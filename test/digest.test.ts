import { describe, expect, it } from "vitest"
import { buildDigest, parseChecks } from "../worker/src/digest.ts"
import type { Brief } from "../worker/src/types.ts"

const brief: Brief = {
  task: "Tint the name",
  constraints: [],
  acceptance: 'contains site/index.html "color:#1F6F78"',
  paths: ["site/index.html"],
}

describe("digest", () => {
  it("parses contains checks and ignores prose", () => {
    const checks = parseChecks('Read this yourself\ncontains site/index.html "night clerk"\n')
    expect(checks).toEqual([{ path: "site/index.html", text: "night clerk" }])
  })

  it("passes when the expected path changed and the check matches", () => {
    const digest = buildDigest({
      brief,
      files: [
        { path: ".shipboard/brief.json", additions: 5, deletions: 0 },
        { path: "site/index.html", additions: 1, deletions: 1 },
      ],
      checks: [{ path: "site/index.html", text: "color:#1F6F78", ok: true }],
    })
    expect(digest.waiting).toBe(false)
    expect(digest.satisfies).toBe("yes")
    expect(digest.unexpectedPaths).toEqual([])
    expect(digest.missedPaths).toEqual([])
  })

  it("fails when a file outside the brief changes", () => {
    const digest = buildDigest({
      brief,
      files: [{ path: "site/extra.css", additions: 3, deletions: 0 }],
      checks: [{ path: "site/index.html", text: "color:#1F6F78", ok: false }],
    })
    expect(digest.satisfies).toBe("no")
    expect(digest.unexpectedPaths).toEqual(["site/extra.css"])
    expect(digest.missedPaths).toEqual(["site/index.html"])
  })

  it("leaves prose acceptance unchecked when the paths match", () => {
    const digest = buildDigest({
      brief: { ...brief, acceptance: "The tide book should mention the shed." },
      files: [{ path: "site/index.html", additions: 1, deletions: 0 }],
      checks: [],
    })
    expect(digest.satisfies).toBe("unchecked")
    expect(digest.summary).toContain("Read the brief yourself")
  })
})
