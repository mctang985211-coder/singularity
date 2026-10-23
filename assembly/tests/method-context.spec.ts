import { testProjections } from './seam.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, expect, it } from 'vitest'
import { digestOf } from '../../src/protocol/envelope.ts'
import { contextDigestOf } from '../../src/measure/protocol.ts'
import { openApparatus, taskStateOf } from '../src/apparatus.ts'
import { startAttempt } from '../src/attempt.ts'
import { loadDomain } from '../src/domain.ts'
import { createMethod, type MethodAssets } from '../src/method.ts'
import { methodContext, mountMethodSkills, readMethodContext, runMethodTool } from '../src/method-run.ts'
import { spawnProcess } from '../src/process.ts'
import { readForAgent } from '../src/read.ts'
import { templateDeclaration } from '../src/template.ts'
import { propose } from '../src/surfaces.ts'
import { agentFor, attachmentsAt, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../domain/reference', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function setup(guidance?: string) {
  const root = await mkdtemp(join(tmpdir(), 'method-context-'))
  roots.push(root)
  const apparatus = await openApparatus('method-context', root, await loadDomain(domainDir, spawnProcess),
    new FakePersistence() as never, attachmentsAt(root), testProjections)
  const assets: MethodAssets = {
    workflowGuidance: '',
    templates: [...apparatus.domain.templates.values()].map((template) => ({
      ...templateDeclaration(template),
      ...(template.id === apparatus.domain.rootTemplate
        ? { skills: ['count'], capabilities: ['candidate-check'], ...(guidance === undefined ? {} : { guidance }) }
        : {}),
    })),
    skills: [{ name: 'count', description: 'Count ASCII letters', capabilities: ['count'], requiredTools: [],
      content: 'Read the frozen input before counting ASCII letters.' }],
    tools: [{ name: 'candidate-check',
      source: "import{readFileSync}from'node:fs';process.exit(readFileSync(process.argv[2],'utf8')==='valid'?0:1)",
      verifier: { samples: [
        { name: 'accept', artifactContent: 'valid', inputContent: '', expected: 'pass' },
        { name: 'reject', artifactContent: 'invalid', inputContent: '', expected: 'fail' },
      ] },
    }],
  }
  const method = await createMethod(apparatus, assets)
  const caller = { agentId: 'context-agent', sessionId: 'context-session', model: { provider: 'test', model: 'test' } }
  const proposal = await propose(apparatus, caller, 'root', { goal: 'The authoritative human objective', method })
  const run = taskStateOf(apparatus, proposal.taskId).runs[proposal.runId]!
  return { apparatus, assets, caller, method, proposal, run, initialConsumption: run.consumed }
}

it('offers a pinned asset catalog and records only guidance and Skills actually read', async () => {
  const h = await setup('Use the count Skill only when ASCII counting is relevant.')
  const ctx = new Context()
  try {
    const context = await methodContext(h.apparatus, h.proposal.taskId, h.run)
    expect(context.method).toEqual(h.method)
    expect(context.guidance).toBe('Use the count Skill only when ASCII counting is relevant.')
    expect(context.skills).toEqual([{ name: 'count', description: 'Count ASCII letters', digest: digestOf(h.assets.skills[0]),
      read: { tool: 'skill', arguments: { name: 'count' } } }])
    expect(context).not.toHaveProperty('contract')
    expect(context).not.toHaveProperty('workspace')
    expect(context).not.toHaveProperty('parent')
    expect(context).not.toHaveProperty('coordination')
    expect(context).not.toHaveProperty('boundSkills')
    expect(context.references).not.toContain(domainDir)
    expect(JSON.stringify(context)).not.toContain(h.assets.skills[0]!.content)
    expect(await readForAgent(h.apparatus, h.caller.agentId, { kind: 'template' })).toContainEqual({
      id: h.apparatus.domain.rootTemplate!, goal: expect.any(String), producers: [],
      skills: ['count'], capabilities: ['candidate-check'],
    })
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual(h.initialConsumption)

    await ctx.plugin(SkillRegistry, {})
    await mountMethodSkills(h.apparatus, Object.assign(agentFor(h.caller.agentId, h.caller.sessionId), { ctx }))
    expect((await ctx.skills.list()).map((skill) => skill.name)).toEqual(['count'])
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual(h.initialConsumption)

    await readForAgent(h.apparatus, h.caller.agentId, { kind: 'template', ref: h.apparatus.domain.rootTemplate! })
    expect(await readForAgent(h.apparatus, h.caller.agentId, { kind: 'method' })).toEqual(context)
    const guidanceUse = { method: `guidance:${context.template!.id}`,
      mode: 'read', source: `${h.method.digest}/read:guidance:${context.template!.id}:${context.template!.digest}` }
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual([...h.initialConsumption, guidanceUse])
    expect((await ctx.skills.get('count'))!.content).toBe(h.assets.skills[0]!.content)
    const consumed = taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed
    expect(consumed).toEqual([...h.initialConsumption, guidanceUse,
      { method: 'skill:count', mode: 'read', source: `${h.method.digest}/skill:count:${digestOf(h.assets.skills[0])}` }])
    await readMethodContext(h.apparatus, h.proposal.taskId, h.run)
    await readForAgent(h.apparatus, h.caller.agentId, { kind: 'template', ref: h.apparatus.domain.rootTemplate! })
    await ctx.skills.get('count')
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual(consumed)
  } finally { await ctx.fiber.dispose(); await h.apparatus.store.close() }
})

it('keeps goals out of optional guidance and supplies an executable verifier call', async () => {
  const h = await setup()
  try {
    const context = await readMethodContext(h.apparatus, h.proposal.taskId, h.run)
    expect(context).not.toHaveProperty('guidance')
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual(h.initialConsumption)
    const tool = context.tools[0]!
    expect(tool.call).toEqual({ tool: 'singularity_run_method', arguments: { tool: 'candidate-check', candidatePath: h.proposal.contract.artifact } })
    expect(tool.candidatePath).toBe('required existing workspace file')
    await writeFile(join(h.proposal.workspace, tool.call.arguments.candidatePath!), 'valid')
    await expect(runMethodTool(h.apparatus, h.caller, h.proposal.taskId, 'sample', new AbortController().signal,
      tool.call.arguments.tool, tool.call.arguments.candidatePath)).resolves.toEqual({ artifact: '' })
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual([...h.initialConsumption,
      { method: 'tool:candidate-check', mode: 'invoked', source: `${h.method.digest}/tool:candidate-check:${tool.digest}:${h.caller.sessionId}/sample` },
    ])
  } finally { await h.apparatus.store.close() }
})

it('keeps an unchanged bound tool comparable across method revisions and exposes the frozen root context to RSI', async () => {
  const h = await setup()
  try {
    const revised = await createMethod(h.apparatus, { ...h.assets,
      templates: h.assets.templates.map(raw => ({ ...(raw as object), guidance: 'Read the evidence before choosing a branch.' })) })
    const next = await propose(h.apparatus, h.caller, 'next-root', { goal: h.proposal.contract.goal, method: revised })
    const bubble = taskStateOf(h.apparatus, next.taskId).runs[next.runId]!.bubble!
    expect(revised.digest).not.toBe(h.method.digest)
    expect(bubble.tools).toEqual(h.run.bubble!.tools)
    expect(contextDigestOf(bubble)).toBe(contextDigestOf(h.run.bubble!))
    const auditCaller = { ...h.caller, agentId: 'audit-agent', sessionId: 'audit-session' }
    await propose(h.apparatus, auditCaller, 'audit', { goal: 'Compare methods', method: h.method },
      { purpose: 'improve', relatedTo: { taskId: h.proposal.taskId, runId: h.proposal.runId } })
    const read = await readForAgent(h.apparatus, auditCaller.agentId, { kind: 'method' }) as {
      format: string; rootExecutionContext: unknown
    }
    expect(read.rootExecutionContext).toEqual({ model: bubble.model, tools: bubble.tools, conditions: bubble.conditions, inputs: bubble.inputs })
    expect(read.format).toContain('requiredTools')
    expect(read.format).toContain('caliber')
  } finally { await h.apparatus.store.close() }
})

it('limits execution reads to the pinned catalog and leaves audit asset reads out of consumption', async () => {
  const h = await setup('Read the evidence before selecting a method.')
  try {
    const newer = await createMethod(h.apparatus, { ...h.assets, skills: [{ ...h.assets.skills[0]!, description: 'A newer count Skill' }] })
    await expect(readForAgent(h.apparatus, h.caller.agentId, { kind: 'method', ref: newer.digest }))
      .rejects.toThrow('execution methods are pinned')
    expect(await readForAgent(h.apparatus, h.caller.agentId, { kind: 'method', ref: h.method.digest }))
      .not.toHaveProperty('assets')

    const auditCaller = { ...h.caller, agentId: 'audit-agent', sessionId: 'audit-session' }
    const audit = await propose(h.apparatus, auditCaller, 'audit', { goal: 'Compare method assets', method: h.method },
      { purpose: 'improve', relatedTo: { taskId: h.proposal.taskId, runId: h.proposal.runId } })
    const initial = taskStateOf(h.apparatus, audit.taskId).runs[audit.runId]!.consumed
    const method = await readForAgent(h.apparatus, auditCaller.agentId, { kind: 'method' })
    expect(method).toMatchObject({ reference: h.method, assets: h.assets })
    for (const field of ['proposal', 'reportTemplate', 'feedback', 'nextRound']) expect(method).not.toHaveProperty(field)
    await readForAgent(h.apparatus, auditCaller.agentId, { kind: 'template', ref: h.apparatus.domain.rootTemplate! })
    expect(taskStateOf(h.apparatus, audit.taskId).runs[audit.runId]!.consumed).toEqual(initial)
  } finally { await h.apparatus.store.close() }
})

it('records failed verifier execution but leaves calls cancelled before launch out of consumption', async () => {
  const h = await setup()
  try {
    const tool = (await methodContext(h.apparatus, h.proposal.taskId, h.run)).tools[0]!
    await writeFile(join(h.proposal.workspace, tool.call.arguments.candidatePath!), 'invalid')
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled before launch'))
    await expect(runMethodTool(h.apparatus, h.caller, h.proposal.taskId, 'cancelled', cancelled.signal,
      tool.call.arguments.tool, tool.call.arguments.candidatePath)).rejects.toThrow('cancelled before launch')
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual(h.initialConsumption)

    await expect(runMethodTool(h.apparatus, h.caller, h.proposal.taskId, 'failed', new AbortController().signal,
      tool.call.arguments.tool, tool.call.arguments.candidatePath)).rejects.toThrow('Tool exited 1')
    expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.run.runId]!.consumed).toEqual([...h.initialConsumption,
      { method: `tool:${tool.name}`, mode: 'invoked', source: `${h.method.digest}/tool:${tool.name}:${tool.digest}:${h.caller.sessionId}/failed` },
    ])
  } finally { await h.apparatus.store.close() }
})

it('passes every frozen input in contract order, placing the candidate after ordinary inputs and before verifier inputs', async () => {
  const h = await setup()
  try {
    const describeArgs = "process.argv.slice(2).map(path=>({name:path.split('/').at(-1),content:readFileSync(path,'utf8')}))"
    const ordinary = { name: 'inspect-inputs',
      source: `import{readFileSync}from'node:fs';process.stdout.write(JSON.stringify(${describeArgs}))` }
    const verifier = { name: 'verify-inputs',
      source: `import{readFileSync}from'node:fs';const [candidate,...inputs]=process.argv.slice(2);if(readFileSync(candidate,'utf8')!==inputs.map(path=>readFileSync(path,'utf8')).join('|'))process.exit(1);process.stdout.write(JSON.stringify(${describeArgs}))`,
      verifier: { samples: [
        { name: 'accept matching input', artifactContent: 'a!', inputContent: 'a!', expected: 'pass' as const },
        { name: 'reject changed input', artifactContent: 'b!', inputContent: 'a!', expected: 'fail' as const },
      ] },
    }
    const method = await createMethod(h.apparatus, { ...h.assets, tools: [ordinary, verifier] })
    const source = h.apparatus.domain.inputs[0]!
    const commands = h.apparatus.tasks.forAgent(h.caller.agentId)
    const contract = { goal: 'Inspect the complete ordered inputs', artifact: 'candidate.txt',
      inputs: ['in/z-first.txt', 'in/a-second.txt'].map(name => ({ name,
        source: { kind: 'protected' as const, ref: source.ref, digest: source.digest } })),
      criteria: [{ criterionId: 'ordered-inputs', statement: 'Both frozen inputs reach the tools in contract order' }],
      capabilities: [ordinary.name, verifier.name],
    }
    await commands.admit({ commandId: 'admit-multiple-inputs', taskId: 'multiple-inputs', contract })
    await commands.assign({ commandId: 'assign-multiple-inputs', taskId: 'multiple-inputs', agentId: h.caller.agentId })
    const run = await startAttempt(h.apparatus, h.caller, 'multiple-inputs', 'ordered-inputs', method)
    const inputContent = Buffer.from(source.bytes).toString('utf8'), candidateContent = `${inputContent}|${inputContent}`
    await writeFile(join(run.bubble!.workspace.ref, contract.artifact), candidateContent)
    const inputArgs = [{ name: 'z-first.txt', content: inputContent }, { name: 'a-second.txt', content: inputContent }]
    const candidateArg = { name: contract.artifact, content: candidateContent }

    const ordinaryResult = await runMethodTool(h.apparatus, h.caller, 'multiple-inputs', 'ordinary',
      new AbortController().signal, ordinary.name, contract.artifact)
    expect(JSON.parse(ordinaryResult.artifact)).toEqual([...inputArgs, candidateArg])
    const verifierResult = await runMethodTool(h.apparatus, h.caller, 'multiple-inputs', 'verifier',
      new AbortController().signal, verifier.name, contract.artifact)
    expect(JSON.parse(verifierResult.artifact)).toEqual([candidateArg, ...inputArgs])
  } finally { await h.apparatus.store.close() }
})

it('confines bound method tools to their workspace inputs and explicitly shared references', async () => {
  const h = await setup()
  try {
    const source = `import{readFileSync}from'node:fs';process.stdout.write(readFileSync(${JSON.stringify(join(domainDir, 'samples/source.txt'))},'utf8'))`
    const method = await createMethod(h.apparatus, { ...h.assets,
      templates: h.assets.templates.map(raw => (raw as { id: string }).id === h.apparatus.domain.rootTemplate
        ? { ...(raw as object), capabilities: ['source-lookup'] } : raw),
      tools: [{ name: 'source-lookup', source }],
    })
    const proposal = await propose(h.apparatus, { ...h.caller, agentId: 'scoped-agent', sessionId: 'scoped-session' },
      'scoped', { goal: 'use only the frozen input', method })
    await expect(runMethodTool(h.apparatus, { ...h.caller, agentId: 'scoped-agent', sessionId: 'scoped-session' },
      proposal.taskId, 'source-lookup', new AbortController().signal, 'source-lookup')).rejects.toThrow('ENOENT')
  } finally { await h.apparatus.store.close() }
})

it('delivers a pinned workflow once, records an explicit read separately and leaves acceptance unchanged', async () => {
  const h = await setup()
  try {
    const { confirmWorkflowDelivery } = await import('../src/method-run.ts')
    const { schedulerMessage } = await import('../../src/runtime/task-message.ts')
    const revision = await createMethod(h.apparatus, { ...h.assets, workflowGuidance: 'Investigate the narrowest uncertain interface, then delegate only independent results.', templates: [] })
    const contract = { goal: 'Solve a different Task without a template', artifact: 'result.txt', inputs: [],
      criteria: [{ criterionId: 'result', statement: 'Return the requested independent result.' }] }
    const task = await propose(h.apparatus, { ...h.caller, agentId: 'independent', sessionId: 'independent' }, 'independent', { contract, method: revision })
    const run = taskStateOf(h.apparatus, task.taskId).runs[task.runId]!
    await methodContext(h.apparatus, task.taskId, run)
    expect(await confirmWorkflowDelivery(h.apparatus, task.taskId, run)).toBe(false)
    expect(taskStateOf(h.apparatus, task.taskId).runs[run.runId]!.consumed).toEqual([])
    const context = await methodContext(h.apparatus, task.taskId, run)
    const message = schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: h.apparatus.controlId,
      parentTaskId: task.taskId, taskId: task.taskId, runId: run.runId, factSeq: 0 }, JSON.stringify({ method: context }))
    const native = { ...h.apparatus, persistence: { stat: async () => ({}), open: async () => ({
      read: async () => ({ events: [{ type: 'user/message', seq: 0, data: message }] }), close: async () => undefined,
    }) } } as unknown as typeof h.apparatus
    expect(await confirmWorkflowDelivery(native, task.taskId, run)).toBe(true)
    expect(await confirmWorkflowDelivery(native, task.taskId, run)).toBe(true)
    expect(taskStateOf(h.apparatus, task.taskId).runs[run.runId]!.consumed.map(use => use.mode)).toEqual(['delivered'])
    await readMethodContext(h.apparatus, task.taskId, run)
    expect(taskStateOf(h.apparatus, task.taskId).runs[run.runId]!.consumed.map(use => use.mode)).toEqual(['delivered', 'read'])
    expect(taskStateOf(h.apparatus, task.taskId).contract).toEqual(contract)
    await expect(createMethod(h.apparatus, { ...h.assets, workflowGuidance: 'x'.repeat(8193) })).rejects.toThrow('8192')
  } finally { await h.apparatus.store.close() }
})

it('keeps a frozen contract executable when a later method changes or removes its template', async () => {
  const h = await setup()
  try {
    const { loadMethod } = await import('../src/method.ts')
    const { submit } = await import('../src/submission.ts')
    const { acceptanceSubject } = await import('../src/review.ts')
    const { fixtureReview } = await import('./review-fixture.ts')
    const { execFor, fakeExecution } = await import('./seam.ts')
    const templates = h.assets.templates.map(raw => ({ ...raw as object, guidance: 'First revision guidance.' }))
    const incumbent = await createMethod(h.apparatus, { ...h.assets, templates })
    const source = await propose(h.apparatus, { ...h.caller, agentId: 'source', sessionId: 'source' }, 'source', { goal: 'count letters', method: incumbent })
    for (const keepTemplate of [true, false]) {
      const candidate = await createMethod(h.apparatus, { ...h.assets, templates: keepTemplate
        ? templates.map(template => ({ ...template, guidance: 'New method guidance.' })) : [] })
      const id = `candidate-${keepTemplate}`, caller = { ...h.caller, agentId: id, sessionId: id }
      const trial = await propose(h.apparatus, caller, id, { contract: source.contract, method: candidate },
        { purpose: 'evaluation', relatedTo: { taskId: source.taskId, runId: source.runId } })
      const run = taskStateOf(h.apparatus, trial.taskId).runs[trial.runId]!
      expect(trial.contract).toEqual(source.contract)
      expect((await methodContext(h.apparatus, trial.taskId, run)).guidance).toBe(keepTemplate ? 'New method guidance.' : 'First revision guidance.')
      await writeFile(join(trial.workspace, trial.contract.artifact), '35')
      const review = fixtureReview(h.apparatus)
      await expect(submit(h.apparatus, fakeExecution(() => undefined), caller, execFor(agentFor(id, id), id),
        { taskId: trial.taskId, path: trial.contract.artifact }, new AbortController().signal,
        async (taskId, run, checks) => {
          expect(checks).toHaveLength(1)
          expect((await acceptanceSubject(h.apparatus, taskId, run, checks)).contract).toEqual(source.contract)
          return review(taskId, run, checks)
        })).resolves.toMatchObject({ phase: 'verified' })
      expect((await loadMethod(h.apparatus, candidate)).assets.templates).toHaveLength(keepTemplate ? templates.length : 0)
    }
  } finally { await h.apparatus.store.close() }
})
