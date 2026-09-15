import { request } from "@playwright/test"

// Global teardown: final sweep of mlm-live-* artifacts. The per-test afterEach sweep
// handles normal flow; this is the last-resort net for crashes that killed a worker
// mid-test. Mirrors tests_suite/sweep.py (prefix + far-future reservations).
const backend = (process.env.MLMANAGE_API_URL || "http://localhost:8000").replace(
  /\/+$/,
  ""
)
const TEST_PREFIX = "mlm-live-"
const FAR_FUTURE = "2027-01-01T00:00:00"
const adminPassword = process.env.MLM_ADMIN_PASSWORD
const admin = {
  username: process.env.MLM_ADMIN_USER || "admin",
  password: adminPassword,
}

const matches = (name: unknown) =>
  typeof name === "string" && name.startsWith(TEST_PREFIX)

export default async function globalTeardown() {
  if (process.env.MLM_SKIP_SWEEP === "1") return
  if (!adminPassword) {
    console.warn(
      "[global-teardown] MLM_ADMIN_PASSWORD is not set; no sweep performed"
    )
    return
  }
  const ctx = await request.newContext()
  try {
    const login = await ctx.post(`${backend}/login`, {
      data: admin,
      failOnStatusCode: false,
    })
    if (!login.ok()) {
      console.warn("[global-teardown] admin login failed; no sweep performed")
      return
    }
    const token = ((await login.json()) as { access_token: string }).access_token
    const headers = { Authorization: `Bearer ${token}` }
    const del = async (url: string) => {
      try {
        await ctx.delete(`${backend}${url}`, { headers, failOnStatusCode: false })
      } catch {
        // best effort
      }
    }
    const list = async <T>(path: string, key: string): Promise<T[]> => {
      const res = await ctx.get(`${backend}${path}`, {
        headers,
        failOnStatusCode: false,
      })
      if (!res.ok()) return []
      const body: unknown = await res.json()
      if (Array.isArray(body)) return body as T[]
      return ((body as Record<string, T[]>)?.[key] ?? []) as T[]
    }

    for (const item of await list<Record<string, unknown>>("/queue", "queue"))
      if (matches(item.display_name)) {
        for (const t of (item.task_names as string[]) ?? [])
          await del(`/tasks/${encodeURIComponent(t)}`)
        await del(`/queue/${item.id}`)
      }
    for (const job of await list<Record<string, unknown>>("/jobs", "jobs"))
      if (matches(job.display_name)) {
        if (typeof job.task_name === "string" && job.task_name)
          await del(`/tasks/${job.task_name}`)
        await del(`/jobs/${job.id}`)
      }
    for (const img of await list<Record<string, unknown>>("/images", "images"))
      if (matches(img.name)) await del(`/images/${img.id}`)
    for (const g of await list<Record<string, unknown>>("/groups", "groups"))
      if (matches(g.name)) await del(`/groups/${encodeURIComponent(String(g.name))}`)
    for (const p of await list<Record<string, unknown>>("/projects", "projects"))
      if (matches(p.name)) await del(`/projects/${encodeURIComponent(String(p.name))}`)
    for (const u of await list<Record<string, unknown>>("/users", "users"))
      if (matches(u.username)) await del(`/users/${encodeURIComponent(String(u.username))}?delete_namespace=true`)
    // far-future reservations are only leftover test windows; job deletion cancels
    // linked ones, this catches any without a job
    for (const r of await list<Record<string, unknown>>("/reservations", "reservations"))
      if (
        r.status === "active" &&
        typeof r.start_time === "string" &&
        r.start_time >= FAR_FUTURE
      )
        await del(`/reservations/${r.id}`)

    // Final erasure of test history via the admin purge endpoint (backend deletes prefixed
    // workload records instead of just cancelling them). The endpoint MUST exist on any
    // current backend deployment — a 404 means the backend was not updated; a 403 means
    // it was not started with MLM_ENABLE_TEST_PURGE=1. Both are loud failures so that a
    // run never silently ends with visible residue.
    const scope = process.env.MLM_PURGE_SCOPE || "test"
    const purge = await ctx.post(`${backend}/admin/purge-data`, {
      headers,
      data: { confirm: "purge-all-data", scope },
      failOnStatusCode: false,
    })
    if (purge.status() === 404)
      throw new Error(
        "Backend does not provide POST /admin/purge-data — update the backend deployment."
      )
    if (purge.status() === 403)
      throw new Error(
        "Purge endpoint disabled — start the backend with MLM_ENABLE_TEST_PURGE=1 (test environments only)."
      )
    if (!purge.ok()) {
      const detail = await purge.text()
      throw new Error(`Purge failed (${purge.status()}): ${detail.slice(0, 200)}`)
    }
    const purged = (await purge.json()) as { deleted?: Record<string, number> }
    console.log(`[global-teardown] purge(${scope}):`, JSON.stringify(purged.deleted ?? {}))
  } finally {
    await ctx.dispose()
  }
}
