# Backend integration

## Network boundary

Browser code must never call the MLManage backend host directly. All browser HTTP traffic uses the same-origin path:

```text
/api/mlmanage/...
```

`app/api/mlmanage/[...path]/route.ts` is a Next.js 16 Route Handler that proxies requests to the real backend URL configured **only on the Next.js server**:

```text
MLMANAGE_API_URL=http://localhost:8000
```

No `NEXT_PUBLIC_*` backend URL is used for backend calls. This keeps the backend address out of the browser bundle and lets production deployments place the backend on a private network.

## Proxy authentication

Several backend endpoints have no auth dependency of their own (`/reservations/calendar`, `/gpu/list`, `/metrics`, `/health`), and this proxy is the internet-facing surface in front of them. It therefore rejects anonymous requests with 401 rather than forwarding them:

- `/health` and `/login` are reachable without credentials, because the browser needs them before it holds a token.
- `/reservations/calendar.ics` also accepts `?token=<JWT>`, because calendar clients that subscribe to the feed cannot send an `Authorization` header.
- Everything else requires an `Authorization` header.

The backend's own `reservations/reminder-cronjob.yaml` calls `/reservations/calendar` unauthenticated from inside the cluster; it reaches the API directly, not through this proxy, so it is unaffected. Closing the gap backend-side needs that CronJob to authenticate as well, which is tracked in the backend repository's own gap list.

## Request handling details

- JSON requests set `Content-Type: application/json`.
- Multipart `FormData` uploads intentionally do **not** set a JSON content type; the browser supplies multipart boundaries.
- Binary downloads (task result files and result tarballs) flow through the same proxy and are consumed as `Blob` objects in the browser.
- The frontend stores the JWT in `localStorage` as `mlmanage.token` and sends `Authorization: Bearer <token>` through the proxy.

## WebSocket exec/log boundary

Task logs use same-origin HTTP requests to `/api/mlmanage/tasks/{name}/logs` and support both one-shot and streaming responses where the backend/runtime provides them.

The task exec UI only attempts a same-origin browser WebSocket URL under `/api/mlmanage-ws/...`; it never opens a direct WebSocket to the configured backend host. The stock Next.js Route Handler runtime used by `npm run dev`/`next start` does not expose a custom WebSocket upgrade bridge in this repository. A production deployment that needs interactive exec should run a small Node/custom-server or reverse-proxy upgrade bridge at that same-origin path and bridge server-side to backend `WS /tasks/{task}/exec?token=<JWT>&command=/bin/sh`. Until that bridge is installed, the UI reports a same-origin bridge error and documents that direct backend WebSocket URLs remain blocked.

## Endpoint coverage

The API client in `lib/mlmanage-api.ts` has typed models for all current frontend-visible backend features:

| Feature | Backend endpoints surfaced in UI |
| --- | --- |
| Auth/users | `POST /login`, `GET /me`, `GET/POST /users`, `PUT/DELETE /users/{username}` |
| GPUs/partitioning | `GET /gpu/list`, `GET /gpu/capabilities`, `GET /gpu/partitions`, `POST /gpu/{uuid}/partition` |
| Images | `GET/POST /images`, `PUT /images/{id}`, `DELETE /images/{id}` with visibility metadata: `user`, `project`, `group`, or `everyone` |
| Jobs/tasks | `GET/POST/DELETE /jobs`, `GET/DELETE /tasks`, top-level `vram_limit_gb`, `project`, `gpu_partition`, `priority` |
| Task logs/results | `GET /tasks/{name}/logs` (selectable `tail_lines`), `GET /tasks/{name}/results`, `GET /tasks/{name}/results/download`, `DELETE /tasks/{name}/results` |
| Scheduling/calendar | `GET /availability`, `GET/POST/DELETE /reservations`, `PUT /reservations/{id}/renew`, `GET /reservations/calendar`, `GET /reservations/calendar.ics` (download and tokenized subscription), `POST /reservations/import.ics`, per-Job `.ics` download |
| Queue | `GET/POST /queue` including `priority`, `replicas`, `gang`, `mpi`, `depends_on`; `DELETE /queue/{id}` |
| Monitoring/analytics/storage | `GET /gpu/usage`, admin `GET /gpu/usage/{username}`, privacy-scoped `GET /analytics/usage` (utilization, `energy_kwh`, `co2_kg`, `efficiency_note`), `GET /analytics/activity`, `GET /disk/usage` |
| Management | `GET/POST /groups`, `PUT/DELETE /groups/{name}`, `GET/POST /projects`, `PUT/DELETE /projects/{name}`, `POST /teams/{team}/shared-storage`, `GET/PUT /settings/cleanup` |

## Deliberately not surfaced

- `PUT /users/{username}` accepts profile fields only (`email`, `slack_id`, `team`, `priority`, `gpu_quota_by_type`, `vram_quota_by_type`). Role and the account-wide `quota_*` values are create-time fields, so Edit account displays them read-only instead of sending values the backend would drop.
- `POST /tasks` (direct Task creation) stays out of the UI: Jobs models the same work as queued or scheduled entries and links the resulting Tasks.
- `GET /metrics` returns a Prometheus text exposition intended for a scraper, not an end user, and is left to the monitoring stack.
- `GET /analytics/usage` groups by user/team only; a project subject is aggregated backend-side. The per-scope job count and allocated GPU hours are not part of the response, so those table cells show a dash and the totals come from `GET /analytics/activity`.

## Environment-dependent behavior

Backend deployments may provide local-development fallbacks for image records, disk records, logs, accelerator availability, and result downloads. Hardware-affecting GPU partition changes and interactive exec require the corresponding Kubernetes, GPU, registry, and same-origin WebSocket infrastructure. Document those capabilities in deployment-specific operations material rather than hard-coding one development machine here.
