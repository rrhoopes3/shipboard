// The persistent top bar: breadcrumbs, the live indicator, the host line and the shortcuts popover.

import { clear, h, icon } from "./dom.js"

const byId = (id) => document.getElementById(id)

/** Items after the brand: [{ label, href }] links, the last one is the current page. */
export function setCrumbs(items) {
  const el = byId("crumbs-extra")
  if (!el) return
  clear(el)
  items.forEach((item, i) => {
    const last = i === items.length - 1
    el.append(h("span", { class: "crumb-sep", "aria-hidden": "true" }, "/"))
    el.append(
      last
        ? h("span", { class: "crumb crumb-here", "aria-current": "page", title: item.label }, item.label)
        : h("a", { class: "crumb", href: item.href, "data-nav": "" }, item.label),
    )
  })
}

export function setSkip(label, target) {
  const el = byId("skip")
  if (!el) return
  el.textContent = label
  el.setAttribute("href", `#${target}`)
}

/** state: "connecting" | "live" | "offline" | null (hidden). */
export function setLive(state, label, meta) {
  const el = byId("live")
  if (!el) return
  if (!state) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.dataset.state = state
  const l = byId("live-label")
  const m = byId("live-meta")
  if (l && l.textContent !== label) l.textContent = label
  if (m && m.textContent !== meta) m.textContent = meta
}

export function pulseLive() {
  const el = byId("live")
  if (!el) return
  el.classList.remove("is-polled")
  void el.offsetWidth
  el.classList.add("is-polled")
}

export function setHostMode(content) {
  const el = byId("host-mode")
  if (!el) return
  clear(el)
  el.hidden = !content
  if (content) el.append(...[content].flat())
}

// ------------------------------------------------------------------ keyboard shortcuts popover

let keysCleanup = null

export function showKeys(rows) {
  const root = byId("keys")
  if (!root) return
  hideKeys()
  clear(root)
  root.hidden = false
  const pop = h(
    "div",
    { class: "popover", id: "keys-pop", role: "dialog", "aria-labelledby": "keys-title", hidden: true },
    h("p", { class: "pop-title", id: "keys-title" }, "Keyboard"),
    h(
      "dl",
      { class: "keys" },
      rows.map(([keys, what]) => [h("dt", null, keys.map((k) => h("kbd", null, k))), h("dd", null, what)]),
    ),
    h("p", { class: "keys-note" }, "Keys are ignored while you type in a field."),
  )
  const btn = h(
    "button",
    {
      class: "tool-btn icon-only",
      id: "keys-btn",
      type: "button",
      "aria-label": "Keyboard shortcuts",
      "aria-expanded": "false",
      "aria-controls": "keys-pop",
      title: "Keyboard shortcuts (?)",
      onclick: () => toggleKeys(),
    },
    icon("keys"),
  )
  root.append(btn, pop)
  const outside = (e) => {
    if (!pop.hidden && e.target instanceof Element && !root.contains(e.target)) toggleKeys(false)
  }
  const esc = (e) => {
    if (e.key === "Escape" && !pop.hidden) {
      e.preventDefault()
      e.stopPropagation()
      toggleKeys(false)
      btn.focus()
    }
  }
  document.addEventListener("click", outside)
  document.addEventListener("keydown", esc, true)
  keysCleanup = () => {
    document.removeEventListener("click", outside)
    document.removeEventListener("keydown", esc, true)
  }
}

export function toggleKeys(force) {
  const pop = byId("keys-pop")
  const btn = byId("keys-btn")
  if (!pop || !btn) return
  const open = force ?? pop.hidden
  pop.hidden = !open
  btn.setAttribute("aria-expanded", String(open))
}

export function hideKeys() {
  keysCleanup?.()
  keysCleanup = null
  const root = byId("keys")
  if (root) {
    clear(root)
    root.hidden = true
  }
}
