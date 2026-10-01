import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("private preview session", () => {
  it("does not render with a grant issued after the user locks, and clears the cookie", async () => {
    const values = new Map()
    const localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    }
    const calls = []
    let resolveGrant
    let grantStarted
    const started = new Promise((resolve) => { grantStarted = resolve })
    vi.stubGlobal("location", { search: "" })
    vi.stubGlobal("localStorage", localStorage)
    vi.stubGlobal("window", { addEventListener() {} })
    vi.stubGlobal("fetch", vi.fn((path, init) => {
      calls.push([path, init?.method ?? "GET"])
      if (path === "/api/config") return Promise.resolve(Response.json({ publicRead: false }))
      if (init?.method === "POST") {
        grantStarted()
        return new Promise((resolve) => { resolveGrant = resolve })
      }
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }))
      throw new Error(`Unexpected request: ${path}`)
    }))

    const { api, setToken } = await import("../../public/js/api.js")
    setToken("board-secret")
    const pending = api.ensurePreviewSession("private-board-1234")
    const denied = expect(pending).rejects.toMatchObject({ status: 401 })
    await started
    setToken("")
    resolveGrant(Response.json({ expiresAt: new Date(Date.now() + 300_000).toISOString() }))
    await denied
    await vi.waitFor(() => expect(calls).toContainEqual(["/api/projects/private-board-1234/preview-session", "DELETE"]))
    expect(values.get("shipboard.previewProjects")).toBe("[]")
  })
})
