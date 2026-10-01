// Parses what follows `/shipboard`. Quoting works as in a shell, so a task can hold spaces.

import { splitWords } from "./shell"

export type DispatchArgs = {
  task: string
  paths: string[]
  constraints: string[]
  acceptance: string
  project?: string
}

export type Parsed =
  | { verb: "claim"; start: boolean }
  | { verb: "dispatch"; start: boolean; dispatch: DispatchArgs }
  | { verb: "status" | "done" | "pane" | "help" }
  | { verb: "error"; message: string }

export const ARGUMENT_HINT = 'claim | dispatch "task" --path <file> | status | done | pane'

export function usage(problem?: string): string {
  return [
    ...(problem ? [problem, ""] : []),
    "/shipboard claim [--no-start]   claim the next queued claude-code job and start on it",
    '/shipboard dispatch "task" --path <file> [--path <file>] [--constraint "..."] [--acceptance \'contains <file> "text"\'] [--project <id>] [--no-start]',
    "                                put a new brief on the board for Claude Code, then claim it",
    "/shipboard status               the job, the brief check and the board's verdict",
    "/shipboard done                 finish the job (pushed, or no_changes when nothing was pushed)",
    "/shipboard pane                 show the shipboard pane",
  ].join("\n")
}

export function parseArgs(args: string): Parsed {
  const words = splitWords(args)
  const verb = words[0] ?? "help"
  const rest = words.slice(1)
  if (verb === "status" || verb === "done" || verb === "pane" || verb === "help") return { verb }
  if (verb === "claim") return { verb, start: !rest.some(isNoStart) }
  if (verb !== "dispatch") return { verb: "error", message: `Unknown subcommand ${JSON.stringify(verb)}.` }

  const out: DispatchArgs = { task: "", paths: [], constraints: [], acceptance: "" }
  const task: string[] = []
  const acceptance: string[] = []
  let start = true
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i] ?? ""
    const eq = word.indexOf("=")
    const flag = word.startsWith("--") && eq > 0 ? word.slice(0, eq) : word
    const inline = word.startsWith("--") && eq > 0 ? word.slice(eq + 1) : undefined
    const value = () => {
      if (inline !== undefined) return inline
      i += 1
      return rest[i]
    }
    if (isNoStart(flag)) {
      start = false
    } else if (flag === "--path" || flag === "-p") {
      const v = value()
      if (v === undefined) return { verb: "error", message: "--path needs a file path." }
      out.paths.push(v)
    } else if (flag === "--constraint" || flag === "-c") {
      const v = value()
      if (v === undefined) return { verb: "error", message: "--constraint needs a sentence." }
      out.constraints.push(v)
    } else if (flag === "--acceptance" || flag === "-a") {
      const v = value()
      if (v === undefined) return { verb: "error", message: "--acceptance needs a check." }
      acceptance.push(v)
    } else if (flag === "--project") {
      const v = value()
      if (v === undefined) return { verb: "error", message: "--project needs a project id." }
      out.project = v
    } else if (word.startsWith("-") && word.length > 1) {
      return { verb: "error", message: `Unknown option ${word}.` }
    } else {
      task.push(word)
    }
  }
  out.task = task.join(" ").trim()
  out.acceptance = acceptance.join("\n")
  if (out.task === "") return { verb: "error", message: "dispatch needs a task in quotes." }
  return { verb: "dispatch", start, dispatch: out }
}

function isNoStart(word: string): boolean {
  return word === "--no-start" || word === "--hold"
}
