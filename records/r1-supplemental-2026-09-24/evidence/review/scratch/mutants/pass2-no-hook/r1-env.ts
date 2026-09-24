/**
 * R1 driver: environment loading for the fixed experiment contract.
 *
 * The gateway credentials come from the deployment's own `.dsh/api.env`
 * (DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL), exported into the process environment
 * for the plugin's `resolveApiKey` path. Nothing here ever logs a secret: the
 * only strings that may appear in evidence pass through `redact` first.
 */

import { readFileSync } from 'node:fs'

export const API_ENV_PATH = '/home/ROXY/code/bb_work/harness/.dsh/api.env'

export const MODEL = 'step-5-preview'
export const PROVIDER = 'deepseek-official'
export const REASONING_EFFORT = 'high'

interface EnvFile {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
}

function parseEnvFile(path: string): EnvFile {
  const text = readFileSync(path, 'utf8')
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    values.set(trimmed.slice(0, eq), trimmed.slice(eq + 1))
  }
  const apiKey = values.get('DEEPSEEK_API_KEY')
  const baseUrl = values.get('DEEPSEEK_BASE_URL')
  if (apiKey === undefined || apiKey.length === 0) throw new Error(`r1: ${API_ENV_PATH} carries no DEEPSEEK_API_KEY`)
  if (baseUrl === undefined || baseUrl.length === 0) throw new Error(`r1: ${API_ENV_PATH} carries no DEEPSEEK_BASE_URL`)
  return { apiKey, baseUrl, model: values.get('DEEPSEEK_MODEL') ?? MODEL }
}

/** Loaded once per process; `keyLength` is the only fact about the key evidence may carry. */
export const gateway = ((): EnvFile => {
  const env = parseEnvFile(API_ENV_PATH)
  process.env.DEEPSEEK_API_KEY = env.apiKey
  process.env.DEEPSEEK_BASE_URL = env.baseUrl
  return env
})()

/** Strip the bearer token from any text before it reaches a log or an artifact. */
export function redact(text: string): string {
  return text.split(gateway.apiKey).join('<redacted-api-key>')
}
