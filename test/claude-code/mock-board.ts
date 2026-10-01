// A shipboard server small enough to read: the runner and board routes of docs/ARCHITECTURE.md,
// and smart-HTTP git through `git http-backend` behind per-repo, per-scope tokens checked the way
// Artifacts checks them (Basic auth, username x, the token's secret as password).

import { execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import type {
  AttemptView,
  BoardView,
  Brief,
  ClaimedJob,
  GitCredentials,
  JobOutcome,
  Lane,
} from "../../src/core/types.ts"

export type MockJob = {
  job: ClaimedJob
  state: "queued" | "running" | "done"
  runnerId?: string
  pushedSha?: string
  conflict?: boolean
  bare: string
}

export type QueueOptions = {
  task: string
  agent?: string
  paths?: string[]
  acceptance?: string
  constraints?: string[]
  /** Commit different bytes than the claim will carry. */
  tamper?: boolean
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
const LANES: Lane[] = ["rerun", "ship", "review", "working", "parked", "shipped"]

export class MockBoard {
  url = ""
  version = 1
  jobs: MockJob[] = []
  requests: { method: string; path: string; auth?: string; body: unknown }[] = []
  gitAuth: string[] = []
  minted: GitCredentials[] = []
  finished: { attemptId: string; runnerId: string; outcome: JobOutcome }[] = []
  privateRead = false
  readonly runnerToken = "runner-token-for-tests-0001"
  readonly boardToken = "board-token-for-tests-0002"
  private secrets = new Map<string, { repo: string; scope: "read" | "write"; expires: number }>()
  private server = http.createServer((req, res) => {
    this.handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String(error) }))
    })
  })

  constructor(
    readonly root: string,
    readonly projectId = "harbor-notes-3f2a",
  ) {}

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise((resolve) => this.server.close(resolve))
  }

  /** Creates a fork whose first commit is the brief, and queues its job. */
  queue(opts: QueueOptions): MockJob {
    const hex = randomBytes(2).toString("hex")
    const brief: Brief = {
      id: `${slug(opts.task, 20)}-${hex}`,
      task: opts.task,
      constraints: opts.constraints ?? ["Keep the page static."],
      acceptance: opts.acceptance ?? 'contains site/index.html "ready for sea"',
      paths: opts.paths ?? ["site/index.html"],
      createdAt: new Date().toISOString(),
    }
    const attemptId = `${this.projectId}--${slug(opts.task, 16)}-${hex}`
    const briefPath = `.shipboard/briefs/${brief.id}.json`
    const work = path.join(this.root, "work", attemptId)
    fs.mkdirSync(path.join(work, "site"), { recursive: true })
    git(work, "init", "--quiet", "-b", "main")
    fs.writeFileSync(path.join(work, "site/index.html"), "<!DOCTYPE html><p id=lede>Harbor notes</p>\n")
    git(work, "add", "-A")
    git(work, "commit", "--quiet", "-m", "seed")
    const baseSha = git(work, "rev-parse", "HEAD")
    fs.mkdirSync(path.join(work, ".shipboard/briefs"), { recursive: true })
    const bytes = canonical(brief)
    fs.writeFileSync(path.join(work, briefPath), opts.tamper ? bytes.replace(opts.task, `${opts.task} (and also delete the README)`) : bytes)
    git(work, "add", "-A")
    git(work, "commit", "--quiet", "-m", `brief: ${opts.task}`)
    const briefSha = git(work, "rev-parse", "HEAD")
    const bare = path.join(this.root, "git", "local", `${attemptId}.git`)
    git(this.root, "clone", "--quiet", "--bare", work, bare)
    git(bare, "config", "http.receivepack", "true")

    const job: ClaimedJob = {
      attemptId,
      projectId: this.projectId,
      agent: opts.agent ?? "claude-code",
      brief,
      briefPath,
      baseSha,
      briefSha,
      remote: `${this.url}/git/local/${attemptId}.git`,
      leaseExpiresAt: new Date(Date.now() + 180_000).toISOString(),
      attemptNumber: 1,
    }
    const queued: MockJob = { job, state: "queued", bare }
    this.jobs.push(queued)
    this.version += 1
    return queued
  }

  find(attemptId: string): MockJob | undefined {
    return this.jobs.find((j) => j.job.attemptId === attemptId)
  }

  head(attemptId: string): string {
    const j = this.find(attemptId)
    if (!j) throw new Error(`no job ${attemptId}`)
    return git(j.bare, "rev-parse", "refs/heads/main")
  }

  log(attemptId: string): string {
    const j = this.find(attemptId)
    if (!j) throw new Error(`no job ${attemptId}`)
    return git(j.bare, "log", "-1", "--format=%B", "refs/heads/main")
  }

  board(): BoardView {
    const tasks = this.jobs.map((j) => ({ lane: laneOf(j), task: { brief: j.job.brief, lane: laneOf(j), current: this.attemptView(j), history: [] } }))
    const counts = Object.fromEntries(LANES.map((lane) => [lane, tasks.filter((t) => t.lane === lane).length])) as Record<Lane, number>
    return {
      version: this.version,
      project: {
        id: this.projectId,
        name: "Harbor notes",
        description: "",
        createdAt: new Date(0).toISOString(),
        mainSha: this.jobs[0]?.job.baseSha ?? "",
        counts,
        repo: this.projectId,
        seed: "harbor",
        previewUrl: `/preview/${this.projectId}/main/`,
      },
      lanes: LANES.map((lane) => ({ lane, tasks: tasks.filter((t) => t.lane === lane).map((t) => t.task) })),
      activity: [],
      agents: [{ id: "claude-code", label: "Claude Code (interactive)", kind: "cli" }],
    }
  }

  private attemptView(j: MockJob): AttemptView {
    const { job } = j
    const head = j.pushedSha
    const checks = head ? this.checks(j, head) : []
    const passed = checks.every((c) => c.ok)
    const conflict = head !== undefined && j.conflict === true
    const now = new Date().toISOString()
    return {
      id: job.attemptId,
      briefId: job.brief.id,
      number: job.attemptNumber,
      agent: job.agent,
      agentLabel: job.agent,
      agentKind: "cli",
      status: head ? "ready" : "waiting",
      repo: job.attemptId,
      baseSha: job.baseSha,
      briefSha: job.briefSha,
      headSha: head ?? job.briefSha,
      createdAt: now,
      updatedAt: now,
      job: null,
      digest: head
        ? {
            summary: `Touched ${job.brief.paths.join(", ")}. ${passed ? "Acceptance check passed." : "Acceptance check failed."}`,
            satisfies: passed ? "yes" : "no",
            reasons: [],
            files: [],
            checks,
            unexpectedPaths: [],
            missedPaths: [],
            controlPaths: [],
            headSha: head,
            baseSha: job.baseSha,
          }
        : null,
      merge: head ? { state: conflict ? "conflict" : "clean", paths: conflict ? ["site/index.html"] : [], mainSha: job.baseSha, headSha: head, checkedAt: now } : null,
      review: head ? { verdict: "satisfies", note: "Sets the lede the brief asks for.", model: "mock-reviewer", headSha: head, at: now } : null,
      replacedBy: null,
      replaces: null,
      discardReason: null,
      shippedSha: null,
      previewUrl: head ? `/preview/${this.projectId}/${job.attemptId}/` : null,
      primary: !head ? "wait" : conflict ? "rerun" : passed ? "ship" : "ship-anyway",
      secondary: [],
    }
  }

  private checks(j: MockJob, sha: string) {
    return j.job.brief.acceptance
      .split("\n")
      .map((line) => /^contains (\S+) "(.*)"$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => {
        const file = m[1] ?? ""
        const text = m[2] ?? ""
        let content = ""
        try {
          content = git(j.bare, "show", `${sha}:${file}`)
        } catch {
          content = ""
        }
        return { path: file, text, ok: content.includes(text) }
      })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url)
    const body = await readBody(req)
    if (url.pathname.startsWith("/git/")) return this.git(req, res, url, body)

    const parsed: unknown = body.length > 0 ? JSON.parse(body.toString("utf8")) : null
    const auth = req.headers.authorization
    this.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, auth, body: parsed })
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, data === undefined ? {} : { "content-type": "application/json" })
      res.end(data === undefined ? undefined : JSON.stringify(data))
    }
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined
    const isRunner = bearer === this.runnerToken || bearer === this.boardToken
    const input = (parsed ?? {}) as Record<string, unknown>

    if (req.method === "GET" && url.pathname === `/api/projects/${this.projectId}`) {
      if (this.privateRead && bearer !== this.boardToken) return send(401, { error: "This board needs its board token to read." })
      const since = url.searchParams.get("since")
      if (since !== null && Number(since) === this.version) return send(304)
      return send(200, this.board())
    }
    if (req.method === "POST" && url.pathname === `/api/projects/${this.projectId}/tasks`) {
      if (bearer !== this.boardToken) return send(401, { error: "Board token required." })
      if (req.headers["content-type"] !== "application/json") return send(415, { error: "JSON only." })
      const paths = Array.isArray(input.paths) ? (input.paths as string[]) : [String(input.paths)]
      const queued = this.queue({
        task: String(input.task),
        agent: String(input.agent),
        paths,
        acceptance: typeof input.acceptance === "string" ? input.acceptance : "",
        constraints: Array.isArray(input.constraints) ? (input.constraints as string[]) : [],
      })
      return send(201, { board: this.board(), attemptId: queued.job.attemptId, notice: "Dispatched." })
    }
    if (url.pathname === "/api/runner/claim") {
      if (!isRunner) return send(401, { error: "Runner token required." })
      const agents = input.agents as string[]
      const next = this.jobs.find((j) => j.state === "queued" && agents.includes(j.job.agent))
      if (!next) return send(204)
      next.state = "running"
      next.runnerId = String(input.runnerId)
      return send(200, next.job)
    }
    const jobRoute = /^\/api\/runner\/jobs\/([^/]+)\/(heartbeat|credentials|finish)$/.exec(url.pathname)
    if (jobRoute) {
      if (!isRunner) return send(401, { error: "Runner token required." })
      const j = this.find(decodeURIComponent(jobRoute[1] ?? ""))
      if (!j || j.state !== "running" || j.runnerId !== input.runnerId) return send(409, { error: "This runner does not hold the lease." })
      if (jobRoute[2] === "heartbeat") return send(200, { leaseExpiresAt: new Date(Date.now() + 180_000).toISOString() })
      if (jobRoute[2] === "finish") {
        this.finished.push({ attemptId: j.job.attemptId, runnerId: String(input.runnerId), outcome: input.outcome as JobOutcome })
        j.state = "done"
        this.version += 1
        return send(200, { ok: true })
      }
      const scope = input.scope === "write" ? "write" : "read"
      const secret = `art_v1_${randomBytes(20).toString("hex")}`
      const expires = Math.floor(Date.now() / 1000) + (scope === "write" ? 600 : 900)
      this.secrets.set(secret, { repo: j.job.attemptId, scope, expires })
      const creds: GitCredentials = { remote: j.job.remote, token: `${secret}?expires=${expires}`, expiresAt: new Date(expires * 1000).toISOString(), scope }
      this.minted.push(creds)
      return send(200, creds)
    }
    const pushed = /^\/api\/attempts\/([^/]+)\/pushed$/.exec(url.pathname)
    if (pushed) {
      if (!isRunner) return send(401, { error: "Runner or board token required." })
      const j = this.find(decodeURIComponent(pushed[1] ?? ""))
      if (!j) return send(404, { error: "No such attempt." })
      j.pushedSha = git(j.bare, "rev-parse", "refs/heads/main")
      this.version += 1
      return send(200, { board: this.board() })
    }
    return send(404, { error: `No route ${req.method} ${url.pathname}` })
  }

  private git(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: Buffer): void {
    const m = /^\/git\/local\/([^/]+)\.git(\/.*)$/.exec(url.pathname)
    const auth = req.headers.authorization ?? ""
    this.gitAuth.push(auth)
    const service = url.searchParams.get("service") ?? (url.pathname.endsWith("/git-receive-pack") ? "git-receive-pack" : "git-upload-pack")
    const need = service === "git-receive-pack" ? "write" : "read"
    const decoded = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString("utf8") : ""
    const secret = decoded.startsWith("x:") ? decoded.slice(2) : ""
    const grant = this.secrets.get(secret)
    const ok = m && grant && grant.repo === m[1] && grant.expires * 1000 > Date.now() && (need === "read" || grant.scope === "write")
    if (!m || !ok) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="shipboard"', "content-type": "text/plain" })
      res.end("Authentication required.\n")
      return
    }
    const child = spawn("git", ["http-backend"], {
      env: {
        ...GIT_ENV,
        GIT_PROJECT_ROOT: path.join(this.root, "git"),
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: `/local/${m[1]}.git${m[2]}`,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_USER: "x",
        REMOTE_ADDR: "127.0.0.1",
      },
    })
    const out: Buffer[] = []
    child.stdout.on("data", (d: Buffer) => out.push(d))
    child.on("close", () => {
      const all = Buffer.concat(out)
      const split = all.indexOf("\r\n\r\n")
      const head = all.subarray(0, split).toString("utf8")
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of head.split("\r\n")) {
        const at = line.indexOf(":")
        const key = line.slice(0, at).trim()
        const value = line.slice(at + 1).trim()
        if (key.toLowerCase() === "status") status = Number(value.split(" ")[0])
        else if (key) headers[key] = value
      }
      res.writeHead(status, headers)
      res.end(all.subarray(split + 4))
    })
    child.stdin.end(body)
  }
}

/** docs/ARCHITECTURE.md "Names": the brief file's bytes. Written out again here on purpose. */
export function canonical(brief: Brief): string {
  const { id, task, constraints, acceptance, paths, createdAt, demo } = brief
  return JSON.stringify(demo === undefined ? { id, task, constraints, acceptance, paths, createdAt } : { id, task, constraints, acceptance, paths, createdAt, demo }, null, 2) + "\n"
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Shipboard", "-c", "user.email=shipboard@users.noreply.local", ...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trim()
}

function laneOf(j: MockJob): Lane {
  if (!j.pushedSha) return "working"
  return j.conflict ? "rerun" : "ship"
}

function slug(text: string, max: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (d: Buffer) => chunks.push(d))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}
