// The dispatch drawer: write a brief, pick an agent, see the exact bytes that become the fork's
// first commit. Re-runs commit the same bytes, so the brief is written once.

import { api, getToken } from "./api.js"
import { explainBlock, handleAuthError, mutationBlock } from "./auth.js"
import { agentOnline } from "./task-card.js"
import { canonicalBrief, highlightJson } from "./inspector.js"
import { agoWords, clear, flag, h, hm, icon, lines, parseAcceptance, setAriaDisabled, sha, shortLabel } from "./dom.js"
import { now } from "./clock.js"
import { closeSheet, openSheet } from "./sheet.js"
import { toast } from "./toast.js"

const LAST_AGENT = "shipboard.lastAgent"
const LIMITS = { task: 240, constraints: 12, constraint: 240, paths: 20, acceptance: 2000 }
const drafts = new Map()

function slug(input, max) {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "")
}

/** Mirrors the server's path rule, so most mistakes are caught before a round trip. */
function pathProblem(path) {
  if (/\s/.test(path)) return `“${path}” has a space in it. Paths cannot contain spaces.`
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path) || path.includes("\\")) return `“${path}” is outside the repo. Use a path like site/index.html.`
  const parts = path.replace(/\/$/, "").split("/")
  if (parts.some((p) => p === "" || p === "." || p === "..")) return `“${path}” is outside the repo. Use a path like site/index.html.`
  if (parts.some((p) => /^\.git[. ]*$/i.test(p))) return `“${path}” touches the .git directory, which no brief may name.`
  if (path.length > 200) return "Keep each path under 200 characters."
  return null
}

function rememberAgent(id) {
  try {
    localStorage.setItem(LAST_AGENT, id)
  } catch {
    // Only a convenience.
  }
}

function lastAgent() {
  try {
    return localStorage.getItem(LAST_AGENT)
  } catch {
    return null
  }
}

/** Agents in picker order: runner agents first, then Manual, then Demo. */
function pickerAgents(agents) {
  const rank = (a) => (a.kind === "cli" ? 0 : a.kind === "manual" ? 1 : 2)
  return agents.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a)
}

function agentStatus(info) {
  if (info.kind === "demo") return { on: "builtin", text: "built in · demo briefs only" }
  if (info.kind === "manual") return { on: "builtin", text: "you push" }
  if (agentOnline(info)) return { on: "true", text: `online · ${agoWords(info.lastSeenAt)}` }
  return { on: "false", text: info.lastSeenAt ? `offline · ${agoWords(info.lastSeenAt)}` : "never seen" }
}

/** onResult(res) gets the API response ({ board, attemptId, notice }) after a dispatch lands. */
export function createDispatch({ projectId, getBoard, onResult }) {
  const draft = drafts.get(projectId) ?? { task: "", constraints: "", acceptance: "", paths: "", agent: null, credentials: true }
  drafts.set(projectId, draft)
  let busy = false

  const f = {
    task: h("input", { class: "input", id: "f-task", name: "task", maxlength: String(LIMITS.task), autocomplete: "off", "aria-describedby": "task-count task-error", placeholder: "e.g. Post the ferry times under the tide table" }),
    constraints: h("textarea", { class: "input", id: "f-constraints", name: "constraints", rows: "3", "aria-describedby": "constraints-hint constraints-error", placeholder: "e.g. Static HTML only. No scripts." }),
    acceptance: h("textarea", { class: "input mono-input", id: "f-acceptance", name: "acceptance", rows: "3", "aria-describedby": "acceptance-hint acc-parse acceptance-error", spellcheck: "false", placeholder: 'e.g. contains site/tides.html "Ferry"' }),
    paths: h("textarea", { class: "input mono-input", id: "f-paths", name: "paths", rows: "2", "aria-describedby": "paths-hint paths-error", spellcheck: "false", placeholder: "e.g. site/tides.html" }),
  }
  const err = {
    task: h("p", { class: "field-error", id: "task-error", hidden: true }),
    constraints: h("p", { class: "field-error", id: "constraints-error", hidden: true }),
    acceptance: h("p", { class: "field-error", id: "acceptance-error", hidden: true }),
    paths: h("p", { class: "field-error", id: "paths-error", hidden: true }),
    agent: h("p", { class: "field-error", id: "agent-error", hidden: true }),
  }
  f.task.value = draft.task
  f.constraints.value = draft.constraints
  f.acceptance.value = draft.acceptance
  f.paths.value = draft.paths

  const count = h("span", { class: "counter", id: "task-count", "aria-live": "off" }, `0 / ${LIMITS.task}`)
  const accParse = h("ul", { class: "acc-parse", id: "acc-parse", "aria-label": "How each acceptance line will be read" })
  const grid = h("div", { class: "agent-grid", role: "radiogroup", "aria-labelledby": "agent-legend" })
  const agentNote = h("p", { class: "agent-note", id: "agent-note" })
  const cred = h("input", { type: "checkbox", name: "credentials", id: "f-credentials" })
  cred.checked = draft.credentials
  const credRow = h("label", { class: "check", for: "f-credentials", hidden: true }, cred, h("span", null, "Return a one-hour write token so I can ", h("code", null, "git push"), " myself"))
  const filePath = h("span", { class: "brief-file-path" })
  const json = h("pre", { class: "code" })
  const formError = h("p", { class: "form-error", role: "alert", hidden: true })
  const mainSha = h("span", { class: "sha" })
  const submit = h("button", { class: "btn btn-lamp", type: "submit" })
  const body = h("div", { class: "sheet-body" })
  const foot = h("footer", { class: "sheet-foot" })

  const fields = [
    formError,
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-top" }, h("label", { class: "field-label", for: "f-task" }, "Task"), count),
      f.task,
      err.task,
    ),
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-top" }, h("label", { class: "field-label", for: "f-constraints" }, "Constraints"), h("span", { class: "hint", id: "constraints-hint" }, "One per line. Up to 12.")),
      f.constraints,
      err.constraints,
    ),
    h(
      "div",
      { class: "field" },
      h(
        "div",
        { class: "field-top" },
        h("label", { class: "field-label", for: "f-acceptance" }, "Acceptance"),
        h("span", { class: "hint", id: "acceptance-hint" }, "Checked by machine when a line reads ", h("code", null, 'contains path "text"')),
      ),
      f.acceptance,
      accParse,
      err.acceptance,
    ),
    h(
      "div",
      { class: "field" },
      h("div", { class: "field-top" }, h("label", { class: "field-label", for: "f-paths" }, "Paths"), h("span", { class: "hint", id: "paths-hint" }, "One per line. A path ending in / covers everything under it.")),
      f.paths,
      err.paths,
    ),
    h("fieldset", { class: "field" }, h("legend", { class: "field-label", id: "agent-legend" }, "Agent"), grid, agentNote, credRow, err.agent),
    h(
      "details",
      { class: "brief-file", open: true },
      h("summary", null, icon("brief"), "What gets committed", filePath, icon("chevron", "ic-trail chev")),
      json,
    ),
  ]

  const form = h(
    "form",
    { class: "sheet-inner", novalidate: true },
    h(
      "header",
      { class: "sheet-head" },
      h(
        "div",
        null,
        h("p", { class: "eyebrow" }, "New brief"),
        h("h2", { class: "sheet-title", id: "dispatch-title", tabindex: "-1" }, "Dispatch a brief"),
        h("p", { class: "sheet-sub" }, "The brief becomes the first commit of a fresh fork of main ", mainSha, ". The agent gets that fork and nothing else."),
      ),
      h("button", { class: "tool-btn icon-only", type: "button", "aria-label": "Close", onclick: () => closeSheet() }, icon("x")),
    ),
    body,
    foot,
  )
  const sheet = h("section", { class: "sheet sheet-dispatch", id: "dispatch", role: "dialog", "aria-modal": "true", "aria-labelledby": "dispatch-title", hidden: true }, form)
  document.body.append(sheet)

  form.addEventListener("input", (e) => {
    if (e.target === cred) draft.credentials = cred.checked
    else update()
  })
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    void send()
  })

  function showForm() {
    clear(body).append(...fields)
    clear(foot).append(
      h("p", { class: "foot-note" }, "Re-runs commit these same bytes again, so write it once and well."),
      h("div", { class: "foot-actions" }, h("button", { class: "btn btn-quiet", type: "button", onclick: () => closeSheet() }, "Cancel"), submit),
    )
  }

  function agents() {
    return pickerAgents(getBoard()?.agents ?? [])
  }

  function chosen() {
    return agents().find((a) => a.id === draft.agent) ?? null
  }

  function defaultAgent() {
    const list = agents().filter((a) => a.kind !== "demo")
    const remembered = list.find((a) => a.id === lastAgent())
    return (remembered ?? list.find((a) => a.kind === "cli" && agentOnline(a)) ?? list.find((a) => a.kind === "manual") ?? list[0])?.id ?? null
  }

  function renderAgents() {
    clear(grid)
    for (const info of agents()) {
      const st = agentStatus(info)
      const id = `agent-${info.id}`
      const demo = info.kind === "demo"
      grid.append(
        h(
          "label",
          { class: "agent-opt", for: id, title: demo ? "The demo agent only runs the harbor demo's scripted briefs." : null },
          h("input", {
            type: "radio",
            name: "agent",
            id,
            value: info.id,
            checked: info.id === draft.agent || null,
            disabled: demo || null,
            "aria-describedby": `${id}-status`,
            onchange: () => {
              draft.agent = info.id
              update()
            },
          }),
          h(
            "span",
            { class: "agent-card" },
            h("span", { class: "agent-top" }, flag(info.id, info.label), h("span", null, shortLabel(info.label))),
            h("span", { class: "agent-status", id: `${id}-status`, "data-on": st.on }, h("span", { class: "dot", "aria-hidden": "true" }), st.text),
          ),
        ),
      )
    }
  }

  function noteFor(info) {
    if (!info) return "Pick who works on it."
    const name = shortLabel(info.label)
    if (info.kind === "manual") return "No job is queued. You, or an agent you run yourself, push to the fork with the agent CLI."
    if (info.kind === "demo") return "The demo agent only runs the harbor demo's scripted briefs."
    if (agentOnline(info)) return `${name} has a runner online. It usually starts within a few seconds.`
    if (!info.lastSeenAt) return `No runner offering ${name} has been seen yet. It will wait in Agent working until one polls.`
    return `No ${name} runner has checked in since ${agoWords(info.lastSeenAt)}. It will wait in Agent working until a runner offering ${name} polls.`
  }

  function read() {
    return {
      task: f.task.value.replace(/\s+/g, " ").trim(),
      constraints: lines(f.constraints.value),
      acceptance: f.acceptance.value.split(/\r?\n/).map((l) => l.trimEnd()).join("\n").trim(),
      paths: lines(f.paths.value),
    }
  }

  function update() {
    draft.task = f.task.value
    draft.constraints = f.constraints.value
    draft.acceptance = f.acceptance.value
    draft.paths = f.paths.value
    const d = read()
    count.textContent = `${f.task.value.length} / ${LIMITS.task}`
    count.toggleAttribute("data-over", f.task.value.length >= LIMITS.task)

    clear(accParse)
    const parsed = parseAcceptance(d.acceptance)
    for (const x of parsed) {
      accParse.append(
        x.kind === "machine"
          ? h("li", null, h("span", { class: "acc-tag", "data-tone": "channel" }, "machine check"), h("span", null, h("code", null, x.path), " must contain ", h("code", null, `“${x.text}”`)))
          : h("li", null, h("span", { class: "acc-tag", "data-tone": "slate" }, "for a person"), h("span", null, x.line)),
      )
    }
    if (!parsed.length) {
      accParse.append(h("li", null, h("span", { class: "acc-tag", "data-tone": "slate" }, "none"), h("span", null, "With no check the digest says unchecked; read the diff before shipping.")))
    }

    const info = chosen()
    agentNote.textContent = noteFor(info)
    credRow.hidden = !info || info.kind !== "manual"
    clear(submit).append(icon("brief"), info ? `Dispatch to ${shortLabel(info.label)}` : "Dispatch")
    const block = mutationBlock()
    setAriaDisabled(submit, Boolean(block))
    if (block) submit.prepend(icon("lock"))

    const id = `${slug(d.task || "task", 20) || "task"}-····`
    filePath.textContent = `.shipboard/briefs/${id}.json`
    highlightJson(json, canonicalBrief({ id, task: d.task, constraints: d.constraints, acceptance: d.acceptance, paths: d.paths, createdAt: new Date(now()).toISOString() }))
  }

  function validate(d) {
    const problems = {}
    if (!d.task) problems.task = "Write the task."
    else if (d.task.length > LIMITS.task) problems.task = `Keep the task to ${LIMITS.task} characters.`
    if (d.constraints.length > LIMITS.constraints) problems.constraints = "Keep constraints to 12 lines."
    else if (d.constraints.some((c) => c.length > LIMITS.constraint)) problems.constraints = `Keep each constraint to ${LIMITS.constraint} characters.`
    if (d.acceptance.length > LIMITS.acceptance) problems.acceptance = "Keep the acceptance text to 2,000 characters."
    if (!d.paths.length) problems.paths = "Name at least one path the agent may touch."
    else if (d.paths.length > LIMITS.paths) problems.paths = "Keep it to 20 paths."
    else {
      const bad = d.paths.map(pathProblem).find(Boolean)
      if (bad) problems.paths = bad
    }
    if (!chosen()) problems.agent = "Pick an agent."
    return problems
  }

  function showProblems(problems) {
    for (const [name, el] of Object.entries(err)) {
      const text = problems[name]
      el.hidden = !text
      el.textContent = text ?? ""
      f[name]?.setAttribute("aria-invalid", String(Boolean(text)))
    }
    const first = ["task", "constraints", "acceptance", "paths"].find((n) => problems[n])
    if (first) f[first].focus()
    else if (problems.agent) grid.querySelector("input:not(:disabled)")?.focus()
  }

  async function send() {
    if (busy) return
    formError.hidden = true
    const d = read()
    const problems = validate(d)
    showProblems(problems)
    if (Object.keys(problems).length) return
    const block = mutationBlock()
    if (block) {
      closeSheet()
      explainBlock(block)
      return
    }
    const info = chosen()
    const input = { task: d.task, constraints: d.constraints, acceptance: d.acceptance, paths: d.paths, agent: info.id }
    const token = getToken()
    if (info.kind === "manual" && cred.checked) input.credentials = true
    busy = true
    submit.setAttribute("aria-busy", "true")
    clear(submit).append(h("span", { class: "spinner", "aria-hidden": "true" }), "Forking main…")
    try {
      const res = await api.dispatch(projectId, input)
      if (getToken() !== token) {
        closeSheet()
        return
      }
      rememberAgent(info.id)
      if (!res.fixture) drafts.set(projectId, { task: "", constraints: "", acceptance: "", paths: "", agent: info.id, credentials: true })
      onResult(res)
      if (res.credentials) showCredentials(res)
      else {
        if (!res.fixture) resetFields()
        closeSheet()
      }
    } catch (e) {
      if (getToken() !== token) return
      if (e.status === 401 || e.status === 503) {
        closeSheet()
        handleAuthError(e)
      } else {
        formError.hidden = false
        formError.textContent = e.network ? "The board is not answering. Your brief is still here; try again in a moment." : e.message
        formError.scrollIntoView({ block: "nearest" })
      }
    } finally {
      busy = false
      submit.removeAttribute("aria-busy")
      update()
    }
  }

  function resetFields() {
    const fresh = drafts.get(projectId)
    if (!fresh) return
    Object.assign(draft, fresh)
    f.task.value = ""
    f.constraints.value = ""
    f.acceptance.value = ""
    f.paths.value = ""
    showProblems({})
  }

  function showCredentials(res) {
    const c = res.credentials
    const secret = String(c.token).split("?expires=")[0]
    const basic = btoa(`x:${secret}`)
    const dir = res.attemptId ?? "fork"
    const env = 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="$SHIPBOARD_AUTH"'
    const commands = [
      "# The token stays in this shell's environment, not in a URL or .git/config.",
      `export SHIPBOARD_AUTH="Authorization: Basic ${basic}"`,
      `${env} git clone ${c.remote} ${dir}`,
      `cd ${dir}`,
      "# Make the change and commit it, then:",
      `${env} git push origin HEAD:main`,
    ].join("\n")
    const copy = h(
      "button",
      {
        class: "btn btn-outline btn-sm",
        type: "button",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(commands)
            toast("ok", "Copied the push commands.")
          } catch {
            toast("info", "The browser did not allow copying here.", "Select the commands and copy them by hand.")
          }
        },
      },
      icon("copy"),
      "Copy",
    )
    clear(body).append(
      h(
        "div",
        { class: "cred-panel" },
        h("p", { class: "section-label" }, "Push it yourself"),
        h("p", null, res.notice ?? "Forked. Push to the fork with the token below; the board picks it up."),
        h("pre", { class: "code" }, commands),
        h("p", { class: "cred-warn" }, `This token can push to ${dir} only and expires at ${hm(c.expiresAt)}. Don't paste it anywhere public.`),
      ),
    )
    clear(foot).append(
      h("p", { class: "foot-note" }, "The card waits in Agent working until the push lands."),
      h("div", { class: "foot-actions" }, copy, h("button", { class: "btn btn-lamp", type: "button", onclick: () => { resetFields(); closeSheet() } }, "Done")),
    )
    body.querySelector("pre")?.focus()
  }

  return {
    open(opener = null) {
      const block = mutationBlock()
      if (block) {
        explainBlock(block)
        return
      }
      const board = getBoard()
      if (!board) return
      if (!draft.agent || !agents().some((a) => a.id === draft.agent && a.kind !== "demo")) draft.agent = defaultAgent()
      clear(mainSha).append(sha(board.project.mainSha).textContent)
      mainSha.title = board.project.mainSha
      showForm()
      renderAgents()
      update()
      openSheet(sheet, { opener, focus: () => f.task })
    },
    /** Agent online status ages with the board; keep the open drawer current. */
    refresh() {
      if (sheet.hidden || !getBoard()) return
      if (!body.contains(grid)) return
      const focused = document.activeElement
      const focusedId = focused instanceof HTMLInputElement && focused.name === "agent" ? focused.id : null
      renderAgents()
      if (focusedId) document.getElementById(focusedId)?.focus()
      agentNote.textContent = noteFor(chosen())
      clear(mainSha).append(sha(getBoard().project.mainSha).textContent)
    },
    destroy() {
      if (!sheet.hidden) closeSheet({ restore: false })
      sheet.remove()
    },
  }
}
