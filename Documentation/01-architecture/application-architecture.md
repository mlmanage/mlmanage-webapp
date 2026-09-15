# Application architecture

## Runtime model

The application uses the Next.js App Router. `app/page.tsx` is a server component that renders `ConsoleShell`, which is a client component because it needs browser state, event handlers, `localStorage`, and direct API calls.

```text
app/page.tsx
└── components/console-shell.tsx
    ├── login gate
    ├── authenticated shell/navigation
    ├── Jobs view
    ├── Capacity view
    ├── Projects view
    ├── Usage view
    ├── My account view
    ├── Administration view
    └── backend status indicator
```

## Main modules

| Module | Responsibility |
|---|---|
| `app/page.tsx` | Minimal route entrypoint. |
| `components/console-shell.tsx` | UI state, auth state, navigation, forms, and view rendering. |
| `lib/mlmanage-api.ts` | API types, `apiRequest()`, `ApiError`, date helpers, command parsing. |
| `components/ui/button.tsx` | shadcn button primitive. |
| `app/globals.css` | Theme tokens and global styles. |

## State ownership

`ConsoleShell` owns the current state for:

- backend status;
- JWT token and current user;
- selected view;
- GPU inventory;
- reservations;
- jobs;
- active tasks;
- users;
- usage, activity, and hardware telemetry;
- form state for login, job creation, and account creation.

The state is intentionally colocated while the app is still small. If the UI grows, split each view into its own file and move API operations into dedicated hooks.

## Navigation model

Unauthenticated users see only the sign-in card. Authenticated users see a sidebar with role-aware navigation:

- Jobs
- Capacity
- Projects
- Usage
- My account
- Administration, only for `admin`

A clear backend status pill appears in the sidebar. Backend target configuration is not editable in the UI; it is supplied through the Next.js server environment/config file.

This keeps the homepage focused and avoids exposing operational controls before login.

## Styling approach

The UI uses Tailwind utility classes and shadcn-style design tokens. Inputs are intentionally compact in resource sections to prevent resource fields from dominating the workflow.
