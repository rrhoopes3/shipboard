/**
 * The ProjectDO speaks ProjectHandle over Workers RPC. An error thrown across RPC keeps only its
 * message (a PortError arrives as a plain Error, without its HTTP status), so every DO method
 * returns an envelope instead, and ProjectClient turns it back into a value or a PortError.
 */

import { PortError } from "../core/ports.ts"
import type { Logger, ProjectHandle } from "../core/ports.ts"

export type RpcError = { message: string; status: number; code: string }

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: RpcError }

/** What the ProjectDO exposes: every ProjectHandle method, answering with an envelope. */
export type ProjectRpc = {
  [K in keyof ProjectHandle]: (
    ...args: Parameters<ProjectHandle[K]>
  ) => Promise<Envelope<Awaited<ReturnType<ProjectHandle[K]>>>>
}

const BROKEN = "Something broke inside this project. Check the Worker logs."

/** Runs `fn` and wraps its result. Expected failures keep their status; anything else is logged and becomes a 500. */
export async function envelope<T>(log: Logger, method: string, fn: () => Promise<T>): Promise<Envelope<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    if (err instanceof PortError) return { ok: false, error: { message: err.message, status: err.status, code: err.code } }
    log.error("project call failed", { method, error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
    return { ok: false, error: { message: BROKEN, status: 500, code: "internal" } }
  }
}

export function unwrap<T>(result: Envelope<T>): T {
  if (result.ok) return result.value
  const { message, status, code } = result.error
  throw new PortError(message, status, code)
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return typeof value === "object" && value !== null && "ok" in value && typeof (value as { ok: unknown }).ok === "boolean"
}

/** Errors thrown by the stub itself (the object was reset, overloaded, or unreachable) rather than by shipboard. */
function infrastructure(err: unknown): PortError | null {
  if (!err || typeof err !== "object") return null
  const flags = err as { retryable?: unknown; overloaded?: unknown }
  if (flags.overloaded === true || flags.retryable === true) {
    return new PortError("This project is busy. Try again in a moment.", 503, "busy")
  }
  return null
}

export async function call<T>(invoke: () => Promise<Envelope<T>>): Promise<T> {
  let result: Envelope<T>
  try {
    result = await invoke()
  } catch (err) {
    throw infrastructure(err) ?? err
  }
  if (!isEnvelope(result)) throw new PortError(BROKEN, 500, "internal")
  return unwrap(result)
}

/** A ProjectHandle backed by a ProjectDO stub. Hosts hand this to the shared API. */
export class ProjectClient implements ProjectHandle {
  constructor(private readonly stub: ProjectRpc) {}

  init(...args: Parameters<ProjectHandle["init"]>) {
    return call(() => this.stub.init(...args))
  }
  summary() {
    return call(() => this.stub.summary())
  }
  board(...args: Parameters<ProjectHandle["board"]>) {
    return call(() => this.stub.board(...args))
  }
  version() {
    return call(() => this.stub.version())
  }
  dispatch(...args: Parameters<ProjectHandle["dispatch"]>) {
    return call(() => this.stub.dispatch(...args))
  }
  pushed(...args: Parameters<ProjectHandle["pushed"]>) {
    return call(() => this.stub.pushed(...args))
  }
  onPushEvent(...args: Parameters<ProjectHandle["onPushEvent"]>) {
    return call(() => this.stub.onPushEvent(...args))
  }
  ship(...args: Parameters<ProjectHandle["ship"]>) {
    return call(() => this.stub.ship(...args))
  }
  park(...args: Parameters<ProjectHandle["park"]>) {
    return call(() => this.stub.park(...args))
  }
  unpark(...args: Parameters<ProjectHandle["unpark"]>) {
    return call(() => this.stub.unpark(...args))
  }
  rerun(...args: Parameters<ProjectHandle["rerun"]>) {
    return call(() => this.stub.rerun(...args))
  }
  diff(...args: Parameters<ProjectHandle["diff"]>) {
    return call(() => this.stub.diff(...args))
  }
  preview(...args: Parameters<ProjectHandle["preview"]>) {
    return call(() => this.stub.preview(...args))
  }
  claim(...args: Parameters<ProjectHandle["claim"]>) {
    return call(() => this.stub.claim(...args))
  }
  nextJobAt(...args: Parameters<ProjectHandle["nextJobAt"]>) {
    return call(() => this.stub.nextJobAt(...args))
  }
  heartbeat(...args: Parameters<ProjectHandle["heartbeat"]>) {
    return call(() => this.stub.heartbeat(...args))
  }
  jobCredentials(...args: Parameters<ProjectHandle["jobCredentials"]>) {
    return call(() => this.stub.jobCredentials(...args))
  }
  finish(...args: Parameters<ProjectHandle["finish"]>) {
    return call(() => this.stub.finish(...args))
  }
  runDemoJobs() {
    return call(() => this.stub.runDemoJobs())
  }
  tick() {
    return call(() => this.stub.tick())
  }
}
