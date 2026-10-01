/** Ids, repo names, brief paths and repo-relative path safety. Platform-neutral. */

import { PortError } from "./ports.ts"

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const PROJECT_ID_MAX = 30
export const ATTEMPT_ID_MAX = 63
export const BRIEF_DIR = ".shipboard/briefs/"

export function slug(input: string, max: number): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
}

export function randomHex(bytes = 2): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function newProjectId(name: string): string {
  return `${slug(name, 24) || "project"}-${randomHex(2)}`
}

export function newBriefId(task: string): string {
  return `${slug(task, 20) || "task"}-${randomHex(2)}`
}

export function newAttemptId(projectId: string, task: string): string {
  return `${projectId}--${slug(task, 16) || "task"}-${randomHex(2)}`
}

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && value.length <= PROJECT_ID_MAX && ID.test(value)
}

export function isBriefId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && ID.test(value)
}

/** `<projectId>--<slug>-<hex>`. Project ids never contain `--`, so the first `--` is the boundary. */
export function isAttemptId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > ATTEMPT_ID_MAX) return false
  const cut = value.indexOf("--")
  if (cut < 0) return false
  return isProjectId(value.slice(0, cut)) && ID.test(value.slice(cut + 2))
}

/** A repo in the namespace is either a project's main repo or one attempt's fork. */
export function isRepoName(value: unknown): value is string {
  return isProjectId(value) || isAttemptId(value)
}

/** The project a repo belongs to: the part before `--`, or the name itself for a main repo. */
export function projectIdOf(name: string): string {
  const cut = name.indexOf("--")
  return cut < 0 ? name : name.slice(0, cut)
}

export function briefPath(briefId: string): string {
  return `${BRIEF_DIR}${briefId}.json`
}

export type SafeRelOptions = {
  /** Allow a trailing `/` meaning "everything under this directory" (brief paths). */
  allowDir?: boolean
  /** Allow spaces inside path segments (previews of arbitrary repo files). */
  allowSpaces?: boolean
}

const UNSAFE_PATH = "Use a relative path inside the repo, like site/index.html."

/**
 * Normalises a repo-relative path and rejects anything that could escape the repo or touch git's
 * own directory. `.git` is matched case-insensitively and with the trailing dots/spaces and 8.3
 * short names that Windows and macOS filesystems fold onto `.git`.
 */
export function assertSafeRel(input: unknown, opts: SafeRelOptions = {}): string {
  if (typeof input !== "string") throw new PortError(UNSAFE_PATH, 400, "bad_path")
  let path = input.replace(/\\/g, "/").trim()
  if (!path || path.length > 200) throw new PortError(UNSAFE_PATH, 400, "bad_path")
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new PortError(UNSAFE_PATH, 400, "bad_path")
  if (!opts.allowSpaces && /\s/.test(path)) throw new PortError("Paths cannot contain spaces.", 400, "bad_path")
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) throw new PortError(UNSAFE_PATH, 400, "bad_path")
  let dir = false
  if (path.endsWith("/")) {
    if (!opts.allowDir) throw new PortError(UNSAFE_PATH, 400, "bad_path")
    dir = true
    path = path.slice(0, -1)
  }
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") throw new PortError(UNSAFE_PATH, 400, "bad_path")
    if (/^\.git[. ]*$/i.test(part) || /^\.?git~\d$/i.test(part)) {
      throw new PortError("Paths cannot touch the .git directory.", 400, "bad_path")
    }
  }
  return dir ? `${path}/` : path
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}

/** Collapses whitespace for commit messages and activity lines. */
export function oneLine(input: string, max = 120): string {
  const line = input.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "-------"
}

/** `a`, `a and b`, `a, b and c`, `a, b, c and 2 more`. */
export function listPhrase(items: string[], max = 3): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0] ?? ""
  if (items.length <= max) return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
  return `${items.slice(0, max).join(", ")} and ${items.length - max} more`
}
