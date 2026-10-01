import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { CloudflareArtifacts, artifactsCode, fullToken, importUrl, toPortError } from "../../src/cloudflare/artifacts.ts"
import { GitWorkspace } from "../../src/core/git.ts"
import { PortError } from "../../src/core/ports.ts"
import { cleanup } from "../local/helpers.ts"
import { FakeArtifacts, FakeArtifactsError, gitBackend } from "./fakes.ts"

let fake: FakeArtifacts
let port: CloudflareArtifacts
let slept: number[]
let close: () => Promise<void>

beforeEach(async () => {
  const backend = await gitBackend()
  close = backend.close
  fake = new FakeArtifacts(backend.local)
  slept = []
  port = new CloudflareArtifacts(fake, { sleep: async (ms) => void slept.push(ms), readyTimeoutMs: 5_000 })
})

afterEach(async () => {
  await close()
  await cleanup()
})

async function rejects(promise: Promise<unknown>): Promise<PortError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(PortError)
    return err as PortError
  }
  throw new Error("expected a rejection")
}

async function seeded(name: string): Promise<string> {
  await port.create(name)
  return new GitWorkspace(port).seed(name, { "site/index.html": "<p>hello</p>\n", "README.md": "# hi\n" }, "Start main")
}

describe("CloudflareArtifacts over the binding", () => {
  it("creates a repo on main and refuses a taken or invalid name", async () => {
    const info = await port.create("keel-a1b2", { description: "A quiet\npage" })
    expect(info).toEqual({ name: "keel-a1b2", remote: `${fake.local.remote("keel-a1b2")}`, defaultBranch: "main" })
    expect(fake.calls[0]?.detail).toEqual({ description: "A quiet page", setDefaultBranch: "main" })

    const taken = await rejects(port.create("keel-a1b2"))
    expect(taken.status).toBe(409)
    expect(taken.code).toBe("exists")

    const bad = await rejects(port.create("Not A Repo"))
    expect(bad.status).toBe(400)
    expect(fake.count("create")).toBe(2)
  })

  it("reads a branch head through log({ ref, limit: 1 }) and returns null for empty or missing repos", async () => {
    await port.create("keel-a1b2")
    expect(await port.head("keel-a1b2")).toBeNull()
    const sha = await new GitWorkspace(port).seed("keel-a1b2", { "a.txt": "a\n" }, "Start main")
    expect(await port.head("keel-a1b2")).toBe(sha)
    expect(await fake.local.head("keel-a1b2")).toBe(sha)
    expect(await port.head("keel-zzzz")).toBeNull()
    expect(await port.head("not a repo")).toBeNull()
    const logs = fake.calls.filter((call) => call.op === "log")
    expect(logs.some((call) => (call.detail as { ref: string; limit: number }).ref === "main")).toBe(true)
    expect(logs.every((call) => (call.detail as { limit: number }).limit === 1)).toBe(true)
  })

  it("forks and waits out FORK_IN_PROGRESS, from fork() and from get()", async () => {
    const main = await seeded("keel-a1b2")
    fake.forkBusyCalls = 2
    fake.forkBusyGets = 3
    const info = await port.fork("keel-a1b2", "keel-a1b2--lede-0001", { description: "Set the lede" })
    expect(info.name).toBe("keel-a1b2--lede-0001")
    expect(info.defaultBranch).toBe("main")
    expect(info.remote).toBe(fake.local.remote("keel-a1b2--lede-0001"))
    expect(await port.head("keel-a1b2--lede-0001")).toBe(main)
    expect(fake.count("fork")).toBe(3)
    expect(slept.length).toBeGreaterThanOrEqual(5)
    const forkCall = fake.calls.find((call) => call.op === "fork")
    expect(forkCall?.detail).toMatchObject({ from: "keel-a1b2", defaultBranchOnly: true, description: "Set the lede" })
  })

  it("gives up on a fork that never becomes usable and removes it", async () => {
    await seeded("keel-a1b2")
    fake.forkBusyGets = 1_000
    const err = await rejects(port.fork("keel-a1b2", "keel-a1b2--lede-0002"))
    expect(err.status).toBe(503)
    expect(err.code).toBe("busy")
    expect(await fake.local.info("keel-a1b2--lede-0002")).toBeNull()
  })

  it("maps a fork of a missing source to 404 and a taken target to 409", async () => {
    expect((await rejects(port.fork("keel-zzzz", "keel-zzzz--x-0001"))).status).toBe(404)
    await seeded("keel-a1b2")
    await port.fork("keel-a1b2", "keel-a1b2--x-0001")
    const taken = await rejects(port.fork("keel-a1b2", "keel-a1b2--x-0001"))
    expect(taken.status).toBe(409)
  })

  it("always passes the token scope and returns the full token string", async () => {
    await seeded("keel-a1b2")
    const seen = fake.count("createToken")
    const read = await port.token("keel-a1b2", "read", 900)
    expect(read.scope).toBe("read")
    expect(read.token).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/)
    expect(read.remote).toBe(fake.local.remote("keel-a1b2"))
    expect(Date.parse(read.expiresAt)).toBeGreaterThan(Date.now())
    expect(fake.local.tokens.check(read.token, "keel-a1b2", "read")).toBe("ok")
    expect(fake.local.tokens.check(read.token, "keel-a1b2", "write")).toBe("forbidden")

    const write = await port.token("keel-a1b2", "write", 5)
    expect(write.scope).toBe("write")
    const scopes = fake.calls
      .filter((call) => call.op === "createToken")
      .slice(seen)
      .map((call) => call.detail)
    // Scope explicit every time; a 5 s request is raised to the 60 s minimum.
    expect(scopes).toEqual([
      { scope: "read", ttl: 900 },
      { scope: "write", ttl: 60 },
    ])

    fake.bareTokens = true
    const bare = await port.token("keel-a1b2", "read", 600)
    expect(bare.token).toMatch(/^art_v1_[0-9a-f]{40}\?expires=\d+$/)
    expect(Number(bare.token.split("?expires=")[1]) * 1000).toBe(Math.floor(Date.parse(bare.expiresAt) / 1000) * 1000)

    expect((await rejects(port.token("keel-zzzz", "read", 600))).status).toBe(404)
  })

  it("reads files as bytes and answers null for anything that is not a file", async () => {
    const sha = await seeded("keel-a1b2")
    const bytes = await port.readFile("keel-a1b2", sha, "site/index.html")
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("<p>hello</p>\n")
    expect(await port.readFile("keel-a1b2", "main", "/README.md")).not.toBeNull()
    expect(await port.readFile("keel-a1b2", "main", "missing.txt")).toBeNull()
    expect(await port.readFile("keel-a1b2", "main", "site")).toBeNull()
    expect(await port.readFile("keel-zzzz", "main", "README.md")).toBeNull()
    const before = fake.count("readFile")
    // Never sent to the binding: an empty path throws INVALID_INPUT there, and traversal is refused here.
    expect(await port.readFile("keel-a1b2", "main", "")).toBeNull()
    expect(await port.readFile("keel-a1b2", "main", "/")).toBeNull()
    expect(await port.readFile("keel-a1b2", "main", "../etc/passwd")).toBeNull()
    expect(await port.readFile("keel-a1b2", "", "README.md")).toBeNull()
    expect(fake.count("readFile")).toBe(before)
  })

  it("reports info, deletes, and releases every repo handle it opens", async () => {
    await seeded("keel-a1b2")
    expect(await port.info("keel-a1b2")).toEqual({ name: "keel-a1b2", remote: fake.local.remote("keel-a1b2"), defaultBranch: "main" })
    expect(await port.info("keel-zzzz")).toBeNull()
    expect(await port.info("NOT valid")).toBeNull()
    expect(await port.delete("keel-a1b2")).toBe(true)
    expect(await port.delete("keel-a1b2")).toBe(false)
    expect(await port.info("keel-a1b2")).toBeNull()
    expect(fake.opened).toBeGreaterThanOrEqual(2)
    expect(fake.disposed).toBe(fake.opened)
  })

  it("imports a public https repo and waits for it", async () => {
    await seeded("keel-a1b2")
    fake.upstreams.set("https://example.test/keel.git", "keel-a1b2")
    fake.importBusyGets = 2
    const info = await port.import("https://example.test/keel.git", "keel-c3d4")
    expect(info).toEqual({ name: "keel-c3d4", remote: fake.local.remote("keel-c3d4"), defaultBranch: "main" })
    expect(await port.head("keel-c3d4")).toBe(await fake.local.head("keel-a1b2"))
    expect(slept.length).toBeGreaterThanOrEqual(2)
  })

  it("refuses imports that are not public https, missing, or not on main", async () => {
    expect((await rejects(port.import("http://example.test/keel.git", "keel-c3d4"))).status).toBe(400)
    expect((await rejects(port.import("https://user:pw@example.test/keel.git", "keel-c3d4"))).status).toBe(400)
    expect((await rejects(port.import("not a url", "keel-c3d4"))).status).toBe(400)
    expect(fake.count("import")).toBe(0)

    const missing = await rejects(port.import("https://example.test/nothing.git", "keel-c3d4"))
    expect(missing.status).toBe(400)
    expect(missing.code).toBe("import_failed")

    fake.upstreams.set("https://example.test/old.git", null)
    const master = await rejects(port.import("https://example.test/old.git", "keel-e5f6"))
    expect(master.status).toBe(400)
    expect(master.code).toBe("no_main")
    expect(master.message).toContain('"master"')
    expect(await fake.local.info("keel-e5f6")).toBeNull()
  })

  it("surfaces binding failures as PortErrors with the right status", async () => {
    await seeded("keel-a1b2")
    fake.failOnce.set("log", "INTERNAL_ERROR")
    const internal = await rejects(port.head("keel-a1b2"))
    expect(internal.status).toBe(502)
    fake.failOnce.set("createToken", "INVALID_TTL")
    expect((await rejects(port.token("keel-a1b2", "read", 600))).status).toBe(400)
    fake.failOnce.set("readFile", "MEMORY_LIMIT")
    expect((await rejects(port.readFile("keel-a1b2", "main", "README.md"))).status).toBe(413)
  })
})

describe("Artifacts error mapping", () => {
  const cases: Array<[ArtifactsErrorCode, number, string]> = [
    ["ALREADY_EXISTS", 409, "exists"],
    ["NOT_FOUND", 404, "not_found"],
    ["CREATE_IN_PROGRESS", 503, "busy"],
    ["IMPORT_IN_PROGRESS", 503, "busy"],
    ["FORK_IN_PROGRESS", 503, "busy"],
    ["INVALID_INPUT", 400, "bad_request"],
    ["INVALID_REPO_NAME", 400, "bad_name"],
    ["INVALID_TTL", 400, "bad_request"],
    ["INVALID_URL", 400, "bad_url"],
    ["REMOTE_AUTH_REQUIRED", 400, "import_failed"],
    ["UPSTREAM_UNAVAILABLE", 502, "upstream"],
    ["MEMORY_LIMIT", 413, "too_large"],
    ["INTERNAL_ERROR", 502, "artifacts"],
  ]

  it.each(cases)("%s → %i %s", (code, status, portCode) => {
    const mapped = toPortError(new FakeArtifactsError(code), "keel-a1b2")
    expect(mapped.status).toBe(status)
    expect(mapped.code).toBe(portCode)
    expect(mapped.message).toMatch(/\.$/)
  })

  it("matches on err.code, falls back to the message when RPC dropped the property, and passes PortErrors through", () => {
    expect(artifactsCode(new FakeArtifactsError("NOT_FOUND", "gone"))).toBe("NOT_FOUND")
    expect(artifactsCode(new Error("ArtifactsError: FORK_IN_PROGRESS while forking"))).toBe("FORK_IN_PROGRESS")
    expect(artifactsCode(new Error("NOT_FOUNDISH"))).toBeNull()
    expect(artifactsCode(new Error("boom"))).toBeNull()
    expect(artifactsCode("NOT_FOUND")).toBeNull()
    const own = new PortError("mine", 418, "teapot")
    expect(toPortError(own, "x")).toBe(own)
    expect(toPortError(new Error("boom"), "x").status).toBe(502)
  })

  it("normalises tokens and import URLs", () => {
    expect(fullToken("art_v1_abc?expires=5", "2030-01-01T00:00:00Z")).toBe("art_v1_abc?expires=5")
    expect(fullToken("art_v1_abc", "1970-01-01T00:01:40.000Z")).toBe("art_v1_abc?expires=100")
    expect(fullToken("art_v1_abc", "soon")).toBe("art_v1_abc")
    expect(importUrl("https://github.com/cloudflare/ci")).toBe("https://github.com/cloudflare/ci")
    expect(() => importUrl("git@github.com:cloudflare/ci.git")).toThrow(PortError)
  })
})
