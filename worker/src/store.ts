import fs from "node:fs/promises"
import path from "node:path"
import type { ForkRecord, ProjectRecord } from "./types.ts"

type Data = { projects: ProjectRecord[]; forks: ForkRecord[] }

function isData(value: unknown): value is Data {
  if (!value || typeof value !== "object") return false
  const record = value as { projects?: unknown; forks?: unknown }
  return Array.isArray(record.projects) && Array.isArray(record.forks)
}

export class Store {
  projects: ProjectRecord[] = []
  forks: ForkRecord[] = []

  constructor(private file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (!isData(parsed)) throw new Error("Board store is not a project list.")
      this.projects = parsed.projects
      this.forks = parsed.forks
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === "ENOENT") {
        this.projects = []
        this.forks = []
        return
      }
      throw error
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    const body = JSON.stringify({ projects: this.projects, forks: this.forks }, null, 2)
    await fs.writeFile(tmp, body)
    await fs.copyFile(tmp, this.file)
    await fs.rm(tmp, { force: true })
  }
}
