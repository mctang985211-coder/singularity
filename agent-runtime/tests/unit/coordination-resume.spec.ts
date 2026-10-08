/**
 * The one way a coordination session comes back after a restart: the same
 * session id, the same composition, the same role. Every refusal is named, and
 * every check happens before the resume.
 */
import { describe, expect, test, vi } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { CoordinationResumeRefusal, resumeCoordinationAgent, type CoordinationResumeDeps } from '../../src/coordination-resume.ts'
import type { CoordinatorResumeRequest } from '../../src/types.ts'

const request: CoordinatorResumeRequest = {
  sessionId: 's-sup' as SessionId,
  scope: { graphStoreId: 'sg-g-1', layoutStoreId: 'sg-l-1' },
  coordinationRole: 'supervisor',
  agentPreset: 'singularity-coordinator',
  permissionPreset: 'danger-full-access',
}

function deps(input: {
  readonly live?: { id: SessionId }[]
  readonly agents?: readonly string[]
  readonly edges?: readonly { kind: string; from: string; to: string }[]
  readonly preset?: string
  readonly resume?: () => Promise<AgentHandle>
  readonly readError?: Error
} = {}): CoordinationResumeDeps & { readonly setups: unknown[] } {
  const setups: unknown[] = []
  return {
    setups,
    agents: {
      get: (id: SessionId) => (input.live ?? []).find(agent => String(agent.id) === String(id)) as never,
      resume: async options => {
        setups.push(options.setup)
        if (input.resume !== undefined) return await input.resume()
        return { agent: { id: options.resumeSessionId } } as unknown as AgentHandle
      },
    },
    sessionQuery: {
      readSession: async (id: SessionId) => {
        if (input.readError !== undefined) throw input.readError
        return { session: { id, agentPreset: input.preset ?? 'singularity-coordinator' }, inheritedEventCount: 0, events: [] }
      },
    },
    graph: {
      snapshotIn: async () => ({
        agents: (input.agents ?? ['s-sup']).map(id => ({ id: id as SessionId })),
        edges: (input.edges ?? [{ kind: 'spawn', from: 's-root', to: 's-sup' }]).map(edge => ({
          kind: edge.kind,
          from: edge.from as SessionId,
          to: edge.to as SessionId,
        })),
      }),
    },
    setup: role => {
      setups.push(role)
      return async () => undefined
    },
  } as unknown as CoordinationResumeDeps & { readonly setups: unknown[] }
}

describe('a coordination resume', () => {
  test('brings the same session back under its own role and composition', async () => {
    const d = deps()
    const handle = await resumeCoordinationAgent(d, request)
    expect(String((handle.agent as { id: string }).id)).toBe('s-sup')
    expect(d.setups[0]).toMatchObject({
      coordinationRole: 'supervisor',
      agentPreset: 'singularity-coordinator',
      permissionPreset: 'danger-full-access',
      taskWorker: false,
    })
  })

  test('refuses a session this process already owns, so two drivers never write one log', async () => {
    await expect(resumeCoordinationAgent(deps({ live: [{ id: 's-sup' as SessionId }] }), request)).rejects.toMatchObject({
      code: 'session-live',
    })
  })

  test('refuses a session the graph does not publish, and one with no delegation edge', async () => {
    await expect(resumeCoordinationAgent(deps({ agents: ['s-other'] }), request)).rejects.toMatchObject({
      code: 'not-in-graph',
    })
    await expect(resumeCoordinationAgent(deps({ edges: [{ kind: 'spawn', from: 's-root', to: 's-other' }] }), request)).rejects.toMatchObject({
      code: 'not-in-graph',
    })
  })

  test('refuses a composition the session\'s own durable header contradicts', async () => {
    await expect(resumeCoordinationAgent(deps({ preset: 'standard' }), request)).rejects.toMatchObject({
      code: 'binding-mismatch',
    })
  })

  test('a missing persisted session is named, and an ownership race is the same refusal as a live one', async () => {
    await expect(
      resumeCoordinationAgent(deps({ readError: Object.assign(new Error('gone'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }) }), request),
    ).rejects.toMatchObject({ code: 'session-missing' })
    const owned = deps({
      resume: async () => {
        throw new SessionAlreadyOwnedError('s-sup' as SessionId)
      },
    })
    await expect(resumeCoordinationAgent(owned, request)).rejects.toMatchObject({ code: 'session-live' })
  })

  test('any other takeover failure is wrapped by name rather than leaking the runtime error', async () => {
    const failing = deps({
      resume: async () => {
        throw new Error('the write lease is held')
      },
    })
    const error = await resumeCoordinationAgent(failing, request).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CoordinationResumeRefusal)
    expect((error as CoordinationResumeRefusal).code).toBe('takeover-refused')
    expect((error as Error).message).toContain('the write lease is held')
    void vi
  })
})
