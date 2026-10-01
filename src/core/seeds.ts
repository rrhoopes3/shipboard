/** Seed content for new projects: a starter site, and the harbor notice board the demo forks three ways. */

import { escapeHtml } from "./names.ts"
import type { BriefFields } from "./brief.ts"

export function starterFiles(name: string, description: string): Record<string, string> {
  const safeName = escapeHtml(name)
  const blurb = description.trim() || "Main is quiet. Forks land here when you ship."
  return {
    "README.md": `# ${name}\n\n${blurb}\n`,
    "site/index.html": `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${safeName}</title>
<style>
  body { margin: 2rem; font-family: Georgia, serif; background: #e7eef0; color: #102126; }
  h1 { font-weight: 500; }
</style>
</head>
<body>
  <h1>${safeName}</h1>
  <p id="lede">Main is quiet. Forks land here when you ship.</p>
</body>
</html>
`,
  }
}

export const HARBOR = {
  name: "Harbor notes",
  description: "Three agents, one notice. Ship what merges. When one conflicts, re-run it on current main.",
} as const

export function harborHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Northline</title>
<style>
  body { margin: 2rem; font-family: Georgia, serif; background: #e7eef0; color: #102126; }
  .eyebrow { letter-spacing: 0.08em; text-transform: uppercase; font-size: 0.75rem; }
  h1 { font-weight: 500; font-size: 2.5rem; margin: 0.3rem 0; }
  footer { margin-top: 2rem; font-size: 0.95rem; }
</style>
</head>
<body>
  <p class="eyebrow">Pier notices</p>
  <h1 id="mark">Northline</h1>
  <p id="lede">The tide book for this week is posted at the shed.</p>
</body>
</html>
`
}

export function harborFiles(): Record<string, string> {
  return {
    "README.md": "# Harbor notes\n\nA pier notice used to show fork, digest, trial merge, ship, and re-run.\n",
    "site/index.html": harborHtml(),
  }
}

/**
 * The three demo briefs. The tint and the rename both rewrite the `<h1 id="mark">` line, so once
 * the footer and one of them ship, the other conflicts. Its re-run on the new main merges cleanly.
 */
export const HARBOR_BRIEFS: ReadonlyArray<BriefFields & { demo: string }> = [
  {
    demo: "mark-color",
    task: "Tint the pier name in channel teal",
    constraints: ["Leave the notice text alone", "Touch only site/index.html"],
    acceptance: 'contains site/index.html "color:#1F6F78"',
    paths: ["site/index.html"],
  },
  {
    demo: "mark-name",
    task: "Rename the pier mark to the night board",
    constraints: ["Keep the mark element", "Touch only site/index.html"],
    acceptance: 'contains site/index.html "Northline night board"',
    paths: ["site/index.html"],
  },
  {
    demo: "footer",
    task: "Add the night clerk footer",
    constraints: ["Do not change the pier name", "Touch only site/index.html"],
    acceptance: 'contains site/index.html "Posted by the night clerk."',
    paths: ["site/index.html"],
  },
]
