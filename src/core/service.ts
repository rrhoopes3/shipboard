/**
 * ProjectService: one project's lifecycle (docs/ARCHITECTURE.md, "Lifecycle"). Platform-neutral.
 *
 * Every mutation runs under one mutex against a draft copy of the stored state. The draft is
 * saved (and the version bumped) only when something actually changed, and dropped when the
 * mutation throws, unless the mutation checkpointed first because it had already done something
 * irreversible in git (a ship, a conflict found while shipping).
 */

import { DEMO_AGENT, agentKind, agentLabel, findAgent } from "./agents.ts"
import { briefBytes, briefFile, bytesEqual, makeBrief, validateDispatch } from "./brief.ts"
import { DEMO_AUTHOR, demoEdit } from "./demo.ts"
import { buildDigest, parseChecks } from "./digest.ts"
import { GitWorkspace } from "./git.ts"
import { validateCreateProject, validateOutcome } from "./inputs.ts"
import { Mutex } from "./mutex.ts"
import {
  assertSafeRel,
  briefPath,
  isAttemptId,
  listPhrase,
  newAttemptId,
  newBriefId,
  oneLine,
  projectIdOf,
  shortSha,
} from "./names.ts"
import { PortError } from "./ports.ts"
import type { Clock, CorePorts, Logger, ProjectHandle, ProjectServiceOptions } from "./ports.ts"
import { HARBOR_BRIEFS, harborFiles, starterFiles } from "./seeds.ts"
import {
  LEASE_MS,
  MANUAL_TOKEN_TTL,
  MAX_REQUEUES,
  READ_TOKEN_TTL,
  RECONCILE_MS,
  WRITE_TOKEN_TTL,
  bumpVersion,
  fingerprint,
  nextAttemptNumber,
  pushActivity,
} from "./state.ts"
import type {
  Activity,
  Attempt,
  BoardView,
  Brief,
  ClaimedJob,
  CreateProjectInput,
  DispatchInput,
  GitCredentials,
  Job,
  JobOutcome,
  Project,
  ProjectState,
  ProjectSummary,
} from "./types.ts"
import { boardView, contentTypeFor, projectSummary } from "./views.ts"

export { validateCreateProject, validateOutcome } from "./inputs.ts"

type Tx = {
  state: ProjectState
  /** Fingerprint of what is already persisted, to decide whether a save is needed. */
  saved: string
  /** Work to start once the mutex is released (demo jobs). */
  after: Array<() => void>
}

const SHA = /^[0-9a-f]{40}$/

const quietLog: Logger = {
  info: () => {},
  warn: (message, data) => console.warn(message, data ?? ""),
  error: (message, data) => console.error(message, data ?? ""),
}

function sentence(text: string): string {
  const t = text.trim()
  return /[.!?]$/.test(t) ? t : `${t}.`
}

export class ProjectService implements ProjectHandle {
  private readonly mutex = new Mutex()
  private committed: ProjectState | null = null
  private ws: GitWorkspace | null = null
  private readonly clock: Clock
  private readonly log: Logger
  private lastReconcileTry = 0

  constructor(
    readonly projectId: string,
    private readonly ports: CorePorts,
    private readonly options: ProjectServiceOptions,
  ) {
    this.clock = ports.clock ?? { now: () => new Date() }
    this.log = ports.log ?? quietLog
  }

  // ------------------------------------------------------------------ reads

  async summary(): Promise<ProjectSummary> {
    return projectSummary(await this.snapshot())
  }

  async board(opts?: { reconcile?: boolean }): Promise<BoardView> {
    if (opts?.reconcile !== false) await this.maybeReconcile()
    return this.view()
  }

  async version(): Promise<number> {
    await this.maybeReconcile()
    return (await this.snapshot()).version
  }

  async diff(attemptId: string): Promise<{ diff: string; truncated: boolean; base: string; head: string }> {
    this.requireOwn(attemptId)
    const state = await this.snapshot()
    const attempt = this.attemptOf(state, attemptId)
    const result = await this.git().diff({
      repo: attempt.repo,
      baseSha: attempt.baseSha,
      headSha: attempt.headSha,
      exclude: [briefPath(attempt.briefId)],
    })
    return { ...result, base: attempt.baseSha, head: attempt.headSha }
  }

  async preview(ref: string, path: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const state = await this.snapshot()
    let repo: string
    let sha: string
    if (ref === "main") {
      repo = state.project.repo
      sha = state.project.mainSha
    } else {
      if (!isAttemptId(ref) || projectIdOf(ref) !== this.projectId) return null
      const attempt = state.attempts.find((item) => item.id === ref)
      if (!attempt) return null
      repo = attempt.repo
      sha = attempt.headSha
    }
    const rel = path.replace(/^\/+/, "")
    const candidates: string[] = []
    if (!rel) candidates.push("index.html")
    else {
      let safe: string
      try {
        safe = assertSafeRel(rel, { allowDir: true, allowSpaces: true })
      } catch {
        return null
      }
      if (safe.endsWith("/")) candidates.push(`${safe}index.html`)
      else candidates.push(safe, `${safe}/index.html`)
    }
    for (const candidate of candidates) {
      const body = await this.ports.artifacts.readFile(repo, sha, candidate)
      if (body) return { body, contentType: contentTypeFor(candidate) }
    }
    return null
  }

  /** queuedAt of the oldest job a runner offering `agents` could claim here, or null. */
  async nextJobAt(agents: string[]): Promise<string | null> {
    const state = await this.snapshot()
    return this.claimable(state, agents)[0]?.queuedAt ?? null
  }

  /** Counts of queued and running jobs, so hosts know whether to keep ticking this project. */
  async activeJobs(): Promise<{ queued: number; running: number }> {
    const state = await this.snapshot()
    let queued = 0
    let running = 0
    for (const job of state.jobs) {
      if (job.state === "queued") queued++
      else if (job.state === "running") running++
    }
    return { queued, running }
  }

  async jobCredentials(attemptId: string, runnerId: string, scope: "read" | "write"): Promise<GitCredentials> {
    this.requireOwn(attemptId)
    if (scope !== "read" && scope !== "write") throw new PortError('Scope is "read" or "write".', 400)
    const state = await this.snapshot()
    const job = this.leasedJob(state, attemptId, runnerId)
    const attempt = this.attemptOf(state, attemptId)
    const writable = attempt.status === "waiting" || attempt.status === "ready"
    if (!writable && (scope === "write" || attempt.status !== "parked")) {
      throw new PortError(`That attempt is ${attempt.status}; it takes no more pushes.`, 409, "not_live")
    }
    if (Date.parse(job.leaseExpiresAt ?? "") <= this.clock.now().getTime()) {
      throw new PortError("The lease on that job expired. Claim a new job.", 409, "lease_expired")
    }
    return this.ports.artifacts.token(attempt.repo, scope, scope === "read" ? READ_TOKEN_TTL : WRITE_TOKEN_TTL)
  }

  // ------------------------------------------------------------------ create

  async init(input: CreateProjectInput & { id: string }): Promise<ProjectSummary> {
    if (!input || input.id !== this.projectId) throw new PortError("The project id does not match this service.", 400)
    const fields = validateCreateProject(input)
    const outcome = await this.mutex.run(async () => {
      if (this.committed || (await this.ports.state.load())) {
        throw new PortError("A project with that id already exists.", 409, "exists")
      }
      const id = this.projectId
      const made: string[] = []
      try {
        let seed: Project["seed"]
        if (fields.importUrl) {
          await this.ports.artifacts.import(fields.importUrl, id)
          made.push(id)
          seed = "import"
        } else {
          await this.ports.artifacts.create(id, { description: fields.description })
          made.push(id)
          seed = fields.seed
          const files = seed === "harbor" ? harborFiles() : starterFiles(fields.name, fields.description)
          await this.git().seed(id, files, seed === "harbor" ? "Start the harbor notice board" : "Start main")
        }
        const mainSha = await this.ports.artifacts.head(id)
        if (!mainSha) throw new PortError("That repo has no main branch to build on.", 400, "empty_repo")
        const now = this.now()
        const state: ProjectState = {
          schema: 1,
          version: 0,
          project: {
            id,
            name: fields.name,
            description: fields.description,
            createdAt: now,
            repo: id,
            mainSha,
            seed,
          },
          briefs: [],
          attempts: [],
          jobs: [],
          activity: [],
          reconciledAt: this.clock.now().getTime(),
        }
        const from = seed === "import" ? `imported ${fields.importUrl}` : seed === "harbor" ? "the harbor demo" : "the starter site"
        pushActivity(state, { kind: "project", text: `Created ${fields.name} from ${from}.` }, now)
        const tx: Tx = { state, saved: "", after: [] }
        if (seed === "harbor") {
          for (const spec of HARBOR_BRIEFS) {
            const { attempt } = await this.dispatchInto(tx, { ...spec, agent: DEMO_AGENT }, { demo: spec.demo })
            made.push(attempt.repo)
          }
        }
        bumpVersion(state)
        await this.ports.state.save(state)
        this.committed = state
        return { summary: projectSummary(state), after: tx.after }
      } catch (err) {
        await Promise.all(made.map((repo) => this.ports.artifacts.delete(repo).catch(() => false)))
        throw err
      }
    })
    this.runAfter(outcome.after)
    return outcome.summary
  }

  // ------------------------------------------------------------------ dispatch and re-run

  async dispatch(
    input: DispatchInput,
    opts?: { withCredentials?: boolean },
  ): Promise<{ board: BoardView; attemptId: string; credentials?: GitCredentials }> {
    const result = await this.write(async (tx) => {
      const { attempt, credentials } = await this.dispatchInto(tx, input, { withCredentials: opts?.withCredentials })
      return { attemptId: attempt.id, credentials }
    })
    const out: { board: BoardView; attemptId: string; credentials?: GitCredentials } = {
      board: await this.view(),
      attemptId: result.attemptId,
    }
    if (result.credentials) out.credentials = result.credentials
    return out
  }

  async rerun(attemptId: string, agent?: string): Promise<{ board: BoardView; attemptId: string }> {
    this.requireOwn(attemptId)
    const freshId = await this.write(async (tx) => {
      const old = this.attemptOf(tx.state, attemptId)
      if (old.status !== "ready" && old.status !== "failed" && old.status !== "parked") {
        throw new PortError(`Only a ready, failed or parked attempt can be re-run. This one is ${old.status}.`, 409, "state")
      }
      const brief = this.briefOf(tx.state, old)
      const agentId = this.checkAgent(agent === undefined || agent === null || agent === "" ? old.agent : agent, brief)

      // The brief is read back from the old fork's brief commit, not trusted from the board's copy.
      const committed = await this.ports.artifacts.readFile(old.repo, old.briefSha, briefPath(brief.id))
      if (!bytesEqual(committed, briefBytes(brief))) {
        throw new PortError(
          `The brief committed on ${old.id} does not match the board's copy, so it was not re-run.`,
          409,
          "brief_mismatch",
        )
      }

      const reason = this.discardReason(tx.state, old)
      const fresh = await this.createAttempt(brief, agentId, nextAttemptNumber(tx.state, brief.id), old.id, tx.state)
      const now = this.now()
      tx.state.attempts.push(fresh)
      old.status = "discarded"
      old.replacedBy = fresh.id
      old.discardReason = reason
      old.updatedAt = now
      this.dropQueuedJob(tx.state, old.id)
      this.cancelRunningJob(tx.state, old.id, `Discarded for a re-run: ${reason}`)
      this.queueJob(tx, fresh)
      this.activity(tx.state, {
        kind: "rerun",
        text: `Re-ran "${oneLine(brief.task, 80)}" as attempt ${fresh.number} on main ${shortSha(fresh.baseSha)}. Attempt ${old.number} was discarded: ${reason}`,
        briefId: brief.id,
        attemptId: fresh.id,
        agent: agentId,
      })
      return fresh.id
    })
    return { board: await this.view(), attemptId: freshId }
  }

  // ------------------------------------------------------------------ push detection and assessment

  async pushed(attemptId: string, sha?: string): Promise<BoardView> {
    this.requireOwn(attemptId)
    await this.write(async (tx) => {
      const attempt = this.attemptOf(tx.state, attemptId)
      if (attempt.status !== "waiting" && attempt.status !== "ready") return
      if (sha && SHA.test(sha) && this.alreadySeen(attempt, sha)) return
      const head = await this.ports.artifacts.head(attempt.repo)
      if (!head || this.alreadySeen(attempt, head)) return
      await this.assessAttempt(tx, attempt)
    })
    return this.view()
  }

  async onPushEvent(event: { repo: string; ref: string; after: string }): Promise<void> {
    if (!event || event.ref !== "refs/heads/main" || !SHA.test(event.after) || /^0+$/.test(event.after)) return
    if (projectIdOf(event.repo) !== this.projectId) return
    // Pushes made while the project is still being created (seed, brief commits) arrive before
    // there is any state. They are shipboard's own and need no assessment.
    try {
      await this.load()
    } catch {
      return
    }
    await this.write(async (tx) => {
      if (event.repo === tx.state.project.repo) {
        if (event.after !== tx.state.project.mainSha) await this.mainMoved(tx)
        return
      }
      const attempt = tx.state.attempts.find((item) => item.repo === event.repo)
      if (!attempt || (attempt.status !== "waiting" && attempt.status !== "ready")) return
      if (this.alreadySeen(attempt, event.after)) return
      await this.assessAttempt(tx, attempt)
    })
  }

  // ------------------------------------------------------------------ ship, park, unpark

  async ship(attemptId: string, expectedHead?: string): Promise<BoardView> {
    this.requireOwn(attemptId)
    await this.write(async (tx) => {
      const attempt = this.attemptOf(tx.state, attemptId)
      if (attempt.status === "shipped") throw new PortError("That attempt already shipped.", 409, "state")
      if (attempt.status !== "ready") {
        throw new PortError(`Only a ready attempt can ship. This one is ${attempt.status}.`, 409, "state")
      }
      if (attempt.merge?.state !== "clean") {
        throw new PortError("This attempt conflicts with main. Re-run it instead of merging.", 409, "conflict")
      }
      if (expectedHead !== undefined && (typeof expectedHead !== "string" || !SHA.test(expectedHead))) {
        throw new PortError("expectedHead must be a full commit sha.", 400)
      }
      const brief = this.briefOf(tx.state, attempt)
      const result = await this.git().ship({
        mainRepo: tx.state.project.repo,
        forkRepo: attempt.repo,
        expectedHead: expectedHead ?? attempt.headSha,
        message: `ship: ${oneLine(brief.task)}\n\nShipboard-Attempt: ${attempt.id}\nShipboard-Brief: ${brief.id}`,
      })
      const now = this.now()
      if (result.kind === "moved") {
        if (result.headSha !== attempt.headSha) await this.assessAttempt(tx, attempt)
        await this.checkpoint(tx)
        throw new PortError(
          `The fork is at ${shortSha(result.headSha)}, not the head you were shown. Check the new digest, then ship.`,
          409,
          "moved",
        )
      }
      if (result.kind === "conflict") {
        attempt.merge = { state: "conflict", paths: result.paths, mainSha: result.mainSha, headSha: result.headSha, checkedAt: now }
        attempt.updatedAt = now
        this.conflictActivity(tx.state, attempt, brief)
        if (result.mainSha !== tx.state.project.mainSha) tx.state.project.mainSha = result.mainSha
        await this.checkpoint(tx)
        throw new PortError(
          `This attempt now conflicts with main${result.paths.length ? ` in ${listPhrase(result.paths)}` : ""}. Re-run it instead.`,
          409,
          "conflict",
        )
      }
      attempt.status = "shipped"
      attempt.shippedSha = result.mainSha
      attempt.updatedAt = now
      tx.state.project.mainSha = result.mainSha
      this.dropQueuedJob(tx.state, attempt.id)
      this.activity(tx.state, {
        kind: "shipped",
        text: `Shipped "${oneLine(brief.task, 80)}" to main at ${shortSha(result.mainSha)}.`,
        briefId: brief.id,
        attemptId: attempt.id,
        agent: attempt.agent,
      })
      // Main moved for real. Persist before re-checking the others, so a failure there cannot lose the ship.
      await this.checkpoint(tx)
      await this.retrialOthers(tx, attempt.id)
    })
    return this.view()
  }

  async park(attemptId: string): Promise<BoardView> {
    this.requireOwn(attemptId)
    await this.write(async (tx) => {
      const attempt = this.attemptOf(tx.state, attemptId)
      if (attempt.status !== "ready" && attempt.status !== "waiting" && attempt.status !== "failed") {
        throw new PortError(`Only a ready, waiting or failed attempt can be parked. This one is ${attempt.status}.`, 409, "state")
      }
      const brief = this.briefOf(tx.state, attempt)
      attempt.status = "parked"
      attempt.updatedAt = this.now()
      this.dropQueuedJob(tx.state, attempt.id)
      this.cancelRunningJob(tx.state, attempt.id, "A human parked the attempt.")
      this.activity(tx.state, {
        kind: "parked",
        text: `Parked "${oneLine(brief.task, 80)}".`,
        briefId: brief.id,
        attemptId: attempt.id,
        agent: attempt.agent,
      })
    })
    return this.view()
  }

  async unpark(attemptId: string): Promise<BoardView> {
    this.requireOwn(attemptId)
    await this.write(async (tx) => {
      const attempt = this.attemptOf(tx.state, attemptId)
      if (attempt.status !== "parked") throw new PortError("That attempt is not parked.", 409, "state")
      const brief = this.briefOf(tx.state, attempt)
      attempt.status = attempt.digest ? "ready" : "waiting"
      attempt.updatedAt = this.now()
      await this.assessAttempt(tx, attempt, { force: true })
      if (attempt.status === "waiting") this.queueJob(tx, attempt)
      this.activity(tx.state, {
        kind: "unparked",
        text: `Put "${oneLine(brief.task, 80)}" back on the board.`,
        briefId: brief.id,
        attemptId: attempt.id,
        agent: attempt.agent,
      })
    })
    return this.view()
  }

  // ------------------------------------------------------------------ runner protocol

  async claim(runnerId: string, agents: string[], opts?: { attemptId?: string }): Promise<ClaimedJob | null> {
    if (opts?.attemptId) this.requireOwn(opts.attemptId)
    return this.write(async (tx) => {
      // Jobs whose attempt is no longer waiting (a human pushed, or it was discarded) are dropped.
      tx.state.jobs = tx.state.jobs.filter((job) => {
        if (job.state !== "queued") return true
        const attempt = tx.state.attempts.find((item) => item.id === job.attemptId)
        return attempt?.status === "waiting"
      })
      const job = this.claimable(tx.state, agents).find((item) => !opts?.attemptId || item.attemptId === opts.attemptId)
      if (!job) return null
      const attempt = this.attemptOf(tx.state, job.attemptId)
      const brief = this.briefOf(tx.state, attempt)
      const info = await this.ports.artifacts.info(attempt.repo)
      if (!info) {
        this.failJob(tx, job, attempt, { reason: "agent_error", summary: "The fork repo is missing." })
        return null
      }
      const now = this.clock.now()
      job.state = "running"
      job.runnerId = runnerId
      job.claimedAt = now.toISOString()
      job.leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString()
      this.activity(tx.state, {
        kind: "claimed",
        text: `Runner ${runnerId} claimed "${oneLine(brief.task, 80)}" for ${agentLabel(this.options.agents, job.agent)}.`,
        briefId: brief.id,
        attemptId: attempt.id,
        agent: job.agent,
      })
      const claimed: ClaimedJob = {
        attemptId: attempt.id,
        projectId: this.projectId,
        agent: job.agent,
        brief: { ...brief, constraints: [...brief.constraints], paths: [...brief.paths] },
        briefPath: briefPath(brief.id),
        baseSha: attempt.baseSha,
        briefSha: attempt.briefSha,
        remote: info.remote,
        leaseExpiresAt: job.leaseExpiresAt,
        attemptNumber: attempt.number,
      }
      if (attempt.replaces) {
        const previous = tx.state.attempts.find((item) => item.id === attempt.replaces)
        claimed.previous = { attemptId: attempt.replaces, reason: previous?.discardReason ?? null }
      }
      return claimed
    })
  }

  async heartbeat(attemptId: string, runnerId: string): Promise<{ leaseExpiresAt: string }> {
    this.requireOwn(attemptId)
    return this.write(async (tx) => {
      const job = this.leasedJob(tx.state, attemptId, runnerId)
      const attempt = this.attemptOf(tx.state, attemptId)
      if (attempt.status === "discarded" || attempt.status === "shipped") {
        throw new PortError(`That attempt is ${attempt.status}. Stop working on it.`, 409, "not_live")
      }
      job.leaseExpiresAt = new Date(this.clock.now().getTime() + LEASE_MS).toISOString()
      return { leaseExpiresAt: job.leaseExpiresAt }
    })
  }

  async finish(attemptId: string, runnerId: string, outcome: JobOutcome): Promise<BoardView> {
    this.requireOwn(attemptId)
    const clean = validateOutcome(outcome)
    await this.write(async (tx) => {
      const job = tx.state.jobs.find((item) => item.attemptId === attemptId)
      if (!job) throw new PortError("There is no job for that attempt.", 404, "not_found")
      if ((job.state === "done" || job.state === "failed") && job.runnerId === runnerId) return
      if (job.state !== "running" || job.runnerId !== runnerId) {
        throw new PortError("This runner does not hold the lease on that job.", 409, "lease")
      }
      const attempt = this.attemptOf(tx.state, attemptId)
      const brief = this.briefOf(tx.state, attempt)
      const now = this.now()
      job.finishedAt = now
      job.outcome = clean
      const live = attempt.status === "waiting" || attempt.status === "ready"
      if (clean.reason === "pushed") {
        job.state = "done"
        if (live) {
          const head = await this.ports.artifacts.head(attempt.repo)
          // Usually the push was already seen through `pushed` or a push event.
          if (head && !this.alreadySeen(attempt, head)) await this.assessAttempt(tx, attempt)
          if (attempt.status === "waiting") {
            attempt.status = "failed"
            attempt.updatedAt = now
            this.activity(tx.state, {
              kind: "failed",
              text: `${agentLabel(this.options.agents, job.agent)} reported a push for "${oneLine(brief.task, 80)}", but the fork has nothing new.`,
              briefId: brief.id,
              attemptId: attempt.id,
              agent: job.agent,
            })
          }
        }
        return
      }
      job.state = "failed"
      this.activity(tx.state, {
        kind: "failed",
        text: `${agentLabel(this.options.agents, job.agent)} did not finish "${oneLine(brief.task, 80)}" (${clean.reason})${clean.summary ? `: ${oneLine(clean.summary, 200)}` : "."}`,
        briefId: brief.id,
        attemptId: attempt.id,
        agent: job.agent,
      })
      if (!live) return
      const head = await this.ports.artifacts.head(attempt.repo)
      if (head && !this.alreadySeen(attempt, head)) {
        // It pushed something before giving up; that is still worth a look.
        await this.assessAttempt(tx, attempt)
      } else if (attempt.status === "waiting") {
        attempt.status = "failed"
        attempt.updatedAt = now
      }
    })
    return this.view()
  }

  // ------------------------------------------------------------------ background work

  async runDemoJobs(): Promise<number> {
    let ran = 0
    for (;;) {
      const did = await this.write(async (tx) => {
        const job = tx.state.jobs
          .filter((item) => item.state === "queued" && agentKind(this.options.agents, item.agent) === "demo")
          .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0))[0]
        if (!job) return false
        await this.runDemoJob(tx, job)
        return true
      })
      if (!did) return ran
      ran++
    }
  }

  async tick(): Promise<void> {
    await this.write(async (tx) => {
      const now = this.clock.now().getTime()
      for (const job of tx.state.jobs) {
        if (job.state !== "running" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > now) continue
        const attempt = tx.state.attempts.find((item) => item.id === job.attemptId)
        const task = attempt ? oneLine(this.briefOf(tx.state, attempt).task, 80) : job.attemptId
        const requeues = job.requeues ?? 0
        if (requeues >= MAX_REQUEUES) {
          job.state = "failed"
          job.finishedAt = new Date(now).toISOString()
          job.outcome = { reason: "lease_expired", summary: `The runner lease expired ${requeues + 1} times.` }
          if (attempt?.status === "waiting") {
            attempt.status = "failed"
            attempt.updatedAt = new Date(now).toISOString()
          }
          this.activity(tx.state, {
            kind: "failed",
            text: `Gave up on "${task}" after the runner lease expired ${requeues + 1} times (lease_expired).`,
            briefId: attempt?.briefId,
            attemptId: job.attemptId,
            agent: job.agent,
          })
          continue
        }
        const runner = job.runnerId ?? "a runner"
        job.state = "queued"
        job.requeues = requeues + 1
        delete job.runnerId
        delete job.claimedAt
        delete job.leaseExpiresAt
        this.activity(tx.state, {
          kind: "failed",
          text: `The lease ${runner} held on "${task}" expired (lease_expired). Queued it again (${requeues + 1} of ${MAX_REQUEUES}).`,
          briefId: attempt?.briefId,
          attemptId: job.attemptId,
          agent: job.agent,
        })
        if (agentKind(this.options.agents, job.agent) === "demo") this.queueDemo(tx)
      }
      if (now - tx.state.reconciledAt >= RECONCILE_MS) await this.reconcile(tx)
      if (tx.state.jobs.some((job) => job.state === "queued" && agentKind(this.options.agents, job.agent) === "demo")) {
        this.queueDemo(tx)
      }
    })
  }

  // ------------------------------------------------------------------ transactions

  private async load(): Promise<ProjectState> {
    if (this.committed) return this.committed
    const state = await this.ports.state.load()
    if (!state) throw new PortError("No project with that id.", 404, "not_found")
    this.committed = state
    return state
  }

  private snapshot(): Promise<ProjectState> {
    return this.load()
  }

  private async view(): Promise<BoardView> {
    return boardView(await this.snapshot(), this.options.agents)
  }

  private async write<T>(task: (tx: Tx) => Promise<T>): Promise<T> {
    const outcome = await this.mutex.run(async () => {
      const base = await this.load()
      const tx: Tx = { state: structuredClone(base), saved: fingerprint(base), after: [] }
      const result = await task(tx)
      await this.persist(tx)
      this.committed = tx.state
      return { result, after: tx.after }
    })
    this.runAfter(outcome.after)
    return outcome.result
  }

  private async persist(tx: Tx): Promise<void> {
    const now = fingerprint(tx.state)
    if (now === tx.saved) return
    bumpVersion(tx.state)
    await this.ports.state.save(tx.state)
    tx.saved = now
  }

  /** Saves mid-mutation, after an irreversible step in git, so a later throw cannot roll it back. */
  private async checkpoint(tx: Tx): Promise<void> {
    await this.persist(tx)
    this.committed = structuredClone(tx.state)
  }

  private runAfter(work: Array<() => void>): void {
    for (const item of work) item()
  }

  private queueDemo(tx: Tx): void {
    if (tx.after.length > 0) return
    tx.after.push(() => {
      const work = () => this.runDemoJobs()
      if (this.options.schedule) this.options.schedule(work)
      else work().catch((err: unknown) => this.log.error("demo jobs failed", { error: String(err) }))
    })
  }

  private async maybeReconcile(): Promise<void> {
    const now = this.clock.now().getTime()
    if (now - this.lastReconcileTry < RECONCILE_MS) return
    const state = await this.snapshot()
    if (now - state.reconciledAt < RECONCILE_MS) return
    this.lastReconcileTry = now
    const run = this.mutex.tryRun(async () => {
      const base = await this.load()
      const tx: Tx = { state: structuredClone(base), saved: fingerprint(base), after: [] }
      await this.reconcile(tx)
      await this.persist(tx)
      this.committed = tx.state
      return tx.after
    })
    if (!run) return
    try {
      this.runAfter(await run)
    } catch (err) {
      this.log.warn("reconcile failed", { project: this.projectId, error: String(err) })
    }
  }

  // ------------------------------------------------------------------ lifecycle internals

  private git(): GitWorkspace {
    if (!this.ws) this.ws = new GitWorkspace(this.ports.artifacts, { http: this.ports.http, clock: this.clock })
    return this.ws
  }

  private now(): string {
    return this.clock.now().toISOString()
  }

  private requireOwn(attemptId: string): void {
    if (!isAttemptId(attemptId) || projectIdOf(attemptId) !== this.projectId) {
      throw new PortError("No attempt with that id.", 404, "not_found")
    }
  }

  private attemptOf(state: ProjectState, attemptId: string): Attempt {
    const attempt = state.attempts.find((item) => item.id === attemptId)
    if (!attempt) throw new PortError("No attempt with that id.", 404, "not_found")
    return attempt
  }

  private briefOf(state: ProjectState, attempt: Attempt): Brief {
    const brief = state.briefs.find((item) => item.id === attempt.briefId)
    if (!brief) throw new PortError(`The brief for ${attempt.id} is missing from the board.`, 500, "corrupt")
    return brief
  }

  private leasedJob(state: ProjectState, attemptId: string, runnerId: string): Job {
    const job = state.jobs.find((item) => item.attemptId === attemptId)
    if (!job) throw new PortError("There is no job for that attempt.", 404, "not_found")
    if (job.state !== "running" || job.runnerId !== runnerId) {
      throw new PortError("This runner does not hold the lease on that job.", 409, "lease")
    }
    return job
  }

  private activity(state: ProjectState, entry: Omit<Activity, "at">): void {
    pushActivity(state, entry, this.now())
  }

  /** A seen head: the brief commit itself, or a head that already has a digest. */
  private alreadySeen(attempt: Attempt, sha: string): boolean {
    if (sha === attempt.briefSha && attempt.status === "waiting") return true
    return sha === attempt.headSha && attempt.digest !== null && attempt.digest.headSha === sha
  }

  private checkAgent(raw: string, brief: Brief): string {
    const id = String(raw).trim().toLowerCase()
    if (!findAgent(this.options.agents, id)) {
      throw new PortError(`There is no agent called "${id.slice(0, 40)}". Pick one from the list.`, 400)
    }
    if (agentKind(this.options.agents, id) === "demo" && !demoEdit(brief.demo)) {
      throw new PortError("The demo agent only runs the harbor demo briefs. Pick a real agent.", 400)
    }
    return id
  }

  private uniqueBriefId(state: ProjectState, task: string): string {
    for (;;) {
      const id = newBriefId(task)
      if (!state.briefs.some((brief) => brief.id === id)) return id
    }
  }

  private async dispatchInto(
    tx: Tx,
    input: DispatchInput,
    opts: { demo?: string; withCredentials?: boolean },
  ): Promise<{ attempt: Attempt; credentials?: GitCredentials }> {
    const fields = validateDispatch(input, this.options.agents)
    const brief = makeBrief(fields, { id: this.uniqueBriefId(tx.state, fields.task), createdAt: this.now(), demo: opts.demo })
    const agent = this.checkAgent(fields.agent, brief)
    const attempt = await this.createAttempt(brief, agent, 1, null, tx.state)
    let credentials: GitCredentials | undefined
    if (agentKind(this.options.agents, agent) === "manual" && opts.withCredentials) {
      try {
        credentials = await this.ports.artifacts.token(attempt.repo, "write", MANUAL_TOKEN_TTL)
      } catch (err) {
        await this.ports.artifacts.delete(attempt.repo).catch(() => false)
        throw err
      }
    }
    tx.state.briefs.push(brief)
    tx.state.attempts.push(attempt)
    this.queueJob(tx, attempt)
    this.activity(tx.state, {
      kind: "dispatched",
      text: `Dispatched "${oneLine(brief.task, 80)}" to ${agentLabel(this.options.agents, agent)}.`,
      briefId: brief.id,
      attemptId: attempt.id,
      agent,
    })
    return { attempt, credentials }
  }

  /** Fork current main and commit the brief as the fork's first commit. Deletes the fork on failure. */
  private async createAttempt(brief: Brief, agent: string, number: number, replaces: string | null, state?: ProjectState): Promise<Attempt> {
    const taken = new Set((state ?? this.committed)?.attempts.map((item) => item.id) ?? [])
    let id = newAttemptId(this.projectId, brief.task)
    while (taken.has(id)) id = newAttemptId(this.projectId, brief.task)
    await this.ports.artifacts.fork(this.projectId, id, { description: oneLine(brief.task, 200) })
    try {
      const { briefSha, baseSha } = await this.git().commitBrief(id, briefFile(brief), oneLine(brief.task))
      const now = this.now()
      return {
        id,
        briefId: brief.id,
        number,
        agent,
        status: "waiting",
        repo: id,
        baseSha,
        briefSha,
        headSha: briefSha,
        createdAt: now,
        updatedAt: now,
        digest: null,
        merge: null,
        review: null,
        replacedBy: null,
        replaces,
        discardReason: null,
        shippedSha: null,
      }
    } catch (err) {
      await this.ports.artifacts.delete(id).catch(() => false)
      throw err
    }
  }

  private queueJob(tx: Tx, attempt: Attempt): void {
    const kind = agentKind(this.options.agents, attempt.agent)
    if (kind === "manual") return
    const existing = tx.state.jobs.find((job) => job.attemptId === attempt.id)
    if (existing && (existing.state === "queued" || existing.state === "running")) return
    tx.state.jobs = tx.state.jobs.filter((job) => job.attemptId !== attempt.id)
    tx.state.jobs.push({ attemptId: attempt.id, agent: attempt.agent, state: "queued", queuedAt: this.now() })
    if (kind === "demo") this.queueDemo(tx)
  }

  private dropQueuedJob(state: ProjectState, attemptId: string): void {
    state.jobs = state.jobs.filter((job) => !(job.attemptId === attemptId && job.state === "queued"))
  }

  /** A runner still holding the attempt loses its lease: heartbeat and credentials then answer 409. */
  private cancelRunningJob(state: ProjectState, attemptId: string, summary: string): void {
    const job = state.jobs.find((item) => item.attemptId === attemptId && item.state === "running")
    if (!job) return
    job.state = "failed"
    job.finishedAt = this.now()
    job.outcome = { reason: "cancelled", summary }
  }

  private claimable(state: ProjectState, agents: string[]): Job[] {
    const offered = new Set(agents)
    return state.jobs
      .filter((job) => {
        if (job.state !== "queued" || !offered.has(job.agent)) return false
        if (agentKind(this.options.agents, job.agent) !== "cli") return false
        return state.attempts.find((item) => item.id === job.attemptId)?.status === "waiting"
      })
      .sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0))
  }

  private failJob(tx: Tx, job: Job, attempt: Attempt, outcome: JobOutcome): void {
    const now = this.now()
    job.state = "failed"
    job.finishedAt = now
    job.outcome = outcome
    if (attempt.status === "waiting") {
      attempt.status = "failed"
      attempt.updatedAt = now
    }
    const brief = this.briefOf(tx.state, attempt)
    this.activity(tx.state, {
      kind: "failed",
      text: `${agentLabel(this.options.agents, job.agent)} did not finish "${oneLine(brief.task, 80)}" (${outcome.reason}): ${outcome.summary}`,
      briefId: brief.id,
      attemptId: attempt.id,
      agent: job.agent,
    })
  }

  private async runDemoJob(tx: Tx, job: Job): Promise<void> {
    const attempt = this.attemptOf(tx.state, job.attemptId)
    const brief = this.briefOf(tx.state, attempt)
    const now = this.clock.now()
    job.state = "running"
    job.runnerId = "demo"
    job.claimedAt = now.toISOString()
    job.leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString()
    const edit = demoEdit(brief.demo)
    if (attempt.status !== "waiting") {
      job.state = "done"
      job.finishedAt = this.now()
      job.outcome = { reason: "no_changes", summary: `The attempt was ${attempt.status} before the demo ran.` }
      return
    }
    if (!edit) {
      this.failJob(tx, job, attempt, { reason: "agent_error", summary: "The demo agent only knows the harbor demo briefs." })
      return
    }
    let commitSha: string
    try {
      const git = this.git()
      const head = await git.head(attempt.repo)
      if (!head) throw new PortError("The fork has no main branch.", 409)
      const current = await git.readAt(attempt.repo, head, edit.path)
      if (!current) {
        this.failJob(tx, job, attempt, { reason: "agent_error", summary: `${edit.path} is missing on this fork.` })
        return
      }
      const next = edit.apply(new TextDecoder().decode(current))
      const commit = await git.commit(
        attempt.repo,
        { [edit.path]: next },
        `${oneLine(brief.task)}\n\nShipboard-Attempt: ${attempt.id}\nShipboard-Agent: ${DEMO_AGENT}`,
        { author: DEMO_AUTHOR, parent: head },
      )
      if (!commit.changed) {
        this.failJob(tx, job, attempt, { reason: "no_changes", summary: `The scripted edit left ${edit.path} unchanged.` })
        return
      }
      commitSha = commit.sha
    } catch (err) {
      this.failJob(tx, job, attempt, { reason: "agent_error", summary: oneLine(err instanceof Error ? err.message : String(err), 300) })
      return
    }
    job.state = "done"
    job.finishedAt = this.now()
    job.outcome = { reason: "pushed", summary: `Edited ${edit.path}.`, commitSha, changedPaths: [edit.path] }
    try {
      await this.assessAttempt(tx, attempt)
    } catch (err) {
      // The push landed; reconcile will assess it later.
      this.log.warn("assess after demo push failed", { attempt: attempt.id, error: String(err) })
    }
  }

  /**
   * Fetch, digest and trial-merge an attempt. `waiting` becomes `ready` on the first head beyond
   * the brief commit. Idempotent for a head that already has a digest against the current main.
   */
  private async assessAttempt(tx: Tx, attempt: Attempt, opts: { force?: boolean } = {}): Promise<void> {
    const brief = this.briefOf(tx.state, attempt)
    const result = await this.git().assess({
      mainRepo: tx.state.project.repo,
      forkRepo: attempt.repo,
      baseSha: attempt.baseSha,
      brief: briefFile(brief),
      checks: parseChecks(brief.acceptance),
    })
    const now = this.now()
    const mainMoved = result.mainSha !== tx.state.project.mainSha
    if (mainMoved) {
      tx.state.project.mainSha = result.mainSha
      this.activity(tx.state, { kind: "project", text: `Main moved to ${shortSha(result.mainSha)} outside shipboard.` })
    }
    if (result.headSha === attempt.briefSha && !attempt.digest) {
      // Nothing beyond the brief yet.
      if (mainMoved) await this.retrialOthers(tx, attempt.id)
      return
    }
    const newHead = result.headSha !== attempt.headSha || attempt.digest?.headSha !== result.headSha
    const wasConflict = attempt.merge?.state === "conflict"
    if (attempt.status === "waiting") attempt.status = "ready"
    if (newHead) {
      this.activity(tx.state, {
        kind: "pushed",
        text: `${agentLabel(this.options.agents, attempt.agent)} pushed ${shortSha(result.headSha)} for "${oneLine(brief.task, 80)}".`,
        briefId: brief.id,
        attemptId: attempt.id,
        agent: attempt.agent,
      })
    }
    attempt.headSha = result.headSha
    attempt.digest = buildDigest({
      brief,
      files: result.files,
      checks: result.checks,
      baseSha: attempt.baseSha,
      headSha: result.headSha,
      briefIntact: result.briefIntact,
    })
    attempt.merge = { ...result.merge, checkedAt: now }
    attempt.updatedAt = now
    if (newHead && this.ports.reviewer) attempt.review = await this.review(brief, attempt)
    if (attempt.merge.state === "conflict") {
      if (newHead || !wasConflict || opts.force) this.conflictActivity(tx.state, attempt, brief)
    } else if (newHead || opts.force) {
      this.activity(tx.state, {
        kind: "assessed",
        text: `Assessed "${oneLine(brief.task, 80)}": ${attempt.digest.summary}`,
        briefId: brief.id,
        attemptId: attempt.id,
        agent: attempt.agent,
      })
    }
    if (mainMoved) await this.retrialOthers(tx, attempt.id)
  }

  private async review(brief: Brief, attempt: Attempt): Promise<Attempt["review"]> {
    const reviewer = this.ports.reviewer
    if (!reviewer || !attempt.digest) return attempt.review
    try {
      const { diff } = await this.git().diff({
        repo: attempt.repo,
        baseSha: attempt.baseSha,
        headSha: attempt.headSha,
        exclude: [briefPath(brief.id)],
      })
      return (await reviewer.review({ brief, files: attempt.digest.files, diff, headSha: attempt.headSha })) ?? null
    } catch (err) {
      this.log.warn("review failed", { attempt: attempt.id, error: String(err) })
      return null
    }
  }

  private conflictActivity(state: ProjectState, attempt: Attempt, brief: Brief): void {
    const paths = attempt.merge?.paths ?? []
    this.activity(state, {
      kind: "conflict",
      text: `"${oneLine(brief.task, 80)}" conflicts with main${paths.length ? ` in ${listPhrase(paths)}` : ""}. Re-run it on current main.`,
      briefId: brief.id,
      attemptId: attempt.id,
      agent: attempt.agent,
    })
  }

  /** Re-runs trial merges for every other ready attempt after main moved. One bad fork cannot fail the rest. */
  private async retrialOthers(tx: Tx, exceptId: string | null): Promise<void> {
    for (const other of tx.state.attempts) {
      if (other.id === exceptId || other.status !== "ready") continue
      try {
        const merge = await this.git().trialMerge(tx.state.project.repo, other.repo)
        if (merge.headSha !== other.headSha) {
          await this.assessAttempt(tx, other)
          continue
        }
        const wasConflict = other.merge?.state === "conflict"
        if (merge.mainSha !== tx.state.project.mainSha) tx.state.project.mainSha = merge.mainSha
        other.merge = { ...merge, checkedAt: this.now() }
        if (merge.state === "conflict" && !wasConflict) {
          other.updatedAt = this.now()
          this.conflictActivity(tx.state, other, this.briefOf(tx.state, other))
        } else if (merge.state === "clean" && wasConflict) {
          other.updatedAt = this.now()
        }
      } catch (err) {
        this.log.warn("trial merge failed", { attempt: other.id, error: String(err) })
      }
    }
  }

  /** Main moved without shipboard shipping (a direct push). Fetch the real head and re-check. */
  private async mainMoved(tx: Tx): Promise<void> {
    const head = await this.git().head(tx.state.project.repo)
    if (!head || head === tx.state.project.mainSha) return
    tx.state.project.mainSha = head
    this.activity(tx.state, { kind: "project", text: `Main moved to ${shortSha(head)} outside shipboard.` })
    await this.retrialOthers(tx, null)
  }

  private async reconcile(tx: Tx): Promise<void> {
    tx.state.reconciledAt = this.clock.now().getTime()
    try {
      const main = await this.ports.artifacts.head(tx.state.project.repo)
      if (main && main !== tx.state.project.mainSha) await this.mainMoved(tx)
    } catch (err) {
      this.log.warn("reconcile main failed", { project: this.projectId, error: String(err) })
    }
    for (const attempt of tx.state.attempts) {
      if (attempt.status !== "waiting" && attempt.status !== "ready") continue
      try {
        const head = await this.ports.artifacts.head(attempt.repo)
        if (!head || this.alreadySeen(attempt, head)) continue
        await this.assessAttempt(tx, attempt)
      } catch (err) {
        this.log.warn("reconcile attempt failed", { attempt: attempt.id, error: String(err) })
      }
    }
  }

  /** One sentence naming the conflicting paths and the shipped task that moved main. */
  private discardReason(state: ProjectState, old: Attempt): string {
    if (old.status === "ready" && old.merge?.state === "conflict") {
      const paths = old.merge.paths
      const where = paths.length ? ` in ${listPhrase(paths)}` : ""
      const touched = new Set(paths)
      const shippedSince = state.attempts
        .filter((item) => item.status === "shipped" && item.briefId !== old.briefId && item.updatedAt >= old.createdAt)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      const mover =
        shippedSince.find((item) => item.digest?.files.some((file) => touched.has(file.path))) ?? shippedSince[0]
      if (mover) {
        const task = state.briefs.find((brief) => brief.id === mover.briefId)?.task ?? mover.id
        return `Conflicted with main${where} after "${oneLine(task, 80)}" shipped.`
      }
      return `Conflicted with main${where}.`
    }
    if (old.status === "failed") {
      const summary = state.jobs.find((job) => job.attemptId === old.id)?.outcome?.summary
      return summary ? sentence(`The agent run failed: ${oneLine(summary, 160)}`) : "The agent run failed."
    }
    if (old.status === "parked") return "Parked, then re-run on current main."
    return "Re-run on current main by request."
  }
}
