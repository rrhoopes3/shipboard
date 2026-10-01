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

2026-10-01: plan only. Nothing built yet. Read [`docs/PLAN.md`](docs/PLAN.md) for the contest
rules as read from the terms PDF, the verified API surface, the schedule, and the go/no-go
gate (a working trial-merge by 2026-10-03).

> `docs/PLAN.md` was written as an internal brief and mentions paths on the author's own
> machine. Scrub it before this repo goes public for submission.

## Planned layout

```
worker/      Hono-or-plain Worker: Artifacts binding, project DO, queue consumer, board API + UI
sandbox/     Sandbox SDK task: clone fork + main, trial-merge, report clean/conflict + paths
agent/       the thin client an agent runs: mint fork, write brief, push, done
docs/        plan, demo script, rules notes
```

## Running it

Not yet. Requires a Cloudflare account on Workers Paid with the Artifacts open beta.

## License

MIT, see [LICENSE](LICENSE).
