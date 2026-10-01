import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { git, MockBoard, type MockJob } from "./mock-board.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function board(): MockBoard {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shipboard-mod-view-"))
  roots.push(root)
  const board = new MockBoard(root)
  board.url = "http://127.0.0.1:1"
  return board
}

function push(board: MockBoard, job: MockJob, changes: Record<string, string>): void {
  const work = path.join(board.root, "work", job.job.attemptId)
  for (const [file, contents] of Object.entries(changes)) {
    const target = path.join(work, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
  }
  git(work, "add", "-A")
  git(work, "commit", "--quiet", "-m", "test change")
  git(work, "push", "--quiet", job.bare, "HEAD:main")
  job.pushedSha = board.head(job.job.attemptId)
}

function card(board: MockBoard, id: string) {
  return board.board().lanes.flatMap((lane) => lane.tasks).find((task) => task.current.id === id)
}

describe("mock board views", () => {
  it("uses core placement for current partial and off-brief reviews, but ignores a stale verdict", () => {
    const mock = board()
    const job = mock.queue({ task: "Set the lede" })
    push(mock, job, { "site/index.html": "<!DOCTYPE html><p id=lede>Harbor notes: ready for sea</p>\n" })
    expect(card(mock, job.job.attemptId)?.current.digest?.satisfies).toBe("yes")

    job.reviewVerdict = "partial"
    expect(card(mock, job.job.attemptId)).toMatchObject({ lane: "review", current: { primary: "ship-anyway", review: { verdict: "partial" } } })
    job.reviewVerdict = "off-brief"
    expect(card(mock, job.job.attemptId)).toMatchObject({ lane: "review", current: { primary: "ship-anyway" } })
    job.reviewHeadSha = job.job.briefSha
    expect(card(mock, job.job.attemptId)).toMatchObject({ lane: "ship", current: { primary: "ship" } })
  })

  it("detects an agent-written control file through buildDigest", () => {
    const mock = board()
    const job = mock.queue({ task: "Set the lede" })
    push(mock, job, {
      "site/index.html": "<!DOCTYPE html><p id=lede>Harbor notes: ready for sea</p>\n",
      ".shipboard/review-notes.md": "An agent changed a control file.\n",
    })
    const task = card(mock, job.job.attemptId)
    expect(task?.current.digest).toMatchObject({
      satisfies: "no",
      controlPaths: [".shipboard/review-notes.md"],
      unexpectedPaths: [],
    })
    expect(task).toMatchObject({ lane: "review", current: { primary: "ship-anyway" } })
  })
})
