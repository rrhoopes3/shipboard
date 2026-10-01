/**
 * ProjectDO: one Durable Object per project id, holding the core ProjectService. The service's
 * mutex serialises operations, because DO input gates do not cover the awaited git fetches. The
 * whole ProjectState is one storage value. An alarm ticks the project (lease expiry, reconcile)
 * while a job is queued or running or an attempt is waiting for a push.
 */

import { DurableObject } from "cloudflare:workers"
import { defaultAgents } from "../core/agents.ts"
import { isProjectId } from "../core/names.ts"
import { PortError } from "../core/ports.ts"
import type { ProjectHandle } from "../core/ports.ts"
import { ProjectService } from "../core/service.ts"
import type { ProjectState } from "../core/types.ts"
import { CloudflareArtifacts } from "./artifacts.ts"
import type { Env } from "./env.ts"
import { workerLog } from "./env.ts"
import { reviewerFor } from "./reviewer.ts"
import { envelope } from "./rpc.ts"
import type { Envelope, ProjectRpc } from "./rpc.ts"
import { DoStateStore } from "./state.ts"
import type { AlarmStorage, KvStorage } from "./state.ts"

/** Alarm period while a job is queued or running (leases last 3 minutes). */
export const BUSY_TICK_MS = 30_000
/** Alarm period while the only thing to watch is an attempt waiting for a push. */
export const IDLE_TICK_MS = 60_000
/** A waiting attempt untouched for this long is left to board views and push events, not the alarm. */
export const WATCH_WAITING_MS = 24 * 60 * 60_000

type Result<K extends keyof ProjectHandle> = Promise<Envelope<Awaited<ReturnType<ProjectHandle[K]>>>>
type Args<K extends keyof ProjectHandle> = Parameters<ProjectHandle[K]>

/** When the alarm should next fire for this state, or null when nothing needs watching. */
export function nextTickAt(state: ProjectState, now: number): number | null {
  const busy = state.jobs.some((job) => job.state === "queued" || job.state === "running")
  if (busy) return now + BUSY_TICK_MS
  const waiting = state.attempts.some((attempt) => {
    if (attempt.status !== "waiting") return false
    const touched = Date.parse(attempt.updatedAt)
    return !Number.isFinite(touched) || now - touched < WATCH_WAITING_MS
  })
  return waiting ? now + IDLE_TICK_MS : null
}

export class ProjectDO extends DurableObject<Env> implements ProjectRpc {
  private readonly store: DoStateStore
  private readonly artifacts: CloudflareArtifacts
  private svc: ProjectService | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new DoStateStore(ctx.storage as unknown as KvStorage, workerLog)
    this.artifacts = new CloudflareArtifacts(env.ARTIFACTS, { log: workerLog })
  }

  // ------------------------------------------------------------------ RPC (ProjectHandle, enveloped)

  init(...[input]: Args<"init">): Result<"init"> {
    return envelope(workerLog, "init", async () => {
      if (!input || typeof input !== "object" || !isProjectId(input.id)) throw new PortError("That is not a project id.", 400)
      this.checkRouting(input.id)
      if (!this.svc) this.svc = this.make(input.id)
      else if (this.svc.projectId !== input.id) throw new PortError("This Durable Object already belongs to another project.", 409, "exists")
      const summary = await this.svc.init(input)
      await this.arm()
      return summary
    })
  }

  summary(): Result<"summary"> {
    return this.rpc("summary", (svc) => svc.summary())
  }

  board(...args: Args<"board">): Result<"board"> {
    return this.rpc("board", (svc) => svc.board(...args))
  }

  version(): Result<"version"> {
    return this.rpc("version", (svc) => svc.version())
  }

  dispatch(...args: Args<"dispatch">): Result<"dispatch"> {
    return this.rpc("dispatch", (svc) => svc.dispatch(...args), true)
  }

  pushed(...args: Args<"pushed">): Result<"pushed"> {
    return this.rpc("pushed", (svc) => svc.pushed(...args), true)
  }

  onPushEvent(...args: Args<"onPushEvent">): Result<"onPushEvent"> {
    return envelope(workerLog, "onPushEvent", async () => {
      let svc: ProjectService
      try {
        svc = await this.service()
      } catch (err) {
        // A push to a repo whose project does not exist (yet, or any more) needs nothing.
        if (err instanceof PortError && err.status === 404) return
        throw err
      }
      await svc.onPushEvent(...args)
    })
  }

  ship(...args: Args<"ship">): Result<"ship"> {
    return this.rpc("ship", (svc) => svc.ship(...args))
  }

  park(...args: Args<"park">): Result<"park"> {
    return this.rpc("park", (svc) => svc.park(...args))
  }

  unpark(...args: Args<"unpark">): Result<"unpark"> {
    return this.rpc("unpark", (svc) => svc.unpark(...args), true)
  }

  rerun(...args: Args<"rerun">): Result<"rerun"> {
    return this.rpc("rerun", (svc) => svc.rerun(...args), true)
  }

  diff(...args: Args<"diff">): Result<"diff"> {
    return this.rpc("diff", (svc) => svc.diff(...args))
  }

  preview(...args: Args<"preview">): Result<"preview"> {
    return this.rpc("preview", (svc) => svc.preview(...args))
  }

  claim(...args: Args<"claim">): Result<"claim"> {
    return this.rpc("claim", (svc) => svc.claim(...args), true)
  }

  nextJobAt(...args: Args<"nextJobAt">): Result<"nextJobAt"> {
    return this.rpc("nextJobAt", (svc) => svc.nextJobAt(...args))
  }

  heartbeat(...args: Args<"heartbeat">): Result<"heartbeat"> {
    return this.rpc("heartbeat", (svc) => svc.heartbeat(...args))
  }

  jobCredentials(...args: Args<"jobCredentials">): Result<"jobCredentials"> {
    return this.rpc("jobCredentials", (svc) => svc.jobCredentials(...args))
  }

  finish(...args: Args<"finish">): Result<"finish"> {
    return this.rpc("finish", (svc) => svc.finish(...args))
  }

  runDemoJobs(): Result<"runDemoJobs"> {
    return this.rpc("runDemoJobs", (svc) => svc.runDemoJobs())
  }

  tick(): Result<"tick"> {
    return this.rpc("tick", (svc) => svc.tick(), true)
  }

  // ------------------------------------------------------------------ alarm

  async alarm(): Promise<void> {
    let svc: ProjectService
    try {
      svc = await this.service()
    } catch {
      return
    }
    try {
      await svc.tick()
    } catch (err) {
      workerLog.error("tick failed", { project: svc.projectId, error: err instanceof Error ? err.message : String(err) })
    }
    // Re-arm even after a failed tick, or a transient error would stop the project being watched.
    await this.arm(true)
  }

  // ------------------------------------------------------------------ internals

  private rpc<T>(method: keyof ProjectHandle, fn: (svc: ProjectService) => Promise<T>, rearm = false): Promise<Envelope<T>> {
    return envelope(workerLog, method, async () => {
      const value = await fn(await this.service())
      if (rearm) await this.arm()
      return value
    })
  }

  private async service(): Promise<ProjectService> {
    if (this.svc) return this.svc
    const state = await this.store.load()
    if (!state) throw new PortError("No project with that id.", 404, "not_found")
    this.checkRouting(state.project.id)
    this.svc ??= this.make(state.project.id)
    return this.svc
  }

  private make(projectId: string): ProjectService {
    return new ProjectService(
      projectId,
      { artifacts: this.artifacts, state: this.store, reviewer: reviewerFor(this.env, workerLog), log: workerLog },
      { agents: defaultAgents(), schedule: (work) => this.schedule(work) },
    )
  }

  /** Demo jobs run after the response; the alarm picks them up again if this instance is evicted first. */
  private schedule(work: () => Promise<unknown>): void {
    const run = Promise.resolve()
      .then(work)
      .catch((err: unknown) => workerLog.error("background work failed", { error: err instanceof Error ? (err.stack ?? err.message) : String(err) }))
    this.ctx.waitUntil(run)
  }

  /** Ids are routed with idFromName(projectId); a mismatch means a routing bug, never a user error. */
  private checkRouting(projectId: string): void {
    const name = this.ctx.id.name
    if (name !== undefined && name !== projectId) {
      throw new PortError("This request reached the wrong project object.", 500, "misrouted")
    }
  }

  /** Sets the alarm when something needs watching. From the alarm itself, always schedules the next one. */
  private async arm(fromAlarm = false): Promise<void> {
    try {
      const state = await this.store.load()
      if (!state) return
      const at = nextTickAt(state, Date.now())
      if (at === null) return
      const storage = this.ctx.storage as unknown as AlarmStorage
      if (!fromAlarm && (await storage.getAlarm()) !== null) return
      await storage.setAlarm(at)
    } catch (err) {
      workerLog.warn("could not set the project alarm", { error: err instanceof Error ? err.message : String(err) })
    }
  }
}
