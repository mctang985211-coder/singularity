import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { workspaceOf } from './attempt.ts'
import { methodForRun, methodToolReferences, type MethodBindings, type MethodSkill } from './method.ts'
import { assertActive, coordinationOf, parentPlan } from './coordination.ts'
import type { RevisionRef } from '../../src/task/protocol.ts'
import type { TaskTemplate } from './template.ts'
import { templateOf } from './domain.ts'
import { spawnProcess } from './process.ts'
import { assertRunFile } from './workspace.ts'

export async function consumeMethod(apparatus: Apparatus, taskId: string, run: RunState, asset: string, source: string,
): Promise<void> {
  if (taskStateOf(apparatus, taskId).runs[run.runId]!.consumed.some((entry) => entry.method === asset)) return
  await apparatus.tasks.recordConsumption({ commandId: `consume:${taskId}/${run.runId}/${asset}`, taskId,
    runId: run.runId, revision: run.revision, method: asset, source: `${run.revision.digest}/${source}`,
  })
}
function workingFor(apparatus: Apparatus, agentId: string) {
  const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .findLast((task) => task.responsibility?.agentId === agentId)
  const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
  return task !== undefined && run?.status === 'running' && run.stage === 'working' ? [{ task, run }] : []
}
async function skillsFor(apparatus: Apparatus, agentId: string) {
  const selections = await Promise.all(workingFor(apparatus, agentId).map(async ({ task, run }) => {
    const { reference, assets, bindings } = await methodForRun(apparatus, run)
    return assets.skills.filter((skill) => bindings.skills.some((binding) => binding.name === skill.name))
      .map((skill) => ({ taskId: task.taskId, run, reference, skill }))
  }))
  return selections.flat()
}
export interface MethodContext {
  readonly method: RevisionRef
  readonly template: { readonly id: string; readonly digest: string } | null
  readonly guidance: string
  readonly applicability?: string
  readonly decomposition?: TaskTemplate['decomposition']
  readonly bindings: MethodBindings
  readonly boundSkills: readonly (MethodSkill & { readonly digest: string })[]
  readonly references: readonly string[]
  readonly measurement?: {
    readonly module: string
    readonly baseline: number
    readonly unit: string
    readonly direction: 'higher' | 'lower'
    readonly conditions: readonly string[] }
}
export async function methodContext(apparatus: Apparatus, taskId: string, run: RunState): Promise<MethodContext> {
  const { reference, assets, domain, bindings } = await methodForRun(apparatus, run)
  const contract = taskStateOf(apparatus, taskId).contract!
  const template = contract.template === undefined ? undefined : templateOf(domain, contract.template)
  const boundSkills = bindings.skills.map((binding) => {
    const skill = assets.skills.find((skill) => skill.name === binding.name)
    if (skill === undefined || digestOf(skill) !== binding.digest) refuse('digest-mismatch', 'bound Skill differs from the pinned Revision')
    return { ...skill, digest: binding.digest }
  })
  return { method: reference, template: template === undefined ? null : { id: template.id, digest: template.digest }, guidance: template?.goal ?? contract.goal,
    ...(template?.applicability === undefined ? {} : { applicability: template?.applicability }),
    ...(template?.decomposition === undefined ? {} : { decomposition: template?.decomposition }), bindings, boundSkills,
    references: [domain.dir, ...domain.references, ...methodToolReferences(apparatus, run)],
    ...(domain.measurement === undefined ? {} : { measurement: { module: domain.measurement.module,
      baseline: domain.measurement.baseline, unit: domain.measurement.unit, direction: domain.measurement.direction,
      conditions: domain.measurement.conditions,
          },
        }),
  }
}
export async function recordMethodContext(apparatus: Apparatus, agentId: string): Promise<void> {
  for (const { task, run } of workingFor(apparatus, agentId)) {
    const context = await methodContext(apparatus, task.taskId, run)
    if (context.template !== null)
      await consumeMethod(apparatus, task.taskId, run, `guidance:${context.template.id}`, `context:${context.template.id}:${context.template.digest}`,
      )
    for (const skill of context.boundSkills)
      await consumeMethod(apparatus, task.taskId, run, `skill:${skill.name}`, `context:skill:${skill.name}:${skill.digest}`,
      )
  }
}
export async function methodSkill(apparatus: Apparatus, agentId: string): Promise<string | undefined> {
  const tasks = await Promise.all(workingFor(apparatus, agentId).map(async ({ task, run }) => {
      return { taskId: task.taskId, runId: run.runId, contract: task.contract,
      workspace: workspaceOf(apparatus, task.taskId, run.runId),
        artifact: task.contract!.artifact,
        coordination: coordinationOf(apparatus, task.taskId),
        parent: parentPlan(apparatus, task.taskId) ?? null,
        ...(await methodContext(apparatus, task.taskId, run)),
      }
    }),
  )
  return tasks.length === 0 ? undefined : JSON.stringify({ assigned: tasks })
}
export async function mountMethodSkills(apparatus: Apparatus, agent: Agent): Promise<void> {
  const ctx = agent.ctx
  const skills = ctx.get('skills') as import('@deepseek-ai/dsh-skill').SkillRegistry
  await ctx.plugin({ name: 'singularity-revision-skills', apply: (scope: typeof ctx) => {
    const provider = `singularity-${agent.id}`
    scope.effect(() => skills.registerProvider(() => ({ name: provider,
      list: async () => ({ complete: false, candidates: (await skillsFor(apparatus, String(agent.id))).map(({ skill, taskId, run, reference }): SkillCandidate => ({
        name: skill.name, description: skill.description, source: 'runtime', provider, rank: 0,
        invocation: { modelInvocable: true, userInvocable: true }, locator: { taskId, runId: run.runId, methodDigest: reference.digest, name: skill.name, digest: digestOf(skill),
                },
              }),
            ),
          }),
          get: async (candidate) => {
        const locator = candidate.locator as { taskId: string
              runId: string
              methodDigest: string
              name: string
              digest: string }
        const held = (await skillsFor(apparatus, String(agent.id))).find(
              (entry) => entry.taskId === locator.taskId && entry.run.runId === locator.runId && entry.skill.name === locator.name,
            )
        if (held === undefined || held.reference.digest !== locator.methodDigest || digestOf(held.skill) !== locator.digest) refuse('unknown-revision', 'Skill binding belongs to another Run')
        await consumeMethod(apparatus, held.taskId, held.run, `skill:${held.skill.name}`, `skill:${held.skill.name}:${locator.digest}`,
            )
        return { ...candidate, content: held.skill.content }
      },
    })),
      )
    },
  })
}
export async function runMethodTool(apparatus: Apparatus, caller: Caller, taskId: string, callId: string,
  signal: AbortSignal, toolName: string, candidatePath?: string,
): Promise<{ artifact: string }> {
  const task = taskStateOf(apparatus, taskId)
  if (task.responsibility?.agentId !== caller.agentId) refuse('not-responsible', 'caller does not own this Task')
  const run = Object.values(task.runs).find((run) => run.status === 'running' && run.stage === 'working')
  if (run === undefined) refuse('illegal-transition', 'Task has no working Run')
  assertActive(apparatus, taskId)
  const method = await methodForRun(apparatus, run)
  const tool = method.assets.tools.find((tool) => tool.name === toolName)
  if (tool === undefined) refuse('malformed-declaration', `Tool ${toolName} is absent from the pinned Revision`)
  if (!method.bindings.tools.some((binding) => binding.name === tool.name && binding.digest === digestOf(tool)))
    refuse('not-responsible', `Tool ${toolName} is not bound to this Task`)
  const workspace = workspaceOf(apparatus, taskId, run.runId)
  const path = join(apparatus.workspaceRoot, 'assets', method.reference.digest, `${tool.name}.mjs`)
  if (tool.verifier !== undefined && candidatePath === undefined)
    refuse('malformed-declaration', 'a verifier Tool requires the artifact candidatePath')
  if (candidatePath !== undefined) await assertRunFile(workspace, candidatePath)
  const inputArgs = task.contract!.inputs.length === 0 ? [] : [join(workspace, task.contract!.inputs[0]!.name)]
  const candidateArgs = candidatePath === undefined ? [] : [join(workspace, candidatePath)]
  const result = await spawnProcess({ shell: false, argv: [process.execPath, path,
        ...(tool.verifier === undefined ? [...inputArgs, ...candidateArgs] : [...candidateArgs, ...inputArgs]),
      ],
    }, signal, workspace,
    { root: workspace, writable: true, protected: run.bubble!.inputs.map((input) => join(workspace, input.name)), references: [method.domain.dir, ...method.domain.references, ...methodToolReferences(apparatus, run)],
    },
  )
  if (result.failure !== undefined || result.exitCode !== 0) throw new Error(result.failure ?? `Tool exited ${result.exitCode}: ${result.stderr}`)
  await consumeMethod(apparatus, taskId, run, `tool:${tool.name}`, `tool:${tool.name}:${digestOf(tool)}:${caller.sessionId}/${callId}`,
  )
  return { artifact: result.stdout }
}
