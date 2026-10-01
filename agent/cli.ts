import fs from "node:fs/promises"

const argv = process.argv.slice(2)
const command = argv[0] ?? "help"

function flag(name: string): string | undefined {
  const index = argv.lastIndexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

function multi(name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1]) {
      values.push(argv[i + 1] ?? "")
      i += 1
    }
  }
  return values
}

function required(name: string): string {
  const value = flag(name)
  if (!value || value.startsWith("--")) {
    console.error(`Missing ${name}`)
    process.exit(1)
  }
  return value
}

const base = (flag("--url") ?? process.env.SHIPBOARD_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "")

async function api(pathname: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${base}${pathname}`, init)
  const text = await res.text()
  let data: unknown = {}
  if (text) {
    try {
      data = JSON.parse(text) as unknown
    } catch {
      data = { error: text }
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : res.statusText
    console.error(message)
    process.exit(1)
  }
  return data
}

function help(): void {
  console.log(`shipboard agent

  npm run agent -- list
  npm run agent -- status --project <id>
  npm run agent -- fork --project <id> --task "..." --path <repo-path> [--acceptance "contains <path> \\"text\\""] [--constraint "..."] [--agent cursor]
  npm run agent -- push --fork <id> --file <repo-path>

The server must already be running. --file is read from the current directory and written to that same path on the fork.
Shipping stays on the board. This client only opens a fork and pushes.
`)
}

if (command === "help" || command === "--help" || command === "-h") {
  help()
} else if (command === "list") {
  const projects = (await api("/api/projects")) as Array<{
    id: string
    name: string
    open: number
    conflict: number
  }>
  if (projects.length === 0) console.log("No projects.")
  for (const project of projects) {
    console.log(`${project.id}\t${project.name}\topen ${project.open}\tconflict ${project.conflict}`)
  }
} else if (command === "status") {
  const board = (await api(`/api/projects/${required("--project")}`)) as {
    forks: Array<{ id: string; action: string; agent: string; task: string; digest: { summary: string } }>
  }
  if (board.forks.length === 0) console.log("No forks.")
  for (const fork of board.forks) {
    console.log(`${fork.id}\t${fork.action}\t${fork.agent}\t${fork.task}`)
    console.log(`  ${fork.digest.summary}`)
  }
} else if (command === "fork") {
  const body = {
    task: required("--task"),
    acceptance: flag("--acceptance") ?? "",
    agent: flag("--agent") ?? "cursor",
    constraints: multi("--constraint"),
    paths: multi("--path"),
  }
  const board = (await api(`/api/projects/${required("--project")}/forks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as { forks: Array<{ id: string; previewUrl: string; createdAt: string }> }
  const created = [...board.forks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
  if (!created) {
    console.error("Fork was not created.")
    process.exit(1)
  }
  console.log(created.id)
  console.log(created.previewUrl)
} else if (command === "push") {
  const repoPath = required("--file")
  const content = await fs.readFile(repoPath, "utf8")
  const fork = required("--fork")
  await api(`/api/forks/${fork}/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: flag("--message"),
      files: [{ path: repoPath.replace(/\\/g, "/"), content }],
    }),
  })
  console.log(`Pushed ${repoPath} to ${fork}`)
} else {
  console.error(`Unknown command: ${command}`)
  help()
  process.exit(1)
}
