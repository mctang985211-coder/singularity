/**
 * The host plugin: the shape a deployment mounts, and the service it provides.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'

import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { Config, apply, inject, name } from '../src/index.ts'
import { FakePersistence } from './seam.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function workspaceRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'assembly-host-'))
  return root
}

describe('the host plugin', () => {
  it('provides the one service the agent face drives', async () => {
    const ctx = new Context()
    new AgentRegistry(ctx)
    new SessionStore(ctx)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(TokenMeter)
    ctx.provide('tools', { guard: () => ctx.effect(() => () => undefined) })
    const workspace = await workspaceRoot()
    await ctx.plugin(JsonlPersistence, { root: join(workspace, 'sessions'), compression: 'none' })
    await apply(ctx, { controlId: 'lib-1', domainDir: REAL, workspaceRoot: workspace })
    expect(typeof ctx.singularity.forCall).toBe('function')
    expect(Object.keys(ctx.singularity).sort()).toEqual(['cancel', 'forCall', 'inheritRsi', 'memoryContext', 'mountSkills', 'read', 'world'])
    await ctx.fiber.dispose()
  })

  it('refuses a config member the shape does not declare, by name', async () => {
    const ctx = new Context()
    ctx.provide('sessionPersistence', new FakePersistence() as never)
    const config = { controlId: 'lib-1', domainDir: REAL, workspaceRoot: await workspaceRoot(), bogus: true }
    expect((await asyncRefusalOf(() => apply(ctx, config))).detail).toContain('unknown member "bogus"')
  })

  it('refuses a mount that leaves a required member out', () => {
    expect(() => Config({ controlId: 'lib-1', domainDir: REAL })).toThrow()
  })

  it('declares identity, tool admission and session persistence ports', () => {
    expect([name, inject]).toEqual(['singularity-assembly', ['agents', 'tools', 'sessions', 'sessionPersistence', 'sessionProjections', 'tokenMeter', 'attachments', 'agentPresets', 'llm']])
  })
})
