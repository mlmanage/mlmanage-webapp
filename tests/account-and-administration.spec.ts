/**
 * "My account" (read-only, what am I allowed to use?) and Administration (accounts and
 * data retention).
 *
 * The account view is asserted against `GET /me` so it cannot drift from the backend, and
 * the administration flows are asserted against `GET /users` and `GET /settings/cleanup`.
 * The retention test restores the deployment's original durations before it finishes.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import {
  acceptNextConfirm,
  admin,
  apiGet,
  dismissNextConfirm,
  apiList,
  auth,
  displayedDateTime,
  ensureRoleAccounts,
  expectToast,
  freeGpu,
  futureWindow,
  goTo,
  inventory,
  loginApi,
  modal,
  optionValues,
  powerUser,
  readonlyUser,
  signIn,
  signInAsAdmin,
  sweep,
  unique,
  workloadUser,
} from "./support/mlmanage"

type Me = {
  id: string
  username: string
  role: string
  quota_cpu?: string | null
  quota_memory?: string | null
  quota_gpu?: number | null
  quota_vram_gb?: number | null
  disk_home_gb?: number | null
  disk_scratch_gb?: number | null
  disk_project_gb?: number | null
  email?: string | null
  slack_id?: string | null
  team?: string | null
  priority?: number | null
  gpu_quota_by_type?: Record<string, number> | string | null
  vram_quota_by_type?: Record<string, number> | string | null
}
type Cleanup = {
  enabled: boolean
  cleanup_interval_seconds: number
  standalone_task_ttl_seconds: number
  result_ttl_seconds: number
  results_helper_idle_ttl_seconds: number
}

const users = (request: APIRequestContext, token: string) =>
  apiList<Me>(request, token, "/users", "users")

/**
 * The `<dt>`/`<dd>` pair of a labelled row, and a headline tile located by its `<p>`
 * label. Both are anchored to the element type rather than to the text alone, because
 * the same words appear again as table headers and in list copy.
 */
function detail(page: Page, label: string) {
  return page
    .locator("dt")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("..")
}

function tile(page: Page, label: string) {
  return page
    .locator("p")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("..")
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser, powerUser, readonlyUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request, { includeAccounts: true })
})

test("My account reports exactly what the backend records for the signed-in user", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const detected = await inventory(request, token)
  const adminToken = await loginApi(request)

  // Give the account something to show in every section.
  const group = unique("acct-group")
  const project = unique("acct-project")
  const created = await request.post("/api/mlmanage/groups", {
    headers: auth(adminToken),
    data: { name: group, total_gpus: 2 },
    failOnStatusCode: false,
  })
  expect([200, 201]).toContain(created.status())
  const madeProject = await request.post("/api/mlmanage/projects", {
    headers: auth(adminToken),
    data: {
      name: project,
      owner: workloadUser.username,
      members: [workloadUser.username],
      total_gpus: 3,
    },
    failOnStatusCode: false,
  })
  expect([200, 201]).toContain(madeProject.status())
  const product = detected.products[0]
  const profile = await request.put(
    `/api/mlmanage/users/${encodeURIComponent(workloadUser.username)}`,
    {
      headers: auth(adminToken),
      data: {
        email: "mlm-live@example.test",
        slack_id: "U-MLM-LIVE",
        team: group,
        priority: 4,
        gpu_quota_by_type: product ? { [product]: 2 } : {},
        vram_quota_by_type: product ? { [product]: 12 } : {},
      },
      failOnStatusCode: false,
    }
  )
  expect(profile.ok(), await profile.text()).toBeTruthy()
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

  const me = await apiGet<Me>(request, await loginApi(request, workloadUser), "/me")

  await signIn(page, workloadUser)
  await goTo(page, "My account")
  for (const heading of ["Profile", "My allocation", "My workspaces", "My access"])
    await expect(page.getByRole("heading", { name: heading })).toBeVisible()

  await expect(detail(page, "Username")).toContainText(me.username)
  await expect(detail(page, "Role")).toContainText("User")
  await expect(detail(page, "Email")).toContainText(me.email || "Not set")
  await expect(detail(page, "Slack")).toContainText(me.slack_id || "Not set")
  await expect(detail(page, "Group")).toContainText(me.team || "No group")
  await expect(detail(page, "Scheduling priority")).toContainText(
    `${me.priority ?? 0} — higher priority work starts first`
  )

  await expect(tile(page, "Accelerators")).toContainText(String(me.quota_gpu ?? 0))
  await expect(tile(page, "GPU memory")).toContainText(`${me.quota_vram_gb ?? 0} GB`)
  await expect(tile(page, "CPU cores")).toContainText(String(me.quota_cpu ?? "—"))
  await expect(tile(page, "Memory")).toContainText(String(me.quota_memory ?? "—"))
  await expect(tile(page, "Home")).toContainText(`${me.disk_home_gb ?? 0} GiB`)
  await expect(tile(page, "Scratch")).toContainText(`${me.disk_scratch_gb ?? 0} GiB`)
  await expect(tile(page, "Project")).toContainText(`${me.disk_project_gb ?? 0} GiB`)

  if (product) {
    await expect(
      page.getByRole("heading", { name: "Limits by accelerator" })
    ).toBeVisible()
    const row = page.getByRole("row").filter({ hasText: product }).first()
    await expect(row).toContainText("2")
    await expect(row).toContainText("12 GB")
  }

  // Access: the project it belongs to and the window it is holding right now.
  const access = page.getByRole("heading", { name: "Projects" }).locator("..")
  await expect(access).toContainText(project)
  await expect(access).toContainText("you own it")
  await expect(access).toContainText("3 accelerators shared")
  const windows = page.getByRole("heading", { name: "Active GPU windows" }).locator("..")
  await expect(windows).toContainText(gpu.gpu_uuid)
  await expect(windows).toContainText(await displayedDateTime(page, window.start))

  // Read-only: the backend only lets an administrator change a profile.
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0)
})

test("My account explains each role in the viewer's own words", async ({
  page,
  request,
}) => {
  for (const [account, wording] of [
    [readonlyUser, /Read only — you can inspect everything you are allowed to see/],
    [powerUser, /Power user — can also create projects and shared storage/],
  ] as const) {
    await signIn(page, account)
    await goTo(page, "My account")
    await expect(detail(page, "Role")).toContainText(wording)
    await expect(
      page.getByText(/An administrator maintains these details/)
    ).toBeVisible()
    await page.getByRole("button", { name: "Sign out" }).first().click()
  }
  await signInAsAdmin(page, request)
  await goTo(page, "My account")
  await expect(detail(page, "Role")).toContainText("Administrator")
})

test("My account states plainly when there is nothing to show", async ({
  page,
  request,
}) => {
  await sweep(request)
  await signIn(page, readonlyUser)
  await goTo(page, "My account")
  // A read-only account holds no windows and cannot be a project member by default.
  await expect(page.getByText("You are not holding any accelerator window.")).toBeVisible()
})

test("an administrator creates an account with quotas and per-model limits", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const username = unique("account")
  const password = "mlm-live-temporary-1"

  await signInAsAdmin(page, request)
  await goTo(page, "Administration")
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible()
  await page.getByRole("button", { name: "Create account" }).click()
  const dialog = modal(page, /Create account/)

  // Username and password are the required pair.
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await dialog.getByLabel("Username").fill(username)
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await dialog.getByLabel("Password").fill(password)
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled()

  // Every role the product defines can be chosen at creation time.
  expect(await optionValues(dialog.getByLabel("Role"))).toEqual([
    "user",
    "poweruser",
    "admin",
    "readonly",
  ])
  await dialog.getByLabel("Role").selectOption("poweruser")
  await dialog.getByLabel("Email (optional)").fill("mlm-live-created@example.test")
  await dialog.getByLabel("CPU allocation").fill("3")
  await dialog.getByLabel("Memory allocation", { exact: true }).fill("6Gi")
  // Per-model limits are part of the same form on create as on edit.
  await expect(
    dialog.getByText("Set limits by accelerator model (optional)")
  ).toBeVisible()
  await dialog.getByLabel("Accelerator allocation").fill("2")
  await dialog.getByLabel("GPU memory allocation (GB)").fill("11")
  const product = detected.products[0]
  if (product) {
    await dialog.getByLabel(`${product} accelerator limit`).fill("1")
    await dialog.getByLabel(`${product} GPU memory limit (GB)`).fill("8")
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expectToast(page, "Saved")

  await expect
    .poll(async () => (await users(request, token)).find((u) => u.username === username), {
      timeout: 30_000,
    })
    .toMatchObject({
      role: "poweruser",
      quota_cpu: "3",
      quota_memory: "6Gi",
      quota_gpu: 2,
      quota_vram_gb: 11,
    })
  if (product) {
    // `POST /users` has no per-model fields, so the console applies them with a
    // follow-up `PUT`. Without that they were silently dropped.
    const record = (await users(request, token)).find((u) => u.username === username)!
    const asMap = (value: Record<string, number> | string | null | undefined) =>
      typeof value === "string" ? JSON.parse(value || "{}") : value || {}
    expect(asMap(record.gpu_quota_by_type)[product]).toBe(1)
    expect(asMap(record.vram_quota_by_type)[product]).toBe(8)
  }

  const row = page.getByText(username, { exact: true }).locator("xpath=../..")
  await expect(row).toContainText("poweruser")
  await expect(row).toContainText("2 accelerators")
  await expect(row).toContainText("11 GB GPU memory")

  // The account really works.
  const login = await request.post("/api/mlmanage/login", {
    data: { username, password },
    failOnStatusCode: false,
  })
  expect(login.ok(), "the created account can sign in").toBeTruthy()

  // Deleting is confirmed, and declining keeps the account.
  dismissNextConfirm(page)
  await row.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(username, { exact: true })).toBeVisible()
  acceptNextConfirm(page)
  await row.getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(username, { exact: true })).toHaveCount(0)
  expect((await users(request, token)).some((u) => u.username === username)).toBe(false)
})

test("editing an account exposes only the fields the update endpoint accepts", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const group = unique("edit-group")
  const created = await request.post("/api/mlmanage/groups", {
    headers: auth(token),
    data: { name: group, total_gpus: 1 },
    failOnStatusCode: false,
  })
  expect([200, 201]).toContain(created.status())

  await signInAsAdmin(page, request)
  await goTo(page, "Administration")
  const row = page
    .getByText(workloadUser.username, { exact: true })
    .locator("xpath=../..")
  await row.getByRole("button", { name: "Edit" }).click()
  const dialog = modal(page, /Edit account/)

  // Create-time values are shown for reference and cannot be edited.
  await expect(dialog.getByLabel("Username")).toBeDisabled()
  await expect(dialog.getByLabel("Role")).toBeDisabled()
  await expect(
    dialog.getByText(/The role is fixed once the account exists/)
  ).toBeVisible()
  for (const label of [
    "CPU allocation",
    "Memory allocation",
    "Accelerator allocation",
    "GPU memory allocation (GB)",
  ])
    await expect(dialog.getByLabel(label, { exact: true })).toBeDisabled()
  await expect(
    dialog.getByText(/Account-wide allocations are set at creation/)
  ).toBeVisible()

  // The profile fields the API does accept are editable, with the group taken from the
  // groups the deployment has.
  expect(await optionValues(dialog.getByLabel("Group"))).toContain(group)
  await dialog.getByLabel("Email (optional)").fill("mlm-live-edited@example.test")
  await dialog.getByLabel("Slack member ID (optional)").fill("U-EDITED")
  await dialog.getByLabel("Group").selectOption(group)
  await dialog.getByLabel("Scheduling priority").fill("7")
  const product = detected.products[0]
  if (product) {
    await dialog.getByLabel(`${product} accelerator limit`).fill("2")
    await dialog.getByLabel(`${product} GPU memory limit (GB)`).fill("9")
  }
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expectToast(page, "Saved")

  await expect
    .poll(
      async () =>
        (await users(request, token)).find((u) => u.username === workloadUser.username),
      { timeout: 30_000 }
    )
    .toMatchObject({
      email: "mlm-live-edited@example.test",
      slack_id: "U-EDITED",
      team: group,
      priority: 7,
    })
  await expect(row).toContainText(`group ${group}`)
  await expect(row).toContainText("priority 7")

  // Focus stays in the field being typed into.
  await row.getByRole("button", { name: "Edit" }).click()
  const reopened = modal(page, /Edit account/)
  await expect(reopened.getByLabel("Email (optional)")).toHaveValue(
    "mlm-live-edited@example.test"
  )
  const email = reopened.getByLabel("Email (optional)")
  await email.fill("focus@example.test")
  await email.pressSequentially(".kept")
  await expect(email).toHaveValue("focus@example.test.kept")
  await reopened.getByRole("button", { name: "Cancel" }).click()
  await expect(reopened).toHaveCount(0)

  // Reset the shared fixture account.
  await request.put(
    `/api/mlmanage/users/${encodeURIComponent(workloadUser.username)}`,
    {
      headers: auth(token),
      data: {
        email: null,
        slack_id: null,
        team: null,
        priority: 0,
        gpu_quota_by_type: {},
        vram_quota_by_type: {},
      },
      failOnStatusCode: false,
    }
  )
})

test("an administrator is not offered a control that would delete their own account", async ({
  page,
  request,
}) => {
  const account = await admin(request)
  await signInAsAdmin(page, request)
  await goTo(page, "Administration")
  const own = page.getByText(account.username, { exact: true }).first().locator("xpath=../..")
  await expect(own.getByRole("button", { name: "Edit" })).toBeVisible()
  await expect(own.getByRole("button", { name: "Delete" })).toHaveCount(0)
})

test("data retention shows the live policy and updates its durations", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const original = await apiGet<Cleanup>(request, token, "/settings/cleanup")

  try {
    await signInAsAdmin(page, request)
    await goTo(page, "Administration")
    await expect(page.getByRole("heading", { name: "Data retention" })).toBeVisible()
    const policy = page
      .locator("dl")
      .filter({ has: page.getByText("Completed task records", { exact: true }) })
      .first()
    await expect(policy).toContainText(original.enabled ? "Enabled" : "Disabled")
    for (const seconds of [
      original.standalone_task_ttl_seconds,
      original.result_ttl_seconds,
      original.results_helper_idle_ttl_seconds,
    ])
      await expect(policy).toContainText(`${seconds / 3600} hours`)

    await page.getByRole("button", { name: "Edit retention policy" }).click()
    const dialog = modal(page, /Data retention/)
    // Whether the reaper runs at all is a deployment setting, so it is described, not
    // offered as a control.
    await expect(
      dialog.getByText(/That switch is the backend’s CLEANUP_ENABLED environment setting/)
    ).toBeVisible()
    await expect(dialog.getByLabel("How often to check")).toHaveValue(
      String(original.cleanup_interval_seconds / 3600)
    )
    await dialog.getByLabel("How often to check").fill("1")
    await dialog.getByLabel("Keep completed task records").fill("12")
    await dialog.getByLabel("Keep result files").fill("48")
    await dialog.getByLabel("Keep idle result helpers").fill("2")
    await dialog.getByRole("button", { name: "Save retention policy" }).click()
    await expectToast(page, "Saved")

    await expect
      .poll(async () => apiGet<Cleanup>(request, token, "/settings/cleanup"), {
        timeout: 30_000,
      })
      .toMatchObject({
        cleanup_interval_seconds: 3_600,
        standalone_task_ttl_seconds: 43_200,
        result_ttl_seconds: 172_800,
        results_helper_idle_ttl_seconds: 7_200,
      })
    // The section re-reads the policy it just changed.
    await expect(policy).toContainText("12 hours")
    await expect(policy).toContainText("48 hours")
    await expect(policy).toContainText("2 hours")
  } finally {
    // Retention deletes user data: put the deployment's own policy back.
    await request.put("/api/mlmanage/settings/cleanup", {
      headers: auth(token),
      data: {
        cleanup_interval_seconds: original.cleanup_interval_seconds,
        standalone_task_ttl_seconds: original.standalone_task_ttl_seconds,
        result_ttl_seconds: original.result_ttl_seconds,
        results_helper_idle_ttl_seconds: original.results_helper_idle_ttl_seconds,
      },
      failOnStatusCode: false,
    })
  }
})

test("administration is unreachable for every non-administrator role", async ({
  page,
  request,
}) => {
  for (const account of [workloadUser, powerUser, readonlyUser]) {
    await signIn(page, account)
    await expect(
      page.getByRole("button", { name: "Administration" })
    ).toHaveCount(0)
    const token = await loginApi(request, account)
    for (const [method, path, data] of [
      ["get", "/users", undefined],
      ["get", "/settings/cleanup", undefined],
      ["post", "/users", { username: unique("denied"), password: "x", role: "user" }],
    ] as const) {
      const response =
        method === "get"
          ? await request.get(`/api/mlmanage${path}`, {
              headers: auth(token),
              failOnStatusCode: false,
            })
          : await request.post(`/api/mlmanage${path}`, {
              headers: auth(token),
              data,
              failOnStatusCode: false,
            })
      expect(response.status(), `${method} ${path} as ${account.role}`).toBe(403)
    }
    await page.getByRole("button", { name: "Sign out" }).first().click()
  }
})
