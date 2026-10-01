/** The shared API, mounted for the Worker. Kept out of worker.ts so the Worker module exports only handlers and classes. */

import type { Hono } from "hono"
import { createApi } from "../http/api.ts"
import type { Env } from "./env.ts"
import { workerLog } from "./env.ts"
import { CloudflareHost } from "./host.ts"

/** Paths the API answers. Everything else belongs to the static assets. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/preview/")
}

/**
 * Built per request, so Durable Object stubs never outlive the request that made them. No
 * `localHosts`: the local Host/Origin guard is for a tokenless board on 127.0.0.1, while on
 * Cloudflare the board and runner tokens are required. No `serveStatic`: assets are served first.
 */
export function appFor(env: Env): Hono {
  return createApi(new CloudflareHost(env), { log: workerLog })
}
