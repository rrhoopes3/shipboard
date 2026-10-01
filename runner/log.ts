/**
 * One-line logs with token redaction. Every line the runner prints goes through `redact`, which
 * removes tokens it has been told about plus anything shaped like an Artifacts token or a Bearer
 * header, so a git error that echoes a header cannot leak a credential into the terminal.
 */

const TOKEN_SHAPE = /art_v1_[0-9A-Za-z]+(?:\?expires=\d+)?/g
const BEARER_SHAPE = /(Bearer\s+)[^\s"']+/gi

export class Redactor {
  private readonly secrets = new Set<string>()

  /** Remember a secret. The part before `?expires=` is remembered too, since that is what Basic auth uses. */
  add(secret: string | undefined): void {
    if (!secret) return
    this.secrets.add(secret)
    const bare = secret.split("?expires=")[0]
    if (bare && bare.length >= 8) this.secrets.add(bare)
  }

  redact(text: string): string {
    let out = text
    // Longest first, so the full token is replaced before its bare prefix.
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join("***")
    }
    return out.replace(TOKEN_SHAPE, "art_v1_***").replace(BEARER_SHAPE, "$1***")
  }
}

export type LogLevel = "info" | "warn" | "error"

export type LogSink = (level: LogLevel, line: string) => void

export const consoleSink: LogSink = (level, line) => {
  if (level === "info") console.log(line)
  else console.error(line)
}

export class RunnerLog {
  constructor(
    readonly redactor: Redactor = new Redactor(),
    private readonly sink: LogSink = consoleSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** `12:04:31 harbor-notes-3f2a--tint-the-pier-n-77de grok cloned 1a2b3c4` */
  job(attemptId: string, agent: string, message: string, level: LogLevel = "info"): void {
    this.write(level, `${attemptId} ${agent} ${message}`)
  }

  info(message: string): void {
    this.write("info", message)
  }

  warn(message: string): void {
    this.write("warn", message)
  }

  error(message: string): void {
    this.write("error", message)
  }

  private write(level: LogLevel, message: string): void {
    const time = this.clock().toTimeString().slice(0, 8)
    const oneLine = message.replace(/\s*\n\s*/g, " | ").trim()
    this.sink(level, this.redactor.redact(`${time} ${oneLine}`))
  }
}
