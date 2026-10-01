/** The small primitives every module here shares: error text, waiting, and shape checks. */

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

export function now(): string {
  return new Date().toISOString()
}

/** Non-blank text: the one check every string field shares, with no rewriting of the value. */
export function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** The keys a value carries that a closed field set does not declare, in declaration order. */
export function unknownFieldKeys(value: object, allowed: ReadonlySet<string> | readonly string[]): string[] {
  const declared = new Set<string>(allowed)
  return Object.keys(value).filter(key => !declared.has(key))
}

/** Run `work` after the work already queued under `key`, in call order; the drained entry goes. */
export function enqueueByKey<T>(chains: Map<string, Promise<void>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(work, work)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return run
}
