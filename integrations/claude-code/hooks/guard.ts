// The push tripwire. While a shipboard job is active, Bash commands that push, rewire remotes or
// credentials, or hard-reset outside the job's working copy are refused with an instruction to call
// the mcp__shipboard__push tool instead.
//
// This is a tripwire, not the lock. A determined command can evade any reading of shell text
// (an alias, a function, a script file, a variable that holds "push"). The lock is that this session
// never holds a token that can write to anything: the mod mints a write token scoped to one fork,
// for one push, inside its own process, and Claude never sees it.

import { isDynamic, parseLine, type Command } from "./shell"

export type Rule = "push" | "force-push" | "remote" | "credential" | "reset" | "token" | "dynamic" | "git-dir"

export type Finding = { rule: Rule; detail: string }

export type GuardContext = {
  /** Where the Bash tool runs now. */
  cwd: string
  /** The job's working copy. `git reset --hard` is allowed inside it. */
  jobDir: string
  home?: string
}

const MAX_DEPTH = 4
const TOKEN_TEXT = /\b(?:SHIPBOARD_(?:RUNNER_)?TOKEN|CLAUDE_PLUGIN_OPTION_(?:RUNNER|BOARD)_TOKEN)\b|\/api\/runner\//
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish"])
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "coproc"])
const REMOTE_WRITES = new Set(["add", "set-url", "rename", "remove", "rm"])
const CREDENTIAL = /^credential(?:-|$)/
const SENSITIVE_KEY = /^(?:remote|url|credential|http|include|includeif|alias)(?:\.|$)|^core\.(?:sshcommand|askpass|gitproxy|hookspath|fsmonitor)$/i
const GIT_VALUE_OPTIONS = new Set(["--git-dir", "--namespace", "--super-prefix", "--list-cmds"])
const CONFIG_VALUE_OPTIONS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"])
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list"])
const CONFIG_WRITES = new Set(["--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section"])
const XARGS_VALUE_OPTIONS = new Set(["-I", "-i", "-n", "-P", "-L", "-l", "-d", "-s", "-E", "-e", "-a", "-J", "-R", "-S"])

export function classifyCommand(line: string, ctx: GuardContext): Finding | null {
  if (TOKEN_TEXT.test(line)) return { rule: "token", detail: "shipboard token or runner API" }
  return scan(line, ctx.cwd, ctx, 0)
}

/** Edit, Write and friends: refuse writes into a .git directory (config, hooks, refs). */
export function classifyFileWrite(path: string, ctx: GuardContext): Finding | null {
  const where = resolvePath(ctx.cwd, path, ctx.home)
  if (where === null) return null
  return where.split("/").includes(".git") ? { rule: "git-dir", detail: where } : null
}

export function denyMessage(finding: Finding, job: { attemptId: string; dir: string }): string {
  const tool = "mcp__shipboard__push"
  const lead = `Blocked by shipboard while job ${job.attemptId} is active.`
  switch (finding.rule) {
    case "push":
      return `${lead} Do not run git push: this session holds no token that can push. Call the ${tool} tool with a one-line message instead. It commits the working copy in ${job.dir}, pushes HEAD:main to this job's fork only, and returns the board's verdict.`
    case "force-push":
      return `${lead} Force pushes are never needed here: a fork that stops merging is re-run from its brief, not rewritten. Call the ${tool} tool with a one-line message to push your work.`
    case "remote":
    case "credential":
      return `${lead} Do not change git remotes, URL rewrites, aliases or credentials (${finding.detail}). ${tool} always pushes to this job's fork, so leave the git configuration as it is.`
    case "reset":
      return `${lead} git reset --hard is only allowed inside the job's working copy, ${job.dir}. Run it there (cd ${job.dir} first) if you need to discard your own changes.`
    case "token":
      return `${lead} Commands that read shipboard tokens or call the runner API are refused. Use the ${tool} tool to push.`
    case "dynamic":
      return `${lead} This command builds a git command at run time (${finding.detail}), so the push guard cannot check it. Write the git command out literally, or call ${tool} to push.`
    case "git-dir":
      return `${lead} Do not edit files inside a .git directory (${finding.detail}). Work on the files of the working copy only.`
  }
}

function scan(line: string, cwd: string | null, ctx: GuardContext, depth: number): Finding | null {
  if (depth > MAX_DEPTH) return { rule: "dynamic", detail: "too deeply nested to read" }
  const { items, nested } = parseLine(line)
  for (const source of nested) {
    const found = scan(source, cwd, ctx, depth + 1)
    if (found) return found
  }
  let dir = cwd
  const scopes: (string | null)[] = []
  const stack: (string | null)[] = []
  for (const item of items) {
    if (item.kind === "open") {
      scopes.push(dir)
    } else if (item.kind === "close") {
      if (scopes.length > 0) dir = scopes.pop() ?? null
    } else {
      const seen = examine(item.command, item.command.words, dir, ctx, depth, stack)
      if (seen.finding) return seen.finding
      dir = seen.dir
    }
  }
  return null
}

function examine(
  cmd: Command,
  raw: string[],
  dir: string | null,
  ctx: GuardContext,
  depth: number,
  stack: (string | null)[],
): { finding: Finding | null; dir: string | null } {
  const { words, env } = unwrap(raw)
  const program = words[0]
  if (program === undefined) return { finding: null, dir }
  const args = words.slice(1)
  const name = program.split("/").pop() ?? program
  const pass = (next: string | null = dir) => ({ finding: null, dir: next })

  if (name === "cd") return pass(cdTarget(args, dir, ctx))
  if (name === "pushd") {
    stack.push(dir)
    return pass(cdTarget(args, dir, ctx))
  }
  if (name === "popd") return pass(stack.length > 0 ? (stack.pop() ?? null) : null)
  if (name === "eval") return { finding: scan(args.join(" "), dir, ctx, depth + 1), dir }
  if (SHELLS.has(name)) {
    const script = shellScript(args)
    const text = script !== undefined ? script : (cmd.stdin ?? pipedText(cmd))
    return { finding: text === null ? null : scan(text, dir, ctx, depth + 1), dir }
  }
  if (name === "find") {
    for (const sub of execArgs(args)) {
      const seen = examine({ words: sub, stdin: null, pipedFrom: null }, sub, dir, ctx, depth + 1, [])
      if (seen.finding) return seen
    }
    return pass()
  }
  if (isDynamic(program)) {
    const sub = args.find((a) => !a.startsWith("-"))
    if (sub === "push" || sub === "remote" || sub === "config" || sub === "send-pack" || (sub && CREDENTIAL.test(sub))) {
      return { finding: { rule: "dynamic", detail: `a command name set at run time, then "${sub}"` }, dir }
    }
    return pass()
  }
  if (name === "git") return { finding: classifyGit(args, dir, env, ctx), dir }
  return pass()
}

/** Strips keywords, VAR=value prefixes and wrappers such as sudo, env, xargs and timeout. */
function unwrap(input: string[]): { words: string[]; env: Record<string, string> } {
  const w = [...input]
  const env: Record<string, string> = {}
  const skipOptions = (valued: Set<string> = new Set()) => {
    while ((w[0] ?? "").startsWith("-") && w[0] !== "-") {
      const option = w.shift() ?? ""
      if (option === "--") break
      if (valued.has(option)) w.shift()
    }
  }
  for (;;) {
    const first = w[0]
    if (first === undefined) break
    const name = first.split("/").pop() ?? first
    if (KEYWORDS.has(first)) {
      w.shift()
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      const at = first.indexOf("=")
      env[first.slice(0, at)] = first.slice(at + 1)
      w.shift()
    } else if (name === "sudo" || name === "doas") {
      w.shift()
      skipOptions(new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U"]))
    } else if (name === "env") {
      w.shift()
      skipOptions(new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]))
    } else if (["command", "builtin", "nohup", "time", "stdbuf", "unbuffer", "chronic", "caffeinate"].includes(name)) {
      w.shift()
      skipOptions()
    } else if (name === "exec") {
      w.shift()
      skipOptions(new Set(["-a"]))
    } else if (name === "nice") {
      w.shift()
      skipOptions(new Set(["-n"]))
    } else if (name === "timeout") {
      w.shift()
      skipOptions(new Set(["-s", "-k", "--signal", "--kill-after"]))
      w.shift()
    } else if (name === "xargs") {
      w.shift()
      skipOptions(XARGS_VALUE_OPTIONS)
    } else if (name === "xcrun") {
      w.shift()
      skipOptions(new Set(["--sdk", "--toolchain"]))
    } else if (name === "watch") {
      w.shift()
      skipOptions(new Set(["-n", "--interval"]))
    } else {
      break
    }
  }
  return { words: w, env }
}

function classifyGit(args: string[], dir: string | null, env: Record<string, string>, ctx: GuardContext): Finding | null {
  let where = dir
  let workTree: string | null | undefined = env.GIT_WORK_TREE === undefined ? undefined : resolvePath(dir, env.GIT_WORK_TREE, ctx.home)
  let i = 0
  while (i < args.length) {
    const a = args[i] ?? ""
    const value = args[i + 1]
    if (a === "-C") {
      where = value === undefined ? null : resolvePath(where, value, ctx.home)
      i += 2
    } else if (a === "-c" || a === "--config-env") {
      const key = (value ?? "").split("=")[0] ?? ""
      if (SENSITIVE_KEY.test(key)) return { rule: "remote", detail: `git -c ${key}` }
      i += 2
    } else if (a.startsWith("--config-env=")) {
      const key = a.slice("--config-env=".length).split("=")[0] ?? ""
      if (SENSITIVE_KEY.test(key)) return { rule: "remote", detail: `git --config-env ${key}` }
      i += 1
    } else if (a === "--work-tree") {
      workTree = value === undefined ? null : resolvePath(where, value, ctx.home)
      i += 2
    } else if (a.startsWith("--work-tree=")) {
      workTree = resolvePath(where, a.slice("--work-tree=".length), ctx.home)
      i += 1
    } else if (GIT_VALUE_OPTIONS.has(a)) {
      i += 2
    } else if (a.startsWith("-")) {
      i += 1
    } else {
      break
    }
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === undefined) return null
  if (isDynamic(sub)) return { rule: "dynamic", detail: "git with a subcommand set at run time" }
  if (sub === "push" || sub === "send-pack" || sub === "http-push") {
    return rest.some(isForce) ? { rule: "force-push", detail: `git ${sub}` } : { rule: "push", detail: `git ${sub}` }
  }
  if ((sub === "subtree" || sub === "lfs") && rest.includes("push")) return { rule: "push", detail: `git ${sub} push` }
  if (sub === "remote") {
    const action = rest.find((a) => !a.startsWith("-"))
    if (action !== undefined && REMOTE_WRITES.has(action)) return { rule: "remote", detail: `git remote ${action}` }
  }
  if (sub === "config" && configTouchesRemotes(rest)) return { rule: "remote", detail: "git config on remotes, URLs or credentials" }
  if (CREDENTIAL.test(sub)) return { rule: "credential", detail: `git ${sub}` }
  if (sub === "reset" && rest.includes("--hard")) {
    const target = workTree === undefined ? where : workTree
    if (target === null || !isInside(ctx.jobDir, target)) {
      return { rule: "reset", detail: target ?? "a directory that cannot be worked out" }
    }
  }
  return null
}

function isForce(arg: string): boolean {
  return (
    arg === "--force" ||
    arg.startsWith("--force-with-lease") ||
    arg === "--force-if-includes" ||
    arg.startsWith("+") ||
    /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)
  )
}

function configTouchesRemotes(rest: string[]): boolean {
  const flags: string[] = []
  const positional: string[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? ""
    if (a.startsWith("-")) {
      flags.push(a)
      if (CONFIG_VALUE_OPTIONS.has(a)) i += 1
    } else {
      positional.push(a)
    }
  }
  const verb = positional[0]
  if (flags.includes("-e") || flags.includes("--edit") || verb === "edit") return true
  if (verb === "get" || verb === "list") return false
  if (verb === "set" || verb === "unset" || verb === "rename-section" || verb === "remove-section") {
    return positional.slice(1).some((key) => SENSITIVE_KEY.test(key))
  }
  if (flags.some((f) => CONFIG_READS.has(f))) return false
  if (flags.some((f) => CONFIG_WRITES.has(f))) return positional.some((key) => SENSITIVE_KEY.test(key))
  return positional.length >= 2 && SENSITIVE_KEY.test(positional[0] ?? "")
}

/** The script of `bash -c '...'`, null for a script file, undefined when the shell reads stdin. */
function shellScript(args: string[]): string | null | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ""
    if (a === "-o" || a === "+o") {
      i += 1
    } else if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) {
      return args.slice(i + 1).find((s) => !s.startsWith("-")) ?? ""
    } else if (!a.startsWith("-") && !a.startsWith("+")) {
      return null
    }
  }
  return undefined
}

/** What a shell reading stdin gets from `echo ... |`, `printf ... |` or `cat <<EOF |`. */
function pipedText(cmd: Command): string | null {
  const from = cmd.pipedFrom
  if (from === null) return null
  const { words } = unwrap(from.words)
  const name = (words[0] ?? "").split("/").pop()
  if (name === "echo" || name === "printf") return words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(" ")
  return from.stdin
}

function execArgs(args: string[]): string[][] {
  const commands: string[][] = []
  for (let i = 0; i < args.length; i += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i] ?? "")) continue
    const sub: string[] = []
    i += 1
    while (i < args.length && args[i] !== ";" && args[i] !== "+") sub.push(args[i++] ?? "")
    commands.push(sub)
  }
  return commands
}

function cdTarget(args: string[], dir: string | null, ctx: GuardContext): string | null {
  const target = args.filter((a) => a !== "--" && !/^-[LPe@]+$/.test(a))[0]
  if (target === undefined) return ctx.home ?? null
  if (target === "-") return null
  return resolvePath(dir, target, ctx.home)
}

export function resolvePath(base: string | null, path: string, home?: string): string | null {
  if (isDynamic(path)) return null
  let full = path
  if (full === "~" || full.startsWith("~/")) {
    if (!home) return null
    full = home + full.slice(1)
  } else if (full.startsWith("~")) {
    return null
  }
  if (!full.startsWith("/")) {
    if (base === null) return null
    full = `${base}/${full}`
  }
  const parts: string[] = []
  for (const part of full.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return "/" + parts.join("/")
}

export function isInside(root: string, path: string): boolean {
  const base = resolvePath(null, root) ?? root
  const target = resolvePath(null, path) ?? path
  return target === base || target.startsWith(base === "/" ? "/" : base + "/")
}
