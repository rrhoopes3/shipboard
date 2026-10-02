# shipboard

**Agents fork. Humans ship. Nobody merges.**

Shipboard keeps each coding task in its own Git fork. A task starts with a committed brief; an agent works on that fork; Shipboard checks the resulting diff and whether it merges with current `main`. If it conflicts, the board offers a re-run of the same brief on a fresh fork of current `main`. A person decides which attempts to ship, park, or re-run.

## What works today

The local board runs with Node and ordinary Git. It can create or import projects, dispatch briefs, run the scripted harbor demo, accept agent pushes, produce a digest and acceptance-check result, trial-merge attempts, show diffs and previews, ship, park, and re-run. The runner claims queued jobs and launches locally installed Claude Code, Codex, Grok, Cursor, or a configured script. Each job gets a fresh clone; the runner verifies the committed brief, inspects agent changes, commits allowed work, and pushes with a token scoped to that fork.

The Cloudflare board is live at [shipboard.rick3.dev](https://shipboard.rick3.dev). A Worker serves the same Hono API and static board, Artifacts stores Git repos, Durable Objects hold project and registry state, a Workflow is configured for Artifacts push events, and an optional Workers AI reviewer adds a verdict. Trial merges use `isomorphic-git` in memory inside the project Durable Object. Production uses `PUBLIC_READ=false`, so project data, diffs, and previews need the board token; the separate dev configuration remains public-read. Deployment requires a Workers Paid account with Artifacts access. See [deployment instructions](docs/DEPLOY.md).

On 2026-10-02, the [security self-test](https://shipboard.rick3.dev/p/shipboard-security-self-ef20) shipped three tasks through live dispatch, push, assessment, and ship. Codex subagents implemented the Artifacts forks, with a coordinator handling the runner protocol manually. A completed event-triggered Workflow was also captured for one brief push. Live conflict/re-run behavior and native Claude/Grok/Cursor runner execution remain unverified. See [deployment evidence](docs/DEPLOY.md#deployment-evidence-and-remaining-checks). The Cloudflare build can be checked offline with `npm run cf:check`.

An optional [Claude Code mod](integrations/claude-code/README.md) connects an interactive Claude session to queued `claude-code` jobs. Its hooks and mock-board tests run locally; a live Claude Code session check is still pending because the CLI was unavailable on the development machine.

## Try the local board

Requires Node 22+, npm, and Git on `PATH`. The local board needs no Cloudflare account.

```bash
npm ci
npm run typecheck
npm test
npm start
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787). Create a starter project or use the harbor demo. In the demo, three scripted attempts change a small notice. Ship one of the two attempts that edit its heading; the other then conflicts and can be re-run against the new main. The footer attempt can ship independently. This demonstrates the re-run loop without a model account.

`PORT` changes the local port (default `8787`), and `SHIPBOARD_DATA` changes the local repo and state directory (default `.data/`). Without `BOARD_TOKEN`, the server binds to loopback and checks the Host and Origin of requests. Set `BOARD_TOKEN` to require authorization for mutations, `RUNNER_TOKEN` for runner routes, and `PUBLIC_READ=false` to require the board token for reads. The UI stores the board token in browser localStorage and sends it as a Bearer header. Agent-authored previews are served with a restrictive content security policy.

## Run a coding agent

Start the board, then in another terminal configure a runner. The runner token is read from the environment; it is never stored in the config file. For a local tokenless board, the runner can start without one. Copy [the example config](shipboard.runner.example.json) if you want to change templates, limits, or the set of agents.

```bash
cp shipboard.runner.example.json shipboard.runner.json
npm run runner -- --agents codex --dry-run
npm run runner -- --agents codex
```

The dry run checks executable discovery and prints the effective command without claiming a job or calling a model. Grok is found as `grok` on `PATH`, then at `~/.grok/bin/grok`; another installation can be set with `templates.grok.bin`. The runner checks whether Cursor's `agent` command actually resolves to Grok and refuses that collision.

Claude, Grok, and Cursor are refused by default. Inside an isolated VM or container, explicitly set `templates.<agent>.allowBypass` to `true` to offer them. This opt-in does not create isolation. Claude's permitted npm/node commands execute repository code; `acceptEdits`, a fresh clone, and environment filtering do not protect host files or credentials. Repository commands can read provider credentials passed to the CLI. Every Claude template requires the opt-in, including custom arguments. Grok's `--always-approve` and Cursor's `--force` also require it; Grok's best-effort `--sandbox workspace` does not waive it. Run `npm run runner -- --help` for flags and [the architecture](docs/ARCHITECTURE.md) for the job and token flow.

Dispatch a task from the board or use the CLI:

```bash
npm run agent -- list
npm run agent -- board <projectId>
npm run agent -- dispatch --project <projectId> --task "Set the lede" \
  --path site/index.html --acceptance 'contains site/index.html "ready for sea"' --agent codex
npm run agent -- status <attemptId>
```

`--path`, `--constraint`, and `--acceptance` can be repeated. Acceptance checks of the form `contains <path> "<text>"` are evaluated against the pushed tree; other acceptance text remains for human review. To work with a CLI outside the runner, dispatch to the `manual` agent with `--credentials` for a fork-scoped Git token and a clone/push recipe. Run `npm run agent -- --help` for the complete CLI.

## Layout

| Path | Purpose |
|---|---|
| `src/core/` | Shared project lifecycle, digests, Git trial merges, ship and re-run |
| `src/http/` | Hono API used by both hosts |
| `src/local/` | Node host, local bare Git repos, smart HTTP, state files |
| `src/cloudflare/` | Worker, Artifacts adapter, Durable Objects, push Workflow, optional AI reviewer |
| `runner/` | Job runner and manual agent CLI |
| `integrations/claude-code/` | Optional mod for interactive Claude Code sessions |
| `public/` | Static board UI and demo fixtures |
| `test/` | Vitest suites, including real Git flows against the local host |

The detailed behavior and API are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). [docs/PLAN.md](docs/PLAN.md) records the public project plan; [docs/DEPLOY.md](docs/DEPLOY.md) covers Cloudflare deployment and the remaining verification steps.

## License

MIT. See [LICENSE](LICENSE).
