/** Digest rules from docs/ARCHITECTURE.md: what changed, against what the brief asked for. Pure. */

import { assertSafeRel, briefPath, listPhrase } from "./names.ts"
import type { Brief, CheckResult, Digest, FileStat } from "./types.ts"

export type AcceptanceCheck = { path: string; text: string }

const CHECK = /^contains\s+(\S+)\s+"(.*)"\s*$/

/** `contains <path> "<text>"` lines. Everything else in the acceptance text is for a human. */
export function parseChecks(acceptance: string): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = []
  for (const raw of acceptance.split(/\r?\n/)) {
    const match = raw.trim().match(CHECK)
    if (match) checks.push({ path: match[1] ?? "", text: match[2] ?? "" })
  }
  return checks
}

/** The repo path a check reads, or null when the path is unsafe (such a check always fails). */
export function checkPath(check: AcceptanceCheck): string | null {
  try {
    return assertSafeRel(check.path)
  } catch {
    return null
  }
}

/** Case-insensitive: on macOS and Windows `.SHIPBOARD/x` lands in `.shipboard/` when checked out. */
export function isControlPath(path: string): boolean {
  return path.toLowerCase().startsWith(".shipboard/")
}

/** A brief path ending in `/` covers everything under it; otherwise the match is exact. */
export function coveredBy(path: string, briefPaths: string[]): boolean {
  return briefPaths.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p))
}

function filesSentence(files: FileStat[]): string {
  if (files.length === 0) return "No files changed beyond the brief."
  if (files.length <= 2) return `Touched ${listPhrase(files.map((f) => f.path))}.`
  return `Touched ${files.length} files.`
}

export function buildDigest(input: {
  brief: Brief
  files: FileStat[]
  checks: CheckResult[]
  baseSha: string
  headSha: string
  /** False when the attempt rewrote its own brief file. That counts as a control-path change. */
  briefIntact?: boolean
}): Digest {
  const own = briefPath(input.brief.id)
  const files = input.files.filter((file) => file.path !== own).sort((a, b) => (a.path < b.path ? -1 : 1))
  const controlPaths = files.filter((file) => isControlPath(file.path)).map((file) => file.path)
  if (input.briefIntact === false) controlPaths.unshift(own)
  const product = files.filter((file) => !isControlPath(file.path))
  const unexpectedPaths = product.filter((file) => !coveredBy(file.path, input.brief.paths)).map((file) => file.path)
  const missedPaths = input.brief.paths.filter((p) =>
    p.endsWith("/") ? !product.some((file) => file.path.startsWith(p)) : !product.some((file) => file.path === p),
  )
  const failed = input.checks.filter((check) => !check.ok)

  const concerns: string[] = []
  if (controlPaths.length > 0) concerns.push(`Changed shipboard control files: ${listPhrase(controlPaths)}.`)
  if (failed.length > 0) {
    const where = listPhrase([...new Set(failed.map((check) => check.path))])
    concerns.push(failed.length === 1 ? `Acceptance check failed for ${where}.` : `${failed.length} acceptance checks failed (${where}).`)
  }
  if (unexpectedPaths.length > 0) concerns.push(`Outside the brief: ${listPhrase(unexpectedPaths)}.`)
  if (missedPaths.length > 0) concerns.push(`Not touched: ${listPhrase(missedPaths)}.`)

  let satisfies: Digest["satisfies"]
  if (concerns.length > 0) satisfies = "no"
  else if (input.checks.length > 0) satisfies = "yes"
  else satisfies = "unchecked"

  let verdict: string
  if (concerns.length > 0) verdict = concerns[0] ?? ""
  else if (input.checks.length === 1) verdict = "Acceptance check passed."
  else if (input.checks.length > 1) verdict = `All ${input.checks.length} acceptance checks passed.`
  else verdict = "No machine-readable acceptance check. Read the diff."

  const lead = filesSentence(files)
  const reasons = [lead, ...(concerns.length > 0 ? concerns : [verdict])]
  return {
    summary: `${lead} ${verdict}`,
    satisfies,
    reasons,
    files,
    checks: input.checks,
    unexpectedPaths,
    missedPaths,
    controlPaths,
    headSha: input.headSha,
    baseSha: input.baseSha,
  }
}
