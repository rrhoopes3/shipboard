import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const digest = { controlPaths: [], unexpectedPaths: [], checks: [], missedPaths: [] }

describe("review card explanation", () => {
  it("explains a partial review supplied by the normalized board view", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal("ResizeObserver", class { observe() {} })
    const { shipAnywayWhy } = await import("../../public/js/task-card.js")
    const headSha = "a".repeat(40)
    const review = { verdict: "partial", note: "The footer is present, but the README still needs work.", headSha }
    expect(shipAnywayWhy({ headSha, digest, review })).toBe(
      "The review only partly confirms the brief: The footer is present, but the README still needs work. Shipping is still your call.",
    )
  })

  it("uses the same highest concern in the card and confirmation", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal("ResizeObserver", class { observe() {} })
    const { shipAnywayWhy, shipAnywayQuestion } = await import("../../public/js/task-card.js")
    const headSha = "a".repeat(40)
    const review = { verdict: "partial", note: "The footer is incomplete.", headSha }
    const control = { headSha, review, digest: { controlPaths: ["policy.json"], unexpectedPaths: ["other.txt"], checks: [{ ok: false }], missedPaths: ["site/index.html"] } }
    expect(shipAnywayWhy(control)).toContain("policy.json under .shipboard/")
    expect(shipAnywayQuestion(control)).toContain("policy.json under .shipboard/")

    const failedCheck = { ...control, digest: { ...control.digest, controlPaths: [], unexpectedPaths: [] } }
    expect(shipAnywayWhy(failedCheck)).toContain("acceptance check failed")
    expect(shipAnywayQuestion(failedCheck)).toContain("acceptance check failed")

    const partial = { ...failedCheck, digest: { ...failedCheck.digest, checks: [] } }
    expect(shipAnywayWhy(partial)).toContain("review only partly confirms")
    expect(shipAnywayQuestion(partial)).toContain("review only partly confirms")
  })
})
