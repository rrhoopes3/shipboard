/** BoardView assembly. Pure: the stored state in, the HTTP response shape out. */

import { agentKind, agentLabel } from "./agents.ts"
import { LANES, currentAttempt, emptyCounts, placement } from "./state.ts"
import type {
  AgentInfo,
  Attempt,
  AttemptView,
  BoardView,
  Lane,
  ProjectState,
  ProjectSummary,
  TaskView,
} from "./types.ts"

export function previewUrl(projectId: string, ref: string): string {
  return `/preview/${projectId}/${ref}/`
}

export function attemptView(state: ProjectState, attempt: Attempt, agents: readonly AgentInfo[], live: boolean): AttemptView {
  const job = state.jobs.find((item) => item.attemptId === attempt.id) ?? null
  const place = live ? placement(attempt) : { primary: "none" as const, secondary: [] }
  const pushed = attempt.headSha !== attempt.briefSha
  return {
    id: attempt.id,
    briefId: attempt.briefId,
    number: attempt.number,
    agent: attempt.agent,
    agentLabel: agentLabel(agents, attempt.agent),
    agentKind: agentKind(agents, attempt.agent),
    status: attempt.status,
    repo: attempt.repo,
    baseSha: attempt.baseSha,
    briefSha: attempt.briefSha,
    headSha: attempt.headSha,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    job: job ? { ...job, agentLabel: agentLabel(agents, job.agent) } : null,
    digest: attempt.digest,
    merge: attempt.merge,
    review: attempt.review?.headSha === attempt.headSha ? attempt.review : null,
    replacedBy: attempt.replacedBy,
    replaces: attempt.replaces,
    discardReason: attempt.discardReason,
    shippedSha: attempt.shippedSha,
    previewUrl: pushed ? previewUrl(state.project.id, attempt.id) : null,
    primary: place.primary,
    secondary: place.secondary,
  }
}

function tasks(state: ProjectState, agents: readonly AgentInfo[]): TaskView[] {
  const out: TaskView[] = []
  for (const brief of state.briefs) {
    const current = currentAttempt(state, brief.id)
    if (!current) continue
    const lane = placement(current).lane ?? "shipped"
    const history = state.attempts
      .filter((attempt) => attempt.briefId === brief.id && attempt.id !== current.id)
      .sort((a, b) => b.number - a.number)
      .map((attempt) => attemptView(state, attempt, agents, false))
    out.push({ brief, lane, current: attemptView(state, current, agents, true), history })
  }
  return out
}

export function laneCounts(state: ProjectState): Record<Lane, number> {
  const counts = emptyCounts()
  for (const brief of state.briefs) {
    const current = currentAttempt(state, brief.id)
    const lane = current ? placement(current).lane : null
    if (lane) counts[lane] += 1
  }
  return counts
}

export function projectSummary(state: ProjectState): ProjectSummary {
  return {
    id: state.project.id,
    name: state.project.name,
    description: state.project.description,
    createdAt: state.project.createdAt,
    mainSha: state.project.mainSha,
    counts: laneCounts(state),
  }
}

export function boardView(state: ProjectState, agents: readonly AgentInfo[]): BoardView {
  const all = tasks(state, agents)
  const lanes = LANES.map((lane) => ({
    lane,
    tasks: all
      .filter((task) => task.lane === lane)
      .sort((a, b) => (a.current.updatedAt < b.current.updatedAt ? 1 : a.current.updatedAt > b.current.updatedAt ? -1 : 0)),
  }))
  return {
    version: state.version,
    project: {
      ...projectSummary(state),
      repo: state.project.repo,
      seed: state.project.seed,
      previewUrl: previewUrl(state.project.id, "main"),
    },
    lanes,
    activity: state.activity.map((entry) => ({ ...entry })),
    agents: agents.map((agent) => ({ ...agent })),
  }
}

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
  pdf: "application/pdf",
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".")
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ""
  return TYPES[ext] ?? "application/octet-stream"
}
