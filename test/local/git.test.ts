import { gzipSync } from "node:zlib"
import type { HttpClient } from "isomorphic-git"
import webHttp from "isomorphic-git/http/web"
import { afterEach, describe, expect, it } from "vitest"
import { GitWorkspace } from "../../src/core/git.ts"
import { boot, cleanup } from "./helpers.ts"

afterEach(cleanup)

const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null)

async function fixture() {
  const server = await boot()
  const project = await server.host.createProject({ name: "Engine room" })
  const handle = await server.host.project(project.id)
  const { attemptId } = await handle.dispatch({ task: "Engine work", paths: ["a.txt"], agent: "manual" })
  const helper = new GitWorkspace(server.host.artifacts)
  return { server, projectId: project.id, attemptId, helper, artifacts: server.host.artifacts }
}

describe("GitWorkspace", () => {
  it("retries a ship once when main moves between fetch and push", async () => {
    const { server, projectId, attemptId, helper, artifacts } = await fixture()
    await helper.commit(attemptId, { "a.txt": "fork\n" }, "fork change")
    let raced = false
    const racing: HttpClient = {
      request: async (request) => {
        if (!raced && request.method === "POST" && request.url.endsWith(`/${projectId}.git/git-receive-pack`)) {
          raced = true
          await helper.commit(projectId, { "b.txt": "main moved\n" }, "someone pushed main")
        }
        return webHttp.request(request)
      },
    }
    const ws = new GitWorkspace(artifacts, { http: racing })
    const result = await ws.ship({ mainRepo: projectId, forkRepo: attemptId, message: "ship: engine work" })
    expect(raced).toBe(true)
    expect(result.kind).toBe("shipped")
    const main = await artifacts.head(projectId)
    expect(result.kind === "shipped" && result.mainSha).toBe(main)
    expect(text(await artifacts.readFile(projectId, "main", "a.txt"))).toBe("fork\n")
    expect(text(await artifacts.readFile(projectId, "main", "b.txt"))).toBe("main moved\n")
    await server.host.idle()
  })

  it("refuses a ship when the fork head is not the expected one", async () => {
    const { projectId, attemptId, helper } = await fixture()
    const first = await helper.commit(attemptId, { "a.txt": "one\n" }, "one")
    await helper.commit(attemptId, { "a.txt": "two\n" }, "two")
    const result = await helper.ship({ mainRepo: projectId, forkRepo: attemptId, expectedHead: first.sha, message: "ship" })
    expect(result.kind).toBe("moved")
  })

  it("diffs added, modified, deleted and binary files, and truncates", async () => {
    const { projectId, attemptId, helper } = await fixture()
    const base = (await helper.head(projectId)) ?? ""
    const head = await helper.commit(
      attemptId,
      {
        "a.txt": "alpha\nbeta\n",
        "bin/blob.dat": new Uint8Array([0, 1, 2, 3, 0]),
        "README.md": null,
        "site/index.html": "<p>changed</p>\n",
      },
      "many",
    )
    const files = await helper.changedFiles(attemptId, base, head.sha)
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
    const brief = files.find((f) => f.path.startsWith(".shipboard/briefs/"))?.path ?? ""
    expect(brief).toMatch(/^\.shipboard\/briefs\/engine-work-[0-9a-f]{4}\.json$/)
    expect(files.map((f) => f.path)).toEqual([brief, "README.md", "a.txt", "bin/blob.dat", "site/index.html"])
    expect(byPath["a.txt"]).toMatchObject({ status: "added", additions: 2, deletions: 0 })
    expect(byPath["README.md"]).toMatchObject({ status: "deleted", additions: 0 })
    expect(byPath["README.md"]?.deletions).toBeGreaterThan(0)
    expect(byPath["bin/blob.dat"]).toMatchObject({ status: "added", additions: 0, deletions: 0 })
    expect(byPath["site/index.html"]?.status).toBe("modified")
    expect(byPath["site/index.html"]?.additions).toBe(1)

    const full = await helper.diff({ repo: attemptId, baseSha: base, headSha: head.sha, exclude: [brief] })
    expect(full.truncated).toBe(false)
    expect(full.diff).not.toContain(".shipboard")
    expect(full.diff).toContain("diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n")
    expect(full.diff).toContain("deleted file mode 100644\n--- a/README.md\n+++ /dev/null\n")
    expect(full.diff).toContain("Binary files /dev/null and b/bin/blob.dat differ")
    expect(full.diff).toContain("+<p>changed</p>")
    const cut = await helper.diff({ repo: attemptId, baseSha: base, headSha: head.sha, limit: 40 })
    expect(cut.truncated).toBe(true)
    expect(cut.diff).toHaveLength(40)
  })

  it("reports an add/add clash as a conflict on that path", async () => {
    const { projectId, attemptId, helper } = await fixture()
    await helper.commit(attemptId, { "new.txt": "from the fork\n" }, "fork adds")
    await helper.commit(projectId, { "new.txt": "from main\n" }, "main adds")
    const merge = await helper.trialMerge(projectId, attemptId)
    expect(merge.state).toBe("conflict")
    expect(merge.paths).toEqual(["new.txt"])
    const clean = await helper.trialMerge(projectId, projectId)
    expect(clean.state).toBe("clean")
  })

  it("serves a gzip-encoded upload-pack request", async () => {
    const { projectId, artifacts } = await fixture()
    const head = (await artifacts.head(projectId)) ?? ""
    const cred = await artifacts.token(projectId, "read", 600)
    const want = `want ${head}\n`
    const body = `${(want.length + 4).toString(16).padStart(4, "0")}${want}00000009done\n`
    const res = await fetch(`${cred.remote}/git-upload-pack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "Content-Type": "application/x-git-upload-pack-request",
        "Content-Encoding": "gzip",
      },
      body: gzipSync(Buffer.from(body)),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-result")
    const bytes = Buffer.from(await res.arrayBuffer())
    expect(bytes.subarray(0, 8).toString()).toBe("0008NAK\n")
    expect(bytes.indexOf("PACK")).toBe(8)
  })

  it("keeps an existing file's executable bit and drops emptied directories", async () => {
    const { attemptId, helper, artifacts } = await fixture()
    await helper.commit(attemptId, { "tools/run.sh": "#!/bin/sh\n" }, "add")
    const removed = await helper.commit(attemptId, { "tools/run.sh": null }, "remove")
    expect(removed.changed).toBe(true)
    expect(await artifacts.readFile(attemptId, "main", "tools/run.sh")).toBeNull()
    const same = await helper.commit(attemptId, { "a.txt": null }, "nothing to remove")
    expect(same.changed).toBe(false)
    expect(same.sha).toBe(removed.sha)
  })
})
