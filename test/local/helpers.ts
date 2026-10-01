import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Clock, Logger } from "../../src/core/ports.ts"
import type { BoardView, TaskView } from "../../src/core/types.ts"
import { gitBinary } from "../../src/local/gitexec.ts"
import { startLocalServer } from "../../src/local/server.ts"
import type { LocalServer, LocalServerOptions } from "../../src/local/server.ts"

export const quiet: Logger = { info: () => {}, warn: () => {}, error: (m, d) => console.error(m, d ?? "") }

const cleanups: Array<() => Promise<void>> = []

export async function tempDir(prefix = "shipboard-test-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

export async function boot(opts: LocalServerOptions = {}): Promise<LocalServer> {
  const dataDir = opts.dataDir ?? (await tempDir())
  const publicDir = opts.publicDir ?? (await makePublic())
  const server = await startLocalServer({ port: 0, tickMs: 0, log: quiet, ...opts, dataDir, publicDir })
  cleanups.unshift(() => server.close())
  return server
}

export async function cleanup(): Promise<void> {
  for (const fn of cleanups.splice(0)) await fn().catch(() => {})
}

async function makePublic(): Promise<string> {
  const dir = await tempDir("shipboard-public-")
  await fs.writeFile(path.join(dir, "index.html"), "<!DOCTYPE html><title>Shipboard</title><div id=app></div>\n")
  await fs.writeFile(path.join(dir, "app.js"), "export {}\n")
  return dir
}

/** A clock tests can move forward. */
export class TestClock implements Clock {
  private offset = 0
  now(): Date {
    return new Date(Date.now() + this.offset)
  }
  advance(ms: number): void {
    this.offset += ms
  }
}

/** Plain git CLI with no user or system config. */
export function git(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      gitBinary(),
      args,
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Test Agent",
          GIT_AUTHOR_EMAIL: "agent@example.test",
          GIT_COMMITTER_NAME: "Test Agent",
          GIT_COMMITTER_EMAIL: "agent@example.test",
          ...opts.env,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0
        resolve({ stdout: String(stdout), stderr: String(stderr), code })
      },
    )
  })
}

export function bearer(token: string): string[] {
  return ["-c", `http.extraHeader=Authorization: Bearer ${token}`]
}

export type Api = {
  get(path: string, headers?: Record<string, string>): Promise<Response>
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  json<T = Record<string, unknown>>(res: Response): Promise<T>
}

export function api(base: string, token?: string): Api {
  const auth = (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {})
  return {
    get: (p, headers = {}) => fetch(`${base}${p}`, { headers: { ...auth(), ...headers } }),
    post: (p, body, headers = {}) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(), ...headers },
        body: body === undefined ? "{}" : JSON.stringify(body),
      }),
    json: async <T>(res: Response) => (await res.json()) as T,
  }
}

export function allTasks(board: BoardView): TaskView[] {
  return board.lanes.flatMap((lane) => lane.tasks)
}

export function taskByTitle(board: BoardView, text: string): TaskView {
  const task = allTasks(board).find((item) => item.brief.task.includes(text))
  if (!task) throw new Error(`No task matching "${text}" on the board.`)
  return task
}

export function laneOf(board: BoardView, attemptId: string): string | undefined {
  return board.lanes.find((lane) => lane.tasks.some((task) => task.current.id === attemptId))?.lane
}
