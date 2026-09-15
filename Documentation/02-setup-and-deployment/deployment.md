# Deployment

## Build

Build the frontend normally:

```bash
npm run build
```

Configure the backend target as a server-side runtime environment variable for the deployed Next.js app:

```bash
MLMANAGE_API_URL=https://mlmanage-api.example.org
```

## Start production server

```bash
npm run start
```

By default Next.js serves on port 3000. Use your process manager, container runtime, or platform settings to expose it.

## Split frontend/backend deployment

The frontend and backend can run on different machines. Requirements:

1. Browser can reach the Next.js frontend.
2. Next.js server can reach the backend URL from `MLMANAGE_API_URL`.
3. Browser application API requests stay same-origin through `/api/mlmanage`.
4. Backend has admin/user data and Kubernetes integration configured.

Backend CORS is no longer on the production browser path because the browser does not call the backend host directly.

## Container deployment notes

A minimal production container should:

1. install dependencies;
2. run `npm run build`;
3. start with `MLMANAGE_API_URL` set and `npm run start`.

Changing the backend URL after deployment is a server/runtime configuration change rather than a browser bundle change, though the app may still need a process restart depending on the platform.

## Pre-deployment validation

Run before shipping:

```bash
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```
