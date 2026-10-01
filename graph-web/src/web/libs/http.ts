import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY = 64 * 1024

/** The request URL against the harness-local base; every route reads its query and path through this. */
export function urlOf(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://dsh.local')
}

export function send(res: ServerResponse, status: number, type: string, value: unknown): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof value === 'string' ? value : JSON.stringify(value))
}

/** Answer with a JSON value. */
export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', value)
}

export async function readJson<T>(req: IncomingMessage, limit = MAX_BODY): Promise<T> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buf.length
    if (length > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) throw new Error('empty request body')
  return JSON.parse(raw) as T
}

/** Answer 405 and report `false` unless the request method is one of `allowed`. */
export function guardMethod(req: IncomingMessage, res: ServerResponse, ...allowed: string[]): boolean {
  if (allowed.includes(req.method ?? '')) return true
  send(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
  return false
}

/** Answer with the error's message; `status` defaults to 400. */
export function fail(res: ServerResponse, error: unknown, status = 400): void {
  send(res, status, 'text/plain; charset=utf-8', messageOf(error))
}

/** The `graphId` query parameter, or the caller-named refusal when it is absent. */
export function graphIdOf(req: IncomingMessage, who: string): string {
  const id = urlOf(req).searchParams.get('graphId')
  if (id === null) throw new Error(`${who}: graphId required`)
  return id
}

/** One required non-empty query parameter, or the caller-named refusal when it is absent. */
export function queryOf(req: IncomingMessage, key: string, who: string): string {
  const value = urlOf(req).searchParams.get(key)
  if (value === null || value.length === 0) throw new Error(`${who}: ${key} required`)
  return value
}

/** The error's message, or the value itself when it is not an error. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
