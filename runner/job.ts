/**
 * One claimed job, start to finish (docs/ARCHITECTURE.md "Runner", research/agents.md 7.1 and 7.5):
 *
 *   read token -> clone into a fresh temp dir -> verify the brief commit -> clean unsafe repo config
 *   -> write prompt -> run agent -> normalize outcome -> inspect tree -> commit -> write token
 *   -> push HEAD:main -> POST pushed -> POST finish
 *
 * The agent never holds a token: the read token is used (and its env discarded) before the agent
 * starts, the write token is fetched after it exits.
 */

import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { ClaimedJob, JobOutcome, JobOutcomeReason } from "../src/core/types.ts"
import { agentEnv, renderArgs, renderString, type RenderVars, type ResolvedAgent } from "./agents.ts"
import { BoardHttpError, type BoardClient } from "./board.ts"
import { briefPathFor, canonicalBriefJson } from "./brief.ts"
import { timeoutFor, type RunnerConfig } from "./config.ts"
import {
  GitError,
  clone,
  commit,
  git,
  isAncestor,
  push,
  readBlob,
  revParse,
  shortSha,
  stagedChanges,
  unstage,
  type GitContext,
} from "./git.ts"
import type { RunnerLog } from "./log.ts"
import { lastParagraph, parseOutcome, type AgentOutcome } from "./outcome.ts"
import { runProcess, type SpawnObserver } from "./proc.ts"
import { writePrompt } from "./prompt.ts"

export type JobDeps = {
  board: BoardClient
  config: RunnerConfig
  agents: ReadonlyMap<string, ResolvedAgent>
  log: RunnerLog
  hostEnv: NodeJS.ProcessEnv
  observe?: SpawnObserver
}

export type JobReport = {
  outcome: JobOutcome
  /** False when the finish call could not be delivered (lease lost, board unreachable). */
  reported: boolean
  jobDir: string
}

/** Repo-root entries that configure an agent CLI. Removed before the agent runs (policy "clean"). */
export const UNSAFE_REPO_CONFIG = [".envrc", ".mcp.json", ".claude", ".grok", ".cursor", ".codex"] as const

/** First path segments whose changes are never committed by the runner. Compared case-insensitively. */
const PROTECTED_ROOTS = new Set([".git", ".shipboard", ...UNSAFE_REPO_CONFIG])

export function isProtectedPath(file: string): boolean {
  const first = file.split("/")[0]?.toLowerCase() ?? ""
  return PROTECTED_ROOTS.has(first)
}

class JobStop extends Error {
  constructor(readonly outcome: JobOutcome) {
    super(outcome.summary)
  }
}

const STOPPED: JobOutcome = { reason: "agent_error", summary: "runner stopped" }

export async function runJob(job: ClaimedJob, deps: JobDeps, stopSignal: AbortSignal): Promise<JobReport> {
  const { config, log, board } = deps
  const started = Date.now()
  const say = (message: string, level: "info" | "warn" | "error" = "info"): void => log.job(job.attemptId, job.agent, message, level)

  await fs.mkdir(config.workDir, { recursive: true })
  // Real path: on macOS the temp dir is under the /var symlink, and Seatbelt profiles match real paths.
  const jobDir = await fs.realpath(await fs.mkdtemp(path.join(config.workDir, "shipboard-job-")))
  const repoDir = path.join(jobDir, "repo")
  const tmpDir = path.join(jobDir, "tmp")
  await fs.mkdir(tmpDir)

  // Aborted by runner shutdown or by losing the lease. Either way the agent is stopped.
  const jobAbort = new AbortController()
  let leaseLost = false
  const onStop = (): void => jobAbort.abort()
  stopSignal.addEventListener("abort", onStop, { once: true })
  if (stopSignal.aborted) jobAbort.abort()

  const heartbeat = setInterval(() => {
    board.heartbeat(job.attemptId, config.runnerId).catch((error: unknown) => {
      const status = error instanceof BoardHttpError ? error.status : 0
      if (status === 404 || status === 409 || status === 403 || status === 410) {
        leaseLost = true
        say(`lease lost (${(error as Error).message}); stopping the agent`, "warn")
        jobAbort.abort()
      } else {
        say(`heartbeat failed: ${(error as Error).message}`, "warn")
      }
    })
  }, config.heartbeatSec * 1_000)

  const gitCtx = (cwd: string): GitContext => ({
    cwd,
    hostEnv: deps.hostEnv,
    timeoutMs: config.gitTimeoutSec * 1_000,
    redactor: log.redactor,
    observe: deps.observe,
  })

  let outcome: JobOutcome
  try {
    outcome = await pipeline()
  } catch (error) {
    if (error instanceof JobStop) outcome = error.outcome
    else {
      const message = log.redactor.redact(error instanceof Error ? error.message : String(error))
      say(`failed: ${message}`, "error")
      outcome = { reason: "agent_error", summary: `The runner failed: ${message}` }
    }
  } finally {
    clearInterval(heartbeat)
    stopSignal.removeEventListener("abort", onStop)
  }
  outcome = { ...outcome, durationMs: outcome.durationMs ?? Date.now() - started }

  let reported = false
  if (leaseLost) {
    say(`not reporting ${outcome.reason}: this runner no longer holds the lease`, "warn")
  } else {
    reported = await finishWithRetry(outcome)
  }

  if (!config.keepJobDirs) await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {})
  return { outcome, reported, jobDir }

  async function finishWithRetry(result: JobOutcome): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await board.finish(job.attemptId, config.runnerId, result)
        say(`finished ${result.reason}${result.commitSha ? ` ${shortSha(result.commitSha)}` : ""}: ${result.summary}`)
        return true
      } catch (error) {
        const status = error instanceof BoardHttpError ? error.status : 0
        say(`finish failed (${(error as Error).message})${attempt < 3 && (status === 0 || status >= 500) ? ", retrying" : ""}`, "warn")
        if (status !== 0 && status < 500) return false
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
      }
    }
    return false
  }

  function stopIfAborted(): void {
    if (jobAbort.signal.aborted) throw new JobStop(STOPPED)
  }

  async function pipeline(): Promise<JobOutcome> {
    const agent = deps.agents.get(job.agent)
    if (!agent) {
      return { reason: "agent_error", summary: `This runner has no template for agent "${job.agent}".` }
    }
    stopIfAborted()

    // ---- clone with a read token
    const read = await board.credentials(job.attemptId, config.runnerId, "read")
    log.redactor.add(read.token)
    try {
      await clone(gitCtx(jobDir), read.remote || job.remote, repoDir, read.token)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const auth = /authentication failed|could not read username|returned error: 40[13]|HTTP 40[13]/i.test(message)
      return { reason: auth ? "auth" : "agent_error", summary: `Could not clone the fork: ${message}` }
    }
    const g = gitCtx(repoDir)
    const headBefore = await revParse(g, "HEAD")
    if (!headBefore) return { reason: "agent_error", summary: "The clone has no main branch." }
    say(`cloned ${shortSha(headBefore)}`)

    // ---- the brief at the brief commit must be the claimed brief, byte for byte
    const mismatch = await verifyBrief(g, job, headBefore)
    if (mismatch) {
      say(`brief mismatch: ${mismatch}`, "warn")
      return { reason: "brief_mismatch", summary: mismatch }
    }
    say(`brief ${job.brief.id} verified at ${shortSha(job.briefSha)}`)

    // ---- agent CLI config in the repo would be loaded by the agent
    const unsafe = await findUnsafeRepoConfig(repoDir)
    if (unsafe.length > 0) {
      if (config.unsafeRepoConfig === "refuse") {
        return {
          reason: "unsafe_repo_config",
          summary: `The fork contains agent configuration (${unsafe.join(", ")}); this runner refuses to run an agent on it.`,
        }
      }
      for (const entry of unsafe) await fs.rm(path.join(repoDir, entry), { recursive: true, force: true })
      say(`removed agent config before the run: ${unsafe.join(", ")}`, "warn")
    }

    const configPath = path.join(repoDir, ".git", "config")
    const pristineConfig = await fs.readFile(configPath)
    stopIfAborted()

    // ---- prompt and agent
    const prompt = await writePrompt(jobDir, job)
    const template = agent.template
    const vars: RenderVars = {
      prompt: prompt.text,
      prompt_file: prompt.file,
      cwd: repoDir,
      job_dir: jobDir,
      session_uuid: randomUUID(),
      max_turns: String(template.maxTurns ?? config.maxTurns),
      budget_usd: String(template.budgetUsd ?? config.budgetUsd),
    }
    const timeoutSec = timeoutFor(config, template)
    say(`agent started (${template.label}, timeout ${timeoutSec} s)`)
    const proc = await runProcess(
      {
        bin: agent.binPath,
        args: renderArgs(template.args, vars),
        cwd: repoDir,
        env: agentEnv(template, { tmpDir, hostEnv: deps.hostEnv }),
        stdin: template.stdin === null ? null : renderString(template.stdin, vars),
        timeoutMs: timeoutSec * 1_000,
        graceMs: config.killGraceSec * 1_000,
        signal: jobAbort.signal,
      },
      deps.observe,
    )
    await fs.writeFile(path.join(jobDir, "agent.stdout.log"), log.redactor.redact(proc.stdout)).catch(() => {})
    await fs.writeFile(path.join(jobDir, "agent.stderr.log"), log.redactor.redact(proc.stderr)).catch(() => {})

    if (proc.spawnError) return { reason: "agent_error", summary: `Could not start ${template.label}: ${proc.spawnError}` }
    if (proc.aborted && !proc.timedOut) throw new JobStop(STOPPED)

    let lastMessage: string | undefined
    if (template.summaryFile) {
      lastMessage = await fs.readFile(renderString(template.summaryFile, vars), "utf8").catch(() => undefined)
    }
    const agentOutcome = parseOutcome(template.parser, {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      lastMessage,
    })
    // A CLI that was handed {session_uuid} ran under that id even if its output does not echo it.
    if (agentOutcome.sessionId === undefined && template.args.some((a) => a.includes("{session_uuid}"))) {
      agentOutcome.sessionId = vars.session_uuid
    }
    const metrics = outcomeMetrics(agentOutcome)
    say(
      `agent exited ${proc.exitCode ?? proc.signal ?? "?"} after ${Math.round(proc.durationMs / 1_000)} s: ${agentOutcome.reason}` +
        (agentOutcome.costUsd !== undefined ? `, $${agentOutcome.costUsd.toFixed(4)}` : "") +
        (agentOutcome.turns !== undefined ? `, ${agentOutcome.turns} turns` : "") +
        (agentOutcome.denials ? `, ${agentOutcome.denials} denied tool calls` : ""),
      agentOutcome.ok ? "info" : "warn",
    )

    // ---- what did the agent actually change?
    const tree = await inspectTree(g, headBefore, configPath, pristineConfig, config.unsafeRepoConfig === "clean" ? unsafe : [])
    for (const note of tree.notes) say(note, "warn")
    const changedPaths = tree.changes.map((c) => c.path)
    const outOfScope = changedPaths.filter((p) => !inBriefPaths(p, job.brief.paths))
    say(
      changedPaths.length === 0
        ? "tree: no changes"
        : `tree: ${changedPaths.length} changed (${changedPaths.slice(0, 5).join(", ")}${changedPaths.length > 5 ? ", …" : ""})` +
            (outOfScope.length > 0 ? `; outside the brief: ${outOfScope.join(", ")}` : ""),
    )

    const partialOk = config.pushPartial && (agentOutcome.reason === "max_turns" || agentOutcome.reason === "budget")
    if (!agentOutcome.ok && !(partialOk && changedPaths.length > 0)) {
      const reason: JobOutcomeReason = agentOutcome.reason === "timeout" ? "timeout" : agentOutcome.reason === "auth" ? "auth" : "agent_error"
      const unpushed = changedPaths.length > 0 ? ` Nothing was pushed (${changedPaths.length} changed file${changedPaths.length === 1 ? "" : "s"} left unpushed).` : ""
      return { reason, summary: `${failureLead(agentOutcome, template.label, timeoutSec)}${unpushed}`, changedPaths, ...metrics }
    }
    if (changedPaths.length === 0) {
      return { reason: "no_changes", summary: `${template.label} finished without changing any files.`, ...metrics }
    }

    // ---- commit with trailers, push with a fresh write token. A shutdown from here on waits for the push.
    const said = lastParagraph(agentOutcome.summary, 600) || `${template.label} changed ${changedPaths.length} file(s).`
    const summary = agentOutcome.ok ? said : `Partial work: ${template.label} stopped at its ${agentOutcome.reason === "budget" ? "budget" : "turn"} limit. ${said}`
    const messageFile = path.join(jobDir, "commit-message.txt")
    await fs.writeFile(messageFile, commitMessage(job, summary, agentOutcome.sessionId))
    const agentSlug = job.agent.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
    const commitSha = await commit(g, messageFile, {
      name: `shipboard-${agentSlug}`,
      email: `shipboard-${agentSlug}@users.noreply.local`,
    })
    say(`committed ${shortSha(commitSha)}`)

    const write = await board.credentials(job.attemptId, config.runnerId, "write")
    log.redactor.add(write.token)
    const pushed = await push(g, write.remote || job.remote, write.token)
    if (!pushed.ok) {
      const reason: JobOutcomeReason = pushed.kind === "auth" ? "auth" : "push_rejected"
      const lead = pushed.kind === "rejected" ? "The fork's main moved while the agent worked; the push was rejected." : "The push failed."
      return { reason, summary: `${lead} ${pushed.detail}`.trim(), changedPaths, ...metrics }
    }
    say(`pushed ${shortSha(commitSha)} to main`)

    try {
      await board.pushed(job.attemptId, commitSha)
    } catch (error) {
      // finish(pushed) also triggers an assess, so this is only a faster path.
      say(`pushed signal failed: ${(error as Error).message}`, "warn")
    }
    return { reason: "pushed", summary, commitSha, changedPaths, ...metrics }
  }
}

function outcomeMetrics(outcome: AgentOutcome): Pick<JobOutcome, "costUsd" | "turns" | "sessionId"> {
  const out: Pick<JobOutcome, "costUsd" | "turns" | "sessionId"> = {}
  if (outcome.costUsd !== undefined) out.costUsd = outcome.costUsd
  if (outcome.turns !== undefined) out.turns = outcome.turns
  if (outcome.sessionId !== undefined) out.sessionId = outcome.sessionId
  return out
}

function failureLead(outcome: AgentOutcome, label: string, timeoutSec: number): string {
  const said = outcome.summary ? ` ${lastParagraph(outcome.summary, 400)}` : ""
  switch (outcome.reason) {
    case "timeout":
      return `${label} ran past the ${formatSeconds(timeoutSec)} job timeout and was stopped.`
    case "max_turns":
      return `${label} stopped at its turn limit.${said}`
    case "budget":
      return `${label} stopped at its budget limit.${said}`
    case "auth":
      return `${label} could not authenticate.${said}`
    case "no_output":
      return `${label} printed no result (exit ${outcome.exitCode ?? "none"}).`
    default:
      return outcome.summary ? lastParagraph(outcome.summary, 500) : `${label} failed.`
  }
}

function formatSeconds(seconds: number): string {
  return seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`
}

export function inBriefPaths(file: string, briefPaths: readonly string[]): boolean {
  return briefPaths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p))
}

export function commitMessage(job: ClaimedJob, summary: string, sessionId: string | undefined): string {
  const subject = job.brief.task.replace(/\s+/g, " ").trim() || "shipboard attempt"
  // Agent text cannot forge our trailers.
  const body = summary
    .split("\n")
    .filter((line) => !/^\s*shipboard-[\w-]+\s*:/i.test(line))
    .join("\n")
    .trim()
  const trailers = [`Shipboard-Attempt: ${job.attemptId}`, `Shipboard-Agent: ${job.agent}`]
  if (sessionId) trailers.push(`Shipboard-Session: ${sessionId.replace(/\s+/g, "")}`)
  return [subject, "", ...(body ? [body, ""] : []), ...trailers, ""].join("\n")
}

/** Returns a sentence describing the mismatch, or null when the brief commit is what the claim says. */
export async function verifyBrief(g: GitContext, job: ClaimedJob, head: string): Promise<string | null> {
  const expectedPath = briefPathFor(job.brief.id)
  if (job.briefPath !== expectedPath) return `The claim names brief file ${job.briefPath}, expected ${expectedPath}.`
  const briefSha = await revParse(g, job.briefSha)
  if (!briefSha) return `The brief commit ${shortSha(job.briefSha)} is not in the fork.`
  if (!(await isAncestor(g, briefSha, head))) return `The fork's main (${shortSha(head)}) does not contain the brief commit ${shortSha(briefSha)}.`
  const parent = await revParse(g, `${briefSha}^1`)
  if (parent !== job.baseSha) {
    return `The brief commit ${shortSha(briefSha)} sits on ${parent ? shortSha(parent) : "nothing"}, not on the base ${shortSha(job.baseSha)}.`
  }
  const committed = await readBlob(g, briefSha, expectedPath)
  if (committed === null) return `The brief commit ${shortSha(briefSha)} has no ${expectedPath}.`
  if (committed !== canonicalBriefJson(job.brief)) {
    return `The brief file committed at ${shortSha(briefSha)} does not match the claimed brief.`
  }
  return null
}

export async function findUnsafeRepoConfig(repoDir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of UNSAFE_REPO_CONFIG) {
    try {
      await fs.lstat(path.join(repoDir, entry))
      found.push(entry)
    } catch {
      // absent
    }
  }
  return found
}

type TreeState = { changes: { path: string; status: string }[]; notes: string[] }

/**
 * Undo agent commits (keeping their changes), restore .git/config if the agent touched it, stage
 * everything, then unstage protected paths and nested repos. What is left staged is what ships.
 */
export async function inspectTree(
  g: GitContext,
  headBefore: string,
  configPath: string,
  pristineConfig: Buffer,
  removedByRunner: readonly string[] = [],
): Promise<TreeState> {
  const notes: string[] = []

  const current = await fs.readFile(configPath).catch(() => null)
  if (current === null || !current.equals(pristineConfig)) {
    await fs.writeFile(configPath, pristineConfig)
    notes.push("the agent changed .git/config; restored the runner's copy")
  }

  // A merge or cherry-pick the agent left half done would turn our commit into a merge commit.
  const gitDir = path.dirname(configPath)
  const leftovers: string[] = []
  for (const name of ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
    const file = path.join(gitDir, name)
    if (await fs.lstat(file).then(() => true, () => false)) {
      await fs.rm(file, { recursive: true, force: true })
      leftovers.push(name)
    }
  }
  if (leftovers.length > 0) notes.push(`the agent left a git operation in progress; cleared ${leftovers.join(", ")}`)

  const headAfter = await revParse(g, "HEAD")
  if (headAfter !== headBefore) {
    try {
      await git(g, ["reset", "--soft", headBefore])
    } catch (error) {
      throw new GitError(`The agent moved HEAD and it could not be reset: ${(error as Error).message}`, "", null)
    }
    notes.push(`the agent committed (HEAD was ${headAfter ? shortSha(headAfter) : "unborn"}); reset --soft to ${shortSha(headBefore)}, keeping its changes`)
  }

  await git(g, ["add", "--all"])
  const staged = await stagedChanges(g)
  const drop = staged.filter((c) => isProtectedPath(c.path) || c.mode === "160000")
  if (drop.length > 0) {
    await unstage(g, drop.map((c) => c.path))
    // Deleting agent config before the run is the runner's own doing; only report what the agent did.
    const shown = drop.filter((c) => !(c.status === "D" && removedByRunner.some((r) => c.path === r || c.path.startsWith(`${r}/`)))).map((c) => c.path)
    if (shown.length > 0) notes.push(`left out of the commit: ${shown.slice(0, 8).join(", ")}${shown.length > 8 ? ", …" : ""}`)
  }
  const kept = drop.length > 0 ? await stagedChanges(g) : staged
  return { changes: kept.map((c) => ({ path: c.path, status: c.status })), notes }
}
