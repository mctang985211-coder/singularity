import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { checkObligationCoverage, findRepoRoot, loadObligationTemplates } from '@dangosys/dsh-singularity-task-runtime'
import { notActivatedLines, rootSnapshotOrUndefined, rootTaskIn } from './root-store.ts'
import { runPhaseCell } from './run-phase.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_status: missing agent id')
  return id
}

/** Soft view of the env-builder store: the graph env's path is where template discovery walks up from. */
interface EnvPathSource {
  store: { get(envId: string): { path: string } }
}

/**
 * Best-effort obligation coverage for the footer (KISS §5.1, guide §4.2 #21):
 * templates from `<repoRoot>/.agents/skills/<name>/obligations.yml` against the
 * graph's obligations and requested capabilities. Every step may be absent —
 * no env builder, no repo root within 8 levels, no template files — and an
 * absent source omits the line rather than reporting zero coverage. Uncovered
 * entries are a hint ("satisfied, or forgotten?"), never a block.
 */
async function obligationLines(ctx: Context, envId: string, snapshot: TaskSnapshot): Promise<string[]> {
  const header = snapshot.obligations.length === 0 ? [] : [`obligations: ${snapshot.obligations.length} recorded`]
  try {
    const envBuilder = (ctx.get?.('envBuilder') ?? (ctx as unknown as { envBuilder?: EnvPathSource }).envBuilder) as EnvPathSource | undefined
    const envPath = envBuilder?.store.get(envId).path
    if (envPath === undefined) return header
    const repoRoot = await findRepoRoot(envPath)
    if (repoRoot === undefined) return header
    const templates = (await loadObligationTemplates(repoRoot)).flatMap(file => file.templates)
    if (templates.length === 0) return header
    const coverage = checkObligationCoverage(templates, snapshot)
    const uncovered = coverage.uncovered.map(template => `${template.id} ("${template.question}") — satisfied, or forgotten?`)
    return [
      ...header,
      `obligation coverage: ${coverage.covered.length}/${templates.length} covered${uncovered.length === 0 ? '' : `; uncovered: ${uncovered.join('; ')}`}`,
    ]
  } catch {
    return header
  }
}

export function defineTaskStatusTool(ctx: Context) {
  return defineTool({
    name: 'task_status',
    description: 'Compact snapshot of the caller\'s graph task tree: task id, objective, status, latest run status with its coordination phase (a phase-less non-terminal run reads needs-recovery), evidence ids, and terminal review outcome. Before any root contract has been accepted it answers the named not-activated state (with whatever proposal is still open) instead of an empty tree. Also lists recorded obligations and the domain-template coverage hint.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const graph = await ctx.graphs.graphForSession(sessionId(exec))
      const storeId = rootTaskStoreId(graph.rootSessionId)
      const snapshot = await rootSnapshotOrUndefined(ctx, storeId)
      const root = rootTaskIn(snapshot)
      // The tree the root session would see does not exist yet (A0 §1.5): the
      // same named state `task_read` answers with, rather than an empty tree a
      // reader could mistake for a graph whose work is done.
      if (snapshot === undefined || root === undefined) {
        return notActivatedLines(graph.id, storeId, graph.rootSessionId, snapshot).join('\n')
      }
      const lines = snapshot.tasks.map(task => {
        const runId = task.runIds[task.runIds.length - 1]
        const run = snapshot.runs.find(item => item.runId === runId)
        const evidence = snapshot.evidence.filter(item => item.taskId === task.taskId).map(item => item.evidenceId)
        const review = [...snapshot.reviews].reverse().find(item => item.taskId === task.taskId)
        const diagnoses = snapshot.diagnoses.filter(item => item.taskId === task.taskId).length
        const runPart = run === undefined ? 'run: none' : `run: ${run.status}${runPhaseCell(run)}`
        const evidencePart = evidence.length === 0 ? '' : ` evidence: [${evidence.join(', ')}]`
        const failing = review?.criteria?.filter(item => item.verdict !== 'pass') ?? []
        const detail = review?.outcome === 'failed' && failing.length > 0
          ? `${review.localizedCause ?? 'failed'} [${failing.map(item => `${item.criterionId}${item.exitCode === undefined ? '' : ` exit ${item.exitCode}`}`).join(', ')}]`
          : review?.localizedCause ?? review?.anomalies[0]
        const reviewPart = review === undefined ? '' : ` review: ${review.outcome}${detail === undefined ? '' : ` — ${detail}`}`
        const diagPart = diagnoses === 0 ? '' : ` diag: ${diagnoses}`
        return `${'  '.repeat(task.depth)}${task.taskId} [${task.status}] ${task.objective} (${runPart}${evidencePart}${reviewPart}${diagPart})`
      })
      return [
        `graph ${graph.id} task tree (${snapshot.tasks.length} tasks):`,
        ...lines,
        ...await obligationLines(ctx, graph.envId, snapshot),
      ].join('\n')
    },
  })
}
