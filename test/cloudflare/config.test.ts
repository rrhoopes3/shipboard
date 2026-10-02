/** wrangler.jsonc against docs/ARCHITECTURE.md ("Cloudflare"), and the code that has to agree with it. */

import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { isApiPath } from "../../src/cloudflare/app.ts"
import * as workerModule from "../../src/cloudflare/worker.ts"
import { BOARD_CSP } from "../../src/http/api.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

type Json = Record<string, unknown>

/** Drops // and /* *\/ comments outside strings, then trailing commas. */
function parseJsonc(text: string): Json {
  let out = ""
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (ch === "\\") out += text[++i] ?? ""
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else {
      out += ch
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Json
}

async function config(): Promise<Json> {
  return parseJsonc(await fs.readFile(path.join(root, "wrangler.jsonc"), "utf8"))
}

function bindingsOf(block: Json) {
  const objects = (block.durable_objects as { bindings: Array<{ name: string; class_name: string }> }).bindings
  const workflows = block.workflows as Array<{ name: string; binding: string; class_name: string }>
  const artifacts = block.artifacts as Array<{ binding: string; namespace: string; remote?: boolean }>
  const events = (block.triggers as { events: Array<Json> }).events
  const vars = block.vars as Record<string, string>
  return { objects, workflows, artifacts, events, vars }
}

describe("wrangler.jsonc", () => {
  it("matches the contract at the top level", async () => {
    const c = await config()
    expect(c.name).toBe("shipboard")
    expect(c.main).toBe("src/cloudflare/worker.ts")
    expect(c.compatibility_date).toBe("2026-10-01")
    expect(c.assets).toMatchObject({ directory: "./public", binding: "ASSETS", run_worker_first: ["/api/*", "/preview/*"] })
    expect(c.limits).toEqual({ cpu_ms: 300000 })
    expect(c.observability).toEqual({ enabled: true })
    expect(c.ai).toEqual({ binding: "AI", remote: true })
    expect(c.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["ProjectDO", "RegistryDO"] }])

    const { objects, workflows, artifacts, events, vars } = bindingsOf(c)
    expect(artifacts).toEqual([{ binding: "ARTIFACTS", namespace: "shipboard", remote: true }])
    expect(objects).toEqual([
      { name: "PROJECT", class_name: "ProjectDO" },
      { name: "REGISTRY", class_name: "RegistryDO" },
    ])
    expect(workflows).toEqual([{ name: "shipboard-push", binding: "PUSH_WORKFLOW", class_name: "PushWorkflow" }])
    // wrangler's schema shape; the docs guide's `target`/`workflowName` shape fails validation.
    expect(events).toEqual([
      { type: "cf.artifacts.repo.pushed", filter: { namespace: "shipboard" }, targets: [{ type: "workflow", workflow_name: "shipboard-push" }] },
    ])
    expect(vars.PUBLIC_READ).toBe("false")
    expect(vars.REVIEW_MODEL).toMatch(/^@cf\//)
    expect(vars.ARTIFACTS_NAMESPACE).toBe("shipboard")
  })

  it("repeats every non-inheritable binding in env.dev, on its own namespace and workflow", async () => {
    const dev = ((await config()).env as Record<string, Json>).dev as Json
    const { objects, workflows, artifacts, events, vars } = bindingsOf(dev)
    expect(artifacts).toEqual([{ binding: "ARTIFACTS", namespace: "shipboard-dev", remote: true }])
    expect(objects.map((o) => o.class_name)).toEqual(["ProjectDO", "RegistryDO"])
    expect(workflows[0]?.class_name).toBe("PushWorkflow")
    expect(workflows[0]?.name).not.toBe("shipboard-push")
    expect(events[0]).toEqual({
      type: "cf.artifacts.repo.pushed",
      filter: { namespace: "shipboard-dev" },
      targets: [{ type: "workflow", workflow_name: workflows[0]?.name }],
    })
    expect(vars.ARTIFACTS_NAMESPACE).toBe("shipboard-dev")
    expect(dev.ai).toEqual({ binding: "AI", remote: true })
  })

  it("names only classes and bindings the Worker actually has", async () => {
    const c = await config()
    expect(typeof workerModule.ProjectDO).toBe("function")
    expect(typeof workerModule.RegistryDO).toBe("function")
    expect(typeof workerModule.PushWorkflow).toBe("function")
    expect(typeof workerModule.default.fetch).toBe("function")
    // The Worker module exports handlers and classes only.
    expect(Object.keys(workerModule).sort()).toEqual(["ProjectDO", "PushWorkflow", "RegistryDO", "default"])
    const envSource = await fs.readFile(path.join(root, "src/cloudflare/env.ts"), "utf8")
    const { objects, workflows, artifacts, vars } = bindingsOf(c)
    const names = [
      ...objects.map((o) => o.name),
      ...workflows.map((w) => w.binding),
      ...artifacts.map((a) => a.binding),
      (c.assets as { binding: string }).binding,
      (c.ai as { binding: string }).binding,
      ...Object.keys(vars),
      "BOARD_TOKEN",
      "RUNNER_TOKEN",
    ]
    for (const name of names) expect(envSource, `${name} missing from Env`).toMatch(new RegExp(`^\\s+${name}\\??:`, "m"))
  })

  it("routes only the API and previews to the Worker", () => {
    expect(isApiPath("/api/projects")).toBe(true)
    expect(isApiPath("/api")).toBe(true)
    expect(isApiPath("/preview/p-0001/main/")).toBe(true)
    expect(isApiPath("/")).toBe(false)
    expect(isApiPath("/p/keel-0001")).toBe(false)
    expect(isApiPath("/apiary")).toBe(false)
  })
})

describe("public/_headers", () => {
  it("gives board pages the same CSP as the local host", async () => {
    const text = await fs.readFile(path.join(root, "public/_headers"), "utf8")
    const csp = /^\s+Content-Security-Policy:\s*(.+)$/m.exec(text)?.[1]?.trim()
    expect(csp).toBe(BOARD_CSP)
    expect(text).toMatch(/^\s+X-Content-Type-Options: nosniff$/m)
    expect(text).toMatch(/^\s+Referrer-Policy: no-referrer$/m)
  })
})
