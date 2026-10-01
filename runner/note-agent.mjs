#!/usr/bin/env node
// A model-free "agent" for demos of the runner loop: `note-agent.mjs <prompt_file> <cwd>`.
// It reads the runner's prompt, and appends one line naming the task to each file path the brief
// lists (directories are skipped). Real work needs a real agent; this only shows the plumbing.
import fs from "node:fs"
import path from "node:path"

const [promptFile, cwd] = process.argv.slice(2)
if (!promptFile || !cwd) {
  console.error("usage: note-agent.mjs <prompt_file> <cwd>")
  process.exit(2)
}
const prompt = fs.readFileSync(promptFile, "utf8")
const task = /^Task:\n(.+)$/m.exec(prompt)?.[1]?.trim() ?? "the brief"
const paths = (/^- Touch only these paths: (.+)$/m.exec(prompt)?.[1] ?? "")
  .split(", ")
  .filter((p) => p && !p.endsWith("/") && !p.startsWith("("))

const touched = []
for (const rel of paths) {
  const file = path.resolve(cwd, rel)
  if (!file.startsWith(path.resolve(cwd) + path.sep)) continue
  const ext = path.extname(file)
  const line =
    ext === ".html" || ext === ".md"
      ? `<!-- note-agent: ${task} -->`
      : ext === ".css"
        ? `/* note-agent: ${task} */`
        : `# note-agent: ${task}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${line}\n`)
  touched.push(rel)
}

console.log(
  touched.length > 0
    ? `Appended a note about "${task}" to ${touched.join(", ")}.`
    : `The brief lists no files to note, so nothing changed.`,
)
