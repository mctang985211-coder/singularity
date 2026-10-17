import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { workspaceOf } from './attempt.ts'
import { methodForRun, methodToolReferences } from './method.ts'
import { assertActive } from './coordination.ts'
import type { RevisionRef } from '../../src/task/protocol.ts'
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
  return task !== undefined && run?.status === 'running' && run.stage === 'working' ? { task, run } : undefined
}
async function skillsFor(apparatus: Apparatus, agentId: string) {
  const working = workingFor(apparatus, agentId)
  if (working === undefined) return []
  const { task, run } = working
  const { reference, assets, bindings } = await methodForRun(apparatus, run)
  return assets.skills.filter((skill) => bindings.skills.some((binding) => binding.name === skill.name))
    .map((skill) => ({ taskId: task.taskId, run, reference, skill }))
}
export interface MethodContext {
  readonly method: RevisionRef
  readonly template: { readonly id: string; readonly digest: string } | null
  readonly guidance?: string
  readonly skills: readonly {
    readonly name: string
    readonly description: string
    readonly digest: string
    readonly read: { readonly tool: 'skill'; readonly arguments: { readonly name: string } }
  }[]
  readonly tools: readonly {
    readonly name: string
    readonly digest: string
    readonly ref: string
    readonly call: {
      readonly tool: 'singularity_run_method'
      readonly arguments: { readonly tool: string; readonly candidatePath?: string }
    }
    readonly candidatePath: 'optional existing workspace file' | 'required existing workspace file'
  }[]
  readonly gaps: readonly string[]
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
  return { method: reference, template: template === undefined ? null : { id: template.id, digest: template.digest },
    ...(template?.guidance === undefined ? {} : { guidance: template.guidance }),
    skills: bindings.skills.map((binding) => {
      const skill = assets.skills.find((skill) => skill.name === binding.name)!
      return { ...binding, description: skill.description,
        read: { tool: 'skill', arguments: { name: skill.name } },
      }
    }),
    tools: bindings.tools.map((binding) => {
      const tool = assets.tools.find((tool) => tool.name === binding.name)!
      return { ...binding, ref: join(apparatus.workspaceRoot, 'assets', reference.digest, `${tool.name}.mjs`),
        call: { tool: 'singularity_run_method', arguments: { tool: tool.name,
          ...(tool.verifier === undefined ? {} : { candidatePath: contract.artifact }),
        } },
        candidatePath: tool.verifier === undefined ? 'optional existing workspace file' : 'required existing workspace file',
      }
    }),
    gaps: bindings.gaps,
    references: [...domain.references, ...methodToolReferences(apparatus, run)],
    ...(domain.measurement === undefined ? {} : { measurement: { module: domain.measurement.module,
      baseline: domain.measurement.baseline, unit: domain.measurement.unit, direction: domain.measurement.direction,
      conditions: domain.measurement.conditions,
    } }),
  }
}
export async function readMethodContext(apparatus: Apparatus, taskId: string, run: RunState): Promise<MethodContext> {
  const context = await methodContext(apparatus, taskId, run)
  if (context.guidance !== undefined) {
    const template = context.template!
    await consumeMethod(apparatus, taskId, run, `guidance:${template.id}`, `read:guidance:${template.id}:${template.digest}`)
  }
  return context
}
export async function mountMethodSkills(apparatus: Apparatus, agent: Agent): Promise<void> {
  const ctx = agent.ctx
  const skills = ctx.get('skills') as import('@deepseek-ai/dsh-skill').SkillRegistry
  const provider = `singularity-${agent.id}`
  await ctx.plugin({ name: 'singularity-revision-skills', apply: (scope: typeof ctx) => {
    scope.effect(() => skills.registerProvider(() => ({ name: provider,
      list: async () => ({ complete: false,
        candidates: (await skillsFor(apparatus, String(agent.id))).map(({ skill, taskId, run, reference }): SkillCandidate => ({
          name: skill.name, description: skill.description, source: 'runtime', provider, rank: 0,
          invocation: { modelInvocable: true, userInvocable: true },
          locator: { taskId, runId: run.runId, methodDigest: reference.digest, name: skill.name, digest: digestOf(skill) },
        })),
      }),
      get: async (candidate) => {
        const locator = candidate.locator as { taskId: string; runId: string; methodDigest: string; name: string; digest: string }
        const held = (await skillsFor(apparatus, String(agent.id))).find(
          (entry) => entry.taskId === locator.taskId && entry.run.runId === locator.runId && entry.skill.name === locator.name)
        if (held === undefined || held.reference.digest !== locator.methodDigest || digestOf(held.skill) !== locator.digest) refuse('unknown-revision', 'Skill binding belongs to another Run')
        await consumeMethod(apparatus, held.taskId, held.run, `skill:${held.skill.name}`, `skill:${held.skill.name}:${locator.digest}`)
        return { ...candidate, content: held.skill.content }
      },
    })))
  } })
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
  const inputArgs = task.contract!.inputs.map((input) => join(workspace, input.name))
  const candidateArgs = candidatePath === undefined ? [] : [join(workspace, candidatePath)]
  const result = await spawnProcess({ shell: false, argv: [process.execPath, path,
        ...(tool.verifier === undefined ? [...inputArgs, ...candidateArgs] : [...candidateArgs, ...inputArgs]),
      ],
    }, signal, workspace,
    { root: workspace, writable: true, protected: run.bubble!.inputs.map((input) => join(workspace, input.name)), references: [...method.domain.references, ...methodToolReferences(apparatus, run)],
    },
  )
  if (result.exitCode !== null)
    await consumeMethod(apparatus, taskId, run, `tool:${tool.name}`, `tool:${tool.name}:${digestOf(tool)}:${caller.sessionId}/${callId}`)
  if (result.failure !== undefined || result.exitCode !== 0) throw new Error(result.failure ?? `Tool exited ${result.exitCode}: ${result.stderr}`)
  return { artifact: result.stdout }
}
