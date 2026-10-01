/**
 * The local git route: `/git/<namespace>/<repo>.git/*`, smart HTTP only, proxied to
 * `git http-backend` as CGI. Every request needs a repo-scoped token from the TokenStore, as a
 * Bearer header (full token) or a Basic password (the secret before `?expires=`). Read scope covers
 * upload-pack; receive-pack needs write. After a push lands, `onPush` reports the new main.
 */

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { isRepoName } from "../core/names.ts"
import type { Logger } from "../core/ports.ts"
import type { TokenStore } from "./artifacts.ts"
import { gitBinary, gitEnv, runGit } from "./gitexec.ts"

export type GitServerOptions = {
  /** Directory holding `<namespace>/<name>.git`. */
  root: string
  namespace: string
  tokens: TokenStore
  /** Called after a receive-pack moved `refs/heads/main`. */
  onPush?: (repo: string, after: string) => void
  /** Receives the promise that settles once a push has been handed to `onPush` (or found to change nothing). */
  track?: (work: Promise<unknown>) => void
  log?: Logger
}

const ROUTE = /^\/git\/([A-Za-z0-9._-]+)\/([a-z0-9-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } })
}

function credentialFrom(header: string | null): string | null {
  if (!header) return null
  const bearerMatch = /^Bearer\s+(\S+)\s*$/i.exec(header)
  if (bearerMatch?.[1]) return bearerMatch[1]
  const basicMatch = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header)
  if (!basicMatch?.[1]) return null
  const decoded = Buffer.from(basicMatch[1], "base64").toString("utf8")
  const colon = decoded.indexOf(":")
  return colon >= 0 ? decoded.slice(colon + 1) || null : null
}

async function mainHead(dir: string): Promise<string | null> {
  const out = await runGit(["-C", dir, "rev-parse", "--verify", "--quiet", "refs/heads/main"], { allowFail: true })
  const sha = out.stdout.toString("utf8").trim()
  return out.code === 0 && sha ? sha : null
}

function headerEnd(buf: Buffer): { at: number; length: number } | null {
  const crlf = buf.indexOf("\r\n\r\n")
  const lf = buf.indexOf("\n\n")
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { at: crlf, length: 4 }
  if (lf >= 0) return { at: lf, length: 2 }
  return null
}

export function createGitHandler(opts: GitServerOptions): (request: Request) => Promise<Response> {
  const projectRoot = path.join(path.resolve(opts.root), opts.namespace)

  return async (request) => {
    const url = new URL(request.url)
    const match = ROUTE.exec(url.pathname)
    if (!match) return text(404, "Not found.")
    const [, namespace, repo, rest] = match
    if (!namespace || !repo || !rest || namespace !== opts.namespace || !isRepoName(repo)) return text(404, "Not found.")

    let need: "read" | "write"
    const service = url.searchParams.get("service")
    if (rest === "info/refs" && request.method === "GET") {
      if (service === "git-upload-pack") need = "read"
      else if (service === "git-receive-pack") need = "write"
      else return text(403, "Only smart HTTP is served here.")
    } else if (request.method === "POST" && rest === "git-upload-pack") need = "read"
    else if (request.method === "POST" && rest === "git-receive-pack") need = "write"
    else return text(405, "Method not allowed.")

    const token = credentialFrom(request.headers.get("authorization"))
    if (!token) return text(401, "Authentication required.", { "WWW-Authenticate": 'Basic realm="shipboard"' })
    const verdict = opts.tokens.check(token, repo, need)
    if (verdict === "unknown") return text(401, "That token is unknown or expired.", { "WWW-Authenticate": 'Basic realm="shipboard"' })
    if (verdict === "forbidden") return text(403, `That token does not grant ${need} access to ${repo}.`)

    const dir = path.join(projectRoot, `${repo}.git`)
    try {
      await fs.stat(path.join(dir, "HEAD"))
    } catch {
      return text(404, "No such repo.")
    }

    const pushing = rest === "git-receive-pack"
    const before = pushing ? await mainHead(dir) : null
    const env = gitEnv({
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repo}.git/${rest}`,
      REMOTE_USER: "shipboard-token",
      REMOTE_ADDR: "127.0.0.1",
      REQUEST_METHOD: request.method,
      QUERY_STRING: url.search.replace(/^\?/, ""),
      CONTENT_TYPE: request.headers.get("content-type") ?? "",
    })
    // http-backend inflates gzip bodies itself when told the encoding.
    const encoding = request.headers.get("content-encoding")
    if (encoding) env.HTTP_CONTENT_ENCODING = encoding
    const protocol = request.headers.get("git-protocol")
    if (protocol) env.GIT_PROTOCOL = protocol
    const length = request.headers.get("content-length")
    if (length && !request.headers.get("transfer-encoding")) env.CONTENT_LENGTH = length

    const child = spawn(gitBinary(), ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8")
    })
    child.stdin.on("error", () => {})
    if (request.body && request.method === "POST") {
      Readable.fromWeb(request.body as WebReadableStream<Uint8Array>)
        .on("error", () => child.kill())
        .pipe(child.stdin)
    } else {
      child.stdin.end()
    }

    const exited = new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 1))
      child.on("error", () => resolve(1))
    })

    if (pushing) {
      const settled = exited.then(async (code) => {
        if (code !== 0) {
          opts.log?.warn("git receive-pack failed", { repo, code, stderr: stderr.trim().slice(0, 400) })
          return
        }
        const after = await mainHead(dir)
        if (after && after !== before) opts.onPush?.(repo, after)
      })
      // The client sees its push succeed before http-backend exits, so let the host wait on the hand-off.
      opts.track?.(settled)
    }

    return new Promise<Response>((resolve) => {
      let head = Buffer.alloc(0)
      const stdout = child.stdout
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = headerEnd(head)
        if (!end) {
          if (head.length > 64 * 1024) {
            child.kill()
            resolve(text(502, "git http-backend sent no headers."))
          }
          return
        }
        stdout.off("data", onData)
        stdout.off("end", onEnd)
        stdout.pause()
        const headers = new Headers()
        let status = 200
        for (const line of head.subarray(0, end.at).toString("latin1").split(/\r?\n/)) {
          const colon = line.indexOf(":")
          if (colon <= 0) continue
          const name = line.slice(0, colon).trim()
          const value = line.slice(colon + 1).trim()
          if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200
          else headers.append(name, value)
        }
        const rest = head.subarray(end.at + end.length)
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if (rest.length) controller.enqueue(new Uint8Array(rest))
            stdout.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk))
              if ((controller.desiredSize ?? 1) <= 0) stdout.pause()
            })
            stdout.on("end", () => controller.close())
            stdout.on("error", (err) => controller.error(err))
          },
          pull() {
            stdout.resume()
          },
          cancel() {
            child.kill()
          },
        })
        resolve(new Response(status === 204 || status === 304 ? null : body, { status, headers }))
      }
      const onEnd = () => {
        opts.log?.warn("git http-backend ended without headers", { repo, stderr: stderr.trim().slice(0, 400) })
        resolve(text(502, "git http-backend failed."))
      }
      stdout.on("data", onData)
      stdout.on("end", onEnd)
    })
  }
}
