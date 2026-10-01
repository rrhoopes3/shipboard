import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { UsageError, allValues, lastValue, parseArgs } from "../../runner/args.ts"
import { ConfigError, loadConfig, parseDuration, timeoutFor } from "../../runner/config.ts"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

function load(argv: string[], files: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    argv,
    env,
    cwd: "/work",
    readFile: async (file) => {
      const text = files[file]
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" })
      return text
    },
  })
}

describe("loadConfig", () => {
  it("uses defaults when there is no config file", async () => {
    const config = await load([])
    expect(config).toMatchObject({ url: "http://127.0.0.1:8787", concurrency: 1, jobTimeoutSec: 1200, pollSec: 3, idlePollMaxSec: 15, heartbeatSec: 60, killGraceSec: 15, unsafeRepoConfig: "clean", pushPartial: false })
    expect(config.configPath).toBeUndefined()
    expect(Object.keys(config.templates).sort()).toEqual(["claude", "codex", "cursor", "grok"])
    expect(config.token).toBeUndefined()
  })

  it("layers file < env < flags", async () => {
    const file = JSON.stringify({ url: "http://file:1", concurrency: 3, agents: ["grok"], jobTimeoutSec: 600 })
    const config = await load(
      ["--url", "http://flag:3/", "--agents", "claude,codex", "--agents", "grok", "--job-timeout", "20m", "--once"],
      { "/work/shipboard.runner.json": file },
      { SHIPBOARD_URL: "http://env:2", SHIPBOARD_RUNNER_TOKEN: "tok" },
    )
    expect(config.url).toBe("http://flag:3")
    expect(config.token).toBe("tok")
    expect(config.concurrency).toBe(3)
    expect(config.agents).toEqual(["claude", "codex", "grok"])
    expect(config.jobTimeoutSec).toBe(600)
    expect(config.jobTimeoutOverrideSec).toBe(1200)
    expect(config.once).toBe(true)
    expect(config.configPath).toBe("/work/shipboard.runner.json")

    const fromEnv = await load([], { "/work/shipboard.runner.json": file }, { SHIPBOARD_URL: "http://env:2" })
    expect(fromEnv.url).toBe("http://env:2")
  })

  it("merges a template over its built-in default and resolves relative paths from the config file", async () => {
    const file = JSON.stringify({
      templates: {
        grok: { timeoutSec: 900, envSet: { RUST_LOG: "warn" } },
        demo: { kind: "script", bin: "./agents/demo.sh" },
      },
    })
    const config = await load(["--config", "/etc/sb/runner.json"], { "/etc/sb/runner.json": file })
    expect(config.templates.grok?.timeoutSec).toBe(900)
    expect(config.templates.grok?.envSet).toEqual({ RUST_LOG: "warn" })
    expect(config.templates.grok?.args).toContain("--prompt-file")
    expect(config.templates.demo).toMatchObject({ kind: "script", bin: "/etc/sb/agents/demo.sh", args: ["{prompt_file}", "{cwd}"], parser: "plain" })
    expect(timeoutFor(config, config.templates.grok!)).toBe(900)
    expect(timeoutFor({ ...config, jobTimeoutOverrideSec: 30 }, config.templates.grok!)).toBe(30)
  })

  it("rejects unknown keys, unknown placeholders and credential env passing", async () => {
    await expect(load([], { "/work/shipboard.runner.json": '{"concurency":2}' })).rejects.toThrow(/Unknown key "concurency"/)
    await expect(load([], { "/work/shipboard.runner.json": '{"templates":{"grok":{"args":["--prompt-file","{promptfile}"]}}}' })).rejects.toThrow(
      /unknown placeholder\(s\) \{promptfile\}/,
    )
    await expect(load([], { "/work/shipboard.runner.json": '{"templates":{"grok":{"envPass":["SHIPBOARD_RUNNER_TOKEN"]}}}' })).rejects.toThrow(
      /may not pass SHIPBOARD_RUNNER_TOKEN/,
    )
    await expect(load([], { "/work/shipboard.runner.json": '{"templates":{"gemini":{"bin":"gemini"}}}' })).rejects.toThrow(/kind is required/)
    await expect(load([], { "/work/shipboard.runner.json": "{not json" })).rejects.toThrow(ConfigError)
  })

  it("errors when an explicit --config is missing, but not when the default is", async () => {
    await expect(load(["--config", "/nope.json"])).rejects.toThrow(/Could not read \/nope\.json/)
    await expect(load([])).resolves.toBeDefined()
  })

  it("rejects bad flags and URLs", async () => {
    await expect(load(["--concurrency", "0"])).rejects.toThrow(UsageError)
    await expect(load(["--frobnicate"])).rejects.toThrow(/Unknown flag --frobnicate/)
    await expect(load(["--url", "ftp://x"])).rejects.toThrow(/not an http\(s\) URL/)
    await expect(load(["--url", "http://user:pass@x"])).rejects.toThrow(/must not contain credentials/)
  })

  it("parses durations", () => {
    expect(parseDuration("90", "t")).toBe(90)
    expect(parseDuration("90s", "t")).toBe(90)
    expect(parseDuration("20m", "t")).toBe(1200)
    expect(parseDuration("1h", "t")).toBe(3600)
    expect(() => parseDuration("soon", "t")).toThrow(UsageError)
  })

  it("accepts the shipped example config", async () => {
    const text = fs.readFileSync(path.join(repoRoot, "shipboard.runner.example.json"), "utf8")
    const config = await load(["--config", "/work/shipboard.runner.example.json"], { "/work/shipboard.runner.example.json": text })
    expect(config.templates.grok?.bin).toBe("/Users/grokbot5000/.grok/bin/grok")
    expect(config.templates.grok?.args).toEqual((await load([])).templates.grok?.args)
    expect(config.templates.script).toMatchObject({ kind: "script", bin: "/work/runner/note-agent.mjs" })
    expect(config.templates.cursor?.bin).toBe(path.join(os.homedir(), ".local/bin/agent"))
  })
})

describe("parseArgs", () => {
  it("keeps every value of a repeated flag and supports --flag=value", () => {
    const args = parseArgs(["dispatch", "--path", "a", "--path=b c", "--credentials", "x"], { values: ["path"], booleans: ["credentials"] })
    expect(allValues(args, "path")).toEqual(["a", "b c"])
    expect(lastValue(args, "path")).toBe("b c")
    expect(args.booleans.has("credentials")).toBe(true)
    expect(args.positionals).toEqual(["dispatch", "x"])
  })

  it("does not swallow the next flag as a value", () => {
    expect(() => parseArgs(["--task", "--path", "x"], { values: ["task", "path"], booleans: [] })).toThrow(/--task needs a value/)
    expect(() => parseArgs(["--task"], { values: ["task"], booleans: [] })).toThrow(/--task needs a value/)
    expect(allValues(parseArgs(["--constraint", "-- keep it short"], { values: ["constraint"], booleans: [] }), "constraint")).toEqual(["-- keep it short"])
  })
})
