import { readFileSync } from "node:fs"
import { createContext, runInContext } from "node:vm"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("../../public/js/theme-init.js", import.meta.url), "utf8")

function load({ hash = "", pathname = "/", search = "", storage = new Map(), session = new Map(), replaceState } = {}) {
  const location = { hash, pathname, search }
  const history = {
    replaceState: replaceState ?? ((_state, _title, url) => {
      location.hash = ""
      location.href = url
    }),
  }
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }
  const sessionStorage = {
    getItem: (key) => session.get(key) ?? null,
    setItem: (key, value) => session.set(key, value),
    removeItem: (key) => session.delete(key),
  }
  const document = { documentElement: { dataset: {} } }
  const context = createContext({ location, history, localStorage, sessionStorage, document, URLSearchParams })
  runInContext(source, context)
  return { location, storage, session }
}

describe("unlock bookmark", () => {
  it("stores the fragment token and takes it off the address", () => {
    const { location, storage, session } = load({ hash: "#unlock=abc123", pathname: "/p/harbor-notes-3f2a", search: "?utc=1" })
    expect(storage.get("shipboard.boardToken")).toBe("abc123")
    expect(session.get("shipboard.justUnlocked")).toBe("1")
    expect(location.href).toBe("/p/harbor-notes-3f2a?utc=1")
    expect(location.hash).toBe("")
  })

  it("decodes the fragment once", () => {
    const { storage } = load({ hash: "#unlock=ab%2Bcd" })
    expect(storage.get("shipboard.boardToken")).toBe("ab+cd")
  })

  it("leaves a blocked store's fragment in place", () => {
    const storage = new Map()
    storage.set = () => {
      throw new Error("blocked")
    }
    const { location, session } = load({ hash: "#unlock=abc123", storage })
    expect(session.has("shipboard.justUnlocked")).toBe(false)
    expect(location.hash).toBe("#unlock=abc123")
    expect(location.href).toBeUndefined()
  })

  it("ignores an ordinary hash and an empty unlock", () => {
    const themed = load({ hash: "#main", search: "?theme=dark" })
    expect(themed.storage.has("shipboard.boardToken")).toBe(false)
    expect(themed.location.hash).toBe("#main")

    const empty = load({ hash: "#unlock=" })
    expect(empty.storage.has("shipboard.boardToken")).toBe(false)
    expect(empty.location.href).toBe("/")
  })
})
