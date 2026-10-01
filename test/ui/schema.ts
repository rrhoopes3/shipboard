/**
 * A tiny runtime schema whose static type is tied to src/core/types.ts. `obj<T>()` must name every
 * key of T with a schema of exactly that key's type (Schema is invariant), so a field added to the
 * contract breaks `npm run typecheck` until the UI fixtures' schema knows it. At runtime it rejects
 * missing keys, wrong types, unknown enum values and keys the contract does not have.
 */

export type Schema<T> = {
  check(value: unknown, path: string, errors: string[]): void
  /** Phantom, for invariance: Schema<"a"> and Schema<string> do not assign to each other. */
  readonly _type?: (value: T) => T
}

const typeName = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v)

export const str: Schema<string> = {
  check(v, path, errors) {
    if (typeof v !== "string") errors.push(`${path}: expected a string, got ${typeName(v)}`)
  },
}

export const num: Schema<number> = {
  check(v, path, errors) {
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${path}: expected a number, got ${typeName(v)}`)
  },
}

export const bool: Schema<boolean> = {
  check(v, path, errors) {
    if (typeof v !== "boolean") errors.push(`${path}: expected a boolean, got ${typeName(v)}`)
  },
}

/** An ISO timestamp as the core writes it. */
export const iso: Schema<string> = {
  check(v, path, errors) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)) errors.push(`${path}: expected an ISO time, got ${JSON.stringify(v)}`)
  },
}

export const sha40: Schema<string> = {
  check(v, path, errors) {
    if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) errors.push(`${path}: expected a 40-hex sha, got ${JSON.stringify(v)}`)
  },
}

export function lit<const T extends string>(...values: T[]): Schema<T> {
  return {
    check(v, path, errors) {
      if (typeof v !== "string" || !(values as string[]).includes(v)) errors.push(`${path}: expected one of ${values.join(", ")}, got ${JSON.stringify(v)}`)
    },
  }
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return {
    check(v, path, errors) {
      if (v !== null) inner.check(v, path, errors)
    },
  }
}

const OPTIONAL = Symbol("optional")

/** For `key?: T`: the key may be absent, but never present as undefined or null. */
export function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  return {
    [OPTIONAL]: true,
    check(v, path, errors) {
      if (v === undefined || v === null) errors.push(`${path}: optional keys are left out, not set to ${String(v)}`)
      else inner.check(v, path, errors)
    },
  } as Schema<T | undefined>
}

export function arr<T>(inner: Schema<T>): Schema<T[]> {
  return {
    check(v, path, errors) {
      if (!Array.isArray(v)) {
        errors.push(`${path}: expected an array, got ${typeName(v)}`)
        return
      }
      v.forEach((item, i) => inner.check(item, `${path}[${i}]`, errors))
    },
  }
}

export function obj<T>(shape: { [K in keyof Required<T>]: Schema<T[K]> }): Schema<T> {
  return {
    check(v, path, errors) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        errors.push(`${path}: expected an object, got ${typeName(v)}`)
        return
      }
      const record = v as Record<string, unknown>
      const known = shape as Record<string, Schema<unknown>>
      for (const [key, schema] of Object.entries(known)) {
        const isOptional = Boolean((schema as unknown as Record<symbol, unknown>)[OPTIONAL])
        if (!(key in record)) {
          if (!isOptional) errors.push(`${path}.${key}: missing`)
          continue
        }
        schema.check(record[key], `${path}.${key}`, errors)
      }
      for (const key of Object.keys(record)) {
        if (!(key in known)) errors.push(`${path}.${key}: not in the contract`)
      }
    },
  }
}

export function validate<T>(schema: Schema<T>, value: unknown, path = "$"): string[] {
  const errors: string[] = []
  schema.check(value, path, errors)
  return errors
}
