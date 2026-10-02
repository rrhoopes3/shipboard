# Live Artifacts push capture

`artifacts-pushed-2026-10-02.json` preserves the top-level `params` from a live
Cloudflare `shipboard-push` Workflow instance description captured on 2026-10-02.
It records Shipboard creating the documentation brief during its security self-test.

- Workflow instance: `79c63f3f-f1f6-4582-9702-5d1ea4cedc11`.
- Trigger source: `event`; type: `cf.artifacts.repo.pushed`.
- Queued: `2026-10-02T03:43:19.944Z`.
- Completed: `2026-10-02T03:43:20.840Z`; status: `complete`; success: `true`.
- Assessment output: project `shipboard-security-self-ef20`, repo
  `shipboard-security-self-ef20--align-security-a-88f4`, head
  `00cf72a6a7cce54d04a41e2ee699d45dbe02f852`.
- Redactions: none. The event contains only Shipboard bot commit identity, repo
  identifiers, and commit data; no credentials, account/subscription identifiers,
  or personal author details are present.

The JSON retains the actual event nesting and fields without synthetic additions.
The Workflow entrypoint receives these params as `event.payload`. The regression
in `push-workflow.test.ts` checks parsing and routing through that entrypoint
using the existing Durable Object and Workflow step mocks.
