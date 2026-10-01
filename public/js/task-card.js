// One card per brief. Top to bottom: who and which attempt, the task, the lineage rail (the brief as
// the first commit, each discarded attempt with why, the current attempt), the one button, the tools.
// The button comes from AttemptView.primary only; the client never decides what may be shipped.

import { secondsSince, agoWords, diffSize, fullTime, h, hm, hms, icon, flag, listPhrase, mmss, parseAcceptance, plural, sha, short, shortLabel, smart } from "./dom.js"
import { now } from "./clock.js"

const ONLINE_MS = 2 * 60 * 1000

export const LANE_TONE = { rerun: "buoy", ship: "channel", review: "lamp", working: "moon", parked: "slate", shipped: "channel" }

export const key = (briefId, name) => `${briefId}:${name}`

// ------------------------------------------------------------------ small facts

export function agentOnline(info) {
  if (!info) return false
  if (info.kind !== "cli") return true
  return Boolean(info.lastSeenAt) && now() - Date.parse(info.lastSeenAt) < ONLINE_MS
}

function pushedAt(a) {
  if (a.job && a.job.finishedAt && a.job.outcome && a.job.outcome.reason === "pushed") return a.job.finishedAt
  return a.digest ? a.merge?.checkedAt ?? a.updatedAt : a.updatedAt
}

function currentReview(a) {
  return a.review && a.review.headSha === a.headSha ? a.review : null
}

const isWaiting = (a) => a.status === "waiting" || (a.status === "ready" && !a.merge && !a.digest)

/** The newest shipped activity at or before `at`, for the main timeline. */
export function shipBefore(board, at) {
  let best = null
  for (const entry of board.activity) {
    if (entry.kind !== "shipped") continue
    if (at && entry.at > at) continue
    if (!best || entry.at >= best.at) best = entry
  }
  return best
}

export function taskTitleOf(board, entry) {
  if (!entry) return null
  if (entry.briefId) {
    for (const lane of board.lanes) for (const t of lane.tasks) if (t.brief.id === entry.briefId) return t.brief.task
  }
  const m = /"([^"]+)"/.exec(entry.text)
  return m ? m[1] : null
}

function briefSummary(brief) {
  const acc = parseAcceptance(brief.acceptance)
  const machine = acc.filter((x) => x.kind === "machine").length
  const person = acc.length - machine
  const parts = [plural(brief.constraints.length, "constraint", "constraints"), plural(machine, "check", "checks")]
  if (person) parts.push(`${person} for a person`)
  parts.push(brief.paths.length <= 2 ? brief.paths.join(", ") : plural(brief.paths.length, "path", "paths"))
  return parts.join(" · ")
}

function pathCovered(path, files) {
  return path.endsWith("/") ? files.some((f) => f.startsWith(path)) : files.includes(path)
}

/** Pages a preview can open, best first: HTML the attempt touched, then HTML the brief names. */
export function previewPages(task) {
  const pages = []
  const add = (p) => {
    if (p && /\.html?$/i.test(p) && !pages.includes(p)) pages.push(p)
  }
  const d = task.current.digest
  if (d) for (const f of d.files) if (f.status !== "deleted") add(f.path)
  for (const p of task.brief.paths) if (!p.endsWith("/")) add(p)
  add("site/index.html")
  return pages
}

/** What a card is rebuilt from. Clock ticks are left out; they update in place. */
export function cardSignature(task, ctx) {
  const a = task.current
  const job = a.job ? { ...a.job, leaseExpiresAt: undefined } : null
  return JSON.stringify([
    task.lane,
    { ...a, job },
    task.history.map((p) => [p.id, p.status, p.discardReason]),
    task.brief,
    ctx.board.project.mainSha,
    ctx.block?.kind ?? null,
    [...ctx.open].sort(),
    ctx.confirm,
    ctx.busy,
    a.job && a.job.state === "queued" ? agentOnline(ctx.agents.get(a.agent)) : null,
  ])
}

// ------------------------------------------------------------------ the card

export function renderCard(task, ctx) {
  const { brief, lane, current: a } = task
  const compact = lane === "shipped" || lane === "parked"
  const card = h("article", {
    class: "card",
    id: `card-${brief.id}`,
    "data-key": brief.id,
    "data-lane": lane,
    "data-tone": LANE_TONE[lane],
    "data-compact": compact || null,
    "aria-labelledby": `t-${brief.id}`,
    "aria-busy": ctx.busy ? "true" : null,
    tabindex: "-1",
  })
  card.append(
    metaRow(task),
    h("h3", { class: "card-title", id: `t-${brief.id}` }, brief.task),
    compact ? compactBody(task, ctx) : lineage(task, ctx),
  )
  const primary = primaryArea(task, ctx)
  if (primary) card.append(primary)
  card.append(cardTools(task, ctx))
  if (ctx.open.has("preview") && a.previewUrl && !compact) card.append(previewExpand(task, ctx))
  if (ctx.open.has("brief")) card.append(h("div", { class: "expand", id: `brief-${brief.id}` }, briefDetail(brief, a)))
  return card
}

function metaRow(task) {
  const a = task.current
  return h(
    "div",
    { class: "card-meta" },
    h("span", { class: "agent" }, flag(a.agent, a.agentLabel), h("span", { class: "agent-name", title: a.agentLabel }, shortLabel(a.agentLabel))),
    h("span", { class: "attempt-no" }, `· attempt ${a.number}`),
    a.number > 1 ? h("span", { class: "rerun-tag", title: `A re-run: attempt ${a.number - 1} was discarded` }, icon("rerun"), h("span", { class: "tag-text" }, "re-run")) : null,
    h("time", { class: a.number > 1 ? "card-time is-optional" : "card-time", datetime: a.updatedAt, title: `Updated ${fullTime(a.updatedAt)}` }, hm(a.updatedAt)),
  )
}

// ------------------------------------------------------------------ lineage

function lineage(task, ctx) {
  const list = h("ol", { class: "lineage", "aria-label": "The brief, then each attempt, oldest first" })
  list.append(briefNode(task, ctx))
  for (const past of [...task.history].reverse()) list.append(pastNode(past, task, ctx))
  list.append(currentNode(task, ctx))
  if (task.lane === "rerun") list.append(ghostNode(task, ctx))
  return list
}

function briefNode(task, ctx) {
  const { brief, current: a, history } = task
  const expanded = ctx.open.has("brief")
  return h(
    "li",
    { class: "node node-brief" },
    h(
      "button",
      {
        class: "brief-block",
        type: "button",
        "data-key": key(brief.id, "brief-block"),
        "aria-expanded": String(expanded),
        "aria-controls": expanded ? `brief-${brief.id}` : null,
        onclick: () => ctx.on.toggle(task, "brief"),
      },
      h(
        "span",
        { class: "bb-top" },
        h("span", { class: "bb-label" }, "Brief · first commit"),
        h("span", { class: "sha-chip", title: `This fork's brief commit, ${a.briefSha}` }, short(a.briefSha)),
      ),
      h("span", { class: "bb-id", title: brief.id }, brief.id),
      h(
        "span",
        { class: "bb-sum" },
        briefSummary(brief),
        history.length ? [" · ", h("span", { class: "bb-same" }, history.length === 1 ? "same bytes in both forks" : `same bytes in all ${history.length + 1} forks`)] : null,
      ),
    ),
  )
}

function pastNode(p, task, ctx) {
  const failed = p.status === "failed"
  const size = diffSize(p.digest)
  const pushed = p.headSha !== p.briefSha
  const outcome = p.job && p.job.outcome && p.job.outcome.reason !== "pushed" ? p.job.outcome : null
  return h(
    "li",
    { class: ctx.isNewDiscard(p.id) ? "node node-past is-new" : "node node-past" },
    h(
      "div",
      { class: "node-head" },
      h("span", { class: "node-name" }, `Attempt ${p.number}`),
      h("span", { class: "past-word" }, `${failed ? "failed" : "discarded"} ${hm(p.updatedAt)}`),
    ),
    h("p", { class: "node-line is-mono" }, h("span", { class: "struck" }, `fork of ${short(p.baseSha)} · ${pushed ? `head ${short(p.headSha)}` : "no push"}`)),
    p.digest && p.digest.files.length ? filesList(p.digest, null, { struck: true }) : null,
    p.discardReason || outcome
      ? h(
          "p",
          { class: "discard-reason" },
          smart(p.discardReason ?? `${shortLabel(p.agentLabel)} did not finish: ${outcome.summary}`),
          size ? h("span", { class: "never-merges" }, "Its diff ", h("span", { class: "struck" }, `+${size.add} −${size.del}`), " never merges.") : null,
        )
      : null,
    pushed
      ? h(
          "div",
          { class: "past-tools" },
          h(
            "button",
            {
              class: "toggle",
              type: "button",
              "data-key": key(task.brief.id, `past-diff-${p.number}`),
              "aria-haspopup": "dialog",
              onclick: (e) => ctx.on.inspect(p.id, "diff", e.currentTarget),
            },
            icon("diff"),
            "Dropped diff",
          ),
        )
      : null,
    h("p", { class: "wake-label" }, icon("rerun"), "re-run · diff dropped"),
  )
}

function nodeState(task) {
  const a = task.current
  if (isWaiting(a)) return { tone: "moon", hollow: !(a.job && a.job.state === "running"), running: Boolean(a.job && a.job.state === "running") }
  if (task.lane === "parked") return { tone: "slate", hollow: true }
  return { tone: LANE_TONE[task.lane] }
}

function currentNode(task, ctx) {
  const a = task.current
  const waiting = isWaiting(a)
  const pushed = a.headSha !== a.briefSha
  const state = nodeState(task)
  const node = h("li", {
    class: ctx.isNewAttempt(a.id) ? "node node-current is-new" : "node node-current",
    "data-tone": state.tone,
    "data-hollow": state.hollow || null,
    "data-running": state.running || null,
  })
  node.append(
    h(
      "div",
      { class: "node-head" },
      h("span", { class: "node-name" }, `Attempt ${a.number}`),
      h("span", { class: "node-sub" }, waiting || !pushed ? ["fresh fork of main ", sha(a.baseSha)] : `pushed ${hm(pushedAt(a))}`),
    ),
    h(
      "p",
      { class: "node-line is-mono" },
      "brief ",
      h("span", { class: "hl" }, short(a.briefSha)),
      h("span", { class: "arrow", "aria-hidden": "true" }, " → "),
      h("span", { class: "visually-hidden" }, " then "),
      pushed ? ["head ", h("span", { class: "hl" }, short(a.headSha))] : "no push yet",
    ),
  )
  if (a.status === "failed") {
    const outcome = a.job && a.job.outcome
    node.append(
      h(
        "p",
        { class: "discard-reason" },
        outcome ? `${shortLabel(a.agentLabel)} stopped (${outcome.reason.replace(/_/g, " ")}): ${outcome.summary}` : `${shortLabel(a.agentLabel)} finished without a usable push.`,
      ),
    )
  }
  if (waiting || !a.digest) return node

  const d = a.digest
  node.append(h("p", { class: "node-text" }, d.summary), pills(a, task, ctx))
  if (d.files.length) node.append(filesList(d, a.merge, {}))
  if (a.merge && a.merge.state === "conflict") node.append(conflictBox(a, ctx))
  const notes = noteItems(d)
  if (notes.length) node.append(h("ul", { class: "notes" }, notes.map((n) => h("li", { "data-tone": n.tone }, icon(n.icon), n.text))))
  if (currentReview(a)) node.append(reviewBlock(a.review))
  return node
}

function ghostNode(task, ctx) {
  const next = task.current.number + 1
  return h(
    "li",
    { class: "node node-ghost" },
    h(
      "p",
      { class: "ghost-text" },
      h("strong", null, `Attempt ${next}`),
      " starts here: a fresh fork of main ",
      sha(ctx.board.project.mainSha),
      " with the same brief as its first commit.",
    ),
  )
}

function pill(tone, name, label, title) {
  return h("span", { class: "pill", "data-tone": tone, title: title ?? null }, icon(name), h("span", null, label))
}

function pills(a, task, ctx) {
  const out = h("div", { class: "pills" })
  const d = a.digest
  if (d) {
    const passed = d.checks.filter((c) => c.ok).length
    const count = d.checks.length ? ` ${passed}/${d.checks.length}` : ""
    if (d.satisfies === "yes") out.append(pill("channel", "check", `On brief${count}`, "The digest says this diff satisfies the brief"))
    else if (d.satisfies === "no") out.append(pill("lamp", "flag", `Off brief${count}`, "The digest says this diff does not satisfy the brief"))
    else out.append(pill(null, "minus", "Not machine-checked", "The brief has no `contains` check for a machine to run"))
  }
  const m = a.merge
  if (m) {
    const main = ctx.board.project.mainSha
    const stale = m.mainSha !== main
    if (m.state === "clean") {
      out.append(pill(stale ? null : "channel", "commit", [stale ? "Was clean · " : "Clean · ", sha(m.mainSha)], `Trial merge against main at ${hms(m.checkedAt)}`))
    } else {
      out.append(pill("buoy", "x", ["Conflict · ", sha(m.mainSha)], `Trial merge against main at ${hms(m.checkedAt)}`))
    }
    if (stale) out.append(pill("moon", "clock", ["main is now ", sha(main)], "Main moved after this attempt was last checked"))
  }
  return out
}

export function filesList(d, merge, { struck = false } = {}) {
  const unexpected = new Set(d.unexpectedPaths)
  const conflicts = new Set(merge && merge.state === "conflict" ? merge.paths : [])
  const list = h("ul", { class: struck ? "files is-struck" : "files", "aria-label": struck ? "Files the dropped diff touched" : "Files touched" })
  for (const f of d.files) {
    const total = f.additions + f.deletions
    const addBlocks = total === 0 ? 0 : Math.round((f.additions / total) * 5)
    const blocks = []
    for (let i = 0; i < 5; i++) blocks.push(h("i", { "data-k": total === 0 ? null : i < addBlocks ? "a" : "d" }))
    const outside = !struck && unexpected.has(f.path)
    const clash = !struck && conflicts.has(f.path)
    list.append(
      h(
        "li",
        { class: ["file", outside && "is-outside", clash && "is-conflict"] },
        h("span", { class: "file-status", "data-s": f.status, title: f.status }, f.status === "added" ? "A" : f.status === "deleted" ? "D" : "M"),
        h("span", { class: "file-path", title: f.path }, h("bdi", null, f.path)),
        h("span", { class: "file-add" }, `+${f.additions}`),
        h("span", { class: "file-del" }, `−${f.deletions}`),
        h("span", { class: "file-bar", "aria-hidden": "true" }, blocks),
      ),
    )
    if (outside) list.append(h("li", { class: "file-flag", "data-tone": "lamp" }, icon("flag"), "outside the brief"))
  }
  return list
}

function noteItems(d) {
  const notes = []
  for (const reason of d.reasons) {
    if (d.summary.includes(reason)) continue
    if (/^Changed shipboard control files/.test(reason)) continue
    notes.push({ tone: d.satisfies === "no" ? "lamp" : "moon", icon: d.satisfies === "no" ? "flag" : "brief", text: reason })
  }
  if (d.missedPaths.length && !d.reasons.some((r) => r.startsWith("Not touched"))) {
    notes.push({ tone: "lamp", icon: "flag", text: `Not touched: ${listPhrase(d.missedPaths)}.` })
  }
  if (d.controlPaths.length) {
    notes.push({ tone: "buoy", icon: "alert", text: `Changes ${listPhrase(d.controlPaths)} under .shipboard/. Shipboard never ships those silently.` })
  }
  return notes
}

function reviewBlock(r) {
  const model = r.model.split("/").pop().replace(/-instruct.*$/, "")
  const tone = r.verdict === "satisfies" ? "channel" : r.verdict === "partial" ? "lamp" : "buoy"
  return h(
    "div",
    { class: "review", "data-tone": tone },
    h(
      "div",
      { class: "review-head" },
      h("span", null, "Review"),
      h("span", { class: "review-verdict" }, r.verdict),
      h("span", { class: "review-model", title: `${r.model} at ${hms(r.at)}` }, model),
    ),
    h("p", { class: "review-note" }, r.note),
  )
}

function conflictBox(a, ctx) {
  return h(
    "div",
    { class: "conflict", role: "group", "aria-label": "Conflict with main" },
    h("p", { class: "conflict-title" }, icon("x"), h("span", null, "Conflicts with main ", sha(a.merge.mainSha))),
    a.merge.paths.length ? h("ul", { class: "conflict-paths" }, a.merge.paths.map((p) => h("li", null, p))) : null,
  )
}

// ------------------------------------------------------------------ compact cards (parked, shipped)

function compactBody(task, ctx) {
  const a = task.current
  const d = a.digest
  const out = h("div", { class: "compact-body" })
  if (task.lane === "shipped") {
    out.append(h("p", { class: "status-line" }, icon("check"), "Shipped as ", sha(a.shippedSha), h("span", { class: "card-time" }, ` at ${hm(a.updatedAt)}`)))
  } else {
    out.append(h("p", { class: "status-line" }, icon("park"), `Parked at ${hm(a.updatedAt)}`))
  }
  if (d) out.append(h("p", { class: "compact-text" }, d.summary))
  if (task.lane === "parked" && a.merge) {
    const stale = a.merge.mainSha !== ctx.board.project.mainSha
    out.append(
      h(
        "p",
        { class: "compact-note" },
        a.merge.state === "clean" ? "Was clean against " : "Conflicted with ",
        sha(a.merge.mainSha),
        stale ? ". Main has moved since; unparking checks again." : ".",
      ),
    )
  } else if (task.lane === "parked" && isWaiting(a)) {
    out.append(h("p", { class: "compact-note" }, "Parked before any push. Unparking queues the agent again."))
  }
  if (d && d.files.length) {
    out.append(
      h(
        "p",
        { class: "mini-files" },
        d.files.slice(0, 3).map((f, i) => [i ? " · " : "", h("span", { class: "mf" }, f.path, " ", h("span", { class: "nowrap" }, h("span", { class: "file-add" }, `+${f.additions}`), " ", h("span", { class: "file-del" }, `−${f.deletions}`)))]),
        d.files.length > 3 ? ` · ${d.files.length - 3} more` : null,
      ),
    )
  }
  if (task.history.length) {
    out.append(h("p", { class: "history-note" }, icon("rerun"), `after ${plural(task.history.length, "discarded attempt", "discarded attempts")}`))
  }
  return out
}

// ------------------------------------------------------------------ the one button

function lockedProps(ctx) {
  return ctx.block ? { "aria-disabled": "true", title: ctx.block.kind === "locked" ? "Unlock the board to do this" : "Changes are switched off on this board", "data-opens-unlock": "" } : {}
}

function actionButton(task, ctx, action, { cls, iconName, label, describedBy }) {
  const busy = ctx.busy && ctx.busy.action === action
  const disabled = Boolean(ctx.busy && !busy)
  return h(
    "button",
    {
      class: ["btn", cls, ctx.block && "is-locked"],
      type: "button",
      "data-key": key(task.brief.id, "primary"),
      "data-action": action,
      "aria-describedby": describedBy ?? null,
      "aria-busy": busy ? "true" : null,
      disabled: disabled || null,
      ...lockedProps(ctx),
      onclick: () => {
        if (!ctx.busy) ctx.on.act(task, action)
      },
    },
    busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(ctx.block ? "lock" : iconName),
    label,
  )
}

function primaryArea(task, ctx) {
  const { brief, current: a } = task
  const capId = `cap-${brief.id}`
  const main = ctx.board.project.mainSha
  if (ctx.confirm) return confirmBox(task, ctx)

  switch (a.primary) {
    case "ship":
      return h(
        "div",
        { class: "primary" },
        actionButton(task, ctx, "ship", { cls: "btn-channel btn-block", iconName: "ship", label: "Ship to main", describedBy: capId }),
        h("p", { class: "primary-caption", id: capId }, "Lands on main ", sha(main), " as one merge commit."),
      )
    case "ship-anyway":
      return h(
        "div",
        { class: "primary" },
        actionButton(task, ctx, "ship-anyway", { cls: "btn-anyway btn-block", iconName: "flag", label: "Ship anyway", describedBy: capId }),
        h("p", { class: "primary-caption", id: capId }, shipAnywayWhy(a)),
      )
    case "rerun": {
      const size = diffSize(a.digest)
      const agent = shortLabel(a.agentLabel)
      const caption =
        a.status === "failed"
          ? `${agent} finished without a usable push. Re-run tries the same brief on a fresh fork.`
          : [`Drops this diff${size ? ` (+${size.add} −${size.del})` : ""}. ${agent} runs the same brief again on a fresh fork of `, sha(main), ". Nobody resolves the conflict by hand."]
      return h(
        "div",
        { class: "primary" },
        actionButton(task, ctx, "rerun", { cls: "btn-lamp btn-block", iconName: "rerun", label: ["Re-run on main ", h("span", { class: "mono" }, short(main))], describedBy: capId }),
        h("p", { class: "primary-caption", id: capId }, caption),
      )
    }
    case "unpark":
      return h(
        "div",
        { class: "primary" },
        actionButton(task, ctx, "unpark", { cls: "btn-outline btn-block", iconName: "unpark", label: "Unpark", describedBy: capId }),
        h("p", { class: "primary-caption", id: capId }, "Puts it back on the board and checks it against main ", sha(main), "."),
      )
    case "wait":
      return h("div", { class: "primary" }, jobPanel(task, ctx))
    default:
      return null
  }
}

export function shipAnywayWhy(a) {
  const d = a.digest
  const review = currentReview(a)
  if (d && d.controlPaths.length) return `It changes ${listPhrase(d.controlPaths)} under .shipboard/. Read the diff before you ship it.`
  if (d && d.unexpectedPaths.length) return `${listPhrase(d.unexpectedPaths)} ${d.unexpectedPaths.length === 1 ? "is" : "are"} outside the brief. Shipping is still your call.`
  if (d && d.checks.some((c) => !c.ok)) return "An acceptance check failed. Shipping is still your call."
  if (review?.verdict === "off-brief") return `The review reads it as off brief: ${review.note.replace(/\.$/, "")}. Shipping is still your call.`
  if (review?.verdict === "partial") return `The review only partly confirms the brief: ${review.note.replace(/\.$/, "")}. Shipping is still your call.`
  if (d && d.missedPaths.length) return `It did not touch ${listPhrase(d.missedPaths)}. Shipping is still your call.`
  return "The digest could not confirm the brief. Shipping is still your call."
}

function confirmBox(task, ctx) {
  const { brief, current: a } = task
  const review = currentReview(a)
  const c = ctx.confirm
  let text
  let yes
  if (c.action === "ship-anyway") {
    const d = a.digest
    text = d && d.unexpectedPaths.length
      ? `Ship it with ${listPhrase(d.unexpectedPaths)} outside the brief?`
      : review?.verdict === "off-brief"
        ? "Ship it although the review reads it as off brief?"
        : review?.verdict === "partial"
          ? "Ship it although the review only partly confirms the brief?"
        : "Ship it although the digest could not confirm the brief?"
    yes = { label: "Yes, ship it", iconName: "ship" }
  } else {
    const size = diffSize(a.digest)
    text = `This drops a clean diff${size ? ` (+${size.add} −${size.del})` : ""} and runs the brief again on main ${short(ctx.board.project.mainSha)}. Re-run anyway?`
    yes = { label: "Re-run", iconName: "rerun" }
  }
  const busy = ctx.busy && ctx.busy.action === c.action
  return h(
    "div",
    { class: "primary" },
    h(
      "div",
      { class: "confirm", role: "group", "aria-labelledby": `confirm-${brief.id}` },
      h("p", { id: `confirm-${brief.id}` }, text),
      h(
        "div",
        { class: "confirm-actions" },
        h("button", { class: "btn btn-quiet btn-sm", type: "button", "data-key": key(brief.id, "confirm-no"), disabled: busy || null, onclick: () => ctx.on.confirm(task, false) }, c.action === "ship-anyway" ? "Not yet" : "Keep it"),
        h(
          "button",
          { class: "btn btn-lamp btn-sm", type: "button", "data-key": key(brief.id, "confirm-yes"), "aria-busy": busy ? "true" : null, onclick: () => !ctx.busy && ctx.on.confirm(task, true) },
          busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(yes.iconName),
          yes.label,
        ),
      ),
    ),
  )
}

// ------------------------------------------------------------------ the job panel (primary = wait)

function jobPanel(task, ctx) {
  const a = task.current
  const j = a.job
  const agent = shortLabel(a.agentLabel)
  if (a.agentKind === "manual" || !j) {
    return h(
      "div",
      { class: "job", "data-state": "manual" },
      h("div", { class: "job-row" }, h("span", { class: "job-what" }, "Waiting for a push"), h("span", { class: "job-clock", "data-since": a.createdAt }, mmss(secondsSince(a.createdAt) * 1000))),
      h("p", { class: "job-meta" }, a.repo),
      h("p", { class: "job-note" }, "Push to this fork with the agent CLI and the fork's write token. The board picks it up."),
    )
  }
  if (a.agentKind === "demo") {
    return h(
      "div",
      { class: "job", "data-state": "running" },
      h("div", { class: "job-row" }, h("span", { class: "job-what" }, "The demo agent is making its edit."), h("span", { class: "job-clock", "data-since": j.claimedAt ?? j.queuedAt }, mmss(secondsSince(j.claimedAt ?? j.queuedAt) * 1000))),
      h("p", { class: "job-note" }, "A scripted edit, run on the server. It pushes in a moment."),
      h("span", { class: "job-bar", "aria-hidden": "true" }),
    )
  }
  if (j.state === "done" || j.state === "failed") {
    // The agent finished; the board is still reading the push (or main) before it picks a lane.
    return h(
      "div",
      { class: "job", "data-state": "running" },
      h("div", { class: "job-row" }, h("span", { class: "job-what" }, "Checking the push"), h("span", { class: "job-clock", "data-since": j.finishedAt ?? a.updatedAt }, mmss(secondsSince(j.finishedAt ?? a.updatedAt) * 1000))),
      h("p", { class: "job-note" }, `${agent} finished. The board is reading the head against the brief and trial-merging it with main.`),
      h("span", { class: "job-bar", "aria-hidden": "true" }),
    )
  }
  if (j.state === "running") {
    return h(
      "div",
      { class: "job", "data-state": "running" },
      h(
        "div",
        { class: "job-row" },
        h("span", { class: "job-what" }, `${agent} is working`),
        h("span", { class: "job-clock", "data-since": j.claimedAt ?? j.queuedAt, title: "Time since the runner claimed the job" }, mmss(secondsSince(j.claimedAt ?? j.queuedAt) * 1000)),
      ),
      h(
        "p",
        { class: "job-meta" },
        h("span", { class: "nowrap", "data-lease": j.leaseExpiresAt ?? "" }, leaseText(j.leaseExpiresAt)),
        j.runnerId ? [" · ", h("span", { class: "nowrap", title: "The runner holding the lease" }, j.runnerId)] : null,
        j.requeues ? ` · ${plural(j.requeues, "requeue", "requeues")}` : null,
      ),
      h("span", { class: "job-bar", "aria-hidden": "true" }),
    )
  }
  const info = ctx.agents.get(a.agent)
  const online = agentOnline(info)
  return h(
    "div",
    { class: "job", "data-state": "queued" },
    h(
      "div",
      { class: "job-row" },
      h("span", { class: "job-what" }, `Queued for ${agent}`),
      h("span", { class: "job-clock", "data-since": j.queuedAt, title: "Time in the queue" }, mmss(secondsSince(j.queuedAt) * 1000)),
    ),
    online
      ? h("p", { class: "job-note" }, "A runner will claim it on its next poll.")
      : h(
          "p",
          { class: "job-note is-warn" },
          `No ${agent} runner is online. `,
          info && info.lastSeenAt ? ["Last seen ", h("span", { "data-ago-words": info.lastSeenAt }, agoWords(info.lastSeenAt)), "."] : "One has never been seen.",
        ),
  )
}

export function leaseText(until) {
  if (!until) return "no lease yet"
  const left = Date.parse(until) - now()
  return left > 0 ? `lease ${mmss(left)} left` : "lease renewing"
}

// ------------------------------------------------------------------ tools

const SECONDARY = {
  park: { iconName: "park", label: "Park", title: "Park: set it aside. Nothing runs until you unpark it." },
  rerun: { iconName: "rerun", label: "Re-run", title: "Re-run: drop this diff and run the same brief on current main." },
  unpark: { iconName: "unpark", label: "Unpark", title: "Unpark: put it back on the board." },
}

function cardTools(task, ctx) {
  const { brief, current: a, lane } = task
  const compact = lane === "shipped" || lane === "parked"
  const pushed = Boolean(a.previewUrl)
  const tools = h("div", { class: "card-tools" })
  if (!compact) {
    const open = ctx.open.has("preview")
    tools.append(
      h(
        "button",
        {
          class: "toggle",
          type: "button",
          "data-key": key(brief.id, "preview"),
          "aria-expanded": pushed ? String(open) : null,
          "aria-controls": pushed && open ? `prev-${brief.id}` : null,
          "aria-disabled": pushed ? null : "true",
          title: pushed ? "Show this attempt's preview" : "No push yet, so nothing to preview",
          onclick: () => pushed && ctx.on.toggle(task, "preview"),
        },
        icon("preview"),
        "Preview",
      ),
    )
  }
  tools.append(
    h(
      "button",
      {
        class: "toggle",
        type: "button",
        "data-key": key(brief.id, "diff"),
        "aria-haspopup": "dialog",
        "aria-disabled": pushed ? null : "true",
        title: pushed ? "Read the diff" : "No push yet, so no diff",
        onclick: (e) => pushed && ctx.on.inspect(a.id, "diff", e.currentTarget),
      },
      icon("diff"),
      "Diff",
    ),
    h(
      "button",
      {
        class: "toggle",
        type: "button",
        "data-key": key(brief.id, "brief"),
        "aria-expanded": String(ctx.open.has("brief")),
        "aria-controls": ctx.open.has("brief") ? `brief-${brief.id}` : null,
        onclick: () => ctx.on.toggle(task, "brief"),
      },
      icon("brief"),
      "Brief",
    ),
  )
  const secondary = a.secondary.filter((s) => s !== a.primary && SECONDARY[s])
  if (secondary.length) {
    tools.append(
      h(
        "span",
        { class: "secondary" },
        secondary.map((s) =>
          h(
            "button",
            {
              class: "toggle",
              type: "button",
              "data-key": key(brief.id, s),
              "aria-label": SECONDARY[s].label,
              title: ctx.block ? "Unlock the board to do this" : SECONDARY[s].title,
              disabled: (ctx.busy && ctx.busy.action !== s) || null,
              "aria-busy": ctx.busy && ctx.busy.action === s ? "true" : null,
              ...(ctx.block ? { "aria-disabled": "true", "data-opens-unlock": "" } : {}),
              onclick: () => !ctx.busy && ctx.on.act(task, s, { secondary: true }),
            },
            ctx.busy && ctx.busy.action === s ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(ctx.block ? "lock" : SECONDARY[s].iconName),
            h("span", { class: "sec-label", "aria-hidden": "true" }, SECONDARY[s].label),
          ),
        ),
      ),
    )
  }
  return tools
}

// ------------------------------------------------------------------ inline previews and the brief

const thumbs = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const width = entry.contentRect.width
    if (width > 0) entry.target.style.setProperty("--s", String(width / 1000))
  }
})

function previewExpand(task, ctx) {
  const a = task.current
  const page = previewPages(task)[0] ?? ""
  const url = `${a.previewUrl}${page}`
  const src = ctx.previewSrc(url)
  const box = h(
    "div",
    { class: "preview-box" },
    h("iframe", {
      src,
      sandbox: "allow-same-origin",
      referrerpolicy: "no-referrer",
      loading: "lazy",
      tabindex: "-1",
      title: `Preview of “${task.brief.task}” at ${short(a.headSha)}`,
    }),
  )
  thumbs.observe(box)
  return h(
    "figure",
    { class: "expand", id: `prev-${task.brief.id}` },
    h(
      "div",
      { class: "preview-frame" },
      h(
        "div",
        { class: "preview-bar" },
        h("span", { class: "url", title: url }, h("bdi", null, url)),
        h("a", { href: src, target: "_blank", rel: "noopener noreferrer", "aria-label": "Open the preview in a new tab" }, icon("external")),
      ),
      box,
    ),
    h("figcaption", { class: "preview-caption" }, `Head ${short(a.headSha)}, served sandboxed. No scripts run.`),
  )
}

export function briefDetail(brief, a) {
  const checks = new Map(((a && a.digest && a.digest.checks) || []).map((c) => [`${c.path}\u0000${c.text}`, c.ok]))
  const touched = ((a && a.digest && a.digest.files) || []).map((f) => f.path)
  const pushed = Boolean(a && a.digest)
  return h(
    "div",
    { class: "brief-detail" },
    h(
      "div",
      null,
      h("p", { class: "bd-label" }, "Constraints"),
      brief.constraints.length
        ? h("ul", { class: "bd-list is-plain" }, brief.constraints.map((c) => h("li", null, c)))
        : h("p", { class: "compact-note" }, "No constraints."),
    ),
    h(
      "div",
      null,
      h("p", { class: "bd-label" }, "Acceptance"),
      parseAcceptance(brief.acceptance).length
        ? h(
            "ul",
            { class: "bd-list" },
            parseAcceptance(brief.acceptance).map((x) => {
              if (x.kind === "person") {
                return h("li", null, h("span", { class: "person" }, icon("brief")), h("span", null, x.line), h("span", { class: "bd-tag" }, "for a person"))
              }
              const ok = checks.get(`${x.path}\u0000${x.text}`)
              const state = ok === true ? ["ok", "check", "passed", "channel"] : ok === false ? ["bad", "x", "failed", "buoy"] : ["wait", "clock", "not run yet", null]
              return h("li", null, h("span", { class: state[0] }, icon(state[1])), h("code", null, x.line), h("span", { class: "bd-tag", "data-tone": state[3] }, state[2]))
            }),
          )
        : h("p", { class: "compact-note" }, "Nothing to check. The digest will say unchecked."),
    ),
    h(
      "div",
      null,
      h("p", { class: "bd-label" }, "Paths"),
      h(
        "ul",
        { class: "bd-list" },
        brief.paths.map((p) =>
          h("li", null, h("code", null, p), pushed ? h("span", { class: "bd-tag", "data-tone": pathCovered(p, touched) ? "channel" : "lamp" }, pathCovered(p, touched) ? "touched" : "not touched") : null),
        ),
      ),
    ),
    h("p", { class: "bd-file" }, `.shipboard/briefs/${brief.id}.json`, a ? [" · committed as ", short(a.briefSha), ", the fork's first commit"] : null),
  )
}
