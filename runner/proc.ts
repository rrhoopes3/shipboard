/**
 * Spawning untrusted-ish child processes (agents, and git with a token in its env).
 *
 * - `shell: false` and an argv array: nothing is ever interpolated into a shell string.
 * - `detached: true` puts the child in its own process group, so a timeout can signal the agent and
 *   everything it started (test runners, dev servers) in one `kill(-pgid)`.
 * - The env is exactly what the caller passes. Building the allowlist is the caller's job
 *   (see `agentEnv` in agents.ts and `gitEnv` in git.ts); nothing from process.env leaks in here.
 * - Output is captured up to a cap, keeping the tail: agents print their result last.
 * - Wall-clock timeout: SIGINT to the group (Claude ends its turn cleanly on SIGINT, exits 143 with
 *   no result on SIGTERM), then SIGTERM after `graceMs`, then SIGKILL after another `graceMs`.
 *   macOS has no `timeout` binary, so this is done here.
 */

import { spawn } from "node:child_process"

export type ProcSpec = {
  bin: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Written to stdin then closed. When null or absent, stdin is /dev/null. */
  stdin?: string | null
  timeoutMs: number
  /** Gap between SIGINT, SIGTERM and SIGKILL. Default 15 s. */
  graceMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  /** Aborting runs the same SIGINT -> SIGTERM -> SIGKILL escalation as a timeout. */
  signal?: AbortSignal
}

export type ProcResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  aborted: boolean
  durationMs: number
  /** Set when the process could not be started at all (missing binary, bad cwd). */
  spawnError?: string
  pid?: number
}

/** Observes every spawn. Tests use it to prove no token reaches argv. */
export type SpawnObserver = (spec: Readonly<ProcSpec>) => void

const DEFAULT_STDOUT_CAP = 8 * 1024 * 1024
const DEFAULT_STDERR_CAP = 1024 * 1024
const POLL_MS = 50

class TailBuffer {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.cap && this.chunks.length > 0) {
      const first = this.chunks[0]
      if (!first) break
      const excess = this.size - this.cap
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
      }
      this.truncated = true
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8")
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig)
  } catch {
    // ESRCH: the group is already gone.
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitGroupGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true
    await sleep(POLL_MS)
  }
  return !groupAlive(pgid)
}

export async function runProcess(spec: ProcSpec, observe?: SpawnObserver): Promise<ProcResult> {
  observe?.(spec)
  const started = Date.now()
  const graceMs = spec.graceMs ?? 15_000
  const stdout = new TailBuffer(spec.maxStdoutBytes ?? DEFAULT_STDOUT_CAP)
  const stderr = new TailBuffer(spec.maxStderrBytes ?? DEFAULT_STDERR_CAP)

  const result = (extra: Partial<ProcResult>): ProcResult => ({
    exitCode: null,
    signal: null,
    stdout: stdout.text(),
    stderr: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    timedOut: false,
    aborted: false,
    durationMs: Date.now() - started,
    ...extra,
  })

  if (spec.signal?.aborted) return result({ aborted: true, spawnError: "aborted before start" })

  const child = spawn(spec.bin, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached: true,
    stdio: [spec.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  return new Promise<ProcResult>((resolve) => {
    let timedOut = false
    let aborted = false
    let escalating: Promise<void> | null = null
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
    let settled = false
    let closed = false
    const pgid = child.pid

    child.on("close", () => {
      closed = true
    })
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))

    if (spec.stdin != null && child.stdin) {
      // The agent may exit without reading stdin; EPIPE is not our problem.
      child.stdin.on("error", () => {})
      child.stdin.end(spec.stdin)
    }

    const escalate = (): Promise<void> => {
      if (escalating || pgid === undefined) return escalating ?? Promise.resolve()
      escalating = (async () => {
        signalGroup(pgid, "SIGINT")
        if (await waitGroupGone(pgid, graceMs)) return
        signalGroup(pgid, "SIGTERM")
        if (await waitGroupGone(pgid, graceMs)) return
        signalGroup(pgid, "SIGKILL")
        await waitGroupGone(pgid, 5_000)
      })()
      return escalating
    }

    // Once the leader has exited on its own, a late timer or abort is not a timeout or an abort.
    const timer = setTimeout(() => {
      if (exited !== null) return
      timedOut = true
      void escalate()
    }, spec.timeoutMs)

    const onAbort = (): void => {
      if (exited !== null) return
      aborted = true
      void escalate()
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true })

    const finish = (extra: Partial<ProcResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      spec.signal?.removeEventListener("abort", onAbort)
      resolve(result({ timedOut, aborted, pid: pgid, ...extra }))
    }

    child.on("error", (error) => {
      // Spawn failures (ENOENT, EACCES) never emit "exit".
      if (exited === null) finish({ spawnError: error.message })
    })

    child.on("exit", (code, signal) => {
      exited = { code, signal }
      void (async () => {
        if (pgid !== undefined) {
          if (escalating) {
            await escalating
          } else if (groupAlive(pgid)) {
            // The leader is done but left children behind. Nothing should outlive the agent.
            signalGroup(pgid, "SIGTERM")
            if (!(await waitGroupGone(pgid, Math.min(graceMs, 2_000)))) {
              signalGroup(pgid, "SIGKILL")
              await waitGroupGone(pgid, 2_000)
            }
          }
        }
        // Give the pipes a moment to drain, then stop waiting on anything that escaped the group.
        if (!closed) {
          await Promise.race([new Promise<void>((done) => child.once("close", () => done())), sleep(1_000)])
        }
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish({ exitCode: exited?.code ?? null, signal: exited?.signal ?? null })
      })()
    })
  })
}

/** Last `max` characters, cut at a line start when one is close. */
export function tail(text: string, max = 2_000): string {
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const newline = cut.indexOf("\n")
  return newline !== -1 && newline < 200 ? cut.slice(newline + 1) : cut
}
