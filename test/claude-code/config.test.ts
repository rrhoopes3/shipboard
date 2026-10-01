import { describe, expect, it } from "vitest"
import { parseArgs } from "../../integrations/claude-code/hooks/command.ts"
import { configOf, DEFAULT_URL } from "../../integrations/claude-code/hooks/config.ts"
import { invalidJob } from "../../integrations/claude-code/hooks/session.ts"
import type { ClaimedJob } from "../../integrations/claude-code/hooks/contract.ts"

describe("/shipboard arguments", () => {
  it("reads a dispatch with quoting, repeated flags and --flag=value", () => {
    expect(
      parseArgs(`dispatch "Tint the pier name" --path site/index.html --path=site/pier.css -c "No new files." --acceptance 'contains site/index.html "pier"' -a 'contains site/pier.css "teal"' --project harbor-notes-3f2a --no-start`),
    ).toEqual({
      verb: "dispatch",
      start: false,
      dispatch: {
        task: "Tint the pier name",
        paths: ["site/index.html", "site/pier.css"],
        constraints: ["No new files."],
        acceptance: 'contains site/index.html "pier"\ncontains site/pier.css "teal"',
        project: "harbor-notes-3f2a",
      },
    })
  })

  it("joins an unquoted task", () => {
    const parsed = parseArgs("dispatch Tint the pier --path site/index.html")
    expect(parsed.verb === "dispatch" && parsed.dispatch.task).toBe("Tint the pier")
  })

  it("explains what is wrong", () => {
    expect(parseArgs("dispatch --path a")).toEqual({ verb: "error", message: "dispatch needs a task in quotes." })
    expect(parseArgs('dispatch "x" --path')).toEqual({ verb: "error", message: "--path needs a file path." })
    expect(parseArgs('dispatch "x" --force')).toEqual({ verb: "error", message: "Unknown option --force." })
    expect(parseArgs("merge")).toEqual({ verb: "error", message: 'Unknown subcommand "merge".' })
  })

  it("knows the other verbs", () => {
    expect(parseArgs("")).toEqual({ verb: "help" })
    expect(parseArgs("claim")).toEqual({ verb: "claim", start: true })
    expect(parseArgs("claim --hold")).toEqual({ verb: "claim", start: false })
    expect(parseArgs("status")).toEqual({ verb: "status" })
    expect(parseArgs("done")).toEqual({ verb: "done" })
    expect(parseArgs("pane")).toEqual({ verb: "pane" })
  })
})

describe("config", () => {
  it("prefers plugin options, then SHIPBOARD_* variables, then the local default", () => {
    const fromOptions = configOf({ url: "https://board.example.com/", runner_token: "r", project: "p" }, { url: "http://ignored", runnerToken: "env" })
    expect(fromOptions).toMatchObject({ url: "https://board.example.com", runnerToken: "r", project: "p", sources: { url: "option", runnerToken: "option", boardToken: "unset" } })
    const fromEnv = configOf({}, { url: "http://127.0.0.1:9999", boardToken: "b", autoclaim: "1" })
    expect(fromEnv).toMatchObject({ url: "http://127.0.0.1:9999", boardToken: "b", autoclaim: true, sources: { url: "env", boardToken: "env" } })
    expect(configOf({}, {})).toMatchObject({ url: DEFAULT_URL, autoclaim: false, sources: { url: "default" } })
  })

  it("refuses a board URL that is not http(s) or that carries credentials", () => {
    expect(configOf({ url: "file:///etc" }, {})).toMatchObject({ url: DEFAULT_URL, problems: [expect.stringContaining("not an http(s) URL")] })
    expect(configOf({ url: "https://user:pw@board.example.com" }, {}).url).toBe(DEFAULT_URL)
  })
})

describe("claimed job checks", () => {
  const job: ClaimedJob = {
    attemptId: "harbor-notes-3f2a--tint-the-pier-n-77de",
    projectId: "harbor-notes-3f2a",
    agent: "claude-code",
    brief: { id: "tint-the-pier-name-9c01", task: "t", constraints: [], acceptance: "", paths: [], createdAt: "x" },
    briefPath: ".shipboard/briefs/tint-the-pier-name-9c01.json",
    baseSha: "a".repeat(40),
    briefSha: "b".repeat(40),
    remote: "http://127.0.0.1:8787/git/local/harbor-notes-3f2a--tint-the-pier-n-77de.git",
    leaseExpiresAt: "x",
    attemptNumber: 1,
  }

  it("accepts a well-formed claim", () => {
    expect(invalidJob(job)).toBeNull()
  })

  it("refuses ids that would escape the working directory, and remotes that are not plain http(s)", () => {
    expect(invalidJob({ ...job, attemptId: "../../etc" })).toContain("not a shipboard attempt id")
    expect(invalidJob({ ...job, attemptId: "other-proj--x-0000" })).toContain("does not belong to project")
    expect(invalidJob({ ...job, remote: "file:///tmp/x.git" })).toContain("not http(s)")
    expect(invalidJob({ ...job, remote: "https://x:y@example.com/r.git" })).toContain("carries credentials")
    expect(invalidJob({ ...job, briefSha: "HEAD" })).toContain("not a sha")
    expect(invalidJob({ ...job, brief: { ...job.brief, id: "../x" } })).toContain("no usable id")
  })
})
