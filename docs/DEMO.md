# Demo video script

The contest submission needs a **5 to 10 minute** video, uploaded as MP4, WebM, or MOV (2 GiB
maximum). A video outside that range does not meet the
[official rules](https://www.cloudflare.com/documents/build-next-gen-git-platform-competition-terms.pdf).
Aim for about 7:30, which leaves room on both sides after editing. Judging weights:

| Weight | Criterion | Where the video answers it |
|---|---|---|
| 50% | Originality and quality of the prototype for agent-oriented collaboration | 1, 2, 6 |
| 25% | Multi-agent concurrency, coordination, context preservation, review, conflict handling | 3, 4 |
| 25% | Ease of use and product experience | 3 |

Record against the deployed board at `https://shipboard.rick3.dev`. Use the local board only as a
fallback, and say so on screen.

## Running order

| # | Time | Segment | On screen |
|---|---|---|---|
| 1 | 0:00–0:30 | The problem | Landing page |
| 2 | 0:30–1:15 | The rule | Landing page hero and the four steps |
| 3 | 1:15–3:30 | Three agents, one conflict | Harbor demo on the deployed board |
| 4 | 3:30–5:30 | Real agents in parallel | Board plus the runner terminal |
| 5 | 5:30–6:45 | How it runs on Cloudflare | Diagram, Wrangler, Workflows dashboard |
| 6 | 6:45–7:30 | What it enables | Shipped lane, main history, repo link |

## 1. The problem (0:30)

Landing page, top of the hero.

> When several agents work on one repo at once, their changes collide. Someone, human or agent,
> then has to resolve the conflicts and understand both sides. That gets harder with every agent you add.

Do not name or criticize other products. The rules forbid attacks on competitor products.

## 2. The rule (0:45)

Point at the hero card, then the four numbered steps under it.

> Shipboard has one rule. Every agent task is a fork whose first commit is its brief: the task,
> constraints, acceptance checks, and paths. When a fork stops merging, Shipboard doesn't repair
> it. It drops the diff and runs the same brief again on the new main. You get a Ship button, not a
> merge editor.

Make the point that the brief is the durable thing. The diff is disposable because an agent can
write it again.

## 3. Three agents, one conflict (2:15)

This is the core of the video. Do it in one continuous take if possible.

1. Click **Run the harbor demo**. Three scripted agents fork the notice board at once. The cards
   show in **Agent working** with timers, then move to **Ready to ship** within seconds.
   > Three agents, three forks of the same main, all at once. Each one edits the same small notice.
2. Open the **Add the night clerk footer** card. Show **BRIEF · FIRST COMMIT** with its sha, then
   **On brief 1/1** and **Clean · `<main sha>`**.
   > Every push is read against its brief and trial-merged against current main, with real Git.
3. Click **Brief** and show the constraints, the acceptance check (`passed`), and the paths. Click
   **Diff**, then **Preview** ("Sandboxed. Nothing in agent output can run here.").
4. Click **Ship to main** on the footer. Main's sha changes in the header. The toast reads
   "Every other ready attempt was re-checked against the new main."
5. Click **Ship to main** on **Rename the pier mark to the night board**. **Tint the pier name in
   channel teal** jumps to **Needs re-run** with "Conflicts with main" on `site/index.html`.
   > Two agents changed the same heading. One shipped, so the other no longer merges. Nobody is
   > going to resolve that.
6. Click **Re-run on main**. Attempt 1 shows as discarded with **Dropped diff**. Attempt 2 is a
   fresh fork of the new main. The brief shows **same bytes in both forks**, under a new commit sha
   because its parent changed.
   > The old diff is never merged. The same brief runs again on the main that exists now.
7. When attempt 2 reaches **Ready to ship**, ship it. All three are in **Shipped**. Open **Main
   preview**.

## 4. Real agents in parallel (2:00)

The scripted agents prove the loop. This segment shows real coding agents on Artifacts forks.

1. Create a project with **Starter site** on the home page.
2. Press **N** (**Dispatch a brief**) and dispatch three briefs back to back. Give two of them the
   same path, so the second one shipped will conflict. Use acceptance lines of the form
   `contains site/index.html "..."` so the digest can check them.
3. Cut to the runner terminal. It claims all the jobs, and each runs in its own clone:
   `npm run runner -- --url https://shipboard.rick3.dev --agents claude,codex,grok,cursor --concurrency 4`.
   Claude Code, Grok, and Cursor need the `allowBypass` opt-in (see below). Say:
   > The runner holds the tokens. The agents never see one. The runner checks the committed brief
   > before the agent starts, and the board flags any file the brief didn't name.
4. Speed up the waiting and label it on screen ("4× speed" or similar). As pushes land, show a
   digest and, if Workers AI answered, the **Review** block with its verdict.
5. Ship two. Re-run the one that conflicts. It goes back to the same agent on the new main.

If real agents cannot be run in time, replace this segment with the board's record of Shipboard's
own security fixes, `shipboard-security-self-ef20`. Three fixes were dispatched, pushed, reviewed,
and shipped on the deployed board. Describe that run accurately: Codex subagents wrote the fixes
and a coordinator handled the runner protocol by hand. Do not present it as the runner launching
agents.

## 5. How it runs on Cloudflare (1:15)

One diagram slide, then two short terminal shots.

- **Worker** serves the Hono API and the static board.
- **Artifacts** holds one repo per project and one fork per attempt.
- **ProjectDO**, one Durable Object per project, holds the board state. It runs trial merges and
  ship merges in memory with `isomorphic-git`.
- An Artifacts **push event** starts the `shipboard-push` **Workflow**, which tells the project's
  Durable Object about the push.
- **Workers AI** optionally adds a review verdict.

Terminal: `npx wrangler artifacts repos list --namespace shipboard` (one repo per attempt) and
`npx wrangler workflows instances list shipboard-push` (one instance per push). Dashboard: a
Workflow instance whose trigger source is `event`.

## 6. What it enables (0:45)

Show the **Shipped** lane, then main's history: one brief file and one merge commit per shipped
change.

> Main ends up as an audit trail: one brief per change, one merge commit per ship. Adding agents
> doesn't add merge work. A conflict costs one re-run.

End card: `github.com/rrhoopes3/shipboard`, MIT, and "runs locally with `npm ci && npm start`".

## Before recording

- [x] **Rehearse segment 3 on Cloudflare.** Done on production on 2026-10-04; see
      [DEPLOY.md](DEPLOY.md#deployment-evidence-and-remaining-checks). Every harbor run adds a
      project with four attempt repos.
- [x] **Get a runner with real agents working (segment 4).** Done on 2026-10-04: all four agents
      pushed and shipped through the runner on the VPS. Codex runs as is. The other three are
      refused until `shipboard.runner.json` opts in, and Cursor on that VPS also needs a template
      that drops `--sandbox enabled`:

      ```json
      {
        "url": "https://shipboard.rick3.dev",
        "agents": ["claude", "codex", "grok", "cursor"],
        "concurrency": 4,
        "templates": {
          "claude": { "allowBypass": true },
          "grok": { "allowBypass": true },
          "cursor": { "allowBypass": true, "bin": "cursor-agent" }
        }
      }
      ```

      With the opt-in, those agents run repository commands without per-command approval, as the
      runner's OS user. Load `SHIPBOARD_RUNNER_TOKEN` into the runner's environment, run
      `--dry-run`, then rehearse one job per agent before the take.
- [ ] Make `github.com/rrhoopes3/shipboard` public. The submission form asks for the repository
      URL, and the end card shows it.
- [ ] Decide which projects should be visible on the home page before the take.
- [ ] Unlock the board through the `#unlock=` bookmark before you start recording. Keep the board
      token, `SHIPBOARD_RUNNER_TOKEN`, and `wrangler secret` output off screen. While locked, the
      production board's banner says every brief, diff, and preview is readable, but production
      reads need the token (`public/js/auth.js`, `authBanner`). Fix that copy or keep it out of
      the shot.
- [x] Rehearse every terminal command in segment 5. Recorded on the VPS on 2026-10-04.

## Recording

- 1920×1080, browser zoom set so card text is readable. Pick one theme for the whole video.
- Capture the screen with OBS. Every shot of the board, terminal, or dashboard must be a real
  capture. Generated video, if any, belongs only on a title card.
- No third-party music, footage, or artwork without permission (rules, section 4).
- Label sped-up footage on screen.
- Check the final length is between 5:00 and 10:00. Export MP4, under 2 GiB.
