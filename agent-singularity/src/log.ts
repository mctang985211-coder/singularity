import type { Context } from '@deepseek-ai/cordis'

/** The soft logger a deployment may mount: absent logger, no crash — the line is simply not written. */
export function logOf(ctx: Context, name: string): { warn(format: string): void; info(format: string): void } | undefined {
  const logger = (ctx as { logger?: (name: string) => { warn(format: string): void; info(format: string): void } }).logger
  return logger?.(name)
}

/** A `(line) => void` warn sink over the soft logger, for triggers that report their work off the caller's path. */
export function warnLine(ctx: Context, name = 'singularity-agent'): (line: string) => void {
  return line => logOf(ctx, name)?.warn(line)
}
