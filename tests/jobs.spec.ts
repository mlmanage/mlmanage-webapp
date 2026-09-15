/**
 * The New job workflow and the Jobs view, option by option.
 *
 * Everything the sheet can express is submitted through the browser and then read back
 * from the backend, so a field that silently fails to reach `POST /queue` or
 * `POST /jobs` fails a test. Jobs created here are CPU-only or far-future wherever the
 * assertion does not need a pod, so the suite does not compete with real work for the
 * deployment's accelerators.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import {
  acceptNextConfirm,
  apiGet,
  apiList,
  auth,
  displayedDateTime,
  ensureRoleAccounts,
  expectToast,
  fillJobBasics,
  freeGpu,
  futureWindow,
  goTo,
  loginApi,
  openAdvancedScheduling,
  openNewJob,
  signIn,
  signInAsAdmin,
  sweep,
  toLocalInput,
  unique,
  workloadUser,
} from "./support/mlmanage"

type QueueEntry = {
  id: number
  display_name?: string | null
  user?: string
  image: string
  command: string[] | string
  resources?: Record<string, unknown> | string
  gpu_uuid?: string | null
  gpus?: number | null
  replicas?: number | null
  gang?: boolean | null
  mpi?: boolean | null
  vram_limit_gb?: number | null
  project?: string | null
  priority?: number | null
  time_limit_seconds?: number | null
  depends_on?: number[] | string | null
  status?: string
  task_names?: string[] | string | null
}
type Job = {
  id: number
  display_name?: string | null
  gpu_uuid: string
  start_time: string
  end_time: string
  image: string
  command: string[] | string
  resources: Record<string, unknown> | string
  time_limit_seconds: number
  status: string
  vram_limit_gb?: number | null
  project?: string | null
  priority?: number | null
  gpu_partition?: string | null
}

const asJson = <T,>(value: T | string | undefined | null, fallback: T): T =>
  value == null
    ? fallback
    : typeof value === "string"
      ? (JSON.parse(value || "null") ?? fallback)
      : value

const limitsOf = (record: { resources?: Record<string, unknown> | string }) => {
  const resources = asJson<Record<string, unknown>>(record.resources, {})
  return (resources.limits || resources) as Record<string, unknown>
}

async function queueEntry(
  request: APIRequestContext,
  token: string,
  name: string
) {
  let found: QueueEntry | undefined
  await expect
    .poll(
      async () => {
        found = (
          await apiList<QueueEntry>(request, token, "/queue", "queue")
        ).find((item) => item.display_name === name)
        return Boolean(found)
      },
      { timeout: 30_000, intervals: [500, 1_000] }
    )
    .toBe(true)
  return found!
}

async function scheduledJob(
  request: APIRequestContext,
  token: string,
  name: string
) {
  let found: Job | undefined
  await expect
    .poll(
      async () => {
        found = (await apiList<Job>(request, token, "/jobs", "jobs")).find(
          (item) => item.display_name === name
        )
        return Boolean(found)
      },
      { timeout: 30_000, intervals: [500, 1_000] }
    )
    .toBe(true)
  return found!
}

/** `POST /queue` answers `{message, job}`; return the created entry itself. */
async function postQueue(
  request: APIRequestContext,
  token: string,
  data: Record<string, unknown>
) {
  const response = await request.post("/api/mlmanage/queue", {
    headers: auth(token),
    data,
    failOnStatusCode: false,
  })
  expect(
    response.ok(),
    `POST /queue -> ${response.status()} ${await response.text()}`
  ).toBeTruthy()
  return ((await response.json()) as { job: QueueEntry }).job
}

/** A project the workload account may submit against, removed by the sweep. */
async function createProject(request: APIRequestContext, members: string[]) {
  const token = await loginApi(request)
  const name = unique("project")
  const response = await request.post("/api/mlmanage/projects", {
    headers: auth(token),
    data: {
      name,
      owner: members[0],
      members,
      total_gpus: 2,
      shared_storage_gb: 5,
      gpu_quota_by_type: {},
    },
    failOnStatusCode: false,
  })
  expect([200, 201]).toContain(response.status())
  return name
}

async function submitQueueJob(page: Page, name: string, command: string) {
  await openNewJob(page)
  await fillJobBasics(page, name, command)
  await page.getByLabel("Accelerators needed").fill("0")
  await page.getByRole("button", { name: "Queue job" }).click()
  await expectToast(page, "Job added to queue")
}

/** Cancel through the UI so the assertion covers the console's own cancel path. */
async function cancelSelected(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(name) }).first().click()
  acceptNextConfirm(page)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test("an ASAP job carries every compute and advanced option into the queue", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const project = await createProject(request, [workloadUser.username])
  const name = unique("asap-full")

  await signIn(page, workloadUser)
  await openNewJob(page)
  await fillJobBasics(page, name, "sh\n-c\necho every-option")
  await page.getByLabel("Project").fill(project)
  await page.getByLabel("Accelerators needed").fill("0")
  await page.getByLabel("GPU memory (GB)").fill("3")
  await page.getByLabel("CPU cores").fill("0.5")
  await page.getByLabel("Memory size").fill("512")
  await page.getByLabel("Memory unit").selectOption("Mi")
  await page.getByLabel("Temporary disk size").fill("2")
  await page.getByLabel("Temporary disk unit").selectOption("Gi")
  await page.getByLabel("Run time limit").fill("30")
  await page.getByLabel("Run time unit").selectOption("minutes")

  await openAdvancedScheduling(page)
  await page.getByLabel("Priority").fill("3")
  await page.getByLabel("Parallel copies").fill("2")
  await page.getByText("Start all copies together").click()
  await page.getByText("Run as an MPI job").click()
  await expect(
    page.getByText("Will enter the fair-share queue")
  ).toBeVisible()
  await page.getByRole("button", { name: "Queue job" }).click()
  await expectToast(page, "Job added to queue")

  const entry = await queueEntry(request, token, name)
  expect(entry.image).toBe("alpine:latest")
  expect(asJson<string[]>(entry.command, [])).toEqual(["sh", "-c", "echo every-option"])
  expect(entry.gpus).toBe(0)
  expect(entry.replicas).toBe(2)
  expect(entry.gang).toBe(true)
  expect(entry.mpi).toBe(true)
  expect(entry.priority).toBe(3)
  expect(entry.vram_limit_gb).toBe(3)
  expect(entry.project).toBe(project)
  expect(entry.time_limit_seconds).toBe(1_800)
  expect(entry.user).toBe(workloadUser.username)
  const limits = limitsOf(entry)
  expect(limits.cpu).toBe("0.5")
  expect(limits.memory).toBe("512Mi")
  expect(limits["ephemeral-storage"]).toBe("2Gi")
  // Zero accelerators means the request must not carry a GPU limit at all, or the pod
  // would ask the scheduler for a device it does not need.
  expect(limits["nvidia.com/gpu"]).toBeUndefined()

  // The submitted draft is cleared, so the next job does not inherit this one.
  await openNewJob(page)
  await expect(page.getByLabel("Job name")).toHaveValue("")
  await expect(page.getByLabel("Accelerators needed")).toHaveValue("1")
  await expect(page.getByLabel("Memory unit")).toHaveValue("Gi")
  await page.getByRole("button", { name: "Close new job" }).click()

  await cancelSelected(page, name)
  await expectToast(page, "Cancellation requested")
  await expect
    .poll(async () => (await queueEntry(request, token, name)).status, {
      timeout: 30_000,
    })
    .toBe("cancelled")
})

test("every memory, disk and run-time unit converts the way the form promises", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  await signIn(page, workloadUser)

  const cases = [
    {
      memory: ["1", "Mi", "1Mi"],
      disk: ["1", "Mi", "1Mi"],
      runtime: ["45", "minutes", 2_700],
    },
    {
      memory: ["2", "Gi", "2Gi"],
      disk: ["8", "Gi", "8Gi"],
      runtime: ["3", "hours", 10_800],
    },
    {
      memory: ["1", "Ti", "1Ti"],
      disk: ["1", "Ti", "1Ti"],
      runtime: ["2", "days", 172_800],
    },
  ] as const

  for (const scenario of cases) {
    const name = unique(`units-${scenario.memory[1]}`)
    await openNewJob(page)
    await fillJobBasics(page, name, "sh\n-c\ntrue")
    await page.getByLabel("Accelerators needed").fill("0")
    await page.getByLabel("Memory size").fill(scenario.memory[0])
    await page.getByLabel("Memory unit").selectOption(scenario.memory[1])
    await page.getByLabel("Temporary disk size").fill(scenario.disk[0])
    await page.getByLabel("Temporary disk unit").selectOption(scenario.disk[1])
    await page.getByLabel("Run time limit").fill(scenario.runtime[0])
    await page.getByLabel("Run time unit").selectOption(scenario.runtime[1])
    await page.getByRole("button", { name: "Queue job" }).click()
    await expectToast(page, "Job added to queue")

    const entry = await queueEntry(request, token, name)
    const limits = limitsOf(entry)
    expect(limits.memory, `memory for ${name}`).toBe(scenario.memory[2])
    expect(limits["ephemeral-storage"], `disk for ${name}`).toBe(scenario.disk[2])
    expect(entry.time_limit_seconds, `run time for ${name}`).toBe(scenario.runtime[2])
    await cancelSelected(page, name)
    await expectToast(page, "Cancellation requested")
  }
})

test("a scheduled job reserves one accelerator and stores the whole workload", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const project = await createProject(request, [workloadUser.username])
  const window = futureWindow(2)
  const gpu = await freeGpu(request, token, window)
  const name = unique("scheduled-full")

  await signIn(page, workloadUser)
  await openNewJob(page)
  await fillJobBasics(page, name, "python\ntrain.py\n--epochs\n20")
  await page.getByLabel("Project").fill(project)
  await page.getByLabel("GPU memory (GB)").fill("5")
  await page.getByLabel("CPU cores").fill("2")
  await page.getByLabel("Memory size").fill("4")
  await page.getByRole("button", { name: /Schedule Exact reservation window/ }).click()

  // A scheduled job runs on the single card it reserves.
  const accelerators = page.getByLabel("Accelerators needed")
  await expect(accelerators).toBeDisabled()
  await expect(accelerators).toHaveValue("1")
  await expect(
    page.getByText("Run time limit: derived from the selected reservation window.")
  ).toBeVisible()
  await expect(page.getByText("Will reserve the selected GPU window")).toBeVisible()

  await page.getByLabel("Start").fill(await toLocalInput(page, window.start))
  await page.getByLabel("End").fill(await toLocalInput(page, window.end))
  await expect(page.getByText("Checking the shared schedule…")).toHaveCount(0, {
    timeout: 30_000,
  })
  const availability = page.getByRole("region", { name: "Accelerator availability" })
  const row = availability.getByRole("row").filter({ hasText: gpu.gpu_uuid })
  await expect(row).toContainText("available")
  await expect(row).toContainText("No conflict in this window")
  await row.getByRole("radio").check()

  await openAdvancedScheduling(page)
  await page.getByLabel("Priority").fill("4")
  // With no MIG geometry the console offers the whole card and says so.
  await expect(page.getByLabel("GPU slice")).toHaveValue("")
  await page.getByRole("button", { name: "Schedule job" }).click()
  await expectToast(page, "Job scheduled")

  const job = await scheduledJob(request, token, name)
  expect(job.gpu_uuid).toBe(gpu.gpu_uuid)
  expect(Date.parse(`${job.start_time}Z`)).toBe(window.start.getTime())
  expect(Date.parse(`${job.end_time}Z`)).toBe(window.end.getTime())
  expect(job.time_limit_seconds).toBe(7_200)
  expect(job.vram_limit_gb).toBe(5)
  expect(job.project).toBe(project)
  expect(job.priority).toBe(4)
  expect(job.status).toBe("scheduled")
  expect(asJson<string[]>(job.command, [])).toEqual([
    "python",
    "train.py",
    "--epochs",
    "20",
  ])
  const limits = limitsOf(job)
  expect(limits["nvidia.com/gpu"]).toBe(1)
  expect(limits.cpu).toBe("2")
  expect(limits.memory).toBe("4Gi")

  // The list renders the window and the pinned card it reserved.
  const listRow = page.getByRole("button", { name: new RegExp(name) }).first()
  await expect(listRow).toContainText("scheduled")
  await expect(listRow).toContainText(await displayedDateTime(page, window.start))
  await expect(listRow).toContainText(gpu.gpu_uuid)
  await expect(listRow).toContainText("5GB")

  await cancelSelected(page, name)
  await expectToast(page, "Cancellation requested")
  await expect
    .poll(async () => (await scheduledJob(request, token, name)).status, {
      timeout: 30_000,
    })
    .toBe("cancelled")
})

test("New job refuses incomplete or nonsensical input before contacting the backend", async ({
  page,
  request,
}) => {
  await ensureRoleAccounts(request, [workloadUser])
  await signIn(page, workloadUser)
  await openNewJob(page)

  // Nothing can be submitted until name, container and command all exist.
  const submit = page.getByRole("button", { name: "Queue job" })
  await expect(submit).toBeDisabled()
  await page.getByLabel("Job name").fill(unique("invalid"))
  await expect(submit).toBeDisabled()
  await page.getByRole("tab", { name: "external" }).click()
  await page.getByLabel("External pull reference").fill("alpine:latest")
  await expect(submit).toBeDisabled()
  await page.getByLabel("Command").fill("true")
  await expect(submit).toBeEnabled()

  // A project has to be one the backend actually knows about.
  await page.getByLabel("Project").fill("mlm-live-not-a-project")
  await submit.click()
  await expect(
    page.getByText("Choose a project from the available project list.")
  ).toBeVisible()
  await page.getByLabel("Project").fill("")

  // Numeric fields reject values the backend would refuse or a pod could not honour.
  await openAdvancedScheduling(page)
  await page.getByLabel("Parallel copies").fill("0")
  await submit.click()
  // Reported next to the field and again in the footer summary, so a scrolled-away
  // field still explains why nothing was submitted.
  await expect(
    page.getByText("Enter one or more copies.", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("replicas: Enter one or more copies.")).toBeVisible()
  await page.getByLabel("Parallel copies").fill("1")

  await page.getByLabel("Priority").fill("1.5")
  await submit.click()
  await expect(page.getByText("priority: Enter a whole number.")).toBeVisible()
  await page.getByLabel("Priority").fill("0")

  for (const [label, key] of [
    ["Accelerators needed", "gpuCount"],
    ["GPU memory (GB)", "vram"],
    ["Run time limit", "runtimeValue"],
    ["Temporary disk size", "diskValue"],
  ] as const) {
    await page.getByLabel(label).fill("-1")
    await submit.click()
    await expect(
      page.getByText(`${key}: Enter a non-negative number.`)
    ).toBeVisible()
    await page.getByLabel(label).fill("1")
  }

  // A schedule with no window and no card cannot be submitted either.
  await page.getByRole("button", { name: /Schedule Exact reservation window/ }).click()
  const schedule = page.getByRole("button", { name: "Schedule job" })
  await expect(schedule).toBeDisabled()
  const past = futureWindow(2)
  await page.getByLabel("Start").fill(await toLocalInput(page, past.end))
  await page.getByLabel("End").fill(await toLocalInput(page, past.start))
  await expect(schedule).toBeDisabled()

  // Reopening the sheet starts from a clean slate.
  await page.getByRole("button", { name: "Close new job" }).click()
  await openNewJob(page)
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveCount(0)
  await expect(
    page.getByText("Choose a project from the available project list.")
  ).toHaveCount(0)
})

test("a whole shell line typed as one argument is called out before it is submitted", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  await signIn(page, workloadUser)
  await openNewJob(page)

  // The form sends an argv array, one element per line. `sleep 1000` on a single line
  // makes the runtime look for a program literally called "sleep 1000": the container
  // dies with StartError before it runs, so there is no log output to explain it. The
  // console has to say so while the form is still open.
  await expect(
    page.getByText(/One argument per line: the first line is the program/)
  ).toBeVisible()
  await page.getByLabel("Command").fill("sleep 1000")
  const hint = page.getByText(/is run as a single program name/)
  await expect(hint).toBeVisible()
  await expect(hint).toContainText("sh, -c, sleep 1000")

  // Split into separate arguments: no warning.
  await page.getByLabel("Command").fill("sleep\n1000")
  await expect(hint).toHaveCount(0)

  // The documented shell form is also fine, spaces and all.
  await page.getByLabel("Command").fill("sh\n-c\nsleep 1000")
  await expect(hint).toHaveCount(0)

  // And the command really is sent as the argv the user typed.
  const name = unique("argv")
  await page.getByLabel("Job name").fill(name)
  await page.getByRole("tab", { name: "external" }).click()
  await page.getByLabel("External pull reference").fill("alpine:latest")
  await page.getByLabel("Accelerators needed").fill("0")
  await page.getByRole("button", { name: "Queue job" }).click()
  await expectToast(page, "Job added to queue")
  expect(asJson<string[]>((await queueEntry(request, token, name)).command, [])).toEqual([
    "sh",
    "-c",
    "sleep 1000",
  ])
})

test("logs that cannot be read explain that a container which never started has none", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const token = await loginApi(request, workloadUser)
  const name = unique("no-logs")
  // A real job with a real linked execution; only the log response is stubbed, because
  // the case under test is what the console says when the pod behind a task is gone -
  // exactly what a startup failure leaves behind once the reaper has been through.
  await postQueue(request, token, {
    display_name: name,
    image: "alpine:latest",
    command: ["sh", "-c", "true"],
    gpus: 0,
    replicas: 1,
  })
  let taskName = ""
  await expect
    .poll(
      async () => {
        taskName =
          asJson<string[]>((await queueEntry(request, token, name)).task_names, [])[0] ||
          ""
        return taskName
      },
      { timeout: 150_000, intervals: [2_000] }
    )
    .not.toBe("")
  await page.route(`**/tasks/${taskName}/logs**`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Task pod not found" }),
    })
  )

  await signIn(page, workloadUser)
  await page.getByLabel("Search jobs").fill(name)
  await page.getByRole("button", { name: new RegExp(name) }).first().click()
  await expect(page.getByText(taskName)).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Logs", exact: true }).click()
  const pane = page.getByLabel("Task logs")
  await expect(pane).toContainText("Task pod not found")
  await expect(pane).toContainText("There is no pod to read logs from")
  await expect(pane).toContainText("produces no log output at all")
  await expect(pane).toContainText("each line is sent as one argument")
})

test("a job that asks for more GPU memory than the account may use is refused with the limit", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const me = await apiGet<{ quota_vram_gb?: number | null; role: string }>(
    request,
    token,
    "/me"
  )
  const cap = me.quota_vram_gb
  test.skip(cap == null, "this account has no VRAM allocation to exceed")

  await signIn(page, workloadUser)
  await openNewJob(page)
  await fillJobBasics(page, unique("over-vram"), "true")
  await page.getByLabel("Accelerators needed").fill("0")
  // The form states the ceiling rather than letting the backend refuse the job later.
  await expect(page.getByText(`Up to ${cap} GB for your account.`)).toBeVisible()
  await page.getByLabel("GPU memory (GB)").fill(String(cap! + 20))
  await page.getByRole("button", { name: "Queue job" }).click()
  await expect(
    page.getByText(
      `Your allocation allows up to ${cap} GB of GPU memory per job. Ask an administrator to raise it.`
    ).first()
  ).toBeVisible()

  // Within the allocation it goes through.
  const allowed = unique("within-vram")
  await page.getByLabel("Job name").fill(allowed)
  await page.getByLabel("GPU memory (GB)").fill(String(cap))
  await page.getByRole("button", { name: "Queue job" }).click()
  await expectToast(page, "Job added to queue")
  expect((await queueEntry(request, token, allowed)).vram_limit_gb).toBe(cap)
})

test("the queue endpoint enforces the same VRAM quota that direct task creation does", async ({
  request,
}) => {
  // The form guard above is a courtesy; the backend is the boundary. `enforce_quota` used
  // to hang off `POST /tasks` only, so `POST /queue` and `POST /jobs` accepted any VRAM
  // request: an account with a 4 GB allocation could ask for 24 GB and be scheduled.
  const token = await loginApi(request, workloadUser)
  const me = await apiGet<{ quota_vram_gb?: number | null }>(request, token, "/me")
  test.skip(me.quota_vram_gb == null, "this account has no VRAM allocation to exceed")
  const over = me.quota_vram_gb! + 20

  for (const [path, body] of [
    [
      "/queue",
      {
        display_name: unique("over-vram-queue"),
        image: "alpine:latest",
        command: ["true"],
        gpus: 1,
        replicas: 1,
        vram_limit_gb: over,
      },
    ],
    [
      "/tasks",
      {
        image: "alpine:latest",
        command: ["true"],
        time_limit_seconds: 60,
        resources: { limits: { "nvidia.com/gpu": 1 } },
        vram_limit_gb: over,
      },
    ],
  ] as const) {
    const response = await request.post(`/api/mlmanage${path}`, {
      headers: auth(token),
      data: body,
      failOnStatusCode: false,
    })
    expect(
      response.status(),
      `POST ${path} with ${over}GB against a ${me.quota_vram_gb}GB allocation`
    ).toBe(403)
    expect(await response.text()).toContain("exceeds your quota")
  }
})

test("the reason a job ended is shown next to it once the pod is gone", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const name = unique("why-it-ended")
  const created = await postQueue(request, token, {
    display_name: name,
    image: "alpine:latest",
    command: ["true"],
    gpus: 0,
    replicas: 1,
  })
  const reason =
    "task-x: StartError (exit 128): exec: \"sleep 1000\": executable file not found in $PATH"
  // The backend records the pod's terminal state before deleting it and reports it as
  // `failure_reason`; the console must put that in front of the user instead of leaving a
  // failed job with no explanation anywhere. Served from a snapshot taken here rather
  // than by rewriting each response, because the list is polled every three seconds.
  const snapshot = (
    await apiList<Record<string, unknown>>(request, token, "/queue", "queue")
  ).map((item) =>
    item.id === created.id
      ? { ...item, status: "failed", failure_reason: reason }
      : item
  )
  await page.route("**/api/mlmanage/queue", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queue: snapshot }),
        })
      : route.continue()
  )

  await signIn(page, workloadUser)
  await page.getByLabel("Search jobs").fill(name)
  await page.getByRole("button", { name: new RegExp(name) }).first().click()
  const detail = page.getByRole("heading", { name }).locator("..")
  await expect(detail).toContainText("Why it ended")
  await expect(detail).toContainText("executable file not found in $PATH")
})

test("the job list filters by text and by each backend status", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const window = futureWindow(1)
  const gpu = await freeGpu(request, token, window)
  const scheduledName = unique("filter-scheduled")
  const cancelledName = unique("filter-cancelled")

  // One scheduled job and one cancelled queue entry, seeded through the API so the test
  // is about the list rather than the form.
  const scheduled = await request.post("/api/mlmanage/jobs", {
    headers: auth(token),
    data: {
      display_name: scheduledName,
      gpu_uuid: gpu.gpu_uuid,
      start_time: window.startIso,
      end_time: window.endIso,
      image: "alpine:latest",
      command: ["true"],
      resources: { limits: { "nvidia.com/gpu": 1 } },
    },
  })
  expect(scheduled.ok()).toBeTruthy()
  const queued = await postQueue(request, token, {
    display_name: cancelledName,
    image: "alpine:latest",
    command: ["true"],
    gpus: 0,
    replicas: 1,
  })
  await request.delete(`/api/mlmanage/queue/${queued.id}`, { headers: auth(token) })

  await signIn(page, workloadUser)
  const scheduledRow = page.getByRole("button", { name: new RegExp(scheduledName) })
  const cancelledRow = page.getByRole("button", { name: new RegExp(cancelledName) })
  await expect(scheduledRow).toBeVisible({ timeout: 30_000 })
  await expect(cancelledRow).toBeVisible({ timeout: 30_000 })

  // Every backend state has a chip of its own, so nothing is only visible under "all".
  for (const chip of [
    "all",
    "running",
    "waiting",
    "scheduled",
    "completed",
    "failed",
    "cancelled",
  ])
    await expect(page.getByRole("button", { name: chip, exact: true })).toBeVisible()

  await page.getByRole("button", { name: "scheduled", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "scheduled", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(scheduledRow).toBeVisible()
  await expect(cancelledRow).toHaveCount(0)

  await page.getByRole("button", { name: "cancelled", exact: true }).click()
  await expect(cancelledRow).toBeVisible()
  await expect(scheduledRow).toHaveCount(0)

  await page.getByRole("button", { name: "all", exact: true }).click()
  await page.getByLabel("Search jobs").fill(scheduledName)
  await expect(scheduledRow).toBeVisible()
  await expect(cancelledRow).toHaveCount(0)
  await page.getByLabel("Search jobs").fill("mlm-live-nothing-matches-this")
  await expect(page.getByText("No jobs match this filter.")).toBeVisible()
})

test("the detail panel explains a queued job's whole configuration", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const project = await createProject(request, [workloadUser.username])
  const blockerName = unique("detail-blocker")
  const dependentName = unique("detail-dependent")

  const blockerId = (
    await postQueue(request, token, {
      display_name: blockerName,
      image: "alpine:latest",
      command: ["sh", "-c", "sleep 120"],
      gpus: 0,
      replicas: 1,
      time_limit_seconds: 180,
    })
  ).id
  await postQueue(request, token, {
    display_name: dependentName,
    image: "alpine:latest",
    command: ["sh", "-c", "echo dependent"],
    gpus: 0,
    replicas: 3,
    gang: true,
    mpi: true,
    priority: 6,
    project,
    vram_limit_gb: 2,
    depends_on: [blockerId],
  })

  await signIn(page, workloadUser)
  await page.getByRole("button", { name: new RegExp(dependentName) }).first().click()
  const detail = page.getByRole("heading", { name: dependentName }).locator("..")
  await expect(detail).toContainText(workloadUser.username)
  await expect(detail).toContainText(project)
  await expect(detail).toContainText("6 (higher runs before lower)")
  await expect(detail).toContainText("3 parallel pods")
  await expect(detail).toContainText("all copies start together")
  await expect(detail).toContainText("MPI launcher and workers")
  await expect(detail).toContainText(`Q-${blockerId}`)
  await expect(detail).toContainText("alpine:latest")
  await expect(detail).toContainText("echo dependent")
  // Exec is documented as unavailable rather than offered and broken.
  await expect(
    detail.getByText(/Browser exec is unavailable through the same-origin WebSocket/)
  ).toBeVisible()

  // It waits for its dependency instead of running.
  const entry = await queueEntry(request, token, dependentName)
  expect(asJson<number[]>(entry.depends_on, [])).toEqual([blockerId])
  expect(["waiting_deps", "queued"]).toContain(entry.status)
})

test("a queued job can be made to wait for another from the sheet", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const blockerName = unique("wait-blocker")
  const waiterName = unique("wait-waiter")

  await signIn(page, workloadUser)
  await submitQueueJob(page, blockerName, "sh\n-c\nsleep 120")
  const blocker = await queueEntry(request, token, blockerName)

  await openNewJob(page)
  await fillJobBasics(page, waiterName, "sh\n-c\necho after")
  await page.getByLabel("Accelerators needed").fill("0")
  await openAdvancedScheduling(page)
  const waitFor = page.getByRole("group", { name: "Wait for other jobs" })
  await waitFor
    .locator("label")
    .filter({ hasText: new RegExp(`Q-${blocker.id} ·`) })
    .getByRole("checkbox")
    .check()
  await page.getByRole("button", { name: "Queue job" }).click()
  await expectToast(page, "Job added to queue")

  const waiter = await queueEntry(request, token, waiterName)
  expect(asJson<number[]>(waiter.depends_on, [])).toContain(blocker.id)
  await expect
    .poll(async () => (await queueEntry(request, token, waiterName)).status, {
      timeout: 30_000,
    })
    .toBe("waiting_deps")

  // Cancelling the dependency cancels the work that was waiting for it.
  await cancelSelected(page, blockerName)
  await expectToast(page, "Cancellation requested")
  await expect
    .poll(async () => (await queueEntry(request, token, waiterName)).status, {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBe("cancelled")
})

test("logs and results of a real execution are readable, downloadable and deletable", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const token = await loginApi(request, workloadUser)
  const name = unique("logs")
  const marker = `mlm-live-marker-${Date.now()}`

  await signIn(page, workloadUser)
  await submitQueueJob(page, name, `sh\n-c\necho ${marker}; sleep 120`)

  // Wait for the scheduler to dispatch a Task and the console to link it.
  let taskName = ""
  await expect
    .poll(
      async () => {
        const entry = await queueEntry(request, token, name)
        const tasks = asJson<string[]>(entry.task_names, [])
        taskName = tasks[0] || ""
        return taskName
      },
      { timeout: 120_000, intervals: [2_000] }
    )
    .not.toBe("")

  await page.getByRole("button", { name: new RegExp(name) }).first().click()
  await expect(page.getByText(taskName)).toBeVisible({ timeout: 30_000 })

  // The number of log lines is the user's choice, not a fixed tail.
  const tail = page.getByLabel("Log lines to fetch")
  await expect(tail).toHaveValue("200")
  await tail.selectOption("50")

  // Pods take a moment to be pulled and started, so retry the fetch.
  await expect
    .poll(
      async () => {
        await page.getByRole("button", { name: "Logs", exact: true }).click()
        return (await page.getByLabel("Task logs").textContent()) || ""
      },
      { timeout: 150_000, intervals: [3_000] }
    )
    .toContain(marker)

  // Following keeps the same pane updated and can be turned off again.
  await page.getByRole("button", { name: "Follow logs" }).click()
  await expect(page.getByRole("button", { name: "Stop follow" })).toBeVisible()
  await page.getByRole("button", { name: "Stop follow" }).click()
  await expect(page.getByRole("button", { name: "Follow logs" })).toBeVisible()

  // Logs are savable as a file.
  const saved = page.waitForEvent("download")
  await page.getByRole("button", { name: "Save logs" }).click()
  const savedFile = await saved
  expect(savedFile.suggestedFilename()).toBe(`${taskName}-logs.txt`)
  const chunks: Buffer[] = []
  for await (const chunk of await savedFile.createReadStream()) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks).toString("utf8")).toContain(marker)

  // Results: listing must not error, and the whole directory downloads as a tar.
  await page.getByRole("button", { name: "Results", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: /failed|error/i })).toHaveCount(0)
  const tar = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download", exact: true }).click()
  expect((await tar).suggestedFilename()).toBe(`${taskName}-results.tar`)

  acceptNextConfirm(page)
  await page.getByRole("button", { name: "Delete results" }).click()
  await expectToast(page, "Results deleted")

  // Cancelling the execution itself is a separate, confirmed action.
  acceptNextConfirm(page)
  await page.getByRole("button", { name: "Cancel task" }).click()
  await expectToast(page, "Task cancellation requested")
})

test("a task with no queue or job record is shown as a legacy execution", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const created = await request.post("/api/mlmanage/tasks", {
    headers: auth(token),
    data: {
      image: "alpine:latest",
      command: ["sh", "-c", `echo ${unique("legacy")}`],
      time_limit_seconds: 60,
      resources: { limits: { cpu: "0.2", memory: "128Mi" } },
    },
    failOnStatusCode: false,
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const task = (await created.json()) as { task?: string; name?: string }
  const taskName = task.task || task.name || ""
  expect(taskName).not.toBe("")

  await signIn(page, workloadUser)
  const row = page.getByRole("button", { name: new RegExp(taskName) }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText("legacy execution")
  await row.click()
  await expect(page.getByText(taskName).first()).toBeVisible()

  // Cancelling it goes through DELETE /tasks/{name}.
  acceptNextConfirm(page)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expectToast(page, "Cancellation requested")
  await request.delete(`/api/mlmanage/tasks/${encodeURIComponent(taskName)}`, {
    headers: auth(token),
    failOnStatusCode: false,
  })
})

test("finished work is not offered a cancel that cannot succeed", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const name = unique("terminal")
  const created = await postQueue(request, token, {
    display_name: name,
    image: "alpine:latest",
    command: ["true"],
    gpus: 0,
    replicas: 1,
  })
  await request.delete(`/api/mlmanage/queue/${created.id}`, {
    headers: auth(token),
  })

  await signIn(page, workloadUser)
  await page.getByRole("button", { name: new RegExp(name) }).first().click()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expectToast(page, "This completed job cannot be cancelled.")
})

test("jobs stay scoped to their owner unless the viewer is an administrator", async ({
  page,
  request,
}) => {
  const token = await loginApi(request, workloadUser)
  const name = unique("scoped")
  await postQueue(request, token, {
    display_name: name,
    image: "alpine:latest",
    command: ["true"],
    gpus: 0,
    replicas: 1,
  })

  // The owner sees it...
  await signIn(page, workloadUser)
  await expect(
    page.getByRole("button", { name: new RegExp(name) }).first()
  ).toBeVisible({ timeout: 30_000 })

  // ...and so does an administrator, attributed to the owner.
  await page.getByRole("button", { name: "Sign out" }).first().click()
  await signInAsAdmin(page, request)
  await goTo(page, "Jobs")
  await page.getByLabel("Search jobs").fill(name)
  await expect(
    page.getByRole("button", { name: new RegExp(name) }).first()
  ).toContainText(workloadUser.username)
})
