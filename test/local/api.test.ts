import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { defaultAgents } from "../../src/core/agents.ts"
import type { Host, ProjectHandle } from "../../src/core/ports.ts"
import { PortError } from "../../src/core/ports.ts"
import { BOARD_CSP, createApi, safeEqual } from "../../src/http/api.ts"
import { api, boot, cleanup } from "./helpers.ts"

afterEach(cleanup)

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: string }

/** node:http, so the test controls Host, Origin and chunked bodies exactly. */
function raw(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | string[] } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => (body += chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on("error", reject)
    if (Array.isArray(opts.body)) for (const chunk of opts.body) req.write(chunk)
    else if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

describe("api without tokens (local)", () => {
  it("answers health and config, and guards Host and Origin", async () => {
    const server = await boot()
    const a = api(server.url)
    expect(await (await a.get("/api/health")).json()).toEqual({ ok: true })
    const config = await a.json<{ mode: string; publicRead: boolean; boardAuth: boolean; agents: Array<{ id: string }>; namespace: string }>(
      await a.get("/api/config"),
    )
    expect(config.mode).toBe("local")
    expect(config.publicRead).toBe(true)
    expect(config.boardAuth).toBe(false)
    expect(config.namespace).toBe("local")
    expect(config.agents.map((agent) => agent.id)).toEqual(["demo", "manual", "claude", "claude-code", "codex", "grok", "cursor"])

    const rebinding = await raw(`${server.url}/api/projects`, { headers: { Host: `evil.example:${server.port}` } })
    expect(rebinding.status).toBe(403)
    expect(rebinding.headers["x-content-type-options"]).toBe("nosniff")
    const localhostName = await raw(`${server.url}/api/projects`, { headers: { Host: `localhost:${server.port}` } })
    expect(localhostName.status).toBe(200)

    const json = { "Content-Type": "application/json" }
    const crossSite = await raw(`${server.url}/api/projects`, {
      method: "POST",
      headers: { ...json, Origin: "https://evil.example" },
      body: JSON.stringify({ name: "Nope" }),
    })
    expect(crossSite.status).toBe(403)
    const sameSite = await raw(`${server.url}/api/projects`, {
      method: "POST",
      headers: { ...json, Origin: server.url },
      body: JSON.stringify({ name: "Yes" }),
    })
    expect(sameSite.status).toBe(201)

    const textPlain = await raw(`${server.url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ name: "CSRF" }),
    })
    expect(textPlain.status).toBe(415)
    const noType = await raw(`${server.url}/api/demo`, { method: "POST" })
    expect(noType.status).toBe(415)

    const big = "x".repeat(64 * 1024)
    const chunked = await raw(`${server.url}/api/projects`, {
      method: "POST",
      headers: { ...json, "Transfer-Encoding": "chunked" },
      body: ['{"name":"', big, big, big, big, big, '"}'],
    })
    expect(chunked.status).toBe(413)
    const badJson = await raw(`${server.url}/api/projects`, { method: "POST", headers: json, body: "{nope" })
    expect(badJson.status).toBe(400)
    const array = await raw(`${server.url}/api/projects`, { method: "POST", headers: json, body: "[1]" })
    expect(array.status).toBe(400)
    const nameless = await a.post("/api/projects", { name: "   " })
    expect(nameless.status).toBe(400)
    expect((await a.json<{ error: string }>(nameless)).error).toBe("Name the project.")
    const badImport = await a.post("/api/projects", { name: "x", importUrl: "file:///etc" })
    expect(badImport.status).toBe(400)
  })

  it("returns 304 for an unchanged version and 404s for unknown ids", async () => {
    const server = await boot()
    const a = api(server.url)
    const { project } = await a.json<{ project: { id: string } }>(await a.post("/api/projects", { name: "Polling" }))
    const first = await a.get(`/api/projects/${project.id}`)
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toBe("no-store")
    const { version } = await a.json<{ version: number }>(first)
    const same = await a.get(`/api/projects/${project.id}?since=${version}`)
    expect(same.status).toBe(304)
    expect(await same.text()).toBe("")
    expect((await a.get(`/api/projects/${project.id}?since=${version - 1}`)).status).toBe(200)

    await a.post(`/api/projects/${project.id}/tasks`, { task: "Change", paths: ["a.txt"], agent: "manual" })
    expect((await a.get(`/api/projects/${project.id}?since=${version}`)).status).toBe(200)

    expect((await a.get("/api/projects/missing-0000")).status).toBe(404)
    expect((await a.get("/api/projects/..%2Fetc")).status).toBe(404)
    expect((await a.post("/api/attempts/not-an-attempt/ship", {})).status).toBe(404)
    expect((await a.post(`/api/attempts/${project.id}--ghost-0000/ship`, {})).status).toBe(404)
    expect((await a.get(`/api/attempts/missing-0000--ghost-0000/diff`)).status).toBe(404)
    expect((await a.get("/api/nothing")).status).toBe(404)
    const dispatch = await a.post(`/api/projects/${project.id}/tasks`, { task: "Bad agent", paths: ["a.txt"], agent: "demo" })
    expect(dispatch.status).toBe(400)
  })

  it("serves the board shell with its CSP and previews sandboxed", async () => {
    const server = await boot()
    const index = await fetch(`${server.url}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get("content-security-policy")).toBe(BOARD_CSP)
    expect(await index.text()).toContain("Shipboard")
    const direct = await fetch(`${server.url}/index.html`)
    expect(direct.headers.get("content-security-policy")).toBe(BOARD_CSP)
    const spa = await fetch(`${server.url}/p/some-project-0000`)
    expect(spa.status).toBe(200)
    expect(spa.headers.get("content-security-policy")).toBe(BOARD_CSP)
    const script = await fetch(`${server.url}/app.js`)
    expect(script.headers.get("content-type")).toContain("javascript")
    expect((await fetch(`${server.url}/missing.css`)).status).toBe(404)
    expect((await raw(`${server.url}/..%2f..%2fpackage.json`)).status).toBe(404)

    const a = api(server.url)
    const { project } = await a.json<{ project: { id: string } }>(await a.post("/api/projects", { name: "Preview me" }))
    const page = await fetch(`${server.url}/preview/${project.id}/main/site/index.html`)
    expect(page.status).toBe(200)
    const csp = page.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("sandbox")
    expect(csp).not.toContain("script-src")
    expect(page.headers.get("referrer-policy")).toBe("no-referrer")
    expect(await page.text()).toContain("Preview me")
    expect((await fetch(`${server.url}/preview/${project.id}/main/nope.html`)).status).toBe(404)
    expect((await fetch(`${server.url}/preview/${project.id}/main/..%2F..%2Fsecret`)).status).toBe(404)
    const readme = await fetch(`${server.url}/preview/${project.id}/main/README.md`)
    expect(readme.headers.get("content-type")).toContain("text/plain")
  })
})

describe("api with tokens", () => {
  it("requires the board token for actions, accepts runner or board on runner routes", async () => {
    const server = await boot({ boardToken: "b-token", runnerToken: "r-token" })
    const anon = api(server.url)
    const board = api(server.url, "b-token")
    const runner = api(server.url, "r-token")
    const wrong = api(server.url, "b-token-but-longer")

    expect((await anon.get("/api/projects")).status).toBe(200)
    const denied = await anon.post("/api/projects", { name: "Nope" })
    expect(denied.status).toBe(401)
    expect(denied.headers.get("www-authenticate")).toContain("Bearer")
    expect((await wrong.post("/api/projects", { name: "Nope" })).status).toBe(401)
    expect((await runner.post("/api/projects", { name: "Nope" })).status).toBe(401)
    expect((await runner.post("/api/demo")).status).toBe(401)
    const created = await board.post("/api/projects", { name: "Guarded" })
    expect(created.status).toBe(201)
    const { project } = await board.json<{ project: { id: string } }>(created)

    const config = await anon.json<{ boardAuth: boolean }>(await anon.get("/api/config"))
    expect(config.boardAuth).toBe(true)
    expect((await anon.post("/api/runner/claim", { runnerId: "x", agents: ["claude"] })).status).toBe(401)
    expect((await runner.post("/api/runner/claim", { runnerId: "x", agents: ["claude"] })).status).toBe(204)
    expect((await board.post("/api/runner/claim", { runnerId: "x", agents: ["claude"] })).status).toBe(204)
    expect((await runner.post("/api/runner/claim", { runnerId: "bad id!", agents: ["claude"] })).status).toBe(400)
    expect((await runner.post("/api/runner/claim", { runnerId: "x", agents: [] })).status).toBe(400)

    const dispatched = await board.json<{ attemptId: string }>(
      await board.post(`/api/projects/${project.id}/tasks`, { task: "Guard", paths: ["a.txt"], agent: "manual" }),
    )
    expect((await runner.post(`/api/attempts/${dispatched.attemptId}/park`)).status).toBe(401)
    expect((await runner.post(`/api/attempts/${dispatched.attemptId}/pushed`, {})).status).toBe(200)
    expect((await board.post(`/api/attempts/${dispatched.attemptId}/pushed`, {})).status).toBe(200)
    expect((await anon.post(`/api/attempts/${dispatched.attemptId}/pushed`, {})).status).toBe(401)

    // With tokens set, Host is not pinned (a tunnel or proxy may front the board).
    const proxied = await raw(`${server.url}/api/health`, { headers: { Host: "board.example" } })
    expect(proxied.status).toBe(200)
  })

  it("keeps reads private when publicRead is off", async () => {
    const server = await boot({ boardToken: "b-token", publicRead: false })
    expect((await api(server.url).get("/api/projects")).status).toBe(401)
    expect((await api(server.url, "b-token").get("/api/projects")).status).toBe(200)
    expect((await api(server.url).get("/api/health")).status).toBe(200)
  })
})

describe("api on a cloudflare-shaped host", () => {
  const handle = {} as ProjectHandle
  const cfHost: Host = {
    mode: "cloudflare",
    namespace: "shipboard",
    publicRead: true,
    agents: async () => defaultAgents(),
    noteRunner: async () => {},
    listProjects: async () => [],
    createProject: async () => {
      throw new PortError("unreachable", 500)
    },
    project: async () => handle,
  }

  it("returns 503 naming the secret when tokens are missing, and skips the local Host check", async () => {
    const app = createApi(cfHost)
    const res = await app.request("https://shipboard.example/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "shipboard.example" },
      body: "{}",
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain("BOARD_TOKEN")
    const runner = await app.request("https://shipboard.example/api/runner/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runnerId: "x", agents: ["claude"] }),
    })
    expect(runner.status).toBe(503)
    expect(((await runner.json()) as { error: string }).error).toContain("RUNNER_TOKEN")
    expect((await app.request("https://shipboard.example/api/projects")).status).toBe(200)
    expect((await app.request("https://shipboard.example/")).status).toBe(404)
  })

  it("compares secrets in constant time without leaking length", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true)
    expect(await safeEqual("abc", "abd")).toBe(false)
    expect(await safeEqual("abc", "abcd")).toBe(false)
    expect(await safeEqual("", "")).toBe(true)
  })
})
