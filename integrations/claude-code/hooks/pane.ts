// The docked pane: this fork's verdict at a glance. Pure: element constructors and a model in, a tree
// out, so it renders the same in a test as in the terminal.
// Element and prop names follow https://code.claude.com/docs/en/plugins/mods/reference.md#elements;
// a prop an element does not take makes Claude Code refuse the whole tree, so this stays plain.

import type { Elements, RenderElement, RenderNode } from "./mods"
import { actionLabel, short, type Verdict } from "./verdict"

export const PANE_ID = "shipboard"
export const PANE_TITLE = "Shipboard"

export type PaneModel = {
  job: {
    attemptId: string
    attemptNumber: number
    task: string
    dir: string
    briefPath: string
  } | null
  brief: { ok: boolean; sha: string; detail: string } | null
  verdict: Verdict | null
  pushedSha: string | null
  /** The latest problem or event worth a line, such as an unreachable board. */
  note: string | null
  /** Set after the job finished, until the next claim. */
  ended: string | null
}

const LABEL = 8

export function renderPane(el: Elements, model: PaneModel): RenderElement {
  const { Box, Text } = el
  const rows: RenderNode[] = []
  const row = (label: string, ...value: RenderNode[]) =>
    Text({ wrap: "truncate-end", children: [Text({ dimColor: true, children: label.padEnd(LABEL) }), ...value] })
  const job = model.job

  if (!job) {
    if (model.ended) rows.push(Text({ wrap: "wrap", children: model.ended }))
    rows.push(Text({ dimColor: true, wrap: "wrap", children: 'No shipboard job in this session. Run /shipboard claim, or /shipboard dispatch "task" --path <file>.' }))
    if (model.note) rows.push(Text({ color: "yellow", wrap: "wrap", children: model.note }))
    return Box({ flexDirection: "column", children: rows })
  }

  const v = model.verdict
  const a = v?.attempt
  rows.push(Text({ bold: true, color: "cyan", wrap: "truncate-end", children: `shipboard · attempt ${job.attemptNumber} · Claude Code` }))
  rows.push(Text({ wrap: "wrap", children: job.task }))

  const brief = model.brief
  rows.push(
    brief === null
      ? row("brief", Text({ dimColor: true, children: "checking" }))
      : brief.ok
        ? row("brief", Text({ color: "green", children: `✓ ${brief.sha}` }), Text({ dimColor: true, children: ` ${job.briefPath}` }))
        : row("brief", Text({ color: "red", children: `✗ ${brief.detail}` })),
  )
  rows.push(row("fork", Text({ children: job.attemptId })))
  rows.push(row("dir", Text({ children: job.dir })))
  rows.push(
    row(
      "head",
      Text({ children: a ? short(a.headSha) : model.pushedSha ? short(model.pushedSha) : "-" }),
      ...(a ? [Text({ dimColor: true, children: `  ${a.status}` })] : []),
    ),
  )

  if (v && (!v.isCurrent || a?.status === "discarded")) {
    rows.push(
      row(
        "status",
        Text({ color: "red", bold: true, children: "discarded" }),
        ...(a?.replacedBy ? [Text({ dimColor: true, children: ` → ${a.replacedBy}` })] : []),
      ),
    )
    if (a?.discardReason) rows.push(Text({ wrap: "wrap", children: a.discardReason }))
  } else if (a) {
    const merge = a.merge
    rows.push(
      merge === null
        ? row("merge", Text({ dimColor: true, children: a.status === "waiting" ? "waiting for a push" : "not checked yet" }))
        : merge.state === "clean"
          ? row("merge", Text({ color: "green", children: "✓ clean" }), Text({ dimColor: true, children: ` vs main ${short(merge.mainSha)}` }))
          : row("merge", Text({ color: "red", bold: true, children: "✗ conflict " }), Text({ children: merge.paths.join(", ") })),
    )
    if (a.digest) {
      const color = a.digest.satisfies === "yes" ? "green" : a.digest.satisfies === "no" ? "red" : "yellow"
      rows.push(Text({ wrap: "wrap", children: [Text({ dimColor: true, children: "digest".padEnd(LABEL) }), Text({ color, children: a.digest.summary })] }))
      for (const check of a.digest.checks) {
        rows.push(
          Text({
            wrap: "truncate-end",
            children: [Text({ children: " ".repeat(LABEL) }), Text({ color: check.ok ? "green" : "red", children: check.ok ? "✓ " : "✗ " }), Text({ dimColor: true, children: `${check.path} "${check.text}"` })],
          }),
        )
      }
      const extra = [...a.digest.unexpectedPaths.map((p) => `+${p}`), ...a.digest.missedPaths.map((p) => `-${p}`), ...a.digest.controlPaths.map((p) => `!${p}`)]
      if (extra.length > 0) rows.push(row("paths", Text({ color: "yellow", children: extra.join(" ") })))
    }
    if (a.review) {
      const color = a.review.verdict === "satisfies" ? "green" : a.review.verdict === "off-brief" ? "red" : "yellow"
      rows.push(Text({ wrap: "wrap", children: [Text({ dimColor: true, children: "review".padEnd(LABEL) }), Text({ color, children: a.review.verdict }), Text({ children: ` · ${a.review.note}` })] }))
    }
    if (v?.previewUrl) rows.push(row("preview", link(el, v.previewUrl)))
    const decides = a.status !== "shipped" && a.primary !== "wait" && a.primary !== "none"
    rows.push(row("next", actionText(el, a.primary, a.status), ...(decides ? [Text({ dimColor: true, children: "  on the board; a person decides" })] : [])))
  } else {
    rows.push(row("merge", Text({ dimColor: true, children: "waiting for the board" })))
  }

  if (model.note) rows.push(Text({ color: "yellow", wrap: "wrap", children: model.note }))
  return Box({ flexDirection: "column", children: rows })
}

function actionText(el: Elements, action: Verdict["attempt"]["primary"], status: string): RenderElement {
  const { Text } = el
  if (status === "shipped") return Text({ color: "green", bold: true, children: "shipped" })
  const label = actionLabel(action)
  switch (action) {
    case "ship":
      return Text({ color: "green", bold: true, children: `▶ ${label}` })
    case "ship-anyway":
      return Text({ color: "yellow", bold: true, children: `▶ ${label}` })
    case "rerun":
      return Text({ color: "red", bold: true, children: `↻ ${label}` })
    case "wait":
      return Text({ dimColor: true, children: "… working" })
    default:
      return Text({ bold: true, children: label })
  }
}

/** A Link only takes an https URL or http://localhost; anything else would void the tree. */
export function link(el: Elements, href: string): RenderElement {
  if (isLinkable(href)) return el.Link({ href, label: href })
  return el.Text({ children: href })
}

export function isLinkable(href: string): boolean {
  try {
    const url = new URL(href)
    if (url.href !== href || href.length > 2048 || !/^[\x21-\x7e]+$/.test(href) || url.username || url.password) return false
    return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")
  } catch {
    return false
  }
}
