/**
 * The scripted demo agent. Each edit is a pure string transform applied to a file read at the
 * fork's head, so a re-run on a newer main edits that newer text. The scripted runner commits the
 * result with a write token, exactly like a runner would.
 */

import { DEMO_AGENT } from "./agents.ts"
import type { GitWorkspace } from "./git.ts"
import { oneLine } from "./names.ts"
import { PortError } from "./ports.ts"
import type { Brief } from "./types.ts"

export type DemoEdit = {
  path: string
  apply: (text: string) => string
}

const MARK = /<h1 id="mark"([^>]*)>([\s\S]*?)<\/h1>/

export const DEMO_EDITS: Readonly<Record<string, DemoEdit>> = {
  "mark-color": {
    path: "site/index.html",
    apply: (html) =>
      html.replace(MARK, (_match, attrs: string, inner: string) => {
        const without = attrs.replace(/\s*style="[^"]*"/g, "")
        return `<h1 id="mark"${without} style="color:#1F6F78">${inner}</h1>`
      }),
  },
  "mark-name": {
    path: "site/index.html",
    apply: (html) => html.replace(MARK, (_match, attrs: string) => `<h1 id="mark"${attrs}>Northline night board</h1>`),
  },
  footer: {
    path: "site/index.html",
    apply: (html) =>
      html.includes("Posted by the night clerk.")
        ? html
        : html.replace("</body>", "<footer>Posted by the night clerk.</footer>\n</body>"),
  },
}

export function demoEdit(id: string | undefined): DemoEdit | null {
  if (!id || !Object.prototype.hasOwnProperty.call(DEMO_EDITS, id)) return null
  return DEMO_EDITS[id] ?? null
}

export function supportsDemo(id: string | undefined): boolean {
  return demoEdit(id) !== null
}

export const DEMO_AUTHOR = { name: "Demo (scripted)", email: "demo@users.noreply.local" } as const

export type DemoResult =
  | { ok: true; sha: string; path: string }
  | { ok: false; reason: "agent_error" | "no_changes"; summary: string }

/** Read, apply, commit and push one scripted edit. The caller owns only the job lifecycle. */
export async function runDemoEdit(git: GitWorkspace, repo: string, attemptId: string, brief: Brief): Promise<DemoResult> {
  const edit = demoEdit(brief.demo)
  if (!edit) return { ok: false, reason: "agent_error", summary: "The demo agent only knows the harbor demo briefs." }
  try {
    const head = await git.head(repo)
    if (!head) throw new PortError("The fork has no main branch.", 409)
    const current = await git.readAt(repo, head, edit.path)
    if (!current) return { ok: false, reason: "agent_error", summary: `${edit.path} is missing on this fork.` }
    const next = edit.apply(new TextDecoder().decode(current))
    const commit = await git.commit(repo, { [edit.path]: next },
      `${oneLine(brief.task)}\n\nShipboard-Attempt: ${attemptId}\nShipboard-Agent: ${DEMO_AGENT}`,
      { author: DEMO_AUTHOR, parent: head })
    if (!commit.changed) return { ok: false, reason: "no_changes", summary: `The scripted edit left ${edit.path} unchanged.` }
    return { ok: true, sha: commit.sha, path: edit.path }
  } catch (err) {
    return { ok: false, reason: "agent_error", summary: oneLine(err instanceof Error ? err.message : String(err), 300) }
  }
}
