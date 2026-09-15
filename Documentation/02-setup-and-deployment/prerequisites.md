# Prerequisites

## Required local tooling

- Node.js compatible with Next.js 16.
- npm.
- Browser dependencies required by Playwright if running E2E tests.

Install Playwright browsers if needed:

```bash
npx playwright install
```

## Backend requirements

A reachable MLManage Compute backend is required for real use. The frontend expects the backend to provide:

- JWT login;
- current-user endpoint;
- GPU list;
- jobs API;
- reservation calendar;
- task list/cancel;
- metrics and usage endpoints.

Configure the backend URL for your environment and check its health endpoint:

```bash
export MLMANAGE_API_URL="http://localhost:8000"
curl "$MLMANAGE_API_URL/health"
```

Use an environment-specific hostname when the backend runs elsewhere; do not commit private addresses.

## Repository notes

This project is a Next.js 16 app. Before changing Next.js-specific code, consult the relevant installed framework documentation under:

```text
node_modules/next/dist/docs/
```
