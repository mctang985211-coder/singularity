import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import { renderRunBinding } from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type { AcceptanceCriterion, TaskInstance, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { notActivatedLines, rootSnapshotOrUndefined, rootTaskIn } from './root-store.ts'
import { runPhaseSuffix } from './run-phase.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_read: missing agent id')
  return id
}

function latestRun(snapshot: TaskSnapshot, task: TaskInstance): TaskRun | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.runs.find(run => run.runId === runId)
}

/**
 * The two contract facts a worker cannot read off the objective and the
 * criteria table: what its contract assumes and what it constrains (T1 §4) —
 * persisted with the task, so this store-backed view and the handoff-rendered
 * block say the same thing. A task created before the contract existed has
 * neither, and renders exactly what it rendered before: nothing is invented
 * for the part the store never held.
 */
function contractLines(task: TaskInstance): string[] {
  const contract = task.contract
  if (contract === undefined) return []
  return [
    ...(contract.assumptions.length === 0 ? [] : ['assumptions:', ...contract.assumptions.map(item => `- ${item}`)]),
    ...(contract.constraints.length === 0 ? [] : ['constraints:', ...contract.constraints.map(item => `- ${item}`)]),
  ]
}

/**
 * The protected acceptance inputs a criterion declares, as one suffix a worker
 * can read: the paths it must not modify. Empty for a criterion that declares
 * none — such a criterion carries no protection, and printing an empty list
 * would read like a claim that it does.
 */
function protectedInputsPart(criterion: AcceptanceCriterion): string {
  const declared = criterion.protectedInputs ?? []
  return declared.length === 0 ? '' : ` [protected inputs: ${declared.map(ref => ref.path).join(', ')}]`
}

/**
 * The run the caller is executing, as the store recorded it (S1-C item 4): the
 * providers this run was bound to, re-checked against the snapshot the record
 * names before they are shown.
 *
 * Why the re-check is not optional: the record says which bytes the run loaded,
 * and the snapshot path is the only place those bytes still exist. A snapshot
 * that is missing or edited is reported as such, naming the skill — the one
 * thing this view must never do is quietly show what stands at the production
 * skill path now, which would read as "this is what you are running".
 *
 * A run created before the field existed, or by a caller that assembled its plan
 * without a pre-check, carries no binding: then there is nothing to claim and
 * nothing is rendered, exactly as before.
 */
async function bindingLines(ctx: Context, run: TaskRun): Promise<string[]> {
  const binding = run.providerBinding
  if (binding === undefined) return []
  const read = await ctx.taskRuntime.readRunBinding(binding)
  const summary = renderRunBinding(binding, read)
  return summary.length === 0 ? [] : ['', ...summary.split('\n')]
}

export function defineTaskReadTool(ctx: Context) {
  return defineTool({
    name: 'task_read',
    description:
      'Read the caller\'s task contract. The root session sees the root task, its acceptance criteria, and child task statuses — or, before any root contract has ' +
      'been accepted, the named state saying so together with whatever proposal is still open (the graph\'s name is never shown as an objective). A worker sees its own task and run. ' +
      'A run line carries the coordination phase this run is in — and its batch id, its submission and any no-progress marking when it has them; a run with no phase ' +
      'is an old record and is shown as needs-recovery.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const caller = sessionId(exec)
      const graph = await ctx.graphs.graphForSession(caller)
      if (graph.rootSessionId !== caller) {
        const { task, run } = await ctx.taskRuntime.runForSession(caller)
        const lines = [
          `task ${task.taskId} [${task.status}] depth ${task.depth}`,
          `objective: ${task.objective}`,
          'acceptance criteria:',
          ...task.acceptanceCriteria.map(criterion => {
            const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
            return `- ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ', mandatory' : ''}] ${criterion.description}${command}${protectedInputsPart(criterion)}`
          }),
          ...contractLines(task),
          `run ${run.runId} [${run.status}]${runPhaseSuffix(run)} started ${run.startedAt}`,
          ...(await bindingLines(ctx, run)),
        ]
        return lines.join('\n')
      }

      const storeId = rootTaskStoreId(graph.rootSessionId)
      const snapshot = await rootSnapshotOrUndefined(ctx, storeId)
      const root = rootTaskIn(snapshot)
      // No root task is not a crash: before a contract is accepted the store
      // may not exist and holds nothing (A0 §1.1). The session gets the named
      // state, its open proposal and the action that changes it — never the
      // graph's name standing in for a goal nobody has stated.
      if (snapshot === undefined || root === undefined) {
        return notActivatedLines(graph.id, storeId, graph.rootSessionId, snapshot).join('\n')
      }
      const children = root.childTaskIds
        .map(taskId => snapshot.tasks.find(task => task.taskId === taskId))
        .filter(task => task !== undefined)
      const lines = [
        `root task ${root.taskId} [${root.status}/${root.decompositionStatus}]`,
        `objective: ${root.objective}`,
        'acceptance criteria:',
        ...root.acceptanceCriteria.map(criterion =>
          `- ${criterion.criterionId} [${criterion.verificationMode}] ${criterion.description}${protectedInputsPart(criterion)}`),
        `children: ${children.length}`,
        ...children.map(child => {
          const run = latestRun(snapshot, child)
          const runPart = run === undefined ? 'no run' : `run ${run.runId} [${run.status}]${runPhaseSuffix(run)}`
          return `- ${child.taskId} [${child.status}/${child.decompositionStatus}] ${runPart} ${child.objective}`
        }),
      ]
      return lines.join('\n')
    },
  })
}
