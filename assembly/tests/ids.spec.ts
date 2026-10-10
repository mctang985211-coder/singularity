/**
 * The stable ids: what one tool call names, on every delivery of that call.
 *
 * These are the names a caller reads back from a tool answer and the names the log carries, so the
 * only thing worth locking is the derivation itself — the same request producing the same id, and a
 * different request producing a different one.
 */

import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { runIdOf, taskIdOf } from '../src/ids.ts'

const sha256 = (bytes: string): string => createHash('sha256').update(bytes).digest('hex')

describe('the stable ids', () => {
  it('derives the task id from the control, the caller and the goal', () => {
    expect(taskIdOf('lib-1', 'agent-7', 'count the letters')).toBe(`task-${sha256('lib-1\u0000agent-7\u0000count the letters').slice(0, 16)}`)
  })

  it('derives the run id from the control, the session and the call', () => {
    expect(runIdOf('lib-1', 'session-9', 'call-4')).toBe(`run-${sha256('lib-1\u0000session-9\u0000call-4').slice(0, 16)}`)
  })

  it('gives two goals of one caller two task ids', () => {
    expect(taskIdOf('lib-1', 'agent-7', 'a')).not.toBe(taskIdOf('lib-1', 'agent-7', 'b'))
  })

  it('gives two calls in one session two run ids', () => {
    expect(runIdOf('lib-1', 'session-9', 'call-4')).not.toBe(runIdOf('lib-1', 'session-9', 'call-5'))
  })
})
