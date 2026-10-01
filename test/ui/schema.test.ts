import { describe, expect, it } from "vitest"
import { arr, lit, nullable, obj, optional, sha40, str, validate } from "./schema.ts"

type Thing = { a: string; b?: "x" | "y"; c: string[]; d: string | null }
const thing = obj<Thing>({ a: str, b: optional(lit("x", "y")), c: arr(str), d: nullable(sha40) })

describe("fixture schema", () => {
  it("accepts a value of the contract's shape, with optional keys left out", () => {
    expect(validate(thing, { a: "1", c: [], d: null })).toEqual([])
    expect(validate(thing, { a: "1", b: "y", c: ["p"], d: "0123456789abcdef0123456789abcdef01234567" })).toEqual([])
  })

  it("names every wrong type, unknown enum value and extra key", () => {
    expect(validate(thing, { a: 1, b: "z", c: [2], d: "abc", e: 0 })).toEqual([
      "$.a: expected a string, got number",
      '$.b: expected one of x, y, got "z"',
      "$.c[0]: expected a string, got number",
      '$.d: expected a 40-hex sha, got "abc"',
      "$.e: not in the contract",
    ])
  })

  it("rejects missing keys and optional keys set to null", () => {
    expect(validate(thing, { c: [], b: null, d: null })).toEqual(["$.a: missing", "$.b: optional keys are left out, not set to null"])
  })
})
