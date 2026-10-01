// Settings come from the plugin's userConfig options first (register(on, options): see
// https://code.claude.com/docs/en/plugins/mods/reference.md#files and
// https://code.claude.com/docs/en/plugins/manifest-reference.md#user-configuration), then from
// SHIPBOARD_* environment variables, which suit `claude --plugin-dir` sessions.

import type { PluginOptions } from "./mods"

export const DEFAULT_URL = "http://127.0.0.1:8787"

type Source = "option" | "env" | "default" | "unset"

export type Config = {
  url: string
  runnerToken?: string
  boardToken?: string
  project?: string
  autoclaim: boolean
  /** Where each value came from (never the value), for /shipboard status. */
  sources: { url: Source; runnerToken: Source; boardToken: Source; project: Source }
  problems: string[]
}

export type EnvValues = {
  url?: string
  runnerToken?: string
  boardToken?: string
  project?: string
  autoclaim?: string
}

export function configOf(options: PluginOptions, env: EnvValues): Config {
  const pick = (option: unknown, fromEnv: string | undefined): { value?: string; source: Source } => {
    if (typeof option === "string" && option.trim() !== "") return { value: option.trim(), source: "option" }
    if (fromEnv !== undefined && fromEnv.trim() !== "") return { value: fromEnv.trim(), source: "env" }
    return { source: "unset" }
  }
  const url = pick(options.url, env.url)
  const runnerToken = pick(options.runner_token, env.runnerToken)
  const boardToken = pick(options.board_token, env.boardToken)
  const project = pick(options.project, env.project)
  const problems: string[] = []

  let base = url.value ?? DEFAULT_URL
  try {
    const parsed = new URL(base)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("not http")
    if (parsed.username || parsed.password) throw new Error("credentials in the URL")
    base = parsed.href.replace(/\/+$/, "")
  } catch {
    problems.push(`The board URL ${JSON.stringify(base)} is not an http(s) URL without credentials; using ${DEFAULT_URL}.`)
    base = DEFAULT_URL
  }

  return {
    url: base,
    runnerToken: runnerToken.value,
    boardToken: boardToken.value,
    project: project.value,
    autoclaim: options.autoclaim === true || /^(?:1|true|yes)$/i.test(env.autoclaim ?? ""),
    sources: {
      url: url.value ? url.source : "default",
      runnerToken: runnerToken.source,
      boardToken: boardToken.source,
      project: project.source,
    },
    problems,
  }
}
