/**
 * LocalArtifacts: the ArtifactsPort over bare repos on disk, served by `git http-backend`.
 * Repos live at `<root>/<namespace>/<name>.git`. Tokens mimic Artifacts (`art_v1_<40 hex>?expires=<unix>`),
 * are kept in memory, and are scoped to one repo and one scope.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { assertSafeRel, isRepoName } from "../core/names.ts"
import { PortError } from "../core/ports.ts"
import type { ArtifactsPort, Clock, RepoInfo } from "../core/ports.ts"
import type { GitCredentials } from "../core/types.ts"
import { runGit } from "./gitexec.ts"

export type TokenGrant = { repo: string; scope: "read" | "write"; expiresAt: number }
export type TokenCheck = "ok" | "unknown" | "forbidden"

export class TokenStore {
  private readonly grants = new Map<string, TokenGrant>()

  constructor(private readonly clock: Clock) {}

  mint(repo: string, scope: "read" | "write", ttlSeconds: number): { token: string; expiresAt: number } {
    this.prune()
    const secret = `art_v1_${randomBytes(20).toString("hex")}`
    const ttl = Math.max(60, Math.min(Math.floor(ttlSeconds), 31_536_000))
    const expiresAt = this.clock.now().getTime() + ttl * 1000
    this.grants.set(secret, { repo, scope, expiresAt })
    return { token: `${secret}?expires=${Math.floor(expiresAt / 1000)}`, expiresAt }
  }

  /** `token` may be the full string or just the secret before `?expires=`. */
  check(token: string, repo: string, need: "read" | "write"): TokenCheck {
    const secret = token.split("?expires=")[0] ?? ""
    const grant = this.grants.get(secret)
    if (!grant) return "unknown"
    if (grant.expiresAt <= this.clock.now().getTime()) {
      this.grants.delete(secret)
      return "unknown"
    }
    if (grant.repo !== repo) return "forbidden"
    if (need === "write" && grant.scope !== "write") return "forbidden"
    return "ok"
  }

  revokeRepo(repo: string): void {
    for (const [secret, grant] of this.grants) if (grant.repo === repo) this.grants.delete(secret)
  }

  private prune(): void {
    const now = this.clock.now().getTime()
    for (const [secret, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(secret)
  }
}

export type LocalArtifactsOptions = {
  /** Directory holding `<namespace>/<name>.git`. */
  root: string
  namespace?: string
  /** Origin the git route is served on, e.g. `http://127.0.0.1:8787`. Read on every call. */
  baseUrl: () => string
  clock?: Clock
  /** Tests only: allow `http://` imports from loopback. */
  allowInsecureImport?: boolean
}

const REPO_CONFIG = [
  "[http]",
  "\treceivepack = true",
  "[receive]",
  // Forks keep their brief commit: no force pushes, no deleted branches.
  "\tdenyNonFastForwards = true",
  "\tdenyDeletes = true",
  "\tfsckObjects = true",
  // gc after a push would keep http-backend alive after the client is done; repos here stay small.
  "\tautogc = false",
  "[gc]",
  "\tauto = 0",
  "[core]",
  "\tlogAllRefUpdates = false",
  "",
].join("\n")

const REF = /^(?:[0-9a-f]{40}|[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/

export class LocalArtifacts implements ArtifactsPort {
  readonly root: string
  readonly namespace: string
  readonly tokens: TokenStore
  private readonly baseUrl: () => string
  private readonly allowInsecureImport: boolean

  constructor(opts: LocalArtifactsOptions) {
    this.root = path.resolve(opts.root)
    this.namespace = opts.namespace ?? "local"
    this.baseUrl = opts.baseUrl
    this.tokens = new TokenStore(opts.clock ?? { now: () => new Date() })
    this.allowInsecureImport = opts.allowInsecureImport ?? false
  }

  /** Throws 400 for anything that is not a project or attempt id, so names never reach the filesystem unchecked. */
  repoDir(name: string): string {
    if (!isRepoName(name)) throw new PortError("That is not a valid repo name.", 400, "bad_name")
    return path.join(this.root, this.namespace, `${name}.git`)
  }

  remote(name: string): string {
    return `${this.baseUrl()}/git/${this.namespace}/${name}.git`
  }

  private async exists(name: string): Promise<boolean> {
    try {
      return (await fs.stat(path.join(this.repoDir(name), "HEAD"))).isFile()
    } catch {
      return false
    }
  }

  private infoFor(name: string): RepoInfo {
    return { name, remote: this.remote(name), defaultBranch: "main" }
  }

  private async configure(dir: string, description?: string): Promise<void> {
    await fs.appendFile(path.join(dir, "config"), REPO_CONFIG)
    await fs.writeFile(path.join(dir, "description"), `${(description ?? "").replace(/\s+/g, " ").slice(0, 200)}\n`)
  }

  async create(name: string, opts?: { description?: string }): Promise<RepoInfo> {
    const dir = this.repoDir(name)
    if (await this.exists(name)) throw new PortError(`A repo called ${name} already exists.`, 409, "exists")
    await fs.mkdir(path.dirname(dir), { recursive: true })
    try {
      await runGit(["init", "--bare", "--quiet", "--initial-branch=main", "--", dir])
      await this.configure(dir, opts?.description)
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true })
      throw err
    }
    return this.infoFor(name)
  }

  async import(url: string, name: string): Promise<RepoInfo> {
    const dir = this.repoDir(name)
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new PortError("Give a public https git URL to import.", 400)
    }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
    const insecureOk = this.allowInsecureImport && parsed.protocol === "http:" && loopback
    if ((parsed.protocol !== "https:" && !insecureOk) || parsed.username || parsed.password) {
      throw new PortError("Give a public https git URL to import, with no credentials in it.", 400)
    }
    if (await this.exists(name)) throw new PortError(`A repo called ${name} already exists.`, 409, "exists")
    await fs.mkdir(path.dirname(dir), { recursive: true })
    const protocols = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always"]
    if (insecureOk) protocols.push("-c", "protocol.http.allow=always")
    try {
      await runGit([...protocols, "clone", "--bare", "--single-branch", "--no-tags", "--quiet", "--", parsed.toString(), dir], {
        timeoutMs: 180_000,
      })
      const head = (await runGit(["-C", dir, "symbolic-ref", "--short", "HEAD"], { allowFail: true })).stdout.toString("utf8").trim()
      // The core works on `main`; an imported repo whose default branch has another name is renamed.
      if (head && head !== "main") await runGit(["-C", dir, "branch", "-m", "--", head, "main"])
      await runGit(["-C", dir, "symbolic-ref", "HEAD", "refs/heads/main"])
      await runGit(["-C", dir, "remote", "remove", "origin"], { allowFail: true })
      await this.configure(dir, `Imported from ${parsed.toString()}`)
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true })
      if (err instanceof PortError) throw err
      throw new PortError(`Could not import that repo: ${err instanceof Error ? err.message : String(err)}`, 400, "import_failed")
    }
    return this.infoFor(name)
  }

  async fork(source: string, target: string, opts?: { description?: string }): Promise<RepoInfo> {
    const from = this.repoDir(source)
    const dir = this.repoDir(target)
    if (!(await this.exists(source))) throw new PortError(`There is no repo called ${source}.`, 404, "not_found")
    if (await this.exists(target)) throw new PortError(`A repo called ${target} already exists.`, 409, "exists")
    try {
      await runGit(["clone", "--bare", "--single-branch", "--branch", "main", "--no-tags", "--quiet", "--", from, dir])
      await runGit(["-C", dir, "remote", "remove", "origin"], { allowFail: true })
      await this.configure(dir, opts?.description)
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true })
      throw err
    }
    return this.infoFor(target)
  }

  async info(name: string): Promise<RepoInfo | null> {
    if (!isRepoName(name) || !(await this.exists(name))) return null
    return this.infoFor(name)
  }

  async token(name: string, scope: "read" | "write", ttlSeconds: number): Promise<GitCredentials> {
    if (scope !== "read" && scope !== "write") throw new PortError('Scope is "read" or "write".', 400)
    if (!(await this.exists(name))) throw new PortError(`There is no repo called ${name}.`, 404, "not_found")
    const { token, expiresAt } = this.tokens.mint(name, scope, ttlSeconds)
    return { remote: this.remote(name), token, expiresAt: new Date(expiresAt).toISOString(), scope }
  }

  async head(name: string, branch = "main"): Promise<string | null> {
    if (!isRepoName(name) || !REF.test(branch) || branch.includes("..")) return null
    if (!(await this.exists(name))) return null
    const out = await runGit(["-C", this.repoDir(name), "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], {
      allowFail: true,
    })
    const sha = out.stdout.toString("utf8").trim()
    return out.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null
  }

  async readFile(name: string, ref: string, file: string): Promise<Uint8Array | null> {
    if (!isRepoName(name) || !REF.test(ref) || ref.includes("..")) return null
    let rel: string
    try {
      rel = assertSafeRel(file, { allowSpaces: true })
    } catch {
      return null
    }
    if (!(await this.exists(name))) return null
    const out = await runGit(["-C", this.repoDir(name), "cat-file", "--batch"], { input: `${ref}:${rel}\n`, allowFail: true })
    if (out.code !== 0) return null
    const buf = out.stdout
    const eol = buf.indexOf(10)
    if (eol < 0) return null
    const header = buf.subarray(0, eol).toString("utf8").split(" ")
    if (header.length !== 3 || header[1] !== "blob") return null
    const size = Number(header[2])
    if (!Number.isInteger(size) || size < 0 || eol + 1 + size > buf.length) return null
    return new Uint8Array(buf.subarray(eol + 1, eol + 1 + size))
  }

  async delete(name: string): Promise<boolean> {
    if (!isRepoName(name) || !(await this.exists(name))) return false
    this.tokens.revokeRepo(name)
    await fs.rm(this.repoDir(name), { recursive: true, force: true })
    return true
  }
}
