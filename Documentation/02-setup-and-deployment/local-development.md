# Local development

## Install dependencies

```bash
npm install
```

## Configure backend

Copy the example env file:

```bash
cp env.example .env.local
```

Set the backend URL for your environment. For example, when the backend runs locally:

```bash
MLMANAGE_API_URL=http://localhost:8000
```

Keep machine-specific addresses and credentials in `.env.local`, which must remain untracked.

The browser calls the local Next.js app at `/api/mlmanage`; the Next.js route handler proxies to `MLMANAGE_API_URL`.

## Start dev server

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Alternatively, `./backend_server.sh` serves the app on `3001` and forwards the cluster's monitoring
stack to `3002` (Grafana) and `3003` (Prometheus); `--monitoring` starts only those two,
`--tunnel` only the backend API tunnel on `8001`.

### Optional backend and monitoring tunnels

`backend_server.sh` can supervise SSH and Kubernetes port forwards when the backend is not directly reachable:

```bash
./backend_server.sh --tunnel
./backend_server.sh --monitoring
./backend_server.sh --stop
```

Configure its connection values with environment variables rather than documenting a personal host or account. The script writes runtime state under `.run/`; use its log files to diagnose connection or port conflicts. Note that `--stop` also stops the web app on port `3001`.

Obtain development credentials from the backend operator or a private secrets channel. Do not commit bootstrap or shared credentials to project documentation.

## Why dev uses webpack

`package.json` runs:

```bash
next dev --webpack
```

The development script explicitly selects Webpack. Production builds still use the normal `next build` command.

## Useful development commands

```bash
npm run lint
npm run typecheck
npm run build
npm run test:e2e
```
