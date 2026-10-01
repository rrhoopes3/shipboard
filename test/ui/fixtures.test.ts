/**
 * The UI's fixtures (public/fixtures, used by ?fixture=<name>) are its contract test: every JSON
 * file must have exactly the shapes in src/core/types.ts and docs/ARCHITECTURE.md, and each board
 * must obey the lane table. The schema below is typed against the contract, so `tsc` fails when
 * types.ts gains a field the fixtures do not cover.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { ProjectHandle } from "../../src/core/ports.ts"
import type {
  Action,
  Activity,
  AgentInfo,
  AttemptView,
  BoardView,
  Brief,
  CheckResult,
  Digest,
  FileStat,
  JobOutcome,
  JobView,
  Lane,
  MergeReport,
  ProjectSummary,
  Review,
  TaskView,
} from "../../src/core/types.ts"
import { FIXTURE_DIR, buildFixtures } from "./build-fixtures.ts"
import { arr, bool, iso, lit, nullable, num, obj, optional, sha40, str, validate } from "./schema.ts"

// ------------------------------------------------------------------ the contract, as schemas

const LANES = ["rerun", "ship", "review", "working", "parked", "shipped"] as const satisfies readonly Lane[]
const action = lit<Action>("ship", "ship-anyway", "rerun", "park", "unpark", "wait", "none")

const agentInfo = obj<AgentInfo>({ id: str, label: str, kind: lit("cli", "demo", "manual"), lastSeenAt: optional(iso) })
const brief = obj<Brief>({ id: str, task: str, constraints: arr(str), acceptance: str, paths: arr(str), createdAt: iso, demo: optional(str) })
const fileStat = obj<FileStat>({ path: str, status: lit("added", "modified", "deleted"), additions: num, deletions: num })
const checkResult = obj<CheckResult>({ path: str, text: str, ok: bool })
const digest = obj<Digest>({
  summary: str,
  satisfies: lit("yes", "no", "unchecked"),
  reasons: arr(str),
  files: arr(fileStat),
  checks: arr(checkResult),
  unexpectedPaths: arr(str),
  missedPaths: arr(str),
  controlPaths: arr(str),
  headSha: sha40,
  baseSha: sha40,
})
const merge = obj<MergeReport>({ state: lit("clean", "conflict"), paths: arr(str), mainSha: sha40, headSha: sha40, checkedAt: iso })
const review = obj<Review>({ verdict: lit("satisfies", "partial", "off-brief"), note: str, model: str, headSha: sha40, at: iso })
const outcome = obj<JobOutcome>({
  reason: lit("pushed", "no_changes", "agent_error", "timeout", "auth", "brief_mismatch", "unsafe_repo_config", "push_rejected", "lease_expired"),
  summary: str,
  commitSha: optional(sha40),
  changedPaths: optional(arr(str)),
  costUsd: optional(num),
  turns: optional(num),
  sessionId: optional(str),
  durationMs: optional(num),
})
const jobView = obj<JobView>({
  attemptId: str,
  agent: str,
  state: lit("queued", "running", "done", "failed"),
  queuedAt: iso,
  runnerId: optional(str),
  claimedAt: optional(iso),
  leaseExpiresAt: optional(iso),
  finishedAt: optional(iso),
  outcome: optional(outcome),
  agentLabel: str,
})
const attemptView = obj<AttemptView>({
  id: str,
  briefId: str,
  number: num,
  agent: str,
  agentLabel: str,
  agentKind: lit("cli", "demo", "manual"),
  status: lit("waiting", "ready", "shipped", "parked", "discarded", "failed"),
  repo: str,
  baseSha: sha40,
  briefSha: sha40,
  headSha: sha40,
  createdAt: iso,
  updatedAt: iso,
  job: nullable(jobView),
  digest: nullable(digest),
  merge: nullable(merge),
  review: nullable(review),
  replacedBy: nullable(str),
  replaces: nullable(str),
  discardReason: nullable(str),
  shippedSha: nullable(sha40),
  previewUrl: nullable(str),
  primary: action,
  secondary: arr(action),
})
const taskView = obj<TaskView>({ brief, lane: lit(...LANES), current: attemptView, history: arr(attemptView) })
const counts = obj<Record<Lane, number>>({ rerun: num, ship: num, review: num, working: num, parked: num, shipped: num })
const projectSummary = obj<ProjectSummary>({ id: str, name: str, description: str, createdAt: iso, mainSha: sha40, counts })
const activity = obj<Activity>({
  at: iso,
  kind: lit("project", "dispatched", "claimed", "pushed", "assessed", "conflict", "shipped", "rerun", "parked", "unparked", "failed"),
  text: str,
  briefId: optional(str),
  attemptId: optional(str),
  agent: optional(str),
})
const boardView = obj<BoardView>({
  version: num,
  project: obj<BoardView["project"]>({
    id: str,
    name: str,
    description: str,
    createdAt: iso,
    mainSha: sha40,
    counts,
    repo: str,
    seed: lit("starter", "harbor", "import"),
    previewUrl: str,
  }),
  lanes: arr(obj<BoardView["lanes"][number]>({ lane: lit(...LANES), tasks: arr(taskView) })),
  activity: arr(activity),
  agents: arr(agentInfo),
})

/** GET /api/config, as docs/ARCHITECTURE.md describes it. */
type ConfigResponse = { mode: "local" | "cloudflare"; publicRead: boolean; boardAuth: boolean; agents: AgentInfo[]; namespace?: string }
const config = obj<ConfigResponse>({ mode: lit("local", "cloudflare"), publicRead: bool, boardAuth: bool, agents: arr(agentInfo), namespace: optional(str) })
const projects = obj<{ projects: ProjectSummary[] }>({ projects: arr(projectSummary) })
type DiffResponse = Awaited<ReturnType<ProjectHandle["diff"]>>
const diff = obj<DiffResponse>({ diff: str, truncated: bool, base: sha40, head: sha40 })

// ------------------------------------------------------------------ what is on disk

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [path.relative(FIXTURE_DIR, full).split(path.sep).join("/")]
  })
}

const files = walk(FIXTURE_DIR).sort()
const read = (rel: string): unknown => JSON.parse(readFileSync(path.join(FIXTURE_DIR, rel), "utf8"))
const json = files.filter((f) => f.endsWith(".json"))
const boardFiles = json.filter((f) => /\/board(-[a-z0-9-]+)?\.json$/.test(f))
const boards = new Map(boardFiles.map((f) => [f, read(f) as BoardView]))

// The lane table in docs/ARCHITECTURE.md.
const PLACEMENT: Record<Lane, { primary: Action; secondary: Action[]; statuses: AttemptView["status"][] }> = {
  rerun: { primary: "rerun", secondary: ["park"], statuses: ["ready", "failed"] },
  ship: { primary: "ship", secondary: ["park", "rerun"], statuses: ["ready"] },
  review: { primary: "ship-anyway", secondary: ["park", "rerun"], statuses: ["ready"] },
  working: { primary: "wait", secondary: ["park"], statuses: ["waiting", "ready"] },
  parked: { primary: "unpark", secondary: ["rerun"], statuses: ["parked"] },
  shipped: { primary: "none", secondary: [], statuses: ["shipped"] },
}

describe("UI fixtures", () => {
  it("are what test/ui/build-fixtures.ts produces", () => {
    const built = buildFixtures()
    expect(files).toEqual([...built.keys()].sort())
    for (const [rel, text] of built) expect(readFileSync(path.join(FIXTURE_DIR, rel), "utf8"), rel).toBe(text)
  })

  it("include a config, a project list, and boards for the main set", () => {
    expect(files).toContain("harbor/config.json")
    expect(files).toContain("harbor/projects.json")
    expect(files).toContain("harbor/board.json")
    expect(files).toContain("harbor/board-rerun.json")
    expect(boardFiles.length).toBeGreaterThanOrEqual(5)
    expect(json.some((f) => /\/diff-.+\.json$/.test(f))).toBe(true)
  })

  it.each(json.filter((f) => f.endsWith("/config.json")))("%s matches GET /api/config", (f) => {
    expect(validate(config, read(f))).toEqual([])
  })

  it.each(json.filter((f) => f.endsWith("/projects.json")))("%s matches GET /api/projects", (f) => {
    expect(validate(projects, read(f))).toEqual([])
  })

  it.each(json.filter((f) => /\/diff-.+\.json$/.test(f)))("%s matches GET /api/attempts/:id/diff", (f) => {
    expect(validate(diff, read(f))).toEqual([])
  })

  describe.each(boardFiles)("%s", (f) => {
    const board = boards.get(f) as BoardView

    it("matches BoardView exactly", () => {
      expect(validate(boardView, board)).toEqual([])
    })

    it("keeps the lane order, counts and in-lane order", () => {
      expect(board.lanes.map((l) => l.lane)).toEqual([...LANES])
      for (const { lane, tasks } of board.lanes) {
        expect(board.project.counts[lane]).toBe(tasks.length)
        const times = tasks.map((t) => t.current.updatedAt)
        expect(times).toEqual([...times].sort().reverse())
        for (const t of tasks) expect(t.lane).toBe(lane)
      }
    })

    it("gives every card the one button the lane table says", () => {
      for (const { lane, tasks } of board.lanes) {
        for (const t of tasks) {
          const rule = PLACEMENT[lane]
          expect(t.current.primary, t.brief.task).toBe(rule.primary)
          expect(t.current.secondary, t.brief.task).toEqual(rule.secondary)
          expect(rule.statuses, t.brief.task).toContain(t.current.status)
          if (lane === "rerun" && t.current.status === "ready") expect(t.current.merge?.state).toBe("conflict")
          if (lane === "ship") expect(t.current.digest?.satisfies).not.toBe("no")
        }
      }
    })

    it("keeps attempts, briefs, history and previews consistent", () => {
      const pid = board.project.id
      expect(board.project.repo).toBe(pid)
      expect(board.project.previewUrl).toBe(`/preview/${pid}/main/`)
      const labels = new Map(board.agents.map((a) => [a.id, a.label]))
      for (const { tasks } of board.lanes) {
        for (const t of tasks) {
          const all = [t.current, ...t.history]
          for (const a of all) {
            expect(a.id.startsWith(`${pid}--`), a.id).toBe(true)
            expect(a.repo).toBe(a.id)
            expect(a.briefId).toBe(t.brief.id)
            expect(a.agentLabel).toBe(labels.get(a.agent))
            expect(a.previewUrl).toBe(a.headSha === a.briefSha ? null : `/preview/${pid}/${a.id}/`)
            if (a.job) expect(a.job.attemptId).toBe(a.id)
            if (a.digest) expect([a.digest.headSha, a.digest.baseSha]).toEqual([a.headSha, a.baseSha])
            if (a.merge) expect(a.merge.headSha).toBe(a.headSha)
          }
          expect(t.current.status).not.toBe("discarded")
          expect(t.current.number).toBe(t.history.length + 1)
          t.history.forEach((p, i) => {
            expect(["discarded", "failed"]).toContain(p.status)
            expect(p.primary).toBe("none")
            expect(p.secondary).toEqual([])
            expect(p.number).toBe(t.current.number - 1 - i)
            expect(p.replacedBy).toBe(i === 0 ? t.current.id : t.history[i - 1]?.id)
            expect(p.discardReason).toBeTruthy()
          })
          if (t.history.length) expect(t.current.replaces).toBe(t.history[0]?.id)
        }
      }
    })

    it("narrates in activity, newest last, about briefs on the board", () => {
      const at = board.activity.map((a) => a.at)
      expect(at).toEqual([...at].sort())
      const briefs = new Set(board.lanes.flatMap((l) => l.tasks.map((t) => t.brief.id)))
      for (const a of board.activity) if (a.briefId) expect(briefs.has(a.briefId), a.text).toBe(true)
    })
  })

  it("lists every project it has a board for, with matching counts", () => {
    for (const f of json.filter((x) => x.endsWith("/projects.json"))) {
      for (const p of (read(f) as { projects: ProjectSummary[] }).projects) {
        // The fixture layer answers GET /api/projects/:id from board.json, or board-<id>.json.
        const main = boards.get(f.replace(/projects\.json$/, "board.json"))
        const own = main?.project.id === p.id ? main : boards.get(f.replace(/projects\.json$/, `board-${p.id}.json`))
        expect(own, p.id).toBeTruthy()
        expect(own?.project.counts).toEqual(p.counts)
        expect(own?.project.mainSha).toBe(p.mainSha)
      }
    }
  })

  it("has diffs that describe the attempts on the boards", () => {
    const attempts = new Map<string, AttemptView>()
    for (const b of boards.values()) for (const l of b.lanes) for (const t of l.tasks) for (const a of [t.current, ...t.history]) attempts.set(a.id, a)
    for (const f of json.filter((x) => /\/diff-.+\.json$/.test(x))) {
      const id = /diff-(.+)\.json$/.exec(f)?.[1] ?? ""
      const a = attempts.get(id)
      expect(a, f).toBeTruthy()
      const d = read(f) as DiffResponse
      expect([d.base, d.head]).toEqual([a?.baseSha, a?.headSha])
      const stats = a?.digest?.files ?? []
      for (const s of stats) expect(d.diff).toContain(`diff --git a/${s.path} b/${s.path}`)
    }
  })

  it("has meta.json transitions and previews that point at real files", () => {
    for (const f of json.filter((x) => x.endsWith("/meta.json"))) {
      const meta = read(f) as {
        extends?: string
        transitions?: Record<string, { board: string; then?: { board: string } }>
        previews?: Record<string, string>
        demo?: { projectId: string }
      }
      const dir = path.dirname(f)
      if (meta.extends) expect(existsSync(path.join(FIXTURE_DIR, meta.extends, "meta.json"))).toBe(true)
      for (const t of Object.values(meta.transitions ?? {})) {
        expect(files).toContain(`${dir}/${t.board}`)
        if (t.then) expect(files).toContain(`${dir}/${t.then.board}`)
      }
      for (const url of Object.values(meta.previews ?? {})) expect(files).toContain(url.replace(/^\/fixtures\//, ""))
      if (meta.demo) expect([...boards.values()].some((b) => b.project.id === meta.demo?.projectId)).toBe(true)
    }
  })

  it("show the re-run story: a conflict, then the same brief on a fresh fork", () => {
    const before = boards.get("harbor/board.json") as BoardView
    const after = boards.get("harbor/board-rerun.json") as BoardView
    const conflict = before.lanes.find((l) => l.lane === "rerun")?.tasks[0]
    expect(conflict?.current.merge?.state).toBe("conflict")
    const rerun = after.lanes.flatMap((l) => l.tasks).find((t) => t.brief.id === conflict?.brief.id)
    expect(rerun?.lane).toBe("working")
    expect(rerun?.current.number).toBe(2)
    expect(rerun?.brief).toEqual(conflict?.brief)
    expect(rerun?.current.baseSha).toBe(before.project.mainSha)
    expect(rerun?.history[0]?.status).toBe("discarded")
    expect(rerun?.history[0]?.discardReason).toMatch(/^Conflicted with main in site\/index\.html after ".+" shipped\.$/)
  })
})
