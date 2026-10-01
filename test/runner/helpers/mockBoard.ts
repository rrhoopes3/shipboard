/**
 * A board that implements the runner-facing routes (and the few the CLI reads) exactly as
 * docs/ARCHITECTURE.md specifies: JSON bodies with `Content-Type: application/json` (415 otherwise),
 * Bearer auth (runner routes take the runner or the board token), `{ error }` bodies on failure,
 * 204 from claim when nothing is queued, leases held per runnerId.
 */

import http from "node:http"
import type { AddressInfo } from "node:net"
import type { BoardView, ClaimedJob, DispatchInput, GitCredentials, JobOutcome, ProjectSummary } from "../../../src/core/types.ts"
import type { GitServer } from "./gitServer.ts"

type Json = Record<string, unknown>

export type QueuedJob = { job: ClaimedJob; repo: string; holder?: string; state: "queued" | "running" | "done" }

export type MockBoard = {
  url: string
  runnerToken: string
  boardToken: string
  queue(job: ClaimedJob, repo: string): void
  jobs: QueuedJob[]
  claims: { runnerId: string; agents: string[] }[]
  heartbeats: { attemptId: string; runnerId: string }[]
  credentialCalls: { attemptId: string; scope: "read" | "write"; token: string }[]
  finishes: { attemptId: string; runnerId: string; outcome: JobOutcome }[]
  pushedCalls: { attemptId: string; sha?: string }[]
  dispatches: { projectId: string; body: Json }[]
  /** Raw request log: method, path, authorization header. */
  requests: { method: string; path: string; authorization?: string }[]
  hooks: {
    beforeCredentials?: (attemptId: string, scope: "read" | "write") => Promise<void> | void
    /** Hand out a token the git server never minted (to test auth failures). */
    forgeToken?: boolean
  }
  projects: ProjectSummary[]
  boards: Map<string, BoardView>
  dispatchCredentials?: (projectId: string, body: Json) => GitCredentials | undefined
  waitForFinish(attemptId: string, timeoutMs?: number): Promise<JobOutcome>
  close(): Promise<void>
}

export async function startMockBoard(git?: GitServer): Promise<MockBoard> {
  const runnerToken = "runner-secret-0123456789"
  const boardToken = "board-secret-9876543210"
  const finishWaiters = new Map<string, ((o: JobOutcome) => void)[]>()

  const board: MockBoard = {
    url: "",
    runnerToken,
    boardToken,
    jobs: [],
    claims: [],
    heartbeats: [],
    credentialCalls: [],
    finishes: [],
    pushedCalls: [],
    dispatches: [],
    requests: [],
    hooks: {},
    projects: [],
    boards: new Map(),
    queue(job, repo) {
      board.jobs.push({ job, repo, state: "queued" })
    },
    waitForFinish(attemptId, timeoutMs = 20_000) {
      const done = board.finishes.find((f) => f.attemptId === attemptId)
      if (done) return Promise.resolve(done.outcome)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no finish for ${attemptId}`)), timeoutMs)
        const list = finishWaiters.get(attemptId) ?? []
        list.push((o) => {
          clearTimeout(timer)
          resolve(o)
        })
        finishWaiters.set(attemptId, list)
      })
    },
    close: () => Promise.resolve(),
  }

  const send = (res: http.ServerResponse, status: number, body?: unknown): void => {
    if (body === undefined) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
  }
  const fail = (res: http.ServerResponse, status: number, error: string): void => send(res, status, { error })

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost")
      const method = req.method ?? "GET"
      board.requests.push({ method, path: url.pathname, authorization: req.headers.authorization })
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined
      const isBoard = bearer === boardToken
      const isRunner = isBoard || bearer === runnerToken

      let body: Json = {}
      if (method === "POST") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          fail(res, 415, "Send JSON with Content-Type: application/json.")
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
          body = typeof parsed === "object" && parsed !== null ? (parsed as Json) : {}
        } catch {
          fail(res, 400, "The body is not valid JSON.")
          return
        }
      }

      const runnerRoute = /^\/api\/runner\/jobs\/([^/]+)\/(heartbeat|credentials|finish)$/.exec(url.pathname)
      const attemptRoute = /^\/api\/attempts\/([^/]+)\/pushed$/.exec(url.pathname)
      const projectRoute = /^\/api\/projects\/([^/]+)$/.exec(url.pathname)
      const tasksRoute = /^\/api\/projects\/([^/]+)\/tasks$/.exec(url.pathname)

      if (method === "GET" && url.pathname === "/api/config") {
        send(res, 200, { mode: "local", publicRead: true, boardAuth: true, agents: [{ id: "grok", label: "Grok", kind: "cli" }, { id: "manual", label: "Manual", kind: "manual" }] })
        return
      }
      if (method === "GET" && url.pathname === "/api/projects") {
        send(res, 200, { projects: board.projects })
        return
      }
      if (method === "GET" && projectRoute) {
        const view = board.boards.get(decodeURIComponent(projectRoute[1] ?? ""))
        if (!view) fail(res, 404, "No such project.")
        else send(res, 200, view)
        return
      }
      if (method === "POST" && tasksRoute) {
        if (!isBoard) return fail(res, 401, "This needs the board token.")
        const projectId = decodeURIComponent(tasksRoute[1] ?? "")
        board.dispatches.push({ projectId, body })
        const input = body as unknown as DispatchInput & { credentials?: boolean }
        const attemptId = `${projectId}--${String(input.task).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 16).replace(/-+$/, "")}-ab12`
        const credentials = input.credentials ? board.dispatchCredentials?.(projectId, body) : undefined
        send(res, 201, { board: board.boards.get(projectId) ?? {}, attemptId, ...(credentials ? { credentials } : {}), notice: "Dispatched." })
        return
      }
      if (method === "POST" && url.pathname === "/api/runner/claim") {
        if (!isRunner) return fail(res, 401, "This needs the runner token.")
        const runnerId = String(body.runnerId ?? "")
        const agents = Array.isArray(body.agents) ? body.agents.map(String) : []
        board.claims.push({ runnerId, agents })
        const next = board.jobs.find((j) => j.state === "queued" && agents.includes(j.job.agent))
        if (!next) return send(res, 204)
        next.state = "running"
        next.holder = runnerId
        send(res, 200, next.job)
        return
      }
      if (method === "POST" && runnerRoute) {
        if (!isRunner) return fail(res, 401, "This needs the runner token.")
        const attemptId = decodeURIComponent(runnerRoute[1] ?? "")
        const action = runnerRoute[2]
        const entry = board.jobs.find((j) => j.job.attemptId === attemptId)
        if (!entry) return fail(res, 404, "No such job.")
        if (entry.holder !== body.runnerId || entry.state !== "running") return fail(res, 409, "This runner does not hold the lease.")
        if (action === "heartbeat") {
          board.heartbeats.push({ attemptId, runnerId: String(body.runnerId) })
          send(res, 200, { leaseExpiresAt: new Date(Date.now() + 180_000).toISOString() })
          return
        }
        if (action === "credentials") {
          const scope = body.scope === "write" ? "write" : "read"
          await board.hooks.beforeCredentials?.(attemptId, scope)
          if (!git) return fail(res, 500, "No git server.")
          const minted = git.mint(entry.repo, scope, scope === "read" ? 900 : 600)
          if (board.hooks.forgeToken) minted.token = `art_v1_${"0".repeat(40)}?expires=${Math.floor(Date.now() / 1000) + 600}`
          board.credentialCalls.push({ attemptId, scope, token: minted.token })
          const creds: GitCredentials = { remote: git.remote(entry.repo), token: minted.token, expiresAt: minted.expiresAt, scope }
          send(res, 200, creds)
          return
        }
        const outcome = body.outcome as JobOutcome
        entry.state = "done"
        board.finishes.push({ attemptId, runnerId: String(body.runnerId), outcome })
        for (const waiter of finishWaiters.get(attemptId) ?? []) waiter(outcome)
        finishWaiters.delete(attemptId)
        send(res, 200, { ok: true })
        return
      }
      if (method === "POST" && attemptRoute) {
        if (!isRunner) return fail(res, 401, "This needs the board or runner token.")
        board.pushedCalls.push({ attemptId: decodeURIComponent(attemptRoute[1] ?? ""), sha: typeof body.sha === "string" ? body.sha : undefined })
        send(res, 200, { board: {} })
        return
      }
      fail(res, 404, "Not found.")
    })().catch((error: unknown) => fail(res, 500, (error as Error).message))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  board.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  board.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return board
}
