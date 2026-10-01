/** The agents a brief can be dispatched to. Hosts fill `lastSeenAt` from runner claims. */

import type { AgentInfo, AgentKind } from "./types.ts"

export const DEMO_AGENT = "demo"
export const MANUAL_AGENT = "manual"

export const DEFAULT_AGENTS: readonly AgentInfo[] = Object.freeze([
  { id: DEMO_AGENT, label: "Demo (scripted)", kind: "demo" },
  { id: MANUAL_AGENT, label: "Manual (you push)", kind: "manual" },
  { id: "claude", label: "Claude Code", kind: "cli" },
  { id: "codex", label: "Codex", kind: "cli" },
  { id: "grok", label: "Grok", kind: "cli" },
  { id: "cursor", label: "Cursor", kind: "cli" },
])

/** A fresh, mutable copy of the default list. */
export function defaultAgents(): AgentInfo[] {
  return DEFAULT_AGENTS.map((agent) => ({ ...agent }))
}

export function findAgent(agents: readonly AgentInfo[], id: string): AgentInfo | undefined {
  return agents.find((agent) => agent.id === id)
}

export function agentLabel(agents: readonly AgentInfo[], id: string): string {
  return findAgent(agents, id)?.label ?? id
}

/** Unknown ids are treated as runner agents: they can only have arrived through a runner. */
export function agentKind(agents: readonly AgentInfo[], id: string): AgentKind {
  return findAgent(agents, id)?.kind ?? "cli"
}
