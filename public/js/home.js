// Home: the idea in one line, the harbor demo, how it works, the projects on this board, and a new project.

import { api } from "./api.js"
import { authBanner, explainBlock, handleAuthError, mutationBlock, onAuthChange, openUnlock } from "./auth.js"
import { setCrumbs, setLive, setSkip } from "./chrome.js"
import { clear, dayOrTime, flag, h, icon, plural, setAriaDisabled, sha } from "./dom.js"
import { LANE_TONE } from "./task-card.js"
import { boardHref, navigate } from "./router.js"
import { toast } from "./toast.js"

const LANE_ORDER = ["rerun", "ship", "review", "working", "parked", "shipped"]
const CHIP = { rerun: "Re-run", ship: "Ready", review: "Look", working: "Working", parked: "Parked", shipped: "Shipped" }

function exampleCard() {
  return h(
    "figure",
    { class: "wake-demo", "aria-label": "Example: one brief, two attempts" },
    h(
      "div",
      { class: "card-meta" },
      h("span", { class: "agent" }, flag("claude"), h("span", { class: "agent-name" }, "Claude Code")),
      h("span", { class: "attempt-no" }, "· attempt 2"),
      h("span", { class: "rerun-tag" }, icon("rerun"), "re-run"),
    ),
    h("p", { class: "card-title" }, "Tint the pier name in channel teal"),
    h(
      "ol",
      { class: "lineage", "aria-label": "The brief, then each attempt, oldest first" },
      h(
        "li",
        { class: "node node-brief" },
        h(
          "div",
          { class: "brief-block" },
          h("span", { class: "bb-top" }, h("span", { class: "bb-label" }, "Brief · first commit"), h("span", { class: "sha-chip" }, "e81c442")),
          h("span", { class: "bb-id" }, "tint-the-pier-name-i-9c01"),
          h("span", { class: "bb-sum" }, "2 constraints · 1 check · ", h("span", { class: "bb-same" }, "same bytes in both forks")),
        ),
      ),
      h(
        "li",
        { class: "node node-past" },
        h("div", { class: "node-head" }, h("span", { class: "node-name" }, "Attempt 1"), h("span", { class: "past-word" }, "discarded")),
        h("p", { class: "node-line is-mono" }, h("span", { class: "struck" }, "fork of 7d20b44 · head 9d4c2a0")),
        h(
          "p",
          { class: "discard-reason" },
          "Conflicted with main in site/index.html after “Rename the pier mark to the night board” shipped.",
          h("span", { class: "never-merges" }, "Its diff ", h("span", { class: "struck" }, "+1 −1"), " never merges."),
        ),
        h("p", { class: "wake-label" }, icon("rerun"), "re-run · diff dropped"),
      ),
      h(
        "li",
        { class: "node node-current", "data-tone": "channel" },
        h("div", { class: "node-head" }, h("span", { class: "node-name" }, "Attempt 2"), h("span", { class: "node-sub" }, "fresh fork of main a41f9e3")),
        h("p", { class: "node-line is-mono" }, "brief e81c442 → head 7a0c3f1"),
        h(
          "div",
          { class: "pills" },
          h("span", { class: "pill", "data-tone": "channel" }, icon("check"), h("span", null, "On brief 1/1")),
          h("span", { class: "pill", "data-tone": "channel" }, icon("commit"), h("span", null, "Clean · ", h("span", { class: "sha" }, "a41f9e3"))),
        ),
      ),
    ),
    h("div", { class: "primary" }, h("span", { class: "btn btn-channel btn-block", "aria-hidden": "true" }, icon("ship"), "Ship to main")),
    h("figcaption", null, "The brief is the durable thing. The conflicted diff was dropped, not repaired."),
  )
}

const STEPS = [
  ["01", "The brief is the first commit", "Task, constraints, acceptance check and paths, committed to a fresh fork of main. The agent gets a token for that fork only."],
  ["02", "Push, then digest", "Each push is read against its brief and trial-merged against the current main with real git."],
  ["03", "Conflict, then re-run", "A fork that stops merging is not repaired. Its diff is dropped and the same brief runs again on the new main."],
  ["04", "Ship", "One card per task, one button. You decide what ships; nobody merges by hand."],
]

export function mountHome(view) {
  setCrumbs([])
  setSkip("Skip to projects", "projects-title")
  setLive(null)
  document.title = "shipboard · Agents fork. Humans ship. Nobody merges."
  let stopped = false

  const banners = h("div", { class: "banners" })
  const status = h("p", { class: "hero-status", role: "status" })
  const demoBtn = h("button", { class: "btn btn-lamp btn-lg", type: "button", onclick: runDemo })
  const count = h("p", { class: "section-sub" })
  const list = h("div", { class: "projects" })
  const form = createForm()

  const page = h(
    "div",
    { class: "page page-home" },
    banners,
    h(
      "main",
      { class: "home-main", id: "main" },
      h(
        "section",
        { class: "hero", "aria-labelledby": "hero-title" },
        h(
          "div",
          null,
          h("p", { class: "eyebrow" }, "shipboard · one fork per agent task"),
          h("h1", { class: "hero-title", id: "hero-title" }, "Agents fork. Humans ship. ", h("em", null, "Nobody merges.")),
          h(
            "p",
            { class: "hero-lede" },
            "Every agent task is a fork whose ",
            h("strong", null, "first commit is its brief"),
            ". When a fork stops merging, shipboard drops the diff and runs the same brief again on the new main. You get a Ship button, not a merge editor.",
          ),
          h(
            "div",
            { class: "hero-cta" },
            demoBtn,
            h("p", { class: "hero-note" }, "Opens “Harbor notes”, a pier notice with three briefs for the scripted demo agent. Ship two. The third conflicts, and you re-run it."),
          ),
          status,
        ),
        exampleCard(),
      ),
      h(
        "ol",
        { class: "steps", "aria-label": "How it works" },
        STEPS.map(([no, title, text]) => h("li", { class: "step" }, h("p", { class: "step-no" }, no), h("h2", { class: "step-title" }, title), h("p", null, text))),
      ),
      h(
        "div",
        { class: "home-grid" },
        h(
          "section",
          { "aria-labelledby": "projects-title" },
          h("div", { class: "section-head" }, h("h2", { class: "section-title", id: "projects-title", tabindex: "-1" }, "Projects"), count),
          list,
        ),
        h("section", { class: "create", "aria-labelledby": "create-title" }, h("div", { class: "section-head" }, h("h2", { class: "section-title", id: "create-title" }, "Create a project")), form.el),
      ),
      h(
        "footer",
        { class: "home-foot" },
        h("p", null, "Built on Cloudflare Artifacts, Workers, Durable Objects and Workflows."),
        h("p", { class: "mono", id: "home-mode" }, "MIT"),
      ),
    ),
  )
  view.append(page)

  function renderChrome() {
    clear(banners)
    const banner = authBanner()
    if (banner) banners.append(banner)
    const block = mutationBlock()
    clear(demoBtn).append(icon(block ? "lock" : "rerun"), "Run the harbor demo")
    demoBtn.classList.toggle("is-locked", Boolean(block))
    setAriaDisabled(demoBtn, Boolean(block))
    demoBtn.toggleAttribute("data-opens-unlock", Boolean(block))
    form.sync()
  }

  async function runDemo() {
    const block = mutationBlock()
    if (block) return explainBlock(block)
    if (demoBtn.getAttribute("aria-busy") === "true") return
    demoBtn.setAttribute("aria-busy", "true")
    clear(demoBtn).append(h("span", { class: "spinner", "aria-hidden": "true" }), "Cutting the harbor…")
    status.removeAttribute("data-tone")
    status.textContent = "Forking the notice board three ways. Each brief becomes the first commit of its fork."
    try {
      const res = await api.demo()
      if (stopped) return
      if (res.notice) toast("ok", res.notice)
      if (res.projectId) navigate(`/p/${res.projectId}`)
      else {
        status.textContent = ""
        renderChrome()
      }
    } catch (err) {
      if (stopped) return
      demoBtn.removeAttribute("aria-busy")
      renderChrome()
      if (handleAuthError(err)) {
        status.textContent = ""
        return
      }
      status.dataset.tone = "buoy"
      status.textContent = err.network ? "The board is not answering. Try again in a moment." : err.message
    }
  }

  function renderProjects(projects) {
    clear(list)
    count.textContent = `${plural(projects.length, "project", "projects")} on this board`
    if (!projects.length) {
      list.append(h("p", { class: "projects-empty" }, "No projects yet. Run the harbor demo, or start one below."))
      return
    }
    for (const p of projects) {
      list.append(
        h(
          "a",
          { class: "project-card", href: boardHref(p.id), "data-nav": "" },
          h("h3", null, p.name),
          h("p", { class: "pc-desc" }, p.description || "No description."),
          h("p", { class: "pc-meta" }, h("span", null, "main ", sha(p.mainSha)), h("span", null, p.id), h("span", null, `created ${dayOrTime(p.createdAt)}`)),
          h(
            "p",
            { class: "counts", "aria-label": LANE_ORDER.map((l) => `${CHIP[l]} ${p.counts[l] ?? 0}`).join(", ") },
            LANE_ORDER.map((lane) =>
              h(
                "span",
                { class: "count-chip", "data-lane": lane, "data-tone": LANE_TONE[lane], "data-zero": (p.counts[lane] ?? 0) === 0 || null, "aria-hidden": "true" },
                CHIP[lane],
                " ",
                h("b", null, String(p.counts[lane] ?? 0)),
              ),
            ),
          ),
        ),
      )
    }
  }

  async function loadProjects() {
    clear(list).append(h("div", { class: "project-card is-skeleton", "aria-hidden": "true" }), h("div", { class: "project-card is-skeleton", "aria-hidden": "true" }))
    count.textContent = "Loading…"
    try {
      const projects = await api.projects()
      if (!stopped) renderProjects(projects)
    } catch (err) {
      if (stopped) return
      count.textContent = ""
      clear(list)
      if (err.status === 401) {
        list.append(
          h(
            "div",
            { class: "projects-empty" },
            h("p", null, "This board needs its token to read. Unlock to continue."),
            h("button", { class: "btn btn-lamp btn-sm", type: "button", "data-opens-unlock": "", onclick: () => openUnlock("This board needs its token to read.") }, icon("key"), "Unlock"),
          ),
        )
        return
      }
      list.append(
        h(
          "div",
          { class: "projects-empty" },
          h("p", null, err.network ? "The board is not answering, so the project list is empty for now." : err.message),
          h("button", { class: "btn btn-outline btn-sm", type: "button", onclick: () => void loadProjects() }, icon("rerun"), "Try again"),
        ),
      )
    }
  }

  async function loadConfig() {
    try {
      const config = await api.config()
      const mode = document.getElementById("home-mode")
      if (mode) mode.textContent = config.mode === "cloudflare" ? `MIT · Cloudflare${config.namespace ? ` · ${config.namespace}` : ""}` : "MIT · local board"
    } catch {
      // The project list explains a dead board; the footer can stay plain.
    }
  }

  const offAuth = onAuthChange(() => {
    renderChrome()
    void loadProjects()
  })
  renderChrome()
  void loadConfig()
  void loadProjects()

  return {
    unmount() {
      stopped = true
      offAuth()
      page.remove()
    },
  }
}

function createForm() {
  const name = h("input", { class: "input", id: "p-name", name: "name", maxlength: "60", autocomplete: "off", placeholder: "e.g. Harbor notes", "aria-describedby": "name-error", required: true })
  const desc = h("input", { class: "input", id: "p-desc", name: "description", maxlength: "280", autocomplete: "off", placeholder: "e.g. Pier notices for the night shift" })
  const url = h("input", { class: "input mono-input", id: "p-url", name: "importUrl", type: "url", inputmode: "url", autocomplete: "off", spellcheck: "false", placeholder: "https://github.com/you/repo.git", "aria-describedby": "url-help url-error" })
  const nameError = h("p", { class: "field-error", id: "name-error", hidden: true })
  const urlError = h("p", { class: "field-error", id: "url-error", hidden: true })
  const formError = h("p", { class: "form-error", role: "alert", hidden: true })
  const starter = h("input", { type: "radio", name: "seed", value: "starter", checked: true })
  const importing = h("input", { type: "radio", name: "seed", value: "import" })
  const urlField = h(
    "div",
    { class: "field", hidden: true },
    h("label", { class: "field-label", for: "p-url" }, "Repository URL"),
    url,
    h("p", { class: "hint", id: "url-help" }, "A public https git URL. Its default branch becomes main."),
    urlError,
  )
  const submit = h("button", { class: "btn btn-outline", type: "submit" })
  let busy = false

  const el = h(
    "form",
    { novalidate: true },
    formError,
    h("div", { class: "field" }, h("label", { class: "field-label", for: "p-name" }, "Name"), name, nameError),
    h("div", { class: "field" }, h("label", { class: "field-label", for: "p-desc" }, "Description ", h("span", { class: "hint" }, "optional")), desc),
    h(
      "fieldset",
      { class: "field" },
      h("legend", { class: "field-label" }, "Main starts from"),
      h(
        "div",
        { class: "seed-seg" },
        h("label", { class: "seed-opt" }, starter, h("span", { class: "seed-card" }, "Starter site", h("small", null, "site/index.html and a README"))),
        h("label", { class: "seed-opt" }, importing, h("span", { class: "seed-card" }, "Import a repo", h("small", null, "a public https git URL"))),
      ),
    ),
    urlField,
    h("div", { class: "create-foot" }, h("p", null, "Briefs land as files under ", h("code", null, ".shipboard/briefs/"), " on main."), submit),
  )

  for (const radio of [starter, importing]) radio.addEventListener("change", () => (urlField.hidden = !importing.checked))

  function sync() {
    const block = mutationBlock()
    clear(submit).append(busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(block ? "lock" : "plus"), busy ? "Creating…" : "Create project")
    setAriaDisabled(submit, Boolean(block))
    submit.toggleAttribute("data-opens-unlock", Boolean(block))
  }

  el.addEventListener("submit", async (e) => {
    e.preventDefault()
    if (busy) return
    formError.hidden = true
    const n = name.value.replace(/\s+/g, " ").trim()
    const u = url.value.trim()
    const nameProblem = !n ? "Name the project." : n.length > 60 ? "Keep the project name to 60 characters or fewer." : null
    let urlProblem = null
    if (importing.checked) {
      try {
        const parsed = new URL(u)
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) urlProblem = "Give a public https git URL to import, with no credentials in it."
      } catch {
        urlProblem = "Give a public https git URL to import."
      }
    }
    nameError.hidden = !nameProblem
    nameError.textContent = nameProblem ?? ""
    name.setAttribute("aria-invalid", String(Boolean(nameProblem)))
    urlError.hidden = !urlProblem
    urlError.textContent = urlProblem ?? ""
    url.setAttribute("aria-invalid", String(Boolean(urlProblem)))
    if (nameProblem) return name.focus()
    if (urlProblem) return url.focus()
    const block = mutationBlock()
    if (block) return explainBlock(block)
    const input = { name: n }
    if (desc.value.trim()) input.description = desc.value.trim()
    if (importing.checked) input.importUrl = u
    else input.seed = "starter"
    busy = true
    submit.setAttribute("aria-busy", "true")
    sync()
    try {
      const res = await api.createProject(input)
      if (res.notice) toast(res.fixture ? "info" : "ok", res.notice)
      if (res.project) navigate(`/p/${res.project.id}`)
    } catch (err) {
      if (!handleAuthError(err)) {
        formError.hidden = false
        formError.textContent = err.network ? "The board is not answering. Try again in a moment." : err.message
      }
    } finally {
      busy = false
      submit.removeAttribute("aria-busy")
      if (submit.isConnected) sync()
    }
  })

  return { el, sync }
}
