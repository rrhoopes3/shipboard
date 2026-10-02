// A stand-in for Claude Code's mod host: records what register() hooks, runs events through them
// as a middleware chain, and answers the mods API with real processes, real HTTP and real files.
// Element constructors refuse props the mods reference does not list, as Claude Code does.

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import type {
  Api,
  ElementProps,
  Elements,
  On,
  PluginOptions,
  ProcessRunInit,
  ProcessRunResult,
  RenderElement,
  RenderNode,
} from "../../integrations/claude-code/hooks/mods"
import { register } from "../../integrations/claude-code/hooks/register.ts"

type Hooked = {
  event: string
  matcher: Record<string, unknown> | null
  hook: (...args: unknown[]) => unknown
  catcher: ((...args: unknown[]) => unknown) | null
}

type Timer = { ms: number; fn: () => void; every: boolean; cancelled: boolean }

export type HarnessOptions = {
  cwd: string
  sessionId?: string
  env?: Record<string, string>
  options?: PluginOptions
  /** Shared between harnesses to simulate a reload of the mod in one session. */
  store?: Map<string, unknown>
  /** Environment for every child process, over this process's own. */
  childEnv?: Record<string, string>
}

export type Harness = Awaited<ReturnType<typeof harness>>

export async function harness(opts: HarnessOptions) {
  const hooks: Hooked[] = []
  const said: string[] = []
  const runs: { argv: string[]; env?: Record<string, string> }[] = []
  const timers: Timer[] = []
  const store = opts.store ?? new Map<string, unknown>()
  const env = new Map(Object.entries(opts.env ?? {}))
  const submitted: string[] = []
  const commands: unknown[] = []
  const tools: unknown[] = []
  const opened: unknown[] = []
  const state = { cwd: opts.cwd, invalidations: 0 }

  const on = ((event: string, a: unknown, b?: unknown) => {
    const hooked: Hooked = {
      event,
      matcher: b === undefined ? null : (a as Record<string, unknown>),
      hook: (b === undefined ? a : b) as Hooked["hook"],
      catcher: null,
    }
    hooks.push(hooked)
    return {
      catch: (handler: Hooked["hook"]) => {
        hooked.catcher = handler
      },
    }
  }) as unknown as On

  const resolveIn = (p: string) => path.resolve(state.cwd, p)

  const run = (argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult> => {
    runs.push({ argv: [...argv], env: init?.env })
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0] ?? "false", argv.slice(1), {
        cwd: init?.cwd ? resolveIn(init.cwd) : state.cwd,
        env: { ...process.env, ...opts.childEnv, ...init?.env },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")))
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")))
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`timed out: ${argv.join(" ")}`))
      }, init?.timeoutMs ?? 30_000)
      child.on("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolve({ exitCode: code ?? 1, stdout, stderr })
      })
      // A hook process can exit without consuming stdin; preserve its exit result.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") return
        clearTimeout(timer)
        reject(error)
      })
      child.stdin.end(init?.stdin ?? "")
    })
  }

  const timer = (ms: number, fn: () => void, every: boolean) => {
    const t: Timer = { ms, fn, every, cancelled: false }
    timers.push(t)
    return { cancel: () => void (t.cancelled = true) }
  }

  const $: Api = {
    plugin: { name: "shipboard", root: "/plugins/shipboard" },
    ui: {
      resolve: () => elements,
      invalidate: () => void (state.invalidations += 1),
      open: async (pane) => {
        opened.push(pane)
        return { isPlaced: true }
      },
      close: async () => undefined,
      log: (text) => void said.push(text),
      toast: (text) => void said.push(text),
      status: (text) => void (text === undefined ? undefined : said.push(text)),
    },
    command: {
      register: async (spec) => {
        commands.push(spec)
        return { command: spec.name }
      },
    },
    tool: {
      register: async (spec) => {
        tools.push(spec)
        return { tool: `mcp__shipboard__${spec.name}` }
      },
    },
    prompt: {
      submit: async (input) => {
        submitted.push(input.text)
        said.push(input.text)
      },
    },
    session: { cwd: async () => state.cwd, id: async () => opts.sessionId ?? "session-1" },
    env: {
      get: async (name) => env.get(name),
      set: async (name, value) => void (value === undefined ? env.delete(name) : env.set(name, value)),
    },
    fs: {
      read: (p) => fs.readFile(resolveIn(p), "utf8"),
      write: (p, text) => fs.writeFile(resolveIn(p), text),
      list: async (p) =>
        (await fs.readdir(resolveIn(p ?? "."), { withFileTypes: true })).map((d) => ({
          name: d.name,
          kind: d.isDirectory() ? "directory" : "file",
          size: 0,
          isLink: d.isSymbolicLink(),
        })),
      exists: (p) => fs.access(resolveIn(p)).then(
        () => true,
        () => false,
      ),
    },
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => void store.set(key, JSON.parse(JSON.stringify(value)) as unknown),
      delete: async (key) => void store.delete(key),
    },
    clock: {
      now: async () => Date.now(),
      after: (ms, fn) => timer(ms, fn, false),
      every: (ms, fn) => timer(ms, fn, true),
    },
    http: {
      fetch: async (url, init) => {
        const res = await fetch(url, { method: init?.method, headers: init?.headers, body: init?.body })
        const text = await res.text()
        return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), text }
      },
    },
    process: { run },
  }

  async function emit(event: string, e: Record<string, unknown>, core: (e: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
    const chain = hooks.filter((h) => h.event === event && matches(h.matcher, e))
    const call = async (i: number, ev: Record<string, unknown>): Promise<unknown> => {
      const h = chain[i]
      if (!h) return core(ev)
      const next = Object.assign((x: Record<string, unknown>) => call(i + 1, x), { signal: new AbortController().signal })
      try {
        return await h.hook($, ev, next)
      } catch (error) {
        if (!h.catcher) throw error
        const caught = Object.assign(next, { error: { kind: "throw", message: String(error) }, called: false })
        return (await h.catcher($, ev, caught)) ?? core(ev)
      }
    }
    return call(0, e)
  }

  register(on, opts.options ?? {})

  return {
    $,
    hooks,
    said,
    runs,
    timers,
    store,
    env,
    submitted,
    commands,
    tools,
    opened,
    state,

    start: () => emit("session.start", { cwd: state.cwd, surface: "terminal", isInteractive: true }, async () => ({ cwd: state.cwd })),

    end: (reason: string) => emit("session.end", { reason, sessionId: opts.sessionId ?? "session-1" }, async () => ({})),

    async command(args: string): Promise<string> {
      const out = (await emit("command.run", { command: "shipboard", args }, async () => ({ text: "(no hook answered)" }))) as { text?: string }
      if (out.text) said.push(out.text)
      return out.text ?? ""
    },

    /** A Bash call. Resolves to the deny text, or null when the command would have run. */
    async bash(command: string): Promise<string | null> {
      const out = (await emit("tool.call", { tool: "Bash", tool_use_id: "toolu_bash", command }, async () => ({ result: "ran" }))) as { deny?: string }
      if (out.deny) said.push(out.deny)
      return out.deny ?? null
    },

    async edit(filePath: string): Promise<string | null> {
      const out = (await emit("tool.call", { tool: "Edit", tool_use_id: "toolu_edit", file_path: filePath, old_string: "a", new_string: "b" }, async () => ({ result: "ran" }))) as { deny?: string }
      if (out.deny) said.push(out.deny)
      return out.deny ?? null
    },

    async push(message: string): Promise<string> {
      const out = (await emit("tool.call", { tool: "mcp__shipboard__push", tool_use_id: "toolu_push", message }, async () => {
        throw new Error("no hook answered mcp__shipboard__push")
      })) as { result?: unknown }
      const text = String(out.result)
      said.push(text)
      return text
    },

    /** Submits a prompt; resolves to the context entries Claude would read with it. */
    async prompt(text: string): Promise<string[]> {
      const out = (await emit("prompt.submit", { text, wait: false, origin: { kind: "composer" } }, async (ev) => ev)) as { context?: string[] }
      const context = out.context ?? []
      said.push(...context)
      return context
    },

    async render(): Promise<RenderNode> {
      const tree = (await emit(
        "ui.render",
        { component: "Pane", surface: "terminal", requestId: "shipboard", props: { title: "Shipboard", isFocused: false, bodyColumns: 64, placement: "dock" } },
        async () => "(engine drew its own)",
      )) as RenderNode
      return tree
    },

    /** Runs every live repeating timer with this period once, and waits for what it started. */
    async tick(ms: number): Promise<void> {
      for (const t of timers.filter((x) => x.every && x.ms === ms && !x.cancelled)) t.fn()
      await new Promise((r) => setTimeout(r, 300))
    },

    liveTimers: () => timers.filter((t) => !t.cancelled),
  }
}

function matches(matcher: Record<string, unknown> | null, e: Record<string, unknown>): boolean {
  if (matcher === null) return true
  return Object.entries(matcher).every(([key, want]) => {
    const got = e[key]
    if (Array.isArray(want)) return want.includes(got)
    if (want instanceof RegExp) return typeof got === "string" && want.test(got)
    return got === want
  })
}

// ------------------------------------------------------------------ elements

const COMMON = ["children"]
const BOX_PROPS = new Set([
  ...COMMON,
  "key",
  "hover",
  "position",
  "top",
  "left",
  "right",
  "bottom",
  "flexDirection",
  "flexGrow",
  "flexShrink",
  "flexWrap",
  "alignItems",
  "alignSelf",
  "justifyContent",
  "gap",
  "columnGap",
  "rowGap",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "margin",
  "marginX",
  "marginY",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "padding",
  "paddingX",
  "paddingY",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "borderStyle",
  "borderColor",
  "borderDimColor",
  "backgroundColor",
  "overflow",
  "display",
])
const TEXT_PROPS = new Set([...COMMON, "hover", "color", "backgroundColor", "dimColor", "bold", "italic", "underline", "strikethrough", "inverse", "wrap"])
const BUTTON_PROPS = new Set(["key", "label", "onPress", "hotkey", "plain", "dimColor", "autoFocus", "action", "hover"])
const LINK_PROPS = new Set([...COMMON, "href", "label"])
const WRAPS = new Set(["wrap", "end", "middle", "truncate", "truncate-start", "truncate-middle", "truncate-end"])

function element(type: string, allowed: Set<string>) {
  return (props: ElementProps): RenderElement => {
    for (const key of Object.keys(props)) {
      if (!allowed.has(key)) throw new Error(`${type} prop "${key}" is not allowed`)
    }
    if (type === "Text" && props.wrap !== undefined && !WRAPS.has(String(props.wrap))) throw new Error(`Text wrap ${String(props.wrap)}`)
    if (type === "Link") {
      const href = String(props.href)
      const url = new URL(href)
      if (!(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"))) throw new Error(`Link href ${href} refused`)
    }
    const children = props.children
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === "") throw new Error(`${type} has an empty string child`)
    }
    return Object.freeze({ type, props })
  }
}

export const elements: Elements = {
  Box: element("Box", BOX_PROPS),
  Text: element("Text", TEXT_PROPS),
  Button: element("Button", BUTTON_PROPS),
  Link: element("Link", LINK_PROPS),
}

/** The text a tree would show: Box children on their own lines, Text children run together. */
export function textOf(node: unknown): string {
  if (node === null || node === undefined || node === false) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  const el = node as { type: string; props: Record<string, unknown> }
  const kids = el.props.children
  const list = Array.isArray(kids) ? kids : [kids]
  if (el.type === "Link") return String(el.props.label ?? el.props.href)
  if (el.type === "Box") return list.map(textOf).filter((s) => s !== "").join("\n")
  return list.map(textOf).join("")
}

/** Every element of a type in a tree. */
export function findAll(node: unknown, type: string): { type: string; props: Record<string, unknown> }[] {
  if (node === null || typeof node !== "object") return []
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, type))
  const el = node as { type: string; props: Record<string, unknown> }
  const own = el.type === type ? [el] : []
  return [...own, ...findAll(el.props.children, type)]
}
