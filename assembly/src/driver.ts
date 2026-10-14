import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runIdOf, sha256 } from './ids.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { schedulerMessage } from './scheduler-message.ts'
import { workspaceOf } from './attempt.ts'
import type { BubbleWorld } from './bubble.ts'
import { inside } from './shape.ts'
import { assertRunFile } from './workspace.ts'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'

import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import type { ReceiptView, TaskView } from '../../src/task/view.ts'
import { callerOf, declareCaller, taskStateOf, openApparatus } from './apparatus.ts'
import type { Apparatus } from './apparatus.ts'
import type { Domain } from './domain.ts'
import type { Admission, Execution, TurnFailureHandler } from './execution.ts'
import { repair } from './repair.ts'
import { createScheduler, DispatchError } from './scheduler.ts'
import { snapshotOf, type ControlSnapshot } from './snapshot.ts'
import { decompose, propose, retry, status } from './surfaces.ts'
import { submit, judgeAndRecord, type AcceptanceReview, type Submission } from './submission.ts'
import { createMethod, publishedMethod, methodOfRun, seedMethod, type MethodAssets } from './method.ts'
import { consumeMethod, methodSkill, mountMethodSkills, recordMethodContext, runMethodTool, type MethodContext } from './method-run.ts'
import { loadMethod } from './method.ts'
import { assertMethodAdmitted } from './method-admission.ts'
import { proposalCostOf, type ProposalCost } from './evaluation-cost.ts'
import { acceptanceSubject, reviewSubject } from './review.ts'
import { assertImprovementOwner, startImprovement, closeImprovements } from './improvement.ts'
import { createEvolution, readEvolutionRound, type EvolutionRound } from './evolution.ts'
import { createNativeSolve } from './native-solve.ts'
import type { RoundDecision } from '../../src/strategy/view.ts'
import { releaseMethod } from './method-release.ts'
import { historyOf, type MethodHistory, type ReadTask, type TemplateDeclaration } from './read.ts'
import { createCampaignBudget, type CampaignBudget, type CampaignLimits } from './budget.ts'
import { structuralEditDetailsOf } from '../../src/strategy/edits.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { singularity: TaskService }
}
export interface TaskService {
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
  skill(agentId: string): Promise<string | undefined>
  recordContext(agentId: string): Promise<void>
  mountSkills(agent: import('@deepseek-ai/dsh-agent').Agent): Promise<void>
  world(agentId: string): BubbleWorld
  purpose(agentId: string): string
}
export interface AgentTaskSurface {
  retry(input: { readonly taskId: string }): Promise<Proposal>
  createMethod(input: { readonly path: string }): Promise<RevisionRef>
  runMethod(input: { readonly taskId: string; readonly tool: string; readonly candidate?: string }): Promise<{ program: string; artifact: string }>
  evolve(input: EvolutionRound): Promise<RoundDecision>
  history(): Promise<MethodHistory>
  decompose(input: DecomposeInput): Promise<PlanRecord>
  submit(input: { readonly taskId: string; readonly program: string }): Promise<Submission>
  status(input: { readonly taskId: string }): Promise<Status>
}
export interface PlannedChild {
  readonly key: string
  readonly template?: string
  readonly contract?: TemplateDeclaration
  readonly method?: RevisionRef
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
}
export type DecomposeInput = { readonly taskId: string; readonly children: readonly PlannedChild[]; readonly useTemplateDecomposition?: never }
  | { readonly taskId: string; readonly useTemplateDecomposition: true; readonly children?: never }
export interface PlanRecord { readonly taskId: string; readonly opened: readonly string[] }
export interface Proposal {
  readonly taskId: string
  readonly runId: string
  readonly workspace: string
  readonly criterionId: string
  readonly phase: TaskView['phase']
  readonly submission: 'program' | 'source'
  readonly input: string
  readonly artifact: string
  readonly inputContent: string
  readonly initialSource: string | null
  readonly rootTemplate: string
  readonly templates: readonly TemplateDeclaration[]
  readonly methodContext: MethodContext | null
}
export interface Status {
  readonly phase: TaskView['phase']
  readonly runs: number
  readonly receipt: ReceiptView | null
  readonly task: ReadTask
}
export interface DriverOptions {
  readonly budget?: CampaignLimits
  readonly attachments: Apparatus['attachments']
  readonly controlId: string
  readonly workspaceRoot: string
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
  readonly execution: (admission: Admission, onTurnFailure: TurnFailureHandler) => Execution
}
export interface TaskDriver extends TaskService {
  readonly budget?: CampaignBudget
  enter(agent: Agent, messages: readonly UserMessage[], model: { provider: string; model: string }): Promise<UserMessage | undefined>
  activate(sessionId: string): Promise<void>
  close(): Promise<void>
}

export async function openDriver(options: DriverOptions): Promise<TaskDriver> {
  const apparatus = await openApparatus(options.controlId, options.workspaceRoot, options.domain, options.persistence, options.attachments)
  if (options.budget !== undefined) {
    apparatus.budget = createCampaignBudget(apparatus, options.budget)
    await apparatus.budget.restore()
  }
  const admission: Admission = exec => {
    if (exec.agent === undefined || exec.name.startsWith('singularity_')) return undefined
    if (['read', 'read_image', 'glob', 'grep', 'send_message', 'list_agents', 'interrupt_agent'].includes(exec.name)) return undefined
    const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
    const owned = [...tasks.values()].filter(task => task.responsibility?.agentId === exec.agent!.id)
    const active = owned.flatMap(task => Object.values(task.runs).filter(run => run.status === 'running'))
    if (active.some(run => run.stage !== 'working'))
      return 'this Run has closed write admission'
    return undefined
  }
  const active = new Set<Promise<unknown>>()
  const lifecycleErrors = new Set<unknown>()
  const controller = new AbortController()
  let closing: Promise<void> | undefined
  const work = <T>(step: () => Promise<T>): Promise<T> => {
    if (closing !== undefined) refuse('illegal-transition', 'the driver is closing')
    const pending = step()
    active.add(pending)
    void pending.then(() => active.delete(pending), () => active.delete(pending))
    return pending
  }
  const scheduler = createScheduler(apparatus, options.seams)
  const purposeOf = (run: import('../../src/task/protocol.ts').RunState): string =>
    (apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!
      .revisions[run.revision.revisionId]!.manifest as { purpose: string }).purpose
  const acceptanceFor = (agent: Agent, signal: AbortSignal): AcceptanceReview => async (taskId, run, judgement) => {
    if (purposeOf(run) === 'review') return undefined
    return reviewSubject(apparatus, options.seams, agent, `accept:${taskId}/${run.runId}`,
      await acceptanceSubject(apparatus, taskId, run, judgement), signal, undefined, false)
  }
  const restoreJudgement = async (taskId: string, run: import('../../src/task/protocol.ts').RunState): Promise<boolean> => {
    const registry = (options.seams.get === undefined ? options.seams.agents : options.seams.get('agents')) as AgentRegistry | undefined
    const parent = registry?.get(SessionId(taskStateOf(apparatus, taskId).responsibility!.agentId))
    if (purposeOf(run) !== 'review' && parent === undefined) return false
    await judgeAndRecord(apparatus, taskId, run, controller.signal, parent === undefined ? undefined : acceptanceFor(parent, controller.signal))
    return true
  }
  const parentPlanOf = (taskId: string): string | undefined =>
    [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .find(task => task.decomposition?.children.some(child => child.taskId === taskId))?.taskId
  const execution = options.execution(admission, failure =>
    work(async () => {
      const cut = apparatus.store.load()
      const owners = [...cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION).values()]
        .filter(agent => agent.sessionId === failure.sessionId).map(agent => agent.agentId)
      for (const task of cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) {
        const agentId = task.responsibility?.agentId
        if (agentId === undefined || !owners.includes(agentId)) continue
        for (const run of Object.values(task.runs)) {
          if (run.status !== 'running' || run.stage !== 'working') continue
          await apparatus.tasks.forAgent(agentId).failRun({
            commandId: `turn-failed:${failure.sessionId}/${failure.seq}/${run.runId}`, taskId: task.taskId, runId: run.runId,
            reason: 'session-turn-failed: ' + JSON.stringify(failure),
          })
          const parentTaskId = parentPlanOf(task.taskId)
          if (parentTaskId !== undefined) void work(() => scheduler.advance(parentTaskId)).catch(error => lifecycleErrors.add(error))
        }
      }
    }).catch(error => { lifecycleErrors.add(error); throw error }))
  try { await seedMethod(apparatus); await repair(apparatus, restoreJudgement) } catch (error) {
    const cleanup = await Promise.allSettled([execution.close(), apparatus.store.close()])
    throw new AggregateError([error, ...cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : [])], 'driver recovery failed')
  }
  return {
    ...(apparatus.budget === undefined ? {} : { budget: apparatus.budget }),
    enter: (agent, messages, model) => work(async () => {
      const agentId = String(agent.id)
      const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
      if ([...tasks.values()].some(task => task.responsibility?.agentId === agentId)) return undefined
      let human = messages.findLast(message => message.source.kind === 'user')
      if (human === undefined) {
        const handle = await apparatus.persistence.open(agent.session.id, 'read')
        try {
          const events = (await handle.read()).events
          for (const event of [...events].reverse()) {
            if (event.type === 'user/message' && event.data.source.kind === 'user') { human = event.data; break }
          }
        } finally { await handle.close() }
      }
      if (human === undefined) return undefined
      const operationId = `human:${human.id}`
      if (apparatus.store.committedOf(`start:${runIdOf(apparatus.controlId, agentId, operationId)}`) !== undefined) return undefined
      const goal = human.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (goal.length === 0) refuse('malformed-declaration', 'a domain request requires a natural-language goal and acceptance requirements')
      const proposal = await propose(apparatus, { agentId, sessionId: agentId, model }, operationId, { goal })
      return schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
        parentTaskId: proposal.taskId, taskId: proposal.taskId, runId: proposal.runId,
        factSeq: apparatus.store.committedOf(`start:${proposal.runId}`)!.seq }, JSON.stringify({
        assigned: proposal, priorExploration: join(apparatus.workspaceRoot, 'agents', sha256(agentId)),
      }))
    }),
    activate: sessionId => work(async () => {
      await mkdir(join(apparatus.workspaceRoot, 'agents', sha256(sessionId)), { recursive: true })
      await repair(apparatus, restoreJudgement, sessionId)
      const cut = apparatus.store.load()
      for (const holder of cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION).values())
        if (holder.sessionId === sessionId) declareCaller(apparatus, holder.agentId)
      for (const task of cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) {
        if (task.decomposition === undefined || task.responsibility === undefined) continue
        const holder = cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility.agentId)
        if (holder?.sessionId === sessionId) await scheduler.advance(task.taskId)
      }
      const registry = (options.seams.get === undefined ? options.seams.agents : options.seams.get('agents')) as AgentRegistry
      const agent = registry.get(SessionId(sessionId))!
      for (const task of apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) {
        if (task.responsibility?.agentId !== sessionId || parentPlanOf(task.taskId) !== undefined) continue
        const run = Object.values(task.runs).at(-1)
        if (run?.status !== 'verified' || purposeOf(run) !== 'solve') continue
        if (publishedMethod(apparatus) === undefined)
          await releaseMethod(apparatus, options.seams, agent, `seed:${task.taskId}/${run.runId}`, { bootstrap: methodOfRun(apparatus, run)! }, controller.signal)
        await startImprovement(apparatus, options.seams, agent, task.taskId, run.runId, controller.signal)
      }
    }),
    forCall: exec => {
      const agent = execution.assertCaller(exec)
      const caller = callerOf(agent)
      const signal = AbortSignal.any([controller.signal, exec.signal])
      const criterion = apparatus.domain.templates.get(apparatus.domain.rootTemplate)!.criterion
      const measurement = apparatus.domain.measurement
      let proposalCost: ProposalCost | undefined
      const freezeAssets = async (input: MethodAssets, operationId = String(exec.callId)): Promise<RevisionRef> => {
        const owner = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
          .findLast(task => task.responsibility?.agentId === caller.agentId)!
        const ownerRun = Object.values(owner.runs).at(-1)!
        const basis = methodOfRun(apparatus, ownerRun)!
        const changes = structuralEditDetailsOf((await loadMethod(apparatus, basis)).assets, input)
        const revision = await createMethod(apparatus, input)
        await reviewSubject(apparatus, options.seams, agent, `${operationId}:asset-review`, {
          purpose: 'asset-admission',
          taskId: owner.taskId, runId: ownerRun.runId,
          requirements: 'Judge whether these exact assets are safe and usable for exploration and independent evaluation: preserve protected inputs and acceptance, review programs and bindings, and assess the proposed method against its evidence. Measurement and publication follow admission; do not require candidate evaluation or a measured winner at this stage.',
          revision, basis, changes, assets: input }, signal)
        return revision
      }
      const evolution = createEvolution({ store: apparatus.store, registry: apparatus.registry,
        criterion, metric: { measured: measurement?.criterion ?? { ...criterion, criterionId: `${criterion.criterionId}:quality` },
          unit: measurement === undefined ? 'pass' : 'baseline area ratio', direction: measurement?.direction ?? 'higher' },
        trials: 1, weights: measurement === undefined ? { quality: 1, cost: 1 } : { quality: 100, cost: 15 },
        calibration: { floor: measurement === undefined ? 0 : 0.01, source: 'declared' },
        loadMethod: async revision => (await loadMethod(apparatus, revision)).assets,
        solve: input => createNativeSolve(apparatus, options.seams, agent, signal, measurement === undefined ? undefined
          : { digest: measurement.criterion.implementationDigest, measure: (source, signal) => measurement.measure(source, signal) }, proposalCost)(input) })
      return {
        retry: input => work(() => retry(apparatus, caller, String(exec.callId), input)),
        createMethod: input => work(async () => {
          const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
            .findLast(task => task.responsibility?.agentId === caller.agentId)
          const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
          if (run?.status !== 'running' || run.stage !== 'working') refuse('illegal-transition', 'asset submission requires a working Task/Run')
          const workspace = workspaceOf(apparatus, task!.taskId, run.runId)
          const path = inside(workspace, input.path, 'Revision path')
          await assertRunFile(workspace, input.path)
          return freezeAssets(JSON.parse(await readFile(path, 'utf8')))
        }),
        runMethod: input => work(() => runMethodTool(apparatus, caller, input.taskId, String(exec.callId), AbortSignal.any([controller.signal, exec.signal]), input.tool, input.candidate)),
        evolve: input => work(async () => {
          assertImprovementOwner(apparatus, caller.agentId)
          input = readEvolutionRound(input)
          for (const revision of [input.incumbent, ...input.candidates]) assertMethodAdmitted(apparatus, revision)
          const held = [`${input.roundId}:bootstrap:evaluation`, ...input.candidates.map((_, slot) => `${input.roundId}:${slot}:candidate:evaluation`)]
            .map(id => apparatus.store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, id)?.observed[0]?.detail)
            .find(detail => detail !== undefined)
          const frozen = held === undefined ? undefined : (JSON.parse(held) as { costBasis: { proposal: ProposalCost } }).costBasis.proposal
          if (frozen !== undefined && (frozen.sessionId !== String(agent.session.id) || frozen.candidates.join('\0') !== input.candidates.map(revision => revision.digest).join('\0')))
            refuse('command-conflict', 'evaluation request differs from the frozen proposal batch')
          proposalCost = await proposalCostOf(apparatus, String(agent.session.id), input.candidates.map(revision => revision.digest), frozen)
          const decision = await evolution.runRound(input)
          if (decision.winner !== null) await releaseMethod(apparatus, options.seams, agent, `round:${input.roundId}:auto-release`, { roundId: input.roundId }, signal)
          return decision
        }),
        history: () => work(async () => {
          const history = await historyOf(apparatus, evolution.history(), caller.agentId)
          const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
            .findLast(task => task.responsibility?.agentId === caller.agentId)!
          const run = Object.values(task.runs).at(-1)!
          if (run.status === 'running' && run.stage === 'working')
            await consumeMethod(apparatus, task.taskId, run, 'history:assets', 'history:assets')
          return history
        }),
        decompose: input => work(async () => {
          if (input.useTemplateDecomposition !== undefined) return decompose(apparatus, scheduler, caller, input)
          const task = taskStateOf(apparatus, input.taskId)
          if (task.responsibility?.agentId !== caller.agentId) refuse('not-responsible', 'the caller is not responsible for this Task')
          const run = Object.values(task.runs).findLast(run => run.status === 'running' && run.stage === 'working')
          if (run === undefined) refuse('illegal-transition', 'only a working parent Run may delegate')
          if (!Array.isArray(input.children)) refuse('malformed-declaration', 'children must be a complete plan')
          const groups = new Map<string, { revision: RevisionRef; contracts: TemplateDeclaration[] }>()
          for (const child of input.children) {
            if (child.method !== undefined) assertMethodAdmitted(apparatus, child.method)
            if (child.contract === undefined) continue
            if (child.template !== undefined) refuse('malformed-declaration', 'child selects either a template or a free contract')
            const revision = child.method ?? methodOfRun(apparatus, run)!
            const group: { revision: RevisionRef; contracts: TemplateDeclaration[] } = groups.get(revision.digest) ?? { revision, contracts: [] }
            if (group.contracts.some(contract => contract.id === child.contract!.id)) refuse('malformed-declaration', 'free task batch repeats a template id')
            group.contracts.push(child.contract)
            groups.set(revision.digest, group)
          }
          const admitted = new Map<string, RevisionRef>()
          for (const [digest, group] of groups) {
            const assets = (await loadMethod(apparatus, group.revision)).assets
            admitted.set(digest, await freezeAssets({ ...assets,
              templates: [...assets.templates.filter(raw => !group.contracts.some(contract => contract.id === (raw as { id: string }).id)), ...group.contracts] },
              `${String(exec.callId)}:contracts:${digest}`))
          }
          const children = input.children.map(child => {
            if (child.contract === undefined) return child
            const { contract, ...declaration } = child
            return { ...declaration, template: contract.id, method: admitted.get((child.method ?? methodOfRun(apparatus, run)!).digest)! }
          })
          return decompose(apparatus, scheduler, caller, { ...input, children })
        }),
        submit: input => work(async () => {
          if (lifecycleErrors.size > 0) throw new AggregateError([...lifecycleErrors], 'native lifecycle failed')
          const cutoff = apparatus.store.load().entries().length
          let answer: Submission
          try { answer = await submit(apparatus, execution, caller, exec, input, signal, acceptanceFor(agent, signal)) }
          catch (error) {
            const failed = apparatus.store.load().entries().slice(cutoff).some(fact => fact.subject === input.taskId && fact.kind === TASK_KINDS.runFailed)
            const parentTaskId = parentPlanOf(input.taskId)
            if (failed && parentTaskId !== undefined) try { await scheduler.advance(parentTaskId) }
            catch (dispatch) { throw new AggregateError([error, dispatch], 'submission and parent notification failed') }
            throw error
          }
          const terminal = apparatus.store.load().entries().slice(cutoff).some(fact => fact.subject === answer.taskId &&
            (fact.kind === TASK_KINDS.runVerified || fact.kind === TASK_KINDS.runFailed) && (fact.payload as { runId: string }).runId === answer.runId)
          const parentTaskId = parentPlanOf(answer.taskId)
          if (terminal && parentTaskId !== undefined) try { await scheduler.advance(parentTaskId) } catch (error) {
            return { ...answer, dispatchError: { parentTaskId, taskId: error instanceof DispatchError ? error.taskId : answer.taskId,
              runId: error instanceof DispatchError ? error.runId : answer.runId, detail: error instanceof Error ? error.message : String(error) } }
          }
          if (answer.verdict === 'pass' && parentTaskId === undefined) {
            const run = taskStateOf(apparatus, answer.taskId).runs[answer.runId]!
            if (purposeOf(run) === 'solve') {
              if (publishedMethod(apparatus) === undefined)
                await releaseMethod(apparatus, options.seams, agent, `seed:${answer.taskId}/${answer.runId}`, { bootstrap: methodOfRun(apparatus, run)! }, signal)
              await startImprovement(apparatus, options.seams, agent, answer.taskId, answer.runId, signal)
            }
          }
          return answer
        }),
        status: input => status(apparatus, caller, input),
      }
    },
    read: () => snapshotOf(apparatus),
    purpose: agentId => {
      const owned = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
        .filter(task => task.responsibility?.agentId === agentId)
      const task = owned.find(task => Object.values(task.runs).some(run => run.status === 'running')) ?? owned.at(-1)
      const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
      return run === undefined ? 'solve' : purposeOf(run)
    },
    mountSkills: agent => mountMethodSkills(apparatus, agent),
    world: agentId => {
      const owned = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
        .filter(task => task.responsibility?.agentId === agentId)
      const task = owned.find(task => Object.values(task.runs).some(run => run.status === 'running')) ?? owned.at(-1)
      const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
      return { root: run === undefined ? join(apparatus.workspaceRoot, 'agents', sha256(agentId)) : workspaceOf(apparatus, task!.taskId, run.runId),
        writable: run === undefined || (run.status === 'running' && run.stage === 'working'),
        protected: run === undefined ? [] : run.bubble!.inputs.map(input => join(run.bubble!.workspace.ref, input.name)),
        references: [apparatus.domain.dir, ...apparatus.domain.references,
          ...(run === undefined ? [] : [join(apparatus.workspaceRoot, 'agents', sha256(agentId))]),
          ...((run === undefined || methodOfRun(apparatus, run) === undefined) ? [] : [join(apparatus.workspaceRoot, 'assets', methodOfRun(apparatus, run)!.digest)])] }
    },
    skill: agentId => work(() => methodSkill(apparatus, agentId)),
    recordContext: agentId => work(() => recordMethodContext(apparatus, agentId)),
    close: () => closing ??= (async () => {
      controller.abort(new Error('the driver is unloading'))
      const failed: unknown[] = []
      try { await execution.close() } catch (error) { failed.push(error) }
      const pending = await Promise.allSettled([...active])
      failed.push(...pending.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
      failed.push(...lifecycleErrors)
      try { await closeImprovements(apparatus) } catch (error) { failed.push(error) }
      try { await scheduler.close() } catch (error) { failed.push(error) }
      try { await apparatus.store.close() } catch (error) { failed.push(error) }
      if (failed.length > 0) throw new AggregateError(failed, 'driver unload failed')
    })(),
  }
}
