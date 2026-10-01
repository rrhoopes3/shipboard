// The slice of the Claude Code mods API this mod uses, declared locally so the mod type-checks
// without the CLI installed.
//
// Sources:
// - https://code.claude.com/docs/en/plugins/mods/reference.md (events, methods, limits, v2.1.287)
// - https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts (written by
//   Claude Code 2.1.277)
//
// Claude Code writes the full declarations for the running version into
// `.claude-plugin/types/` whenever it loads this directory with `--plugin-dir`
// (https://code.claude.com/docs/en/plugins/mods/create.md#get-the-types-for-your-build). Trust those
// over this file when they disagree. This file only narrows; it never adds behaviour.

export type PluginOptions = Readonly<Record<string, string | number | boolean | readonly string[]>>

export type HttpInit = {
  method?: string
  headers?: Record<string, string>
  body?: string
}

export type HttpResponse = {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: string
}

export type ProcessRunInit = {
  cwd?: string
  /** Variables set over the host process's own environment, for this child only. */
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export type ProcessRunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type FsEntry = {
  name: string
  kind: string
  size: number
  isLink: boolean
}

export type Timer = { cancel: () => void }

export type RenderElement = { readonly [key: string]: unknown }
export type RenderNode = RenderElement | string | null
export type ElementProps = { [prop: string]: unknown; children?: RenderNode | readonly RenderNode[] }
export type ElementConstructor = (props: ElementProps) => RenderElement

export type Elements = {
  Box: ElementConstructor
  Text: ElementConstructor
  Button: ElementConstructor
  Link: ElementConstructor
}

export type PaneProps = {
  title: string
  isFocused: boolean
  bodyColumns: number
  placement: "dock" | "inline"
}

export type RenderInput = {
  surface: string
  component: string
  requestId: string
  props: Partial<PaneProps> & Record<string, unknown>
}

export type PaneOpenArgs = {
  id: string
  title?: string
  focus?: true
  closeOnEscape?: true
  rows?: number
  columns?: number
}

export type CommandSpec = {
  name: string
  description: string
  argumentHint?: string
  immediate?: true
}

export type ToolSpec = {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

export type Api = {
  plugin: { name: string; root: string }
  ui: {
    resolve: (e: RenderInput) => Elements
    invalidate: (event: "ui.render") => void
    open: (pane: PaneOpenArgs) => Promise<unknown>
    close: (pane: { id: string }) => Promise<void>
    log: (text: string, options?: { to?: "transcript" | "debug" }) => void
    toast: (text: string, options?: { timeoutMs?: number }) => void
    status: (text: string | undefined) => void
  }
  command: { register: (spec: CommandSpec) => Promise<unknown> }
  tool: { register: (spec: ToolSpec) => Promise<unknown> }
  prompt: { submit: (input: { text: string }) => Promise<unknown> }
  session: {
    cwd: () => Promise<string>
    id: () => Promise<string>
  }
  env: {
    get: (name: string) => Promise<string | undefined>
    set: (name: string, value: string | undefined) => Promise<void>
  }
  fs: {
    read: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
    list: (path?: string) => Promise<FsEntry[]>
    exists: (path: string) => Promise<boolean>
  }
  store: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<void>
  }
  clock: {
    now: () => Promise<number>
    after: (ms: number, fn: () => void) => Timer
    every: (ms: number, fn: () => void) => Timer
  }
  http: { fetch: (url: string, init?: HttpInit) => Promise<HttpResponse> }
  process: { run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult> }
}

export type SessionStartInput = { cwd: string; surface: string | null; isInteractive: boolean }
export type SessionEndInput = { reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other"; sessionId: string }

/** `tool.call`: the tool's arguments are fields of the event, as in `e.command` for Bash. */
export type ToolCallInput = { tool: string; tool_use_id: string; [argument: string]: unknown }
export type ToolCallResult =
  | { deny: string }
  | { result: unknown; context?: readonly string[]; text?: string; isError?: boolean }

export type CommandRunInput = { command: string; args: string }
export type CommandRunResult = { text?: string; context?: readonly string[] }

export type PromptSubmitInput = { text: string; context?: readonly string[]; [field: string]: unknown }
export type PromptSubmitResult = { text: string; context?: readonly string[] } | { drop: string }

export type Next<I, R> = ((e: I) => Promise<R>) & {
  signal: AbortSignal
  error?: { kind: "throw" | "timeout"; message: string }
  called?: boolean
}

export type Hook<I, R> = ($: Api, e: I, next: Next<I, R>) => R | Promise<R>

export type Registration<I, R> = { catch: (handler: Hook<I, R | undefined>) => void }

export type On = {
  (event: "session.start", hook: Hook<SessionStartInput, unknown>): Registration<SessionStartInput, unknown>
  (event: "session.end", hook: Hook<SessionEndInput, unknown>): Registration<SessionEndInput, unknown>
  (event: "session.compact", hook: Hook<Record<string, unknown>, unknown>): Registration<Record<string, unknown>, unknown>
  (
    event: "tool.call",
    matcher: { tool: string | readonly string[] },
    hook: Hook<ToolCallInput, ToolCallResult>,
  ): Registration<ToolCallInput, ToolCallResult>
  (
    event: "command.run",
    matcher: { command: string },
    hook: Hook<CommandRunInput, CommandRunResult>,
  ): Registration<CommandRunInput, CommandRunResult>
  (event: "prompt.submit", hook: Hook<PromptSubmitInput, PromptSubmitResult>): Registration<PromptSubmitInput, PromptSubmitResult>
  (
    event: "ui.render",
    matcher: { component: "Pane" },
    hook: Hook<RenderInput, RenderNode>,
  ): Registration<RenderInput, RenderNode>
}
