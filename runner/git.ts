/**
 * The runner's own git calls. Tokens travel only in env-scoped config
 * (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n): never in argv (visible in `ps`) and
 * never in .git/config (where the agent could read it). The token env exists only for the clone
 * and push commands, which run before and after the agent, never during.
 *
 * Every call also ignores system and global git config and disables hooks, so neither the user's
 * credential helpers nor anything the agent wrote into .git can run with a token in its env.
 */

import { runProcess, tail, type SpawnObserver } from "./proc.ts"
import type { Redactor } from "./log.ts"

export type GitIdentity = { name: string; email: string }

export type GitContext = {
  cwd: string
  hostEnv: NodeJS.ProcessEnv
  timeoutMs: number
  redactor: Redactor
  observe?: SpawnObserver
}

export type GitResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message)
    this.name = "GitError"
  }
}

export function gitEnv(hostEnv: NodeJS.ProcessEnv, opts: { token?: string; identity?: GitIdentity; literalPathspecs?: boolean } = {}): Record<string, string> {
  const config: [string, string][] = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["commit.gpgSign", "false"],
    // An empty value resets the helper list, so no keychain helper is asked for anything.
    ["credential.helper", ""],
  ]
  if (opts.token) config.push(["http.extraHeader", `Authorization: Bearer ${opts.token}`])

  const env: Record<string, string> = {
    PATH: hostEnv.PATH ?? "/usr/bin:/bin",
    HOME: hostEnv.HOME ?? "/",
    LANG: hostEnv.LANG ?? "en_US.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: String(config.length),
  }
  config.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key
    env[`GIT_CONFIG_VALUE_${i}`] = value
  })
  if (opts.identity) {
    env.GIT_AUTHOR_NAME = opts.identity.name
    env.GIT_AUTHOR_EMAIL = opts.identity.email
    env.GIT_COMMITTER_NAME = opts.identity.name
    env.GIT_COMMITTER_EMAIL = opts.identity.email
  }
  if (opts.literalPathspecs) env.GIT_LITERAL_PATHSPECS = "1"
  return env
}

export async function git(
  ctx: GitContext,
  args: string[],
  opts: { token?: string; identity?: GitIdentity; stdin?: string; allowFail?: boolean; literalPathspecs?: boolean } = {},
): Promise<GitResult> {
  const res = await runProcess(
    {
      bin: "git",
      args,
      cwd: ctx.cwd,
      env: gitEnv(ctx.hostEnv, opts),
      stdin: opts.stdin ?? null,
      timeoutMs: ctx.timeoutMs,
      graceMs: 2_000,
      maxStdoutBytes: 64 * 1024 * 1024,
    },
    ctx.observe,
  )
  const out: GitResult = { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut }
  if (!opts.allowFail && (res.exitCode !== 0 || res.spawnError)) {
    const what = res.timedOut ? "timed out" : res.spawnError ? `could not start (${res.spawnError})` : `failed (exit ${res.exitCode})`
    const detail = ctx.redactor.redact(tail(res.stderr.trim(), 600))
    throw new GitError(`git ${args[0] ?? ""} ${what}${detail ? `: ${detail}` : ""}`, ctx.redactor.redact(res.stderr), res.exitCode)
  }
  return out
}

/** Refuse remotes that carry credentials in the URL: they would end up in argv and .git/config. */
export function assertCleanRemote(remote: string): void {
  let url: URL
  try {
    url = new URL(remote)
  } catch {
    throw new GitError(`The remote "${remote}" is not a URL.`, "", null)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new GitError(`The remote must be http(s), got ${url.protocol}`, "", null)
  if (url.username || url.password) throw new GitError("The remote URL carries credentials; refusing to use it.", "", null)
}

export async function clone(ctx: GitContext, remote: string, dest: string, token: string): Promise<void> {
  assertCleanRemote(remote)
  await git(ctx, ["clone", "--quiet", "--no-tags", "--single-branch", "--branch", "main", "--", remote, dest], { token })
}

export async function revParse(ctx: GitContext, rev: string): Promise<string | null> {
  const res = await git(ctx, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true })
  const sha = res.stdout.trim()
  return res.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

export async function isAncestor(ctx: GitContext, ancestor: string, descendant: string): Promise<boolean> {
  const res = await git(ctx, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true })
  return res.exitCode === 0
}

/** Raw file content at a commit, or null when the path is missing there. No textconv, no filters. */
export async function readBlob(ctx: GitContext, commit: string, file: string): Promise<string | null> {
  const res = await git(ctx, ["cat-file", "blob", `${commit}:${file}`], { allowFail: true })
  return res.exitCode === 0 ? res.stdout : null
}

export type StagedChange = { path: string; status: string; mode: string }

/** Staged changes against HEAD, rename detection off, NUL-separated so any path survives. */
export async function stagedChanges(ctx: GitContext): Promise<StagedChange[]> {
  const res = await git(ctx, ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-ext-diff", "HEAD"])
  const parts = res.stdout.split("\0")
  const changes: StagedChange[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] ?? ""
    const file = parts[i + 1] ?? ""
    // ":100644 100644 <old> <new> M"
    const fields = meta.replace(/^:/, "").split(" ")
    const newMode = fields[1] ?? ""
    const status = fields[4] ?? ""
    if (!file) continue
    changes.push({ path: file, status, mode: newMode })
  }
  return changes
}

/** Put index entries for these paths back to HEAD. Paths are taken literally. */
export async function unstage(ctx: GitContext, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await git(ctx, ["reset", "--quiet", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"], {
    stdin: paths.join("\0") + "\0",
    literalPathspecs: true,
  })
}

export async function commit(ctx: GitContext, messageFile: string, identity: GitIdentity): Promise<string> {
  await git(ctx, ["commit", "--quiet", "--no-verify", "--file", messageFile], { identity })
  const sha = await revParse(ctx, "HEAD")
  if (!sha) throw new GitError("Commit succeeded but HEAD did not resolve.", "", null)
  return sha
}

export type PushResult = { ok: true } | { ok: false; kind: "rejected" | "auth" | "error"; detail: string }

export async function push(ctx: GitContext, remote: string, token: string): Promise<PushResult> {
  assertCleanRemote(remote)
  const res = await git(ctx, ["push", "--porcelain", "--", remote, "HEAD:refs/heads/main"], { token, allowFail: true })
  if (res.exitCode === 0) return { ok: true }
  const text = `${res.stdout}\n${res.stderr}`
  const detail = ctx.redactor.redact(tail(res.stderr.trim() || res.stdout.trim(), 600))
  if (/non-fast-forward|\[rejected\]|fetch first|stale info|\(rejected\)/i.test(text)) return { ok: false, kind: "rejected", detail }
  if (/authentication failed|could not read username|returned error: 40[13]|HTTP 40[13]|\b401\b|\b403\b/i.test(text)) {
    return { ok: false, kind: "auth", detail }
  }
  return { ok: false, kind: "error", detail: res.timedOut ? `push timed out. ${detail}` : detail }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}
