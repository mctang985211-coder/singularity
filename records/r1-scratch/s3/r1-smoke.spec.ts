/**
 * The standalone smoke gate: the same one minimal real call the run's first
 * step performs, runnable on its own to check connectivity before a full run.
 */

import { describe, expect, it } from 'vitest'
import { smokeCall } from './r1-smoke.ts'

describe('r1 smoke: one minimal real model call', () => {
  it('reaches the configured gateway and reports usage', async () => {
    const result = await smokeCall()
    console.log(JSON.stringify({ smoke: result }, null, 2))
    expect(result.ok, result.error ?? 'the gateway did not answer').toBe(true)
    expect(JSON.stringify(result.finishReason)).toContain('stop')
  }, 130_000)
})
