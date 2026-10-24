import '../../scripts/dsh-control-runtime.mjs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { ModuleLoader, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { LlmResolvedModelInfo, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type { Domain } from '../src/domain.ts'
import { executionProfile } from '../src/execution-profile.ts'

const resources = vi.hoisted(() => ({ parallelism: 4, memory: 8 * 1024 ** 3 }))
const changedFiles = vi.hoisted(() => new Set<string>())
const mounted = vi.hoisted(() => ({
  presets: [] as { presetId: string; key: object; tree: { entries(): Iterable<Entry> } }[],
}))
vi.mock('@deepseek-ai/dsh-agent-preset-registry', async original => ({
  ...(await original<object>()),
  livePresetMounts: () => mounted.presets,
}))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const value = await fs.readFile(...args)
      return changedFiles.has(String(args[0]))
        ? Buffer.concat([Buffer.from(value), Buffer.from('\n// changed implementation')])
        : value
    },
  }
})
vi.mock('node:os', async original => ({
  ...(await original<typeof import('node:os')>()),
  availableParallelism: () => resources.parallelism,
  totalmem: () => resources.memory,
}))

const ids = ['singularity-root', 'singularity-next', 'singularity-review']
type AgentPresetComposition = Awaited<ReturnType<AgentPresetRegistry['compositionInventory']>>[number]
type AgentPresetDocument = Awaited<ReturnType<AgentPresetRegistry['readDocument']>>
function fixture() {
  let config = { provider: 'offline-fixture', model: 'fixed-model', reasoningEffort: 'high' }
  const parent = {
    session: { requestHeader: () => ({ config }) },
    options: { ...config, reasoningEffort: 'low' },
  } as unknown as Agent
  const documents = new Map<string, AgentPresetDocument>(
    ids.map(id => [
      id,
      {
        agentPreset: id,
        content: '- name: "@deepseek-ai/dsh-agent"\n',
      },
    ]),
  )
  const inventory: AgentPresetComposition[] = ids.map(id => ({
    id,
    isDefault: id === ids[0],
    rows: [{ entryId: 'agent', moduleName: '@deepseek-ai/dsh-agent', enabled: true }],
  }))
  let retry: ResolvedRetryPolicy = {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: ['TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  }
  let model: LlmResolvedModelInfo = {
    provider: config.provider,
    id: config.model,
    name: 'Offline model',
    context: { contextWindow: 32_768 },
    defaultMaxTokens: 4096,
  }
  const llm = { providerRetryPolicy: vi.fn(() => retry), resolveModelInfo: vi.fn(async () => model) }
  let providerAvailable = true
  const bases = new Map(ids.map(id => [id, import.meta.url]))
  mounted.presets = ids.map(id => ({
    presetId: id,
    key: {},
    tree: {
      entries: () =>
        inventory
          .find(p => p.id === id)!
          .rows.map(
            row =>
              ({
                id: row.entryId!,
                options: { name: row.moduleName },
                disabled: row.enabled === false,
                parent: { tree: { ctx: { baseUrl: bases.get(id) } } },
              }) as Entry,
          ),
    },
  }))
  const seams = {
    get: (name: string) =>
      name === 'agentPresets'
        ? {
            compositionInventory: async () => inventory,
            readDocument: async (id: string) => documents.get(id),
            acquireScope: async (id: string) => ({
              key: mounted.presets.find(p => p.presetId === id)!.key,
              [Symbol.asyncDispose]: async () => undefined,
            }),
          }
        : name === 'loader'
          ? { ctx: { root: { fiber: {} } }, internal: ModuleLoader.fromInternal() }
          : name === 'llm' && providerAvailable
            ? llm
            : undefined,
  } as ChildSessionSeams
  const domain: Domain = {
    dir: '/offline-domain',
    references: [],
    inputs: [],
    templates: new Map(),
    verifiers: [
      {
        ref: 'protected-check',
        version: '1',
        implementationDigest: 'a'.repeat(64),
        program: '/offline-verifier',
        args: [],
        selftest: { samples: [] },
        judge: async () => ({ verdict: 'unknown' }),
      },
    ],
    measurement: {
      module: fileURLToPath(import.meta.url),
      baseline: 1,
      unit: 'score',
      direction: 'higher',
      criterion: {
        criterionId: 'quality',
        statement: 'Protected quality',
        verifierRef: 'quality',
        verifierVersion: '1',
        implementationDigest: 'b'.repeat(64),
      },
      tools: [{ name: 'compiler', version: '1', implementationDigest: 'c'.repeat(64) }],
      conditions: ['one fixed workload'],
      measure: async () => 1,
    },
  }
  return {
    parent,
    seams,
    domain,
    inventory,
    documents,
    llm,
    bases,
    retry: (value: ResolvedRetryPolicy) => {
      retry = value
    },
    model: (value: Partial<LlmResolvedModelInfo>) => {
      model = { ...model, ...value }
    },
    removeProvider: () => {
      providerAvailable = false
    },
    reasoning: (value: string) => {
      config = { ...config, reasoningEffort: value }
    },
    profile: () => executionProfile(parent, seams, domain),
  }
}

beforeEach(() => {
  resources.parallelism = 4
  resources.memory = 8 * 1024 ** 3
  changedFiles.clear()
})
const temporary: string[] = []
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('frozen execution identity', () => {
  it('hashes plugins from each mounted Loader tree, including packages unavailable to the assembly', async () => {
    const held = fixture(),
      root = await mkdtemp(join(tmpdir(), 'profile-mounted-'))
    temporary.push(root)
    const name = '@profile-test/native-tool'
    const paths = []
    for (const [index, id] of ids.entries()) {
      const base = join(root, id),
        pkg = join(base, 'node_modules', name)
      await mkdir(pkg, { recursive: true })
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }))
      await writeFile(join(pkg, 'index.js'), `export const version = ${index}\n`)
      paths.push(join(pkg, 'index.js'))
      held.bases.set(id, pathToFileURL(join(base, 'preset.yml')).href)
      held.inventory[index] = {
        ...held.inventory[index]!,
        rows: [{ entryId: 'native', moduleName: name, enabled: true }],
      }
    }
    expect(() => import.meta.resolve(name)).toThrow()
    const first = await held.profile()
    expect(first.missing).toEqual([])
    expect(first.profile.presets!.flatMap(p => p.sources.map(s => s.path))).toEqual(paths)
    for (const path of paths) {
      changedFiles.add(path)
      expect((await held.profile()).digest).not.toBe(first.digest)
      changedFiles.clear()
    }
    held.inventory[0] = {
      ...held.inventory[0]!,
      rows: [{ entryId: 'missing', moduleName: '@profile-test/absent', enabled: true }],
    }
    const missing = await held.profile()
    expect(missing.complete).toBe(false)
    expect(missing.missing).toContain('mounted presets')
  })
  it('binds evaluation concurrency into the comparison profile', async () => {
    const held = fixture(),
      serial = await held.profile()
    const parallel = await executionProfile(held.parent, held.seams, held.domain, 2)
    expect(parallel.profile.evaluationParallelism).toBe(2)
    expect(parallel.digest).not.toBe(serial.digest)
  })
  it('tracks effective provider retries and model capacity independently of the request config', async () => {
    const held = fixture(),
      first = await held.profile()
    held.retry({
      mode: 'normal',
      maxRetries: 1,
      retryableCodes: ['TRANSPORT'],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    })
    const retry = await held.profile()
    expect(retry.digest).not.toBe(first.digest)
    expect(retry.profile.config).toEqual(first.profile.config)
    held.model({ context: { contextWindow: 65_536 }, defaultMaxTokens: 8192 })
    const model = await held.profile()
    expect(model.digest).not.toBe(retry.digest)
    expect(model.profile.config).toEqual(first.profile.config)
    expect(held.llm.resolveModelInfo).toHaveBeenCalledWith('offline-fixture', 'fixed-model')
  })

  it('uses only public model metadata fields in provider evidence', async () => {
    const held = fixture(),
      first = await held.profile()
    const adapterMetadata = { id: 'fixed-model', unrelatedAdapterField: 'must-not-enter-profile' }
    held.model(adapterMetadata)
    const profile = await held.profile()
    expect(profile.digest).toBe(first.digest)
    expect(JSON.stringify(profile)).not.toContain('must-not-enter-profile')
    held.model({ toolUpdate: 'in-history', systemPromptUpdate: 'in-history', inputModalities: ['text', 'image'] })
    expect((await held.profile()).digest).not.toBe(first.digest)
  })

  it.each(['missing-service', 'lookup-failure', 'wrong-route'] as const)(
    'does not attest provider evidence with %s',
    async fault => {
      const held = fixture()
      if (fault === 'missing-service') held.removeProvider()
      if (fault === 'lookup-failure') held.llm.resolveModelInfo.mockRejectedValue(new Error('metadata unavailable'))
      if (fault === 'wrong-route') held.model({ id: 'different-model' })
      const profile = await held.profile()
      expect(profile.complete).toBe(false)
      expect(profile.missing).toContain('provider configuration')
      expect(profile.profile.provider).toBeNull()
    },
  )

  it.each(['../src/agent.ts', '../../src/task/commands.ts'])(
    'includes execution code outside the profile module: %s',
    async path => {
      const held = fixture(),
        first = await held.profile()
      changedFiles.add(fileURLToPath(new URL(path, import.meta.url)))
      expect((await held.profile()).digest).not.toBe(first.digest)
    },
  )

  it('includes host package implementation bytes and external measurement module bytes', async () => {
    const held = fixture(),
      first = await held.profile()
    changedFiles.add(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent')))
    const host = await held.profile()
    expect(host.digest).not.toBe(first.digest)
    expect(host.profile.runtimeDigest).toBe(first.profile.runtimeDigest)
    changedFiles.clear()
    changedFiles.add(held.domain.measurement!.module)
    const measurement = await held.profile()
    expect(measurement.digest).not.toBe(first.digest)
    expect(measurement.profile.runtimeDigest).toBe(first.profile.runtimeDigest)
  })
  it('is stable for the same apparatus and follows the actual request reasoning configuration', async () => {
    const held = fixture(),
      first = await held.profile()
    expect(first.missing).toEqual([])
    expect(first.complete).toBe(true)
    expect((await held.profile()).digest).toBe(first.digest)
    expect(first.profile.config.reasoningEffort).toBe('high')
    held.reasoning('max')
    expect((await held.profile()).digest).not.toBe(first.digest)
  })

  it('changes when a mounted preset declaration or tool enablement changes', async () => {
    const held = fixture(),
      first = await held.profile()
    held.documents.set(ids[0]!, {
      agentPreset: ids[0]!,
      content: '- name: "@deepseek-ai/dsh-agent"\n  config: { maxSteps: 20 }\n',
    })
    const declaration = await held.profile()
    expect(declaration.digest).not.toBe(first.digest)
    held.inventory[1] = {
      ...held.inventory[1]!,
      rows: [{ entryId: 'agent', moduleName: '@deepseek-ai/dsh-agent', enabled: false }],
    }
    expect((await held.profile()).digest).not.toBe(declaration.digest)
  })

  it('changes when measurement tools, protected verifier implementations or their arguments change', async () => {
    const held = fixture(),
      first = await held.profile()
    const changedTool = {
      ...held.domain,
      measurement: {
        ...held.domain.measurement!,
        tools: [{ name: 'compiler', version: '2', implementationDigest: 'd'.repeat(64) }],
      },
    }
    expect((await executionProfile(held.parent, held.seams, changedTool)).digest).not.toBe(first.digest)
    const changedVerifier = {
      ...held.domain,
      verifiers: held.domain.verifiers.map(v => ({ ...v, implementationDigest: 'e'.repeat(64) })),
    }
    expect((await executionProfile(held.parent, held.seams, changedVerifier)).digest).not.toBe(first.digest)
    const changedArgs = {
      ...held.domain,
      verifiers: held.domain.verifiers.map(v => ({ ...v, args: ['--strict', '{artifact}'] })),
    }
    expect((await executionProfile(held.parent, held.seams, changedArgs)).digest).not.toBe(first.digest)
  })

  it('binds reviewed domain coefficients and evaluation policy into the profile', async () => {
    const held = fixture(),
      first = await held.profile()
    const measurement = {
      ...held.domain.measurement!,
      parameters: { areaWeight: 0.35, delayWeight: 0.65 },
      evaluation: { weights: { quality: 1, cost: 0 }, noiseFloor: 0.005 },
    }
    const weighted = await executionProfile(held.parent, held.seams, { ...held.domain, measurement })
    expect(weighted.digest).not.toBe(first.digest)
    expect(weighted.profile.measurement).toMatchObject({
      parameters: measurement.parameters,
      evaluation: measurement.evaluation,
    })
    const changed = { ...measurement, parameters: { areaWeight: 0.5, delayWeight: 0.5 } }
    expect((await executionProfile(held.parent, held.seams, { ...held.domain, measurement: changed })).digest).not.toBe(
      weighted.digest,
    )
  })

  it('changes with the available CPU and memory resources', async () => {
    const held = fixture(),
      first = await held.profile()
    resources.parallelism = 2
    const cpu = await held.profile()
    expect(cpu.digest).not.toBe(first.digest)
    resources.memory = 4 * 1024 ** 3
    expect((await held.profile()).digest).not.toBe(cpu.digest)
  })

  it.each(['missing', 'broken', 'conditional'] as const)('does not attest an %s preset composition', async problem => {
    const held = fixture()
    if (problem === 'missing') held.inventory.pop()
    if (problem === 'broken') held.inventory[1] = { ...held.inventory[1]!, broken: 'unresolved module' }
    if (problem === 'conditional')
      held.inventory[1] = {
        ...held.inventory[1]!,
        rows: [{ entryId: 'agent', moduleName: '@deepseek-ai/dsh-agent', enabled: 'conditional' }],
      }
    const profile = await held.profile()
    expect(profile.complete).toBe(false)
    expect(profile.missing).toContain('mounted presets')
  })
})
