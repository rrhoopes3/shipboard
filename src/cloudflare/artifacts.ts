/**
 * CloudflareArtifacts: the core's ArtifactsPort over the Artifacts Workers binding.
 *
 * Binding facts this file leans on (research verdicts, 2026-10-01):
 * - `get()` returns a disposable capability, not metadata; metadata comes from `info()`.
 * - A new fork or import can answer `*_IN_PROGRESS` for a while, so those calls retry with backoff.
 * - Errors are matched on `err.code`, never on message wording.
 * - `createToken` defaults to write scope, so the scope is always passed.
 * - There is no ref API: a branch head is the first entry of `log({ ref, limit: 1 })`.
 */

import { assertSafeRel, isRepoName, oneLine } from "../core/names.ts"
import { PortError } from "../core/ports.ts"
import type { ArtifactsPort, Logger, RepoInfo } from "../core/ports.ts"
import type { GitCredentials } from "../core/types.ts"

const CODES: ReadonlySet<string> = new Set<ArtifactsErrorCode>([
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "CREATE_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "INVALID_INPUT",
  "INVALID_REPO_NAME",
  "INVALID_TTL",
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
  "INTERNAL_ERROR",
])

const IN_PROGRESS: ReadonlySet<string> = new Set(["CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS", "FORK_IN_PROGRESS"])

const SHA = /^[0-9a-f]{40}$/
const REF = /^(?:[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/
const TTL_MIN = 60
const TTL_MAX = 31_536_000

/** The `ArtifactsError` code of an error thrown by the binding, or null for anything else. */
export function artifactsCode(err: unknown): ArtifactsErrorCode | null {
  if (!err || typeof err !== "object") return null
  const code = (err as { code?: unknown }).code
  if (typeof code === "string" && CODES.has(code)) return code as ArtifactsErrorCode
  // Errors that crossed an RPC boundary can lose custom properties; the message still carries the code.
  const message = (err as { message?: unknown }).message
  if (typeof message === "string") {
    for (const known of CODES) if (new RegExp(`(^|[^A-Z_])${known}([^A-Z_]|$)`).test(message)) return known as ArtifactsErrorCode
  }
  return null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Maps a binding failure to the PortError (and HTTP status) the API reports. `repo` names the repo involved. */
export function toPortError(err: unknown, repo: string): PortError {
  if (err instanceof PortError) return err
  switch (artifactsCode(err)) {
    case "ALREADY_EXISTS":
      return new PortError(`A repo called ${repo} already exists.`, 409, "exists")
    case "NOT_FOUND":
      return new PortError(`There is no repo called ${repo}.`, 404, "not_found")
    case "CREATE_IN_PROGRESS":
    case "IMPORT_IN_PROGRESS":
    case "FORK_IN_PROGRESS":
      return new PortError(`${repo} is still being set up. Try again in a moment.`, 503, "busy")
    case "INVALID_REPO_NAME":
      return new PortError("That is not a valid repo name.", 400, "bad_name")
    case "INVALID_TTL":
      return new PortError("That token lifetime is out of range.", 400, "bad_request")
    case "INVALID_INPUT":
      return new PortError("Artifacts refused that request as invalid.", 400, "bad_request")
    case "INVALID_URL":
      return new PortError("That URL does not point at a git repository.", 400, "bad_url")
    case "REMOTE_AUTH_REQUIRED":
      return new PortError("That repository needs credentials. Only public repositories can be imported.", 400, "import_failed")
    case "UPSTREAM_UNAVAILABLE":
      return new PortError("The remote repository could not be reached. Try again later.", 502, "upstream")
    case "MEMORY_LIMIT":
      return new PortError(`${repo} is too large for Artifacts to handle in one go.`, 413, "too_large")
    case "INTERNAL_ERROR":
      return new PortError("Artifacts had an internal error. Try again in a moment.", 502, "artifacts")
    default:
      return new PortError(`Artifacts failed: ${oneLine(messageOf(err), 200)}`, 502, "artifacts")
  }
}

/** Accepts only a public https URL with no credentials in it. */
export function importUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new PortError("Give a public https git URL to import.", 400, "bad_url")
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new PortError("Give a public https git URL to import, with no credentials in it.", 400, "bad_url")
  }
  return url.toString()
}

/** The full token string the core and git clients expect: `art_v1_<hex>?expires=<unix>`. */
export function fullToken(plaintext: string, expiresAt: string | undefined): string {
  if (plaintext.includes("?expires=")) return plaintext
  const ms = Date.parse(expiresAt ?? "")
  return Number.isFinite(ms) ? `${plaintext}?expires=${Math.floor(ms / 1000)}` : plaintext
}

function expiryOf(token: string, expiresAt: string | undefined, fallbackMs: number): string {
  const ms = Date.parse(expiresAt ?? "")
  if (Number.isFinite(ms)) return new Date(ms).toISOString()
  const unix = Number(/\?expires=(\d+)/.exec(token)?.[1])
  return new Date(Number.isFinite(unix) && unix > 0 ? unix * 1000 : fallbackMs).toISOString()
}

function dispose(handle: unknown): void {
  if (typeof Symbol.dispose !== "symbol" || !handle || typeof handle !== "object") return
  const fn = (handle as { [Symbol.dispose]?: unknown })[Symbol.dispose]
  if (typeof fn === "function") {
    try {
      fn.call(handle)
    } catch {
      // Releasing a stub early is an optimisation; the request end releases it anyway.
    }
  }
}

function clipDescription(text: string | undefined): string | undefined {
  if (!text) return undefined
  const line = oneLine(text, 200)
  return line || undefined
}

/** Thrown inside the ready-wait loop when a repo answers but is not usable yet. */
class NotReady extends Error {
  readonly code = "FORK_IN_PROGRESS"
}

export type CloudflareArtifactsOptions = {
  log?: Logger
  /** Injected by tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>
  /** How long to wait for a repo that is still being created or forked. Default 30 s. */
  readyTimeoutMs?: number
  /** How long to wait for an import to finish. Default 90 s. */
  importTimeoutMs?: number
  now?: () => number
}

export class CloudflareArtifacts implements ArtifactsPort {
  /** Remote URLs never change for a repo name, so one `info()` per repo is enough. */
  private readonly remotes = new Map<string, string>()
  private readonly sleep: (ms: number) => Promise<void>
  private readonly readyTimeoutMs: number
  private readonly importTimeoutMs: number
  private readonly now: () => number
  private readonly log?: Logger

  constructor(
    private readonly binding: Artifacts,
    opts: CloudflareArtifactsOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000
    this.importTimeoutMs = opts.importTimeoutMs ?? 90_000
    this.now = opts.now ?? (() => Date.now())
    this.log = opts.log
  }

  async create(name: string, opts?: { description?: string }): Promise<RepoInfo> {
    this.checkName(name)
    try {
      const made = await this.binding.create(name, { description: clipDescription(opts?.description), setDefaultBranch: "main" })
      this.remotes.set(name, made.remote)
      return { name, remote: made.remote, defaultBranch: made.defaultBranch || "main" }
    } catch (err) {
      throw toPortError(err, name)
    }
  }

  async import(url: string, name: string): Promise<RepoInfo> {
    const source = importUrl(url)
    this.checkName(name)
    let remote: string
    try {
      const made = await this.binding.import({
        source: { url: source },
        target: { name, opts: { description: clipDescription(`Imported from ${source}`) } },
      })
      remote = made.remote
      this.remotes.set(name, remote)
    } catch (err) {
      if (artifactsCode(err) === "NOT_FOUND") throw new PortError("There is no public repository at that URL.", 400, "import_failed")
      throw toPortError(err, name)
    }
    try {
      const head = await this.whileBusy(() => this.headOnce(name, "main"), this.importTimeoutMs)
      if (!head) {
        const info = await this.info(name).catch(() => null)
        const branch = info?.defaultBranch && info.defaultBranch !== "main" ? `"${info.defaultBranch}"` : "not main"
        throw new PortError(`Shipboard builds on a branch called main. That repository's default branch is ${branch}.`, 400, "no_main")
      }
    } catch (err) {
      await this.delete(name).catch(() => false)
      throw toPortError(err, name)
    }
    return { name, remote, defaultBranch: "main" }
  }

  async fork(source: string, target: string, opts?: { description?: string }): Promise<RepoInfo> {
    this.checkName(source)
    this.checkName(target)
    const description = clipDescription(opts?.description)
    let remote: string | null = null
    let waited = 0
    let delay = 250
    for (let tries = 0; ; tries++) {
      try {
        const made = await this.withRepo(source, (repo) => repo.fork(target, { description, defaultBranchOnly: true }))
        remote = made.remote
        break
      } catch (err) {
        const code = artifactsCode(err)
        // A retry after FORK_IN_PROGRESS can find the fork an earlier try started; attempt ids are random, so it is ours.
        if (code === "ALREADY_EXISTS" && tries > 0) break
        if (code === "FORK_IN_PROGRESS" && waited < this.readyTimeoutMs) {
          await this.sleep(delay)
          waited += delay
          delay = Math.min(delay * 2, 2000)
          continue
        }
        throw toPortError(err, code === "NOT_FOUND" ? source : target)
      }
    }
    try {
      // Usable means: the handle opens and main has a commit to build on.
      await this.whileBusy(async () => {
        const head = await this.headOnce(target, "main")
        if (!head) throw new NotReady(`${target} has no main yet`)
        return head
      }, this.readyTimeoutMs)
      remote ??= await this.remoteOf(target)
    } catch (err) {
      this.log?.warn("fork not usable, removing it", { source, target, error: messageOf(err) })
      await this.binding.delete(target).catch(() => false)
      throw toPortError(err, target)
    }
    this.remotes.set(target, remote)
    return { name: target, remote, defaultBranch: "main" }
  }

  async info(name: string): Promise<RepoInfo | null> {
    if (!isRepoName(name)) return null
    try {
      return await this.withRepo(name, async (repo) => {
        const info = await repo.info()
        this.remotes.set(name, info.remote)
        return { name, remote: info.remote, defaultBranch: info.defaultBranch || "main" }
      })
    } catch (err) {
      if (artifactsCode(err) === "NOT_FOUND") return null
      throw toPortError(err, name)
    }
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<GitCredentials> {
    if (scope !== "read" && scope !== "write") throw new PortError('Scope is "read" or "write".', 400)
    this.checkName(name)
    const ttl = Math.max(TTL_MIN, Math.min(Math.floor(Number.isFinite(ttlSeconds) ? ttlSeconds : TTL_MIN), TTL_MAX))
    const issuedAt = this.now()
    try {
      return await this.withRepo(name, async (repo) => {
        const known = this.remotes.get(name)
        const [made, remote] = await Promise.all([
          // Always pass the scope: the binding defaults to write.
          repo.createToken(scope, ttl),
          known ? Promise.resolve(known) : repo.info().then((info) => info.remote),
        ])
        this.remotes.set(name, remote)
        const token = fullToken(made.plaintext, made.expiresAt)
        return {
          remote,
          token,
          expiresAt: expiryOf(token, made.expiresAt, issuedAt + ttl * 1000),
          scope: made.scope === "read" || made.scope === "write" ? made.scope : scope,
        }
      })
    } catch (err) {
      throw toPortError(err, name)
    }
  }

  async head(name: string, branch = "main"): Promise<string | null> {
    if (!isRepoName(name) || !REF.test(branch) || branch.includes("..")) return null
    try {
      return await this.whileBusy(() => this.headOnce(name, branch), this.readyTimeoutMs)
    } catch (err) {
      throw toPortError(err, name)
    }
  }

  async readFile(name: string, ref: string, file: string): Promise<Uint8Array | null> {
    if (!isRepoName(name) || !REF.test(ref) || ref.includes("..")) return null
    // The binding throws INVALID_INPUT for an empty path, and paths are repo-relative.
    const rel = file.replace(/^\/+/, "")
    if (!rel) return null
    let safe: string
    try {
      safe = assertSafeRel(rel, { allowSpaces: true })
    } catch {
      return null
    }
    try {
      return await this.withRepo(name, async (repo) => {
        const blob = await repo.readFile({ ref, path: safe })
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null
      })
    } catch (err) {
      const code = artifactsCode(err)
      if (code === "NOT_FOUND" || code === "INVALID_INPUT") return null
      throw toPortError(err, name)
    }
  }

  async delete(name: string): Promise<boolean> {
    if (!isRepoName(name)) return false
    try {
      const deleted = await this.binding.delete(name)
      this.remotes.delete(name)
      return deleted
    } catch (err) {
      if (artifactsCode(err) === "NOT_FOUND") return false
      throw toPortError(err, name)
    }
  }

  // ------------------------------------------------------------------ internals

  private checkName(name: string): void {
    if (!isRepoName(name)) throw new PortError("That is not a valid repo name.", 400, "bad_name")
  }

  /** null when the repo is gone or the branch has no commits; in-progress errors propagate. */
  private async headOnce(name: string, branch: string): Promise<string | null> {
    try {
      return await this.withRepoOnce(name, async (repo) => {
        let [commit] = await repo.log({ ref: branch, limit: 1 })
        // Cheap insurance in case the service resolves only fully qualified refs.
        if (!commit && !SHA.test(branch)) [commit] = await repo.log({ ref: `refs/heads/${branch}`, limit: 1 })
        return commit && SHA.test(commit.hash) ? commit.hash : null
      })
    } catch (err) {
      if (artifactsCode(err) === "NOT_FOUND") return null
      throw err
    }
  }

  private async remoteOf(name: string): Promise<string> {
    const known = this.remotes.get(name)
    if (known) return known
    const info = await this.withRepo(name, (repo) => repo.info())
    this.remotes.set(name, info.remote)
    return info.remote
  }

  /** Runs `fn` again while the repo answers `*_IN_PROGRESS`, backing off up to `budgetMs` in total. */
  private async whileBusy<T>(fn: () => Promise<T>, budgetMs: number): Promise<T> {
    let waited = 0
    let delay = 200
    for (;;) {
      try {
        return await fn()
      } catch (err) {
        const code = artifactsCode(err)
        if (!code || !IN_PROGRESS.has(code) || waited >= budgetMs) throw err
        await this.sleep(delay)
        waited += delay
        delay = Math.min(delay * 2, 2000)
      }
    }
  }

  /** Opens the repo (waiting out a create, fork or import still in progress), runs `fn`, then releases the handle. */
  private withRepo<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    return this.whileBusy(() => this.withRepoOnce(name, fn), this.readyTimeoutMs)
  }

  private async withRepoOnce<T>(name: string, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T> {
    const repo = await this.binding.get(name)
    try {
      return await fn(repo)
    } finally {
      dispose(repo)
    }
  }
}
