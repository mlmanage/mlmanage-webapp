/**
 * Groups and projects: the shared allocations jobs can be charged to.
 *
 * Covers create, prefilled edit, delete, membership editing, per-model allocations, the
 * role boundary around each action, and carrying a project into New job. The per-model
 * quota fields are generated from the accelerator models the deployment reports, and the
 * stored key is checked against the normalisation the backend's quota check performs.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import {
  acceptNextConfirm,
  apiList,
  auth,
  dismissNextConfirm,
  ensureRoleAccounts,
  expectToast,
  goTo,
  inventory,
  loginApi,
  modal,
  powerUser,
  signIn,
  signInAsAdmin,
  sweep,
  unique,
  workloadUser,
} from "./support/mlmanage"

type GroupRecord = {
  name: string
  total_gpus?: number
  total_disk_gb?: number
  gpu_quota_by_type?: Record<string, number> | string | null
  members?: string[] | null
}
type ProjectRecord = GroupRecord & {
  owner?: string | null
  shared_storage_gb?: number
}

/** How the backend's `normalize_gpu_type` keys a quota map. */
const quotaKey = (product: string) => (product || "unknown").trim().replace(/\s+/g, "-")

const asMap = (value: Record<string, number> | string | null | undefined) =>
  typeof value === "string"
    ? (JSON.parse(value || "{}") as Record<string, number>)
    : value || {}

const groups = (request: APIRequestContext, token: string) =>
  apiList<GroupRecord>(request, token, "/groups", "groups")
const projects = (request: APIRequestContext, token: string) =>
  apiList<ProjectRecord>(request, token, "/projects", "projects")

/** The list row for a named group or project. */
function recordRow(page: Page, name: string) {
  return page.getByText(name, { exact: true }).locator("xpath=../..")
}

async function addMember(page: Page, username: string) {
  await page.getByLabel("Search members").fill(username)
  await page.getByRole("button", { name: "Add", exact: true }).click()
  await expect(page.getByRole("button", { name: `Remove ${username}` })).toBeVisible()
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser, powerUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("an administrator creates, edits and deletes a group with members and allocations", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const name = unique("group")

  await signInAsAdmin(page, request)
  await goTo(page, "Projects")
  await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible()
  await page.getByRole("button", { name: "Create group" }).click()
  const dialog = modal(page, /Create group/)

  // A name is the one thing a group cannot do without.
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
  await dialog.getByLabel("Group name").fill(name)
  await dialog.getByLabel("Total accelerators").fill("3")
  await dialog.getByLabel("Shared storage (GiB)").fill("40")

  // Membership: only real accounts, no duplicates, and removable again.
  await dialog.getByLabel("Search members").fill("mlm-live-nobody")
  await expect(dialog.getByRole("button", { name: "Add", exact: true })).toBeDisabled()
  await addMember(page, workloadUser.username)
  await dialog.getByLabel("Search members").fill(workloadUser.username)
  await expect(dialog.getByRole("button", { name: "Add", exact: true })).toBeDisabled()
  await addMember(page, powerUser.username)
  await dialog.getByRole("button", { name: `Remove ${powerUser.username}` }).click()
  await expect(
    dialog.getByRole("button", { name: `Remove ${powerUser.username}` })
  ).toHaveCount(0)

  // Per-model limits: one field per accelerator model the cluster reports.
  const product = detected.products[0]
  if (product) await dialog.getByLabel(`${product} accelerator limit`).fill("2")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expectToast(page, "Saved")

  await expect
    .poll(async () => (await groups(request, token)).find((item) => item.name === name), {
      timeout: 30_000,
    })
    .toMatchObject({ total_gpus: 3, total_disk_gb: 40 })
  const record = (await groups(request, token)).find((item) => item.name === name)!
  expect(record.members).toEqual([workloadUser.username])
  if (product) expect(asMap(record.gpu_quota_by_type)[quotaKey(product)]).toBe(2)

  const row = recordRow(page, name)
  await expect(row).toContainText(workloadUser.username)
  await expect(row).toContainText("3 accelerators")
  await expect(row).toContainText("40 GiB shared")
  if (product) await expect(row).toContainText(`Per model: ${quotaKey(product)}: 2`)

  // Editing starts from the existing record rather than an empty form.
  await row.getByRole("button", { name: "Edit" }).click()
  const edit = modal(page, /Edit group/)
  await expect(edit.getByLabel("Group name")).toHaveValue(name)
  await expect(edit.getByLabel("Total accelerators")).toHaveValue("3")
  await expect(edit.getByLabel("Shared storage (GiB)")).toHaveValue("40")
  if (product)
    await expect(edit.getByLabel(`${product} accelerator limit`)).toHaveValue("2")
  await edit.getByLabel("Total accelerators").fill("5")
  await addMember(page, powerUser.username)
  await edit.getByRole("button", { name: "Save", exact: true }).click()
  await expectToast(page, "Saved")
  await expect
    .poll(async () => (await groups(request, token)).find((item) => item.name === name), {
      timeout: 30_000,
    })
    .toMatchObject({ total_gpus: 5 })
  await expect(recordRow(page, name)).toContainText(powerUser.username)

  // Deleting asks first, and declining keeps the group.
  dismissNextConfirm(page)
  await recordRow(page, name).getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
  acceptNextConfirm(page)
  await recordRow(page, name).getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(name, { exact: true })).toHaveCount(0)
  expect((await groups(request, token)).some((item) => item.name === name)).toBe(false)
})

test("a power user manages projects but cannot create a group", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, powerUser)
  const detected = await inventory(request, token)
  const name = unique("pu-project")

  await signIn(page, powerUser)
  await goTo(page, "Projects")
  // Creating groups is administrator-only; creating projects is not.
  await expect(page.getByRole("button", { name: "Create group" })).toHaveCount(0)
  await page.getByRole("button", { name: "Create project" }).click()
  const dialog = modal(page, /Create project/)
  await dialog.getByLabel("Project name").fill(name)
  await dialog.getByLabel("Total accelerators").fill("2")
  await dialog.getByLabel("Shared storage (GiB)").fill("15")
  // `GET /users` is administrator-only, so a power user has no account list to search.
  // The form must still let them name a member of the project they are allowed to create.
  await expect(page.getByText("Type a username, then add them")).toBeVisible()
  await addMember(page, workloadUser.username)
  const product = detected.products[0]
  if (product) await dialog.getByLabel(`${product} accelerator limit`).fill("1")
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expectToast(page, "Saved")

  await expect
    .poll(
      async () => (await projects(request, token)).find((item) => item.name === name),
      { timeout: 30_000 }
    )
    .toMatchObject({ total_gpus: 2, shared_storage_gb: 15 })
  const record = (await projects(request, token)).find((item) => item.name === name)!
  expect(record.members).toContain(workloadUser.username)
  if (product) expect(asMap(record.gpu_quota_by_type)[quotaKey(product)]).toBe(1)

  const row = recordRow(page, name)
  await expect(row).toContainText("2 accelerators")
  await expect(row).toContainText("15 GiB shared")
  await row.getByRole("button", { name: "Edit" }).click()
  const edit = modal(page, /Edit project/)
  await expect(edit.getByLabel("Project name")).toHaveValue(name)
  await expect(edit.getByLabel("Shared storage (GiB)")).toHaveValue("15")
  await edit.getByLabel("Shared storage (GiB)").fill("25")
  await edit.getByRole("button", { name: "Save", exact: true }).click()
  await expectToast(page, "Saved")
  await expect
    .poll(
      async () => (await projects(request, token)).find((item) => item.name === name),
      { timeout: 30_000 }
    )
    .toMatchObject({ shared_storage_gb: 25 })

  acceptNextConfirm(page)
  await recordRow(page, name).getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(name, { exact: true })).toHaveCount(0)

  // The backend enforces the same boundary on groups.
  const attempt = await request.post("/api/mlmanage/groups", {
    headers: auth(token),
    data: { name: unique("pu-group"), total_gpus: 1 },
    failOnStatusCode: false,
  })
  expect(attempt.status()).toBe(403)
})

test("an owner can be chosen from the accounts the backend knows", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const accounts = await apiList<{ username: string }>(request, token, "/users", "users")
  const name = unique("owned-project")

  await signInAsAdmin(page, request)
  await goTo(page, "Projects")
  await page.getByRole("button", { name: "Create project" }).click()
  const dialog = modal(page, /Create project/)
  await dialog.getByLabel("Project name").fill(name)
  const owner = dialog.getByLabel("Owner")
  for (const account of accounts.slice(0, 5))
    await expect(owner.locator("option", { hasText: account.username })).toHaveCount(1)
  await owner.selectOption(workloadUser.username)
  await dialog.getByRole("button", { name: "Save", exact: true }).click()
  await expectToast(page, "Saved")
  await expect
    .poll(
      async () => (await projects(request, token)).find((item) => item.name === name),
      { timeout: 30_000 }
    )
    .toMatchObject({ owner: workloadUser.username })
  await expect(recordRow(page, name)).toContainText(`Owner: ${workloadUser.username}`)
})

test("a plain workload account reads shared allocations without changing them", async ({
  page,
  request,
}) => {
  const adminToken = await loginApi(request)
  const project = unique("readable-project")
  const group = unique("readable-group")
  for (const [path, data] of [
    ["/projects", { name: project, owner: "admin", total_gpus: 1 }],
    ["/groups", { name: group, total_gpus: 1 }],
  ] as const) {
    const created = await request.post(`/api/mlmanage${path}`, {
      headers: auth(adminToken),
      data,
      failOnStatusCode: false,
    })
    expect([200, 201]).toContain(created.status())
  }

  await signIn(page, workloadUser)
  await goTo(page, "Projects")
  await expect(page.getByText(project, { exact: true })).toBeVisible()
  await expect(page.getByText(group, { exact: true })).toBeVisible()
  for (const control of ["Create group", "Create project", "Edit", "Delete", "Shared storage"])
    await expect(page.getByRole("button", { name: control })).toHaveCount(0)

  const token = await loginApi(request, workloadUser)
  for (const path of ["/groups", "/projects"]) {
    const attempt = await request.post(`/api/mlmanage${path}`, {
      headers: auth(token),
      data: { name: unique("denied"), total_gpus: 1 },
      failOnStatusCode: false,
    })
    expect(attempt.status(), `POST ${path} as user`).toBe(403)
  }
})

test("New job started from a project row is charged to that project", async ({
  page,
  request,
}) => {
  const adminToken = await loginApi(request)
  const token = await loginApi(request, workloadUser)
  const project = unique("carry-project")
  const created = await request.post("/api/mlmanage/projects", {
    headers: auth(adminToken),
    data: {
      name: project,
      owner: workloadUser.username,
      members: [workloadUser.username],
      total_gpus: 2,
    },
    failOnStatusCode: false,
  })
  expect([200, 201]).toContain(created.status())
  const name = unique("project-job")

  await signIn(page, workloadUser)
  await goTo(page, "Projects")
  await recordRow(page, project).getByRole("button", { name: "New job" }).click()
  const sheet = page.getByRole("dialog", { name: "What should run?" })
  await expect(sheet).toBeVisible()
  await expect(page.getByLabel("Project", { exact: true })).toHaveValue(project)

  await page.getByLabel("Job name").fill(name)
  await page.getByRole("tab", { name: "external" }).click()
  await page.getByLabel("External pull reference").fill("alpine:latest")
  await page.getByLabel("Command").fill("true")
  await page.getByLabel("Accelerators needed").fill("0")
  await page.getByRole("button", { name: "Queue job" }).click()
  await expectToast(page, "Job added to queue")
  await expect
    .poll(
      async () =>
        (
          await apiList<{ display_name?: string | null; project?: string | null }>(
            request,
            token,
            "/queue",
            "queue"
          )
        ).find((item) => item.display_name === name)?.project,
      { timeout: 30_000 }
    )
    .toBe(project)

  // A project the account is not a member of is rejected by the backend.
  const foreign = unique("foreign-project")
  const other = await request.post("/api/mlmanage/projects", {
    headers: auth(adminToken),
    data: { name: foreign, owner: "admin", members: ["admin"], total_gpus: 1 },
    failOnStatusCode: false,
  })
  expect([200, 201]).toContain(other.status())
  const denied = await request.post("/api/mlmanage/queue", {
    headers: auth(token),
    data: {
      display_name: unique("denied-job"),
      image: "alpine:latest",
      command: ["true"],
      gpus: 1,
      project: foreign,
    },
    failOnStatusCode: false,
  })
  expect(denied.status()).toBe(403)
})

test("the empty states explain what a group and a project are for", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const existingGroups = await groups(request, token)
  const existingProjects = await projects(request, token)

  await signInAsAdmin(page, request)
  await goTo(page, "Projects")
  await expect(
    page.getByText(/Groups share accelerator and storage allocations across their members/)
  ).toBeVisible()
  await expect(
    page.getByText(/Project jobs use this project’s shared accelerator allocation/)
  ).toBeVisible()
  if (!existingGroups.length)
    await expect(page.getByText(/No groups yet\./)).toBeVisible()
  if (!existingProjects.length)
    await expect(page.getByText(/No projects yet\./)).toBeVisible()
  // The lists are scrollable regions rather than an unbounded page.
  await expect(page.getByRole("region", { name: "Groups list" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Projects list" })).toBeVisible()
})
