# Codebase entrypoints

## Understanding the project

Start with:

1. `README.md`
2. `Documentation/README.md`
3. `Documentation/00-overview/project-summary.md`
4. `Documentation/00-overview/current-state-and-gaps.md`

## Changing the UI

Start with:

1. Relevant Next.js documentation under `node_modules/next/dist/docs/`
2. `Documentation/04-development/modifying-ui.md`
3. `components/console-shell.tsx`
4. `lib/mlmanage-api.ts`
5. `tests/mlmanage-live.spec.ts`

## Changing API integration

Start with:

1. `Documentation/01-architecture/backend-integration.md`
2. `lib/mlmanage-api.ts`
3. `Documentation/03-api/endpoints.md` in a separate MLManage Compute checkout
4. `devops-backend/api/main.py` in that backend checkout, if a backend change is required

## Updating tests

Start with:

1. `Documentation/04-development/testing-and-validation.md`
2. `playwright.config.ts`
3. The relevant specification under `tests/`

## Running or deploying the application

Start with:

1. `README.md`
2. `Documentation/02-setup-and-deployment/local-development.md`
3. `Documentation/02-setup-and-deployment/deployment.md`
