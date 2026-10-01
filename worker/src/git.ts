import { execFile } from "node:child_process"

export type GitResult = { code: number; stdout: string; stderr: string }

export function git(cwd: string, args: string[], opts?: { allowFail?: boolean }): Promise<GitResult> {
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
        if (opts?.allowFail) {
          resolve({ code, stdout: out, stderr: errOut })
          return
        }
        const detail = errOut.trim() || err.message
        reject(new Error(detail))
      },
    )
  })
}
