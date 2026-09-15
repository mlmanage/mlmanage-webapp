# MLManage project description and product specification

## 1. Product definition

MLManage is a self-hosted platform for sharing GPU compute inside an organization. It lets technical users submit containerized workloads without giving them direct access to the Kubernetes cluster or to the private compute-management backend.

The product consists of two repositories:

- **MLManage Web App** — this repository. It is the user-facing, locally hostable web application.
- **MLManage Compute** — maintained in a separate backend repository. It owns authentication data, scheduling policy, workload execution, GPU allocation, persistence, monitoring integration, and Kubernetes operations.

The web application is intentionally a thin product layer over MLManage Compute. End users interact with the web application; only the web application server and trusted operators should need network access to the backend. Browser HTTP traffic is sent to the web application's same-origin `/api/mlmanage` boundary, and the server forwards it to the privately configured backend.

MLManage is best understood as an **internal GPU workload portal**, not as a general-purpose Kubernetes dashboard, public container registry, notebook environment, or cloud billing product.

## 2. Product goals

MLManage should enable an organization to:

1. Share scarce GPU resources predictably among users, teams, and projects.
2. Run arbitrary containerized AI/ML or compute workloads with explicit resource and time limits.
3. Support immediate, scheduled, and queue-managed execution models.
4. Keep Kubernetes, cluster credentials, and backend internals away from normal users.
5. Give users enough operational visibility to manage workloads and retrieve results without operator intervention.
6. Give administrators control over users, quotas, GPU configuration, retention, and shared resources.
7. Run in a lightweight development mode without Kubernetes and in a full Kubernetes deployment with real NVIDIA GPUs.

## 3. Target users and roles

### Workload user (`user`)

A researcher, ML engineer, data scientist, student, or developer who needs compute. A workload user should be able to manage their images, reservations, tasks, scheduled jobs, queue entries, results, and usage data, subject to backend policy and quota checks.

### Power user (`poweruser`)

A trusted team or project lead. A power user has normal workload capabilities and may also create projects and request team shared storage. This is not a full administrator role.

### Administrator (`admin`)

A platform or lab operator responsible for account provisioning, quotas, GPU partitioning, retention settings, cross-user visibility, and cluster-facing configuration. Administrators can see broader records than ordinary users and can perform disruptive operations such as changing GPU partition modes.

### Read-only user (`readonly`)

An auditor, observer, instructor, manager, or support user who needs operational visibility but must not create, modify, cancel, delete, or execute workloads.

### Infrastructure operator

An operator may work directly in MLManage Compute to deploy and troubleshoot Kubernetes, PostgreSQL, the GPU Operator, controllers, registry, monitoring, and storage. This is an operational responsibility rather than a separate API role.

## 4. Core domain model

Use these terms consistently:

| Term              | Product meaning                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**          | A login identity with one application role, scalar quotas, optional per-GPU-type quotas, optional contact metadata, and an optional team.                               |
| **Team / Group**  | A named organizational grouping. In the current backend, a user's `team` value is matched to a `Group` record name. Groups carry aggregate GPU and disk quota metadata. |
| **Project**       | A workload and accounting context with an owner, GPU quota metadata, and shared-storage metadata. Tasks, jobs, and queue entries may be associated with a project.      |
| **GPU**           | A physical or inventory-reported accelerator identified by UUID and node. Simulated GPUs are visible for development but are not schedulable.                           |
| **GPU partition** | The configured sharing mode for a GPU: full device, time slicing, MPS, or MIG where supported.                                                                          |
| **Reservation**   | A time-bounded claim on a whole GPU or a MIG slice. Reservations are persisted in the backend database, not represented by a working Kubernetes Reservation resource.   |
| **Task**          | An immediate workload request. In a real cluster it becomes a namespaced custom resource and then a Pod; in local development it is represented by a database record.   |
| **Job**           | A scheduled workload that combines a reservation with automatic task dispatch at the reservation start time. A Job is not the same as a Kubernetes Job.                 |
| **Queue entry**   | A workload waiting for the backend queue scheduler. It can express priority, dependencies, multiple GPUs, multiple replicas, gang behavior, and MPI intent.             |
| **Image record**  | Metadata for a user-uploaded `docker save` tarball pushed to the configured registry. Visibility controls discovery in MLManage, not registry pull authorization.       |
| **Result**        | A file written by a task into its persistent results directory and made available for listing or download.                                                              |
| **Usage sample**  | A timestamped GPU utilization, memory, temperature, and power measurement attributed to a user when monitoring infrastructure is available.                             |

## 5. Supported product capabilities

### 5.1 Authentication and access control

Users can sign in with a username and password and receive a time-limited backend session token. The product recognizes `admin`, `poweruser`, `user`, and `readonly` roles.

The product must enforce authorization in the backend even when controls are hidden in the frontend. The frontend's role-aware behavior is a usability measure, not the security boundary.

Current account management is administrator-driven. The product does not currently provide user self-registration, password reset, password change, account deletion, or self-service profile editing.

### 5.2 Account, quota, and notification metadata

Administrators can:

- create users and choose their role;
- assign scalar CPU, memory, GPU-count, and VRAM quotas when creating an account;
- assign team and priority metadata;
- configure per-GPU-type GPU-count and VRAM quota maps;
- inspect backend-provided workspace quota metadata; and
- record e-mail and Slack identifiers used by backend notifications when those integrations are configured.

In a Kubernetes deployment, user creation also attempts to create a per-user namespace and home, scratch, and project workspace volumes. Their initial sizes come from backend deployment defaults; the current account API does not provide a complete per-user workspace-size editing workflow. Notification delivery is backend/environment dependent; entering contact metadata alone does not configure SMTP or Slack.

### 5.3 Container images

Authorized workload users can upload a tar archive produced by `docker save`. They can name and tag the image, see the backend-provided pull reference, reuse it in workload submissions, update its discovery scope, and delete its MLManage record.

Supported discovery scopes are:

- private to the uploader;
- visible to a group/team;
- visible to a project;
- visible to everyone using the platform.

Deleting an image record does not necessarily delete image layers from the registry. Image availability and push behavior depend on the registry configured by the backend deployment.

### 5.4 GPU inventory and partitioning

Authenticated users can inspect GPU inventory, product, node, UUID, supported sharing modes, and current partition records. Simulated inventory is clearly distinguished from real schedulable hardware.

Administrators can request a GPU partition mode:

- full-device allocation;
- time-sliced replicas;
- NVIDIA MPS replicas;
- MIG profiles and slice counts on hardware that reports MIG support.

Partition changes are disruptive cluster operations and may affect running workloads. Actual application depends on the GPU model, Kubernetes, NVIDIA GPU Operator configuration, and backend permissions.

### 5.5 Reservations

Authorized users can create a reservation for a start/end window, inspect reservations, renew the end time, and cancel reservations they are allowed to manage. A reservation may target a whole GPU or a MIG profile and may include priority.

The backend detects time conflicts. A higher-priority reservation may preempt conflicting lower-priority reservations according to backend policy. Whole-GPU and slice reservations on the same card have different capacity/conflict semantics.

Users can export reservation calendars as iCal feeds and import `.ics` files. Tokenized calendar URLs should be treated as credentials because the token may grant access to private reservation data.

### 5.6 Scheduled jobs

A user can schedule a container workload for a future GPU reservation window. A scheduled job includes:

- GPU and optional partition/MIG profile;
- start and end times;
- container image and command;
- CPU, memory, GPU-count, disk, and VRAM requests;
- optional project and priority.

Creating a job creates the associated reservation and stores the workload definition. At the start time, the backend dispatches a Task automatically. If the start time has already passed, dispatch can occur immediately. Cancelling is supported while a job is still scheduled; the linked reservation is also cancelled.

Typical job states are `scheduled`, `submitted`, `completed`, `cancelled`, and `dispatch_failed`.

### 5.7 Immediate tasks

A user can run a standalone task without first creating a reservation-backed scheduled job. A task can specify:

- a raw or uploaded image reference;
- a command;
- CPU, memory, GPU count, optional GPU UUID, and time limit;
- a VRAM limit;
- an optional project;
- an optional MIG profile.

In Kubernetes mode, the backend creates a Task custom resource in the user's namespace and the task controller creates the workload Pod. In local development mode, task behavior is simulated with database records and explicit fallback responses; it does not prove real container or GPU execution.

Users can list and cancel tasks they own. Administrators can inspect tasks across users. Read-only users can inspect tasks but cannot execute or cancel them.

### 5.8 Queue-managed workloads

Users can submit work to a backend queue when immediate execution or a fixed reservation is not the right model. Queue requests can include:

- priority and fair-share context;
- dependencies on earlier queue entries;
- GPUs per replica and replica count;
- gang scheduling intent;
- MPI intent;
- optional pinned GPU, project, VRAM, and time limit.

The scheduler waits for dependencies, orders runnable work using priority and fair-share signals, backfills work that fits available capacity, and dispatches one or more Tasks. A failed or cancelled dependency can cancel dependent work.

Typical queue states are `waiting_deps`, `queued`, `running`, `completed`, `failed`, and `cancelled`.

### 5.9 Workload observation and results

Users can inspect workload state, retrieve one-shot logs, request followed log output, list result files, download one result, download all results as a tar archive, and delete results when authorized.

In a full deployment, task results live under a task-specific directory on the user's persistent scratch volume and can survive Pod deletion until retention cleanup removes them.

The backend supports interactive task execution over WebSocket. **The web product does not currently provide a working end-to-end shell**, because its same-origin WebSocket upgrade bridge is intentionally unimplemented and returns HTTP 426. A production deployment needs a trusted reverse proxy or custom Node upgrade bridge; browsers must not connect directly to the private backend.

### 5.10 Storage

Users can inspect their workspace quota metadata and backend-reported PVC/workspace status. In the intended cluster deployment, each user has home, scratch, and project volumes.

Administrators and power users can request a ReadWriteMany shared volume for a team. This requires a compatible Kubernetes storage class. Disk usage values can be unavailable or inaccurate when cluster-side measurement is not configured correctly.

### 5.11 Groups and projects

All authenticated roles can inspect Groups and Projects. Administrators can create Groups; administrators and power users can create Projects. Projects can be selected as the accounting/quota context for tasks, scheduled jobs, and queue entries.

The current product does not provide a complete organizational lifecycle. `POST /groups` and `POST /projects` create a record or update an existing record with the same name, but there are no dedicated update or delete endpoints. Team membership is stored as user metadata rather than managed through a membership workflow.

### 5.12 Monitoring and analytics

Users can inspect their GPU usage history, including utilization, memory use, temperature, and power when samples exist. Administrators can query another user's usage. The console also aggregates analytics by user, team, or project, including average utilization, estimated energy use, estimated CO₂, and efficiency notes, and exports the result as CSV. The backend's raw Prometheus exposition at `GET /metrics` is left to the monitoring stack rather than rendered in the UI.

These values depend on DCGM, Prometheus, attribution logic, and collected samples. Empty datasets are a valid result. Energy and CO₂ are estimates, not billing-grade measurements. Project grouping is currently limited by what project attribution the backend records.

### 5.13 Retention and cleanup

Administrators can inspect and update runtime cleanup settings for:

- cleanup-loop frequency;
- standalone-task lifetime;
- result-data lifetime;
- idle result-helper lifetime.

The backend also ends Pods at workload time limits and cleans up job-associated tasks after reservation completion. Retention changes can delete user data and should be treated as operational policy changes.

## 6. Core user workflows

### Workflow A — administrator prepares the service

1. Deploy MLManage Compute and its database; optionally deploy Kubernetes, NVIDIA, registry, monitoring, and storage components.
2. Bootstrap the first administrator securely.
3. Configure the web application server with the private backend address.
4. Create user accounts and assign roles, quotas, teams, priorities, and contact metadata.
5. Optionally create Groups, Projects, shared storage, and GPU partition policy.
6. Verify health, schedulable GPU inventory, and same-origin frontend/backend communication.

### Workflow B — user prepares and runs an immediate workload

1. Sign in.
2. Upload a private or shared container image, or enter an existing pull reference.
3. Choose command, resource limits, optional project, GPU, VRAM, partition, and time limit.
4. Submit a Task.
5. Observe status and logs.
6. Download results or cancel the task.

### Workflow C — user schedules exclusive future compute

1. Inspect GPU availability and reservation calendar.
2. Choose a GPU or compatible MIG slice, time window, and priority.
3. Define the container workload and resource limits.
4. Create a Job, which creates the reservation and workload definition together.
5. Wait for backend dispatch at the start time.
6. Observe the resulting Task, retrieve results, or cancel before dispatch when allowed.

### Workflow D — user submits flexible queued work

1. Define the workload, resource shape, priority, dependencies, replicas, and optional gang/MPI behavior.
2. Submit a queue entry.
3. Observe dependency and queue state while the scheduler waits for capacity.
4. Follow the dispatched Task or Tasks when the entry runs.
5. Retrieve results or cancel the queued item when allowed.

### Workflow E — user manages reservations independently

1. Inspect inventory and calendar.
2. Create a whole-GPU or MIG-slice reservation.
3. Renew or cancel it as plans change.
4. Export a subscription URL or import reservations from iCal.

A standalone reservation does not by itself define a container workload; use a Job when reservation and execution should be coupled.

### Workflow F — operator monitors and governs the platform

1. Inspect queue, reservations, GPU state, usage, storage, and metrics.
2. Adjust accounts, quotas, projects, shared storage, partition strategy, or cleanup policy.
3. Diagnose failed dispatch, capacity, registry, Pod, monitoring, and storage issues in the backend repository and cluster.
4. Use backend tests and the frontend live Playwright suite to verify behavior after changes.

## 7. Role/capability summary

| Capability                                                    | `readonly` |      `user` | `poweruser` |           `admin` |
| ------------------------------------------------------------- | ---------: | ----------: | ----------: | ----------------: |
| Sign in and inspect permitted operational data                |        Yes |         Yes |         Yes |               Yes |
| Upload/manage own images                                      |         No |         Yes |         Yes |               Yes |
| Create/cancel tasks, jobs, queue entries, reservations        |         No |         Yes |         Yes |               Yes |
| Read logs and download results                                |        Yes |         Yes |         Yes |               Yes |
| Delete results                                                |         No |         Yes |         Yes |               Yes |
| Use backend task-exec API when a trusted bridge/client exists |         No |         Yes |         Yes |               Yes |
| Create projects                                               |         No |          No |         Yes |               Yes |
| Request team shared storage                                   |         No |          No |         Yes |               Yes |
| Create groups                                                 |         No |          No |          No |               Yes |
| Manage users and quotas                                       |         No |          No |          No |               Yes |
| Change GPU partitions                                         |         No |          No |          No |               Yes |
| Change cleanup settings                                       |         No |          No |          No |               Yes |
| Inspect records across users                                  |    Limited | Own/visible | Own/visible | Broad/admin scope |

Backend authorization is authoritative; this table summarizes intended product behavior rather than replacing endpoint-specific role checks. Although workload roles are authorized for the backend task-exec API, browser exec is not currently available end to end because the web application's WebSocket bridge is missing.

## 8. Deployment modes and environment-dependent behavior

### Lightweight/local development

`LOCAL_DEV_MODE=true` allows the backend to run without Kubernetes. It is suitable for API contracts, frontend development, role checks, and stateful integration tests. Synthetic or simulated GPU inventory may be shown, but simulated GPUs are intentionally not schedulable. Image upload, logs, results, and tasks can use development fallbacks.

This mode does **not** validate real Pod execution, GPU assignment, MIG/MPS/time slicing, registry pulls, persistent volumes, DCGM metrics, or WebSocket Pod exec.

### Full Kubernetes deployment

The intended production-like deployment uses PostgreSQL, the FastAPI service, per-user namespaces, Task custom resources, the Kopf task controller, workload Pods, registry integration, persistent storage, and optional NVIDIA GPU Operator and monitoring components.

Hardware and infrastructure determine which capabilities are usable. A deployment without a compatible GPU, device plugin, storage class, registry, Prometheus/DCGM, SMTP, or Slack can still expose the related API while returning empty data or an environment error.

## 9. Security and trust boundaries

- End users should not receive Kubernetes credentials or direct backend network access.
- Browser HTTP calls must remain same-origin through `/api/mlmanage`.
- Only the web application server reads `MLMANAGE_API_URL`.
- WebSocket task exec requires a same-origin trusted bridge; exposing the private backend URL to browsers is not an acceptable workaround.
- Backend role checks, ownership checks, and namespace isolation are the authorization boundary.
- JWTs are currently stored in browser `localStorage`; a hardened deployment should use a secure HTTP-only session design.
- Tokenized iCal and WebSocket URLs are sensitive and should not be logged or displayed unnecessarily.
- Some backend inventory, calendar, health, and metrics endpoints are public in the current API. Operators should review that exposure before production use.
- Image visibility controls record discovery, not registry-level pull authorization.
- The current VRAM mechanism primarily passes `VRAM_LIMIT_MB` into workloads; it should not be described as universally enforcing a hard hardware memory boundary.

## 10. Product boundaries and known gaps

The following should not be mistaken for complete product support:

- Interactive browser exec is blocked until a real same-origin WebSocket bridge is deployed.
- There is no self-service registration, password recovery, password change, or user deletion workflow.
- Groups and Projects can be listed and upserted by name, but they do not have dedicated update/delete endpoints or a complete lifecycle-management workflow.
- The backend defines several Kubernetes CRDs, but Task is the actively reconciled workload abstraction; User, Group, and Project CRDs are not the source of application state, and the Reservation CRD is not functional.
- Queue/job quota enforcement is not identical to direct Task quota enforcement in the current backend and should be reviewed before relying on it as a strict multi-tenant control.
- Registry record deletion does not guarantee registry blob deletion.
- Monitoring, disk usage, energy, CO₂, notification, and storage behavior depend on external infrastructure and may be empty or partial.
- The current frontend is a single operational console, not a general cluster administration interface.

## 11. Maintainer reference map

Use these sources when maintaining the application. When documentation and implementation disagree, verify the behavior in executable code and tests:

### To understand the product

1. This file: `Documentation/00-overview/project-summary.md`.
2. `Documentation/00-overview/current-state-and-gaps.md` for current limitations.
3. Root `README.md` for local setup and the currently configured development backend.

### To understand frontend behavior

1. `components/console-shell.tsx` — current user workflows and role-aware actions.
2. `lib/mlmanage-api.ts` — frontend domain types and HTTP client behavior.
3. `app/api/mlmanage/[...path]/route.ts` — same-origin HTTP trust boundary.
4. `app/api/mlmanage-ws/[...path]/route.ts` — current WebSocket limitation.
5. `tests/mlmanage-live.spec.ts` — live, non-mocked workflow coverage.
6. `Documentation/01-architecture/` and `Documentation/03-frontend-features/` for supporting explanations.

### To understand backend contracts and execution

Use a separate checkout of the MLManage Compute repository. Paths below are relative to that repository:

1. `devops-backend/api/main.py` — real FastAPI service and authoritative endpoint behavior.
2. `Documentation/03-api/` — endpoint, model, and role reference.
3. `devops-backend/controllers/task_controller.py` and `devops-backend/crd/task-crd.yaml` — real-cluster Task-to-Pod behavior.
4. `tests_suite/` — focused security/contract tests and cluster integration suites.
5. `Documentation/00-overview/current-state-and-gaps.md` — backend caveats.
6. `Documentation/02-setup-and-deployment/` and `devops-backend/scripts/` — deployment and operations.

## 12. Repository and change-management notes

- The frontend and backend are separate repositories. Run Git status, diff, tests, and commits independently in each checkout.
- Before changing framework-specific behavior, consult the installed Next.js 16 documentation under `node_modules/next/dist/docs/`.
- Frontend end-to-end tests are live, stateful tests against a real backend through the same-origin proxy; they do not mock backend responses.
- Supply test credentials through the approved secret-management process; never reuse them for production.
- Product documentation should describe intended user behavior and clearly label infrastructure-dependent or incomplete capabilities instead of presenting backend endpoint existence as proof of end-to-end support.
