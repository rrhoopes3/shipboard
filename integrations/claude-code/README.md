# shipboard for Claude Code

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that seats an
interactive Claude Code session on a shipboard board as the agent `claude-code`.

shipboard stands on its own: Codex, Grok and headless Claude reach the board through the runner
and never load this. The mod is only how a person's interactive session takes a brief, works it in
its own fork, pushes, and watches the board's verdict, with the same rules the runner follows.
It does no merging. Trial merges, digests, ship and re-run all happen on the board.

Needs Claude Code 2.1.287 or later (mods are on by default from that version), `git` on `PATH`,
and a shipboard server: `npm start` at the repository root, or the Worker.

## Install

For development, load the directory for one session. It reloads when a file changes:

```bash
SHIPBOARD_URL=http://127.0.0.1:8787 claude --plugin-dir integrations/claude-code
```

To install it, add this directory as a local marketplace, then install from it. In a session:

```
/plugin marketplace add ./integrations/claude-code
/plugin install shipboard@shipboard-local
```

or from your shell:

```bash
claude plugin marketplace add ./integrations/claude-code
claude plugin install shipboard@shipboard-local
```

If a session was already open, run `/reload-plugins` in it. `claude plugin validate
./integrations/claude-code` lists the events the mod hooks and the API calls it makes, without
running it.

## Configure

Plugin options come first (Claude Code asks for them when the plugin is enabled; the two tokens
are marked sensitive, so they go to the OS credential store, not `settings.json`). Environment
variables are the fallback, which suits `--plugin-dir`.

| Option | Variable | What it is |
|---|---|---|
| `url` | `SHIPBOARD_URL` | The board. Default `http://127.0.0.1:8787`. |
| `runner_token` | `SHIPBOARD_RUNNER_TOKEN` | The board's `RUNNER_TOKEN`: claim jobs, mint per-fork git tokens. |
| `board_token` | `SHIPBOARD_TOKEN` | The board's `BOARD_TOKEN`. Only `/shipboard dispatch` uses it. |
| `project` | `SHIPBOARD_PROJECT` | Default project for `/shipboard dispatch`. |
| `autoclaim` | `SHIPBOARD_AUTOCLAIM=1` | Claim the next `claude-code` job when an interactive session starts. |

A local board with no tokens configured needs neither token.

## Use

```
/shipboard claim [--no-start]
/shipboard dispatch "Tint the pier name" --path site/index.html --acceptance 'contains site/index.html "teal"' [--constraint "..."] [--project <id>] [--no-start]
/shipboard status
/shipboard done
/shipboard pane
```

- **claim** takes the oldest queued `claude-code` job (headless runners offer `claude`, so only
  this mod takes these). It clones the fork into the session directory if that is empty, otherwise
  into `./shipboard/<attemptId>`, checks the brief commit, opens the pane, and starts Claude on the
  job. `--no-start` only claims.
- **dispatch** puts a new brief on the board for `claude-code` with the board token, then claims it.
- **status** prints the configuration (never a token), the job and the board's verdict.
- **done** finishes the job: `pushed` with the last commit if Claude pushed, `no_changes` if not.

Claude pushes with the **`mcp__shipboard__push`** tool. It refuses changes under `.shipboard/`,
`.git/` and agent config directories, folds anything Claude committed into one commit with
`Shipboard-Attempt` and `Shipboard-Agent: claude-code` trailers, pushes `HEAD:main` to the job's
fork, tells the board, and returns the verdict: merge state against main, acceptance checks,
review, preview URL and the board's next action. Claude can push again after a fix.

## What it does

1. **Joins the board.** The runner protocol from `docs/ARCHITECTURE.md`: `claim` with
   `agents: ["claude-code"]` and runner id `claude-code-mod/<hostname>/<session id>`, a heartbeat
   every 60 s while the job is active, read and write credentials per job, `pushed`, `finish`.
2. **Checks the brief.** The fork's first commit after base must change only
   `.shipboard/briefs/<briefId>.json`, and hold exactly the canonical bytes of the brief that came
   with the claim. Anything else finishes the job as `brief_mismatch` before Claude sees it.
3. **Tells Claude.** The brief (task, constraints, acceptance, paths, attempt number and, for a
   re-run, why the last attempt was discarded) rides along with the next prompt as context. Later
   prompts carry one line with the board's current verdict. After `/clear` or a compaction the
   whole brief goes again.
4. **Draws the pane.** A docked pane polls `GET /api/projects/:id?since=<version>` every 3 s while
   a job is active: brief check, fork and head, clean or conflicting paths, digest and checks,
   review, preview URL, and the board's one action (Ship, Ship anyway, Re-run, working). The same
   summary sits on the status line under the prompt for terminals too narrow for a pane.

## Security

The push guard is a **tripwire**. While a job is active, a `tool.call` hook reads every Bash
command (through quotes, escapes, `&&`, subshells, `$( )`, `bash -c`, `eval`, heredocs, `xargs`,
`find -exec`) and refuses `git push` in any spelling it can see, force pushes, `git remote
add/set-url/rename/remove`, `git config` or `git -c` on remotes, URL rewrites, credentials or
aliases, `git credential`, and `git reset --hard` outside the job's working copy. Edits inside a
`.git` directory are refused too. The refusal tells Claude to call `mcp__shipboard__push` instead.
A determined command still gets past any reading of shell text: an alias, a shell function, a
script file, a variable that holds `push`. The guard is off when no job is active.

**The lock is the token.** Claude's session never holds a token that can write to anything. The
mod asks the board for a fork-scoped write token at the moment of a push, hands it to the one `git
push` child as an `http.extraHeader` in env-scoped config (`GIT_CONFIG_COUNT`), and drops it. It
is never in argv, `.git/config`, a credential helper or keychain, the transcript, or any text
Claude reads; the tests check every string and argv for every token the mock board minted. The
push always goes to the fork URL from the claim, never to a configured remote, and the mod refuses
to push at all (finishing the job as `unsafe_repo_config`) if the working copy's git config holds
URL rewrites, `http.*`, credential, proxy, hooks or include settings.

What is left: the runner token lives in the Claude Code process. Tokens given as environment
variables are removed from that process's environment at session start, so Bash children do not
inherit them, but the process's initial environment stays readable with `ps`, and a mod is not a
sandbox. Prefer the sensitive plugin options, and give interactive sessions a runner token you
can rotate. After a hot reload, tokens that came from the environment are gone; set them as
options to survive reloads.

## Board requirements

- The server's agent list must include `{ id: "claude-code", label: "Claude Code (interactive)",
  kind: "cli" }`, or dispatch rejects the agent.
- `claim` may receive an extra `attemptId` field (sent after `/shipboard dispatch`). A server that
  ignores it hands out the oldest queued `claude-code` job instead, and the mod says so.

## Develop

```bash
npx vitest run test/claude-code
npx tsc --noEmit -p integrations/claude-code
```

The tests run the hooks module under a stand-in for Claude Code's mod host (`test/claude-code/harness.ts`)
against a mock board that serves real git over smart HTTP with per-fork Basic-auth tokens
(`test/claude-code/mock-board.ts`).

`hooks/mods.d.ts` declares the slice of the mods API this mod uses, from the
[mods reference](https://code.claude.com/docs/en/plugins/mods/reference) and the published
[`claude-code.d.ts`](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts).
When Claude Code loads the directory with `--plugin-dir` it writes the full declarations for its
version into `.claude-plugin/types/` (git-ignored); trust those where they differ.
`hooks/contract.ts` copies the core types the mod reads, because an installed plugin may only
import files inside its own directory; `test/claude-code/contract.test.ts` fails to type-check if
they drift from `src/core/types.ts`.

Written against the mods docs for Claude Code 2.1.287. It has not yet run inside a live Claude
Code session; the build machine did not have the CLI.
