// One project's board: masthead, six lanes in fixed order, the activity feed. Polls
// GET /api/projects/:id?since=<version> every 2 s, re-renders only cards whose data changed, and
// moves cards between lanes with FLIP so a re-run reads as motion, not a page refresh.

import { api, getToken, previewSrc } from "./api.js"
import { authBanner, explainBlock, handleAuthError, mutationBlock, onAuthChange, openUnlock } from "./auth.js"
import { createFeed, renderTicker } from "./activity.js"
import { pulseLive, setCrumbs, setLive, setSkip, showKeys, hideKeys, toggleKeys } from "./chrome.js"
import { now } from "./clock.js"
import { createDispatch } from "./dispatch.js"
import { $$, ago, agoWords, clear, dayOrTime, h, hm, hms, icon, mmss, place, plural, reducedMotion, replay, secondsSince, setAriaDisabled, sha, short } from "./dom.js"
import { createInspector } from "./inspector.js"
import { href } from "./router.js"
import { closeSheet, isSheetOpen, retarget, sheetOpener } from "./sheet.js"
import { LANE_TONE, cardSignature, key, leaseText, renderCard, shipBefore, taskTitleOf } from "./task-card.js"
import { announce, toast } from "./toast.js"

const POLL_MS = 2000
const BACKOFF_MS = [2000, 4000, 8000, 15000]
const MOVE_MS = 560

export const LANES = {
  rerun: { name: "Needs re-run", short: "Re-run", desc: "Conflicts with main. Re-run drops the diff and runs the brief again." },
  ship: { name: "Ready to ship", short: "Ship", desc: "Clean, on brief, checked." },
  review: { name: "Needs a look", short: "Look", desc: "Clean, but needs a human review." },
  working: { name: "Agent working", short: "Working", desc: "A fork with its brief and no push yet." },
  parked: { name: "Parked", short: "Parked", desc: "Set aside. Nothing runs." },
  shipped: { name: "Shipped", short: "Shipped", desc: "On main." },
}
const ORDER = ["rerun", "ship", "review", "working", "parked", "shipped"]

const KEYS = [
  [["N"], "Dispatch a brief"],
  [["J"], "Next card"],
  [["K"], "Previous card"],
  [["S"], "Ship the focused card"],
  [["R"], "Re-run the focused card"],
  [["U"], "Unpark the focused card"],
  [["Esc"], "Close a sheet or a question"],
  [["?"], "Show these keys"],
]

const EMPTY = new Set()

export function mountBoard(view, projectId) {
  const s = {
    board: null,
    open: new Map(),
    confirm: null,
    busy: null,
    seenAttempts: new Set(),
    seenDiscards: new Set(),
    laneOf: new Map(),
    counts: null,
    main: null,
    polledAt: 0,
    lastOkAt: 0,
    fails: 0,
    timer: 0,
    ticker: 0,
    inFlight: false,
    stopped: false,
    state: "loading",
    privateRead: false,
  }

  setCrumbs([{ label: "Projects", href: href("/") }, { label: projectId }])
  setSkip("Skip to the board", "lanes")
  setLive("connecting", "Connecting", "")

  const root = h("div", { class: "page page-board" })
  view.append(root)
  showLoading()

  // ---------------------------------------------------------------- page skeleton (built once a board arrives)

  const el = {}
  const cards = new Map()
  const laneEls = new Map()
  const feed = { list: null, api: null }

  function buildPage() {
    el.eyebrow = h("p", { class: "eyebrow" })
    el.name = h("h1", { class: "project-name", id: "project-name", tabindex: "-1" })
    el.desc = h("p", { class: "project-desc" })
    el.sha = h("span", { class: "sha-big" })
    el.note = h("p", { class: "main-note" })
    el.preview = h("a", { class: "btn btn-outline", target: "_blank", rel: "noopener noreferrer" }, icon("preview"), "Main preview", icon("external", "ic-trail"))
    el.dispatchBtn = h("button", { class: "btn btn-lamp btn-lg", type: "button", "aria-haspopup": "dialog", "aria-controls": "dispatch", onclick: (e) => dispatch.open(e.currentTarget) })
    el.banners = h("div", { class: "banners" })
    el.ticker = h("p", { class: "ticker", "aria-label": "Newest activity" })
    el.meter = h("nav", { class: "lane-meter", "aria-label": "Lane counts" })
    el.lanes = h("div", { class: "lanes", id: "lanes", tabindex: "-1", "aria-label": "Lanes" })
    el.empty = h("div", { class: "state", hidden: true })
    feed.list = h("ol", { class: "feed-list", "aria-live": "polite", "aria-relevant": "additions" })
    feed.api = createFeed(feed.list)

    const quay = h("div", { class: "lane-stack" })
    for (const lane of ORDER) {
      const info = LANES[lane]
      const count = h("span", { class: "lane-count" }, "0")
      const body = h("div", { class: "lane-body" })
      const empty = h("p", { class: "lane-empty" })
      const heading = h("h2", { class: "lane-name", id: `lane-${lane}`, tabindex: "-1" }, info.name)
      const section = h(
        "section",
        { class: "lane", "data-lane": lane, "data-tone": LANE_TONE[lane], "data-size": "empty", "aria-labelledby": `lane-${lane}` },
        h("header", { class: "lane-head" }, h("span", { class: "lane-lamp", "aria-hidden": "true" }), heading, count),
        h("p", { class: "lane-desc" }, info.desc),
        body,
      )
      laneEls.set(lane, { section, count, body, empty, heading })
      if (lane === "parked" || lane === "shipped") quay.append(section)
      else el.lanes.append(section)
      const cell = h(
        "button",
        { class: "meter-cell", type: "button", "data-tone": LANE_TONE[lane], "data-lane": lane, onclick: () => goToLane(lane) },
        h("span", { class: "meter-n" }, "0"),
        h("span", { class: "meter-name" }, info.short),
      )
      el.meter.append(cell)
    }
    el.lanes.append(quay, el.empty)

    const main = h(
      "main",
      { id: "main", class: "board-main" },
      h(
        "section",
        { class: "masthead", "aria-labelledby": "project-name" },
        h(
          "div",
          { class: "project-id" },
          el.eyebrow,
          el.name,
          el.desc,
          h(
            "p",
            { class: "standing-order" },
            icon("rerun"),
            h("span", null, "Conflicts are never merged by hand. ", h("strong", null, "Re-run"), " drops the diff and runs the same brief on the new main."),
          ),
        ),
        h(
          "div",
          { class: "main-block" },
          h(
            "div",
            { class: "main-sha" },
            h("p", { class: "main-label" }, "main"),
            h(
              "p",
              { class: "main-value" },
              el.sha,
              h("button", { class: "copy-btn", type: "button", "aria-label": "Copy the main commit sha", title: "Copy the full sha", onclick: copyMain }, icon("copy")),
            ),
            el.note,
          ),
          h("div", { class: "main-actions" }, el.preview, el.dispatchBtn),
        ),
      ),
      el.banners,
      el.ticker,
      el.meter,
      h(
        "div",
        { class: "board" },
        el.lanes,
        h(
          "aside",
          { class: "feed", id: "feed", "aria-labelledby": "feed-title" },
          h("header", { class: "feed-head" }, h("h2", { class: "feed-title", id: "feed-title", tabindex: "-1" }, "Activity"), h("p", { class: "feed-sub" }, "newest first")),
          feed.list,
        ),
      ),
    )
    clear(root).append(main)
    showKeys(KEYS)
  }

  // ---------------------------------------------------------------- states before or instead of a board

  function showLoading() {
    clear(root).append(
      h("p", { class: "loading-line", role: "status" }, "Loading the board…"),
      h("div", { class: "skeleton-row", "aria-hidden": "true" }, [0, 1, 2].map(() => h("div", { class: "skeleton-lane" }, h("i"), h("i"), h("i")))),
    )
  }

  function showState({ tone, iconName, title, text, actions }) {
    s.board = null
    s.state = "error"
    cards.clear()
    laneEls.clear()
    hideKeys()
    clear(root).append(
      h(
        "main",
        { id: "main" },
        h(
          "div",
          { class: "state", "data-tone": tone ?? null, role: "status" },
          h("div", { class: "state-inner" }, icon(iconName, "ic-big"), h("h2", { tabindex: "-1" }, title), h("p", null, text), actions ?? null),
        ),
      ),
    )
  }

  function showMissing() {
    setLive(null)
    showState({
      tone: "slate",
      iconName: "anchor",
      title: "No such project",
      text: ["There is no project called ", h("code", null, projectId), ". It may have been created on another board."],
      actions: h("a", { class: "btn btn-outline", href: href("/"), "data-nav": "" }, icon("back"), "All projects"),
    })
  }

  function showReadLock(message) {
    setLive(null)
    showState({
      tone: "lamp",
      iconName: "lock",
      title: "This board needs its token to read",
      text: message ?? "Unlock to continue. The token stays in this browser and goes out only as a Bearer header.",
      actions: h("button", { class: "btn btn-lamp", type: "button", "data-opens-unlock": "", onclick: () => openUnlock("This board needs its token to read.") }, icon("key"), "Unlock"),
    })
  }

  function showUnreachable(err) {
    setLive("offline", "Offline", "retrying")
    showState({
      tone: err.network ? "buoy" : "lamp",
      iconName: "alert",
      title: err.network ? "The board is not answering" : "The board could not show this project",
      text: err.network ? `Trying again every ${Math.round(backoff() / 1000)} seconds.` : err.message,
      actions: h("button", { class: "btn btn-outline", type: "button", onclick: () => pollNow() }, icon("rerun"), "Try now"),
    })
  }

  // ---------------------------------------------------------------- rendering

  function cardCtx(task) {
    const id = task.brief.id
    return {
      board: s.board,
      block: mutationBlock(),
      open: s.open.get(id) ?? EMPTY,
      confirm: s.confirm && s.confirm.briefId === id ? { action: s.confirm.action } : null,
      busy: s.busy && s.busy.briefId === id ? { action: s.busy.action } : null,
      agents: new Map(s.board.agents.map((a) => [a.id, a])),
      isNewAttempt: (aid) => !s.seenAttempts.has(aid),
      isNewDiscard: (aid) => !s.seenDiscards.has(aid),
      previewSrc,
      on: handlers,
    }
  }

  function tasks() {
    return s.board ? s.board.lanes.flatMap((l) => l.tasks) : []
  }

  function apply(board, { animate = true, follow = null } = {}) {
    if (s.board && board.version < s.board.version) return
    const first = !s.board
    if (first) {
      buildPage()
      for (const t of board.lanes.flatMap((l) => l.tasks)) {
        s.seenAttempts.add(t.current.id)
        for (const p of t.history) s.seenDiscards.add(p.id)
      }
    }
    s.board = board
    s.state = "board"
    render({ animate: animate && !first, follow })
  }

  function render({ animate = false, follow = null } = {}) {
    if (!s.board) return
    const before = animate && !reducedMotion() ? measure() : null
    const prevLanes = new Map(s.laneOf)
    renderMasthead()
    renderBanners()
    renderLanes()
    renderFeed()
    inspector.refresh()
    dispatch.refresh()
    const moved = []
    for (const [briefId, lane] of s.laneOf) {
      const was = prevLanes.get(briefId)
      if (was && was !== lane) moved.push(briefId)
    }
    if (animate) motion(before, moved)
    if (moved.length && animate) {
      const t = tasks().find((x) => x.brief.id === moved[0])
      if (t) announce(`“${t.brief.task}” moved to ${LANES[t.lane].name}.`)
    }
    if (follow) followCard(follow, moved.includes(follow))
    for (const t of tasks()) {
      s.seenAttempts.add(t.current.id)
      for (const p of t.history) s.seenDiscards.add(p.id)
    }
    tick()
  }

  function renderMasthead() {
    const p = s.board.project
    el.eyebrow.textContent = `project · ${p.id}`
    if (el.name.textContent !== p.name) el.name.textContent = p.name
    el.desc.textContent = p.description
    el.desc.hidden = !p.description
    if (el.sha.textContent !== short(p.mainSha)) el.sha.textContent = short(p.mainSha)
    el.sha.title = p.mainSha
    if (s.main && s.main !== p.mainSha) replay(el.sha, "is-changed")
    s.main = p.mainSha
    const shipped = shipBefore(s.board, null)
    const title = taskTitleOf(s.board, shipped)
    clear(el.note).append(
      shipped && title ? `after “${title}” shipped ${when(shipped.at)}` : `${p.seed === "import" ? "as imported" : "as seeded"} ${when(p.createdAt)}`,
    )
    el.preview.href = previewSrc(p.previewUrl)
    el.preview.title = `Main at ${short(p.mainSha)}, served sandboxed`
    const block = mutationBlock()
    clear(el.dispatchBtn).append(icon(block ? "lock" : "plus"), "Dispatch a brief", h("kbd", { "aria-hidden": "true" }, "N"))
    setAriaDisabled(el.dispatchBtn, Boolean(block))
    el.dispatchBtn.classList.toggle("is-locked", Boolean(block))
    el.dispatchBtn.toggleAttribute("data-opens-unlock", Boolean(block))
    el.dispatchBtn.setAttribute("aria-keyshortcuts", "N")
    document.title = `${p.name} · shipboard`
    setCrumbs([{ label: "Projects", href: href("/") }, { label: p.name }])
  }

  /** "at 21:09" today, "on 29 Sep" otherwise. */
  function when(iso) {
    const t = dayOrTime(iso)
    return t.includes(":") ? `at ${t}` : `on ${t}`
  }

  function renderBanners() {
    if (!el.banners) return
    // Rebuild only when something changed, so a focused Unlock button keeps focus across polls.
    const k = `${mutationBlock()?.kind ?? ""}|${s.fails > 0 ? `${backoff()}|${s.lastOkAt}` : ""}`
    if (el.banners.dataset.key === k) return
    el.banners.dataset.key = k
    clear(el.banners)
    const auth = authBanner()
    if (auth) el.banners.append(auth)
    if (s.fails > 0 && s.board) {
      el.banners.append(
        h(
          "div",
          { class: "banner", "data-tone": "buoy", role: "status" },
          icon("alert"),
          h(
            "p",
            null,
            h("strong", null, "The board is not answering."),
            " Showing what it said at ",
            h("span", { class: "mono" }, s.lastOkAt ? hms(new Date(s.lastOkAt).toISOString()) : "load"),
            `. Trying again every ${Math.round(backoff() / 1000)} seconds.`,
          ),
          h("button", { class: "btn btn-outline btn-sm", type: "button", onclick: () => pollNow() }, "Try now"),
        ),
      )
    }
  }

  function renderLanes() {
    const board = s.board
    const all = tasks()
    const focus = focusKey()
    const empty = all.length === 0
    el.empty.hidden = !empty
    for (const { section } of laneEls.values()) section.hidden = empty
    el.lanes.classList.toggle("is-empty", empty)
    if (empty) {
      clear(el.empty).append(
        h(
          "div",
          { class: "state-inner" },
          icon("brief", "ic-big"),
          h("h2", null, "Nothing on this board yet"),
          h("p", null, "Dispatch a brief and an agent gets its own fork, with the brief as the first commit."),
          h("button", { class: "btn btn-lamp btn-lg", type: "button", onclick: (e) => dispatch.open(e.currentTarget) }, icon(mutationBlock() ? "lock" : "plus"), "Dispatch a brief"),
        ),
      )
    }

    const want = new Map()
    s.laneOf.clear()
    for (const { lane, tasks: list } of board.lanes) {
      const els = []
      for (const task of list) {
        const ctx = cardCtx(task)
        const sig = cardSignature(task, ctx)
        let card = cards.get(task.brief.id)
        if (!card || card.dataset.sig !== sig) {
          card = renderCard(task, ctx)
          card.dataset.sig = sig
          cards.set(task.brief.id, card)
        } else {
          // Heartbeats move the lease without changing the card; keep the countdown honest.
          const lease = card.querySelector("[data-lease]")
          if (lease instanceof HTMLElement) lease.dataset.lease = task.current.job?.leaseExpiresAt ?? ""
        }
        els.push(card)
        s.laneOf.set(task.brief.id, lane)
      }
      want.set(lane, els)
    }
    for (const [briefId, card] of cards) {
      if (!s.laneOf.has(briefId)) {
        card.remove()
        cards.delete(briefId)
      }
    }

    const counts = {}
    for (const lane of ORDER) {
      const parts = laneEls.get(lane)
      const els = want.get(lane) ?? []
      counts[lane] = els.length
      parts.section.dataset.size = els.length === 0 ? "empty" : lane === "parked" || lane === "shipped" ? "compact" : "full"
      parts.count.textContent = String(els.length)
      parts.count.setAttribute("aria-label", plural(els.length, "task", "tasks"))
      if (s.counts && s.counts[lane] !== els.length) replay(parts.count, "is-bumped")
      let at = parts.body.firstChild
      for (const card of els) {
        place(parts.body, card, at)
        at = card.nextSibling
      }
      while (at) {
        const next = at.nextSibling
        if (at !== parts.empty) at.remove()
        at = next
      }
      if (els.length === 0) {
        clear(parts.empty).append(...emptySentence(lane))
        if (parts.empty.parentNode !== parts.body) parts.body.append(parts.empty)
      } else if (parts.empty.parentNode) {
        parts.empty.remove()
      }
      const cell = el.meter.querySelector(`[data-lane="${lane}"]`)
      if (cell) {
        cell.querySelector(".meter-n").textContent = String(els.length)
        cell.toggleAttribute("data-zero", els.length === 0)
        cell.setAttribute("aria-label", `${LANES[lane].name}: ${plural(els.length, "task", "tasks")}`)
      }
    }
    s.counts = counts
    restoreFocus(focus)
  }

  function emptySentence(lane) {
    const main = s.board.project.mainSha
    const open = s.board.lanes.some((l) => (l.lane === "ship" || l.lane === "review") && l.tasks.length)
    switch (lane) {
      case "rerun":
        return open ? ["Nothing to re-run. Every open attempt merges with main ", sha(main), "."] : ["Nothing to re-run."]
      case "ship":
        return ["Nothing is ready to ship yet."]
      case "review":
        return ["Nothing needs a second look."]
      case "working":
        return ["No agent is working right now."]
      case "parked":
        return ["Nothing is parked."]
      default:
        return ["Nothing has shipped yet."]
    }
  }

  function renderFeed() {
    const titles = new Map(tasks().map((t) => [t.brief.task, t.brief.id]))
    const ctx = { titles, onTask: onFeedTask, onFeed: goToFeed }
    feed.api.render(s.board.activity, ctx)
    renderTicker(el.ticker, s.board.activity, ctx)
  }

  // ---------------------------------------------------------------- focus and motion

  function focusKey() {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !el.lanes?.contains(active)) return null
    return active.closest("[data-key]")?.getAttribute("data-key") ?? null
  }

  function restoreFocus(k) {
    if (k && !(document.activeElement instanceof HTMLElement && el.lanes.contains(document.activeElement))) {
      const target = el.lanes.querySelector(`[data-key="${CSS.escape(k)}"]`)
      if (target instanceof HTMLElement) target.focus({ preventScroll: true })
    }
    // A sheet opened from a card should still return focus to that card's button after a re-render.
    const opener = sheetOpener()
    if (opener instanceof HTMLElement && !opener.isConnected && opener.dataset.key) {
      const again = el.lanes.querySelector(`[data-key="${CSS.escape(opener.dataset.key)}"]`)
      if (again instanceof HTMLElement) retarget(again)
    }
  }

  function measure() {
    const out = new Map()
    for (const [briefId, card] of cards) if (card.isConnected) out.set(briefId, card.getBoundingClientRect())
    return out
  }

  function motion(before, moved) {
    const movedSet = new Set(moved)
    if (!before) {
      // Reduced motion: no travel. A static outline in the lane's colour marks where the card went.
      for (const briefId of moved) {
        const card = cards.get(briefId)
        if (!card) continue
        card.classList.add("is-moved")
        setTimeout(() => card.classList.remove("is-moved"), 1200)
      }
      return
    }
    for (const [briefId, card] of cards) {
      const was = before.get(briefId)
      if (!was) {
        card.classList.add("is-entering")
        card.addEventListener("animationend", () => card.classList.remove("is-entering"), { once: true })
        continue
      }
      const now = card.getBoundingClientRect()
      const dx = was.left - now.left
      const dy = was.top - now.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      const anim = card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: MOVE_MS,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      })
      if (movedSet.has(briefId)) {
        anim.addEventListener("finish", () => {
          card.classList.add("is-settled")
          setTimeout(() => card.classList.remove("is-settled"), 1300)
        })
      }
    }
  }

  /** After the user's own action moved a card off screen: bring it back into view once it has landed. */
  function followCard(briefId, moved) {
    const wait = moved && !reducedMotion() ? MOVE_MS + 40 : 0
    setTimeout(() => {
      const card = cards.get(briefId)
      if (!card || !card.isConnected || isSheetOpen()) return
      const r = card.getBoundingClientRect()
      const off = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth
      if (off) card.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" })
      const primary = card.querySelector(`[data-key="${CSS.escape(key(briefId, "primary"))}"]`)
      const target = primary instanceof HTMLElement && !primary.hasAttribute("disabled") ? primary : card
      const active = document.activeElement
      if (!active || active === document.body || !active.isConnected || card.contains(active) || !el.lanes.contains(active)) target.focus({ preventScroll: true })
    }, wait)
  }

  function onFeedTask(briefId, how) {
    const card = cards.get(briefId)
    if (!card) return
    if (how === "enter") card.classList.add("is-highlight")
    else if (how === "leave") card.classList.remove("is-highlight")
    else {
      card.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center", inline: "center" })
      card.classList.add("is-highlight")
      card.focus({ preventScroll: true })
      setTimeout(() => card.classList.remove("is-highlight"), 1600)
    }
  }

  function goToFeed() {
    const target = document.getElementById("feed")
    target?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" })
    document.getElementById("feed-title")?.focus({ preventScroll: true })
  }

  function goToLane(lane) {
    const parts = laneEls.get(lane)
    if (!parts) return
    parts.section.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start", inline: "start" })
    parts.heading.focus({ preventScroll: true })
  }

  // ---------------------------------------------------------------- live clock

  function tick() {
    if (!el.lanes || !s.board) return
    for (const node of $$("[data-since]", root)) node.textContent = mmss(secondsSince(node.dataset.since) * 1000)
    for (const node of $$("[data-lease]", root)) node.textContent = leaseText(node.dataset.lease)
    for (const node of $$("[data-ago]", root)) node.textContent = ago(node.dataset.ago)
    for (const node of $$("[data-ago-words]", root)) node.textContent = agoWords(node.dataset.agoWords)
    const v = `v${s.board.version}`
    if (s.fails > 0) setLive("offline", "Offline", `${v} · retrying every ${Math.round(backoff() / 1000)}s`)
    else setLive("live", "Live", `${v} · checked ${Math.max(0, Math.round((Date.now() - s.polledAt) / 1000))}s ago`)
  }

  // ---------------------------------------------------------------- polling

  const backoff = () => BACKOFF_MS[Math.min(Math.max(s.fails - 1, 0), BACKOFF_MS.length - 1)]

  function schedule(ms) {
    clearTimeout(s.timer)
    if (!s.stopped) s.timer = setTimeout(poll, ms)
  }

  async function poll() {
    if (s.stopped || s.inFlight) return
    if (document.hidden && s.board) return
    s.inFlight = true
    try {
      const res = await api.board(projectId, s.board ? s.board.version : null)
      s.privateRead = await api.ensurePreviewSession(projectId)
      s.inFlight = false
      if (s.stopped) return
      const wasOffline = s.fails > 0
      s.fails = 0
      s.polledAt = Date.now()
      s.lastOkAt = now()
      pulseLive()
      if (res.status === 200 && res.board) apply(res.board, { animate: true })
      else if (wasOffline) renderBanners()
      schedule(POLL_MS)
    } catch (err) {
      s.inFlight = false
      if (s.stopped) return
      if (err.status === 401) return showReadLock()
      if (err.status === 404) return showMissing()
      s.fails += 1
      if (s.board) {
        renderBanners()
        tick()
      } else showUnreachable(err)
      schedule(backoff())
    }
  }

  function pollNow() {
    clearTimeout(s.timer)
    void poll()
  }

  // ---------------------------------------------------------------- actions

  const handlers = {
    act: (task, action, opts) => void act(task, action, opts),
    confirm: (task, yes) => {
      const c = s.confirm
      if (!c) return
      if (!yes) {
        s.confirm = null
        renderLanes()
        focusPrimary(task.brief.id)
        return
      }
      void run(task, c.action === "ship-anyway" ? "ship" : "rerun", { busyAs: c.action })
    },
    toggle: (task, what) => {
      const set = new Set(s.open.get(task.brief.id) ?? [])
      if (set.has(what)) set.delete(what)
      else set.add(what)
      s.open.set(task.brief.id, set)
      renderLanes()
    },
    inspect: (attemptId, tab, opener) => inspector.open(attemptId, tab, opener),
  }

  async function act(task, action, opts = {}) {
    const block = mutationBlock()
    if (block) return explainBlock(block)
    if (action === "ship-anyway" || (action === "rerun" && opts.secondary && task.lane !== "rerun")) {
      s.confirm = { briefId: task.brief.id, action }
      renderLanes()
      const no = cards.get(task.brief.id)?.querySelector(`[data-key="${CSS.escape(key(task.brief.id, "confirm-no"))}"]`)
      if (no instanceof HTMLElement) no.focus()
      return
    }
    return run(task, action, opts)
  }

  function focusPrimary(briefId) {
    const card = cards.get(briefId)
    const btn = card?.querySelector(`[data-key="${CSS.escape(key(briefId, "primary"))}"]`)
    ;(btn instanceof HTMLElement ? btn : card)?.focus({ preventScroll: true })
  }

  /** Performs a mutation. Resolves true when the board accepted it. */
  async function run(task, action, opts = {}) {
    const block = mutationBlock()
    if (block) {
      explainBlock(block)
      return false
    }
    const a = task.current
    s.busy = { briefId: task.brief.id, action: opts.busyAs ?? action }
    renderLanes()
    try {
      let res
      if (action === "ship") res = await api.ship(a.id, a.headSha)
      else if (action === "rerun") res = await api.rerun(a.id, opts.agent)
      else if (action === "park") res = await api.park(a.id)
      else if (action === "unpark") res = await api.unpark(a.id)
      else throw new Error(`Unknown action ${action}`)
      s.busy = null
      s.confirm = null
      if (res.board) apply(res.board, { animate: true, follow: task.brief.id })
      else renderLanes()
      if (res.notice) toast(res.fixture ? "info" : "ok", res.notice)
      return !res.fixture
    } catch (err) {
      s.busy = null
      s.confirm = null
      renderLanes()
      if (!handleAuthError(err)) {
        if (err.network) toast("error", "The board is not answering.", "Nothing changed. Try again in a moment.")
        else toast("error", err.message)
        if (err.status === 409) pollNow()
      }
      return false
    }
  }

  async function copyMain() {
    const full = s.board?.project.mainSha
    if (!full) return
    try {
      await navigator.clipboard.writeText(full)
      toast("ok", `Copied main ${short(full)}.`)
    } catch {
      toast("info", `Main is ${full}.`, "The browser did not allow copying here.")
    }
  }

  // ---------------------------------------------------------------- sheets

  const inspector = createInspector({
    lookup(attemptId) {
      for (const task of tasks()) {
        if (task.current.id === attemptId) return { task, attempt: task.current }
        const past = task.history.find((p) => p.id === attemptId)
        if (past) return { task, attempt: past }
      }
      return null
    },
    getBoard: () => s.board,
    run,
    previewSrc,
  })

  const dispatch = createDispatch({
    projectId,
    getBoard: () => s.board,
    onResult(res) {
      if (res.board) {
        const before = new Set(tasks().map((t) => t.brief.id))
        apply(res.board, { animate: true })
        const added = tasks().find((t) => !before.has(t.brief.id))
        if (added) setTimeout(() => cards.get(added.brief.id)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }), MOVE_MS)
      }
      if (res.notice && !res.credentials) toast(res.fixture ? "info" : "ok", res.notice)
    },
  })

  // ---------------------------------------------------------------- keyboard

  function onKey(e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    const t = e.target
    if (t instanceof Element && t.closest("input, textarea, select, [contenteditable]")) return
    if (isSheetOpen() || !s.board) return
    if (e.key === "Escape") {
      if (s.confirm) {
        const briefId = s.confirm.briefId
        s.confirm = null
        renderLanes()
        focusPrimary(briefId)
      }
      return
    }
    const k = e.key.toLowerCase()
    if (e.key === "?") {
      e.preventDefault()
      toggleKeys()
      return
    }
    if (k === "n") {
      e.preventDefault()
      dispatch.open()
      return
    }
    if (k === "j" || k === "k") {
      e.preventDefault()
      const list = $$(".card", el.lanes).filter((c) => c.offsetParent !== null)
      if (!list.length) return
      const at = list.findIndex((c) => c.contains(document.activeElement))
      const next = at < 0 ? (k === "j" ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, at + (k === "j" ? 1 : -1)))
      list[next].focus({ preventScroll: true })
      list[next].scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion() ? "auto" : "smooth" })
      return
    }
    if (k === "s" || k === "r" || k === "u") {
      const card = document.activeElement instanceof Element ? document.activeElement.closest(".card") : null
      const task = card ? tasks().find((x) => x.brief.id === card.getAttribute("data-key")) : null
      if (!task) return
      const p = task.current.primary
      const match = (k === "s" && (p === "ship" || p === "ship-anyway")) || (k === "r" && p === "rerun") || (k === "u" && p === "unpark")
      if (!match) return
      e.preventDefault()
      void act(task, p)
    }
  }

  function onVisible() {
    if (!document.hidden) pollNow()
  }

  document.addEventListener("keydown", onKey)
  document.addEventListener("visibilitychange", onVisible)
  const offAuth = onAuthChange(() => {
    if (s.privateRead && !getToken()) {
      showReadLock()
      return
    }
    if (s.state === "error" && !s.board) {
      showLoading()
      pollNow()
      return
    }
    if (s.board) {
      if (s.privateRead) pollNow()
      else {
        for (const card of cards.values()) delete card.dataset.sig
        render()
      }
    }
  })
  s.ticker = setInterval(tick, 1000)
  void poll()

  return {
    unmount() {
      s.stopped = true
      clearTimeout(s.timer)
      clearInterval(s.ticker)
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("visibilitychange", onVisible)
      offAuth()
      inspector.destroy()
      dispatch.destroy()
      closeSheet({ restore: false })
      hideKeys()
      setLive(null)
      root.remove()
    },
  }
}
