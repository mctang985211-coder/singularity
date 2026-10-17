import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import type { Bubble } from '../../src/task/bubble.ts'
import type { TaskTemplateRef } from '../../src/task/contract.ts'
import { projectTree, projectPlan, type TreeChildView, type TreeCriterionView } from '../../src/task/tree.ts'
import { projectReceipt, projectTask, type ReceiptView } from '../../src/task/view.ts'
import type { Apparatus } from './apparatus.ts'
import type { TaskInputSource } from '../../src/task/contract.ts'
import { STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../../src/strategy/protocol.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import { RELEASE_PROTOCOL } from '../../src/release/protocol.ts'
import { methodEnvironment, loadMethod, bindingsForContract, type MethodAssets, type MethodBindings } from './method.ts'
import type { RevisionRef } from '../../src/task/protocol.ts'
import { coordinationOf } from './coordination.ts'

export interface ControlSnapshot {
  readonly providerStopped: boolean
  readonly formatVersion: 9
  readonly geometry: Readonly<Record<string, { x: number; y: number; width: number; height: number }>>
  readonly controlId: string
  readonly cutoff: number
  readonly tasks: readonly {
    readonly taskId: string
    readonly goal: string
    readonly phase: string
    readonly sessionId: string | null
    readonly template: TaskTemplateRef | null
    readonly relatedTo: { readonly taskId: string; readonly runId: string } | null
    readonly purpose: string
    readonly closure: TaskState['closure'] | null
    readonly rsi: TaskState['rsi'] | null
    readonly requests: NonNullable<TaskState['rounds']>
    readonly bindings: MethodBindings | null
    readonly coordination: ReturnType<typeof coordinationOf>
    readonly runs: readonly {
      readonly runId: string
      readonly status: string
      readonly detail: string | null
      readonly model: Bubble['model'] | null
      readonly inputSources: readonly {
        readonly name: string
        readonly digest: string
        readonly source: TaskInputSource
        readonly producerRunId?: string
      }[]
      readonly receipt: ReceiptView | null
    }[]
  }[]
  readonly reviews: readonly ReviewRun[]
  readonly plans: readonly {
    readonly parentTaskId: string
    readonly complete: boolean
    readonly children: readonly Omit<TreeChildView, 'lastOutcome'>[]
    readonly criteria: readonly Omit<TreeCriterionView, 'supportedBy'>[]
  }[]
  readonly methods: readonly {
    readonly reference: RevisionRef
    readonly published: boolean
    readonly templates: readonly string[]
    readonly skillBytes: number
    readonly toolBytes: number
    readonly toolCount: number
  }[]
  readonly rounds: readonly {
    readonly roundId: string
    readonly plan: RoundState['plan']
    readonly submissions: RoundState['submissions']
    readonly decision: RoundState['decision'] | null
    readonly evaluations: readonly { readonly evaluationId: string
      readonly report: ReturnType<typeof projectEvaluation> }[]
  }[]
  readonly releases: readonly { readonly seq: number
    readonly kind: string
    readonly environmentId: string
    readonly payload: unknown }[]
  readonly consumption: readonly { readonly seq: number
    readonly taskId: string
    readonly runId: string
    readonly method: string
    readonly source: string
    readonly revision: RevisionRef }[]
  readonly budget: { readonly rootSolves: number; readonly childRuns: number; readonly terminalRuns: number }
}

export async function snapshotOf(apparatus: Apparatus): Promise<ControlSnapshot> {
  const committed = apparatus.store.load()
  const entries = committed.entries()
  const tasks: ControlSnapshot['tasks'][number][] = []
  const loadedMethods = new Map<string, Awaited<ReturnType<typeof loadMethod>>>()
  for (const [taskId, state] of committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)) {
    if (state.contract === undefined) continue
    const view = projectTask(state)
    const agent = state.responsibility === undefined ? undefined : committed.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, state.responsibility.agentId)
    const run = Object.values(state.runs).at(-1)
    let bindings: MethodBindings | null = null
    if (run !== undefined) {
      let method = loadedMethods.get(run.revision.digest)
      if (method === undefined) {
        method = await loadMethod(apparatus, run.revision)
        loadedMethods.set(run.revision.digest, method)
      }
      bindings = bindingsForContract(state.contract, method.assets)
    }
    tasks.push({
      closure: state.closure ?? null,
      rsi: state.rsi ?? null,
      requests: state.rounds ?? [],
      taskId, goal: state.contract.goal, phase: view.phase,
      coordination: coordinationOf(apparatus, taskId, committed),
      sessionId: agent?.sessionId ?? null, template: state.contract.template ?? null,
      relatedTo: run?.relatedTo ?? null, purpose: run?.purpose ?? 'solve',
      bindings,
      runs: view.runs.map((run) => {
        const execution = state.runs[run.runId]!
        const inputSources =
          execution.bubble?.inputs.map((input) => ({
            name: input.name,
            digest: input.digest,
            source: state.contract!.inputs.find((declared) => declared.name === input.name)!.source,
            ...(input.producerRunId === undefined ? {} : { producerRunId: input.producerRunId }),
          })) ?? []
        return { runId: run.runId, status: run.status, model: execution.bubble?.model ?? null, inputSources,
          detail: run.failureReason ?? run.verdicts.find((entry) => entry.criterionId === state.contract!.criteria[0]!.criterionId)?.detail ?? null,
          receipt: run.status === 'running' ? null : projectReceipt(apparatus.registry, entries, taskId, run.runId),
        }
      }),
    })
  }
  const reviews = [...committed.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()]
  const states = committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const plans = [
    ...projectTree(states),
    ...reviews.filter((r) => r.children.length > 0).map((r) => projectPlan(r.reviewId, r.criteria, r.children, states)),
  ].map((view) => ({
    parentTaskId: view.parentTaskId,
    complete: view.complete,
    children: view.children.map(({ lastOutcome: _, ...child }) => child),
    criteria: view.criteria.map(({ supportedBy: _, ...criterion }) => criterion),
  }))
  const ordered = tasks.sort((left, right) => left.taskId.localeCompare(right.taskId))
  const library = committed.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus),
  )
  const methods = Object.values(library?.revisions ?? {}).map((revision) => {
    const assets = revision.manifest as MethodAssets
    return { reference: { environmentId: library!.environmentId, revisionId: revision.revisionId, digest: revision.contentDigest,
      },
      published: library!.pointer === revision.revisionId,
      templates: assets.templates.map((template) => (template as { id: string }).id),
      skillBytes: Buffer.byteLength(JSON.stringify(assets.skills)), toolBytes: Buffer.byteLength(JSON.stringify(assets.tools)), toolCount: assets.tools.length,
    }
  })
  const evaluations = committed.statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION)
  const rounds = [...committed.statesOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION).values()].map((round) => ({
    roundId: round.roundId, plan: round.plan, submissions: round.submissions, decision: round.decision ?? null,
    evaluations: round.submissions.flatMap((submission) => {
      const state = evaluations.get(submission.evaluationId)
      return state === undefined ? [] : [{ evaluationId: submission.evaluationId, report: projectEvaluation(state) }]
    }),
  }))
  const releases = entries.filter((entry) => entry.protocol === RELEASE_PROTOCOL || entry.kind === 'pointer/switched')
    .map((entry) => ({ seq: entry.seq, kind: entry.kind, environmentId: entry.subject, payload: entry.payload }))
  const consumption = entries.filter((entry) => entry.kind === 'method/consumed')
    .map((entry) => {
    const use = entry.payload as { runId: string; method: string; source: string }
    const execution = committed.stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, entry.subject)!.runs[use.runId]!
      return { seq: entry.seq, taskId: entry.subject, ...use, revision: execution.revision }
  })
  const childIds = new Set(plans.flatMap((plan) => plan.children.map((child) => child.taskId)))
  const starts = entries.filter((entry) => entry.kind === 'run/started')
  const budget = { rootSolves: starts.filter((entry) => !childIds.has(entry.subject)).length,
    childRuns: starts.filter((entry) => childIds.has(entry.subject)).length,
    terminalRuns: entries.filter((entry) => ['run/verified', 'run/failed'].includes(entry.kind)).length,
  }
  const geometry: Record<string, { x: number; y: number; width: number; height: number }> = {}
  const parentOf = new Map([...plans.flatMap((plan) => plan.children.map((child) => [child.taskId, plan.parentTaskId] as const)),
    ...tasks.flatMap((task) => (task.relatedTo === null ? [] : [[task.taskId, task.relatedTo.taskId] as const])),
  ])
  const depth = (id: string): number => (parentOf.has(id) ? 1 + depth(parentOf.get(id)!) : 0)
  const rows = new Map<number, number>()
  for (const review of reviews)
    if (review.target.kind === 'acceptance') parentOf.set(review.reviewId, review.target.taskId)
  for (const task of [...ordered.map((t) => t.taskId), ...reviews.map((r) => r.reviewId)]) {
    const column = depth(task), row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    geometry[task] = { x: column * 330, y: row * 145, width: 260, height: 105 }
  }
  return { formatVersion: 9, providerStopped: false,
    reviews, geometry, controlId: apparatus.controlId, cutoff: entries.length, tasks: ordered, plans, methods, rounds, releases, consumption, budget,
  }
}
