// A small reader for the POSIX shell lines Claude hands the Bash tool. It finds the simple commands a
// line would run (through quotes, escapes, &&/||/;/|, subshells, $( ), backticks, heredocs) so the
// guard can look at each one. It does not evaluate anything: a word built at run time ($VAR, $(cmd),
// aliases, functions, sourced files) is marked DYNAMIC and stays unknown.

/** Stands in for any part of a word that only exists at run time. */
export const DYNAMIC = "\u0000"

export type Command = {
  words: string[]
  /** Body of a heredoc or here-string fed to this command. */
  stdin: string | null
  /** The command this one reads from through a pipe. */
  pipedFrom: Command | null
}

export type Item = { kind: "command"; command: Command } | { kind: "open" } | { kind: "close" }

export type Parsed = {
  items: Item[]
  /** Sources of $( ), backticks and <( ) found anywhere in the line, to be read on their own. */
  nested: string[]
}

const REDIRECT = /^(?:<<<|<<-|<<|<>|<&|<|>>|>&|>\||>|&>>|&>)/

export function parseLine(src: string): Parsed {
  const items: Item[] = []
  const nested: string[] = []
  let cmd = newCommand(null)
  let word = ""
  let inWord = false
  let redirect: "skip" | "heredoc" | "heredoc-strip" | "herestring" | null = null
  const heredocs: { command: Command; delim: string; strip: boolean }[] = []
  let i = 0

  const endWord = () => {
    if (!inWord) return
    if (redirect === "heredoc" || redirect === "heredoc-strip") {
      heredocs.push({ command: cmd, delim: word.split(DYNAMIC).join(""), strip: redirect === "heredoc-strip" })
    } else if (redirect === "herestring") {
      cmd.stdin = word
    } else if (redirect === null) {
      cmd.words.push(word)
    }
    redirect = null
    word = ""
    inWord = false
  }

  const endCommand = (piped = false) => {
    endWord()
    if (cmd.words.length > 0 || cmd.stdin !== null || heredocs.some((h) => h.command === cmd)) {
      items.push({ kind: "command", command: cmd })
    }
    cmd = newCommand(piped ? cmd : null)
  }

  const readHeredocs = () => {
    for (const doc of heredocs.splice(0)) {
      const lines: string[] = []
      while (i < src.length) {
        const end = src.indexOf("\n", i)
        const raw = end === -1 ? src.slice(i) : src.slice(i, end)
        i = end === -1 ? src.length : end + 1
        const line = doc.strip ? raw.replace(/^\t+/, "") : raw
        if (line === doc.delim) break
        lines.push(line)
      }
      doc.command.stdin = lines.join("\n")
    }
  }

  while (i < src.length) {
    const c = src[i] ?? ""
    const rest = src.slice(i)

    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2
        continue
      }
      word += src[i + 1] ?? ""
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      word += end === -1 ? src.slice(i + 1) : src.slice(i + 1, end)
      inWord = true
      i = end === -1 ? src.length : end + 1
      continue
    }
    if (c === "$" && src[i + 1] === "'") {
      const { text, next } = ansiC(src, i + 2)
      word += text
      inWord = true
      i = next
      continue
    }
    if (c === '"' || (c === "$" && src[i + 1] === '"')) {
      i += c === "$" ? 2 : 1
      while (i < src.length && src[i] !== '"') {
        const d = src[i] ?? ""
        if (d === "\\" && /["\\$`\n]/.test(src[i + 1] ?? "")) {
          if (src[i + 1] !== "\n") word += src[i + 1]
          i += 2
        } else if (d === "$" || d === "`") {
          const sub = substitution(src, i)
          if (sub.source !== null) nested.push(sub.source)
          word += DYNAMIC + src.slice(i, sub.next)
          i = sub.next
        } else {
          word += d
          i += 1
        }
      }
      inWord = true
      i += 1
      continue
    }
    if (c === "$" || c === "`") {
      const sub = substitution(src, i)
      if (sub.next > i + 1 || c === "`") {
        if (sub.source !== null) nested.push(sub.source)
        word += DYNAMIC + src.slice(i, sub.next)
        inWord = true
        i = sub.next
        continue
      }
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(" && !inWord) {
      const end = closing(src, i + 2, "(", ")")
      nested.push(src.slice(i + 2, end))
      word += DYNAMIC
      inWord = true
      i = Math.min(src.length, end + 1)
      continue
    }
    if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
      if (inWord && /^\d+$/.test(word)) {
        word = ""
        inWord = false
      }
      endWord()
      const op = REDIRECT.exec(rest)?.[0] ?? c
      redirect = op === "<<" ? "heredoc" : op === "<<-" ? "heredoc-strip" : op === "<<<" ? "herestring" : "skip"
      i += op.length
      continue
    }
    if (c === "#" && !inWord) {
      const end = src.indexOf("\n", i)
      i = end === -1 ? src.length : end
      continue
    }
    if (c === " " || c === "\t") {
      endWord()
      i += 1
      continue
    }
    if (c === "\n") {
      endCommand()
      i += 1
      readHeredocs()
      continue
    }
    if (c === ";") {
      endCommand()
      i += src[i + 1] === ";" ? 2 : 1
      continue
    }
    if (c === "&") {
      endCommand()
      i += src[i + 1] === "&" ? 2 : 1
      continue
    }
    if (c === "|") {
      const isOr = src[i + 1] === "|"
      endCommand(!isOr)
      i += isOr || src[i + 1] === "&" ? 2 : 1
      continue
    }
    if (c === "(" || c === ")") {
      endCommand()
      items.push({ kind: c === "(" ? "open" : "close" })
      i += 1
      continue
    }
    word += c
    inWord = true
    i += 1
  }
  endCommand()
  return { items, nested }
}

/** The words of a line as typed (nothing expanded), ignoring command boundaries. For slash-command arguments. */
export function splitWords(src: string): string[] {
  return parseLine(src)
    .items.flatMap((item) => (item.kind === "command" ? item.command.words : []))
    .map((word) => word.split(DYNAMIC).join(""))
}

export function isDynamic(word: string): boolean {
  return word.includes(DYNAMIC)
}

function newCommand(pipedFrom: Command | null): Command {
  return { words: [], stdin: null, pipedFrom }
}

/** `$( )`, `$(( ))`, `${ }`, `$name` or a backtick span starting at `start`. */
function substitution(src: string, start: number): { source: string | null; next: number } {
  if (src[start] === "`") {
    let j = start + 1
    while (j < src.length && src[j] !== "`") j += src[j] === "\\" ? 2 : 1
    return { source: src.slice(start + 1, j), next: Math.min(src.length, j + 1) }
  }
  const after = src[start + 1]
  if (after === "(") {
    const end = closing(src, start + 2, "(", ")")
    return { source: src.slice(start + 2, end), next: Math.min(src.length, end + 1) }
  }
  if (after === "{") {
    const end = closing(src, start + 2, "{", "}")
    return { source: null, next: Math.min(src.length, end + 1) }
  }
  const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9#?$!*@-])/.exec(src.slice(start + 1))
  return { source: null, next: start + 1 + (name?.[0].length ?? 0) }
}

/** Index of the bracket that closes the one opened just before `from`, honouring quotes. */
function closing(src: string, from: number, open: string, close: string): number {
  let depth = 1
  let j = from
  while (j < src.length) {
    const d = src[j]
    if (d === "\\") {
      j += 2
      continue
    }
    if (d === "'") {
      const end = src.indexOf("'", j + 1)
      j = end === -1 ? src.length : end + 1
      continue
    }
    if (d === '"') {
      j += 1
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1
      j += 1
      continue
    }
    if (d === open) depth += 1
    if (d === close) {
      depth -= 1
      if (depth === 0) return j
    }
    j += 1
  }
  return src.length
}

/** Bash's $'...' quoting, which can spell any byte with escapes (`$'\x67it'` is `git`). */
function ansiC(src: string, from: number): { text: string; next: number } {
  let text = ""
  let j = from
  while (j < src.length && src[j] !== "'") {
    const d = src[j] ?? ""
    if (d !== "\\") {
      text += d
      j += 1
      continue
    }
    const e = src[j + 1] ?? ""
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(j + 1))
    const oct = /^([0-7]{1,3})/.exec(src.slice(j + 1))
    if (hex) {
      text += String.fromCharCode(parseInt(hex[1] ?? "0", 16))
      j += 1 + hex[0].length
    } else if (oct) {
      text += String.fromCharCode(parseInt(oct[1] ?? "0", 8))
      j += 1 + oct[0].length
    } else {
      text += ({ n: "\n", t: "\t", r: "\r", a: "\u0007", b: "\b", e: "\u001b", f: "\f", v: "\v" } as Record<string, string>)[e] ?? e
      j += 2
    }
  }
  return { text, next: Math.min(src.length, j + 1) }
}
