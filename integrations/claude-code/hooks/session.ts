// One interactive session's membership on the board: at most one claimed job, its working copy,
// its lease, and the verdict the pane shows. Every effect goes through `Io`, which register.ts
// builds from the mods API, so this file never touches the API object itself
// (https://code.claude.com/docs/en/plugins/mods/create.md: a hooks module may not pass `$` to a
// function imported from another file).

import { boardClient, BoardError, messageOf, type BoardClient, type Fetch } from "./api"
import type { Config } from "./config"
import { AGENT_ID, AGENT_LABEL, type ClaimedJob, type JobOutcome } from "./contract"
import { briefContext, PUSH_TOOL, reminder } from "./context"
import * as git from "./git"
import { classifyCommand, classifyFileWrite, denyMessage } from "./guard"
import type { PaneModel } from "./pane"
import { actionLabel, oneLine, short, verdictLines, verdictOf, type Verdict } from "./verdict"

export const HEARTBEAT_MS = 60_000
export const POLL_MS = 3_000

export type Io = {
  fetch: Fetch
  run: git.Run
  cwd: () => Promise<string>
  list: (path: string) => Promise<readonly { name: string }[]>
  exists: (path: string) => Promise<boolean>
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => { cancel: () => void }
  redraw: () => void
  toast: (text: string) => void
  status: (text: string | undefined) => void
  openPane: () => Promise<void>
  /** Remembers the job (never a token) across a reload of the mod; null forgets it. */
  save: (saved: Saved | null) => Promise<void>
}

/** What survives a hot reload, kept in the mod's store under the session id. Holds no token. */
export type Saved = {
  job: ClaimedJob
  runnerId: string
  dir: string
  sessionCwd: string
  briefSha: string
  pushedSha: string | null
  changedPaths: string[]
  claimedAt: number
}

type Active = Saved & {
  timers: { cancel: () => void }[]
  briefSent: boolean
  busy: boolean
  polling: boolean
  version: number | null
  verdict: Verdict | null
}

export type Identity = { runnerId: string; sessionId: string; home?: string }

const ATTEMPT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*$/
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

export class Shipboard {
  private active: Active | null = null
  private note: string | null = null
  private ended: string | null = null

  constructor(
    readonly config: Config,
    readonly identity: Identity,
  ) {}

  get job(): ClaimedJob | null {
    return this.active?.job ?? null
  }

  get dir(): string | null {
    return this.active?.dir ?? null
  }

  private client(io: Io): BoardClient {
    return boardClient(io.fetch, this.config)
  }

  pane(): PaneModel {
    const a = this.active
    return {
      job: a
        ? { attemptId: a.job.attemptId, attemptNumber: a.job.attemptNumber, task: a.job.brief.task, dir: a.dir, briefPath: a.job.briefPath }
        : null,
      brief: a ? { ok: true, sha: a.briefSha, detail: "" } : null,
      verdict: a?.verdict ?? null,
      pushedSha: a?.pushedSha ?? null,
      note: this.note,
      ended: this.ended,
    }
  }

  // ---------------------------------------------------------------- claim

  async claim(io: Io, want?: string): Promise<string> {
    if (this.active) return `Already working on ${this.active.job.attemptId} in ${this.active.dir}. Run /shipboard done before claiming another job.`
    const board = this.client(io)
    const runnerId = this.identity.runnerId
    let job: ClaimedJob | null
    try {
      job = await board.claim(runnerId, [AGENT_ID], want)
    } catch (error) {
      return `Could not claim a job: ${messageOf(error)}${authHint(error, "runner_token", "SHIPBOARD_RUNNER_TOKEN", "RUNNER_TOKEN")}`
    }
    if (!job) {
      return `No queued ${AGENT_ID} jobs on ${board.url}. Put one up with /shipboard dispatch "task" --path <file>, or pick "${AGENT_LABEL}" when dispatching on the board.`
    }

    const invalid = invalidJob(job)
    if (invalid) {
      await finishQuietly(board, job.attemptId, runnerId, { reason: "agent_error", summary: `Claude Code refused the claim: ${invalid}` })
      return `Refused the job the board handed out: ${invalid}`
    }

    // The lease is three minutes; a slow clone must not lose it.
    const early = io.every(HEARTBEAT_MS, () => void board.heartbeat(job.attemptId, runnerId).catch(() => undefined))
    let ready: Prepared
    try {
      ready = await prepare(io, board, job, runnerId)
    } catch (error) {
      ready = { ok: false, outcome: { reason: "agent_error", summary: `Setup failed: ${messageOf(error)}` }, text: `Could not set up ${job.attemptId}: ${messageOf(error)}` }
    }
    early.cancel()
    if (!ready.ok) {
      await finishQuietly(board, job.attemptId, runnerId, ready.outcome)
      this.note = ready.text
      io.redraw()
      return ready.text
    }

    const { dir, sessionCwd, sha } = ready
    const active: Active = {
      job,
      runnerId,
      dir,
      sessionCwd,
      briefSha: sha,
      pushedSha: null,
      changedPaths: [],
      claimedAt: await io.now(),
      timers: [],
      briefSent: false,
      busy: false,
      polling: false,
      version: null,
      verdict: null,
    }
    this.begin(io, active)
    await io.save(savedOf(active))
    await io.openPane().catch(() => undefined)

    const lines = [
      `Claimed ${job.attemptId} (attempt ${job.attemptNumber}) on ${board.url}.`,
      `Brief verified at ${sha}: ${job.brief.task}`,
      `Working copy: ${dir}${dir === sessionCwd ? "" : " (cd there to work)"}.`,
      `The brief rides along with the next prompt. Push with the ${PUSH_TOOL} tool; finish with /shipboard done.`,
    ]
    if (want && job.attemptId !== want) {
      lines.push(`Note: the board handed out an older queued job, ${job.attemptId}; ${want} is still queued.`)
    }
    return lines.join("\n")
  }

  async dispatch(io: Io, input: { task: string; paths: string[]; constraints: string[]; acceptance: string; project?: string }): Promise<string> {
    if (this.active) return `Already working on ${this.active.job.attemptId}. Run /shipboard done before dispatching another job to this session.`
    const project = input.project ?? this.config.project
    if (!project) return "Which project? Pass --project <id>, or set the project option (SHIPBOARD_PROJECT)."
    let attemptId: string
    try {
      const out = await this.client(io).dispatch(project, {
        task: input.task,
        paths: input.paths,
        constraints: input.constraints,
        acceptance: input.acceptance,
        agent: AGENT_ID,
      })
      attemptId = out.attemptId
    } catch (error) {
      return `Could not dispatch: ${messageOf(error)}${authHint(error, "board_token", "SHIPBOARD_TOKEN", "BOARD_TOKEN")}`
    }
    return `Dispatched ${attemptId} to ${AGENT_ID}.\n${await this.claim(io, attemptId)}`
  }

  /** Resumes a job this session claimed before the mod reloaded. */
  async restore(io: Io, saved: Saved): Promise<void> {
    if (this.active) return
    const active: Active = { ...saved, timers: [], briefSent: true, busy: false, polling: false, version: null, verdict: null }
    this.begin(io, active)
    await this.heartbeat(io)
  }

  private begin(io: Io, active: Active): void {
    this.active = active
    this.note = null
    this.ended = null
    active.timers.push(io.every(HEARTBEAT_MS, () => void this.heartbeat(io)))
    active.timers.push(io.every(POLL_MS, () => void this.poll(io)))
    void this.poll(io)
    io.redraw()
  }

  // ---------------------------------------------------------------- lease and board

  async heartbeat(io: Io): Promise<void> {
    const a = this.active
    if (!a) return
    try {
      await this.client(io).heartbeat(a.job.attemptId, a.runnerId)
    } catch (error) {
      if (this.active !== a) return
      if (error instanceof BoardError && error.status >= 400 && error.status < 500) {
        await this.stop(io, `Lost the lease on ${a.job.attemptId}: ${error.message}`)
        io.toast(`shipboard: lost the lease on ${a.job.attemptId}`)
      } else {
        this.note = `Heartbeat failed: ${messageOf(error)}`
        io.redraw()
      }
    }
  }

  async poll(io: Io): Promise<void> {
    const a = this.active
    if (!a || a.polling) return
    a.polling = true
    try {
      const view = await this.client(io).board(a.job.projectId, a.version ?? undefined)
      if (this.active !== a || view === null) return
      a.version = view.version
      const verdict = verdictOf(view, a.job.attemptId, this.config.url)
      if (verdict) {
        const turn = turnOf(verdict)
        if (turn && (!a.verdict || turnOf(a.verdict) !== turn)) io.toast(`shipboard: ${a.job.attemptId} ${turn}`)
        a.verdict = verdict
      }
      this.note = null
      this.showStatus(io)
      io.redraw()
    } catch (error) {
      if (this.active !== a) return
      this.note = `Board unreachable: ${messageOf(error)}`
      io.redraw()
    } finally {
      a.polling = false
    }
  }

  private showStatus(io: Io): void {
    const a = this.active
    if (!a) return io.status(undefined)
    const v = a.verdict?.attempt
    if (!v) return io.status(`${a.job.attemptId} · working`)
    const merge = v.merge ? (v.merge.state === "clean" ? "clean" : `conflict in ${v.merge.paths.length} file(s)`) : "not checked"
    io.status(`${a.job.attemptId} · ${v.status} · ${merge} · next ${actionLabel(v.primary)}`)
  }

  // ---------------------------------------------------------------- push

  async push(io: Io, input: { message?: string }): Promise<string> {
    const a = this.active
    if (!a) return "No shipboard job is active in this session, so there is nothing to push. Ask the user to run /shipboard claim."
    if (a.busy) return "A push for this job is already running. Wait for its verdict."
    a.busy = true
    const board = this.client(io)
    let secrets: string[] = []
    try {
      const unsafe = await git.unsafeConfig(io.run, a.dir)
      if (unsafe.length > 0) {
        const summary = `Refused to push: the working copy's git config sets ${unsafe.join(", ")}.`
        await finishQuietly(board, a.job.attemptId, a.runnerId, { reason: "unsafe_repo_config", summary })
        await this.stop(io, `Ended ${a.job.attemptId}: ${summary}`)
        return `${summary} Those settings could send the fork's write token somewhere else, so the job is ended as unsafe_repo_config and nothing was pushed. A person can re-run the brief from the board.`
      }

      const base = a.pushedSha ?? a.job.briefSha
      const staged = await git.stage(io.run, a.dir, base)
      if (staged.forbidden.length > 0) {
        return `Not pushed: a shipboard job may not change ${staged.forbidden.join(", ")}. Revert those paths (restore them, or delete files you added there), then call ${PUSH_TOOL} again. Nothing was committed.`
      }
      if (staged.paths.length === 0) {
        if (!a.pushedSha) return `Nothing to push yet: ${a.dir} has no changes against the brief commit.`
        return [`Nothing new to push since ${short(a.pushedSha)}.`, ...(a.verdict ? verdictLines(a.verdict) : [])].join("\n")
      }

      const subject = subjectOf(input.message, a.job.brief.task)
      const sha = await git.commit(io.run, a.dir, subject, a.job.attemptId, AGENT_ID)
      const creds = await board.credentials(a.job.attemptId, a.runnerId, "write")
      secrets = git.secretsOf(creds.token)
      if (creds.remote !== a.job.remote) {
        return `Not pushed: the board's write token is for ${creds.remote}, not this job's fork ${a.job.remote}.`
      }
      const pushed = await git.push(io.run, a.dir, a.job.remote, creds.token)
      if (!pushed.ok) {
        return `Push failed (${pushed.reason}): ${pushed.message}\nThe commit ${short(sha)} stays local; the next ${PUSH_TOOL} call folds it into a new commit.`
      }

      a.pushedSha = sha
      a.changedPaths = await git.changedSince(io.run, a.dir, a.job.briefSha)
      await io.save(savedOf(a))

      const lines = [`Pushed ${short(sha)} to ${a.job.attemptId}: ${subject} (${staged.paths.length} file${staged.paths.length === 1 ? "" : "s"}: ${staged.paths.join(", ")}).`]
      try {
        const view = await board.pushed(a.job.attemptId, sha)
        if (view && this.active === a) {
          a.version = view.version
          a.verdict = verdictOf(view, a.job.attemptId, this.config.url) ?? a.verdict
        }
      } catch (error) {
        lines.push(`The board did not confirm the push (${messageOf(error)}); it also learns of pushes from repo events and its own reconcile.`)
      }
      this.showStatus(io)
      io.redraw()
      if (a.verdict && a.verdict.attempt.headSha === sha) lines.push(...verdictLines(a.verdict))
      else lines.push("The board has not assessed this head yet; the shipboard pane shows the verdict when it lands.")
      return lines.join("\n")
    } catch (error) {
      return `Push failed: ${git.redact(messageOf(error), secrets)}`
    } finally {
      a.busy = false
    }
  }

  // ---------------------------------------------------------------- finish

  async done(io: Io): Promise<string> {
    const a = this.active
    if (!a) return "No shipboard job is active in this session."
    if (a.busy) return "A push is still running. Wait for it, then run /shipboard done."
    const dirty = await git.dirtyPaths(io.run, a.dir).catch(() => [] as string[])
    const durationMs = Math.max(0, (await io.now()) - a.claimedAt)
    const outcome: JobOutcome = a.pushedSha
      ? {
          reason: "pushed",
          summary: `Pushed ${short(a.pushedSha)} from an interactive Claude Code session.`,
          commitSha: a.pushedSha,
          changedPaths: a.changedPaths,
          sessionId: this.identity.sessionId,
          durationMs,
        }
      : { reason: "no_changes", summary: "Finished from an interactive Claude Code session without pushing.", sessionId: this.identity.sessionId, durationMs }
    let text = `Finished ${a.job.attemptId} as ${outcome.reason}. ${outcome.summary}`
    try {
      await this.client(io).finish(a.job.attemptId, a.runnerId, outcome)
    } catch (error) {
      // A 4xx means the board no longer counts this job as ours (lease gone, re-run, shipped):
      // holding on to it here would only block the next claim.
      if (!(error instanceof BoardError) || error.status < 400 || error.status >= 500) {
        return `Could not finish ${a.job.attemptId}: ${messageOf(error)}. The job is still claimed; run /shipboard done again, or let the lease expire.`
      }
      text = `Released ${a.job.attemptId} here; the board no longer holds it for this session (${messageOf(error)}).`
    }
    await this.stop(io, text)
    return dirty.length > 0 ? `${text}\n${dirty.length} uncommitted change(s) in ${a.dir} were not pushed and stay there.` : text
  }

  /** session.end: a session that pushed reports it; one that did not lets the lease expire so the job is re-queued. */
  async end(io: Io, reason: string): Promise<void> {
    const a = this.active
    if (!a) return
    if (reason === "clear" || reason === "resume") {
      a.briefSent = false
      return
    }
    for (const timer of a.timers) timer.cancel()
    if (a.pushedSha) {
      await finishQuietly(this.client(io), a.job.attemptId, a.runnerId, {
        reason: "pushed",
        summary: `Pushed ${short(a.pushedSha)}; the Claude Code session ended.`,
        commitSha: a.pushedSha,
        changedPaths: a.changedPaths,
        sessionId: this.identity.sessionId,
      })
      await io.save(null).catch(() => undefined)
    }
  }

  /** After a compaction the brief may have been summarised away; send it again. */
  resendBrief(): void {
    if (this.active) this.active.briefSent = false
  }

  private async stop(io: Io, why: string): Promise<void> {
    const a = this.active
    if (!a) return
    for (const timer of a.timers) timer.cancel()
    this.active = null
    this.ended = why
    this.note = null
    io.status(undefined)
    await io.save(null).catch(() => undefined)
    io.redraw()
  }

  // ---------------------------------------------------------------- what Claude reads

  /** Context for a prompt: the full brief once, then a one-line reminder with the board's verdict. */
  contextFor(): string | null {
    const a = this.active
    if (!a) return null
    if (!a.briefSent) {
      a.briefSent = true
      return briefContext({ job: a.job, dir: a.dir, briefSha: a.briefSha, sessionCwd: a.sessionCwd })
    }
    return reminder(a.job, a.dir, a.verdict ? oneLine(a.verdict) : null)
  }

  guardCommand(command: string, cwd: string): string | null {
    const a = this.active
    if (!a) return null
    const finding = classifyCommand(command, { cwd, jobDir: a.dir, home: this.identity.home })
    return finding ? denyMessage(finding, { attemptId: a.job.attemptId, dir: a.dir }) : null
  }

  guardFile(path: string, cwd: string): string | null {
    const a = this.active
    if (!a) return null
    const finding = classifyFileWrite(path, { cwd, jobDir: a.dir, home: this.identity.home })
    return finding ? denyMessage(finding, { attemptId: a.job.attemptId, dir: a.dir }) : null
  }

  status(): string {
    const c = this.config
    const lines = [
      `Board: ${c.url} (${c.sources.url}). Runner token: ${c.sources.runnerToken}. Board token: ${c.sources.boardToken}. Project: ${c.project ?? "none"}.`,
      `Runner id: ${this.identity.runnerId}. Agent: ${AGENT_ID} (${AGENT_LABEL}).`,
      ...c.problems,
    ]
    const a = this.active
    if (!a) {
      lines.push(this.ended ? `No active job. Last: ${this.ended}` : "No active job. /shipboard claim takes the next queued claude-code job.")
      return lines.join("\n")
    }
    lines.push(`Job: ${a.job.attemptId} (attempt ${a.job.attemptNumber}) · ${a.job.brief.task}`, `Brief: verified at ${a.briefSha}. Working copy: ${a.dir}.`)
    lines.push(a.pushedSha ? `Last push: ${short(a.pushedSha)}.` : "Not pushed yet.")
    if (a.verdict) lines.push(...verdictLines(a.verdict))
    if (this.note) lines.push(this.note)
    return lines.join("\n")
  }
}

function savedOf(a: Active): Saved {
  return {
    job: a.job,
    runnerId: a.runnerId,
    dir: a.dir,
    sessionCwd: a.sessionCwd,
    briefSha: a.briefSha,
    pushedSha: a.pushedSha,
    changedPaths: a.changedPaths,
    claimedAt: a.claimedAt,
  }
}

export function isSaved(value: unknown): value is Saved {
  if (!value || typeof value !== "object") return false
  const v = value as Partial<Saved>
  return typeof v.dir === "string" && typeof v.runnerId === "string" && typeof v.briefSha === "string" && !!v.job && typeof v.job.attemptId === "string"
}

/** Why a claimed job cannot be worked on safely, or null. Its ids become paths and URLs. */
export function invalidJob(job: ClaimedJob): string | null {
  if (!ATTEMPT_ID.test(job.attemptId) || job.attemptId.length > 63) return `attempt id ${JSON.stringify(job.attemptId)} is not a shipboard attempt id`
  if (!job.attemptId.startsWith(`${job.projectId}--`)) return `attempt ${job.attemptId} does not belong to project ${job.projectId}`
  if (!job.brief || !SAFE_SEGMENT.test(job.brief.id)) return "the brief has no usable id"
  try {
    const remote = new URL(job.remote)
    if (remote.protocol !== "http:" && remote.protocol !== "https:") return `the fork remote ${job.remote} is not http(s)`
    if (remote.username || remote.password) return "the fork remote carries credentials"
  } catch {
    return `the fork remote ${JSON.stringify(job.remote)} is not a URL`
  }
  if (!git.isSha(job.baseSha) || !git.isSha(job.briefSha)) return "the claim's base or brief sha is not a sha"
  return null
}

type Prepared = { ok: true; dir: string; sessionCwd: string; sha: string } | { ok: false; outcome: JobOutcome; text: string }

/** Read token, clone, brief check. The token lives only inside this call and the git child's env. */
async function prepare(io: Io, board: BoardClient, job: ClaimedJob, runnerId: string): Promise<Prepared> {
  const sessionCwd = await io.cwd()
  const dir = await pickDir(io, sessionCwd, job.attemptId)
  let creds
  try {
    creds = await board.credentials(job.attemptId, runnerId, "read")
  } catch (error) {
    return { ok: false, outcome: { reason: "auth", summary: `No read token: ${messageOf(error)}` }, text: `Claimed ${job.attemptId} but could not get a read token: ${messageOf(error)}` }
  }
  if (creds.remote !== job.remote) {
    return {
      ok: false,
      outcome: { reason: "auth", summary: "The read token is for another remote." },
      text: `Refused ${job.attemptId}: the board's read token is for ${creds.remote}, not the claimed fork ${job.remote}.`,
    }
  }
  const cloned = await git.clone(io.run, job.remote, dir, creds.token)
  if (!cloned.ok) {
    return { ok: false, outcome: { reason: cloned.reason, summary: `Clone failed: ${cloned.message}` }, text: `Could not clone ${job.attemptId}: ${cloned.message}` }
  }
  const check = await git.verifyBrief(io.run, dir, job)
  if (!check.ok) {
    return {
      ok: false,
      outcome: { reason: "brief_mismatch", summary: `Brief check failed: ${check.detail}.` },
      text: `Did not start ${job.attemptId}: ${check.detail}. The job is finished as brief_mismatch; the clone is left in ${dir} for inspection.`,
    }
  }
  return { ok: true, dir, sessionCwd, sha: check.sha }
}

/** The session directory when it is empty, else ./shipboard/<attemptId> (with a suffix if taken). */
async function pickDir(io: Io, cwd: string, attemptId: string): Promise<string> {
  const entries = await io.list(cwd).catch(() => null)
  if (entries !== null && entries.length === 0) return cwd
  const root = `${cwd.replace(/\/+$/, "")}/shipboard/${attemptId}`
  let dir = root
  for (let n = 2; await io.exists(dir); n += 1) dir = `${root}.${n}`
  return dir
}

function subjectOf(message: string | undefined, task: string): string {
  const first = (message ?? "").split("\n")[0]?.replace(/\s+/g, " ").trim() ?? ""
  const subject = first || task.replace(/\s+/g, " ").trim()
  return subject.length > 72 ? `${subject.slice(0, 71)}…` : subject
}

/** The board-side turns worth a toast: someone else acted on this attempt. */
function turnOf(v: Verdict): string | null {
  if (!v.isCurrent || v.attempt.status === "discarded") return "was discarded for a re-run. Run /shipboard done, then /shipboard claim."
  if (v.attempt.status === "shipped") return "shipped. Run /shipboard done."
  if (v.attempt.merge?.state === "conflict") return "now conflicts with main; the board offers a re-run."
  return null
}

function authHint(error: unknown, option: string, variable: string, secret: string): string {
  if (!(error instanceof BoardError) || (error.status !== 401 && error.status !== 403 && error.status !== 503)) return ""
  return ` Set the ${option} option (or ${variable}) to the board's ${secret}.`
}

async function finishQuietly(board: BoardClient, attemptId: string, runnerId: string, outcome: JobOutcome): Promise<void> {
  try {
    await board.finish(attemptId, runnerId, outcome)
  } catch {
    // The lease expires on its own and the board re-queues or fails the job.
  }
}
