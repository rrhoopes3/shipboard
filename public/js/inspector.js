// The inspector: one attempt's diff, its sandboxed preview, and its brief (the manifest, the exact
// committed JSON, the lineage, and what a re-run kept and dropped).

import { api } from "./api.js"
import { agentOnline, briefDetail, previewPages } from "./task-card.js"
import { clear, diffSize, h, icon, listPhrase, plural, sha, short, shortLabel, smart } from "./dom.js"
import { renderDiff } from "./diff.js"
import { closeSheet, openSheet } from "./sheet.js"

const TABS = ["diff", "preview", "brief"]
const TAB_LABEL = { diff: "Diff", preview: "Preview", brief: "Brief" }
const TAB_ICON = { diff: "diff", preview: "preview", brief: "brief" }

const STATE_WORD = {
  waiting: ["working", "moon"],
  ready: ["ready", "channel"],
  shipped: ["shipped", "channel"],
  parked: ["parked", "slate"],
  discarded: ["discarded", "slate"],
  failed: ["failed", "buoy"],
}

/** The brief file exactly as committed: keys in contract order, 2-space indent, trailing newline. */
export function canonicalBrief(brief) {
  const out = { id: brief.id, task: brief.task, constraints: brief.constraints, acceptance: brief.acceptance, paths: brief.paths, createdAt: brief.createdAt }
  if (brief.demo !== undefined) out.demo = brief.demo
  return JSON.stringify(out, null, 2) + "\n"
}

export function highlightJson(pre, json) {
  clear(pre)
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?/g
  let last = 0
  let m
  while ((m = re.exec(json))) {
    if (m.index > last) pre.append(json.slice(last, m.index))
    pre.append(h("span", { class: m[2] ? "j-key" : "j-str" }, m[1]))
    if (m[2]) pre.append(m[2])
    last = re.lastIndex
  }
  pre.append(json.slice(last))
}

/**
 * lookup(attemptId) → { task, attempt } from the current board, or null.
 * run(task, action, opts) → Promise<boolean> performs a mutation through the board.
 */
export function createInspector({ lookup, getBoard, run, previewSrc }) {
  const ui = { attemptId: null, tab: "diff", page: new Map(), diffs: new Map(), shown: { diff: "", preview: "" } }

  const eyebrow = h("p", { class: "eyebrow", id: "inspect-eyebrow" })
  const title = h("h2", { class: "sheet-title", id: "inspect-title", tabindex: "-1" })
  const sub = h("p", { class: "sheet-sub mono", id: "inspect-sub" })
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Inspect this attempt" })
  const panes = {}
  const tabEls = {}
  for (const name of TABS) {
    tabEls[name] = h(
      "button",
      { class: "tab", role: "tab", id: `tab-${name}`, type: "button", "aria-controls": `pane-${name}`, onclick: () => select(name) },
      icon(TAB_ICON[name]),
      TAB_LABEL[name],
    )
    tabs.append(tabEls[name])
    panes[name] = h("div", { class: "pane", role: "tabpanel", id: `pane-${name}`, "aria-labelledby": `tab-${name}`, tabindex: "0" })
  }
  tabs.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(ui.tab)
    let next = null
    if (e.key === "ArrowRight") next = TABS[(i + 1) % TABS.length]
    else if (e.key === "ArrowLeft") next = TABS[(i + TABS.length - 1) % TABS.length]
    else if (e.key === "Home") next = TABS[0]
    else if (e.key === "End") next = TABS[TABS.length - 1]
    if (!next) return
    e.preventDefault()
    select(next)
    tabEls[next].focus()
  })

  const sheet = h(
    "section",
    { class: "sheet sheet-inspect", id: "inspect", role: "dialog", "aria-modal": "true", "aria-labelledby": "inspect-title", hidden: true },
    h(
      "div",
      { class: "sheet-inner" },
      h(
        "header",
        { class: "sheet-head" },
        h("div", null, eyebrow, title, sub),
        h("button", { class: "tool-btn icon-only", type: "button", "aria-label": "Close", onclick: () => closeSheet() }, icon("x")),
      ),
      tabs,
      h("div", { class: "sheet-body inspect-body" }, TABS.map((name) => panes[name])),
    ),
  )
  document.body.append(sheet)

  function current() {
    return ui.attemptId ? lookup(ui.attemptId) : null
  }

  function select(name) {
    ui.tab = name
    render()
  }

  function open(attemptId, tab = "diff", opener = null) {
    ui.attemptId = attemptId
    ui.tab = TABS.includes(tab) ? tab : "diff"
    ui.shown = { diff: "", preview: "" }
    if (!current()) return
    render()
    openSheet(sheet, {
      opener,
      focus: () => tabEls[ui.tab],
      onClose: () => {
        ui.attemptId = null
        clear(panes.preview)
        ui.shown.preview = ""
      },
    })
  }

  /** Called after every board render, so an open inspector follows the attempt as it changes. */
  function refresh() {
    if (!ui.attemptId || sheet.hidden) return
    if (!current()) {
      closeSheet()
      return
    }
    render()
  }

  function render() {
    const found = current()
    if (!found) return
    const { task, attempt: a } = found
    const discarded = a.status === "discarded"
    clear(eyebrow).append(`Attempt ${a.number} · ${shortLabel(a.agentLabel)}${discarded ? " · discarded" : a.status === "failed" ? " · failed" : ""}`)
    title.textContent = task.brief.task
    sub.textContent = a.repo
    for (const name of TABS) {
      const on = name === ui.tab
      tabEls[name].setAttribute("aria-selected", String(on))
      tabEls[name].tabIndex = on ? 0 : -1
      panes[name].hidden = !on
    }
    if (ui.tab === "diff") renderDiffPane(task, a)
    if (ui.tab === "preview") renderPreviewPane(task, a)
    if (ui.tab === "brief") renderBriefPane(task, a)
  }

  // ---------------------------------------------------------------- diff

  function renderDiffPane(task, a) {
    const pane = panes.diff
    const k = `${a.id}@${a.headSha}@${a.status}`
    if (ui.shown.diff === k) return
    ui.shown.diff = k
    clear(pane)
    if (a.status === "discarded") {
      pane.append(
        h(
          "div",
          { class: "banner inspect-banner", "data-tone": "buoy", role: "note" },
          icon("x"),
          h("p", null, h("strong", null, "This diff was dropped"), ` when attempt ${a.number + 1} replaced it. It never merges.`, a.discardReason ? ` ${smart(a.discardReason)}` : ""),
        ),
      )
    }
    if (a.headSha === a.briefSha) {
      pane.append(h("p", { class: "pane-state" }, "Nothing has been pushed to this fork yet, so there is no diff. The brief commit is all it holds."))
      return
    }
    const body = h("div", null, h("p", { class: "pane-state", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), "Reading the diff…"))
    pane.append(body)
    let promise = ui.diffs.get(`${a.id}@${a.headSha}`)
    if (!promise) {
      promise = api.diff(a.id)
      ui.diffs.set(`${a.id}@${a.headSha}`, promise)
      promise.catch(() => ui.diffs.delete(`${a.id}@${a.headSha}`))
    }
    promise.then(
      (result) => {
        if (ui.shown.diff !== k) return
        const d = a.digest
        clear(body).append(
          renderDiff(result, {
            unexpected: new Set(d ? d.unexpectedPaths : []),
            conflicts: new Set(a.merge && a.merge.state === "conflict" ? a.merge.paths : []),
          }),
        )
      },
      (err) => {
        if (ui.shown.diff !== k) return
        clear(body).append(
          h(
            "div",
            { class: "pane-state", role: "alert" },
            h("p", null, err.message || "The diff did not load."),
            h("button", { class: "btn btn-outline btn-sm", type: "button", onclick: () => { ui.shown.diff = ""; render() } }, icon("rerun"), "Try again"),
          ),
        )
      },
    )
  }

  // ---------------------------------------------------------------- preview

  function renderPreviewPane(task, a) {
    const pane = panes.preview
    if (!a.previewUrl) {
      ui.shown.preview = ""
      clear(pane).append(h("p", { class: "pane-state" }, "No push yet, so there is nothing to preview."))
      return
    }
    const pages = previewPages(task.current.id === a.id ? task : { ...task, current: a })
    const page = ui.page.get(a.id) ?? pages[0] ?? ""
    const url = `${a.previewUrl}${page}`
    const src = previewSrc(url)
    if (ui.shown.preview === src) return
    ui.shown.preview = src
    clear(pane)
    const select = pages.length > 1
      ? h(
          "select",
          {
            class: "input",
            id: "preview-page",
            onchange: (e) => {
              ui.page.set(a.id, e.currentTarget.value)
              render()
            },
          },
          pages.map((p) => h("option", { value: p, selected: p === page || null }, p)),
        )
      : null
    pane.append(
      h(
        "div",
        { class: "inspect-preview" },
        h(
          "div",
          { class: "preview-tools" },
          select ? [h("label", { class: "field-label", for: "preview-page" }, "Page"), select] : h("span", { class: "mono" }, page || "/"),
          h("span", { class: "sandbox-note" }, icon("shield"), "Sandboxed. Nothing in agent output can run here."),
        ),
        h(
          "div",
          { class: "preview-frame" },
          h(
            "div",
            { class: "preview-bar" },
            h("span", { class: "url", title: url }, h("bdi", null, url)),
            h("a", { href: src, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open the preview in a new tab" }, icon("external")),
          ),
          h(
            "div",
            { class: "preview-box" },
            h("iframe", { src, sandbox: "", referrerpolicy: "no-referrer", title: `Preview of attempt ${a.number} at ${short(a.headSha)}` }),
          ),
        ),
        h("p", { class: "preview-caption" }, `Head ${short(a.headSha)} of ${a.repo}.`),
      ),
    )
  }

  // ---------------------------------------------------------------- brief

  function renderBriefPane(task, a) {
    const pane = panes.brief
    const brief = task.brief
    const board = getBoard()
    const all = [...task.history].reverse().concat(task.current)
    clear(pane)

    const json = h("pre", { class: "code" })
    highlightJson(json, canonicalBrief(brief))

    const rows = all.map((x) => {
      const [word, tone] = STATE_WORD[x.status] ?? [x.status, "slate"]
      return h(
        "tr",
        { "data-current": x.id === a.id || null },
        h("td", null, `#${x.number}`),
        h("td", null, sha(x.briefSha)),
        h("td", null, "on main ", sha(x.baseSha)),
        h("td", null, shortLabel(x.agentLabel)),
        h("td", null, h("span", { class: "state-word", "data-tone": tone }, word)),
      )
    })

    pane.append(
      h(
        "div",
        { class: "inspect-brief" },
        h(
          "div",
          { class: "manifest" },
          h("div", { class: "manifest-top" }, h("span", { class: "bb-label" }, "Brief · first commit"), h("span", { class: "sha-chip" }, short(a.briefSha))),
          h("p", { class: "manifest-subject" }, h("span", { class: "mono" }, "brief: "), brief.task),
          briefDetail(brief, a),
        ),
        h(
          "section",
          { class: "json-block", "aria-label": "The committed brief file" },
          h("p", { class: "section-label" }, "Committed as ", h("span", { class: "path" }, `.shipboard/briefs/${brief.id}.json`)),
          json,
        ),
        h(
          "section",
          { "aria-label": "Lineage" },
          h("p", { class: "section-label" }, all.length > 1 ? `Lineage · the same brief, ${plural(all.length, "fork", "forks")}` : "Lineage"),
          h(
            "table",
            { class: "lineage-table" },
            h("thead", null, h("tr", null, ["Attempt", "Brief commit", "Base", "Agent", "State"].map((t) => h("th", { scope: "col" }, t)))),
            h("tbody", null, rows),
          ),
        ),
        receipt(task, a, board),
        rerunWith(task, a, board),
      ),
    )
  }

  function receipt(task, a, board) {
    if (a.number < 2) return null
    const prev = task.history.find((x) => x.id === a.replaces) ?? task.history.find((x) => x.number === a.number - 1)
    if (!prev) return null
    const size = diffSize(prev.digest)
    const between = board.activity
      .filter((e) => e.kind === "shipped" && e.at >= prev.createdAt && e.at <= a.createdAt)
      .map((e) => {
        const m = /"([^"]+)"/.exec(e.text)
        return m ? `“${m[1]}”` : null
      })
      .filter(Boolean)
    return h(
      "section",
      { "aria-label": "What the re-run kept" },
      h("p", { class: "section-label" }, "What the re-run kept"),
      h(
        "ul",
        { class: "receipt" },
        h("li", { "data-tone": "channel" }, icon("check"), h("span", null, h("strong", null, "Kept"), " the brief, byte for byte: ", h("code", null, `.shipboard/briefs/${task.brief.id}.json`))),
        h(
          "li",
          { "data-tone": "buoy" },
          icon("x"),
          h(
            "span",
            null,
            h("strong", null, "Dropped"),
            size
              ? ` attempt ${prev.number}'s diff (+${size.add} −${size.del} in ${listPhrase(prev.digest.files.map((f) => f.path))}). It was never merged.`
              : ` attempt ${prev.number}, which pushed nothing usable.`,
          ),
        ),
        h(
          "li",
          { "data-tone": "lamp" },
          icon("fork"),
          h("span", null, h("strong", null, "New base"), " main ", sha(a.baseSha), between.length ? `, which now includes ${listPhrase(between)}.` : "."),
        ),
      ),
    )
  }

  function rerunWith(task, a, board) {
    if (task.current.id !== a.id) return null
    if (a.primary !== "rerun" && !a.secondary.includes("rerun")) return null
    const options = board.agents.filter((x) => x.kind !== "demo" || task.brief.demo)
    const select = h(
      "select",
      { class: "input", id: "rerun-agent", "aria-label": "Agent for the re-run" },
      options.map((x) =>
        h("option", { value: x.id, selected: x.id === a.agent || null }, `${shortLabel(x.label)}${x.kind === "cli" ? (agentOnline(x) ? " · online" : " · offline") : ""}`),
      ),
    )
    const button = h(
      "button",
      {
        class: "btn btn-lamp btn-sm",
        type: "button",
        onclick: async () => {
          button.setAttribute("aria-busy", "true")
          const agent = select.value && select.value !== a.agent ? select.value : undefined
          const ok = await run(task, "rerun", { agent })
          button.removeAttribute("aria-busy")
          if (ok) closeSheet()
        },
      },
      icon("rerun"),
      "Re-run",
    )
    return h(
      "div",
      { class: "rerun-with" },
      h("p", null, `Re-run with another agent. The brief is the same bytes; only who runs it changes. It forks main ${short(board.project.mainSha)}.`),
      select,
      button,
    )
  }

  return {
    open,
    refresh,
    isOpen: () => Boolean(ui.attemptId) && !sheet.hidden,
    destroy() {
      if (!sheet.hidden) closeSheet({ restore: false })
      sheet.remove()
    },
  }
}

