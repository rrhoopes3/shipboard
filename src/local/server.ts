/**
 * `npm start`: the local board on 127.0.0.1. Mounts the git route, the shared API and the UI in
 * ./public. Env: PORT (8787), SHIPBOARD_DATA (./.data), BOARD_TOKEN, RUNNER_TOKEN, PUBLIC_READ.
 */

import fs from "node:fs/promises"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { serve } from "@hono/node-server"
import type { Clock, Logger } from "../core/ports.ts"
import type { AgentInfo } from "../core/types.ts"
import { contentTypeFor } from "../core/views.ts"
import { createApi } from "../http/api.ts"
import type { StaticFile } from "../http/api.ts"
import { checkGit } from "./gitexec.ts"
import { createGitHandler } from "./gitserver.ts"
import { LocalHost, consoleLog } from "./host.ts"

export type LocalServerOptions = {
  /** 0 picks a free port. Default 8787. */
  port?: number
  dataDir?: string
  publicDir?: string
  boardToken?: string
  runnerToken?: string
  publicRead?: boolean
  agents?: AgentInfo[]
  clock?: Clock
  log?: Logger
  tickMs?: number
  allowInsecureImport?: boolean
}

export type LocalServer = {
  url: string
  port: number
  host: LocalHost
  close(): Promise<void>
}

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_PUBLIC_DIR = path.resolve(here, "../../public")

/** Serves files under `root` only; never follows a path outside it. */
export function staticFiles(root: string): (urlPath: string) => Promise<StaticFile | null> {
  const base = path.resolve(root)
  return async (urlPath) => {
    let rel: string
    try {
      rel = decodeURIComponent(urlPath)
    } catch {
      return null
    }
    if (rel.includes("\0")) return null
    let full = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`)
    if (full !== base && !full.startsWith(`${base}${path.sep}`)) return null
    try {
      let stat = await fs.stat(full)
      if (stat.isDirectory()) {
        full = path.join(full, "index.html")
        stat = await fs.stat(full)
      }
      if (!stat.isFile()) return null
      const real = await fs.realpath(full)
      const realBase = await fs.realpath(base)
      if (real !== realBase && !real.startsWith(`${realBase}${path.sep}`)) return null
      return { body: new Uint8Array(await fs.readFile(real)), contentType: contentTypeFor(real) }
    } catch {
      return null
    }
  }
}

export async function startLocalServer(opts: LocalServerOptions = {}): Promise<LocalServer> {
  await checkGit()
  const log = opts.log ?? consoleLog
  const host = await LocalHost.open({
    dataDir: opts.dataDir ?? path.resolve(".data"),
    boardToken: opts.boardToken,
    runnerToken: opts.runnerToken,
    publicRead: opts.publicRead,
    agents: opts.agents,
    clock: opts.clock,
    log,
    tickMs: opts.tickMs,
    allowInsecureImport: opts.allowInsecureImport,
  })
  let port = opts.port ?? 8787
  const git = createGitHandler({
    root: host.artifacts.root,
    namespace: host.artifacts.namespace,
    tokens: host.artifacts.tokens,
    onPush: (repo, after) => host.onRepoPush(repo, after),
    track: (work) => host.schedule(() => work),
    log,
  })
  const api = createApi(host, {
    serveStatic: staticFiles(opts.publicDir ?? DEFAULT_PUBLIC_DIR),
    localHosts: () => [`127.0.0.1:${port}`, `localhost:${port}`],
    log,
  })
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve(
      {
        fetch: (request: Request) => (new URL(request.url).pathname.startsWith("/git/") ? git(request) : api.fetch(request)),
        port,
        hostname: "127.0.0.1",
      },
      () => resolve(s),
    )
    s.once("error", reject)
  })
  port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`
  host.setBaseUrl(url)
  host.start()
  return {
    url,
    port,
    host,
    close: async () => {
      await host.stop()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Idle keep-alive sockets would otherwise hold close() open until they time out.
        if ("closeAllConnections" in server) server.closeAllConnections()
      })
    },
  }
}

async function main(): Promise<void> {
  const env = process.env
  const port = env.PORT ? Number(env.PORT) : 8787
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, not "${env.PORT}".`)
  const server = await startLocalServer({
    port,
    dataDir: path.resolve(env.SHIPBOARD_DATA || ".data"),
    boardToken: env.BOARD_TOKEN || undefined,
    runnerToken: env.RUNNER_TOKEN || undefined,
    publicRead: env.PUBLIC_READ ? env.PUBLIC_READ !== "false" : true,
  })
  const auth = server.host.boardToken ? "board token required for actions" : "no tokens set: open on this machine only"
  console.log(`Shipboard board ${server.url} (${auth})`)
  const shutdown = () => {
    void server.close().then(() => process.exit(0))
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
