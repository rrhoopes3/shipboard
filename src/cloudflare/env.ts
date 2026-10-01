/**
 * The Worker's bindings, as declared in wrangler.jsonc. Written by hand rather than generated:
 * `wrangler types` turns vars into literal types ("true") and cannot see secrets.
 * test/cloudflare/config.test.ts checks that this list and wrangler.jsonc agree.
 */

import type { Logger } from "../core/ports.ts"

export type Env = {
  ARTIFACTS: Artifacts
  ASSETS: Fetcher
  /** ProjectDO, one per project id (`idFromName(projectId)`). */
  PROJECT: DurableObjectNamespace
  /** RegistryDO, a singleton (`idFromName("registry")`). */
  REGISTRY: DurableObjectNamespace
  PUSH_WORKFLOW?: Workflow
  /** Workers AI. Optional: without it (or with REVIEW_MODEL empty or "off") there are no reviews. */
  AI?: Ai
  /** "false" makes reads need the board token. Anything else (or unset) leaves reads open. */
  PUBLIC_READ?: string
  REVIEW_MODEL?: string
  /** The Artifacts namespace the ARTIFACTS binding points at. Shown in /api/config and checked on push events. */
  ARTIFACTS_NAMESPACE?: string
  /** Secrets: `wrangler secret put BOARD_TOKEN` / `RUNNER_TOKEN`. */
  BOARD_TOKEN?: string
  RUNNER_TOKEN?: string
}

export const DEFAULT_NAMESPACE = "shipboard"
export const REGISTRY_NAME = "registry"

export function namespaceOf(env: Pick<Env, "ARTIFACTS_NAMESPACE">): string {
  const value = env.ARTIFACTS_NAMESPACE?.trim()
  return value ? value : DEFAULT_NAMESPACE
}

/** Workers Logs indexes JSON lines, so each entry is one object. */
export const workerLog: Logger = {
  info: (message, data) => console.log(JSON.stringify({ level: "info", message, ...data })),
  warn: (message, data) => console.warn(JSON.stringify({ level: "warn", message, ...data })),
  error: (message, data) => console.error(JSON.stringify({ level: "error", message, ...data })),
}
