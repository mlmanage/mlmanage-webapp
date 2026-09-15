/**
 * Accelerator reservations, end to end and in depth.
 *
 * Reservations are the one workflow a user must be able to complete 100% from the
 * browser: hold a window, see it, see what everyone else holds, extend it, release it,
 * exchange it with a calendar application, and get a usable error whenever the backend
 * says no. Every card, window, sharing mode and MIG profile used here is discovered
 * from the live deployment, so the file is not tied to any particular hardware.
 */
import { expect, test, type APIRequestContext } from "@playwright/test"
import {
  acceptNextConfirm,
  admin,
  apiList,
  auth,
  availabilityFor,
  displayedDateTime,
  displayedTime,
  dismissNextConfirm,
  enabledOptionValues,
  ensureRoleAccounts,
  expectToast,
  freeGpu,
  futureWindow,
  goTo,
  inventory,
  loginApi,
  migProfilesFor,
  modal,
  readonlyUser,
  reservationRow,
  signIn,
  signInAsAdmin,
  sweep,
  toLocalInput,
  unique,
  windowFrom,
  workloadUser,
  type Window,
} from "./support/mlmanage"

type Reservation = {
  id: number
  user?: string
  gpu_uuid: string
  start_time: string
  end_time: string
  status?: string
  priority?: number | null
  gpu_partition?: string | null
  slice_index?: number | null
}

const reservations = (request: APIRequestContext, token: string) =>
  apiList<Reservation>(request, token, "/reservations", "reservations")

/** The reservation this suite just created for `gpu` starting at `window.start`. */
async function storedReservation(
  request: APIRequestContext,
  token: string,
  gpu: string,
  window: Window
) {
  let found: Reservation | undefined
  await expect
    .poll(
      async () => {
        found = (await reservations(request, token)).find(
          (item) =>
            item.gpu_uuid === gpu &&
            item.status === "active" &&
            Date.parse(`${item.start_time}Z`) === window.start.getTime()
        )
        return Boolean(found)
      },
      { timeout: 30_000, intervals: [500, 1_000, 2_000] }
    )
    .toBe(true)
  return found!
}

async function reserveViaApi(
  request: APIRequestContext,
  token: string,
  body: Record<string, unknown>
) {
  const response = await request.post("/api/mlmanage/reservations", {
    headers: auth(token),
    data: body,
    failOnStatusCode: false,
  })
  expect(
    response.ok(),
    `seeding a reservation failed: ${response.status()} ${await response.text()}`
  ).toBeTruthy()
  return (await response.json()) as { id: number }
}

/** An `.ics` payload in exactly the shape `GET /reservations/calendar.ics` emits. */
function icsFor(events: Array<{ uid: string; gpu: string; window: Window; user: string }>) {
  const stamp = (date: Date) =>
    date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//MLManage//Reservations//EN",
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      `UID:${event.uid}@mlmanage`,
      `DTSTART:${stamp(event.window.start)}`,
      `DTEND:${stamp(event.window.end)}`,
      `SUMMARY:GPU ${event.gpu} — ${event.user}`,
      "DESCRIPTION:Priority 0",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ].join("\r\n")
}

/**
 * Fill the reserve dialog's window, wait for the shared-schedule check to settle, and
 * report which cards it marked free. The window check is debounced, so the wait is on
 * the copy the console shows while it is running.
 */
async function fillReserveWindow(
  page: import("@playwright/test").Page,
  window: Window
) {
  const dialog = modal(page, /Reserve an accelerator/)
  await dialog.getByLabel("Start").fill(await toLocalInput(page, window.start))
  await dialog.getByLabel("End").fill(await toLocalInput(page, window.end))
  await expect(dialog.getByText("Checking the shared schedule…")).toHaveCount(0, {
    timeout: 30_000,
  })
  return dialog
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser, readonlyUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("a user holds, inspects, extends and releases a window without leaving the console", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const window = futureWindow(2)
  const gpu = await freeGpu(request, token, window)

  await signIn(page, workloadUser)
  await goTo(page, "Capacity")
  // A workload user sees their own windows, not everyone's.
  await expect(
    page.getByRole("heading", { name: "My reserved GPU windows" })
  ).toBeVisible()

  await page.getByRole("button", { name: "Reserve a GPU" }).click()
  const dialog = await fillReserveWindow(page, window)
  await expect(dialog.getByText("Free and busy are for the window above.")).toBeVisible()

  const picker = dialog.getByLabel("Accelerator to reserve")
  // Nothing can be reserved until a card is chosen.
  await expect(dialog.getByRole("button", { name: "Reserve", exact: true })).toBeDisabled()
  expect(await enabledOptionValues(picker)).toContain(gpu.gpu_uuid)
  await expect(picker.locator(`option[value="${gpu.gpu_uuid}"]`)).toContainText("free")
  await picker.selectOption(gpu.gpu_uuid)
  await expect(dialog.getByLabel("Priority")).toHaveValue("0")
  await dialog.getByRole("button", { name: "Reserve", exact: true }).click()
  await expectToast(page, "Accelerator reserved")

  // The backend stores exactly the window the user typed, in UTC.
  const stored = await storedReservation(request, token, gpu.gpu_uuid, window)
  expect(Date.parse(`${stored.end_time}Z`)).toBe(window.end.getTime())
  expect(stored.gpu_partition ?? null).toBeNull()

  // ...and the console renders it back unchanged, in the viewer's timezone.
  const row = await reservationRow(page, gpu.gpu_uuid, window)
  await expect(row).toContainText(await displayedDateTime(page, window.end))
  await expect(row).toContainText("Whole card")
  await expect(row).toContainText("active")

  // The same hold is what "My account" reports as currently held.
  await goTo(page, "My account")
  const held = page.getByRole("heading", { name: "Active GPU windows" }).locator("..")
  await expect(held).toContainText(gpu.gpu_uuid)
  await expect(held).toContainText(await displayedTime(page, window.end))

  // Extend: the dialog states the current end and refuses anything not after it.
  await goTo(page, "Capacity")
  await (await reservationRow(page, gpu.gpu_uuid, window))
    .getByRole("button", { name: "Extend" })
    .click()
  const extend = modal(page, /Extend reservation/)
  await expect(extend).toContainText(gpu.gpu_uuid)
  await expect(extend).toContainText(await displayedDateTime(page, window.end))
  await expect(
    extend.getByText(/does not raise the run time limit of a job that is already running/)
  ).toBeVisible()
  await extend
    .getByLabel("New end")
    .fill(await toLocalInput(page, new Date(window.end.getTime() - 3_600_000)))
  await expect(extend.getByText("Pick a time later than the current end.")).toBeVisible()
  await expect(extend.getByRole("button", { name: "Extend", exact: true })).toBeDisabled()

  const extended = new Date(window.end.getTime() + 2 * 3_600_000)
  await extend.getByLabel("New end").fill(await toLocalInput(page, extended))
  await extend.getByRole("button", { name: "Extend", exact: true }).click()
  await expectToast(page, "Reservation extended")
  await expect
    .poll(
      async () =>
        (await reservations(request, token)).find((item) => item.id === stored.id)
          ?.end_time,
      { timeout: 30_000 }
    )
    .toBe(extended.toISOString().replace("Z", "").replace(".000", ""))
  await expect(await reservationRow(page, gpu.gpu_uuid, window)).toContainText(
    await displayedDateTime(page, extended)
  )

  // Release: destructive, so it asks first — and declining changes nothing.
  dismissNextConfirm(page)
  await (await reservationRow(page, gpu.gpu_uuid, window))
    .getByRole("button", { name: "Release" })
    .click()
  await expect(await reservationRow(page, gpu.gpu_uuid, window)).toBeVisible()

  acceptNextConfirm(page)
  await (await reservationRow(page, gpu.gpu_uuid, window))
    .getByRole("button", { name: "Release" })
    .click()
  await expectToast(page, "Reservation released")
  await expect
    .poll(
      async () =>
        (await reservations(request, token)).find((item) => item.id === stored.id)
          ?.status,
      { timeout: 30_000 }
    )
    .toBe("cancelled")
  // The released window stays on record as cancelled, with no action left on it.
  const releasedRow = await reservationRow(page, gpu.gpu_uuid, window)
  await expect(releasedRow).toContainText("cancelled")
  await expect(releasedRow.getByRole("button", { name: "Release" })).toHaveCount(0)
  await expect(releasedRow.getByRole("button", { name: "Extend" })).toHaveCount(0)
  // ...and it stops occupying the card, so the same window can be taken again.
  await expect
    .poll(
      async () =>
        (await availabilityFor(request, token, window)).find(
          (item) => item.gpu_uuid === gpu.gpu_uuid
        )?.available,
      { timeout: 30_000 }
    )
    .toBe(true)
})

test("the reserve dialog rejects an impossible window and marks cards already taken", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const window = futureWindow(2)
  const taken = await freeGpu(request, token, window)
  await reserveViaApi(request, token, {
    gpu_uuid: taken.gpu_uuid,
    start_time: window.startIso,
    end_time: window.endIso,
  })

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await page.getByRole("button", { name: "Reserve a GPU" }).click()
  const dialog = modal(page, /Reserve an accelerator/)
  // Without a window there is nothing to check availability against, and the dialog
  // says so instead of showing a stale free/busy list.
  await dialog.getByLabel("Start").fill("")
  await expect(
    dialog.getByText("Pick a window to see which accelerators are free.")
  ).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Reserve", exact: true })).toBeDisabled()

  // End before start is caught in the form, before any request is made.
  await dialog.getByLabel("Start").fill(await toLocalInput(page, window.end))
  await dialog.getByLabel("End").fill(await toLocalInput(page, window.start))
  await expect(dialog.getByText("The end must be after the start.")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Reserve", exact: true })).toBeDisabled()

  await fillReserveWindow(page, window)
  const picker = dialog.getByLabel("Accelerator to reserve")
  await expect(picker.locator(`option[value="${taken.gpu_uuid}"]`)).toContainText("busy")
  const selectable = await enabledOptionValues(picker)
  expect(selectable).not.toContain(taken.gpu_uuid)
  // Everything the backend still reports as free stays selectable.
  for (const gpu of (await availabilityFor(request, token, window)).filter(
    (item) => item.available
  ))
    expect(selectable).toContain(gpu.gpu_uuid)
})

test("a window taken while the form was open fails inside the dialog, not silently", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const window = futureWindow(2)
  const gpu = await freeGpu(request, token, window)

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await page.getByRole("button", { name: "Reserve a GPU" }).click()
  const dialog = await fillReserveWindow(page, window)
  await dialog.getByLabel("Accelerator to reserve").selectOption(gpu.gpu_uuid)

  // Somebody else claims the same card after this form checked availability.
  await reserveViaApi(request, token, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: window.startIso,
    end_time: window.endIso,
  })

  await dialog.getByRole("button", { name: "Reserve", exact: true }).click()
  // The modal overlay covers the corner toast, so the failure has to be inline.
  await expect(dialog.getByRole("alert")).toContainText(/409|conflict/i)
  await expect(dialog).toBeVisible()
  // The typed window is still there to correct rather than re-enter.
  await expect(dialog.getByLabel("Start")).toHaveValue(
    await toLocalInput(page, window.start)
  )
})

test("extending into an occupied window is refused and explained inline", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, token, window)
  const mine = await reserveViaApi(request, token, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: window.startIso,
    end_time: window.endIso,
  })
  // The next hour on the same card belongs to somebody else.
  const next = windowFrom(window.end, 2)
  await reserveViaApi(request, token, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: next.startIso,
    end_time: next.endIso,
  })

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await (await reservationRow(page, gpu.gpu_uuid, window))
    .getByRole("button", { name: "Extend" })
    .click()
  const extend = modal(page, /Extend reservation/)
  await extend
    .getByLabel("New end")
    .fill(await toLocalInput(page, new Date(next.start.getTime() + 3_600_000)))
  await extend.getByRole("button", { name: "Extend", exact: true }).click()
  await expect(extend.getByRole("alert")).toContainText(/409|overlap|conflict/i)
  await expect(extend).toBeVisible()

  // The original hold is untouched by the failed extension.
  expect(
    (await reservations(request, token)).find((item) => item.id === mine.id)?.end_time
  ).toBe(window.endIso.replace("Z", "").replace(".000", ""))
})

test("priority is sent with the hold and preempts a lower-priority window", async ({
  page,
  request,
}) => {
  const adminToken = await loginApi(request)
  const userToken = await loginApi(request, workloadUser)
  const window = futureWindow(2)
  const gpu = await freeGpu(request, adminToken, window)

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await page.getByRole("button", { name: "Reserve a GPU" }).click()
  const dialog = await fillReserveWindow(page, window)
  await expect(
    dialog.getByText(/Higher priority can preempt lower-priority holds/)
  ).toBeVisible()
  await dialog.getByLabel("Accelerator to reserve").selectOption(gpu.gpu_uuid)
  await dialog.getByLabel("Priority").fill("7")

  // A low-priority hold lands on the card between the availability check and submit.
  const victim = await reserveViaApi(request, userToken, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: window.startIso,
    end_time: window.endIso,
    priority: 1,
  })
  await dialog.getByRole("button", { name: "Reserve", exact: true }).click()
  await expectToast(page, "Accelerator reserved")

  const stored = await storedReservation(request, adminToken, gpu.gpu_uuid, window)
  expect(stored.priority).toBe(7)
  await expect
    .poll(
      async () =>
        (await reservations(request, adminToken)).find(
          (item) => item.id === victim.id
        )?.status,
      { timeout: 30_000 }
    )
    .toBe("preempted")
  // An administrator sees both, with the owner and the preempted state spelled out.
  await expect(page.getByRole("row").filter({ hasText: "preempted" }).first()).toContainText(
    workloadUser.username
  )
})

test("slice reservations follow whatever MIG geometry the deployment reports", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, token, window)
  const profiles = migProfilesFor(detected.partitions, gpu.gpu_uuid)

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await page.getByRole("button", { name: "Reserve a GPU" }).click()
  const dialog = await fillReserveWindow(page, window)
  await dialog.getByLabel("Accelerator to reserve").selectOption(gpu.gpu_uuid)

  const slice = dialog.getByLabel("GPU slice to reserve")
  if (!profiles.length) {
    // No MIG geometry configured for this card: the console must not offer slices it
    // cannot reserve, and the reservation covers the whole accelerator.
    await expect(slice).toHaveCount(0)
    await dialog.getByRole("button", { name: "Reserve", exact: true }).click()
    await expectToast(page, "Accelerator reserved")
    const stored = await storedReservation(request, token, gpu.gpu_uuid, window)
    expect(stored.gpu_partition ?? null).toBeNull()
    await expect(await reservationRow(page, gpu.gpu_uuid, window)).toContainText(
      "Whole card"
    )
    return
  }

  // MIG-configured card: every configured profile is offered with its slice VRAM, and
  // reserving one records the profile plus the assigned slice index.
  await expect(slice.locator("option")).toHaveCount(profiles.length + 1)
  for (const profile of profiles)
    await expect(slice.locator(`option[value="${profile}"]`)).toContainText(
      new RegExp(`${profile.replace(".", "\\.")} \\(\\d+ GB\\)`)
    )
  await slice.selectOption(profiles[0])
  await dialog.getByRole("button", { name: "Reserve", exact: true }).click()
  await expectToast(page, "Accelerator reserved")
  const stored = await storedReservation(request, token, gpu.gpu_uuid, window)
  expect(stored.gpu_partition).toBe(profiles[0])
  expect(stored.slice_index).not.toBeNull()
  await expect(await reservationRow(page, gpu.gpu_uuid, window)).toContainText(
    `${profiles[0]} #${stored.slice_index}`
  )
})

test("the schedule can be exported, subscribed to, and imported as iCal", async ({
  page,
  context,
  request,
  browserName,
}) => {
  const token = await loginApi(request)
  const held = futureWindow(1)
  const gpu = await freeGpu(request, token, held)
  await reserveViaApi(request, token, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: held.startIso,
    end_time: held.endIso,
  })
  const compact = (date: Date) =>
    date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")

  // Export: a real iCal document containing the window we are holding, in UTC.
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export .ics" }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe("mlmanage-reservations.ics")
  const chunks: Buffer[] = []
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer)
  const exported = Buffer.concat(chunks).toString("utf8")
  expect(exported).toContain("BEGIN:VCALENDAR")
  expect(exported).toContain(`DTSTART:${compact(held.start)}`)
  expect(exported).toContain(`GPU ${gpu.gpu_uuid}`)
  await expectToast(page, "Calendar file downloaded")

  // Subscription address: same-origin, tokenised, and flagged as a secret.
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"])
  let prompted = ""
  page.on("dialog", (dialog) => {
    prompted = dialog.message()
    void dialog.dismiss()
  })
  await page.getByRole("button", { name: "Copy calendar subscription link" }).click()
  const copied =
    prompted ||
    (await page.evaluate(() => navigator.clipboard.readText().catch(() => "")))
  if (copied) {
    expect(copied).toContain("/api/mlmanage/reservations/calendar.ics?token=")
    expect(copied).not.toContain("8000")
  }
  await expectToast(page, /treat it like a password|Copy this calendar/)

  // Import: a window nobody holds becomes a reservation; importing it again is a no-op.
  const imported = futureWindow(1)
  const target = await freeGpu(request, token, imported)
  const ics = icsFor([
    {
      uid: unique("ics"),
      gpu: target.gpu_uuid,
      window: imported,
      user: (await admin(request)).username,
    },
  ])
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: "Import .ics" }).click()
  await (
    await chooser
  ).setFiles({
    name: "mlm-live-import.ics",
    mimeType: "text/calendar",
    buffer: Buffer.from(ics),
  })
  await expectToast(page, "Imported 1 reservation")
  await storedReservation(request, token, target.gpu_uuid, imported)
  await expect(await reservationRow(page, target.gpu_uuid, imported)).toBeVisible()

  const again = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: "Import .ics" }).click()
  await (
    await again
  ).setFiles({
    name: "mlm-live-import.ics",
    mimeType: "text/calendar",
    buffer: Buffer.from(ics),
  })
  await expectToast(page, /No new reservations were imported/)
})

test("the shared schedule shows every hold and marks the viewer's own", async ({
  page,
  request,
}) => {
  const userToken = await loginApi(request, workloadUser)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, userToken, window)
  await reserveViaApi(request, userToken, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: window.startIso,
    end_time: window.endIso,
  })

  // An administrator sees somebody else's hold, attributed to them.
  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  const schedule = page.getByRole("region", { name: "Shared reservation schedule" })
  const shared = schedule
    .getByRole("row")
    .filter({ hasText: await displayedDateTime(page, window.start) })
    .first()
  await expect(shared).toContainText(workloadUser.username)
  await expect(shared).not.toContainText("you")

  // The owner sees the same row marked as theirs.
  await page.getByRole("button", { name: "Sign out" }).first().click()
  await signIn(page, workloadUser)
  await goTo(page, "Capacity")
  await expect(
    page
      .getByRole("region", { name: "Shared reservation schedule" })
      .getByRole("row")
      .filter({ hasText: await displayedDateTime(page, window.start) })
      .first()
  ).toContainText("you")
})

test("a scheduled job owns a reservation that can be extended and released with it", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const window = futureWindow(2)
  const gpu = await freeGpu(request, token, window)
  const name = unique("job-window")

  await signIn(page, workloadUser)
  await page.getByRole("button", { name: "New job" }).click()
  await page.getByLabel("Job name").fill(name)
  await page.getByRole("tab", { name: "external" }).click()
  await page.getByLabel("External pull reference").fill("alpine:latest")
  await page.getByLabel("Command").fill("sh\n-c\necho window")
  await page.getByRole("button", { name: /Schedule Exact reservation window/ }).click()
  await page.getByLabel("Start").fill(await toLocalInput(page, window.start))
  await page.getByLabel("End").fill(await toLocalInput(page, window.end))
  await expect(page.getByText("Checking the shared schedule…")).toHaveCount(0, {
    timeout: 30_000,
  })
  await page
    .getByRole("region", { name: "Accelerator availability" })
    .getByRole("row")
    .filter({ hasText: gpu.gpu_uuid })
    .getByRole("radio")
    .check()
  await page.getByRole("button", { name: "Schedule job" }).click()
  await expectToast(page, "Job scheduled")

  // Scheduling created the hold, with the window the user picked.
  const stored = await storedReservation(request, token, gpu.gpu_uuid, window)
  await goTo(page, "Capacity")
  await expect(await reservationRow(page, gpu.gpu_uuid, window)).toContainText(
    await displayedDateTime(page, window.end)
  )

  // The job's own detail panel can extend that same hold.
  await goTo(page, "Jobs")
  await page.getByRole("button", { name: new RegExp(name) }).first().click()
  const ics = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download calendar event (.ics)" }).click()
  const event = await ics
  const chunks: Buffer[] = []
  for await (const chunk of await event.createReadStream()) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks).toString("utf8")).toContain(
    `DTSTART:${window.start.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`
  )

  const longer = new Date(window.end.getTime() + 3_600_000)
  await page.getByRole("button", { name: "Hold the accelerator longer" }).click()
  const extend = modal(page, /Extend reservation/)
  await extend.getByLabel("New end").fill(await toLocalInput(page, longer))
  await extend.getByRole("button", { name: "Extend", exact: true }).click()
  await expectToast(page, "Reservation extended")
  await expect
    .poll(
      async () =>
        (await reservations(request, token)).find((item) => item.id === stored.id)
          ?.end_time,
      { timeout: 30_000 }
    )
    .toBe(longer.toISOString().replace("Z", "").replace(".000", ""))

  // Cancelling the job releases the accelerator it was holding.
  acceptNextConfirm(page)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expectToast(page, "Cancellation requested")
  await expect
    .poll(
      async () =>
        (await reservations(request, token)).find((item) => item.id === stored.id)
          ?.status,
      { timeout: 30_000 }
    )
    .toBe("cancelled")
})

test("read-only accounts can read the schedule and change nothing", async ({
  page,
  request,
}) => {
  const adminToken = await loginApi(request)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, adminToken, window)
  await reserveViaApi(request, adminToken, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: window.startIso,
    end_time: window.endIso,
  })

  await signIn(page, readonlyUser)
  await goTo(page, "Capacity")
  for (const control of [
    "Reserve a GPU",
    "Schedule a job",
    "Import .ics",
    "Extend",
    "Release",
  ])
    await expect(page.getByRole("button", { name: control })).toHaveCount(0)
  // Reading and exchanging the schedule stays available.
  await expect(page.getByRole("button", { name: "Export .ics" })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Copy calendar subscription link" })
  ).toBeVisible()
  await expect(
    page.getByRole("region", { name: "Shared reservation schedule" })
  ).toContainText(await displayedDateTime(page, window.start))

  // The backend is the real boundary, not the hidden controls.
  const readonlyToken = await loginApi(request, readonlyUser)
  const attempt = await request.post("/api/mlmanage/reservations", {
    headers: auth(readonlyToken),
    data: {
      gpu_uuid: gpu.gpu_uuid,
      start_time: futureWindow(1).startIso,
      end_time: futureWindow(1).endIso,
    },
    failOnStatusCode: false,
  })
  expect(attempt.status()).toBe(403)
})

test("an administrator sees the owner of every window and can release it", async ({
  page,
  request,
}) => {
  const userToken = await loginApi(request, workloadUser)
  const adminToken = await loginApi(request)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, userToken, window)
  const held = await reserveViaApi(request, userToken, {
    gpu_uuid: gpu.gpu_uuid,
    start_time: window.startIso,
    end_time: window.endIso,
  })

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await expect(
    page.getByRole("heading", { name: "Reserved GPU windows", exact: true })
  ).toBeVisible()
  const row = await reservationRow(page, gpu.gpu_uuid, window)
  await expect(row).toContainText(workloadUser.username)

  acceptNextConfirm(page)
  await row.getByRole("button", { name: "Release" }).click()
  await expectToast(page, "Reservation released")
  await expect
    .poll(
      async () =>
        (await reservations(request, adminToken)).find(
          (item) => item.id === held.id
        )?.status,
      { timeout: 30_000 }
    )
    .toBe("cancelled")
})

test.describe("in a timezone that is not UTC and not a whole hour from it", () => {
  // The backend serialises UTC without a `Z` on several endpoints. A console that parses
  // those as local time hands the user back a window shifted by their own offset, which
  // is exactly what a reservation must never do. Kathmandu (+05:45) also catches any
  // whole-hour rounding.
  test.use({ timezoneId: "Asia/Kathmandu" })

  test("the window a user types is the window that is stored and shown", async ({
    page,
    request,
  }) => {
    const token = await loginApi(request, workloadUser)
    const window = futureWindow(3)
    const gpu = await freeGpu(request, token, window)

    await signIn(page, workloadUser)
    await goTo(page, "Capacity")
    await page.getByRole("button", { name: "Reserve a GPU" }).click()
    const dialog = await fillReserveWindow(page, window)
    await dialog.getByLabel("Accelerator to reserve").selectOption(gpu.gpu_uuid)
    const typedStart = await dialog.getByLabel("Start").inputValue()
    const typedEnd = await dialog.getByLabel("End").inputValue()
    await dialog.getByRole("button", { name: "Reserve", exact: true }).click()
    await expectToast(page, "Accelerator reserved")

    const stored = await storedReservation(request, token, gpu.gpu_uuid, window)
    expect(Date.parse(`${stored.start_time}Z`)).toBe(window.start.getTime())
    expect(Date.parse(`${stored.end_time}Z`)).toBe(window.end.getTime())

    // Round trip: the table shows the same wall-clock time that was typed.
    const row = await reservationRow(page, gpu.gpu_uuid, window)
    await expect(row).toContainText(await displayedDateTime(page, window.start))
    await expect(row).toContainText(await displayedDateTime(page, window.end))
    expect(await toLocalInput(page, window.start)).toBe(typedStart)
    expect(await toLocalInput(page, window.end)).toBe(typedEnd)

    // Extending prefills one hour after the current end, in the viewer's clock.
    await row.getByRole("button", { name: "Extend" }).click()
    const extend = modal(page, /Extend reservation/)
    await expect(extend.getByLabel("New end")).toHaveValue(
      await toLocalInput(page, new Date(window.end.getTime() + 3_600_000))
    )
  })
})
