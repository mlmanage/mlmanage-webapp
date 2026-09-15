/**
 * A real `docker save` archive for the image-upload tests.
 *
 * A production backend pushes the uploaded tarball to its registry with `crane`, so a
 * dummy buffer is rejected there (only a `LOCAL_DEV_MODE` backend accepts one). The
 * fixture is resolved in this order:
 *
 *   1. `MLMANAGE_E2E_IMAGE_TAR` - an archive supplied by the caller.
 *   2. `tests/.artifacts/docker-save.tar` - one produced by an earlier run.
 *   3. `docker save` of a tiny local image, pulling it first if necessary.
 *
 * If none of those works the upload tests skip with the reason, rather than failing for
 * a missing fixture on a machine without Docker.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"

const ARTIFACT_DIR = path.join(process.cwd(), "tests", ".artifacts")
const ARTIFACT = path.join(ARTIFACT_DIR, "docker-save.tar")
/** Small images, cheapest first; the first one already present locally is used. */
const CANDIDATES = ["busybox:latest", "alpine:latest", "hello-world:latest"]

let resolved: { path: string } | { reason: string } | null = null

function usable(file: string) {
  try {
    return statSync(file).size > 1024
  } catch {
    return false
  }
}

function docker(args: string[], timeout = 300_000) {
  execFileSync("docker", args, { stdio: "pipe", timeout })
}

function build(): { path: string } | { reason: string } {
  try {
    docker(["version", "--format", "{{.Server.Version}}"], 30_000)
  } catch {
    return {
      reason:
        "no Docker daemon and no MLMANAGE_E2E_IMAGE_TAR: cannot produce a real docker-save archive",
    }
  }
  let image = CANDIDATES.find((candidate) => {
    try {
      docker(["image", "inspect", candidate], 30_000)
      return true
    } catch {
      return false
    }
  })
  if (!image) {
    try {
      docker(["pull", CANDIDATES[0]])
      image = CANDIDATES[0]
    } catch {
      return { reason: `could not pull ${CANDIDATES[0]} to build the fixture` }
    }
  }
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true })
    docker(["save", image, "-o", ARTIFACT])
  } catch {
    return { reason: `docker save ${image} failed` }
  }
  return usable(ARTIFACT) ? { path: ARTIFACT } : { reason: "docker save produced no archive" }
}

/** Path to a real docker-save archive, or a reason the upload tests must skip. */
export function imageTar(): { path: string } | { reason: string } {
  if (resolved) return resolved
  const supplied = process.env.MLMANAGE_E2E_IMAGE_TAR
  if (supplied && usable(supplied)) resolved = { path: supplied }
  else if (supplied)
    resolved = { reason: `MLMANAGE_E2E_IMAGE_TAR=${supplied} is missing or empty` }
  else if (existsSync(ARTIFACT) && usable(ARTIFACT)) resolved = { path: ARTIFACT }
  else resolved = build()
  return resolved
}
