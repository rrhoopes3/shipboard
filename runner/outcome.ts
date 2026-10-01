/**
 * Turn each CLI's output into one normalized AgentOutcome. This is only a first filter (did the
 * agent finish, run out of turns, fail to log in). Whether the work is any good is decided from the
 * git tree afterwards and by the board's digest.
 *
 * Shapes follow research/agents.md 7.4 with the fact-check corrections applied:
 * - Claude error subtypes carry `errors: string[]` and no `result`.
 * - Grok 1.0.44 emits snake_case `stopReason` ("end_turn"); `max_turn_requests` is the turn cap,
 *   `max_tokens` is not.
 * - Cursor prints no JSON at all on failure, only stderr.
 */

import { tail } from "./proc.ts"

export type ParserName = "claude-json" | "codex-jsonl" | "grok-json" | "cursor-json" | "plain"

export const PARSERS: readonly ParserName[] = ["claude-json", "codex-jsonl", "grok-json", "cursor-json", "plain"]

export type AgentOutcomeReason = "end_turn" | "max_turns" | "budget" | "agent_error" | "timeout" | "auth" | "no_output"

export type AgentOutcome = {
  ok: boolean
  reason: AgentOutcomeReason
  /** The agent's own last words, or why it failed. */
  summary: string
  sessionId?: string
  costUsd?: number
  turns?: number
  /** Tool calls the CLI refused (Claude permission_denials, Codex declined commands). */
  denials?: number
  exitCode: number | null
  stderrTail: string
}

export type ParseInput = {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** Contents of the template's `summaryFile` (Codex `-o`), when it exists. */
  lastMessage?: string
}

const AUTH_PATTERN =
  /not logged in|unauthori[sz]ed|authentication (failed|required|error)|invalid api key|invalid x-api-key|api key (is )?(missing|invalid)|please run \/?login|run `?\w+ login|oauth token (has )?expired|token expired|\b401\b/i

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** The whole stdout as one JSON object, or else the last line that is one. */
function lastJsonObject(stdout: string, accept: (value: JsonObject) => boolean = () => true): JsonObject | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    const whole: unknown = JSON.parse(trimmed)
    if (isObject(whole) && accept(whole)) return whole
  } catch {
    // Fall through to line scanning: some CLIs print warnings before the JSON.
  }
  const lines = trimmed.split("\n")
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim()
    if (!line || !line.startsWith("{")) continue
    try {
      const value: unknown = JSON.parse(line)
      if (isObject(value) && accept(value)) return value
    } catch {
      // not JSON
    }
  }
  return null
}

function looksLikeAuth(...texts: (string | undefined)[]): boolean {
  return texts.some((text) => text !== undefined && AUTH_PATTERN.test(text))
}

function base(input: ParseInput): Pick<AgentOutcome, "exitCode" | "stderrTail"> {
  return { exitCode: input.exitCode, stderrTail: tail(input.stderr.trim(), 2_000) }
}

/** A failure with no structured output: timeout, auth, or a generic agent error from stderr. */
function unstructured(input: ParseInput, agentName: string): AgentOutcome {
  const stderrTail = tail(input.stderr.trim(), 2_000)
  if (input.timedOut) {
    return { ...base(input), ok: false, reason: "timeout", summary: `${agentName} ran past the job timeout and was stopped.` }
  }
  if (input.exitCode === 0) {
    return { ...base(input), ok: false, reason: "no_output", summary: `${agentName} exited 0 but printed no result.` }
  }
  const lastLine = stderrTail.split("\n").filter(Boolean).pop() ?? ""
  if (looksLikeAuth(stderrTail, input.stdout)) {
    return { ...base(input), ok: false, reason: "auth", summary: `${agentName} is not logged in: ${lastLine || "authentication failed"}` }
  }
  const detail = lastLine ? `: ${lastLine}` : "."
  return {
    ...base(input),
    ok: false,
    reason: "agent_error",
    summary: `${agentName} exited with code ${input.exitCode ?? "none"}${detail}`,
  }
}

export function parseClaudeJson(input: ParseInput): AgentOutcome {
  const json = lastJsonObject(input.stdout, (value) => value.type === "result")
  if (!json) return unstructured(input, "Claude")

  const subtype = str(json.subtype) ?? "unknown"
  const errors = Array.isArray(json.errors) ? json.errors.filter((e): e is string => typeof e === "string") : []
  const result = str(json.result)
  const denials = Array.isArray(json.permission_denials) ? json.permission_denials.length : undefined
  const terminal = str(json.terminal_reason)
  const common = {
    ...base(input),
    sessionId: str(json.session_id),
    costUsd: num(json.total_cost_usd),
    turns: num(json.num_turns),
    denials,
  }
  const summary = result ?? (errors.length > 0 ? errors.join("; ") : `Claude finished with ${subtype}.`)

  if (input.timedOut) return { ...common, ok: false, reason: "timeout", summary }
  if (subtype === "success" && json.is_error === false && input.exitCode === 0) {
    return { ...common, ok: true, reason: "end_turn", summary }
  }
  if (subtype === "error_max_turns" || terminal === "max_turns") return { ...common, ok: false, reason: "max_turns", summary }
  if (subtype === "error_max_budget_usd" || terminal === "budget_exhausted") {
    return { ...common, ok: false, reason: "budget", summary }
  }
  // Claude reports a failed login as the result text of an is_error "success".
  if (looksLikeAuth(result, ...errors, str(json.startup_failure_reason))) {
    return { ...common, ok: false, reason: "auth", summary }
  }
  return { ...common, ok: false, reason: "agent_error", summary }
}

export function parseCodexJsonl(input: ParseInput): AgentOutcome {
  let sessionId: string | undefined
  let turnsCompleted = 0
  let turnFailed: string | undefined
  let errorSeen: string | undefined
  let lastAgentMessage: string | undefined
  let denials = 0

  for (const raw of input.stdout.split("\n")) {
    const line = raw.trim()
    if (!line.startsWith("{")) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      // The tail buffer can cut the first line in half.
      continue
    }
    if (!isObject(event)) continue
    switch (event.type) {
      case "thread.started":
        sessionId = str(event.thread_id) ?? sessionId
        break
      case "turn.completed":
        turnsCompleted += 1
        break
      case "turn.failed": {
        const error = isObject(event.error) ? str(event.error.message) : undefined
        turnFailed = error ?? "turn failed"
        break
      }
      case "error":
        errorSeen = str(event.message) ?? "error"
        break
      case "item.completed": {
        const item = event.item
        if (!isObject(item)) break
        if (item.type === "agent_message") lastAgentMessage = str(item.text) ?? lastAgentMessage
        if (item.type === "command_execution" && item.status === "declined") denials += 1
        break
      }
      default:
        break
    }
  }

  const sawAny = sessionId !== undefined || turnsCompleted > 0 || turnFailed !== undefined || errorSeen !== undefined
  if (!sawAny && !input.lastMessage) return unstructured(input, "Codex")

  const finalText = input.lastMessage?.trim() || lastAgentMessage
  const failure = turnFailed ?? errorSeen
  const common = {
    ...base(input),
    sessionId,
    turns: turnsCompleted > 0 ? turnsCompleted : undefined,
    denials,
  }
  if (input.timedOut) {
    return { ...common, ok: false, reason: "timeout", summary: finalText ?? "Codex ran past the job timeout and was stopped." }
  }
  const ok = input.exitCode === 0 && turnsCompleted > 0 && !turnFailed && !errorSeen
  if (ok) return { ...common, ok: true, reason: "end_turn", summary: finalText ?? "Codex finished." }
  if (looksLikeAuth(failure, input.stderr)) {
    return { ...common, ok: false, reason: "auth", summary: failure ?? "Codex is not logged in." }
  }
  const summary = failure ?? finalText ?? `Codex exited with code ${input.exitCode ?? "none"} without completing a turn.`
  return { ...common, ok: false, reason: "agent_error", summary }
}

export function parseGrokJson(input: ParseInput): AgentOutcome {
  const json = lastJsonObject(input.stdout, (value) => "stopReason" in value || "text" in value)
  if (!json) return unstructured(input, "Grok")

  const stopReason = str(json.stopReason) ?? "unknown"
  const text = str(json.text)?.trim()
  const common = {
    ...base(input),
    sessionId: str(json.sessionId),
    costUsd: num(json.total_cost_usd),
    turns: num(json.num_turns),
  }
  const summary = text || `Grok stopped with ${stopReason}.`

  if (input.timedOut) return { ...common, ok: false, reason: "timeout", summary }
  if (input.exitCode === 0 && stopReason === "end_turn") return { ...common, ok: true, reason: "end_turn", summary }
  if (stopReason === "max_turn_requests") return { ...common, ok: false, reason: "max_turns", summary }
  if (input.exitCode !== 0 && looksLikeAuth(input.stderr, text)) return { ...common, ok: false, reason: "auth", summary }
  const why =
    stopReason === "max_tokens"
      ? "Grok hit its output token limit."
      : stopReason === "refusal"
        ? "Grok refused the task."
        : stopReason === "cancelled"
          ? "Grok was cancelled."
          : `Grok stopped with ${stopReason} (exit ${input.exitCode ?? "none"}).`
  return { ...common, ok: false, reason: "agent_error", summary: text ? `${why} ${text}` : why }
}

export function parseCursorJson(input: ParseInput): AgentOutcome {
  if (input.exitCode !== 0 || input.timedOut) return unstructured(input, "Cursor")
  const json = lastJsonObject(input.stdout, (value) => value.type === "result")
  if (!json) return unstructured(input, "Cursor")
  const result = str(json.result)?.trim()
  const common = { ...base(input), sessionId: str(json.session_id) }
  if (json.is_error === false) return { ...common, ok: true, reason: "end_turn", summary: result || "Cursor finished." }
  if (looksLikeAuth(result)) return { ...common, ok: false, reason: "auth", summary: result ?? "Cursor is not logged in." }
  return { ...common, ok: false, reason: "agent_error", summary: result || "Cursor reported an error." }
}

export function parsePlain(input: ParseInput): AgentOutcome {
  if (input.timedOut || input.exitCode !== 0) return unstructured(input, "The agent")
  const text = input.stdout.trim()
  return {
    ...base(input),
    ok: true,
    reason: "end_turn",
    summary: text ? lastParagraph(text) : "The agent exited 0.",
  }
}

export function parseOutcome(parser: ParserName, input: ParseInput): AgentOutcome {
  switch (parser) {
    case "claude-json":
      return parseClaudeJson(input)
    case "codex-jsonl":
      return parseCodexJsonl(input)
    case "grok-json":
      return parseGrokJson(input)
    case "cursor-json":
      return parseCursorJson(input)
    case "plain":
      return parsePlain(input)
  }
}

/** The last non-empty paragraph, capped. Agents are asked to end with a one-paragraph summary. */
export function lastParagraph(text: string, max = 600): string {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const last = (paragraphs[paragraphs.length - 1] ?? "").replace(/\s+/g, " ")
  return last.length > max ? `${last.slice(0, max - 1)}…` : last
}
