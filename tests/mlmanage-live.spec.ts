import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test"

// The suite creates run-specific fixtures and removes them during teardown. Administrator
// credentials must be supplied explicitly for the selected test environment.
const adminPassword = process.env.MLM_ADMIN_PASSWORD
if (!adminPassword)
  throw new Error("Set MLM_ADMIN_PASSWORD before running the live test suite.")
const admin = {
  username: process.env.MLM_ADMIN_USER || "admin",
  password: adminPassword,
}
// Run-scoped accounts: created in beforeAll via the API, wiped by the sweep at teardown.
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const standard = {
  username: `mlm-live-std-${runId}`,
  password: "ephemeral-password-123",
  role: "user",
}
const poweruser = {
  username: `mlm-live-power-${runId}`,
  password: "ephemeral-password-123",
  role: "poweruser",
}
const readonly = {
  username: `mlm-live-readonly-${runId}`,
  password: "ephemeral-password-123",
  role: "readonly",
}
// Everything this suite creates is prefixed so the sweep (afterEach + globalTeardown) can
// reliably identify and remove OUR artifacts without ever touching team data. The backend
// Python suites use the sibling prefix "mlm-api-".
const TEST_PREFIX = "mlm-live-"
const unique = (prefix: string) =>
  `${TEST_PREFIX}${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

async function loginApi(request: APIRequestContext, account = admin) {
  const response = await request.post("/api/mlmanage/login", { data: account })
  expect(response.ok()).toBeTruthy()
  return ((await response.json()) as { access_token: string }).access_token
}

const matches = (name: unknown) =>
  typeof name === "string" && name.startsWith(TEST_PREFIX)

// Best-effort, idempotent cleanup of everything this suite has ever created on the backend
// (incl. orphans of earlier failed runs): queue items -> tasks -> jobs (DELETE /jobs also
// cancels the linked reservation) -> images -> projects -> groups -> prefixed accounts.
// The backend-side sweep in tests_suite/lib.py uses the same rules for "mlm-api-".
async function sweepTestArtifacts(
  request: APIRequestContext,
  opts: { includeAccounts?: boolean } = {}
) {
  let token: string
  try {
    token = await loginApi(request)
  } catch {
    return // backend unreachable - nothing sensible to clean up here
  }
  const headers = { Authorization: `Bearer ${token}` }
  const del = async (url: string) => {
    try {
      await request.delete(url, { headers })
    } catch {
      // best effort; leftovers are re-detected by the next sweep
    }
  }

  const queue = await request.get("/api/mlmanage/queue", { headers })
  if (queue.ok()) {
    const items =
      ((await queue.json()) as { queue?: Array<Record<string, unknown>> })
        .queue ?? []
    for (const item of items)
      if (matches(item.display_name)) {
        for (const t of (item.task_names as string[]) ?? [])
          await del(`/api/mlmanage/tasks/${encodeURIComponent(t)}`)
        await del(`/api/mlmanage/queue/${item.id}`)
      }
  }
  const jobs = await request.get("/api/mlmanage/jobs", { headers })
  if (jobs.ok()) {
    const list =
      ((await jobs.json()) as { jobs?: Array<Record<string, unknown>> }).jobs ??
      []
    for (const job of list)
      if (matches(job.display_name)) {
        if (typeof job.task_name === "string" && job.task_name)
          await del(`/api/mlmanage/tasks/${job.task_name}`)
        await del(`/api/mlmanage/jobs/${job.id}`)
      }
  }
  const images = await request.get("/api/mlmanage/images", { headers })
  if (images.ok()) {
    const list =
      ((await images.json()) as { images?: Array<Record<string, unknown>> })
        .images ?? []
    for (const img of list)
      if (matches(img.name)) await del(`/api/mlmanage/images/${img.id}`)
  }
  const groups = await request.get("/api/mlmanage/groups", { headers })
  if (groups.ok()) {
    const list =
      ((await groups.json()) as { groups?: Array<Record<string, unknown>> })
        .groups ?? []
    for (const g of list)
      if (matches(g.name))
        await del(`/api/mlmanage/groups/${encodeURIComponent(String(g.name))}`)
  }
  const projects = await request.get("/api/mlmanage/projects", { headers })
  if (projects.ok()) {
    const list =
      ((await projects.json()) as { projects?: Array<Record<string, unknown>> })
        .projects ?? []
    for (const p of list)
      if (matches(p.name))
        await del(
          `/api/mlmanage/projects/${encodeURIComponent(String(p.name))}`
        )
  }
  if (opts.includeAccounts) {
    const users = await request.get("/api/mlmanage/users", { headers })
    if (users.ok()) {
      const body: unknown = await users.json() // /users returns a bare list, not {users:[...]}
      const accounts = Array.isArray(body)
        ? body
        : ((body as { users?: Array<Record<string, unknown>> })?.users ?? [])
      for (const u of accounts)
        if (matches(u.username))
          await del(
            `/api/mlmanage/users/${encodeURIComponent(String(u.username))}`
          )
    }
  }
}

// Accounts persist across the whole run (created in beforeAll), so they are removed by the
// globalTeardown sweep only — NOT by the per-test afterEach sweep.
async function createRunAccounts(request: APIRequestContext) {
  const token = await loginApi(request)
  const headers = { Authorization: `Bearer ${token}` }
  for (const account of [standard, poweruser, readonly]) {
    const res = await request.post("/api/mlmanage/users", {
      headers,
      data: account,
    })
    // 200 = created; 400/409 = already exists from an earlier attempt of this run.
    expect([200, 400, 409]).toContain(res.status())
  }
}

// Run after EVERY test, success or failure, so nothing survives an assertion error.
test.afterEach(async ({ request }) => {
  await sweepTestArtifacts(request)
})

test.beforeAll(async ({ request }) => {
  await createRunAccounts(request)
})

async function signIn(page: Page, account = admin) {
  await page.goto("/")
  await page.getByLabel("Username").fill(account.username)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible({
    timeout: 20_000,
  })
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() =>
      Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
    )
  ).toBeLessThanOrEqual((await page.viewportSize())!.width + 2)
}

async function openExternalJob(page: Page, name: string, command: string) {
  await page.getByRole("button", { name: "New job" }).click()
  await page.getByLabel("Job name").fill(name)
  await page.getByRole("tab", { name: "external" }).click()
  await page.getByLabel("External pull reference").fill("alpine:latest")
  await page.getByLabel("Command").fill(command)
}

/** Value for a `datetime-local` input, in the browser's own timezone. */
function localDateTime(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

async function addMember(page: Page, username: string) {
  await page.getByLabel("Search members").fill(username)
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    page.getByRole("button", { name: `Remove ${username}` })
  ).toBeVisible()
}

test("New Job is understandable, keeps focus, and stays same-origin", async ({
  page,
}) => {
  const direct = new Set<string>()
  const backendOrigin = new URL(
    process.env.MLMANAGE_API_URL || "http://localhost:8000"
  ).origin
  page.on("request", (request) => {
    if (new URL(request.url()).origin === backendOrigin) direct.add(request.url())
  })
  await signIn(page)
  await page.getByRole("button", { name: "New job" }).click()
  const jobName = page.getByLabel("Job name")
  await jobName.fill("focus")
  await jobName.pressSequentially("-retained")
  await expect(jobName).toHaveValue("focus-retained")
  await expect(page.getByRole("heading", { name: "Compute" })).toBeVisible()
  for (const label of [
    "Project",
    "CPU cores",
    "Memory size",
    "Memory unit",
    "Run time limit",
    "Run time unit",
    "Temporary disk size",
    "Temporary disk unit",
  ])
    await expect(page.getByLabel(label)).toBeVisible()
  // Queue-level scheduling controls exist, but they stay behind a collapsed
  // disclosure so the default form remains the simple path.
  for (const advanced of ["Priority", "Parallel copies", "Wait for other jobs"])
    await expect(page.getByLabel(advanced)).toBeHidden()
  await page.getByText("Advanced scheduling (optional)").click()
  for (const advanced of ["Priority", "Parallel copies"])
    await expect(page.getByLabel(advanced)).toBeVisible()
  await expect(page.getByText("Start all copies together")).toBeVisible()
  await expect(page.getByText("Run as an MPI job")).toBeVisible()
  await expect(page.getByText("Wait for other jobs")).toBeVisible()
  expect([...direct]).toEqual([])

  // A scheduled job runs on the single accelerator it reserves, so the GPU count is
  // pinned to 1 rather than posting a request no pod could satisfy.
  await page
    .getByRole("button", { name: /Schedule Exact reservation window/ })
    .click()
  const accelerators = page.getByLabel("Accelerators needed")
  await expect(accelerators).toBeDisabled()
  await expect(accelerators).toHaveValue("1")

  // Validation state must not survive the sheet: reopening starts clean.
  await page.getByRole("button", { name: /As soon as possible/ }).click()
  await page.getByLabel("Parallel copies").fill("0")
  await page.getByRole("button", { name: "Queue job" }).click()
  await expect(page.getByText("Enter one or more copies.")).toBeVisible()
  await page.getByRole("button", { name: "Close new job" }).click()
  await page.getByRole("button", { name: "New job" }).click()
  await page.getByText("Advanced scheduling (optional)").click()
  await expect(page.getByText("Enter one or more copies.")).toHaveCount(0)
})

test("Jobs status filters cover every backend state", async ({ page }) => {
  await signIn(page)
  // Queue entries can be waiting_deps or cancelled and scheduled Jobs can be
  // submitted; each state needs a chip, or that work is only visible under "all".
  for (const chip of [
    "all",
    "running",
    "waiting",
    "scheduled",
    "completed",
    "failed",
    "cancelled",
  ])
    await expect(
      page.getByRole("button", { name: chip, exact: true })
    ).toBeVisible()
})

test("a failed save is reported inside the dialog, not behind it", async ({
  page,
}) => {
  const conflict = "Group quota conflict: 2 accelerators already committed"
  await page.route("**/api/mlmanage/groups/**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue()
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ detail: conflict }),
    })
  })
  await signIn(page)
  await page.getByRole("button", { name: "Projects" }).click()
  const group = unique("error-group")
  await page.getByRole("button", { name: "Create group" }).click()
  await page.getByLabel("Group name").fill(group)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 })
  const row = page.getByText(group, { exact: true }).locator("xpath=../..")
  await row.getByRole("button", { name: "Edit" }).click()
  const dialog = page.getByRole("dialog", { name: /Edit group/ })
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  // The modal overlay paints over the corner toast, so the failure has to be inline.
  await expect(dialog.getByRole("alert")).toContainText(conflict)
  await expect(dialog).toBeVisible()
})

test("the same-origin proxy refuses unauthenticated backend calls", async ({
  request,
}) => {
  // Several backend endpoints have no auth dependency of their own; the proxy is the
  // internet-facing surface in front of them and must not pass anonymous requests.
  for (const path of ["reservations/calendar", "gpu/list", "metrics", "queue"])
    expect((await request.get(`/api/mlmanage/${path}`)).status()).toBe(401)
  // Pre-login paths stay reachable, or nobody could sign in.
  expect((await request.get("/api/mlmanage/health")).ok()).toBeTruthy()
})

test("New Job explains backend quota rejections inside the open form", async ({
  page,
}) => {
  const quotaMessage =
    "Group vision-research GPU quota exceeded: 2 in use + 1 requested > quota 2"
  await page.route("**/api/mlmanage/queue", async (route) => {
    if (route.request().method() !== "POST") return route.continue()
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ detail: quotaMessage }),
    })
  })

  await signIn(page)
  await openExternalJob(page, unique("quota-rejection"), "echo quota")
  await page.getByLabel("Accelerators needed").fill("1")
  await page.getByRole("button", { name: "Queue job" }).click()

  const dialog = page.getByRole("dialog", { name: "What should run?" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("alert")).toContainText(quotaMessage)
  await expect(page.getByLabel("Job name")).not.toHaveValue("")

  await page.getByRole("button", { name: "Close new job" }).click()
  await page.getByRole("button", { name: "New job" }).click()
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0)
})

test("ASAP and scheduled Jobs complete through the normal creation flow", async ({
  page,
  browserName,
}) => {
  await signIn(page)
  const asap = unique("clear-job")
  await openExternalJob(page, asap, "sh\n-c\necho clear")
  await page.getByRole("button", { name: "Queue job" }).click()
  await expect(page.getByText("Job added to queue")).toBeVisible({
    timeout: 20_000,
  })

  const scheduled = unique("scheduled-job")
  await openExternalJob(page, scheduled, "sh\n-c\necho scheduled")
  await page
    .getByRole("button", { name: /Schedule Exact reservation window/ })
    .click()
  // Disjoint near-future windows exercise scheduling, availability checks, and ICS downloads
  // without leaving long-running reservations that could block shared test capacity.
  const browserOffsetMinutes =
    { chromium: 0, firefox: 5, webkit: 10 }[browserName] || 0
  const start = new Date(Date.now() + (120 + browserOffsetMinutes) * 60_000)
  start.setSeconds(0, 0)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  await page.getByLabel("Start").fill(localDateTime(start))
  await page.getByLabel("End").fill(localDateTime(end))
  await expect(page.getByText("Checking the shared schedule…")).toHaveCount(0, {
    timeout: 20_000,
  })
  const available = page
    .locator('input[name="scheduled-gpu"]:not([disabled])')
    .first()
  await expect(available).toBeVisible({ timeout: 20_000 })
  await available.check()
  await page.getByRole("button", { name: "Schedule job" }).click()
  await expect(page.getByText("Job scheduled")).toBeVisible({ timeout: 20_000 })
  await page
    .getByRole("button", { name: new RegExp(scheduled) })
    .first()
    .click()
  const download = page.waitForEvent("download")
  await page
    .getByRole("button", { name: "Download calendar event (.ics)" })
    .click()
  expect((await download).suggestedFilename()).toMatch(/\.ics$/)
})

test("inline image upload is part of New Job and immediately usable", async ({
  page,
}) => {
  await signIn(page)
  const name = unique("inline-image")
  await page.getByRole("button", { name: "New job" }).click()
  await page.getByRole("tab", { name: "upload" }).click()
  const realImageTar = process.env.MLMANAGE_E2E_IMAGE_TAR
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: "Choose .tar file" }).click()
  await (
    await chooser
  ).setFiles(
    realImageTar
      ? realImageTar
      : {
          name: `${name}.tar`,
          mimeType: "application/x-tar",
          buffer: Buffer.from("docker archive"),
        }
  )
  await expect(
    page.getByRole("button", { name: /upload docker-save tar/i })
  ).toHaveCount(0)
  await expect(page.getByText(/Uploaded and selected/)).toBeVisible({
    timeout: 20_000,
  })
  await page.getByLabel("Job name").fill(`${name}-job`)
  await page.getByLabel("Command").fill("sh\n-c\necho inline")
  await page.getByRole("button", { name: "Queue job" }).click()
  await expect(page.getByText("Job added to queue")).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    page.getByRole("button", {
      name: new RegExp(`${name}-job.*(running|completed)`, "i"),
    })
  ).toBeVisible({ timeout: 25_000 })
})

test("project and group membership, structured quotas, editing, and deletion work", async ({
  page,
}) => {
  await signIn(page)
  await page.getByRole("button", { name: "Projects" }).click()
  const project = unique("ux-project")
  await page.getByRole("button", { name: "Create project" }).click()
  await page.getByLabel("Project name").fill(project)
  await page.getByLabel("Owner").selectOption("admin")
  await page.getByLabel("Total accelerators").fill("2")
  await page.getByLabel("Shared storage (GiB)").fill("20")
  await addMember(page, standard.username)
  await addMember(page, poweruser.username)
  // Hardware-agnostic: console-shell renders one field per detected card, labelled
  // `${gpu.product} accelerator limit`. Hardcoding "NVIDIA-A100" only matched the curated
  // dev VM and cannot pass on other hardware (e.g. RTX A5000), so match the per-type field
  // that this cluster actually exposes - mirroring the backend suite, which is likewise
  // hardware-agnostic and validates against detected capability.
  const perTypeLimit = page.getByLabel(/accelerator limit/).first()
  await perTypeLimit.fill("1")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(page.getByText("Saved")).toBeVisible({ timeout: 15_000 })
  const projectRow = page
    .getByText(project, { exact: true })
    .locator("xpath=../..")
  await expect(projectRow).toContainText(standard.username)
  await projectRow.getByRole("button", { name: "Edit" }).click()
  await expect(page.getByLabel("Shared storage (GiB)")).toHaveValue("20")
  await expect(page.getByLabel(/accelerator limit/).first()).toHaveValue("1")
  await addMember(page, readonly.username)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(projectRow).toContainText(readonly.username)
  page.once("dialog", (dialog) => dialog.accept())
  await projectRow.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(project, { exact: true })).toHaveCount(0)

  const group = unique("ux-group")
  await page.getByRole("button", { name: "Create group" }).click()
  await page.getByLabel("Group name").fill(group)
  await page.getByLabel("Total accelerators").fill("2")
  await addMember(page, standard.username)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  const groupRow = page.getByText(group, { exact: true }).locator("xpath=../..")
  await expect(groupRow).toContainText(standard.username)
  page.once("dialog", (dialog) => dialog.accept())
  await groupRow.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(group, { exact: true })).toHaveCount(0)
})

test("Usage is scoped, explanatory, and selectable by user/project/group", async ({
  page,
  request,
}) => {
  await signIn(page)
  // The usage table only renders when the backend has workload activity inside the
  // selected window ("Allocated GPU time comes from real Job lifecycle timestamps").
  // The suite cleans up after itself, so it can no longer rely on leftover history:
  // seed one short lifecycle via the queue API and wait until analytics reports it.
  const seedToken = await loginApi(request)
  const seeded = await request.post("/api/mlmanage/queue", {
    headers: { Authorization: `Bearer ${seedToken}` },
    data: {
      display_name: unique("usage-seed"),
      image: "alpine:latest",
      command: ["echo", "usage-seed"],
      gpus: 1,
      replicas: 1,
      priority: 0,
    },
  })
  expect(seeded.ok()).toBeTruthy()
  await expect
    .poll(
      async () => {
        const usage = await request.get(
          "/api/mlmanage/analytics/usage?group_by=user&hours=168",
          { headers: { Authorization: `Bearer ${seedToken}` } }
        )
        if (!usage.ok()) return false
        const body = (await usage.json()) as { results?: unknown[] }
        return Boolean(body.results?.length)
      },
      { timeout: 45_000, intervals: [2_000] }
    )
    .toBe(true)
  await page.getByRole("button", { name: "Usage", exact: true }).click()
  await expect(page.getByLabel("Usage scope")).toHaveValue("mine")
  await expect(page.getByLabel("Usage period")).toHaveValue("168")
  await expect(page.getByText("Allocated GPU time")).toBeVisible()
  await expect(page.getByText("GPU activity", { exact: true })).toBeVisible()
  await expect(page.getByText("Hardware telemetry")).toBeVisible()
  // Energy and carbon footprint come from the same analytics response. Both are
  // always labelled; the value reads "Not monitored" until samples exist, so the
  // assertion is on the labels and on the copy that explains the dependency.
  await expect(page.getByText("Energy used")).toBeVisible()
  await expect(page.getByText("Carbon footprint").first()).toBeVisible()
  await expect(
    page.getByText(/energy and carbon footprint appear only when/)
  ).toBeVisible()
  await page.getByLabel("Usage scope").selectOption("user")
  await expect(page.getByLabel("Usage subject")).toBeVisible()
  await page.getByLabel("Usage scope").selectOption("project")
  await expect(page.getByLabel("Usage subject")).toBeVisible()
  await page.getByLabel("Usage scope").selectOption("team")
  await expect(page.getByLabel("Usage subject")).toBeVisible()
  await expect(page.getByText("Metrics preview", { exact: true })).toHaveCount(
    0
  )

  await page.getByRole("button", { name: "Sign out" }).click()
  await signIn(page, standard)
  await page.getByRole("button", { name: "Usage" }).click()
  await expect(
    page.getByLabel("Usage scope").locator("option[value=user]")
  ).toHaveCount(0)
  await expect(
    page.getByText(/Only activity available to your account is shown/)
  ).toBeVisible()
})

test("Capacity exposes GPU sharing, direct reservations, and iCal exchange", async ({
  page,
  browserName,
}) => {
  await signIn(page)
  await page.getByRole("button", { name: "Capacity" }).click()
  await expect(
    page.getByRole("heading", { name: "GPU inventory" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Shared schedule" })
  ).toBeVisible()
  await expect(page.getByText("Sharing", { exact: true })).toBeVisible()

  const exported = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export .ics" }).click()
  expect((await exported).suggestedFilename()).toMatch(/\.ics$/)

  // A short, browser-disjoint near-future window: created through the UI and
  // released again in this test, so no accelerator stays held after the run.
  const offset = { chromium: 0, firefox: 20, webkit: 40 }[browserName] || 0
  const start = new Date(Date.now() + (180 + offset) * 60_000)
  start.setSeconds(0, 0)
  const end = new Date(start.getTime() + 15 * 60_000)
  await page.getByRole("button", { name: "Reserve a GPU" }).click()
  const dialog = page.getByRole("dialog", { name: /Reserve an accelerator/ })
  await dialog.getByLabel("Start").fill(localDateTime(start))
  await dialog.getByLabel("End").fill(localDateTime(end))
  const picker = page.getByLabel("Accelerator to reserve")
  const free = picker.locator("option:not([disabled])").nth(1)
  await expect(free).toBeAttached({ timeout: 20_000 })
  const gpuUuid = (await free.getAttribute("value")) as string
  expect(gpuUuid).toBeTruthy()
  await picker.selectOption(gpuUuid)
  await dialog.getByRole("button", { name: "Reserve", exact: true }).click()
  await expect(page.getByText("Accelerator reserved")).toBeVisible({
    timeout: 20_000,
  })

  const reserved = page
    .getByRole("row")
    .filter({ hasText: gpuUuid })
    .filter({ hasText: start.toLocaleTimeString() })
    .first()
  page.once("dialog", (confirmation) => confirmation.accept())
  await reserved.getByRole("button", { name: "Release" }).click()
  await expect(page.getByText("Reservation released")).toBeVisible({
    timeout: 20_000,
  })
})

test("My account shows the allocation, workspaces and access the backend reports", async ({
  page,
}) => {
  await signIn(page, standard)
  await page.getByRole("button", { name: "My account" }).click()
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "My allocation" })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "My workspaces" })
  ).toBeVisible()
  await expect(page.getByText("Accelerators", { exact: true })).toBeVisible()
  await expect(page.getByText("Scratch", { exact: true })).toBeVisible()
  // Read-only view: it never offers to change the profile it displays.
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0)
})

test("account editing retains focus, prefills values, and deletion is explicit", async ({
  page,
}) => {
  await signIn(page)
  await page.getByRole("button", { name: "Administration" }).click()
  const username = unique("ux-account")
  await page.getByRole("button", { name: "Create account" }).click()
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password").fill("temporary-password")
  await page.getByLabel("Role").selectOption("user")
  await page.getByLabel("Accelerator allocation").fill("2")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  const row = page.getByText(username, { exact: true }).locator("xpath=../..")
  await expect(row).toContainText("2 accelerators")
  await row.getByRole("button", { name: "Edit" }).click()
  await expect(page.getByLabel("Accelerator allocation")).toHaveValue("2")
  // PUT /users/{username} carries the profile fields only, so the account-wide
  // allocations are shown for reference and cannot be edited here.
  await expect(page.getByLabel("Accelerator allocation")).toBeDisabled()
  await expect(page.getByLabel("Slack member ID (optional)")).toBeVisible()
  await expect(page.getByLabel("Scheduling priority")).toBeVisible()
  const email = page.getByLabel("Email (optional)")
  await email.fill("focus@example.test")
  await email.pressSequentially(".retained")
  await expect(email).toHaveValue("focus@example.test.retained")
  await page.getByRole("button", { name: "Cancel" }).click()
  page.once("dialog", (dialog) => dialog.accept())
  await row.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(username, { exact: true })).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Data retention" })
  ).toBeVisible()
})

test("backend enforces project membership and privacy-safe availability", async ({
  request,
}) => {
  const adminToken = await loginApi(request)
  const userToken = await loginApi(request, standard)
  const allowed = unique("member-project")
  const denied = unique("private-project")
  const headers = { Authorization: `Bearer ${adminToken}` }
  for (const [name, members] of [
    [allowed, [standard.username]],
    [denied, ["admin"]],
  ] as const) {
    const created = await request.post("/api/mlmanage/projects", {
      headers,
      data: {
        name,
        owner: "admin",
        members,
        total_gpus: 2,
        shared_storage_gb: 10,
        gpu_quota_by_type: {},
      },
    })
    // The backend's POST /projects returns 200 (FastAPI default, no explicit status_code),
    // not 201 - verified against the live API and consistent with its own test suite. The
    // old `toBe(201)` could therefore never pass against any deployment of this backend.
    expect([200, 201]).toContain(created.status())
  }
  const payload = {
    display_name: unique("member-job"),
    image: "alpine:latest",
    command: ["echo", "member"],
    resources: { limits: { "nvidia.com/gpu": 1 } },
    gpus: 1,
    project: allowed,
  }
  expect(
    (
      await request.post("/api/mlmanage/queue", {
        headers: { Authorization: `Bearer ${userToken}` },
        data: payload,
      })
    ).ok()
  ).toBeTruthy()
  expect(
    (
      await request.post("/api/mlmanage/queue", {
        headers: { Authorization: `Bearer ${userToken}` },
        data: { ...payload, project: denied },
      })
    ).status()
  ).toBe(403)
  expect(
    (
      await request.get(
        `/api/mlmanage/analytics/usage?group_by=project&hours=168&subject=${encodeURIComponent(denied)}`,
        { headers: { Authorization: `Bearer ${userToken}` } }
      )
    ).status()
  ).toBe(403)
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  const availability = await request.get(
    `/api/mlmanage/availability?start_time=${encodeURIComponent(start.toISOString())}&end_time=${encodeURIComponent(end.toISOString())}`,
    { headers: { Authorization: `Bearer ${userToken}` } }
  )
  expect(availability.ok()).toBeTruthy()
  const availabilityBody = (await availability.json()) as {
    start_time: string
    end_time: string
    gpus: Array<Record<string, unknown>>
  }
  expect(Object.keys(availabilityBody).sort()).toEqual([
    "end_time",
    "gpus",
    "start_time",
  ])
  for (const gpu of availabilityBody.gpus) {
    expect(Object.keys(gpu).sort()).toEqual([
      "available",
      "busy_windows",
      "gpu_uuid",
      "node",
      "product",
      "reserved",
      "synthetic_e2e",
    ])
    for (const window of gpu.busy_windows as Array<Record<string, unknown>>)
      expect(Object.keys(window).sort()).toEqual(["end", "reserved", "start"])
  }
  for (const name of [allowed, denied])
    expect(
      (
        await request.delete(
          `/api/mlmanage/projects/${encodeURIComponent(name)}`,
          { headers }
        )
      ).ok()
    ).toBeTruthy()
})

test("readonly is non-mutating and mobile workflows do not overflow", async ({
  page,
}) => {
  await signIn(page, readonly)
  await expect(page.getByRole("button", { name: "New job" })).toHaveCount(0)
  // Including the per-project shortcut, which used to open the full creation sheet
  // for an account the backend would reject on submit.
  await page.getByRole("button", { name: "Projects" }).click()
  await expect(page.getByRole("button", { name: "New job" })).toHaveCount(0)
  await page.getByRole("button", { name: "Jobs" }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await noOverflow(page)
  await page.getByRole("button", { name: "Open navigation" }).click()
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" })
  ).toBeVisible()
})
