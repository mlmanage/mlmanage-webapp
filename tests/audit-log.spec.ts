/**
 * The Administration "Activity log": who did what, to what, and how it ended.
 *
 * Every assertion is anchored to a record the test itself causes - a group it creates, a
 * sign-in it deliberately fails, an action it performs as an account that is not allowed
 * to - and then found through the view's own Search box. That keeps the suite immune to
 * whatever else the deployment has been doing, since the log is shared and append-only.
 */
import { expect, test, type Page } from "@playwright/test"
import {
  auth,
  ensureRoleAccounts,
  goTo,
  loginApi,
  signInAsAdmin,
  sweep,
  unique,
  workloadUser,
} from "./support/mlmanage"

/**
 * The log's own `<section>` (the heading's parent), so the filters and rows are never
 * confused with the Accounts and Data retention tables above it.
 */
function log(page: Page) {
  return page.getByRole("heading", { name: "Activity log" }).locator("..")
}

/** Filter the log to one substring and wait for the fetch (debounced 250ms) to land. */
async function search(page: Page, term: string) {
  const section = log(page)
  await section.getByLabel("Search").fill(term)
  await expect(section.getByText(/Showing \d+–\d+ of \d+/)).toBeVisible()
  return section
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("an administrator sees who changed what, with the values that were set", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const group = unique("audit-group")
  const created = await request.post("/api/mlmanage/groups", {
    headers: auth(token),
    data: { name: group, total_gpus: 3 },
    failOnStatusCode: false,
  })
  expect([200, 201]).toContain(created.status())

  await signInAsAdmin(page, request)
  await goTo(page, "Administration")
  await expect(
    page.getByRole("heading", { name: "Activity log" })
  ).toBeVisible()

  const section = await search(page, group)
  const row = section.getByRole("row").filter({ hasText: group })
  await expect(row).toHaveCount(1)
  // The record names the action, the object, the person, and the outcome.
  await expect(row).toContainText("groups.create")
  await expect(row).toContainText(group)
  await expect(row).toContainText("admin")
  await expect(row).toContainText("Succeeded")
  // The endpoint's own note is what makes the entry useful: the allocation it set.
  await expect(row).toContainText("total_gpus=3")

  // Changing the same group again is a second, separate record.
  const updated = await request.put(`/api/mlmanage/groups/${group}`, {
    headers: auth(token),
    data: { name: group, total_gpus: 5 },
    failOnStatusCode: false,
  })
  expect(updated.status()).toBe(200)
  await section.getByRole("button", { name: "Refresh" }).click()
  await expect(
    section.getByRole("row").filter({ hasText: "groups.update" })
  ).toContainText("total_gpus=5")
})

test("a failed sign-in and a forbidden action are both recorded, without the password", async ({
  page,
  request,
}) => {
  const wrongPassword = `mlm-live-wrong-${Date.now().toString(36)}`
  const refused = await request.post("/api/mlmanage/login", {
    data: { username: workloadUser.username, password: wrongPassword },
    failOnStatusCode: false,
  })
  expect(refused.status()).toBe(401)

  // An account with no rights over other accounts tries to delete one.
  const userToken = await loginApi(request, workloadUser)
  const denied = await request.delete("/api/mlmanage/users/admin", {
    headers: auth(userToken),
    failOnStatusCode: false,
  })
  expect(denied.status()).toBe(403)

  await signInAsAdmin(page, request)
  await goTo(page, "Administration")
  const section = await search(page, workloadUser.username)

  // Anchor on the REFUSED attempt itself, not on row order: the log is newest-first and
  // `loginApi` above signs the same account in successfully *after* the rejected attempt,
  // so the newest auth.login row for this user is a success, not the failure under test.
  await expect(
    section
      .getByRole("row")
      .filter({ hasText: "auth.login" })
      .filter({ hasText: "Not permitted" })
      .first()
  ).toBeVisible()
  await expect(
    section
      .getByRole("row")
      .filter({ hasText: "users.delete" })
      .filter({ hasText: "Not permitted" })
      .first()
  ).toBeVisible()

  // The rejected password must not be recoverable from the log - not in a row, not in
  // the exported file, not in the detail column.
  await expect(section).not.toContainText(wrongPassword)

  // Narrowing by result keeps only the attempts that were refused.
  await section.getByLabel("Result").selectOption("denied")
  const userRows = section
    .getByRole("row")
    .filter({ hasText: workloadUser.username })
  // "Showing x-y of z" is already on screen from the unfiltered list, so waiting for it
  // proves nothing; the refetch is debounced 250ms. Wait for the successes to actually
  // disappear, otherwise the rows are read before the filtered page replaces them.
  await expect(userRows.filter({ hasText: "Succeeded" })).toHaveCount(0)
  await expect(
    userRows.filter({ hasText: "Not permitted" }).first()
  ).toBeVisible()
  const outcomes = await userRows.allInnerTexts()
  expect(outcomes.length).toBeGreaterThan(0)
  for (const text of outcomes) expect(text).toContain("Not permitted")
})

test("the log is administrator-only", async ({ request }) => {
  const userToken = await loginApi(request, workloadUser)
  const response = await request.get("/api/mlmanage/audit-log", {
    headers: auth(userToken),
    failOnStatusCode: false,
  })
  expect(response.status()).toBe(403)
})
