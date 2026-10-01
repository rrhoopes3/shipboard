import path from "node:path"
import { BoardError } from "./errors.ts"

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isId(value: string): boolean {
  return ID.test(value) && value.length <= 48
}

export function slug(input: string, fallback: string): string {
  const stem = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/^-+|-+$/g, "")
  return stem || fallback
}

export function oneLine(input: string, fallback = "update"): string {
  const line = input.replace(/\s+/g, " ").trim().slice(0, 180)
  return line || fallback
}

export function assertSafeRel(input: unknown): string {
  if (typeof input !== "string") {
    throw new BoardError("Use a relative path inside the repo.", 400)
  }
  const slashed = input.replace(/\\/g, "/").trim()
  if (!slashed || slashed.length > 200 || slashed.includes("\0")) {
    throw new BoardError("Use a relative path inside the repo.", 400)
  }
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(input.trim())) {
    throw new BoardError("Use a relative path inside the repo.", 400)
  }
  const norm = path.posix.normalize(slashed)
  if (norm === ".." || norm.startsWith("../")) {
    throw new BoardError("Use a relative path inside the repo.", 400)
  }
  const parts = norm.split("/")
  if (parts.some((part) => part === "" || part === "." || part === ".." || part === ".git")) {
    throw new BoardError("Use a relative path inside the repo.", 400)
  }
  if (/\s/.test(norm)) {
    throw new BoardError("Paths cannot contain spaces.", 400)
  }
  return norm
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    return "&quot;"
  })
}
