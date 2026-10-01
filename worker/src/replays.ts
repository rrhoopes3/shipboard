import fs from "node:fs/promises"
import path from "node:path"

async function editHtml(root: string, change: (html: string) => string): Promise<void> {
  const full = path.join(root, "site", "index.html")
  const current = await fs.readFile(full, "utf8")
  const next = change(current)
  if (next !== current) await fs.writeFile(full, next)
}

export async function replayMarkColor(root: string): Promise<void> {
  await editHtml(root, (html) =>
    html.replace(/<h1 id="mark"([^>]*)>([\s\S]*?)<\/h1>/, (_match, attrs: string, inner: string) => {
      const without = attrs.replace(/\s*style="[^"]*"/g, "")
      return `<h1 id="mark"${without} style="color:#1F6F78">${inner}</h1>`
    }),
  )
}

export async function replayMarkName(root: string): Promise<void> {
  await editHtml(root, (html) =>
    html.replace(
      /<h1 id="mark"([^>]*)>[\s\S]*?<\/h1>/,
      (_match, attrs: string) => `<h1 id="mark"${attrs}>Northline night board</h1>`,
    ),
  )
}

export async function replayFooter(root: string): Promise<void> {
  await editHtml(root, (html) => {
    if (html.includes("Posted by the night clerk.")) return html
    return html.replace("</body>", "<footer>Posted by the night clerk.</footer>\n</body>")
  })
}

const REPLAYS = {
  "mark-color": replayMarkColor,
  "mark-name": replayMarkName,
  footer: replayFooter,
} as const

export type ReplayId = keyof typeof REPLAYS

export function isReplay(id: string): id is ReplayId {
  return Object.prototype.hasOwnProperty.call(REPLAYS, id)
}

export async function runReplay(id: ReplayId, root: string): Promise<void> {
  await REPLAYS[id](root)
}

export const PIER = [
  {
    agent: "claude",
    replay: "mark-color" as const,
    task: "Tint the pier name in channel teal",
    constraints: ["Leave the notice text alone", "Touch only site/index.html"],
    acceptance: 'contains site/index.html "color:#1F6F78"',
    paths: ["site/index.html"],
  },
  {
    agent: "codex",
    replay: "mark-name" as const,
    task: "Rename the pier mark to the night board",
    constraints: ["Keep the mark element", "Touch only site/index.html"],
    acceptance: 'contains site/index.html "Northline night board"',
    paths: ["site/index.html"],
  },
  {
    agent: "grok",
    replay: "footer" as const,
    task: "Add the night clerk footer",
    constraints: ["Do not change the pier name", "Touch only site/index.html"],
    acceptance: 'contains site/index.html "Posted by the night clerk."',
    paths: ["site/index.html"],
  },
]
