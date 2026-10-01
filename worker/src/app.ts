import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { BoardError } from "./errors.ts"
import { isId } from "./paths.ts"
import type { BoardService } from "./service.ts"

const BOARD_CSP = [
  "default-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "frame-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ")

const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ")

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") || 0)
  if (length > 2_000_000) throw new BoardError("That request is too large.", 400)
  try {
    return await request.json()
  } catch {
    throw new BoardError("The request body was not JSON.", 400)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoardError("The request body was not an object.", 400)
  }
  return value as Record<string, unknown>
}

export async function createApp(service: BoardService): Promise<Hono> {
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public")
  const indexHtml = await fs.readFile(path.join(publicDir, "index.html"), "utf8")
  const app = new Hono()

  app.use("*", async (c, next) => {
    await next()
    c.header("X-Content-Type-Options", "nosniff")
    c.header("Referrer-Policy", "no-referrer")
  })

  app.onError((error, c) => {
    if (error instanceof BoardError) return c.json({ error: error.message }, error.status)
    console.error(error)
    return c.json({ error: "Something broke on the board. Check the server log." }, 500)
  })

  app.get("/api/health", (c) => c.json({ ok: true }))

  app.get("/api/projects", (c) => c.json(service.listProjects()))

  app.post("/api/projects", async (c) => {
    const body = asRecord(await readJson(c.req.raw))
    const project = await service.createProject({ name: body.name, description: body.description })
    return c.json({ project, notice: "Project created." }, 201)
  })

  app.post("/api/demo", async (c) => {
    const board = await service.runPierDemo()
    return c.json(
      {
        ...board,
        notice: "Three agents pushed. Ship what merges cleanly. Re-run whatever conflicts after main moves.",
      },
      201,
    )
  })

  app.get("/api/projects/:id", async (c) => c.json(await service.getBoard(c.req.param("id"))))

  app.post("/api/projects/:id/forks", async (c) => {
    const body = asRecord(await readJson(c.req.raw))
    const board = await service.createFork(c.req.param("id"), body)
    return c.json({ ...board, notice: "Fork dispatched. Waiting for the agent to push." }, 201)
  })

  app.post("/api/forks/:id/push", async (c) => {
    const body = asRecord(await readJson(c.req.raw))
    const board = await service.pushFiles(c.req.param("id"), body)
    return c.json({ ...board, notice: "Pushed. Digest and trial-merge are updated." })
  })

  app.post("/api/forks/:id/ship", async (c) => {
    const board = await service.ship(c.req.param("id"))
    return c.json({ ...board, notice: "Shipped onto main." })
  })

  app.post("/api/forks/:id/park", async (c) => {
    const board = await service.park(c.req.param("id"))
    return c.json({ ...board, notice: "Parked. It stays on the board, off to the side." })
  })

  app.post("/api/forks/:id/return", async (c) => {
    const board = await service.returnToBoard(c.req.param("id"))
    return c.json({ ...board, notice: "Back on the board." })
  })

  app.post("/api/forks/:id/rerun", async (c) => {
    const result = await service.rerun(c.req.param("id"))
    return c.json({ ...result.board, notice: result.notice })
  })

  app.get("/api/forks/:id/diff", async (c) => c.json(await service.diff(c.req.param("id"))))

  app.get("/preview/:projectId/:ref", (c) => {
    const projectId = c.req.param("projectId")
    const ref = c.req.param("ref")
    if (!isId(projectId) || !isId(ref)) throw new BoardError("Not found.", 404)
    return c.redirect(`/preview/${projectId}/${ref}/site/index.html`)
  })

  app.get("/preview/:projectId/:ref/*", async (c) => {
    const projectId = c.req.param("projectId")
    const ref = c.req.param("ref")
    let splat = c.req.param("*") ?? ""
    try {
      splat = decodeURIComponent(splat)
    } catch {
      throw new BoardError("Not found.", 404)
    }
    const file = await service.readPreview(projectId, ref, splat)
    c.header("Content-Type", file.type)
    c.header("Content-Security-Policy", PREVIEW_CSP)
    c.header("Cache-Control", "no-store")
    return c.body(new Uint8Array(file.body))
  })

  const board = (c: { header: (name: string, value: string) => void }) => {
    c.header("Content-Security-Policy", BOARD_CSP)
    c.header("Cache-Control", "no-store")
    return c
  }

  app.get("/", (c) => {
    board(c)
    return c.html(indexHtml)
  })

  app.get("/p/:id", (c) => {
    board(c)
    return c.html(indexHtml)
  })

  app.use("*", serveStatic({ root: publicDir }))

  app.notFound((c) => {
    if (c.req.path.startsWith("/api") || c.req.path.startsWith("/preview")) {
      return c.json({ error: "Not found." }, 404)
    }
    return c.json({ error: "Not found." }, 404)
  })

  return app
}
