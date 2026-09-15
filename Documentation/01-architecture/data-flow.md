# Data flow

## Login flow

```text
User submits username/password
→ POST /login with JSON `{ username, password }`
→ store access_token in localStorage
→ GET /me
→ load private app data
→ render authenticated shell
```

If `/me` fails, the frontend removes the saved token and returns to the sign-in flow.

## Initial data loading

On refresh or sign-in, the frontend loads:

```text
Before authentication:
- GET /health

After authentication:
- GET /me
- GET /jobs
- GET /tasks
- view-specific requests for capacity, reservations, projects, usage, and administration
```

Role-restricted data is loaded only for views available to the signed-in account. A failed session check returns the user to the sign-in flow.

## Scheduled job flow

```text
User enters image, command, resource limits, GPU, start, end
→ POST /jobs
→ backend creates reservation
→ backend stores job record
→ if start time is now/past, backend dispatches task immediately
→ otherwise backend scheduler dispatches task when due
→ UI refreshes Jobs and Capacity views
```

The frontend does not ask users to create reservations separately. A reservation is part of the scheduled job.

## Active task flow

```text
GET /tasks
→ filter out cancelled/completed/failed/succeeded tasks
→ show remaining items under Active tasks
```

Active tasks are backend task records that have already been dispatched by the scheduler. Scheduled future work remains in Jobs.

## Admin account flow

```text
Admin enters username, password, role, quotas
→ POST /users
→ refresh GET /users
```

The backend is responsible for namespace creation and quota persistence.

## Usage flow

```text
Authenticated user selects a period and permitted scope
→ GET /analytics/usage
→ GET /analytics/activity
→ render allocation, utilization, energy, carbon, and workload activity

Authenticated user opens hardware telemetry
→ GET /gpu/usage
→ render available memory, power, temperature, and utilization samples

Administrator optionally selects another account
→ GET /gpu/usage/{username}
→ render that account's permitted telemetry
```

Usage and telemetry sections may be empty when the backend has not collected samples. The Prometheus `/metrics` endpoint is intended for monitoring infrastructure and is not displayed in the application.
