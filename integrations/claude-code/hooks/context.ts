// What Claude reads about the job: the brief as committed, and a one-line reminder on later prompts.

import type { Brief, ClaimedJob } from "./contract"

export const PUSH_TOOL = "mcp__shipboard__push"

/**
 * The brief file's exact bytes, per docs/ARCHITECTURE.md "Names": keys in this order, two-space
 * indent, trailing newline, `demo` only when present. The server commits these bytes; the mod
 * compares them with what it finds at the brief commit.
 */
export function canonicalBrief(brief: Brief): string {
  const ordered: Record<string, unknown> = {
    id: brief.id,
    task: brief.task,
    constraints: brief.constraints,
    acceptance: brief.acceptance,
    paths: brief.paths,
    createdAt: brief.createdAt,
  }
  if (brief.demo !== undefined) ordered.demo = brief.demo
  return JSON.stringify(ordered, null, 2) + "\n"
}

export type JobContext = {
  job: ClaimedJob
  dir: string
  /** Short sha of the verified brief commit. */
  briefSha: string
  /** The session's own directory, to say whether Claude must cd. */
  sessionCwd: string
}

export function briefContext({ job, dir, briefSha, sessionCwd }: JobContext): string {
  const { brief } = job
  const lines = [
    `[shipboard] You are working shipboard job ${job.attemptId}. The brief below was committed as this fork's first commit (verified at ${briefSha}) and is the whole task.`,
    "",
    `Task: ${brief.task}`,
  ]
  if (job.attemptNumber > 1) {
    lines.push(`Attempt: ${job.attemptNumber}, a re-run of the same brief on a newer main. Start from the files as they are now.`)
    if (job.previous?.reason) lines.push(`Why the previous attempt was discarded: ${job.previous.reason}`)
  }
  lines.push(dir === sessionCwd ? `Working copy: ${dir} (the session directory).` : `Working copy: ${dir}. Run commands there (cd ${dir}) and edit files under it.`)
  if (brief.constraints.length > 0) lines.push("Constraints:", ...brief.constraints.map((c) => `- ${c}`))
  if (brief.acceptance.trim() !== "") lines.push("Acceptance (lines of the form contains <path> \"<text>\" are checked by machine):", brief.acceptance.trim())
  if (brief.paths.length > 0) lines.push("Paths you are expected to touch:", ...brief.paths.map((p) => `- ${p}`))
  lines.push(
    "",
    "How this job works:",
    `- When you think the acceptance check passes, call the ${PUSH_TOOL} tool with a one-line message. It commits the working copy, pushes it to this fork, and returns the board's verdict. You can push again after fixing something.`,
    "- git push, remote changes and credential changes are blocked. You never need them.",
    "- Do not edit .shipboard/, .git/ or agent config directories such as .claude/. A push that changes them is refused.",
    "- Do not merge main or resolve conflicts. If the board says Re-run, stop: shipboard discards this diff and runs the brief again on the new main.",
    "- A person decides what ships. Do not ask to ship.",
  )
  return lines.join("\n")
}

export function reminder(job: ClaimedJob, dir: string, board: string | null): string {
  const base = `[shipboard] Job ${job.attemptId} is active in ${dir}. Push with ${PUSH_TOOL}.`
  return board ? `${base} Board: ${board}` : base
}
