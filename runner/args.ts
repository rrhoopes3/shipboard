/**
 * Tiny argv parser shared by the runner and the agent CLI. Every value flag is repeatable; callers
 * decide whether they want the last value or all of them. `--flag=value` and `--flag value` both
 * work. A value that looks like another known flag is treated as a missing value, so
 * `--task --path x` fails loudly instead of dispatching a task called "--path".
 */

export type FlagSpec = {
  /** Flags that take a value, without the leading dashes. */
  values: readonly string[]
  /** Flags that are on/off, without the leading dashes. */
  booleans: readonly string[]
}

export type ParsedArgs = {
  positionals: string[]
  values: Map<string, string[]>
  booleans: Set<string>
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}

export function parseArgs(argv: readonly string[], spec: FlagSpec): ParsedArgs {
  const values = new Map<string, string[]>()
  const booleans = new Set<string>()
  const positionals: string[] = []
  const known = new Set([...spec.values, ...spec.booleans])

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? ""
    if (token === "--") {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (!token.startsWith("--") || token === "--") {
      positionals.push(token)
      continue
    }
    const eq = token.indexOf("=")
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    if (!known.has(name)) throw new UsageError(`Unknown flag --${name}.`)

    if (spec.booleans.includes(name)) {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value.`)
      booleans.add(name)
      continue
    }

    let value: string | undefined
    if (eq !== -1) {
      value = token.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith("--") && known.has(next.slice(2).split("=")[0] ?? ""))) {
        throw new UsageError(`--${name} needs a value.`)
      }
      value = next
      i += 1
    }
    const list = values.get(name) ?? []
    list.push(value)
    values.set(name, list)
  }

  return { positionals, values, booleans }
}

/** Last value given for a flag, or undefined. */
export function lastValue(args: ParsedArgs, name: string): string | undefined {
  const list = args.values.get(name)
  return list === undefined ? undefined : list[list.length - 1]
}

/** Every value given for a repeatable flag, in order. */
export function allValues(args: ParsedArgs, name: string): string[] {
  return [...(args.values.get(name) ?? [])]
}
