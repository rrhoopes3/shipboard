import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createApp } from "../worker/src/app.ts"
import { BoardService } from "../worker/src/service.ts"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function boot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-http-"))
  dirs.push(dir)
  const service = await BoardService.open(dir)
  const app = await createApp(service)
  return { app, service }
}

describe("http", () => {
  it("serves the board, rejects a nameless project, and previews main", async () => {
    const { app } = await boot()
    const health = await app.request("/api/health")
    expect(health.status).toBe(200)

    const home = await app.request("/")
    expect(home.status).toBe(200)
    expect(await home.text()).toContain("Shipboard")
    expect(home.headers.get("content-security-policy")).toContain("default-src 'self'")

    const missing = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    })
    expect(missing.status).toBe(400)

    const created = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Keel", description: "Notes" }),
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { project: { id: string; previewUrl: string } }
    const preview = await app.request(body.project.previewUrl)
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-security-policy")).toContain("default-src 'none'")
    expect(await preview.text()).toContain("Keel")

    const absent = await app.request("/api/projects/missing-project")
    expect(absent.status).toBe(404)
  })
})
