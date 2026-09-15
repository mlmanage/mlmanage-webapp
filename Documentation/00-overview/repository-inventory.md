# Repository inventory

## Root files

| Path | Purpose |
|---|---|
| `README.md` | Concise human-facing overview and setup guide. |
| `package.json` | Scripts, dependencies, and project metadata. |
| `env.example` | Example frontend backend URL configuration. |
| `next.config.ts` | Next.js configuration. |
| `playwright.config.ts` | E2E test configuration and test browser projects. |
| `components.json` | shadcn/ui configuration. |

## Application source

| Path | Purpose |
|---|---|
| `app/layout.tsx` | Root layout, fonts, theme provider, global CSS import. |
| `app/page.tsx` | Home route; renders the authenticated console shell. |
| `app/globals.css` | Tailwind v4, shadcn theme tokens, base styles. |
| `components/console-shell.tsx` | Main client-side app: auth, navigation, forms, views, API orchestration. |
| `components/theme-provider.tsx` | Theme provider wrapper. |
| `components/ui/button.tsx` | shadcn button component. |
| `lib/mlmanage-api.ts` | Shared API types, fetch wrapper, error handling, date/command helpers. |
| `lib/utils.ts` | `cn()` utility for class name merging. |

## Tests

| Path | Purpose |
|---|---|
| `tests/*.spec.ts` | Focused live-backend Playwright suites for jobs, capacity, reservations, usage, accounts, roles, layout, and proxy behavior. |
| `tests/mlmanage-live.spec.ts` | Consolidated live workflow coverage across the main product areas. |
| `tests/support/` | Shared API, account, fixture, cleanup, and image-archive helpers. |
| `tests/global-teardown.ts` | Final cleanup of test-prefixed backend records. |
| `playwright.config.ts` | Runs Chromium, Firefox, and WebKit and configures the application server. |

## Generated or external files

| Path | Notes |
|---|---|
| `node_modules/` | Installed dependencies and framework documentation; not committed. |
| `.next/` | Next.js build/dev output; not committed. |
| `test-results/`, `playwright-report/` | Playwright output; not committed. |
