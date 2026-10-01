# Deploying shipboard to Cloudflare

This puts the board on Workers, with project repos in Artifacts, one Durable Object per project,
and a Workflow that hears every push. Agents still run on your own machine through the runner and
talk to the deployed board over HTTPS.

## What you need

- A Cloudflare account on **Workers Paid**. Artifacts is not available on the Free plan, and
  Artifacts usage is billed from 2026-10-14.
- Node 22 or later, and `npm ci` run in this repo. `wrangler` is a dev dependency, so use it
  through `npx`.
- Optional: Workers AI on the same account, for the reviewer. The board works without it.

Nothing needs creating by hand first. The `shipboard` Artifacts namespace is created the first time
the Worker creates a repo in it. The Durable Object classes, the Workflow and the push trigger are
all created by the deploy.

> If you need the repos kept in one jurisdiction (`eu` or `us`), create the namespace yourself
> before the first deploy; it cannot be changed later:
> `curl -X POST https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -d '{"namespace":"shipboard","jurisdiction":"eu"}'`

## 1. Check the build offline

This works without logging in, and is worth running after any change to `wrangler.jsonc`:

```bash
npm run typecheck
npm test
npm run cf:check      # wrangler deploy --dry-run: bundles the Worker and validates the config
```

`cf:check` ends with `--dry-run: exiting now.` and lists the bindings: `PROJECT`, `REGISTRY`,
`PUSH_WORKFLOW`, `ARTIFACTS (shipboard)`, `AI`, `ASSETS` and three vars.

## 2. Log in

```bash
npx wrangler login
```

This opens a browser for the OAuth consent. On a machine without a browser, export
`CLOUDFLARE_API_TOKEN` (with Workers Scripts Edit, Artifacts Edit and Workers AI permissions) and
`CLOUDFLARE_ACCOUNT_ID` instead.

## 3. Set the two secrets

Make two long random tokens and keep them somewhere safe:

```bash
openssl rand -hex 32    # board token: the Ship, Park and Re-run buttons, dispatch, create
openssl rand -hex 32    # runner token: claim jobs, get git credentials, report results
```

```bash
npx wrangler secret put BOARD_TOKEN
npx wrangler secret put RUNNER_TOKEN
```

If the Worker does not exist yet, wrangler offers to create it with the secret; answer yes. Until
`BOARD_TOKEN` is set, every board action answers `503` with a sentence naming the missing secret,
so a half-configured board is never open.

## 4. Deploy

```bash
npm run deploy
```

This runs `wrangler deploy --env=''` (the top-level environment, not `dev`). It prints the URL,
for example `https://shipboard.<your-subdomain>.workers.dev`. The first deploy also applies
migration `v1` (the two SQLite-backed Durable Object classes), creates the `shipboard-push`
Workflow and registers the `cf.artifacts.repo.pushed` trigger for the namespace.

```bash
export SHIPBOARD_URL=https://shipboard.<your-subdomain>.workers.dev
export SHIPBOARD_TOKEN=<board token>
export SHIPBOARD_RUNNER_TOKEN=<runner token>
```

## 5. Verify

```bash
curl -s $SHIPBOARD_URL/api/health          # {"ok":true}
curl -s $SHIPBOARD_URL/api/config          # "mode":"cloudflare", "namespace":"shipboard", "boardAuth":true
```

Run the harbor demo. Three scripted agents fork the notice board and push, all inside the
project's Durable Object:

```bash
curl -s -X POST $SHIPBOARD_URL/api/demo \
  -H "Authorization: Bearer $SHIPBOARD_TOKEN" -H "Content-Type: application/json" -d '{}'
# {"projectId":"harbor-notes-xxxx","notice":"Three scripted agents ..."}
```

Open `$SHIPBOARD_URL` in a browser and paste the board token when the board asks for it (it is kept
in that browser's localStorage and sent as a Bearer header). Within a few seconds the three demo
attempts sit in the Ship lane. Ship two; the third moves to Re-run with a conflict on
`site/index.html`; re-run it and ship the new attempt.

Things worth looking at while you do that:

```bash
npx wrangler tail                                         # Worker and Durable Object logs (JSON lines)
npx wrangler workflows instances list shipboard-push      # one instance per push event
npx wrangler artifacts repos list --namespace shipboard   # the project repo and one repo per attempt
```

## 6. Run agents against the deployed board

On the machine where your agent CLIs are installed and logged in:

```bash
npm run runner -- --url $SHIPBOARD_URL --agents claude,codex --concurrency 2
```

The runner reads `SHIPBOARD_RUNNER_TOKEN`. `npm run runner -- --dry-run` checks the agent binaries
without claiming anything. Dispatch work from the board UI, or from the agent CLI:

```bash
npm run agent -- list
npm run agent -- dispatch --project <projectId> --task "Set the lede" \
  --path site/index.html --acceptance 'contains site/index.html "ready for sea"' --agent claude
```

The agent CLI reads `SHIPBOARD_URL` and `SHIPBOARD_TOKEN`. For an agent that pushes by itself, use
`--agent manual --credentials`. It prints a one-hour write token for that fork only, and a git
recipe that keeps the token out of argv and `.git/config`.

## A separate dev board

`env.dev` in `wrangler.jsonc` is the same Worker named `shipboard-dev`, on the Artifacts namespace
`shipboard-dev` with its own Workflow (`shipboard-dev-push`). Set its secrets with `--env dev`.

```bash
npx wrangler secret put BOARD_TOKEN --env dev
npx wrangler secret put RUNNER_TOKEN --env dev
npm run deploy:dev
npm run cf:dev        # wrangler dev --env dev
```

`wrangler dev` has no local Artifacts: the binding always talks to the real service, so it
creates real, billable repos in `shipboard-dev`. Push events never reach `wrangler dev`; the board
still notices pushes through reconcile (below).

## Troubleshooting

**A dispatch or re-run fails with "… is still being set up. Try again in a moment." (503)**
Artifacts answered `FORK_IN_PROGRESS`. shipboard retries `fork()` and the first reads of the new
repo with backoff for up to 30 s. If the fork still is not usable it deletes it and returns `503`.
Nothing is half-made on the board, and a re-run's old attempt is left as it was. Press the button
again. If it keeps happening, look in `npx wrangler tail` for `fork not usable, removing it`.

**Pushes do not show up on the board, or show up late**
Each push should start a `shipboard-push` Workflow instance:

- Check with `npx wrangler workflows instances list shipboard-push`. No instances means the
  trigger is not delivering. Check the Workflow's triggers in the dashboard, and that
  `triggers.events[0].filter.namespace` matches the `artifacts` namespace in `wrangler.jsonc`.
- An instance that `errored` shows the Durable Object's answer in its step output.

Events are not the only way pushes are noticed:

- The runner calls `POST /api/attempts/:id/pushed` itself after it pushes.
- Viewing the board reconciles every live attempt's head at most every 10 s.
- The project alarm reconciles every 30 s while a job runs, and every 60 s while an attempt is
  waiting.

So a missing trigger slows the board down; it does not lose a push. To nudge one attempt by hand:
`npm run agent -- pushed <attemptId>`.

**No reviews appear**
The reviewer is optional and fails quietly: any error, timeout (20 s) or reply that is not exactly
one JSON verdict means no review, and the lane is decided by the digest alone. `npx wrangler tail`
shows `reviewer failed` or `reviewer reply was not a verdict`. If `REVIEW_MODEL` names a model your
account cannot run, pick another text-generation model from developers.cloudflare.com/workers-ai/models
and redeploy. Set `"REVIEW_MODEL": ""` (or `"off"`) to turn reviews off. If Workers AI is not
enabled on the account at all, also remove the `"ai"` block from `wrangler.jsonc`.

**`503` "Set the BOARD_TOKEN secret …" or "Set the RUNNER_TOKEN secret …"**
The secret is missing in the environment you deployed. Run `npx wrangler secret list` (add
`--env dev` for the dev board).

**`401` "This action needs the board token."**
The browser has an old token in localStorage, or the runner is using the board URL with the wrong
variable. The runner uses `SHIPBOARD_RUNNER_TOKEN`; the agent CLI uses `SHIPBOARD_TOKEN`.

**Reads need a token**
Set `"PUBLIC_READ": "false"` in `wrangler.jsonc` vars and redeploy. The board, previews and diffs
then need the board token too.

**Importing a repo fails**
Only public `https://` URLs import. The repo's default branch must be `main`, because every fork
and ship works on `main`. A repo whose default branch is `master` is refused with a message saying
so, and the half-imported copy is deleted. Large repos can hit Artifacts' `MEMORY_LIMIT` (413).
The trial merges also hold the project's history in the Durable Object's memory (128 MB), so keep
imported projects small.

**Cleaning up**
Every attempt is a repo. Discarded attempts are kept as history; delete old ones with
`npx wrangler artifacts repos delete <name> --namespace shipboard`. `npx wrangler rollback`
returns the Worker to its previous version. Deleting the Worker does not delete Artifacts repos.
