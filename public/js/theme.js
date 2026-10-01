// Theme: Auto (follow the OS), Day or Night. A radiogroup in the top bar; one cycle button on
// phones. theme-init.js applies the stored choice before first paint.

import { clear, h, icon } from "./dom.js"

const KEY = "shipboard.theme"
const MODES = ["auto", "light", "dark"]
const NAME = { auto: "Auto", light: "Day", dark: "Night" }
const ICON = { auto: "auto", light: "sun", dark: "moon" }
const TITLE = { auto: "Auto: follow the system", light: "Day: chart paper", dark: "Night: harbor at night" }

function current() {
  const t = document.documentElement.dataset.theme
  return t === "light" || t === "dark" ? t : "auto"
}

function choose(mode) {
  if (mode === "auto") delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = mode
  try {
    if (mode === "auto") localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch {
    // Not stored; it still applies to this page.
  }
  sync()
}

function sync() {
  const mode = current()
  for (const btn of document.querySelectorAll(".theme-opt")) {
    const on = btn.dataset.mode === mode
    btn.setAttribute("aria-checked", String(on))
    btn.tabIndex = on ? 0 : -1
  }
  const cycle = document.getElementById("theme-cycle")
  if (cycle) {
    const next = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
    clear(cycle).append(icon(ICON[mode]))
    cycle.setAttribute("aria-label", `Theme: ${NAME[mode]}. Switch to ${NAME[next]}.`)
    cycle.title = `Theme: ${NAME[mode]}`
  }
}

export function initTheme() {
  const group = document.getElementById("theme-switch")
  if (group && !group.children.length) {
    for (const mode of MODES) {
      group.append(
        h(
          "button",
          {
            class: "theme-opt",
            type: "button",
            role: "radio",
            "data-mode": mode,
            "aria-label": NAME[mode],
            title: TITLE[mode],
            onclick: () => choose(mode),
          },
          icon(ICON[mode]),
        ),
      )
    }
    group.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
      if (!step) return
      e.preventDefault()
      const next = MODES[(MODES.indexOf(current()) + step + MODES.length) % MODES.length]
      choose(next)
      group.querySelector(`[data-mode="${next}"]`)?.focus()
    })
  }
  document.getElementById("theme-cycle")?.addEventListener("click", () => {
    choose(MODES[(MODES.indexOf(current()) + 1) % MODES.length])
  })
  sync()
}
