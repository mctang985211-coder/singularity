import { testProjections } from './seam.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, expect, it } from 'vitest'
import { ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState,
} from '../../src/environment/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { openApparatus, bindCaller, type Apparatus } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { createMethod, loadMethod, methodEnvironment, publishedMethod, seedMethod, type MethodAssets,
} from '../src/method.ts'
import { templateDeclaration } from '../src/template.ts'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { startAttempt } from '../src/attempt.ts'
import { decompose } from '../src/surfaces.ts'
import { methodContext, readMethodContext, mountMethodSkills, runMethodTool } from '../src/method-run.ts'
import { propose } from '../src/surfaces.ts'
import { taskStateOf } from '../src/apparatus.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { agentFor, factsOf, attachmentsAt, execFor, fakeExecution, FakePersistence } from './seam.ts'
import { contractFor } from '../src/inputs.ts'
import { submit } from '../src/submission.ts'
import { fixtureReview } from './review-fixture.ts'

const dir = '/home/ROXY/code/singularity-core/deployment/domain/letters'
const tool = "import {readFileSync} from 'node:fs'; process.stdout.write(String((readFileSync(process.argv[2],'utf8').match(/[A-Za-z]/g)??[]).length))"
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-method-'))
  roots.push(root)
  const domain = await loadDomain(dir, spawnProcess)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('method-spec', root, domain, medium as unknown as SessionPersistence, attachmentsAt(root), testProjections,
  )
  const assets: MethodAssets = { rootTemplate: apparatus.domain.rootTemplate, templates: [...apparatus.domain.templates.values()].map((template) => ({
    ...templateDeclaration(template), ...(template.id === apparatus.domain.rootTemplate ? { skills: ['count'] } : {}),
  })), skills: [{ name: 'count', description: 'Count letters', capabilities: ['count'], requiredTools: ['count'], content: 'Count letters using available evidence.',
      },
    ], tools: [{ name: 'count', source: tool }],
  }
  const caller = { agentId: 'method-agent', sessionId: 'method-session', model: { provider: 'test', model: 'test' } }
  await bindCaller(apparatus, caller)
  return { apparatus, assets, caller, root, medium }
}

const contextFor = (apparatus: Apparatus, proposal: { taskId: string; runId: string }) =>
  methodContext(apparatus, proposal.taskId, taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!)

it('validates an imported seed and uses the latest publication for each independent business root', async () => {
  const { apparatus, assets, caller } = await setup()
  const invalid = { ...assets, templates: assets.templates.map(raw => ({ ...raw as object, artifact: 'changed.txt' })) }
  await expect(seedMethod(apparatus, invalid)).rejects.toThrow('protected input or acceptance')
  expect(publishedMethod(apparatus)).toBeUndefined()
  const seed = await seedMethod(apparatus, assets)
  const first = await propose(apparatus, caller, 'first-root', { goal: 'count letters' })
  expect(taskStateOf(apparatus, first.taskId).runs[first.runId]!.revision).toEqual(seed)
  const winner = await createMethod(apparatus, { ...assets, templates: assets.templates.map(raw => ({ ...raw as object, guidance: 'Read once and delegate one bounded count.' })) })
  await apparatus.store.emit({ commandId: 'publish-winner', protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched, subject: methodEnvironment(apparatus), payload: { expected: seed.revisionId, to: winner.revisionId } })
  expect(await seedMethod(apparatus, invalid)).toEqual(winner)
  const nextCaller = { ...caller, agentId: 'new-root-agent', sessionId: 'new-root-session' }
  await bindCaller(apparatus, nextCaller)
  const next = await propose(apparatus, nextCaller, 'next-root', { goal: 'count letters' })
  expect(next.taskId).not.toBe(first.taskId)
  expect(next.workspace).not.toBe(first.workspace)
  expect(taskStateOf(apparatus, next.taskId).runs[next.runId]!.revision).toEqual(winner)
  expect(taskStateOf(apparatus, first.taskId).runs[first.runId]!.revision).toEqual(seed)
  await apparatus.store.close()
})

it('freezes usable candidates without a separate asset admission review', async () => {
  const { apparatus, assets } = await setup()
  const revision = await createMethod(apparatus, assets)
  expect((await loadMethod(apparatus, revision)).assets).toEqual(assets)
  expect(
    apparatus.store
      .load()
      .entries()
      .filter((e) => e.protocol === 'review'),
  ).toEqual([])
  await apparatus.store.close()
})

it('rejects unbound method assets at Skill discovery and Tool execution without recording consumption', async () => {
  const { apparatus, assets, caller } = await setup()
  const method = await createMethod(apparatus, { ...assets, templates: assets.templates.map((raw) => ({ ...raw as object, skills: [] })) })
  const proposal = await propose(apparatus, caller, 'discover-skills', { goal: 'count letters', method })
  const view = await contextFor(apparatus, proposal)
  expect(view.skills).toEqual([])
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry, {})
    await mountMethodSkills(apparatus, Object.assign(agentFor(caller.agentId, caller.sessionId), { ctx }))
    expect(await ctx.skills.list()).toEqual([])
    expect(await ctx.skills.get('count')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
  await expect(runMethodTool(apparatus, caller, proposal.taskId, 'unbound', new AbortController().signal, 'count'))
    .rejects.toThrow('not bound to this Task')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.bubble!.tools.map((tool) => tool.name)).toEqual(['node'])
  expect((await contextFor(apparatus, proposal)).references).not.toContain(join(apparatus.workspaceRoot, 'assets', method.digest))
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed.some((use) => use.method === 'skill:count'),
  ).toBe(false)
  await apparatus.store.close()
})

it('keeps optional guidance separate from the fixed objective and preserves its read across recovery', async () => {
  const { apparatus, assets, caller, root, medium } = await setup()
  const method = await createMethod(apparatus, { ...assets, templates: assets.templates.map((raw) => {
    const template = raw as { id: string }
    return template.id === assets.rootTemplate ? { ...template, guidance: 'APPLY_CANDIDATE_METHOD_MARKER', skills: ['count'] } : template
  }) })
  const proposal = await propose(apparatus, caller, 'evaluation-context', { goal: 'fixed human objective', method }, { purpose: 'evaluation' })
  const task = taskStateOf(apparatus, proposal.taskId)
  expect(task.contract!.goal).toBe('fixed human objective')
  const context = await contextFor(apparatus, proposal)
  expect(context).toMatchObject({ guidance: 'APPLY_CANDIDATE_METHOD_MARKER', skills: [{ name: 'count', description: assets.skills[0]!.description }] })
  expect(context).not.toHaveProperty('boundSkills')
  expect(context).not.toHaveProperty('localCheck')
  expect(task.runs[proposal.runId]!.consumed.filter(use => !use.method.startsWith('template:'))).toEqual([])
  expect(await readMethodContext(apparatus, task.taskId, task.runs[proposal.runId]!)).toEqual(context)
  const consumption = taskStateOf(apparatus, task.taskId).runs[proposal.runId]!.consumed
  expect(consumption).toContainEqual({ method: 'guidance:count-source', source: `${method.digest}/read:guidance:count-source:${context.template!.digest}` })
  expect(consumption.some(use => use.method === 'skill:count')).toBe(false)
  await apparatus.store.close()
  const restored = await openApparatus('method-spec', root, await loadDomain(dir, spawnProcess), medium as unknown as SessionPersistence, attachmentsAt(root), testProjections)
  expect(await contextFor(restored, proposal)).toEqual(context)
  await readMethodContext(restored, task.taskId, taskStateOf(restored, task.taskId).runs[proposal.runId]!)
  expect(taskStateOf(restored, task.taskId).runs[proposal.runId]!.consumed).toEqual(consumption)
  await restored.store.close()
})

it('executes generated verifier samples from exact literal content, including an empty input', async () => {
  const { apparatus, assets } = await setup()
  const content = { ...assets, tools: [...assets.tools, { name: 'content-check',
    source: "import {readFileSync} from 'node:fs'; process.exit(readFileSync(process.argv[2],'utf8') === 'accepted bytes' && readFileSync(process.argv[3],'utf8') === '' ? 0 : 1)",
    verifier: { samples: [
      { name: 'accept exact bytes', artifactContent: 'accepted bytes', inputContent: '', expected: 'pass' as const,
            },
      { name: 'reject changed bytes', artifactContent: 'wrong bytes', inputContent: '', expected: 'fail' as const,
            },
          ],
        },
      },
    ],
  }
  const revision = await createMethod(apparatus, content)
  expect((await loadMethod(apparatus, revision)).assets).toEqual(content)
  await apparatus.store.close()
})

it('returns generated verifier execution details when a declared positive sample fails', async () => {
  const { apparatus, assets } = await setup()
  await expect(createMethod(apparatus, { ...assets, tools: [...assets.tools, { name: 'broken-check',
    source: "console.error('cannot compile staged RTL sample'); process.exit(1)",
    verifier: { samples: [
      { name: 'positive', artifactContent: 'sample RTL', inputContent: '', expected: 'pass' },
      { name: 'negative', artifactContent: 'changed RTL', inputContent: '', expected: 'fail' },
    ],
          },
        },
      ],
    }),
  ).rejects.toThrow('cannot compile staged RTL sample')
  await apparatus.store.close()
})

it('loads the exact immutable content and admits a self-created template using the declared domain ports', async () => {
  const { apparatus, assets } = await setup()
  const custom = structuredClone(assets.templates[0]) as { id: string; goal: string }
  custom.id = 'count-exploration'
  custom.goal = 'Count using a streaming traversal.'
  const content = { ...assets, templates: [...assets.templates, custom] }
  const revision = await createMethod(apparatus, content)
  expect((await loadMethod(apparatus, revision)).assets).toEqual(content)
  expect((await loadMethod(apparatus, revision)).domain.templates.get(custom.id)?.goal).toBe(custom.goal)
  await expect(createMethod(apparatus, content)).resolves.toEqual(revision)
  await apparatus.store.close()
})

it('refuses changes to protected task input or acceptance while allowing changed solver instructions', async () => {
  const { apparatus, assets } = await setup()
  let changed = structuredClone(assets.templates) as { guidance: string
    inputs: { source: { ref: string } }[]
    checks: { verifier: string }[] }[]
  changed[0]!.guidance = 'Use a single-pass counter.'
  await expect(createMethod(apparatus, { ...assets, templates: changed })).resolves.toBeDefined()
  changed = structuredClone(changed)
  changed[0]!.checks[0]!.verifier = 'extract-letters'
  await expect(createMethod(apparatus, { ...assets, templates: changed })).rejects.toThrow('acceptance')
  changed[0]!.checks[0]!.verifier = 'letters'
  changed[0]!.inputs[0]!.source.ref = 'invented-source'
  await expect(createMethod(apparatus, { ...assets, templates: changed })).rejects.toThrow()
  await apparatus.store.close()
})

it('refuses dropping a protected checker or replacing the frozen root initial content', async () => {
  const { apparatus, assets } = await setup()
  await expect(createMethod(apparatus, { ...assets, templates: assets.templates.map(raw => {
    const template = raw as { id: string }
    return template.id === assets.rootTemplate ? { ...template, checks: [] } : template
  }) })).rejects.toThrow('acceptance')
  await expect(createMethod(apparatus, { ...assets, templates: assets.templates.map(raw => {
    const template = raw as { id: string }
    return template.id === assets.rootTemplate ? { ...template, initial: { content: '35' } } : template
  }) })).rejects.toThrow('initial root source')
  await apparatus.store.close()
})

it('judges a generated template with the verifier frozen in its Run revision', async () => {
  const { apparatus, assets, caller } = await setup()
  const checker = { name: 'generated-count',
    source: "import {readFileSync} from 'node:fs'; const n=(readFileSync(process.argv[3],'utf8').match(/[A-Za-z]/g)||[]).length; process.exit(readFileSync(process.argv[2],'utf8').trim()===String(n)?0:1)",
    verifier: { samples: [
      { name: 'right', artifactContent: '1', inputContent: 'a!', expected: 'pass' },
      { name: 'wrong', artifactContent: '2', inputContent: 'a!', expected: 'fail' },
    ] },
  } as const
  const method = await createMethod(apparatus, { ...assets, tools: [...assets.tools, checker], templates: [...assets.templates,
    { ...assets.templates[0] as object, id: 'generated-task', checks: [{ criterionId: 'letters', verifier: checker.name, input: 'in/source.txt' }] },
  ] })
  const { domain } = await loadMethod(apparatus, method), template = domain.templates.get('generated-task')!
  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.admit({ commandId: 'generated-admit', taskId: 'generated-task', contract: contractFor(domain, template, template.goal) })
  await commands.assign({ commandId: 'generated-assign', taskId: 'generated-task', agentId: caller.agentId })
  const run = await startAttempt(apparatus, caller, 'generated-task', 'run-generated', method)
  const count = (Buffer.from(domain.inputs[0]!.bytes).toString('utf8').match(/[A-Za-z]/g) ?? []).length
  await writeFile(join(run.bubble!.workspace.ref, template.artifact), String(count))
  const agent = agentFor(caller.agentId, caller.sessionId)
  const result = await submit(apparatus, fakeExecution(() => undefined), caller, execFor(agent, 'submit-generated'),
    { taskId: 'generated-task', path: template.artifact }, new AbortController().signal, fixtureReview(apparatus))
  expect(result.verdict, result.detail).toBe('pass')
  const evidence = taskStateOf(apparatus, 'generated-task').runs[run.runId]!.evidence[0]!
  expect(JSON.parse(evidence.detail!).checks[0]).toMatchObject({ verifierRef: checker.name,
    implementationDigest: template.checks[0]!.criterion.implementationDigest })
  await apparatus.store.close()
})

it('passes a model-created candidate to the pinned auxiliary tool without making it the submission', async () => {
  const { apparatus, assets, caller } = await setup()
  const method = await createMethod(apparatus, { ...assets,
    tools: [{ name: 'count', source: "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(process.argv[3],'utf8').toUpperCase())",
      },
    ],
  })
  const proposal = await propose(apparatus, caller, 'candidate-test', { goal: 'inspect candidate', method })
  await writeFile(join(proposal.workspace, 'candidate.v'), 'model-created source')
  const result = await runMethodTool(apparatus, caller, proposal.taskId, 'inspect', new AbortController().signal, 'count', 'candidate.v',
  )
  expect(result.artifact).toBe('MODEL-CREATED SOURCE')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.submission).toBeUndefined()
  await apparatus.store.close()
})
it('runs a verifier Tool with the same artifact/input order as its checked samples', async () => {
  const { apparatus, assets, caller } = await setup()
  const checker = {
    name: 'check-count',
    source: "import {readFileSync} from 'node:fs'; const n=(readFileSync(process.argv[3],'utf8').match(/[A-Za-z]/g)||[]).length; process.exit(readFileSync(process.argv[2],'utf8').trim()===String(n)?0:1)",
    verifier: { samples: [
      { name: 'right', artifactContent: '1', inputContent: 'a!', expected: 'pass' },
      { name: 'wrong', artifactContent: '2', inputContent: 'a!', expected: 'fail' },
    ] },
  } as const
  const method = await createMethod(apparatus, { ...assets, tools: [...assets.tools, checker],
    templates: assets.templates.map((raw) => ({ ...raw as object, capabilities: [checker.name] })) })
  const proposal = await propose(apparatus, caller, 'verifier-tool', { goal: 'count letters', method })
  await writeFile(join(proposal.workspace, 'candidate.txt'), '35')
  await expect(runMethodTool(apparatus, caller, proposal.taskId, 'check', new AbortController().signal,
    checker.name, 'candidate.txt')).resolves.toEqual({ artifact: '' })
  await writeFile(join(proposal.workspace, 'candidate.txt'), '0')
  await expect(runMethodTool(apparatus, caller, proposal.taskId, 'wrong', new AbortController().signal,
    checker.name, 'candidate.txt')).rejects.toThrow('Tool exited 1')
  await apparatus.store.close()
})

it('freezes capability bindings to Skills and Tools from the same Revision and reports uncovered declarations', async () => {
  const { apparatus, assets, caller } = await setup()
  const probe = { name: 'probe', source: "process.stdout.write('probe result')" }
  const method = await createMethod(apparatus, { ...assets,
    templates: assets.templates.map((raw) => {
      const template = raw as { id: string }
      return template.id === assets.rootTemplate ? { ...template, capabilities: ['count', 'probe', 'yosys'] } : template
    }), tools: [...assets.tools, probe],
  })
  const proposal = await propose(apparatus, caller, 'bind-generated-assets', { goal: 'count letters', method })
  const bindings = { skills: [{ name: 'count', digest: digestOf(assets.skills[0]) }],
    tools: [{ name: 'count', digest: digestOf(assets.tools[0]) }, { name: 'probe', digest: digestOf(probe) },
    ],
    gaps: ['yosys'],
  }
  expect(await contextFor(apparatus, proposal)).toMatchObject({ skills: bindings.skills, tools: bindings.tools, gaps: bindings.gaps })
  const view = await contextFor(apparatus, proposal)
  expect(view).toMatchObject({ method, skills: bindings.skills, tools: bindings.tools, gaps: bindings.gaps })
  expect((await snapshotOf(apparatus)).tasks.find((task) => task.taskId === proposal.taskId)!.bindings).toEqual(bindings)
  expect((await runMethodTool(apparatus, caller, proposal.taskId, 'probe', new AbortController().signal, 'probe')).artifact,
  ).toBe('probe result')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed).toContainEqual({
    method: 'tool:probe', source: `${method.digest}/tool:probe:${digestOf(probe)}:${caller.sessionId}/probe`,
  })
  await apparatus.store.close()
})

it('keeps an existing Run on its Revision across publication and reload, while a new Run consumes the published version', async () => {
  const { apparatus, assets, caller, root, medium } = await setup()
  const first = await createMethod(apparatus, assets)
  const secondAssets = { ...assets,
    skills: [{ ...assets.skills[0]!, content: 'Second version instructions.' }],
    tools: [{ name: 'count', source: "process.stdout.write('second version')" }, { name: 'new-tool', source: "process.stdout.write('new Tool')" },
    ],
  }
  const second = await createMethod(apparatus, secondAssets)
  const environmentId = methodEnvironment(apparatus)
  await apparatus.store.emit({ commandId: 'publish-first', protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched, subject: environmentId, payload: { expected: '', to: first.revisionId },
  })
  const original = await propose(apparatus, caller, 'before-publication', { goal: 'original task' })
  const originalBindings = (await snapshotOf(apparatus)).tasks.find(task => task.taskId === original.taskId)!.bindings
  await apparatus.store.emit({ commandId: 'publish-second', protocol: ENVIRONMENT_PROTOCOL, version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.pointerSwitched, subject: environmentId, payload: { expected: first.revisionId, to: second.revisionId },
  })
  await apparatus.store.close()
  const restored = await openApparatus(apparatus.controlId, root, apparatus.domain, medium as unknown as SessionPersistence, attachmentsAt(root), testProjections,
  )
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry, {})
    await mountMethodSkills(restored, Object.assign(agentFor(caller.agentId, caller.sessionId), { ctx }))
    expect((await ctx.skills.get('count'))?.content).toBe(assets.skills[0]!.content)
    const firstResult = await runMethodTool(restored, caller, original.taskId, 'first-tool', new AbortController().signal, 'count',
    )
    expect(firstResult.artifact).toMatch(/^\d+$/)
    const originalRun = taskStateOf(restored, original.taskId).runs[original.runId]!
    expect(originalRun.revision).toEqual(first)
    expect(originalRun.consumed).toContainEqual({ method: 'skill:count', source: `${first.digest}/skill:count:${digestOf(assets.skills[0])}`,
    })
    expect(originalRun.consumed.every((use) => use.source.startsWith(`${first.digest}/`))).toBe(true)
    expect(publishedMethod(restored)).toEqual(second)
    await expect(runMethodTool(restored, caller, original.taskId, 'new-tool', new AbortController().signal, 'new-tool'),
    )
      .rejects.toThrow('absent from the pinned Revision')
    const nextCaller = { ...caller, agentId: 'next-agent', sessionId: 'next-session' }
    const next = await propose(restored, nextCaller, 'after-publication', { goal: 'next task' })
    const nextCtx = new Context()
    try {
      await nextCtx.plugin(SkillRegistry, {})
      await mountMethodSkills(restored, Object.assign(agentFor(nextCaller.agentId, nextCaller.sessionId), { ctx: nextCtx }),
      )
      expect((await nextCtx.skills.get('count'))?.content).toBe(secondAssets.skills[0]!.content)
      expect((await runMethodTool(restored, nextCaller, next.taskId, 'next-tool', new AbortController().signal, 'count')).artifact,
      ).toBe('second version')
      const nextRun = taskStateOf(restored, next.taskId).runs[next.runId]!
      expect(nextRun.revision).toEqual(second)
      const snapshot = await snapshotOf(restored)
      expect(snapshot.tasks.find((task) => task.taskId === original.taskId)!.bindings).toEqual(originalBindings)
      expect(snapshot.tasks.find((task) => task.taskId === next.taskId)!.bindings).toMatchObject({
        skills: [{ name: 'count', digest: digestOf(secondAssets.skills[0]) }],
      })
      expect(nextRun.consumed.every((use) => use.source.startsWith(`${second.digest}/`))).toBe(true)
      expect([...restored.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).values()]
        .filter((environment) => environment.pointer !== undefined)
          .map((environment) => environment.environmentId),
      ).toEqual([environmentId])
    } finally { await nextCtx.fiber.dispose() }
  } finally { await ctx.fiber.dispose()
    await restored.store.close() }
})

it('uses one method Revision directly with no execution Environment copy', async () => {
  const { apparatus, assets, caller } = await setup()
  const method = await createMethod(apparatus, assets)
  const proposal = await propose(apparatus, caller, 'direct', { goal: 'count', method })
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.revision).toEqual(method)
  expect(apparatus.store.load().statesOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).size).toBe(1)
  await apparatus.store.close()
})

it('records the first actual Tool execution even when it fails and records it once', async () => {
  const { apparatus, assets, caller } = await setup()
  const conditional = { name: 'count', source: "import {readFileSync} from 'node:fs'; if (readFileSync(process.argv[3],'utf8') !== 'pass') { console.error('rejected candidate'); process.exit(1) }; process.stdout.write('accepted')",
  }
  const method = await createMethod(apparatus, { ...assets, tools: [conditional] })
  const proposal = await propose(apparatus, caller, 'tool-failure', { goal: 'inspect tool', method })
  await writeFile(join(proposal.workspace, 'candidate.txt'), 'fail')
  await expect(runMethodTool(apparatus, caller, proposal.taskId, 'failed', new AbortController().signal, 'count', 'candidate.txt'),
  ).rejects.toThrow('rejected candidate')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed.filter((use) => use.method === 'tool:count'))
    .toEqual([{ method: 'tool:count', source: `${method.digest}/tool:count:${digestOf(conditional)}:${caller.sessionId}/failed` }])
  await writeFile(join(proposal.workspace, 'candidate.txt'), 'pass')
  await runMethodTool(apparatus, caller, proposal.taskId, 'success', new AbortController().signal, 'count', 'candidate.txt')
  await runMethodTool(apparatus, caller, proposal.taskId, 'again', new AbortController().signal, 'count', 'candidate.txt')
  expect(taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!.consumed.filter((use) => use.method === 'tool:count'),
  ).toEqual([
    { method: 'tool:count', source: `${method.digest}/tool:count:${digestOf(conditional)}:${caller.sessionId}/failed`,
    },
  ])
  await apparatus.store.close()
})

it('rejects a method without its protected root template', async () => {
  const { apparatus, assets } = await setup()
  await expect(
    createMethod(apparatus, { ...assets, templates: assets.templates.filter((t) => (t as { id: string }).id !== assets.rootTemplate),
    }),
  ).rejects.toThrow()
  await apparatus.store.close()
})


it('keeps task-selected assets in their native agent scope, including one-off responsibilities', async () => {
  const { apparatus, assets, caller } = await setup()
  const probe = { name: 'probe', source: "process.stdout.write('scoped probe')" }
  const method = await createMethod(apparatus, { ...assets, tools: [...assets.tools, probe] })
  const parent = await propose(apparatus, caller, 'scoped-assets', { goal: 'count letters', method })
  await decompose(apparatus, { advance: async () => [] }, caller, {
    taskId: parent.taskId, children: [{ key: 'probe', contract: { goal: 'investigate a specific uncertainty',
      artifact: 'finding.txt', inputs: [], capabilities: ['probe'],
      criteria: [{ criterionId: 'finding', statement: 'a supported finding' }] },
      supports: ['letters'], dependsOn: [], maxRuns: 1, requirement: 'required' as const }] })
  const childId = taskStateOf(apparatus, parent.taskId).decomposition!.children[0]!.taskId
  const child = taskStateOf(apparatus, childId)
  const childCaller = { ...caller, agentId: child.responsibility!.agentId, sessionId: child.responsibility!.agentId }
  const run = await startAttempt(apparatus, childCaller, childId, 'probe', method)
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry, {})
    const parentScope = createScope(ctx, { agent: caller.agentId })
    const childScope = createScope(ctx, { agent: childCaller.agentId })
    await mountMethodSkills(apparatus, Object.assign(agentFor(caller.agentId, caller.sessionId), { ctx: parentScope.ctx }))
    await mountMethodSkills(apparatus, Object.assign(agentFor(childCaller.agentId, childCaller.sessionId), { ctx: childScope.ctx }))
    expect((await ctx.skills.list({ scope: scopeOf(parentScope.ctx) })).map((skill) => skill.name)).toEqual(['count'])
    expect(await ctx.skills.get('count', { scope: scopeOf(childScope.ctx) })).toBeUndefined()
    expect(await ctx.skills.list()).toEqual([])
    expect((await runMethodTool(apparatus, childCaller, childId, 'probe', new AbortController().signal, 'probe')).artifact)
      .toBe('scoped probe')
    await expect(runMethodTool(apparatus, childCaller, childId, 'count', new AbortController().signal, 'count'))
      .rejects.toThrow('not bound to this Task')
    expect(run.bubble!.tools.filter((tool) => tool.name.startsWith('method:'))).toEqual([
      { name: 'method:probe', version: digestOf(probe), implementationDigest: digestOf(probe) }])
    const context = await methodContext(apparatus, childId, run)
    expect(context.references).toContain(join(apparatus.workspaceRoot, 'assets', method.digest, 'probe.mjs'))
    expect(context.references).not.toContain(join(apparatus.workspaceRoot, 'assets', method.digest, 'count.mjs'))
    await expect(runMethodTool(apparatus, caller, parent.taskId, 'parent-probe', new AbortController().signal, 'probe'))
      .rejects.toThrow('delegated responsibilities')
  } finally { await ctx.fiber.dispose(); await apparatus.store.close() }
})

it('rejects a one-off selection with an absent Skill before admitting children', async () => {
  const { apparatus, assets, caller, medium } = await setup()
  const method = await createMethod(apparatus, assets)
  const parent = await propose(apparatus, caller, 'missing-selection', { goal: 'count letters', method })
  const count = factsOf(medium).length
  await expect(decompose(apparatus, { advance: async () => [] }, caller, {
    taskId: parent.taskId, children: [{ key: 'missing', contract: { goal: 'one uncertainty', artifact: 'finding.txt',
      inputs: [], skills: ['missing'], criteria: [{ criterionId: 'finding', statement: 'a supported finding' }] },
      supports: ['letters'], dependsOn: [], maxRuns: 1, requirement: 'required' as const }] })).rejects.toThrow('missing Skill')
  expect(factsOf(medium)).toHaveLength(count)
  await apparatus.store.close()
})
