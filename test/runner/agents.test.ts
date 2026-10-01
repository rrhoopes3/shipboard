import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_TEMPLATES,
  agentEnv,
  bypassFlagsIn,
  renderArgs,
  renderString,
  resolveAgents,
  unknownPlaceholders,
  type AgentTemplate,
  type RenderVars,
} from "../../runner/agents.ts"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-agents-"))
  dirs.push(dir)
  return dir
}

async function executable(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "#!/bin/sh\necho fake 1.0\n", { mode: 0o755 })
}

const vars: RenderVars = {
  prompt: "Tint {cwd} literally; $HOME; `id`",
  prompt_file: "/jobs/j1/prompt.md",
  cwd: "/jobs/j1/repo",
  job_dir: "/jobs/j1",
  session_uuid: "11111111-2222-4333-8444-555555555555",
  max_turns: "40",
  budget_usd: "2",
}

describe("template rendering", () => {
  it("replaces placeholders per element in one pass", () => {
    const args = renderArgs(["-p", "{prompt}", "-o", "{job_dir}/last-message.txt", "--settings", '{"disableAllHooks":true}', "{unknown}"], vars)
    expect(args).toEqual([
      "-p",
      "Tint {cwd} literally; $HOME; `id`",
      "-o",
      "/jobs/j1/last-message.txt",
      "--settings",
      '{"disableAllHooks":true}',
      "{unknown}",
    ])
  })

  it("renders every default template without leftover placeholders", () => {
    for (const template of Object.values(DEFAULT_TEMPLATES)) {
      const rendered = renderArgs(template.args, vars).join("\u0000") + (template.stdin ? renderString(template.stdin, vars) : "")
      expect(rendered.replace(vars.prompt, "")).not.toMatch(/\{(prompt|prompt_file|cwd|job_dir|session_uuid|max_turns|budget_usd)\}/)
      expect(unknownPlaceholders(template.args.join(" "))).toEqual([])
    }
  })

  it("flags typos in placeholders but not JSON", () => {
    expect(unknownPlaceholders("{promptfile} {cwd} {\"a\":1}")).toEqual(["promptfile"])
  })
})

describe("default templates", () => {
  it("use no bypass flags on the host, except Cursor whose only edit mode is --force", () => {
    expect(bypassFlagsIn(DEFAULT_TEMPLATES.claude)).toEqual([])
    expect(bypassFlagsIn(DEFAULT_TEMPLATES.codex)).toEqual([])
    expect(bypassFlagsIn(DEFAULT_TEMPLATES.grok)).toEqual([])
    expect(bypassFlagsIn(DEFAULT_TEMPLATES.cursor)).toEqual(["--force"])
  })

  it("detect bypass flags in any spelling", () => {
    const t = (kind: AgentTemplate["kind"], args: string[]) => bypassFlagsIn({ kind, args })
    expect(t("grok", ["--always-approve"])).toEqual(["--always-approve"])
    expect(t("grok", ["--yolo"])).toEqual(["--yolo"])
    expect(t("grok", ["--permission-mode", "bypassPermissions"])).toEqual(["--permission-mode bypassPermissions"])
    expect(t("claude", ["--permission-mode=bypassPermissions"])).toEqual(["--permission-mode bypassPermissions"])
    expect(t("claude", ["--dangerously-skip-permissions"])).toEqual(["--dangerously-skip-permissions"])
    expect(t("codex", ["exec", "--sandbox", "danger-full-access"])).toEqual(["--sandbox danger-full-access"])
    expect(t("codex", ["--dangerously-bypass-approvals-and-sandbox"])).toEqual(["--dangerously-bypass-approvals-and-sandbox"])
    expect(t("cursor", ["--yolo"])).toEqual(["--yolo"])
    expect(t("script", ["--yolo"])).toEqual([])
  })

  it("Grok: acceptEdits, workspace sandbox, no --trust, and deny rules for git and .git/.shipboard", () => {
    const args = DEFAULT_TEMPLATES.grok.args
    expect(DEFAULT_TEMPLATES.grok.bin).toBe("/Users/grokbot5000/.grok/bin/grok")
    expect(args.join(" ")).toContain("--permission-mode acceptEdits")
    expect(args.join(" ")).toContain("--sandbox workspace")
    expect(args).not.toContain("--trust")
    expect(args).toContain("--prompt-file")
    const denies = args.filter((_a, i) => args[i - 1] === "--deny")
    expect(denies).toEqual(expect.arrayContaining(["Bash(git commit*)", "Bash(git push*)", "Edit(**/.git/**)", "Write(**/.git/**)", "Edit(**/.shipboard/**)"]))
    expect(DEFAULT_TEMPLATES.grok.parser).toBe("grok-json")
  })

  it("Claude: acceptEdits, no project settings or MCP, no Glob/Grep in the allow list", () => {
    const args = DEFAULT_TEMPLATES.claude.args
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1]
    expect(after("--permission-mode")).toBe("acceptEdits")
    expect(after("--setting-sources")).toBe("user")
    expect(args).toContain("--strict-mcp-config")
    expect(after("--settings")).toBe('{"disableAllHooks":true}')
    expect(after("--allowedTools")).not.toMatch(/Glob|Grep/)
    expect(after("--disallowedTools")).toMatch(/Bash\(git commit \*\).*Bash\(git push \*\)/)
    expect(args).not.toContain("--bare")
  })

  it("Codex: workspace-write sandbox and the prompt on stdin", () => {
    const t = DEFAULT_TEMPLATES.codex
    expect(t.args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"])
    expect(t.args[t.args.length - 1]).toBe("-")
    expect(t.stdin).toBe("{prompt}")
    expect(t.summaryFile).toBe("{job_dir}/last-message.txt")
  })
})

describe("agentEnv", () => {
  it("builds the env from scratch: allowlist, envPass when set, envSet, TMPDIR in the job dir", () => {
    const template: AgentTemplate = { ...DEFAULT_TEMPLATES.grok, envPass: ["XAI_API_KEY", "GROK_HOME", "SHIPBOARD_RUNNER_TOKEN"], envSet: { RUST_LOG: "error", GIT_CONFIG_COUNT: "1" } }
    const env = agentEnv(template, {
      tmpDir: "/jobs/j1/tmp",
      hostEnv: {
        PATH: `/usr/bin:relative/bin::/opt/homebrew/bin`,
        HOME: "/Users/x",
        LANG: "en_GB.UTF-8",
        XAI_API_KEY: "xai-123",
        SHIPBOARD_RUNNER_TOKEN: "runner-secret",
        AWS_SECRET_ACCESS_KEY: "nope",
        GIT_CONFIG_VALUE_0: "Authorization: Bearer x",
      },
    })
    expect(env).toEqual({
      PATH: "/usr/bin:/opt/homebrew/bin",
      HOME: "/Users/x",
      LANG: "en_GB.UTF-8",
      TMPDIR: "/jobs/j1/tmp",
      CI: "1",
      NO_COLOR: "1",
      GIT_TERMINAL_PROMPT: "0",
      XAI_API_KEY: "xai-123",
      RUST_LOG: "error",
    })
  })
})

describe("resolveAgents", () => {
  it("refuses an agent whose binary is missing, with a clear message", async () => {
    const dir = await tempDir()
    const { ready, refused } = await resolveAgents(["claude"], { claude: DEFAULT_TEMPLATES.claude }, { pathVar: dir, cwd: dir })
    expect(ready).toEqual([])
    expect(refused[0]?.reason).toMatch(/`claude` was not found on PATH\. Install Claude Code or set templates\.claude\.bin/)
  })

  it("resolves bare names on PATH and checks absolute paths", async () => {
    const dir = await tempDir()
    await executable(path.join(dir, "bin", "codex"))
    const { ready } = await resolveAgents(["codex"], { codex: DEFAULT_TEMPLATES.codex }, { pathVar: path.join(dir, "bin"), cwd: dir })
    expect(ready[0]?.binPath).toBe(path.join(dir, "bin", "codex"))

    const missing = { ...DEFAULT_TEMPLATES.codex, bin: path.join(dir, "nope", "codex") }
    const res = await resolveAgents(["codex"], { codex: missing }, { pathVar: "", cwd: dir })
    expect(res.refused[0]?.reason).toMatch(/does not exist or is not executable/)
  })

  it("refuses Cursor when a bare `agent` resolves to Grok", async () => {
    const dir = await tempDir()
    await executable(path.join(dir, "downloads", "grok-1.0.44-macos-aarch64"))
    await fs.mkdir(path.join(dir, "bin"))
    await fs.symlink("../downloads/grok-1.0.44-macos-aarch64", path.join(dir, "bin", "agent"))
    const cursor = { ...DEFAULT_TEMPLATES.cursor, allowBypass: true }
    const { ready, refused } = await resolveAgents(["cursor"], { cursor }, { pathVar: path.join(dir, "bin"), cwd: dir })
    expect(ready).toEqual([])
    expect(refused[0]?.reason).toMatch(/which is Grok, not Cursor\. Set templates\.cursor\.bin to Cursor's absolute path/)
  })

  it("refuses Cursor's --force by default and allows it, with a warning, when allowBypass is set", async () => {
    const dir = await tempDir()
    await executable(path.join(dir, "cursor", "agent"))
    const bin = path.join(dir, "cursor", "agent")
    const refusedRun = await resolveAgents(["cursor"], { cursor: { ...DEFAULT_TEMPLATES.cursor, bin } }, { pathVar: "", cwd: dir })
    expect(refusedRun.refused[0]?.reason).toMatch(/uses --force.*allowBypass/)

    const allowed = await resolveAgents(["cursor"], { cursor: { ...DEFAULT_TEMPLATES.cursor, bin, allowBypass: true } }, { pathVar: "", cwd: dir })
    expect(allowed.ready[0]?.warnings.join(" ")).toMatch(/running with --force/)
  })

  it("warns about a bare Cursor `agent` even when it is not Grok", async () => {
    const dir = await tempDir()
    await executable(path.join(dir, "bin", "agent"))
    const { ready } = await resolveAgents(["cursor"], { cursor: { ...DEFAULT_TEMPLATES.cursor, allowBypass: true } }, { pathVar: path.join(dir, "bin"), cwd: dir })
    expect(ready[0]?.warnings.join(" ")).toMatch(/bare name `agent`/)
  })

  it("refuses an id with no template", async () => {
    const { refused } = await resolveAgents(["gemini"], {}, { pathVar: "", cwd: "/" })
    expect(refused[0]?.reason).toMatch(/No template for agent "gemini"/)
  })
})
