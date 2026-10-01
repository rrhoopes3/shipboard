// DOM and text helpers. Every node is built with h(); server text only ever becomes a text node,
// never markup, so agent-authored titles and diffs cannot inject anything.

import { now } from "./clock.js"

const SVG_NS = "http://www.w3.org/2000/svg"

export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

/**
 * h("button", { class: "btn", onclick: fn, "aria-label": "Ship" }, icon("ship"), "Ship")
 * Props: `class` (string or array), `on<event>` handlers, `vars` (CSS custom properties set through
 * CSSOM, which the CSP allows), anything else becomes an attribute. null/false props and kids are skipped.
 */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag)
  if (props) {
    for (const [name, value] of Object.entries(props)) {
      if (value == null || value === false) continue
      if (name === "class") el.className = Array.isArray(value) ? value.filter(Boolean).join(" ") : value
      else if (name === "vars") for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, String(v))
      else if (name.startsWith("on") && typeof value === "function") el.addEventListener(name.slice(2), value)
      else el.setAttribute(name, value === true ? "" : String(value))
    }
  }
  append(el, kids)
  return el
}

function append(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue
    if (Array.isArray(kid)) append(el, kid)
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
}

export function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs ?? {})) el.setAttribute(name, String(value))
  return el
}

export function icon(name, cls) {
  const svg = svgEl("svg", { class: cls ? `ic ${cls}` : "ic", "aria-hidden": "true", focusable: "false" })
  svg.append(svgEl("use", { href: `#i-${name}` }))
  return svg
}

/** aria-disabled must read "true"; an empty attribute counts as not disabled. */
export function setAriaDisabled(el, on) {
  if (on) el.setAttribute("aria-disabled", "true")
  else el.removeAttribute("aria-disabled")
}

export function clear(el) {
  el.textContent = ""
  return el
}

// ------------------------------------------------------------------ agent marks

// International Code of Signals flags, drawn inline so theme CSS reaches every part. Not logos.
const FLAGS = {
  claude: [["rect", "f-blue", { width: 18, height: 12 }], ["rect", "f-white", { y: 2.4, width: 18, height: 7.2 }], ["rect", "f-red", { y: 4.2, width: 18, height: 3.6 }]],
  codex: [["rect", "f-white", { width: 18, height: 12 }], ["rect", "f-blue", { x: 7.4, width: 3.2, height: 12 }], ["rect", "f-blue", { y: 4.4, width: 18, height: 3.2 }]],
  grok: [["rect", "f-blue", { width: 18, height: 12 }], ["rect", "f-yellow", { width: 3, height: 12 }], ["rect", "f-yellow", { x: 6, width: 3, height: 12 }], ["rect", "f-yellow", { x: 12, width: 3, height: 12 }]],
  cursor: [["rect", "f-red", { width: 18, height: 12 }], ["rect", "f-yellow", { x: 7.4, width: 3.2, height: 12 }], ["rect", "f-yellow", { y: 4.4, width: 18, height: 3.2 }]],
  demo: [["rect", "f-yellow", { width: 18, height: 12 }], ["rect", "f-blue", { y: 3, width: 18, height: 6 }]],
  manual: [["rect", "f-blue", { width: 18, height: 12 }], ["path", "f-saltire", { d: "M0 0L18 12M18 0L0 12" }]],
}
const FLAG_NAME = { claude: "C, Charlie", codex: "X, X-ray", grok: "G, Golf", cursor: "R, Romeo", demo: "D, Delta", manual: "M, Mike" }

function flagKey(agentId) {
  const id = String(agentId || "")
  if (Object.prototype.hasOwnProperty.call(FLAGS, id)) return id
  // An interactive Claude Code seat (claude-code) flies the same flag as the headless runner.
  if (id.startsWith("claude")) return "claude"
  return null
}

export function flag(agentId, label) {
  const k = flagKey(agentId)
  const svg = svgEl("svg", { viewBox: "0 0 18 12", "aria-hidden": "true", focusable: "false" })
  if (k) {
    for (const [tag, cls, attrs] of FLAGS[k]) svg.append(svgEl(tag, { class: cls, ...attrs }))
  } else {
    svg.append(svgEl("path", { class: "f-slate", d: "M0 0h18L0 12z" }))
    const letter = svgEl("text", { class: "f-letter", x: 2.2, y: 6.6 })
    letter.textContent = String(label || agentId || "?").trim().charAt(0).toUpperCase()
    svg.append(letter)
  }
  return h("span", { class: "flag", title: k ? `Signal flag ${FLAG_NAME[k]}` : "No signal flag for this agent" }, svg)
}

/** "Demo (scripted)" reads as "Demo" on a card; the picker keeps the full label. */
export function shortLabel(label) {
  return String(label || "").replace(/\s*\([^)]*\)\s*$/, "") || String(label || "")
}

// ------------------------------------------------------------------ text

export const short = (value) => (value ? String(value).slice(0, 7) : "—")
export const sha = (value, cls) => h("span", { class: cls ? `sha ${cls}` : "sha", title: value || null }, short(value))
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
/** Straight quotes around titles become typographic ones. */
export const smart = (text) => String(text ?? "").replace(/"([^"]+)"/g, "“$1”")

export function listPhrase(items, max = 3) {
  const list = items.slice(0, max)
  const rest = items.length - list.length
  if (rest > 0) return `${list.join(", ")} and ${rest} more`
  if (list.length <= 1) return list.join("")
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`
}

export function lines(value) {
  return (Array.isArray(value) ? value : String(value ?? "").split("\n")).map((line) => String(line).trim()).filter(Boolean)
}

const CHECK_RE = /^contains\s+(\S+)\s+"(.*)"\s*$/

/** Acceptance text, one line each: `contains <path> "<text>"` is a machine check, anything else is for a person. */
export function parseAcceptance(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = CHECK_RE.exec(line)
      return m ? { kind: "machine", path: m[1], text: m[2], line } : { kind: "person", line }
    })
}

export function diffSize(digest) {
  if (!digest || !digest.files.length) return null
  let add = 0
  let del = 0
  for (const file of digest.files) {
    add += file.additions
    del += file.deletions
  }
  return { add, del, files: digest.files.length }
}

// ------------------------------------------------------------------ time

let utc = false
const formatters = new Map()

/** Forces UTC display (fixture mode and `?utc=1`), so recordings read the same on every machine. */
export function setUtc(on) {
  utc = Boolean(on)
  formatters.clear()
}

function fmt(withSeconds) {
  const k = withSeconds ? "s" : "m"
  let f = formatters.get(k)
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: withSeconds ? "2-digit" : undefined,
      hourCycle: "h23",
      timeZone: utc ? "UTC" : undefined,
    })
    formatters.set(k, f)
  }
  return f
}

const valid = (iso) => typeof iso === "string" && Number.isFinite(Date.parse(iso))
export const hm = (iso) => (valid(iso) ? fmt(false).format(new Date(iso)) : "—")
export const hms = (iso) => (valid(iso) ? fmt(true).format(new Date(iso)) : "—")
export const fullTime = (iso) => (valid(iso) ? new Date(iso).toLocaleString("en-GB", { timeZone: utc ? "UTC" : undefined }) : "")

/** HH:MM for today (board clock), otherwise a short date such as "29 Sep". */
export function dayOrTime(iso) {
  if (!valid(iso)) return "—"
  const zone = utc ? "UTC" : undefined
  const day = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(d)
  const then = new Date(iso)
  if (day(then) === day(new Date(now()))) return hm(iso)
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: zone }).format(then)
}

export function secondsSince(iso) {
  return valid(iso) ? Math.max(0, Math.round((now() - Date.parse(iso)) / 1000)) : 0
}

export function ago(iso) {
  const s = secondsSince(iso)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const hours = Math.floor(m / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function agoWords(iso) {
  const s = secondsSince(iso)
  if (s < 60) return s < 5 ? "just now" : `${s} seconds ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const hours = Math.floor(m / 60)
  if (hours < 48) return plural(hours, "hour", "hours") + " ago"
  return plural(Math.floor(hours / 24), "day", "days") + " ago"
}

export function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(s / 3600)
  const mins = Math.floor((s % 3600) / 60)
  const secs = String(s % 60).padStart(2, "0")
  return hours ? `${hours}:${String(mins).padStart(2, "0")}:${secs}` : `${mins}:${secs}`
}

// ------------------------------------------------------------------ motion

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)")
export const reducedMotion = () => reduce.matches

/** Restarts a CSS animation class on an element (count bumps, sha flashes). */
export function replay(el, cls) {
  if (!el) return
  el.classList.remove(cls)
  void el.offsetWidth
  el.classList.add(cls)
  el.addEventListener("animationend", () => el.classList.remove(cls), { once: true })
}

/** Moves an element without reloading its iframes where the browser can (Element.moveBefore). */
export function place(parent, el, before) {
  if (el.parentNode === parent && el.nextSibling === before) return
  if (typeof parent.moveBefore === "function" && el.isConnected && parent.isConnected && el.ownerDocument === parent.ownerDocument) {
    try {
      parent.moveBefore(el, before ?? null)
      return
    } catch {
      // Fall through: moveBefore refuses some cross-tree moves.
    }
  }
  parent.insertBefore(el, before ?? null)
}
