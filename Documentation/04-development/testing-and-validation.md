# Testing and validation

## Standard checks

Run these before handing off frontend changes:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:e2e -- --project=chromium
```

`npm run test:e2e` without a project runs all configured browsers.

## Live backend requirement

Playwright tests are live end-to-end tests. They use the app and the same-origin Next.js proxy (`/api/mlmanage/...`) against the deployed dev backend; they do not mock backend responses.

Point the suite at a disposable backend environment:

```bash
export MLMANAGE_API_URL="http://localhost:8000"
curl "$MLMANAGE_API_URL/health"
npm run dev
```

The Playwright config passes `MLMANAGE_API_URL` to the Next.js web server. Tests also install a browser request guard that fails if browser code contacts a backend URL directly instead of using the same-origin proxy.

## Development credentials

Supply role-specific test accounts through the approved secret-management process. The suite may also create unique temporary users and resources for isolation; run it only against an environment where that is safe.

## Current live Playwright coverage

The Chromium live suite covers:

- login/session and same-origin network boundary;
- role-gated navigation and readonly hiding of mutation controls;
- custom image upload/list/delete with a real upload progress path and use of the returned `pull_ref` in job and queue forms;
- scheduled-job creation and backend persistence of top-level `vram_limit_gb`, project, and priority fields, plus job list/cancel controls;
- task and legacy-execution listing, cancellation controls, log retrieval, result listing, and same-origin exec bridge status;
- queue submission/list rendering with priority, replicas, and VRAM fields plus cancellation controls;
- reservation creation/list rendering, priority/MIG profile inputs, iCal URL copy, and a real `.ics` import request;
- dynamically discovered GPU inventory, capabilities/partition read UI, simulated-inventory handling, and admin partition mutation form;
- cleanup settings get/update, including result-helper idle TTL;
- analytics grouped by user/team/project with energy/CO₂ fields;
- authenticated self GPU usage display, admin-only cross-user authorization, and memory/power/temperature columns;
- disk/workspace usage view;
- team shared storage form for admin/poweruser;
- user edit flow including email, Slack ID, team, priority, and structured per-model accelerator and VRAM limits;
- groups/projects create/list and project selection in run forms;
- desktop and narrow-screen overflow regression checks.

## Environment-dependent paths

A lightweight backend may expose local-development fallbacks without a real Kubernetes cluster, registry, GPU Operator, or Next.js WebSocket upgrade bridge. Hardware partition application and fully interactive exec require the corresponding production infrastructure and a same-origin WebSocket bridge.

Tests assert that the UI exposes these paths and reports backend or bridge status without using mocks or direct browser-to-backend URLs.
