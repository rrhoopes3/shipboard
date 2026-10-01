// Read-only mode and the Unlock popover. The board token lives in localStorage and leaves this
// browser only as `Authorization: Bearer`. /api/config says whether the board wants one.

import { getToken, setToken } from "./api.js"
import { clear, h, icon } from "./dom.js"
import { toast } from "./toast.js"

let config = null
let rejected = false
let message = null
let opening = false
const listeners = new Set()

export function setConfig(value) {
  config = value
  renderLock()
  emit()
}

export function onAuthChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) fn()
}

/** Why this browser cannot change the board, or null when it can. */
export function mutationBlock() {
  if (!config) return null
  if (config.mode === "cloudflare" && !config.boardAuth) return { kind: "unconfigured" }
  if (config.boardAuth && !getToken()) return { kind: "locked" }
  return null
}

const LOCKED_SENTENCE = "Shipping, re-running and dispatching need the board token."

/** Says why a button did nothing: opens Unlock, or explains that changes are off. */
export function explainBlock(block) {
  if (!block) return
  if (block.kind === "locked") openUnlock(LOCKED_SENTENCE)
  else toast("error", "Changes are switched off on this board.", "No BOARD_TOKEN secret is set. Set it with wrangler secret put BOARD_TOKEN, then reload.")
}

/** 401 and 503 from a mutation. Returns true when it handled the error. */
export function handleAuthError(err) {
  if (err.status === 401) {
    if (getToken()) {
      rejected = true
      openUnlock("The board did not accept that token. Check BOARD_TOKEN and try again.", "buoy")
    } else {
      openUnlock(err.message || LOCKED_SENTENCE)
    }
    return true
  }
  if (err.status === 503) {
    toast("error", "Changes are switched off on this board.", err.message)
    return true
  }
  return false
}

/** The banner under the masthead when this browser cannot change the board. */
export function authBanner() {
  const block = mutationBlock()
  if (!block) return null
  if (block.kind === "locked") {
    return h(
      "div",
      { class: "banner", "data-tone": "lamp", role: "region", "aria-label": "Read-only mode" },
      icon("lock"),
      h("p", null, h("strong", null, "Read-only."), " You can read every brief, diff and preview. ", LOCKED_SENTENCE),
      h("button", { class: "btn btn-lamp btn-sm", type: "button", onclick: () => openUnlock() }, icon("key"), "Unlock"),
    )
  }
  return h(
    "div",
    { class: "banner", "data-tone": "buoy", role: "region", "aria-label": "Changes are off" },
    icon("alert"),
    h("p", null, h("strong", null, "Changes are switched off on this board."), " No BOARD_TOKEN secret is set. Set it with ", h("code", null, "wrangler secret put BOARD_TOKEN"), ", then reload."),
  )
}

// ------------------------------------------------------------------ the lock control

const root = () => document.getElementById("lock")

function renderLock() {
  const el = root()
  if (!el) return
  const show = Boolean(config && (config.boardAuth || getToken()))
  el.hidden = !show
  if (!show) return
  const locked = !getToken()
  let btn = document.getElementById("lock-btn")
  if (!btn) {
    btn = h("button", { class: "tool-btn lock-btn", id: "lock-btn", type: "button", "aria-expanded": "false", "aria-controls": "unlock-pop" })
    btn.addEventListener("click", () => (isOpen() ? closeUnlock() : openUnlock()))
    el.append(btn, h("div", { class: "popover", id: "unlock-pop", role: "dialog", "aria-labelledby": "unlock-title", hidden: true }))
  }
  btn.dataset.locked = String(locked)
  clear(btn).append(icon(locked ? "lock" : "unlock"), h("span", { class: "lock-label" }, locked ? "Read-only" : "Unlocked"))
  btn.setAttribute("aria-label", locked ? "Read-only. Unlock the board" : "Unlocked. Lock the board")
}

const pop = () => document.getElementById("unlock-pop")
const isOpen = () => Boolean(pop() && !pop().hidden)

export function openUnlock(text, tone) {
  if (!config) return
  if (!root() || root().hidden) {
    // A board without auth still shows the control once someone needs it.
    config = { ...config, boardAuth: true }
    renderLock()
  }
  message = text ? { text, tone } : null
  const p = pop()
  if (!p) return
  // The click that opened the popover is still bubbling; do not let it count as "outside".
  opening = true
  setTimeout(() => {
    opening = false
  }, 0)
  renderPopover(p)
  p.hidden = false
  document.getElementById("lock-btn")?.setAttribute("aria-expanded", "true")
  setTimeout(() => (p.querySelector("input") ?? p.querySelector("button"))?.focus(), 30)
}

export function closeUnlock({ restore = true } = {}) {
  const p = pop()
  if (!p || p.hidden) return
  p.hidden = true
  const btn = document.getElementById("lock-btn")
  btn?.setAttribute("aria-expanded", "false")
  if (restore && p.contains(document.activeElement)) btn?.focus()
}

function renderPopover(p) {
  clear(p)
  const token = getToken()
  const note = message ? h("p", { class: "pop-message", "data-tone": message.tone ?? null }, message.text) : null
  if (token && !rejected) {
    p.append(
      h("p", { class: "pop-title", id: "unlock-title" }, "Board unlocked"),
      note,
      h("p", { class: "pop-copy" }, "Changes from this browser carry the stored token. Lock to forget it here."),
      h(
        "div",
        { class: "pop-actions" },
        h("button", { class: "btn btn-quiet", type: "button", onclick: () => closeUnlock() }, "Keep it"),
        h("button", { class: "btn btn-outline", type: "button", onclick: forget }, icon("lock"), "Lock and forget"),
      ),
    )
    return
  }
  const input = h("input", {
    class: "input mono-input",
    id: "board-token",
    name: "token",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "BOARD_TOKEN",
    "aria-describedby": "token-help",
  })
  const error = h("p", { class: "field-error", id: "token-error", hidden: true })
  const form = h(
    "form",
    { novalidate: true },
    h("p", { class: "pop-title", id: "unlock-title" }, "Unlock this board"),
    note,
    h("p", { class: "pop-copy", id: "token-help" }, "Stored in this browser only. Sent as a Bearer header, never a cookie."),
    h("label", { class: "field-label", for: "board-token" }, "Board token"),
    input,
    error,
    h(
      "div",
      { class: "pop-actions" },
      token ? h("button", { class: "btn btn-quiet", type: "button", onclick: forget }, "Forget the old one") : h("button", { class: "btn btn-quiet", type: "button", onclick: () => closeUnlock() }, "Cancel"),
      h("button", { class: "btn btn-lamp", type: "submit" }, icon("key"), "Unlock"),
    ),
  )
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    const value = input.value.trim()
    if (!value) {
      error.hidden = false
      error.textContent = "Paste the board token first."
      input.setAttribute("aria-invalid", "true")
      input.focus()
      return
    }
    setToken(value)
    rejected = false
    message = null
    closeUnlock()
    renderLock()
    emit()
    toast("ok", "Board unlocked.", "Changes from this browser now carry the token.")
  })
  p.append(form)
}

function forget() {
  setToken("")
  rejected = false
  message = null
  closeUnlock()
  renderLock()
  emit()
  toast("info", "Locked. The token is gone from this browser.")
}

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && isOpen()) {
      e.preventDefault()
      e.stopPropagation()
      closeUnlock()
    }
  },
  true,
)

document.addEventListener("click", (e) => {
  if (!isOpen() || opening) return
  const target = e.target
  if (!(target instanceof Element)) return
  if (root()?.contains(target) || target.closest("[data-opens-unlock]")) return
  closeUnlock({ restore: false })
})
