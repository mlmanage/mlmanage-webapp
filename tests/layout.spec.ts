/**
 * Layout and keyboard behaviour: no horizontal overflow on any view at desktop or phone
 * width, the mobile navigation drawer and job-detail sheet, and the focus contract every
 * dialog in the console shares (focus moves in, Tab is trapped, Escape closes, focus
 * returns to whatever opened it).
 *
 * The compact resource grids in New job are the usual source of overflow regressions, so
 * they are checked with long values in every field rather than with defaults.
 */
import { expect, test, type Page } from "@playwright/test"
import {
  auth,
  ensureRoleAccounts,
  expectNoOverflow,
  futureWindow,
  goTo,
  loginApi,
  openAdvancedScheduling,
  openNewJob,
  readonlyUser,
  signIn,
  signInAsAdmin,
  sweep,
  toLocalInput,
  unique,
} from "./support/mlmanage"

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }
const NARROW_DESKTOP = { width: 1024, height: 720 }

const VIEWS = [
  "Jobs",
  "Capacity",
  "Projects",
  "Usage",
  "My account",
  "Administration",
] as const

async function everyView(page: Page, run: (view: string) => Promise<void>) {
  for (const view of VIEWS) {
    await goTo(page, view)
    await run(view)
  }
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [readonlyUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("no view overflows horizontally at desktop, narrow desktop or phone width", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  await signInAsAdmin(page, request)
  for (const size of [DESKTOP, NARROW_DESKTOP, PHONE]) {
    await page.setViewportSize(size)
    await everyView(page, async (view) => {
      await expectNoOverflow(page)
      expect(
        await page.evaluate(() => document.body.scrollWidth),
        `${view} at ${size.width}px`
      ).toBeLessThanOrEqual(size.width + 2)
    })
  }
})

test("New job stays inside the sheet with long values in every resource field", async ({
  page,
  request,
}) => {
  const window = futureWindow(2)
  await signInAsAdmin(page, request)
  for (const size of [DESKTOP, PHONE]) {
    await page.setViewportSize(size)
    await openNewJob(page)
    // The sheet keeps the draft between openings on purpose, so the timing chosen at the
    // end of the previous pass has to be reset before the ASAP fields are filled again.
    await page.getByRole("button", { name: /As soon as possible/ }).click()
    await page.getByLabel("Job name").fill("mlm-live-a-deliberately-long-job-name-here")
    await page.getByRole("tab", { name: "external" }).click()
    await page
      .getByLabel("External pull reference")
      .fill("registry.example.com/a-long-team-name/a-long-image-name:2026-06-01-build-12345")
    await page
      .getByLabel("Command")
      .fill("python\n-m\ntorch.distributed.run\n--nproc-per-node\n8\ntrain.py")
    await page.getByLabel("CPU cores").fill("128")
    await page.getByLabel("Memory size").fill("1024")
    await page.getByLabel("Memory unit").selectOption("Gi")
    await page.getByLabel("Temporary disk size").fill("4096")
    await page.getByLabel("Temporary disk unit").selectOption("Gi")
    await page.getByLabel("GPU memory (GB)").fill("80")
    await page.getByLabel("Run time limit").fill("336")
    await openAdvancedScheduling(page)
    await page.getByLabel("Priority").fill("100")
    await page.getByLabel("Parallel copies").fill("64")
    await expectNoOverflow(page)

    // The datetime controls of the scheduled path are the widest inputs in the form.
    await page.getByRole("button", { name: /Schedule Exact reservation window/ }).click()
    await page.getByLabel("Start").fill(await toLocalInput(page, window.start))
    await page.getByLabel("End").fill(await toLocalInput(page, window.end))
    await expect(page.getByText("Checking the shared schedule…")).toHaveCount(0, {
      timeout: 30_000,
    })
    await expectNoOverflow(page)
    // The submit button stays reachable however long the form gets.
    const submit = page.getByRole("button", { name: "Schedule job" })
    await expect(submit).toBeVisible()
    await page.getByRole("button", { name: "Close new job" }).click()
  }
})

test("on a phone the navigation is a drawer that opens, navigates and closes", async ({
  page,
  request,
}) => {
  await signInAsAdmin(page, request)
  await page.setViewportSize(PHONE)
  const navigation = page.getByRole("navigation", { name: "Primary navigation" })
  // The sidebar is replaced by a button rather than squeezed onto the page.
  await expect(navigation).toBeHidden()
  await page.getByRole("button", { name: "Open navigation" }).click()
  const drawer = page.getByRole("dialog", { name: "Navigation menu" })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole("navigation", { name: "Primary navigation" })).toBeVisible()
  await expectNoOverflow(page)

  // Choosing a view navigates and dismisses the drawer in one action.
  await drawer.getByRole("button", { name: "Capacity", exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.getByRole("heading", { name: "Capacity", level: 1 })).toBeVisible()

  // Escape closes it, and so does the close control.
  await page.getByRole("button", { name: "Open navigation" }).click()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog", { name: "Navigation menu" })).toHaveCount(0)
  await page.getByRole("button", { name: "Open navigation" }).click()
  await page
    .getByRole("dialog", { name: "Navigation menu" })
    .getByRole("button", { name: "Close navigation" })
    .click()
  await expect(page.getByRole("dialog", { name: "Navigation menu" })).toHaveCount(0)

  // Clicking away also dismisses it, under a name of its own. The drawer covers the left
  // of the overlay, so the tap has to land on the strip the user can actually see.
  await page.getByRole("button", { name: "Open navigation" }).click()
  await page
    .getByRole("button", { name: "Dismiss navigation" })
    .click({ position: { x: PHONE.width - 12, y: PHONE.height / 2 } })
  await expect(page.getByRole("dialog", { name: "Navigation menu" })).toHaveCount(0)

  // Sign out is reachable from the drawer, not only from the hidden sidebar.
  await page.getByRole("button", { name: "Open navigation" }).click()
  await page
    .getByRole("dialog", { name: "Navigation menu" })
    .getByRole("button", { name: "Sign out" })
    .click()
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
})

test("on a phone a job opens as its own screen instead of a squeezed split panel", async ({
  page,
  request,
}) => {
  // A job of our own, so the row to open is unambiguous on any deployment.
  const token = await loginApi(request)
  const name = unique("mobile-detail")
  const created = await request.post("/api/mlmanage/queue", {
    headers: auth(token),
    data: {
      display_name: name,
      image: "alpine:latest",
      command: ["true"],
      gpus: 0,
      replicas: 1,
    },
  })
  expect(created.ok()).toBeTruthy()

  await signInAsAdmin(page, request)
  await page.setViewportSize(PHONE)
  await goTo(page, "Jobs")
  await page.getByLabel("Search jobs").fill(name)
  const first = page.getByRole("button", { name: new RegExp(name) }).first()
  await expect(first).toBeVisible({ timeout: 30_000 })

  await first.click()
  const detail = page.getByRole("dialog", { name: "Job detail" })
  await expect(detail).toBeVisible()
  await expectNoOverflow(page)
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)

  await first.click()
  await page.getByRole("button", { name: "Close job detail" }).click()
  await expect(page.getByRole("dialog", { name: "Job detail" })).toHaveCount(0)
})

test("every dialog moves focus in, traps Tab, closes on Escape and restores focus", async ({
  page,
  request,
}) => {
  await signInAsAdmin(page, request)

  // New job: a full-height sheet.
  const opener = page.getByRole("button", { name: "New job" })
  await opener.click()
  const sheet = page.getByRole("dialog", { name: "What should run?" })
  await expect(sheet).toBeVisible()
  // Focus is inside the dialog, not left behind on the page.
  expect(
    await page.evaluate(
      () => document.activeElement?.closest('[role="dialog"]') !== null
    )
  ).toBe(true)
  // Tab cycles within the dialog rather than escaping to the page behind it.
  for (let step = 0; step < 25; step += 1) {
    await page.keyboard.press("Tab")
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('[role="dialog"]') !== null
      ),
      `focus left the sheet after ${step + 1} tabs`
    ).toBe(true)
  }
  await page.keyboard.press("Escape")
  await expect(sheet).toHaveCount(0)
  await expect(opener).toBeFocused()

  // A modal form: same contract, and the background is not scrollable behind it.
  await goTo(page, "Capacity")
  const reserve = page.getByRole("button", { name: "Reserve a GPU" })
  await reserve.click()
  const dialog = page.getByRole("dialog", { name: /Reserve an accelerator/ })
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden")
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(reserve).toBeFocused()
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("")
})

test("long tables scroll inside their own region rather than stretching the page", async ({
  page,
  request,
}) => {
  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  for (const region of [
    "Scheduled GPU availability",
    "Shared reservation schedule",
  ] as const) {
    const scroller = page.getByRole("region", { name: region })
    if (!(await scroller.count())) continue
    await expect(scroller).toBeVisible()
    // Keyboard-reachable, so the rows are not only accessible with a mouse wheel.
    await expect(scroller).toHaveAttribute("tabindex", "0")
  }
  await goTo(page, "Projects")
  for (const region of ["Groups list", "Projects list"] as const)
    await expect(page.getByRole("region", { name: region })).toHaveAttribute(
      "tabindex",
      "0"
    )
  await goTo(page, "Administration")
  await expect(page.getByRole("region", { name: "Users list" })).toHaveAttribute(
    "tabindex",
    "0"
  )
})

test("a read-only account's views fit a phone screen as well", async ({ page }) => {
  await signIn(page, readonlyUser)
  await page.setViewportSize(PHONE)
  for (const view of ["Jobs", "Capacity", "Projects", "Usage", "My account"] as const) {
    await goTo(page, view)
    await expectNoOverflow(page)
  }
})
