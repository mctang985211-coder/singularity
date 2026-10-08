/**
 * The seal a concluded coordination session wears: after the completion, writes
 * are refused at execution time while reads stay available — and the guard is
 * installed by the composition, so a resume rebuilds it too.
 */
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  COORDINATION_SEALED_ALLOW,
  COORDINATION_WRITE_DENIAL,
  guardCoordinationWrites,
  isCoordinationSealed,
  sealCoordinationSession,
} from '../../src/coordination-seal.ts'

type Guard = (execution: { name: string }) => string | undefined

function harness(agentId: string): { readonly ctx: Context; readonly guard: Guard } {
  let guard: Guard = () => undefined
  const ctx = {
    tools: {
      guard(next: Guard) {
        guard = next
      },
    },
  } as unknown as Context
  guardCoordinationWrites(ctx, { id: agentId as SessionId } as Agent, COORDINATION_SEALED_ALLOW)
  return { ctx, guard: execution => guard(execution) }
}

describe('the coordination seal', () => {
  test('before the completion every call the composition allows is untouched', () => {
    const h = harness('s-unsealed')
    expect(isCoordinationSealed('s-unsealed')).toBe(false)
    for (const name of ['write', 'bash', 'task_read', 'supervisor_complete']) expect(h.guard({ name })).toBeUndefined()
  })

  test('after the completion the write surfaces are refused and the reads are not', () => {
    const h = harness('s-sealed')
    sealCoordinationSession('s-sealed')
    expect(isCoordinationSealed('s-sealed')).toBe(true)
    for (const name of ['write', 'edit', 'bash', 'graph_spawn', 'task_decompose', 'evolution_apply', 'method_publish'])
      expect(h.guard({ name })).toBe(COORDINATION_WRITE_DENIAL)
    for (const name of ['read', 'glob', 'grep', 'task_read', 'task_status', 'context_read', 'task_review_pack', 'skill'])
      expect(h.guard({ name })).toBeUndefined()
  })

  test('a completion may be called again, so a repeat gets an idempotent answer rather than a denial', () => {
    const h = harness('s-repeat')
    sealCoordinationSession('s-repeat')
    expect(h.guard({ name: 'supervisor_complete' })).toBeUndefined()
    expect(h.guard({ name: 'reviewer_complete' })).toBeUndefined()
  })

  test('the seal is per session: another session of the same store is untouched', () => {
    const h = harness('s-other')
    sealCoordinationSession('s-sealed-elsewhere')
    expect(h.guard({ name: 'write' })).toBeUndefined()
    void vi
  })
})
