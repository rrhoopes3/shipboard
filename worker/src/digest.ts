import type { Brief, Digest, FileStat } from "./types.ts"

export type AcceptanceCheck = { path: string; text: string }

const CHECK = /^contains\s+(\S+)\s+"([^"]*)"\s*$/

export function parseChecks(acceptance: string): AcceptanceCheck[] {
  const checks: AcceptanceCheck[] = []
  for (const raw of acceptance.split(/\n/)) {
    const match = raw.trim().match(CHECK)
    if (match) checks.push({ path: match[1] ?? "", text: match[2] ?? "" })
  }
  return checks
}

function fileSentence(files: FileStat[]): string {
  if (files.length === 0) return "No product files changed."
  if (files.length === 1) return `Touched ${files[0]?.path}.`
  if (files.length === 2) return `Touched ${files[0]?.path} and ${files[1]?.path}.`
  return `Touched ${files.length} files.`
}

export function buildDigest(input: {
  brief: Brief
  files: FileStat[]
  checks: Array<AcceptanceCheck & { ok: boolean }>
}): Digest {
  const product = input.files.filter((file) => !file.path.startsWith(".shipboard/"))
  const touched = new Set(product.map((file) => file.path))
  const unexpectedPaths = [...touched].filter((file) => !input.brief.paths.includes(file))
  const missedPaths = input.brief.paths.filter((file) => !touched.has(file))
  const waiting = product.length === 0
  const failed = input.checks.filter((check) => !check.ok)
  let satisfies: Digest["satisfies"]
  if (input.checks.length === 0) {
    satisfies = unexpectedPaths.length > 0 || missedPaths.length > 0 ? "no" : "unchecked"
  } else if (failed.length > 0 || unexpectedPaths.length > 0 || missedPaths.length > 0) {
    satisfies = "no"
  } else {
    satisfies = "yes"
  }

  const reasons: string[] = []
  if (waiting) reasons.push("Only the brief is on this fork.")
  else reasons.push(fileSentence(product))
  if (unexpectedPaths.length > 0) reasons.push(`Outside the brief: ${unexpectedPaths.join(", ")}.`)
  if (missedPaths.length > 0) reasons.push(`Not touched yet: ${missedPaths.join(", ")}.`)
  if (input.checks.length > 0 && failed.length > 0) {
    reasons.push(`Acceptance check failed for ${failed.map((check) => check.path).join(", ")}.`)
  } else if (input.checks.length > 0) {
    reasons.push("Acceptance checks passed.")
  } else {
    reasons.push("No machine-readable acceptance check. Read the brief yourself.")
  }

  return {
    summary: reasons.join(" "),
    satisfies,
    reasons,
    files: product,
    unexpectedPaths,
    missedPaths,
    waiting,
  }
}
