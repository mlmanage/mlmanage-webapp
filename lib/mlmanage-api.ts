export type Role =
  | "admin"
  | "poweruser"
  | "user"
  | "readonly"
  | "read-only"
  | string

export type JsonMap = Record<string, unknown>

export type CurrentUser = {
  id: string
  username: string
  role: Role
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
  groups?: string[] | null
  projects?: string[] | null
  priority?: number | null
  gpu_quota_by_type?: Record<string, number> | string | null
  vram_quota_by_type?: Record<string, number> | string | null
}

export type Gpu = {
  uuid: string
  product?: string
  node?: string
  memory_gb?: number
  simulated?: boolean
  synthetic_e2e?: boolean
  /**
   * How many schedulable units this card currently publishes; 1 means the whole card,
   * which is the default for every accelerator. Sharing is configured per card, so this
   * follows this card's own configuration - a divided sibling does not change it.
   */
  shares?: number
  sharing_strategy?: string | null
}

export type GpuCapability = {
  gpu_uuid: string
  uuid?: string
  product?: string
  node?: string
  mig_capable?: boolean
  mig_strategy?: string
  current_strategy?: string
  supported_modes?: string[]
  memory_gb?: number
  simulated?: boolean
  synthetic_e2e?: boolean
  shares?: number
  sharing_strategy?: string | null
  partition?: GpuPartition | null
}

/**
 * Sharing modes the backend accepts for `POST /gpu/{uuid}/partition`, in the wording
 * used across this console. The backend reports which of them a card supports in
 * `GET /gpu/capabilities` (`supported_modes`).
 */
export const PARTITION_MODES: Array<{
  mode: "full" | "timeslice" | "mps" | "mig"
  label: string
  help: string
}> = [
  {
    mode: "full",
    label: "Full GPU",
    help:
      "One job at a time gets the whole accelerator, with all of its memory. This is also how a divided card is " +
      "rejoined: it drops this card out of the sharing configuration, so it republishes as one whole device once " +
      "the device plugin restarts. Other cards keep their own setting.",
  },
  {
    mode: "timeslice",
    label: "Time sharing",
    help:
      "The driver gives each job the whole card for a slice of TIME, switching between them every few milliseconds. " +
      "Every share still sees the card's full memory, so nothing is isolated: two jobs can exhaust the same VRAM and each " +
      "runs at roughly 1/N of the speed. Publishing N shares means N jobs may hold this card at once. Set per card: " +
      "dividing one accelerator leaves the others whole.",
  },
  {
    mode: "mps",
    label: "Concurrent sharing",
    help:
      "Jobs run at the same time through one MPS server instead of taking turns, so short kernels do not wait for each " +
      "other. Memory is still shared and unisolated, and a job that fails can take the others with it.",
  },
  {
    mode: "mig",
    label: "MIG hardware slices",
    help:
      "Splits a supported card into slices that each get their own memory and compute, isolated in hardware. " +
      "Only on cards that report MIG support, and at most 7 slices.",
  },
]

/** MIG profiles the backend validates against, with the VRAM each slice receives. */
export const MIG_PROFILE_VRAM_GB: Record<string, number> = {
  "1g.5gb": 5,
  "1g.10gb": 10,
  "1g.20gb": 20,
  "2g.10gb": 10,
  "2g.20gb": 20,
  "3g.20gb": 20,
  "3g.40gb": 40,
  "4g.20gb": 20,
  "7g.40gb": 40,
  "7g.80gb": 80,
}

export type GpuPartition = {
  id?: number
  node?: string
  gpu_uuid: string
  product?: string | null
  mode: "full" | "timeslice" | "mps" | "mig" | string
  replicas?: number | null
  mig_profiles?: Record<string, number> | string | null
  applied?: boolean | null
  applied_detail?: string | null
  updated_at?: string | null
}

export type ReservationEvent = {
  id: number | string
  title: string
  user?: string
  start: string
  end: string
  resourceId: string
  status?: string
}

export type ReservationRecord = {
  id: number
  user?: string
  username?: string
  gpu_uuid: string
  start_time: string
  end_time: string
  status?: string
  priority?: number | null
  gpu_partition?: string | null
  slice_index?: number | null
  notified_start?: boolean
  notified_end?: boolean
}

export type TaskRecord = {
  name: string
  user?: string
  image: string
  command: string[] | string
  resources: Record<string, unknown> | string
  gpu_uuid?: string | null
  time_limit_seconds?: number | null
  status?: string
  created_at?: string | null
  vram_limit_gb?: number | null
  gpu_partition?: string | null
  project?: string | null
}

export type JobRecord = {
  id: number
  display_name?: string | null
  reservation_id?: number | null
  task_name?: string | null
  user?: string
  username?: string
  gpu_uuid: string
  start_time: string
  end_time: string
  image: string
  command: string[] | string
  resources: Record<string, unknown> | string
  time_limit_seconds: number
  status: string
  created_at?: string | null
  vram_limit_gb?: number | null
  gpu_partition?: string | null
  project?: string | null
  priority?: number | null
}

export type ImageRecord = {
  id: number
  user: string
  name: string
  tag: string
  repository: string
  pull_ref: string
  size_bytes?: number | null
  visibility?: "user" | "project" | "group" | "everyone" | string
  project?: string | null
  group?: string | null
  created_at?: string | null
}

export type QueueRecord = {
  id: number
  display_name?: string | null
  user?: string
  team?: string | null
  image: string
  command: string[] | string
  resources?: Record<string, unknown> | string
  gpu_uuid?: string | null
  gpus?: number | null
  replicas?: number | null
  gang?: boolean | null
  mpi?: boolean | null
  vram_limit_gb?: number | null
  project?: string | null
  priority?: number | null
  time_limit_seconds?: number | null
  depends_on?: number[] | string | null
  status?: string
  task_names?: string[] | string | null
  /**
   * Why the work ended, captured from the pod before it was deleted. Kubernetes keeps
   * nothing once a pod is gone, so for a container that failed at startup this is the
   * only explanation that exists.
   */
  failure_reason?: string | null
  created_at?: string | null
  started_at?: string | null
  finished_at?: string | null
}

export type UsagePoint = {
  timestamp: string
  gpu_uuid?: string
  utilization: number
  memory?: number
  memory_used?: number
  temperature?: number
  power?: number
}

export type WorkloadActivity = {
  scope: string
  job_id: string
  job_name: string
  user: string
  project?: string | null
  status: string
  gpu_count: number
  gpu_uuid?: string | null
  started_at: string
  finished_at?: string | null
  duration_seconds: number
  allocated_gpu_seconds: number
  source: "workload" | string
}

export type TaskResultFile = {
  path: string
  size?: number
  size_bytes?: number
  modified_at?: string
}

export type CleanupSettings = {
  enabled: boolean
  cleanup_interval_seconds: number
  standalone_task_ttl_seconds: number
  result_ttl_seconds: number
  results_helper_idle_ttl_seconds: number
}

export type UserPreferences = {
  reminder_lead_time_minutes: number
}

/**
 * One recorded action from `GET /audit-log`: who did what, to which object, and how it
 * ended. The backend writes a row for every state-changing request plus every sign-in
 * attempt, so a `denied` entry with no token is as meaningful as a successful change.
 */
export type AuditEntry = {
  id: number
  at?: string | null
  actor: string
  actor_role?: string | null
  action: string
  target?: string | null
  method: string
  path: string
  status_code: number
  /** `success` | `denied` (401/403) | `rejected` (other 4xx) | `error` (5xx). */
  outcome: string
  detail?: Record<string, unknown> | null
  client_ip?: string | null
  user_agent?: string | null
}

export type AuditLogPage = {
  entries: AuditEntry[]
  total: number
  hours: number
  limit: number
  offset: number
  /** Everyone and every action seen in this time window, for building the filters. */
  actors: string[]
  actions: string[]
  /** False when recording is switched off on the backend - an empty list then means nothing was recorded, not that nothing happened. */
  enabled: boolean
  /** Whether read-only requests (GET) are recorded too; off by default. */
  includes_reads: boolean
  retention_seconds: number
}

export type AnalyticsResult = {
  group?: string
  user?: string
  team?: string
  project?: string
  avg_utilization?: number
  average_utilization?: number
  avg_utilization_percent?: number
  energy_kwh?: number | null
  co2_kg?: number | null
  job_count?: number
  allocated_gpu_hours?: number
  telemetry_samples?: number
  efficiency_note?: string
  note?: string
}

export type AnalyticsUsage = {
  group_by: "user" | "team" | "project" | string
  hours: number
  results: AnalyticsResult[]
}

export type DiskUsageRecord = {
  namespace?: string
  name?: string
  pvc?: string
  type?: string
  volume_type?: string
  requested?: string
  requested_size?: string
  requested_gb?: number
  phase?: string
  used_bytes?: number
  capacity_bytes?: number
  usage_percent?: number
  [key: string]: unknown
}

export type GroupRecord = {
  id?: number
  name: string
  total_gpus?: number
  total_disk_gb?: number
  gpu_quota_by_type?: Record<string, number> | string | null
  members?: string[] | null
  created_at?: string | null
}

export type ProjectRecord = {
  id?: number
  name: string
  owner?: string | null
  total_gpus?: number
  shared_storage_gb?: number
  gpu_quota_by_type?: Record<string, number> | string | null
  members?: string[] | null
  created_at?: string | null
}

export type Alert = {
  id: string
  alert_name: string
  severity: "critical" | "warning" | "info"
  gpu_uuid?: string | null
  node?: string | null
  value?: number | null
  threshold?: number | null
  unit?: string | null
  message: string
  fired_at: string
  dismissed?: boolean
  dismissed_at?: string | null
}

export class ApiError extends Error {
  status: number
  body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}

export function defaultApiUrl() {
  return "/api/mlmanage"
}

function cleanBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "")
}

function shouldSetJsonContentType(body: BodyInit | null | undefined) {
  if (!body) return false
  if (typeof FormData !== "undefined" && body instanceof FormData) return false
  if (typeof Blob !== "undefined" && body instanceof Blob) return false
  if (body instanceof URLSearchParams) return false
  if (typeof body === "string") return true
  return false
}

export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
  token?: string | null
): Promise<T> {
  const headers = new Headers(options.headers)
  if (shouldSetJsonContentType(options.body) && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json")
  if (token) headers.set("Authorization", `Bearer ${token}`)

  const response = await fetch(`${cleanBaseUrl(baseUrl)}${path}`, {
    ...options,
    headers,
  })

  const contentType = response.headers.get("content-type") || ""
  const isBinary =
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/x-tar") ||
    contentType.includes("application/gzip")
  const text = isBinary ? "" : await response.text()
  if (!response.ok) {
    let message = text || response.statusText
    try {
      const parsed = JSON.parse(text) as {
        detail?: string | { msg?: string }[]
      }
      if (typeof parsed.detail === "string") message = parsed.detail
      else if (Array.isArray(parsed.detail))
        message = parsed.detail
          .map((item) => item.msg || JSON.stringify(item))
          .join("; ")
    } catch {
      // keep raw text
    }
    throw new ApiError(message, response.status, text)
  }

  if (isBinary) return (await response.blob()) as T
  if (!text) return undefined as T
  if (contentType.includes("application/json")) return JSON.parse(text) as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

export async function downloadBlob(
  baseUrl: string,
  path: string,
  token?: string | null
) {
  const headers = new Headers()
  if (token) headers.set("Authorization", `Bearer ${token}`)
  const response = await fetch(`${cleanBaseUrl(baseUrl)}${path}`, { headers })
  if (!response.ok)
    throw new ApiError(
      await response.text(),
      response.status,
      response.statusText
    )
  return response.blob()
}

export function parseCommand(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export function formatCommand(command: string[] | string | undefined | null) {
  if (Array.isArray(command)) return command.join(" ")
  if (!command) return ""
  try {
    const parsed = JSON.parse(command) as string[]
    return Array.isArray(parsed) ? parsed.join(" ") : command
  } catch {
    return command
  }
}

export function parseMaybeJson<T>(
  value: T | string | null | undefined,
  fallback: T
): T {
  if (value == null) return fallback
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function formatDateTimeLocal(date: Date) {
  const offset = date.getTimezoneOffset()
  const local = new Date(date.getTime() - offset * 60_000)
  return local.toISOString().slice(0, 16)
}

export function toIsoFromLocal(value: string) {
  return new Date(value).toISOString()
}

/** An ISO-8601 timestamp with no timezone designator, e.g. `2033-06-01T10:00:00`. */
const NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/**
 * The backend stores and serialises UTC, but only some endpoints append `Z`:
 * `/reservations`, `/jobs`, `/reservations/calendar`, `/analytics/activity` and
 * `/gpu/usage` return bare `2033-06-01T10:00:00`. `new Date()` parses a bare
 * date-time as LOCAL time, so outside UTC every window was rendered shifted by the
 * viewer's offset - including the window they had just typed into the form. Parse a
 * naive timestamp as the UTC the backend actually means; anything that already
 * carries an offset (or a `Z`) is left alone.
 */
export function parseServerDate(
  value: string | number | Date | null | undefined
) {
  if (value == null) return new Date(NaN)
  if (value instanceof Date) return value
  if (typeof value === "number") return new Date(value)
  const text = value.trim()
  return new Date(
    NAIVE_TIMESTAMP.test(text) ? `${text.replace(" ", "T")}Z` : text
  )
}

/** `Date.parse` for a backend timestamp, with 0 instead of NaN for sorting. */
export function serverTime(value: string | number | Date | null | undefined) {
  const time = parseServerDate(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

/** Grid intensity the backend uses for `co2_kg` (kg CO₂ per kWh), for explanatory copy only. */
export const CO2_KG_PER_KWH = 0.4
/** Average car emissions (kg CO₂ per km) used for the plain-language CO₂ comparison. */
const CO2_KG_PER_CAR_KM = 0.12

export function formatEnergy(kwh?: number | null) {
  if (kwh == null || Number.isNaN(kwh)) return null
  if (kwh === 0) return "0 kWh"
  if (kwh < 0.001) return "<0.001 kWh"
  if (kwh < 1) return `${Math.round(kwh * 1000)} Wh`
  if (kwh < 1000) return `${kwh.toFixed(kwh < 10 ? 2 : 1)} kWh`
  return `${(kwh / 1000).toFixed(2)} MWh`
}

export function formatCo2(kg?: number | null) {
  if (kg == null || Number.isNaN(kg)) return null
  if (kg === 0) return "0 kg CO₂"
  if (kg < 0.001) return "<0.001 kg CO₂"
  if (kg < 1) return `${Math.round(kg * 1000)} g CO₂`
  if (kg < 1000) return `${kg.toFixed(kg < 10 ? 2 : 1)} kg CO₂`
  return `${(kg / 1000).toFixed(2)} t CO₂`
}

/** Plain-language comparison so a CO₂ figure means something without a reference table. */
export function co2Comparison(kg?: number | null) {
  if (kg == null || Number.isNaN(kg) || kg <= 0) return null
  const km = kg / CO2_KG_PER_CAR_KM
  if (km < 1) return "less than a kilometre of average car driving"
  if (km < 1000) return `about ${Math.round(km)} km of average car driving`
  return `about ${Math.round(km / 100) / 10} thousand km of average car driving`
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell == null ? "" : String(cell)
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
        })
        .join(",")
    )
    .join("\r\n")
}

export function saveBlob(filename: string, blob: Blob) {
  const anchor = document.createElement("a")
  anchor.href = URL.createObjectURL(blob)
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(anchor.href)
}

export function downloadTextFile(
  filename: string,
  text: string,
  type = "text/plain;charset=utf-8"
) {
  saveBlob(filename, new Blob([text], { type }))
}

export function formatBytes(bytes?: number | null) {
  if (bytes == null || Number.isNaN(bytes)) return "—"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export async function fetchAlerts(
  baseUrl: string,
  token?: string | null,
  dismissed = false
): Promise<Alert[]> {
  try {
    const query = new URLSearchParams({ dismissed: String(dismissed) })
    const response = await apiRequest<{ alerts: Alert[] }>(
      baseUrl,
      `/alerts?${query}`,
      {},
      token
    )
    return response.alerts || []
  } catch (error) {
    console.debug("Failed to fetch alerts:", error)
    return []
  }
}

export async function dismissAlert(
  baseUrl: string,
  alertId: string,
  token?: string | null
): Promise<void> {
  try {
    await apiRequest<{ message: string }>(
      baseUrl,
      `/alerts/${encodeURIComponent(alertId)}/dismiss`,
      { method: "POST" },
      token
    )
  } catch (error) {
    console.debug("Failed to dismiss alert:", error)
  }
}
