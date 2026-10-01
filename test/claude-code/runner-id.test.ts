import { describe, expect, it } from "vitest"
import { runnerIdFor } from "../../integrations/claude-code/hooks/register.ts"
import type { Host } from "../../src/core/ports.ts"
import { createApi } from "../../src/http/api.ts"

describe("Claude Code runner IDs", () => {
  it("uses an ID accepted by the real claim route for long and unusual session IDs", async () => {
    const seen: string[] = []
    const host = {
      mode: "local",
      namespace: "local",
      publicRead: true,
      runnerToken: "runner-secret",
      noteRunner: async (id: string) => { seen.push(id) },
      listProjects: async () => [],
    } as unknown as Host
    const app = createApi(host)
    const machine = "node/🛥️/" + "a".repeat(200)
    const session = "session/with spaces/🔒/" + "z".repeat(200)
    const id = runnerIdFor(machine, session)
    const again = runnerIdFor(machine, session)
    const other = runnerIdFor(machine, `${session}!`)
    expect(id).toBe(again)
    expect(id).not.toBe(other)
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}$/)
    expect(id.length).toBeLessThanOrEqual(80)

    const claim = (runnerId: string) => app.request("http://localhost/api/runner/claim", {
      method: "POST",
      headers: { authorization: "Bearer runner-secret", "content-type": "application/json" },
      body: JSON.stringify({ runnerId, agents: ["claude-code"] }),
    })
    expect((await claim(`claude-code-mod/${machine}/${session}`)).status).toBe(400)
    expect((await claim(id)).status).toBe(204)
    expect(seen).toEqual([id])
  })
})
