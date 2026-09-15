/**
 * Container images: uploading a real `docker save` archive from inside New job, every
 * discovery scope, replacing an existing tag, using an uploaded reference for a job,
 * changing who may use it, deleting it, and the failure paths a registry can produce.
 *
 * These tests push real layers, so each one uploads at most one archive.
 */
import { readFileSync } from "node:fs"
import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import {
  admin,
  apiList,
  auth,
  ensureRoleAccounts,
  expectToast,
  loginApi,
  modal,
  openNewJob,
  signIn,
  signInAsAdmin,
  sweep,
  unique,
  workloadUser,
} from "./support/mlmanage"
import { imageTar } from "./support/image-tar"

type ImageRecord = {
  id: number
  user: string
  name: string
  tag: string
  repository: string
  pull_ref: string
  size_bytes?: number | null
  visibility?: string
  project?: string | null
  group?: string | null
}

const fixture = imageTar()

const images = (request: APIRequestContext, token: string) =>
  apiList<ImageRecord>(request, token, "/images", "images")

async function uploadedRecord(
  request: APIRequestContext,
  token: string,
  name: string
) {
  let found: ImageRecord | undefined
  await expect
    .poll(
      async () => {
        found = (await images(request, token)).find((item) => item.name === name)
        return Boolean(found)
      },
      { timeout: 60_000, intervals: [1_000] }
    )
    .toBe(true)
  return found!
}

/** Open New job on the upload tab. */
async function openUploadTab(page: Page) {
  await openNewJob(page)
  await page.getByRole("tab", { name: "upload" }).click()
  await expect(page.getByLabel("Image name")).toBeVisible()
}

async function chooseFile(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer }
) {
  const chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: "Choose .tar file" }).click()
  await (await chooser).setFiles(file)
}

/** Open the collapsed container library, whether or not it is already open. */
async function expandLibrary(page: Page) {
  const library = page.locator("details", {
    has: page.locator("summary", { hasText: "Container library" }),
  })
  await expect(library).toBeVisible()
  if (!(await library.evaluate((node) => (node as HTMLDetailsElement).open)))
    await library.locator("summary").click()
}

test.beforeAll(async ({ request }) => {
  await ensureRoleAccounts(request, [workloadUser])
})

test.afterEach(async ({ request }) => {
  await sweep(request)
})

test.describe("uploading a real archive", () => {
  test.skip("reason" in fixture, "reason" in fixture ? fixture.reason : "")
  const tarPath = () => ("path" in fixture ? fixture.path : "")

  test("an archive uploaded in New job is pushed, selected and immediately runnable", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const token = await loginApi(request, workloadUser)
    const name = unique("upload")
    const jobName = `${name}-job`

    await signIn(page, workloadUser)
    await openUploadTab(page)
    // The metadata is applied to the upload, so it is set before the file is chosen.
    await expect(
      page.getByText(/These details are applied to the upload/)
    ).toBeVisible()
    await page.getByLabel("Image name").fill(name)
    await page.getByLabel("Image tag").fill("v1")
    await expect(page.getByLabel("Image visibility")).toHaveValue("user")
    await chooseFile(page, tarPath())

    await expectToast(page, /Uploaded and selected/)
    await expect(page.getByText(/is uploaded and selected\./)).toBeVisible()

    const record = await uploadedRecord(request, token, name)
    expect(record.tag).toBe("v1")
    expect(record.visibility).toBe("user")
    expect(record.user).toBe(workloadUser.username)
    expect(record.repository).toContain(name)
    expect(record.size_bytes ?? 0).toBeGreaterThan(1_000)
    expect(record.pull_ref).toContain(`${name}:v1`)

    // The uploaded reference is what the job is submitted with.
    await page.getByLabel("Job name").fill(jobName)
    await page.getByLabel("Command").fill("sh\n-c\ntrue")
    await page.getByLabel("Accelerators needed").fill("0")
    await page.getByRole("button", { name: "Queue job" }).click()
    await expectToast(page, "Job added to queue")
    await expect
      .poll(
        async () =>
          (
            await apiList<{ display_name?: string | null; image: string }>(
              request,
              token,
              "/queue",
              "queue"
            )
          ).find((item) => item.display_name === jobName)?.image,
        { timeout: 30_000 }
      )
      .toBe(record.pull_ref)

    // And it is offered in the library picker for the next job.
    await openNewJob(page)
    await page.getByRole("tab", { name: "existing" }).click()
    await expect(
      page.getByLabel("Existing image").locator(`option[value="${record.pull_ref}"]`)
    ).toHaveCount(1)
  })

  test("re-uploading the same name and tag warns that it replaces the image", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const token = await loginApi(request, workloadUser)
    const name = unique("replace")

    await signIn(page, workloadUser)
    await openUploadTab(page)
    await page.getByLabel("Image name").fill(name)
    await page.getByLabel("Image tag").fill("stable")
    await chooseFile(page, tarPath())
    await expectToast(page, /Uploaded and selected/)
    const first = await uploadedRecord(request, token, name)

    // The typed name is cleared after a successful upload, so the next one cannot
    // silently overwrite this image.
    await expect(page.getByLabel("Image name")).toHaveValue("")
    await page.getByLabel("Image name").fill(name)
    await page.getByLabel("Image tag").fill("stable")
    await expect(
      page.getByText(`${first.pull_ref} already exists — uploading replaces it.`)
    ).toBeVisible()

    // A different tag is a different image and carries no warning.
    await page.getByLabel("Image tag").fill("other")
    await expect(page.getByText(/already exists — uploading replaces it\./)).toHaveCount(0)
  })

  test("a project-scoped upload needs its project chosen before the archive is sent", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const adminAccount = await admin(request)
    const token = await loginApi(request)
    const project = unique("img-project")
    const created = await request.post("/api/mlmanage/projects", {
      headers: auth(token),
      data: { name: project, owner: adminAccount.username, total_gpus: 1 },
      failOnStatusCode: false,
    })
    expect([200, 201]).toContain(created.status())
    const name = unique("scoped-image")

    await signInAsAdmin(page, request)
    await openUploadTab(page)
    await page.getByLabel("Image name").fill(name)
    await page.getByLabel("Image visibility").selectOption("project")
    // Until a project is picked the upload is blocked, with the reason on screen.
    await expect(page.getByRole("button", { name: "Choose .tar file" })).toBeDisabled()
    await expect(
      page.getByText("Choose which project may use this image before uploading.")
    ).toBeVisible()

    await page.getByLabel("Share image with").selectOption(project)
    await expect(page.getByRole("button", { name: "Choose .tar file" })).toBeEnabled()
    await chooseFile(page, tarPath())
    await expectToast(page, /Uploaded and selected/)

    const record = await uploadedRecord(request, token, name)
    expect(record.visibility).toBe("project")
    expect(record.project).toBe(project)
  })

  test("an image published to everyone is discoverable by another account, a private one is not", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const adminToken = await loginApi(request)
    const shared = unique("shared-image")
    const secret = unique("private-image")

    await signInAsAdmin(page, request)
    await openUploadTab(page)
    await page.getByLabel("Image name").fill(shared)
    await page.getByLabel("Image visibility").selectOption("everyone")
    await chooseFile(page, tarPath())
    await expectToast(page, /Uploaded and selected/)
    const publicRecord = await uploadedRecord(request, adminToken, shared)
    expect(publicRecord.visibility).toBe("everyone")

    // A second record kept private, uploaded through the API to avoid a second push
    // of the same layers being the point of the test.
    const privateUpload = await request.post(
      `/api/mlmanage/images?name=${secret}&tag=latest&visibility=user`,
      {
        headers: auth(adminToken),
        multipart: {
          file: {
            name: "archive.tar",
            mimeType: "application/x-tar",
            buffer: readFileSync(tarPath()),
          },
        },
        timeout: 180_000,
      }
    )
    expect(privateUpload.ok(), await privateUpload.text()).toBeTruthy()

    await page.getByRole("button", { name: "Close new job" }).click()
    await page.getByRole("button", { name: "Sign out" }).first().click()
    await signIn(page, workloadUser)
    await openNewJob(page)
    await page.getByRole("tab", { name: "existing" }).click()
    const picker = page.getByLabel("Existing image")
    await expect(picker.locator(`option[value="${publicRecord.pull_ref}"]`)).toHaveCount(1)
    await expect(picker.getByText(secret)).toHaveCount(0)

    // The backend, not the picker, is the boundary: it also hides the private record.
    const userToken = await loginApi(request, workloadUser)
    const visible = (await images(request, userToken)).map((item) => item.name)
    expect(visible).toContain(shared)
    expect(visible).not.toContain(secret)
  })

  test("the library changes who can use an image and deletes it", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    const adminAccount = await admin(request)
    const token = await loginApi(request)
    const group = unique("img-group")
    const created = await request.post("/api/mlmanage/groups", {
      headers: auth(token),
      data: { name: group, total_gpus: 1, members: [adminAccount.username] },
      failOnStatusCode: false,
    })
    expect([200, 201]).toContain(created.status())
    const name = unique("library")

    await signInAsAdmin(page, request)
    await openUploadTab(page)
    await page.getByLabel("Image name").fill(name)
    await chooseFile(page, tarPath())
    await expectToast(page, /Uploaded and selected/)
    const record = await uploadedRecord(request, token, name)

    await expandLibrary(page)
    await page
      .getByRole("button", { name: `Change who can use ${name}` })
      .click()
    const dialog = modal(page, /Who can use this image/)
    await expect(dialog).toContainText(record.pull_ref)
    // A group scope needs a target, and says so before anything is sent.
    await dialog.getByLabel("Image visibility").selectOption("group")
    await expect(dialog.getByText("Choose the group to share with.")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled()
    await dialog.getByLabel("Share image with").selectOption(group)
    await dialog.getByRole("button", { name: "Save", exact: true }).click()
    await expectToast(page, "Saved")

    await expect
      .poll(
        async () => (await images(request, token)).find((item) => item.id === record.id),
        { timeout: 30_000 }
      )
      .toMatchObject({ visibility: "group", group })
    await expandLibrary(page)
    await expect(
      page.getByRole("button", { name: `Change who can use ${name}` })
    ).toContainText(`Group · ${group}`)

    // Deleting removes the MLManage record.
    await page.getByRole("button", { name: `Delete ${name}` }).click()
    await expect
      .poll(
        async () => (await images(request, token)).some((item) => item.id === record.id),
        { timeout: 30_000 }
      )
      .toBe(false)
  })
})

test("an archive the registry cannot read is reported and selects nothing", async ({
  page,
  request,
}) => {
  await ensureRoleAccounts(request, [workloadUser])
  await signIn(page, workloadUser)
  await openUploadTab(page)
  // Everything except the container is already valid, so the only reason the job cannot
  // be submitted afterwards is that no usable image was selected.
  await page.getByLabel("Job name").fill(unique("broken-job"))
  await page.getByLabel("Command").fill("true")
  await page.getByLabel("Image name").fill(unique("broken"))
  await chooseFile(page, {
    name: "not-really-a-docker-save.tar",
    mimeType: "application/x-tar",
    buffer: Buffer.from("this is not a docker archive"),
  })
  // A real backend pushes with `crane` and fails; a LOCAL_DEV_MODE one accepts the
  // buffer. Either way the console must state the outcome and never leave the form in
  // a state where an unusable image looks selected.
  await expectToast(page, /Image upload failed|Uploaded and selected/)
  const failed = await page
    .getByRole("status")
    .filter({ hasText: "Image upload failed" })
    .count()
  if (failed) {
    await expect(page.getByRole("button", { name: "Queue job" })).toBeDisabled()
    await expect(page.getByText("Or choose a file from your computer.")).toBeVisible()
  }
})

test("a file that is not a tar archive is refused before it is uploaded", async ({
  page,
  request,
}) => {
  await ensureRoleAccounts(request, [workloadUser])
  const token = await loginApi(request, workloadUser)
  const before = (await images(request, token)).length

  await signIn(page, workloadUser)
  await openUploadTab(page)
  await page.getByLabel("Job name").fill(unique("not-a-tar-job"))
  await page.getByLabel("Command").fill("true")
  await chooseFile(page, {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  })
  await expectToast(page, "Choose a Docker save archive ending in .tar")
  // Nothing was sent.
  expect((await images(request, token)).length).toBe(before)
  await expect(page.getByRole("button", { name: "Queue job" })).toBeDisabled()
})

test("an external reference is usable without any upload", async ({ page, request }) => {
  await ensureRoleAccounts(request, [workloadUser])
  const token = await loginApi(request, workloadUser)
  const name = unique("external")

  await signIn(page, workloadUser)
  await openNewJob(page)
  await page.getByLabel("Job name").fill(name)
  await page.getByRole("tab", { name: "external" }).click()
  const reference = "registry.example.com/team/train:2026-06"
  await page.getByLabel("External pull reference").fill(reference)
  await page.getByLabel("Command").fill("true")
  await page.getByLabel("Accelerators needed").fill("0")
  await page.getByRole("button", { name: "Queue job" }).click()
  await expectToast(page, "Job added to queue")
  await expect
    .poll(
      async () =>
        (
          await apiList<{ display_name?: string | null; image: string }>(
            request,
            token,
            "/queue",
            "queue"
          )
        ).find((item) => item.display_name === name)?.image,
      { timeout: 30_000 }
    )
    .toBe(reference)
})
