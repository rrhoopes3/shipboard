import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { lastParagraph, parseOutcome, type ParseInput } from "../../runner/outcome.ts"

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "outcomes")
const fixture = (name: string): string => fs.readFileSync(path.join(dir, name), "utf8")

function input(stdout: string, extra: Partial<ParseInput> = {}): ParseInput {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, ...extra }
}

describe("claude-json", () => {
  it("reads a successful run", () => {
    const out = parseOutcome("claude-json", input(fixture("claude-success.json")))
    expect(out).toMatchObject({
      ok: true,
      reason: "end_turn",
      sessionId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f",
      costUsd: 0.1834,
      turns: 9,
      denials: 1,
    })
    expect(out.summary).toContain("Tinted the pier name teal")
  })

  it("takes the summary from errors[] when an error subtype has no result", () => {
    const out = parseOutcome("claude-json", input(fixture("claude-max-turns.json"), { exitCode: 1 }))
    expect(out).toMatchObject({ ok: false, reason: "max_turns", turns: 41, costUsd: 0.9241 })
    expect(out.summary).toBe("Reached maximum number of turns (40)")
  })

  it("maps the budget subtype", () => {
    const out = parseOutcome("claude-json", input(fixture("claude-budget.json"), { exitCode: 1 }))
    expect(out).toMatchObject({ ok: false, reason: "budget" })
  })

  it("treats a failed login printed as an is_error result as auth", () => {
    const out = parseOutcome("claude-json", input(fixture("claude-auth.json"), { exitCode: 1 }))
    expect(out).toMatchObject({ ok: false, reason: "auth" })
    expect(out.summary).toContain("Invalid API key")
  })

  it("maps error_during_execution to agent_error", () => {
    const out = parseOutcome("claude-json", input(fixture("claude-during-execution.json"), { exitCode: 1 }))
    expect(out).toMatchObject({ ok: false, reason: "agent_error", summary: "API Error: 529 Overloaded" })
  })

  it("is not ok when the JSON says success but the process failed", () => {
    const out = parseOutcome("claude-json", input(fixture("claude-success.json"), { exitCode: 143 }))
    expect(out.ok).toBe(false)
  })

  it("finds the result line after stray warnings", () => {
    const out = parseOutcome("claude-json", input(`warning: something\n${fixture("claude-success.json")}`))
    expect(out.ok).toBe(true)
  })

  it("reports a timeout even when output parsed", () => {
    const out = parseOutcome("claude-json", input(fixture("claude-success.json"), { timedOut: true, exitCode: 130 }))
    expect(out).toMatchObject({ ok: false, reason: "timeout", sessionId: "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f" })
  })

  it("falls back to stderr when there is no JSON", () => {
    const out = parseOutcome("claude-json", input("", { exitCode: 1, stderr: "Error: not logged in. Run claude auth login\n" }))
    expect(out).toMatchObject({ ok: false, reason: "auth" })
    const empty = parseOutcome("claude-json", input(""))
    expect(empty).toMatchObject({ ok: false, reason: "no_output" })
  })
})

describe("codex-jsonl", () => {
  it("reads a successful run", () => {
    const out = parseOutcome("codex-jsonl", input(fixture("codex-success.jsonl")))
    expect(out).toMatchObject({
      ok: true,
      reason: "end_turn",
      sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53",
      turns: 1,
      denials: 1,
      summary: "Tinted the pier name teal in site/index.html.",
    })
  })

  it("prefers the -o last-message file for the summary", () => {
    const out = parseOutcome("codex-jsonl", input(fixture("codex-success.jsonl"), { lastMessage: "From the file.\n" }))
    expect(out.summary).toBe("From the file.")
  })

  it("maps a 401 turn failure to auth", () => {
    const out = parseOutcome("codex-jsonl", input(fixture("codex-auth.jsonl"), { exitCode: 1 }))
    expect(out).toMatchObject({ ok: false, reason: "auth" })
  })

  it("maps other turn failures to agent_error", () => {
    const out = parseOutcome("codex-jsonl", input(fixture("codex-failed.jsonl"), { exitCode: 1 }))
    expect(out).toMatchObject({ ok: false, reason: "agent_error" })
    expect(out.summary).toContain("stream disconnected")
  })

  it("needs a turn.completed even on exit 0", () => {
    const lines = fixture("codex-success.jsonl").split("\n").filter((l) => !l.includes("turn.completed")).join("\n")
    expect(parseOutcome("codex-jsonl", input(lines)).ok).toBe(false)
  })

  it("survives a first line cut in half by the output cap", () => {
    const text = fixture("codex-success.jsonl")
    const out = parseOutcome("codex-jsonl", input(text.slice(30)))
    expect(out.ok).toBe(true)
  })
})

describe("grok-json", () => {
  it("accepts the snake_case end_turn that grok 1.0.44 prints", () => {
    const out = parseOutcome("grok-json", input(fixture("grok-success.json")))
    expect(out).toMatchObject({
      ok: true,
      reason: "end_turn",
      sessionId: "0199f2a4-6c1d-7e2f-8a3b-4c5d6e7f8091",
      costUsd: 0.0044676,
      turns: 5,
    })
  })

  it("does not accept the README's PascalCase EndTurn", () => {
    const pascal = fixture("grok-success.json").replace('"end_turn"', '"EndTurn"')
    expect(parseOutcome("grok-json", input(pascal)).ok).toBe(false)
  })

  it("maps max_turn_requests to max_turns but not max_tokens", () => {
    expect(parseOutcome("grok-json", input(fixture("grok-max-turns.json"))).reason).toBe("max_turns")
    const tokens = parseOutcome("grok-json", input(fixture("grok-max-tokens.json")))
    expect(tokens).toMatchObject({ ok: false, reason: "agent_error" })
    expect(tokens.summary).toContain("output token limit")
  })

  it("reads exit 1 with an auth error on stderr as auth", () => {
    const out = parseOutcome("grok-json", input("", { exitCode: 1, stderr: "Error: Authentication failed: token expired, run `grok login`\n" }))
    expect(out).toMatchObject({ ok: false, reason: "auth" })
  })

  it("reports exit 130 after a timeout as timeout", () => {
    const out = parseOutcome("grok-json", input("", { exitCode: 130, timedOut: true }))
    expect(out.reason).toBe("timeout")
  })
})

describe("cursor-json", () => {
  it("reads a successful run", () => {
    const out = parseOutcome("cursor-json", input(fixture("cursor-success.json")))
    expect(out).toMatchObject({ ok: true, reason: "end_turn", sessionId: "c6b62c6f-7ead-4fd6-9922-e952131177ff" })
    expect(out.summary).toContain("no other files changed")
  })

  it("uses stderr on failure, where Cursor prints no JSON", () => {
    const out = parseOutcome("cursor-json", input("", { exitCode: 1, stderr: "Error: Workspace is not trusted. Pass --trust.\n" }))
    expect(out).toMatchObject({ ok: false, reason: "agent_error" })
    expect(out.summary).toContain("Workspace is not trusted")
    expect(out.stderrTail).toContain("Workspace is not trusted")
  })

  it("maps a missing API key to auth", () => {
    const out = parseOutcome("cursor-json", input("", { exitCode: 1, stderr: "Authentication required. Set CURSOR_API_KEY or run agent login.\n" }))
    expect(out.reason).toBe("auth")
  })
})

describe("plain", () => {
  it("is ok on exit 0 and keeps the last paragraph", () => {
    const out = parseOutcome("plain", input("Working...\n\nChanged site/index.html.\nAll good.\n"))
    expect(out).toMatchObject({ ok: true, reason: "end_turn", summary: "Changed site/index.html. All good." })
  })

  it("fails on a non-zero exit", () => {
    const out = parseOutcome("plain", input("partial", { exitCode: 3, stderr: "boom\n" }))
    expect(out).toMatchObject({ ok: false, reason: "agent_error", exitCode: 3 })
    expect(out.summary).toContain("boom")
  })
})

describe("lastParagraph", () => {
  it("caps long text", () => {
    const text = "a ".repeat(1_000)
    expect(lastParagraph(text, 50).length).toBe(50)
  })
})
