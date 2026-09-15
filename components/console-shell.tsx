"use client"
/* eslint-disable react-hooks/set-state-in-effect */

import type React from "react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderKanban,
  HardDrive,
  Layers3,
  Leaf,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Trash2,
  Upload,
  UserCircle,
  X,
  Zap,
} from "lucide-react"
import {
  addDays,
  addMonths,
  eachHourOfInterval,
  eachDayOfInterval,
  endOfDay,
  endOfMonth,
  format,
  isAfter,
  isBefore,
  isToday,
  startOfDay,
  startOfMonth,
} from "date-fns"
import {
  ApiError,
  CO2_KG_PER_KWH,
  MIG_PROFILE_VRAM_GB,
  PARTITION_MODES,
  type Alert,
  type AnalyticsResult,
  type AnalyticsUsage,
  type AuditEntry,
  type AuditLogPage,
  type CleanupSettings,
  type CurrentUser,
  type DiskUsageRecord,
  type Gpu,
  type GpuCapability,
  type GpuPartition,
  type GroupRecord,
  type ImageRecord,
  type JobRecord,
  type ProjectRecord,
  type QueueRecord,
  type ReservationEvent,
  type ReservationRecord,
  type TaskRecord,
  type TaskResultFile,
  type WorkloadActivity,
  apiRequest,
  co2Comparison,
  defaultApiUrl,
  dismissAlert,
  downloadBlob,
  downloadTextFile,
  fetchAlerts,
  formatBytes,
  formatCo2,
  formatCommand,
  formatDateTimeLocal,
  formatEnergy,
  parseCommand,
  parseMaybeJson,
  parseServerDate,
  saveBlob,
  serverTime,
  toCsv,
  toIsoFromLocal,
} from "@/lib/mlmanage-api"
import { cn } from "@/lib/utils"
import { AlertStack } from "@/components/alerts"

type View = "jobs" | "capacity" | "projects" | "usage" | "account" | "admin"
type Timing = "asap" | "schedule"
type Notice = { kind: "success" | "error" | "info"; text: string }
type GpuAvailability = {
  gpu_uuid: string
  product?: string
  node?: string
  synthetic_e2e?: boolean
  available: boolean
  busy_windows: Array<{ start: string; end: string }>
}
type UnifiedJob = {
  key: string
  id: string
  name: string
  kind: "queue" | "scheduled" | "legacy"
  status: string
  timing: string
  compute: string
  image: string
  command: string
  owner: string
  project?: string | null
  source: QueueRecord | JobRecord | TaskRecord
  taskNames: string[]
  timestamp: number
}
type Draft = {
  name: string
  image: string
  command: string
  timing: Timing
  gpuUuid: string
  gpuCount: string
  cpu: string
  memoryValue: string
  memoryUnit: "Mi" | "Gi" | "Ti"
  vram: string
  runtimeValue: string
  runtimeUnit: "minutes" | "hours" | "days"
  project: string
  start: string
  end: string
  diskValue: string
  diskUnit: "Mi" | "Gi" | "Ti"
  priority: string
  replicas: string
  gang: boolean
  mpi: boolean
  dependsOn: number[]
  gpuPartition: string
}

const nav: {
  id: View
  label: string
  icon: typeof Activity
  admin?: boolean
}[] = [
  { id: "jobs", label: "Jobs", icon: Layers3 },
  { id: "capacity", label: "Capacity", icon: Server },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "usage", label: "Usage", icon: Activity },
  { id: "account", label: "My account", icon: UserCircle },
  { id: "admin", label: "Administration", icon: Shield, admin: true },
]
/** Rows fetched per page of the activity log; the backend caps a request at 1000. */
const AUDIT_PAGE_SIZE = 100
/** How the four outcomes the backend reports are worded and coloured in the log. */
const AUDIT_OUTCOMES: Record<string, { label: string; className: string }> = {
  success: { label: "Succeeded", className: "text-emerald-300" },
  denied: { label: "Not permitted", className: "text-red-300" },
  rejected: { label: "Rejected", className: "text-amber-300" },
  error: { label: "Failed", className: "text-red-300" },
}
/**
 * The recorded detail as one readable line. The backend stores whatever the endpoint
 * knew - changed fields, quotas, the image submitted - so this stays generic rather
 * than naming keys, and secrets never arrive here (they are redacted on write).
 */
function auditDetail(entry: AuditEntry) {
  const detail = entry.detail
  if (!detail || typeof detail !== "object") return ""
  return Object.entries(detail)
    .map(([key, value]) => {
      const text =
        value == null
          ? ""
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value)
      return `${key}=${text}`
    })
    .join(" · ")
}
const input =
  "h-9 w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-400 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:opacity-50"
const button =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-200 outline-none hover:border-zinc-600 hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
const ModalFormContext = createContext<{
  data: Record<string, string>
  setData: React.Dispatch<React.SetStateAction<Record<string, string>>>
} | null>(null)
function ModalField({
  name,
  label,
  type = "text",
  help,
  disabled,
}: {
  name: string
  label: string
  type?: string
  help?: string
  disabled?: boolean
}) {
  const context = useContext(ModalFormContext)
  if (!context) return null
  // The help text sits OUTSIDE the label and is linked with aria-describedby. Inside the
  // label it became part of the field's accessible name, so two fields whose labels share
  // a prefix ("Memory allocation" / "GPU memory allocation (GB)") could not be told apart
  // by name at all once one of them carried help.
  const helpId = help ? `modal-help-${name}` : undefined
  return (
    <div className="grid gap-1 text-xs">
      <label className="grid gap-1">
        {label}
        <input
          className={input}
          type={type}
          disabled={disabled}
          aria-describedby={helpId}
          value={context.data[name] || ""}
          onChange={(event) =>
            context.setData((data) => ({ ...data, [name]: event.target.value }))
          }
        />
      </label>
      {help && (
        <span id={helpId} className="text-[10px] text-zinc-400">
          {help}
        </span>
      )}
    </div>
  )
}

/**
 * The command is sent as an argv array, one element per line. A single line that
 * contains spaces is therefore treated as one program name: `sleep 1000` makes the
 * runtime look for an executable literally called "sleep 1000", the container dies
 * before it runs, and because it never started there is no log output at all. Warn
 * about that in the form instead of letting the job fail with nothing to read.
 */
const SHELLS = [
  "sh",
  "bash",
  "/bin/sh",
  "/bin/bash",
  "zsh",
  "python",
  "python3",
]
function commandHint(text: string) {
  const parts = parseCommand(text)
  const withSpaces = parts.find((part) => /\s/.test(part))
  if (!withSpaces || SHELLS.includes(parts[0])) return ""
  const program = withSpaces.split(/\s+/)[0]
  return `Each line is one argument, so “${withSpaces}” is run as a single program name and the container will fail before it starts. Put “${program}” and each argument on their own line, or use three lines: sh, -c, ${withSpaces}`
}
function logFailure(error: unknown) {
  const message = `Log retrieval failed: ${readable(error)}`
  if (error instanceof ApiError && error.status === 404)
    return `${message}\n\nThere is no pod to read logs from. Either it has already been cleaned up, or the container never started — a workload that fails at startup produces no log output at all. Check the Command: each line is sent as one argument, so a whole shell line such as “sleep 1000” has to be split, or run as sh, -c, sleep 1000.`
  return message
}
function logText(value: unknown) {
  return typeof value === "string"
    ? value
    : value && typeof value === "object" && "logs" in value
      ? String((value as { logs?: unknown }).logs || "No logs returned.")
      : JSON.stringify(value, null, 2)
}
function readable(error: unknown) {
  return error instanceof ApiError
    ? `${error.status}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error)
}
function role(user: CurrentUser | null) {
  return String(user?.role || "")
    .toLowerCase()
    .replace("read-only", "readonly")
}
function mutable(user: CurrentUser | null) {
  return ["user", "poweruser", "admin"].includes(role(user))
}
/**
 * The most GPU memory this account may ask for on the selected card, resolved the way
 * the backend's quota check does: the per-model limit, then its `default` entry, then the
 * account-wide value. Administrators are exempt. Asking for more than this is refused by
 * the backend, so the form says so before the job is submitted rather than after.
 */
function vramCeiling(
  user: CurrentUser | null,
  gpus: Gpu[],
  gpuUuid: string
): number | null {
  if (!user || role(user) === "admin") return null
  const byModel = parseMaybeJson<Record<string, number>>(
    user.vram_quota_by_type,
    {}
  )
  const model = gpuTypeKey(
    gpus.find((gpu) => gpu.uuid === gpuUuid)?.product || ""
  )
  const cap = byModel[model] ?? byModel.default ?? user.quota_vram_gb
  return typeof cap === "number" && cap >= 0 ? cap : null
}
function resources(d: Draft) {
  const limits: Record<string, unknown> = {}
  if (d.cpu) limits.cpu = d.cpu
  if (d.memoryValue) limits.memory = `${d.memoryValue}${d.memoryUnit}`
  // A scheduled job reserves exactly one accelerator, so it must not request more
  // than one: a larger request produces a pod that can never be scheduled.
  const gpuCount = d.timing === "schedule" ? 1 : +d.gpuCount
  if (gpuCount) limits["nvidia.com/gpu"] = gpuCount
  if (d.diskValue) limits["ephemeral-storage"] = `${d.diskValue}${d.diskUnit}`
  return { limits }
}
function initialDraft(): Draft {
  const later = (hours: number) =>
    formatDateTimeLocal(new Date(Date.now() + hours * 3_600_000))
  return {
    name: "",
    image: "",
    command: "",
    timing: "asap",
    gpuUuid: "",
    gpuCount: "1",
    cpu: "1",
    memoryValue: "2",
    memoryUnit: "Gi",
    vram: "4",
    runtimeValue: "2",
    runtimeUnit: "hours",
    project: "",
    start: later(1),
    end: later(3),
    diskValue: "10",
    diskUnit: "Gi",
    priority: "0",
    replicas: "1",
    gang: false,
    mpi: false,
    dependsOn: [],
    gpuPartition: "",
  }
}
/**
 * Job list filters. Each chip owns an explicit set of backend states, so no state
 * can fall between two chips: queue entries are queued/waiting_deps/running/
 * completed/failed/cancelled, scheduled Jobs are scheduled/submitted/…, and Tasks
 * are pending/running/…
 */
const STATUS_FILTERS: Array<{ id: string; states: string[] }> = [
  { id: "all", states: [] },
  { id: "running", states: ["running", "submitted"] },
  { id: "waiting", states: ["queued", "waiting_deps", "pending"] },
  { id: "scheduled", states: ["scheduled", "reserved"] },
  { id: "completed", states: ["completed", "succeeded"] },
  { id: "failed", states: ["failed", "error"] },
  {
    id: "cancelled",
    states: ["cancelled", "canceled", "preempted", "expired"],
  },
]
function matchesStatusFilter(status: string, filterId: string) {
  if (filterId === "all") return true
  const filter = STATUS_FILTERS.find((item) => item.id === filterId)
  const value = status.toLowerCase().replace(/[\s-]/g, "_")
  if (!filter) return true
  if (filter.states.some((state) => value.includes(state))) return true
  // Anything the backend adds later is only ever hidden from a named chip, never
  // from "all"; surface it under the closest chip instead of dropping it.
  return (
    filterId === "waiting" &&
    !STATUS_FILTERS.slice(1).some((item) =>
      item.states.some((state) => value.includes(state))
    )
  )
}
const VISIBILITY_LABELS: Record<string, string> = {
  user: "Only me",
  project: "Project",
  group: "Group",
  everyone: "Everyone",
}
/**
 * Quota maps are keyed by the backend's `normalize_gpu_type` (spaces become dashes).
 * Writing the raw product name would store a key `enforce_quota` never looks up.
 */
function gpuTypeKey(product: string) {
  return (product || "unknown").trim().replace(/\s+/g, "-")
}
/** Canonicalize an image name/tag the way the backend's own validation expects. */
function imageSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
}
/** MIG slice profiles a card is configured for, from the applied partition records. */
function migProfilesFor(partitions: GpuPartition[], gpuUuid: string) {
  const record = partitions.find(
    (partition) => partition.gpu_uuid === gpuUuid && partition.mode === "mig"
  )
  if (!record) return []
  return Object.keys(
    parseMaybeJson<Record<string, number>>(record.mig_profiles, {})
  )
}
function statusTone(status: string) {
  const s = status.toLowerCase()
  return s.includes("run") || s.includes("complete")
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : s.includes("fail") || s.includes("cancel")
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : s.includes("queue") || s.includes("wait")
        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
        : "border-blue-500/30 bg-blue-500/10 text-blue-300"
}
function Pill({
  children,
  status,
}: {
  children: React.ReactNode
  status: string
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        statusTone(status)
      )}
    >
      {children}
    </span>
  )
}
/**
 * Get color for disk usage progress bar based on percentage used.
 * Green < 80%, Yellow 80-95%, Red > 95%
 */
function diskUsageColor(percentUsed: number) {
  if (percentUsed > 95)
    return "bg-red-500 border-red-600"
  if (percentUsed > 80)
    return "bg-amber-500 border-amber-600"
  return "bg-emerald-500 border-emerald-600"
}
/**
 * Format bytes to MB/GB with appropriate precision
 */
function formatDiskSize(bytes: number | undefined) {
  if (!bytes || bytes < 0) return "—"
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.round(mb)} MB`
  const gb = mb / 1024
  return gb < 10 ? `${gb.toFixed(2)} GB` : `${gb.toFixed(1)} GB`
}
/**
 * A titled panel. Declared at module scope on purpose: a component defined inside
 * `ConsoleShell` would be a NEW component type on every render, so React would throw away
 * and rebuild the whole panel's DOM on each of the three-second workload polls — losing
 * focus, selection and scroll position inside it, and never restoring focus to a control
 * that opened a dialog because the node it was captured from no longer exists.
 */
function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      <div className="overflow-x-auto rounded-md border border-zinc-800 bg-[#0c0c0f] p-3">
        {children}
      </div>
    </section>
  )
}
/** A single headline figure: label, value, and one line saying what it means. */
function Tile({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Activity
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </p>
      <p className="mt-1.5 text-lg font-semibold text-zinc-100">{value}</p>
      {detail && (
        <p className="mt-0.5 text-[11px] leading-snug text-zinc-400">
          {detail}
        </p>
      )}
    </div>
  )
}
/** Real-time disk usage progress bar with quota comparison */
function DiskUsageProgressBar({
  record,
  label,
}: {
  record: DiskUsageRecord
  label: string
}) {
  const capacityBytes = record.capacity_bytes ?? 0
  const usedBytes = record.used_bytes ?? 0
  const usagePercent = record.usage_percent ?? 0
  const capacityGb = capacityBytes / (1024 ** 3)

  const Icon = usagePercent > 95 ? AlertTriangle : HardDrive
  const iconColor =
    usagePercent > 95
      ? "text-red-400"
      : usagePercent > 80
        ? "text-amber-400"
        : "text-emerald-400"

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          <Icon className={cn("size-3.5", iconColor)} aria-hidden="true" />
          {label}
        </span>
        <span className={cn(
          "text-xs font-medium",
          usagePercent > 95
            ? "text-red-300"
            : usagePercent > 80
              ? "text-amber-300"
              : "text-emerald-300"
        )}>
          {usagePercent.toFixed(1)}%
        </span>
      </p>
      <div className="mt-2 w-full bg-zinc-800 rounded-sm h-2 overflow-hidden">
        <div
          className={cn(
            "h-full transition-all duration-300",
            diskUsageColor(usagePercent)
          )}
          style={{ width: `${Math.min(usagePercent, 100)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-zinc-300">
        <span className="font-mono">
          {formatDiskSize(usedBytes)} / {capacityGb.toFixed(1)} GB
        </span>
      </p>
      {usagePercent > 80 && (
        <p className={cn(
          "mt-1.5 text-[11px] leading-snug",
          usagePercent > 95 ? "text-red-300" : "text-amber-300"
        )}>
          {usagePercent > 95
            ? "Critical: Storage nearly full"
            : "Warning: Storage usage high"}
        </p>
      )}
    </div>
  )
}
/** Turn a per-model limit map (object or JSON string) into prefixed form fields. */
function quotaEntries(
  prefix: string,
  value: Record<string, number> | string | null | undefined
) {
  return Object.fromEntries(
    Object.entries(parseMaybeJson<Record<string, number>>(value, {})).map(
      ([model, count]) => [`${prefix}${model}`, String(count)]
    )
  )
}
function utilizationOf(item: AnalyticsResult) {
  return (
    item.avg_utilization_percent ??
    item.avg_utilization ??
    item.average_utilization ??
    null
  )
}
function jobName(
  record: QueueRecord | JobRecord | TaskRecord,
  fallback: string
) {
  return "display_name" in record && record.display_name
    ? record.display_name
    : record.project
      ? `${record.project} · ${formatCommand(record.command).slice(0, 42) || fallback}`
      : formatCommand(record.command).slice(0, 48) || fallback
}
function compute(record: QueueRecord | JobRecord | TaskRecord) {
  const r = parseMaybeJson<Record<string, unknown>>(record.resources, {})
  const limits = (r.limits || r) as Record<string, unknown>
  const g =
    record.gpu_uuid ||
    limits["nvidia.com/gpu"] ||
    ("gpus" in record ? record.gpus : 0)
  return g
    ? `${record.gpu_uuid ? `Pinned · ${record.gpu_uuid}` : `${g} GPU${String(g) === "1" ? "" : "s"}`}${record.vram_limit_gb ? ` · ${record.vram_limit_gb}GB` : ""}`
    : "CPU"
}
function gpuTime(hours?: number) {
  if (hours === undefined) return "—"
  if (hours < 1 / 60) return `${Math.round(hours * 3600)} GPU-sec`
  if (hours < 1) return `${(hours * 60).toFixed(1)} GPU-min`
  return `${hours.toFixed(2)} GPU-h`
}
function elapsed(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}
function normalize(
  queue: QueueRecord[],
  jobs: JobRecord[],
  tasks: TaskRecord[]
): UnifiedJob[] {
  const linked = new Set<string>()
  const out: UnifiedJob[] = []
  queue.forEach((q) => {
    const names = Array.isArray(q.task_names)
      ? q.task_names
      : typeof q.task_names === "string"
        ? parseMaybeJson<string[]>(q.task_names, [])
        : []
    names.forEach((n) => linked.add(n))
    out.push({
      key: `q-${q.id}`,
      id: `Q-${q.id}`,
      name: jobName(q, `Queue ${q.id}`),
      kind: "queue",
      status: q.status || "Queued",
      timing: q.started_at
        ? `Started ${parseServerDate(q.started_at).toLocaleString()}`
        : "ASAP queue",
      compute: compute(q),
      image: q.image,
      command: formatCommand(q.command),
      owner: q.user || "—",
      project: q.project,
      source: q,
      taskNames: names,
      timestamp: serverTime(q.created_at || q.started_at),
    })
  })
  jobs.forEach((j) => {
    if (j.task_name) linked.add(j.task_name)
    out.push({
      key: `j-${j.id}`,
      id: `J-${j.id}`,
      name: jobName(j, `Scheduled job ${j.id}`),
      kind: "scheduled",
      status: j.status || "Scheduled",
      timing: `${parseServerDate(j.start_time).toLocaleString()} – ${parseServerDate(j.end_time).toLocaleTimeString()}`,
      compute: compute(j),
      image: j.image,
      command: formatCommand(j.command),
      owner: j.user || j.username || "—",
      project: j.project,
      source: j,
      taskNames: j.task_name ? [j.task_name] : [],
      timestamp: serverTime(j.created_at || j.start_time),
    })
  })
  tasks
    .filter((t) => !linked.has(t.name))
    .forEach((t) =>
      out.push({
        key: `t-${t.name}`,
        id: t.name,
        name: jobName(t, t.name),
        kind: "legacy",
        status: t.status || "Legacy execution",
        timing: t.created_at
          ? `Created ${parseServerDate(t.created_at).toLocaleString()}`
          : "Legacy execution",
        compute: compute(t),
        image: t.image,
        command: formatCommand(t.command),
        owner: t.user || "—",
        project: t.project,
        source: t,
        taskNames: [t.name],
        timestamp: serverTime(t.created_at),
      })
    )
  return out.sort((a, b) => b.timestamp - a.timestamp)
}

export function ConsoleShell() {
  const apiUrl = defaultApiUrl()
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<CurrentUser | null>(null)
  const [connection, setConnection] = useState("checking")
  const [view, setView] = useState<View>("jobs")
  const [drawer, setDrawer] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sessionMessage, setSessionMessage] = useState("")
  const [submitError, setSubmitError] = useState("")
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [login, setLogin] = useState({ username: "admin", password: "test" })
  const [queue, setQueue] = useState<QueueRecord[]>([])
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [gpus, setGpus] = useState<Gpu[]>([])
  const [images, setImages] = useState<ImageRecord[]>([])
  const [reservations, setReservations] = useState<ReservationRecord[]>([])
  const [availability, setAvailability] = useState<GpuAvailability[]>([])
  const [availabilityLoading, setAvailabilityLoading] = useState(false)
  const [availabilityRefresh, setAvailabilityRefresh] = useState(0)
  const [windowCheck, setWindowCheck] = useState<GpuAvailability[]>([])
  const [windowCheckLoading, setWindowCheckLoading] = useState(false)
  const [partitions, setPartitions] = useState<GpuPartition[]>([])
  const [capabilities, setCapabilities] = useState<GpuCapability[]>([])
  const [capabilityNote, setCapabilityNote] = useState("")
  const [calendar, setCalendar] = useState<ReservationEvent[]>([])
  const [calendarViewMode, setCalendarViewMode] = useState<"grid" | "table">(
    "grid"
  )
  const [calendarDate, setCalendarDate] = useState<Date>(new Date())
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [disk, setDisk] = useState<DiskUsageRecord[]>([])
  const [diskRefresh, setDiskRefresh] = useState(0)
  const [analytics, setAnalytics] = useState<AnalyticsUsage | null>(null)
  const [users, setUsers] = useState<CurrentUser[]>([])
  const [cleanup, setCleanup] = useState<CleanupSettings | null>(null)
  const [userPreferences, setUserPreferences] = useState<{ reminder_lead_time_minutes: number } | null>(null)
  const [audit, setAudit] = useState<AuditLogPage | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditHours, setAuditHours] = useState("168")
  const [auditActor, setAuditActor] = useState("")
  const [auditAction, setAuditAction] = useState("")
  const [auditOutcome, setAuditOutcome] = useState("")
  const [auditSearch, setAuditSearch] = useState("")
  const [auditPage, setAuditPage] = useState(0)
  const [auditRefresh, setAuditRefresh] = useState(0)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())
  const [alertsRefresh, setAlertsRefresh] = useState(0)
  const [selectedKey, setSelectedKey] = useState("")
  const [filter, setFilter] = useState("")
  const [status, setStatus] = useState("all")
  const [draft, setDraft] = useState<Draft>(initialDraft)
  const [imageMode, setImageMode] = useState<
    "existing" | "external" | "upload"
  >("existing")
  const [file, setFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [draggingFile, setDraggingFile] = useState(false)
  const [imageMeta, setImageMeta] = useState({
    name: "",
    tag: "latest",
    visibility: "user",
    shareWith: "",
  })
  const [logs, setLogs] = useState("")
  const [logTail, setLogTail] = useState("200")
  // The task whose logs are being followed, so the button on each execution
  // attempt follows that attempt rather than always the first one.
  const [followedTask, setFollowedTask] = useState("")
  const [resultFiles, setResultFiles] = useState<TaskResultFile[]>([])
  const [resultsTask, setResultsTask] = useState("")
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [modal, setModal] = useState<
    | "reservation"
    | "renew-reservation"
    | "partition"
    | "group"
    | "project"
    | "storage"
    | "image"
    | "user"
    | "edit-user"
    | "cleanup"
    | null
  >(null)
  const [modalData, setModalData] = useState<Record<string, string>>({})
  const [modalError, setModalError] = useState("")
  const [memberSearch, setMemberSearch] = useState("")
  const [usageHours, setUsageHours] = useState("168")
  const [usageGroup, setUsageGroup] = useState("mine")
  const [usageUser, setUsageUser] = useState("")
  const [usageActivity, setUsageActivity] = useState<WorkloadActivity[]>([])
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageRefresh, setUsageRefresh] = useState(0)
  const [usagePoints, setUsagePoints] = useState<
    Array<{
      timestamp: string
      gpu_uuid?: string
      utilization: number
      memory?: number
      memory_used?: number
      temperature?: number
      power?: number
    }>
  >([])
  const drawerButton = useRef<HTMLButtonElement>(null)
  const sheetButton = useRef<HTMLButtonElement>(null)
  const uploadInput = useRef<HTMLInputElement>(null)
  const icsInput = useRef<HTMLInputElement>(null)
  const availabilityRequest = useRef(0)
  const windowCheckRequest = useRef(0)
  const usageRequest = useRef(0)
  const auditRequest = useRef(0)
  // A 401 means the stored JWT is gone or expired (they last 24h). Without this the
  // console keeps showing pre-expiry data while every action quietly fails.
  const expireSession = useCallback(() => {
    localStorage.removeItem("mlmanage.token")
    setToken(null)
    setUser(null)
    setView("jobs")
    // Kept out of the auto-dismissing toast: it must still be on the sign-in screen
    // when someone comes back to the tab minutes later.
    setSessionMessage(
      "Your session expired, so you were signed out. Sign in again to continue."
    )
  }, [])
  const call = useCallback(
    <T,>(path: string, options?: RequestInit) =>
      apiRequest<T>(apiUrl, path, options, token).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) expireSession()
        throw error
      }),
    [apiUrl, expireSession, token]
  )
  const say = (kind: Notice["kind"], text: string) => setNotice({ kind, text })
  const handleDismissAlert = useCallback(
    (alertId: string) => {
      setDismissedAlerts((prev) => new Set([...prev, alertId]))
      setAlerts((prev) => prev.filter((a) => a.id !== alertId))
      void dismissAlert(apiUrl, alertId, token).catch((error) =>
        console.debug("Failed to dismiss alert:", error)
      )
    },
    [apiUrl, token]
  )
  function downloadCalendar(job: JobRecord) {
    const event = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//MLManage//EN",
      "BEGIN:VEVENT",
      `UID:mlmanage-job-${job.id}`,
      `DTSTART:${parseServerDate(job.start_time)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "")}`,
      `DTEND:${parseServerDate(job.end_time)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "")}`,
      `SUMMARY:${job.display_name || `MLManage job ${job.id}`}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")
    const url = URL.createObjectURL(
      new Blob([event], { type: "text/calendar" })
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `mlmanage-job-${job.id}.ics`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      await apiRequest(apiUrl, "/health")
      setConnection("online")
      if (!token) return
      const me = await call<CurrentUser>("/me")
      setUser(me)
      const r = await Promise.allSettled([
        call<{ queue: QueueRecord[] }>("/queue"),
        call<{ jobs: JobRecord[] }>("/jobs"),
        call<{ tasks: TaskRecord[] }>("/tasks"),
        call<{ images: ImageRecord[] }>("/images"),
        call<{ gpus: Gpu[] }>("/gpu/list"),
        call<{ reservations: ReservationRecord[] }>("/reservations"),
        call<{ partitions: GpuPartition[] }>("/gpu/partitions"),
        call<{ groups: GroupRecord[] }>("/groups"),
        call<{ projects: ProjectRecord[] }>("/projects"),
        call<DiskUsageRecord[] | { volumes?: DiskUsageRecord[] }>(
          "/disk/usage"
        ),
        call<CurrentUser[]>("/users"),
        call<{ gpus: GpuCapability[]; error?: string }>("/gpu/capabilities"),
        call<ReservationEvent[]>("/reservations/calendar"),
      ])
      const value = <T,>(i: number, fallback: T): T =>
        r[i].status === "fulfilled" ? (r[i].value as T) : fallback
      setQueue(value(0, { queue: [] }).queue)
      setJobs(value(1, { jobs: [] }).jobs)
      setTasks(value(2, { tasks: [] }).tasks)
      setImages(value(3, { images: [] }).images)
      setGpus(value(4, { gpus: [] }).gpus)
      setReservations(value(5, { reservations: [] }).reservations)
      setPartitions(value(6, { partitions: [] }).partitions)
      setGroups(value(7, { groups: [] }).groups)
      setProjects(value(8, { projects: [] }).projects)
      const d = value<DiskUsageRecord[] | { volumes?: DiskUsageRecord[] }>(
        9,
        []
      )
      setDisk(Array.isArray(d) ? d : d.volumes || [])
      setUsers(value(10, []))
      const detected = value<{ gpus?: GpuCapability[]; error?: string }>(11, {})
      setCapabilities(detected.gpus || [])
      setCapabilityNote(detected.error || "")
      setCalendar(value<ReservationEvent[]>(12, []))
      // Usage analytics are owned by the Usage view alone: writing them here too
      // let a slow refresh replace a scoped report with the personal one.
      setUsageRefresh((value) => value + 1)
      if (role(me) === "admin") {
        try {
          setCleanup(await call<CleanupSettings>("/settings/cleanup"))
        } catch {}
      }
      try {
        setUserPreferences(await call<{ reminder_lead_time_minutes: number }>("/user-preferences"))
      } catch {}
    } catch {
      setConnection("offline")
    } finally {
      setLoading(false)
    }
  }, [apiUrl, call, token])
  useEffect(() => {
    setToken(localStorage.getItem("mlmanage.token"))
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (!token) return
    const refreshWorkloads = async () => {
      if (document.visibilityState !== "visible") return
      try {
        const [queueResponse, jobResponse, taskResponse] = await Promise.all([
          call<{ queue: QueueRecord[] }>("/queue"),
          call<{ jobs: JobRecord[] }>("/jobs"),
          call<{ tasks: TaskRecord[] }>("/tasks"),
        ])
        setQueue(queueResponse.queue)
        setJobs(jobResponse.jobs)
        setTasks(taskResponse.tasks)
        setConnection("online")
      } catch {
        // The full refresh action remains available when a transient poll fails.
      }
    }
    const timer = window.setInterval(() => void refreshWorkloads(), 3000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshWorkloads()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [call, token])
  useEffect(() => {
    if (!token) return
    const refreshAlerts = async () => {
      if (document.visibilityState !== "visible") return
      try {
        const alerts = await fetchAlerts(apiUrl, token, false)
        // Filter out dismissed alerts
        setAlerts(alerts.filter((a) => !dismissedAlerts.has(a.id)))
      } catch {
        // Failed to fetch alerts, don't interrupt other operations
      }
    }
    void refreshAlerts()
    const timer = window.setInterval(() => void refreshAlerts(), 10000) // Check every 10 seconds
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshAlerts()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [apiUrl, token, alertsRefresh, dismissedAlerts])
  const username = user?.username
  useEffect(() => {
    if (view !== "usage" || !token || !username) return
    const requestId = ++usageRequest.current
    const groupBy = usageGroup === "mine" ? "user" : usageGroup
    const subject = usageGroup === "mine" ? username : usageUser
    const query = new URLSearchParams({ group_by: groupBy, hours: usageHours })
    if (subject) query.set("subject", subject)
    const telemetryPath =
      usageGroup === "mine"
        ? `/gpu/usage?hours=${usageHours}`
        : usageGroup === "user" && usageUser
          ? `/gpu/usage/${encodeURIComponent(usageUser)}?hours=${usageHours}`
          : null
    setUsageLoading(true)
    setAnalytics(null)
    setUsageActivity([])
    setUsagePoints([])
    void Promise.all([
      call<AnalyticsUsage>(`/analytics/usage?${query}`),
      call<WorkloadActivity[]>(`/analytics/activity?${query}`),
      telemetryPath
        ? call<typeof usagePoints>(telemetryPath)
        : Promise.resolve([]),
    ])
      .then(([summary, activity, telemetry]) => {
        if (usageRequest.current !== requestId) return
        setAnalytics(summary)
        setUsageActivity(activity)
        setUsagePoints(telemetry)
      })
      .catch((error) => {
        if (usageRequest.current === requestId)
          setNotice({ kind: "error", text: readable(error) })
      })
      .finally(() => {
        if (usageRequest.current === requestId) setUsageLoading(false)
      })
  }, [
    call,
    token,
    usageGroup,
    usageHours,
    usageRefresh,
    usageUser,
    username,
    view,
  ])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (!sheet) {
      setSubmitError("")
      setFormErrors({})
    }
  }, [sheet])
  useEffect(() => {
    if (!sheet || draft.timing !== "schedule" || !draft.start || !draft.end) {
      availabilityRequest.current += 1
      setAvailability([])
      setAvailabilityLoading(false)
      return
    }
    const start = new Date(draft.start)
    const end = new Date(draft.end)
    if (end <= start) {
      availabilityRequest.current += 1
      setAvailability([])
      setAvailabilityLoading(false)
      return
    }
    const requestId = ++availabilityRequest.current
    setAvailability([])
    setAvailabilityLoading(true)
    const timer = window.setTimeout(() => {
      void call<{ gpus: typeof availability }>(
        `/availability?start_time=${encodeURIComponent(toIsoFromLocal(draft.start))}&end_time=${encodeURIComponent(toIsoFromLocal(draft.end))}`
      )
        .then((response) => {
          if (availabilityRequest.current !== requestId) return
          setAvailability(response.gpus || [])
          setDraft((current) =>
            current.gpuUuid &&
            !response.gpus?.some(
              (gpu) => gpu.gpu_uuid === current.gpuUuid && gpu.available
            )
              ? { ...current, gpuUuid: "" }
              : current
          )
        })
        .catch((error) => {
          if (availabilityRequest.current === requestId)
            say("error", `Could not check availability: ${readable(error)}`)
        })
        .finally(() => {
          if (availabilityRequest.current === requestId)
            setAvailabilityLoading(false)
        })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [availabilityRefresh, call, draft.end, draft.start, draft.timing, sheet])
  const reservationStart = modal === "reservation" ? modalData.start : ""
  const reservationEnd = modal === "reservation" ? modalData.end : ""
  useEffect(() => {
    if (!reservationStart || !reservationEnd) {
      windowCheckRequest.current += 1
      setWindowCheck([])
      setWindowCheckLoading(false)
      return
    }
    if (new Date(reservationEnd) <= new Date(reservationStart)) {
      windowCheckRequest.current += 1
      setWindowCheck([])
      setWindowCheckLoading(false)
      return
    }
    const requestId = ++windowCheckRequest.current
    setWindowCheckLoading(true)
    const timer = window.setTimeout(() => {
      void call<{ gpus: GpuAvailability[] }>(
        `/availability?start_time=${encodeURIComponent(toIsoFromLocal(reservationStart))}&end_time=${encodeURIComponent(toIsoFromLocal(reservationEnd))}`
      )
        .then((response) => {
          if (windowCheckRequest.current !== requestId) return
          setWindowCheck(response.gpus || [])
        })
        .catch(() => {
          if (windowCheckRequest.current === requestId) setWindowCheck([])
        })
        .finally(() => {
          if (windowCheckRequest.current === requestId)
            setWindowCheckLoading(false)
        })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [call, reservationEnd, reservationStart])
  // The activity log is loaded by the Administration view alone, and only for an
  // administrator: `GET /audit-log` is the one endpoint everybody else gets a 403 from,
  // and asking for it on every refresh would put a denied entry in the log it is showing.
  const auditVisible = view === "admin" && role(user) === "admin"
  useEffect(() => {
    if (!token || !auditVisible) return
    const requestId = ++auditRequest.current
    setAuditLoading(true)
    const query = new URLSearchParams({
      hours: auditHours,
      limit: String(AUDIT_PAGE_SIZE),
      offset: String(auditPage * AUDIT_PAGE_SIZE),
    })
    if (auditActor) query.set("actor", auditActor)
    if (auditAction) query.set("action", auditAction)
    if (auditOutcome) query.set("outcome", auditOutcome)
    if (auditSearch.trim()) query.set("search", auditSearch.trim())
    // Debounced so typing in the search box does not fire a request per keystroke.
    const timer = window.setTimeout(() => {
      void call<AuditLogPage>(`/audit-log?${query.toString()}`)
        .then((response) => {
          if (auditRequest.current === requestId) setAudit(response)
        })
        .catch((error) => {
          if (auditRequest.current !== requestId) return
          setAudit(null)
          say("error", `Could not load the activity log: ${readable(error)}`)
        })
        .finally(() => {
          if (auditRequest.current === requestId) setAuditLoading(false)
        })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [
    auditAction,
    auditActor,
    auditHours,
    auditOutcome,
    auditPage,
    auditRefresh,
    auditSearch,
    auditVisible,
    call,
    token,
  ])
  // Auto-refresh disk usage every 15-20 seconds when viewing account or capacity
  useEffect(() => {
    if (!token || (view !== "account" && view !== "capacity")) return
    const refreshDiskUsage = async () => {
      try {
        const d = await call<DiskUsageRecord[] | { volumes?: DiskUsageRecord[] }>(
          "/disk/usage"
        )
        setDisk(Array.isArray(d) ? d : d.volumes || [])
      } catch {
        // Silently fail on refresh, keeping the last known state
      }
    }
    // Initial refresh
    void refreshDiskUsage()
    // Auto-refresh every 15 seconds
    const timer = window.setInterval(() => void refreshDiskUsage(), 15000)
    return () => window.clearInterval(timer)
  }, [call, token, view, diskRefresh])
  useEffect(() => {
    if (!drawer && !sheet && !modal && !mobileDetail) return
    const activeDialog = () =>
      Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
        .filter((item) => item.getClientRects().length > 0)
        .at(-1)
    const focusable = () =>
      Array.from(
        activeDialog()?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        ) || []
      ).filter((item) => !item.closest("details:not([open])"))
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawer(false)
        setSheet(false)
        setModal(null)
        setMobileDetail(false)
        return
      }
      if (e.key !== "Tab") return
      const items = focusable()
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    focusable()[0]?.focus()
    document.addEventListener("keydown", close)
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", close)
      document.body.style.overflow = ""
      previousFocus?.focus()
    }
  }, [drawer, mobileDetail, sheet, modal])
  const all = useMemo(() => normalize(queue, jobs, tasks), [queue, jobs, tasks])
  const filtered = all.filter(
    (j) =>
      matchesStatusFilter(j.status, status) &&
      `${j.name} ${j.id} ${j.image}`
        .toLowerCase()
        .includes(filter.toLowerCase())
  )
  const selected =
    filtered.find((j) => j.key === selectedKey) ||
    all.find((j) => j.key === selectedKey) ||
    filtered[0] ||
    all[0]
  useEffect(() => {
    if (selected && !selectedKey) setSelectedKey(selected.key)
  }, [selected, selectedKey])
  const selectedTasks =
    (selected?.taskNames
      .map((n) => tasks.find((t) => t.name === n))
      .filter(Boolean) as TaskRecord[]) || []
  useEffect(() => {
    setLogs("")
    setResultFiles([])
    setResultsTask("")
    setFollowedTask("")
  }, [selected?.key])
  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    try {
      const r = await apiRequest<{ access_token: string }>(apiUrl, "/login", {
        method: "POST",
        body: JSON.stringify(login),
      })
      localStorage.setItem("mlmanage.token", r.access_token)
      setToken(r.access_token)
      setSessionMessage("")
      say("success", "Signed in")
    } catch (e) {
      say("error", `Login failed: ${readable(e)}`)
    } finally {
      setPending(false)
    }
  }
  function logout() {
    localStorage.removeItem("mlmanage.token")
    setToken(null)
    setUser(null)
    setView("jobs")
  }
  async function submit() {
    setSubmitError("")
    const errors: Record<string, string> = {}
    if (!draft.name.trim()) errors.name = "A job name is required."
    if (!draft.image.trim()) errors.image = "Choose or enter an image."
    if (!draft.command.trim()) errors.command = "A command is required."
    if (
      draft.project &&
      !projects.some((project) => project.name === draft.project)
    )
      errors.project = "Choose a project from the available project list."
    if (
      draft.timing === "asap" &&
      (!Number.isInteger(Number(draft.replicas)) || Number(draft.replicas) < 1)
    )
      errors.replicas = "Enter one or more copies."
    if (!Number.isInteger(Number(draft.priority)))
      errors.priority = "Enter a whole number."
    for (const key of ["gpuCount", "vram", "runtimeValue", "diskValue"]) {
      if (
        draft[key as keyof Draft] &&
        (!Number.isFinite(Number(draft[key as keyof Draft])) ||
          Number(draft[key as keyof Draft]) < 0)
      )
        errors[key] = "Enter a non-negative number."
    }
    const vramCap = vramCeiling(user, gpus, draft.gpuUuid)
    if (vramCap != null && Number(draft.vram) > vramCap)
      errors.vram = `Your allocation allows up to ${vramCap} GB of GPU memory per job. Ask an administrator to raise it.`
    if (draft.timing === "schedule") {
      if (availabilityLoading)
        errors.gpuUuid = "Wait for the shared schedule check to finish."
      else if (!draft.gpuUuid.trim())
        errors.gpuUuid = "Choose an available GPU for this window."
      else if (
        !availability.some(
          (gpu) => gpu.gpu_uuid === draft.gpuUuid && gpu.available
        )
      )
        errors.gpuUuid =
          "This GPU is no longer available. Refresh and choose another."
      if (
        !draft.start ||
        !draft.end ||
        new Date(draft.end) <= new Date(draft.start)
      )
        errors.dates = "End must be after start."
    }
    setFormErrors(errors)
    if (pending || Object.keys(errors).length) return
    setPending(true)
    try {
      const common = {
        display_name: draft.name,
        image: draft.image,
        command: parseCommand(draft.command),
        resources: resources(draft),
        gpu_uuid: draft.gpuUuid || undefined,
        vram_limit_gb: +draft.vram || undefined,
        project: draft.project || undefined,
        priority: Number(draft.priority) || 0,
      }
      if (draft.timing === "asap")
        await call("/queue", {
          method: "POST",
          body: JSON.stringify({
            ...common,
            gpus: +draft.gpuCount || 0,
            replicas: Number(draft.replicas) || 1,
            depends_on: draft.dependsOn,
            gang: draft.gang,
            mpi: draft.mpi,
            time_limit_seconds:
              Math.round(
                Number(draft.runtimeValue) *
                  (draft.runtimeUnit === "days"
                    ? 86400
                    : draft.runtimeUnit === "hours"
                      ? 3600
                      : 60)
              ) || undefined,
          }),
        })
      else
        await call("/jobs", {
          method: "POST",
          body: JSON.stringify({
            ...common,
            gpu_partition:
              draft.gpuPartition &&
              migProfilesFor(partitions, draft.gpuUuid).includes(
                draft.gpuPartition
              )
                ? draft.gpuPartition
                : undefined,
            start_time: toIsoFromLocal(draft.start),
            end_time: toIsoFromLocal(draft.end),
            time_limit_seconds: Math.max(
              1,
              Math.round(
                (new Date(draft.end).getTime() -
                  new Date(draft.start).getTime()) /
                  1000
              )
            ),
          }),
        })
      say(
        "success",
        draft.timing === "asap" ? "Job added to queue" : "Job scheduled"
      )
      setSheet(false)
      setDraft(initialDraft())
      await refresh()
    } catch (e) {
      setSubmitError(`Could not create job: ${readable(e)}`)
    } finally {
      setPending(false)
    }
  }
  async function upload(selectedFile: File) {
    if (uploading) return
    if (!selectedFile.name.toLowerCase().endsWith(".tar")) {
      setFile(null)
      say("error", "Choose a Docker save archive ending in .tar")
      return
    }
    // The backend rejects project/group visibility without a target, and it does so
    // only after the whole archive has been uploaded. Catch it before sending.
    if (
      ["project", "group"].includes(imageMeta.visibility) &&
      !imageMeta.shareWith
    ) {
      setFile(null)
      say(
        "error",
        `Choose which ${imageMeta.visibility} may use this image before uploading.`
      )
      return
    }
    setFile(selectedFile)
    setDraft((current) => ({ ...current, image: "" }))
    setUploading(true)
    setUploadProgress(0)
    const form = new FormData()
    form.set("file", selectedFile)
    const imageName =
      imageSlug(imageMeta.name) ||
      imageSlug(selectedFile.name.replace(/\.tar$/i, "")) ||
      "image"
    const query = new URLSearchParams({
      name: imageName,
      tag: imageSlug(imageMeta.tag) || "latest",
      visibility: imageMeta.visibility,
    })
    if (imageMeta.visibility === "project" && imageMeta.shareWith)
      query.set("project", imageMeta.shareWith)
    if (imageMeta.visibility === "group" && imageMeta.shareWith)
      query.set("group", imageMeta.shareWith)
    let uploadedRef = ""
    let uploadError = ""
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open("POST", `${apiUrl}/images?${query}`)
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`)
      xhr.upload.onprogress = (e) =>
        e.lengthComputable &&
        setUploadProgress(Math.round((e.loaded / e.total) * 100))
      xhr.onload = () => {
        try {
          if (xhr.status >= 200 && xhr.status < 300) {
            const record = JSON.parse(xhr.responseText) as ImageRecord
            const ref =
              record.pull_ref ||
              (record as { image?: ImageRecord }).image?.pull_ref
            uploadedRef = ref || ""
          } else {
            let detail = xhr.statusText
            try {
              detail =
                (JSON.parse(xhr.responseText) as { detail?: string }).detail ||
                detail
            } catch {
              // A non-JSON error body is reported with its status alone.
            }
            uploadError = `Image upload failed (${xhr.status}): ${detail}`
          }
        } catch {
          uploadError = "Image upload response could not be read"
        }
        resolve()
      }
      xhr.onerror = () => {
        uploadError = "Image upload failed"
        resolve()
      }
      xhr.send(form)
    })
    if (!uploadedRef && !uploadError) {
      try {
        const library = await call<{ images: ImageRecord[] }>("/images")
        uploadedRef =
          library.images.find((item) => item.name === imageName)?.pull_ref || ""
      } catch {
        // The upload response remains the source of truth when refresh fails.
      }
    }
    await refresh()
    if (uploadedRef) {
      setDraft((draft) => ({ ...draft, image: uploadedRef }))
      // Clear the typed name: the backend replaces an existing name+tag, so keeping
      // it would make the next upload silently overwrite this one.
      setImageMeta((meta) => ({ ...meta, name: "" }))
      say("success", `Uploaded and selected ${uploadedRef}`)
    } else {
      say("error", uploadError || "Uploaded image could not be selected")
    }
    setUploading(false)
  }
  async function cancel() {
    if (!selected) return
    if (/completed|failed|cancelled/i.test(selected.status)) {
      say("info", "This completed job cannot be cancelled.")
      return
    }
    if (!confirm(`Cancel ${selected.name}? Running work may be stopped.`))
      return
    try {
      const hasRunningExecutions =
        selected.taskNames.length > 0 &&
        /running|submitted/i.test(selected.status)
      if (hasRunningExecutions) {
        await Promise.all(
          selected.taskNames.map((name) =>
            call(`/tasks/${encodeURIComponent(name)}`, { method: "DELETE" })
          )
        )
      } else {
        await call(
          selected.kind === "queue"
            ? `/queue/${(selected.source as QueueRecord).id}`
            : selected.kind === "scheduled"
              ? `/jobs/${(selected.source as JobRecord).id}`
              : `/tasks/${encodeURIComponent((selected.source as TaskRecord).name)}`,
          { method: "DELETE" }
        )
      }
      say("success", "Cancellation requested")
      await refresh()
    } catch (e) {
      say("error", readable(e))
    }
  }
  async function loadLogs(task: string) {
    try {
      setLogs(
        logText(
          await call<unknown>(
            `/tasks/${encodeURIComponent(task)}/logs?follow=false&tail_lines=${encodeURIComponent(logTail)}`
          )
        )
      )
    } catch (e) {
      setLogs(logFailure(e))
    }
  }
  useEffect(() => {
    if (!followedTask) return
    const fetchLogs = async () => {
      try {
        setLogs(
          logText(
            await call<unknown>(
              `/tasks/${encodeURIComponent(followedTask)}/logs?follow=false&tail_lines=${encodeURIComponent(logTail)}`
            )
          )
        )
      } catch (error) {
        setLogs(logFailure(error))
      }
    }
    void fetchLogs()
    const timer = window.setInterval(() => void fetchLogs(), 5000)
    return () => window.clearInterval(timer)
  }, [call, followedTask, logTail])
  async function deleteResults(task: string) {
    if (!confirm(`Delete all results for ${task}? This cannot be undone.`))
      return
    try {
      await call(`/tasks/${encodeURIComponent(task)}/results`, {
        method: "DELETE",
      })
      setResultFiles([])
      say("success", "Results deleted")
    } catch (e) {
      say("error", readable(e))
    }
  }
  async function loadResults(task: string) {
    try {
      const r = await call<{
        files?: TaskResultFile[]
        results?: TaskResultFile[]
      }>(`/tasks/${encodeURIComponent(task)}/results`)
      setResultFiles(r.files || r.results || [])
      setResultsTask(task)
    } catch (e) {
      say("error", readable(e))
    }
  }
  async function download(task: string, path?: string) {
    try {
      const b = await downloadBlob(
        apiUrl,
        `/tasks/${encodeURIComponent(task)}/results/download${path ? `?path=${encodeURIComponent(path)}` : ""}`,
        token
      )
      const a = document.createElement("a")
      a.href = URL.createObjectURL(b)
      a.download = path?.split("/").pop() || `${task}-results.tar`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (e) {
      say("error", readable(e))
    }
  }
  async function deleteImage(id: number) {
    try {
      await call(`/images/${id}`, { method: "DELETE" })
      await refresh()
    } catch (e) {
      say("error", readable(e))
    }
  }
  async function cancelReservation(reservation: ReservationRecord) {
    if (
      !confirm(
        `Release the ${parseServerDate(reservation.start_time).toLocaleString()} window on ${reservation.gpu_uuid}? A job started from it is stopped.`
      )
    )
      return
    try {
      await call(`/reservations/${reservation.id}`, { method: "DELETE" })
      say("success", "Reservation released")
      await refresh()
    } catch (e) {
      say("error", `Could not release the reservation: ${readable(e)}`)
    }
  }
  async function downloadReservationCalendar() {
    try {
      saveBlob(
        "mlmanage-reservations.ics",
        await downloadBlob(apiUrl, "/reservations/calendar.ics", token)
      )
      say("success", "Calendar file downloaded")
    } catch (e) {
      say("error", `Could not export the calendar: ${readable(e)}`)
    }
  }
  async function copySubscriptionUrl() {
    const url = `${window.location.origin}${apiUrl}/reservations/calendar.ics?token=${encodeURIComponent(token || "")}`
    try {
      await navigator.clipboard.writeText(url)
      say(
        "success",
        "Subscription address copied — add it in Google Calendar as “From URL”. It contains your personal token, so treat it like a password."
      )
    } catch {
      window.prompt("Copy this calendar subscription address:", url)
    }
  }
  async function importCalendar(selectedFile: File) {
    setPending(true)
    try {
      const form = new FormData()
      form.set("file", selectedFile)
      const result = await call<{ created?: number }>(
        "/reservations/import.ics",
        { method: "POST", body: form }
      )
      say(
        "success",
        result.created
          ? `Imported ${result.created} reservation${result.created === 1 ? "" : "s"}`
          : "No new reservations were imported — every window was already taken."
      )
      await refresh()
    } catch (e) {
      say("error", `Could not import the calendar: ${readable(e)}`)
    } finally {
      setPending(false)
    }
  }
  async function downloadLogs(task: string) {
    try {
      const text = logText(
        await call<unknown>(
          `/tasks/${encodeURIComponent(task)}/logs?follow=false&tail_lines=${encodeURIComponent(logTail)}`
        )
      )
      downloadTextFile(`${task}-logs.txt`, text)
    } catch (e) {
      say("error", `Could not download logs: ${readable(e)}`)
    }
  }
  if (!token || !user)
    return (
      <main className="grid min-h-svh place-items-center bg-[#09090b] p-4 text-zinc-100">
        <form
          onSubmit={signIn}
          className="w-full max-w-sm rounded-lg border border-zinc-800 bg-[#101014] p-6"
        >
          <p className="font-mono text-xs text-blue-400">
            MLMANAGE / JOB MANAGER
          </p>
          <h1 className="mt-2 text-xl font-semibold">Sign in</h1>
          <p className="mt-1 text-xs text-zinc-400">
            Same-origin cluster connection · {connection}
          </p>
          {sessionMessage && (
            <p
              role="status"
              className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100"
            >
              {sessionMessage}
            </p>
          )}
          <label className="mt-6 grid gap-1 text-xs">
            Username
            <input
              aria-label="Username"
              className={input}
              value={login.username}
              onChange={(e) => setLogin({ ...login, username: e.target.value })}
            />
          </label>
          <label className="mt-3 grid gap-1 text-xs">
            Password
            <input
              aria-label="Password"
              type="password"
              className={input}
              value={login.password}
              onChange={(e) => setLogin({ ...login, password: e.target.value })}
            />
          </label>
          <button
            className="mt-5 h-9 w-full rounded-md bg-blue-600 text-sm font-medium hover:bg-blue-500"
            disabled={pending}
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
          {notice && (
            <p role="status" className="mt-3 text-xs text-red-300">
              {notice.text}
            </p>
          )}
        </form>
      </main>
    )
  const Navigation = () => (
    <nav aria-label="Primary navigation" className="grid gap-1">
      {nav
        .filter((n) => !n.admin || role(user) === "admin")
        .map((n) => {
          const Icon = n.icon
          return (
            <button
              key={n.id}
              onClick={() => {
                setView(n.id)
                setDrawer(false)
              }}
              className={cn(
                "flex h-9 items-center gap-2 rounded-md px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                view === n.id
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
              )}
            >
              <Icon className="size-4" />
              {n.label}
            </button>
          )
        })}
    </nav>
  )
  return (
    <main className="min-h-svh overflow-x-hidden bg-[#09090b] text-zinc-100">
      <div className="grid min-h-svh lg:grid-cols-[208px_minmax(0,1fr)]">
        <aside className="hidden border-r border-zinc-800 bg-[#0c0c0f] p-3 lg:block">
          <div className="px-2 py-1">
            <b>MLManage</b>
            <p className="text-[11px] text-zinc-400">GPU job manager</p>
          </div>
          <div className="mt-7">{Navigation()}</div>
          <div className="mt-8 border-t border-zinc-800 px-2 pt-3 text-xs text-zinc-400">
            {user.username} · {user.role}
            <br />
            <span
              className={
                connection === "online" ? "text-emerald-400" : "text-red-400"
              }
            >
              ● {connection}
            </span>
          </div>
          <button className={cn(button, "mt-3 w-full")} onClick={logout}>
            <LogOut className="size-3" />
            Sign out
          </button>
        </aside>
        {drawer && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="fixed inset-0 z-40 lg:hidden"
          >
            {/* Click-away dismiss. Its name differs from the drawer's own close
                control, so the two are distinguishable to assistive technology. */}
            <button
              aria-label="Dismiss navigation"
              className="absolute inset-0 bg-black/70"
              onClick={() => setDrawer(false)}
            />
            <aside className="relative h-full w-72 border-r border-zinc-700 bg-[#0c0c0f] p-4">
              <div className="mb-7 flex items-center justify-between">
                <b>MLManage</b>
                <button
                  aria-label="Close navigation"
                  className={button}
                  onClick={() => setDrawer(false)}
                >
                  <X className="size-4" />
                </button>
              </div>
              {Navigation()}
              <button className={cn(button, "mt-8 w-full")} onClick={logout}>
                Sign out
              </button>
            </aside>
          </div>
        )}
        <section className="min-w-0">
          <header className="flex h-14 items-center justify-between border-b border-zinc-800 px-3 sm:px-5">
            <div className="flex items-center gap-2">
              <button
                ref={drawerButton}
                aria-label="Open navigation"
                className={cn(button, "lg:hidden")}
                onClick={() => setDrawer(true)}
              >
                <Menu className="size-4" />
              </button>
              <div>
                <h1 className="text-sm font-semibold">
                  {nav.find((item) => item.id === view)?.label || view}
                </h1>
                <p className="hidden text-[10px] text-zinc-400 sm:block">
                  {view === "jobs"
                    ? "Queued and scheduled GPU work"
                    : view === "capacity"
                      ? "Inventory, windows, sharing and storage"
                      : view === "usage"
                        ? "Accelerator time, energy and carbon footprint"
                        : view === "account"
                          ? "Your allocation, workspaces and notifications"
                          : "Compact operations"}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                className={button}
                onClick={() => void refresh()}
                aria-label="Refresh"
              >
                <RefreshCw
                  className={cn("size-3", loading && "animate-spin")}
                />
              </button>
              {view === "jobs" && mutable(user) && (
                <button
                  ref={sheetButton}
                  className="inline-flex h-9 items-center gap-1 rounded-md bg-blue-600 px-3 text-xs font-medium hover:bg-blue-500"
                  onClick={() => setSheet(true)}
                >
                  <Plus className="size-4" />
                  New job
                </button>
              )}
            </div>
          </header>
          {notice && (
            <p
              role="status"
              className={cn(
                // Above the sheet/modal overlays (z-50), so an upload or
                // availability failure raised from inside them stays readable.
                "fixed right-4 bottom-4 z-60 max-w-sm rounded-md border bg-zinc-900 px-3 py-2 text-xs shadow-lg",
                notice.kind === "error"
                  ? "border-red-800 text-red-300"
                  : "border-zinc-700 text-zinc-200"
              )}
            >
              {notice.text}
            </p>
          )}
          {view === "jobs" && JobsView()}
          {view === "capacity" && CapacityView()}
          {view === "projects" && ProjectsView()}
          {view === "usage" && UsageView()}
          {view === "account" && AccountView()}
          {view === "admin" && role(user) === "admin" && AdminView()}
        </section>
      </div>
      {sheet && NewJobSheet()}
      {modal && ActionModal()}
      <AlertStack alerts={alerts} onDismiss={handleDismissAlert} />
    </main>
  )
  function JobsView() {
    return (
      <div className="grid min-h-[calc(100svh-56px)] lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="max-h-[calc(100svh-56px)] min-w-0 overflow-y-auto border-r border-zinc-800">
          <div className="flex flex-wrap gap-2 border-b border-zinc-800 p-3">
            <input
              aria-label="Search jobs"
              className={cn(input, "max-w-xs")}
              placeholder="Search jobs"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {STATUS_FILTERS.map(({ id }) => (
              <button
                key={id}
                aria-pressed={status === id}
                className={cn(
                  "rounded-md px-2 text-[11px]",
                  status === id ? "bg-zinc-800 text-white" : "text-zinc-400"
                )}
                onClick={() => setStatus(id)}
              >
                {id}
              </button>
            ))}
          </div>
          <div className="hidden grid-cols-[minmax(160px,1.4fr)_90px_minmax(110px,.8fr)_100px] gap-3 border-b border-zinc-800 px-4 py-2 text-[10px] tracking-wider text-zinc-400 uppercase sm:grid">
            <span>Job</span>
            <span>Status</span>
            <span>Timing</span>
            <span>Compute</span>
          </div>
          {filtered.length ? (
            filtered.map((j) => (
              <button
                key={j.key}
                onClick={() => {
                  setSelectedKey(j.key)
                  if (window.matchMedia("(max-width: 1023px)").matches)
                    setMobileDetail(true)
                }}
                className={cn(
                  "grid w-full gap-2 border-b border-zinc-800 px-3 py-3 text-left sm:grid-cols-[minmax(160px,1.4fr)_90px_minmax(110px,.8fr)_100px] sm:gap-3",
                  selected?.key === j.key
                    ? "bg-zinc-900"
                    : "hover:bg-zinc-900/60"
                )}
              >
                <span className="min-w-0">
                  <b className="block truncate text-sm font-medium">{j.name}</b>
                  <span className="font-mono text-[10px] text-zinc-400">
                    {j.id} · {j.owner}
                    {j.kind === "legacy" ? " · legacy execution" : ""}
                  </span>
                </span>
                <span>
                  <Pill status={j.status}>{j.status}</Pill>
                </span>
                <span className="text-xs text-zinc-400">{j.timing}</span>
                <span className="font-mono text-xs text-zinc-400">
                  {j.compute}
                </span>
              </button>
            ))
          ) : (
            <p className="p-5 text-sm text-zinc-400">
              No jobs match this filter.
            </p>
          )}
        </section>
        <div className="hidden lg:block">
          {/* Called, not rendered as <JobDetail/>: a component declared inside this one
              is a new type on every render, which would rebuild the panel's DOM on each
              workload poll. Every other view here is invoked the same way. */}
          {JobDetail()}
        </div>
        {mobileDetail && (
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Job detail"
            className="fixed inset-0 z-50 flex flex-col bg-[#09090b] lg:hidden"
          >
            <header className="flex h-14 items-center justify-between border-b border-zinc-800 px-3">
              <b className="text-sm">Job detail</b>
              <button
                aria-label="Close job detail"
                className={button}
                onClick={() => setMobileDetail(false)}
              >
                <X className="size-4" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">{JobDetail()}</div>
          </section>
        )}
      </div>
    )
  }
  function JobDetail() {
    if (!selected)
      return (
        <aside className="p-5 text-sm text-zinc-400">
          Select a job to inspect it.
        </aside>
      )
    const queueSource =
      selected.kind === "queue" ? (selected.source as QueueRecord) : null
    const jobSource =
      selected.kind === "scheduled" ? (selected.source as JobRecord) : null
    const dependencies = queueSource
      ? parseMaybeJson<number[]>(queueSource.depends_on, [])
      : []
    const sharing = [
      queueSource?.gang ? "all copies start together" : "",
      queueSource?.mpi ? "MPI launcher and workers" : "",
    ].filter(Boolean)
    const extras: Array<[string, React.ReactNode]> = [
      ["Owner", selected.owner],
      ["Project", selected.project || "Personal allocation"],
    ]
    const priority = (selected.source as { priority?: number | null }).priority
    if (priority)
      extras.push(["Priority", `${priority} (higher runs before lower)`])
    if (queueSource?.replicas && queueSource.replicas > 1)
      extras.push(["Copies", `${queueSource.replicas} parallel pods`])
    if (sharing.length) extras.push(["Placement", sharing.join(" · ")])
    if (dependencies.length)
      extras.push(["Waits for", dependencies.map((id) => `Q-${id}`).join(", ")])
    const slice = (selected.source as { gpu_partition?: string | null })
      .gpu_partition
    if (slice) extras.push(["GPU slice", slice])
    // A container that never started writes no logs, so the recorded pod outcome is the
    // only thing that explains the failure once the pod has been cleaned up.
    const failure = (selected.source as { failure_reason?: string | null })
      .failure_reason
    if (failure)
      extras.push([
        "Why it ended",
        <span key="failure" className="text-right break-words text-red-300">
          {failure}
        </span>,
      ])
    return (
      <aside className="border-t border-zinc-800 p-4 lg:border-t-0">
        <p className="font-mono text-[10px] text-zinc-400">{selected.id}</p>
        <h2 className="mt-1 text-base font-semibold break-words">
          {selected.name}
        </h2>
        <div className="mt-3 flex items-center justify-between">
          <Pill status={selected.status}>{selected.status}</Pill>
          {mutable(user) && (
            <button
              className="text-xs text-red-400"
              onClick={() => void cancel()}
            >
              Cancel
            </button>
          )}
        </div>
        {selected.kind === "scheduled" && (
          <div className="mb-3 flex flex-wrap gap-1">
            <button
              className={button}
              onClick={() => downloadCalendar(selected.source as JobRecord)}
            >
              Download calendar event (.ics)
            </button>
            {mutable(user) && jobSource?.reservation_id && (
              <button
                className={button}
                onClick={() =>
                  openModal("renew-reservation", {
                    id: String(jobSource.reservation_id),
                    gpu_uuid: jobSource.gpu_uuid,
                    current_end: jobSource.end_time,
                    end: formatDateTimeLocal(
                      new Date(
                        parseServerDate(jobSource.end_time).getTime() +
                          3_600_000
                      )
                    ),
                  })
                }
              >
                Hold the accelerator longer
              </button>
            )}
          </div>
        )}
        <dl className="mt-4 grid gap-2 border-y border-zinc-800 py-4 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-400">Timing</dt>
            <dd className="text-right">{selected.timing}</dd>
          </div>
          {extras.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-zinc-400">{label}</dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-400">Compute</dt>
            <dd>{selected.compute}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-400">Image</dt>
            <dd className="max-w-[180px] truncate font-mono">
              {selected.image}
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-zinc-400">Command</dt>
            <dd className="font-mono text-[11px] break-all">
              {selected.command}
            </dd>
          </div>
        </dl>
        <div className="mt-4">
          <h3 className="text-xs font-medium">Execution attempts</h3>
          {selectedTasks.length > 0 && (
            <label className="mt-2 grid gap-1 text-xs">
              Log lines to fetch
              <select
                aria-label="Log lines to fetch"
                className={cn(input, "w-32")}
                value={logTail}
                onChange={(event) => setLogTail(event.target.value)}
              >
                <option value="50">Last 50</option>
                <option value="200">Last 200</option>
                <option value="1000">Last 1000</option>
                <option value="10000">Last 10000</option>
              </select>
            </label>
          )}
          {selectedTasks.length ? (
            selectedTasks.map((t) => (
              <div key={t.name} className="mt-2 border-b border-zinc-800 pb-2">
                <p className="font-mono text-[11px]">{t.name}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  <button
                    className={button}
                    onClick={() => void loadLogs(t.name)}
                  >
                    Logs
                  </button>
                  <button
                    className={button}
                    onClick={() => void loadResults(t.name)}
                  >
                    Results
                  </button>
                  <button
                    className={button}
                    aria-pressed={followedTask === t.name}
                    onClick={() =>
                      setFollowedTask((current) =>
                        current === t.name ? "" : t.name
                      )
                    }
                  >
                    {followedTask === t.name ? "Stop follow" : "Follow logs"}
                  </button>
                  <button
                    className={button}
                    onClick={() => void downloadLogs(t.name)}
                  >
                    Save logs
                  </button>
                  {mutable(user) && (
                    <button
                      className={cn(button, "text-red-300")}
                      onClick={() => void deleteResults(t.name)}
                    >
                      Delete results
                    </button>
                  )}
                  <button
                    className={button}
                    onClick={() => void download(t.name)}
                  >
                    Download
                  </button>
                  {mutable(user) && (
                    <button
                      className={cn(button, "text-red-300")}
                      onClick={() => {
                        if (!confirm(`Cancel execution ${t.name}?`)) return
                        void call(`/tasks/${encodeURIComponent(t.name)}`, {
                          method: "DELETE",
                        })
                          .then(() => {
                            say("success", "Task cancellation requested")
                            return refresh()
                          })
                          .catch((error) => say("error", readable(error)))
                      }}
                    >
                      Cancel task
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="mt-2 text-xs text-zinc-400">
              No linked Task yet.
              {selected.kind === "legacy" ? " Legacy execution record." : ""}
            </p>
          )}
          <p className="mt-3 text-[10px] text-zinc-400">
            Browser exec is unavailable through the same-origin WebSocket
            boundary.
          </p>
          {logs && (
            <pre
              aria-label="Task logs"
              className="mt-3 max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 text-[10px] text-zinc-400"
            >
              {logs}
            </pre>
          )}
          {resultFiles.length > 0 && (
            <div className="mt-2 text-xs">
              {resultFiles.map((f) => (
                <button
                  key={f.path}
                  className="mr-2 text-blue-300 underline"
                  onClick={() =>
                    resultsTask && void download(resultsTask, f.path)
                  }
                >
                  {f.path}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>
    )
  }
  function NewJobSheet() {
    // A dependency is cleared when it completes, so offer anything unfinished and
    // leave out failed/cancelled entries, which would cancel this job instead.
    const waitCandidates = queue.filter((item) =>
      ["queued", "waiting_deps", "running"].includes(
        String(item.status || "").toLowerCase()
      )
    )
    const sliceOptions = migProfilesFor(partitions, draft.gpuUuid)
    const uploadTargetReady =
      !["project", "group"].includes(imageMeta.visibility) ||
      Boolean(imageMeta.shareWith)
    // The backend upserts on (owner, name, tag): warn before an upload overwrites
    // an image that is already in the library.
    const plannedName = imageSlug(imageMeta.name)
    const plannedTag = imageSlug(imageMeta.tag) || "latest"
    const replacedImage =
      plannedName &&
      images.find(
        (item) =>
          item.name === plannedName &&
          item.tag === plannedTag &&
          item.user === user?.username
      )?.pull_ref
    return (
      <div className="fixed inset-0 z-50 bg-black/70">
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-job-title"
          className="ml-auto flex h-[100svh] w-full max-w-2xl flex-col border-l border-zinc-700 bg-[#101014]"
        >
          <header className="flex items-center justify-between border-b border-zinc-800 p-4">
            <div>
              <p className="font-mono text-[10px] text-blue-400">NEW JOB</p>
              <h2 id="new-job-title" className="text-lg font-semibold">
                What should run?
              </h2>
            </div>
            <button
              aria-label="Close new job"
              className={button}
              onClick={() => setSheet(false)}
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="grid gap-3">
              <label className="grid gap-1 text-xs">
                Job name
                <input
                  className={input}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. llama fine-tune"
                />
                {formErrors.name && (
                  <span className="text-[11px] text-red-300">
                    {formErrors.name}
                  </span>
                )}
              </label>
              <div>
                <p className="text-xs font-medium">Container</p>
                <div className="mt-2 flex gap-1" role="tablist">
                  {(["existing", "external", "upload"] as const).map((m) => (
                    <button
                      key={m}
                      role="tab"
                      aria-selected={imageMode === m}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs",
                        imageMode === m ? "bg-zinc-800" : "text-zinc-400"
                      )}
                      onClick={() => setImageMode(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                {imageMode === "existing" ? (
                  <select
                    aria-label="Existing image"
                    className={cn(input, "mt-2")}
                    value={draft.image}
                    onChange={(e) =>
                      setDraft({ ...draft, image: e.target.value })
                    }
                  >
                    <option value="">Select image</option>
                    {images.map((i) => (
                      <option key={i.id} value={i.pull_ref}>
                        {i.pull_ref}
                      </option>
                    ))}
                  </select>
                ) : imageMode === "external" ? (
                  <input
                    aria-label="External pull reference"
                    className={cn(input, "mt-2")}
                    placeholder="registry.example.com/team/image:tag"
                    value={draft.image}
                    onChange={(e) =>
                      setDraft({ ...draft, image: e.target.value })
                    }
                  />
                ) : (
                  <>
                    <div className="mt-2 grid gap-2 rounded-md border border-zinc-800 p-3 sm:grid-cols-2">
                      <p className="text-[10px] text-zinc-400 sm:col-span-2">
                        These details are applied to the upload, so set them
                        before you choose the file.
                      </p>
                      {replacedImage && (
                        <p className="text-[11px] text-amber-300 sm:col-span-2">
                          {replacedImage} already exists — uploading replaces
                          it.
                        </p>
                      )}
                      <label className="grid gap-1 text-xs">
                        Image name
                        <input
                          aria-label="Image name"
                          className={input}
                          value={imageMeta.name}
                          placeholder="Taken from the file name"
                          onChange={(event) =>
                            setImageMeta((meta) => ({
                              ...meta,
                              name: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="grid gap-1 text-xs">
                        Tag
                        <input
                          aria-label="Image tag"
                          className={input}
                          value={imageMeta.tag}
                          placeholder="latest"
                          onChange={(event) =>
                            setImageMeta((meta) => ({
                              ...meta,
                              tag: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="grid gap-1 text-xs">
                        Who can use it
                        <select
                          aria-label="Image visibility"
                          className={input}
                          value={imageMeta.visibility}
                          onChange={(event) =>
                            setImageMeta((meta) => ({
                              ...meta,
                              visibility: event.target.value,
                              shareWith: "",
                            }))
                          }
                        >
                          <option value="user">Only me</option>
                          <option value="project">A project</option>
                          <option value="group">A group</option>
                          <option value="everyone">Everyone</option>
                        </select>
                      </label>
                      {(imageMeta.visibility === "project" ||
                        imageMeta.visibility === "group") && (
                        <label className="grid gap-1 text-xs">
                          {imageMeta.visibility === "project"
                            ? "Project"
                            : "Group"}
                          <select
                            aria-label="Share image with"
                            className={input}
                            value={imageMeta.shareWith}
                            onChange={(event) =>
                              setImageMeta((meta) => ({
                                ...meta,
                                shareWith: event.target.value,
                              }))
                            }
                          >
                            <option value="">Select…</option>
                            {(imageMeta.visibility === "project"
                              ? projects.map((project) => project.name)
                              : groups.map((group) => group.name)
                            ).map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    <div
                      className={cn(
                        "mt-2 rounded-md border border-dashed p-4 text-center transition-colors",
                        draggingFile
                          ? "border-blue-400 bg-blue-500/10"
                          : "border-zinc-700 bg-zinc-950/30"
                      )}
                      onDragEnter={(event) => {
                        event.preventDefault()
                        if (!uploading) setDraggingFile(true)
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDragLeave={(event) => {
                        if (
                          !event.currentTarget.contains(
                            event.relatedTarget as Node
                          )
                        )
                          setDraggingFile(false)
                      }}
                      onDrop={(event) => {
                        event.preventDefault()
                        setDraggingFile(false)
                        const selectedFile = event.dataTransfer.files[0]
                        if (selectedFile) void upload(selectedFile)
                      }}
                    >
                      <input
                        ref={uploadInput}
                        aria-label="Docker save tar file"
                        className="sr-only"
                        type="file"
                        accept=".tar,application/x-tar"
                        disabled={uploading}
                        onChange={(event) => {
                          const selectedFile = event.target.files?.[0]
                          event.target.value = ""
                          if (selectedFile) void upload(selectedFile)
                        }}
                      />
                      <Upload className="mx-auto size-5 text-zinc-400" />
                      <p className="mt-2 text-xs text-zinc-200">
                        Drop a Docker save .tar here
                      </p>
                      <p className="mt-1 text-[10px] text-zinc-500">
                        Upload starts automatically after selection.
                      </p>
                      <button
                        type="button"
                        className={cn(button, "mt-3")}
                        disabled={uploading || !uploadTargetReady}
                        title={
                          uploadTargetReady
                            ? undefined
                            : `Choose which ${imageMeta.visibility} may use this image first.`
                        }
                        onClick={() => uploadInput.current?.click()}
                      >
                        {uploading ? "Uploading…" : "Choose .tar file"}
                      </button>
                      <p
                        className="mt-2 min-h-4 text-[11px] text-zinc-400"
                        role="status"
                        aria-live="polite"
                      >
                        {uploading && file
                          ? `Uploading ${file.name} · ${uploadProgress}%`
                          : !uploadTargetReady
                            ? `Choose which ${imageMeta.visibility} may use this image before uploading.`
                            : draft.image && file
                              ? `${file.name} is uploaded and selected.`
                              : "Or choose a file from your computer."}
                      </p>
                      {uploading && (
                        <div
                          className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800"
                          role="progressbar"
                          aria-label="Container upload progress"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={uploadProgress}
                        >
                          <div
                            className="h-full bg-blue-500 transition-[width]"
                            style={{ width: `${uploadProgress}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
                <p className="mt-1 text-[10px] text-zinc-400">
                  Choose a library image, reference an external image, or upload
                  inline.
                </p>
                {formErrors.image && (
                  <p className="text-[11px] text-red-300">{formErrors.image}</p>
                )}
                {images.length > 0 && (
                  <details className="mt-2 text-xs text-zinc-400">
                    <summary>Container library ({images.length})</summary>
                    {images.map((i) => (
                      <div key={i.id} className="mt-1 flex justify-between">
                        <span className="truncate">{i.pull_ref}</span>
                        {mutable(user) && (
                          <span className="flex shrink-0 items-center gap-2">
                            <button
                              className="text-[11px] text-blue-300"
                              aria-label={`Change who can use ${i.name}`}
                              onClick={() =>
                                openModal("image", {
                                  id: String(i.id),
                                  pull_ref: i.pull_ref,
                                  visibility: i.visibility || "user",
                                  shareWith: i.project || i.group || "",
                                })
                              }
                            >
                              {VISIBILITY_LABELS[i.visibility || "user"] ||
                                i.visibility}
                              {i.project || i.group
                                ? ` · ${i.project || i.group}`
                                : ""}
                            </button>
                            <button
                              className="text-red-400"
                              onClick={() => void deleteImage(i.id)}
                              aria-label={`Delete ${i.name}`}
                            >
                              <Trash2 className="size-3" />
                            </button>
                          </span>
                        )}
                      </div>
                    ))}
                  </details>
                )}
              </div>
              <label className="grid gap-1 text-xs">
                Command
                <textarea
                  className="min-h-20 rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  value={draft.command}
                  onChange={(e) =>
                    setDraft({ ...draft, command: e.target.value })
                  }
                  placeholder={"python\ntrain.py\n--config\nconfig.yaml"}
                />
                <span className="text-[10px] text-zinc-400">
                  One argument per line: the first line is the program, each
                  following line is one argument. To run a shell line instead,
                  use three lines: <code>sh</code>, <code>-c</code>, then the
                  whole command.
                </span>
                {commandHint(draft.command) && (
                  <span role="status" className="text-[11px] text-amber-300">
                    {commandHint(draft.command)}
                  </span>
                )}
                {formErrors.command && (
                  <span className="text-[11px] text-red-300">
                    {formErrors.command}
                  </span>
                )}
              </label>
              <div>
                <p className="text-xs font-medium">When</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["asap", "schedule"] as const).map((t) => (
                    <button
                      key={t}
                      className={cn(
                        "rounded-md border p-2 text-left",
                        draft.timing === t
                          ? "border-blue-500 bg-blue-500/10"
                          : "border-zinc-700"
                      )}
                      onClick={() => setDraft({ ...draft, timing: t })}
                    >
                      <b className="text-xs">
                        {t === "asap" ? "As soon as possible" : "Schedule"}
                      </b>
                      <span className="mt-1 block text-[10px] text-zinc-400">
                        {t === "asap"
                          ? "Fair-share queue"
                          : "Exact reservation window"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              {draft.timing === "schedule" && (
                <div className="grid gap-3">
                  <p className="rounded-md border border-blue-500/30 bg-blue-500/10 p-2 text-xs text-blue-100">
                    Pick a window in your local timezone, then choose a GPU
                    marked available. Scheduled work reserves that accelerator
                    for the selected time.
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="grid gap-1 text-xs">
                      Start{" "}
                      <input
                        className={input}
                        type="datetime-local"
                        value={draft.start}
                        onChange={(e) =>
                          setDraft({ ...draft, start: e.target.value })
                        }
                      />
                    </label>
                    <label className="grid gap-1 text-xs">
                      End{" "}
                      <input
                        className={input}
                        type="datetime-local"
                        value={draft.end}
                        onChange={(e) =>
                          setDraft({ ...draft, end: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  <div
                    className="max-h-44 overflow-auto rounded-md border border-zinc-800"
                    role="region"
                    aria-label="Accelerator availability"
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Accelerator</th>
                          <th>Availability</th>
                          <th>Existing reservations</th>
                        </tr>
                      </thead>
                      <tbody>
                        {availability.map((gpu) => (
                          <tr
                            key={gpu.gpu_uuid}
                            className={gpu.available ? "" : "bg-red-500/5"}
                          >
                            <td>
                              <label className="flex items-center gap-2">
                                <input
                                  type="radio"
                                  name="scheduled-gpu"
                                  checked={draft.gpuUuid === gpu.gpu_uuid}
                                  disabled={!gpu.available}
                                  onChange={() =>
                                    setDraft({
                                      ...draft,
                                      gpuUuid: gpu.gpu_uuid,
                                    })
                                  }
                                />
                                {gpu.product || "GPU"}
                                {gpu.synthetic_e2e && (
                                  <span className="text-[10px] text-amber-300">
                                    synthetic
                                  </span>
                                )}
                                <span className="font-mono text-[10px] text-zinc-400">
                                  {gpu.gpu_uuid}
                                </span>
                              </label>
                            </td>
                            <td>
                              <Pill
                                status={
                                  gpu.available ? "available" : "conflict"
                                }
                              >
                                {gpu.available ? "available" : "busy"}
                              </Pill>
                            </td>
                            <td className="text-xs text-zinc-400">
                              {gpu.busy_windows.length
                                ? gpu.busy_windows
                                    .map(
                                      (window) =>
                                        `${parseServerDate(window.start).toLocaleString()}–${parseServerDate(window.end).toLocaleTimeString()}`
                                    )
                                    .join(", ")
                                : "No conflict in this window"}
                            </td>
                          </tr>
                        ))}
                        {!availability.length && (
                          <tr>
                            <td colSpan={3} className="text-xs text-zinc-400">
                              {availabilityLoading
                                ? "Checking the shared schedule…"
                                : "No schedulable accelerators were returned for this window."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <button
                    className={cn(button, "w-fit")}
                    onClick={() => setAvailabilityRefresh((value) => value + 1)}
                  >
                    Refresh availability
                  </button>
                  {formErrors.gpuUuid && (
                    <span className="text-[11px] text-red-300">
                      {formErrors.gpuUuid}
                    </span>
                  )}
                </div>
              )}
              {formErrors.dates && (
                <p className="text-[11px] text-red-300">{formErrors.dates}</p>
              )}
              <section
                aria-labelledby="compute-heading"
                className="rounded-md border border-zinc-800 p-3"
              >
                <div className="mb-3">
                  <h3 id="compute-heading" className="text-sm font-medium">
                    Compute
                  </h3>
                  <p className="text-xs text-zinc-400">
                    Set the resources available to this job. Project allocations
                    are applied when a project is selected.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="grid gap-1 text-xs">
                    Project
                    <input
                      aria-label="Project"
                      className={input}
                      list="available-projects"
                      value={draft.project}
                      onChange={(e) =>
                        setDraft({ ...draft, project: e.target.value })
                      }
                      placeholder="No project — use my allocation"
                    />
                    <datalist id="available-projects">
                      {projects.map((project) => (
                        <option key={project.name} value={project.name}>
                          {project.name}
                        </option>
                      ))}
                    </datalist>
                    <span className="text-[10px] text-zinc-400">
                      Search and select an available project, or leave empty to
                      use your own allocation.
                    </span>
                    {formErrors.project && (
                      <span className="text-[11px] text-red-300">
                        {formErrors.project}
                      </span>
                    )}
                  </label>
                  {draft.timing === "asap" ? (
                    <label className="grid gap-1 text-xs">
                      Run time limit{" "}
                      <span className="flex gap-2">
                        <input
                          aria-label="Run time limit"
                          className={input}
                          type="number"
                          min="1"
                          value={draft.runtimeValue}
                          onChange={(e) =>
                            setDraft({ ...draft, runtimeValue: e.target.value })
                          }
                        />
                        <select
                          aria-label="Run time unit"
                          className={cn(input, "w-28")}
                          value={draft.runtimeUnit}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              runtimeUnit: e.target
                                .value as Draft["runtimeUnit"],
                            })
                          }
                        >
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                        </select>
                      </span>
                      <span className="text-[10px] text-zinc-400">
                        The service stops the job after this duration.
                      </span>
                    </label>
                  ) : (
                    <p className="text-xs text-zinc-400">
                      Run time limit: derived from the selected reservation
                      window.
                    </p>
                  )}
                  <label className="grid gap-1 text-xs">
                    Accelerators needed{" "}
                    <input
                      aria-label="Accelerators needed"
                      className={input}
                      type="number"
                      min="0"
                      disabled={draft.timing === "schedule"}
                      value={draft.timing === "schedule" ? "1" : draft.gpuCount}
                      onChange={(e) =>
                        setDraft({ ...draft, gpuCount: e.target.value })
                      }
                    />
                    <span className="text-[10px] text-zinc-400">
                      {draft.timing === "schedule"
                        ? "A scheduled job runs on the one accelerator it reserves. Queue the job instead to ask for several."
                        : "Number of GPUs needed for each copy of the job."}
                    </span>
                  </label>
                  <label className="grid gap-1 text-xs">
                    GPU memory (GB){" "}
                    <input
                      className={input}
                      type="number"
                      min="0"
                      max={vramCeiling(user, gpus, draft.gpuUuid) ?? undefined}
                      value={draft.vram}
                      onChange={(e) =>
                        setDraft({ ...draft, vram: e.target.value })
                      }
                    />
                    <span className="text-[10px] text-zinc-400">
                      {vramCeiling(user, gpus, draft.gpuUuid) == null
                        ? "VRAM made available to the job."
                        : `Up to ${vramCeiling(user, gpus, draft.gpuUuid)} GB for your account.`}
                    </span>
                    {formErrors.vram && (
                      <span className="text-[11px] text-red-300">
                        {formErrors.vram}
                      </span>
                    )}
                  </label>
                  <label className="grid gap-1 text-xs">
                    CPU cores{" "}
                    <input
                      aria-label="CPU cores"
                      className={input}
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={draft.cpu}
                      onChange={(e) =>
                        setDraft({ ...draft, cpu: e.target.value })
                      }
                    />
                    <span className="text-[10px] text-zinc-400">
                      Number of CPU cores available to the job.
                    </span>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Memory{" "}
                    <span className="flex gap-2">
                      <input
                        aria-label="Memory size"
                        className={input}
                        type="number"
                        min="0"
                        value={draft.memoryValue}
                        onChange={(e) =>
                          setDraft({ ...draft, memoryValue: e.target.value })
                        }
                      />
                      <select
                        aria-label="Memory unit"
                        className={cn(input, "w-24")}
                        value={draft.memoryUnit}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            memoryUnit: e.target.value as Draft["memoryUnit"],
                          })
                        }
                      >
                        <option value="Mi">MiB</option>
                        <option value="Gi">GiB</option>
                        <option value="Ti">TiB</option>
                      </select>
                    </span>
                    <span className="text-[10px] text-zinc-400">
                      Memory available to the job.
                    </span>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Temporary disk{" "}
                    <span className="flex gap-2">
                      <input
                        aria-label="Temporary disk size"
                        className={input}
                        type="number"
                        min="0"
                        value={draft.diskValue}
                        onChange={(e) =>
                          setDraft({ ...draft, diskValue: e.target.value })
                        }
                      />
                      <select
                        aria-label="Temporary disk unit"
                        className={cn(input, "w-24")}
                        value={draft.diskUnit}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            diskUnit: e.target.value as Draft["diskUnit"],
                          })
                        }
                      >
                        <option value="Mi">MiB</option>
                        <option value="Gi">GiB</option>
                        <option value="Ti">TiB</option>
                      </select>
                    </span>
                    <span className="text-[10px] text-zinc-400">
                      Scratch space removed when the job ends.
                    </span>
                  </label>
                </div>
              </section>
              <details className="rounded-md border border-zinc-800 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Advanced scheduling (optional)
                </summary>
                <p className="mt-1 text-xs text-zinc-400">
                  Defaults suit a single job on one machine. Change these only
                  when you need queue ordering, multiple cooperating copies, or
                  a hardware slice.
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-xs">
                    Priority
                    <input
                      aria-label="Priority"
                      className={input}
                      type="number"
                      step="1"
                      value={draft.priority}
                      onChange={(e) =>
                        setDraft({ ...draft, priority: e.target.value })
                      }
                    />
                    <span className="text-[10px] text-zinc-400">
                      Higher numbers start before lower ones. Your account
                      priority still applies.
                    </span>
                    {formErrors.priority && (
                      <span className="text-[11px] text-red-300">
                        {formErrors.priority}
                      </span>
                    )}
                  </label>
                  {draft.timing === "asap" ? (
                    <>
                      <label className="grid gap-1 text-xs">
                        Pin to one accelerator
                        <select
                          aria-label="Pin to one accelerator"
                          className={input}
                          value={draft.gpuUuid}
                          onChange={(e) =>
                            setDraft({ ...draft, gpuUuid: e.target.value })
                          }
                        >
                          <option value="">Any suitable accelerator</option>
                          {gpus
                            .filter((gpu) => !gpu.simulated)
                            .map((gpu) => (
                              <option key={gpu.uuid} value={gpu.uuid}>
                                {gpu.product || gpu.uuid}
                                {gpu.node ? ` · ${gpu.node}` : ""}
                              </option>
                            ))}
                        </select>
                        <span className="text-[10px] text-zinc-400">
                          Leave on “any” unless the job needs one specific card.
                          Pinning makes it wait for that card to free up.
                        </span>
                      </label>
                      <label className="grid gap-1 text-xs">
                        Parallel copies
                        <input
                          aria-label="Parallel copies"
                          className={input}
                          type="number"
                          min="1"
                          step="1"
                          value={draft.replicas}
                          onChange={(e) =>
                            setDraft({ ...draft, replicas: e.target.value })
                          }
                        />
                        <span className="text-[10px] text-zinc-400">
                          Runs this many identical pods, each with the compute
                          above. Use for multi-node training.
                        </span>
                        {formErrors.replicas && (
                          <span className="text-[11px] text-red-300">
                            {formErrors.replicas}
                          </span>
                        )}
                      </label>
                      <label className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={draft.gang}
                          onChange={(e) =>
                            setDraft({ ...draft, gang: e.target.checked })
                          }
                        />
                        <span>
                          Start all copies together
                          <span className="block text-[10px] text-zinc-400">
                            Gang scheduling: nothing starts until every copy can
                            start.
                          </span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={draft.mpi}
                          onChange={(e) =>
                            setDraft({ ...draft, mpi: e.target.checked })
                          }
                        />
                        <span>
                          Run as an MPI job
                          <span className="block text-[10px] text-zinc-400">
                            Adds a launcher plus workers instead of independent
                            copies.
                          </span>
                        </span>
                      </label>
                      <fieldset className="text-xs sm:col-span-2">
                        <legend className="mb-1">Wait for other jobs</legend>
                        <p className="mb-2 text-[10px] text-zinc-400">
                          This job stays queued until the selected queued jobs
                          finish.
                        </p>
                        {waitCandidates.length ? (
                          <div className="grid max-h-32 gap-1 overflow-y-auto">
                            {waitCandidates.map((item) => (
                              <label
                                key={item.id}
                                className="flex items-center gap-2"
                              >
                                <input
                                  type="checkbox"
                                  checked={draft.dependsOn.includes(item.id)}
                                  onChange={(e) =>
                                    setDraft({
                                      ...draft,
                                      dependsOn: e.target.checked
                                        ? [...draft.dependsOn, item.id]
                                        : draft.dependsOn.filter(
                                            (id) => id !== item.id
                                          ),
                                    })
                                  }
                                />
                                <span className="truncate">
                                  Q-{item.id} ·{" "}
                                  {item.display_name ||
                                    formatCommand(item.command).slice(0, 40)}
                                </span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[11px] text-zinc-400">
                            You have no unfinished queued jobs to wait for.
                          </p>
                        )}
                      </fieldset>
                    </>
                  ) : (
                    <label className="grid gap-1 text-xs">
                      GPU slice
                      <select
                        aria-label="GPU slice"
                        className={input}
                        value={draft.gpuPartition}
                        onChange={(e) =>
                          setDraft({ ...draft, gpuPartition: e.target.value })
                        }
                      >
                        <option value="">Whole accelerator</option>
                        {sliceOptions.map((profile) => (
                          <option key={profile} value={profile}>
                            {profile} ({MIG_PROFILE_VRAM_GB[profile] ?? "?"} GB)
                          </option>
                        ))}
                      </select>
                      <span className="text-[10px] text-zinc-400">
                        {sliceOptions.length
                          ? "Reserve one MIG slice instead of the whole card, so others can use the rest."
                          : "The selected accelerator has no MIG slices configured, so the whole card is reserved."}
                      </span>
                    </label>
                  )}
                </div>
              </details>
              {Object.entries(formErrors)
                .filter(([key]) =>
                  [
                    "gpuCount",
                    "vram",
                    "runtimeValue",
                    "diskValue",
                    "replicas",
                    "priority",
                  ].includes(key)
                )
                .map(([key, message]) => (
                  <p key={key} className="text-[11px] text-red-300">
                    {key}: {message}
                  </p>
                ))}
            </div>
          </div>
          <footer className="grid gap-3 border-t border-zinc-800 p-4">
            {submitError && (
              <p
                role="alert"
                className="rounded-md border border-red-900/80 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-200"
              >
                {submitError}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-zinc-400">
                {draft.timing === "asap"
                  ? "Will enter the fair-share queue"
                  : "Will reserve the selected GPU window"}
              </p>
              <button
                className="h-9 shrink-0 rounded-md bg-blue-600 px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-400"
                disabled={
                  pending ||
                  availabilityLoading ||
                  !draft.name ||
                  !draft.image ||
                  !draft.command ||
                  (draft.timing === "schedule" &&
                    (!draft.gpuUuid ||
                      new Date(draft.end) <= new Date(draft.start)))
                }
                onClick={() => void submit()}
              >
                {pending
                  ? "Submitting…"
                  : draft.timing === "asap"
                    ? "Queue job"
                    : "Schedule job"}
              </button>
            </div>
          </footer>
        </section>
      </div>
    )
  }
  function openModal(
    kind: NonNullable<typeof modal>,
    values: Record<string, string> = {}
  ) {
    setMemberSearch("")
    setModalError("")
    setModalData(values)
    setModal(kind)
  }
  async function submitModal() {
    setModalError("")
    if (pending) return
    if (
      modal === "partition" &&
      !confirm(
        "Changing GPU partitioning is disruptive and can affect running workloads. Continue?"
      )
    )
      return
    setPending(true)
    try {
      const d = modalData
      // Per-model limits use their own `gpuq_`/`vramq_` prefixes so they can never
      // collide with the flat `quota_cpu`/`quota_gpu` account fields.
      const quotaByModel = Object.fromEntries(
        Object.entries(d)
          .filter(([key, value]) => key.startsWith("gpuq_") && value.trim())
          .map(([key, value]) => [key.slice("gpuq_".length), Number(value)])
      )
      const vramByModel = Object.fromEntries(
        Object.entries(d)
          .filter(([key, value]) => key.startsWith("vramq_") && value.trim())
          .map(([key, value]) => [key.slice("vramq_".length), Number(value)])
      )
      const members = d.members ? d.members.split(",").filter(Boolean) : []
      if (modal === "reservation")
        await call("/reservations", {
          method: "POST",
          body: JSON.stringify({
            gpu_uuid: d.gpu_uuid,
            start_time: toIsoFromLocal(d.start),
            end_time: toIsoFromLocal(d.end),
            priority: Number(d.priority || 0),
            gpu_partition: d.gpu_partition || undefined,
          }),
        })
      if (modal === "renew-reservation")
        await call(`/reservations/${encodeURIComponent(d.id)}/renew`, {
          method: "PUT",
          body: JSON.stringify({ end_time: toIsoFromLocal(d.end) }),
        })
      if (modal === "partition") {
        // 1 share means the card is NOT divided, which is what Full GPU is for: the device
        // plugin drops a 1-share entry, so the backend rejects it rather than record a
        // sharing mode for a whole card. Say so here instead of surfacing a 400.
        if (
          (d.mode === "timeslice" || d.mode === "mps") &&
          Number(d.replicas) < 2
        ) {
          setModalError(
            "Sharing starts at 2 shares — pick Full GPU to leave this card whole."
          )
          return
        }
        const migProfiles = Object.fromEntries(
          Object.entries(d)
            .filter(
              ([key, value]) => key.startsWith("mig_") && Number(value) > 0
            )
            .map(([key, value]) => [key.slice("mig_".length), Number(value)])
        )
        await call(`/gpu/${encodeURIComponent(d.gpu_uuid)}/partition`, {
          method: "POST",
          body: JSON.stringify({
            mode: d.mode,
            replicas:
              d.mode === "timeslice" || d.mode === "mps"
                ? Number(d.replicas || 2)
                : undefined,
            mig_profiles: d.mode === "mig" ? migProfiles : undefined,
          }),
        })
      }
      if (modal === "image")
        await call(`/images/${encodeURIComponent(d.id)}`, {
          method: "PUT",
          body: JSON.stringify({
            visibility: d.visibility,
            project: d.visibility === "project" ? d.shareWith : null,
            group: d.visibility === "group" ? d.shareWith : null,
          }),
        })
      if (modal === "group")
        await call(
          d._editing === "true"
            ? `/groups/${encodeURIComponent(d.name)}`
            : "/groups",
          {
            method: d._editing === "true" ? "PUT" : "POST",
            body: JSON.stringify({
              name: d.name,
              total_gpus: Number(d.total_gpus || 0),
              total_disk_gb: Number(d.total_disk_gb || 0),
              gpu_quota_by_type: quotaByModel,
              members,
            }),
          }
        )
      if (modal === "project")
        await call(
          d._editing === "true"
            ? `/projects/${encodeURIComponent(d.name)}`
            : "/projects",
          {
            method: d._editing === "true" ? "PUT" : "POST",
            body: JSON.stringify({
              name: d.name,
              owner: d.owner || undefined,
              total_gpus: Number(d.total_gpus || 0),
              shared_storage_gb: Number(d.shared_storage_gb || 0),
              gpu_quota_by_type: quotaByModel,
              members,
            }),
          }
        )
      if (modal === "storage")
        await call(
          `/teams/${encodeURIComponent(d.team)}/shared-storage?size_gb=${encodeURIComponent(d.size_gb || "50")}`,
          { method: "POST" }
        )
      if (modal === "user") {
        await call("/users", {
          method: "POST",
          body: JSON.stringify({
            username: d.username,
            password: d.password,
            role: d.role || "user",
            quota_cpu: d.quota_cpu || undefined,
            quota_memory: d.quota_memory || undefined,
            quota_gpu: Number(d.quota_gpu || 0),
            quota_vram_gb: Number(d.quota_vram_gb || 0),
          }),
        })
        // POST /users has no per-model limit fields, so apply them with the profile
        // update that does. Without this second call they were silently discarded.
        if (Object.keys(quotaByModel).length || Object.keys(vramByModel).length)
          await call(`/users/${encodeURIComponent(d.username)}`, {
            method: "PUT",
            body: JSON.stringify({
              gpu_quota_by_type: quotaByModel,
              vram_quota_by_type: vramByModel,
            }),
          })
      }
      if (modal === "edit-user")
        // PUT /users/{username} accepts the profile fields only: e-mail, Slack,
        // group membership, priority and the per-model GPU/VRAM limits.
        await call(`/users/${encodeURIComponent(d.username)}`, {
          method: "PUT",
          body: JSON.stringify({
            email: d.email || null,
            slack_id: d.slack_id || null,
            team: d.team || null,
            priority: Number(d.priority || 0),
            gpu_quota_by_type: quotaByModel,
            vram_quota_by_type: vramByModel,
          }),
        })
      if (modal === "cleanup")
        // PUT /settings/cleanup takes the four durations only; whether the reaper
        // runs at all comes from the backend's CLEANUP_ENABLED environment value.
        await call("/settings/cleanup", {
          method: "PUT",
          body: JSON.stringify({
            cleanup_interval_seconds:
              Number(d.cleanup_interval_value || 0) * 3600,
            standalone_task_ttl_seconds:
              Number(d.standalone_task_ttl_value || 0) * 3600,
            result_ttl_seconds: Number(d.result_ttl_value || 0) * 3600,
            results_helper_idle_ttl_seconds:
              Number(d.results_helper_idle_ttl_value || 0) * 3600,
          }),
        })
      say(
        "success",
        modal === "reservation"
          ? "Accelerator reserved"
          : modal === "renew-reservation"
            ? "Reservation extended"
            : modal === "partition"
              ? "Sharing configuration submitted"
              : modal === "storage"
                ? "Shared storage ready"
                : "Saved"
      )
      setModal(null)
      await refresh()
    } catch (e) {
      // Inline, not the corner toast: the modal stays open on failure and its
      // overlay paints over anything behind it.
      setModalError(readable(e))
    } finally {
      setPending(false)
    }
  }

  /**
   * Determine the color class for a calendar cell based on reservation status
   */
  function getReservationColor(
    events: ReservationEvent[],
    gpu: Gpu,
    hour: Date
  ): string {
    const hourStart = startOfDay(hour)
    const hourEnd = addDays(hourStart, 1)

    const conflicts = events.filter((event) => {
      const eventStart = parseServerDate(event.start)
      const eventEnd = parseServerDate(event.end)
      return (
        isBefore(eventStart, hourEnd) &&
        isAfter(eventEnd, hourStart) &&
        event.resourceId === gpu.uuid
      )
    })

    if (conflicts.length === 0) {
      return "bg-green-900/40 hover:bg-green-800/60 border-green-700/40"
    }
    if (
      conflicts.some(
        (e) => e.user === user?.username || e.title === user?.username
      )
    ) {
      return "bg-blue-900/40 hover:bg-blue-800/60 border-blue-700/40"
    }
    return "bg-red-900/40 hover:bg-red-800/60 border-red-700/40"
  }

  function CalendarGridView() {
    const daysToShow = 7
    const startDate = startOfDay(calendarDate)
    const days = eachDayOfInterval({
      start: startDate,
      end: addDays(startDate, daysToShow - 1),
    })

    // Group events by GPU for easy lookup
    const eventsByGpu: Record<string, ReservationEvent[]> = {}
    gpus.forEach((gpu) => {
      eventsByGpu[gpu.uuid] = calendar.filter((e) => e.resourceId === gpu.uuid)
    })

    return (
      <div className="mb-4 flex flex-col gap-4">
        {/* Navigation controls */}
        <div className="flex items-center justify-between gap-2">
          <button
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800"
            onClick={() => setCalendarDate(addDays(calendarDate, -7))}
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="text-center text-sm font-semibold">
            {format(startDate, "MMM d, yyyy")} — {format(addDays(startDate, 6), "MMM d, yyyy")}
          </div>
          <button
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800"
            onClick={() => setCalendarDate(addDays(calendarDate, 7))}
          >
            <ChevronRight className="size-4" />
          </button>
          <button
            className="ml-auto rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800"
            onClick={() => setCalendarDate(new Date())}
          >
            Today
          </button>
        </div>

        {/* Calendar grid */}
        <div className="overflow-x-auto">
          <div className="inline-block min-w-full">
            {/* Header row with day names */}
            <div className="mb-2 grid gap-1" style={{ gridTemplateColumns: `80px repeat(${daysToShow}, 1fr)` }}>
              <div className="font-mono text-[10px] font-semibold text-zinc-400">GPU</div>
              {days.map((day) => (
                <div
                  key={day.toISOString()}
                  className={cn(
                    "text-center text-xs font-semibold",
                    isToday(day) ? "text-blue-300" : "text-zinc-300"
                  )}
                >
                  {format(day, "EEE")}{" "}
                  <div className="text-[10px] text-zinc-400">{format(day, "MMM d")}</div>
                </div>
              ))}
            </div>

            {/* GPU rows */}
            {gpus.map((gpu) => (
              <div
                key={gpu.uuid}
                className="mb-3 grid gap-1 rounded border border-zinc-800 p-2"
                style={{ gridTemplateColumns: `80px repeat(${daysToShow}, 1fr)` }}
              >
                <div className="flex flex-col justify-center text-[10px]">
                  <span className="font-mono font-semibold text-zinc-200">
                    {gpu.product || "GPU"}
                  </span>
                  <span className="text-[8px] text-zinc-500">{gpu.uuid.slice(-8)}</span>
                </div>
                {days.map((day) => {
                  const events = eventsByGpu[gpu.uuid] || []
                  const dayStart = startOfDay(day)
                  const dayEnd = endOfDay(day)

                  const dayEvents = events.filter((e) => {
                    const eventStart = parseServerDate(e.start)
                    const eventEnd = parseServerDate(e.end)
                    return (
                      isBefore(eventStart, dayEnd) && isAfter(eventEnd, dayStart)
                    )
                  })

                  const isAvailable = dayEvents.length === 0
                  const hasUserEvent = dayEvents.some(
                    (e) => e.user === user?.username || e.title === user?.username
                  )

                  const colorClass = isAvailable
                    ? "bg-green-900/40 hover:bg-green-800/60 border-green-700/40"
                    : hasUserEvent
                      ? "bg-blue-900/40 hover:bg-blue-800/60 border-blue-700/40"
                      : "bg-red-900/40 hover:bg-red-800/60 border-red-700/40"

                  return (
                    <button
                      key={`${gpu.uuid}-${day.toISOString()}`}
                      className={cn(
                        "relative rounded border p-2 text-left text-[10px] transition-colors",
                        colorClass
                      )}
                      onClick={() => {
                        if (mutable(user)) {
                          openModal("reservation", {
                            gpu_uuid: gpu.uuid,
                            start: formatDateTimeLocal(dayStart),
                            end: formatDateTimeLocal(
                              addDays(dayStart, 1)
                            ),
                          })
                        }
                      }}
                      title={
                        dayEvents.length
                          ? `${dayEvents.length} reservation(s)`
                          : "Available - click to reserve"
                      }
                    >
                      <span className="line-clamp-2 text-[9px] leading-tight">
                        {dayEvents.length > 0
                          ? dayEvents
                              .map(
                                (e) =>
                                  e.user || e.title || "Reserved"
                              )
                              .join(", ")
                          : "Free"}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-[10px] text-zinc-400">
          <div className="flex items-center gap-1">
            <div className="size-3 rounded border border-green-700/40 bg-green-900/40" />
            Available
          </div>
          <div className="flex items-center gap-1">
            <div className="size-3 rounded border border-blue-700/40 bg-blue-900/40" />
            Your reservation
          </div>
          <div className="flex items-center gap-1">
            <div className="size-3 rounded border border-red-700/40 bg-red-900/40" />
            Reserved
          </div>
        </div>
      </div>
    )
  }

  function CapacityView() {
    const isAdmin = role(user) === "admin"
    const capabilityFor = (uuid: string) =>
      capabilities.find((item) => (item.gpu_uuid || item.uuid) === uuid)
    const partitionFor = (uuid: string) =>
      partitions.find((item) => item.gpu_uuid === uuid)
    /**
     * How many units THIS card publishes right now. Sharing is configured per card (the
     * device-plugin profile names device indices), so a divided sibling says nothing about
     * this one: a card with no sharing of its own reports 1 share — a whole card.
     */
    const sharesOf = (gpu: Gpu) =>
      gpu.shares ?? capabilityFor(gpu.uuid)?.shares ?? 1
    const strategyOf = (gpu: Gpu) =>
      gpu.sharing_strategy ?? capabilityFor(gpu.uuid)?.sharing_strategy ?? null
    const sharingSummary = (gpu: Gpu) => {
      // Sharing is per card, so only this card's own record and its own published share
      // count describe it. A sibling being divided says nothing about this one.
      const partition = partitionFor(gpu.uuid)
      const shares = sharesOf(gpu)
      const strategy = strategyOf(gpu)
      if (shares <= 1 && (!partition || partition.mode === "full"))
        return "Whole card — not divided"
      if (!partition && shares <= 1) return "Whole card — not divided"
      const label = partition
        ? PARTITION_MODES.find((item) => item.mode === partition.mode)?.label ||
          partition.mode
        : strategy === "mps"
          ? "Concurrent sharing"
          : "Time sharing"
      if (partition?.mode === "mig") {
        const slices = Object.entries(
          parseMaybeJson<Record<string, number>>(partition.mig_profiles, {})
        )
          .map(([profile, count]) => `${count}×${profile}`)
          .join(", ")
        return [
          label,
          slices,
          partition.applied ? "" : "requested, not applied yet",
        ]
          .filter(Boolean)
          .join(" · ")
      }
      // The share count is the number that matters: it is how many jobs may hold this
      // one card at the same time.
      const divided =
        shares > 1
          ? `divided into ${shares} shares`
          : "requested, not applied yet"
      return [label, divided].filter(Boolean).join(" · ")
    }
    // GET /gpu/list reports uuid/product/node/simulated. Card memory is only present
    // when a deployment adds it, so the column appears only when there is data for it.
    const showMemory = gpus.some(
      (gpu) =>
        gpu.memory_gb != null || capabilityFor(gpu.uuid)?.memory_gb != null
    )
    const memoryOf = (gpu: Gpu) =>
      gpu.memory_gb ?? capabilityFor(gpu.uuid)?.memory_gb
    const columns = 4 + (showMemory ? 1 : 0) + (isAdmin ? 1 : 0)
    return (
      <div className="grid content-start gap-5 p-4 sm:p-5">
        {gpus.some((gpu) => gpu.simulated || gpu.synthetic_e2e) && (
          <p
            role="note"
            className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100"
          >
            Some accelerators here are inventory-only: they exercise Kubernetes
            scheduling, but no CUDA or physical GPU computation occurs, and they
            cannot be reserved or used for workloads.
          </p>
        )}
        <Section title="GPU inventory">
          <p className="mb-3 text-xs text-zinc-400">
            Sharing shows how each accelerator is currently divided.{" "}
            {isAdmin
              ? "Use Configure sharing to change it; only modes the hardware reports are offered."
              : "Only administrators can change how a card is divided."}
          </p>
          <table>
            <thead>
              <tr>
                <th>GPU</th>
                <th>Node</th>
                {showMemory && <th>Memory</th>}
                <th>Sharing</th>
                <th>Status</th>
                {isAdmin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {gpus.map((g) => {
                const capability = capabilityFor(g.uuid)
                const modes = capability?.supported_modes || []
                const onNode = gpus.filter((item) => item.node === g.node)
                const position = onNode.findIndex(
                  (item) => item.uuid === g.uuid
                )
                const shares = sharesOf(g)
                return (
                  <tr key={g.uuid}>
                    {/* A node commonly holds several identical cards, so the row names
                        the specific one: its position on the node and its identifier.
                        That identifier is what Configure sharing, a reserved window and
                        a pinned job all refer to. */}
                    <td className="font-mono">
                      {g.product || "GPU"}
                      <span className="block text-[10px] text-zinc-300">
                        {onNode.length > 1
                          ? `card ${position + 1} of ${onNode.length} on ${g.node}`
                          : `the only card on ${g.node}`}
                      </span>
                      <span className="block text-[10px] text-zinc-400">
                        {g.uuid}
                      </span>
                    </td>
                    <td>{g.node || "—"}</td>
                    {showMemory && (
                      <td>{memoryOf(g) == null ? "—" : `${memoryOf(g)} GB`}</td>
                    )}
                    <td>
                      {sharingSummary(g)}
                      <span className="block text-[10px] text-zinc-400">
                        {shares > 1
                          ? `${shares} jobs may hold this card at once`
                          : capability?.mig_capable
                            ? "MIG capable"
                            : modes.length
                              ? "No MIG support"
                              : "Capabilities not reported"}
                      </span>
                    </td>
                    <td>
                      {g.simulated
                        ? "inventory only"
                        : g.synthetic_e2e
                          ? "synthetic E2E"
                          : "online"}
                    </td>
                    {isAdmin && (
                      <td>
                        <button
                          className="text-xs text-blue-300 disabled:text-zinc-500"
                          disabled={!modes.length}
                          title={
                            modes.length
                              ? undefined
                              : "This card reports no configurable sharing modes."
                          }
                          onClick={() =>
                            openModal("partition", {
                              gpu_uuid: g.uuid,
                              product: g.product || g.uuid,
                              node: g.node || "",
                              // An already-divided card must be rejoined before it can be
                              // divided differently, so only Full GPU is offered for it.
                              modes: (shares > 1 ? ["full"] : modes).join(","),
                              shares: String(shares),
                              cards_on_node: String(onNode.length),
                              mode:
                                shares > 1
                                  ? "full"
                                  : partitionFor(g.uuid)?.mode || modes[0],
                              // Only a time/concurrent sharing record says anything about
                              // a share count. Seeding from any record showed a number
                              // belonging to another mode (a MIG slice total, say) on a
                              // card nobody had divided; an undivided card has 1 share,
                              // and 1 share is not a division, so the field starts at the
                              // smallest real split.
                              replicas: String(
                                partitionFor(g.uuid)?.mode === "timeslice" ||
                                  partitionFor(g.uuid)?.mode === "mps"
                                  ? partitionFor(g.uuid)?.replicas || 2
                                  : 2
                              ),
                              ...Object.fromEntries(
                                Object.entries(
                                  parseMaybeJson<Record<string, number>>(
                                    partitionFor(g.uuid)?.mig_profiles,
                                    {}
                                  )
                                ).map(([profile, count]) => [
                                  `mig_${profile}`,
                                  String(count),
                                ])
                              ),
                            })
                          }
                        >
                          Configure sharing
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
              {!gpus.length && (
                <tr>
                  <td colSpan={columns} className="text-xs text-zinc-400">
                    No accelerators are reported by the cluster.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {capabilityNote && (
            <p className="mt-3 text-[11px] text-zinc-400">
              Hardware capability detection is unavailable, so sharing options
              are limited to what is already recorded: {capabilityNote}
            </p>
          )}
        </Section>
        <Section
          title={isAdmin ? "Reserved GPU windows" : "My reserved GPU windows"}
        >
          <p className="mb-3 text-xs text-zinc-400">
            {isAdmin
              ? "Every window is shown in your local timezone."
              : "Your windows are shown in your local timezone."}{" "}
            Scheduling a job creates a window automatically; reserve one
            directly when you want the accelerator held before the job exists.
          </p>
          <div className="mb-3 flex flex-wrap gap-2">
            {mutable(user) && (
              <>
                <button
                  className={button}
                  onClick={() => {
                    setDraft({ ...initialDraft(), timing: "schedule" })
                    setSheet(true)
                  }}
                >
                  Schedule a job
                </button>
                <button
                  className={button}
                  onClick={() =>
                    openModal("reservation", {
                      gpu_uuid: "",
                      start: formatDateTimeLocal(
                        new Date(Date.now() + 3_600_000)
                      ),
                      end: formatDateTimeLocal(
                        new Date(Date.now() + 3 * 3_600_000)
                      ),
                      priority: "0",
                      gpu_partition: "",
                    })
                  }
                >
                  <CalendarClock className="size-3" />
                  Reserve a GPU
                </button>
              </>
            )}
            <button
              className={button}
              onClick={() => void downloadReservationCalendar()}
            >
              <Download className="size-3" />
              Export .ics
            </button>
            <button
              className={button}
              onClick={() => void copySubscriptionUrl()}
            >
              Copy calendar subscription link
            </button>
            {mutable(user) && (
              <>
                <input
                  ref={icsInput}
                  aria-label="Calendar file to import"
                  className="sr-only"
                  type="file"
                  accept=".ics,text/calendar"
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0]
                    event.target.value = ""
                    if (selectedFile) void importCalendar(selectedFile)
                  }}
                />
                <button
                  className={button}
                  disabled={pending}
                  onClick={() => icsInput.current?.click()}
                >
                  <Upload className="size-3" />
                  Import .ics
                </button>
              </>
            )}
          </div>
          <div
            className="max-h-[360px] overflow-auto"
            tabIndex={0}
            role="region"
            aria-label="Scheduled GPU availability"
          >
            <table>
              <thead className="sticky top-0 bg-[#0c0c0f]">
                <tr>
                  <th>GPU</th>
                  {isAdmin && <th>Owner</th>}
                  <th>Start</th>
                  <th>End</th>
                  <th>Share</th>
                  <th>Status</th>
                  {mutable(user) && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {reservations.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono">{r.gpu_uuid}</td>
                    {isAdmin && <td>{r.user || r.username || "—"}</td>}
                    <td>{parseServerDate(r.start_time).toLocaleString()}</td>
                    <td>{parseServerDate(r.end_time).toLocaleString()}</td>
                    <td>
                      {r.gpu_partition
                        ? `${r.gpu_partition}${r.slice_index == null ? "" : ` #${r.slice_index}`}`
                        : "Whole card"}
                    </td>
                    <td>
                      <Pill status={r.status || "active"}>
                        {r.status || "active"}
                      </Pill>
                    </td>
                    {mutable(user) && (
                      <td>
                        {(r.status || "active") === "active" ? (
                          <span className="flex gap-2">
                            <button
                              className="text-xs text-blue-300"
                              onClick={() =>
                                openModal("renew-reservation", {
                                  id: String(r.id),
                                  gpu_uuid: r.gpu_uuid,
                                  current_end: r.end_time,
                                  end: formatDateTimeLocal(
                                    new Date(
                                      parseServerDate(r.end_time).getTime() +
                                        3_600_000
                                    )
                                  ),
                                })
                              }
                            >
                              Extend
                            </button>
                            <button
                              className="text-xs text-red-300"
                              onClick={() => void cancelReservation(r)}
                            >
                              Release
                            </button>
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-400">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!reservations.length && (
            <p className="text-xs text-zinc-400">
              No accelerator windows are reserved yet.
            </p>
          )}
        </Section>
        <Section title="Shared schedule">
          <p className="mb-3 text-xs text-zinc-400">
            Active windows held by everyone, so you can see what is taken before
            asking for a slot. Times are local.
          </p>
          {calendar.length ? (
            <div className="space-y-4">
              {/* View toggle */}
              <div className="flex gap-2">
                <button
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium transition-colors",
                    calendarViewMode === "grid"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  )}
                  onClick={() => setCalendarViewMode("grid")}
                >
                  Calendar View
                </button>
                <button
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium transition-colors",
                    calendarViewMode === "table"
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  )}
                  onClick={() => setCalendarViewMode("table")}
                >
                  Table View
                </button>
              </div>

              {/* Calendar Grid View */}
              {calendarViewMode === "grid" ? (
                <CalendarGridView />
              ) : (
                /* Table View (fallback) */
                <div
                  className="max-h-72 overflow-auto"
                  tabIndex={0}
                  role="region"
                  aria-label="Shared reservation schedule (table view)"
                >
                  <table>
                    <thead className="sticky top-0 bg-[#0c0c0f]">
                      <tr>
                        <th>Accelerator</th>
                        <th>Held by</th>
                        <th>From</th>
                        <th>Until</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...calendar]
                        .sort(
                          (a, b) => serverTime(a.start) - serverTime(b.start)
                        )
                        .map((event) => (
                          <tr key={event.id}>
                            <td className="font-mono">
                              {gpus.find((gpu) => gpu.uuid === event.resourceId)
                                ?.product || "GPU"}
                              <span className="block text-[10px] text-zinc-400">
                                {event.resourceId}
                              </span>
                            </td>
                            <td>
                              {event.user || event.title}
                              {event.user === user?.username && (
                                <span className="ml-1 text-[10px] text-blue-300">
                                  you
                                </span>
                              )}
                            </td>
                            <td>
                              {parseServerDate(event.start).toLocaleString()}
                            </td>
                            <td>
                              {parseServerDate(event.end).toLocaleString()}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-zinc-400">
              Nobody is holding an accelerator window right now.
            </p>
          )}
        </Section>
        {role(user) === "admin" &&
          partitions.some(
            (partition) =>
              !gpus.some((gpu) => gpu.uuid === partition.gpu_uuid) ||
              partition.applied === false
          ) && (
            <Section title="Sharing configuration to review">
              <p className="mb-3 text-xs text-zinc-400">
                Configurations the cluster has not applied yet, or that belong
                to a card no longer in the inventory.
              </p>
              {partitions
                .filter(
                  (partition) =>
                    !gpus.some((gpu) => gpu.uuid === partition.gpu_uuid) ||
                    partition.applied === false
                )
                .map((p) => {
                  const gone = !gpus.some((gpu) => gpu.uuid === p.gpu_uuid)
                  return (
                    <div
                      key={`${p.gpu_uuid}-${p.id}`}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 py-2 text-xs"
                    >
                      <span>
                        <b>{p.product || p.gpu_uuid}</b>
                        <span className="ml-1 font-mono text-[10px] text-zinc-400">
                          {p.gpu_uuid}
                        </span>
                        <span className="block text-zinc-400">
                          {PARTITION_MODES.find((mode) => mode.mode === p.mode)
                            ?.label || p.mode}{" "}
                          ·{" "}
                          {gone
                            ? "this card is not in the inventory any more, so the record no longer describes anything"
                            : p.applied
                              ? "applied"
                              : "requested, not applied yet"}
                          {p.applied_detail ? ` · ${p.applied_detail}` : ""}
                        </span>
                      </span>
                      {gone && (
                        <button
                          className="text-xs text-red-300"
                          onClick={() => {
                            if (
                              !confirm(
                                `Forget the sharing record for ${p.gpu_uuid}? Nothing on the cluster changes; only this stale record is removed.`
                              )
                            )
                              return
                            void call(
                              `/gpu/${encodeURIComponent(p.gpu_uuid)}/partition`,
                              { method: "DELETE" }
                            )
                              .then(() => {
                                say("success", "Sharing record forgotten")
                                return refresh()
                              })
                              .catch((e) =>
                                say(
                                  "error",
                                  `Could not forget the record: ${readable(e)}`
                                )
                              )
                          }}
                        >
                          Forget
                        </button>
                      )}
                    </div>
                  )
                })}
              <p className="mt-3 text-[11px] text-zinc-400">
                Every sharing mode applies to the single card it was set on. One
                node cannot mix time sharing with concurrent sharing, because
                the device plugin takes one mechanism per node. Dividing a card
                does not create extra cards — the inventory always lists the
                physical accelerators.
              </p>
            </Section>
          )}
        <Section title="Workspace storage">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <p className="text-xs text-zinc-400">
              Persistent volumes behind your workspaces. Usage figures appear
              when the cluster reports them.
            </p>
            {["admin", "poweruser"].includes(role(user)) && (
              <button
                className={button}
                onClick={() =>
                  openModal("storage", {
                    team: user?.team || "",
                    size_gb: "50",
                  })
                }
              >
                Create shared storage
              </button>
            )}
          </div>
          {disk.length ? (
            <table>
              <thead>
                <tr>
                  <th>Workspace</th>
                  <th>Volume</th>
                  <th>Size</th>
                  <th>Used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {disk.map((d, i) => (
                  <tr key={`${d.namespace || ""}-${d.pvc || d.name || i}`}>
                    <td className="capitalize">
                      {d.volume_type || d.type || "workspace"}
                    </td>
                    <td className="font-mono text-[11px]">
                      {d.pvc || d.name || "—"}
                      <span className="block text-zinc-400">
                        {d.namespace || ""}
                      </span>
                    </td>
                    <td>
                      {d.requested ||
                        d.requested_size ||
                        (d.requested_gb ? `${d.requested_gb}Gi` : null) ||
                        formatBytes(d.capacity_bytes)}
                    </td>
                    <td>
                      {d.used_bytes != null
                        ? `${formatBytes(d.used_bytes)}${d.usage_percent != null ? ` · ${d.usage_percent}%` : ""}`
                        : d.usage_percent != null
                          ? `${d.usage_percent}%`
                          : "Not reported"}
                    </td>
                    <td>{d.phase || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-zinc-400">
              No workspace volumes are reported for your account.
            </p>
          )}
        </Section>
      </div>
    )
  }
  function ProjectsView() {
    const canManageProjects = ["admin", "poweruser"].includes(role(user))
    const quotaMap = (record: GroupRecord | ProjectRecord) =>
      typeof record.gpu_quota_by_type === "string"
        ? parseMaybeJson<Record<string, number>>(record.gpu_quota_by_type, {})
        : record.gpu_quota_by_type || {}
    const quota = (record: GroupRecord | ProjectRecord) =>
      Object.entries(quotaMap(record))
        .map(([model, count]) => `${model}: ${count}`)
        .join(" · ")
    const quotaInputs = (record: GroupRecord | ProjectRecord) =>
      Object.fromEntries(
        Object.entries(quotaMap(record)).map(([model, count]) => [
          `gpuq_${model}`,
          String(count),
        ])
      )
    return (
      <div className="grid content-start gap-5 p-4 sm:p-5">
        <Section title="Groups">
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-xs text-zinc-400">
              Groups share accelerator and storage allocations across their
              members.
            </p>
            {role(user) === "admin" && (
              <button
                className={button}
                onClick={() =>
                  openModal("group", {
                    total_gpus: "1",
                    total_disk_gb: "100",
                    storage_unit: "Gi",
                    members: "",
                  })
                }
              >
                Create group
              </button>
            )}
          </div>
          <div
            className="max-h-80 overflow-y-auto"
            tabIndex={0}
            role="region"
            aria-label="Groups list"
          >
            {groups.length ? (
              groups.map((group) => (
                <div
                  key={group.name}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 py-2 text-sm"
                >
                  <div>
                    <b>{group.name}</b>
                    <p className="text-xs text-zinc-400">
                      Members:{" "}
                      {group.members?.join(", ") ||
                        "Not available until membership service is deployed"}{" "}
                      · {group.total_gpus || 0} accelerators ·{" "}
                      {group.total_disk_gb || 0} GiB shared
                    </p>
                    {quota(group) && (
                      <p className="text-[11px] text-zinc-400">
                        Per model: {quota(group)}
                      </p>
                    )}
                  </div>
                  <span className="flex gap-2">
                    {["admin", "poweruser"].includes(role(user)) && (
                      <button
                        className="text-xs text-blue-300"
                        onClick={() =>
                          openModal("storage", {
                            team: group.name,
                            size_gb: String(group.total_disk_gb || 50),
                          })
                        }
                      >
                        Shared storage
                      </button>
                    )}
                    {role(user) === "admin" && (
                      <>
                        <button
                          className="text-xs text-blue-300"
                          onClick={() =>
                            openModal("group", {
                              _editing: "true",
                              name: group.name,
                              total_gpus: String(group.total_gpus || 0),
                              total_disk_gb: String(group.total_disk_gb || 0),
                              storage_unit: "Gi",
                              members: (group.members || []).join(","),
                              ...quotaInputs(group),
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          className="text-xs text-red-300"
                          onClick={() => {
                            if (
                              !confirm(
                                `Delete group ${group.name}? Memberships are removed; historical jobs and storage are retained.`
                              )
                            )
                              return
                            void call(
                              `/groups/${encodeURIComponent(group.name)}`,
                              { method: "DELETE" }
                            )
                              .then(refresh)
                              .catch((e) =>
                                say(
                                  "error",
                                  `Could not delete group: ${readable(e)}`
                                )
                              )
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-xs text-zinc-400">
                No groups yet. An administrator can create one for a shared
                allocation.
              </p>
            )}
          </div>
        </Section>
        <Section title="Projects">
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-xs text-zinc-400">
              Project jobs use this project’s shared accelerator allocation and
              storage.
            </p>
            {canManageProjects && (
              <button
                className={button}
                onClick={() =>
                  openModal("project", {
                    owner: user?.username || "",
                    total_gpus: "1",
                    shared_storage_gb: "100",
                    storage_unit: "Gi",
                    members: "",
                  })
                }
              >
                Create project
              </button>
            )}
          </div>
          <div
            className="max-h-80 overflow-y-auto"
            tabIndex={0}
            role="region"
            aria-label="Projects list"
          >
            {projects.length ? (
              projects.map((project) => (
                <div
                  key={project.name}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 py-2 text-sm"
                >
                  <div>
                    <b>{project.name}</b>
                    <p className="text-xs text-zinc-400">
                      Owner: {project.owner || "—"} · Members:{" "}
                      {project.members?.join(", ") ||
                        "Not available until membership service is deployed"}{" "}
                      · {project.total_gpus || 0} accelerators ·{" "}
                      {project.shared_storage_gb || 0} GiB shared
                    </p>
                    {quota(project) && (
                      <p className="text-[11px] text-zinc-400">
                        Per model: {quota(project)}
                      </p>
                    )}
                  </div>
                  <span className="flex gap-2">
                    {mutable(user) && (
                      <button
                        className="text-xs text-blue-300"
                        onClick={() => {
                          setDraft({ ...initialDraft(), project: project.name })
                          setSheet(true)
                        }}
                      >
                        New job
                      </button>
                    )}
                    {canManageProjects && (
                      <>
                        <button
                          className="text-xs text-blue-300"
                          onClick={() =>
                            openModal("project", {
                              _editing: "true",
                              name: project.name,
                              owner: project.owner || "",
                              total_gpus: String(project.total_gpus || 0),
                              shared_storage_gb: String(
                                project.shared_storage_gb || 0
                              ),
                              storage_unit: "Gi",
                              members: (project.members || []).join(","),
                              ...quotaInputs(project),
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          className="text-xs text-red-300"
                          onClick={() => {
                            if (
                              !confirm(
                                `Delete project ${project.name}? Memberships are removed; historical jobs and storage are retained.`
                              )
                            )
                              return
                            void call(
                              `/projects/${encodeURIComponent(project.name)}`,
                              { method: "DELETE" }
                            )
                              .then(refresh)
                              .catch((e) =>
                                say(
                                  "error",
                                  `Could not delete project: ${readable(e)}`
                                )
                              )
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-xs text-zinc-400">
                No projects yet. Create a project to share an allocation and
                storage with members.
              </p>
            )}
          </div>
        </Section>
      </div>
    )
  }
  function UsageView() {
    const isAdmin = role(user) === "admin"
    const period =
      usageHours === "24"
        ? "Last 24 hours"
        : usageHours === "168"
          ? "Last 7 days"
          : "Last 30 days"
    // Only offer subjects the backend will actually answer for: it returns 403 for a
    // project you are not a member of, or any team but your own.
    const subjectOptions =
      usageGroup === "user"
        ? isAdmin
          ? users.map((account) => account.username)
          : [user?.username || ""]
        : usageGroup === "project"
          ? projects
              .filter(
                (project) =>
                  isAdmin ||
                  project.owner === user?.username ||
                  (project.members || []).includes(user?.username || "")
              )
              .map((project) => project.name)
          : usageGroup === "team"
            ? groups
                .filter((group) => isAdmin || group.name === user?.team)
                .map((group) => group.name)
            : []
    const results = analytics?.results || []
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
    const numbers = (
      pick: (item: AnalyticsResult) => number | null | undefined
    ) =>
      results
        .map(pick)
        .filter(
          (value): value is number => value != null && !Number.isNaN(value)
        )
    const energyValues = numbers((item) => item.energy_kwh)
    const co2Values = numbers((item) => item.co2_kg)
    const utilValues = numbers(utilizationOf)
    const reportedHours = numbers((item) => item.allocated_gpu_hours)
    const totals = {
      jobs: usageActivity.length || sum(numbers((item) => item.job_count)),
      gpuHours: usageActivity.length
        ? sum(
            usageActivity.map((activity) => activity.allocated_gpu_seconds || 0)
          ) / 3600
        : sum(reportedHours),
      energy: energyValues.length ? sum(energyValues) : null,
      co2: co2Values.length ? sum(co2Values) : null,
      utilization: utilValues.length
        ? sum(utilValues) / utilValues.length
        : null,
    }
    const exportUsageCsv = () =>
      downloadTextFile(
        `mlmanage-usage-${usageGroup}-${usageHours}h.csv`,
        toCsv([
          [
            "scope",
            "jobs",
            "allocated_gpu_hours",
            "avg_utilization_percent",
            "energy_kwh",
            "co2_kg",
            "efficiency_note",
          ],
          ...results.map((item) => [
            item.project || item.user || item.team || item.group || "workspace",
            item.job_count ?? "",
            item.allocated_gpu_hours == null
              ? ""
              : item.allocated_gpu_hours.toFixed(3),
            utilizationOf(item) ?? "",
            item.energy_kwh ?? "",
            item.co2_kg ?? "",
            item.efficiency_note || item.note || "",
          ]),
          [
            "total for this scope and period",
            totals.jobs,
            totals.gpuHours.toFixed(3),
            totals.utilization == null ? "" : totals.utilization.toFixed(1),
            totals.energy ?? "",
            totals.co2 ?? "",
            "",
          ],
        ]),
        "text/csv;charset=utf-8"
      )
    return (
      <div className="grid content-start gap-5 p-4 sm:p-5">
        <Section title="Usage">
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-xs">
              Scope
              <select
                aria-label="Usage scope"
                className={input}
                value={usageGroup}
                onChange={(e) => {
                  setUsageGroup(e.target.value)
                  setUsageUser("")
                }}
              >
                <option value="mine">My usage</option>
                {isAdmin ? (
                  <>
                    <option value="user">All users</option>
                    <option value="project">Projects</option>
                    <option value="team">Groups</option>
                  </>
                ) : (
                  <>
                    <option value="project">My projects</option>
                    <option value="team">My groups</option>
                  </>
                )}
              </select>
            </label>
            {usageGroup !== "mine" && (
              <label className="grid gap-1 text-xs">
                {usageGroup === "user"
                  ? "User"
                  : usageGroup === "project"
                    ? "Project"
                    : "Group"}
                <select
                  aria-label="Usage subject"
                  className={input}
                  value={usageUser}
                  onChange={(e) => setUsageUser(e.target.value)}
                >
                  <option value="">All available</option>
                  {subjectOptions.map((subject) => (
                    <option key={subject} value={subject}>
                      {subject}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="grid gap-1 text-xs">
              Period
              <select
                aria-label="Usage period"
                className={input}
                value={usageHours}
                onChange={(e) => setUsageHours(e.target.value)}
              >
                <option value="24">Last 24 hours</option>
                <option value="168">Last 7 days</option>
                <option value="720">Last 30 days</option>
              </select>
            </label>
            <button
              className={button}
              disabled={usageLoading}
              onClick={() => setUsageRefresh((value) => value + 1)}
            >
              <RefreshCw
                className={cn("size-3", usageLoading && "animate-spin")}
              />
              Refresh usage
            </button>
          </div>
          <p className="mb-3 text-xs text-zinc-400">
            {period}. Accelerator time comes from real Job lifecycle timestamps.
            Hardware utilization, energy and carbon footprint appear only when
            monitoring is configured.
            {!isAdmin && " Only activity available to your account is shown."}
          </p>
          <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              icon={Activity}
              label="Jobs with GPU time"
              value={usageLoading ? "…" : String(totals.jobs)}
              detail={
                usageLoading
                  ? "Loading…"
                  : `${gpuTime(totals.gpuHours)} allocated`
              }
            />
            <Tile
              icon={Zap}
              label="Energy used"
              value={
                usageLoading
                  ? "…"
                  : formatEnergy(totals.energy) || "Not monitored"
              }
              detail={
                usageLoading
                  ? "Loading…"
                  : totals.energy == null
                    ? "Needs GPU power monitoring"
                    : "Measured from GPU power samples"
              }
            />
            <Tile
              icon={Leaf}
              label="Carbon footprint"
              value={
                usageLoading ? "…" : formatCo2(totals.co2) || "Not monitored"
              }
              detail={
                usageLoading
                  ? "Loading…"
                  : totals.co2 == null
                    ? "Derived from energy once monitored"
                    : co2Comparison(totals.co2) || "Almost nothing"
              }
            />
            <Tile
              icon={Server}
              label="Average utilization"
              value={
                usageLoading
                  ? "…"
                  : totals.utilization == null
                    ? "Not monitored"
                    : `${totals.utilization.toFixed(1)}%`
              }
              detail={
                usageLoading
                  ? "Loading…"
                  : totals.utilization == null
                    ? "Needs GPU monitoring"
                    : totals.utilization < 30
                      ? "Low — consider a smaller allocation"
                      : "Healthy use of the reserved hardware"
              }
            />
          </div>
          {analytics?.results?.length ? (
            <>
              <div className="max-h-80 overflow-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>Jobs</th>
                      <th>Allocated GPU time</th>
                      <th>Hardware utilization</th>
                      <th>Energy</th>
                      <th>Carbon footprint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.results.map((item, index) => {
                      const util = utilizationOf(item)
                      return (
                        <tr key={index}>
                          <td>
                            {item.project ||
                              item.user ||
                              item.team ||
                              item.group ||
                              "Workspace"}
                          </td>
                          <td>{item.job_count ?? "—"}</td>
                          <td>
                            {item.allocated_gpu_hours == null
                              ? "—"
                              : gpuTime(item.allocated_gpu_hours)}
                          </td>
                          <td>
                            {util == null ? (
                              "Not monitored"
                            ) : (
                              <>
                                {util}%
                                {(item.efficiency_note || util < 30) && (
                                  <span className="block text-[10px] text-amber-300">
                                    {item.efficiency_note === "ok"
                                      ? ""
                                      : item.efficiency_note ||
                                        "low utilization"}
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <td>
                            {formatEnergy(item.energy_kwh) || "Not monitored"}
                          </td>
                          <td>{formatCo2(item.co2_kg) || "Not monitored"}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button className={button} onClick={exportUsageCsv}>
                  <Download className="size-3" />
                  Download this report (CSV)
                </button>
                <p className="text-[11px] text-zinc-400">
                  Carbon footprint = energy × {CO2_KG_PER_KWH} kg CO₂ per kWh,
                  the grid intensity configured on the backend. A dash means
                  this backend reports the figure per workspace only — see the
                  cards above.
                </p>
              </div>
            </>
          ) : (
            <p className="text-xs text-zinc-400">
              {usageLoading
                ? "Loading usage…"
                : "No GPU Jobs were active for this scope and period."}
            </p>
          )}
        </Section>
        <Section title="GPU activity">
          <p className="mb-3 max-w-2xl text-xs text-zinc-400">
            Jobs that held GPU allocations during {period.toLowerCase()}. This
            activity is derived from real workload start and finish times and
            loads automatically.
          </p>
          {usageActivity.length ? (
            <div className="max-h-80 overflow-auto">
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Job</th>
                    <th className="hidden sm:table-cell">Owner</th>
                    <th>GPUs</th>
                    <th>Duration</th>
                    <th className="hidden sm:table-cell">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {usageActivity.map((activity) => (
                    <tr key={`${activity.job_id}-${activity.scope}`}>
                      <td>
                        {parseServerDate(activity.started_at).toLocaleString()}
                      </td>
                      <td>{activity.job_name}</td>
                      <td className="hidden sm:table-cell">{activity.user}</td>
                      <td>{activity.gpu_count}</td>
                      <td>{elapsed(activity.duration_seconds)}</td>
                      <td className="hidden sm:table-cell">
                        {activity.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-zinc-400">
              {usageLoading
                ? "Loading GPU activity…"
                : "No GPU Jobs were active for this scope and period."}
            </p>
          )}
          <div className="mt-4 border-t border-zinc-800 pt-4">
            <h3 className="text-xs font-semibold text-zinc-200">
              Hardware telemetry
            </h3>
            {usagePoints.length ? (
              <div className="mt-2 max-h-80 overflow-auto">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Accelerator</th>
                      <th>Utilization</th>
                      <th>Memory used</th>
                      <th>Temperature</th>
                      <th>Power draw</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usagePoints.slice(-50).map((point) => (
                      <tr key={`${point.timestamp}-${point.gpu_uuid || ""}`}>
                        <td>
                          {parseServerDate(point.timestamp).toLocaleString()}
                        </td>
                        <td className="font-mono text-[11px]">
                          {gpus.find((gpu) => gpu.uuid === point.gpu_uuid)
                            ?.product ||
                            point.gpu_uuid ||
                            "—"}
                        </td>
                        <td>{point.utilization}%</td>
                        <td>
                          {point.memory ?? point.memory_used ?? "—"}
                          {(point.memory ?? point.memory_used) ? " MiB" : ""}
                        </td>
                        <td>
                          {point.temperature == null
                            ? "—"
                            : `${point.temperature} °C`}
                        </td>
                        <td>
                          {point.power == null ? "—" : `${point.power} W`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-xs text-zinc-400">
                No monitored hardware samples are available. Allocation time is
                shown above without inventing utilization, temperature, or power
                values
                {gpus.some((gpu) => gpu.synthetic_e2e)
                  ? " for synthetic GPUs"
                  : ""}
                .
              </p>
            )}
          </div>
        </Section>
      </div>
    )
  }
  function AccountView() {
    if (!user) return null
    const perModelGpu = parseMaybeJson<Record<string, number>>(
      user.gpu_quota_by_type,
      {}
    )
    const perModelVram = parseMaybeJson<Record<string, number>>(
      user.vram_quota_by_type,
      {}
    )
    const myProjects = projects.filter(
      (project) =>
        project.owner === user.username ||
        (project.members || []).includes(user.username)
    )
    // Admins receive every reservation from the API, so match on the owner here.
    const mine = (item: ReservationRecord) =>
      item.user || item.username
        ? item.user === user.username || item.username === user.username
        : true
    const myReservations = reservations.filter(
      (item) => (item.status || "active") === "active" && mine(item)
    )
    const rows: Array<[string, React.ReactNode]> = [
      ["Username", user.username],
      [
        "Role",
        role(user) === "readonly"
          ? "Read only — you can inspect everything you are allowed to see, but not change it"
          : role(user) === "admin"
            ? "Administrator"
            : role(user) === "poweruser"
              ? "Power user — can also create projects and shared storage"
              : "User",
      ],
      ["Email", user.email || "Not set"],
      ["Slack", user.slack_id || "Not set"],
      ["Group", user.team || "No group"],
      [
        "Scheduling priority",
        `${user.priority ?? 0} — higher priority work starts first`,
      ],
    ]
    return (
      <div className="grid content-start gap-5 p-4 sm:p-5">
        <Section title="Profile">
          <p className="mb-3 text-xs text-zinc-400">
            An administrator maintains these details. Email and Slack are used
            for reservation and job notifications when they are configured.
          </p>
          <dl className="grid gap-2 text-xs">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-zinc-400">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </Section>
        <Section title="My allocation">
          <p className="mb-3 text-xs text-zinc-400">
            The most a single job of yours may request. Project and group jobs
            draw on the shared allocation instead.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              icon={Server}
              label="Accelerators"
              value={String(user.quota_gpu ?? 0)}
              detail="Per job, unless a project allocation applies"
            />
            <Tile
              icon={Server}
              label="GPU memory"
              value={`${user.quota_vram_gb ?? 0} GB`}
              detail="Upper bound for the VRAM limit you can set"
            />
            <Tile
              icon={Activity}
              label="CPU cores"
              value={String(user.quota_cpu ?? "—")}
            />
            <Tile
              icon={Activity}
              label="Memory"
              value={String(user.quota_memory ?? "—")}
            />
          </div>
          {(Object.keys(perModelGpu).length > 0 ||
            Object.keys(perModelVram).length > 0) && (
            <div className="mt-3">
              <h3 className="text-xs font-semibold">Limits by accelerator</h3>
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Accelerators</th>
                    <th>GPU memory</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ...new Set([
                      ...Object.keys(perModelGpu),
                      ...Object.keys(perModelVram),
                    ]),
                  ].map((model) => (
                    <tr key={model}>
                      <td className="font-mono">{model}</td>
                      <td>{perModelGpu[model] ?? "No specific limit"}</td>
                      <td>
                        {perModelVram[model] != null
                          ? `${perModelVram[model]} GB`
                          : "No specific limit"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
        <Section title="My workspaces">
          <p className="mb-3 text-xs text-zinc-400">
            Persistent space attached to your account. Live usage is in Capacity
            → Workspace storage.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            <Tile
              icon={FolderKanban}
              label="Home"
              value={`${user.disk_home_gb ?? 0} GiB`}
              detail="Kept between jobs"
            />
            <Tile
              icon={FolderKanban}
              label="Scratch"
              value={`${user.disk_scratch_gb ?? 0} GiB`}
              detail="Fast working space, cleaned up periodically"
            />
            <Tile
              icon={FolderKanban}
              label="Project"
              value={`${user.disk_project_gb ?? 0} GiB`}
              detail="Shared project data"
            />
          </div>
        </Section>
        <Section title="Storage usage">
          <div className="flex items-start justify-between gap-3 mb-3">
            <p className="text-xs text-zinc-400">
              Real-time disk space utilization across your workspaces. Auto-refreshes every 15 seconds.
            </p>
            <button
              className={cn(button, "text-[10px]")}
              onClick={() => setDiskRefresh(d => d + 1)}
              aria-label="Refresh disk usage"
            >
              <RefreshCw className="size-3" />
            </button>
          </div>
          {disk && disk.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {disk
                .filter(
                  (d) =>
                    (d.volume_type || d.type) &&
                    d.capacity_bytes != null &&
                    d.used_bytes != null
                )
                .map((record) => {
                  const volumeType = record.volume_type || record.type || "unknown"
                  const typeLabel =
                    volumeType === "home"
                      ? "Home (/home)"
                      : volumeType === "scratch"
                        ? "Scratch (/scratch)"
                        : volumeType === "project"
                          ? "Project (/project)"
                          : volumeType.charAt(0).toUpperCase() + volumeType.slice(1)
                  return (
                    <DiskUsageProgressBar
                      key={`${volumeType}-${record.namespace}-${record.pvc || record.name}`}
                      record={record}
                      label={typeLabel}
                    />
                  )
                })}
            </div>
          ) : (
            <p className="text-xs text-zinc-400">
              No storage usage data available. Check back in a moment.
            </p>
          )}
        </Section>
        <Section title="My access">
          <p className="text-xs text-zinc-400">
            Projects you can submit against, and the accelerator windows you are
            holding right now.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <h3 className="text-xs font-semibold">Projects</h3>
              {myProjects.length ? (
                <ul className="mt-1 grid gap-1 text-xs text-zinc-300">
                  {myProjects.map((project) => (
                    <li key={project.name}>
                      {project.name}
                      <span className="text-zinc-400">
                        {project.owner === user.username ? " · you own it" : ""}{" "}
                        · {project.total_gpus || 0} accelerators shared
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-zinc-400">
                  You are not a member of any project yet.
                </p>
              )}
            </div>
            <div>
              <h3 className="text-xs font-semibold">Active GPU windows</h3>
              {myReservations.length ? (
                <ul className="mt-1 grid gap-1 text-xs text-zinc-300">
                  {myReservations.slice(0, 8).map((item) => (
                    <li key={item.id}>
                      {parseServerDate(item.start_time).toLocaleString()} –{" "}
                      {parseServerDate(item.end_time).toLocaleTimeString()}
                      <span className="block text-zinc-400">
                        {item.gpu_uuid}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-zinc-400">
                  You are not holding any accelerator window.
                </p>
              )}
            </div>
          </div>
        </Section>
        <RemindersSection reservations={myReservations} userPrefs={userPreferences} />
      </div>
    )
  }
  function RemindersSection({ reservations: myReservations, userPrefs: userPreferences }: { reservations: ReservationRecord[]; userPrefs: { reminder_lead_time_minutes: number } | null }) {
    const now = new Date()
    const leadTimeMinutes = userPreferences?.reminder_lead_time_minutes || 5
    const upcomingWithReminders = myReservations
      .filter((r) => parseServerDate(r.start_time) > now)
      .sort((a, b) => parseServerDate(a.start_time).getTime() - parseServerDate(b.start_time).getTime())

    const getReminderStatus = (reservation: ReservationRecord) => {
      const start = parseServerDate(reservation.start_time)
      const end = parseServerDate(reservation.end_time)
      const timeUntilStart = (start.getTime() - now.getTime()) / 1000 / 60
      const timeUntilEnd = (end.getTime() - now.getTime()) / 1000 / 60
      const status: Array<{ type: "start" | "end"; sent: boolean; minutesRemaining: number }> = []

      if (timeUntilStart > 0 && timeUntilStart <= leadTimeMinutes) {
        status.push({
          type: "start",
          sent: reservation.notified_start || false,
          minutesRemaining: Math.ceil(timeUntilStart)
        })
      }
      if (timeUntilEnd > 0 && timeUntilEnd <= leadTimeMinutes) {
        status.push({
          type: "end",
          sent: reservation.notified_end || false,
          minutesRemaining: Math.ceil(timeUntilEnd)
        })
      }

      return status
    }

    const manuallyTriggerReminder = async (reservation: ReservationRecord, type: "start" | "end") => {
      try {
        await call(`/reservations/${reservation.id}/send-reminder?type=${type}`, {
          method: "POST",
        })
        say("success", `Reminder manually triggered for GPU ${reservation.gpu_uuid}`)
        await refresh()
      } catch (e) {
        say("error", `Could not send reminder: ${readable(e)}`)
      }
    }

    const updateLeadTime = async (minutes: number) => {
      try {
        const params = new URLSearchParams({ reminder_lead_time_minutes: String(minutes) })
        await call(`/user-preferences?${params}`, {
          method: "POST",
        })
        say("success", `Reminder lead time updated to ${minutes} minutes`)
        await refresh()
      } catch (e) {
        say("error", `Could not update reminder settings: ${readable(e)}`)
      }
    }

    return (
      <Section title="Reservation reminders">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-zinc-400">
              Automatic reminders notify you via email or Slack when your GPU
              reservations are starting or ending soon. You can manually
              trigger a reminder at any time.
            </p>
            <p className="mt-2 text-[11px] text-zinc-500">
              Lead time: <span className="text-zinc-400">{leadTimeMinutes} minutes</span>
            </p>
          </div>
          {mutable(user) && (
            <div className="flex flex-wrap gap-1">
              {[5, 10, 15, 30].map((mins) => (
                <button
                  key={`lead-${mins}`}
                  className={cn(
                    "rounded-md px-2 py-1 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                    leadTimeMinutes === mins
                      ? "border border-blue-600 bg-blue-600/20 text-blue-300"
                      : "border border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-800"
                  )}
                  onClick={() => void updateLeadTime(mins)}
                >
                  {mins}m
                </button>
              ))}
            </div>
          )}
        </div>
        {upcomingWithReminders.length > 0 ? (
          <div className="grid gap-3">
            {upcomingWithReminders.map((reservation) => {
              const reminders = getReminderStatus(reservation)
              const start = parseServerDate(reservation.start_time)
              const end = parseServerDate(reservation.end_time)
              const isRunning = now >= start && now < end

              return (
                <div
                  key={reservation.id}
                  className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs font-semibold text-blue-300">
                        {reservation.gpu_uuid}
                      </p>
                      <p className="mt-1 text-xs text-zinc-300">
                        {isRunning ? (
                          <>
                            <span className="text-emerald-300">● Running</span>
                            {" · "}
                            Ends {end.toLocaleTimeString()}
                          </>
                        ) : (
                          <>
                            Starts {start.toLocaleString()}
                            {" · "}
                            Ends {end.toLocaleTimeString()}
                          </>
                        )}
                      </p>
                      {reminders.length > 0 && (
                        <div className="mt-2 grid gap-1">
                          {reminders.map((reminder, idx) => (
                            <div
                              key={`${reservation.id}-${reminder.type}-${idx}`}
                              className="flex items-center gap-2 text-[11px] text-zinc-400"
                            >
                              <span
                                className={cn(
                                  "inline-block size-1.5 rounded-full",
                                  reminder.sent
                                    ? "bg-emerald-500"
                                    : "bg-amber-500"
                                )}
                                aria-hidden="true"
                              />
                              {reminder.sent ? (
                                <>
                                  Reminder sent about{" "}
                                  <span className="font-semibold text-zinc-300">
                                    {reminder.type === "start"
                                      ? "reservation start"
                                      : "reservation end"}
                                  </span>
                                </>
                              ) : (
                                <>
                                  Will remind in about{" "}
                                  <span className="font-semibold text-amber-300">
                                    {reminder.minutesRemaining} minute
                                    {reminder.minutesRemaining !== 1 ? "s" : ""}
                                  </span>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      {reminders.length === 0 && (
                        <p className="mt-2 text-[11px] text-zinc-500">
                          Reminders trigger within {leadTimeMinutes} minutes of start/end
                        </p>
                      )}
                    </div>
                    {mutable(user) && reminders.length > 0 && (
                      <div className="flex flex-col gap-1">
                        {reminders.map((reminder) => (
                          <button
                            key={`trigger-${reservation.id}-${reminder.type}`}
                            className={cn(
                              "whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                              reminder.sent
                                ? "border border-zinc-700 text-zinc-400"
                                : "border border-blue-600 bg-blue-600/20 text-blue-300 hover:bg-blue-600/30"
                            )}
                            onClick={() =>
                              void manuallyTriggerReminder(
                                reservation,
                                reminder.type
                              )
                            }
                            disabled={reminder.sent}
                          >
                            {reminder.sent ? "Sent" : "Send now"}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-zinc-400">
            No upcoming reservations within the next {leadTimeMinutes} minutes. Reminders will
            appear here as your GPU windows approach.
          </p>
        )}
      </Section>
    )
  }
  function AdminView() {
    return (
      <div className="grid content-start gap-5 p-4 sm:p-5">
        <Section title="Accounts">
          <div className="mb-3 flex items-start justify-between gap-3">
            <p className="text-xs text-zinc-400">
              Create accounts and set their default compute allocation. Project
              and group allocations are shared separately.
            </p>
            <button
              className={button}
              onClick={() =>
                openModal("user", {
                  role: "user",
                  quota_cpu: "2",
                  quota_memory: "4Gi",
                  quota_gpu: "1",
                  quota_vram_gb: "4",
                })
              }
            >
              Create account
            </button>
          </div>
          <div
            className="max-h-[520px] overflow-y-auto"
            tabIndex={0}
            role="region"
            aria-label="Users list"
          >
            {users.map((account) => (
              <div
                key={account.username}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 py-2 text-sm"
              >
                <div>
                  <b>{account.username}</b>
                  <span className="ml-2 text-xs text-zinc-400">
                    {account.role} · {account.quota_gpu ?? 0} accelerators ·{" "}
                    {account.quota_vram_gb ?? 0} GB GPU memory
                    {account.team ? ` · group ${account.team}` : ""}
                    {account.priority ? ` · priority ${account.priority}` : ""}
                  </span>
                </div>
                <span className="flex gap-2">
                  <button
                    className="text-xs text-blue-300"
                    onClick={() =>
                      openModal("edit-user", {
                        username: account.username,
                        role: account.role || "user",
                        email: account.email || "",
                        slack_id: account.slack_id || "",
                        team: account.team || "",
                        priority: String(account.priority ?? 0),
                        quota_cpu: account.quota_cpu || "2",
                        quota_memory: account.quota_memory || "4Gi",
                        quota_gpu: String(account.quota_gpu || 0),
                        quota_vram_gb: String(account.quota_vram_gb || 0),
                        ...quotaEntries("gpuq_", account.gpu_quota_by_type),
                        ...quotaEntries("vramq_", account.vram_quota_by_type),
                      })
                    }
                  >
                    Edit
                  </button>
                  {account.username !== user?.username && (
                    <button
                      className="text-xs text-red-300"
                      onClick={() => {
                        if (
                          confirm(
                            `Delete ${account.username}? Their account is removed; existing job records are retained for audit.`
                          )
                        )
                          void call(
                            `/users/${encodeURIComponent(account.username)}`,
                            { method: "DELETE" }
                          )
                            .then(refresh)
                            .catch((e) =>
                              say(
                                "error",
                                `Could not delete account: ${readable(e)}`
                              )
                            )
                      }}
                    >
                      Delete
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Section>
        <Section title="Data retention">
          {cleanup ? (
            <>
              <p className="mb-3 text-xs text-zinc-400">
                Controls how long completed tasks, result files, and idle result
                helpers are retained. Existing values are shown below; deleting
                data cannot be undone.
              </p>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-1 text-xs text-zinc-300">
                <dt>Policy</dt>
                <dd>{cleanup.enabled ? "Enabled" : "Disabled"}</dd>
                <dt>Completed task records</dt>
                <dd>{cleanup.standalone_task_ttl_seconds / 3600} hours</dd>
                <dt>Result files</dt>
                <dd>{cleanup.result_ttl_seconds / 3600} hours</dd>
                <dt>Idle result helpers</dt>
                <dd>{cleanup.results_helper_idle_ttl_seconds / 3600} hours</dd>
              </dl>
              <button
                className={cn(button, "mt-3")}
                onClick={() =>
                  openModal("cleanup", {
                    enabled: String(cleanup.enabled),
                    cleanup_interval_value: String(
                      cleanup.cleanup_interval_seconds / 3600
                    ),
                    cleanup_interval_unit: "hours",
                    standalone_task_ttl_value: String(
                      cleanup.standalone_task_ttl_seconds / 3600
                    ),
                    standalone_task_ttl_unit: "hours",
                    result_ttl_value: String(cleanup.result_ttl_seconds / 3600),
                    result_ttl_unit: "hours",
                    results_helper_idle_ttl_value: String(
                      cleanup.results_helper_idle_ttl_seconds / 3600
                    ),
                    results_helper_idle_ttl_unit: "hours",
                  })
                }
              >
                Edit retention policy
              </button>
            </>
          ) : (
            <p className="text-xs text-zinc-400">
              Data retention settings are unavailable.
            </p>
          )}
        </Section>
        {AuditSection()}
      </div>
    )
  }
  function AuditSection() {
    const entries = audit?.entries || []
    const total = audit?.total || 0
    const from = total === 0 ? 0 : auditPage * AUDIT_PAGE_SIZE + 1
    const to = auditPage * AUDIT_PAGE_SIZE + entries.length
    // Any filter change puts you on a page that may not exist in the new result set.
    const onFilter = (apply: () => void) => {
      setAuditPage(0)
      apply()
    }
    const exportCsv = () =>
      downloadTextFile(
        `mlmanage-activity-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv([
          [
            "When",
            "Who",
            "Role",
            "Action",
            "Target",
            "Result",
            "Status",
            "Method",
            "Path",
            "Address",
            "Details",
          ],
          ...entries.map((entry) => [
            parseServerDate(entry.at).toISOString(),
            entry.actor,
            entry.actor_role || "",
            entry.action,
            entry.target || "",
            AUDIT_OUTCOMES[entry.outcome]?.label || entry.outcome,
            entry.status_code,
            entry.method,
            entry.path,
            entry.client_ip || "",
            auditDetail(entry),
          ]),
        ]),
        "text/csv;charset=utf-8"
      )
    return (
      <Section title="Activity log">
        <p className="mb-3 max-w-3xl text-xs text-zinc-400">
          Everything people did through this console: accounts and allocations
          changed, jobs submitted and cancelled, accelerator sharing
          reconfigured, and every sign-in attempt including the ones that
          failed. Records are kept for{" "}
          {audit?.retention_seconds
            ? `${Math.round(audit.retention_seconds / 86400)} days`
            : "as long as configured on the backend"}
          , and only administrators can read them.
          {audit && !audit.includes_reads
            ? " Viewing data is not recorded — only actions that changed something."
            : ""}
        </p>
        {audit && !audit.enabled && (
          <p className="mb-3 rounded-md border border-amber-900 bg-amber-950/40 p-2 text-xs text-amber-200">
            Recording is switched off on the backend (AUDIT_ENABLED), so this
            list stays empty no matter what happens. Nothing is being recorded
            right now.
          </p>
        )}
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs">
            Period
            <select
              className={cn(input, "w-40")}
              value={auditHours}
              onChange={(event) =>
                onFilter(() => setAuditHours(event.target.value))
              }
            >
              <option value="24">Last 24 hours</option>
              <option value="168">Last 7 days</option>
              <option value="720">Last 30 days</option>
              <option value="2160">Last 90 days</option>
              <option value="8784">Last year</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Who
            <select
              className={cn(input, "w-44")}
              value={auditActor}
              onChange={(event) =>
                onFilter(() => setAuditActor(event.target.value))
              }
            >
              <option value="">Everyone</option>
              {(audit?.actors || []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Action
            <select
              className={cn(input, "w-52")}
              value={auditAction}
              onChange={(event) =>
                onFilter(() => setAuditAction(event.target.value))
              }
            >
              <option value="">All actions</option>
              {(audit?.actions || []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Result
            <select
              className={cn(input, "w-40")}
              value={auditOutcome}
              onChange={(event) =>
                onFilter(() => setAuditOutcome(event.target.value))
              }
            >
              <option value="">Any result</option>
              {Object.entries(AUDIT_OUTCOMES).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs">
            Search
            <input
              className={cn(input, "w-56")}
              value={auditSearch}
              placeholder="Person, object, path…"
              onChange={(event) =>
                onFilter(() => setAuditSearch(event.target.value))
              }
            />
          </label>
          <button
            className={button}
            onClick={() => setAuditRefresh((value) => value + 1)}
            disabled={auditLoading}
          >
            <RefreshCw className="size-3" />
            Refresh
          </button>
        </div>
        {entries.length ? (
          <>
            <div className="max-h-[520px] overflow-auto">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Result</th>
                    <th className="hidden lg:table-cell">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const outcome = AUDIT_OUTCOMES[entry.outcome]
                    const details = auditDetail(entry)
                    return (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap">
                          {parseServerDate(entry.at).toLocaleString()}
                        </td>
                        <td>
                          {entry.actor}
                          {entry.actor_role ? (
                            <span className="ml-1 text-[10px] text-zinc-400">
                              {entry.actor_role}
                            </span>
                          ) : null}
                        </td>
                        <td className="font-mono text-[11px]">
                          {entry.action}
                        </td>
                        <td
                          className="max-w-[16rem] truncate"
                          title={entry.path}
                        >
                          {entry.target || "—"}
                        </td>
                        <td
                          className={cn(
                            "whitespace-nowrap",
                            outcome?.className
                          )}
                        >
                          {outcome?.label || entry.outcome}
                          <span className="ml-1 text-[10px] text-zinc-400">
                            {entry.status_code}
                          </span>
                        </td>
                        <td
                          className="hidden max-w-[28rem] truncate lg:table-cell"
                          title={details}
                        >
                          {details || "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-[11px] text-zinc-400">
                Showing {from}–{to} of {total}
              </p>
              <button
                className={button}
                disabled={auditPage === 0 || auditLoading}
                onClick={() => setAuditPage((page) => Math.max(0, page - 1))}
              >
                Previous
              </button>
              <button
                className={button}
                disabled={to >= total || auditLoading}
                onClick={() => setAuditPage((page) => page + 1)}
              >
                Next
              </button>
              <button className={button} onClick={exportCsv}>
                <Download className="size-3" />
                Download this page (CSV)
              </button>
            </div>
          </>
        ) : (
          <p className="text-xs text-zinc-400">
            {auditLoading
              ? "Loading the activity log…"
              : "Nothing was recorded for this period and these filters."}
          </p>
        )}
      </Section>
    )
  }
  function ActionModal() {
    if (!modal) return null
    const labels: Record<NonNullable<typeof modal>, string> = {
      reservation: "Reserve an accelerator",
      "renew-reservation": "Extend reservation",
      partition: "Configure accelerator sharing",
      group: modalData._editing === "true" ? "Edit group" : "Create group",
      project:
        modalData._editing === "true" ? "Edit project" : "Create project",
      storage: "Shared storage",
      image: "Who can use this image",
      user: "Create account",
      "edit-user": "Edit account",
      cleanup: "Data retention",
    }
    const required =
      modal === "user"
        ? ["username", "password"]
        : ["group", "project"].includes(modal)
          ? ["name"]
          : modal === "reservation"
            ? ["gpu_uuid", "start", "end"]
            : modal === "renew-reservation"
              ? ["end"]
              : modal === "partition"
                ? ["mode"]
                : modal === "storage"
                  ? ["team"]
                  : []
    const problem =
      modal === "reservation" &&
      modalData.start &&
      modalData.end &&
      new Date(modalData.end) <= new Date(modalData.start)
        ? "The end must be after the start."
        : modal === "renew-reservation" &&
            modalData.end &&
            modalData.current_end &&
            // `end` comes from a datetime-local control (local wall clock);
            // `current_end` is a backend UTC timestamp.
            new Date(modalData.end) <= parseServerDate(modalData.current_end)
          ? "Pick a time later than the current end."
          : modal === "image" &&
              ["project", "group"].includes(modalData.visibility || "") &&
              !modalData.shareWith
            ? `Choose the ${modalData.visibility} to share with.`
            : modal === "partition" &&
                modalData.mode === "mig" &&
                !Object.entries(modalData).some(
                  ([key, value]) => key.startsWith("mig_") && Number(value) > 0
                )
              ? "Set at least one slice count."
              : // The backend builds a Kubernetes namespace from the group name and
                // rejects anything that is not a lowercase DNS-safe label.
                modal === "storage" &&
                  modalData.team &&
                  imageSlug(modalData.team) !== modalData.team
                ? `Shared storage needs a lowercase group name (letters, digits, "-", "_", "."). Rename “${modalData.team}” first — the backend will reject it otherwise.`
                : ""
    const valid = required.every((key) => modalData[key]?.trim()) && !problem
    const quotaFields = (
      <details
        className="rounded-md border border-zinc-800 p-2"
        // Open wherever per-model limits can be set, creating an account included: they
        // are applied by a follow-up PUT, and hiding them made the create and edit forms
        // disagree about whether the fields exist.
        open={["group", "project", "user", "edit-user"].includes(modal)}
      >
        <summary className="cursor-pointer text-xs">
          Set limits by accelerator model (optional)
        </summary>
        <p className="my-2 text-[10px] text-zinc-400">
          Leave blank to use the total accelerator allocation. Add an override
          only when a specific model needs a separate cap.
        </p>
        <div className="grid max-h-48 gap-2 overflow-y-auto">
          {[
            ...new Map(
              gpus
                .filter((gpu) => !gpu.simulated)
                .map((gpu) => [gpu.product || gpu.uuid, gpu])
            ).values(),
          ].map((gpu) => (
            <div key={gpu.uuid} className="grid gap-2">
              <ModalField
                name={`gpuq_${gpuTypeKey(gpu.product || gpu.uuid)}`}
                label={`${gpu.product || gpu.uuid} accelerator limit`}
                type="number"
              />
              {(modal === "edit-user" || modal === "user") && (
                <ModalField
                  name={`vramq_${gpuTypeKey(gpu.product || gpu.uuid)}`}
                  label={`${gpu.product || gpu.uuid} GPU memory limit (GB)`}
                  type="number"
                />
              )}
            </div>
          ))}
        </div>
      </details>
    )
    // `GET /users` is administrator-only, so a power user - who may create projects -
    // gets no account list to search. Their typed name is accepted instead; the backend
    // validates it either way.
    const canListAccounts = users.length > 0
    const memberAddable =
      Boolean(memberSearch.trim()) &&
      (!canListAccounts ||
        users.some((account) => account.username === memberSearch)) &&
      !(modalData.members || "").split(",").includes(memberSearch)
    const memberFields = (
      <fieldset>
        <legend className="mb-1 text-xs">Members</legend>
        <p className="mb-2 text-[10px] text-zinc-400">
          {canListAccounts
            ? "Search a person, then add them to this shared allocation."
            : "Type a username, then add them to this shared allocation."}
        </p>
        <div className="flex gap-2">
          <input
            aria-label="Search members"
            className={input}
            list="member-options"
            value={memberSearch}
            onChange={(event) => setMemberSearch(event.target.value)}
            placeholder={canListAccounts ? "Search people" : "Username"}
          />
          <datalist id="member-options">
            {users
              .filter((account) =>
                account.username
                  .toLowerCase()
                  .includes(memberSearch.toLowerCase())
              )
              .slice(0, 12)
              .map((account) => (
                <option key={account.username} value={account.username} />
              ))}
          </datalist>
          <button
            className={button}
            type="button"
            disabled={!memberAddable}
            onClick={() => {
              setModalData((data) => ({
                ...data,
                members: [
                  ...new Set([
                    ...(data.members || "").split(",").filter(Boolean),
                    memberSearch.trim(),
                  ]),
                ].join(","),
              }))
              setMemberSearch("")
            }}
          >
            Add
          </button>
        </div>
        <div className="mt-2 flex max-h-20 flex-wrap gap-1 overflow-y-auto">
          {(modalData.members || "")
            .split(",")
            .filter(Boolean)
            .map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-xs"
              >
                {name}
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  className="text-zinc-300"
                  onClick={() =>
                    setModalData((data) => ({
                      ...data,
                      members: (data.members || "")
                        .split(",")
                        .filter((member) => member && member !== name)
                        .join(","),
                    }))
                  }
                >
                  ×
                </button>
              </span>
            ))}
        </div>
      </fieldset>
    )
    const content =
      modal === "group" ? (
        <>
          <ModalField name="name" label="Group name" />
          <ModalField
            name="total_gpus"
            label="Total accelerators"
            type="number"
            help="Shared across every selected member."
          />
          <ModalField
            name="total_disk_gb"
            label="Shared storage (GiB)"
            type="number"
          />
          {memberFields}
          <div className="grid gap-2">{quotaFields}</div>
        </>
      ) : modal === "project" ? (
        <>
          <ModalField name="name" label="Project name" />
          <label className="grid gap-1 text-xs">
            Owner
            <select
              className={input}
              value={modalData.owner || ""}
              onChange={(event) =>
                setModalData((data) => ({ ...data, owner: event.target.value }))
              }
            >
              <option value="">No owner</option>
              {users.map((account) => (
                <option key={account.username}>{account.username}</option>
              ))}
            </select>
          </label>
          <ModalField
            name="total_gpus"
            label="Total accelerators"
            type="number"
            help="Shared across every selected member’s project jobs."
          />
          <ModalField
            name="shared_storage_gb"
            label="Shared storage (GiB)"
            type="number"
          />
          {memberFields}
          <div className="grid gap-2">{quotaFields}</div>
        </>
      ) : modal === "user" || modal === "edit-user" ? (
        <>
          <ModalField
            name="username"
            label="Username"
            disabled={modal === "edit-user"}
          />
          <>
            {modal === "user" && (
              <ModalField name="password" label="Password" type="password" />
            )}
          </>
          <label className="grid gap-1 text-xs">
            Role
            <select
              className={input}
              disabled={modal === "edit-user"}
              value={modalData.role || "user"}
              onChange={(event) =>
                setModalData((data) => ({ ...data, role: event.target.value }))
              }
            >
              <option value="user">User</option>
              <option value="poweruser">Power user</option>
              <option value="admin">Administrator</option>
              <option value="readonly">Read only</option>
            </select>
            {modal === "edit-user" && (
              <span className="text-[10px] text-zinc-400">
                The role is fixed once the account exists. Recreate the account
                to change it.
              </span>
            )}
          </label>
          <ModalField name="email" label="Email (optional)" />
          {modal === "edit-user" && (
            <>
              <ModalField
                name="slack_id"
                label="Slack member ID (optional)"
                help="Reservation and job notifications are sent here when Slack is configured."
              />
              <label className="grid gap-1 text-xs">
                Group
                <select
                  aria-label="Group"
                  className={input}
                  value={modalData.team || ""}
                  onChange={(event) =>
                    setModalData((data) => ({
                      ...data,
                      team: event.target.value,
                    }))
                  }
                >
                  <option value="">No group</option>
                  {groups.map((group) => (
                    <option key={group.name} value={group.name}>
                      {group.name}
                    </option>
                  ))}
                </select>
                <span className="text-[10px] text-zinc-400">
                  Group membership shares that group’s allocation and storage.
                </span>
              </label>
              <ModalField
                name="priority"
                label="Scheduling priority"
                type="number"
                help="Applied to this account’s queued work. Higher runs first."
              />
            </>
          )}
          <p className="text-[10px] text-zinc-400">
            Project access is managed from Projects, where one account can
            belong to multiple shared allocations.
          </p>
          <ModalField
            name="quota_cpu"
            label="CPU allocation"
            disabled={modal === "edit-user"}
          />
          <ModalField
            name="quota_memory"
            label="Memory allocation"
            disabled={modal === "edit-user"}
          />
          <ModalField
            name="quota_gpu"
            label="Accelerator allocation"
            type="number"
            disabled={modal === "edit-user"}
          />
          <ModalField
            name="quota_vram_gb"
            label="GPU memory allocation (GB)"
            type="number"
            disabled={modal === "edit-user"}
            help={
              modal === "edit-user"
                ? "Account-wide allocations are set at creation. Use the per-model limits below to change what this account may take."
                : undefined
            }
          />
          <div className="grid gap-2">{quotaFields}</div>
        </>
      ) : modal === "cleanup" ? (
        <>
          <p className="text-[11px] text-zinc-400">
            Automatic retention is currently{" "}
            <b>{modalData.enabled === "true" ? "enabled" : "disabled"}</b>. That
            switch is the backend’s <code>CLEANUP_ENABLED</code> environment
            setting, so it changes with the deployment, not from here. The
            durations below apply immediately.
          </p>
          <ModalField
            name="cleanup_interval_value"
            label="How often to check"
            type="number"
            help="Hours between retention checks."
          />
          <ModalField
            name="standalone_task_ttl_value"
            label="Keep completed task records"
            type="number"
            help="Hours before completed task records are removed."
          />
          <ModalField
            name="result_ttl_value"
            label="Keep result files"
            type="number"
            help="Hours before result files are removed."
          />
          <ModalField
            name="results_helper_idle_ttl_value"
            label="Keep idle result helpers"
            type="number"
            help="Hours before helpers are stopped."
          />
        </>
      ) : modal === "reservation" ? (
        <>
          <p className="text-[11px] text-zinc-400">
            Holds an accelerator for a window without creating a job yet. Times
            are in your local timezone.
          </p>
          <ModalField name="start" label="Start" type="datetime-local" />
          <ModalField name="end" label="End" type="datetime-local" />
          <label className="grid gap-1 text-xs">
            Accelerator
            <select
              aria-label="Accelerator to reserve"
              className={input}
              value={modalData.gpu_uuid || ""}
              onChange={(event) =>
                setModalData((data) => ({
                  ...data,
                  gpu_uuid: event.target.value,
                  gpu_partition: "",
                }))
              }
            >
              <option value="">Select an accelerator</option>
              {gpus
                .filter((gpu) => !gpu.simulated)
                .map((gpu) => {
                  const check = windowCheck.find(
                    (item) => item.gpu_uuid === gpu.uuid
                  )
                  return (
                    <option
                      key={gpu.uuid}
                      value={gpu.uuid}
                      disabled={check ? !check.available : false}
                    >
                      {gpu.product || gpu.uuid}
                      {check ? (check.available ? " — free" : " — busy") : ""}
                    </option>
                  )
                })}
            </select>
            <span className="text-[10px] text-zinc-400">
              {windowCheckLoading
                ? "Checking the shared schedule…"
                : windowCheck.length
                  ? "Free and busy are for the window above."
                  : "Pick a window to see which accelerators are free."}
            </span>
          </label>
          {migProfilesFor(partitions, modalData.gpu_uuid || "").length > 0 && (
            <label className="grid gap-1 text-xs">
              GPU slice
              <select
                aria-label="GPU slice to reserve"
                className={input}
                value={modalData.gpu_partition || ""}
                onChange={(event) =>
                  setModalData((data) => ({
                    ...data,
                    gpu_partition: event.target.value,
                  }))
                }
              >
                <option value="">Whole accelerator</option>
                {migProfilesFor(partitions, modalData.gpu_uuid || "").map(
                  (profile) => (
                    <option key={profile} value={profile}>
                      {profile} ({MIG_PROFILE_VRAM_GB[profile] ?? "?"} GB)
                    </option>
                  )
                )}
              </select>
              <span className="text-[10px] text-zinc-400">
                Reserving one slice leaves the rest of the card for others.
              </span>
            </label>
          )}
          <ModalField
            name="priority"
            label="Priority"
            type="number"
            help="Higher priority can preempt lower-priority holds on this card."
          />
        </>
      ) : modal === "renew-reservation" ? (
        <>
          <p className="text-[11px] text-zinc-400">
            {modalData.gpu_uuid ? `${modalData.gpu_uuid} · ` : ""}
            currently held until{" "}
            {modalData.current_end
              ? parseServerDate(modalData.current_end).toLocaleString()
              : "an unknown time"}
            . The new end must be later, and the extra time must still be free.
          </p>
          <ModalField name="end" label="New end" type="datetime-local" />
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-100">
            This keeps the accelerator reserved for you. It does not raise the
            run time limit of a job that is already running — that limit is
            fixed when the job starts, so start a new job to use the extra time.
          </p>
        </>
      ) : modal === "partition" ? (
        <>
          <p className="text-[11px] text-zinc-400">
            {modalData.product} · {modalData.gpu_uuid}
            {modalData.node ? ` on ${modalData.node}` : ""}: choose how this
            accelerator is shared. Changing it can disrupt work already running
            on the card.
          </p>
          {Number(modalData.shares || 1) > 1 && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-100">
              This card is already divided into {modalData.shares} shares. Only
              Full GPU is offered, which rejoins this card — other cards on{" "}
              {modalData.node || "the node"} keep whatever they are set to.
              Rejoin first, then divide again if you want a different number of
              shares; dividing a divided card is not supported.
            </p>
          )}
          <label className="grid gap-1 text-xs">
            Sharing mode
            <select
              aria-label="Sharing mode"
              className={input}
              value={modalData.mode || ""}
              onChange={(event) =>
                setModalData((data) => ({ ...data, mode: event.target.value }))
              }
            >
              {PARTITION_MODES.filter((option) =>
                (modalData.modes || "").split(",").includes(option.mode)
              ).map((option) => (
                <option key={option.mode} value={option.mode}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-zinc-400">
              {PARTITION_MODES.find((option) => option.mode === modalData.mode)
                ?.help || "Only modes this hardware reports are listed."}
            </span>
          </label>
          {(modalData.mode === "timeslice" || modalData.mode === "mps") && (
            <>
              <ModalField
                name="replicas"
                label="Shares for this card"
                type="number"
                help="How many jobs may hold this card at the same time. 2 or more — one share is an undivided card, which is Full GPU."
              />
              <p className="rounded-md border border-blue-500/30 bg-blue-500/10 p-2 text-[11px] text-blue-100">
                Applies to {modalData.gpu_uuid} only
                {Number(modalData.replicas || 0) > 0
                  ? `: that card will publish ${modalData.replicas} shares, while the other cards on ${modalData.node || "the node"} stay as they are.`
                  : "; the other cards on the node stay as they are."}{" "}
                {modalData.mode === "timeslice"
                  ? "Shares take turns in time on the same silicon; they do not each get their own memory."
                  : "Shares run concurrently on the same silicon and share its memory."}{" "}
                One card can be time-shared and another left whole, but a single
                node cannot mix time sharing and concurrent sharing — the device
                plugin takes one mechanism per node.
              </p>
            </>
          )}
          {modalData.mode === "mig" && (
            <fieldset className="grid gap-2">
              <legend className="text-xs">Slices to create</legend>
              <p className="text-[10px] text-zinc-400">
                Set how many slices of each profile this card should expose.
                Leave a profile empty to skip it.
              </p>
              <div className="grid max-h-48 gap-2 overflow-y-auto">
                {Object.entries(MIG_PROFILE_VRAM_GB).map(([profile, vram]) => (
                  <ModalField
                    key={profile}
                    name={`mig_${profile}`}
                    label={`${profile} — ${vram} GB per slice`}
                    type="number"
                  />
                ))}
              </div>
            </fieldset>
          )}
        </>
      ) : modal === "storage" ? (
        <>
          <p className="text-[11px] text-zinc-400">
            Creates one shared volume that every member of the group can mount.
            Running it again for the same group leaves the existing volume
            untouched.
          </p>
          <label className="grid gap-1 text-xs">
            Group
            <select
              aria-label="Group for shared storage"
              className={input}
              value={modalData.team || ""}
              onChange={(event) =>
                setModalData((data) => ({ ...data, team: event.target.value }))
              }
            >
              <option value="">Select a group</option>
              {groups.map((group) => (
                <option key={group.name} value={group.name}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <ModalField
            name="size_gb"
            label="Size (GiB)"
            type="number"
            help="Requested capacity for the shared volume."
          />
        </>
      ) : modal === "image" ? (
        <>
          <p className="font-mono text-[11px] break-all text-zinc-400">
            {modalData.pull_ref}
          </p>
          <label className="grid gap-1 text-xs">
            Who can use it
            <select
              aria-label="Image visibility"
              className={input}
              value={modalData.visibility || "user"}
              onChange={(event) =>
                setModalData((data) => ({
                  ...data,
                  visibility: event.target.value,
                  shareWith: "",
                }))
              }
            >
              <option value="user">Only me</option>
              <option value="project">A project</option>
              <option value="group">A group</option>
              <option value="everyone">Everyone</option>
            </select>
          </label>
          {(modalData.visibility === "project" ||
            modalData.visibility === "group") && (
            <label className="grid gap-1 text-xs">
              {modalData.visibility === "project" ? "Project" : "Group"}
              <select
                aria-label="Share image with"
                className={input}
                value={modalData.shareWith || ""}
                onChange={(event) =>
                  setModalData((data) => ({
                    ...data,
                    shareWith: event.target.value,
                  }))
                }
              >
                <option value="">Select…</option>
                {(modalData.visibility === "project"
                  ? projects.map((project) => project.name)
                  : groups.map((group) => group.name)
                ).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-zinc-400">
                Members of the selected{" "}
                {modalData.visibility === "project" ? "project" : "group"} see
                this image in their picker.
              </span>
            </label>
          )}
        </>
      ) : (
        <p className="text-xs text-zinc-400">
          This action is not available from the streamlined workflow.
        </p>
      )
    return (
      <ModalFormContext.Provider
        value={{ data: modalData, setData: setModalData }}
      >
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-label={`${labels[modal]} form`}
            className="max-h-[90svh] w-full max-w-md overflow-y-auto rounded-lg border border-zinc-700 bg-[#101014] p-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{labels[modal]}</h2>
              <button
                className={button}
                aria-label="Close form"
                onClick={() => setModal(null)}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-3">{content}</div>
            {problem && (
              <p className="mt-3 text-[11px] text-amber-300">{problem}</p>
            )}
            {modalError && (
              <p
                role="alert"
                className="mt-3 rounded-md border border-red-900/80 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-200"
              >
                {modalError}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className={button} onClick={() => setModal(null)}>
                Cancel
              </button>
              <button
                className="h-9 rounded-md bg-blue-600 px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-400"
                onClick={() => void submitModal()}
                disabled={pending || !valid}
              >
                {pending
                  ? "Saving…"
                  : modal === "cleanup"
                    ? "Save retention policy"
                    : modal === "reservation"
                      ? "Reserve"
                      : modal === "renew-reservation"
                        ? "Extend"
                        : modal === "partition"
                          ? "Apply sharing"
                          : modal === "storage"
                            ? "Create shared storage"
                            : "Save"}
              </button>
            </div>
          </section>
        </div>
      </ModalFormContext.Provider>
    )
  }
}
