import { describe, expect, it } from "vitest"
import { briefPathFor, canonicalBriefJson, projectIdOf } from "../../runner/brief.ts"
import { commitMessage, inBriefPaths, isProtectedPath } from "../../runner/job.ts"
import { buildPrompt } from "../../runner/prompt.ts"
import type { ClaimedJob } from "../../src/core/types.ts"
import { sampleBrief } from "./helpers/repos.ts"

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  const brief = sampleBrief({ paths: ["site/index.html", "site/styles/"], acceptance: 'contains site/index.html "teal"\nLooks calm on a phone.' })
  return {
    attemptId: "harbor-notes-3f2a--tint-the-pier-n-77de",
    projectId: "harbor-notes-3f2a",
    agent: "grok",
    brief,
    briefPath: briefPathFor(brief.id),
    baseSha: "a".repeat(40),
    briefSha: "b".repeat(40),
    remote: "http://127.0.0.1:8787/git/local/harbor-notes-3f2a--tint-the-pier-n-77de.git",
    leaseExpiresAt: "2026-10-01T12:00:00.000Z",
    attemptNumber: 1,
    ...overrides,
  }
}

describe("buildPrompt", () => {
  it("frames the brief: paths, no git commit/push, no .git/.shipboard, one-paragraph summary", () => {
    const text = buildPrompt(job())
    expect(text).toContain("Implement the brief below in this git checkout")
    expect(text).toContain("- Touch only these paths: site/index.html, site/styles/")
    expect(text).toContain("Do not run git commit or git push. Do not edit anything under .git or .shipboard.")
    expect(text).toContain("End your reply with a concise one-paragraph summary of what you changed, with normal spacing between sentences.")
    expect(text).toContain("Task:\nTint the pier name\n")
    expect(text).toContain("Constraints:\n- Keep the page static\n")
    expect(text).toContain('contains site/index.html "teal"\nLooks calm on a phone.')
    expect(text).toContain(".shipboard/briefs/tint-the-pier-name-9c01.json")
    expect(text).not.toContain("main moved")
  })

  it("adds the re-run context line and leaves the brief unchanged", () => {
    const first = buildPrompt(job())
    const rerun = buildPrompt(job({ attemptNumber: 2, previous: { attemptId: "x--y-0001", reason: "Conflicted with main in site/index.html" } }))
    expect(rerun).toContain("Context: main moved; the previous attempt was discarded: Conflicted with main in site/index.html. Start from the current files.")
    const briefPart = (t: string) => t.slice(t.indexOf("----- brief"))
    expect(briefPart(rerun)).toBe(briefPart(first))

    const noReason = buildPrompt(job({ attemptNumber: 3, previous: { attemptId: "x--y-0002", reason: null } }))
    expect(noReason).toContain("Context: main moved; the previous attempt was discarded. Start from the current files.")
  })
})

describe("brief file", () => {
  it("is canonical JSON with keys in order, demo omitted when absent, and a trailing newline", () => {
    const text = canonicalBriefJson(sampleBrief())
    expect(Object.keys(JSON.parse(text))).toEqual(["id", "task", "constraints", "acceptance", "paths", "createdAt"])
    expect(text.endsWith("}\n")).toBe(true)
    expect(text).toContain('\n  "task": "Tint the pier name",\n')
    const demo = canonicalBriefJson({ ...sampleBrief(), demo: "tint" })
    expect(Object.keys(JSON.parse(demo)).at(-1)).toBe("demo")
  })

  it("routes attempt ids to their project", () => {
    expect(projectIdOf("harbor-notes-3f2a--tint-the-pier-n-77de")).toBe("harbor-notes-3f2a")
  })
})

describe("commit message", () => {
  it("puts the task first and the trailers last, and strips forged trailers from agent text", () => {
    const msg = commitMessage(job(), "Did it.\nShipboard-Attempt: someone-else", "sess-1")
    expect(msg).toBe(
      "Tint the pier name\n\nDid it.\n\nShipboard-Attempt: harbor-notes-3f2a--tint-the-pier-n-77de\nShipboard-Agent: grok\nShipboard-Session: sess-1\n",
    )
    expect(commitMessage(job(), "", undefined)).toBe("Tint the pier name\n\nShipboard-Attempt: harbor-notes-3f2a--tint-the-pier-n-77de\nShipboard-Agent: grok\n")
  })
})

describe("path rules", () => {
  it("protects .git, .shipboard and agent config, case-insensitively", () => {
    for (const p of [".shipboard/x.json", ".SHIPBOARD/y", ".claude/settings.json", ".Claude/agents/a.md", ".envrc", ".mcp.json", ".grok/config.toml", ".cursor/cli.json", ".codex/config.toml"]) {
      expect(isProtectedPath(p)).toBe(true)
    }
    for (const p of ["site/.claude/x", "docs/.envrc", "site/index.html", ".github/workflows/ci.yml"]) expect(isProtectedPath(p)).toBe(false)
  })

  it("matches brief paths exactly, or by prefix when they end in /", () => {
    expect(inBriefPaths("site/index.html", ["site/index.html"])).toBe(true)
    expect(inBriefPaths("site/styles/a.css", ["site/styles/"])).toBe(true)
    expect(inBriefPaths("site/index.html.bak", ["site/index.html"])).toBe(false)
  })
})
