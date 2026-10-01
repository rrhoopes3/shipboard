/**
 * Fakes for the Cloudflare host, so its code runs in Node:
 * - FakeArtifacts implements the Artifacts binding over LocalArtifacts (bare repos) and the local
 *   git server, so isomorphic-git in the core really fetches and pushes over HTTP.
 * - FakeNamespace hands out Durable Object stubs that behave like Workers RPC: arguments and results
 *   are structured-cloned, and a thrown error arrives as a plain Error with only its message.
 * - FakeStorage is DO storage (key-value plus one alarm), cloning on the way in and out.
 */

import type { AddressInfo } from "node:net"
import path from "node:path"
import { serve } from "@hono/node-server"
import { isRepoName } from "../../src/core/names.ts"
import { ProjectDO } from "../../src/cloudflare/project-do.ts"
import { RegistryDO } from "../../src/cloudflare/registry-do.ts"
import type { Env } from "../../src/cloudflare/env.ts"
import { LocalArtifacts } from "../../src/local/artifacts.ts"
import { createGitHandler } from "../../src/local/gitserver.ts"
import { tempDir } from "../local/helpers.ts"

export const NAMESPACE = "shipboard"

const NUMERIC: Record<ArtifactsErrorCode, number> = {
  NOT_FOUND: 10200,
  ALREADY_EXISTS: 10201,
  CREATE_IN_PROGRESS: 10301,
  IMPORT_IN_PROGRESS: 10302,
  FORK_IN_PROGRESS: 10303,
  INVALID_INPUT: 10100,
  INVALID_REPO_NAME: 10101,
  INVALID_TTL: 10103,
  INVALID_URL: 10104,
  REMOTE_AUTH_REQUIRED: 10106,
  UPSTREAM_UNAVAILABLE: 10401,
  MEMORY_LIMIT: 10402,
  INTERNAL_ERROR: 10400,
}

export class FakeArtifactsError extends Error implements ArtifactsError {
  override readonly name = "ArtifactsError" as const
  readonly numericCode: number
  constructor(
    readonly code: ArtifactsErrorCode,
    message = `${code}: fake Artifacts error`,
  ) {
    super(message)
    this.numericCode = NUMERIC[code]
  }
}

export type Call = { op: string; name: string; detail?: unknown }

/** A tiny git server over `root/<namespace>/<name>.git`, plus LocalArtifacts pointing at it. */
export async function gitBackend(): Promise<{ local: LocalArtifacts; url: string; close(): Promise<void> }> {
  const dir = await tempDir("shipboard-cf-")
  let base = "http://127.0.0.1:0"
  const local = new LocalArtifacts({ root: path.join(dir, "git"), namespace: NAMESPACE, baseUrl: () => base })
  const handler = createGitHandler({ root: local.root, namespace: NAMESPACE, tokens: local.tokens })
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: handler, port: 0, hostname: "127.0.0.1" }, () => resolve(s))
    s.once("error", reject)
  })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    local,
    url: base,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        if ("closeAllConnections" in server) server.closeAllConnections()
      }),
  }
}

export class FakeArtifacts implements Artifacts {
  readonly calls: Call[] = []
  opened = 0
  disposed = 0
  /** A fresh fork answers get() with FORK_IN_PROGRESS this many times. */
  forkBusyGets = 0
  /** fork() itself throws FORK_IN_PROGRESS this many times first. */
  forkBusyCalls = 0
  /** An import answers get() with IMPORT_IN_PROGRESS this many times. */
  importBusyGets = 0
  /** Throw this code once from the named operation (create, get, import, delete, createToken, info, readFile, log, fork). */
  readonly failOnce = new Map<string, ArtifactsErrorCode>()
  /** Import sources: https URL → an existing local repo to copy, or null for a repo whose default branch is not main. */
  readonly upstreams = new Map<string, string | null>()
  /** createToken hands out the bare secret, without `?expires=`, when set. */
  bareTokens = false
  readonly defaultBranches = new Map<string, string>()
  private readonly busy = new Map<string, { code: ArtifactsErrorCode; left: number }>()

  constructor(readonly local: LocalArtifacts) {}

  fail(op: string): void {
    const code = this.failOnce.get(op)
    if (code) {
      this.failOnce.delete(op)
      throw new FakeArtifactsError(code)
    }
  }

  markBusy(name: string, code: ArtifactsErrorCode, left: number): void {
    if (left > 0) this.busy.set(name, { code, left })
  }

  async create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<ArtifactsCreateRepoResult> {
    this.calls.push({ op: "create", name, detail: opts })
    this.fail("create")
    if (!isRepoName(name)) throw new FakeArtifactsError("INVALID_REPO_NAME")
    if (await this.local.info(name)) throw new FakeArtifactsError("ALREADY_EXISTS")
    const info = await this.local.create(name, { description: opts?.description })
    const token = await this.local.token(name, "write", 86_400)
    return { id: `id-${name}`, name, description: opts?.description ?? null, defaultBranch: opts?.setDefaultBranch ?? "main", remote: info.remote, token: token.token }
  }

  async get(name: string): Promise<ArtifactsRepo> {
    this.calls.push({ op: "get", name })
    this.fail("get")
    const busy = this.busy.get(name)
    if (busy && busy.left > 0) {
      busy.left -= 1
      throw new FakeArtifactsError(busy.code)
    }
    if (!(await this.local.info(name))) throw new FakeArtifactsError("NOT_FOUND")
    this.opened += 1
    return new FakeRepo(this, name) as unknown as ArtifactsRepo
  }

  async import(params: {
    source: { url: string; branch?: string; depth?: number }
    target: { name: string; opts?: { description?: string; readOnly?: boolean } }
  }): Promise<ArtifactsCreateRepoResult> {
    const name = params.target.name
    this.calls.push({ op: "import", name, detail: params })
    this.fail("import")
    if (!this.upstreams.has(params.source.url)) throw new FakeArtifactsError("NOT_FOUND")
    if (await this.local.info(name)) throw new FakeArtifactsError("ALREADY_EXISTS")
    const from = this.upstreams.get(params.source.url)
    let remote: string
    if (from) {
      remote = (await this.local.fork(from, name)).remote
    } else {
      remote = (await this.local.create(name)).remote
      this.defaultBranches.set(name, "master")
    }
    this.markBusy(name, "IMPORT_IN_PROGRESS", this.importBusyGets)
    const token = await this.local.token(name, "write", 86_400)
    return { id: `id-${name}`, name, description: null, defaultBranch: this.defaultBranches.get(name) ?? "main", remote, token: token.token }
  }

  async list(): Promise<ArtifactsRepoListResult> {
    return { repos: [], total: 0 }
  }

  async delete(name: string): Promise<boolean> {
    this.calls.push({ op: "delete", name })
    this.fail("delete")
    if (!isRepoName(name)) throw new FakeArtifactsError("INVALID_REPO_NAME")
    return this.local.delete(name)
  }

  count(op: string, name?: string): number {
    return this.calls.filter((call) => call.op === op && (name === undefined || call.name === name)).length
  }
}

class FakeRepo {
  constructor(
    private readonly binding: FakeArtifacts,
    readonly name: string,
  ) {}

  private get local(): LocalArtifacts {
    return this.binding.local
  }

  async createToken(scope?: "write" | "read", ttl?: number): Promise<ArtifactsCreateTokenResult> {
    this.binding.calls.push({ op: "createToken", name: this.name, detail: { scope, ttl } })
    this.binding.fail("createToken")
    if (ttl !== undefined && (ttl < 60 || ttl > 31_536_000)) throw new FakeArtifactsError("INVALID_TTL")
    // The real binding defaults to write; so does this fake.
    const granted = scope ?? "write"
    const cred = await this.local.token(this.name, granted, ttl ?? 86_400)
    const plaintext = this.binding.bareTokens ? (cred.token.split("?expires=")[0] ?? cred.token) : cred.token
    return { id: `tok-${this.binding.calls.length}`, plaintext, scope: granted, expiresAt: cred.expiresAt }
  }

  async listTokens(): Promise<ArtifactsTokenListResult> {
    return { tokens: [], total: 0 }
  }

  async revokeToken(): Promise<boolean> {
    return false
  }

  async info(): Promise<ArtifactsRepoInfo> {
    this.binding.calls.push({ op: "info", name: this.name })
    this.binding.fail("info")
    const info = await this.local.info(this.name)
    if (!info) throw new FakeArtifactsError("NOT_FOUND")
    return {
      id: `id-${this.name}`,
      name: this.name,
      description: null,
      defaultBranch: this.binding.defaultBranches.get(this.name) ?? "main",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      lastPushAt: null,
      source: null,
      readOnly: false,
      remote: info.remote,
    }
  }

  async readBlob(): Promise<Blob | null> {
    return null
  }

  async readTree(): Promise<ArtifactsTreeEntry[] | null> {
    return null
  }

  async readCommit(): Promise<ArtifactsCommitMetadata | null> {
    return null
  }

  async readFile(args: { ref: string; path: string }): Promise<Blob | null> {
    this.binding.calls.push({ op: "readFile", name: this.name, detail: args })
    this.binding.fail("readFile")
    if (!args.ref || !args.path) throw new FakeArtifactsError("INVALID_INPUT")
    const bytes = await this.local.readFile(this.name, args.ref, args.path)
    return bytes ? new Blob([bytes as Uint8Array<ArrayBuffer>]) : null
  }

  async log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommitMetadata[]> {
    this.binding.calls.push({ op: "log", name: this.name, detail: opts })
    this.binding.fail("log")
    const ref = opts?.ref ?? "HEAD"
    const sha = /^[0-9a-f]{40}$/.test(ref) ? ref : await this.local.head(this.name, ref === "HEAD" ? "main" : ref.replace(/^refs\/heads\//, ""))
    if (!sha) return []
    const person = { name: "Fake", email: "fake@example.test" }
    return [{ hash: sha, treeHash: "", message: "", author: person, committer: person, parents: [], authoredAt: 0, committedAt: 0 }]
  }

  async fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<ArtifactsCreateRepoResult> {
    this.binding.calls.push({ op: "fork", name, detail: { from: this.name, ...opts } })
    if (this.binding.forkBusyCalls > 0) {
      this.binding.forkBusyCalls -= 1
      throw new FakeArtifactsError("FORK_IN_PROGRESS")
    }
    this.binding.fail("fork")
    if (await this.local.info(name)) throw new FakeArtifactsError("ALREADY_EXISTS")
    const info = await this.local.fork(this.name, name, { description: opts?.description })
    this.binding.markBusy(name, "FORK_IN_PROGRESS", this.binding.forkBusyGets)
    const token = await this.local.token(name, "write", 86_400)
    return { id: `id-${name}`, name, description: opts?.description ?? null, defaultBranch: "main", remote: info.remote, token: token.token }
  }

  [Symbol.dispose](): void {
    this.binding.disposed += 1
  }
}

// ---------------------------------------------------------------- Durable Objects

export class FakeStorage {
  readonly data = new Map<string, unknown>()
  alarm: number | null = null
  puts = 0

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.data.get(key)
    return value === undefined ? undefined : (structuredClone(value) as T)
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.puts += 1
    this.data.set(key, structuredClone(value))
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key)
  }

  async list<T = unknown>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort()
    const out = new Map<string, T>()
    for (const key of keys.slice(0, options.limit ?? keys.length)) out.set(key, structuredClone(this.data.get(key)) as T)
    return out
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm
  }

  async setAlarm(at: number | Date): Promise<void> {
    this.alarm = typeof at === "number" ? at : at.getTime()
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null
  }
}

export class FakeState {
  readonly storage = new FakeStorage()
  readonly pending = new Set<Promise<unknown>>()
  readonly id: { name?: string; toString(): string; equals(other: { toString(): string }): boolean }

  constructor(name: string | undefined) {
    this.id = { name, toString: () => `id:${name}`, equals: (other) => other.toString() === `id:${name}` }
  }

  waitUntil(promise: Promise<unknown>): void {
    const tracked = promise.finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
  }

  async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }
}

/** Behaves like a stub across Workers RPC: cloned arguments and results, and errors reduced to their message. */
export function rpcStub<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop) as unknown
      if (typeof value !== "function" || prop === "constructor") return value
      return async (...args: unknown[]) => {
        try {
          const result = await (value as (...a: unknown[]) => unknown).apply(obj, structuredClone(args))
          return result === undefined ? undefined : structuredClone(result)
        } catch (err) {
          throw new Error(err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}

export class FakeNamespace<T extends object> {
  readonly instances = new Map<string, { object: T; state: FakeState }>()
  /** When false, ctx.id.name is undefined inside the object, as in older runtimes. */
  exposeNames = true

  constructor(private readonly make: (state: FakeState) => T) {}

  idFromName(name: string): DurableObjectId {
    return { name, toString: () => `id:${name}`, equals: (other: DurableObjectId) => other.toString() === `id:${name}` }
  }

  idFromString(id: string): DurableObjectId {
    return this.idFromName(id.replace(/^id:/, ""))
  }

  newUniqueId(): DurableObjectId {
    return this.idFromName(`unique-${this.instances.size}`)
  }

  get(id: DurableObjectId): DurableObjectStub {
    return rpcStub(this.entry(id.name ?? id.toString()).object) as unknown as DurableObjectStub
  }

  getByName(name: string): DurableObjectStub {
    return this.get(this.idFromName(name))
  }

  jurisdiction(): DurableObjectNamespace {
    return this as unknown as DurableObjectNamespace
  }

  entry(name: string): { object: T; state: FakeState } {
    let entry = this.instances.get(name)
    if (!entry) {
      const state = new FakeState(this.exposeNames ? name : undefined)
      entry = { object: this.make(state), state }
      this.instances.set(name, entry)
    }
    return entry
  }

  /** Simulates eviction: the next call builds a fresh object over the same storage. */
  evict(name: string): void {
    const entry = this.instances.get(name)
    if (entry) this.instances.set(name, { object: this.make(entry.state), state: entry.state })
  }

  async idle(): Promise<void> {
    for (const { state } of this.instances.values()) await state.idle()
  }
}

// ---------------------------------------------------------------- the whole Worker environment

export type FakeAi = { run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>; calls: number }

export type TestEnv = Env & {
  ARTIFACTS: FakeArtifacts
  PROJECT: FakeNamespace<ProjectDO> & DurableObjectNamespace
  REGISTRY: FakeNamespace<RegistryDO> & DurableObjectNamespace
}

export function makeEnv(artifacts: FakeArtifacts, vars: Partial<Env> = {}): TestEnv {
  const env = {
    ARTIFACTS: artifacts,
    ASSETS: { fetch: async (request: Request) => new Response(`asset ${new URL(request.url).pathname}`) },
    PUBLIC_READ: "true",
    ARTIFACTS_NAMESPACE: NAMESPACE,
    BOARD_TOKEN: "board-secret",
    RUNNER_TOKEN: "runner-secret",
    REVIEW_MODEL: "",
    ...vars,
  } as unknown as TestEnv
  env.PROJECT = new FakeNamespace<ProjectDO>((state) => new ProjectDO(state as unknown as DurableObjectState, env)) as TestEnv["PROJECT"]
  env.REGISTRY = new FakeNamespace<RegistryDO>((state) => new RegistryDO(state as unknown as DurableObjectState, env)) as TestEnv["REGISTRY"]
  return env
}

export function fakeCtx(): ExecutionContext & { idle(): Promise<void> } {
  const pending = new Set<Promise<unknown>>()
  return {
    waitUntil(promise: Promise<unknown>) {
      pending.add(promise)
    },
    passThroughOnException() {},
    props: {},
    async idle() {
      await Promise.allSettled([...pending])
    },
  } as unknown as ExecutionContext & { idle(): Promise<void> }
}
