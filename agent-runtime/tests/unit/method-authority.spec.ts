/**
 * Publication authority is a fact about the orchestration role: a capability may
 * never grant a pointer-moving tool, a preset plane cannot add one, and the
 * execution-time seal refuses the call on every agent whose grant did not carry
 * it — spawn and resume alike, since both run through `applyWorkerGrant`.
 */
import { describe, expect, it } from 'vitest'
import { resolveGrant } from '../../src/grants.ts'
import {
  METHOD_AUTHORITY_DENIAL,
  METHOD_AUTHORITY_TOOLS,
  assertNoMethodAuthorityGrant,
  grantCarriesMethodAuthority,
  isMethodAuthorityTool,
  sealMethodAuthority,
} from '../../src/method-authority.ts'
import type { WorkerGrant } from '../../src/types.ts'

/** The surface a composition offers: the global layer, plus what its mounted preset adds. */
const GLOBAL = ['read', 'method_list', 'method_draft', 'method_evaluate', 'method_publish', 'method_rollback']
const PRESET = ['bash', 'method_publish']

function agentCtx(preset: readonly string[] = PRESET, global: readonly string[] = GLOBAL) {
  const guards: ((execution: { name: string }) => string | undefined)[] = []
  return {
    guards,
    ctx: {
      tools: {
        schemas: (scope?: unknown) => [...global, ...(scope === undefined ? [] : preset)].map(name => ({ name })),
        guard: (check: (execution: { name: string }) => string | undefined) => guards.push(check),
      },
    } as never,
  }
}

/** The denial one installed guard answers for a tool name, or `undefined` when the call passes. */
function denialOf(guards: readonly ((execution: { name: string }) => string | undefined)[], name: string): string | undefined {
  let reason: string | undefined
  for (const guard of guards) {
    const answer = guard({ name })
    if (answer !== undefined) reason = answer
  }
  return reason
}

const agent = { id: 'w1' } as never
const supervisorGrant: WorkerGrant = { capabilities: [], baseline: [...METHOD_AUTHORITY_TOOLS, 'method_draft'], keepPresetTools: false }
const workerGrant: WorkerGrant = { capabilities: [], baseline: ['method_list', 'method_draft'], keepPresetTools: false }

describe('the method authority seal', () => {
  it('names the two pointer-moving tools and the one denial', () => {
    expect([...METHOD_AUTHORITY_TOOLS].sort()).toEqual(['method_publish', 'method_rollback'])
    expect(isMethodAuthorityTool('method_publish')).toBe(true)
    expect(isMethodAuthorityTool('method_draft')).toBe(false)
    expect(METHOD_AUTHORITY_DENIAL).toContain('method_draft')
  })

  it('denies the two tools at execution for an agent that was not granted them', () => {
    const { ctx, guards } = agentCtx()
    sealMethodAuthority(ctx, false)
    expect(denialOf(guards, 'method_publish')).toBe(METHOD_AUTHORITY_DENIAL)
    expect(denialOf(guards, 'method_rollback')).toBe(METHOD_AUTHORITY_DENIAL)
    expect(denialOf(guards, 'method_draft')).toBeUndefined()
    expect(denialOf(guards, 'method_list')).toBeUndefined()
  })

  it('installs no seal for the agent that holds the authority', () => {
    const { ctx, guards } = agentCtx()
    sealMethodAuthority(ctx, true)
    expect(guards).toHaveLength(0)
  })
})

describe('a grant that resolves the method surface', () => {
  it('refuses a capability that declares a pointer-moving tool, naming the capability', () => {
    const grant: WorkerGrant = { capabilities: [{ capability: 'publish-please', tools: ['method_publish'], skills: [] }], baseline: [], keepPresetTools: false }
    expect(() => assertNoMethodAuthorityGrant(grant)).toThrow(/no capability may grant/)
    const { ctx } = agentCtx()
    expect(() => resolveGrant(ctx, agent, grant)).toThrow(/publish-please/)
  })

  it('strips a preset plane of the pointer-moving tools even where the composition offers them', () => {
    // A composition whose global layer offers everything but the two pointer
    // tools, and a preset that happens to offer one of them.
    const { ctx } = agentCtx(PRESET, ['read', 'method_list', 'method_draft', 'method_evaluate', 'method_rollback'])
    const resolved = resolveGrant(ctx, agent, { capabilities: [], baseline: [], keepPresetTools: true })
    // The preset's own tools survive; a pointer-moving tool it happens to offer
    // does not, even though the global layer never named it.
    expect(resolved.allow).toContain('bash')
    expect(resolved.allow).not.toContain('method_publish')
    expect(resolved.methodAuthority).toBe(false)
  })

  it('carries the authority only when the baseline itself names one of the two, as the supervisor baseline does', () => {
    const { ctx } = agentCtx([])
    expect(resolveGrant(ctx, agent, supervisorGrant)).toMatchObject({ methodAuthority: true })
    expect(resolveGrant(ctx, agent, supervisorGrant).allow).toEqual(expect.arrayContaining([...METHOD_AUTHORITY_TOOLS]))
    expect(resolveGrant(ctx, agent, workerGrant)).toMatchObject({ methodAuthority: false })
    expect(grantCarriesMethodAuthority(['read', 'method_draft'])).toBe(false)
    expect(grantCarriesMethodAuthority(['method_rollback'])).toBe(true)
  })

  it('seals from that same resolved answer, so the grant is the one place the decision is taken', () => {
    const supervisor = agentCtx([])
    sealMethodAuthority(supervisor.ctx, resolveGrant(supervisor.ctx, agent, supervisorGrant).methodAuthority)
    expect(supervisor.guards).toHaveLength(0)

    const worker = agentCtx([])
    sealMethodAuthority(worker.ctx, resolveGrant(worker.ctx, agent, workerGrant).methodAuthority)
    expect(denialOf(worker.guards, 'method_publish')).toBe(METHOD_AUTHORITY_DENIAL)
    expect(denialOf(worker.guards, 'method_rollback')).toBe(METHOD_AUTHORITY_DENIAL)
    expect(denialOf(worker.guards, 'method_draft')).toBeUndefined()
  })
})
