// Bootstrap and router. Routes: / (home) and /p/<projectId> (a board), navigated with pushState.

import { api, fixture, ready } from "./js/api.js"
import { setConfig } from "./js/auth.js"
import { setHostMode } from "./js/chrome.js"
import { clear, h, icon, setUtc } from "./js/dom.js"
import { mountBoard } from "./js/board.js"
import { mountHome } from "./js/home.js"
import { currentRoute, href, onRoute } from "./js/router.js"
import { initTheme } from "./js/theme.js"
import { closeSheet } from "./js/sheet.js"

const view = document.getElementById("view")
let mounted = null

function mountMissing(root) {
  root.append(
    h(
      "main",
      { id: "main" },
      h(
        "div",
        { class: "state", "data-tone": "slate" },
        h(
          "div",
          { class: "state-inner" },
          icon("anchor", "ic-big"),
          h("h2", null, "Nothing is moored here"),
          h("p", null, "This address is not a page on the board."),
          h("a", { class: "btn btn-outline", href: href("/"), "data-nav": "" }, icon("back"), "All projects"),
        ),
      ),
    ),
  )
  return { unmount() {} }
}

function render() {
  closeSheet({ restore: false })
  mounted?.unmount()
  mounted = null
  clear(view)
  const route = currentRoute()
  document.body.dataset.route = route.name
  if (route.name === "board") mounted = mountBoard(view, route.id)
  else if (route.name === "home") mounted = mountHome(view)
  else mounted = mountMissing(view)
}

onRoute(() => {
  render()
  window.scrollTo(0, 0)
})

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const link = e.target instanceof Element ? e.target.closest("a[data-nav]") : null
  if (!link || link.target === "_blank") return
  const url = new URL(link.href, location.href)
  if (url.origin !== location.origin) return
  e.preventDefault()
  if (url.pathname + url.search !== location.pathname + location.search) history.pushState(null, "", url.pathname + url.search)
  render()
  window.scrollTo(0, 0)
})

window.addEventListener("popstate", render)

async function boot() {
  initTheme()
  if (new URLSearchParams(location.search).get("utc") === "1") setUtc(true)
  await ready()
  if (fixture) {
    const chip = document.getElementById("fixture-chip")
    if (chip) {
      chip.hidden = false
      chip.textContent = `fixture · ${fixture}`
      chip.title = "Fixture data from public/fixtures. Nothing is sent to a board."
    }
  }
  // Brand links keep fixture and clock parameters too.
  for (const a of document.querySelectorAll("a.brand")) a.setAttribute("href", href("/"))
  render()
  try {
    const config = await api.config()
    setConfig(config)
    setHostMode(
      config.mode === "cloudflare"
        ? [h("b", null, "Cloudflare"), config.namespace ? ` · ${config.namespace}` : ""]
        : [h("b", null, "Local board"), ` · ${location.host}`],
    )
  } catch {
    // Views show their own errors; without config the board stays usable and mutations explain themselves.
  }
}

void boot()
