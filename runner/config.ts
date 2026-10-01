/**
 * Runner configuration: defaults, then `shipboard.runner.json` (from --config or the current
 * directory), then env (SHIPBOARD_URL, SHIPBOARD_RUNNER_TOKEN), then flags. Unknown keys are errors
 * so a typo cannot silently fall back to a default.
 */

import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_TEMPLATES,
  SCRIPT_TEMPLATE_DEFAULTS,
  TEMPLATE_KINDS,
  isForbiddenAgentEnv,
  unknownPlaceholders,
  type AgentTemplate,
  type TemplateKind,
} from "./agents.ts"
import { UsageError, allValues, lastValue, parseArgs } from "./args.ts"
import { PARSERS, type ParserName } from "./outcome.ts"

export type UnsafeRepoConfigPolicy = "clean" | "refuse"

export type RunnerConfig = {
  url: string
  /** Bearer token for the runner routes. Env only; never read from the config file. */
  token?: string
  runnerId: string
  /** Agent ids to offer. Empty means every configured agent whose binary resolves. */
  agents: string[]
  concurrency: number
  jobTimeoutSec: number
  /** Set by --job-timeout; beats per-agent timeoutSec. */
  jobTimeoutOverrideSec?: number
  pollSec: number
  idlePollMaxSec: number
  heartbeatSec: number
  /** Gap between SIGINT, SIGTERM and SIGKILL when stopping an agent. */
  killGraceSec: number
  gitTimeoutSec: number
  maxTurns: number
  budgetUsd: number
  /** Parent of the per-job temp dirs. */
  workDir: string
  keepJobDirs: boolean
  /** What to do when a clone contains .envrc, .mcp.json, .claude/, .grok/, .cursor/ or .codex/. */
  unsafeRepoConfig: UnsafeRepoConfigPolicy
  /** Push the agent's changes even when it stopped at max turns or budget. Default off. */
  pushPartial: boolean
  templates: Record<string, AgentTemplate>
  once: boolean
  dryRun: boolean
  help: boolean
  configPath?: string
}

export const RUNNER_FLAGS = {
  values: ["url", "agents", "concurrency", "config", "job-timeout"],
  booleans: ["once", "dry-run", "help"],
} as const

export function defaultConfig(): RunnerConfig {
  return {
    url: "http://127.0.0.1:8787",
    runnerId: `${os.hostname().split(".")[0] || "runner"}-${randomBytes(2).toString("hex")}`,
    agents: [],
    concurrency: 1,
    jobTimeoutSec: 1_200,
    pollSec: 3,
    idlePollMaxSec: 15,
    heartbeatSec: 60,
    killGraceSec: 15,
    gitTimeoutSec: 300,
    maxTurns: 40,
    budgetUsd: 2,
    workDir: os.tmpdir(),
    keepJobDirs: false,
    unsafeRepoConfig: "clean",
    pushPartial: false,
    templates: Object.fromEntries(Object.entries(DEFAULT_TEMPLATES).map(([id, t]) => [id, cloneTemplate(t)])),
    once: false,
    dryRun: false,
    help: false,
  }
}

function cloneTemplate(template: AgentTemplate): AgentTemplate {
  return {
    ...template,
    args: [...template.args],
    envPass: [...template.envPass],
    envSet: { ...template.envSet },
    versionArgs: [...template.versionArgs],
    authCheckArgs: template.authCheckArgs ? [...template.authCheckArgs] : undefined,
    notes: [...template.notes],
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function check(cond: boolean, where: string, what: string): void {
  if (!cond) throw new ConfigError(`${where} must be ${what}.`)
}

function stringList(value: unknown, where: string): string[] {
  check(Array.isArray(value) && value.every((v) => typeof v === "string"), where, "an array of strings")
  return value as string[]
}

function positiveNumber(value: unknown, where: string, integer = false): number {
  check(typeof value === "number" && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value)), where, integer ? "a positive integer" : "a positive number")
  return value as number
}

const TOP_KEYS = new Set([
  "$schema",
  "$comment",
  "url",
  "runnerId",
  "agents",
  "concurrency",
  "jobTimeoutSec",
  "pollSec",
  "idlePollMaxSec",
  "heartbeatSec",
  "killGraceSec",
  "gitTimeoutSec",
  "maxTurns",
  "budgetUsd",
  "workDir",
  "keepJobDirs",
  "unsafeRepoConfig",
  "pushPartial",
  "templates",
])

const TEMPLATE_KEYS = new Set([
  "$comment",
  "kind",
  "label",
  "bin",
  "args",
  "stdin",
  "envPass",
  "envSet",
  "parser",
  "timeoutSec",
  "maxTurns",
  "budgetUsd",
  "summaryFile",
  "allowBypass",
  "versionArgs",
  "authCheckArgs",
  "notes",
])

/** Apply a parsed config file over `config`. `baseDir` resolves relative paths in it. */
export function applyConfigFile(config: RunnerConfig, file: unknown, baseDir: string): RunnerConfig {
  check(isObject(file), "shipboard.runner.json", "a JSON object")
  const data = file as Json
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.has(key)) throw new ConfigError(`Unknown key "${key}" in shipboard.runner.json.`)
  }
  const next: RunnerConfig = { ...config, templates: { ...config.templates } }

  if (data.url !== undefined) {
    check(typeof data.url === "string", "url", "a string")
    next.url = data.url as string
  }
  if (data.runnerId !== undefined) {
    check(typeof data.runnerId === "string" && /^[\w.-]{1,64}$/.test(data.runnerId), "runnerId", "1-64 letters, digits, dots, dashes or underscores")
    next.runnerId = data.runnerId as string
  }
  if (data.agents !== undefined) next.agents = stringList(data.agents, "agents")
  if (data.concurrency !== undefined) next.concurrency = positiveNumber(data.concurrency, "concurrency", true)
  for (const key of ["jobTimeoutSec", "pollSec", "idlePollMaxSec", "heartbeatSec", "killGraceSec", "gitTimeoutSec", "budgetUsd"] as const) {
    if (data[key] !== undefined) next[key] = positiveNumber(data[key], key)
  }
  if (data.maxTurns !== undefined) next.maxTurns = positiveNumber(data.maxTurns, "maxTurns", true)
  if (data.workDir !== undefined) {
    check(typeof data.workDir === "string", "workDir", "a string")
    next.workDir = path.resolve(baseDir, data.workDir as string)
  }
  if (data.keepJobDirs !== undefined) {
    check(typeof data.keepJobDirs === "boolean", "keepJobDirs", "true or false")
    next.keepJobDirs = data.keepJobDirs as boolean
  }
  if (data.pushPartial !== undefined) {
    check(typeof data.pushPartial === "boolean", "pushPartial", "true or false")
    next.pushPartial = data.pushPartial as boolean
  }
  if (data.unsafeRepoConfig !== undefined) {
    check(data.unsafeRepoConfig === "clean" || data.unsafeRepoConfig === "refuse", "unsafeRepoConfig", '"clean" or "refuse"')
    next.unsafeRepoConfig = data.unsafeRepoConfig as UnsafeRepoConfigPolicy
  }
  if (data.templates !== undefined) {
    check(isObject(data.templates), "templates", "an object keyed by agent id")
    for (const [id, raw] of Object.entries(data.templates as Json)) {
      if (id.startsWith("$")) continue
      next.templates[id] = mergeTemplate(id, next.templates[id], raw, baseDir)
    }
  }
  return next
}

/** A config entry replaces the fields it names; everything else comes from the default for its kind. */
export function mergeTemplate(id: string, existing: AgentTemplate | undefined, raw: unknown, baseDir: string): AgentTemplate {
  const where = `templates.${id}`
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw new ConfigError(`${where}: agent ids are lowercase letters, digits, - and _.`)
  check(isObject(raw), where, "an object")
  const data = raw as Json
  for (const key of Object.keys(data)) {
    if (!TEMPLATE_KEYS.has(key)) throw new ConfigError(`Unknown key "${key}" in ${where}.`)
  }

  let kind: TemplateKind
  if (data.kind !== undefined) {
    check(typeof data.kind === "string" && (TEMPLATE_KINDS as readonly string[]).includes(data.kind), `${where}.kind`, TEMPLATE_KINDS.map((k) => `"${k}"`).join(", "))
    kind = data.kind as TemplateKind
  } else if (existing) {
    kind = existing.kind
  } else {
    throw new ConfigError(`${where}.kind is required for an agent without a built-in template (one of ${TEMPLATE_KINDS.join(", ")}).`)
  }

  let base: AgentTemplate
  if (existing && existing.kind === kind) base = cloneTemplate(existing)
  else if (kind === "script") {
    check(typeof data.bin === "string", `${where}.bin`, "a string (script agents have no default binary)")
    base = cloneTemplate({ ...SCRIPT_TEMPLATE_DEFAULTS, bin: "" })
  } else base = cloneTemplate(DEFAULT_TEMPLATES[kind])

  const t: AgentTemplate = { ...base, kind }
  if (data.label !== undefined) {
    check(typeof data.label === "string", `${where}.label`, "a string")
    t.label = data.label as string
  }
  if (data.bin !== undefined) {
    check(typeof data.bin === "string" && data.bin.length > 0, `${where}.bin`, "a non-empty string")
    const bin = data.bin as string
    // A path relative to the config file, so a checked-in config can point at a script beside it.
    t.bin = bin.startsWith("~/")
      ? path.join(os.homedir(), bin.slice(2))
      : bin.includes("/") && !path.isAbsolute(bin)
        ? path.resolve(baseDir, bin)
        : bin
  }
  if (data.args !== undefined) t.args = stringList(data.args, `${where}.args`)
  if (data.stdin !== undefined) {
    check(data.stdin === null || typeof data.stdin === "string", `${where}.stdin`, "a string or null")
    t.stdin = data.stdin as string | null
  }
  if (data.envPass !== undefined) t.envPass = stringList(data.envPass, `${where}.envPass`)
  if (data.envSet !== undefined) {
    check(isObject(data.envSet) && Object.values(data.envSet).every((v) => typeof v === "string"), `${where}.envSet`, "an object of strings")
    t.envSet = { ...(data.envSet as Record<string, string>) }
  }
  if (data.parser !== undefined) {
    check(typeof data.parser === "string" && (PARSERS as readonly string[]).includes(data.parser), `${where}.parser`, PARSERS.map((p) => `"${p}"`).join(", "))
    t.parser = data.parser as ParserName
  }
  if (data.timeoutSec !== undefined) t.timeoutSec = positiveNumber(data.timeoutSec, `${where}.timeoutSec`)
  if (data.maxTurns !== undefined) t.maxTurns = positiveNumber(data.maxTurns, `${where}.maxTurns`, true)
  if (data.budgetUsd !== undefined) t.budgetUsd = positiveNumber(data.budgetUsd, `${where}.budgetUsd`)
  if (data.summaryFile !== undefined) {
    check(typeof data.summaryFile === "string", `${where}.summaryFile`, "a string")
    t.summaryFile = data.summaryFile as string
  }
  if (data.allowBypass !== undefined) {
    check(typeof data.allowBypass === "boolean", `${where}.allowBypass`, "true or false")
    t.allowBypass = data.allowBypass as boolean
  }
  if (data.versionArgs !== undefined) t.versionArgs = stringList(data.versionArgs, `${where}.versionArgs`)
  if (data.authCheckArgs !== undefined) t.authCheckArgs = stringList(data.authCheckArgs, `${where}.authCheckArgs`)
  if (data.notes !== undefined) t.notes = stringList(data.notes, `${where}.notes`)

  validateTemplate(id, t)
  return t
}

export function validateTemplate(id: string, t: AgentTemplate): void {
  const where = `templates.${id}`
  const texts = [...t.args, t.stdin ?? "", t.summaryFile ?? ""]
  const unknown = [...new Set(texts.flatMap(unknownPlaceholders))]
  if (unknown.length > 0) {
    throw new ConfigError(`${where} uses unknown placeholder(s) ${unknown.map((u) => `{${u}}`).join(", ")}. Known: {prompt} {prompt_file} {cwd} {job_dir} {session_uuid} {max_turns} {budget_usd}.`)
  }
  const forbidden = [...t.envPass, ...Object.keys(t.envSet)].filter(isForbiddenAgentEnv)
  if (forbidden.length > 0) {
    throw new ConfigError(`${where} may not pass ${forbidden.join(", ")} to an agent; agents never see shipboard, git or Cloudflare credentials.`)
  }
  if (t.args.some((a) => a.includes("\0"))) throw new ConfigError(`${where}.args may not contain NUL bytes.`)
}

/** `90`, `90s`, `20m`, `1h` -> seconds. */
export function parseDuration(text: string, where: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim())
  if (!match) throw new UsageError(`${where} must be a number of seconds, or end in s, m or h (got "${text}").`)
  const value = Number(match[1])
  const unit = match[2] === "h" ? 3_600 : match[2] === "m" ? 60 : 1
  const seconds = value * unit
  if (!(seconds > 0)) throw new UsageError(`${where} must be more than zero.`)
  return seconds
}

export type LoadOptions = {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  readFile?: (file: string) => Promise<string>
}

export async function loadConfig(opts: LoadOptions): Promise<RunnerConfig> {
  const args = parseArgs(opts.argv, RUNNER_FLAGS)
  if (args.positionals.length > 0) throw new UsageError(`Unexpected argument "${args.positionals[0]}".`)
  const readFile = opts.readFile ?? ((file: string) => fs.readFile(file, "utf8"))

  let config = defaultConfig()
  const explicit = lastValue(args, "config")
  const configPath = path.resolve(opts.cwd, explicit ?? "shipboard.runner.json")
  let text: string | null = null
  try {
    text = await readFile(configPath)
  } catch (error) {
    if (explicit !== undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ConfigError(`Could not read ${configPath}: ${(error as Error).message}`)
    }
  }
  if (text !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new ConfigError(`${configPath} is not valid JSON: ${(error as Error).message}`)
    }
    config = applyConfigFile(config, parsed, path.dirname(configPath))
    config.configPath = configPath
  }

  if (opts.env.SHIPBOARD_URL) config.url = opts.env.SHIPBOARD_URL
  if (opts.env.SHIPBOARD_RUNNER_TOKEN) config.token = opts.env.SHIPBOARD_RUNNER_TOKEN

  const url = lastValue(args, "url")
  if (url !== undefined) config.url = url
  const agents = allValues(args, "agents")
  if (agents.length > 0) {
    config.agents = agents.flatMap((a) => a.split(",")).map((a) => a.trim()).filter(Boolean)
  }
  const concurrency = lastValue(args, "concurrency")
  if (concurrency !== undefined) {
    const n = Number(concurrency)
    if (!Number.isInteger(n) || n < 1) throw new UsageError("--concurrency must be a positive integer.")
    config.concurrency = n
  }
  const timeout = lastValue(args, "job-timeout")
  if (timeout !== undefined) config.jobTimeoutOverrideSec = parseDuration(timeout, "--job-timeout")
  config.once = args.booleans.has("once")
  config.dryRun = args.booleans.has("dry-run")
  config.help = args.booleans.has("help")

  try {
    const parsed = new URL(config.url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http")
    if (parsed.username || parsed.password) throw new ConfigError("The board URL must not contain credentials; use SHIPBOARD_RUNNER_TOKEN.")
  } catch (error) {
    if (error instanceof ConfigError) throw error
    throw new ConfigError(`The board URL "${config.url}" is not an http(s) URL.`)
  }
  config.url = config.url.replace(/\/+$/, "")
  if (config.idlePollMaxSec < config.pollSec) config.idlePollMaxSec = config.pollSec
  return config
}

/** Effective wall-clock limit for one agent, in seconds. */
export function timeoutFor(config: RunnerConfig, template: AgentTemplate): number {
  return config.jobTimeoutOverrideSec ?? template.timeoutSec ?? config.jobTimeoutSec
}

export const RUNNER_USAGE = `shipboard runner: claims jobs from a board and runs a local coding agent on each.

  npm run runner -- [--url <board>] [--agents codex,claude] [--concurrency 2] [--config <file>]
                    [--job-timeout 20m] [--once] [--dry-run]

  --url          Board URL (default http://127.0.0.1:8787, or SHIPBOARD_URL).
  --agents       Agent ids to offer, comma separated or repeated (default: every agent whose binary is found).
  --concurrency  Jobs at once (default 1).
  --config       Config file (default ./shipboard.runner.json if it exists). See shipboard.runner.example.json.
  --job-timeout  Wall-clock limit per agent run: seconds, or 90s / 20m / 1h (default 1200 s).
  --once         Process one job, then exit (exit code 0 only if it pushed).
  --dry-run      Claim nothing. Print the resolved agent templates and check each binary.

  SHIPBOARD_RUNNER_TOKEN is the runner's Bearer token (the board token also works).
`
