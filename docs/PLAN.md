# Shipboard project plan

Shipboard is an agent-oriented Git board built around one rule: when an attempt conflicts with current `main`, re-run its committed brief on a new fork. Keep the brief; discard the stale diff. A human chooses when to ship, park, or re-run.

The project was started for Cloudflare's 2026 [next Git platform contest](https://blog.cloudflare.com/next-git-platform-on-cloudflare/). The contest calls for concurrent agent work on Workers and Artifacts. The source repository, run instructions, license, and a demo are part of the intended submission. Refer to the [contest page](https://www.cloudflare.com/git-competition/) for current terms and deadlines.

## Current implementation

- The local Node host supports the full brief → fork → push → digest → trial merge → ship or re-run loop, including a scripted demo that needs no model account.
- The Cloudflare host is implemented using a Worker, Artifacts repos, Durable Objects, an Artifacts push Workflow, and an optional Workers AI reviewer. Trial merges use `isomorphic-git` in memory. A live deployment and end-to-end Cloudflare verification are still pending.
- The local runner launches installed coding-agent CLIs in isolated clones. It verifies the committed brief before work, withholds Git tokens from agents, checks changed paths, and pushes allowed changes itself.
- The board UI shows task lanes, attempt history, digests, diffs, and sandboxed file previews.

## Remaining work

1. Validate the Cloudflare build and then verify fork, push detection, trial merge, re-run, and ship on a Workers Paid account with Artifacts access.
2. Exercise the intended demo with real agents and capture reproducible run instructions and results.
   Run the interactive Claude Code mod in a live Claude session as well; it currently has local
   hook and mock-board coverage but no live CLI verification.
3. Review the public repository and record a short demo that shows a conflict followed by re-running the same brief on current `main`.

The current behavior is specified in [ARCHITECTURE.md](ARCHITECTURE.md); local usage is in the [README](../README.md), and Cloudflare setup is in [DEPLOY.md](DEPLOY.md). This plan describes work remaining, not a claim that the board is already deployed.
