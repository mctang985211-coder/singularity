import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { workspaceOf } from './attempt.ts'
import { loadMethod, methodOfRun } from './method.ts'
import { spawnProcess } from './process.ts'

export async function consumeMethod(apparatus: Apparatus, taskId: string, run: RunState,
  method: 'template' | 'skill' | 'tool', source: string): Promise<void> {
  if (taskStateOf(apparatus, taskId).runs[run.runId]!.consumed.some(entry => entry.method === method)) return
  await apparatus.tasks.recordConsumption({ commandId: `consume:${taskId}/${run.runId}/${method}`, taskId,
    runId: run.runId, revision: run.revision, method, source })
}

function workingFor(apparatus: Apparatus, agentId: string): { taskId: string; run: RunState }[] {
  return [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .filter(task => task.responsibility?.agentId === agentId)
    .flatMap(task => Object.values(task.runs).filter(run => run.status === 'running' && run.stage === 'working')
      .map(run => ({ taskId: task.taskId, run })))
}

export async function methodSkill(apparatus: Apparatus, agentId: string): Promise<string | undefined> {
  const sections: string[] = []
  for (const { taskId, run } of workingFor(apparatus, agentId)) {
    const ref = methodOfRun(apparatus, run)
    if (ref !== undefined) sections.push(`Method ${ref.digest} for Task ${taskId}, Run ${run.runId}:\n${(await loadMethod(apparatus, ref)).assets.skill}`)
  }
  return sections.length === 0 ? undefined : sections.join('\n\n')
}

export async function observeMethodSkill(apparatus: Apparatus, sessionId: string, prompt: string, source: string): Promise<void> {
  const agent = [...apparatus.store.load().statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION).values()]
    .find(agent => agent.sessionId === sessionId)
  if (agent === undefined) return
  for (const { taskId, run } of workingFor(apparatus, agent.agentId)) {
    const ref = methodOfRun(apparatus, run)
    if (ref === undefined) continue
    const text = `Method ${ref.digest} for Task ${taskId}, Run ${run.runId}:\n${(await loadMethod(apparatus, ref)).assets.skill}`
    if (prompt.includes(text)) await consumeMethod(apparatus, taskId, run, 'skill', source)
  }
}

export async function runMethodTool(apparatus: Apparatus, caller: Caller, taskId: string, callId: string,
  signal: AbortSignal): Promise<{ program: string; artifact: string }> {
  const task = taskStateOf(apparatus, taskId)
  if (task.responsibility?.agentId !== caller.agentId) refuse('not-responsible', 'the caller does not own this Task')
  const run = Object.values(task.runs).find(run => run.status === 'running' && run.stage === 'working')
  if (run === undefined) refuse('illegal-transition', 'the Task has no working Run')
  const ref = methodOfRun(apparatus, run)
  if (ref === undefined) refuse('unknown-revision', 'this Run has no Method tool')
  const method = await loadMethod(apparatus, ref)
  const template = method.domain.templates.get(task.contract!.template.id)!
  const workspace = workspaceOf(apparatus, taskId, run.runId)
  const path = join(workspace, 'method-tool.mjs')
  await writeFile(path, method.assets.tool, 'utf8')
  await consumeMethod(apparatus, taskId, run, 'tool', `tool:${caller.sessionId}/${callId}:${ref.digest}`)
  const result = await spawnProcess({ shell: false, argv: [process.execPath, path, join(workspace, template.input.name)] }, signal, workspace)
  if (result.failure !== undefined || result.exitCode !== 0) throw new Error(result.failure ?? `Method tool exited ${result.exitCode}: ${result.stderr}`)
  return { program: method.assets.tool, artifact: result.stdout }
}
