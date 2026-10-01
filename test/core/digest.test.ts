import { describe, expect, it } from "vitest"
import { makeBrief } from "../../src/core/brief.ts"
import { buildDigest, coveredBy, isControlPath, parseChecks } from "../../src/core/digest.ts"
import type { Brief, CheckResult, FileStat } from "../../src/core/types.ts"

const brief: Brief = makeBrief(
  { task: "Set the lede", constraints: [], acceptance: 'contains site/index.html "ready"', paths: ["site/index.html"] },
  { id: "set-the-lede-0001", createdAt: "2026-10-01T00:00:00.000Z" },
)

function file(path: string, status: FileStat["status"] = "modified"): FileStat {
  return { path, status, additions: 1, deletions: 1 }
}

const own = file(".shipboard/briefs/set-the-lede-0001.json", "added")
const passed: CheckResult[] = [{ path: "site/index.html", text: "ready", ok: true }]

function digest(files: FileStat[], checks: CheckResult[] = passed, b: Brief = brief, briefIntact = true) {
  return buildDigest({ brief: b, files, checks, baseSha: "a".repeat(40), headSha: "b".repeat(40), briefIntact })
}

describe("parseChecks", () => {
  it("reads contains lines and leaves prose for a human", () => {
    expect(
      parseChecks('Make it nice.\ncontains site/index.html "ready for sea"\n  contains a.txt "say \\"hi\\""  \ncontains nope'),
    ).toEqual([
      { path: "site/index.html", text: "ready for sea" },
      { path: "a.txt", text: 'say \\"hi\\"' },
    ])
    expect(parseChecks("Look at it.")).toEqual([])
  })
})

describe("buildDigest", () => {
  it("ignores the attempt's own brief file and passes a met brief", () => {
    const d = digest([own, file("site/index.html")])
    expect(d.satisfies).toBe("yes")
    expect(d.files.map((f) => f.path)).toEqual(["site/index.html"])
    expect(d.controlPaths).toEqual([])
    expect(d.summary).toBe("Touched site/index.html. Acceptance check passed.")
    expect(d.headSha).toBe("b".repeat(40))
    expect(d.baseSha).toBe("a".repeat(40))
  })

  it("flags any other .shipboard change as a control path and fails the brief", () => {
    const d = digest([own, file("site/index.html"), file(".shipboard/hooks/payload.sh", "added"), file(".SHIPBOARD/x", "added")])
    expect(d.satisfies).toBe("no")
    expect(d.controlPaths).toEqual([".SHIPBOARD/x", ".shipboard/hooks/payload.sh"])
    expect(d.unexpectedPaths).toEqual([])
    expect(d.files.map((f) => f.path)).toContain(".shipboard/hooks/payload.sh")
    expect(d.summary).toContain("Changed shipboard control files")
    expect(isControlPath(".Shipboard/a")).toBe(true)
  })

  it("treats a rewritten brief file as a control path", () => {
    const d = digest([own, file("site/index.html")], passed, brief, false)
    expect(d.satisfies).toBe("no")
    expect(d.controlPaths).toEqual([".shipboard/briefs/set-the-lede-0001.json"])
  })

  it("reports unexpected and missed paths", () => {
    const d = digest([own, file("README.md")])
    expect(d.unexpectedPaths).toEqual(["README.md"])
    expect(d.missedPaths).toEqual(["site/index.html"])
    expect(d.satisfies).toBe("no")
  })

  it("lets a brief path ending in / cover everything under it", () => {
    const dirBrief = { ...brief, paths: ["site/"] }
    const d = digest([file("site/a.html"), file("site/css/b.css")], [], dirBrief)
    expect(d.unexpectedPaths).toEqual([])
    expect(d.missedPaths).toEqual([])
    expect(d.satisfies).toBe("unchecked")
    expect(digest([file("README.md")], [], dirBrief).missedPaths).toEqual(["site/"])
    expect(coveredBy("site/x", ["site/"])).toBe(true)
    expect(coveredBy("siteX/x", ["site/"])).toBe(false)
    expect(coveredBy("site", ["site/"])).toBe(false)
  })

  it("fails on a failed check and is unchecked with no checks", () => {
    const failed = digest([file("site/index.html")], [{ path: "site/index.html", text: "ready", ok: false }])
    expect(failed.satisfies).toBe("no")
    expect(failed.summary).toBe("Touched site/index.html. Acceptance check failed for site/index.html.")
    const prose = digest([file("site/index.html")], [])
    expect(prose.satisfies).toBe("unchecked")
    expect(prose.summary).toBe("Touched site/index.html. No machine-readable acceptance check. Read the diff.")
  })

  it("counts files in the summary", () => {
    const many = { ...brief, paths: ["a", "b", "c"] }
    expect(digest([file("a"), file("b"), file("c")], [], many).summary).toBe(
      "Touched 3 files. No machine-readable acceptance check. Read the diff.",
    )
    expect(digest([], [], brief).summary.startsWith("No files changed beyond the brief.")).toBe(true)
  })
})
