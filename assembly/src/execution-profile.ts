import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, platform, arch, release, totalmem, availableParallelism } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { livePresetMounts, type AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { sha256 } from './ids.ts'
import type { Domain } from './domain.ts'

async function treeDigest(roots: readonly string[]): Promise<string> {
  const files: Record<string, string> = {}
  for (const [index, root] of roots.entries()) {
    const walk = async (dir: string): Promise<void> => {
      for (const f of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, f.name)
        if (f.isDirectory()) await walk(path)
        else if (f.isFile() && !f.name.endsWith('.map'))
          files[`${index}/${path.slice(root.length + 1)}`] = sha256(await readFile(path))
      }
    }
    await walk(root)
  }
  if (Object.keys(files).length === 0) throw Error('empty implementation tree')
  return digestOf(files)
}

/** Hash actual local implementations and mounted declarations; an opaque server revision stays opaque. */
export async function executionProfile(
  parent: Agent,
  seams: ChildSessionSeams,
  domain: Domain,
  evaluationParallelism = 1,
) {
  const missing: string[] = []
  const capture = async <T>(name: string, action: () => Promise<T>): Promise<T | null> => {
    try {
      return await action()
    } catch {
      missing.push(name)
      return null
    }
  }
  const registry = (seams.get?.('agentPresets') ?? seams.agentPresets) as AgentPresetRegistry | undefined
  const loader = seams.get?.('loader') as Loader | undefined
  const mounted = new Map<string, Set<string>>()
  const config = parent.session.requestHeader()?.config ?? parent.options
  const provider = await capture('provider configuration', async () => {
    const llm = seams.get?.('llm') as LlmRuntime | undefined
    if (!llm || !config.provider || !config.model) throw Error('missing provider configuration')
    const retry = llm.providerRetryPolicy(config.provider)
    const model = await llm.resolveModelInfo(config.provider, config.model)
    if (model.provider !== config.provider || model.id !== config.model) throw Error('model route mismatch')
    // Public metadata only: connection profiles and credentials never enter evidence.
    return {
      retry: {
        mode: retry.mode,
        initialDelayMs: retry.initialDelayMs,
        maxDelayMs: retry.maxDelayMs,
        jitterRatio: retry.jitterRatio,
        ...(retry.mode === 'normal' ? { maxRetries: retry.maxRetries, retryableCodes: [...retry.retryableCodes] } : {}),
      },
      model: {
        contextWindow: model.context?.contextWindow ?? null,
        defaultMaxTokens: model.defaultMaxTokens ?? null,
        inputModalities: model.inputModalities === undefined ? null : [...model.inputModalities],
        reasoning:
          model.reasoning === undefined
            ? null
            : { efforts: model.reasoning.efforts.map(e => e.id), defaultEffort: model.reasoning.defaultEffort ?? null },
        systemPromptUpdate: model.systemPromptUpdate ?? null,
        toolUpdate: model.toolUpdate ?? null,
      },
    }
  })
  const presets = await capture('mounted presets', async () => {
    if (!registry || !loader) throw Error('missing preset registry or host loader')
    const inventory = await registry.compositionInventory()
    const mounts = livePresetMounts(loader.ctx.root.fiber)
    const result = []
    for (const id of ['singularity-root', 'singularity-next', 'singularity-review']) {
      const held = inventory.find(p => p.id === id)
      if (!held || held.broken || held.rows.some(r => r.enabled === 'conditional')) throw Error('unresolved preset')
      const lease = await registry.acquireScope(id)
      try {
        const mount = mounts.find(m => m.key === lease.key)
        if (!mount) throw Error('missing mounted preset')
        const sources: { entryId: string; moduleName: string; path: string }[] = []
        for (const entry of mount.tree.entries()) {
          const name = entry.options.name
          if (
            entry.options.group ||
            entry.disabled ||
            name === '@dangosys/dsh-singularity-next' ||
            name.startsWith('@dangosys/dsh-singularity-next/')
          )
            continue
          // Use the same ESM resolver and base as EntryTree.import, not assembly peers.
          const base = entry.parent.tree.ctx.baseUrl!
          const resolver = loader.internal
          if (!resolver) throw Error('native ESM resolver unavailable')
          const url =
            resolver.version === 'v1'
              ? (await resolver.resolve(name, base, {})).url
              : resolver.resolveSync(base, { specifier: name, attributes: {} }).url
          const path = url.startsWith('file:') ? fileURLToPath(url) : url
          const roots = mounted.get(name) ?? new Set<string>()
          roots.add(dirname(path))
          mounted.set(name, roots)
          sources.push({ entryId: entry.id, moduleName: name, path })
        }
        result.push({ id, declarationDigest: digestOf(await registry.readDocument(id)), rows: held.rows, sources })
      } finally {
        await lease[Symbol.asyncDispose]()
      }
    }
    return result
  })
  const packages = new Set([
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-token-meter',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-retry',
    '@deepseek-ai/dsh-subprocess',
    ...mounted.keys(),
  ])
  const implementations: Record<string, string | null> = {}
  for (const name of [...packages].sort())
    implementations[name] = await capture(name, async () => {
      const roots = mounted.get(name) ?? new Set([dirname(fileURLToPath(import.meta.resolve(name)))])
      return treeDigest([...roots].sort())
    })
  const runtimeDir = dirname(fileURLToPath(import.meta.url))
  const profile = {
    version: 1,
    config,
    provider,
    evaluationParallelism,
    presets,
    implementations,
    // The agent is a separate bundle. Source probes must also include the core, not just this module.
    runtimeDigest: await capture('assembly implementation', () =>
      treeDigest(runtimeDir.endsWith('/src') ? [runtimeDir, join(runtimeDir, '../../src')] : [runtimeDir]),
    ),
    node: {
      version: process.version,
      digest: await capture('node binary', async () => sha256(await readFile(process.execPath))),
    },
    isolation: await capture('bubblewrap binary', async () => sha256(await readFile('/usr/bin/bwrap'))),
    resource: {
      platform: platform(),
      arch: arch(),
      kernel: release(),
      cpu: cpus().map(c => c.model),
      parallelism: availableParallelism(),
      memory: totalmem(),
      cgroup: await Promise.all(
        ['/sys/fs/cgroup/cpu.max', '/sys/fs/cgroup/memory.max'].map(async p => {
          try {
            return (await readFile(p, 'utf8')).trim()
          } catch {
            return 'not exposed'
          }
        }),
      ),
    },
    measurement:
      domain.measurement === undefined
        ? null
        : {
            criterion: domain.measurement.criterion,
            baseline: domain.measurement.baseline,
            unit: domain.measurement.unit,
            direction: domain.measurement.direction,
            implementation: await capture('measurement module', async () =>
              sha256(await readFile(domain.measurement!.module)),
            ),
            parameters: domain.measurement.parameters ?? null,
            evaluation: domain.measurement.evaluation ?? null,
            tools: domain.measurement.tools,
            conditions: domain.measurement.conditions,
          },
    verifiers: domain.verifiers.map(v => ({
      ref: v.ref,
      version: v.version,
      digest: v.implementationDigest,
      program: v.program,
      args: v.args,
    })),
    modelRevision: 'opaque; provider/model route does not attest a server revision',
  }
  return { digest: digestOf(profile), complete: missing.length === 0, missing, profile }
}
