/** Running the git binary for the local host. */

import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"

let gitPath: string | null = null

/**
 * Absolute path of the git binary, found once. Spawning by bare name makes every call walk PATH,
 * and npm prepends a node_modules/.bin for each parent directory; on macOS some of those (under
 * ~/Desktop, ~/Documents) are slow to stat, which cost ~50 ms per spawn.
 */
export function gitBinary(): string {
  if (gitPath) return gitPath
  const override = process.env.SHIPBOARD_GIT
  if (override) return (gitPath = override)
  const names = process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || dir.includes("node_modules")) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        return (gitPath = candidate)
      } catch {
        // keep looking
      }
    }
  }
  return (gitPath = "git")
}

/** Server-side git ignores the operator's global and system config and never prompts. */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    LC_ALL: "C",
    ...extra,
  }
}

export type GitRun = { stdout: Buffer; stderr: string; code: number }

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.filter((a) => !a.includes("://")).slice(0, 4).join(" ")} failed (${code}): ${stderr.trim().slice(0, 400)}`)
    this.name = "GitCommandError"
  }
}

export function runGit(
  args: string[],
  opts: { cwd?: string; input?: string | Buffer; timeoutMs?: number; allowFail?: boolean } = {},
): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitBinary(),
      args,
      {
        cwd: opts.cwd,
        env: gitEnv(),
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0
        const result: GitRun = { stdout, stderr: stderr.toString("utf8"), code }
        if (error && !opts.allowFail) reject(new GitCommandError(args, code, result.stderr || error.message))
        else resolve(result)
      },
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
    else child.stdin?.end()
  })
}

/** Parses `git version 2.50.1 (Apple Git-155)` into [2, 50, 1]. */
export function parseGitVersion(text: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

export async function checkGit(min: [number, number] = [2, 38]): Promise<string> {
  let out: GitRun
  try {
    out = await runGit(["--version"])
  } catch {
    throw new Error("Shipboard needs git on PATH.")
  }
  const text = out.stdout.toString("utf8").trim()
  const version = parseGitVersion(text)
  if (!version || version[0] < min[0] || (version[0] === min[0] && version[1] < min[1])) {
    throw new Error(`Shipboard needs git ${min.join(".")} or newer; found "${text}".`)
  }
  const backend = await runGit(["http-backend"], { allowFail: true, timeoutMs: 10_000 })
  // With no CGI environment http-backend prints an error but exits; a missing binary has no "git-http-backend" text at all.
  if (backend.code !== 0 && /not a git command/i.test(backend.stderr)) {
    throw new Error("Shipboard needs `git http-backend` (part of git) for the local git server.")
  }
  return text
}
