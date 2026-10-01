/**
 * Serves public/ for UI work without the board server. Client routes like /p/<id> get the app
 * shell, HTML gets the board CSP from docs/ARCHITECTURE.md (so a CSP slip shows up in the console),
 * and fixture previews get the preview CSP.
 *
 *   npx tsx test/support/serve-public.ts [port]     then open /?fixture=harbor
 */

import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BOARD_CSP, PREVIEW_CSP } from "../../src/http/api.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public")
const port = Number(process.argv[2] ?? process.env.PORT ?? 5179)

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
}

async function resolveFile(urlPath: string): Promise<string | null> {
  let rel: string
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, "")
  } catch {
    return null
  }
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) return null
  try {
    const info = await stat(full)
    return info.isDirectory() ? resolveFile(`${urlPath.replace(/\/?$/, "/")}index.html`) : full
  } catch {
    return null
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  let file = await resolveFile(url.pathname)
  const last = url.pathname.split("/").pop() ?? ""
  if (!file && !last.includes(".") && !url.pathname.startsWith("/fixtures/")) file = path.join(root, "index.html")
  if (!file) {
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "Not found." }))
    return
  }
  const type = TYPES[path.extname(file)] ?? "application/octet-stream"
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  }
  if (type.startsWith("text/html")) headers["content-security-policy"] = url.pathname.includes("/previews/") ? PREVIEW_CSP : BOARD_CSP
  res.writeHead(200, headers)
  res.end(await readFile(file))
}).listen(port, "127.0.0.1", () => console.log(`public/ on http://127.0.0.1:${port}`))
