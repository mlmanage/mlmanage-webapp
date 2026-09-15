# MLManage Web App

User-facing web application for MLManage, a self-hosted internal platform for running, scheduling, and monitoring containerized GPU workloads without exposing Kubernetes or the private compute backend to end users.

## What it provides

- Authenticated app shell with Jobs, Capacity, Projects, Usage, My account, and admin-only Administration views.
- Reservation-backed job scheduling: users enter the GPU reservation window and container details in one form.
- Standalone accelerator reservations: reserve, extend and release a window (whole card or MIG slice) without creating a job first, and see the schedule everyone else is holding.
- iCal schedule exchange: download the reservation calendar, subscribe to it from Google Calendar, or import windows from an `.ics` file.
- Custom container image and command support, with upload name, tag and visibility (only me, project, group, everyone).
- CPU, RAM, GPU count, VRAM, disk, GPU UUID, start, and end controls, plus optional queue scheduling: priority, parallel copies, gang scheduling, MPI, dependencies on other queued jobs, and MIG slice selection.
- Active task visibility, cancellation, log tail selection and log download.
- Energy and carbon-footprint reporting alongside allocated GPU time and utilization, with a CSV export.
- GPU sharing visibility for everyone and administrator configuration of full, time-sharing, concurrent-sharing or MIG modes per card.
- Admin user creation with quota fields, and profile editing for notifications, group, scheduling priority and per-model accelerator/VRAM limits.
- A read-only account view of the signed-in user's allocation, workspaces and access.
- Configurable backend URL for frontend/backend deployments on different machines.
- Live-backend Playwright coverage for login, role gating, jobs and advanced queue options, images, tasks/logs/results, queue, reservation create/release and iCal export, GPU sharing read paths, storage, analytics including energy/carbon labels, the account view, admin/management flows, and layout overflow.

## Requirements

- Node.js compatible with Next.js 16.
- npm.
- A reachable MLManage Compute backend.

Configure a reachable backend for your environment. For example, when it runs locally:

```bash
export MLMANAGE_API_URL="http://localhost:8000"
curl "$MLMANAGE_API_URL/health"
```

## Setup

```bash
npm install
cp env.example .env.local
```

Edit `.env.local` for your backend. This value is server-side only; browser requests stay same-origin through `/api/mlmanage`:

```bash
MLMANAGE_API_URL=http://localhost:8000
```

Keep deployment-specific addresses and credentials in private, untracked configuration.

## Run locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Alternatively, `backend_server.sh` serves the app on port `3001` and forwards the cluster's monitoring stack, so its local surface is:

| Port | Service |
| --- | --- |
| `3001` | This web app |
| `3002` | Grafana |
| `3003` | Prometheus |
| `8001` | MLManage backend API through the SSH tunnel |

Treat monitoring access as privileged. Obtain credentials through the approved secret-management process and keep port forwards bound to a trusted interface. See [local development](Documentation/02-setup-and-deployment/local-development.md#optional-backend-and-monitoring-tunnels) for the configurable tunnel workflow.

## Deploy a development backend VM

Backend deployment details vary by environment. See the parameterized [backend development VM runbook](Documentation/02-setup-and-deployment/backend-development-vm.md) for backup, deployment, health-check, recovery, and rollback guidance. Keep hostnames, usernames, paths, and service secrets outside this repository.

## Build and run production

```bash
npm run build
npm run start
```

Set `MLMANAGE_API_URL` in the Next.js server environment for the target backend. The browser must not reach the MLManage backend directly; it calls the same-origin `/api/mlmanage/...` proxy instead.

## Verification

Run all checks:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

Run only Chromium Playwright tests while iterating:

```bash
npm run test:e2e -- --project=chromium
```

### Running the full browser matrix

For reliable Firefox and WebKit runs, use a production build rather than the development server. Build once, then reuse it:

```bash
npm run build
npm run start &                 # Playwright reuses this server
npx playwright test             # chromium + firefox + webkit
```

WebKit also needs system libraries once: `sudo npx playwright install-deps webkit`.

Point the suite at a disposable backend and provide credentials through environment variables or an approved secret-management process. Supply a real image archive when testing a production-like backend:

```bash
MLMANAGE_API_URL=http://localhost:8000 \
MLM_ADMIN_PASSWORD='<test-admin-password>' \
MLM_ROLE_PASSWORD='<test-role-password>' \
MLMANAGE_E2E_IMAGE_TAR=/path/to/docker-save.tar \
  npx playwright test
```

`MLMANAGE_E2E_IMAGE_TAR` must be a real `docker save` archive when the backend validates and pushes uploads to a registry. Ensure the required role-specific test accounts exist, and never run the stateful suite against shared or production data.

## Important files

| Path                                           | Purpose                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `app/page.tsx`                                 | Route entrypoint.                                                                                   |
| `components/console-shell.tsx`                 | Main authenticated UI and view logic.                                                               |
| `lib/mlmanage-api.ts`                          | API client, types, and helpers.                                                                     |
| `tests/mlmanage-live.spec.ts`                  | Playwright regression tests.                                                                        |
| `Documentation/00-overview/project-summary.md` | Comprehensive product description, supported workflows, roles, boundaries, and source-of-truth map. |
| `Documentation/`                               | Architecture, feature, development, operations, and deployment documentation.                       |

## Documentation

Start with [`Documentation/README.md`](Documentation/README.md). It links to the product overview, architecture, setup, feature, development, operations, and contributor guides.
