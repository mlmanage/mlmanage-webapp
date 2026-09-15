import { NextRequest } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
])

function backendBaseUrl() {
  return (process.env.MLMANAGE_API_URL || "http://localhost:8000").replace(
    /\/+$/,
    ""
  )
}

function backendUrl(request: NextRequest, segments: string[]) {
  const url = new URL(request.url)
  const target = new URL(
    `${backendBaseUrl()}/${segments.map(encodeURIComponent).join("/")}`
  )
  target.search = url.search
  return target
}

function forwardedHeaders(request: NextRequest) {
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value)
  })
  return headers
}

// Paths the browser must reach before it holds a token. Everything else requires
// credentials: several backend endpoints (`/reservations/calendar`, `/gpu/list`,
// `/metrics`) have no auth dependency of their own, and this proxy is the
// internet-facing surface in front of them.
const PUBLIC_PATHS = new Set(["health", "login"])
// The iCal feed is subscribed to by calendar clients that cannot send headers, so
// the backend accepts `?token=<JWT>` there instead.
const QUERY_TOKEN_PATHS = new Set(["reservations/calendar.ics"])

function isAuthorized(request: NextRequest, segments: string[]) {
  const path = segments.join("/")
  if (PUBLIC_PATHS.has(path)) return true
  if (request.headers.has("authorization")) return true
  if (QUERY_TOKEN_PATHS.has(path)) {
    return Boolean(new URL(request.url).searchParams.get("token"))
  }
  return false
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> }
) {
  const { path = [] } = await context.params
  const method = request.method.toUpperCase()

  if (method !== "OPTIONS" && !isAuthorized(request, path)) {
    return Response.json(
      { detail: "Not authenticated" },
      { status: 401, headers: { "cache-control": "no-store" } }
    )
  }

  const init: RequestInit = {
    method,
    headers: forwardedHeaders(request),
    cache: "no-store",
    redirect: "manual",
  }

  if (!HEAD_OR_GET.has(method)) {
    init.body = await request.arrayBuffer()
  }

  const response = await fetch(backendUrl(request, path), init)
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  headers.set("cache-control", "no-store")

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

const HEAD_OR_GET = new Set(["GET", "HEAD"])

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
export const HEAD = proxy
export const OPTIONS = proxy
