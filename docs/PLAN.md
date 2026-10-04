# Shipboard project plan

Shipboard is an agent-oriented Git board built around one rule: when an attempt conflicts with current `main`, re-run its committed brief on a new fork. Keep the brief; discard the stale diff. A human chooses when to ship, park, or re-run.

The project was started for Cloudflare's 2026 [next Git platform contest](https://blog.cloudflare.com/next-git-platform-on-cloudflare/). The contest calls for multiple agents working on changes concurrently, built on Workers and Artifacts. A submission needs the source repository with a LICENSE file (MIT here), instructions for running the project, and a **5 to 10 minute** demo video uploaded as MP4, WebM, or MOV (2 GiB maximum). Submissions close October 14, 2026 at 11:59 PM PDT. Finalists are scored on originality and quality of the prototype for agent-oriented collaboration (50%); multi-agent concurrency, coordination, context preservation, review, and conflict handling (25%); and ease of use (25%). This summary was taken from the [official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf) on 2026-10-02. The rules govern; see the [contest page](https://www.cloudflare.com/git-competition/) for updates.

## Current implementation

- The local Node host supports the full brief → fork → push → digest → trial merge → ship or re-run loop, including a scripted demo that needs no model account.
- The Cloudflare host is implemented using a Worker, Artifacts repos, Durable Objects, an Artifacts push Workflow, and an optional Workers AI reviewer. Trial merges use `isomorphic-git` in memory. It is live at [shipboard.rick3.dev](https://shipboard.rick3.dev), where dispatch, push detection, trial merge, conflict, re-run, and ship were verified on 2026-10-02 and 2026-10-04 (see [DEPLOY.md](DEPLOY.md#deployment-evidence-and-remaining-checks)).
- The local runner launches installed coding-agent CLIs in isolated clones. It verifies the committed brief before work, withholds Git tokens from agents, checks changed paths, and pushes allowed changes itself.
- The board UI shows task lanes, attempt history, digests, diffs, and sandboxed file previews.

## Remaining work

1. Run the interactive Claude Code mod in a live Claude session. It has local hook and mock-board
   coverage but no live CLI verification.
2. Submit the 5–10 minute demo recorded from [DEMO.md](DEMO.md). It shows four agents working
   concurrently and a conflict followed by re-running the same brief on current `main`.

The current behavior is specified in [ARCHITECTURE.md](ARCHITECTURE.md); local usage is in the [README](../README.md), and Cloudflare setup is in [DEPLOY.md](DEPLOY.md).
