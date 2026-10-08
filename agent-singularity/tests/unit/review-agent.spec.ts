/**
 * The reviewer's tool surface: what `reviewerGrant()` resolves to on a full
 * composition, and what it must never contain. The surface is the read-only
 * investigation tools plus the one completion tool; everything that writes,
 * spawns, diagnoses or publishes belongs to another role.
 */
import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveGrant } from '../../../agent-runtime/src/grants.ts'
import {
  REVIEWER_BASELINE,
  REVIEWER_PRESET,
  reviewerGrant,
  sourceRef,
} from '../../src/coordination/review-run.ts'
import { COORDINATION_PRESET } from '../../src/coordination/roles.ts'

/** A composition offering every tool a reviewer must NOT have, plus the read-only baseline. */
const FULL_SURFACE = [
  ...REVIEWER_BASELINE,
  'bash',
  'write',
  'edit',
  'read_image',
  'jobs',
  'job_output',
  'subagent',
  'graph_spawn',
  'hitl_ask',
  'hitl_approve',
  'ask_user_question',
  'task_diagnose',
  'task_decompose',
  'evolution_propose',
  'evolution_candidate',
  'evolution_gate',
  'evolution_decide',
  'evolution_list',
  'supervisor_complete',
  'run_code',
]

const FORBIDDEN = [
  'bash',
  'write',
  'edit',
  'jobs',
  'job_output',
  'subagent',
  'graph_spawn',
  'hitl_ask',
  'hitl_approve',
  'task_diagnose',
  'task_decompose',
  'evolution_propose',
  'evolution_candidate',
  'evolution_gate',
  'evolution_decide',
  'evolution_list',
  'supervisor_complete',
]

function grantHarness(preset: readonly string[] = []) {
  const schemas = (scope?: unknown) =>
    (scope === undefined ? FULL_SURFACE : [...FULL_SURFACE, ...preset]).map(name => ({
      name,
      description: '',
      parameters: {},
    }))
  const restrict = vi.fn()
  return { ctx: { tools: { schemas, restrict }, get: () => undefined } as unknown as Context, restrict }
}

function worker(): Agent {
  return { id: 'rev' as SessionId, session: { header: { cwd: '/work' } } } as unknown as Agent
}

describe('reviewer grant', () => {
  test('resolves to exactly the read-only baseline on a full composition', () => {
    const resolved = resolveGrant(grantHarness().ctx, worker(), reviewerGrant())
    expect(resolved.allow).toEqual([...REVIEWER_BASELINE].sort())
    expect(resolved.baselineUnavailable).toEqual([])
  })

  test('has no shell, write, spawn, hitl, diagnosis, evolution or supervisor tool to give', () => {
    const allow = resolveGrant(grantHarness().ctx, worker(), reviewerGrant()).allow
    for (const name of FORBIDDEN) expect(allow).not.toContain(name)
  })

  test('carries neither half of the question protocol', () => {
    expect(REVIEWER_BASELINE).not.toContain('task_ask_parent')
    expect(REVIEWER_BASELINE).not.toContain('task_answer')
    const allow = resolveGrant(grantHarness().ctx, worker(), reviewerGrant()).allow
    expect(allow).not.toContain('task_ask_parent')
    expect(allow).not.toContain('task_answer')
  })

  test('keepPresetTools is false, so the mounted preset contributes no tool plane', () => {
    const allow = resolveGrant(grantHarness(['preset_shell_passthrough', 'preset_write']).ctx, worker(), reviewerGrant())
      .allow
    expect(allow).not.toContain('preset_shell_passthrough')
    expect(allow).not.toContain('preset_write')
    expect(allow).toEqual([...REVIEWER_BASELINE].sort())
  })

  test('the declared grant carries no capability plane and no preset tools', () => {
    expect(reviewerGrant()).toEqual({ capabilities: [], baseline: REVIEWER_BASELINE, keepPresetTools: false })
  })

  test('the reviewer keeps its reads and exactly one way to end', () => {
    for (const name of ['context_read', 'task_read', 'task_status', 'task_review_pack', 'skill'])
      expect(REVIEWER_BASELINE).toContain(name)
    expect(REVIEWER_BASELINE).toContain('reviewer_complete')
    expect(REVIEWER_PRESET).toBe(COORDINATION_PRESET)
  })

  test('a source ref names the run, or the absence of one', () => {
    expect(sourceRef({ taskId: 't1', runId: 'r1' })).toBe('t1#r1')
    expect(sourceRef({ taskId: 't1', runId: null })).toBe('t1#no-run')
  })
})
