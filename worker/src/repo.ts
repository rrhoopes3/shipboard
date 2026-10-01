import fs from "node:fs/promises"
import path from "node:path"
import { BoardError } from "./errors.ts"
import { git } from "./git.ts"
import { assertSafeRel } from "./paths.ts"
import type { FileStat } from "./types.ts"

export class Repo {
  constructor(readonly dir: string) {}

  static async init(dir: string, files: Record<string, string>): Promise<Repo> {
    await fs.mkdir(dir, { recursive: true })
    await git(dir, ["init", "-b", "main"])
    await git(dir, ["config", "user.email", "shipboard@localhost"])
    await git(dir, ["config", "user.name", "Shipboard"])
    await git(dir, ["config", "core.autocrlf", "false"])
    await git(dir, ["config", "core.eol", "lf"])
    await git(dir, ["config", "commit.gpgsign", "false"])
    await git(dir, ["config", "core.quotepath", "false"])
    await fs.appendFile(path.join(dir, ".git", "info", "exclude"), "\n.worktrees\n")
    const repo = new Repo(dir)
    await repo.commitFiles(null, files, "start main")
    return repo
  }

  worktree(forkId: string | null): string {
    return forkId ? path.join(this.dir, ".worktrees", forkId) : this.dir
  }

  branch(forkId: string): string {
    return `fork/${forkId}`
  }

  async addFork(forkId: string): Promise<void> {
    const destination = this.worktree(forkId)
    await git(this.dir, ["worktree", "add", "-b", this.branch(forkId), destination, "main"])
  }

  async commitFiles(forkId: string | null, files: Record<string, string>, message: string): Promise<void> {
    const root = this.worktree(forkId)
    const paths: string[] = []
    for (const [rel, content] of Object.entries(files)) {
      const safe = assertSafeRel(rel)
      const full = path.join(root, safe)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, content)
      paths.push(safe)
    }
    await git(root, ["add", "--", ...paths])
    await this.commitIfDirty(root, message)
  }

  async commitAll(forkId: string, message: string): Promise<boolean> {
    const root = this.worktree(forkId)
    await git(root, ["add", "-A"])
    return this.commitIfDirty(root, message, false)
  }

  private async commitIfDirty(root: string, message: string, required = true): Promise<boolean> {
    const status = await git(root, ["status", "--porcelain"])
    if (!status.stdout.trim()) {
      if (required) throw new BoardError("Nothing changed.", 400)
      return false
    }
    await git(root, ["commit", "-m", message])
    return true
  }

  async head(forkId: string | null): Promise<string> {
    const ref = forkId ? this.branch(forkId) : "main"
    const result = await git(this.dir, ["rev-parse", ref])
    return result.stdout.trim()
  }

  async numstat(forkId: string): Promise<FileStat[]> {
    const result = await git(this.dir, [
      "diff",
      "--numstat",
      "--no-color",
      `main...${this.branch(forkId)}`,
    ])
    const files: FileStat[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!match) continue
      files.push({
        path: match[3] ?? "",
        additions: match[1] === "-" ? 0 : Number(match[1]),
        deletions: match[2] === "-" ? 0 : Number(match[2]),
      })
    }
    return files
  }

  async diff(forkId: string): Promise<string> {
    const result = await git(this.dir, [
      "diff",
      "--no-color",
      "--unified=3",
      `main...${this.branch(forkId)}`,
    ])
    return result.stdout
  }

  async readFile(forkId: string | null, rel: string): Promise<string | null> {
    const full = path.join(this.worktree(forkId), assertSafeRel(rel))
    try {
      return await fs.readFile(full, "utf8")
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null
      throw error
    }
  }

  async ship(forkId: string, message: string): Promise<void> {
    await git(this.dir, ["checkout", "main"])
    const merged = await git(
      this.dir,
      ["merge", "--no-ff", "--no-edit", this.branch(forkId), "-m", message],
      { allowFail: true },
    )
    if (merged.code !== 0) {
      await git(this.dir, ["merge", "--abort"], { allowFail: true })
      throw new BoardError("The merge did not apply cleanly. Re-run the agent instead.", 409)
    }
  }
}
