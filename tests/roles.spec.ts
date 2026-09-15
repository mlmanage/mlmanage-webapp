/**
 * The role/capability table from `Documentation/00-overview/project-summary.md`, asserted
 * twice for every role: once in the console (which controls are offered) and once against
 * the backend (which requests are actually allowed).
 *
 * The frontend's role awareness is a usability measure; the backend is the boundary. A
 * test that only checked the hidden buttons would pass on a console that hid a control
 * the backend still accepted from anyone, so both halves are here.
 */
import { expect, test, type APIRequestContext } from "@playwright/test"
import {
  type Account,
  admin,
  apiList,
  auth,
  ensureRoleAccounts,
  freeGpu,
  futureWindow,
  goTo,
  loginApi,
  powerUser,
  readonlyUser,
  signIn,
  sweep,
  unique,
  workloadUser,
} from "./support/mlmanage"

type Capability = {
  label: string
  roles: string[]
  request: (
    request: APIRequestContext,
    token: string
  ) => Promise<{ status: number }>
}

/** One probe per write capability, so the allowed/denied split is explicit. */
async function capabilities(request: APIRequestContext): Promise<Capability[]> {
  const token = await loginApi(request)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, token, window)
  const post = (path: string, data: unknown) => async (
    ctx: APIRequestContext,
    userToken: string
  ) => {
    const response = await ctx.post(`/api/mlmanage${path}`, {
      headers: auth(userToken),
      data,
      failOnStatusCode: false,
    })
    return { status: response.status() }
  }
  return [
    {
      label: "create a queued job",
      roles: ["user", "poweruser", "admin"],
      request: post("/queue", {
        display_name: unique("role-queue"),
        image: "alpine:latest",
        command: ["true"],
        gpus: 0,
        replicas: 1,
      }),
    },
    {
      label: "create a task directly",
      roles: ["user", "poweruser", "admin"],
      request: post("/tasks", {
        image: "alpine:latest",
        command: ["true"],
        time_limit_seconds: 60,
      }),
    },
    {
      label: "reserve an accelerator",
      roles: ["user", "poweruser", "admin"],
      // A fresh window per caller, so a second allowed role is not refused with 409
      // for a conflict rather than being allowed.
      request: async (ctx, userToken) => {
        const slot = futureWindow(1)
        const response = await ctx.post("/api/mlmanage/reservations", {
          headers: auth(userToken),
          data: {
            gpu_uuid: gpu.gpu_uuid,
            start_time: slot.startIso,
            end_time: slot.endIso,
          },
          failOnStatusCode: false,
        })
        return { status: response.status() }
      },
    },
    {
      label: "create a project",
      roles: ["poweruser", "admin"],
      request: post("/projects", { name: unique("role-project"), total_gpus: 1 }),
    },
    {
      label: "request team shared storage",
      roles: ["poweruser", "admin"],
      // A ReadWriteMany team volume has no delete endpoint, so the probe deliberately
      // uses a group name Kubernetes cannot turn into a namespace: the role check runs
      // first (403 for the roles that may not), and an allowed role gets a non-403
      // failure without anything being created.
      request: post("/teams/MLM-LIVE-INVALID-TEAM/shared-storage?size_gb=1", undefined),
    },
    {
      label: "create a group",
      roles: ["admin"],
      request: post("/groups", { name: unique("role-group"), total_gpus: 1 }),
    },
    {
      label: "create an account",
      roles: ["admin"],
      request: post("/users", {
        username: unique("role-user"),
        password: "mlm-live-temporary-1",
        role: "user",
      }),
    },
    {
      label: "change accelerator sharing",
      roles: ["admin"],
      request: post(`/gpu/${encodeURIComponent(gpu.gpu_uuid)}/partition`, {
        mode: "full",
      }),
    },
    {
      label: "change retention settings",
      roles: ["admin"],
      request: async (ctx, userToken) => {
        const response = await ctx.put("/api/mlmanage/settings/cleanup", {
          headers: auth(userToken),
          data: {},
          failOnStatusCode: false,
        })
        return { status: response.status() }
      },
    },
  ]
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request)
})

test.afterEach(async ({ request }) => {
  await sweep(request, { includeAccounts: true })
})

test("the backend allows exactly the write capabilities each role is documented to have", async ({
  request,
}) => {
  test.setTimeout(300_000)
  const adminToken = await loginApi(request)
  const probes = await capabilities(request)
  const accounts: Array<Account & { role: string }> = [
    { ...(await admin(request)), role: "admin" },
    { ...powerUser, role: "poweruser" },
    { ...workloadUser, role: "user" },
    { ...readonlyUser, role: "readonly" },
  ]
  // Direct Task creation leaves a pod behind and carries no name this suite can filter
  // on, so the tasks the probes create are identified by difference and removed.
  const before = new Set(
    (await apiList<{ name: string }>(request, adminToken, "/tasks", "tasks")).map(
      (task) => task.name
    )
  )

  try {
    for (const account of accounts) {
      const token = await loginApi(request, account)
      for (const probe of probes) {
        const { status } = await probe.request(request, token)
        const allowed = probe.roles.includes(account.role)
        if (allowed)
          expect(status, `${account.role} may ${probe.label}`).not.toBe(403)
        else expect(status, `${account.role} may not ${probe.label}`).toBe(403)
      }
    }
  } finally {
    for (const task of await apiList<{ name: string }>(
      request,
      adminToken,
      "/tasks",
      "tasks"
    ))
      if (!before.has(task.name))
        await request.delete(
          `/api/mlmanage/tasks/${encodeURIComponent(task.name)}`,
          { headers: auth(adminToken), failOnStatusCode: false }
        )
  }
})

test("every role can read the operational data it is entitled to", async ({
  request,
}) => {
  for (const account of [
    await admin(request),
    powerUser,
    workloadUser,
    readonlyUser,
  ]) {
    const token = await loginApi(request, account)
    for (const path of [
      "/me",
      "/jobs",
      "/queue",
      "/tasks",
      "/images",
      "/reservations",
      "/reservations/calendar",
      "/gpu/list",
      "/gpu/capabilities",
      "/gpu/partitions",
      "/groups",
      "/projects",
      "/disk/usage",
      "/gpu/usage?hours=24",
      "/analytics/usage?group_by=user&hours=24",
      "/analytics/activity?group_by=user&hours=24",
    ]) {
      const response = await request.get(`/api/mlmanage${path}`, {
        headers: auth(token),
        failOnStatusCode: false,
      })
      expect(response.status(), `${account.username} GET ${path}`).toBe(200)
    }
  }
})

test("a read-only account is offered no way to create, cancel or delete anything", async ({
  page,
  request,
}) => {
  const adminToken = await loginApi(request)
  const name = unique("readonly-visible")
  const created = await request.post("/api/mlmanage/queue", {
    headers: auth(adminToken),
    data: {
      display_name: name,
      image: "alpine:latest",
      command: ["true"],
      gpus: 0,
      replicas: 1,
    },
  })
  expect(created.ok()).toBeTruthy()

  await signIn(page, readonlyUser)
  // Navigation: everything except Administration.
  for (const view of ["Jobs", "Capacity", "Projects", "Usage", "My account"] as const) {
    await goTo(page, view)
    // No creation entry point, on any view, including the per-project shortcut.
    await expect(page.getByRole("button", { name: "New job" })).toHaveCount(0)
  }
  await expect(page.getByRole("button", { name: "Administration" })).toHaveCount(0)

  await goTo(page, "Jobs")
  // A read-only account may still read logs and download results, so those controls stay
  // available on any job it can see; the destructive ones must not.
  await page.getByLabel("Search jobs").fill(name)
  const row = page.getByRole("button", { name: new RegExp(name) }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  for (const control of ["Cancel", "Delete results", "Cancel task"])
    await expect(page.getByRole("button", { name: control, exact: true })).toHaveCount(0)
})

test("a power user sees the shared-allocation controls a workload user does not", async ({
  page,
}) => {
  await signIn(page, workloadUser)
  await goTo(page, "Projects")
  await expect(page.getByRole("button", { name: "Create project" })).toHaveCount(0)
  await goTo(page, "Capacity")
  await expect(page.getByRole("button", { name: "Create shared storage" })).toHaveCount(0)
  await page.getByRole("button", { name: "Sign out" }).first().click()

  await signIn(page, powerUser)
  await goTo(page, "Projects")
  await expect(page.getByRole("button", { name: "Create project" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Create group" })).toHaveCount(0)
  await goTo(page, "Capacity")
  await expect(page.getByRole("button", { name: "Create shared storage" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Configure sharing" })).toHaveCount(0)
})

test("an administrator sees records across accounts where the product says so", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const adminToken = await loginApi(request)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, token, window)
  const held = await request.post("/api/mlmanage/reservations", {
    headers: auth(token),
    data: {
      gpu_uuid: gpu.gpu_uuid,
      start_time: window.startIso,
      end_time: window.endIso,
    },
  })
  expect(held.ok()).toBeTruthy()

  // The owner sees one reservation; an administrator sees at least that one plus others.
  const own = await apiList<{ user?: string }>(
    request,
    token,
    "/reservations",
    "reservations"
  )
  expect(own.every((item) => !item.user || item.user === workloadUser.username)).toBe(true)
  const all = await apiList<{ user?: string }>(
    request,
    adminToken,
    "/reservations",
    "reservations"
  )
  expect(all.length).toBeGreaterThanOrEqual(own.length)
  expect(all.some((item) => item.user === workloadUser.username)).toBe(true)

  // Which is why the administrator's Capacity table has an Owner column and the
  // workload user's does not.
  await signIn(page, workloadUser)
  await goTo(page, "Capacity")
  await expect(
    page.getByRole("heading", { name: "My reserved GPU windows" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Sign out" }).first().click()
  const account = await admin(request)
  await signIn(page, account)
  await goTo(page, "Capacity")
  await expect(
    page.getByRole("heading", { name: "Reserved GPU windows", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("columnheader", { name: "Owner" })).toBeVisible()
})
