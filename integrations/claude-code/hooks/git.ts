// Git work for one job: clone the fork, verify the brief commit, stage and commit the working copy,
// push it. Every call goes through `run` (the mods API's process.run in Claude Code: an argv, no
// shell, repo hooks off).
//
// The fork token reaches git only as an http.extraHeader in env-scoped config (GIT_CONFIG_COUNT /
// GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n), in the environment of the one git child that needs it.
// It is never in argv, never in .git/config, never in anything Claude reads, and no credential
// helper sees it, so it cannot land in a keychain.
// process.run takes `env` per call: https://code.claude.com/docs/en/plugins/mods/api.md#reach-files-processes-and-the-network
// and ProcessRunInit in mods/types/claude-code.d.ts ("variables set over the host process's own environment").

import type { ClaimedJob } from "./contract"
import { canonicalBrief } from "./context"

export type RunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type Run = (argv: readonly string[], init?: RunInit) => Promise<RunResult>

export const TRAILER_ATTEMPT = "Shipboard-Attempt"
export const TRAILER_AGENT = "Shipboard-Agent"

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
const NETWORK_TIMEOUT_MS = 180_000
const FORBIDDEN = [
  /(?:^|\/)\.git(?:\/|$)/,
  /^\.shipboard(?:\/|$)/,
  /^\.(?:claude|codex|grok|cursor|gemini|windsurf|continue|aider[^/]*)(?:\/|$)/,
  /^\.mcp\.json$/,
]
// Repo-local keys that could send a request (and its Authorization header) somewhere else, run a
// program, or move the repository. None of them is set by a fresh clone.
const UNSAFE_KEY =
  /^(?:url\..*\.(?:insteadof|pushinsteadof)|http\..*|credential(?:\..*)?|core\.(?:sshcommand|askpass|gitproxy|hookspath|fsmonitor|worktree)|include\.path|includeif\..*|remote\..*\.(?:proxy|pushurl|receivepack|uploadpack|vcs))$/i

/** The part of an Artifacts token that authenticates; `?expires=` is metadata. */
export function secretOf(token: string): string {
  return token.split("?expires=")[0] ?? token
}

/** Basic auth with username `x`, as the core's isomorphic-git onAuth sends and Artifacts accepts. */
export function authHeader(token: string): string {
  return `Authorization: Basic ${base64(`x:${secretOf(token)}`)}`
}

/** Environment for a git child that talks to the fork with `token`. */
export function remoteEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_PARAMETERS: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: authHeader(token),
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  }
}

/** Every spelling of a token that could show up in git's output. */
export function secretsOf(token: string): string[] {
  const secret = secretOf(token)
  return [token, secret, base64(`x:${secret}`), authHeader(token)].filter((s) => s.length >= 8)
}

export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const secret of secrets) out = out.split(secret).join("***")
  return out
}

export function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA.test(value)
}

export function isForbiddenPath(path: string): boolean {
  return FORBIDDEN.some((re) => re.test(path))
}

export type CloneResult = { ok: true } | { ok: false; reason: "auth" | "agent_error"; message: string }

export async function clone(run: Run, remote: string, dir: string, token: string): Promise<CloneResult> {
  const res = await run(["git", "clone", "--quiet", "--branch", "main", "--", remote, dir], {
    env: remoteEnv(token),
    timeoutMs: NETWORK_TIMEOUT_MS,
  })
  if (res.exitCode === 0) return { ok: true }
  const message = redact(res.stderr.trim() || res.stdout.trim(), secretsOf(token)).slice(0, 400)
  return { ok: false, reason: isAuthFailure(message) ? "auth" : "agent_error", message }
}

export type BriefCheck = { ok: true; sha: string } | { ok: false; detail: string }

/**
 * The brief commit must be the fork's first commit after base, change only the brief file, sit
 * under HEAD, and hold exactly the canonical bytes of the brief the board sent with the claim.
 */
export async function verifyBrief(run: Run, dir: string, job: ClaimedJob): Promise<BriefCheck> {
  const git = (...args: string[]) => run(["git", "-C", dir, ...args])
  const fail = (detail: string): BriefCheck => ({ ok: false, detail })
  if (!isSha(job.briefSha) || !isSha(job.baseSha)) return fail("the claim's base or brief sha is not a sha")
  if (job.briefPath !== `.shipboard/briefs/${job.brief.id}.json`) return fail(`unexpected brief path ${job.briefPath}`)

  const parent = await git("rev-parse", "--verify", "--quiet", `${job.briefSha}^`)
  if (parent.exitCode !== 0) return fail(`brief commit ${job.briefSha.slice(0, 7)} is not in the fork`)
  if (parent.stdout.trim() !== job.baseSha) return fail(`brief commit ${job.briefSha.slice(0, 7)} does not sit on base ${job.baseSha.slice(0, 7)}`)

  const under = await git("merge-base", "--is-ancestor", job.briefSha, "HEAD")
  if (under.exitCode !== 0) return fail("the fork's main does not contain the brief commit")

  const touched = await git("diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", job.briefSha)
  const paths = touched.stdout.split("\0").filter(Boolean)
  if (paths.length !== 1 || paths[0] !== job.briefPath) return fail(`brief commit changes ${paths.join(", ") || "nothing"}, not just the brief file`)

  const file = await git("cat-file", "blob", `${job.briefSha}:${job.briefPath}`)
  if (file.exitCode !== 0) return fail("brief file missing at the brief commit")
  if (file.stdout !== canonicalBrief(job.brief)) return fail("brief file at the brief commit differs from the claimed brief")
  return { ok: true, sha: job.briefSha.slice(0, 7) }
}

/** Repo-local config keys that would make a push go somewhere other than where it is told. */
export async function unsafeConfig(run: Run, dir: string): Promise<string[]> {
  const gitDir = await run(["git", "-C", dir, "rev-parse", "--git-dir"])
  if (gitDir.exitCode !== 0) return ["(not a git repository)"]
  if (gitDir.stdout.trim() !== ".git") return [`(git dir moved to ${gitDir.stdout.trim()})`]
  const list = await run(["git", "-C", dir, "config", "--local", "--list", "--name-only"])
  return list.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((key) => key !== "" && UNSAFE_KEY.test(key))
}

export type Staged = { paths: string[]; forbidden: string[] }

/**
 * Folds anything Claude committed itself back onto `base` and stages the whole working copy, so
 * each push is one commit with shipboard's trailers. Refused paths are unstaged again, untouched.
 */
export async function stage(run: Run, dir: string, base: string): Promise<Staged> {
  if (!isSha(base)) throw new Error("stage needs a full sha")
  const git = (...args: string[]) => run(["git", "-C", dir, ...args])
  const reset = await git("reset", "--soft", base)
  if (reset.exitCode !== 0) throw new Error(`git reset --soft failed: ${reset.stderr.trim()}`)
  const add = await git("add", "-A")
  if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`)
  const diff = await git("diff", "--cached", "--name-only", "--no-renames", "-z")
  const paths = diff.stdout.split("\0").filter(Boolean)
  const forbidden = paths.filter(isForbiddenPath)
  if (forbidden.length > 0) await git("reset", "--quiet")
  return { paths, forbidden }
}

export async function commit(run: Run, dir: string, subject: string, attemptId: string, agent: string): Promise<string> {
  const message = `${subject}\n\n${TRAILER_ATTEMPT}: ${attemptId}\n${TRAILER_AGENT}: ${agent}\n`
  const who = await run(["git", "-C", dir, "config", "user.email"])
  const env: Record<string, string> =
    who.exitCode === 0 && who.stdout.trim() !== ""
      ? {}
      : {
          GIT_AUTHOR_NAME: "Claude Code",
          GIT_AUTHOR_EMAIL: "claude-code@shipboard.invalid",
          GIT_COMMITTER_NAME: "Claude Code",
          GIT_COMMITTER_EMAIL: "claude-code@shipboard.invalid",
        }
  const res = await run(["git", "-C", dir, "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "--file", "-"], { stdin: message, env })
  if (res.exitCode !== 0) throw new Error(`git commit failed: ${res.stderr.trim() || res.stdout.trim()}`)
  return head(run, dir)
}

export type PushResult = { ok: true } | { ok: false; reason: "auth" | "push_rejected" | "agent_error"; message: string }

/** Pushes HEAD to main on `remote`, the fork's URL from the claim, never a configured remote. */
export async function push(run: Run, dir: string, remote: string, token: string): Promise<PushResult> {
  const res = await run(["git", "-C", dir, "push", "--quiet", "--no-verify", "--", remote, "HEAD:refs/heads/main"], {
    env: remoteEnv(token),
    timeoutMs: NETWORK_TIMEOUT_MS,
  })
  if (res.exitCode === 0) return { ok: true }
  const message = redact(res.stderr.trim() || res.stdout.trim(), secretsOf(token)).slice(0, 400)
  if (isAuthFailure(message)) return { ok: false, reason: "auth", message }
  if (/rejected|non-fast-forward|fetch first/i.test(message)) return { ok: false, reason: "push_rejected", message }
  return { ok: false, reason: "agent_error", message }
}

export async function head(run: Run, dir: string): Promise<string> {
  const res = await run(["git", "-C", dir, "rev-parse", "HEAD"])
  const sha = res.stdout.trim()
  if (!isSha(sha)) throw new Error(`could not read HEAD in ${dir}`)
  return sha
}

export async function changedSince(run: Run, dir: string, from: string): Promise<string[]> {
  const res = await run(["git", "-C", dir, "diff", "--name-only", "--no-renames", "-z", from, "HEAD"])
  return res.stdout.split("\0").filter(Boolean)
}

/** Paths with uncommitted changes, for warning before a finish. */
export async function dirtyPaths(run: Run, dir: string): Promise<string[]> {
  const res = await run(["git", "-C", dir, "status", "--porcelain", "-z", "--untracked-files=all"])
  return res.stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
}

function isAuthFailure(message: string): boolean {
  return /\b40[13]\b|authentication failed|could not read username|terminal prompts disabled|unauthori[sz]ed|forbidden/i.test(message)
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** UTF-8 base64. Hooks modules get web APIs but no Buffer, and btoa only takes Latin-1. */
export function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? ALPHABET.charAt((n >> 6) & 63) : "="
    out += i + 2 < bytes.length ? ALPHABET.charAt(n & 63) : "="
  }
  return out
}
