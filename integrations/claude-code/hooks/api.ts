// The shipboard HTTP API, as docs/ARCHITECTURE.md "HTTP API" defines it, over whatever fetch the
// caller hands in (the mods API's http.fetch in Claude Code, node's fetch in tests). Tokens go in the
// Authorization header only and never appear in an error message.

import type { BoardView, ClaimedJob, DispatchInput, GitCredentials, JobOutcome } from "./contract"

export type FetchInit = { method?: string; headers?: Record<string, string>; body?: string }
export type FetchResult = { status: number; ok: boolean; text: string }
export type Fetch = (url: string, init?: FetchInit) => Promise<FetchResult>

export class BoardError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "BoardError"
  }
}

export type BoardClient = ReturnType<typeof boardClient>

export function boardClient(fetch: Fetch, opts: { url: string; runnerToken?: string; boardToken?: string }) {
  const base = opts.url.replace(/\/+$/, "")
  const runner = opts.runnerToken ?? opts.boardToken
  const board = opts.boardToken
  const id = encodeURIComponent

  async function call(method: string, path: string, token: string | undefined, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers["content-type"] = "application/json"
    let res: FetchResult
    try {
      res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (error) {
      throw new BoardError(`Could not reach the board at ${base}: ${messageOf(error)}`, 0)
    }
    let data: unknown = null
    if (res.text) {
      try {
        data = JSON.parse(res.text) as unknown
      } catch {
        data = null
      }
    }
    if (!res.ok && res.status !== 304) {
      const said = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : res.text.slice(0, 200)
      throw new BoardError(`The board answered ${res.status} to ${method} ${path}${said ? `: ${said}` : ""}`, res.status)
    }
    return { status: res.status, data }
  }

  return {
    url: base,

    async claim(runnerId: string, agents: string[], attemptId?: string): Promise<ClaimedJob | null> {
      // `attemptId` asks for one specific job; servers that predate it ignore the field and hand
      // out the oldest queued job, which the caller checks for.
      const body = attemptId ? { runnerId, agents, attemptId } : { runnerId, agents }
      const { status, data } = await call("POST", "/api/runner/claim", runner, body)
      return status === 204 || data === null ? null : (data as ClaimedJob)
    },

    async heartbeat(attemptId: string, runnerId: string): Promise<{ leaseExpiresAt: string }> {
      const { data } = await call("POST", `/api/runner/jobs/${id(attemptId)}/heartbeat`, runner, { runnerId })
      return data as { leaseExpiresAt: string }
    },

    async credentials(attemptId: string, runnerId: string, scope: "read" | "write"): Promise<GitCredentials> {
      const { data } = await call("POST", `/api/runner/jobs/${id(attemptId)}/credentials`, runner, { runnerId, scope })
      const creds = data as GitCredentials | null
      if (!creds || typeof creds.token !== "string" || typeof creds.remote !== "string") {
        throw new BoardError("The board sent credentials without a token or remote.", 502)
      }
      return creds
    },

    async pushed(attemptId: string, sha: string): Promise<BoardView | null> {
      const { data } = await call("POST", `/api/attempts/${id(attemptId)}/pushed`, runner, { sha })
      return (data as { board?: BoardView } | null)?.board ?? null
    },

    async finish(attemptId: string, runnerId: string, outcome: JobOutcome): Promise<void> {
      await call("POST", `/api/runner/jobs/${id(attemptId)}/finish`, runner, { runnerId, outcome })
    },

    /** The project's board, or null when it has not changed since `since` (304). */
    async board(projectId: string, since?: number): Promise<BoardView | null> {
      const query = since === undefined ? "" : `?since=${since}`
      const { status, data } = await call("GET", `/api/projects/${id(projectId)}${query}`, board)
      return status === 304 ? null : (data as BoardView)
    },

    async dispatch(projectId: string, input: DispatchInput): Promise<{ attemptId: string; notice?: string }> {
      const { data } = await call("POST", `/api/projects/${id(projectId)}/tasks`, board, input)
      const out = data as { attemptId?: string; notice?: string } | null
      if (!out?.attemptId) throw new BoardError("The board accepted the task but sent no attempt id.", 502)
      return { attemptId: out.attemptId, notice: out.notice }
    },
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
