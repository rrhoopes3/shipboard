import { escapeHtml } from "./paths.ts"

export function northlineHtml(): string {
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

export function northlineFiles(): Record<string, string> {
  return {
    "README.md":
      "# Harbor notes\n\nA pier notice used to show fork, digest, trial-merge, ship, and re-run.\n",
    "site/index.html": northlineHtml(),
  }
}
