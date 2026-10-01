/**
 * HTTP client for the board API (docs/ARCHITECTURE.md "HTTP API"). Used by the runner (runner
 * routes, runner token) and the agent CLI (board routes, board token). JSON in, JSON out; errors
 * come back as `{ error: "<sentence>" }` and surface as BoardHttpError with that sentence.
 */

import type {
  AgentInfo,
  BoardView,
  ClaimedJob,
  DispatchInput,
  GitCredentials,
  JobOutcome,
  ProjectSummary,
} from "../src/core/types.ts"

export class BoardHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "BoardHttpError"
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type DispatchResponse = {
  board: BoardView
  attemptId: string
  credentials?: GitCredentials
  notice?: string
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class BoardClient {
  readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly token?: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly timeoutMs = 30_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
  }

  private async request(method: "GET" | "POST", pathname: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    if (method === "POST") headers["content-type"] = "application/json"
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string; errors?: { code?: string }[] } }).cause
      const code = cause?.code ?? cause?.errors?.[0]?.code ?? cause?.message
      const why = (error as Error).name === "TimeoutError" ? "timed out" : (code ?? (error as Error).message)
      throw new BoardHttpError(`Could not reach the board at ${this.baseUrl} (${why}). Is it running? Set --url or SHIPBOARD_URL.`, 0)
    }
    const text = await res.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text) as unknown
      } catch {
        data = { error: text.slice(0, 300) }
      }
    }
    if (!res.ok && res.status !== 304) {
      const message = isObject(data) && typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`
      throw new BoardHttpError(message, res.status)
    }
    return { status: res.status, data }
  }

  // ------------------------------------------------------------------ runner routes

  async claim(runnerId: string, agents: string[]): Promise<ClaimedJob | null> {
    const { status, data } = await this.request("POST", "/api/runner/claim", { runnerId, agents })
    if (status === 204 || data === null) return null
    return assertClaimedJob(data)
  }

  async heartbeat(attemptId: string, runnerId: string): Promise<{ leaseExpiresAt: string }> {
    const { data } = await this.request("POST", `/api/runner/jobs/${encodeURIComponent(attemptId)}/heartbeat`, { runnerId })
    if (!isObject(data) || typeof data.leaseExpiresAt !== "string") throw new BoardHttpError("Heartbeat response had no leaseExpiresAt.", 502)
    return { leaseExpiresAt: data.leaseExpiresAt }
  }

  async credentials(attemptId: string, runnerId: string, scope: "read" | "write"): Promise<GitCredentials> {
    const { data } = await this.request("POST", `/api/runner/jobs/${encodeURIComponent(attemptId)}/credentials`, { runnerId, scope })
    if (!isObject(data) || typeof data.remote !== "string" || typeof data.token !== "string") {
      throw new BoardHttpError("Credentials response had no remote or token.", 502)
    }
    return {
      remote: data.remote,
      token: data.token,
      expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : "",
      scope: data.scope === "write" ? "write" : "read",
    }
  }

  async finish(attemptId: string, runnerId: string, outcome: JobOutcome): Promise<void> {
    await this.request("POST", `/api/runner/jobs/${encodeURIComponent(attemptId)}/finish`, { runnerId, outcome })
  }

  async pushed(attemptId: string, sha?: string): Promise<void> {
    await this.request("POST", `/api/attempts/${encodeURIComponent(attemptId)}/pushed`, sha ? { sha } : {})
  }

  // ------------------------------------------------------------------ board routes (CLI)

  async config(): Promise<{ agents: AgentInfo[] }> {
    const { data } = await this.request("GET", "/api/config")
    if (!isObject(data) || !Array.isArray(data.agents)) throw new BoardHttpError("Unexpected /api/config response.", 502)
    return { agents: data.agents as AgentInfo[] }
  }

  async projects(): Promise<ProjectSummary[]> {
    const { data } = await this.request("GET", "/api/projects")
    if (!isObject(data) || !Array.isArray(data.projects)) throw new BoardHttpError("Unexpected /api/projects response.", 502)
    return data.projects as ProjectSummary[]
  }

  async board(projectId: string): Promise<BoardView> {
    const { data } = await this.request("GET", `/api/projects/${encodeURIComponent(projectId)}`)
    if (!isObject(data) || !Array.isArray(data.lanes)) throw new BoardHttpError("Unexpected board response.", 502)
    return data as unknown as BoardView
  }

  async dispatch(projectId: string, input: DispatchInput & { credentials?: boolean }): Promise<DispatchResponse> {
    const { data } = await this.request("POST", `/api/projects/${encodeURIComponent(projectId)}/tasks`, input)
    if (!isObject(data) || typeof data.attemptId !== "string") throw new BoardHttpError("Dispatch response had no attemptId.", 502)
    return data as unknown as DispatchResponse
  }
}

function assertClaimedJob(data: unknown): ClaimedJob {
  const bad = (what: string): never => {
    throw new BoardHttpError(`Claim response is missing ${what}.`, 502)
  }
  if (!isObject(data)) return bad("a body")
  for (const key of ["attemptId", "projectId", "agent", "briefPath", "baseSha", "briefSha", "remote", "leaseExpiresAt"]) {
    if (typeof data[key] !== "string") bad(key)
  }
  if (typeof data.attemptNumber !== "number") bad("attemptNumber")
  const brief = data.brief
  if (!isObject(brief)) return bad("brief")
  if (typeof brief.id !== "string" || typeof brief.task !== "string" || typeof brief.createdAt !== "string") bad("brief fields")
  if (!Array.isArray(brief.constraints) || !Array.isArray(brief.paths) || typeof brief.acceptance !== "string") bad("brief fields")
  return data as unknown as ClaimedJob
}
