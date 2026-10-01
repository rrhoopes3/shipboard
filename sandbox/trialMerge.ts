import { execFile } from "node:child_process"

/**
 * Trial-merge a fork against a base ref with the real git binary.
 * This is the local stand-in for the Cloudflare Sandbox SDK job:
 * `git merge-tree` reports clean or conflict plus the conflicted paths.
 * It does not write to the worktree and it does not open a merge editor.
 */

type GitResult = { code: number; stdout: string; stderr: string }

const TREE_OID = /^[0-9a-f]{40}$/

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 10_000_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "")
        const errOut = String(stderr ?? "")
        if (!err) {
          resolve({ code: 0, stdout: out, stderr: errOut })
          return
        }
        const raw = (err as { code?: unknown }).code
        const code = typeof raw === "number" ? raw : 1
        resolve({ code, stdout: out, stderr: errOut })
      },
    )
  })
}

export async function trialMerge(
  repoDir: string,
  baseRef: string,
  headRef: string,
): Promise<{ state: "clean" | "conflict"; paths: string[] }> {
  const result = await git(repoDir, ["merge-tree", "--write-tree", "--name-only", baseRef, headRef])
  if (result.code !== 0 && result.code !== 1) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-4).join(" ")
    throw new Error(detail || "Trial-merge failed.")
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const oid = lines[0] ?? ""
  if (!TREE_OID.test(oid)) {
    const detail = result.stderr.trim().split(/\r?\n/).slice(-4).join(" ")
    throw new Error(detail || "Trial-merge did not return a tree.")
  }
  const paths = result.code === 0 ? [] : lines.slice(1).filter(isConflictPath)
  return { state: result.code === 0 ? "clean" : "conflict", paths }
}

function isConflictPath(line: string): boolean {
  if (!line || /\s/.test(line)) return false
  if (line.startsWith("Auto-merging") || line.startsWith("CONFLICT")) return false
  return true
}
