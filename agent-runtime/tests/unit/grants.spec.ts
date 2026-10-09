import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { applyWorkerGrant, resolveGrant } from '../../src/grants.ts'
import type { WorkerGrant } from '../../src/types.ts'

/** The surface one worker's composition offers: the global layer plus what its mounted preset adds. */
interface Surface {
  global: readonly string[]
  preset: readonly string[]
}

interface Registered {
  name: string
  content: string
  source: string
  path?: string
}

function harness(
  surface: Surface,
  options: { skills?: 'discovery' | 'absent'; discovered?: Record<string, string> } = {},
) {
  const registered: Registered[] = []
  const schemas = (scope?: unknown) =>
    scope === undefined
      ? // The global view also carries the reserved transport, as the real registry does.
        [...surface.global, 'run_code'].map(name => ({ name, description: '', parameters: {} }))
      : [...surface.global, ...surface.preset, 'run_code'].map(name => ({ name, description: '', parameters: {} }))
  const restrict = vi.fn()
  const mounted: { name: string; config: Record<string, unknown> }[] = []
  const skills =
    options.skills === 'absent'
      ? undefined
      : {
          get: vi.fn(async (name: string) =>
            options.discovered?.[name] === undefined
              ? undefined
              : {
                  name,
                  description: 'discovered',
                  content: options.discovered[name]!,
                  source: 'user-agents',
                  path: `/discovered/${name}/SKILL.md`,
                },
          ),
          register: vi.fn((skill: Registered) => {
            registered.push(skill)
            return () => {}
          }),
        }
  const plugin = vi.fn(async (pluginModule: unknown, config: Record<string, unknown>) => {
    mounted.push({ name: (pluginModule as { name?: string }).name ?? '(anonymous)', config })
    return {}
  })
  const ctx = {
    tools: { schemas, restrict, guard: vi.fn() },
    get: (name: string) => (name === 'skills' ? skills : undefined),
    // The cordis plugin seam mcp-client mounts through; captured, never run.
    plugin,
    isolate: () => {
      let localSkills: unknown
      return {
        on: vi.fn(),
        get: (name: string) => name === 'skills' ? localSkills : undefined,
        get skills() { return localSkills },
        plugin: async (module: unknown) => {
          if (module === SkillRegistry) localSkills = {
            register: (skill: Registered) => { registered.push(skill); return () => {} },
          }
          return {}
        },
      }
    },
  }
  return { ctx: ctx as unknown as Context, restrict, registered, skills, mounted, plugin }
}

function worker(cwd = '/work'): Agent {
  return { id: 'w1' as SessionId, session: { header: { cwd } } } as unknown as Agent
}

function grant(overrides: Partial<WorkerGrant> = {}): WorkerGrant {
  return {
    capabilities: [],
    baseline: [],
    keepPresetTools: false,
    ...overrides,
  }
}

const DESIGN_BALL = {
  capability: 'design-ball',
  tools: ['read', 'bash'],
  skills: [],
}

describe('resolveGrant', () => {
  test('allows the capability tools plus the baseline the composition offers, sorted', () => {
    const h = harness({ global: ['task_read', 'graph_spawn', 'read', 'bash', 'grep', 'skill'], preset: [] })
    const resolved = resolveGrant(
      h.ctx,
      worker(),
      grant({
        capabilities: [DESIGN_BALL],
        baseline: ['read', 'bash', 'grep', 'skill', 'task_decompose'],
      }),
    )

    expect(resolved.allow).toEqual(['bash', 'grep', 'read', 'skill'])
    expect(resolved.baselineUnavailable).toEqual(['task_decompose'])
  })

  test('baseline names the composition never mounted are dropped, not demanded', () => {
    // The `bb-verify` node mounts no shell: nothing to revoke, so nothing to reject.
    const h = harness({ global: ['session_event_read'], preset: ['verify_console'] })
    const resolved = resolveGrant(
      h.ctx,
      worker(),
      grant({
        capabilities: [{ capability: 'verify-ball-functional', tools: [], skills: ['verify'] }],
        baseline: ['bash', 'skill', 'session_event_read'],
      }),
    )

    expect(resolved.allow).toEqual(['session_event_read'])
    expect(resolved.baselineUnavailable).toEqual(['bash', 'skill'])
  })

  test('the preset plane stays only when the capability named its own preset', () => {
    const surface = { global: ['task_read', 'read'], preset: ['bash', 'verify_console'] }
    const kept = resolveGrant(harness(surface).ctx, worker(), grant({ baseline: ['read'], keepPresetTools: true }))
    const dropped = resolveGrant(harness(surface).ctx, worker(), grant({ baseline: ['read'], keepPresetTools: false }))

    expect(kept.allow).toEqual(['bash', 'read', 'verify_console'])
    expect(dropped.allow).toEqual(['read'])
  })

  test('the reserved PTC transport is never allowed', () => {
    const h = harness({ global: ['read', 'run_code'], preset: ['bash'] })
    const resolved = resolveGrant(h.ctx, worker(), grant({ baseline: ['read', 'bash'], keepPresetTools: true }))
    expect(resolved.allow).toEqual(['bash', 'read'])
  })

  test('keeping research preset tools cannot add a second agent delegation tree', () => {
    const h = harness({ global: ['task_decompose', 'read'], preset: ['web_search', 'subagent', 'subagent_fork', 'workflow', 'ralph'] })
    const resolved = resolveGrant(h.ctx, worker(), grant({ baseline: ['task_decompose', 'read'], keepPresetTools: true }))
    expect(resolved.allow).toEqual(['read', 'task_decompose', 'web_search'])
  })

  test('an explicit capability cannot bypass Task admission with native delegation', () => {
    const h = harness({ global: ['subagent'], preset: [] })
    expect(() => resolveGrant(h.ctx, worker(), grant({ capabilities: [{ capability: 'research', tools: ['subagent'], skills: [] }] })))
      .toThrow('delegate through task_decompose')
  })

  test('a capability tool the worker cannot see rejects the grant, naming the capability and the surface', () => {
    const h = harness({ global: ['read'], preset: [] })
    expect(() =>
      resolveGrant(
        h.ctx,
        worker(),
        grant({
          capabilities: [{ capability: 'design-ball', tools: ['read', 'write'], skills: [] }],
        }),
      ),
    ).toThrow(
      'agent-runtime: capability "design-ball" grants unavailable tool "write"; this worker\'s visible tools: read',
    )
  })

  test('every missing capability is named in one rejection', () => {
    const h = harness({ global: ['read'], preset: [] })
    expect(() =>
      resolveGrant(
        h.ctx,
        worker(),
        grant({
          capabilities: [
            { capability: 'a', tools: ['write'], skills: [] },
            { capability: 'b', tools: ['edit'], skills: [] },
          ],
        }),
      ),
    ).toThrow('agent-runtime: capabilities "a" grants unavailable tool "write"; "b" grants unavailable tool "edit"')
  })
})

describe('applyWorkerGrant', () => {
  test('restricts the worker to the resolved allow-list', () => {
    const h = harness({ global: ['task_read', 'graph_spawn', 'read'], preset: ['bash'] })
    return applyWorkerGrant(h.ctx, worker(), grant({ capabilities: [DESIGN_BALL], baseline: ['read'] })).then(() => {
      expect(h.restrict).toHaveBeenCalledWith({ allow: ['bash', 'read'] })
    })
  })

  test('a rejection from the tools registry is re-thrown with the worker and the capabilities', async () => {
    const h = harness({ global: ['read'], preset: [] })
    h.restrict.mockImplementation(() => {
      throw new Error('tools.restrict() names unknown global tool "read"; known global tools: (none)')
    })
    await expect(applyWorkerGrant(h.ctx, worker(), grant({ baseline: ['read'] }))).rejects.toThrow(
      'agent-runtime: could not restrict agent "w1" to [read] for capabilities []: tools.restrict() names unknown global tool "read"',
    )
  })

  test('a granted skill the deployment can discover is pinned into the worker layer', async () => {
    const h = harness({ global: [], preset: [] }, { discovered: { verify: 'the verify body' } })
    await applyWorkerGrant(
      h.ctx,
      worker(),
      grant({
        capabilities: [{ capability: 'verify-ball-functional', tools: [], skills: ['verify'] }],
      }),
    )

    expect(h.registered).toEqual([
      {
        name: 'verify',
        description: 'discovered',
        content: 'the verify body',
        source: 'runtime',
        path: '/discovered/verify/SKILL.md',
      },
    ])
    expect(h.skills!.get).toHaveBeenCalledWith('verify', { scope: expect.objectContaining({ id: 'w1' }), cwd: '/work' })
  })

  test('a granted skill discovery cannot see is read from its SKILL.md', async () => {
    const h = harness({ global: [], preset: [] }, { discovered: {} })
    await applyWorkerGrant(
      h.ctx,
      worker(root),
      grant({
        capabilities: [{ capability: 'design-ball', tools: [], skills: ['ball-align'] }],
      }),
    )

    expect(h.registered).toHaveLength(1)
    expect(h.registered[0]!.name).toBe('ball-align')
    expect(h.registered[0]!.content).toContain('# Ball Alignment')
    expect(h.registered[0]!.path).toBe(join(root, '.agents', 'skills', 'ball-align', 'SKILL.md'))
  })

  test('a granted skill with no SKILL.md anywhere rejects the spawn, naming the capability and the roots', async () => {
    const h = harness({ global: [], preset: [] }, { discovered: {} })
    await expect(
      applyWorkerGrant(
        h.ctx,
        worker(root),
        grant({
          capabilities: [{ capability: 'design-ball', tools: [], skills: ['ghost-skill'] }],
        }),
      ),
    ).rejects.toThrow(
      /capability "design-ball" grants skill "ghost-skill" but no SKILL\.md for it is reachable; searched /,
    )
  })

  test('a deployment with no skill registry rejects a skill grant instead of silently dropping it', async () => {
    const h = harness({ global: [], preset: [] }, { skills: 'absent' })
    await expect(
      applyWorkerGrant(
        h.ctx,
        worker(root),
        grant({
          capabilities: [{ capability: 'design-ball', tools: [], skills: ['ball-align'] }],
        }),
      ),
    ).rejects.toThrow(
      'capabilities [design-ball] grant skills [ball-align] but the deployment provides no skill registry (ctx.skills)',
    )
  })

  test('a skill file declaring another name is rejected', async () => {
    const h = harness({ global: [], preset: [] }, { discovered: {} })
    await expect(
      applyWorkerGrant(
        h.ctx,
        worker(root),
        grant({
          capabilities: [{ capability: 'design-ball', tools: [], skills: ['mismatch'] }],
        }),
      ),
    ).rejects.toThrow(/declares name "someone-else" but the capability grants "mismatch"/)
  })
})

let root: string
let previousHome: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-grant-'))
  mkdirSync(join(root, '.agents', 'skills', 'ball-align'), { recursive: true })
  writeFileSync(
    join(root, '.agents', 'skills', 'ball-align', 'SKILL.md'),
    '---\nname: ball-align\ndescription: Align a Ball\n---\n# Ball Alignment\nbody\n',
  )
  mkdirSync(join(root, '.agents', 'skills', 'mismatch'), { recursive: true })
  writeFileSync(
    join(root, '.agents', 'skills', 'mismatch', 'SKILL.md'),
    '---\nname: someone-else\ndescription: d\n---\nbody\n',
  )
  mkdirSync(join(root, 'dsh-home'), { recursive: true })
  previousHome = process.env.DSH_HOME
  // A private DSH home keeps the real deployment's skills out of the file fallback.
  process.env.DSH_HOME = join(root, 'dsh-home')
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

describe('applyWorkerGrant skill overlay (extra skill roots)', () => {
  /** One overlay root holding a `verify` candidate skill and an ungranted `overlay-only` skill. */
  function overlayRoot() {
    const dir = mkdtempSync(join(tmpdir(), 'skill-overlay-'))
    mkdirSync(join(dir, 'verify'), { recursive: true })
    writeFileSync(
      join(dir, 'verify', 'SKILL.md'),
      '---\nname: verify\ndescription: candidate verify\n---\n# Candidate\noverlay body\n',
    )
    mkdirSync(join(dir, 'overlay-only'), { recursive: true })
    writeFileSync(
      join(dir, 'overlay-only', 'SKILL.md'),
      '---\nname: overlay-only\ndescription: only in the overlay\n---\nbody\n',
    )
    return dir
  }

  test('an overlay freezes the granted skill without exposing other overlay skills', async () => {
    const dir = overlayRoot()
    const h = harness({ global: [], preset: [] }, { discovered: { verify: 'production verify body' } })
    await applyWorkerGrant(
      h.ctx,
      worker(),
      grant({
        capabilities: [{ capability: 'verify-ball-functional', tools: [], skills: ['verify'] }],
        skillRoots: [dir],
      }),
    )

    const names = h.registered.map(skill => skill.name)
    expect(names).toEqual(['verify'])
    // the granted name kept the overlay body — production discovery was never consulted for it
    expect(h.registered.find(skill => skill.name === 'verify')!.content).toContain('overlay body')
    expect(h.registered.find(skill => skill.name === 'verify')!.path).toBe(join(dir, 'verify', 'SKILL.md'))
    expect(h.skills!.get).not.toHaveBeenCalled()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a granted skill absent from the overlay roots still resolves through production discovery', async () => {
    const dir = overlayRoot()
    const h = harness({ global: [], preset: [] }, { discovered: { other: 'production other body' } })
    await applyWorkerGrant(
      h.ctx,
      worker(),
      grant({
        capabilities: [{ capability: 'x', tools: [], skills: ['other'] }],
        skillRoots: [dir],
      }),
    )

    const names = h.registered.map(skill => skill.name).sort()
    expect(names).toEqual(['other'])
    expect(h.registered.find(skill => skill.name === 'other')!.content).toBe('production other body')
    rmSync(dir, { recursive: true, force: true })
  })

  test('an unreadable overlay root fails the spawn with the root named', async () => {
    const h = harness({ global: [], preset: [] }, { discovered: {} })
    await expect(applyWorkerGrant(h.ctx, worker(), grant({ skillRoots: [join(root, 'no-such-dir')] }))).rejects.toThrow(
      /skill overlay root ".*no-such-dir" is not readable/,
    )
  })

  test('an overlay on a deployment with no skill registry fails instead of being dropped', async () => {
    const dir = overlayRoot()
    const h = harness({ global: [], preset: [] }, { skills: 'absent' })
    await expect(applyWorkerGrant(h.ctx, worker(), grant({ skillRoots: [dir] }))).rejects.toThrow(
      /skill overlay roots .* no skill registry/,
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('no skillRoots keeps the production resolution untouched', async () => {
    const h = harness({ global: [], preset: [] }, { discovered: { verify: 'production verify body' } })
    await applyWorkerGrant(
      h.ctx,
      worker(),
      grant({
        capabilities: [{ capability: 'verify-ball-functional', tools: [], skills: ['verify'] }],
      }),
    )
    expect(h.registered.map(skill => skill.name)).toEqual(['verify'])
    expect(h.registered[0]!.content).toBe('production verify body')
  })
})

describe('applyWorkerGrant MCP server mounts', () => {
  const BB_DEV = {
    serverName: 'bbdev',
    command: '/env/project1/fork/buckyball/scripts/claude/run_mcp_server.sh',
    args: [],
    env: {},
    cwd: '/env/project1/fork/buckyball',
  }

  test('each granted server mounts as one mcp-client instance with failOnStartupError, after the restrict', async () => {
    const h = harness({ global: ['read'], preset: [] })
    const agent = worker()
    await applyWorkerGrant(
      h.ctx,
      agent,
      grant({
        capabilities: [{ capability: 'check-ball-registration', tools: ['read'], skills: [] }],
        mcpServers: [BB_DEV],
      }),
    )

    expect(h.mounted).toEqual([
      {
        name: 'mcp-client',
        config: {
          transport: 'stdio',
          serverName: 'bbdev',
          command: BB_DEV.command,
          args: [],
          env: {},
          cwd: BB_DEV.cwd,
          // The mount hands the worker's own session to the sandbox policy resolve.
          session: agent.session,
          failOnStartupError: true,
        },
      },
    ])
    // The mount runs after the allow-list is computed: own-layer mcp__* names
    // must never reach tools.restrict, which only names the inherited surface.
    expect(h.restrict.mock.invocationCallOrder[0]!).toBeLessThan(h.plugin.mock.invocationCallOrder[0]!)
  })

  test('a server that fails to start rejects the grant, naming the server and the agent', async () => {
    const h = harness({ global: [], preset: [] })
    h.plugin.mockRejectedValue(new Error('initial connection or tool synchronization failed'))
    await expect(applyWorkerGrant(h.ctx, worker(), grant({ mcpServers: [BB_DEV] }))).rejects.toThrow(
      'agent-runtime: MCP server "bbdev" (command: /env/project1/fork/buckyball/scripts/claude/run_mcp_server.sh) failed to start for agent "w1"',
    )
  })

  test('a grant without mcpServers mounts nothing', async () => {
    const h = harness({ global: ['read'], preset: [] })
    await applyWorkerGrant(
      h.ctx,
      worker(),
      grant({ capabilities: [{ capability: 'design-ball', tools: ['read'], skills: [] }] }),
    )
    expect(h.mounted).toEqual([])
  })
})
