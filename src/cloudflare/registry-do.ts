/**
 * RegistryDO: the singleton index of projects, and when runners offering each agent last polled.
 * Project state itself lives in each ProjectDO; this only knows which ids exist.
 */

import { DurableObject } from "cloudflare:workers"
import { isProjectId } from "../core/names.ts"
import type { Env } from "./env.ts"
import type { KvStorage } from "./state.ts"

export type RegistryEntry = { id: string; name: string; createdAt: string }
export type RunnerSeen = { agent: string; runnerId: string; at: string }

const PROJECT = "project:"
const AGENT = "agent:"
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/
/** Runner polls arrive every few seconds; writing last-seen more often than this is noise. */
export const SEEN_RESOLUTION_MS = 15_000

/** The registry's logic over plain key-value storage, so tests can run it without a Durable Object. */
export class RegistryStore {
  constructor(private readonly storage: KvStorage) {}

  async add(entry: RegistryEntry): Promise<void> {
    if (!isProjectId(entry.id)) throw new Error(`not a project id: ${entry.id}`)
    await this.storage.put(`${PROJECT}${entry.id}`, { id: entry.id, name: entry.name, createdAt: entry.createdAt })
  }

  async remove(id: string): Promise<boolean> {
    if (!isProjectId(id)) return false
    return this.storage.delete(`${PROJECT}${id}`)
  }

  async has(id: string): Promise<boolean> {
    if (!isProjectId(id)) return false
    return (await this.storage.get(`${PROJECT}${id}`)) !== undefined
  }

  /** Newest first. */
  async list(): Promise<RegistryEntry[]> {
    const rows = await this.storage.list<RegistryEntry>({ prefix: PROJECT })
    return [...rows.values()]
      .filter((row) => row && isProjectId(row.id))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  async noteRunner(runnerId: string, agents: string[], at: string): Promise<void> {
    const now = Date.parse(at)
    for (const agent of agents) {
      if (!AGENT_ID.test(agent)) continue
      const key = `${AGENT}${agent}`
      const seen = await this.storage.get<RunnerSeen>(key)
      if (seen && seen.runnerId === runnerId && now - Date.parse(seen.at) < SEEN_RESOLUTION_MS) continue
      await this.storage.put(key, { agent, runnerId, at })
    }
  }

  async runners(): Promise<RunnerSeen[]> {
    const rows = await this.storage.list<RunnerSeen>({ prefix: AGENT })
    return [...rows.values()].filter((row) => row && typeof row.agent === "string" && typeof row.at === "string")
  }
}

/** The RPC surface the host calls. */
export type RegistryRpc = {
  add(entry: RegistryEntry): Promise<void>
  remove(id: string): Promise<boolean>
  has(id: string): Promise<boolean>
  list(): Promise<RegistryEntry[]>
  noteRunner(runnerId: string, agents: string[], at: string): Promise<void>
  runners(): Promise<RunnerSeen[]>
}

export class RegistryDO extends DurableObject<Env> implements RegistryRpc {
  private readonly store: RegistryStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new RegistryStore(ctx.storage as unknown as KvStorage)
  }

  add(entry: RegistryEntry): Promise<void> {
    return this.store.add(entry)
  }

  remove(id: string): Promise<boolean> {
    return this.store.remove(id)
  }

  has(id: string): Promise<boolean> {
    return this.store.has(id)
  }

  list(): Promise<RegistryEntry[]> {
    return this.store.list()
  }

  noteRunner(runnerId: string, agents: string[], at: string): Promise<void> {
    return this.store.noteRunner(runnerId, agents, at)
  }

  runners(): Promise<RunnerSeen[]> {
    return this.store.runners()
  }
}
