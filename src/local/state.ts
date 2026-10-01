/** JSON files for the local host: one per project, plus the registry index. Writes are atomic (tmp + rename). */

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { StatePort } from "../core/ports.ts"
import type { ProjectState } from "../core/types.ts"

export async function readJson<T>(file: string): Promise<T | null> {
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  return JSON.parse(text) as T
}

/** Each write goes to its own tmp file, so concurrent saves never share one, then replaces the target. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

export class JsonStateStore implements StatePort {
  constructor(readonly file: string) {}

  load(): Promise<ProjectState | null> {
    return readJson<ProjectState>(this.file)
  }

  save(state: ProjectState): Promise<void> {
    return writeJsonAtomic(this.file, state)
  }
}

export type RegistryEntry = { id: string; createdAt: string }

/** The set of project ids, kept in `<data>/registry.json`. */
export class Registry {
  private entries: RegistryEntry[] = []

  constructor(readonly file: string) {}

  async load(): Promise<void> {
    const data = await readJson<{ projects?: RegistryEntry[] }>(this.file)
    this.entries = Array.isArray(data?.projects) ? data.projects.filter((p) => typeof p?.id === "string") : []
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id)
  }

  ids(): string[] {
    return this.entries.map((entry) => entry.id)
  }

  async add(entry: RegistryEntry): Promise<void> {
    if (this.has(entry.id)) return
    const next = [...this.entries, entry]
    await writeJsonAtomic(this.file, { projects: next })
    this.entries = next
  }
}
