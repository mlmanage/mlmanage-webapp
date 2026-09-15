# MLManage Web App Documentation

## Whole documentation map

This page is the starting point for project documentation. Each folder contains a focused `README.md` with more targeted links.

```text
Documentation/
├── README.md                                      # This root map and navigation guide
├── 00-overview/
│   ├── README.md                                  # Overview sub-map
│   ├── project-summary.md                         # Product description, users, capabilities, workflows, and system specification
│   ├── repository-inventory.md                    # Source tree and purpose of important files
│   └── current-state-and-gaps.md                  # Known caveats and backend-dependent behavior
├── 01-architecture/
│   ├── README.md                                  # Architecture sub-map
│   ├── application-architecture.md                # Main UI/runtime components
│   ├── data-flow.md                               # Login, scheduled job, admin, monitoring flows
│   └── backend-integration.md                     # API contracts and frontend configuration
├── 02-setup-and-deployment/
│   ├── README.md                                  # Setup/deployment sub-map
│   ├── prerequisites.md                           # Required tooling and backend assumptions
│   ├── local-development.md                       # Local dev server workflow
│   ├── deployment.md                              # Frontend production build/deployment notes
│   └── backend-development-vm.md                  # Parameterized development-backend deployment runbook
├── 03-frontend-features/
│   ├── README.md                                  # Feature sub-map
│   ├── redesigned-experience.md                   # Workload-centered experience brief
│   ├── views-and-navigation.md                    # Authenticated app views
│   └── scheduled-jobs.md                          # Reservation-backed job scheduling UX
├── 04-development/
│   ├── README.md                                  # Development sub-map
│   ├── modifying-ui.md                            # How to change UI safely
│   └── testing-and-validation.md                  # Lint, typecheck, build, and Playwright checks
├── 05-operations/
│   ├── README.md                                  # Operations sub-map
│   ├── configuration.md                           # Environment variables and browser override
│   └── troubleshooting.md                         # Common frontend/backend connection problems
└── 06-contributor-guide/
    ├── README.md                                  # Contributor guide map
    ├── codebase-entrypoints.md                    # Starting points for common development tasks
    └── change-safety-checklist.md                 # Pre-change and validation checklist
```

## Fast navigation by intent

| If you need to...                                      | Start here                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Understand the product, users, and supported workflows | [`00-overview/project-summary.md`](00-overview/project-summary.md)                                       |
| Locate important files                                 | [`00-overview/repository-inventory.md`](00-overview/repository-inventory.md)                             |
| Understand UI/runtime architecture                     | [`01-architecture/application-architecture.md`](01-architecture/application-architecture.md)             |
| Understand backend API usage                           | [`01-architecture/backend-integration.md`](01-architecture/backend-integration.md)                       |
| Run locally                                            | [`02-setup-and-deployment/local-development.md`](02-setup-and-deployment/local-development.md)           |
| Deploy the frontend                                    | [`02-setup-and-deployment/deployment.md`](02-setup-and-deployment/deployment.md)                         |
| Deploy or recover a development backend VM              | [`02-setup-and-deployment/backend-development-vm.md`](02-setup-and-deployment/backend-development-vm.md) |
| Understand the job scheduling UX                       | [`03-frontend-features/scheduled-jobs.md`](03-frontend-features/scheduled-jobs.md)                       |
| Change UI safely                                       | [`04-development/modifying-ui.md`](04-development/modifying-ui.md)                                       |
| Validate changes                                       | [`04-development/testing-and-validation.md`](04-development/testing-and-validation.md)                   |
| Troubleshoot                                           | [`05-operations/troubleshooting.md`](05-operations/troubleshooting.md)                                   |

## Project in one paragraph

MLManage is a self-hosted internal GPU workload platform. Technical users can prepare container images, run immediate tasks, schedule reservation-backed jobs, submit queue-managed workloads, monitor execution, and retrieve results; trusted roles manage projects, shared storage, users, quotas, GPU partitions, and retention. This repository provides the user-facing web application, while the separately versioned backend owns scheduling and Kubernetes operations. Browsers reach it only through the web application's same-origin `/api/mlmanage` boundary.

## Primary source-code entrypoints

- Main page route: [`../app/page.tsx`](../app/page.tsx)
- Main console component: [`../components/console-shell.tsx`](../components/console-shell.tsx)
- API client and shared types: [`../lib/mlmanage-api.ts`](../lib/mlmanage-api.ts)
- Styling/theme globals: [`../app/globals.css`](../app/globals.css)
- Playwright tests: [`../tests/mlmanage-live.spec.ts`](../tests/mlmanage-live.spec.ts)
- Playwright config: [`../playwright.config.ts`](../playwright.config.ts)

## Important caveats

- The frontend depends on backend endpoints for authentication, users, GPUs, jobs, reservations, tasks, metrics, and usage.
- The current implementation keeps the JWT in browser `localStorage`.
- The dev script explicitly selects the Webpack development bundler.
- Browser API traffic goes to the same-origin Next.js proxy at `/api/mlmanage`; configure the real backend target server-side with `MLMANAGE_API_URL`.
