// The board's HTTP API (docs/ARCHITECTURE.md, "HTTP API"). JSON in and out, the board token as a
// Bearer header. Preview documents use a separate, short-lived, HttpOnly scoped cookie because
// iframe navigation and relative assets cannot send an Authorization header.
// With ?fixture=<name> every call is answered from public/fixtures/<name>/ instead.

import { noteServerDate } from "./clock.js"

const TOKEN_KEY = "shipboard.boardToken"
const PREVIEW_PROJECTS_KEY = "shipboard.previewProjects"

const params = new URLSearchParams(location.search)
const fixtureParam = (params.get("fixture") || "").toLowerCase().replace(/[^a-z0-9-]/g, "")
export const fixture = fixtureParam || null

export class ApiError extends Error {
  /** status 0 means the request never got an answer. */
  constructor(message, status, data = null) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.data = data
  }
  get network() {
    return this.status === 0
  }
}

// ------------------------------------------------------------------ token

let memoryToken = ""
const previewExpires = new Map()
const previewPending = new Map()
const previewProjects = new Set()
let revoking = Promise.resolve()

try {
  for (const id of JSON.parse(localStorage.getItem(PREVIEW_PROJECTS_KEY) || "[]")) {
    if (/^[a-z0-9][a-z0-9-]*$/.test(id)) previewProjects.add(id)
  }
} catch {
  // Storage may be unavailable or contain an old value.
}

function rememberPreviewProject(id) {
  for (const known of knownPreviewProjects()) previewProjects.add(known)
  previewProjects.add(id)
  try { localStorage.setItem(PREVIEW_PROJECTS_KEY, JSON.stringify([...previewProjects])) } catch {}
}

function knownPreviewProjects() {
  const ids = new Set(previewProjects)
  try {
    for (const id of JSON.parse(localStorage.getItem(PREVIEW_PROJECTS_KEY) || "[]")) {
      if (/^[a-z0-9][a-z0-9-]*$/.test(id)) ids.add(id)
    }
  } catch {}
  return [...ids]
}

function revokePreviews() {
  const pending = [...previewPending.values()]
  previewExpires.clear()
  previewPending.clear()
  revoking = revoking.then(async () => {
    await Promise.allSettled(pending)
    const ids = knownPreviewProjects()
    const results = await Promise.allSettled(ids.map((id) => fetch(`/api/projects/${encodeURIComponent(id)}/preview-session`, {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
    })))
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value.ok) previewProjects.delete(ids[index])
      else previewProjects.add(ids[index])
    }
    try { localStorage.setItem(PREVIEW_PROJECTS_KEY, JSON.stringify([...previewProjects])) } catch {}
  }).catch(() => {})
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || ""
  } catch {
    return memoryToken
  }
}

export function setToken(value) {
  const previous = getToken()
  if (previous && previous !== value) revokePreviews()
  memoryToken = value || ""
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Storage can be blocked (private windows, strict settings). The token then lives for this tab only.
  }
}

window.addEventListener("storage", (event) => {
  if (event.key === TOKEN_KEY && event.oldValue && event.oldValue !== event.newValue) revokePreviews()
})

window.addEventListener("online", () => {
  if (!getToken() && knownPreviewProjects().length) revokePreviews()
})

if (!getToken() && previewProjects.size) revokePreviews()

// ------------------------------------------------------------------ requests

const FALLBACK = {
  400: "The board could not read that request.",
  401: "This needs the board token.",
  403: "The board refused that request.",
  404: "The board has no such thing.",
  409: "That changed on the board while you were looking. Try again.",
  413: "That request is too large.",
  415: "The board only takes JSON.",
  500: "Something broke on the board. Check the server log.",
  503: "Changes are switched off on this board.",
}

function sentence(status, data) {
  if (data && typeof data.error === "string" && data.error.trim()) return data.error.trim()
  return FALLBACK[status] ?? `The board answered ${status}.`
}

let fixtureLayer = null

async function request(method, path, body) {
  if (fixture) {
    fixtureLayer ??= await import("./fixtures.js")
    return fixtureLayer.request(fixture, method, path, body, getToken())
  }
  const headers = { Accept: "application/json" }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const init = { method, headers, cache: "no-store", credentials: "same-origin" }
  if (method !== "GET") {
    headers["Content-Type"] = "application/json"
    init.body = JSON.stringify(body ?? {})
  }
  let res
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError("The board is not answering.", 0)
  }
  noteServerDate(res.headers.get("Date"))
  if (res.status === 304 || res.status === 204) return { status: res.status, data: null }
  let data = null
  const text = await res.text().catch(() => "")
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) throw new ApiError(sentence(res.status, data), res.status, data)
  if (data === null) throw new ApiError("The board sent something that is not JSON.", res.status)
  return { status: res.status, data }
}

const enc = encodeURIComponent

let configPromise = null

export const api = {
  /** Cached for the page's life; a failure is retried on the next call. */
  config() {
    configPromise ??= request("GET", "/api/config").then(
      (r) => r.data,
      (err) => {
        configPromise = null
        throw err
      },
    )
    return configPromise
  },
  async ensurePreviewSession(projectId) {
    if (fixture || (await this.config()).publicRead) return false
    await revoking
    if (previewExpires.get(projectId) > Date.now() + 60_000) return true
    if (previewPending.has(projectId)) return previewPending.get(projectId)
    const token = getToken()
    if (!token) throw new ApiError("This board needs its board token to read.", 401)
    rememberPreviewProject(projectId)
    const pending = request("POST", `/api/projects/${enc(projectId)}/preview-session`).then(({ data }) => {
      if (getToken() !== token) throw new ApiError("The board token changed while opening the preview.", 401)
      previewExpires.set(projectId, Date.parse(data.expiresAt))
      return true
    }).finally(() => previewPending.delete(projectId))
    previewPending.set(projectId, pending)
    return pending
  },
  async projects() {
    return (await request("GET", "/api/projects")).data.projects
  },
  /** { status: 304 } when nothing changed since `since`, else { status: 200, board }. */
  async board(projectId, since) {
    const query = since == null ? "" : `?since=${enc(String(since))}`
    const r = await request("GET", `/api/projects/${enc(projectId)}${query}`)
    return r.status === 304 ? { status: 304, board: null } : { status: r.status, board: r.data }
  },
  async diff(attemptId) {
    return (await request("GET", `/api/attempts/${enc(attemptId)}/diff`)).data
  },
  async createProject(input) {
    return (await request("POST", "/api/projects", input)).data
  },
  async demo() {
    return (await request("POST", "/api/demo", {})).data
  },
  async dispatch(projectId, input) {
    return (await request("POST", `/api/projects/${enc(projectId)}/tasks`, input)).data
  },
  async ship(attemptId, expectedHead) {
    return (await request("POST", `/api/attempts/${enc(attemptId)}/ship`, expectedHead ? { expectedHead } : {})).data
  },
  async park(attemptId) {
    return (await request("POST", `/api/attempts/${enc(attemptId)}/park`, {})).data
  },
  async unpark(attemptId) {
    return (await request("POST", `/api/attempts/${enc(attemptId)}/unpark`, {})).data
  },
  async rerun(attemptId, agent) {
    return (await request("POST", `/api/attempts/${enc(attemptId)}/rerun`, agent ? { agent } : {})).data
  },
}

/** Where an iframe should load a preview from. Fixture mode swaps in the fixture's static pages. */
export function previewSrc(url) {
  if (!fixture || !fixtureLayer) return url
  return fixtureLayer.previewSrc(fixture, url)
}

/** Loads the fixture layer early, so previewSrc can answer synchronously. */
export async function ready() {
  if (fixture) fixtureLayer ??= await import("./fixtures.js")
}
