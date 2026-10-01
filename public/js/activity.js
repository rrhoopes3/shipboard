// The activity feed (newest first) and the one-line ticker. Server sentences are text; quoted task
// titles become links to their card and shas become mono chips.

import { ago, clear, h, hms, icon, short } from "./dom.js"

const GLYPH = {
  project: "anchor",
  dispatched: "brief",
  claimed: "clock",
  pushed: "commit",
  assessed: "check",
  conflict: "x",
  shipped: "ship",
  rerun: "rerun",
  parked: "park",
  unparked: "unpark",
  failed: "alert",
}
const KIND_LABEL = { rerun: "re-run" }
const MAX_ITEMS = 80

const keyOf = (item) => `${item.at}|${item.kind}|${item.attemptId ?? ""}|${item.text}`

/** Newest first by time, ties broken by original position (later = newer), whatever order the server used. */
export function sortActivity(list) {
  return list
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.at < b.item.at ? 1 : a.item.at > b.item.at ? -1 : b.i - a.i))
    .map((x) => x.item)
}

const RICH = /"([^"\n]{1,200})"|\b([0-9a-f]{40}|(?=[0-9a-f]{0,6}\d)[0-9a-f]{7})\b/g

/**
 * `ctx.titles` maps task title → briefId; `ctx.onTask(briefId, how)` is called with "enter",
 * "leave" or "go" so the board can light up or scroll to the card.
 */
export function richText(text, ctx) {
  const out = []
  let last = 0
  let m
  RICH.lastIndex = 0
  while ((m = RICH.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) {
      const briefId = ctx ? findBrief(ctx.titles, m[1]) : null
      const quoted = `“${m[1]}”`
      out.push(
        briefId
          ? h(
              "a",
              {
                class: "feed-task",
                href: `#card-${briefId}`,
                onclick: (e) => {
                  e.preventDefault()
                  ctx.onTask(briefId, "go")
                },
                onmouseenter: () => ctx.onTask(briefId, "enter"),
                onmouseleave: () => ctx.onTask(briefId, "leave"),
                onfocus: () => ctx.onTask(briefId, "enter"),
                onblur: () => ctx.onTask(briefId, "leave"),
              },
              quoted,
            )
          : quoted,
      )
    } else {
      out.push(h("span", { class: "sha", title: m[2] }, short(m[2])))
    }
    last = RICH.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function findBrief(titles, quoted) {
  if (!titles) return null
  if (titles.has(quoted)) return titles.get(quoted)
  // Core shortens long titles in sentences and ends them with an ellipsis.
  const stem = quoted.replace(/(…|\.\.\.)$/, "")
  if (stem !== quoted) for (const [title, id] of titles) if (title.startsWith(stem)) return id
  return null
}

function item(entry, ctx, isNew) {
  return h(
    "li",
    { class: isNew ? "feed-item is-new" : "feed-item", "data-kind": entry.kind },
    h("span", { class: "feed-glyph", "aria-hidden": "true" }, icon(GLYPH[entry.kind] ?? "commit")),
    h(
      "p",
      { class: "feed-when" },
      h("time", { datetime: entry.at }, hms(entry.at)),
      h("span", { class: "feed-kind" }, KIND_LABEL[entry.kind] ?? entry.kind),
      h("span", { class: "feed-ago", "data-ago": entry.at }, ago(entry.at)),
    ),
    h("p", { class: "feed-text" }, richText(entry.text, ctx)),
  )
}

/** Keeps the list in step with the board. Only new entries are prepended, so aria-live reads just those. */
export function createFeed(list) {
  let keys = []
  return {
    render(activity, ctx) {
      const sorted = sortActivity(activity).slice(0, MAX_ITEMS)
      const next = sorted.map(keyOf)
      const known = new Set(keys)
      const fresh = []
      for (const k of next) {
        if (known.has(k)) break
        fresh.push(k)
      }
      const rest = next.slice(fresh.length)
      const continues = keys.length > 0 && rest.length > 0 && rest.every((k, i) => keys[i] === k)
      if (continues && fresh.length === 0 && rest.length === keys.length) return
      if (continues) {
        for (let i = fresh.length - 1; i >= 0; i--) list.prepend(item(sorted[i], ctx, true))
        while (list.children.length > next.length) list.lastElementChild?.remove()
      } else {
        list.setAttribute("aria-live", "off")
        clear(list)
        for (const entry of sorted) list.append(item(entry, ctx, false))
        if (!sorted.length) list.append(h("li", { class: "feed-empty" }, "Nothing has happened here yet."))
        requestAnimationFrame(() => list.setAttribute("aria-live", "polite"))
      }
      keys = next
    },
  }
}

/** One line: the newest sentence, for widths where the feed sits below the lanes. */
export function renderTicker(el, activity, ctx) {
  const newest = sortActivity(activity)[0]
  const k = newest ? keyOf(newest) : ""
  if (el.dataset.key === k) return
  const changed = Boolean(el.dataset.key)
  el.dataset.key = k
  clear(el)
  if (!newest) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.dataset.kind = newest.kind
  el.append(
    h("span", { class: "feed-glyph", "aria-hidden": "true" }, icon(GLYPH[newest.kind] ?? "commit")),
    h("time", { class: "ticker-when", datetime: newest.at }, hms(newest.at)),
    h("span", { class: "ticker-kind" }, KIND_LABEL[newest.kind] ?? newest.kind),
    h("span", { class: "ticker-text" }, richText(newest.text, ctx)),
    h("a", { class: "ticker-all", href: "#feed", onclick: (e) => {
      e.preventDefault()
      ctx.onFeed()
    } }, "All activity ", icon("down")),
  )
  if (changed) {
    el.classList.remove("is-new")
    void el.offsetWidth
    el.classList.add("is-new")
  }
}
