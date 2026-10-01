import { describe, expect, it } from "vitest"
import { BoardError } from "../worker/src/errors.ts"
import { assertSafeRel, isId, isInside, slug } from "../worker/src/paths.ts"

describe("paths", () => {
  it("accepts a nested repo path", () => {
    expect(assertSafeRel("site/index.html")).toBe("site/index.html")
    expect(assertSafeRel("site\\index.html")).toBe("site/index.html")
  })

  it("rejects escapes", () => {
    for (const bad of ["../secret", "/etc/passwd", "C:\\temp\\x", "foo/../../x", ".git/config", "site/.git/config", "has space.txt", ""]) {
      expect(() => assertSafeRel(bad)).toThrow(BoardError)
    }
  })

  it("keeps sliced slugs valid as ids", () => {
    const stem = slug("Rename the pier mark to the night board", "fork")
    expect(stem.endsWith("-")).toBe(false)
    expect(isId(`${stem}-ab12`)).toBe(true)
  })

  it("knows when a file stays inside a root", () => {
    expect(isInside("B:\\repo", "B:\\repo\\site\\index.html")).toBe(true)
    expect(isInside("B:\\repo", "B:\\repo")).toBe(true)
    expect(isInside("B:\\repo", "B:\\other\\index.html")).toBe(false)
  })
})
