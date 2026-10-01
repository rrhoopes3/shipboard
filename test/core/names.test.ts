import { describe, expect, it } from "vitest"
import { canonicalBrief, makeBrief, parseBrief, validateDispatch } from "../../src/core/brief.ts"
import { defaultAgents } from "../../src/core/agents.ts"
import {
  assertSafeRel,
  briefPath,
  isAttemptId,
  isProjectId,
  isRepoName,
  listPhrase,
  newAttemptId,
  newBriefId,
  newProjectId,
  projectIdOf,
  slug,
} from "../../src/core/names.ts"
import { PortError } from "../../src/core/ports.ts"

describe("ids", () => {
  it("slugs to lowercase dashes and trims at the limit without a trailing dash", () => {
    expect(slug("Harbor Notes!", 24)).toBe("harbor-notes")
    expect(slug("Café  déjà vu", 24)).toBe("cafe-deja-vu")
    expect(slug("Tint the pier name in channel teal", 16)).toBe("tint-the-pier-na")
    expect(slug("abc def", 4)).toBe("abc")
    expect(slug("!!!", 10)).toBe("")
  })

  it("makes project, brief and attempt ids in the documented shapes", () => {
    for (let i = 0; i < 50; i++) {
      const project = newProjectId("A very long project name that keeps going and going")
      expect(isProjectId(project)).toBe(true)
      expect(project.length).toBeLessThanOrEqual(30)
      expect(project).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      const attempt = newAttemptId(project, "Tint the pier name in channel teal")
      expect(isAttemptId(attempt)).toBe(true)
      expect(attempt.length).toBeLessThanOrEqual(63)
      expect(projectIdOf(attempt)).toBe(project)
      expect(newBriefId("Tint the pier name in channel teal")).toMatch(/^tint-the-pier-name-i-[0-9a-f]{4}$/)
    }
    expect(newProjectId("???")).toMatch(/^project-[0-9a-f]{4}$/)
  })

  it("routes repo names to their project", () => {
    expect(projectIdOf("harbor-notes-3f2a--tint-the-pier-n-77de")).toBe("harbor-notes-3f2a")
    expect(projectIdOf("harbor-notes-3f2a")).toBe("harbor-notes-3f2a")
    expect(isRepoName("harbor-notes-3f2a")).toBe(true)
    expect(isRepoName("harbor-notes-3f2a--x-1")).toBe(true)
    expect(isRepoName("../etc")).toBe(false)
    expect(isAttemptId("harbor--")).toBe(false)
    expect(isAttemptId("Harbor--x")).toBe(false)
    expect(isProjectId("a".repeat(31))).toBe(false)
    expect(briefPath("tint-9c01")).toBe(".shipboard/briefs/tint-9c01.json")
  })

  it("phrases lists", () => {
    expect(listPhrase(["a"])).toBe("a")
    expect(listPhrase(["a", "b"])).toBe("a and b")
    expect(listPhrase(["a", "b", "c"])).toBe("a, b and c")
    expect(listPhrase(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more")
  })
})

describe("assertSafeRel", () => {
  it("accepts and normalises repo-relative paths", () => {
    expect(assertSafeRel("site/index.html")).toBe("site/index.html")
    expect(assertSafeRel(" site\\index.html ")).toBe("site/index.html")
    expect(assertSafeRel(".gitignore")).toBe(".gitignore")
    expect(assertSafeRel(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml")
    expect(assertSafeRel("site/", { allowDir: true })).toBe("site/")
    expect(assertSafeRel("my file.txt", { allowSpaces: true })).toBe("my file.txt")
  })

  it.each([
    "",
    "/etc/passwd",
    "C:/Windows",
    "c:\\x",
    "../secret",
    "site/../../x",
    "site//index.html",
    "./site",
    "site/.",
    ".git/config",
    ".GIT/config",
    "a/.Git/hooks/x",
    ".git./x",
    ".git /x",
    "git~1/config",
    "a\u0000b",
    "line\nbreak",
    "x".repeat(201),
  ])("rejects %j", (input) => {
    expect(() => assertSafeRel(input)).toThrow(PortError)
  })

  it("rejects a trailing slash unless directories are allowed, and spaces unless asked", () => {
    expect(() => assertSafeRel("site/")).toThrow(PortError)
    expect(() => assertSafeRel("my file.txt")).toThrow(/spaces/)
    expect(() => assertSafeRel(42)).toThrow(PortError)
  })

  it("uses status 400", () => {
    try {
      assertSafeRel("../x")
    } catch (err) {
      expect(err).toBeInstanceOf(PortError)
      expect((err as PortError).status).toBe(400)
    }
  })
})

describe("brief", () => {
  const agents = defaultAgents()

  it("writes canonical JSON with keys in order and demo only when set", () => {
    const brief = makeBrief(
      { task: "Tint", constraints: ["one"], acceptance: 'contains a "b"', paths: ["a"] },
      { id: "tint-0001", createdAt: "2026-10-01T00:00:00.000Z" },
    )
    const text = canonicalBrief(brief)
    expect(text).toBe(
      '{\n  "id": "tint-0001",\n  "task": "Tint",\n  "constraints": [\n    "one"\n  ],\n  "acceptance": "contains a \\"b\\"",\n  "paths": [\n    "a"\n  ],\n  "createdAt": "2026-10-01T00:00:00.000Z"\n}\n',
    )
    const demo = canonicalBrief({ ...brief, demo: "footer" })
    expect(demo.trimEnd().endsWith('"demo": "footer"\n}')).toBe(true)
    expect(parseBrief(new TextEncoder().encode(demo))).toEqual({ ...brief, demo: "footer" })
    expect(parseBrief(new TextEncoder().encode("{nope"))).toBeNull()
  })

  it("validates dispatch limits", () => {
    const ok = validateDispatch(
      { task: "  Fix   the lede ", constraints: "a\n\nb", acceptance: "x", paths: "site/index.html, docs/", agent: "Claude" },
      agents,
    )
    expect(ok).toEqual({ task: "Fix the lede", constraints: ["a", "b"], acceptance: "x", paths: ["site/index.html", "docs/"], agent: "claude" })
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ task: "", paths: ["a"], agent: "claude" }, /task/],
      [{ task: "x".repeat(241), paths: ["a"], agent: "claude" }, /240/],
      [{ task: "t", paths: [], agent: "claude" }, /at least one path/],
      [{ task: "t", paths: Array.from({ length: 21 }, (_, i) => `f${i}`), agent: "claude" }, /at most 20/],
      [{ task: "t", paths: ["../x"], agent: "claude" }, /relative path/],
      [{ task: "t", paths: ["a"], constraints: Array.from({ length: 13 }, () => "c"), agent: "claude" }, /12/],
      [{ task: "t", paths: ["a"], constraints: ["c".repeat(241)], agent: "claude" }, /240/],
      [{ task: "t", paths: ["a"], acceptance: "x".repeat(2001), agent: "claude" }, /2000/],
      [{ task: "t", paths: ["a"], agent: "nobody" }, /no agent/],
      [{ task: "t", paths: ["a"] }, /Pick an agent/],
    ]
    for (const [input, message] of bad) {
      expect(() => validateDispatch(input as never, agents)).toThrow(message)
    }
  })
})
