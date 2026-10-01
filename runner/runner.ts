/**
 * `npm run runner -- --url <board> --agents codex,claude [--concurrency 2]`
 *
 * Polls POST /api/runner/claim every 3 s (backing off to 15 s while idle), runs up to N jobs at once
 * (runner/job.ts), heartbeats each lease every 60 s. Ctrl-C stops claiming, stops running agents,
 * and reports their jobs as agent_error "runner stopped"; a second Ctrl-C exits at once.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { ClaimedJob, JobOutcome } from "../src/core/types.ts"
import { describeArgv, preflight, resolveAgents, type AgentRefusal, type ResolvedAgent } from "./agents.ts"
import { UsageError } from "./args.ts"
import { BoardClient, BoardHttpError } from "./board.ts"
import { ConfigError, RUNNER_USAGE, loadConfig, timeoutFor, type RunnerConfig } from "./config.ts"
import { runJob, type JobReport } from "./job.ts"
import { RunnerLog } from "./log.ts"
import type { SpawnObserver } from "./proc.ts"

export type RunnerDeps = {
  config: RunnerConfig
  agents: ResolvedAgent[]
  board?: BoardClient
  log?: RunnerLog
  hostEnv?: NodeJS.ProcessEnv
  observe?: SpawnObserver
  /** Called after each job with what was reported. */
  onJobDone?: (job: ClaimedJob, report: JobReport) => void
}

export type RunSummary = {
  jobs: { attemptId: string; outcome: JobOutcome; reported: boolean }[]
  /** Set when the loop ended on an error it cannot recover from (bad token, no agents). */
  fatal?: string
}

export class Runner {
  readonly board: BoardClient
  readonly log: RunnerLog
  private readonly stopController = new AbortController()
  private readonly active = new Map<string, Promise<void>>()
  private readonly agents: Map<string, ResolvedAgent>
  private readonly summary: RunSummary = { jobs: [] }

  constructor(private readonly deps: RunnerDeps) {
    this.board = deps.board ?? new BoardClient(deps.config.url, deps.config.token)
    this.log = deps.log ?? new RunnerLog()
    this.log.redactor.add(deps.config.token)
    this.agents = new Map(deps.agents.map((a) => [a.id, a]))
  }

  get offered(): string[] {
    return [...this.agents.keys()]
  }

  get running(): number {
    return this.active.size
  }

  get stopping(): boolean {
    return this.stopController.signal.aborted
  }

  /** Stop claiming and stop running agents. Their jobs are reported as "runner stopped". */
  stop(): void {
    if (this.stopping) return
    this.log.info(this.active.size > 0 ? `stopping: ending ${this.active.size} running job(s)` : "stopping")
    this.stopController.abort()
  }

  async run(): Promise<RunSummary> {
    const { config } = this.deps
    if (this.agents.size === 0) {
      this.summary.fatal = "No agent is available to offer."
      return this.summary
    }
    this.log.info(
      `runner ${config.runnerId} offering ${this.offered.join(", ")} to ${config.url} (concurrency ${config.concurrency}${config.once ? ", once" : ""})`,
    )

    let delaySec = config.pollSec
    let claimed = 0
    while (!this.stopping) {
      if (config.once && claimed > 0) break
      if (this.active.size >= config.concurrency) {
        await Promise.race([...this.active.values(), this.stoppedPromise()])
        continue
      }

      let job: ClaimedJob | null
      try {
        job = await this.board.claim(config.runnerId, this.offered)
      } catch (error) {
        const status = error instanceof BoardHttpError ? error.status : 0
        if (status === 401 || status === 403) {
          this.summary.fatal = `The board refused the runner token (${status}): ${(error as Error).message} Set SHIPBOARD_RUNNER_TOKEN.`
          this.log.error(this.summary.fatal)
          break
        }
        this.log.warn(`claim failed: ${(error as Error).message}`)
        await this.sleep(delaySec)
        delaySec = Math.min(delaySec * 2, config.idlePollMaxSec)
        continue
      }

      if (!job) {
        await this.sleep(delaySec)
        delaySec = Math.min(delaySec * 2, config.idlePollMaxSec)
        continue
      }
      delaySec = config.pollSec
      claimed += 1
      this.start(job)
    }

    await Promise.allSettled([...this.active.values()])
    return this.summary
  }

  private start(job: ClaimedJob): void {
    const rerun = job.attemptNumber > 1 ? `, re-run of ${job.previous?.attemptId ?? "an earlier attempt"}` : ""
    this.log.job(job.attemptId, job.agent, `claimed (attempt ${job.attemptNumber}${rerun}) brief ${job.brief.id}: ${job.brief.task}`)
    const work = (async () => {
      let report: JobReport
      if (!this.agents.has(job.agent)) {
        // The board only hands out agents we offered, so this is a board bug; fail fast, not by lease expiry.
        const outcome: JobOutcome = { reason: "agent_error", summary: `Runner ${this.deps.config.runnerId} does not run agent "${job.agent}".` }
        const reported = await this.board.finish(job.attemptId, this.deps.config.runnerId, outcome).then(
          () => true,
          () => false,
        )
        report = { outcome, reported, jobDir: "" }
      } else {
        report = await runJob(
          job,
          {
            board: this.board,
            config: this.deps.config,
            agents: this.agents,
            log: this.log,
            hostEnv: this.deps.hostEnv ?? process.env,
            observe: this.deps.observe,
          },
          this.stopController.signal,
        )
      }
      this.summary.jobs.push({ attemptId: job.attemptId, outcome: report.outcome, reported: report.reported })
      this.deps.onJobDone?.(job, report)
    })()
      .catch((error: unknown) => {
        this.log.job(job.attemptId, job.agent, `job crashed: ${(error as Error).message}`, "error")
      })
      .finally(() => {
        this.active.delete(job.attemptId)
      })
    this.active.set(job.attemptId, work)
  }

  private stoppedPromise(): Promise<void> {
    const signal = this.stopController.signal
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
  }

  private sleep(seconds: number): Promise<void> {
    return Promise.race([new Promise<void>((resolve) => setTimeout(resolve, seconds * 1_000)), this.stoppedPromise()])
  }
}

/** Which agents to offer: the explicit list, or every configured template. */
export async function prepareAgents(
  config: RunnerConfig,
  hostEnv: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ ready: ResolvedAgent[]; refused: AgentRefusal[]; explicit: boolean }> {
  const explicit = config.agents.length > 0
  const ids = explicit ? config.agents : Object.keys(config.templates)
  const { ready, refused } = await resolveAgents(ids, config.templates, { pathVar: hostEnv.PATH ?? "", cwd, homeDir: hostEnv.HOME })
  return { ready, refused, explicit }
}

export async function dryRun(config: RunnerConfig, hostEnv: NodeJS.ProcessEnv, cwd: string, print: (line: string) => void): Promise<number> {
  const { ready, refused } = await prepareAgents(config, hostEnv, cwd)
  print("shipboard runner dry run: nothing is claimed and no model is called.")
  print(`board        ${config.url} (runner token ${config.token ? "set" : "not set"})`)
  print(`config       ${config.configPath ?? "built-in defaults (no shipboard.runner.json)"}`)
  print(`runner id    ${config.runnerId}, concurrency ${config.concurrency}, unsafe repo config: ${config.unsafeRepoConfig}`)
  print(`work dir     ${config.workDir}${config.keepJobDirs ? " (job dirs kept)" : ""}`)
  print("")
  await fs.mkdir(config.workDir, { recursive: true })
  const probeDir = await fs.mkdtemp(path.join(config.workDir, "shipboard-preflight-"))
  try {
    for (const agent of ready) {
      const t = agent.template
      const check = await preflight(agent, { tmpDir: probeDir, hostEnv })
      const version = check.version ?? (check.versionError ? `version check failed: ${check.versionError}` : "no version check")
      print(`${agent.id}  ready  ${agent.binPath}  (${version})`)
      print(`  argv     ${describeArgv(agent)}`)
      print(`  stdin    ${t.stdin === null ? "none" : t.stdin}`)
      print(`  parser   ${t.parser}, timeout ${timeoutFor(config, t)} s, max turns ${t.maxTurns ?? config.maxTurns}, budget $${t.budgetUsd ?? config.budgetUsd}`)
      const passed = t.envPass.map((name) => `${name}${hostEnv[name] === undefined ? " (unset)" : ""}`)
      const set = Object.entries(t.envSet).map(([k, v]) => `${k}=${v}`)
      print(`  env      PATH HOME LANG TMPDIR CI NO_COLOR GIT_TERMINAL_PROMPT${passed.length ? ` + ${passed.join(" ")}` : ""}${set.length ? ` + ${set.join(" ")}` : ""}`)
      if (check.auth) print(`  login    ${check.auth}`)
      for (const warning of agent.warnings) print(`  warning  ${warning}`)
      for (const note of t.notes) print(`  note     ${note}`)
      print("")
    }
  } finally {
    await fs.rm(probeDir, { recursive: true, force: true })
  }
  for (const refusal of refused) print(`${refusal.id}  refused  ${refusal.reason}`)
  const offeredIds = new Set([...ready, ...refused].map((a) => a.id))
  const others = Object.keys(config.templates).filter((id) => !offeredIds.has(id))
  if (others.length > 0) print(`\nalso configured, not offered (add to --agents to use): ${others.join(", ")}`)
  if (ready.length === 0) {
    print("")
    print("No agent is ready. Install one, or point templates.<id>.bin at it in shipboard.runner.json.")
    return 1
  }
  return 0
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let config: RunnerConfig
  try {
    config = await loadConfig({ argv, env, cwd: process.cwd() })
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      console.error(error.message)
      if (error instanceof UsageError) console.error(`\n${RUNNER_USAGE}`)
      return 2
    }
    throw error
  }
  if (config.help) {
    console.log(RUNNER_USAGE)
    return 0
  }
  if (config.dryRun) return dryRun(config, env, process.cwd(), (line) => console.log(line))

  const log = new RunnerLog()
  const { ready, refused, explicit } = await prepareAgents(config, env, process.cwd())
  for (const refusal of refused) {
    if (explicit) log.warn(`${refusal.id} refused: ${refusal.reason}`)
    else log.info(`${refusal.id} not offered: ${refusal.reason}`)
  }
  for (const agent of ready) for (const warning of agent.warnings) log.warn(`${agent.id}: ${warning}`)
  if (ready.length === 0) {
    log.error("No agent is ready to offer. Run with --dry-run to see why.")
    return 1
  }

  const runner = new Runner({ config, agents: ready, log, hostEnv: env })
  let interrupts = 0
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupts += 1
    if (interrupts > 1) {
      log.warn(`${signal} again: exiting without waiting`)
      process.exit(130)
    }
    runner.stop()
  }
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)

  const summary = await runner.run()
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)
  if (summary.fatal) return 2
  if (interrupts > 0) return 130
  if (config.once) return summary.jobs[0]?.outcome.reason === "pushed" ? 0 : 1
  return 0
}

function isEntry(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}

if (isEntry()) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
      process.exit(1)
    },
  )
}
