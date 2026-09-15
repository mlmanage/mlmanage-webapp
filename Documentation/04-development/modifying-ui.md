# Modifying UI

## Before editing

1. For Next.js behavior, read relevant docs under `node_modules/next/dist/docs/`.
2. Check `Documentation/00-overview/current-state-and-gaps.md` for caveats.
3. Check backend docs if changing API expectations.

## Common edit locations

| Change type | Start here |
|---|---|
| Add or change a view | `components/console-shell.tsx` |
| Change API request/response types | `lib/mlmanage-api.ts` |
| Change route-level rendering | `app/page.tsx`, `app/layout.tsx` |
| Change theme/global styling | `app/globals.css` |
| Change E2E coverage | `tests/mlmanage-live.spec.ts` |

## UI structure guidance

`components/console-shell.tsx` currently contains the main shell and view functions. If a view becomes large, split it into a dedicated component file, for example:

```text
components/views/jobs-view.tsx
components/views/resources-view.tsx
components/views/admin-view.tsx
```

Keep API types in `lib/mlmanage-api.ts` so tests and components share one contract.

## Form/layout guidance

- Keep login focused; do not add operational controls to the unauthenticated screen.
- Do not add UI for editing the backend URL; configure it with `MLMANAGE_API_URL` in the server environment/config file and keep only a status indicator in the UI.
- Do not add demo image buttons; users should provide their own images.
- Keep resource inputs compact but wide enough for values like `32Gi` and datetime controls.
- Add Playwright layout checks when changing form grids.

## Backend changes

Prefer frontend-only changes. If a frontend feature requires backend support, keep backend changes minimal and document the endpoint expectation in `Documentation/01-architecture/backend-integration.md`.
