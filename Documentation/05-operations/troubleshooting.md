# Troubleshooting

## Login fails

Check:

1. Backend is reachable from the Next.js host:

   ```bash
   curl http://<backend-host>:8000/health
   ```

2. `MLMANAGE_API_URL` points to the backend.
3. The browser can reach the Next.js frontend and `/api/mlmanage/health` returns a proxied response.
4. Credentials exist in the backend database.

## Backend service is down after a runtime upgrade

Check the service and logs using the deployment platform's normal operational tooling. If Python modules are missing after an operating-system or interpreter upgrade, follow the parameterized [development VM recovery procedure](../02-setup-and-deployment/backend-development-vm.md#recover-a-broken-python-environment), then verify `/health` and the Chromium suite.

Keep hostnames, account names, filesystem paths, and service credentials in private environment configuration rather than this troubleshooting guide.

## Browser shows backend/network errors

Likely causes:

- wrong `MLMANAGE_API_URL` on the Next.js server;
- backend service not running;
- Next.js server cannot route to the backend host;
- frontend is being served without the `/api/mlmanage` route handler.

The browser should not call the backend host directly in production.

## Jobs do not appear after scheduling

Check:

1. `POST /api/mlmanage/jobs` succeeds in the browser network tab.
2. `GET /api/mlmanage/jobs` returns the new job.
3. The selected GPU reservation window does not conflict with another reservation.
4. Backend scheduler is running if the start time is in the future.

## Active tasks section is empty

This is expected if no scheduled job has been dispatched yet. Future jobs remain under Jobs until the backend scheduler creates a task.

## Metrics are empty

The frontend only displays backend-provided metrics. Empty usage/metrics usually means the backend collector or database has no samples.

## Dev server issues

The dev script uses webpack:

```bash
npm run dev
```

If the server still fails, remove generated output and retry:

```bash
rm -rf .next
npm run dev
```

## Playwright failures

Run Chromium only for faster debugging:

```bash
npm run test:e2e -- --project=chromium
```

Open the generated report:

```bash
npx playwright show-report
```
