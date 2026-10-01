/**
 * `npm run agent -- <command>`: the thin board client for agents (and people) that self-serve.
 *
 *   list                                  projects
 *   board <projectId>                     lanes, one line per task
 *   dispatch --project <id> --task "..." --path <p> [--path <p>...] [--constraint "..."]...
 *            [--acceptance "<line>"]... --agent <id> [--credentials]
 *   status <attemptId>                    one attempt in detail
 *   pushed <attemptId> [--sha <sha>]      tell the board you pushed (it also notices on its own)
 *
 * Every repeatable flag keeps every value (the old client kept only the last --path). `dispatch`
 * prints the attempt id the board returned instead of guessing the newest fork.
 */

import { pathToFileURL } from "node:url"
import type { AttemptView, BoardView, GitCredentials, Lane, TaskView } from "../src/core/types.ts"
import { UsageError, allValues, lastValue, parseArgs, type ParsedArgs } from "./args.ts"
import { BoardClient, BoardHttpError, type FetchLike } from "./board.ts"
import { projectIdOf } from "./brief.ts"

export type CliIo = {
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
  fetch?: FetchLike
}

const FLAGS = {
  values: ["url", "token", "project", "task", "path", "constraint", "acceptance", "agent", "sha"],
  booleans: ["credentials", "help"],
} as const

export const CLI_USAGE = `shipboard agent CLI

  npm run agent -- list
  npm run agent -- board <projectId>
  npm run agent -- dispatch --project <id> --task "Tint the pier name" --path site/index.html \\
        [--path <more>] [--constraint "No new files"] [--acceptance 'contains site/index.html "teal"'] \\
        --agent <agentId> [--credentials]
  npm run agent -- status <attemptId>
  npm run agent -- pushed <attemptId> [--sha <commit>]

  --path, --constraint and --acceptance repeat; each --acceptance is one line.
  --credentials (manual agents only) also prints a write token and a git clone/push recipe.

  Board: --url or SHIPBOARD_URL (default http://127.0.0.1:8787).
  Token: --token or SHIPBOARD_TOKEN (the board token; needed for dispatch when the board has one).
`

const LANE_TITLES: Record<Lane, string> = {
  rerun: "RE-RUN",
  ship: "SHIP",
  review: "REVIEW",
  working: "WORKING",
  parked: "PARKED",
  shipped: "SHIPPED",
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv, FLAGS)
  } catch (error) {
    io.err((error as Error).message)
    io.err(CLI_USAGE)
    return 2
  }
  const [command, ...rest] = args.positionals
  if (!command || command === "help" || args.booleans.has("help")) {
    io.out(CLI_USAGE)
    return command || args.booleans.has("help") ? 0 : 2
  }

  const base = (lastValue(args, "url") ?? io.env.SHIPBOARD_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "")
  const token = lastValue(args, "token") ?? io.env.SHIPBOARD_TOKEN
  const client = new BoardClient(base, token, io.fetch)

  try {
    switch (command) {
      case "list":
        return await list(client, io)
      case "board":
        return await board(client, need(rest[0], "board <projectId>"), base, io)
      case "dispatch":
        return await dispatch(client, args, base, io)
      case "status":
        return await status(client, need(rest[0], "status <attemptId>"), base, io)
      case "pushed": {
        const attemptId = need(rest[0], "pushed <attemptId>")
        await client.pushed(attemptId, lastValue(args, "sha"))
        io.out(`Told the board ${attemptId} was pushed.`)
        return 0
      }
      default:
        throw new UsageError(`Unknown command "${command}".`)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message)
      io.err(CLI_USAGE)
      return 2
    }
    if (error instanceof BoardHttpError) {
      io.err(error.status === 401 ? `${error.message} Set SHIPBOARD_TOKEN or pass --token.` : error.message)
      return 1
    }
    throw error
  }
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(`Usage: npm run agent -- ${usage}`)
  return value
}

async function list(client: BoardClient, io: CliIo): Promise<number> {
  const projects = await client.projects()
  if (projects.length === 0) {
    io.out("No projects yet.")
    return 0
  }
  for (const p of projects) {
    const counts = (Object.keys(LANE_TITLES) as Lane[])
      .filter((lane) => (p.counts?.[lane] ?? 0) > 0)
      .map((lane) => `${lane} ${p.counts[lane]}`)
      .join(", ")
    io.out(`${p.id}  ${p.name}  main ${short(p.mainSha)}${counts ? `  (${counts})` : ""}`)
  }
  return 0
}

async function board(client: BoardClient, projectId: string, base: string, io: CliIo): Promise<number> {
  const view = await client.board(projectId)
  io.out(`${view.project.name} (${view.project.id})  main ${short(view.project.mainSha)}  v${view.version}`)
  io.out(`preview ${absolute(base, view.project.previewUrl)}`)
  let any = false
  for (const { lane, tasks } of view.lanes) {
    if (tasks.length === 0) continue
    any = true
    io.out("")
    io.out(`${LANE_TITLES[lane]}  ${tasks.length}`)
    for (const task of tasks) {
      const a = task.current
      io.out(`  ${pad(a.primary, 11)} ${pad(`${a.agent} #${a.number}`, 12)} ${task.brief.task}`)
      io.out(`  ${" ".repeat(11)} ${a.id}  ${laneDetail(task)}`)
    }
  }
  if (!any) io.out("\nNo tasks yet. Dispatch one with: npm run agent -- dispatch --project " + view.project.id + " ...")
  const recent = view.activity.slice(-5)
  if (recent.length > 0) {
    io.out("")
    io.out("RECENT")
    for (const item of recent) io.out(`  ${item.at.slice(11, 16)}  ${item.text}`)
  }
  return 0
}

function laneDetail(task: TaskView): string {
  const a = task.current
  if (a.status === "shipped") return `shipped as ${short(a.shippedSha ?? "")}`
  if (a.status === "parked") return "parked"
  if (a.status === "failed") return `failed: ${a.job?.outcome?.summary ?? "the agent pushed nothing usable"}`
  if (a.status === "waiting") {
    if (!a.job) return a.agentKind === "manual" ? "waiting for a push" : "waiting"
    if (a.job.state === "running") return `running on ${a.job.runnerId ?? "a runner"}`
    return `job ${a.job.state}`
  }
  if (a.merge?.state === "conflict") return `conflicts with main in ${a.merge.paths.join(", ") || "some files"}`
  const parts = [a.digest?.summary ?? "assessing"]
  if (a.review && a.review.verdict !== "satisfies") parts.push(`review: ${a.review.verdict}`)
  return parts.join("  ")
}

async function dispatch(client: BoardClient, args: ParsedArgs, base: string, io: CliIo): Promise<number> {
  const project = lastValue(args, "project")
  const task = lastValue(args, "task")
  const paths = allValues(args, "path")
  let agent = lastValue(args, "agent")
  if (!project) throw new UsageError("dispatch needs --project <id>.")
  if (!task) throw new UsageError("dispatch needs --task \"...\".")
  if (paths.length === 0) throw new UsageError("dispatch needs at least one --path (repeat it for more).")
  if (!agent) {
    const known = await client.config().then(
      (c) => c.agents.map((a) => `${a.id} (${a.kind})`).join(", "),
      () => "",
    )
    throw new UsageError(`dispatch needs --agent <id>${known ? ` (this board knows: ${known})` : ""}.`)
  }
  agent = agent.trim()
  const withCredentials = args.booleans.has("credentials")

  const res = await client.dispatch(project, {
    task,
    paths,
    constraints: allValues(args, "constraint"),
    acceptance: allValues(args, "acceptance").join("\n"),
    agent,
    ...(withCredentials ? { credentials: true } : {}),
  })
  io.out(res.attemptId)
  if (res.notice) io.out(res.notice)
  io.out(`preview ${absolute(base, `/preview/${projectIdOf(res.attemptId)}/${res.attemptId}/`)} (after the first push)`)
  if (withCredentials) {
    if (res.credentials) {
      for (const line of pushRecipe(res.attemptId, task, paths, res.credentials)) io.out(line)
    } else {
      io.out("")
      io.out(`The board returned no credentials: only manual agents get a token, and "${agent}" is not one.`)
    }
  }
  return 0
}

/** Single-quote for sh/zsh. */
export function shQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`
}

/**
 * A clone/push recipe with the token in env-scoped git config (http.extraHeader). It stays out of
 * argv and out of the clone's .git/config, the same way the runner handles it.
 */
export function pushRecipe(attemptId: string, task: string, paths: string[], creds: GitCredentials): string[] {
  const header = "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0=\"$SHIPBOARD_GIT_AUTH\""
  const remote = shQuote(creds.remote)
  const dir = shQuote(attemptId)
  return [
    "",
    `Write token for this fork only, expires ${creds.expiresAt || "soon"}. Treat it like a password.`,
    "",
    `  export SHIPBOARD_GIT_AUTH=${shQuote(`Authorization: Bearer ${creds.token}`)}`,
    `  ${header} git clone --branch main ${remote} ${dir}`,
    `  cd ${dir}`,
    `  # change ${paths.join(", ")}, then:`,
    `  git add -A && git commit -m ${shQuote(task)}`,
    `  ${header} git push ${remote} HEAD:main`,
    `  npm run agent -- pushed ${attemptId}`,
  ]
}

async function status(client: BoardClient, attemptId: string, base: string, io: CliIo): Promise<number> {
  const view = await client.board(projectIdOf(attemptId))
  const found = findAttempt(view, attemptId)
  if (!found) {
    io.err(`No attempt ${attemptId} on project ${view.project.id}.`)
    return 1
  }
  const { task, attempt, lane } = found
  const isCurrent = task.current.id === attempt.id
  io.out(`attempt   ${attempt.id}  (#${attempt.number}, ${attempt.agentLabel || attempt.agent})`)
  io.out(`task      ${task.brief.task}`)
  io.out(`status    ${attempt.status}${isCurrent ? `, lane ${lane}, next: ${attempt.primary}` : " (an earlier attempt)"}`)
  if (attempt.job) {
    const job = attempt.job
    const runner = job.runnerId ? ` on ${job.runnerId}` : ""
    const outcome = job.outcome ? ` (${job.outcome.reason}): ${job.outcome.summary}` : ""
    io.out(`job       ${job.state}${runner}${outcome}`)
  }
  if (attempt.merge) {
    const m = attempt.merge
    io.out(`merge     ${m.state === "clean" ? "clean" : `conflict in ${m.paths.join(", ")}`} against main ${short(m.mainSha)}`)
  }
  if (attempt.digest) io.out(`digest    ${attempt.digest.summary} [satisfies: ${attempt.digest.satisfies}]`)
  if (attempt.review) io.out(`review    ${attempt.review.verdict}: ${attempt.review.note}`)
  io.out(`head      ${short(attempt.headSha)} (base ${short(attempt.baseSha)}, brief ${short(attempt.briefSha)})`)
  if (attempt.previewUrl) io.out(`preview   ${absolute(base, attempt.previewUrl)}`)
  if (attempt.replacedBy) io.out(`replaced  by ${attempt.replacedBy}${attempt.discardReason ? `: ${attempt.discardReason}` : ""}`)
  if (attempt.replaces) io.out(`replaces  ${attempt.replaces}`)
  if (attempt.shippedSha) io.out(`shipped   main ${short(attempt.shippedSha)}`)
  return 0
}

function findAttempt(view: BoardView, attemptId: string): { task: TaskView; attempt: AttemptView; lane: Lane } | null {
  for (const { lane, tasks } of view.lanes) {
    for (const task of tasks) {
      for (const attempt of [task.current, ...task.history]) {
        if (attempt.id === attemptId) return { task, attempt, lane }
      }
    }
  }
  return null
}

function short(sha: string): string {
  return sha ? sha.slice(0, 7) : "-"
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

function absolute(base: string, url: string): string {
  return /^https?:\/\//.test(url) ? url : `${base}${url.startsWith("/") ? "" : "/"}${url}`
}

function isEntry(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntry()) {
  runCli(process.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    },
  )
}
