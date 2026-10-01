import git from "isomorphic-git"
import { describe, expect, it } from "vitest"
import { MemoryFS } from "../../src/core/memfs.ts"
import { Mutex } from "../../src/core/mutex.ts"

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describe("MemoryFS", () => {
  it("gives every error a Node-style code", async () => {
    const fs = new MemoryFS()
    const p = fs.promises
    expect(await code(p.readFile("/missing"))).toBe("ENOENT")
    expect(await code(p.stat("/missing"))).toBe("ENOENT")
    expect(await code(p.writeFile("/no/parent/file", "x"))).toBe("ENOENT")
    await p.writeFile("/file", "x")
    expect(await code(p.readdir("/file"))).toBe("ENOTDIR")
    expect(await code(p.writeFile("/file/child", "x"))).toBe("ENOTDIR")
    expect(await code(p.mkdir("/file"))).toBe("EEXIST")
    await p.mkdir("/dir")
    await p.writeFile("/dir/a", "a")
    expect(await code(p.rmdir("/dir"))).toBe("ENOTEMPTY")
    expect(await code(p.unlink("/dir"))).toBe("EISDIR")
    expect(await code(p.readlink("/file"))).toBe("ENOENT")
    await p.rm("/dir", { recursive: true })
    expect(await code(p.stat("/dir"))).toBe("ENOENT")
    await p.mkdir("/deep/er/still", { recursive: true })
    expect((await p.stat("/deep/er/still")).isDirectory()).toBe(true)
  })

  it("has readlink and symlink, and reads text or bytes", async () => {
    const fs = new MemoryFS()
    const p = fs.promises
    expect(typeof p.readlink).toBe("function")
    expect(typeof p.symlink).toBe("function")
    await p.writeFile("/target", "hello")
    await p.symlink("/target", "/link")
    expect(await p.readlink("/link")).toBe("/target")
    expect((await p.lstat("/link")).isSymbolicLink()).toBe(true)
    expect(await p.readFile("/link", "utf8")).toBe("hello")
    expect(await p.readFile("/target")).toBeInstanceOf(Uint8Array)
    expect(await p.readdir("/")).toEqual(["link", "target"])
    expect(fs.size).toBe(5)
  })

  it("runs isomorphic-git init, commits and a conflicting merge entirely in memory", async () => {
    const fs = new MemoryFS()
    const gitdir = "/repo"
    const author = { name: "T", email: "t@example.test", timestamp: 1_700_000_000, timezoneOffset: 0 }
    await git.init({ fs, gitdir, bare: true, defaultBranch: "main" })
    const commit = async (text: string, parent: string[]) => {
      const blob = await git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode(text) })
      const tree = await git.writeTree({ fs, gitdir, tree: [{ mode: "100644", path: "a.txt", oid: blob, type: "blob" }] })
      return git.writeCommit({ fs, gitdir, commit: { tree, parent, message: "m\n", author, committer: author } })
    }
    const base = await commit("one\ntwo\nthree\n", [])
    const ours = await commit("ONE\ntwo\nthree\n", [base])
    const theirs = await commit("uno\ntwo\nthree\n", [base])
    const clean = await commit("one\ntwo\nTHREE!\n", [base])
    await git.writeRef({ fs, gitdir, ref: "refs/heads/main", value: ours })
    await git.writeRef({ fs, gitdir, ref: "refs/heads/theirs", value: theirs })
    await git.writeRef({ fs, gitdir, ref: "refs/heads/clean", value: clean })

    const conflict = await git
      .merge({ fs, gitdir, ours: "main", theirs: "theirs", dryRun: true, noUpdateBranch: true, abortOnConflict: true, author })
      .then(
        () => null,
        (err: unknown) => err as { code?: string; data?: { filepaths?: string[] } },
      )
    expect(conflict?.code).toBe("MergeConflictError")
    expect(conflict?.data?.filepaths).toEqual(["a.txt"])
    expect(await git.resolveRef({ fs, gitdir, ref: "main" })).toBe(ours)

    const result = await git.merge({ fs, gitdir, ours: "main", theirs: "clean", fastForward: false, noUpdateBranch: true, author, message: "merge\n" })
    expect(result.mergeCommit).toBe(true)
    const merged = await git.readCommit({ fs, gitdir, oid: result.oid ?? "" })
    expect(merged.commit.parent).toEqual([ours, clean])
    const { blob } = await git.readBlob({ fs, gitdir, oid: result.oid ?? "", filepath: "a.txt" })
    expect(new TextDecoder().decode(blob)).toBe("ONE\ntwo\nTHREE!\n")
    expect(await git.resolveRef({ fs, gitdir, ref: "main" })).toBe(ours)
  })
})

describe("Mutex", () => {
  it("runs tasks one at a time in order and survives a failing task", async () => {
    const mutex = new Mutex()
    const order: string[] = []
    const slow = mutex.run(async () => {
      order.push("a:start")
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push("a:end")
    })
    const failing = mutex.run(async () => {
      order.push("b")
      throw new Error("boom")
    })
    const last = mutex.run(async () => {
      order.push("c")
      return 7
    })
    expect(mutex.busy).toBe(true)
    expect(mutex.tryRun(async () => 1)).toBeUndefined()
    await slow
    await expect(failing).rejects.toThrow("boom")
    expect(await last).toBe(7)
    expect(order).toEqual(["a:start", "a:end", "b", "c"])
    await Promise.resolve()
    expect(mutex.busy).toBe(false)
  })
})
