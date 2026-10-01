/**
 * Smart-HTTP git server for tests: `git http-backend` behind a Node http server that checks
 * `Authorization: Bearer <token>` the way the local host and Artifacts do. Tokens look like
 * Artifacts tokens (`art_v1_<40 hex>?expires=<unix>`), are scoped to one repo and one scope, and
 * every request is recorded so tests can see exactly which header arrived.
 *
 * Repos live at `<root>/<namespace>/<name>.git` and are served at `/git/<namespace>/<name>.git/...`.
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

export type GitRequestRecord = {
  method: string
  path: string
  repo: string
  service: "upload-pack" | "receive-pack"
  authorization: string | undefined
  status: number
}

export type GitServer = {
  url: string
  remote(repo: string, namespace?: string): string
  mint(repo: string, scope: "read" | "write", ttlSec?: number): { token: string; expiresAt: string }
  revokeAll(): void
  requests: GitRequestRecord[]
  close(): Promise<void>
}

type TokenInfo = { repo: string; scope: "read" | "write"; expires: number }

export async function startGitServer(root: string): Promise<GitServer> {
  const tokens = new Map<string, TokenInfo>()
  const requests: GitRequestRecord[] = []

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    const match = /^\/git\/([a-z0-9-]+)\/([a-z0-9-]+)\.git(\/.*)$/.exec(url.pathname)
    if (!match) {
      res.writeHead(404).end("not found")
      return
    }
    const [, namespace, repo, rest] = match as unknown as [string, string, string, string]
    const service =
      url.searchParams.get("service") === "git-receive-pack" || rest.endsWith("/git-receive-pack") ? "receive-pack" : "upload-pack"
    const authorization = req.headers.authorization
    const record: GitRequestRecord = { method: req.method ?? "GET", path: url.pathname, repo, service, authorization, status: 0 }
    requests.push(record)

    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
    const info = bearer ? tokens.get(bearer) : undefined
    const authorized =
      info !== undefined &&
      info.repo === repo &&
      info.expires * 1000 > Date.now() &&
      (service === "upload-pack" || info.scope === "write")
    if (!authorized) {
      record.status = 401
      res.writeHead(401, { "www-authenticate": 'Basic realm="shipboard"', "content-type": "text/plain" }).end("unauthorized\n")
      return
    }

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      PATH_INFO: `/${namespace}/${repo}.git${rest}`,
      REQUEST_METHOD: req.method ?? "GET",
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_USER: "runner",
      REMOTE_ADDR: "127.0.0.1",
    }
    if (req.headers["content-length"]) env.CONTENT_LENGTH = req.headers["content-length"]
    if (req.headers["content-encoding"]) env.HTTP_CONTENT_ENCODING = req.headers["content-encoding"]
    const protocol = req.headers["git-protocol"]
    if (typeof protocol === "string") env.GIT_PROTOCOL = protocol

    const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] })
    req.pipe(child.stdin)
    child.stdin.on("error", () => {})

    let headerBuf = Buffer.alloc(0)
    let headersDone = false
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersDone) {
        res.write(chunk)
        return
      }
      headerBuf = Buffer.concat([headerBuf, chunk])
      let end = headerBuf.indexOf("\r\n\r\n")
      let sepLength = 4
      if (end === -1) {
        end = headerBuf.indexOf("\n\n")
        sepLength = 2
      }
      if (end === -1) return
      headersDone = true
      const head = headerBuf.subarray(0, end).toString("utf8")
      const body = headerBuf.subarray(end + sepLength)
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of head.split(/\r?\n/)) {
        const colon = line.indexOf(":")
        if (colon === -1) continue
        const name = line.slice(0, colon).trim()
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200
        else headers[name] = value
      }
      record.status = status
      res.writeHead(status, headers)
      if (body.length > 0) res.write(body)
    })
    child.on("close", () => {
      if (!headersDone) {
        record.status = 500
        res.writeHead(500).end("http-backend produced no headers")
      } else res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}`

  return {
    url,
    remote: (repo, namespace = "local") => `${url}/git/${namespace}/${repo}.git`,
    mint(repo, scope, ttlSec = 600) {
      const expires = Math.floor(Date.now() / 1000) + ttlSec
      const token = `art_v1_${randomBytes(20).toString("hex")}?expires=${expires}`
      tokens.set(token, { repo, scope, expires })
      return { token, expiresAt: new Date(expires * 1000).toISOString() }
    },
    revokeAll: () => tokens.clear(),
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
