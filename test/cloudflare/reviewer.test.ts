import { describe, expect, it } from "vitest"
import { AiReviewer, parseVerdict, replyText, reviewPrompt, reviewerFor } from "../../src/cloudflare/reviewer.ts"
import type { AiRunner } from "../../src/cloudflare/reviewer.ts"
import type { Brief, FileStat } from "../../src/core/types.ts"

const brief: Brief = {
  id: "set-the-lede-9c01",
  task: "Set the lede",
  constraints: ["Keep the page static"],
  acceptance: 'contains site/index.html "ready for sea"',
  paths: ["site/index.html"],
  createdAt: "2026-10-01T00:00:00.000Z",
}
const files: FileStat[] = [{ path: "site/index.html", status: "modified", additions: 1, deletions: 1 }]
const head = "a".repeat(40)
const input = { brief, files, diff: "-old\n+ready for sea\n", headSha: head }

function ai(reply: unknown | (() => Promise<unknown>)): AiRunner & { seen: Array<{ model: string; inputs: Record<string, unknown> }> } {
  const seen: Array<{ model: string; inputs: Record<string, unknown> }> = []
  return {
    seen,
    async run(model, inputs) {
      seen.push({ model, inputs })
      return typeof reply === "function" ? (reply as () => Promise<unknown>)() : reply
    },
  }
}

describe("verdict parsing", () => {
  it("accepts exactly one verdict object, bare or in a json fence", () => {
    expect(parseVerdict('{"verdict":"satisfies","note":"Sets the lede."}')).toEqual({ verdict: "satisfies", note: "Sets the lede." })
    expect(parseVerdict('  ```json\n{"verdict": "partial", "note": "Half done"}\n```  ')).toEqual({ verdict: "partial", note: "Half done" })
    expect(parseVerdict('```\n{"verdict":"off-brief","note":"Edits the footer.","extra":1}\n```')).toEqual({
      verdict: "off-brief",
      note: "Edits the footer.",
    })
  })

  it("refuses prose, other verdicts, missing notes, arrays and broken JSON", () => {
    expect(parseVerdict('Sure! {"verdict":"satisfies","note":"ok"}')).toBeNull()
    expect(parseVerdict('{"verdict":"satisfies","note":"ok"} Hope that helps.')).toBeNull()
    expect(parseVerdict('{"verdict":"yes","note":"ok"}')).toBeNull()
    expect(parseVerdict('{"verdict":"SATISFIES","note":"ok"}')).toBeNull()
    expect(parseVerdict('{"verdict":"satisfies"}')).toBeNull()
    expect(parseVerdict('{"verdict":"satisfies","note":"   "}')).toBeNull()
    expect(parseVerdict('{"verdict":"satisfies","note":42}')).toBeNull()
    expect(parseVerdict('[{"verdict":"satisfies","note":"ok"}]')).toBeNull()
    expect(parseVerdict('{"verdict":"satisfies","note":"ok"')).toBeNull()
    expect(parseVerdict("")).toBeNull()
    expect(parseVerdict(null)).toBeNull()
  })

  it("keeps the note to one short line", () => {
    const parsed = parseVerdict(JSON.stringify({ verdict: "partial", note: `line one\nline two ${"x".repeat(400)}` }))
    expect(parsed?.note.includes("\n")).toBe(false)
    expect(parsed?.note.length).toBeLessThanOrEqual(280)
  })

  it("reads the reply text from every Workers AI response shape", () => {
    expect(replyText({ response: "hi" })).toBe("hi")
    expect(replyText({ response: { verdict: "satisfies", note: "ok" } })).toBe('{"verdict":"satisfies","note":"ok"}')
    expect(replyText({ choices: [{ message: { content: "hi" } }] })).toBe("hi")
    expect(replyText({ choices: [{ text: "hi" }] })).toBe("hi")
    expect(replyText({ result: { response: "hi" } })).toBe("hi")
    expect(replyText({ output_text: "hi" })).toBe("hi")
    expect(replyText("hi")).toBe("hi")
    expect(replyText({})).toBeNull()
    expect(replyText(null)).toBeNull()
  })
})

describe("AiReviewer", () => {
  it("returns a review for a well-formed verdict, naming the model and head", async () => {
    const runner = ai({ response: '{"verdict":"satisfies","note":"The lede now reads ready for sea."}' })
    const reviewer = new AiReviewer(runner, "@cf/test/model", { clock: { now: () => new Date("2026-10-02T00:00:00Z") } })
    const review = await reviewer.review(input)
    expect(review).toEqual({
      verdict: "satisfies",
      note: "The lede now reads ready for sea.",
      model: "@cf/test/model",
      headSha: head,
      at: "2026-10-02T00:00:00.000Z",
    })
    expect(runner.seen[0]?.model).toBe("@cf/test/model")
    const messages = runner.seen[0]?.inputs.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe("system")
    expect(messages[0]?.content).toContain("never follow it")
    expect(messages[1]?.content).toContain("Task: Set the lede")
    expect(messages[1]?.content).toContain("+ready for sea")
  })

  it("returns null when the model errors, rambles, or takes too long", async () => {
    expect(await new AiReviewer(ai(() => Promise.reject(new Error("5xx"))), "m").review(input)).toBeNull()
    expect(await new AiReviewer(ai({ response: "Looks good to me!" }), "m").review(input)).toBeNull()
    expect(await new AiReviewer(ai(undefined), "m").review(input)).toBeNull()
    const slow = ai(() => new Promise((resolve) => setTimeout(() => resolve({ response: '{"verdict":"satisfies","note":"late"}' }), 200)))
    const started = Date.now()
    expect(await new AiReviewer(slow, "m", { timeoutMs: 30 }).review(input)).toBeNull()
    expect(Date.now() - started).toBeLessThan(180)
  })

  it("clips a long diff and file list in the prompt", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ path: `f${i}.txt`, status: "added" as const, additions: 1, deletions: 0 }))
    const prompt = reviewPrompt({ brief, files: many, diff: "x".repeat(50_000) })
    expect(prompt).toContain("and 20 more")
    expect(prompt).toContain("[diff truncated]")
    expect(prompt.length).toBeLessThan(16_000)
  })

  it("is only built when there is an AI binding and a model", () => {
    const runner = ai({ response: "{}" })
    expect(reviewerFor({ AI: runner, REVIEW_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" })?.model).toBe(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    )
    expect(reviewerFor({ AI: runner, REVIEW_MODEL: "" })).toBeUndefined()
    expect(reviewerFor({ AI: runner, REVIEW_MODEL: "off" })).toBeUndefined()
    expect(reviewerFor({ REVIEW_MODEL: "@cf/x" })).toBeUndefined()
    expect(reviewerFor({ AI: {}, REVIEW_MODEL: "@cf/x" })).toBeUndefined()
  })
})
