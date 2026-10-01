// shipboard for Claude Code: an interactive session joins the board as the `claude-code` agent.
//
// - /shipboard claim | dispatch | status | done | pane, and the mcp__shipboard__push tool
// - a tool.call tripwire that refuses git push and remote/credential rewiring during a job
// - the brief as prompt context, and a pane with this fork's verdict
//
// This is the only file that touches the mods API. Claude Code reads hooks and API calls off the
// source, so every call is spelled out in full here, and other files get plain functions through
// ioOf() (https://code.claude.com/docs/en/plugins/mods/create.md, "Check what Claude Code reads
// from your mod"). Imports are extensionless, as in Claude Code's own built-in mods.

import { messageOf } from "./api"
import { ARGUMENT_HINT, parseArgs, usage } from "./command"
import { configOf, type EnvValues } from "./config"
import { AGENT_ID } from "./contract"
import type { Api, On, PluginOptions } from "./mods"
import { PANE_ID, PANE_TITLE, renderPane } from "./pane"
import { isSaved, Shipboard, type Io } from "./session"

// Shared by every hook below. A reload of the mod starts a new one and restores the job from $.store.
let board: Shipboard | null = null
let storeKey = "job:unknown"

const PUSH_DESCRIPTION =
  "Push your work on the active shipboard job. Commits the job's working copy as one commit (with Shipboard-Attempt and Shipboard-Agent trailers), " +
  "pushes it to that job's fork only, and returns the board's verdict: merge state against main, acceptance checks, review, preview URL and the board's next action. " +
  "git push is blocked during a shipboard job; this tool is the way to push. Call it again after fixing something: each call pushes the whole working copy."

const GUARD_FAILED =
  "The shipboard push guard failed on this command, so it was not run. Try a simpler command, or call mcp__shipboard__push to push."

export function register(on: On, options: PluginOptions): void {
  on("session.start", async ($, e, next) => {
    const result = await next(e)
    const env = await readEnv($)
    const sessionId = await $.session.id()
    const host = await hostName($)
    const sb = new Shipboard(configOf(options, env), { runnerId: runnerIdFor(host, sessionId), sessionId, home: env.home })
    board = sb
    storeKey = `job:${sessionId}`
    // Commands and tools are registered at session.start: https://code.claude.com/docs/en/plugins/mods/api.md#add-a-command-or-a-tool
    try {
      await $.command.register({ name: "shipboard", description: "Join the shipboard board: claim, dispatch, status, done", argumentHint: ARGUMENT_HINT })
    } catch (error) {
      $.ui.log(`/shipboard was not registered: ${messageOf(error)}`)
    }
    try {
      await $.tool.register({
        name: "push",
        description: PUSH_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "One line saying what changed. Used as the commit subject." } },
          required: ["message"],
        },
      })
    } catch (error) {
      $.ui.log(`mcp__shipboard__push was not registered: ${messageOf(error)}`)
    }
    const saved = await $.store.get(storeKey)
    if (isSaved(saved)) {
      await sb.restore(ioOf($), saved)
    } else if (sb.config.autoclaim && e.isInteractive) {
      // Not awaited: Claude Code holds the first prompt until session.start hooks return.
      $.clock.after(1, () => void autoclaim($, sb))
    }
    return result
  })

  on("session.end", async ($, e, next) => {
    if (board) await board.end(ioOf($), e.reason).catch(() => undefined)
    return next(e)
  })

  on("session.compact", async ($, e, next) => {
    const result = await next(e)
    board?.resendBrief()
    return result
  })

  on("command.run", { command: "shipboard" }, async ($, e) => {
    const sb = board
    if (!sb) return { text: "shipboard is still starting. Try again in a moment." }
    const parsed = parseArgs(e.args)
    switch (parsed.verb) {
      case "claim": {
        const text = await sb.claim(ioOf($))
        if (parsed.start) kickoff($, sb)
        return { text }
      }
      case "dispatch": {
        const text = await sb.dispatch(ioOf($), parsed.dispatch)
        if (parsed.start) kickoff($, sb)
        return { text }
      }
      case "status":
        return { text: sb.status() }
      case "done":
        return { text: await sb.done(ioOf($)) }
      case "pane":
        await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true, closeOnEscape: true })
        return {}
      case "error":
        return { text: usage(parsed.message) }
      default:
        return { text: usage() }
    }
  })

  on("tool.call", { tool: "mcp__shipboard__push" }, async ($, e) => {
    const sb = board
    if (!sb) return { result: "shipboard is still starting. Try again in a moment." }
    const message = typeof e.message === "string" ? e.message : undefined
    return { result: await sb.push(ioOf($), { message }) }
  })

  // The tripwire: a deny is the result Claude reads, so it says what to do instead.
  // https://code.claude.com/docs/en/plugins/mods/events.md#guard-or-change-a-tool-call
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const sb = board
    if (!sb?.job) return next(e)
    const deny = sb.guardCommand(typeof e.command === "string" ? e.command : "", await $.session.cwd())
    return deny ? { deny } : next(e)
  }).catch(async () => (board?.job ? { deny: GUARD_FAILED } : undefined))

  on("tool.call", { tool: ["Edit", "Write", "MultiEdit", "NotebookEdit"] }, async ($, e, next) => {
    const sb = board
    if (!sb?.job) return next(e)
    const path = typeof e.file_path === "string" ? e.file_path : typeof e.notebook_path === "string" ? e.notebook_path : null
    const deny = path === null ? null : sb.guardFile(path, await $.session.cwd())
    return deny ? { deny } : next(e)
  }).catch(async () => (board?.job ? { deny: GUARD_FAILED } : undefined))

  // https://code.claude.com/docs/en/plugins/mods/events.md#rewrite-or-add-to-a-prompt
  on("prompt.submit", async ($, e, next) => {
    const text = board?.contextFor()
    return text ? next({ ...e, context: [...(e.context ?? []), text] }) : next(e)
  })

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const model = board?.pane() ?? { job: null, brief: null, verdict: null, pushedSha: null, note: "shipboard is starting.", ended: null }
    return renderPane($.ui.resolve(e), model)
  })
}

/** Plain functions over the mods API, for the modules that may not see `$`. */
function ioOf($: Api): Io {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    run: (argv, init) => $.process.run(argv, init),
    cwd: () => $.session.cwd(),
    list: (path) => $.fs.list(path),
    exists: (path) => $.fs.exists(path),
    now: () => $.clock.now(),
    every: (ms, fn) => $.clock.every(ms, fn),
    redraw: () => $.ui.invalidate("ui.render"),
    toast: (text) => $.ui.toast(text),
    status: (text) => $.ui.status(text),
    openPane: async () => {
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    },
    save: async (saved) => {
      if (saved === null) await $.store.delete(storeKey)
      else await $.store.set(storeKey, saved)
    },
  }
}

/**
 * SHIPBOARD_* settings for `claude --plugin-dir` sessions. Bash children inherit this process's
 * environment, so tokens read from it are removed from it: otherwise Claude could echo them.
 * Best effort only; the process's initial environment stays visible to ps. The userConfig options
 * (kept in the OS keychain when marked sensitive) are the better home for tokens.
 */
async function readEnv($: Api): Promise<EnvValues & { home?: string }> {
  const env = {
    url: await $.env.get("SHIPBOARD_URL"),
    runnerToken: await $.env.get("SHIPBOARD_RUNNER_TOKEN"),
    boardToken: await $.env.get("SHIPBOARD_TOKEN"),
    project: await $.env.get("SHIPBOARD_PROJECT"),
    autoclaim: await $.env.get("SHIPBOARD_AUTOCLAIM"),
    home: await $.env.get("HOME"),
  }
  if (env.runnerToken !== undefined) await $.env.set("SHIPBOARD_RUNNER_TOKEN", undefined)
  if (env.boardToken !== undefined) await $.env.set("SHIPBOARD_TOKEN", undefined)
  return env
}

async function hostName($: Api): Promise<string> {
  try {
    const res = await $.process.run(["hostname"], { timeoutMs: 5000 })
    return res.stdout.trim() || "localhost"
  } catch {
    return "localhost"
  }
}

/** The API accepts 80 characters from [A-Za-z0-9._:@-], with a letter/digit first. */
export function runnerIdFor(host: string, sessionId: string): string {
  const label = (value: string, max: number) => value.replace(/[^A-Za-z0-9._:@-]+/g, "-").slice(0, max) || "unknown"
  // Keep the full identity in the fingerprint even when the readable labels are shortened.
  // FNV-1a needs no host crypto API and this ID is a lease label, not an authentication token.
  const identity = JSON.stringify([host, sessionId])
  const hash = (seed: bigint) => {
    let value = seed
    for (let i = 0; i < identity.length; i++) value = BigInt.asUintN(64, (value ^ BigInt(identity.charCodeAt(i))) * 0x100000001b3n)
    return value.toString(16).padStart(16, "0")
  }
  return `claude-code-mod:${label(host, 16)}:${label(sessionId, 10)}:${hash(0xcbf29ce484222325n)}${hash(0x84222325cbf29ce4n)}`
}

async function autoclaim($: Api, sb: Shipboard): Promise<void> {
  const text = await sb.claim(ioOf($))
  $.ui.log(text)
  if (sb.job) $.ui.toast(`shipboard: claimed ${sb.job.attemptId}. Send a prompt to start.`)
}

/** Starts Claude on the job it just claimed. Not awaited: submit resolves only once the turn starts. */
function kickoff($: Api, sb: Shipboard): void {
  const job = sb.job
  if (!job) return
  void $.prompt.submit({
    text: `Start shipboard job ${job.attemptId} (agent ${AGENT_ID}). Its brief is attached to this message. Work in ${sb.dir}, and call mcp__shipboard__push when the acceptance check should pass.`,
  })
}
