// The mod keeps its own copy of the core types (a plugin may only import files inside its own
// directory). This file stops type-checking (`tsc --noEmit`) when the two drift apart.

import { expect, it } from "vitest"
import type * as Core from "../../src/core/types.ts"
import type * as Mod from "../../integrations/claude-code/hooks/contract.ts"
import { AGENT_ID, AGENT_LABEL } from "../../integrations/claude-code/hooks/contract.ts"

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const same: [
  Same<Core.ClaimedJob, Mod.ClaimedJob>,
  Same<Core.GitCredentials, Mod.GitCredentials>,
  Same<Core.JobOutcome, Mod.JobOutcome>,
  Same<Core.BoardView, Mod.BoardView>,
  Same<Core.AttemptView, Mod.AttemptView>,
  Same<Core.TaskView, Mod.TaskView>,
  Same<Core.DispatchInput, Mod.DispatchInput>,
  Same<Core.Brief, Mod.Brief>,
  Same<Core.AgentInfo, Mod.AgentInfo>,
] = [true, true, true, true, true, true, true, true, true]

it("mirrors the core contract", () => {
  expect(same.every(Boolean)).toBe(true)
  expect(AGENT_ID).toBe("claude-code")
  expect(AGENT_LABEL).toBe("Claude Code (interactive)")
})
