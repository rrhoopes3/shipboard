/**
 * The HTTP API both hosts serve (docs/ARCHITECTURE.md, "HTTP API"). Hono only: no node:* imports,
 * so the Cloudflare Worker mounts the same app. The local host adds `/git` and static files.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import { isAttemptId, isProjectId, projectIdOf } from "../core/names.ts"
import { PortError } from "../core/ports.ts"
import type { Host, Logger, ProjectHandle } from "../core/ports.ts"
import { HARBOR } from "../core/seeds.ts"
import type { CreateProjectInput, DispatchInput, JobOutcome } from "../core/types.ts"

export const BOARD_CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ")

export const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox",
].join("; ")

export type StaticFile = { body: Uint8Array; contentType: string }

export type ApiOptions = {
  /** Serves the board UI for GETs outside /api and /preview. Return null when the file is missing. */
  serveStatic?: (path: string) => Promise<StaticFile | null>
  /**
   * Local host only: the `Host` values the server answers to when no board token is set
   * (e.g. `127.0.0.1:8787`, `localhost:8787`). Mutations must then also carry a matching
   * `Origin` when they carry one at all. Leave unset on Cloudflare.
   */
  localHosts?: () => string[]
  /** Largest JSON body accepted, in bytes. Default 256 KiB. */
  maxBodyBytes?: number
  log?: Logger
}

type Level = "read" | "board" | "runner"

const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}$/
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/
const SHA = /^[0-9a-f]{40}$/

const encoder = new TextEncoder()

/** Constant-time string comparison: compares SHA-256 digests so length leaks nothing either. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ])
  const xa = new Uint8Array(x)
  const ya = new Uint8Array(y)
  let diff = 0
  for (let i = 0; i < xa.length; i++) diff |= (xa[i] ?? 0) ^ (ya[i] ?? 0)
  return diff === 0
}

function bearer(c: Context): string | null {
  const header = c.req.header("authorization") ?? ""
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match?.[1] ?? null
}

async function readBody(c: Context, max: number): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? ""
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new PortError("Send JSON with Content-Type: application/json.", 415, "unsupported_media_type")
  }
  const declared = Number(c.req.header("content-length") ?? "")
  if (Number.isFinite(declared) && declared > max) throw new PortError("That request is too large.", 413, "too_large")
  const stream = c.req.raw.body
  if (!stream) return {}
  // Read the stream ourselves: a chunked body has no content-length to trust.
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new PortError("That request is too large.", 413, "too_large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  if (!text.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new PortError("The request body was not valid JSON.", 400)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PortError("Send a JSON object.", 400)
  }
  return value as Record<string, unknown>
}

function optionalString(body: Record<string, unknown>, key: string, max = 200): string | undefined {
  const value = body[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max) throw new PortError(`"${key}" must be text.`, 400)
  return value
}

function runnerIdOf(body: Record<string, unknown>): string {
  const id = body.runnerId
  if (typeof id !== "string" || !RUNNER_ID.test(id)) {
    throw new PortError("Send a runnerId: letters, digits and . _ : @ - only, up to 80 characters.", 400)
  }
  return id
}

function agentsOf(body: Record<string, unknown>): string[] {
  const agents = body.agents
  if (!Array.isArray(agents) || agents.length === 0 || agents.length > 32) {
    throw new PortError("Send the agents this runner offers as a list of agent ids.", 400)
  }
  const out: string[] = []
  for (const agent of agents) {
    if (typeof agent !== "string" || !AGENT_ID.test(agent)) throw new PortError("Agent ids are lowercase letters, digits, . _ -.", 400)
    out.push(agent)
  }
  return [...new Set(out)]
}

export function createApi(host: Host, opts: ApiOptions = {}): Hono {
  const app = new Hono()
  const maxBody = opts.maxBodyBytes ?? 256 * 1024
  const log = opts.log

  app.use("*", async (c, next) => {
    await next()
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store")
  })

  // Local host without a board token: close DNS rebinding (Host) and CSRF (Origin).
  app.use("*", async (c, next) => {
    if (opts.localHosts && !host.boardToken) {
      const allowed = opts.localHosts().map((h) => h.toLowerCase())
      const hostHeader = (c.req.header("host") ?? "").toLowerCase()
      if (!allowed.includes(hostHeader)) {
        return c.json({ error: "This board only answers on 127.0.0.1 or localhost." }, 403)
      }
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        const origin = c.req.header("origin")
        if (origin !== undefined && !allowed.some((h) => origin.toLowerCase() === `http://${h}`)) {
          return c.json({ error: "Cross-site requests cannot change this board." }, 403)
        }
      }
    }
    await next()
  })

  app.onError((err, c) => {
    if (err instanceof PortError) {
      if (err.status === 401) c.header("WWW-Authenticate", 'Bearer realm="shipboard"')
      return c.json({ error: err.message }, err.status as 400)
    }
    log?.error("request failed", { path: c.req.path, error: err instanceof Error ? err.stack ?? err.message : String(err) })
    return c.json({ error: "Something broke on the board. Check the server log." }, 500)
  })

  app.notFound((c) => c.json({ error: "Not found." }, 404))

  async function authorize(c: Context, level: Level): Promise<void> {
    const board = host.boardToken
    const runner = host.runnerToken
    const token = bearer(c)
    const matches = async (secret: string | undefined) => Boolean(secret && token && (await safeEqual(token, secret)))
    if (level === "read") {
      if (host.publicRead) return
      if (!board) {
        if (host.mode === "cloudflare") throw new PortError("Set the BOARD_TOKEN secret to read this board.", 503, "unconfigured")
        return
      }
      if (await matches(board)) return
      throw new PortError("This board needs its board token to read.", 401, "unauthorized")
    }
    if (level === "board") {
      if (!board) {
        if (host.mode === "cloudflare") {
          throw new PortError("Set the BOARD_TOKEN secret (wrangler secret put BOARD_TOKEN) to use the board's buttons.", 503, "unconfigured")
        }
        return
      }
      if (await matches(board)) return
      throw new PortError("This action needs the board token.", 401, "unauthorized")
    }
    if (!board && !runner) {
      if (host.mode === "cloudflare") {
        throw new PortError("Set the RUNNER_TOKEN secret (wrangler secret put RUNNER_TOKEN) so runners can connect.", 503, "unconfigured")
      }
      return
    }
    if ((await matches(runner)) || (await matches(board))) return
    throw new PortError("This action needs the runner token.", 401, "unauthorized")
  }

  async function projectFor(id: string): Promise<ProjectHandle> {
    if (!isProjectId(id)) throw new PortError("No project with that id.", 404, "not_found")
    return host.project(id)
  }

  async function attemptProject(id: string): Promise<ProjectHandle> {
    if (!isAttemptId(id)) throw new PortError("No attempt with that id.", 404, "not_found")
    return host.project(projectIdOf(id))
  }

  // ---------------------------------------------------------------- open

  app.get("/api/health", (c) => c.json({ ok: true }))

  app.get("/api/config", async (c) => {
    return c.json({
      mode: host.mode,
      publicRead: host.publicRead,
      boardAuth: Boolean(host.boardToken),
      agents: await host.agents(),
      namespace: host.namespace,
    })
  })

  // ---------------------------------------------------------------- projects

  app.get("/api/projects", async (c) => {
    await authorize(c, "read")
    return c.json({ projects: await host.listProjects() })
  })

  app.post("/api/projects", async (c) => {
    await authorize(c, "board")
    const body = await readBody(c, maxBody)
    const input: CreateProjectInput = {
      name: typeof body.name === "string" ? body.name : "",
      description: optionalString(body, "description", 2000),
      seed: body.seed === undefined || body.seed === null ? undefined : (body.seed as CreateProjectInput["seed"]),
      importUrl: optionalString(body, "importUrl", 2000),
    }
    const project = await host.createProject(input)
    const notice = input.importUrl
      ? "Imported. Dispatch a brief to fork it."
      : "Project created. Dispatch a brief to fork it."
    return c.json({ project, notice }, 201)
  })

  app.post("/api/demo", async (c) => {
    await authorize(c, "board")
    await readBody(c, maxBody)
    const project = await host.createProject({ name: HARBOR.name, description: HARBOR.description, seed: "harbor" })
    return c.json(
      {
        projectId: project.id,
        notice: "Three scripted agents are editing the harbor notice. Ship two of them; the third will conflict. Re-run it.",
      },
      201,
    )
  })

  app.get("/api/projects/:id", async (c) => {
    await authorize(c, "read")
    const handle = await projectFor(c.req.param("id"))
    const since = c.req.query("since")
    if (since !== undefined && /^\d+$/.test(since)) {
      const version = await handle.version()
      if (String(version) === since) return c.body(null, 304)
    }
    const board = await handle.board()
    return c.json({ ...board, agents: await host.agents() })
  })

  app.post("/api/projects/:id/tasks", async (c) => {
    await authorize(c, "board")
    const handle = await projectFor(c.req.param("id"))
    const body = await readBody(c, maxBody)
    if (body.credentials !== undefined && typeof body.credentials !== "boolean") {
      throw new PortError('"credentials" is true or false.', 400)
    }
    const input = {
      task: body.task,
      constraints: body.constraints,
      acceptance: body.acceptance,
      paths: body.paths,
      agent: body.agent,
    } as DispatchInput
    const result = await handle.dispatch(input, { withCredentials: body.credentials === true })
    const agent = result.board.lanes.flatMap((lane) => lane.tasks).find((task) => task.current.id === result.attemptId)?.current
    let notice = "Forked. The brief is the fork's first commit."
    if (agent?.agentKind === "demo") notice = "Forked. The demo agent is on it."
    else if (agent?.agentKind === "manual") {
      notice = result.credentials
        ? "Forked. Push to the fork with the token below; the board picks it up."
        : "Forked. Ask for credentials to push to it yourself."
    } else if (agent) notice = `Forked. Queued for a runner that offers ${agent.agentLabel}.`
    const out: Record<string, unknown> = { board: result.board, attemptId: result.attemptId, notice }
    if (result.credentials) out.credentials = result.credentials
    return c.json(out, 201)
  })

  // ---------------------------------------------------------------- attempts

  app.post("/api/attempts/:id/ship", async (c) => {
    await authorize(c, "board")
    const id = c.req.param("id")
    const handle = await attemptProject(id)
    const body = await readBody(c, maxBody)
    const expectedHead = optionalString(body, "expectedHead", 64)
    if (expectedHead !== undefined && !SHA.test(expectedHead)) throw new PortError("expectedHead must be a full commit sha.", 400)
    const board = await handle.ship(id, expectedHead)
    return c.json({ board, notice: "Shipped to main. Every other ready attempt was re-checked against the new main." })
  })

  app.post("/api/attempts/:id/park", async (c) => {
    await authorize(c, "board")
    const id = c.req.param("id")
    const handle = await attemptProject(id)
    await readBody(c, maxBody)
    const board = await handle.park(id)
    return c.json({ board, notice: "Parked. It stays off to the side until you put it back." })
  })

  app.post("/api/attempts/:id/unpark", async (c) => {
    await authorize(c, "board")
    const id = c.req.param("id")
    const handle = await attemptProject(id)
    await readBody(c, maxBody)
    const board = await handle.unpark(id)
    return c.json({ board, notice: "Back on the board." })
  })

  app.post("/api/attempts/:id/rerun", async (c) => {
    await authorize(c, "board")
    const id = c.req.param("id")
    const handle = await attemptProject(id)
    const body = await readBody(c, maxBody)
    const agent = optionalString(body, "agent", 40)
    const result = await handle.rerun(id, agent)
    const fresh = result.board.lanes.flatMap((lane) => lane.tasks).find((task) => task.current.id === result.attemptId)?.current
    const notice = fresh
      ? `Discarded the old diff. Attempt ${fresh.number} runs the same brief on main ${fresh.baseSha.slice(0, 7)}.`
      : "Discarded the old diff. A new attempt runs the same brief on current main."
    return c.json({ board: result.board, attemptId: result.attemptId, notice })
  })

  app.get("/api/attempts/:id/diff", async (c) => {
    await authorize(c, "read")
    const id = c.req.param("id")
    const handle = await attemptProject(id)
    return c.json(await handle.diff(id))
  })

  app.post("/api/attempts/:id/pushed", async (c) => {
    await authorize(c, "runner")
    const id = c.req.param("id")
    const handle = await attemptProject(id)
    const body = await readBody(c, maxBody)
    const sha = optionalString(body, "sha", 64)
    if (sha !== undefined && !SHA.test(sha)) throw new PortError("sha must be a full commit sha.", 400)
    return c.json({ board: await handle.pushed(id, sha) })
  })

  // ---------------------------------------------------------------- runner protocol

  app.post("/api/runner/claim", async (c) => {
    await authorize(c, "runner")
    const body = await readBody(c, maxBody)
    const runnerId = runnerIdOf(body)
    const agents = agentsOf(body)
    await host.noteRunner(runnerId, agents)
    const wanted = optionalString(body, "attemptId", 80)
    if (wanted !== undefined) {
      const job = await (await attemptProject(wanted)).claim(runnerId, agents, { attemptId: wanted })
      return job ? c.json(job) : c.body(null, 204)
    }
    const projects = await host.listProjects()
    const candidates = (
      await Promise.all(
        projects.map(async (project) => {
          try {
            const handle = await host.project(project.id)
            const at = await handle.nextJobAt(agents)
            return at ? { handle, at } : null
          } catch (err) {
            log?.warn("claim peek failed", { project: project.id, error: String(err) })
            return null
          }
        }),
      )
    )
      .filter((item): item is { handle: ProjectHandle; at: string } => item !== null)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    for (const { handle } of candidates) {
      const job = await handle.claim(runnerId, agents)
      if (job) return c.json(job)
    }
    return c.body(null, 204)
  })

  app.post("/api/runner/jobs/:attemptId/heartbeat", async (c) => {
    await authorize(c, "runner")
    const id = c.req.param("attemptId")
    const handle = await attemptProject(id)
    const body = await readBody(c, maxBody)
    return c.json(await handle.heartbeat(id, runnerIdOf(body)))
  })

  app.post("/api/runner/jobs/:attemptId/credentials", async (c) => {
    await authorize(c, "runner")
    const id = c.req.param("attemptId")
    const handle = await attemptProject(id)
    const body = await readBody(c, maxBody)
    const scope = body.scope
    if (scope !== "read" && scope !== "write") throw new PortError('scope is "read" or "write".', 400)
    return c.json(await handle.jobCredentials(id, runnerIdOf(body), scope))
  })

  app.post("/api/runner/jobs/:attemptId/finish", async (c) => {
    await authorize(c, "runner")
    const id = c.req.param("attemptId")
    const handle = await attemptProject(id)
    const body = await readBody(c, maxBody)
    const runnerId = runnerIdOf(body)
    if (!body.outcome || typeof body.outcome !== "object") throw new PortError("Send the job outcome.", 400)
    await handle.finish(id, runnerId, body.outcome as JobOutcome)
    return c.json({ ok: true })
  })

  // ---------------------------------------------------------------- previews

  app.get("/preview/:projectId/:ref", (c) => {
    const projectId = c.req.param("projectId")
    const ref = c.req.param("ref")
    if (!isProjectId(projectId) || (ref !== "main" && !isAttemptId(ref))) throw new PortError("Not found.", 404)
    return c.redirect(`/preview/${projectId}/${ref}/`, 302)
  })

  app.get("/preview/:projectId/:ref/*", async (c) => {
    await authorize(c, "read")
    const projectId = c.req.param("projectId")
    const ref = c.req.param("ref")
    if (!isProjectId(projectId) || (ref !== "main" && !isAttemptId(ref))) throw new PortError("Not found.", 404)
    const prefix = `/preview/${projectId}/${ref}/`
    const pathname = new URL(c.req.url).pathname
    if (!pathname.startsWith(prefix)) throw new PortError("Not found.", 404)
    let rest: string
    try {
      rest = pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/")
    } catch {
      throw new PortError("Not found.", 404)
    }
    const handle = await host.project(projectId)
    const file = await handle.preview(ref, rest)
    if (!file) {
      // Seeded sites live under site/. Send the bare preview URL there instead of a 404.
      if (rest === "" && (await handle.preview(ref, "site/index.html"))) return c.redirect(`${prefix}site/`, 302)
      return c.json({ error: "Not found." }, 404)
    }
    c.header("Content-Type", file.contentType)
    c.header("Content-Security-Policy", PREVIEW_CSP)
    c.header("Cross-Origin-Resource-Policy", "same-origin")
    c.header("Cache-Control", "no-store")
    return c.body(file.body as Uint8Array<ArrayBuffer>)
  })

  // ---------------------------------------------------------------- the board UI

  if (opts.serveStatic) {
    const serve = opts.serveStatic
    app.get("*", async (c) => {
      const path = c.req.path
      if (path.startsWith("/api/") || path === "/api" || path.startsWith("/preview/") || path.startsWith("/git/")) {
        return c.json({ error: "Not found." }, 404)
      }
      let file = await serve(path === "/" ? "/index.html" : path)
      const last = path.split("/").pop() ?? ""
      // Client-side routes like /p/<id> get the app shell.
      if (!file && !last.includes(".")) file = await serve("/index.html")
      if (!file) return c.json({ error: "Not found." }, 404)
      c.header("Content-Type", file.contentType)
      if (file.contentType.startsWith("text/html")) {
        c.header("Content-Security-Policy", BOARD_CSP)
        c.header("Cache-Control", "no-store")
      } else {
        c.header("Cache-Control", "no-cache")
      }
      return c.body(file.body as Uint8Array<ArrayBuffer>)
    })
  }

  return app
}
