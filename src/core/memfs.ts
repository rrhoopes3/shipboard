/**
 * In-memory filesystem for isomorphic-git. Based on the MemoryFS from the Cloudflare Artifacts
 * isomorphic-git example, with the fixes isomorphic-git 1.42 needs:
 * - `promises.readlink` and `promises.symlink` exist (isomorphic-git binds them unconditionally),
 * - every thrown error carries a Node-style `.code` (isomorphic-git branches on ENOENT/ENOTDIR/EEXIST),
 * - `promises.rm` exists so isomorphic-git does not mistake a two-argument `rmdir` for a recursive rm.
 * Platform-neutral: no node:* imports.
 */

type FileEntry = { kind: "file"; data: Uint8Array; mtimeMs: number; mode: number }
type DirEntry = { kind: "dir"; children: Set<string>; mtimeMs: number }
type LinkEntry = { kind: "symlink"; target: string; mtimeMs: number }
type Entry = FileEntry | DirEntry | LinkEntry

export type FsErrorCode = "ENOENT" | "ENOTDIR" | "EEXIST" | "ENOTEMPTY" | "EISDIR"

export class FsError extends Error {
  constructor(
    readonly code: FsErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`)
    this.name = "FsError"
  }
}

export class MemoryStats {
  readonly dev = 0
  readonly ino = 0
  readonly uid = 0
  readonly gid = 0

  constructor(private readonly entry: Entry) {}

  get size(): number {
    if (this.entry.kind === "file") return this.entry.data.byteLength
    if (this.entry.kind === "symlink") return this.entry.target.length
    return 0
  }

  get mode(): number {
    if (this.entry.kind === "file") return this.entry.mode
    if (this.entry.kind === "symlink") return 0o120000
    return 0o040000
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs
  }

  isFile(): boolean {
    return this.entry.kind === "file"
  }

  isDirectory(): boolean {
    return this.entry.kind === "dir"
  }

  isSymbolicLink(): boolean {
    return this.entry.kind === "symlink"
  }
}

type Encoding = { encoding?: string | null } | string | undefined
type WriteOptions = { mode?: number } | string | undefined

export type MemoryFsPromises = {
  readFile(path: string, options?: Encoding): Promise<Uint8Array | string>
  writeFile(path: string, data: Uint8Array | ArrayBuffer | string, options?: WriteOptions): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void>
  rmdir(path: string): Promise<void>
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  stat(path: string): Promise<MemoryStats>
  lstat(path: string): Promise<MemoryStats>
  readlink(path: string, options?: Encoding): Promise<string | Uint8Array>
  symlink(target: string, path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

export class MemoryFS {
  private readonly entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]])
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()

  /** isomorphic-git detects a promise fs by an enumerable own `promises` property. */
  readonly promises: MemoryFsPromises = {
    readFile: (path, options) => this.readFile(path, options),
    writeFile: (path, data, options) => this.writeFile(path, data, options),
    unlink: (path) => this.unlink(path),
    readdir: (path) => this.readdir(path),
    mkdir: (path, options) => this.mkdir(path, options),
    rmdir: (path) => this.rmdir(path),
    rm: (path, options) => this.rm(path, options),
    stat: (path) => this.stat(path),
    lstat: (path) => this.lstat(path),
    readlink: (path, options) => this.readlink(path, options),
    symlink: (target, path) => this.symlink(target, path),
    chmod: (path, mode) => this.chmod(path, mode),
  }

  /** Bytes held in file contents. Useful to watch memory in a Worker. */
  get size(): number {
    let total = 0
    for (const entry of this.entries.values()) if (entry.kind === "file") total += entry.data.byteLength
    return total
  }

  normalize(input: string): string {
    if (typeof input !== "string") throw new FsError("ENOENT", String(input))
    const segments: string[] = []
    for (const part of input.split("/")) {
      if (!part || part === ".") continue
      if (part === "..") {
        segments.pop()
        continue
      }
      segments.push(part)
    }
    return `/${segments.join("/")}`
  }

  private parent(path: string): string {
    const parts = this.normalize(path).split("/").filter(Boolean)
    parts.pop()
    return `/${parts.join("/")}`
  }

  private basename(path: string): string {
    return this.normalize(path).split("/").filter(Boolean).pop() ?? ""
  }

  private lookup(path: string): Entry {
    const entry = this.entries.get(this.normalize(path))
    if (!entry) throw new FsError("ENOENT", path)
    return entry
  }

  private requireDir(path: string): DirEntry {
    const entry = this.lookup(path)
    if (entry.kind !== "dir") throw new FsError("ENOTDIR", path)
    return entry
  }

  /** The parent must already exist and be a directory, as with Node's fs. */
  private attach(target: string, entry: Entry): void {
    const parentPath = this.parent(target)
    const parent = this.entries.get(parentPath)
    if (!parent) throw new FsError("ENOENT", parentPath)
    if (parent.kind !== "dir") throw new FsError("ENOTDIR", parentPath)
    this.entries.set(target, entry)
    parent.children.add(this.basename(target))
    parent.mtimeMs = Date.now()
  }

  private detach(target: string): void {
    this.entries.delete(target)
    const parent = this.entries.get(this.parent(target))
    if (parent?.kind === "dir") parent.children.delete(this.basename(target))
  }

  async mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void> {
    const target = this.normalize(path)
    const recursive = typeof options === "object" && options !== null && options.recursive === true
    const existing = this.entries.get(target)
    if (existing) {
      if (recursive && existing.kind === "dir") return
      throw new FsError("EEXIST", path)
    }
    if (recursive && !this.entries.has(this.parent(target))) {
      await this.mkdir(this.parent(target), { recursive: true })
    }
    this.attach(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() })
  }

  async writeFile(path: string, data: Uint8Array | ArrayBuffer | string, options?: WriteOptions): Promise<void> {
    const target = this.normalize(path)
    const existing = this.entries.get(target)
    if (existing?.kind === "dir") throw new FsError("EISDIR", path)
    const bytes =
      typeof data === "string" ? this.encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
    const mode = typeof options === "object" && options?.mode ? options.mode : existing?.kind === "file" ? existing.mode : 0o100644
    const entry: FileEntry = { kind: "file", data: bytes, mtimeMs: Date.now(), mode: mode === 0o755 || mode === 0o100755 ? 0o100755 : 0o100644 }
    if (existing) this.entries.set(target, entry)
    else this.attach(target, entry)
  }

  async readFile(path: string, options?: Encoding): Promise<Uint8Array | string> {
    const entry = this.lookup(path)
    if (entry.kind === "dir") throw new FsError("EISDIR", path)
    if (entry.kind === "symlink") return this.readFile(entry.target, options)
    const encoding = typeof options === "string" ? options : options?.encoding
    return encoding ? this.decoder.decode(entry.data) : entry.data
  }

  async readdir(path: string): Promise<string[]> {
    return [...this.requireDir(path).children].sort()
  }

  async unlink(path: string): Promise<void> {
    const target = this.normalize(path)
    const entry = this.lookup(target)
    if (entry.kind === "dir") throw new FsError("EISDIR", path)
    this.detach(target)
  }

  async rmdir(path: string): Promise<void> {
    const target = this.normalize(path)
    if (target === "/") throw new FsError("ENOTEMPTY", path)
    const entry = this.requireDir(target)
    if (entry.children.size > 0) throw new FsError("ENOTEMPTY", path)
    this.detach(target)
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const target = this.normalize(path)
    const entry = this.entries.get(target)
    if (!entry) {
      if (options?.force) return
      throw new FsError("ENOENT", path)
    }
    if (entry.kind === "dir") {
      if (!options?.recursive && entry.children.size > 0) throw new FsError("ENOTEMPTY", path)
      for (const child of [...entry.children]) await this.rm(`${target}/${child}`, { recursive: true, force: true })
      if (target === "/") return
    }
    this.detach(target)
  }

  async stat(path: string): Promise<MemoryStats> {
    const entry = this.lookup(path)
    if (entry.kind === "symlink") return this.stat(entry.target)
    return new MemoryStats(entry)
  }

  async lstat(path: string): Promise<MemoryStats> {
    return new MemoryStats(this.lookup(path))
  }

  async readlink(path: string, options?: Encoding): Promise<string | Uint8Array> {
    const entry = this.lookup(path)
    if (entry.kind !== "symlink") throw new FsError("ENOENT", path)
    const encoding = typeof options === "string" ? options : options?.encoding
    return encoding === "buffer" ? this.encoder.encode(entry.target) : entry.target
  }

  async symlink(target: string, path: string): Promise<void> {
    const at = this.normalize(path)
    if (this.entries.has(at)) throw new FsError("EEXIST", path)
    this.attach(at, { kind: "symlink", target, mtimeMs: Date.now() })
  }

  async chmod(path: string, mode: number): Promise<void> {
    const entry = this.lookup(path)
    if (entry.kind === "file") entry.mode = (mode & 0o111) !== 0 ? 0o100755 : 0o100644
  }
}
