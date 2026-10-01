/**
 * The prompt the agent sees. It is written to the job dir, outside the clone, so it can never be
 * committed. Fixed framing first, then the brief fields copied verbatim, then (for re-runs) one
 * context sentence. The brief itself is never edited: a re-run executes the same brief again.
 */

import fs from "node:fs/promises"
import path from "node:path"
import type { ClaimedJob } from "../src/core/types.ts"

export function buildPrompt(job: ClaimedJob): string {
  const { brief } = job
  const paths = brief.paths.length > 0 ? brief.paths.join(", ") : "(the brief lists no paths; keep the change small)"
  const lines: string[] = [
    "Implement the brief below in this git checkout (your current working directory).",
    "",
    "Rules:",
    `- Touch only these paths: ${paths}`,
    "- Do not run git commit or git push. Do not edit anything under .git or .shipboard. The runner commits and pushes your work when you finish.",
    "- Do not ask questions; nobody is watching this run. If something is unclear, make the smallest reasonable choice and say so.",
    "- End your reply with a concise one-paragraph summary of what you changed, with normal spacing between sentences.",
    "",
  ]

  if (job.attemptNumber > 1) {
    const raw = job.previous?.reason?.trim().replace(/\s+/g, " ")
    const reason = raw ? (/[.!?]$/.test(raw) ? raw : `${raw}.`) : ""
    lines.push(
      `Context: main moved; the previous attempt was discarded${reason ? `: ${reason}` : "."} Start from the current files.`,
      "",
    )
  }

  lines.push(
    `----- brief ${brief.id} (also committed at ${job.briefPath}) -----`,
    "",
    "Task:",
    brief.task,
    "",
  )
  if (brief.constraints.length > 0) {
    lines.push("Constraints:", ...brief.constraints.map((c) => `- ${c}`), "")
  }
  lines.push("Paths:", ...(brief.paths.length > 0 ? brief.paths.map((p) => `- ${p}`) : ["- (none listed)"]), "")
  if (brief.acceptance.trim()) {
    lines.push(
      "Acceptance (lines of the form contains <path> \"<text>\" are checked by machine against your files):",
      brief.acceptance,
      "",
    )
  }
  lines.push("----- end of brief -----", "")
  return lines.join("\n")
}

/** Writes `<jobDir>/prompt.md` and returns its path. */
export async function writePrompt(jobDir: string, job: ClaimedJob): Promise<{ file: string; text: string }> {
  const text = buildPrompt(job)
  const file = path.join(jobDir, "prompt.md")
  await fs.writeFile(file, text, { mode: 0o600 })
  return { file, text }
}
