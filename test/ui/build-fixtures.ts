/**
 * Builds public/fixtures/** (the UI's fixture mode, ?fixture=<name>) from project timelines,
 * so every board, diff and preview agrees with the others and with
 * src/core/types.ts. Diffs are real unified diffs of real file contents, in core/git.ts's format.
 *
 *   npx tsx test/ui/build-fixtures.ts        rewrites the files
 *
 * test/ui/fixtures.test.ts checks that the files on disk equal this output and match the contract.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { structuredPatch } from "diff"
import { buildDigest, parseChecks } from "../../src/core/digest.ts"
import { slug } from "../../src/core/names.ts"
import { boardView } from "../../src/core/views.ts"
import type {
  Activity,
  ActivityKind,
  AgentInfo,
  AgentKind,
  Attempt,
  BoardView,
  Brief,
  Digest,
  FileStat,
  Job,
  MergeReport,
  Project,
  ProjectState,
  ProjectSummary,
  Review,
} from "../../src/core/types.ts"

// ------------------------------------------------------------------ names, shas and time (as core/names.ts)

/** A stable 40-hex sha per label, so fixtures do not churn between builds. */
function shaOf(label: string): string {
  let x = 0x811c9dc5
  for (let i = 0; i < label.length; i++) x = Math.imul(x ^ label.charCodeAt(i), 0x01000193) >>> 0
  let out = ""
  for (let i = 0; i < 40; i++) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    out += "0123456789abcdef"[x & 15]
  }
  return out
}

const short = (sha: string) => sha.slice(0, 7)
const T = (hms: string, day = "2026-10-01") => `${day}T${hms}.000Z`
const plusSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString()

// ------------------------------------------------------------------ agents (as core/agents.ts)

const AGENT_INFO: Record<string, { label: string; kind: AgentKind }> = {
  demo: { label: "Demo (scripted)", kind: "demo" },
  manual: { label: "Manual (you push)", kind: "manual" },
  claude: { label: "Claude Code", kind: "cli" },
  codex: { label: "Codex", kind: "cli" },
  grok: { label: "Grok", kind: "cli" },
  cursor: { label: "Cursor", kind: "cli" },
}

function agentList(seen: Record<string, string>): AgentInfo[] {
  return Object.entries(AGENT_INFO).map(([id, info]) => {
    const out: AgentInfo = { id, label: info.label, kind: info.kind }
    const at = seen[id]
    if (at) out.lastSeenAt = at
    return out
  })
}

const label = (agent: string) => AGENT_INFO[agent]?.label ?? agent

// ------------------------------------------------------------------ site content (as core/seeds.ts and core/demo.ts)

type Files = Record<string, string>

const NOTICE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Northline</title>
<style>
  body { margin: 2rem; font-family: Georgia, serif; background: #e7eef0; color: #102126; }
  .eyebrow { letter-spacing: 0.08em; text-transform: uppercase; font-size: 0.75rem; }
  h1 { font-weight: 500; font-size: 2.5rem; margin: 0.3rem 0; }
  footer { margin-top: 2rem; font-size: 0.95rem; }
</style>
</head>
<body>
  <p class="eyebrow">Pier notices</p>
  <h1 id="mark">Northline</h1>
  <p id="lede">The tide book for this week is posted at the shed.</p>
</body>
</html>
`

const MARK = /<h1 id="mark"([^>]*)>([\s\S]*?)<\/h1>/

type Edit = (files: Files) => Files
const edit = (file: string, fn: (text: string) => string): Edit => (files) => ({ ...files, [file]: fn(files[file] ?? "") })
const withFile = (file: string, text: string): Edit => (files) => ({ ...files, [file]: text })
const apply = (files: Files, ...edits: Edit[]) => edits.reduce((acc, e) => e(acc), files)

const EDITS = {
  markColor: edit("site/index.html", (html) =>
    html.replace(MARK, (_m, attrs: string, inner: string) => `<h1 id="mark"${attrs.replace(/\s*style="[^"]*"/g, "")} style="color:#1F6F78">${inner}</h1>`),
  ),
  markName: edit("site/index.html", (html) => html.replace(MARK, (_m, attrs: string) => `<h1 id="mark"${attrs}>Northline night board</h1>`)),
  footer: edit("site/index.html", (html) => html.replace("</body>", "<footer>Posted by the night clerk.</footer>\n</body>")),
  slipway: edit("site/index.html", (html) => html.replace("</body>", '<p id="slipway">The slipway is closed on Sundays.</p>\n</body>')),
  storm: edit("site/index.html", (html) =>
    html.replace('  <h1 id="mark"', '  <p id="warning">Small craft warning until Thursday morning. Moor with extra lines.</p>\n  <h1 id="mark"'),
  ),
  footerCopy: edit("site/index.html", (html) => html.replace("Posted by the night clerk.", "Posted nightly by the clerk.")),
  readmeBlurb: edit("README.md", (text) => text.replace("Pier notices for the Northline night shift.", "A pier notice for the night shift.\nPosted nightly by the clerk.")),
  controlNote: withFile(".shipboard/review-notes.md", "Agent-written review notes do not belong in the brief directory.\n"),
  tides: withFile(
    "site/tides.html",
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Tides · Northline</title>
<style>
  body { margin: 2rem; font-family: Georgia, serif; background: #e7eef0; color: #102126; }
  table { border-collapse: collapse; }
  th, td { padding: 0.3rem 1.2rem 0.3rem 0; text-align: left; }
</style>
</head>
<body>
  <p class="eyebrow">Pier notices</p>
  <h1>Tides this week</h1>
  <table>
    <tr><th>Day</th><th>High water</th><th>Low water</th></tr>
    <tr><td>Thu</td><td>04:12 · 16:38</td><td>10:25 · 22:51</td></tr>
    <tr><td>Fri</td><td>05:01 · 17:24</td><td>11:14 · 23:37</td></tr>
    <tr><td>Sat</td><td>05:47 · 18:09</td><td>12:00</td></tr>
    <tr><td>Sun</td><td>06:31 · 18:52</td><td>00:21 · 12:44</td></tr>
  </table>
  <p>Times are local. Read top to bottom.</p>
</body>
</html>
`,
  ),
}

// ------------------------------------------------------------------ diffs (as core/git.ts describe())

function fileDiff(file: string, before: string | undefined, after: string | undefined): { patch: string; stat: FileStat } {
  const status: FileStat["status"] = before === undefined ? "added" : after === undefined ? "deleted" : "modified"
  let header = `diff --git a/${file} b/${file}\n`
  if (status === "added") header += "new file mode 100644\n"
  else if (status === "deleted") header += "deleted file mode 100644\n"
  const left = status === "added" ? "/dev/null" : `a/${file}`
  const right = status === "deleted" ? "/dev/null" : `b/${file}`
  const stat: FileStat = { path: file, status, additions: 0, deletions: 0 }
  const patch = structuredPatch(left, right, before ?? "", after ?? "", undefined, undefined, { context: 3 })
  let body = ""
  for (const hunk of patch.hunks) {
    const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart
    const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart
    body += `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@\n`
    for (const line of hunk.lines) {
      if (line.startsWith("+")) stat.additions++
      else if (line.startsWith("-")) stat.deletions++
      body += `${line}\n`
    }
  }
  return { stat, patch: body ? `${header}--- ${left}\n+++ ${right}\n${body}` : header }
}

function treeDiff(base: Files, head: Files): { diff: string; files: FileStat[] } {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((p) => base[p] !== head[p]).sort()
  let diff = ""
  const files: FileStat[] = []
  for (const p of paths) {
    const { patch, stat } = fileDiff(p, base[p], head[p])
    diff += patch
    files.push(stat)
  }
  return { diff, files }
}

// ------------------------------------------------------------------ core digest and board view

function digestOf(brief: Brief, base: Files, head: Files, baseSha: string, headSha: string): Digest {
  const files = treeDiff(base, head).files
  const checks = parseChecks(brief.acceptance).map(({ path, text }) => ({ path, text, ok: (head[path] ?? "").includes(text) }))
  return buildDigest({ brief, files, checks, baseSha, headSha })
}

type Scene = Pick<ProjectState, "version" | "project" | "briefs" | "attempts" | "jobs" | "activity"> & { agents: AgentInfo[] }

function boardOf(scene: Scene): BoardView {
  const { agents, ...state } = scene
  return boardView({ schema: 1, reconciledAt: 0, ...state }, agents)
}

const summaryOf = (board: BoardView): ProjectSummary => {
  const { id, name, description, createdAt, mainSha, counts } = board.project
  return { id, name, description, createdAt, mainSha, counts }
}

// ------------------------------------------------------------------ building blocks for scenes

const REVIEW_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

function briefOf(task: string, constraints: string[], acceptance: string, paths: string[], createdAt: string, hex: string, demo?: string): Brief {
  const out: Brief = { id: `${slug(task, 20)}-${hex}`, task, constraints, acceptance, paths, createdAt }
  if (demo) out.demo = demo
  return out
}

const attemptIdOf = (projectId: string, brief: Brief, hex: string) => `${projectId}--${slug(brief.task, 16)}-${hex}`

type Fork = {
  brief: Brief
  id: string
  number: number
  agent: string
  base: Files
  baseSha: string
  createdAt: string
  edits: Edit[]
}

/** The head files and shas of a fork whose agent applied `edits` on top of its base. */
function forkHead(f: Fork) {
  const head = apply(f.base, ...f.edits)
  const briefSha = shaOf(`${f.id}:brief`)
  const headSha = f.edits.length ? shaOf(`${f.id}:head`) : briefSha
  return { head, briefSha, headSha }
}

function readyAttempt(f: Fork, o: { updatedAt: string; mainSha: string; checkedAt: string; conflict?: string[]; review?: Review | null; status?: Attempt["status"] }): Attempt {
  const { head, briefSha, headSha } = forkHead(f)
  const merge: MergeReport = { state: o.conflict ? "conflict" : "clean", paths: o.conflict ?? [], mainSha: o.mainSha, headSha, checkedAt: o.checkedAt }
  return {
    id: f.id,
    briefId: f.brief.id,
    number: f.number,
    agent: f.agent,
    status: o.status ?? "ready",
    repo: f.id,
    baseSha: f.baseSha,
    briefSha,
    headSha,
    createdAt: f.createdAt,
    updatedAt: o.updatedAt,
    digest: digestOf(f.brief, f.base, head, f.baseSha, headSha),
    merge,
    review: o.review ?? null,
    replacedBy: null,
    replaces: null,
    discardReason: null,
    shippedSha: null,
  }
}

function waitingAttempt(f: Fork, updatedAt: string, status: Attempt["status"] = "waiting"): Attempt {
  const briefSha = shaOf(`${f.id}:brief`)
  return {
    id: f.id,
    briefId: f.brief.id,
    number: f.number,
    agent: f.agent,
    status,
    repo: f.id,
    baseSha: f.baseSha,
    briefSha,
    headSha: briefSha,
    createdAt: f.createdAt,
    updatedAt,
    digest: null,
    merge: null,
    review: null,
    replacedBy: null,
    replaces: null,
    discardReason: null,
    shippedSha: null,
  }
}

const review = (verdict: Review["verdict"], note: string, headSha: string, at: string): Review => ({ verdict, note, model: REVIEW_MODEL, headSha, at })

function doneJob(f: Fork, runnerId: string, queuedAt: string, claimedAt: string, finishedAt: string, summary: string): Job {
  const { head, headSha } = forkHead(f)
  return {
    attemptId: f.id,
    agent: f.agent,
    state: "done",
    queuedAt,
    runnerId,
    claimedAt,
    leaseExpiresAt: plusSeconds(finishedAt, 150),
    finishedAt,
    outcome: { reason: "pushed", summary, commitSha: headSha, changedPaths: treeDiff(f.base, head).files.map((x) => x.path) },
  }
}

function act(at: string, kind: ActivityKind, text: string, extra: { briefId?: string; attemptId?: string; agent?: string } = {}): Activity {
  const out: Activity = { at, kind, text }
  if (extra.briefId) out.briefId = extra.briefId
  if (extra.attemptId) out.attemptId = extra.attemptId
  if (extra.agent) out.agent = extra.agent
  return out
}

const q = (task: string) => `"${task}"`

type Out = { files: Map<string, string> }

function writeJson(out: Out, file: string, value: unknown) {
  out.files.set(file, JSON.stringify(value, null, 2) + "\n")
}

function diffFile(out: Out, set: string, f: Fork) {
  const { head, headSha } = forkHead(f)
  writeJson(out, `${set}/diff-${f.id}.json`, { diff: treeDiff(f.base, head).diff, truncated: false, base: f.baseSha, head: headSha })
}

function previewFile(out: Out, name: string, files: Files, page = "site/index.html") {
  out.files.set(`harbor/previews/${name}.html`, files[page] ?? "")
  return `/fixtures/harbor/previews/${name}.html`
}

// ------------------------------------------------------------------ the harbor demo project (scripted demo agent)

function harborProject(out: Out, previews: Record<string, string>) {
  const id = "harbor-notes-3f2a"
  const created = T("21:12:10")
  const seed: Files = {
    "README.md": "# Harbor notes\n\nA pier notice used to show fork, digest, trial merge, ship, and re-run.\n",
    "site/index.html": NOTICE,
  }
  const main0 = shaOf(`${id}:main0`)
  const project: Project = {
    id,
    name: "Harbor notes",
    description: "Three agents, one notice. Ship what merges. When one conflicts, re-run it on current main.",
    createdAt: created,
    repo: id,
    mainSha: main0,
    seed: "harbor",
  }
  const tint = briefOf("Tint the pier name in channel teal", ["Leave the notice text alone", "Touch only site/index.html"], 'contains site/index.html "color:#1F6F78"', ["site/index.html"], plusSeconds(created, 0.2), "9c01", "mark-color")
  const rename = briefOf("Rename the pier mark to the night board", ["Keep the mark element", "Touch only site/index.html"], 'contains site/index.html "Northline night board"', ["site/index.html"], plusSeconds(created, 0.4), "41d7", "mark-name")
  const footer = briefOf("Add the night clerk footer", ["Do not change the pier name", "Touch only site/index.html"], 'contains site/index.html "Posted by the night clerk."', ["site/index.html"], plusSeconds(created, 0.6), "e5a0", "footer")

  const fork = (brief: Brief, hex: string, number: number, base: Files, baseSha: string, createdAt: string, edits: Edit[]): Fork => ({ brief, id: attemptIdOf(id, brief, hex), number, agent: "demo", base, baseSha, createdAt, edits })
  const tint1 = fork(tint, "3b1c", 1, seed, main0, tint.createdAt, [EDITS.markColor])
  const rename1 = fork(rename, "a20e", 1, seed, main0, rename.createdAt, [EDITS.markName])
  const footer1 = fork(footer, "6c42", 1, seed, main0, footer.createdAt, [EDITS.footer])

  const afterRename = apply(seed, EDITS.markName)
  const mainR = shaOf(`${id}:mainR`)
  const shipR = T("21:14:05")
  const tint2 = fork(tint, "77de", 2, afterRename, mainR, T("21:14:40"), [EDITS.markColor])
  const afterTint = apply(afterRename, EDITS.markColor)
  const mainT = shaOf(`${id}:mainT`)

  const demoJob = (f: Fork, at: string) => doneJob(f, "demo", f.createdAt, f.createdAt, at, `Edited site/index.html.`)
  const agents = agentList({ claude: T("21:14:24"), codex: T("21:13:52"), grok: T("21:13:31"), cursor: T("21:04:10") })

  const early: Activity[] = [
    act(created, "project", "Created Harbor notes from the harbor demo."),
    ...[tint1, rename1, footer1].map((f) => act(f.createdAt, "dispatched", `Dispatched ${q(f.brief.task)} to Demo (scripted).`, { briefId: f.brief.id, attemptId: f.id, agent: "demo" })),
  ]
  const pushes = (f: Fork, at: string): Activity[] => {
    const { headSha } = forkHead(f)
    const d = digestOf(f.brief, f.base, apply(f.base, ...f.edits), f.baseSha, headSha)
    return [
      act(at, "pushed", `Demo (scripted) pushed ${short(headSha)} for ${q(f.brief.task)}.`, { briefId: f.brief.id, attemptId: f.id, agent: "demo" }),
      act(at, "assessed", `Assessed ${q(f.brief.task)}: ${d.summary}`, { briefId: f.brief.id, attemptId: f.id, agent: "demo" }),
    ]
  }
  const conflictScene: Activity[] = [
    ...early,
    ...pushes(tint1, T("21:12:11")),
    ...pushes(rename1, T("21:12:11")),
    ...pushes(footer1, T("21:12:12")),
    act(shipR, "shipped", `Shipped ${q(rename.task)} to main at ${short(mainR)}.`, { briefId: rename.id, attemptId: rename1.id, agent: "demo" }),
    act(shipR, "conflict", `${q(tint.task)} conflicts with main in site/index.html. Re-run it on current main.`, { briefId: tint.id, attemptId: tint1.id, agent: "demo" }),
  ]

  const renameShipped: Attempt = { ...readyAttempt(rename1, { updatedAt: shipR, mainSha: main0, checkedAt: T("21:12:11") }), status: "shipped", shippedSha: mainR }
  const footerReady = (mainSha: string, checkedAt: string) => readyAttempt(footer1, { updatedAt: checkedAt, mainSha, checkedAt })
  const tint1Conflict = readyAttempt(tint1, { updatedAt: shipR, mainSha: mainR, checkedAt: shipR, conflict: ["site/index.html"] })
  const jobsBase = [demoJob(tint1, T("21:12:11")), demoJob(rename1, T("21:12:11")), demoJob(footer1, T("21:12:12"))]

  const board0 = boardOf({
    version: 11,
    project: { ...project, mainSha: mainR },
    briefs: [tint, rename, footer],
    attempts: [tint1Conflict, renameShipped, footerReady(mainR, shipR)],
    jobs: jobsBase,
    activity: conflictScene,
    agents,
  })

  // Re-run: attempt 1 is discarded with one sentence; attempt 2 forks the new main with the same brief.
  const rerunAt = T("21:14:40")
  const reason = "Conflicted with main in site/index.html."
  const tint1Discarded: Attempt = { ...tint1Conflict, status: "discarded", updatedAt: rerunAt, replacedBy: tint2.id, discardReason: reason }
  const tint2Waiting: Attempt = { ...waitingAttempt(tint2, rerunAt), replaces: tint1.id }
  const rerunActivity = act(rerunAt, "rerun", `Re-ran ${q(tint.task)} as attempt 2 on main ${short(mainR)}. Attempt 1 was discarded: ${reason}`, { briefId: tint.id, attemptId: tint2.id, agent: "demo" })
  const board1 = boardOf({
    version: 12,
    project: { ...project, mainSha: mainR },
    briefs: [tint, rename, footer],
    attempts: [tint1Discarded, tint2Waiting, renameShipped, footerReady(mainR, shipR)],
    jobs: [...jobsBase, { attemptId: tint2.id, agent: "demo", state: "running", queuedAt: rerunAt, runnerId: "demo", claimedAt: rerunAt, leaseExpiresAt: plusSeconds(rerunAt, 180) }],
    activity: [...conflictScene, rerunActivity],
    agents,
  })

  const pushedAt = T("21:14:42")
  const tint2Ready: Attempt = { ...readyAttempt(tint2, { updatedAt: pushedAt, mainSha: mainR, checkedAt: pushedAt }), replaces: tint1.id }
  const board2 = boardOf({
    version: 14,
    project: { ...project, mainSha: mainR },
    briefs: [tint, rename, footer],
    attempts: [tint1Discarded, tint2Ready, renameShipped, footerReady(mainR, shipR)],
    jobs: [...jobsBase, demoJob(tint2, pushedAt)],
    activity: [...conflictScene, rerunActivity, ...pushes(tint2, pushedAt)],
    agents,
  })

  const shipT = T("21:14:58")
  const board3 = boardOf({
    version: 15,
    project: { ...project, mainSha: mainT },
    briefs: [tint, rename, footer],
    attempts: [tint1Discarded, { ...tint2Ready, status: "shipped", updatedAt: shipT, shippedSha: mainT }, renameShipped, footerReady(mainT, shipT)],
    jobs: [...jobsBase, demoJob(tint2, pushedAt)],
    activity: [...conflictScene, rerunActivity, ...pushes(tint2, pushedAt), act(shipT, "shipped", `Shipped ${q(tint.task)} to main at ${short(mainT)}.`, { briefId: tint.id, attemptId: tint2.id, agent: "demo" })],
    agents,
  })

  writeJson(out, "harbor/board.json", board0)
  writeJson(out, "harbor/board-rerun.json", board1)
  writeJson(out, "harbor/board-ready.json", board2)
  writeJson(out, "harbor/board-shipped.json", board3)
  for (const f of [tint1, rename1, footer1, tint2]) diffFile(out, "harbor", f)

  previews[tint1.id] = previewFile(out, "harbor-tint-1", apply(seed, EDITS.markColor))
  previews[rename1.id] = previewFile(out, "harbor-rename", afterRename)
  previews[footer1.id] = previewFile(out, "harbor-footer", apply(seed, EDITS.footer))
  previews[tint2.id] = previewFile(out, "harbor-tint-2", afterTint)
  previews[`main@${short(main0)}`] = previewFile(out, "harbor-main-0", seed)
  previews[`main@${short(mainR)}`] = previewFile(out, "harbor-main-r", afterRename)
  previews[`main@${short(mainT)}`] = previewFile(out, "harbor-main-t", afterTint)

  return {
    board: board0,
    transitions: {
      [`rerun:${tint1.id}`]: {
        board: "board-rerun.json",
        now: T("21:14:40"),
        attemptId: tint2.id,
        notice: `Discarded the old diff. Attempt 2 runs the same brief on main ${short(mainR)}.`,
        then: { afterMs: 3800, board: "board-ready.json", now: T("21:14:44") },
      },
      [`ship:${tint2.id}`]: {
        board: "board-shipped.json",
        now: T("21:14:59"),
        notice: "Shipped to main. Every other ready attempt was re-checked against the new main.",
      },
    },
  }
}

// ------------------------------------------------------------------ a busy project with real agents (every card state)

function northlineProject(out: Out, previews: Record<string, string>) {
  const id = "northline-notices-5e2b"
  const created = T("21:01:10")
  const seed: Files = { "README.md": "# Northline notices\n\nPier notices for the Northline night shift.\n", "site/index.html": NOTICE }
  const main0 = shaOf(`${id}:main0`)
  const mainR = shaOf(`${id}:mainR`)
  const mainF = shaOf(`${id}:mainF`)
  const filesR = apply(seed, EDITS.markName)
  const filesF = apply(filesR, EDITS.footer)
  const project: Project = { id, name: "Northline notices", description: "Pier notices for the Northline night shift.", createdAt: created, repo: id, mainSha: mainF, seed: "starter" }

  const b = (task: string, constraints: string[], acceptance: string, paths: string[], at: string, hex: string) => briefOf(task, constraints, acceptance, paths, at, hex)
  const rename = b("Rename the pier mark to the night board", ["Keep the mark element", "Touch only site/index.html"], 'contains site/index.html "Northline night board"', ["site/index.html"], T("21:02:55"), "41d7")
  const footer = b("Add the night clerk footer", ["Do not change the pier name", "Touch only site/index.html"], 'contains site/index.html "Posted by the night clerk."', ["site/index.html"], T("21:03:10"), "e5a0")
  const tint = b("Tint the pier name in channel teal", ["Leave the notice text alone", "Touch only site/index.html"], 'contains site/index.html "color:#1F6F78"', ["site/index.html"], T("21:02:40"), "9c01")
  const tides = b("Add the tide table", ["Static HTML only. No scripts.", "Use the same serif as the notice"], 'contains site/tides.html "High water"\nTimes are local and read top to bottom.', ["site/tides.html"], T("21:07:20"), "2b8c")
  const copy = b("Tighten the footer copy", ["Keep the footer to one line", "Do not touch the pier name"], 'contains site/index.html "Posted nightly by the clerk."', ["site/index.html"], T("21:10:15"), "4e72")
  const storm = b("Add a storm warning banner", ["Banner sits above the pier name", "Plain words, no exclamation marks"], 'contains site/index.html "Small craft warning"', ["site/index.html"], T("21:03:30"), "7f19")
  const ferry = b("Post the ferry times under the tide table", ["Static HTML only. No scripts.", "Keep the tide table as it is"], 'contains site/tides.html "Ferry"\nThe last ferry is easy to find.', ["site/tides.html"], T("21:03:50"), "c3a8")
  const slipway = b("Mark the slipway closed on Sundays", ["One sentence, after the lede", "Touch only site/index.html"], 'contains site/index.html "closed on Sundays"', ["site/index.html"], T("21:04:30"), "5d02")
  const phone = b("Add the harbor master's phone number", ["Use the number from the shed board: 0161 555 0142", "Touch only site/index.html"], 'contains site/index.html "0161 555 0142"', ["site/index.html"], T("21:13:20"), "a91e")
  const norsk = b("Translate the notice into Norwegian", ["Keep the English notice; add site/no/index.html", "Same layout and serif"], 'contains site/no/index.html "Brygge"', ["site/no/"], T("21:12:40"), "0b6f")
  const shed = b("Fix the broken shed link", ["Link to site/tides.html, not the old PDF"], "The shed link opens the tide table.", ["site/index.html"], T("21:10:58"), "d4c7")

  const fork = (brief: Brief, hex: string, number: number, agent: string, base: Files, baseSha: string, createdAt: string, edits: Edit[]): Fork => ({ brief, id: attemptIdOf(id, brief, hex), number, agent, base, baseSha, createdAt, edits })
  const rename1 = fork(rename, "a20e", 1, "codex", seed, main0, rename.createdAt, [EDITS.markName])
  const footer1 = fork(footer, "6c42", 1, "grok", seed, main0, footer.createdAt, [EDITS.footer])
  const tint1 = fork(tint, "3b1c", 1, "claude", seed, main0, tint.createdAt, [EDITS.markColor])
  const tint2 = fork(tint, "77de", 2, "claude", filesF, mainF, T("21:13:40"), [EDITS.markColor])
  const tides1 = fork(tides, "9a51", 1, "codex", seed, main0, tides.createdAt, [EDITS.tides])
  const copy1 = fork(copy, "c3d9", 1, "grok", filesF, mainF, copy.createdAt, [EDITS.footerCopy, EDITS.readmeBlurb, EDITS.controlNote])
  const storm1 = fork(storm, "1d0b", 1, "cursor", seed, main0, storm.createdAt, [EDITS.storm])
  const ferry1 = fork(ferry, "e270", 1, "cursor", seed, main0, ferry.createdAt, [])
  const slip1 = fork(slipway, "48fa", 1, "claude", seed, main0, slipway.createdAt, [EDITS.slipway])
  const phone1 = fork(phone, "6b33", 1, "claude", filesF, mainF, phone.createdAt, [])
  const norsk1 = fork(norsk, "f05c", 1, "cursor", filesF, mainF, norsk.createdAt, [])
  const shed1 = fork(shed, "2e9d", 1, "manual", filesF, mainF, shed.createdAt, [])

  const shipR = T("21:08:30")
  const shipF = T("21:09:10")
  const tint1Discard = T("21:13:40")
  const reasonTint = "Conflicted with main in site/index.html."

  const attempts: Attempt[] = [
    { ...readyAttempt(rename1, { updatedAt: shipR, mainSha: main0, checkedAt: T("21:05:13"), review: review("satisfies", "Changes the mark text and nothing else.", forkHead(rename1).headSha, T("21:05:15")) }), status: "shipped", shippedSha: mainR },
    { ...readyAttempt(footer1, { updatedAt: shipF, mainSha: mainR, checkedAt: shipR, review: review("satisfies", "Adds one footer line before the closing body tag.", forkHead(footer1).headSha, T("21:06:05")) }), status: "shipped", shippedSha: mainF },
    {
      ...readyAttempt(tint1, { updatedAt: tint1Discard, mainSha: mainR, checkedAt: shipR, conflict: ["site/index.html"], review: review("satisfies", "Adds an inline colour to the mark. Nothing else changes.", forkHead(tint1).headSha, T("21:05:43")) }),
      status: "discarded",
      replacedBy: tint2.id,
      discardReason: reasonTint,
    },
    { ...readyAttempt(tint2, { updatedAt: T("21:14:03"), mainSha: mainF, checkedAt: T("21:14:03"), review: review("satisfies", "Colours the renamed mark teal. The footer is untouched.", forkHead(tint2).headSha, T("21:14:05")) }), replaces: tint1.id },
    readyAttempt(tides1, { updatedAt: T("21:09:52"), mainSha: mainF, checkedAt: T("21:09:52"), review: review("partial", "The table is present, but the free-text reading guidance needs a human check.", forkHead(tides1).headSha, T("21:09:55")) }),
    readyAttempt(copy1, { updatedAt: T("21:12:07"), mainSha: mainF, checkedAt: T("21:12:07"), review: review("off-brief", "The README and a shipboard control file were changed without being requested.", forkHead(copy1).headSha, T("21:12:10")) }),
    { ...readyAttempt(storm1, { updatedAt: T("21:07:05"), mainSha: main0, checkedAt: T("21:06:31") }), status: "parked" },
    waitingAttempt(ferry1, T("21:05:20"), "failed"),
    readyAttempt(slip1, { updatedAt: T("21:09:11"), mainSha: mainF, checkedAt: T("21:09:11"), conflict: ["site/index.html"], review: review("satisfies", "One sentence about the slipway, placed after the lede.", forkHead(slip1).headSha, T("21:07:44")) }),
    waitingAttempt(phone1, T("21:13:49")),
    waitingAttempt(norsk1, T("21:12:40")),
    waitingAttempt(shed1, T("21:10:58")),
  ]

  const jobs: Job[] = [
    doneJob(rename1, "harbor-vps-2", rename.createdAt, T("21:03:44"), T("21:05:12"), "Renamed the mark to Northline night board."),
    doneJob(footer1, "harbor-vps-1", footer.createdAt, T("21:03:58"), T("21:06:02"), "Added the footer line."),
    doneJob(tint1, "harbor-vps-1", tint.createdAt, T("21:02:41"), T("21:05:40"), "Set the mark colour to #1F6F78."),
    doneJob(tint2, "harbor-vps-1", T("21:13:40"), T("21:13:42"), T("21:14:02"), "Set the mark colour to #1F6F78 on the renamed mark."),
    doneJob(tides1, "harbor-vps-2", tides.createdAt, T("21:07:26"), T("21:09:50"), "Added site/tides.html with four days of high and low water."),
    doneJob(copy1, "harbor-vps-1", copy.createdAt, T("21:10:20"), T("21:12:05"), "Shortened the footer; also refreshed the README blurb."),
    doneJob(storm1, "mac-mini", storm.createdAt, T("21:03:41"), T("21:06:30"), "Added a small craft warning above the pier name."),
    {
      attemptId: ferry1.id,
      agent: "cursor",
      state: "failed",
      queuedAt: ferry.createdAt,
      runnerId: "mac-mini",
      claimedAt: T("21:04:10"),
      leaseExpiresAt: T("21:07:10"),
      finishedAt: T("21:05:20"),
      outcome: { reason: "agent_error", summary: "cursor-agent stopped at a login prompt it could not answer.", durationMs: 70000 },
    },
    doneJob(slip1, "harbor-vps-1", slipway.createdAt, T("21:04:31"), T("21:07:40"), "Added the slipway sentence after the lede."),
    { attemptId: phone1.id, agent: "claude", state: "running", queuedAt: phone.createdAt, runnerId: "harbor-vps-1", claimedAt: T("21:13:49"), leaseExpiresAt: T("21:16:49") },
    { attemptId: norsk1.id, agent: "cursor", state: "queued", queuedAt: norsk.createdAt },
  ]

  const ev = (at: string, kind: ActivityKind, text: string, f?: Fork) => act(at, kind, text, f ? { briefId: f.brief.id, attemptId: f.id, agent: f.agent } : {})
  const pushed = (f: Fork, at: string) => ev(at, "pushed", `${label(f.agent)} pushed ${short(forkHead(f).headSha)} for ${q(f.brief.task)}.`, f)
  const assessed = (f: Fork, at: string) => {
    const { head, headSha } = forkHead(f)
    return ev(at, "assessed", `Assessed ${q(f.brief.task)}: ${digestOf(f.brief, f.base, head, f.baseSha, headSha).summary}`, f)
  }
  const dispatched = (f: Fork) => ev(f.createdAt, "dispatched", `Dispatched ${q(f.brief.task)} to ${label(f.agent)}.`, f)
  const claimed = (f: Fork, at: string, runner: string) => ev(at, "claimed", `Runner ${runner} claimed ${q(f.brief.task)} for ${label(f.agent)}.`, f)

  const activity: Activity[] = [
    ev(created, "project", "Created Northline notices from the starter site."),
    dispatched(tint1),
    claimed(tint1, T("21:02:41"), "harbor-vps-1"),
    dispatched(rename1),
    dispatched(footer1),
    dispatched(storm1),
    claimed(storm1, T("21:03:41"), "mac-mini"),
    claimed(rename1, T("21:03:44"), "harbor-vps-2"),
    dispatched(ferry1),
    claimed(footer1, T("21:03:58"), "harbor-vps-1"),
    claimed(ferry1, T("21:04:10"), "mac-mini"),
    dispatched(slip1),
    claimed(slip1, T("21:04:31"), "harbor-vps-1"),
    pushed(rename1, T("21:05:12")),
    assessed(rename1, T("21:05:13")),
    ev(T("21:05:20"), "failed", `Cursor did not finish ${q(ferry.task)} (agent_error): cursor-agent stopped at a login prompt it could not answer.`, ferry1),
    pushed(tint1, T("21:05:40")),
    assessed(tint1, T("21:05:41")),
    pushed(footer1, T("21:06:02")),
    assessed(footer1, T("21:06:03")),
    pushed(storm1, T("21:06:30")),
    assessed(storm1, T("21:06:31")),
    ev(T("21:07:05"), "parked", `Parked ${q(storm.task)}.`, storm1),
    dispatched(tides1),
    claimed(tides1, T("21:07:26"), "harbor-vps-2"),
    pushed(slip1, T("21:07:40")),
    assessed(slip1, T("21:07:41")),
    ev(shipR, "shipped", `Shipped ${q(rename.task)} to main at ${short(mainR)}.`, rename1),
    ev(shipR, "conflict", `${q(tint.task)} conflicts with main in site/index.html. Re-run it on current main.`, tint1),
    ev(shipF, "shipped", `Shipped ${q(footer.task)} to main at ${short(mainF)}.`, footer1),
    ev(T("21:09:11"), "conflict", `${q(slipway.task)} conflicts with main in site/index.html. Re-run it on current main.`, slip1),
    pushed(tides1, T("21:09:50")),
    assessed(tides1, T("21:09:52")),
    dispatched(copy1),
    claimed(copy1, T("21:10:20"), "harbor-vps-1"),
    dispatched(shed1),
    pushed(copy1, T("21:12:05")),
    assessed(copy1, T("21:12:07")),
    dispatched(norsk1),
    dispatched(phone1),
    ev(tint1Discard, "rerun", `Re-ran ${q(tint.task)} as attempt 2 on main ${short(mainF)}. Attempt 1 was discarded: ${reasonTint}`, tint2),
    claimed(tint2, T("21:13:42"), "harbor-vps-1"),
    claimed(phone1, T("21:13:49"), "harbor-vps-1"),
    pushed(tint2, T("21:14:02")),
    assessed(tint2, T("21:14:03")),
  ]

  const board = boardOf({
    version: 83,
    project,
    briefs: [rename, footer, tint, tides, copy, storm, ferry, slipway, phone, norsk, shed],
    attempts,
    jobs,
    activity,
    agents: agentList({ claude: T("21:14:24"), codex: T("21:13:52"), grok: T("21:13:31"), cursor: T("21:04:10") }),
  })
  writeJson(out, `harbor/board-${id}.json`, board)
  for (const f of [rename1, footer1, tint1, tint2, tides1, copy1, storm1, slip1]) diffFile(out, "harbor", f)

  previews[rename1.id] = previewFile(out, "north-rename", filesR)
  previews[footer1.id] = previewFile(out, "north-footer", apply(seed, EDITS.footer))
  previews[tint1.id] = previewFile(out, "north-tint-1", apply(seed, EDITS.markColor))
  previews[tint2.id] = previewFile(out, "north-tint-2", apply(filesF, EDITS.markColor))
  previews[tides1.id] = previewFile(out, "north-tides", apply(seed, EDITS.tides), "site/tides.html")
  previews[copy1.id] = previewFile(out, "north-copy", apply(filesF, EDITS.footerCopy))
  previews[storm1.id] = previewFile(out, "north-storm", apply(seed, EDITS.storm))
  previews[slip1.id] = previewFile(out, "north-slipway", apply(seed, EDITS.slipway))
  previews[`main@${short(mainF)}`] = previewFile(out, "north-main-f", filesF)
  return board
}

function emptyProject(out: Out): BoardView {
  const id = "ferry-board-19be"
  const created = T("16:02:11", "2026-09-29")
  const board = boardOf({
    version: 1,
    project: { id, name: "Ferry board", description: "Departures from the north pier. Nothing dispatched yet.", createdAt: created, repo: id, mainSha: shaOf(`${id}:main0`), seed: "starter" },
    briefs: [],
    attempts: [],
    jobs: [],
    activity: [act(created, "project", "Created Ferry board from the starter site.")],
    agents: agentList({ claude: T("21:14:24"), codex: T("21:13:52"), grok: T("21:13:31"), cursor: T("21:04:10") }),
  })
  writeJson(out, `harbor/board-${id}.json`, board)
  return board
}

// ------------------------------------------------------------------ the fixture sets

export function buildFixtures(): Map<string, string> {
  const out: Out = { files: new Map() }
  const previews: Record<string, string> = {}
  const harbor = harborProject(out, previews)
  const busy = northlineProject(out, previews)
  const empty = emptyProject(out)
  out.files.set("harbor/previews/missing.html", "<!DOCTYPE html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>No preview</title><style>body{margin:2rem;font-family:Georgia,serif;background:#e7eef0;color:#102126}</style></head><body><p>This fixture has no page for that preview.</p></body></html>\n")

  const agents = harbor.board.agents
  const config = (over: Record<string, unknown> = {}) => ({ mode: "local", publicRead: true, boardAuth: false, agents, namespace: "local", ...over })
  writeJson(out, "harbor/config.json", config())
  writeJson(out, "harbor/projects.json", { projects: [summaryOf(harbor.board), summaryOf(busy), summaryOf(empty)] })
  writeJson(out, "harbor/meta.json", {
    about: "Two projects: the harbor demo (three scripted briefs, one conflict) and Northline notices (every card state). Built by test/ui/build-fixtures.ts.",
    now: T("21:14:30"),
    stateNow: { rerun: T("21:14:41"), ready: T("21:14:47"), shipped: T("21:15:02") },
    latencyMs: 160,
    demo: { projectId: harbor.board.project.id, notice: "Three scripted agents are editing the harbor notice. Ship two of them; the third will conflict. Re-run it." },
    previews,
    transitions: harbor.transitions,
  })

  writeJson(out, "locked/meta.json", { about: "Read-only: the board wants a token. Any token unlocks it, except a wrong one: use harbor.", extends: "harbor", token: "harbor" })
  writeJson(out, "locked/config.json", config({ boardAuth: true }))
  writeJson(out, "private/meta.json", { about: "PUBLIC_READ=false: reads need the token too (harbor).", extends: "harbor", token: "harbor", requireToken: true })
  writeJson(out, "private/config.json", config({ publicRead: false, boardAuth: true }))
  writeJson(out, "offline/meta.json", { about: "The board stops answering after two polls.", extends: "harbor", offlineAfter: 2 })
  writeJson(out, "cloud/meta.json", { about: "A Cloudflare deploy with no BOARD_TOKEN secret: buttons answer 503.", extends: "harbor" })
  writeJson(out, "cloud/config.json", config({ mode: "cloudflare", namespace: "shipboard" }))
  writeJson(out, "fresh/meta.json", { about: "A new board with no projects.", extends: "harbor" })
  writeJson(out, "fresh/projects.json", { projects: [] })
  return out.files
}

export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/fixtures")

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  const files = buildFixtures()
  for (const [rel, text] of files) {
    const full = path.join(FIXTURE_DIR, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  console.log(`Wrote ${files.size} fixture files to ${path.relative(process.cwd(), FIXTURE_DIR)}`)
}
