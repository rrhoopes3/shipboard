/**
 * Durable Object storage for the core: one project's whole ProjectState under a single key, so a
 * save is one atomic `put`. The ProjectDO is the only reader and writer of its storage.
 */

import type { Logger, StatePort } from "../core/ports.ts"
import type { ProjectState } from "../core/types.ts"

/** The slice of `DurableObjectStorage` shipboard uses; tests pass an in-memory map. */
export type KvStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>
}

export type AlarmStorage = {
  getAlarm(): Promise<number | null>
  setAlarm(scheduledTime: number | Date): Promise<void>
  deleteAlarm(): Promise<void>
}

export const STATE_KEY = "state"

/** SQLite-backed Durable Objects cap one stored value at 2 MB; warn well before that. */
const WARN_BYTES = 1_500_000

export class DoStateStore implements StatePort {
  constructor(
    private readonly storage: Pick<KvStorage, "get" | "put">,
    private readonly log?: Logger,
    private readonly key: string = STATE_KEY,
  ) {}

  async load(): Promise<ProjectState | null> {
    const state = await this.storage.get<ProjectState>(this.key)
    return state ?? null
  }

  async save(state: ProjectState): Promise<void> {
    if (this.log) {
      const bytes = JSON.stringify(state).length
      if (bytes > WARN_BYTES) this.log.warn("project state is close to the 2 MB storage limit", { project: state.project.id, bytes })
    }
    await this.storage.put(this.key, state)
  }
}
