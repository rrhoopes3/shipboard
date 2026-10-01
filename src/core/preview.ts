import { assertSafeRel } from "./names.ts"
import type { ArtifactsPort } from "./ports.ts"
import { contentTypeFor } from "./views.ts"

/** Resolve a preview path within one repo head, including directory index pages. */
export async function readPreview(
  artifacts: ArtifactsPort,
  repo: string,
  sha: string,
  path: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  const rel = path.replace(/^\/+/, "")
  const candidates: string[] = []
  if (!rel) candidates.push("index.html")
  else {
    let safe: string
    try {
      safe = assertSafeRel(rel, { allowDir: true, allowSpaces: true })
    } catch {
      return null
    }
    if (safe.endsWith("/")) candidates.push(`${safe}index.html`)
    else candidates.push(safe, `${safe}/index.html`)
  }
  for (const candidate of candidates) {
    const body = await artifacts.readFile(repo, sha, candidate)
    if (body) return { body, contentType: contentTypeFor(candidate) }
  }
  return null
}
