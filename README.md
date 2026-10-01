# shipboard

**Agents fork. Humans ship. Nobody merges.**

An entry for Cloudflare's [next Git platform](https://blog.cloudflare.com/next-git-platform-on-cloudflare/)
contest, built on [Artifacts](https://developers.cloudflare.com/artifacts/) (one repo per agent task),
Workers, Queues event subscriptions, Sandbox SDK and a Durable Object per project.

## The idea

Multi-agent coding today is pull requests with agents bolted on. Three agents open three PRs,
two of them conflict, and a human spends the evening in a merge editor reconciling work that
no human wrote.

shipboard replaces the PR with three things:

1. **Intent-first forks.** An agent task starts as an Artifacts fork of the project. The first
   commit on the fork is a structured **brief**: task, constraints, acceptance check, the paths
   it expects to touch. The agent gets a repo-scoped write token for *that fork only*. The
   coordinator never sees the agent's credentials and the agent never sees anyone else's.
2. **Push → digest.** A Queue consumer wakes on every `repo.pushed` event, reads the brief and
   the diff, asks "does this diff satisfy the brief", trial-merges the fork against the current
   main in a Sandbox (real `git`), and records clean/conflict plus the preview URL from Workers
   Builds. All of that lands in the project's Durable Object.
3. **The ship board.** One page per project. Every open fork with its brief, its digest, its
   preview, its build state, its merge state, and **one button**. Agent context stays attached
   to the change so a human can still decide what ships.

And the part that matters: **a conflict is not something you resolve. It is something you
re-run.** When a fork no longer merges cleanly, the board offers to re-run the agent against
the new main with its original brief. Agents are cheap. Three-way merges of agent output are
not.

This is a productized version of a protocol one person has been running by hand for a year
across Claude Code, Codex, Grok and Cursor on one VPS: a `queue/` of task briefs, a
`handoff/` directory of what each agent did and left open, and a freeze board. The demo opens
there.

## Status

2026-10-01: the local board runs. Forks, briefs, digests, real `git merge-tree` trial-merges,
ship / park / re-run, and a thin agent client are in this tree. Cloudflare Artifacts, Queues,
and the Sandbox SDK are not wired — that needs a Workers Paid account on the Artifacts beta.
Until then, git on this machine stands in for Artifacts and the sandbox.

Read [`docs/PLAN.md`](docs/PLAN.md) for the contest rules, the verified API surface, and the
schedule. The go/no-go gate there is a working trial-merge; `npm test` covers that locally.

> `docs/PLAN.md` was written as an internal brief and mentions paths on the author's own
> machine. Scrub it before this repo goes public for submission.

## Layout

```
worker/      Hono app: board API, project state, local git repos
sandbox/     trial-merge via git merge-tree (Sandbox SDK stand-in)
agent/       thin client: open a fork, push files
public/      ship board
docs/        plan
```

## Running it

Requires Node 22+ and `git` on `PATH`. No Cloudflare account is required for the local board.

```bash
npm install
npm test
npm start
```

Open http://127.0.0.1:8787

The pier demo on the home page forks a small notice three ways and pushes. All three merge
into the original main. Ship two of them. The third conflicts. Re-run it. The re-run starts
from current main with the original brief. There is no merge editor.

`PORT` changes the listen port (default 8787). `SHIPBOARD_DATA` changes where repos and the
board store live (default `.data/`).

Agent client, with the server already running. It can open a fork and push. Shipping stays
on the board.

```bash
npm run agent -- list
npm run agent -- fork --project <id> --task "Set the lede" --path site/index.html --acceptance "contains site/index.html \"ready for sea\"" --agent cursor
npm run agent -- push --fork <id> --file site/index.html
npm run agent -- status --project <id>
```

Acceptance checks are one per line: `contains <path> "<text>"`. Any other acceptance text is
left for a person to read.

A Workers deploy against live Artifacts is not wired up yet.

## License

MIT, see [LICENSE](LICENSE).
