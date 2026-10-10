/**
 * The host plugin: the shape a deployment mounts, and the service it provides.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'

import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { Config, apply, inject, name } from '../src/index.ts'
import { FakePersistence, mount } from './seam.ts'

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
    const mounted = await mount({ controlId: 'lib-1', domainDir: REAL, workspaceRoot: await workspaceRoot() })
    expect(typeof mounted.ctx.singularity.forCall).toBe('function')
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

  it('declares the seam it opens its control store over', () => {
    expect([name, inject]).toEqual(['singularity-assembly', ['sessionPersistence']])
  })
})
