// Two routes: / (home) and /p/<projectId> (a board). /?p=<projectId> also opens a board, for hosts
// that serve only real files. Fixture and clock parameters ride along on every link.

const KEEP = ["fixture", "utc"]
const PROJECT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function href(path) {
  const from = new URLSearchParams(location.search)
  const keep = new URLSearchParams()
  for (const key of KEEP) if (from.has(key)) keep.set(key, from.get(key) ?? "")
  const query = keep.toString()
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path
}

export const boardHref = (projectId) => href(`/p/${encodeURIComponent(projectId)}`)

export function currentRoute() {
  const m = /^\/p\/([^/]+)\/?$/.exec(location.pathname)
  if (m) {
    const id = decodeURIComponent(m[1])
    return PROJECT_ID.test(id) ? { name: "board", id } : { name: "missing" }
  }
  const p = new URLSearchParams(location.search).get("p")
  if (p && PROJECT_ID.test(p)) return { name: "board", id: p }
  if (location.pathname === "/" || location.pathname === "/index.html") return { name: "home" }
  return { name: "missing" }
}

let onChange = () => {}

export function onRoute(fn) {
  onChange = fn
}

export function navigate(path, { replace = false } = {}) {
  const target = href(path)
  if (replace) history.replaceState(null, "", target)
  else history.pushState(null, "", target)
  onChange()
}
