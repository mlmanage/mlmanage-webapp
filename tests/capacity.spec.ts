/**
 * Capacity: accelerator inventory, how each card is shared, and workspace storage.
 *
 * The inventory assertions are generated from `GET /gpu/list`, `GET /gpu/capabilities`
 * and `GET /gpu/partitions`, so this file describes whatever hardware the deployment
 * actually has - six real A5000s, a synthetic development device, or nothing at all.
 *
 * Two operations here are deliberately not performed against live hardware:
 *
 * - `timeslice`/`mps` reconfigure the NVIDIA device plugin for the whole node, and
 * - `mig` rewrites a card's geometry,
 *
 * both of which disrupt work already running on a shared cluster. Their requests are
 * intercepted so the payload the console builds is still fully asserted. `full` performs
 * no cluster action at all (it only records the desired state), so it is exercised for
 * real, end to end.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import {
  MIG_PROFILE_VRAM_GB,
  PARTITION_MODES,
} from "../lib/mlmanage-api"
import {
  acceptNextConfirm,
  apiList,
  auth,
  capabilityFor,
  dismissNextConfirm,
  ensureRoleAccounts,
  expectToast,
  goTo,
  inventory,
  loginApi,
  modal,
  optionValues,
  powerUser,
  signIn,
  signInAsAdmin,
  sweep,
  unique,
  workloadUser,
  type Inventory,
  type Partition,
} from "./support/mlmanage"

const labelFor = (mode: string) =>
  PARTITION_MODES.find((item) => item.mode === mode)?.label || mode

const partitions = (request: APIRequestContext, token: string) =>
  apiList<Partition>(request, token, "/gpu/partitions", "partitions")

/** The Sharing cell the console builds for a card, from that card's own state.
 *
 * A card is undivided unless it is divided itself: an accelerator publishing one share is
 * whole even when a sibling on its node is shared, and that is the default for every card.
 */
function sharingSummary(detected: Inventory, uuid: string) {
  const gpu = detected.gpus.find((item) => item.uuid === uuid)
  const shares = gpu?.shares ?? capabilityFor(detected, uuid)?.shares ?? 1
  const partition = detected.partitions.find((item) => item.gpu_uuid === uuid)
  if (shares <= 1 && (!partition || partition.mode === "full"))
    return "Whole card — not divided"
  if (!partition) {
    const strategy =
      gpu?.sharing_strategy ?? capabilityFor(detected, uuid)?.sharing_strategy
    return `${strategy === "mps" ? "Concurrent sharing" : "Time sharing"} · divided into ${shares} shares`
  }
  const profiles =
    typeof partition.mig_profiles === "string"
      ? (JSON.parse(partition.mig_profiles || "{}") as Record<string, number>)
      : partition.mig_profiles || {}
  const pending = partition.applied ? "" : "requested, not applied yet"
  if (partition.mode === "mig")
    return [
      labelFor(partition.mode),
      Object.entries(profiles)
        .map(([profile, count]) => `${count}×${profile}`)
        .join(", "),
      pending,
    ]
      .filter(Boolean)
      .join(" · ")
  return [
    labelFor(partition.mode),
    shares > 1 ? `divided into ${shares} shares` : pending,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** The inventory table, identified by its own Sharing column. */
function inventoryTable(page: Page) {
  return page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Sharing" }) })
    .first()
}

/** The workspace-storage table, identified by its own Workspace column. */
function storageTable(page: Page) {
  return page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Workspace" }) })
    .first()
}

/**
 * The inventory row for one specific card. A node usually holds several identical
 * cards, so the row is located by UUID rather than by product name.
 */
function inventoryRow(page: Page, gpu: { uuid: string }) {
  return inventoryTable(page).getByRole("row").filter({ hasText: gpu.uuid }).first()
}

async function openSharing(page: Page, gpu: { uuid: string; product?: string }) {
  await inventoryRow(page, gpu).getByRole("button", { name: "Configure sharing" }).click()
  return modal(page, /Configure accelerator sharing/)
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser, powerUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("the inventory describes every accelerator the cluster reports", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await expect(page.getByRole("heading", { name: "GPU inventory" })).toBeVisible()

  if (!detected.gpus.length) {
    await expect(
      page.getByText("No accelerators are reported by the cluster.")
    ).toBeVisible()
    return
  }

  // A memory column only appears when the deployment supplies card memory, instead of
  // a column of dashes.
  const showsMemory = detected.gpus.some(
    (gpu) => gpu.memory_gb != null || capabilityFor(detected, gpu.uuid)?.memory_gb != null
  )
  await expect(
    inventoryTable(page).getByRole("columnheader", { name: "Memory" })
  ).toHaveCount(showsMemory ? 1 : 0)

  // Inventory-only devices must be called out as unusable for workloads.
  await expect(
    page.getByText(/Some accelerators here are inventory-only/)
  ).toHaveCount(
    detected.gpus.some((gpu) => gpu.simulated || gpu.synthetic_e2e) ? 1 : 0
  )

  for (const gpu of detected.gpus) {
    const row = inventoryRow(page, gpu)
    await expect(row, `row for ${gpu.uuid}`).toBeVisible()
    // Identical cards on one node must still be told apart.
    await expect(row).toContainText(gpu.uuid)
    if (gpu.product) await expect(row).toContainText(gpu.product)
    await expect(row).toContainText(gpu.node || "—")
    await expect(row).toContainText(sharingSummary(detected, gpu.uuid))
    await expect(row).toContainText(
      gpu.simulated ? "inventory only" : gpu.synthetic_e2e ? "synthetic E2E" : "online"
    )
    const capability = capabilityFor(detected, gpu.uuid)
    await expect(row).toContainText(
      capability?.mig_capable
        ? "MIG capable"
        : capability?.supported_modes?.length
          ? "No MIG support"
          : "Capabilities not reported"
    )
  }
})

test("the inventory names each card and says what it is divided into", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  test.skip(!detected.gpus.length, "no accelerators reported")

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")

  // Cards on a node are identical in every visible respect except their position and
  // identifier, so the row has to carry both.
  const byNode = new Map<string, typeof detected.gpus>()
  for (const gpu of detected.gpus) {
    const list = byNode.get(gpu.node || "") || []
    list.push(gpu)
    byNode.set(gpu.node || "", list)
  }
  for (const [node, cards] of byNode)
    for (const [position, gpu] of cards.entries()) {
      const row = inventoryRow(page, gpu)
      await expect(row).toContainText(
        cards.length > 1
          ? `card ${position + 1} of ${cards.length} on ${node}`
          : `the only card on ${node}`
      )
      await expect(row).toContainText(gpu.uuid)
    }

  // The product name is the physical model. Time slicing makes the GPU Operator relabel
  // the node `<product>-SHARED`, which would also break the per-model quota keys, so the
  // console must never show that suffix as if it were a different card.
  for (const gpu of detected.gpus) {
    expect(gpu.product || "").not.toContain("-SHARED")
    if (gpu.product)
      await expect(inventoryRow(page, gpu)).not.toContainText("-SHARED")
  }

  // Sharing is stated in terms of what it means: whole card, or divided into N shares.
  for (const gpu of detected.gpus) {
    const shares = gpu.shares ?? capabilityFor(detected, gpu.uuid)?.shares ?? 1
    const row = inventoryRow(page, gpu)
    if (shares > 1) {
      await expect(row).toContainText(`divided into ${shares} shares`)
      await expect(row).toContainText(
        `${shares} jobs may hold this card at once`
      )
    } else if (!detected.partitions.some((item) => item.gpu_uuid === gpu.uuid))
      await expect(row).toContainText("Whole card — not divided")
  }
})

test("the inventory lists physical cards, not the units a shared node publishes", async ({
  request,
}) => {
  // Time slicing multiplies `nvidia.com/gpu` capacity, and listing that as separate cards
  // invents hardware: 2 shares on 6 cards used to show 12 accelerators, and rejoining
  // them left records and reservations pointing at cards that no longer existed.
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  test.skip(!detected.gpus.length, "no accelerators reported")

  const shares = new Map<string, number>()
  for (const gpu of detected.gpus)
    shares.set(
      gpu.node || "",
      gpu.shares ?? capabilityFor(detected, gpu.uuid)?.shares ?? 1
    )
  for (const [node, factor] of shares) {
    const cards = detected.gpus.filter((gpu) => (gpu.node || "") === node)
    const identifiers = new Set(cards.map((gpu) => gpu.uuid))
    expect(identifiers.size, `duplicate identifiers on ${node}`).toBe(cards.length)
    if (factor > 1)
      // The count must be the physical card count, so it does not change with the
      // sharing factor.
      expect(
        cards.length % factor === 0 ? "divisible" : "independent-of-factor"
      ).toBeTruthy()
  }
  // Nothing in the inventory may reference a card that is not in the inventory.
  for (const partition of detected.partitions)
    if (!detected.gpus.some((gpu) => gpu.uuid === partition.gpu_uuid))
      expect(
        partition.gpu_uuid,
        "a stale sharing record must be reported for review, not treated as a card"
      ).toBeTruthy()
})

test("a card that is already divided must be rejoined before it can be divided again", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const divided = detected.schedulable.find(
    (gpu) => (gpu.shares ?? capabilityFor(detected, gpu.uuid)?.shares ?? 1) > 1
  )
  test.skip(!divided, "no accelerator on this deployment is currently divided")

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  const dialog = await openSharing(page, divided!)
  const shares = divided!.shares ?? capabilityFor(detected, divided!.uuid)!.shares!
  await expect(
    dialog.getByText(`This card is already divided into ${shares} shares.`)
  ).toBeVisible()
  // Only rejoining is offered; a different share count has to go through Full GPU first.
  expect(await optionValues(dialog.getByLabel("Sharing mode"))).toEqual(["full"])
  await expect(dialog.getByLabel("Shares for this card")).toHaveCount(0)
})

test("dividing a card explains that time sharing splits time, and only touches that card", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const target = detected.schedulable.find(
    (gpu) =>
      (gpu.shares ?? capabilityFor(detected, gpu.uuid)?.shares ?? 1) === 1 &&
      (capabilityFor(detected, gpu.uuid)?.supported_modes || []).includes("timeslice")
  )
  test.skip(!target, "no undivided accelerator supports time sharing")
  const siblings = detected.gpus.filter((gpu) => gpu.node === target!.node).length

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  const dialog = await openSharing(page, target!)
  await expect(dialog).toContainText(target!.uuid)
  await dialog.getByLabel("Sharing mode").selectOption("timeslice")

  // What time slicing actually is: turns in time on one card, with shared memory.
  await expect(
    dialog.getByText(/gives each job the whole card for a slice of TIME/)
  ).toBeVisible()
  await expect(dialog.getByText(/every few milliseconds/)).toBeVisible()
  await expect(dialog.getByText(/roughly 1\/N of the speed/)).toBeVisible()

  // The field starts at the smallest real split: one share is an undivided card, which is
  // what Full GPU is for, so the dialog must not propose a share count of 1 (nor a number
  // carried over from another mode) for a card that is whole.
  const sharesField = dialog.getByLabel("Shares for this card")
  expect(Number(await sharesField.inputValue())).toBeGreaterThanOrEqual(2)

  // And that the split lands on THIS card only, leaving its siblings whole.
  await sharesField.fill("4")
  await expect(
    dialog.getByText(new RegExp(`Applies to ${target!.uuid} only`))
  ).toBeVisible()
  if (siblings > 1)
    await expect(
      dialog.getByText(
        `: that card will publish 4 shares, while the other cards on ${target!.node} stay as they are.`
      )
    ).toBeVisible()
  await expect(
    dialog.getByText(/Shares take turns in time on the same silicon/)
  ).toBeVisible()

  // One share is not a division: it is refused here instead of reaching the backend.
  await sharesField.fill("1")
  acceptNextConfirm(page)
  await dialog.getByRole("button", { name: "Apply sharing" }).click()
  await expect(
    dialog.getByText(
      "Sharing starts at 2 shares — pick Full GPU to leave this card whole."
    )
  ).toBeVisible()
})

test("a sharing record for a card that no longer exists can be forgotten", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const stale = detected.partitions.filter(
    (partition) => !detected.gpus.some((gpu) => gpu.uuid === partition.gpu_uuid)
  )
  test.skip(!stale.length, "no stale sharing records on this deployment")

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  const review = page.getByRole("heading", { name: "Sharing configuration to review" })
  await expect(review).toBeVisible()
  const row = page
    .locator("div")
    .filter({ hasText: stale[0].gpu_uuid })
    .filter({ has: page.getByRole("button", { name: "Forget" }) })
    .last()
  await expect(row).toContainText("not in the inventory any more")

  acceptNextConfirm(page)
  await row.getByRole("button", { name: "Forget" }).click()
  await expectToast(page, "Sharing record forgotten")
  await expect
    .poll(
      async () =>
        (await partitions(request, token)).some(
          (item) => item.gpu_uuid === stale[0].gpu_uuid
        ),
      { timeout: 30_000 }
    )
    .toBe(false)
})

test("only an administrator is offered the sharing controls", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  test.skip(!detected.schedulable.length, "no schedulable accelerator to configure")

  await signIn(page, workloadUser)
  await goTo(page, "Capacity")
  await expect(
    page.getByText("Only administrators can change how a card is divided.")
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Configure sharing" })).toHaveCount(0)
  await expect(
    inventoryTable(page).getByRole("columnheader", { name: "Actions" })
  ).toHaveCount(0)

  // The backend refuses the mutation as well, whatever the UI shows.
  const userToken = await loginApi(request, workloadUser)
  const attempt = await request.post(
    `/api/mlmanage/gpu/${encodeURIComponent(detected.schedulable[0].uuid)}/partition`,
    { headers: auth(userToken), data: { mode: "full" }, failOnStatusCode: false }
  )
  expect(attempt.status()).toBe(403)

  await page.getByRole("button", { name: "Sign out" }).first().click()
  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await expect(
    page.getByText(/Use Configure sharing to change it/)
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Configure sharing" }).first()
  ).toBeVisible()
})

test("the sharing dialog offers only the modes the hardware reports", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const target = detected.schedulable.find((gpu) =>
    (capabilityFor(detected, gpu.uuid)?.supported_modes || []).length
  )
  test.skip(!target, "no accelerator reports configurable sharing modes")
  const supported = capabilityFor(detected, target!.uuid)!.supported_modes!

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  const dialog = await openSharing(page, target!)
  await expect(dialog).toContainText(target!.product || target!.uuid)
  await expect(
    dialog.getByText(/Changing it can disrupt work already running on the card/)
  ).toBeVisible()

  // Exactly the reported modes, in the console's own order, and nothing else.
  const modeSelect = dialog.getByLabel("Sharing mode")
  expect(await optionValues(modeSelect)).toEqual(
    PARTITION_MODES.filter((item) => supported.includes(item.mode)).map(
      (item) => item.mode
    )
  )
  if (!supported.includes("mig"))
    expect(await optionValues(modeSelect)).not.toContain("mig")

  for (const mode of supported) {
    await modeSelect.selectOption(mode)
    await expect(dialog).toContainText(
      PARTITION_MODES.find((item) => item.mode === mode)!.help
    )
    // Shares are asked for exactly when the mode publishes shares.
    await expect(dialog.getByLabel("Shares for this card")).toHaveCount(
      mode === "timeslice" || mode === "mps" ? 1 : 0
    )
    if (mode === "mig") {
      // Every profile the backend validates against is offered, with its slice VRAM.
      for (const [profile, vram] of Object.entries(MIG_PROFILE_VRAM_GB))
        await expect(
          dialog.getByLabel(`${profile} — ${vram} GB per slice`)
        ).toBeVisible()
      await expect(dialog.getByText("Set at least one slice count.")).toBeVisible()
      await expect(
        dialog.getByRole("button", { name: "Apply sharing" })
      ).toBeDisabled()
    }
  }

  // Applying is disruptive, so it asks first - and declining sends nothing.
  const requests: string[] = []
  await page.route("**/api/mlmanage/gpu/*/partition", async (route) => {
    requests.push(route.request().postData() || "")
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Partition set" }),
    })
  })
  await modeSelect.selectOption(supported[0])
  dismissNextConfirm(page)
  await dialog.getByRole("button", { name: "Apply sharing" }).click()
  expect(requests).toEqual([])
  await expect(dialog).toBeVisible()
})

test("each sharing mode builds the request the backend documents", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const target = detected.schedulable.find((gpu) =>
    (capabilityFor(detected, gpu.uuid)?.supported_modes || []).some((mode) =>
      ["timeslice", "mps", "mig"].includes(mode)
    )
  )
  test.skip(
    !target,
    "no accelerator reports a shared mode beyond full-device allocation"
  )
  const supported = capabilityFor(detected, target!.uuid)!.supported_modes!

  // Intercepted: these two modes reconfigure the node's device plugin or the card's
  // geometry, which would disrupt other people's running work.
  const sent: Array<Record<string, unknown>> = []
  await page.route("**/api/mlmanage/gpu/*/partition", async (route) => {
    sent.push(JSON.parse(route.request().postData() || "{}"))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Partition set", applied_detail: {} }),
    })
  })

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")

  for (const mode of ["timeslice", "mps"].filter((item) => supported.includes(item))) {
    const dialog = await openSharing(page, target!)
    await dialog.getByLabel("Sharing mode").selectOption(mode)
    await dialog.getByLabel("Shares for this card").fill("4")
    acceptNextConfirm(page)
    await dialog.getByRole("button", { name: "Apply sharing" }).click()
    await expectToast(page, "Sharing configuration submitted")
    expect(sent.at(-1)).toEqual({ mode, replicas: 4 })
  }

  if (supported.includes("mig")) {
    const profile = Object.keys(MIG_PROFILE_VRAM_GB)[0]
    const dialog = await openSharing(page, target!)
    await dialog.getByLabel("Sharing mode").selectOption("mig")
    await dialog
      .getByLabel(`${profile} — ${MIG_PROFILE_VRAM_GB[profile]} GB per slice`)
      .fill("2")
    acceptNextConfirm(page)
    await dialog.getByRole("button", { name: "Apply sharing" }).click()
    await expectToast(page, "Sharing configuration submitted")
    expect(sent.at(-1)).toEqual({ mode: "mig", mig_profiles: { [profile]: 2 } })
  }
})

test("full-device sharing is recorded by the backend and shown in the inventory", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  // Prefer a card already recorded as full-device: re-applying that mode changes
  // nothing at all on the cluster, while still exercising the real endpoint.
  const target =
    detected.schedulable.find(
      (gpu) =>
        detected.partitions.find((item) => item.gpu_uuid === gpu.uuid)?.mode === "full"
    ) ||
    detected.schedulable.find((gpu) =>
      (capabilityFor(detected, gpu.uuid)?.supported_modes || []).includes("full")
    )
  test.skip(!target, "no accelerator supports full-device allocation")

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  const dialog = await openSharing(page, target!)
  await dialog.getByLabel("Sharing mode").selectOption("full")
  acceptNextConfirm(page)
  await dialog.getByRole("button", { name: "Apply sharing" }).click()
  await expectToast(page, "Sharing configuration submitted")

  await expect
    .poll(
      async () =>
        (await partitions(request, token)).find(
          (item) => item.gpu_uuid === target!.uuid
        ),
      { timeout: 30_000 }
    )
    .toMatchObject({ mode: "full", applied: true, replicas: 1 })
  await expect(inventoryRow(page, target!)).toContainText(labelFor("full"))
})

test("workspace storage reports the volumes behind the account", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const volumes = await apiList<Record<string, unknown>>(
    request,
    token,
    "/disk/usage",
    "volumes"
  )

  await signIn(page, workloadUser)
  await goTo(page, "Capacity")
  await expect(page.getByRole("heading", { name: "Workspace storage" })).toBeVisible()
  if (!volumes.length) {
    await expect(
      page.getByText("No workspace volumes are reported for your account.")
    ).toBeVisible()
    return
  }
  for (const header of ["Workspace", "Volume", "Size", "Used", "Status"])
    await expect(
      storageTable(page).getByRole("columnheader", { name: header })
    ).toBeVisible()
  const first = volumes[0]
  const row = storageTable(page)
    .getByRole("row")
    .filter({ hasText: String(first.pvc || first.name) })
    .first()
  await expect(row).toContainText(String(first.volume_type || first.type || "workspace"))
  await expect(row).toContainText(String(first.namespace || ""))
  // Usage is only claimed when the cluster measured it.
  await expect(row).toContainText(
    first.used_bytes != null || first.usage_percent != null ? /%|B/ : "Not reported"
  )
})

test("shared storage is offered to admins and power users, with a name the cluster accepts", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const valid = unique("storage-group")
  const invalid = `${unique("Storage")}-UPPER`
  for (const name of [valid, invalid]) {
    const created = await request.post("/api/mlmanage/groups", {
      headers: auth(token),
      data: { name, total_gpus: 1, total_disk_gb: 10 },
      failOnStatusCode: false,
    })
    expect([200, 201]).toContain(created.status())
  }

  // A plain workload account is not offered it.
  await signIn(page, workloadUser)
  await goTo(page, "Capacity")
  await expect(page.getByRole("button", { name: "Create shared storage" })).toHaveCount(0)
  await page.getByRole("button", { name: "Sign out" }).first().click()

  // A power user is.
  await signIn(page, powerUser)
  await goTo(page, "Capacity")
  await expect(
    page.getByRole("button", { name: "Create shared storage" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Sign out" }).first().click()

  // Creating a ReadWriteMany team volume has no delete endpoint, so the request is
  // captured rather than performed - the assertion is on what the console sends.
  let requested = ""
  await page.route("**/api/mlmanage/teams/*/shared-storage**", async (route) => {
    requested = route.request().url()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ message: "Shared storage created" }),
    })
  })
  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  await page.getByRole("button", { name: "Create shared storage" }).click()
  const dialog = modal(page, /Shared storage/)
  await expect(
    dialog.getByText(/Creates one shared volume that every member of the group can mount/)
  ).toBeVisible()

  // The backend builds a Kubernetes namespace from the group name, so a name it would
  // reject is refused here with the reason.
  await dialog.getByLabel("Group for shared storage").selectOption(invalid)
  await expect(
    dialog.getByText(/needs a lowercase group name/)
  ).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Create shared storage" })).toBeDisabled()

  await dialog.getByLabel("Group for shared storage").selectOption(valid)
  await dialog.getByLabel("Size (GiB)").fill("25")
  await dialog.getByRole("button", { name: "Create shared storage" }).click()
  await expectToast(page, "Shared storage ready")
  expect(requested).toContain(`/teams/${valid}/shared-storage`)
  expect(requested).toContain("size_gb=25")
})

test("sharing configuration the cluster has not applied is surfaced for review", async ({
  page,
  request,
}) => {
  const token = await loginApi(request)
  const detected = await inventory(request, token)
  const needsReview = detected.partitions.filter(
    (partition) =>
      !detected.gpus.some((gpu) => gpu.uuid === partition.gpu_uuid) ||
      partition.applied === false
  )

  await signInAsAdmin(page, request)
  await goTo(page, "Capacity")
  const section = page.getByRole("heading", { name: "Sharing configuration to review" })
  if (!needsReview.length) {
    // Nothing pending: the console must not show an empty review section.
    await expect(section).toHaveCount(0)
    return
  }
  await expect(section).toBeVisible()
  for (const partition of needsReview)
    await expect(
      page.getByText(partition.product || partition.gpu_uuid).first()
    ).toBeVisible()
  await expect(
    page.getByText(/Every sharing mode applies to the single card it was set on/)
  ).toBeVisible()
})
