/**
 * The scripted demo agent. Each edit is a pure string transform applied to a file read at the
 * fork's head, so a re-run on a newer main edits that newer text. The core commits and pushes the
 * result with a write token, exactly like a runner would.
 */

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

export const DEMO_AUTHOR = { name: "Demo (scripted)", email: "demo@users.noreply.local" } as const
