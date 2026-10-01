import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { CapabilityConfig } from '../../src/capability.ts'
import { TaskRuntime } from '../../src/index.ts'
import { executionProviders } from '../../src/sidecar.ts'

/**
 * The load-time provider scan (S1-C item 3, guide §2.4): the deployment reads
 * its own capability table with its own discovery roots, reports every defect
 * loudly, and starts anyway.
 *
 * What is real: the service's own `[Service.init]` hook (the trigger a
 * deployment actually runs), the discovery (`agent-runtime/src/skill-file.ts`),
 * the sidecar loader and validator, and the cordis logger service — the sink is
 * attached to the real logger, so what a deployment would print is what this
 * test reads back.
 *
 * What is asserted from the outside: the report `providerLoadReport()` hands
 * back (its verdicts, its defect lines), the warning lines the logger received,
 * and the fact that the hook returned instead of throwing. Nothing here asserts
 * that a private helper was called.
 *
 * Every skill this file grants is installed under a pinned `$DSH_HOME` and named
 * something no deployment ships, so the roots the harness process itself walks
 * cannot decide a verdict: the fixture is the only copy discovery can find.
 */

const VERIFIERS = ['command', 'composite', 'review']
const EXECUTION_SKILL = 's1c-load-exec-fixture'
const GUIDANCE_SKILL = 's1c-load-guidance-fixture'

let workspace: string
let home: string
const contexts: Context[] = []

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'provider-load-'))
  home = join(workspace, 'home')
  await mkdir(home, { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  await rm(workspace, { recursive: true, force: true })
})

/** SHA-256 of bytes, computed here so the implementation is never confirmed against itself. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** One skill directory as the validator reads it: `SKILL.md`, its frontmatter naming the granted skill, and the identity the loader re-hashes. */
async function installSkill(
  name: string,
  sidecar?:
    { type: 'execution'; capabilities: string[]; requiredTools: string[]; verifierRef: string } | { type: 'knowledge' },
): Promise<string> {
  const directory = join(home, 'skills', name)
  await mkdir(directory, { recursive: true })
  const skillMd = `---\nname: ${name}\ndescription: fixture skill for the load-time provider scan\n---\n\n# ${name}\n`
  await writeFile(join(directory, 'SKILL.md'), skillMd)
  if (sidecar === undefined) return directory
  const content = { skillMdSha256: sha256Of(skillMd), resources: [] }
  const declared =
    sidecar.type === 'execution'
      ? {
          contractVersion: 1,
          type: 'execution',
          capabilities: sidecar.capabilities,
          precondition: 'the fixture is installed where discovery looks',
          inputs: [],
          outputs: [],
          requiredTools: sidecar.requiredTools,
          verifier: { ref: sidecar.verifierRef },
          content,
        }
      : {
          contractVersion: 1,
          type: 'knowledge',
          source: 'this test fixture',
          scope: 'load-time scan behaviour only',
          content,
          contentCheck: { kind: 'command', command: 'true' },
        }
  await writeFile(join(directory, 'SKILL.contract.json'), `${JSON.stringify(declared, null, 2)}\n`)
  return directory
}

/**
 * A hand-built runtime with the fixture deployment's own table, its verifier
 * vocabulary, and a logger sink on the real logger service. `[Service.init]` is
 * cordis's hook, so no `.ready()`-style shortcut is taken here: the test runs
 * what a deployment runs.
 */
function harness(capabilities: Record<string, CapabilityConfig>) {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('verifier', { ready: async () => {}, verifierIds: () => [...VERIFIERS] } as never)
  // A bare context exports only `error`, so the threshold is raised — the same
  // sink the integration suite uses to read warnings a deployment would print.
  const warnings: string[] = []
  ;(ctx.logger as unknown as { exporter(sink: unknown): unknown }).exporter({
    levels: { default: 3 },
    export: (message: { type: string; args: unknown[] }) => {
      if (message.type === 'warn') warnings.push(String(message.args[0]))
    },
  })
  return { runtime: new TaskRuntime(ctx, { capabilities } as never), warnings }
}

describe('load-time provider scan (S1-C item 3)', () => {
  it('runs at service init, reports every defect loudly, and leaves the deployment running', async () => {
    await installSkill(EXECUTION_SKILL, {
      type: 'execution',
      capabilities: ['fixture-capability'],
      // `bash` is not granted by the row below, and the verifier ref names nothing registered:
      // two separate reasons, both of which must be printed.
      requiredTools: ['bash'],
      verifierRef: 'not-a-registered-verifier',
    })
    const { runtime, warnings } = harness({
      'fixture-capability': { skills: [EXECUTION_SKILL], tools: ['filesystem'] },
    })

    // The hook is the entry: a deployment loads the plugin, and this is what runs.
    await expect(runtime[Service.init]()).resolves.toBeUndefined()

    const report = await runtime.providerLoadReport()
    expect(report.failed).toBeUndefined()
    // One line per defect, each naming the capability, the skill, the code and the detail.
    expect(report.defects).toHaveLength(2)
    expect(report.defects[0]).toContain(`capability "fixture-capability" skill "${EXECUTION_SKILL}"`)
    expect(report.defects.map(line => line.split(': ')[1])).toEqual(['verifier-unknown', 'tool-not-covered'])
    expect(report.defects[0]).toContain('not-a-registered-verifier')
    expect(report.defects[1]).toContain('"bash"')

    // Loudly: a header plus every defect line, through the logger a deployment logs to.
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('2 provider defects in the effective capability table')
    expect(warnings[0]).toContain('reported, not enforced')
    expect(warnings.slice(1)).toEqual(report.defects.map(line => `config load: ${line}`))
    // The roots the deployment's own viewpoint covered are named, so an operator
    // knows which discovery this conclusion belongs to.
    expect(warnings[0]).toContain(join(home, 'skills'))

    // The verdict itself is queryable, and it says what the row resolved to.
    const row = report.precheck!.capabilities.find(item => item.capability === 'fixture-capability')!
    expect(row.skills).toHaveLength(1)
    expect(row.skills[0]!.valid).toBe(false)
    // A refused provider is never part of the effective provider set.
    expect(executionProviders(row.skills)).toEqual([])
  })

  it('reports nothing for a table whose skills are loadable, and does not misreport a skill without a sidecar', async () => {
    await installSkill(GUIDANCE_SKILL)
    const { runtime, warnings } = harness({ 'fixture-capability': { skills: [GUIDANCE_SKILL], tools: ['filesystem'] } })
    await runtime[Service.init]()

    const report = await runtime.providerLoadReport()
    expect(report.failed).toBeUndefined()
    expect(report.defects).toEqual([])
    expect(warnings).toEqual([])
    const verdict = report.precheck!.capabilities[0]!.skills[0]!
    expect(verdict.valid && verdict.role).toBe('guidance')
    // Guidance is loadable and carries no execution claim: it is not in the provider set either.
    expect(executionProviders([verdict])).toEqual([])
  })

  it('names an execution provider that passes as such, and keeps it in the effective provider set', async () => {
    await installSkill(EXECUTION_SKILL, {
      type: 'execution',
      capabilities: ['fixture-capability'],
      requiredTools: ['bash', 'mcp__bbdev__bbdev_bemu_sim'],
      verifierRef: 'command',
    })
    const { runtime, warnings } = harness({
      'fixture-capability': { skills: [EXECUTION_SKILL], tools: ['filesystem', 'bash'], mcpServers: ['bbdev'] },
    })
    await runtime[Service.init]()

    const report = await runtime.providerLoadReport()
    expect(report.defects).toEqual([])
    expect(warnings).toEqual([])
    const providers = executionProviders(report.precheck!.capabilities.flatMap(row => [...row.skills]))
    expect(providers.map(provider => provider.name)).toEqual([EXECUTION_SKILL])
    expect(providers[0]!.verifierRef).toBe('command')
    // The scan's revision describes the table and the providers it accepted.
    expect(report.precheck!.revision).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports a table it cannot scan as failed, instead of passing a table it never read', async () => {
    // A row shaped so the scan itself throws: `skills` is not a list. The point
    // is not the shape (resolution refuses it elsewhere) but that the load-time
    // scan never turns a failure to read into a quiet success.
    const { runtime, warnings } = harness({ broken: { skills: 5 } as unknown as CapabilityConfig })
    await expect(runtime[Service.init]()).resolves.toBeUndefined()

    const report = await runtime.providerLoadReport()
    expect(report.precheck).toBeUndefined()
    expect(report.defects).toEqual([])
    expect(report.failed).toBeTruthy()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('the capability provider scan could not run')
    expect(warnings[0]).toContain('admission still refuses a batch whose provider cannot be judged')
  })

  it('takes the scan once: a later call answers with the load-time fact rather than re-reading the table', async () => {
    await installSkill(GUIDANCE_SKILL)
    const { runtime } = harness({ 'fixture-capability': { skills: [GUIDANCE_SKILL] } })
    const first = await runtime.providerLoadReport()
    const second = await runtime.providerLoadReport()
    expect(second).toBe(first)
  })
})
