/**
 * The git engine. isomorphic-git over smart HTTP into an in-memory object store, so the same code
 * runs in Node and in a Durable Object. One workspace per project: main is fetched to
 * `refs/remotes/<projectId>/main` and each attempt to `refs/remotes/<attemptId>/main`, sharing one
 * object store. Full history always (merge bases need it). Every operation fetches first; the
 * object store only saves bandwidth.
 */

import git from "isomorphic-git"
import type { HttpClient, TreeEntry, WalkerEntry } from "isomorphic-git"
import webHttp from "isomorphic-git/http/web"
import { structuredPatch } from "diff"
import type { AcceptanceCheck } from "./digest.ts"
import { checkPath } from "./digest.ts"
import { MemoryFS } from "./memfs.ts"
import { Mutex } from "./mutex.ts"
import { PortError } from "./ports.ts"
import type { ArtifactsPort, Clock } from "./ports.ts"
import { READ_TOKEN_TTL, WRITE_TOKEN_TTL } from "./state.ts"
import type { CheckResult, FileStat, GitCredentials } from "./types.ts"

const GITDIR = "/repo"
const OUT_REF = "refs/heads/shipboard-out"
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
export const DIFF_LIMIT = 80_000
const MAX_TEXT_BYTES = 1_000_000
const DIFF_TIMEOUT_MS = 2_000

export type Person = { name: string; email: string }
export const SHIPBOARD_AUTHOR: Person = { name: "Shipboard", email: "shipboard@users.noreply.local" }

/** Repo-relative path → new bytes (or text), or null to delete. */
export type FileChanges = Record<string, Uint8Array | string | null>

export type TrialMerge = { state: "clean" | "conflict"; paths: string[]; mainSha: string; headSha: string }

export type AssessInput = {
  mainRepo: string
  forkRepo: string
  baseSha: string
  /** The attempt's own brief file and its canonical bytes. */
  brief: { path: string; bytes: Uint8Array }
  checks: AcceptanceCheck[]
}

export type AssessResult = {
  mainSha: string
  headSha: string
  files: FileStat[]
  checks: CheckResult[]
  /** The brief file at head still has the exact committed bytes. */
  briefIntact: boolean
  merge: TrialMerge
}

export type ShipResult =
  | { kind: "shipped"; mainSha: string; previousMain: string; headSha: string }
  | { kind: "moved"; headSha: string }
  | { kind: "conflict"; paths: string[]; mainSha: string; headSha: string }

export type GitWorkspaceOptions = {
  /** isomorphic-git HttpClient. Defaults to `isomorphic-git/http/web` (fetch). */
  http?: unknown
  clock?: Clock
}

type Side = { oid: string; mode: number; type: string }
type RawChange = { path: string; before: Side | null; after: Side | null }

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) return String((err as { code: unknown }).code)
  return undefined
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function conflictPaths(err: unknown): string[] {
  const data = (err as { data?: { filepaths?: unknown } }).data
  const paths = Array.isArray(data?.filepaths) ? data.filepaths.filter((p): p is string => typeof p === "string") : []
  return [...new Set(paths)].sort()
}

function failure(action: string, err: unknown): PortError {
  if (err instanceof PortError) return err
  const status = (err as { data?: { statusCode?: unknown } }).data?.statusCode
  if (status === 404) return new PortError(`The repo for ${action} was not found.`, 404, "not_found")
  return new PortError(`Git ${action} failed: ${errorMessage(err)}`, 502, "git")
}

function isPushRejection(err: unknown): boolean {
  const code = errorCode(err)
  return code === "PushRejectedError" || code === "GitPushError"
}

export function tokenSecret(token: string): string {
  return token.split("?expires=")[0] ?? token
}

function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, 8000)
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return true
  return false
}

function countLines(text: string): number {
  if (!text) return 0
  let lines = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return text.endsWith("\n") ? lines : lines + 1
}

function modeString(mode: number): string {
  return mode.toString(8).padStart(6, "0")
}

export class GitWorkspace {
  private readonly fs = new MemoryFS()
  private readonly cache: object = {}
  private readonly lock = new Mutex()
  private readonly http: HttpClient
  private readonly clock: Clock
  private readonly tokens = new Map<string, { cred: GitCredentials; until: number }>()
  private readonly remotes = new Map<string, string>()
  private initialised: Promise<void> | null = null

  constructor(
    private readonly artifacts: ArtifactsPort,
    options: GitWorkspaceOptions = {},
  ) {
    this.http = (options.http as HttpClient | undefined) ?? webHttp
    this.clock = options.clock ?? { now: () => new Date() }
  }

  /** Bytes held by the in-memory object store. */
  get memoryBytes(): number {
    return this.fs.size
  }

  // ------------------------------------------------------------------ public operations

  /** Fetches a repo's main and returns its sha, or null when the repo has no main yet. */
  head(repo: string): Promise<string | null> {
    return this.exclusive(() => this.fetchHead(repo))
  }

  /** Commits `files` as the first commit of an empty repo and pushes it to main. */
  seed(repo: string, files: Record<string, string | Uint8Array>, message: string): Promise<string> {
    return this.exclusive(async () => {
      const tree = await this.buildTree(null, this.changeMap(files))
      const sha = await this.writeCommit(tree, [], message, SHIPBOARD_AUTHOR)
      await this.pushOrMoved(repo, sha)
      return sha
    })
  }

  /**
   * Commits changes on top of the repo's current main and pushes. With `parent`, refuses (409)
   * when main is not at that sha. Returns the parent too, so callers know what the commit sits on.
   */
  commit(
    repo: string,
    changes: FileChanges,
    message: string,
    opts: { author?: Person; parent?: string } = {},
  ): Promise<{ sha: string; parent: string; changed: boolean }> {
    return this.exclusive(async () => {
      const parent = await this.fetchHead(repo)
      if (!parent) throw new PortError(`${repo} has no main branch to commit on.`, 409, "empty_repo")
      if (opts.parent && parent !== opts.parent) {
        throw new PortError(`${repo} moved to ${parent.slice(0, 7)} while shipboard was writing to it.`, 409, "moved")
      }
      const parentTree = (await git.readCommit({ fs: this.fs, gitdir: GITDIR, oid: parent, cache: this.cache })).commit.tree
      const tree = await this.buildTree(parentTree, this.changeMap(changes))
      if (tree === parentTree) return { sha: parent, parent, changed: false }
      const sha = await this.writeCommit(tree, [parent], message, opts.author ?? SHIPBOARD_AUTHOR)
      await this.pushOrMoved(repo, sha)
      return { sha, parent, changed: true }
    })
  }

  /** Writes the brief file on top of the fork's main as `brief: <task>`. */
  async commitBrief(repo: string, brief: { path: string; bytes: Uint8Array }, task: string): Promise<{ briefSha: string; baseSha: string }> {
    const result = await this.commit(repo, { [brief.path]: brief.bytes }, `brief: ${task}`)
    return { briefSha: result.sha, baseSha: result.parent }
  }

  /** File bytes at a commit of `repo`, fetching the repo when the commit is not here yet. */
  readAt(repo: string, sha: string, path: string): Promise<Uint8Array | null> {
    return this.exclusive(async () => {
      await this.ensureCommit(repo, sha)
      return this.readBlobAt(sha, path)
    })
  }

  trialMerge(mainRepo: string, forkRepo: string): Promise<TrialMerge> {
    return this.exclusive(async () => {
      const mainSha = await this.requireHead(mainRepo)
      const headSha = await this.requireHead(forkRepo)
      return this.mergeCheck(mainRepo, forkRepo, mainSha, headSha)
    })
  }

  /** Fetch main and fork; files, acceptance checks at head, brief integrity, trial merge. */
  assess(input: AssessInput): Promise<AssessResult> {
    return this.exclusive(async () => {
      const mainSha = await this.requireHead(input.mainRepo)
      const headSha = await this.requireHead(input.forkRepo)
      const changes = await this.listChanges(input.baseSha, headSha)
      const files: FileStat[] = []
      for (const change of changes) files.push((await this.describe(change, false)).stat)
      const checks: CheckResult[] = []
      for (const check of input.checks) {
        const path = checkPath(check)
        const bytes = path ? await this.readBlobAt(headSha, path) : null
        checks.push({ path: check.path, text: check.text, ok: bytes !== null && decoder.decode(bytes).includes(check.text) })
      }
      const briefAtHead = await this.readBlobAt(headSha, input.brief.path)
      const briefIntact = briefAtHead !== null && sameBytes(briefAtHead, input.brief.bytes)
      const merge = await this.mergeCheck(input.mainRepo, input.forkRepo, mainSha, headSha)
      return { mainSha, headSha, files, checks, briefIntact, merge }
    })
  }

  /**
   * Merges the fork into main as a real merge commit (parents [main, head]) and pushes main.
   * Refuses when the fork head is not `expectedHead` or the merge conflicts. A rejected push
   * (main moved underneath) re-fetches and tries once more, then gives up with 409.
   */
  ship(input: { mainRepo: string; forkRepo: string; expectedHead?: string; message: string }): Promise<ShipResult> {
    return this.exclusive(async () => {
      for (let round = 0; round < 2; round++) {
        const mainSha = await this.requireHead(input.mainRepo)
        const headSha = await this.requireHead(input.forkRepo)
        if (input.expectedHead && headSha !== input.expectedHead) return { kind: "moved", headSha }
        let oid: string
        try {
          const when = this.when()
          const result = await git.merge({
            fs: this.fs,
            gitdir: GITDIR,
            cache: this.cache,
            ours: this.tracking(input.mainRepo),
            theirs: this.tracking(input.forkRepo),
            fastForward: false,
            noUpdateBranch: true,
            abortOnConflict: true,
            message: input.message.endsWith("\n") ? input.message : `${input.message}\n`,
            author: { ...SHIPBOARD_AUTHOR, ...when },
            committer: { ...SHIPBOARD_AUTHOR, ...when },
          })
          if (result.alreadyMerged || !result.oid) {
            return { kind: "shipped", mainSha, previousMain: mainSha, headSha }
          }
          oid = result.oid
        } catch (err) {
          const code = errorCode(err)
          if (code === "MergeConflictError") return { kind: "conflict", paths: conflictPaths(err), mainSha, headSha }
          if (code === "MergeNotSupportedError") {
            return { kind: "conflict", paths: await this.overlap(mainSha, headSha), mainSha, headSha }
          }
          throw failure("merge", err)
        }
        try {
          await this.pushSha(input.mainRepo, oid)
          return { kind: "shipped", mainSha: oid, previousMain: mainSha, headSha }
        } catch (err) {
          if (!isPushRejection(err)) throw failure(`push to ${input.mainRepo}`, err)
        }
      }
      throw new PortError("Main kept moving while shipping. Try again.", 409, "main_moved")
    })
  }

  /** Unified diff baseSha..headSha, excluding `exclude` paths, truncated at `limit` characters. */
  diff(input: { repo: string; baseSha: string; headSha: string; exclude?: string[]; limit?: number }): Promise<{ diff: string; truncated: boolean }> {
    return this.exclusive(async () => {
      const limit = input.limit ?? DIFF_LIMIT
      await this.ensureCommit(input.repo, input.headSha)
      const exclude = new Set(input.exclude ?? [])
      let out = ""
      for (const change of await this.listChanges(input.baseSha, input.headSha)) {
        if (exclude.has(change.path)) continue
        out += (await this.describe(change, true)).patch
        if (out.length > limit) return { diff: out.slice(0, limit), truncated: true }
      }
      return { diff: out, truncated: false }
    })
  }

  /** File stats baseSha..headSha (both must be reachable from `repo`). */
  changedFiles(repo: string, baseSha: string, headSha: string): Promise<FileStat[]> {
    return this.exclusive(async () => {
      await this.ensureCommit(repo, headSha)
      const out: FileStat[] = []
      for (const change of await this.listChanges(baseSha, headSha)) out.push((await this.describe(change, false)).stat)
      return out
    })
  }

  // ------------------------------------------------------------------ internals

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.lock.run(async () => {
      await this.init()
      return task()
    })
  }

  private init(): Promise<void> {
    if (!this.initialised) {
      this.initialised = git.init({ fs: this.fs, gitdir: GITDIR, bare: true, defaultBranch: "main" }).catch((err: unknown) => {
        this.initialised = null
        throw err
      })
    }
    return this.initialised
  }

  private tracking(repo: string): string {
    return `refs/remotes/${repo}/main`
  }

  private when(): { timestamp: number; timezoneOffset: number } {
    return { timestamp: Math.floor(this.clock.now().getTime() / 1000), timezoneOffset: 0 }
  }

  private async credentials(repo: string, scope: "read" | "write"): Promise<GitCredentials> {
    const key = `${scope}:${repo}`
    const now = this.clock.now().getTime()
    const hit = this.tokens.get(key)
    if (hit && hit.until > now) return hit.cred
    const ttl = scope === "read" ? READ_TOKEN_TTL : WRITE_TOKEN_TTL
    const cred = await this.artifacts.token(repo, scope, ttl)
    const expires = Date.parse(cred.expiresAt)
    const until = Math.min(Number.isFinite(expires) ? expires : now + ttl * 1000, now + ttl * 1000) - 60_000
    this.tokens.set(key, { cred, until })
    return cred
  }

  private onAuth(cred: GitCredentials) {
    const password = tokenSecret(cred.token)
    return () => ({ username: "x", password })
  }

  /** Sent up front so each request skips the 401 round trip; onAuth stays as the fallback. */
  private authHeaders(cred: GitCredentials): Record<string, string> {
    return { Authorization: `Basic ${btoa(`x:${tokenSecret(cred.token)}`)}` }
  }

  private async resolve(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, gitdir: GITDIR, ref })
    } catch {
      return null
    }
  }

  /** isomorphic-git's fetch maps refs through the remote's configured refspec, so each repo gets one. */
  private async ensureRemote(repo: string, url: string): Promise<void> {
    if (this.remotes.get(repo) === url) return
    await git.addRemote({ fs: this.fs, gitdir: GITDIR, remote: repo, url, force: true })
    this.remotes.set(repo, url)
  }

  private async fetchHead(repo: string): Promise<string | null> {
    const cred = await this.credentials(repo, "read")
    await this.ensureRemote(repo, cred.remote)
    try {
      await git.fetch({
        fs: this.fs,
        http: this.http,
        gitdir: GITDIR,
        cache: this.cache,
        url: cred.remote,
        remote: repo,
        ref: "main",
        // All branches, so every local ref counts as a "have" and refetches stay small.
        singleBranch: false,
        tags: false,
        headers: this.authHeaders(cred),
        onAuth: this.onAuth(cred),
      })
    } catch (err) {
      if (errorCode(err) === "NotFoundError") return null
      if ((err as { data?: { statusCode?: unknown } }).data?.statusCode === 401) {
        this.tokens.delete(`read:${repo}`)
      }
      throw failure(`fetch of ${repo}`, err)
    }
    return this.resolve(this.tracking(repo))
  }

  private async requireHead(repo: string): Promise<string> {
    const sha = await this.fetchHead(repo)
    if (!sha) throw new PortError(`${repo} has no main branch.`, 409, "empty_repo")
    return sha
  }

  private async hasCommit(sha: string): Promise<boolean> {
    try {
      await git.readCommit({ fs: this.fs, gitdir: GITDIR, oid: sha, cache: this.cache })
      return true
    } catch {
      return false
    }
  }

  private async ensureCommit(repo: string, sha: string): Promise<void> {
    if (await this.hasCommit(sha)) return
    await this.fetchHead(repo)
    if (!(await this.hasCommit(sha))) throw new PortError(`Commit ${sha.slice(0, 7)} is not in ${repo}.`, 404, "not_found")
  }

  private async pushSha(repo: string, sha: string): Promise<void> {
    const cred = await this.credentials(repo, "write")
    await git.writeRef({ fs: this.fs, gitdir: GITDIR, ref: OUT_REF, value: sha, force: true })
    try {
      await git.push({
        fs: this.fs,
        http: this.http,
        gitdir: GITDIR,
        cache: this.cache,
        url: cred.remote,
        remote: repo,
        ref: OUT_REF,
        remoteRef: "refs/heads/main",
        headers: this.authHeaders(cred),
        onAuth: this.onAuth(cred),
      })
    } catch (err) {
      if ((err as { data?: { statusCode?: unknown } }).data?.statusCode === 401) this.tokens.delete(`write:${repo}`)
      // Rejections go back raw so ship can tell "main moved" from a broken remote.
      if (isPushRejection(err)) throw err
      throw failure(`push to ${repo}`, err)
    }
  }

  private async pushOrMoved(repo: string, sha: string): Promise<void> {
    try {
      await this.pushSha(repo, sha)
    } catch (err) {
      if (isPushRejection(err)) throw new PortError(`${repo} moved while shipboard was writing to it. Try again.`, 409, "moved")
      throw err
    }
  }

  private changeMap(files: FileChanges | Record<string, string | Uint8Array>): Map<string, Uint8Array | null> {
    const map = new Map<string, Uint8Array | null>()
    for (const [path, value] of Object.entries(files)) {
      map.set(path, value === null ? null : typeof value === "string" ? encoder.encode(value) : value)
    }
    return map
  }

  /** Applies path changes to a tree, rewriting only the subtrees they touch. Empty subtrees vanish. */
  private async buildTree(base: string | null, changes: Map<string, Uint8Array | null>): Promise<string> {
    const entries = new Map<string, TreeEntry>()
    if (base) {
      const { tree } = await git.readTree({ fs: this.fs, gitdir: GITDIR, oid: base, cache: this.cache })
      for (const entry of tree) entries.set(entry.path, entry)
    }
    const nested = new Map<string, Map<string, Uint8Array | null>>()
    for (const [path, data] of changes) {
      const cut = path.indexOf("/")
      if (cut >= 0) {
        const dir = path.slice(0, cut)
        let sub = nested.get(dir)
        if (!sub) {
          sub = new Map()
          nested.set(dir, sub)
        }
        sub.set(path.slice(cut + 1), data)
        continue
      }
      if (data === null) {
        entries.delete(path)
        continue
      }
      const oid = await git.writeBlob({ fs: this.fs, gitdir: GITDIR, blob: data })
      const previous = entries.get(path)
      const mode = previous?.type === "blob" && previous.mode === "100755" ? "100755" : "100644"
      entries.set(path, { mode, path, oid, type: "blob" })
    }
    for (const [dir, sub] of nested) {
      const previous = entries.get(dir)
      const oid = await this.buildTree(previous?.type === "tree" ? previous.oid : null, sub)
      if (oid === EMPTY_TREE) entries.delete(dir)
      else entries.set(dir, { mode: "040000", path: dir, oid, type: "tree" })
    }
    return git.writeTree({ fs: this.fs, gitdir: GITDIR, tree: [...entries.values()] })
  }

  private async writeCommit(tree: string, parents: string[], message: string, author: Person): Promise<string> {
    const when = this.when()
    return git.writeCommit({
      fs: this.fs,
      gitdir: GITDIR,
      commit: {
        tree,
        parent: parents,
        message: message.endsWith("\n") ? message : `${message}\n`,
        author: { ...author, ...when },
        committer: { ...SHIPBOARD_AUTHOR, ...when },
      },
    })
  }

  private async readBlobAt(sha: string, path: string): Promise<Uint8Array | null> {
    try {
      const { blob } = await git.readBlob({ fs: this.fs, gitdir: GITDIR, oid: sha, filepath: path, cache: this.cache })
      return blob
    } catch {
      return null
    }
  }

  private async readBlob(oid: string): Promise<Uint8Array> {
    return (await git.readBlob({ fs: this.fs, gitdir: GITDIR, oid, cache: this.cache })).blob
  }

  private async mergeCheck(mainRepo: string, forkRepo: string, mainSha: string, headSha: string): Promise<TrialMerge> {
    try {
      await git.merge({
        fs: this.fs,
        gitdir: GITDIR,
        cache: this.cache,
        ours: this.tracking(mainRepo),
        theirs: this.tracking(forkRepo),
        dryRun: true,
        noUpdateBranch: true,
        abortOnConflict: true,
        author: { ...SHIPBOARD_AUTHOR, ...this.when() },
      })
      return { state: "clean", paths: [], mainSha, headSha }
    } catch (err) {
      const code = errorCode(err)
      if (code === "MergeConflictError") return { state: "conflict", paths: conflictPaths(err), mainSha, headSha }
      // add/add and file/directory clashes, or several merge bases: isomorphic-git gives up
      // without naming paths, so report the paths both sides changed.
      if (code === "MergeNotSupportedError") return { state: "conflict", paths: await this.overlap(mainSha, headSha), mainSha, headSha }
      throw failure("trial merge", err)
    }
  }

  private async overlap(mainSha: string, headSha: string): Promise<string[]> {
    const bases = (await git.findMergeBase({ fs: this.fs, gitdir: GITDIR, cache: this.cache, oids: [mainSha, headSha] })) as string[]
    const base = bases[0]
    if (!base) return (await this.listChanges(mainSha, headSha)).map((change) => change.path)
    const ours = new Set((await this.listChanges(base, mainSha)).map((change) => change.path))
    return (await this.listChanges(base, headSha)).map((change) => change.path).filter((path) => ours.has(path))
  }

  /** Paths whose blob or mode differ between two commits. No rename detection. Sorted by path. */
  private async listChanges(fromSha: string, toSha: string): Promise<RawChange[]> {
    const changes: RawChange[] = []
    await git.walk({
      fs: this.fs,
      gitdir: GITDIR,
      cache: this.cache,
      trees: [git.TREE({ ref: fromSha }), git.TREE({ ref: toSha })],
      map: async (filepath: string, entries: Array<WalkerEntry | null>) => {
        if (filepath === ".") return true
        const [a, b] = entries
        const at = a ? await a.type() : null
        const bt = b ? await b.type() : null
        const ao = a ? await a.oid() : null
        const bo = b ? await b.oid() : null
        if (at === "tree" && bt === "tree") return ao === bo ? null : true
        const before = a && at !== "tree" && ao ? { oid: ao, mode: await a.mode(), type: at ?? "blob" } : null
        const after = b && bt !== "tree" && bo ? { oid: bo, mode: await b.mode(), type: bt ?? "blob" } : null
        if (before || after) {
          const same = before && after && before.oid === after.oid && before.mode === after.mode
          if (!same) changes.push({ path: filepath, before, after })
        }
        return at === "tree" || bt === "tree" ? true : null
      },
    })
    return changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
  }

  private async content(side: Side | null): Promise<Uint8Array | null> {
    if (!side || side.type !== "blob") return null
    return this.readBlob(side.oid)
  }

  /** Line counts, and with `withPatch` a git-style unified diff section for one path. */
  private async describe(change: RawChange, withPatch: boolean): Promise<{ stat: FileStat; patch: string }> {
    const status: FileStat["status"] = !change.before ? "added" : !change.after ? "deleted" : "modified"
    const before = await this.content(change.before)
    const after = await this.content(change.after)
    const path = change.path
    let header = `diff --git a/${path} b/${path}\n`
    if (status === "added") header += `new file mode ${modeString(change.after?.mode ?? 0o100644)}\n`
    else if (status === "deleted") header += `deleted file mode ${modeString(change.before?.mode ?? 0o100644)}\n`
    else if (change.before && change.after && change.before.mode !== change.after.mode) {
      header += `old mode ${modeString(change.before.mode)}\nnew mode ${modeString(change.after.mode)}\n`
    }
    const stat: FileStat = { path, status, additions: 0, deletions: 0 }
    const tooBig = (before?.byteLength ?? 0) > MAX_TEXT_BYTES || (after?.byteLength ?? 0) > MAX_TEXT_BYTES
    const binary = (before !== null && looksBinary(before)) || (after !== null && looksBinary(after))
    const left = status === "added" ? "/dev/null" : `a/${path}`
    const right = status === "deleted" ? "/dev/null" : `b/${path}`
    if (tooBig || binary) {
      return { stat, patch: withPatch ? `${header}Binary files ${left} and ${right} differ\n` : "" }
    }
    const oldText = before ? decoder.decode(before) : ""
    const newText = after ? decoder.decode(after) : ""
    if (status === "added" && !withPatch) return { stat: { ...stat, additions: countLines(newText) }, patch: "" }
    if (status === "deleted" && !withPatch) return { stat: { ...stat, deletions: countLines(oldText) }, patch: "" }
    const patch = structuredPatch(left, right, oldText, newText, undefined, undefined, { context: 3, timeout: DIFF_TIMEOUT_MS })
    if (!patch) return { stat, patch: withPatch ? `${header}(diff too large to show)\n` : "" }
    let body = ""
    for (const hunk of patch.hunks) {
      const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart
      const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart
      if (withPatch) body += `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@\n`
      for (const line of hunk.lines) {
        if (line.startsWith("+")) stat.additions++
        else if (line.startsWith("-")) stat.deletions++
        if (withPatch) body += `${line}\n`
      }
    }
    if (!withPatch) return { stat, patch: "" }
    return { stat, patch: body ? `${header}--- ${left}\n+++ ${right}\n${body}` : header }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}
