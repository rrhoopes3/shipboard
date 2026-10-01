import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const digest = { controlPaths: [], unexpectedPaths: [], checks: [], missedPaths: [] }

describe("review card explanation", () => {
  it("explains a partial review of the current head, without applying a stale verdict", async () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) })
    vi.stubGlobal("ResizeObserver", class { observe() {} })
    const { shipAnywayWhy } = await import("../../public/js/task-card.js")
    const headSha = "a".repeat(40)
    const review = { verdict: "partial", note: "The footer is present, but the README still needs work.", headSha }
    expect(shipAnywayWhy({ headSha, digest, review })).toBe(
      "The review only partly confirms the brief: The footer is present, but the README still needs work. Shipping is still your call.",
    )
    expect(shipAnywayWhy({ headSha: "b".repeat(40), digest, review })).toBe("The digest could not confirm the brief. Shipping is still your call.")
  })
})
