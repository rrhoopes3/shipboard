// Toasts: the API's `notice` sentences as they are, and error sentences. Errors are role=alert.

import { h, icon } from "./dom.js"

const TONE = { ok: "channel", info: "lamp", error: "buoy" }
const ICON = { ok: "check", info: "brief", error: "alert" }

export function toast(kind, text, sub) {
  const root = document.getElementById("toasts")
  if (!root || !text) return
  const el = h(
    "div",
    { class: "toast", "data-tone": TONE[kind] ?? "lamp", role: kind === "error" ? "alert" : null },
    icon(ICON[kind] ?? "brief"),
    h("p", null, text, sub ? h("span", { class: "toast-sub" }, sub) : null),
    h("button", { type: "button", "aria-label": "Dismiss", onclick: () => dismiss(el) }, icon("x")),
  )
  root.append(el)
  while (root.children.length > 3) root.firstElementChild?.remove()
  const life = kind === "error" ? 10000 : 6500
  let timer = setTimeout(() => dismiss(el), life)
  // Reading a toast holds it in place.
  const hold = () => clearTimeout(timer)
  const release = () => {
    clearTimeout(timer)
    timer = setTimeout(() => dismiss(el), 2500)
  }
  el.addEventListener("mouseenter", hold)
  el.addEventListener("focusin", hold)
  el.addEventListener("mouseleave", release)
  el.addEventListener("focusout", release)
}

function dismiss(el) {
  if (!el.isConnected || el.classList.contains("is-leaving")) return
  el.classList.add("is-leaving")
  setTimeout(() => el.remove(), 260)
}

/** Polite announcement for things that are not toasts (a card changing lanes). */
export function announce(text) {
  const el = document.getElementById("announcer")
  if (!el) return
  el.textContent = ""
  setTimeout(() => {
    el.textContent = text
  }, 60)
}
