/**
 * The same-origin trust boundary and the session.
 *
 * `MLMANAGE_API_URL` is server-side only: the browser must reach the backend exclusively
 * through `/api/mlmanage`, and that proxy is the internet-facing surface in front of
 * backend endpoints that have no auth dependency of their own. These tests cover what the
 * proxy lets through, what it refuses, and what the console does when a token stops
 * working.
 */
import { expect, test } from "@playwright/test"
import {
  auth,
  ensureRoleAccounts,
  goTo,
  loginApi,
  signIn,
  signInAsAdmin,
  sweep,
  workloadUser,
} from "./support/mlmanage"

/**
 * Backend endpoints with no authentication of their own. Anonymous access to any of them
 * would leak inventory, the shared schedule, or cluster metrics to the internet.
 */
const UNAUTHENTICATED_BACKEND_PATHS = [
  "gpu/list",
  "reservations/calendar",
  "reservations/calendar.ics",
  "metrics",
]

/** Everything else the console calls; all of it requires credentials at the proxy. */
const AUTHENTICATED_PATHS = [
  "me",
  "users",
  "jobs",
  "queue",
  "tasks",
  "images",
  "reservations",
  "availability",
  "gpu/capabilities",
  "gpu/partitions",
  "gpu/usage",
  "groups",
  "projects",
  "disk/usage",
  "analytics/usage",
  "analytics/activity",
  "settings/cleanup",
]

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("the proxy refuses anonymous requests, including to endpoints the backend leaves open", async ({
  request,
}) => {
  for (const path of [...UNAUTHENTICATED_BACKEND_PATHS, ...AUTHENTICATED_PATHS]) {
    const response = await request.get(`/api/mlmanage/${path}`, {
      failOnStatusCode: false,
    })
    expect(response.status(), `anonymous GET ${path}`).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  }
  // Writes are refused before they reach the backend as well.
  for (const path of ["queue", "reservations", "users", "groups", "projects"]) {
    const response = await request.post(`/api/mlmanage/${path}`, {
      data: {},
      failOnStatusCode: false,
    })
    expect(response.status(), `anonymous POST ${path}`).toBe(401)
  }
  const removed = await request.delete("/api/mlmanage/jobs/1", {
    failOnStatusCode: false,
  })
  expect(removed.status()).toBe(401)
})

test("the two paths the browser needs before it holds a token stay reachable", async ({
  request,
}) => {
  const health = await request.get("/api/mlmanage/health")
  expect(health.ok()).toBeTruthy()
  expect(await health.json()).toMatchObject({ status: "ok" })

  // A wrong password must reach the backend and come back as its own rejection.
  const rejected = await request.post("/api/mlmanage/login", {
    data: { username: "mlm-live-nobody", password: "wrong" },
    failOnStatusCode: false,
  })
  expect(rejected.status()).toBe(401)
  expect(await rejected.text()).not.toBe('{"detail":"Not authenticated"}')
})

test("the iCal feed accepts a token in the query, because calendar clients cannot send headers", async ({
  request,
}) => {
  const token = await loginApi(request)
  const subscribed = await request.get(
    `/api/mlmanage/reservations/calendar.ics?token=${encodeURIComponent(token)}`,
    { failOnStatusCode: false }
  )
  expect(subscribed.ok()).toBeTruthy()
  expect(await subscribed.text()).toContain("BEGIN:VCALENDAR")

  // The exception is that path only: a token in the query buys nothing elsewhere.
  const elsewhere = await request.get(
    `/api/mlmanage/reservations?token=${encodeURIComponent(token)}`,
    { failOnStatusCode: false }
  )
  expect(elsewhere.status()).toBe(401)
  const empty = await request.get("/api/mlmanage/reservations/calendar.ics?token=", {
    failOnStatusCode: false,
  })
  expect(empty.status()).toBe(401)
})

test("the proxy forwards the backend's own status for anything it does not know", async ({
  request,
}) => {
  const token = await loginApi(request)
  const missing = await request.get("/api/mlmanage/mlm-live-no-such-endpoint", {
    headers: auth(token),
    failOnStatusCode: false,
  })
  expect(missing.status()).toBe(404)
  const conflict = await request.post("/api/mlmanage/reservations", {
    headers: auth(token),
    data: { gpu_uuid: "mlm-live-no-such-gpu" },
    failOnStatusCode: false,
  })
  // A validation error from the backend, not a proxy-level failure.
  expect([400, 404, 422]).toContain(conflict.status())
})

test("the browser never addresses the backend host directly, on any view", async ({
  page,
  request,
}) => {
  const offOrigin: string[] = []
  page.on("request", (browserRequest) => {
    const url = new URL(browserRequest.url())
    if (!["http:", "https:"].includes(url.protocol)) return
    const local = ["localhost", "127.0.0.1"].includes(url.hostname)
    if (!local || !["", "80", "3001"].includes(url.port))
      offOrigin.push(browserRequest.url())
  })

  await signInAsAdmin(page, request)
  for (const view of [
    "Capacity",
    "Projects",
    "Usage",
    "My account",
    "Administration",
    "Jobs",
  ] as const)
    await goTo(page, view)
  await page.getByRole("button", { name: "New job" }).click()
  await page.getByRole("button", { name: "Close new job" }).click()
  expect(offOrigin).toEqual([])

  // Nor is the configured backend address present in what the browser was served.
  const backend = process.env.MLMANAGE_API_URL
  if (backend) {
    const served = await page.evaluate(() => document.documentElement.outerHTML)
    expect(served).not.toContain(new URL(backend).host)
  }
})

test("the token lives in localStorage and signing out removes it", async ({
  page,
  request,
}) => {
  await signIn(page, workloadUser)
  const stored = await page.evaluate(() => localStorage.getItem("mlmanage.token"))
  expect(stored).toBeTruthy()
  // It is the backend's own JWT, sent as a bearer token through the proxy.
  const me = await request.get("/api/mlmanage/me", { headers: auth(stored!) })
  expect(me.ok()).toBeTruthy()
  expect(await me.json()).toMatchObject({ username: workloadUser.username })

  await page.getByRole("button", { name: "Sign out" }).first().click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("mlmanage.token"))).toBeNull()

  // A reload stays signed out rather than resurrecting the session.
  await page.reload()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
})

test("a token the backend no longer accepts signs the session out and says so", async ({
  page,
}) => {
  await signIn(page, workloadUser)
  // Whatever happened to it - expiry, a restarted backend, a deleted account - the
  // console must not keep showing pre-expiry data while every action quietly fails. The
  // token the app holds lives in React state, so the session is invalidated the way the
  // backend would: by answering 401.
  await page.route("**/api/mlmanage/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Not authenticated" }),
    })
  )
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible({
    timeout: 30_000,
  })
  await expect(
    page.getByText(
      "Your session expired, so you were signed out. Sign in again to continue."
    )
  ).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("mlmanage.token"))).toBeNull()

  // Signing back in clears the explanation.
  await page.unroute("**/api/mlmanage/me")
  await signIn(page, workloadUser)
  await expect(
    page.getByText("Your session expired, so you were signed out.")
  ).toHaveCount(0)
})

test("a stale token in storage returns to the sign-in screen on load", async ({
  page,
}) => {
  await page.goto("/")
  await page.evaluate(() =>
    localStorage.setItem("mlmanage.token", "mlm-live-stale-token")
  )
  await page.reload()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Jobs" })).toHaveCount(0)
})

test("a wrong password is reported on the sign-in card without leaving it", async ({
  page,
}) => {
  await page.goto("/")
  await page.getByLabel("Username").fill(workloadUser.username)
  await page.getByLabel("Password").fill("definitely-not-the-password")
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByText(/Login failed:/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem("mlmanage.token"))).toBeNull()
})

test("interactive exec is documented as unavailable rather than offered and broken", async ({
  page,
  request,
}) => {
  // The same-origin WebSocket bridge is intentionally unimplemented and answers 426; the
  // console must not fall back to a direct backend WebSocket URL.
  const upgrade = await request.get("/api/mlmanage-ws/tasks/whatever/exec", {
    failOnStatusCode: false,
  })
  expect(upgrade.status()).toBe(426)

  await signInAsAdmin(page, request)
  await expect(
    page.getByText(/Browser exec is unavailable through the same-origin WebSocket/)
  ).toBeVisible()
})

test("the backend status pill reflects whether the proxy can reach the backend", async ({
  page,
}) => {
  await signIn(page, workloadUser)
  await expect(page.getByText("● online")).toBeVisible({ timeout: 30_000 })

  // With the health check failing, the console says offline instead of pretending.
  await page.route("**/api/mlmanage/health", (route) => route.abort())
  await page.getByRole("button", { name: "Refresh" }).click()
  await expect(page.getByText("● offline")).toBeVisible({ timeout: 30_000 })
})
