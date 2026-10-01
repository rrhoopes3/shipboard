# PLAN — Cloudflare "next Git platform" contest entry (Artifacts open beta)

**Raised by:** operator, 2026-10-01 ("tentatively interested").
**Status:** brief + Grok review folded in (addendum at the foot, 2026-10-01). Nothing built, no Cloudflare account changes, no wrangler on the box. **Read the addendum first; it supersedes Gate 0, the stretch list, and open question 3.**
**Repo:** none yet. If this goes ahead: a new repo (`sites/` is wrong — it is not a site; use
`~/worktrees/` or a fresh `~/projects/` dir), never under a Caddy docroot.

---

## The contest in one paragraph

Cloudflare Artifacts is a versioned filesystem that speaks Git, one repo per project / user /
session / agent task, backed by Durable Objects. Open beta on Workers Paid. They are running a
two-week contest for a "GitHub-shaped product for an agent-heavy world". Blog:
https://blog.cloudflare.com/next-git-platform-on-cloudflare/ · page:
https://www.cloudflare.com/git-competition/ · rules PDF:
https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf

## Hard facts from the rules PDF (read 2026-10-01, not from the blog)

| Item | Rule |
|---|---|
| Window | 2026-10-01 09:00 EDT → **2026-10-14 23:59 PDT** |
| Eligibility | legal resident of **US or Canada**, 18+. Not Cloudflare staff/family, not government employees. |
| Entries | **one submission per entrant** |
| Must use | Cloudflare Workers **and** Artifacts; project "must enable multiple agents working on changes concurrently" |
| Deliverables | application form on the contest site + 5–10 min demo video + source repo + run instructions + `LICENSE` (MIT / Apache-2.0 / BSD-2 / BSD-3) |
| Judging | **50 %** originality + quality of the prototype for agent-oriented collaboration · **25 %** multi-agent concurrency, coordination, context preservation, review, conflict handling · **25 %** ease of use / UX. Each 1–5. Tie-break = the 50 % bucket. |
| Finalists | 3 teams, notified before Cloudflare Connect; **10-min live presentation on stage, Moscone West SF, 2026-10-21**. Winner must be physically present. Travel + hotel for up to 2 people per team "may" be provided. |
| Prize | $25k Cloudflare credits (12-month validity) + VIP speakers dinner |
| IP | entrant keeps the project. Cloudflare gets a perpetual licence to the **video / presentation / name / likeness** for promo, and may build competing products. Submissions are not confidential. |
| Content | original work; no third-party copyrighted material; no personal attacks on products (so no "GitHub sucks" slides). |

**Gate 0 (operator):** confirm US/Canada residency and that being in SF on 10-21 is possible if
it goes that far. If either is no, stop here.

## What the API actually exposes (blog, 2026-10-01)

- Worker binding: `env.ARTIFACTS.get(name)` → project; `project.fork(id)` → workspace with its
  **own scoped Git token and remote URL**; `repo.readFile({ref, path})`; `project.info()`.
- Events via **Workers Queues**: repo created / imported / deleted / forked / pushed / cloned /
  fetched (e.g. `cf.artifacts.repo.pushed`).
- **Workers Builds**: production-branch push deploys; any other branch gets a preview URL.
- Data jurisdiction US/EU. Billing (repo ops + stored bytes) starts **2026-10-15**, i.e. the
  entire build window is free.
- **There is no merge, PR, or review primitive.** Merge is ours to build (a Worker doing git over
  HTTP with the scoped token, or a DO that owns the "main" fork and pulls from task forks).
  This is the design constraint and the opportunity: anything that assumes a merge button is
  wrong, anything that replaces the PR because there is none is the contest.

Verify all of the above against the docs before writing code; the blog is a launch post.

## The pitch (decided in chat 2026-10-01, pending operator)

**Productize what this directory already does by hand.** Brain's `handoff/`, `queue/<VERB>-*.md`,
and the `bot-msg.md` freeze board are a working multi-agent (Claude, Grok, Cursor, Codex)
collaboration protocol with a human gate. Most entrants will theorize; we have a year of the
real artifact. The demo opens on this repo.

Core = **intent-first forks + a ship board**:

1. **Intent-first fork.** An agent task starts as `project.fork(taskId)`. The fork's first commit
   is a structured brief (`.brief.md` or JSON: task, constraints, acceptance check, paths it
   expects to touch) — the `queue/FIX-*.md` card moved into the repo. The scoped token is handed
   to the agent; the coordinator never sees the agent's creds and vice versa.
2. **Push → digest.** A Queue consumer on `repo.pushed` reads the brief + diff (`readFile` on
   both refs), produces a short "does the diff satisfy the brief" review, records build /
   preview status from Workers Builds, and trial-merges against the current main fork.
3. **Ship board.** One page per project: each open fork with brief, digest, preview URL,
   build state, conflict state, and **one button**. This is "keep agent context so a human
   can still decide what ships" made literal. State lives in a Durable Object per project.
4. **Conflict = re-run, not resolve.** If a fork no longer merges cleanly, the board offers
   "rebase by re-running the agent against the new main with its brief" instead of a 3-way
   merge UI. Agents are cheap; merges are not. (This is the originality point; land it in the
   video.)

Stretch, only if the core is done by ~10-09:

- **File leases.** The brief's expected paths become leases in the project DO; a second agent
  asking for the same path gets queued or warned. Live ownership map on the board. Replaces
  the manual freeze board.
- **Speculative merge matrix.** Trial-merge every open fork against every other and show a
  compatibility grid; the human picks a merge-set.

## Demo (5–10 min, scripted)

1. 30 s: this repo's `handoff/` + `queue/` as the problem statement ("we already do this by
   hand with four agents").
2. Create project, spawn 3 agents (Claude Code, Codex, Grok via `claude -p` / CLI) on three
   briefs, each on its own fork with its own token. Show the tokens are distinct and scoped.
3. Pushes land; board fills with digests and preview URLs live.
4. Two forks conflict; show re-run-against-new-main instead of a merge editor.
5. Human ships two, parks one. Production branch push → Workers Builds deploy.

Record with real agents, no faked output; judges score "quality of the prototype".

## Schedule (13 days, solo + agents)

| Dates | Work |
|---|---|
| 10-01 → 10-02 | Gate 0. Workers Paid plan on the Cloudflare account (own account/token, **never** the Caddy DNS-01 token). Read Artifacts docs, confirm the binding + Queue event shape, spike `fork` + push with a scoped token from this box. |
| 10-03 → 10-06 | Core: fork-with-brief, push consumer, trial-merge Worker, ship board UI. |
| 10-07 → 10-09 | Wire real agents, conflict re-run path, polish UX (25 % of the score). |
| 10-10 → 10-11 | Stretch or cut. README + run instructions + LICENSE. |
| 10-12 → 10-13 | Record and edit the video. Two days, not an evening. |
| 10-14 | Submit before 23:59 PDT. One shot; the form is one entry per person. |

## Box rules that apply

- Install wrangler / `cf` per-user (`npx` or `~/.local`), **not** `npm i -g` into the nvm Node
  22 that every unit runs on (`queue/RESEARCH-cloudflare-cf-cli.md` has the same rule).
- A new Cloudflare API token for this, stored in `/etc/app-envs/` if any box-side service
  needs it; agent-side tokens in the project are **Artifacts' per-fork tokens**, never account
  tokens.
- Nothing from this project under `sites/` or a Caddy block. The board is a Worker, it lives
  on Cloudflare.
- Keep FD24 / production repos out of the demo. Use this Brain repo (public-safe content only;
  check `handoff/` for anything that should not be on a conference screen) or a throwaway.

## Open questions

- Residency / travel (Gate 0).
- Which account: the one holding the FD24 zones, or a separate one for the contest? Separate
  is cleaner for the credits and for keeping prod zones away from a beta product.
- Does Artifacts' Git endpoint accept a push from a plain `git` client with the scoped token
  (needed for real Claude Code / Codex agents), or only from Workers? Decides whether agents
  run here or inside Workers.
- Team: solo entry, or is there a second person worth adding for the stage slot?

## Decision needed

Operator says go / no-go by **2026-10-03**; after that the 13-day plan does not fit.

---

## Addendum 2026-10-01 — Grok review + doc verification (Claude)

Grok reviewed the brief the same day. The rules table and the pitch stood. Four changes, plus
the docs checked by hand (`developers.cloudflare.com/artifacts/llms.txt` and the pages under it).

### Verified against the docs (not the blog)

- **Plain git pushes work.** Tokens are repo-scoped Artifacts tokens (`read` / `write`), not
  Cloudflare API tokens. Format `art_v1_<secret>?expires=<unix_seconds>`. Either
  `git -c http.extraHeader="Authorization: Bearer <token>" push "$REMOTE" HEAD:main` or Basic
  auth with username `x` and the secret as password. Minted from a Worker with
  `repo.createToken("write", 3600)`. → **Open question 3 is closed:** Claude Code, Codex and
  Grok run on this box and push; nothing has to live inside a Worker.
- **Events are Cloudflare Queues event subscriptions** (`developers.cloudflare.com/queues/event-subscriptions/`),
  source `artifacts`, account-level. Types: `repo.created/deleted/forked/imported/pushed/cloned/fetched`
  plus token changes. `repo.forked` carries source and target namespace/repo. Consumer is a
  queue-consumer Worker. Grok's "unverified" flag on Queues is cleared.
- **The binding cannot read or write files.** Docs, verbatim: "The Artifacts binding creates
  and manages repos, but it cannot read or write files inside them — for that, you need Git."
  Two documented routes: `isomorphic-git` with an in-memory FS inside a Worker, or
  **Sandbox SDK** (container with a real `git` binary; template
  `cloudflare/sandbox-sdk/examples/git-repo-per-sandbox`, one Artifacts repo per sandbox).
- **ArtifactFS** exists (Go, FUSE, blobless clone that hydrates on read). Not needed here.
- **Limits:** 1 GB per repo, 32 MB per blob, 2,000 git requests / 10 s per repo, unlimited
  repos. Fork-per-task is fine at this scale.

### Changes to the plan

1. **Gate 0 no longer kills the entry.** Residency is a yes (operator). Physical presence is
   only required to *win*; finalists are notified before 10-21. Enter, and decide about SF if
   the finalist mail arrives. Portland→SF is cheap if they don't comp it.
2. **The real gate is the trial-merge spike, by 2026-10-03.** Workers have no git binary.
   Recommended route: **Sandbox SDK** does the merge (real `git merge --no-commit` /
   `git merge-tree` against the main fork, report clean/conflict + the conflicting paths back
   to the project DO); the Worker only orchestrates and renders. Fallback route: `isomorphic-git`
   `merge` in a Worker — check the installed version's conflict handling (`abortOnConflict`,
   `mergeDriver`) before trusting it, it historically threw on any conflict. If neither
   route produces a real conflict detection on 10-02/03, the entry is a dashboard and that is
   the **no-go**, not residency.
3. **Stretch is cut.** File leases and the compatibility matrix don't move the 50 % bucket.
   The re-run-instead-of-merge story does; make it unmistakable in the video.
4. **Video = scripted takes with real agent output.** No single-take live demo of three
   agents. A flaky push on 10-12 eats the buffer. No faked diffs on the board (one entry per
   person, and judges score prototype quality).
5. **Separate Cloudflare account** on Workers Paid for the contest. Nothing on the account
   that holds the production zones.
6. **Demo content:** this Brain repo only after a sweep of `handoff/` for anything that should
   not be on a conference screen, or a throwaway repo. No FD24 / production repos.

### Revised schedule

| Dates | Work |
|---|---|
| 10-01 → 10-03 | New account, Workers Paid, wrangler per-user. Spike: `fork` + plain-git push from this box with a scoped token (should be trivial), then **trial-merge via Sandbox SDK** reporting clean/conflict. Go/no-go on the merge result. |
| 10-04 → 10-07 | Core: fork-with-brief, push consumer (Queues), merge-status + preview URL into the project DO, ship board. |
| 10-08 → 10-10 | Real agents from this box; the re-run-against-new-main path; UX pass. |
| 10-11 | README, run instructions, LICENSE, freeze. |
| 10-12 → 10-13 | Record scripted takes, edit. |
| 10-14 | Submit well before 23:59 PDT. |

### Open questions (remaining)

- Which account name / email for the separate Cloudflare account.
- Solo vs. a second name for the stage slot.
- Does Sandbox SDK need anything beyond Workers Paid (container limits, regions)? Check on 10-02.

**Verdict (Grok + Claude agree):** go, on a separate account, if the merge spike works by 10-03.
