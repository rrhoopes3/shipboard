import { describe, expect, it } from "vitest"
import { defaultAgents } from "../../src/core/agents.ts"
import {
  ACTIVITY_CAP,
  LANES,
  bumpVersion,
  currentAttempt,
  fingerprint,
  placement,
  pushActivity,
} from "../../src/core/state.ts"
import type { Attempt, Digest, MergeReport, ProjectState } from "../../src/core/types.ts"
import { boardView, projectSummary } from "../../src/core/views.ts"

const sha = (c: string) => c.repeat(40)

function digest(over: Partial<Digest> = {}): Digest {
  return {
    summary: "",
    satisfies: "yes",
    reasons: [],
    files: [],
    checks: [],
    unexpectedPaths: [],
    missedPaths: [],
    controlPaths: [],
    headSha: sha("c"),
    baseSha: sha("a"),
    ...over,
  }
}

function merge(state: MergeReport["state"]): MergeReport {
  return { state, paths: state === "conflict" ? ["site/index.html"] : [], mainSha: sha("a"), headSha: sha("c"), checkedAt: "" }
}

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: "p-0001--t-0001",
    briefId: "t-0001",
    number: 1,
    agent: "claude",
    status: "ready",
    repo: "p-0001--t-0001",
    baseSha: sha("a"),
    briefSha: sha("b"),
    headSha: sha("c"),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    digest: digest(),
    merge: merge("clean"),
    review: null,
    replacedBy: null,
    replaces: null,
    discardReason: null,
    shippedSha: null,
    ...over,
  }
}

describe("lanes and the one button", () => {
  it("follows the table in ARCHITECTURE.md row for row", () => {
    expect(placement(attempt({ merge: merge("conflict") }))).toEqual({ lane: "rerun", primary: "rerun", secondary: ["park"] })
    expect(placement(attempt({ status: "failed", digest: null, merge: null }))).toEqual({
      lane: "rerun",
      primary: "rerun",
      secondary: ["park"],
    })
    expect(placement(attempt())).toEqual({ lane: "ship", primary: "ship", secondary: ["park", "rerun"] })
    expect(placement(attempt({ digest: digest({ satisfies: "unchecked" }) })).lane).toBe("ship")
    const review = { lane: "review", primary: "ship-anyway", secondary: ["park", "rerun"] }
    expect(placement(attempt({ digest: digest({ satisfies: "no" }) }))).toEqual(review)
    expect(placement(attempt({ digest: digest({ controlPaths: [".shipboard/x"] }) }))).toEqual(review)
    expect(
      placement(attempt({ review: { verdict: "off-brief", note: "", model: "m", headSha: sha("c"), at: "" } })),
    ).toEqual(review)
    expect(
      placement(attempt({ review: { verdict: "partial", note: "One check needs a person.", model: "m", headSha: sha("c"), at: "" } })),
    ).toEqual(review)
    expect(
      placement(attempt({ review: { verdict: "satisfies", note: "Complete.", model: "m", headSha: sha("c"), at: "" } })),
    ).toEqual({ lane: "ship", primary: "ship", secondary: ["park", "rerun"] })
    // An old review is about the old head, even if it used to say partial or off-brief.
    for (const verdict of ["partial", "off-brief"] as const) {
      expect(placement(attempt({ review: { verdict, note: "Old head.", model: "m", headSha: sha("d"), at: "" } }))).toEqual({
        lane: "ship", primary: "ship", secondary: ["park", "rerun"],
      })
    }
    expect(placement(attempt({ status: "waiting", digest: null, merge: null }))).toEqual({
      lane: "working",
      primary: "wait",
      secondary: ["park"],
    })
    expect(placement(attempt({ status: "parked" }))).toEqual({ lane: "parked", primary: "unpark", secondary: ["rerun"] })
    expect(placement(attempt({ status: "shipped" }))).toEqual({ lane: "shipped", primary: "none", secondary: [] })
    expect(placement(attempt({ status: "discarded" }))).toEqual({ lane: null, primary: "none", secondary: [] })
    // A conflict wins over a failing digest.
    expect(placement(attempt({ merge: merge("conflict"), digest: digest({ satisfies: "no" }) })).lane).toBe("rerun")
    expect(placement(attempt({ merge: merge("conflict"), review: { verdict: "partial", note: "", model: "m", headSha: sha("c"), at: "" } })).lane).toBe("rerun")
  })

  it("orders lanes rerun, ship, review, working, parked, shipped", () => {
    expect(LANES).toEqual(["rerun", "ship", "review", "working", "parked", "shipped"])
  })
})

function state(attempts: Attempt[]): ProjectState {
  return {
    schema: 1,
    version: 3,
    project: { id: "p-0001", name: "P", description: "", createdAt: "", repo: "p-0001", mainSha: sha("a"), seed: "starter" },
    briefs: [
      { id: "t-0001", task: "T", constraints: [], acceptance: "", paths: ["a"], createdAt: "" },
      { id: "t-0002", task: "U", constraints: [], acceptance: "", paths: ["a"], createdAt: "" },
    ],
    attempts,
    jobs: [],
    activity: [],
    reconciledAt: 0,
  }
}

describe("state helpers", () => {
  it("caps activity at 200, newest last", () => {
    const s = state([])
    for (let i = 0; i < ACTIVITY_CAP + 25; i++) pushActivity(s, { kind: "pushed", text: `n${i}` }, `t${i}`)
    expect(s.activity).toHaveLength(ACTIVITY_CAP)
    expect(s.activity[0]?.text).toBe("n25")
    expect(s.activity.at(-1)?.text).toBe(`n${ACTIVITY_CAP + 24}`)
  })

  it("picks the newest non-discarded attempt as current", () => {
    const old = attempt({ status: "discarded", number: 1 })
    const fresh = attempt({ id: "p-0001--t-0002", number: 2, status: "waiting", digest: null, merge: null })
    expect(currentAttempt(state([old, fresh]), "t-0001")?.id).toBe("p-0001--t-0002")
    expect(currentAttempt(state([old]), "t-0001")?.id).toBe(old.id)
  })

  it("bumps the version and ignores bookkeeping in the change fingerprint", () => {
    const s = state([])
    const before = fingerprint(s)
    s.reconciledAt = 123
    expect(fingerprint(s)).toBe(before)
    expect(bumpVersion(s)).toBe(4)
    expect(fingerprint(s)).toBe(before)
    s.project.mainSha = sha("f")
    expect(fingerprint(s)).not.toBe(before)
  })

  it("builds a board with lanes, history and counts", () => {
    const shipped = attempt({ id: "p-0001--u-0001", briefId: "t-0002", status: "shipped", updatedAt: "2026-10-01T00:00:02.000Z" })
    const old = attempt({ status: "discarded", replacedBy: "p-0001--t-0002", discardReason: "Conflicted." })
    const fresh = attempt({ id: "p-0001--t-0002", number: 2, replaces: old.id, merge: merge("conflict") })
    const s = state([shipped, old, fresh])
    const board = boardView(s, defaultAgents())
    expect(board.version).toBe(3)
    expect(board.lanes.map((lane) => lane.lane)).toEqual([...LANES])
    const rerun = board.lanes[0]?.tasks[0]
    expect(rerun?.current.id).toBe("p-0001--t-0002")
    expect(rerun?.current.primary).toBe("rerun")
    expect(rerun?.current.agentLabel).toBe("Claude Code")
    expect(rerun?.history.map((h) => h.id)).toEqual([old.id])
    expect(rerun?.history[0]?.primary).toBe("none")
    expect(board.project.previewUrl).toBe("/preview/p-0001/main/")
    expect(projectSummary(s).counts).toEqual({ rerun: 1, ship: 0, review: 0, working: 0, parked: 0, shipped: 1 })
  })
})
