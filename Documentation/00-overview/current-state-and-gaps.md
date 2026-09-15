# Current state and gaps

## Current frontend state

The frontend is an implemented live-backend console rather than the starter shell described by the older commits. Authenticated navigation currently includes:

- Jobs (queued, scheduled and unlinked legacy Tasks in one list, with a detail panel).
- Capacity (GPU inventory and sharing, reserved windows, the shared schedule, workspace storage).
- Projects (groups, projects, shared storage).
- Usage (allocated GPU time, utilization, energy, carbon footprint, activity, telemetry).
- My account (read-only view of the signed-in user's allocation, workspaces and access).
- Administration for administrator-only account and retention controls.

The UI supports uploaded images with name/tag/visibility, reservation-backed jobs, queue-level scheduling (priority, parallel copies, gang, MPI, dependencies, MIG slice), task logs/results with a selectable log tail and download, standalone reservation create/extend/release, iCal export/subscribe/import, GPU capability and partition mutation, disk/team storage, analytics with energy and CO₂, groups/projects, role-aware controls, and top-level VRAM limits. `admin`, `poweruser`, `user`, and `readonly` behavior is covered by the live Chromium suite.

Browser HTTP traffic is same-origin through `/api/mlmanage/...`. Only the Next.js server reads `MLMANAGE_API_URL`; no public backend URL is exposed to browser code.

## Backend-dependent behavior

The console currently uses these endpoint groups:

- Authentication/users: `/login`, `/me`, `/users`, `/users/{username}`.
- Workloads: `/jobs`, `/tasks`, `/tasks/{name}/logs`, `/tasks/{name}/results`, and `/queue`.
- Images: `/images` and `/images/{id}`.
- Reservations: `/reservations`, renewal/cancellation, `/availability`, calendar JSON, `calendar.ics`, and `import.ics`.
- GPUs: `/gpu/list`, `/gpu/capabilities`, `/gpu/partitions`, partition mutation, and GPU usage.
- Operations: `/analytics/usage`, `/analytics/activity`, `/disk/usage`, `/teams/{team}/shared-storage`, and `/settings/cleanup`.
- Organization: `/groups` and `/projects`.

See [`../01-architecture/backend-integration.md`](../01-architecture/backend-integration.md) for the endpoints that are deliberately left out of the UI and why.

The backend target is configured server-side with `MLMANAGE_API_URL`. Frontend and backend changes belong to separate repositories and must be reviewed and committed separately.

## Known gaps and caveats

- **Interactive task exec is not bridged yet.** `app/api/mlmanage-ws/[...path]/route.ts` intentionally returns HTTP 426. A custom Node server or deployment reverse proxy must handle WebSocket upgrades while preserving the same-origin boundary; browsers must not connect directly to the backend host.
- JWTs are stored in browser `localStorage`. A hardened production deployment should prefer an HTTP-only cookie/session design.
- Lightweight backend environments may use simulated GPU inventory and local-development fallbacks instead of Kubernetes, a registry, GPU Operator, or real GPU execution.
- Monitoring and analytics can be empty when the backend has no samples. Energy and carbon footprint come from GPU power samples, so they read "Not monitored" until a monitoring stack feeds `gpu_metrics`; the CO₂ figure is energy × the backend's configured `CO2_KG_PER_KWH` (0.4 by default), not a measurement.
- `GET /analytics/usage` returns no per-scope job count or allocated GPU hours, so those columns show a dash and the headline totals are derived from `GET /analytics/activity`.
- Only fields that `PUT /users/{username}` accepts are editable in Edit account; role and the account-wide `quota_*` values are create-time and shown read-only. Per-model limits typed while creating an account are applied by a follow-up `PUT`, because `POST /users` has no field for them.
- `GET /gpu/list` reports uuid/product/node/simulated only. The inventory shows a Memory column only when a deployment supplies `memory_gb`, instead of a row of dashes.
- Extending a reservation moves the accelerator hold, not the run time limit of a job that is already running; the dialog says so, because the backend cannot change a running job's limit.
- A scheduled job runs on the single accelerator it reserves, so its GPU request is fixed at 1. Ask for several accelerators by queueing the job instead.
- `PUT /settings/cleanup` carries the four durations only. Whether the reaper runs at all is the backend's `CLEANUP_ENABLED` environment value, so Data retention shows that state read-only.
- A 401 from any call signs the session out and says so on the sign-in screen, rather than leaving pre-expiry data on screen while every action fails.
- The Playwright suite is intentionally a live, stateful integration suite against the deployed development backend; it does not mock API responses.
- `npm run dev` explicitly selects the Webpack development bundler.
