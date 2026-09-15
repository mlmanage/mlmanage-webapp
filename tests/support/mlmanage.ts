/**
 * Shared support for the live MLManage suites.
 *
 * Everything here is hardware- and deployment-agnostic: accelerator UUIDs,
 * products, counts, supported sharing modes, MIG profiles, and monitoring
 * availability are discovered from the running backend rather than hardcoded.
 * Credentials are supplied explicitly through environment variables.
 *
 * Conventions:
 * - Every record these suites create is prefixed with `mlm-live-`, so `sweep()`, the
 *   per-file `afterAll`, and `tests/global-teardown.ts` can all identify and remove
 *   exactly our artifacts and never touch team data.
 * - Reservations carry no name, so they are placed in a dedicated far-future band
 *   (see `RESERVATION_BAND_START`). Anything active in that band is ours and is
 *   released by the sweep. A far-future window also guarantees the backend
 *   scheduler never dispatches a pod for a test job.
 */
import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test"

/** Prefix shared with `tests/global-teardown.ts` and the backend `tests_suite` sweep. */
export const TEST_PREFIX = "mlm-live-"

/**
 * Reservations created by these suites start no earlier than this. It is inside the
 * window `global-teardown.ts` already sweeps (`>= 2027-01-01`), and far enough out
 * that no real user schedule can plausibly overlap it.
 */
export const RESERVATION_BAND_START = "2033-01-01T00:00:00"

/** Role fixtures are created on demand and reused across test runs. */
export const ROLE_ACCOUNT_PASSWORD =
  process.env.MLM_ROLE_PASSWORD ||
  (() => {
    throw new Error("Set MLM_ROLE_PASSWORD before running the live test suite.")
  })()
export const workloadUser = {
  username: process.env.MLM_USER || "frontend-user",
  password: ROLE_ACCOUNT_PASSWORD,
  role: "user",
}
export const powerUser = {
  username: process.env.MLM_POWERUSER || "frontend-poweruser",
  password: ROLE_ACCOUNT_PASSWORD,
  role: "poweruser",
}
export const readonlyUser = {
  username: process.env.MLM_READONLY || "frontend-readonly",
  password: ROLE_ACCOUNT_PASSWORD,
  role: "readonly",
}

export type Account = { username: string; password: string; role?: string }

/** Administrator credentials must be provided for the target test environment. */
let adminPromise: Promise<Account> | null = null

export function admin(request: APIRequestContext): Promise<Account> {
  adminPromise ??= (async () => {
    const username = process.env.MLM_ADMIN_USER || "admin"
    const password = process.env.MLM_ADMIN_PASSWORD
    if (!password)
      throw new Error("Set MLM_ADMIN_PASSWORD before running the live test suite.")

    const response = await request.post("/api/mlmanage/login", {
      data: { username, password },
      failOnStatusCode: false,
    })
    if (response.ok()) return { username, password, role: "admin" }
    throw new Error(
      `Could not sign in as "${username}". Check MLM_ADMIN_USER and MLM_ADMIN_PASSWORD.`
    )
  })()
  return adminPromise
}

/** A run-unique, sweepable name for anything this suite creates. */
export function unique(label: string) {
  return `${TEST_PREFIX}${label}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`
}

// ─────────────────────────────── API access ────────────────────────────────

export async function loginApi(
  request: APIRequestContext,
  account?: Account
): Promise<string> {
  const credentials = account ?? (await admin(request))
  const response = await request.post("/api/mlmanage/login", {
    data: { username: credentials.username, password: credentials.password },
  })
  expect(
    response.ok(),
    `login failed for ${credentials.username}: ${response.status()}`
  ).toBeTruthy()
  return ((await response.json()) as { access_token: string }).access_token
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` }
}

/** GET returning the named collection, tolerating both `{key: []}` and a bare list. */
export async function apiList<T>(
  request: APIRequestContext,
  token: string,
  path: string,
  key: string
): Promise<T[]> {
  const response = await request.get(`/api/mlmanage${path}`, {
    headers: auth(token),
    failOnStatusCode: false,
  })
  if (!response.ok()) return []
  const body: unknown = await response.json()
  if (Array.isArray(body)) return body as T[]
  return ((body as Record<string, T[]>)?.[key] ?? []) as T[]
}

export async function apiGet<T>(
  request: APIRequestContext,
  token: string,
  path: string
): Promise<T> {
  const response = await request.get(`/api/mlmanage${path}`, {
    headers: auth(token),
  })
  expect(response.ok(), `GET ${path} -> ${response.status()}`).toBeTruthy()
  return (await response.json()) as T
}

/** Create the documented role fixtures if this deployment does not have them yet. */
export async function ensureRoleAccounts(
  request: APIRequestContext,
  accounts: Account[] = [workloadUser, powerUser, readonlyUser]
) {
  const token = await loginApi(request)
  const existing = new Set(
    (
      await apiList<{ username: string }>(request, token, "/users", "users")
    ).map((account) => account.username)
  )
  for (const account of accounts) {
    if (existing.has(account.username)) continue
    const response = await request.post("/api/mlmanage/users", {
      headers: auth(token),
      data: account,
      failOnStatusCode: false,
    })
    // 400/409 = created concurrently by another worker or an earlier attempt.
    expect(
      [200, 201, 400, 409],
      `could not create ${account.username}: ${response.status()} ${await response.text()}`
    ).toContain(response.status())
  }
  // A brand new account only becomes usable once the row is committed; the namespace
  // and PVCs it also provisions are asynchronous and not needed to sign in.
  for (const account of accounts)
    await expect
      .poll(
        async () =>
          (
            await request.post("/api/mlmanage/login", {
              data: { username: account.username, password: account.password },
              failOnStatusCode: false,
            })
          ).ok(),
        { timeout: 30_000, intervals: [500, 1_000, 2_000] }
      )
      .toBe(true)
}

/**
 * Best-effort, idempotent removal of everything the suites create, in dependency
 * order: queue -> tasks -> jobs (which also cancels the linked reservation) ->
 * images -> projects -> groups -> band reservations -> prefixed accounts.
 */
export async function sweep(
  request: APIRequestContext,
  options: { includeAccounts?: boolean } = {}
) {
  let token: string
  try {
    token = await loginApi(request)
  } catch {
    return // backend unreachable; the next run's sweep re-detects leftovers
  }
  const headers = auth(token)
  const del = async (path: string) => {
    try {
      await request.delete(`/api/mlmanage${path}`, {
        headers,
        failOnStatusCode: false,
      })
    } catch {
      // best effort
    }
  }
  const ours = (value: unknown) =>
    typeof value === "string" && value.startsWith(TEST_PREFIX)

  for (const item of await apiList<Record<string, unknown>>(
    request,
    token,
    "/queue",
    "queue"
  ))
    if (ours(item.display_name)) {
      for (const task of (item.task_names as string[]) ?? [])
        await del(`/tasks/${encodeURIComponent(task)}`)
      await del(`/queue/${item.id}`)
    }
  for (const job of await apiList<Record<string, unknown>>(
    request,
    token,
    "/jobs",
    "jobs"
  ))
    if (ours(job.display_name)) {
      if (typeof job.task_name === "string" && job.task_name)
        await del(`/tasks/${encodeURIComponent(job.task_name)}`)
      await del(`/jobs/${job.id}`)
    }
  for (const image of await apiList<Record<string, unknown>>(
    request,
    token,
    "/images",
    "images"
  ))
    if (ours(image.name)) await del(`/images/${image.id}`)
  for (const project of await apiList<Record<string, unknown>>(
    request,
    token,
    "/projects",
    "projects"
  ))
    if (ours(project.name))
      await del(`/projects/${encodeURIComponent(String(project.name))}`)
  for (const group of await apiList<Record<string, unknown>>(
    request,
    token,
    "/groups",
    "groups"
  ))
    if (ours(group.name))
      await del(`/groups/${encodeURIComponent(String(group.name))}`)
  // Reservations have no name: the far-future band is the marker instead.
  for (const reservation of await apiList<Record<string, unknown>>(
    request,
    token,
    "/reservations",
    "reservations"
  ))
    if (
      reservation.status === "active" &&
      typeof reservation.start_time === "string" &&
      reservation.start_time >= RESERVATION_BAND_START
    )
      await del(`/reservations/${reservation.id}`)
  if (options.includeAccounts)
    for (const account of await apiList<Record<string, unknown>>(
      request,
      token,
      "/users",
      "users"
    ))
      if (ours(account.username))
        await del(
          `/users/${encodeURIComponent(String(account.username))}?delete_namespace=true`
        )
}

// ───────────────────────────── inventory discovery ─────────────────────────────

export type Gpu = {
  uuid: string
  product?: string
  node?: string
  memory_gb?: number
  simulated?: boolean
  synthetic_e2e?: boolean
  /** Units this card publishes right now; > 1 means it is divided into shares. */
  shares?: number
  sharing_strategy?: string | null
}
export type GpuCapability = {
  gpu_uuid?: string
  uuid?: string
  product?: string
  node?: string
  mig_capable?: boolean
  supported_modes?: string[]
  memory_gb?: number
  simulated?: boolean
  shares?: number
  sharing_strategy?: string | null
  partition?: Partition | null
}
export type Partition = {
  gpu_uuid: string
  node?: string
  product?: string | null
  mode: string
  replicas?: number | null
  mig_profiles?: Record<string, number> | string | null
  applied?: boolean | null
}
export type AvailabilityGpu = {
  gpu_uuid: string
  product?: string
  node?: string
  synthetic_e2e?: boolean
  available: boolean
  busy_windows: Array<{ start: string; end: string; reserved?: boolean }>
}

export type Inventory = {
  gpus: Gpu[]
  /** Cards a workload can actually be placed on. */
  schedulable: Gpu[]
  capabilities: GpuCapability[]
  partitions: Partition[]
  /** Sharing modes at least one card in this deployment reports. */
  modes: Set<string>
  migCapable: GpuCapability[]
  /** Distinct `product` values, which is what the per-model quota fields key on. */
  products: string[]
}

export async function inventory(
  request: APIRequestContext,
  token: string
): Promise<Inventory> {
  const gpus = await apiList<Gpu>(request, token, "/gpu/list", "gpus")
  const capabilities = await apiList<GpuCapability>(
    request,
    token,
    "/gpu/capabilities",
    "gpus"
  )
  const partitions = await apiList<Partition>(
    request,
    token,
    "/gpu/partitions",
    "partitions"
  )
  const modes = new Set<string>()
  for (const capability of capabilities)
    for (const mode of capability.supported_modes || []) modes.add(mode)
  return {
    gpus,
    schedulable: gpus.filter((gpu) => !gpu.simulated),
    capabilities,
    partitions,
    modes,
    migCapable: capabilities.filter((capability) => capability.mig_capable),
    products: [
      ...new Set(gpus.map((gpu) => gpu.product || gpu.uuid).filter(Boolean)),
    ],
  }
}

export function capabilityFor(inventoryData: Inventory, uuid: string) {
  return inventoryData.capabilities.find(
    (capability) => (capability.gpu_uuid || capability.uuid) === uuid
  )
}

/** MIG profiles a card is configured for, mirroring `migProfilesFor` in the console. */
export function migProfilesFor(partitions: Partition[], uuid: string) {
  const record = partitions.find(
    (partition) => partition.gpu_uuid === uuid && partition.mode === "mig"
  )
  if (!record) return []
  const profiles =
    typeof record.mig_profiles === "string"
      ? (JSON.parse(record.mig_profiles || "{}") as Record<string, number>)
      : record.mig_profiles || {}
  return Object.keys(profiles)
}

export async function availabilityFor(
  request: APIRequestContext,
  token: string,
  window: Window
): Promise<AvailabilityGpu[]> {
  const body = await apiGet<{ gpus: AvailabilityGpu[] }>(
    request,
    token,
    `/availability?start_time=${encodeURIComponent(window.startIso)}&end_time=${encodeURIComponent(window.endIso)}`
  )
  return body.gpus || []
}

/** A card that is free for `window`, chosen from live availability. */
export async function freeGpu(
  request: APIRequestContext,
  token: string,
  window: Window
): Promise<AvailabilityGpu> {
  const gpus = await availabilityFor(request, token, window)
  const free = gpus.find((gpu) => gpu.available)
  expect(
    free,
    `no accelerator is free for ${window.startIso}..${window.endIso}`
  ).toBeTruthy()
  return free!
}

// ───────────────────────────────── windows ─────────────────────────────────

export type Window = {
  start: Date
  end: Date
  startIso: string
  endIso: string
}

/**
 * Each call returns a distinct one-slot-per-day window inside the far-future band, so
 * concurrent tests, retries and repeated runs never collide on a card. The random day
 * base keeps two simultaneous runs apart as well.
 */
const bandBase = Date.UTC(2033, 0, 1, 8, 0, 0)
const bandDayOffset = Math.floor(Math.random() * 2_000)
let bandSlot = 0

export function futureWindow(hours = 2): Window {
  const start = new Date(
    bandBase + (bandDayOffset + bandSlot++) * 24 * 3_600_000
  )
  return windowFrom(start, hours)
}

export function windowFrom(start: Date, hours = 2): Window {
  return {
    start,
    end: new Date(start.getTime() + hours * 3_600_000),
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + hours * 3_600_000).toISOString(),
  }
}

/**
 * The three time helpers below all evaluate inside the page, so they use the *browser's*
 * timezone and locale rather than the Node process's. That is what makes these suites
 * timezone-independent: they work unchanged on a UTC CI machine and under an explicit
 * `test.use({ timezoneId })`, and they compare against exactly the string the console
 * renders instead of a re-implementation of its formatting.
 */

/** Value to type into a `datetime-local` control for this instant. */
export function toLocalInput(page: Page, date: Date) {
  return page.evaluate((iso) => {
    const value = new Date(iso)
    return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16)
  }, date.toISOString())
}

/** How the console renders this instant with `toLocaleString()`. */
export function displayedDateTime(page: Page, date: Date) {
  return page.evaluate(
    (iso) => new Date(iso).toLocaleString(),
    date.toISOString()
  )
}

/** How the console renders this instant with `toLocaleTimeString()`. */
export function displayedTime(page: Page, date: Date) {
  return page.evaluate(
    (iso) => new Date(iso).toLocaleTimeString(),
    date.toISOString()
  )
}

// ─────────────────────────────────── UI ───────────────────────────────────

export async function signIn(page: Page, account: Account) {
  await page.goto("/")
  await page.getByLabel("Username").fill(account.username)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Sign in" }).click()
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible({
    timeout: 30_000,
  })
}

export async function signInAsAdmin(page: Page, request: APIRequestContext) {
  await signIn(page, await admin(request))
}

/**
 * Navigate to a view at any viewport width: the sidebar below `lg` is replaced by a modal
 * drawer, so the same helper has to use whichever one the layout is currently showing.
 */
export async function goTo(
  page: Page,
  view:
    | "Jobs"
    | "Capacity"
    | "Projects"
    | "Usage"
    | "My account"
    | "Administration"
) {
  const sidebar = page.getByRole("navigation", { name: "Primary navigation" }).first()
  if (await sidebar.isVisible())
    await sidebar.getByRole("button", { name: view, exact: true }).click()
  else {
    await page.getByRole("button", { name: "Open navigation" }).click()
    await page
      .getByRole("dialog", { name: "Navigation menu" })
      .getByRole("button", { name: view, exact: true })
      .click()
  }
  await expect(page.getByRole("heading", { name: view, level: 1 })).toBeVisible()
}

/** Accept the next `window.confirm`, which the console uses for destructive actions. */
export function acceptNextConfirm(page: Page) {
  page.once("dialog", (dialog) => void dialog.accept())
}
export function dismissNextConfirm(page: Page) {
  page.once("dialog", (dialog) => void dialog.dismiss())
}

export function modal(page: Page, name: RegExp | string) {
  return page.getByRole("dialog", { name })
}

/** The row of the Capacity reservation table holding `uuid` at `window.start`. */
export async function reservationRow(page: Page, uuid: string, window: Window) {
  return page
    .getByRole("row")
    .filter({ hasText: uuid })
    .filter({ hasText: await displayedDateTime(page, window.start) })
    .first()
}

export async function openNewJob(page: Page) {
  await page.getByRole("button", { name: "New job" }).click()
  await expect(page.getByRole("dialog", { name: "What should run?" })).toBeVisible()
}

/** Fill the always-required part of New job with an external image reference. */
export async function fillJobBasics(
  page: Page,
  name: string,
  command = "sh\n-c\necho mlm-live",
  image = "alpine:latest"
) {
  await page.getByLabel("Job name").fill(name)
  await page.getByRole("tab", { name: "external" }).click()
  await page.getByLabel("External pull reference").fill(image)
  await page.getByLabel("Command").fill(command)
}

export async function openAdvancedScheduling(page: Page) {
  await page.getByText("Advanced scheduling (optional)").click()
}

/** Body of the page has not grown wider than the viewport. */
export async function expectNoOverflow(page: Page) {
  const width = (await page.viewportSize())!.width
  expect(
    await page.evaluate(() =>
      Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)
    )
  ).toBeLessThanOrEqual(width + 2)
}

/** Fails the test if browser code ever addresses the backend host directly. */
export function guardSameOrigin(page: Page) {
  const direct: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    const sameOrigin =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.protocol === "data:" ||
      url.protocol === "blob:"
    const appPort = url.port === "" || url.port === "3001"
    if (!sameOrigin || !appPort) direct.push(request.url())
  })
  return () => expect(direct).toEqual([])
}

/** Reads a triggered download as text. */
export async function downloadText(page: Page, trigger: () => Promise<void>) {
  const download = page.waitForEvent("download")
  await trigger()
  const file = await download
  const stream = await file.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return { name: file.suggestedFilename(), text: Buffer.concat(chunks).toString("utf8") }
}

export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.getByRole("status").filter({ hasText: text }).first()).toBeVisible({
    timeout: 30_000,
  })
}

/** Every option value of a `<select>`, in DOM order. */
export async function optionValues(select: Locator) {
  return select.locator("option").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value)
  )
}

export async function enabledOptionValues(select: Locator) {
  return select
    .locator("option:not([disabled])")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value)
    )
}
