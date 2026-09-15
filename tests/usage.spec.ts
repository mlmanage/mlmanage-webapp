/**
 * Usage: allocated accelerator time, energy, carbon footprint, per-scope analytics, the
 * CSV export, the activity feed and hardware telemetry.
 *
 * Monitoring is infrastructure-dependent, so every assertion about utilization, energy,
 * CO₂, temperature or power is derived from what the backend currently reports: where
 * there are no samples the console must say "Not monitored" rather than invent a number,
 * and that is asserted too.
 */
import { expect, test, type APIRequestContext } from "@playwright/test"
import { CO2_KG_PER_KWH, formatCo2, formatEnergy } from "../lib/mlmanage-api"
import {
  apiGet,
  apiList,
  auth,
  ensureRoleAccounts,
  freeGpu,
  futureWindow,
  goTo,
  loginApi,
  optionValues,
  signIn,
  signInAsAdmin,
  sweep,
  unique,
  workloadUser,
} from "./support/mlmanage"

type AnalyticsResult = {
  group?: string
  user?: string
  team?: string
  project?: string
  avg_utilization_percent?: number
  energy_kwh?: number | null
  co2_kg?: number | null
  job_count?: number
  allocated_gpu_hours?: number
  efficiency_note?: string
}
type Analytics = { group_by: string; hours: number; results: AnalyticsResult[] }
type Activity = {
  job_id: string
  job_name: string
  user: string
  status: string
  gpu_count: number
  duration_seconds: number
  allocated_gpu_seconds: number
}
type UsagePoint = {
  timestamp: string
  gpu_uuid?: string
  utilization: number
  memory?: number
  memory_used?: number
  temperature?: number
  power?: number
}

const analyticsFor = (
  request: APIRequestContext,
  token: string,
  query: string
) => apiGet<Analytics>(request, token, `/analytics/usage?${query}`)

/**
 * A headline tile, located by its own `<p>` label. The per-scope table repeats the same
 * words as column headers, so matching on text alone would be ambiguous.
 */
function tile(page: import("@playwright/test").Page, label: string) {
  return page
    .locator("p")
    .filter({ hasText: new RegExp(`^${label}$`) })
    .first()
    .locator("..")
}

/** Seed one workload with real lifecycle timestamps so the report has something in it. */
async function seedActivity(request: APIRequestContext, token: string) {
  const name = unique("usage-seed")
  const response = await request.post("/api/mlmanage/queue", {
    headers: auth(token),
    data: {
      display_name: name,
      image: "alpine:latest",
      command: ["true"],
      gpus: 1,
      replicas: 1,
      priority: 0,
    },
  })
  expect(response.ok()).toBeTruthy()
  return name
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("usage opens on the signed-in account over seven days and explains its numbers", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  await seedActivity(request, token)

  await signInAsAdmin(page, request)
  await goTo(page, "Usage")
  await expect(page.getByLabel("Usage scope")).toHaveValue("mine")
  await expect(page.getByLabel("Usage period")).toHaveValue("168")
  await expect(page.getByText(/^Last 7 days\./)).toBeVisible()
  await expect(
    page.getByText(/Accelerator time comes from real Job lifecycle timestamps/)
  ).toBeVisible()
  await expect(
    page.getByText(
      /Hardware utilization, energy and carbon footprint appear only when monitoring is configured/
    )
  ).toBeVisible()

  // The four headline figures are always labelled, monitored or not.
  for (const label of [
    "Jobs with GPU time",
    "Energy used",
    "Carbon footprint",
    "Average utilization",
  ])
    await expect(page.getByText(label, { exact: true })).toBeVisible()

  // Changing the period relabels the report and reloads it.
  await page.getByLabel("Usage period").selectOption("24")
  await expect(page.getByText(/^Last 24 hours\./)).toBeVisible()
  await page.getByLabel("Usage period").selectOption("720")
  await expect(page.getByText(/^Last 30 days\./)).toBeVisible()
  await page.getByLabel("Usage period").selectOption("168")
  await page.getByRole("button", { name: "Refresh usage" }).click()
  await expect(page.getByText("Loading usage…")).toHaveCount(0, { timeout: 30_000 })

  // The raw Prometheus exposition is left to the monitoring stack, not rendered here.
  await expect(page.getByText("Metrics preview", { exact: true })).toHaveCount(0)
})

test("the headline figures match what the analytics endpoint reports", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  await seedActivity(request, token)
  const admin = await apiGet<{ username: string }>(request, token, "/me")
  const query = `group_by=user&hours=168&subject=${encodeURIComponent(admin.username)}`
  await expect
    .poll(async () => (await analyticsFor(request, token, query)).results.length, {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBeGreaterThan(0)
  const analytics = await analyticsFor(request, token, query)
  const activity = await apiGet<Activity[]>(
    request,
    token,
    `/analytics/activity?${query}`
  )

  await signInAsAdmin(page, request)
  await goTo(page, "Usage")
  await expect(page.getByText("Loading usage…")).toHaveCount(0, { timeout: 30_000 })

  const sum = (values: Array<number | null | undefined>) =>
    values.filter((value): value is number => value != null).reduce((a, b) => a + b, 0)
  const energies = analytics.results
    .map((item) => item.energy_kwh)
    .filter((value): value is number => value != null)
  const co2s = analytics.results
    .map((item) => item.co2_kg)
    .filter((value): value is number => value != null)

  // Jobs and allocated time come from the activity feed, not from the analytics rows.
  await expect(tile(page, "Jobs with GPU time")).toContainText(String(activity.length))

  const energyTile = tile(page, "Energy used")
  await expect(energyTile).toContainText(
    energies.length ? formatEnergy(sum(energies))! : "Not monitored"
  )
  await expect(energyTile).toContainText(
    energies.length ? "Measured from GPU power samples" : "Needs GPU power monitoring"
  )

  await expect(tile(page, "Carbon footprint")).toContainText(
    co2s.length ? formatCo2(sum(co2s))! : "Not monitored"
  )

  const utilization = analytics.results
    .map((item) => item.avg_utilization_percent)
    .filter((value): value is number => value != null)
  await expect(tile(page, "Average utilization")).toContainText(
    utilization.length
      ? `${(sum(utilization) / utilization.length).toFixed(1)}%`
      : "Not monitored"
  )

  // The per-scope table repeats each row with the efficiency note the backend supplies.
  for (const result of analytics.results.slice(0, 3)) {
    const scope =
      result.project || result.user || result.team || result.group || "Workspace"
    const row = page.getByRole("row").filter({ hasText: scope }).first()
    await expect(row).toBeVisible()
    await expect(row).toContainText(
      result.energy_kwh == null ? "Not monitored" : formatEnergy(result.energy_kwh)!
    )
    if (result.efficiency_note && result.efficiency_note !== "ok")
      await expect(row).toContainText(result.efficiency_note)
  }
  // The CO₂ figure states the formula that produced it instead of standing alone.
  await expect(
    page.getByText(
      new RegExp(`Carbon footprint = energy × ${CO2_KG_PER_KWH} kg CO₂ per kWh`)
    )
  ).toBeVisible()
})

test("the scope selector only offers subjects the backend will answer for", async ({
  page,
  request,
}) => {
  const adminToken = await loginApi(request)
  const mine = unique("my-project")
  const foreign = unique("other-project")
  for (const [name, members] of [
    [mine, [workloadUser.username]],
    [foreign, ["admin"]],
  ] as const) {
    const created = await request.post("/api/mlmanage/projects", {
      headers: auth(adminToken),
      data: { name, owner: "admin", members, total_gpus: 1 },
      failOnStatusCode: false,
    })
    expect([200, 201]).toContain(created.status())
  }

  // An administrator may select any user, project or group.
  await signInAsAdmin(page, request)
  await goTo(page, "Usage")
  expect(await optionValues(page.getByLabel("Usage scope"))).toEqual([
    "mine",
    "user",
    "project",
    "team",
  ])
  await page.getByLabel("Usage scope").selectOption("user")
  const users = await apiList<{ username: string }>(
    request,
    adminToken,
    "/users",
    "users"
  )
  // Every account is selectable, plus the "All available" entry. Compared as a set so
  // the assertion does not depend on the order `GET /users` happens to return.
  await expect
    .poll(async () => (await optionValues(page.getByLabel("Usage subject"))).sort(), {
      timeout: 30_000,
    })
    .toEqual(["", ...users.map((account) => account.username)].sort())
  await page.getByLabel("Usage scope").selectOption("project")
  expect(await optionValues(page.getByLabel("Usage subject"))).toContain(foreign)

  // A workload account may not select other users at all, and only sees the projects
  // and groups it belongs to - the backend answers 403 for anything else.
  await page.getByRole("button", { name: "Sign out" }).first().click()
  await signIn(page, workloadUser)
  await goTo(page, "Usage")
  expect(await optionValues(page.getByLabel("Usage scope"))).toEqual([
    "mine",
    "project",
    "team",
  ])
  await expect(
    page.getByText(/Only activity available to your account is shown/)
  ).toBeVisible()
  await page.getByLabel("Usage scope").selectOption("project")
  // The shell renders as soon as /me answers, while the project list is still loading.
  await expect
    .poll(async () => optionValues(page.getByLabel("Usage subject")), {
      timeout: 30_000,
    })
    .toContain(mine)
  expect(await optionValues(page.getByLabel("Usage subject"))).not.toContain(foreign)

  const token = await loginApi(request, workloadUser)
  const denied = await request.get(
    `/api/mlmanage/analytics/usage?group_by=project&hours=168&subject=${encodeURIComponent(foreign)}`,
    { headers: auth(token), failOnStatusCode: false }
  )
  expect(denied.status()).toBe(403)
})

test("the report downloads as a CSV that carries the table and a total row", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  await seedActivity(request, token)
  await expect
    .poll(
      async () =>
        (await analyticsFor(request, token, "group_by=user&hours=168")).results.length,
      { timeout: 60_000, intervals: [2_000] }
    )
    .toBeGreaterThan(0)

  await signInAsAdmin(page, request)
  await goTo(page, "Usage")
  await expect(page.getByText("Loading usage…")).toHaveCount(0, { timeout: 30_000 })
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download this report (CSV)" }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe("mlmanage-usage-mine-168h.csv")
  const chunks: Buffer[] = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer)
  const rows = Buffer.concat(chunks).toString("utf8").split("\r\n")
  expect(rows[0]).toBe(
    "scope,jobs,allocated_gpu_hours,avg_utilization_percent,energy_kwh,co2_kg,efficiency_note"
  )
  expect(rows.at(-1)).toContain("total for this scope and period")
  expect(rows.length).toBeGreaterThan(2)
})

test("GPU activity lists the workloads that held an allocation", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const window = futureWindow(2)
  const gpu = await freeGpu(request, token, window)
  const created = await request.post("/api/mlmanage/jobs", {
    headers: auth(token),
    data: {
      display_name: unique("activity-job"),
      gpu_uuid: gpu.gpu_uuid,
      start_time: window.startIso,
      end_time: window.endIso,
      image: "alpine:latest",
      command: ["true"],
      resources: { limits: { "nvidia.com/gpu": 1 } },
    },
  })
  expect(created.ok()).toBeTruthy()
  const jobId = ((await created.json()) as { job: { id: number } }).job.id

  await signInAsAdmin(page, request)
  await goTo(page, "Usage")
  await expect(page.getByRole("heading", { name: "GPU activity" })).toBeVisible()
  await expect(
    page.getByText(/This activity is derived from real workload start and finish times/)
  ).toBeVisible()

  const activity = await apiGet<Activity[]>(
    request,
    token,
    "/analytics/activity?group_by=user&hours=168"
  )
  const ours = activity.find((item) => String(item.job_id) === String(jobId))
  expect(ours, "the scheduled job is reported as activity").toBeTruthy()
  const row = page.getByRole("row").filter({ hasText: ours!.job_name }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText(String(ours!.gpu_count))
  await expect(row).toContainText(ours!.status)
  // Durations are rendered in human units rather than raw seconds.
  await expect(row).toContainText(/\d+(\.\d+)?(s|m|h)/)
})

test("hardware telemetry appears only when the backend has samples", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const samples = await apiGet<UsagePoint[]>(request, token, "/gpu/usage?hours=168")

  await signInAsAdmin(page, request)
  await goTo(page, "Usage")
  await expect(page.getByText("Hardware telemetry")).toBeVisible()
  await expect(page.getByText("Loading usage…")).toHaveCount(0, { timeout: 30_000 })

  if (!samples.length) {
    await expect(
      page.getByText(/No monitored hardware samples are available/)
    ).toBeVisible()
    return
  }
  for (const header of [
    "Time",
    "Accelerator",
    "Utilization",
    "Memory used",
    "Temperature",
    "Power draw",
  ])
    await expect(
      page.getByRole("columnheader", { name: header }).first()
    ).toBeVisible()
  // Values carry their unit; a missing measurement is a dash, not a zero.
  const telemetry = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Power draw" }) })
    .first()
  await expect(telemetry).toContainText("%")
  const latest = samples.at(-1)!
  if (latest.temperature != null) await expect(telemetry).toContainText("°C")
  if (latest.power != null) await expect(telemetry).toContainText("W")
})

test("an administrator can read another account's telemetry, and a user cannot", async ({
  page,
  request,
}) => {
  const adminToken = await loginApi(request)
  const userToken = await loginApi(request, workloadUser)

  // Cross-user telemetry is admin-only in the backend.
  expect(
    (
      await request.get(
        `/api/mlmanage/gpu/usage/${encodeURIComponent("admin")}?hours=24`,
        { headers: auth(userToken), failOnStatusCode: false }
      )
    ).status()
  ).toBe(403)
  expect(
    (
      await request.get(
        `/api/mlmanage/gpu/usage/${encodeURIComponent(workloadUser.username)}?hours=24`,
        { headers: auth(adminToken), failOnStatusCode: false }
      )
    ).ok()
  ).toBeTruthy()

  // And the console reaches it by selecting a user as the subject.
  await signInAsAdmin(page, request)
  await goTo(page, "Usage")
  await page.getByLabel("Usage scope").selectOption("user")
  await page.getByLabel("Usage subject").selectOption(workloadUser.username)
  await expect(page.getByText("Loading usage…")).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByRole("status").filter({ hasText: /403/ })).toHaveCount(0)
  await expect(page.getByText("Hardware telemetry")).toBeVisible()
})
