# Configuration

## Environment variables

| Variable | Required | Purpose | Default |
|---|---:|---|---|
| `MLMANAGE_API_URL` | Recommended | Backend API base URL used by the Next.js server-side proxy. | `http://localhost:8000` |
| `MLM_ALLOWED_DEV_ORIGINS` | Optional | Comma-separated hosts allowed to load Next.js development assets. | `localhost` |

Example:

```bash
MLMANAGE_API_URL=http://localhost:8000
```

## Browser API path

The browser should call the same-origin Next.js route handler:

```text
/api/mlmanage
```

The route handler in `app/api/mlmanage/[...path]/route.ts` forwards requests to `MLMANAGE_API_URL`. This keeps production browser traffic from directly reaching the Kubernetes/backend API host.

## UI status indicator

Authenticated users can see a backend status pill in the sidebar. A green dot means the Next.js proxy can reach the backend, amber means the check is in progress, and red means the backend is offline or misconfigured. The real backend URL is server-side configuration and is not editable in browser UI.

## Token storage

The JWT access token is stored in browser `localStorage`:

```text
mlmanage.token
```

Use Sign out to remove it. For manual cleanup, clear site data or remove the key in developer tools.

## Changing backend URL after deployment

Update `MLMANAGE_API_URL` in the runtime environment for the Next.js server and restart/redeploy the app as required by the hosting platform. Browser bundles do not need a direct backend URL.
