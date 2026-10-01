import { describe, expect, it } from "vitest"
import { classifyCommand, classifyFileWrite, denyMessage, type Rule } from "../../integrations/claude-code/hooks/guard.ts"

const JOB = "/work/session/shipboard/harbor-notes-3f2a--tint-the-pier-n-77de"
const ctx = (cwd = "/work/session") => ({ cwd, jobDir: JOB, home: "/Users/someone" })
const rule = (command: string, cwd?: string): Rule | null => classifyCommand(command, ctx(cwd))?.rule ?? null

describe("push tripwire", () => {
  it.each([
    "git push",
    "git push origin main",
    "git push origin HEAD:main",
    `git -C ${JOB} push`,
    "git -C ../other push origin HEAD:main",
    "git --no-pager push",
    "/usr/bin/git push",
    "cd x && git push",
    "cd x; git push",
    "ls && git push origin main || true",
    "git status\ngit push",
    "(cd sub && git push)",
    '"git" push',
    "'git' 'push'",
    "g\\it pu\\sh",
    "$'\\x67it' push",
    'git "push"',
    "GIT_TRACE=1 git push",
    "env GIT_TRACE=1 git push",
    "sudo -u me git push",
    "command git push",
    "nohup git push &",
    "time git push",
    "timeout 30 git push",
    'bash -c "git push"',
    "sh -c 'cd /tmp && git push'",
    'bash -lc "git push origin main"',
    'eval "git push"',
    "eval git push",
    "echo hi $(git push)",
    "echo `git push`",
    'echo "$(git push)"',
    "git send-pack http://x main",
    "git subtree push --prefix site origin main",
    "echo origin | xargs git push",
    "find . -maxdepth 0 -exec git push \\;",
    'echo "git push" | bash',
    "printf 'git push origin main' | sh",
    "bash <<'EOF'\ngit status\ngit push\nEOF",
    "bash <<< 'git push'",
  ])("denies %j", (command) => {
    expect(rule(command)).toBe("push")
  })

  it.each(["git push --force", "git push -f origin main", "git push origin +main", "git push --force-with-lease", "git push -uf origin main"])(
    "denies the force push %j",
    (command) => {
      expect(rule(command)).toBe("force-push")
    },
  )

  it.each(["$GIT push", "$(which git) push origin main", '"$GIT" push', "git $SUB origin"])("denies the run-time command %j", (command) => {
    expect(rule(command)).toBe("dynamic")
  })

  it.each([
    "git status",
    "git stash push -m wip",
    "git stash push",
    "npm run push",
    "docker push registry/image:1",
    'echo "git push"',
    "echo git push",
    'grep -r "git push" README.md',
    "pushd /tmp && ls && popd",
    'git commit -m "explain why git push is blocked"',
    "git log --grep=push",
    "git remote -v",
    "git remote get-url origin",
    "git remote show origin",
    "git config --get remote.origin.url",
    "git config remote.origin.url",
    'git config user.name "Claude"',
    "git fetch origin",
    "git -c core.pager=cat log",
    "cat <<EOF\ngit push\nEOF",
    "printf 'git push\\n' > notes.txt",
    "git diff HEAD~1 -- site/index.html",
    "# git push\nls",
    "",
  ])("allows %j", (command) => {
    expect(rule(command)).toBeNull()
  })

  it.each([
    ["git remote add evil https://evil.example/x.git", "remote"],
    ["git remote set-url origin https://evil.example/x.git", "remote"],
    ["git remote rename origin upstream", "remote"],
    ["git remote remove origin", "remote"],
    ["git config remote.origin.url https://evil.example/x.git", "remote"],
    ["git config --add remote.origin.pushurl https://evil.example/x.git", "remote"],
    ["git config --unset remote.origin.url", "remote"],
    ["git config url.https://evil.example/.insteadOf http://127.0.0.1:8787/", "remote"],
    ["git config --global credential.helper store", "remote"],
    ["git config set remote.origin.url x", "remote"],
    ["git config --remove-section remote.origin", "remote"],
    ["git config --edit", "remote"],
    ['git -c http.extraHeader="Authorization: Basic eDp5" fetch', "remote"],
    ["git -c alias.p=push p", "remote"],
    ["git --config-env=http.extraHeader=TOKEN fetch", "remote"],
    ["git credential fill", "credential"],
    ["git credential-osxkeychain get", "credential"],
  ])("denies %j as %s", (command, expected) => {
    expect(rule(command)).toBe(expected)
  })

  describe("git reset --hard", () => {
    it("is allowed inside the job's working copy", () => {
      expect(rule("git reset --hard", JOB)).toBeNull()
      expect(rule("git reset --hard HEAD~1", `${JOB}/site`)).toBeNull()
      expect(rule(`cd ${JOB} && git reset --hard`)).toBeNull()
      expect(rule("cd shipboard/harbor-notes-3f2a--tint-the-pier-n-77de && git reset --hard")).toBeNull()
      expect(rule(`git -C ${JOB} reset --hard`)).toBeNull()
      expect(rule(`git --work-tree=${JOB} reset --hard`)).toBeNull()
    })

    it("is refused anywhere else", () => {
      expect(rule("git reset --hard")).toBe("reset")
      expect(rule("git reset --hard", "/work/elsewhere")).toBe("reset")
      expect(rule("git -C /work/other reset --hard")).toBe("reset")
      expect(rule("cd .. && git reset --hard", JOB)).toBe("reset")
      expect(rule(`cd ${JOB}-copy && git reset --hard`)).toBe("reset")
      expect(rule("cd ~/code && git reset --hard")).toBe("reset")
      expect(rule(`(cd /work/other && git reset --hard); git reset --hard`, JOB)).toBe("reset")
    })

    it("is refused when the directory cannot be worked out", () => {
      expect(rule("cd - && git reset --hard", JOB)).toBe("reset")
      expect(rule('git -C "$DIR" reset --hard', JOB)).toBe("reset")
      expect(rule("cd $(mktemp -d) && git reset --hard", JOB)).toBe("reset")
    })

    it("does not care about soft or mixed resets", () => {
      expect(rule("git reset --soft HEAD~1", "/work/elsewhere")).toBeNull()
      expect(rule("git reset HEAD site/index.html", "/work/elsewhere")).toBeNull()
    })

    it("restores the directory when a subshell closes", () => {
      expect(rule(`(cd /work/other && ls) && git reset --hard`, JOB)).toBeNull()
    })
  })

  it("refuses commands that read shipboard tokens or call the runner API", () => {
    expect(rule("echo $SHIPBOARD_RUNNER_TOKEN")).toBe("token")
    expect(rule("printenv SHIPBOARD_TOKEN")).toBe("token")
    expect(rule("curl -X POST http://127.0.0.1:8787/api/runner/jobs/x/credentials")).toBe("token")
    expect(rule("curl http://127.0.0.1:8787/api/projects/harbor-notes-3f2a")).toBeNull()
  })

  it("refuses edits inside .git but not .gitignore", () => {
    expect(classifyFileWrite(`${JOB}/.git/config`, ctx())?.rule).toBe("git-dir")
    expect(classifyFileWrite(".git/hooks/pre-push", ctx(JOB))?.rule).toBe("git-dir")
    expect(classifyFileWrite(`${JOB}/site/index.html`, ctx())).toBeNull()
    expect(classifyFileWrite(`${JOB}/.gitignore`, ctx())).toBeNull()
  })

  it("tells Claude what to do instead", () => {
    const job = { attemptId: "harbor-notes-3f2a--tint-the-pier-n-77de", dir: JOB }
    const push = denyMessage({ rule: "push", detail: "git push" }, job)
    expect(push).toContain("mcp__shipboard__push")
    expect(push).toContain(job.attemptId)
    expect(denyMessage({ rule: "force-push", detail: "git push" }, job)).toContain("re-run")
    expect(denyMessage({ rule: "reset", detail: "/x" }, job)).toContain(JOB)
    expect(denyMessage({ rule: "remote", detail: "git remote add" }, job)).toContain("git remote add")
  })
})
