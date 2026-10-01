import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defaultAgents } from "../../src/core/agents.ts"
import { GitWorkspace } from "../../src/core/git.ts"
import { ProjectService } from "../../src/core/service.ts"
import { JsonStateStore } from "../../src/local/state.ts"
import { allTasks, boot, cleanup, quiet, tempDir } from "./helpers.ts"

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

const event = (repo: string, after: string) => ({ repo, ref: "refs/heads/main", after })

describe("head ingress", () => {
  it("ignores a pre-init event, but surfaces a transient state-load failure", async () => {
    const server = await boot()
    const dir = await tempDir()
    const id = "load-ingress-0001"
    const missing = new ProjectService(id,
      { artifacts: server.host.artifacts, state: new JsonStateStore(path.join(dir, "missing.json")), log: quiet },
      { agents: defaultAgents() })
    await expect(missing.onPushEvent(event(id, "1".repeat(40)))).resolves.toBeUndefined()

    const outage = new Error("temporary state storage outage")
    const broken = new ProjectService(id,
      { artifacts: server.host.artifacts, state: { load: async () => { throw outage }, save: async () => {} }, log: quiet },
      { agents: defaultAgents() })
    await expect(broken.onPushEvent(event(id, "1".repeat(40)))).rejects.toBe(outage)
  })

  it("ignores notifications for a discarded attempt after its fork was deleted", async () => {
    const server = await boot()
    const dir = await tempDir()
    const id = "retired-ingress-0001"
    const service = new ProjectService(id,
      { artifacts: server.host.artifacts, state: new JsonStateStore(path.join(dir, `${id}.json`)), log: quiet },
      { agents: defaultAgents() })
    await service.init({ id, name: "Retired ingress" })
    const { attemptId } = await service.dispatch({ task: "Write a file", paths: ["a.txt"], agent: "manual" })
    const pushed = await new GitWorkspace(server.host.artifacts).commit(attemptId, { "a.txt": "first\n" }, "first")
    await service.pushed(attemptId, pushed.sha)
    const rerun = await service.rerun(attemptId)
    expect(allTasks(rerun.board)[0]?.history[0]?.status).toBe("discarded")
    expect(await server.host.artifacts.delete(attemptId)).toBe(true)

    const originalHead = server.host.artifacts.head.bind(server.host.artifacts)
    const head = vi.spyOn(server.host.artifacts, "head").mockImplementation((repo, branch) => {
      if (repo === attemptId) throw new Error("retired fork was read")
      return originalHead(repo, branch)
    })
    const before = await service.board({ reconcile: false })
    await expect(service.onPushEvent(event(attemptId, pushed.sha))).resolves.toBeUndefined()
    const after = await service.pushed(attemptId)
    expect(after.version).toBe(before.version)
    expect(head.mock.calls.some(([repo]) => repo === attemptId)).toBe(false)
    expect(allTasks(after)[0]?.current.id).toBe(rerun.attemptId)
  })
})
