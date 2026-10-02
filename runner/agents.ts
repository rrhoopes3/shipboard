/**
 * Agent command templates. A template is an argv array (never a shell string) with placeholders
 * replaced per element in a single pass, so a brief containing "{cwd}" stays literal.
 *
 * Default headless invocations from research/agents.md section 6, as corrected:
 * - Claude uses acceptEdits but permits repo-controlled npm/node commands without verified OS
 *   isolation, so every Claude template requires allowBypass on an isolated runner. Codex uses
 *   the workspace-write sandbox. Grok 1.0.44 cancelled headless
 *   editing under acceptEdits (seen live on 2026-10-01). Its working template has
 *   `--always-approve`, but is refused by default: Grok's sandbox can fail open, so an isolated
 *   runner must explicitly set allowBypass. Grok is not given `--trust`, so a fresh clone's
 *   project config stays untrusted.
 * - Cursor has no narrower headless edit mode than `--force` (documented alias: `--yolo`). Its
 *   default template therefore carries a bypass flag and is refused unless `allowBypass` is set.
 * - git commit/push and edits to .git/.shipboard are denied where the CLI has deny rules. The runner
 *   checks the tree afterwards anyway (agents that commit get `reset --soft`).
 */

import { constants as fsConstants } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ParserName } from "./outcome.ts"
import { runProcess, type SpawnObserver } from "./proc.ts"

export type TemplateKind = "claude" | "codex" | "grok" | "cursor" | "script"

export const TEMPLATE_KINDS: readonly TemplateKind[] = ["claude", "codex", "grok", "cursor", "script"]

export type AgentTemplate = {
  kind: TemplateKind
  label: string
  /** Absolute path, or a bare name resolved on PATH when the runner starts. */
  bin: string
  args: string[]
  /** Rendered and written to stdin (Codex reads the prompt from `-`). Null means /dev/null. */
  stdin: string | null
  /** Host env vars passed through to the agent when set (credentials for that CLI only). */
  envPass: string[]
  /** Extra env vars set for the agent. */
  envSet: Record<string, string>
  parser: ParserName
  /** Per-agent wall-clock limit. Falls back to the runner's jobTimeoutSec. */
  timeoutSec?: number
  maxTurns?: number
  budgetUsd?: number
  /** File the agent writes its final message to (rendered), read after it exits. */
  summaryFile?: string
  /** Opt into Claude execution or bypass/yolo flags. Requires an already isolated VM/container. */
  allowBypass: boolean
  /** Args for a version probe in --dry-run. Empty skips it. */
  versionArgs: string[]
  /** Args for a login probe in --dry-run, when the CLI has one. */
  authCheckArgs?: string[]
  /** Printed by --dry-run. */
  notes: string[]
}

export const PLACEHOLDERS = ["prompt", "prompt_file", "cwd", "job_dir", "session_uuid", "max_turns", "budget_usd"] as const

export type Placeholder = (typeof PLACEHOLDERS)[number]

export type RenderVars = Record<Placeholder, string>

const PLACEHOLDER_RE = /\{(prompt|prompt_file|cwd|job_dir|session_uuid|max_turns|budget_usd)\}/g
const ANY_PLACEHOLDER_RE = /\{([a-z][a-z_]*)\}/g

export const GROK_DEFAULT_BIN = "grok"

export const DEFAULT_TEMPLATES: Record<Exclude<TemplateKind, "script">, AgentTemplate> = {
  claude: {
    kind: "claude",
    label: "Claude Code",
    bin: "claude",
    args: [
      "-p",
      "{prompt}",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      // Glob and Grep are left out: on macOS/Linux they are not in the default tool set, so allowing them does nothing.
      "--allowedTools",
      "Read,Edit,Write,Bash(npm test *),Bash(npm run *),Bash(node *)",
      "--disallowedTools",
      "WebFetch,WebSearch,Bash(git commit *),Bash(git push *),Bash(git config *),Edit(.git/**),Edit(.shipboard/**)",
      // Without these, -p runs project hooks and connects project MCP servers even in an untrusted folder.
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--settings",
      '{"disableAllHooks":true}',
      "--session-id",
      "{session_uuid}",
      "--max-turns",
      "{max_turns}",
      "--max-budget-usd",
      "{budget_usd}",
    ],
    stdin: null,
    envPass: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    envSet: {},
    parser: "claude-json",
    allowBypass: false,
    versionArgs: ["--version"],
    authCheckArgs: ["auth", "status"],
    notes: [
      "Requires allowBypass on an isolated VM or container: acceptEdits and tool permissions do not isolate npm/node scripts from host files or credentials.",
      "Auth: CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY. Do not add --bare with a subscription token: bare mode ignores it.",
    ],
  },
  codex: {
    kind: "codex",
    label: "Codex",
    bin: "codex",
    args: ["exec", "--sandbox", "workspace-write", "--json", "-o", "{job_dir}/last-message.txt", "-C", "{cwd}", "--ignore-rules", "-"],
    stdin: "{prompt}",
    envPass: ["CODEX_API_KEY", "CODEX_HOME"],
    envSet: {},
    parser: "codex-jsonl",
    summaryFile: "{job_dir}/last-message.txt",
    allowBypass: false,
    versionArgs: ["--version"],
    authCheckArgs: ["login", "status"],
    notes: [
      "The workspace-write sandbox keeps .git read-only and turns network off. Add -c sandbox_workspace_write.network_access=true only for briefs that need it.",
      "`codex login status` checks stored login only; it reports \"Not logged in\" when auth comes from CODEX_API_KEY even though exec works.",
    ],
  },
  grok: {
    kind: "grok",
    label: "Grok",
    bin: GROK_DEFAULT_BIN,
    args: [
      "--prompt-file",
      "{prompt_file}",
      "--cwd",
      "{cwd}",
      "--output-format",
      "json",
      "--always-approve",
      "--sandbox",
      "workspace",
      "--disable-web-search",
      "--no-subagents",
      "--max-turns",
      "{max_turns}",
      "-s",
      "{session_uuid}",
      "--allow",
      "Bash(npm test*)",
      "--allow",
      "Bash(npm run *)",
      "--allow",
      "Bash(node *)",
      "--deny",
      "Bash(git commit*)",
      "--deny",
      "Bash(git push*)",
      "--deny",
      "Bash(git config*)",
      "--deny",
      "Bash(sudo*)",
      "--deny",
      "Edit(**/.git/**)",
      "--deny",
      "Write(**/.git/**)",
      "--deny",
      "Edit(**/.shipboard/**)",
      "--deny",
      "Write(**/.shipboard/**)",
    ],
    stdin: null,
    envPass: ["XAI_API_KEY", "GROK_HOME"],
    envSet: { RUST_LOG: "error" },
    parser: "grok-json",
    allowBypass: false,
    versionArgs: ["--version"],
    notes: [
      "Grok OAuth logins expire after 7 days; an unattended runner needs `grok login` again or XAI_API_KEY (a stored login outranks the key).",
      "Headless editing currently needs --always-approve. The runner refuses this template until allowBypass is set inside an isolated VM or container; --deny rules still apply but are not a sandbox.",
      "--sandbox workspace is a best-effort Seatbelt profile; Grok can continue unsandboxed if it cannot apply it.",
    ],
  },
  cursor: {
    kind: "cursor",
    label: "Cursor",
    // Grok also installs an `agent` command; resolve the real executable before offering Cursor.
    bin: "agent",
    args: ["-p", "--output-format", "json", "--workspace", "{cwd}", "--trust", "--force", "--sandbox", "enabled", "{prompt}"],
    stdin: null,
    envPass: ["CURSOR_API_KEY"],
    envSet: {},
    parser: "cursor-json",
    allowBypass: false,
    versionArgs: ["--version"],
    authCheckArgs: ["status"],
    notes: [
      "Cursor only applies edits with --force, which its docs define as the same flag as --yolo. The runner refuses it unless templates.cursor.allowBypass is true.",
      "If you allow it, keep --sandbox enabled and put permissions.deny rules (Shell(git), Write(.git/**)) in ~/.cursor/cli-config.json.",
    ],
  },
}

/** Defaults for a `script` agent: any program run as `<bin> {prompt_file} {cwd}`, judged on its exit code. */
export const SCRIPT_TEMPLATE_DEFAULTS: Omit<AgentTemplate, "bin"> = {
  kind: "script",
  label: "Script",
  args: ["{prompt_file}", "{cwd}"],
  stdin: null,
  envPass: [],
  envSet: {},
  parser: "plain",
  allowBypass: false,
  versionArgs: [],
  notes: [],
}

/** Flags that turn off a CLI's approvals or sandbox. Matching is per argv element (`--flag=value` included). */
const BYPASS_FLAGS: Record<TemplateKind, { flags: string[]; values: Record<string, string[]> }> = {
  claude: {
    flags: ["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
    values: { "--permission-mode": ["bypassPermissions"] },
  },
  codex: {
    flags: ["--dangerously-bypass-approvals-and-sandbox", "--yolo"],
    values: { "--sandbox": ["danger-full-access"], "-s": ["danger-full-access"] },
  },
  grok: {
    flags: ["--always-approve", "--yolo"],
    values: { "--permission-mode": ["bypassPermissions"] },
  },
  cursor: {
    flags: ["--force", "-f", "--yolo", "--approve-mcps"],
    values: { "--sandbox": ["disabled"] },
  },
  script: { flags: [], values: {} },
}

export function bypassFlagsIn(template: Pick<AgentTemplate, "kind" | "args">): string[] {
  const rules = BYPASS_FLAGS[template.kind]
  const found: string[] = []
  template.args.forEach((arg, i) => {
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined]
    if (rules.flags.includes(name)) found.push(name)
    const bad = rules.values[name]
    const value = inline ?? template.args[i + 1]
    if (bad && value !== undefined && bad.includes(value)) found.push(`${name} ${value}`)
  })
  return found
}

export function renderString(text: string, vars: RenderVars): string {
  return text.replace(PLACEHOLDER_RE, (_match, name: Placeholder) => vars[name])
}

export function renderArgs(args: readonly string[], vars: RenderVars): string[] {
  return args.map((arg) => renderString(arg, vars))
}

/** `{names}` that look like placeholders but are not known ones (typos like `{promptfile}`). */
export function unknownPlaceholders(text: string): string[] {
  const known = new Set<string>(PLACEHOLDERS)
  return [...text.matchAll(ANY_PLACEHOLDER_RE)].map((m) => m[1] ?? "").filter((name) => !known.has(name))
}

/** Env names an agent must never receive, whatever the config says. */
const FORBIDDEN_ENV = /^(SHIPBOARD_|GIT_CONFIG|ARTIFACTS_|CLOUDFLARE_|CF_API)/

export function isForbiddenAgentEnv(name: string): boolean {
  return FORBIDDEN_ENV.test(name)
}

/**
 * The agent's whole environment, built from scratch: PATH (absolute entries only), HOME, LANG,
 * TMPDIR inside the job dir, CI/NO_COLOR/GIT_TERMINAL_PROMPT, the template's own envPass vars and
 * envSet. No board or git token is ever in here.
 */
export function agentEnv(template: AgentTemplate, opts: { tmpDir: string; hostEnv: NodeJS.ProcessEnv }): Record<string, string> {
  const host = opts.hostEnv
  const env: Record<string, string> = {
    PATH: absolutePathEntries(host.PATH ?? "").join(path.delimiter),
    HOME: host.HOME ?? "/",
    LANG: host.LANG ?? "en_US.UTF-8",
    TMPDIR: opts.tmpDir,
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
  }
  for (const name of template.envPass) {
    const value = host[name]
    if (value !== undefined && !isForbiddenAgentEnv(name)) env[name] = value
  }
  for (const [name, value] of Object.entries(template.envSet)) {
    if (!isForbiddenAgentEnv(name)) env[name] = value
  }
  return env
}

export function absolutePathEntries(pathVar: string): string[] {
  return pathVar.split(path.delimiter).filter((entry) => entry !== "" && path.isAbsolute(entry))
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    await fs.access(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First executable `name` on PATH, or null. Absolute and ./relative names are checked as given. */
export async function resolveBin(bin: string, pathVar: string, cwd: string): Promise<string | null> {
  if (bin.includes("/")) {
    const full = path.resolve(cwd, bin)
    return (await isExecutable(full)) ? full : null
  }
  for (const dir of absolutePathEntries(pathVar)) {
    const candidate = path.join(dir, bin)
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

/** Grok installs under ~/.grok/bin on systems that do not add that directory to PATH. */
async function resolveGrokBin(bin: string, pathVar: string, cwd: string, homeDir: string): Promise<string | null> {
  const onPath = await resolveBin(bin, pathVar, cwd)
  if (onPath || bin !== GROK_DEFAULT_BIN) return onPath
  return resolveBin(path.join(homeDir, ".grok", "bin", "grok"), pathVar, cwd)
}

export type ResolvedAgent = {
  id: string
  template: AgentTemplate
  /** Absolute path of the binary that will run. */
  binPath: string
  warnings: string[]
}

export type AgentRefusal = { id: string; reason: string }

/**
 * Check every agent the runner would offer. An agent is refused (never offered to the board) when
 * its binary is missing, a Cursor template resolves to Grok's `agent` symlink, or `allowBypass`
 * is unset on a Claude template or a template carrying bypass flags.
 */
export async function resolveAgents(
  ids: readonly string[],
  templates: Readonly<Record<string, AgentTemplate>>,
  opts: { pathVar: string; cwd: string; homeDir?: string },
): Promise<{ ready: ResolvedAgent[]; refused: AgentRefusal[] }> {
  const ready: ResolvedAgent[] = []
  const refused: AgentRefusal[] = []
  const homeDir = opts.homeDir || os.homedir()
  const grokPath = await resolveGrokBin(GROK_DEFAULT_BIN, opts.pathVar, opts.cwd, homeDir)
  const grokReal = grokPath ? await realpathOrNull(grokPath) : null

  for (const id of ids) {
    const template = templates[id]
    if (!template) {
      refused.push({ id, reason: `No template for agent "${id}". Add templates.${id} to shipboard.runner.json.` })
      continue
    }
    const warnings: string[] = []
    const binPath = template.kind === "grok"
      ? await resolveGrokBin(template.bin, opts.pathVar, opts.cwd, homeDir)
      : await resolveBin(template.bin, opts.pathVar, opts.cwd)
    if (!binPath) {
      const where = template.bin.includes("/")
        ? `${template.bin} does not exist or is not executable`
        : template.kind === "grok" && template.bin === GROK_DEFAULT_BIN
          ? "`grok` was not found on PATH or at ~/.grok/bin/grok"
          : `\`${template.bin}\` was not found on PATH`
      refused.push({ id, reason: `${where}. Install ${template.label} or set templates.${id}.bin to its absolute path.` })
      continue
    }

    if (template.kind === "cursor") {
      const real = await realpathOrNull(binPath)
      const isGrok = (real !== null && grokReal !== null && real === grokReal) || /grok/i.test(path.basename(real ?? binPath))
      if (isGrok) {
        refused.push({
          id,
          reason: `\`${template.bin}\` resolves to ${binPath} -> ${real ?? "?"}, which is Grok, not Cursor. Set templates.${id}.bin to Cursor's absolute path (the installer puts it at ~/.local/bin/agent).`,
        })
        continue
      }
      if (!template.bin.includes("/")) {
        warnings.push(`templates.${id}.bin is the bare name \`${template.bin}\`; Grok also installs an \`agent\` binary, so prefer an absolute path.`)
      }
    }

    // Do not infer host isolation from Claude's permission mode, tool list, or custom args.
    // Repo tests can execute arbitrary code, and this runner does not create an OS sandbox.
    if (template.kind === "claude") {
      if (!template.allowBypass) {
        refused.push({
          id,
          reason: `Claude Code can run repository commands without verified host isolation. Set templates.${id}.allowBypass to true only inside an isolated VM or container; this setting does not create isolation.`,
        })
        continue
      }
      warnings.push("Claude Code isolation opt-in is set (allowBypass). Repository commands can access the runner's files and provider credentials; isolation must already be in place.")
    }

    const bypass = bypassFlagsIn(template)
    if (bypass.length > 0 && !template.allowBypass) {
      refused.push({
        id,
        reason: `its template uses ${bypass.join(", ")}, which turns off ${template.label}'s approvals or sandbox. The runner does not do that on a host by default. Set templates.${id}.allowBypass to true only inside a VM or container.`,
      })
      continue
    }
    if (bypass.length > 0) warnings.push(`running with ${bypass.join(", ")} (allowBypass is set).`)

    ready.push({ id, template, binPath, warnings })
  }
  return { ready, refused }
}

async function realpathOrNull(file: string): Promise<string | null> {
  try {
    return await fs.realpath(file)
  } catch {
    return null
  }
}

export type Preflight = { version?: string; versionError?: string; auth?: string }

/** `--version` and, where there is one, a login probe. Used by --dry-run only; never runs a model. */
export async function preflight(
  agent: ResolvedAgent,
  opts: { tmpDir: string; hostEnv: NodeJS.ProcessEnv; observe?: SpawnObserver },
): Promise<Preflight> {
  const env = agentEnv(agent.template, opts)
  const out: Preflight = {}
  if (agent.template.versionArgs.length > 0) {
    const res = await runProcess(
      { bin: agent.binPath, args: agent.template.versionArgs, cwd: opts.tmpDir, env, timeoutMs: 15_000, graceMs: 1_000 },
      opts.observe,
    )
    const line = firstLine(res.stdout) || firstLine(res.stderr)
    if (res.spawnError) out.versionError = res.spawnError
    else if (res.exitCode === 0) out.version = line || "(no output)"
    else out.versionError = `exit ${res.exitCode ?? res.signal ?? "?"}${line ? `: ${line}` : ""}`
  }
  if (agent.template.authCheckArgs) {
    const res = await runProcess(
      { bin: agent.binPath, args: agent.template.authCheckArgs, cwd: opts.tmpDir, env, timeoutMs: 15_000, graceMs: 1_000 },
      opts.observe,
    )
    const line = firstLine(res.stdout) || firstLine(res.stderr)
    out.auth = res.spawnError ? `could not run: ${res.spawnError}` : `exit ${res.exitCode ?? "?"}${line ? `: ${line}` : ""}`
  }
  return out
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? ""
}

/** For --dry-run: the argv as a readable line, placeholders left in. */
export function describeArgv(agent: ResolvedAgent): string {
  const quote = (arg: string): string => (/^[\w@%+=:,./{}-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)
  return [agent.binPath, ...agent.template.args].map(quote).join(" ")
}
