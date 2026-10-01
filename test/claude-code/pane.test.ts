import { describe, expect, it } from "vitest"
import type { AttemptView, BoardView, Brief } from "../../src/core/types.ts"
import { isLinkable, renderPane, type PaneModel } from "../../integrations/claude-code/hooks/pane.ts"
import { oneLine, verdictLines, verdictOf } from "../../integrations/claude-code/hooks/verdict.ts"
import { elements, findAll, textOf } from "./harness.ts"

const ID = "harbor-notes-3f2a--tint-the-pier-n-77de"
const BASE = "http://127.0.0.1:8787"
const sha = (c: string) => c.repeat(40)

const brief: Brief = {
  id: "tint-the-pier-name-9c01",
  task: "Tint the pier name",
  constraints: [],
  acceptance: 'contains site/index.html "ready for sea"',
  paths: ["site/index.html"],
  createdAt: "2026-10-01T12:00:00.000Z",
}

function attempt(over: Partial<AttemptView> = {}): AttemptView {
  return {
    id: ID,
    briefId: brief.id,
    number: 1,
    agent: "claude-code",
    agentLabel: "Claude Code (interactive)",
    agentKind: "cli",
    status: "ready",
    repo: ID,
    baseSha: sha("a"),
    briefSha: sha("b"),
    headSha: sha("c"),
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:05:00.000Z",
    job: null,
    digest: {
      summary: "Touched site/index.html. Acceptance check passed.",
      satisfies: "yes",
      reasons: [],
      files: [{ path: "site/index.html", status: "modified", additions: 1, deletions: 1 }],
      checks: [{ path: "site/index.html", text: "ready for sea", ok: true }],
      unexpectedPaths: [],
      missedPaths: [],
      controlPaths: [],
      headSha: sha("c"),
      baseSha: sha("a"),
    },
    merge: { state: "clean", paths: [], mainSha: sha("d"), headSha: sha("c"), checkedAt: "2026-10-01T12:05:01.000Z" },
    review: { verdict: "satisfies", note: "Sets the lede the brief asks for.", model: "@cf/meta/llama", headSha: sha("c"), at: "2026-10-01T12:05:02.000Z" },
    replacedBy: null,
    replaces: null,
    discardReason: null,
    shippedSha: null,
    previewUrl: `/preview/harbor-notes-3f2a/${ID}/`,
    primary: "ship",
    secondary: ["park", "rerun"],
    ...over,
  }
}

function board(current: AttemptView, lane: BoardView["lanes"][number]["lane"], history: AttemptView[] = []): BoardView {
  const lanes = (["rerun", "ship", "review", "working", "parked", "shipped"] as const).map((l) => ({
    lane: l,
    tasks: l === lane ? [{ brief, lane, current, history }] : [],
  }))
  return {
    version: 7,
    project: {
      id: "harbor-notes-3f2a",
      name: "Harbor notes",
      description: "",
      createdAt: "2026-10-01T11:00:00.000Z",
      mainSha: sha("d"),
      counts: { rerun: 0, ship: 1, review: 0, working: 0, parked: 0, shipped: 0 },
      repo: "harbor-notes-3f2a",
      seed: "harbor",
      previewUrl: "/preview/harbor-notes-3f2a/main/",
    },
    lanes,
    activity: [],
    agents: [],
  }
}

function model(view: BoardView, base = BASE): PaneModel {
  return {
    job: { attemptId: ID, attemptNumber: 1, task: brief.task, dir: `/work/shipboard/${ID}`, briefPath: `.shipboard/briefs/${brief.id}.json` },
    brief: { ok: true, sha: "bbbbbbb", detail: "" },
    verdict: verdictOf(view, ID, base),
    pushedSha: sha("c"),
    note: null,
    ended: null,
  }
}

describe("pane", () => {
  it("shows a clean, satisfied fork with its checks, review, absolute preview URL and the Ship action", () => {
    const tree = renderPane(elements, model(board(attempt(), "ship")))
    const text = textOf(tree)
    expect(text).toContain("shipboard · attempt 1 · Claude Code")
    expect(text).toContain("Tint the pier name")
    expect(text).toContain("✓ bbbbbbb")
    expect(text).toContain(ID)
    expect(text).toContain("✓ clean vs main ddddddd")
    expect(text).toContain("Touched site/index.html. Acceptance check passed.")
    expect(text).toContain('✓ site/index.html "ready for sea"')
    expect(text).toContain("satisfies · Sets the lede the brief asks for.")
    expect(text).toContain(`http://127.0.0.1:8787/preview/harbor-notes-3f2a/${ID}/`)
    expect(text).toContain("▶ Ship")
    expect(text).toContain("a person decides")
  })

  it("shows a conflict with its paths and the Re-run action", () => {
    const view = board(attempt({ merge: { state: "conflict", paths: ["site/index.html", "README.md"], mainSha: sha("e"), headSha: sha("c"), checkedAt: "x" }, primary: "rerun" }), "rerun")
    const text = textOf(renderPane(elements, model(view)))
    expect(text).toContain("✗ conflict site/index.html, README.md")
    expect(text).toContain("↻ Re-run")
  })

  it("labels a clean fork that misses the brief Ship anyway", () => {
    const digest = { ...attempt().digest!, satisfies: "no" as const, summary: "Touched site/index.html. Acceptance check failed.", checks: [{ path: "site/index.html", text: "ready for sea", ok: false }], unexpectedPaths: ["README.md"] }
    const view = board(attempt({ digest, review: { ...attempt().review!, verdict: "off-brief" }, primary: "ship-anyway" }), "review")
    const text = textOf(renderPane(elements, model(view)))
    expect(text).toContain('✗ site/index.html "ready for sea"')
    expect(text).toContain("+README.md")
    expect(text).toContain("off-brief")
    expect(text).toContain("▶ Ship anyway")
  })

  it("shows an attempt a re-run replaced as discarded, with the reason", () => {
    const old = attempt({ status: "discarded", replacedBy: `${ID}-2`, discardReason: 'Conflicted with main in site/index.html after "Rename the pier mark" shipped.', primary: "none" })
    const view = board(attempt({ id: `${ID}-2`, number: 2, status: "waiting", digest: null, merge: null, review: null, previewUrl: null, primary: "wait" }), "working", [old])
    const text = textOf(renderPane(elements, model(view)))
    expect(text).toContain("discarded")
    expect(text).toContain(`→ ${ID}-2`)
    expect(text).toContain("Rename the pier mark")
    expect(oneLine(verdictOf(view, ID, BASE)!)).toContain("Stop working on it")
  })

  it("shows a fork still waiting for its first push as working", () => {
    const view = board(attempt({ status: "waiting", digest: null, merge: null, review: null, previewUrl: null, primary: "wait", headSha: sha("b") }), "working")
    const text = textOf(renderPane(elements, model(view)))
    expect(text).toContain("waiting for a push")
    expect(text).toContain("… working")
  })

  it("uses a Link only for URLs Claude Code accepts, and plain text otherwise", () => {
    const local = renderPane(elements, model(board(attempt(), "ship")))
    expect(findAll(local, "Link")).toHaveLength(0)
    const hosted = renderPane(elements, model(board(attempt(), "ship"), "https://shipboard.example.workers.dev"))
    expect(findAll(hosted, "Link").map((l) => l.props.href)).toEqual([`https://shipboard.example.workers.dev/preview/harbor-notes-3f2a/${ID}/`])
    expect(isLinkable("http://localhost:8787/preview/x/")).toBe(true)
    expect(isLinkable("http://127.0.0.1:8787/preview/x/")).toBe(false)
    expect(isLinkable("https://user:pw@example.com/")).toBe(false)
  })

  it("says how to start when there is no job", () => {
    const text = textOf(renderPane(elements, { job: null, brief: null, verdict: null, pushedSha: null, note: null, ended: "Finished x as pushed." }))
    expect(text).toContain("Finished x as pushed.")
    expect(text).toContain("/shipboard claim")
  })
})

describe("verdict text for Claude", () => {
  it("reads out merge, digest, checks, review, preview and the next action", () => {
    const lines = verdictLines(verdictOf(board(attempt(), "ship"), ID, BASE)!).join("\n")
    expect(lines).toContain("Merge: clean against main ddddddd.")
    expect(lines).toContain("Digest: Touched site/index.html. Acceptance check passed. (satisfies: yes)")
    expect(lines).toContain('pass: contains site/index.html "ready for sea"')
    expect(lines).toContain("Review (@cf/meta/llama): satisfies.")
    expect(lines).toContain(`Preview: ${BASE}/preview/harbor-notes-3f2a/${ID}/`)
    expect(lines).toContain("Board action: Ship. A person decides")
  })

  it("tells Claude not to resolve a conflict", () => {
    const view = board(attempt({ merge: { state: "conflict", paths: ["site/index.html"], mainSha: sha("e"), headSha: sha("c"), checkedAt: "x" }, primary: "rerun" }), "rerun")
    const lines = verdictLines(verdictOf(view, ID, BASE)!).join("\n")
    expect(lines).toContain("CONFLICT against main eeeeeee in site/index.html")
    expect(lines).toContain("Do not resolve the conflict")
  })

  it("finds nothing for an attempt the board does not list", () => {
    expect(verdictOf(board(attempt(), "ship"), "other--x-0000", BASE)).toBeNull()
  })
})
