/** Catalog authority is present in real provider requests before a child proposal is generated. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assembleContextFor } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import type { TaskTemplate } from '../../task/src/index.ts'
import { registerTaskTemplate } from '../../task-runtime/src/task-template.ts'
import { reviewerBindingSource, readReviewerDelegation } from '../../agent-singularity/src/coordination/ledger.ts'
import { startSupervisorHandoff } from '../../agent-singularity/src/coordination/evolution-handoff.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop } from '../support/scripted-loop.ts'

const directories: string[] = []
afterEach(async () => {
  await disposeScriptedLoops()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const ROOT = 's-root'
function template(id: string, catalogPath: string[], objective = id): TaskTemplate {
  return {
    id, version: 1, catalogPath, appliesTo: [`Use when ${objective} is relevant.`],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: {
      objective, requiredCapabilities: ['execute-task'],
      acceptanceCriteria: [{ description: 'authoritative project check passes', command: 'true' }],
    },
  }
}
function texts(h: ScriptedLoop, sessionId: string, index = 0): string {
  return h.requestsOf(sessionId)[index]!.texts.join('\n')
}

describe('Task template catalog in the model request', () => {
  it('gives the pre-intake root category summaries derived from the library, without dumping complete templates', async () => {
    const h = await startScriptedLoop({ script: () => [{ text: 'ready to select a category' }] })
    await h.runtime.registerTaskTemplate(template('accelerator-check', ['hardware', 'buckyball'], 'hardware-private-body'))
    await h.runtime.registerTaskTemplate(template('typescript-check', ['software', 'typescript'], 'software-private-body'))
    await h.runtime.registerTaskTemplate(template('general-check', ['general']))
    h.userSays('verify an accelerator')
    await h.agent(ROOT).whenIdle()
    const request = texts(h, ROOT)
    expect(request).toContain('# Visible Task templates')
    expect(request).toContain('"catalogPath":["hardware"]')
    expect(request).toContain('"catalogPath":["software"]')
    expect(request).not.toContain('hardware-private-body')
    expect(request).not.toContain('software-private-body')
    expect(h.calls).toHaveLength(0)
  })

  it('reads only the chosen scope and general summaries before the root and child can generate their next children', async () => {
    let h!: ScriptedLoop
    let reference!: Awaited<ReturnType<typeof registerTaskTemplate>>
    h = await startScriptedLoop({
      script: sessionId => sessionId === ROOT ? [
        { tool: 'task_decompose', args: () => ({
          reason: 'run the accelerator project check', children: [{ templateRef: reference, templateParameters: {}, templateScope: [['hardware', 'buckyball']] }],
        }) },
        { waitFor: async () => {
          await vi.waitFor(async () => expect((await h.runForSession(ROOT)).run.executionPhase).toBe('active'), { timeout: 10_000 })
        } },
        { tool: 'task_submit_result', args: { summary: 'project acceptance passed' } },
        { text: 'done' },
      ] : [
        { tool: 'task_submit_result', args: { summary: 'authoritative child check is ready' } }, { text: 'done' },
      ],
    })
    reference = await h.runtime.registerTaskTemplate(template('accelerator-check', ['hardware', 'buckyball']))
    await h.runtime.registerTaskTemplate(template('typescript-check', ['software', 'typescript'], 'unrelated-domain-marker'))
    await h.runtime.registerTaskTemplate(template('general-check', ['general']))
    const root = await h.begin({
      objective: 'verify accelerator output', templateScope: [['hardware']], requiredCapabilities: ['execute-task'],
      acceptanceCriteria: [{ description: 'project check passes', command: 'true' }],
    })
    await vi.waitFor(async () => expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified'), { timeout: 15_000 })
    expect(h.calls.find(call => call.name === 'task_decompose')?.result?.isError).toBe(false)
    const child = h.spawns.find(spawn => spawn.name === 'accelerator-check')!
    expect(child).toBeDefined()
    for (const sessionId of [ROOT, child.sessionId]) {
      const request = texts(h, sessionId)
      expect(request).toContain('# Visible Task templates')
      expect(request).toContain('accelerator-check')
      expect(request).toContain('general-check')
      expect(request).not.toContain('typescript-check')
      expect(request).not.toContain('unrelated-domain-marker')
    }
    expect(texts(h, ROOT)).toContain('"templateScope":[["hardware"]]')
    expect(texts(h, child.sessionId)).toContain('"templateScope":[["hardware","buckyball"]]')
  })

  it('makes the empty-library case explicit and names unreadable libraries before any provider request', async () => {
    const h = await startScriptedLoop({ script: () => [{ text: 'ready' }] })
    h.userSays('begin with a complete standard contract')
    await h.agent(ROOT).whenIdle()
    expect(texts(h, ROOT)).toContain('No matching Task template. A complete standard contract is allowed.')
    const before = h.requestsOf(ROOT).length
    mkdirSync(h.runtime.config.taskTemplatesRoot!, { recursive: true })
    writeFileSync(join(h.runtime.config.taskTemplatesRoot!, 'broken@1.json'), '{')
    await expect(h.ctx.systemPrompt.assemble(assembleContextFor(h.agent(ROOT)))).rejects.toMatchObject({
      name: 'AssemblyRefusalError', refusal: 'unreadable', message: expect.stringContaining('task-template-catalog-unreadable'),
    })
    expect(h.requestsOf(ROOT)).toHaveLength(before)
    expect(h.calls).toHaveLength(0)
  })

  it('keeps replay request scope and the persisted frozen library when process bindings are absent', async () => {
    const h = await startScriptedLoop({ script: () => [
      { tool: 'task_submit_result', args: { summary: 'the original acceptance is ready' } }, { text: 'done' },
    ] })
    await h.runtime.registerTaskTemplate(template('accelerator-check', ['hardware'], 'production-before-freeze'))
    const root = await h.begin({
      objective: 'verify accelerator output', templateScope: [['hardware']], requiredCapabilities: ['execute-task'],
      acceptanceCriteria: [{ description: 'project check passes', command: 'true' }],
    })
    await vi.waitFor(async () => expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified'), { timeout: 10_000 })
    const frozen = join(h.workspace, 'frozen-templates')
    await registerTaskTemplate(frozen, template('accelerator-check', ['hardware'], 'frozen-library-marker'))
    await h.runtime.registerTaskTemplate({ ...template('accelerator-check', ['hardware'], 'production-after-freeze'), version: 2 })
    const workspace = join(h.workspace, 'replay')
    mkdirSync(workspace)
    const replay = await h.runtime.replayTask(root.storeId, root.taskId, {
      lineage: 'scoped replay', overlay: { taskTemplatesRoot: frozen }, workspace: { path: workspace },
    }, ROOT)
    const snapshot = await h.snapshot(root.storeId)
    const run = snapshot.runs.find(item => item.runId === replay.runId)!
    expect(snapshot.tasks.find(item => item.taskId === run.taskId)?.contract?.templateScope).toEqual([['hardware']])
    expect(run.taskTemplatesRoot).toBe(frozen)
    const request = texts(h, run.sessionId)
    expect(request).toContain('frozen-library-marker')
    expect(request).not.toContain('production-after-freeze')
    h.runtime.sessions.delete(run.sessionId)
    h.runtime.sessionExecutionBindings.delete(run.sessionId)
    const page = await h.runtime.listTaskTemplates({}, run.sessionId)
    expect(JSON.stringify(page)).toContain('frozen-library-marker')
    expect(JSON.stringify(page)).not.toContain('production-after-freeze')
    expect(await h.snapshot(root.storeId)).toEqual(snapshot)
    const secondWorkspace = join(h.workspace, 'replay-again')
    mkdirSync(secondWorkspace)
    const second = await h.runtime.replayTask(root.storeId, run.taskId, {
      lineage: 'inherit frozen replay', workspace: { path: secondWorkspace },
    }, ROOT)
    const secondRun = (await h.snapshot(root.storeId)).runs.find(item => item.runId === second.runId)!
    expect(secondRun.taskTemplatesRoot).toBe(frozen)
    expect(texts(h, secondRun.sessionId)).toContain('frozen-library-marker')
    expect(texts(h, secondRun.sessionId)).not.toContain('production-after-freeze')
  })

  it('lets a delegated supervisor without a business Run read scoped summaries and the exact template to prepare a Task improvement', async () => {
    const ledger = mkdtempSync(join(tmpdir(), 'supervisor-template-')); directories.push(ledger)
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      evolution: { ledgerRoot: ledger }, supervision: { autoReview: 'off' },
      script: sessionId => sessionId === ROOT ? [
        { tool: 'task_submit_result', args: { summary: 'the original check passes' } }, { text: 'done' },
      ] : [
        { tool: 'task_template_list' },
        { tool: 'task_template_list', args: calls => {
          const page = JSON.parse(calls.filter(call => call.sessionId === sessionId && call.name === 'task_template_list').at(-1)!.result!.text)
          return { templateRef: page.entries.find((item: { kind: string; templateRef?: { id: string } }) => item.kind === 'template' && item.templateRef?.id === 'accelerator-check').templateRef }
        } },
        { tool: 'evolution_propose', args: { proposalId: 'p-supervised-template', targetType: 'task_definition', targetId: 'accelerator-check', baseVersion: '1', level: 'L2', rationale: 'make applicability more precise', sourceRefs: ['diagnosis:d-supervised-template'] } },
        { tool: 'evolution_candidate', args: calls => {
          const exact = JSON.parse(calls.filter(call => call.sessionId === sessionId && call.name === 'task_template_list').at(-1)!.result!.text)
          return { proposalId: 'p-supervised-template', versionSet: { 'accelerator-check': '2' }, mutationJson: JSON.stringify({ template: {
            ...exact.template, version: 2, appliesTo: ['Use for accelerator acceptance with an authoritative checker.'],
          } }) }
        } },
        { tool: 'evolution_prepare', args: { proposalId: 'p-supervised-template' } },
        { text: '{"status":"closed","reason":"candidate is prepared for comparison"}' },
      ],
    })
    h.ctx.singularityContext.registerReviewerBindingSource(reviewerBindingSource())
    await h.runtime.registerTaskTemplate(template('accelerator-check', ['hardware', 'buckyball']))
    const foreign = await h.runtime.registerTaskTemplate(template('typescript-check', ['software', 'typescript']))
    await h.runtime.registerTaskTemplate(template('general-check', ['general']))
    const root = await h.begin({ objective: 'verify accelerator output', templateScope: [['hardware']], requiredCapabilities: ['execute-task'], acceptanceCriteria: [{ description: 'project check passes', command: 'true' }] })
    await vi.waitFor(async () => expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified'), { timeout: 10_000 })
    await h.task.recordDiagnosisIn(root.storeId, { diagnosisId: 'd-supervised-template', taskId: root.taskId, observedFailure: 'reusable applicability is imprecise', scope: 'task template', localizedCause: 'appliesTo lacks its authoritative checker condition', evidenceRefs: [], reviewRefs: [`${root.taskId}#${root.runId}`], confidence: 'high', proposals: [{ targetType: 'task_definition', targetId: 'accelerator-check', rationale: 'make applicability precise' }] }, ROOT)
    const diagnosis = (await h.snapshot(root.storeId)).diagnoses.find(item => item.diagnosisId === 'd-supervised-template')!
    const spawned = await startSupervisorHandoff(h.ctx, { storeId: root.storeId, diagnosis, delegator: { sessionId: ROOT, agent: h.agent(ROOT) }, sourceRef: `${root.taskId}#${root.runId}`, sourceOutcome: 'verified' })
    if (spawned.result !== 'started') throw new Error(JSON.stringify(spawned))
    await h.agent(spawned.sessionId).whenIdle()
    expect((await h.snapshot(root.storeId)).runs.some(run => run.sessionId === spawned.sessionId)).toBe(false)
    expect(await readReviewerDelegation(spawned.sessionId)).toMatchObject({ rootStoreId: root.storeId, taskId: root.taskId })
    const lookup = h.calls.filter(call => call.sessionId === spawned.sessionId && call.name === 'task_template_list')
    expect(lookup).toHaveLength(2)
    expect(lookup[0]!.result!.text).toContain('accelerator-check')
    expect(lookup[0]!.result!.text).toContain('general-check')
    expect(lookup[0]!.result!.text).not.toContain('typescript-check')
    expect(JSON.parse(lookup[1]!.result!.text).template.contract.acceptanceCriteria[0].command).toBe('true')
    expect((await h.ctx.evolution.get('p-supervised-template')).status, JSON.stringify(h.calls)).toBe('prepared')
    await expect(h.runtime.listTaskTemplates({ templateRef: foreign }, spawned.sessionId)).rejects.toThrow(/outside/)
  })
})
