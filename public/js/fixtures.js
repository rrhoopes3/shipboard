// Fixture mode (?fixture=<name>). Answers the API from public/fixtures/<name>/ so the board can be
// built, checked and demonstrated without a server. Nothing is sent anywhere.
//
// A set holds config.json, projects.json, board.json (and board-<projectId>.json for other projects),
// diff-<attemptId>.json and meta.json. meta.json may say:
//   now          the moment the fixture describes; the board clock starts there
//   stateNow     { "<state>": iso } the clock for ?state=<state>
//   extends      another set to take missing files and meta keys from
//   demo         the response to POST /api/demo
//   previews     { "<attemptId>" | "main@<sha7>" | "main": "/fixtures/.../page.html" }
//   transitions  { "<action>:<attemptId or projectId>": { board, now, notice, attemptId, then: { afterMs, board, now } } }
//   token        the only board token the set accepts (any token when absent)
//   requireToken reads need the token too (PUBLIC_READ=false)
//   offlineAfter board polls that answer before the board "goes offline"
// ?state=<name> opens the main project at board-<name>.json instead of board.json.

import { ApiError } from "./api.js"
import { setNow } from "./clock.js"
import { setUtc, short } from "./dom.js"

const sets = new Map()
const boards = new Map()
let started = false
let polls = 0
const resolvedMeta = new Map()

async function load(set, name) {
  let entry = sets.get(set)
  if (!entry) {
    entry = new Map()
    sets.set(set, entry)
  }
  if (!entry.has(name)) {
    entry.set(
      name,
      fetch(`/fixtures/${set}/${name}`, { cache: "no-store" }).then(
        (res) => (res.ok ? res.json() : undefined),
        () => undefined,
      ),
    )
  }
  return entry.get(name)
}

async function metaOf(set, seen = new Set()) {
  if (resolvedMeta.has(set)) return resolvedMeta.get(set)
  seen.add(set)
  const own = (await load(set, "meta.json")) ?? {}
  const parent = own.extends && !seen.has(own.extends) ? await metaOf(own.extends, seen) : {}
  const merged = { ...parent, ...own, chain: [set, ...(parent.chain ?? [])] }
  resolvedMeta.set(set, merged)
  return merged
}

async function file(set, name) {
  const meta = await metaOf(set)
  for (const from of meta.chain) {
    const value = await load(from, name)
    if (value !== undefined) return structuredClone(value)
  }
  return undefined
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ok = (data, status = 200) => ({ status, data })

function start(meta) {
  if (started) return
  started = true
  const state = new URLSearchParams(location.search).get("state")
  const at = (state && meta.stateNow?.[state]) || meta.now
  if (at) setNow(at)
  const utcParam = new URLSearchParams(location.search).get("utc")
  setUtc(utcParam !== "0")
}

function tokenOk(meta, token) {
  return Boolean(token) && (!meta.token || token === meta.token)
}

async function boardFor(set, projectId) {
  if (boards.has(projectId)) return boards.get(projectId)
  // ?state=rerun starts the main project at board-rerun.json, for screenshots of later moments.
  const state = new URLSearchParams(location.search).get("state")
  const main = (state && /^[a-z0-9-]+$/.test(state) ? await file(set, `board-${state}.json`) : undefined) ?? (await file(set, "board.json"))
  let board = main && main.project.id === projectId ? main : await file(set, `board-${projectId}.json`)
  if (board) boards.set(projectId, board)
  return board
}

async function applyTransition(set, step) {
  const board = await file(set, step.board)
  if (!board) throw new ApiError(`The fixture is missing ${step.board}.`, 500)
  boards.set(board.project.id, board)
  if (step.now) setNow(step.now)
  if (step.then) {
    const next = step.then
    setTimeout(() => void applyTransition(set, next), next.afterMs ?? 3000)
  }
  return board
}

const VERB = {
  ship: "ship this attempt to main",
  park: "park this attempt",
  unpark: "put this attempt back on the board",
  rerun: "discard this diff and re-run the brief on current main",
  dispatch: "fork main and commit this brief",
  create: "create the project",
  demo: "cut the harbor demo",
}

export async function request(set, method, path, body, token) {
  const meta = await metaOf(set)
  start(meta)
  await wait(meta.latencyMs ?? 140)
  const url = new URL(path, location.origin)
  const p = url.pathname

  if (method === "GET") {
    if (p === "/api/config") return ok(await file(set, "config.json"))
    if (meta.requireToken && !tokenOk(meta, token)) {
      throw new ApiError("This board needs its board token to read.", 401, { error: "This board needs its board token to read." })
    }
    if (p === "/api/projects") return ok((await file(set, "projects.json")) ?? { projects: [] })
    let m = /^\/api\/projects\/([^/]+)$/.exec(p)
    if (m) {
      polls += 1
      if (meta.offlineAfter != null && polls > meta.offlineAfter) throw new ApiError("The board is not answering.", 0)
      const board = await boardFor(set, decodeURIComponent(m[1]))
      if (!board) throw new ApiError("No project with that id.", 404, { error: "No project with that id." })
      const since = url.searchParams.get("since")
      if (since !== null && since === String(board.version)) return ok(null, 304)
      return ok(structuredClone(board))
    }
    m = /^\/api\/attempts\/([^/]+)\/diff$/.exec(p)
    if (m) {
      const diff = await file(set, `diff-${decodeURIComponent(m[1])}.json`)
      if (!diff) throw new ApiError("This fixture has no diff for that attempt.", 404)
      return ok(diff)
    }
    throw new ApiError("Not found.", 404)
  }

  const config = (await file(set, "config.json")) ?? {}
  if (config.mode === "cloudflare" && !config.boardAuth) {
    const error = "Set the BOARD_TOKEN secret (wrangler secret put BOARD_TOKEN) to use the board's buttons."
    throw new ApiError(error, 503, { error })
  }
  if (config.boardAuth && !tokenOk(meta, token)) {
    const error = "This action needs the board token."
    throw new ApiError(error, 401, { error })
  }

  let action = null
  let target = null
  let m = /^\/api\/attempts\/([^/]+)\/(ship|park|unpark|rerun)$/.exec(p)
  if (m) {
    action = m[2]
    target = decodeURIComponent(m[1])
  } else if ((m = /^\/api\/projects\/([^/]+)\/tasks$/.exec(p))) {
    action = "dispatch"
    target = decodeURIComponent(m[1])
  } else if (p === "/api/projects") {
    action = "create"
  } else if (p === "/api/demo") {
    action = "demo"
  }
  if (!action) throw new ApiError("Not found.", 404)

  if (action === "demo" && meta.demo) return ok(structuredClone(meta.demo), 201)

  const step = meta.transitions?.[`${action}:${target}`]
  if (step) {
    const board = await applyTransition(set, step)
    const out = { board: structuredClone(board), notice: step.notice ?? "Done." }
    if (step.attemptId) out.attemptId = step.attemptId
    return ok(out, action === "dispatch" ? 201 : 200)
  }
  return ok({ fixture: true, notice: `Fixture data, so nothing was sent. A live board would ${VERB[action]}.` }, 200)
}

/** Fixture previews are static pages listed in meta.previews; the board keeps its real preview URLs. */
export function previewSrc(set, url) {
  const meta = resolvedMeta.get(set)
  const m = /^\/preview\/([^/]+)\/([^/]+)\/(.*)$/.exec(String(url))
  if (!meta || !m) return url
  const [, projectId, ref] = m
  const map = meta.previews ?? {}
  let target = map[ref]
  if (ref === "main") {
    const board = boards.get(projectId)
    target = (board && map[`main@${short(board.project.mainSha)}`]) ?? map.main
  }
  return target ?? `/fixtures/${meta.chain.at(-1)}/previews/missing.html`
}
