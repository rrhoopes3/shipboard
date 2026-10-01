import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { runProcess, tail } from "../../runner/proc.ts"

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const stubborn = path.join(fixtures, "stubborn.mjs")
const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shipboard-proc-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function eventuallyDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir() }

describe("runProcess", () => {
  it("escalates SIGINT -> SIGTERM -> SIGKILL to the whole process group on timeout", async () => {
    const dir = await tempDir()
    const log = path.join(dir, "signals.log")
    const res = await runProcess({ bin: process.execPath, args: [stubborn, log, "hard"], cwd: dir, env, timeoutMs: 400, graceMs: 300 })
    const pids = JSON.parse(res.stdout.trim().split("\n")[0] ?? "{}") as { parent: number; child: number }

    expect(res.timedOut).toBe(true)
    expect(res.signal).toBe("SIGKILL")
    expect(res.durationMs).toBeGreaterThanOrEqual(900)
    expect(await fs.readFile(log, "utf8")).toBe("parent SIGINT\nparent SIGTERM\n")
    expect(await eventuallyDead(pids.parent)).toBe(true)
    expect(await eventuallyDead(pids.child)).toBe(true)
  })

  it("kills a child that outlives a parent ended by SIGTERM", async () => {
    const dir = await tempDir()
    const log = path.join(dir, "signals.log")
    const res = await runProcess({ bin: process.execPath, args: [stubborn, log, "soft"], cwd: dir, env, timeoutMs: 300, graceMs: 300 })
    const pids = JSON.parse(res.stdout.trim().split("\n")[0] ?? "{}") as { parent: number; child: number }
    expect(res.timedOut).toBe(true)
    expect(res.signal).toBe("SIGTERM")
    expect(await eventuallyDead(pids.child)).toBe(true)
  })

  it("stops at SIGINT when the agent honours it", async () => {
    const dir = await tempDir()
    const log = path.join(dir, "signals.log")
    const res = await runProcess({ bin: process.execPath, args: [stubborn, log, "polite"], cwd: dir, env, timeoutMs: 300, graceMs: 5_000 })
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).toBe(130)
    expect(res.durationMs).toBeLessThan(3_000)
  })

  it("cleans up children left running after the leader exits", async () => {
    const dir = await tempDir()
    const res = await runProcess({ bin: process.execPath, args: [stubborn, path.join(dir, "x"), "straggler"], cwd: dir, env, timeoutMs: 10_000, graceMs: 500 })
    const pids = JSON.parse(res.stdout.trim().split("\n")[0] ?? "{}") as { parent: number; child: number }
    expect(res.exitCode).toBe(0)
    expect(res.timedOut).toBe(false)
    expect(res.durationMs).toBeLessThan(5_000)
    expect(await eventuallyDead(pids.child)).toBe(true)
  })

  it("aborts like a timeout when the signal fires", async () => {
    const dir = await tempDir()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const res = await runProcess({
      bin: process.execPath,
      args: [stubborn, path.join(dir, "s.log"), "polite"],
      cwd: dir,
      env,
      timeoutMs: 30_000,
      graceMs: 300,
      signal: controller.signal,
    })
    expect(res.aborted).toBe(true)
    expect(res.timedOut).toBe(false)
    expect(res.exitCode).toBe(130)
  })

  it("passes exactly the given env, writes stdin, and keeps the tail of capped output", async () => {
    const dir = await tempDir()
    const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.stringify({keys:Object.keys(process.env).filter(k=>!k.startsWith("__CF")).sort(),stdin:s}));process.stdout.write("x".repeat(5000)+"END")})'
    const res = await runProcess({
      bin: process.execPath,
      args: ["-e", script],
      cwd: dir,
      env: { PATH: env.PATH, ONLY_THIS: "1" },
      stdin: "hello",
      timeoutMs: 10_000,
      maxStdoutBytes: 1_000,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdoutTruncated).toBe(true)
    expect(res.stdout.length).toBe(1_000)
    expect(res.stdout.endsWith("END")).toBe(true)

    const full = await runProcess({ bin: process.execPath, args: ["-e", script], cwd: dir, env: { PATH: env.PATH, ONLY_THIS: "1" }, stdin: "hello", timeoutMs: 10_000 })
    const first = JSON.parse(full.stdout.split("\n")[0] ?? "{}") as { keys: string[]; stdin: string }
    expect(first.keys).toEqual(["ONLY_THIS", "PATH"])
    expect(first.stdin).toBe("hello")
  })

  it("reports a missing binary as a spawn error", async () => {
    const dir = await tempDir()
    const res = await runProcess({ bin: path.join(dir, "nope"), args: [], cwd: dir, env, timeoutMs: 1_000 })
    expect(res.spawnError).toMatch(/ENOENT/)
    expect(res.exitCode).toBeNull()
  })

  it("never uses a shell", async () => {
    const dir = await tempDir()
    const res = await runProcess({ bin: "echo", args: ["$HOME", "; rm -rf /"], cwd: dir, env, timeoutMs: 5_000 })
    expect(res.stdout.trim()).toBe("$HOME ; rm -rf /")
  })
})

describe("tail", () => {
  it("cuts at a line start near the cut point", () => {
    expect(tail("aaaa\nbbbb\ncccc", 9)).toBe("cccc")
    expect(tail("short", 10)).toBe("short")
  })
})
