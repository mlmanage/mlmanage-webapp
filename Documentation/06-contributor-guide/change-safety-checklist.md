# Change safety checklist

## Before changing code

- [ ] Read the relevant Next.js documentation under `node_modules/next/dist/docs/`.
- [ ] Check `Documentation/00-overview/current-state-and-gaps.md`.
- [ ] Determine whether the change is frontend-only or requires backend API support.
- [ ] Avoid broad backend changes unless they are required for the frontend behavior.

## While changing the UI

- [ ] Keep the unauthenticated screen focused on login.
- [ ] Keep backend URL configuration out of the UI; use `MLMANAGE_API_URL` in the server environment and expose only backend status in the interface.
- [ ] Keep job creation and reservation creation unified.
- [ ] Preserve support for custom images and commands.
- [ ] Avoid promotional or requirements text in operational UI.
- [ ] Check compact input layouts for overflow.
- [ ] Preserve role-aware Administration visibility.

## Before submitting a change

Run:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```

If API integration changed, also smoke-test against a suitable live backend.

Record the validation performed, relevant backend assumptions, and any known residual risks in the change description.
