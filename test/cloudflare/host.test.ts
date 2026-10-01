import { describe, expect, it } from "vitest"
import { CloudflareHost, projectStub } from "../../src/cloudflare/host.ts"
import { RegistryDO, RegistryStore, SEEN_RESOLUTION_MS } from "../../src/cloudflare/registry-do.ts"
import { ProjectClient, call, envelope } from "../../src/cloudflare/rpc.ts"
import type { Envelope, ProjectRpc } from "../../src/cloudflare/rpc.ts"
import { PortError } from "../../src/core/ports.ts"
import type { ProjectSummary } from "../../src/core/types.ts"
import { FakeNamespace, FakeStorage } from "./fakes.ts"

const quiet = { info: () => {}, warn: () => {}, error: () => {} }

function summary(id: string, createdAt: string, name = "Keel notes"): ProjectSummary {
  return {
    id,
    name,
    description: "",
    createdAt,
    mainSha: "a".repeat(40),
    counts: { rerun: 0, ship: 0, review: 0, working: 0, parked: 0, shipped: 0 },
  }
}

/** A ProjectRpc that answers from a script, recording which object (by name) each call reached. */
class ScriptedProject {
  static calls: Array<{ name: string; method: string; args: unknown[] }> = []
  static initAnswers: Array<Envelope<ProjectSummary>> = []
  static summaries = new Map<string, Envelope<ProjectSummary>>()

  constructor(private readonly name: string) {}

  private note(method: string, args: unknown[]) {
    ScriptedProject.calls.push({ name: this.name, method, args })
  }

  async init(input: { id: string; name: string }): Promise<Envelope<ProjectSummary>> {
    this.note("init", [input])
    const answer = ScriptedProject.initAnswers.shift() ?? { ok: true as const, value: summary(input.id, "2026-10-01T00:00:00.000Z", input.name) }
    if (answer.ok) ScriptedProject.summaries.set(input.id, answer)
    return answer
  }

  async summary(): Promise<Envelope<ProjectSummary>> {
    this.note("summary", [])
    return ScriptedProject.summaries.get(this.name) ?? { ok: false, error: { message: "No project with that id.", status: 404, code: "not_found" } }
  }

  async version(): Promise<Envelope<number>> {
    this.note("version", [])
    return { ok: true, value: 7 }
  }
}

function hostEnv(vars: Record<string, string | undefined> = {}) {
  ScriptedProject.calls = []
  ScriptedProject.initAnswers = []
  ScriptedProject.summaries = new Map()
  const PROJECT = new FakeNamespace((state) => new ScriptedProject(state.id.name ?? "?"))
  const REGISTRY = new FakeNamespace((state) => new RegistryDO(state as unknown as DurableObjectState, {} as never))
  return {
    env: { PROJECT, REGISTRY, ...vars } as unknown as ConstructorParameters<typeof CloudflareHost>[0],
    PROJECT,
    REGISTRY,
  }
}

async function rejects(promise: Promise<unknown>): Promise<PortError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(PortError)
    return err as PortError
  }
  throw new Error("expected a rejection")
}

describe("RPC envelopes", () => {
  it("carries a PortError's status and code across the boundary", async () => {
    const failed = await envelope(quiet, "ship", async () => {
      throw new PortError("This attempt conflicts with main.", 409, "conflict")
    })
    expect(failed).toEqual({ ok: false, error: { message: "This attempt conflicts with main.", status: 409, code: "conflict" } })
    const err = await rejects(call(async () => failed))
    expect(err.status).toBe(409)
    expect(err.code).toBe("conflict")
    expect(await call(async () => ({ ok: true as const, value: 3 }))).toBe(3)
  })

  it("hides unexpected errors behind a 500 and logs them", async () => {
    const logged: string[] = []
    const out = await envelope({ ...quiet, error: (message) => void logged.push(message) }, "board", async () => {
      throw new TypeError("x is undefined")
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.error.status).toBe(500)
      expect(out.error.message).not.toContain("undefined")
    }
    expect(logged).toEqual(["project call failed"])
  })

  it("turns a reset or overloaded object into a 503 and passes other stub failures through", async () => {
    const reset = Object.assign(new Error("Durable Object reset because its code was updated."), { retryable: true })
    expect((await rejects(call(() => Promise.reject(reset)))).status).toBe(503)
    const overloaded = Object.assign(new Error("Durable Object is overloaded."), { overloaded: true })
    expect((await rejects(call(() => Promise.reject(overloaded)))).code).toBe("busy")
    await expect(call(() => Promise.reject(new Error("network lost")))).rejects.toThrow("network lost")
    expect((await rejects(call(async () => "not an envelope" as never))).status).toBe(500)
  })

  it("ProjectClient forwards every ProjectHandle method to the stub", async () => {
    const seen: string[] = []
    const stub = new Proxy({} as ProjectRpc, {
      get: (_, method: string) => async () => {
        seen.push(method)
        return { ok: true, value: method }
      },
    })
    const client = new ProjectClient(stub)
    const methods = [
      "init", "summary", "board", "version", "dispatch", "pushed", "onPushEvent", "ship", "park", "unpark", "rerun",
      "diff", "preview", "claim", "nextJobAt", "heartbeat", "jobCredentials", "finish", "runDemoJobs", "tick",
    ] as const
    for (const method of methods) {
      expect(await (client[method] as (...args: unknown[]) => Promise<unknown>)()).toBe(method)
    }
    expect(seen).toEqual([...methods])
  })
})

describe("CloudflareHost", () => {
  it("reads its mode, namespace, secrets and read policy from env", () => {
    let host = new CloudflareHost(hostEnv({ BOARD_TOKEN: "b", RUNNER_TOKEN: "r", ARTIFACTS_NAMESPACE: "shipboard-dev" }).env)
    expect(host.mode).toBe("cloudflare")
    expect(host.namespace).toBe("shipboard-dev")
    expect(host.boardToken).toBe("b")
    expect(host.runnerToken).toBe("r")
    expect(host.publicRead).toBe(true)
    host = new CloudflareHost(hostEnv({ BOARD_TOKEN: " ", PUBLIC_READ: "FALSE" }).env)
    expect(host.namespace).toBe("shipboard")
    expect(host.boardToken).toBeUndefined()
    expect(host.runnerToken).toBeUndefined()
    expect(host.publicRead).toBe(false)
    expect(new CloudflareHost(hostEnv({ PUBLIC_READ: "true" }).env).publicRead).toBe(true)
  })

  it("routes a project id to the object of that name, and refuses non-ids without a call", async () => {
    const { env } = hostEnv()
    const host = new CloudflareHost(env, { log: quiet })
    expect(await (await host.project("keel-notes-a1b2")).version()).toBe(7)
    expect(ScriptedProject.calls).toEqual([{ name: "keel-notes-a1b2", method: "version", args: [] }])
    expect((await rejects(host.project("Keel Notes"))).status).toBe(404)
    expect((await rejects(host.project("keel-notes-a1b2--lede-0001"))).status).toBe(404)
    expect(ScriptedProject.calls).toHaveLength(1)
    // An unknown id reaches its (empty) object, which answers 404 itself.
    expect((await rejects((await host.project("ghost-0000")).summary())).status).toBe(404)
  })

  it("creates a project: validates first, registers it, and inits its object", async () => {
    const { env } = hostEnv()
    const host = new CloudflareHost(env, { log: quiet })
    expect((await rejects(host.createProject({ name: "" }))).status).toBe(400)
    expect(ScriptedProject.calls).toHaveLength(0)

    const made = await host.createProject({ name: "Keel notes", seed: "starter" })
    expect(made.id).toMatch(/^keel-notes-[0-9a-f]{4}$/)
    const init = ScriptedProject.calls.find((c) => c.method === "init")
    expect(init?.name).toBe(made.id)
    expect(init?.args[0]).toMatchObject({ id: made.id, name: "Keel notes", seed: "starter" })
    expect((await host.listProjects()).map((p) => p.id)).toEqual([made.id])
  })

  it("picks a new id when the first one collides, and unlists a project whose init failed", async () => {
    const { env } = hostEnv()
    const host = new CloudflareHost(env, { log: quiet })
    ScriptedProject.initAnswers.push({ ok: false, error: { message: "A repo called x already exists.", status: 409, code: "exists" } })
    const made = await host.createProject({ name: "Keel notes" })
    const inits = ScriptedProject.calls.filter((c) => c.method === "init")
    expect(inits).toHaveLength(2)
    expect(inits[0]?.name).not.toBe(inits[1]?.name)
    expect((await host.listProjects()).map((p) => p.id)).toEqual([made.id])

    ScriptedProject.initAnswers.push({ ok: false, error: { message: "Git push failed.", status: 502, code: "git" } })
    const err = await rejects(host.createProject({ name: "Broken" }))
    expect(err.status).toBe(502)
    expect((await host.listProjects()).map((p) => p.id)).toEqual([made.id])
  })

  it("lists projects newest first and skips ids whose object has no project", async () => {
    const { env } = hostEnv()
    const host = new CloudflareHost(env, { log: quiet })
    const reg = env.REGISTRY.get(env.REGISTRY.idFromName("registry")) as unknown as RegistryStore
    await reg.add({ id: "old-0001", name: "Old", createdAt: "2026-09-01T00:00:00.000Z" })
    await reg.add({ id: "new-0002", name: "New", createdAt: "2026-09-30T00:00:00.000Z" })
    await reg.add({ id: "ghost-0003", name: "Ghost", createdAt: "2026-09-15T00:00:00.000Z" })
    ScriptedProject.summaries.set("old-0001", { ok: true, value: summary("old-0001", "2026-09-01T00:00:00.000Z") })
    ScriptedProject.summaries.set("new-0002", { ok: true, value: summary("new-0002", "2026-09-30T00:00:00.000Z") })
    expect((await host.listProjects()).map((p) => p.id)).toEqual(["new-0002", "old-0001"])
  })

  it("fills lastSeenAt for runner agents from claims", async () => {
    const { env } = hostEnv()
    const host = new CloudflareHost(env, { log: quiet, clock: { now: () => new Date("2026-10-01T12:00:00.000Z") } })
    let agents = await host.agents()
    expect(agents.every((a) => a.lastSeenAt === undefined)).toBe(true)
    await host.noteRunner("vps-1", ["claude", "grok", "demo", "Bad Id"])
    agents = await host.agents()
    expect(agents.find((a) => a.id === "claude")?.lastSeenAt).toBe("2026-10-01T12:00:00.000Z")
    expect(agents.find((a) => a.id === "grok")?.lastSeenAt).toBe("2026-10-01T12:00:00.000Z")
    expect(agents.find((a) => a.id === "codex")?.lastSeenAt).toBeUndefined()
    // demo is not a runner agent, even if a runner claims to offer it.
    expect(agents.find((a) => a.id === "demo")?.lastSeenAt).toBeUndefined()
  })

  it("projectStub addresses objects by name", () => {
    const names: string[] = []
    const ns = { idFromName: (n: string) => (names.push(n), { name: n }), get: (id: { name: string }) => ({ id }) }
    const stub = projectStub(ns as never, "keel-notes-a1b2") as unknown as { id: { name: string } }
    expect(stub.id.name).toBe("keel-notes-a1b2")
    expect(names).toEqual(["keel-notes-a1b2"])
  })
})

describe("RegistryStore", () => {
  it("keeps project ids and throttles runner last-seen writes", async () => {
    const storage = new FakeStorage()
    const store = new RegistryStore(storage)
    await store.add({ id: "keel-a1b2", name: "Keel", createdAt: "2026-10-01T00:00:00.000Z" })
    await expect(store.add({ id: "Not An Id", name: "x", createdAt: "" })).rejects.toThrow()
    expect(await store.has("keel-a1b2")).toBe(true)
    expect(await store.has("keel-zzzz")).toBe(false)
    expect(await store.remove("keel-a1b2")).toBe(true)
    expect(await store.list()).toEqual([])

    const t0 = Date.parse("2026-10-01T00:00:00.000Z")
    await store.noteRunner("vps-1", ["claude"], new Date(t0).toISOString())
    const writes = storage.puts
    await store.noteRunner("vps-1", ["claude"], new Date(t0 + 1_000).toISOString())
    expect(storage.puts).toBe(writes)
    await store.noteRunner("vps-2", ["claude"], new Date(t0 + 2_000).toISOString())
    expect(storage.puts).toBe(writes + 1)
    await store.noteRunner("vps-2", ["claude"], new Date(t0 + 2_000 + SEEN_RESOLUTION_MS).toISOString())
    expect(storage.puts).toBe(writes + 2)
    expect(await store.runners()).toEqual([{ agent: "claude", runnerId: "vps-2", at: new Date(t0 + 2_000 + SEEN_RESOLUTION_MS).toISOString() }])
  })
})
