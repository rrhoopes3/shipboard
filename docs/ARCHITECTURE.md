# Shipboard architecture

This is the contract every part of the codebase follows. Types live in
[`src/core/types.ts`](../src/core/types.ts) and interfaces in [`src/core/ports.ts`](../src/core/ports.ts);
this document says how they behave.

## The one idea

When an attempt stops merging, shipboard does not repair it. It **discards the attempt's diff and
re-executes the brief** that was committed as that fork's first commit, on a fresh fork of the new
main. The human gets a Ship button, not a merge editor. Everything below serves that loop.

## Layout

```
src/core/        platform-neutral: model, digest, trial merge, ship, re-run, views. No node:* or cloudflare:* imports.
src/http/        Hono API shared by both hosts (createApi(host)).
src/local/       Node host: bare repos + `git http-backend`, JSON state files, in-process timers.
src/cloudflare/  Worker host: Artifacts binding, ProjectDO + RegistryDO, PushWorkflow, Workers AI reviewer.
runner/          The agent runner and the agent CLI (Node). Talks to either host over HTTP.
public/          The board UI. Static ES modules, no build step. Served by both hosts.
test/            Vitest. Core flows run against the local host with real git.
```

## Names

| Thing | Format | Example |
|---|---|---|
| Project id | `slug(name, 24)-<4 hex>`, matches `^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤ 30 chars | `harbor-notes-3f2a` |
| Project main repo | = project id | `harbor-notes-3f2a` |
| Brief id | `slug(task, 20)-<4 hex>` | `tint-the-pier-name-9c01` |
| Attempt id = fork repo | `<projectId>--<slug(task, 16)>-<4 hex>` (≤ 63 chars) | `harbor-notes-3f2a--tint-the-pier-n-77de` |
| Brief file | `.shipboard/briefs/<briefId>.json` | |

`projectIdOf(attemptId)` is the part before `--`. Every route that takes an attempt id finds the
project this way, so attempt ids are globally routable without an index. Re-runs keep the brief id
and therefore commit the **same bytes at the same path**; only one attempt per brief can ship, so
brief files never conflict with each other on main. Main accumulates one brief file per shipped
change, which is the audit trail.

The brief file is canonical JSON: `JSON.stringify({id, task, constraints, acceptance, paths, createdAt, demo?}, null, 2) + "\n"`.
Keys in that order, `demo` omitted when absent. The agent id is not in the file (a re-run may use a
different agent).

## Git engine (core/git.ts)

All object work uses **isomorphic-git** over smart HTTP with an in-memory filesystem
(`core/memfs.ts`, patched per the research: `readlink`/`symlink` present, every thrown error has
`.code`). Auth: `onAuth: () => ({ username: "x", password: token.split("?expires=")[0] })`, picking
the token for the URL being contacted. Push is protocol v1 (isomorphic-git default).

One `GitWorkspace` per project, held in memory and rebuilt on demand:
- a single object store at `/repo` with main fetched to `refs/remotes/main/main` and each attempt
  fetched to `refs/remotes/<attemptId>/main`. Shared history is stored once.
- Always full history (no shallow), because merge bases need it.
- Every operation starts with a fetch of the refs it needs; the cache only saves bandwidth.

Operations:
- `commitBrief(attempt, brief)`: fetch fork, write the brief file on top of fork main, commit
  `brief: <task>` (author `Shipboard <shipboard@users.noreply.local>`), push with a short-lived
  write token. Returns `briefSha`.
- `assess(attempt)`: fetch main + fork. `files = diffTrees(baseSha, headSha)` with line counts, no
  rename detection. Acceptance checks read file contents **at headSha**. Trial merge:
  `git.merge({ ours: main, theirs: fork, dryRun: true, noUpdateBranch: true, abortOnConflict: true })`;
  `MergeConflictError` → `{state: "conflict", paths: err.data.filepaths}`.
- `ship(attempt, expectedHead)`: fetch main + fork; refuse unless fork head == expectedHead (when
  given) and the trial merge is clean; create a real merge commit
  `ship: <task>` with parents `[main, head]`; push to main with a short-lived write token. A
  rejected push (main moved) → re-fetch and retry once, then 409.
- `diff(attempt)`: unified diff `baseSha..headSha` (not `main...head`, so shipped attempts still
  show their diff), excluding the brief file. Truncate at 80 000 chars.

## Lifecycle

### Create project
`Host.createProject` picks the id, then `ProjectHandle.init`:
- `seed: "starter"` → `artifacts.create(id)` and push a small static site (`site/index.html`, `README.md`).
- `seed: "harbor"` → the demo notice board (from the old `worker/src/seeds.ts`), plus three demo
  briefs dispatched to the `demo` agent (see below).
- `importUrl` → `artifacts.import(url, id)`.
`mainSha` is read back with `artifacts.head(id)`.

### Dispatch (new brief)
1. Validate (task ≤ 240 chars; ≤ 12 constraints ≤ 240 chars each; ≤ 20 paths, each `assertSafeRel`;
   acceptance ≤ 2000 chars; agent must be a known `AgentInfo.id`).
2. Create the brief, then the attempt: `baseSha = artifacts.head(project)`,
   `artifacts.fork(project, attemptId)`, `commitBrief`.
3. Create the job (`queued`). `demo` jobs run right after the response is built (local: immediately in
   process; Cloudflare: `ctx.waitUntil`). `manual` agents get no job; with `withCredentials` the
   response carries a 1-hour write token for the fork so the caller can `git push` itself.
4. Activity: `dispatched`.

### Runner jobs
- `claim(runnerId, agents)`: oldest `queued` job whose agent is in `agents` → `running`, lease 3 min.
  Returns `ClaimedJob` (no tokens).
- `heartbeat` extends the lease by 3 min. `tick()` re-queues `running` jobs whose lease expired
  (outcome `lease_expired` recorded in activity), at most 3 times, then marks the attempt `failed`.
- `park` and `re-run` cancel a running job (outcome `cancelled`): the runner's next heartbeat or
  credentials call gets 409 and it stops.
- `jobCredentials(scope)`: read token (TTL 15 min) for clone, write token (TTL 10 min) for push.
  Only for the runner holding the lease.
- `finish(outcome)`: job `done` (reason `pushed`) or `failed`. `pushed` triggers `assess`. Any other
  reason with no new commits marks the attempt `failed` and logs the summary.

### Push detection (three paths, all idempotent on `(attemptId, headSha)`)
1. Explicit: the runner calls `POST /api/attempts/:id/pushed` after pushing.
2. Events: on Cloudflare, `triggers.events` → `PushWorkflow` for `cf.artifacts.repo.pushed` in the
   namespace → `ProjectDO.onPushEvent`. Locally, the git server calls `onPushEvent` after a
   successful `git-receive-pack`.
3. Reconcile: `board()` (throttled to once per 10 s) and `tick()` compare each `waiting`/`ready`
   attempt's stored `headSha` with `artifacts.head(repo)` and assess the ones that moved.
A push to the main repo (someone pushed main directly) updates `mainSha` and re-runs trial merges.

### Assess
`waiting` → `ready` on the first head beyond `briefSha`. Recompute digest, trial merge, and (if a
reviewer is configured and the head is new) review. Activity: `pushed`, then `assessed` or
`conflict`.

### Ship
Only from `ready`, merge `clean`, head == `expectedHead` when supplied. Digest `satisfies: "no"` or
review `off-brief` still allows shipping, but the UI labels the button "Ship anyway". After the
push: attempt `shipped`, `shippedSha` set, `mainSha` updated, every other `ready` attempt re-assessed
(that is how conflicts appear). Activity: `shipped`, and `conflict` for each attempt that now
conflicts.

### Re-run
From `ready` (usually conflicting), `failed`, or `parked`. Reads the brief from the old attempt's
brief commit (`artifacts.readFile(oldRepo, briefSha, briefPath)`), verifies it equals the stored
brief, then makes attempt `number + 1` from **current** main exactly like a dispatch, with the same
brief id and bytes. The old attempt becomes `discarded` with `replacedBy` and a one-sentence
`discardReason` (e.g. `Conflicted with main in site/index.html.`). A conflict reports its paths,
not a guessed cause: timestamps and overlapping files cannot establish which ship produced it.
Its diff is never merged. The new job goes to the same agent unless one is given. Activity: `rerun`.
If any step fails, nothing is discarded (the old attempt stays as it was; a half-made fork repo is
deleted best-effort).

### Park / unpark
`park`: `ready`/`waiting`/`failed` → `parked` (a queued job is cancelled). `unpark`: back to `ready`
(re-assessed) or `waiting`.

## Lanes and the one button

Derived in `core/state.ts` from the current attempt of each brief:

| Current attempt | Lane | Primary | Secondary |
|---|---|---|---|
| `ready`, merge `conflict` | `rerun` | `rerun` | `park` |
| `failed` | `rerun` | `rerun` | `park` |
| `ready`, clean, digest not `no`, review not `off-brief`, no control paths | `ship` | `ship` | `park`, `rerun` |
| `ready`, clean, otherwise | `review` | `ship-anyway` | `park`, `rerun` |
| `waiting` | `working` | `wait` | `park` |
| `parked` | `parked` | `unpark` | `rerun` |
| `shipped` | `shipped` | `none` | — |

Lane order on the board: rerun, ship, review, working, parked, shipped. Within a lane, newest
`updatedAt` first. `discarded` attempts only appear in their task's `history`.

## Digest rules (core/digest.ts)

- Ignore the attempt's own brief file. Any other change under `.shipboard/` goes to `controlPaths`
  and forces `satisfies: "no"`.
- `unexpectedPaths` = touched − brief paths (a brief path ending in `/` covers everything under it).
  `missedPaths` = brief paths not touched.
- Machine checks: `contains <path> "<text>"` per line, evaluated at headSha. Other lines are left
  for a human.
- `satisfies`: `no` if any check fails or any unexpected/missed/control path; `yes` if there were
  checks and all passed; else `unchecked`.
- `summary`: one plain sentence, e.g. `Touched site/index.html. Acceptance check passed.`

## HTTP API (src/http/api.ts)

JSON everywhere. Errors: `{ "error": "<sentence>" }` with the status from `PortError`.
Mutations require `Content-Type: application/json` (415 otherwise).

| Method | Path | Auth | Body → Response |
|---|---|---|---|
| GET | `/api/health` | none | `{ ok: true }` |
| GET | `/api/config` | none | `{ mode, publicRead, boardAuth: boolean, agents: AgentInfo[], namespace?: string }` |
| GET | `/api/projects` | read | `{ projects: ProjectSummary[] }` |
| POST | `/api/projects` | board | `CreateProjectInput` → 201 `{ project: ProjectSummary, notice }` |
| POST | `/api/demo` | board | — → 201 `{ projectId, notice }` (creates a `harbor` project) |
| GET | `/api/projects/:id` | read | `?since=<version>` → `BoardView`, or 304 when `version == since` |
| POST | `/api/projects/:id/preview-session` | board | Sets a 5-minute preview cookie scoped to `/preview/:id/`; returns `{ expiresAt }` |
| DELETE | `/api/projects/:id/preview-session` | none | Clears that preview cookie (204) |
| POST | `/api/projects/:id/tasks` | board | `DispatchInput & { credentials?: boolean }` → 201 `{ board, attemptId, credentials?, notice }` |
| POST | `/api/attempts/:id/ship` | board | `{ expectedHead?: string }` → `{ board, notice }` |
| POST | `/api/attempts/:id/park` | board | → `{ board, notice }` |
| POST | `/api/attempts/:id/unpark` | board | → `{ board, notice }` |
| POST | `/api/attempts/:id/rerun` | board | `{ agent?: string }` → `{ board, attemptId, notice }` |
| GET | `/api/attempts/:id/diff` | read | `{ diff, truncated, base, head }` |
| POST | `/api/attempts/:id/pushed` | board or runner | `{ sha?: string }` → `{ board }` |
| POST | `/api/runner/claim` | runner | `{ runnerId, agents: string[], attemptId? }` → 200 `ClaimedJob` or 204. Fans out over projects (oldest job first); with `attemptId`, claims only that job. |
| POST | `/api/runner/jobs/:attemptId/heartbeat` | runner | `{ runnerId }` → `{ leaseExpiresAt }` |
| POST | `/api/runner/jobs/:attemptId/credentials` | runner | `{ runnerId, scope }` → `GitCredentials` |
| POST | `/api/runner/jobs/:attemptId/finish` | runner | `{ runnerId, outcome: JobOutcome }` → `{ ok: true }` |
| GET | `/preview/:projectId/:ref/*` | read or preview session | File at `main` or at an attempt's head. `ref` = `main` or an attempt id. Empty path → `index.html`; a directory → its `index.html`. |
| * | `/git/:namespace/:repo.git/*` | repo token | **Local host only.** Smart HTTP via `git http-backend`. |

### Auth
- `board`: `Authorization: Bearer <BOARD_TOKEN>`. `runner`: `Authorization: Bearer <RUNNER_TOKEN>`
  (the board token is also accepted). Compare in constant time.
- Cloudflare: both secrets are required; with no `BOARD_TOKEN` set, every board mutation returns 503
  with a sentence saying which secret to set. `read` is open when `PUBLIC_READ` is not `"false"`,
  otherwise it needs the board token.
- On a private board, the UI sends its board Bearer token to the preview-session route before
  loading an iframe. The response sets a five-minute signed, HttpOnly cookie scoped to that
  project's `/preview/` path, with `SameSite=Lax` and `Secure` on HTTPS. It contains no board token
  and only authorizes preview files; it cannot authorize API reads or mutations. Locking the UI
  requests cookie deletion; failed deletions are retained for retry when connectivity returns,
  and every session expires after five minutes. Rotating the board token invalidates existing
  signatures. This lets iframe navigation and relative assets load without putting the board
  token in preview URLs.
- Local: tokens are optional. When unset, the server binds 127.0.0.1 only, and every request must
  carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, and mutations an `Origin` (if present)
  of the same. This closes CSRF and DNS rebinding.
- The UI keeps the board token in `localStorage` and sends it as a Bearer header for API calls.

### Security headers
Board pages: `Content-Security-Policy: default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
Previews: `default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src data: blob: 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-same-origin`.
Both the response policy and the UI iframe keep scripts disabled. Same-origin access lets static
relative assets use the scoped preview cookie; it must never be combined with `allow-scripts`.
Preview responses retain `Cross-Origin-Resource-Policy: same-origin`.
All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.

## Hosts

### Local (`npm start`)
- `LocalArtifacts`: bare repos under `$SHIPBOARD_DATA/git/<namespace>/<name>.git`
  (`http.receivepack=true`), fork = `git clone --bare --single-branch`, import = `git clone --bare`,
  head/readFile via `git rev-parse` / `git cat-file`. Tokens are random `art_v1_<40 hex>?expires=<unix>`
  kept in memory, scoped to one repo and one scope, checked by the git route.
- State: `$SHIPBOARD_DATA/projects/<id>.json`, written to a unique tmp file then `rename`d.
- Remote URLs: `http://127.0.0.1:<port>/git/local/<name>.git`.
- A 5 s interval calls `tick()` on projects with running jobs. Demo jobs run in process.

### Cloudflare (`npm run deploy`)
- `wrangler.jsonc`: `main: src/cloudflare/worker.ts`, `compatibility_date: 2026-10-01`,
  `assets: { directory: "./public", binding: "ASSETS", run_worker_first: ["/api/*", "/preview/*"] }`,
  `artifacts: [{ binding: "ARTIFACTS", namespace: "shipboard", remote: true }]`,
  `durable_objects` ProjectDO + RegistryDO (SQLite classes, migration tag v1),
  `workflows: [{ name: "shipboard-push", binding: "PUSH_WORKFLOW", class_name: "PushWorkflow" }]`,
  `triggers.events: [{ type: "cf.artifacts.repo.pushed", filter: { namespace: "shipboard" }, targets: [{ type: "workflow", workflow_name: "shipboard-push" }] }]`,
  optional `ai: { binding: "AI" }`, `vars: { PUBLIC_READ: "true", REVIEW_MODEL: "..." }`,
  `limits: { cpu_ms: 300000 }`. Secrets: `BOARD_TOKEN`, `RUNNER_TOKEN`.
  Also: `assets.not_found_handling: "single-page-application"` (so `/p/<id>` gets the app shell, as
  locally), `vars.ARTIFACTS_NAMESPACE` (the namespace the binding points at; shown in `/api/config`,
  checked on push events), `ai.remote: true` (Workers AI has no local mode), and an `env.dev` block
  on namespace `shipboard-dev` that repeats every non-inheritable binding. Board pages get their
  headers from `public/_headers`. Deploy steps: [`docs/DEPLOY.md`](DEPLOY.md).
- `ProjectDO` (one per project id) holds the core `ProjectService`, storing the `ProjectState` as one
  value in DO storage; an alarm calls `tick()` while jobs are running. A mutex in core serialises
  operations (DO input gates do not cover awaited fetches).
  Its RPC methods have the `ProjectHandle` names and arguments but answer an envelope,
  `{ ok: true, value } | { ok: false, error: { message, status, code } }`, because an error crossing
  Workers RPC keeps only its message. `Host.project(id)` returns a `ProjectClient`
  (`src/cloudflare/rpc.ts`) that unwraps it back into a value or a `PortError`. The alarm fires every
  30 s while a job is queued or running, every 60 s while an attempt touched in the last 24 h is
  `waiting`, and stops otherwise.
- `RegistryDO` (singleton) keeps the project index and when runners offering each agent last polled.
- `PushWorkflow.run(event)` parses the event defensively (`event.payload` may be the CloudEvent or
  its `payload`), maps repo → project via `projectIdOf`, and calls `onPushEvent` in a `step.do`.
- `AiReviewer`: Workers AI chat model named by `REVIEW_MODEL`; returns null on any failure.

## Runner (runner/runner.ts)

`npm run runner -- --url <board> --agents grok,claude [--concurrency 2]`. Config in
`shipboard.runner.json` (agent templates; see `runner/agents.ts` for defaults). Per job: claim →
read token → `git clone` in a fresh temp dir with the token in env-scoped git config
(`GIT_CONFIG_COUNT`), never argv or `.git/config` → verify the brief file at the first commit after
base equals the claimed brief → write the prompt outside the repo → spawn the agent from its argv
template (`shell: false`, own process group, scrubbed env, wall-clock timeout with SIGINT → SIGTERM →
SIGKILL) → inspect the tree (undo agent commits with `reset --soft`, drop changes to `.git`,
`.shipboard`, agent config dirs) → commit with trailers (`Shipboard-Attempt`, `Shipboard-Agent`) →
write token → push `HEAD:main` → `pushed` → `finish`. Heartbeat every 60 s. Agents never see a
token. The `demo` agent never reaches a runner.

`npm run agent -- <command>` is the thin CLI for agents that self-serve: `list`, `board`, `dispatch`
(with `--credentials`, prints a ready `git push` command), `status`.
