/**
 * Task runtime: capability resolution, decomposition admission, sequential run
 * orchestration on the agent-runtime spawn seam, and worker handoff rendering.
 * @module dsh-singularity-task-runtime
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {} from '@dangosys/dsh-singularity-agent-runtime'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {
  AcceptanceCriterion,
  CapabilityManifest,
  DependencyEdge,
  EvidenceBundle,
  RunId,
  TaskEvent,
  TaskId,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'
import { RootTaskSpec, rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, capabilitySnapshot, type CapabilityConfig } from './capability.ts'
import { checkDecomposition } from './admission.ts'
import { runChildrenCascade, VerifierUnavailableError, type ChildOutcome, type ChildPlan, type OrchestrateEnv, type VerifyRunOptions } from './orchestrate.ts'

export type { CapabilityConfig } from './capability.ts'
export { resolveCapabilities } from './capability.ts'
export type { AdmissionChild, AdmissionParent, AdmissionVerdict } from './admission.ts'
export { checkDecomposition } from './admission.ts'
export type { HandoffInit } from './handoff.ts'
export { buildHandoff, renderWorkerPrompt } from './handoff.ts'
export type { ChildOutcome, ChildPlan, OrchestrateEnv, SpawnChildRequest, VerifyRunOptions } from './orchestrate.ts'
export { runChildrenCascade, VerifierUnavailableError } from './orchestrate.ts'

/** Local view of the verifier service (ticket C2 develops it in parallel): the
 * runtime resolves it softly from the context and never imports the package. */
export interface RunVerifier {
  verifyRun(storeId: string, runId: RunId, options?: VerifyRunOptions): Promise<EvidenceBundle>
}

/** Soft view of the env-builder store: verification commands run where the workers ran. */
interface EnvPathSource {
  store: { get(envId: string): { path: string } }
}

export interface CriterionSpec {
  description: string
  command?: string
  mode?: VerificationMode
  mandatory?: boolean
  requiredEvidence?: string[]
}

export interface DecomposeChildSpec {
  objective: string
  acceptanceCriteria: readonly CriterionSpec[]
  requiredCapabilities?: readonly string[]
  dependsOn?: readonly number[]
  /**
   * The caller declares this child may decompose itself (RFC §36: the agent
   * admits it so its own worker keeps the option to split further). A missing
   * required capability forces `decomposable` on its own; the declaration is
   * what makes a child with no gap decomposable.
   */
  decomposable?: boolean
}

export interface DecomposeSpec {
  children: readonly DecomposeChildSpec[]
  reason: string
}

export interface Config {
  /** Capability registry: name → skills/tools/preset granted when a task requires it. */
  capabilities: Record<string, CapabilityConfig>
  /** Agent preset used when no matched capability names one. */
  defaultPreset?: string
  /** Wall-clock budget for one `verifier.verifyRun` call. */
  verifyTimeoutMs: number
}

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

export const DEFAULT_CAPABILITIES: Readonly<Record<string, CapabilityConfig>> = {
  'design-chip': { skills: ['chip-designer'] },
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'check-ball-registration': { skills: ['check'] },
  'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify' },
  'run-bemu-regression': { skills: ['verify'], preset: 'bb-verify' },
  'run-verilator-regression': { skills: ['verify'], preset: 'bb-verify' },
  'analyze-waveform': { skills: ['waveform'] },
  'research': { preset: 'default' },
}

const Capability: z<CapabilityConfig> = z.object({
  skills: z.array(z.string()),
  tools: z.array(z.string()),
  preset: z.string(),
})

const ConfigSchema: z<Config> = z.object({
  capabilities: z.dict(Capability).default({ ...DEFAULT_CAPABILITIES }),
  defaultPreset: z.string(),
  verifyTimeoutMs: z.number().default(DEFAULT_VERIFY_TIMEOUT_MS),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskRuntime: TaskRuntime
  }
}

interface RunBinding {
  storeId: string
  taskId: TaskId
  runId: RunId
}

function now(): string {
  return new Date().toISOString()
}

function normalizeCriteria(criteria: readonly CriterionSpec[], childIndex: number): AcceptanceCriterion[] {
  return criteria.map((criterion, index) => ({
    criterionId: `ac${childIndex + 1}-${index + 1}`,
    description: criterion.description,
    verificationMode: criterion.mode ?? (criterion.command !== undefined ? 'deterministic' : 'review'),
    requiredEvidence: [...(criterion.requiredEvidence ?? [])],
    mandatory: criterion.mandatory ?? true,
    ...(criterion.command !== undefined ? { command: criterion.command } : {}),
  }))
}

export class TaskRuntime extends Service {
  static inject = ['task', 'agentRuntime', 'graphs']
  static Config: z<Config> = ConfigSchema

  private readonly config: Config
  /** sessionId → run binding, rebuilt whenever a store is (re)opened. */
  private readonly sessions = new Map<string, RunBinding>()

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'taskRuntime')
    this.config = {
      capabilities: structuredClone(config?.capabilities ?? DEFAULT_CAPABILITIES),
      ...(config?.defaultPreset !== undefined ? { defaultPreset: config.defaultPreset } : {}),
      verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    }
  }

  /** Resolve required capability names against the configured registry. */
  resolveCapabilities(required: readonly string[]): CapabilityManifest {
    return resolveCapabilities(required, this.config.capabilities)
  }

  /** Create (or reopen) the store, expand RootTaskSpec into the root task, and bind a run to the root session. */
  async createRootTask(
    storeId: string,
    options: { objective: string; rootSessionId: string },
    actor: string,
  ): Promise<{ taskId: TaskId; runId: RunId }> {
    try {
      await this.ctx.task.createStore(storeId)
    } catch (error) {
      if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error
      await this.ctx.task.openStore(storeId)
    }
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    this.reindex(storeId, snapshot)
    const root = snapshot.tasks.find(task => task.parentTaskId === undefined)
    if (root !== undefined) {
      const run = [...snapshot.runs].reverse().find(item => item.taskId === root.taskId && item.sessionId === options.rootSessionId)
      if (run === undefined) {
        throw new Error(`task-runtime: store "${storeId}" already has root task "${root.taskId}" without a run for session "${options.rootSessionId}"`)
      }
      return { taskId: root.taskId, runId: run.runId }
    }

    const manifest = this.resolveCapabilities(RootTaskSpec.requiredCapabilities)
    const task: TaskInstance = {
      taskId: `t-${randomUUID()}`,
      definitionRef: { taskType: RootTaskSpec.taskType, version: RootTaskSpec.version },
      objective: options.objective,
      depth: 0,
      acceptanceCriteria: RootTaskSpec.acceptanceCriteria.map(criterion => ({ ...criterion, requiredEvidence: [...criterion.requiredEvidence] })),
      requestedCapabilities: [...RootTaskSpec.requiredCapabilities],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }
    await this.ctx.task.createTaskIn(storeId, task, actor)
    await this.ctx.task.admitTaskIn(storeId, task.taskId, actor, { decompositionStatus: 'decomposable', manifest })
    const run: TaskRun = {
      runId: `r-${randomUUID()}`,
      taskId: task.taskId,
      sessionId: options.rootSessionId,
      capabilitySnapshot: capabilitySnapshot(manifest),
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: now(),
    }
    await this.ctx.task.startRunIn(storeId, run, actor)
    this.sessions.set(options.rootSessionId, { storeId, taskId: task.taskId, runId: run.runId })
    return { taskId: task.taskId, runId: run.runId }
  }

  /**
   * Atomic decomposition plus the sequential run cascade: structural admission
   * and capability admission must pass for the whole batch before anything is
   * persisted; children then run one at a time in dependency order.
   */
  async decomposeAndRun(
    storeId: string,
    parentTaskId: TaskId,
    parentRunId: RunId,
    callerSessionId: string,
    spec: DecomposeSpec,
    exec: { signal?: AbortSignal } = {},
  ): Promise<ChildOutcome[]> {
    const actor = callerSessionId
    const parentTask = await this.ctx.task.taskIn(storeId, parentTaskId)
    const parentRun = await this.ctx.task.runIn(storeId, parentRunId)
    if (parentRun.taskId !== parentTaskId) {
      throw new Error(`task-runtime: run "${parentRunId}" belongs to task "${parentRun.taskId}", not "${parentTaskId}"`)
    }
    if (parentRun.sessionId !== callerSessionId) {
      throw new Error(`task-runtime: run "${parentRunId}" is bound to session "${parentRun.sessionId}", not caller "${callerSessionId}"`)
    }
    if (!Array.isArray(spec.children) || spec.children.length === 0) {
      throw new Error('task-runtime: decomposition requires at least one child')
    }

    const childTaskIds = spec.children.map(() => `t-${randomUUID()}`)
    const criteria = spec.children.map((child, index) => normalizeCriteria(child.acceptanceCriteria, index))
    const snapshot = await this.ctx.task.snapshotIn(storeId)
    const verdict = checkDecomposition(
      { ...parentTask, decompositionPolicy: { allowed: parentTask.decompositionStatus !== 'leaf' } },
      spec.children.map((child, index) => ({
        taskId: childTaskIds[index]!,
        objective: child.objective,
        acceptanceCriteria: criteria[index]!,
        dependsOn: child.dependsOn,
      })),
      snapshot.edges,
    )
    if (!verdict.ok) {
      throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}":\n- ${verdict.reasons.join('\n- ')}`)
    }

    const manifests = spec.children.map(child => this.resolveCapabilities(child.requiredCapabilities ?? []))
    const rejected = spec.children
      .map((child, index) => ({ child, index, manifest: manifests[index]! }))
      .filter(({ child, manifest }) => manifest.missing.length > 0 && child.decomposable !== true)
    if (rejected.length > 0) {
      const detail = rejected
        .map(({ index, manifest }) => `child ${index} is missing [${manifest.missing.join(', ')}] and may not decompose`)
        .join('; ')
      throw new Error(`task-runtime: admission rejected decomposition of "${parentTaskId}": capability gap: ${detail}`)
    }

    const children: TaskInstance[] = spec.children.map((child, index) => ({
      taskId: childTaskIds[index]!,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId,
      objective: child.objective,
      depth: parentTask.depth + 1,
      acceptanceCriteria: criteria[index]!,
      requestedCapabilities: [...(child.requiredCapabilities ?? [])],
      decompositionStatus: child.decomposable === true || manifests[index]!.missing.length > 0 ? 'decomposable' : 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }))
    const edges: DependencyEdge[] = spec.children.flatMap((child, to) =>
      (child.dependsOn ?? [] as readonly number[]).map((from: number) => ({ from: childTaskIds[from]!, to: childTaskIds[to]! })))
    await this.ctx.task.decomposeIn(storeId, parentTaskId, children, actor, edges)

    const manifestEvents: TaskEvent[] = manifests.flatMap((manifest, index) => {
      const envelope = {
        taskId: childTaskIds[index]!,
        parentTaskId,
        timestamp: now(),
        actor,
        schemaVersion: 1 as const,
      }
      const events: TaskEvent[] = [
        { ...envelope, kind: 'CapabilityResolved', payload: { manifest } },
      ]
      if (manifest.missing.length > 0) {
        events.push({ ...envelope, kind: 'CapabilityGapDetected', payload: { missing: [...manifest.missing] } })
      }
      return events
    })
    await this.ctx.task.commitIn(storeId, manifestEvents)

    const plans: ChildPlan[] = children.map((task, index) => ({
      task,
      manifest: manifests[index]!,
      dependsOn: spec.children[index]!.dependsOn ?? [],
    }))
    return runChildrenCascade(
      this.orchestrateEnv(callerSessionId, actor),
      storeId,
      parentTask,
      parentRun,
      plans,
      spec.reason,
      callerSessionId,
      exec.signal,
    )
  }

  /** Reverse lookup: the task run a (worker) session is bound to. */
  async runForSession(sessionId: string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }> {
    const found = await this.lookupRun(sessionId)
    if (found === undefined) throw new Error(`task-runtime: no task run is bound to session "${sessionId}"`)
    return found
  }

  private async lookupRun(sessionId: string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun } | undefined> {
    const binding = this.sessions.get(sessionId)
    if (binding !== undefined) {
      const resolved = await this.resolveBinding(binding)
      if (resolved !== undefined) return resolved
      this.sessions.delete(sessionId)
    }
    let rootSessionId: string
    try {
      const graph = await this.ctx.graphs.graphForSession(SessionId(sessionId))
      rootSessionId = graph.rootSessionId
    } catch {
      return undefined
    }
    const storeId = rootTaskStoreId(rootSessionId)
    try {
      const snapshot = await this.ctx.task.openStore(storeId)
      this.reindex(storeId, snapshot)
    } catch {
      return undefined
    }
    const rebinding = this.sessions.get(sessionId)
    if (rebinding === undefined) return undefined
    return this.resolveBinding(rebinding)
  }

  private async resolveBinding(binding: RunBinding): Promise<{ storeId: string; task: TaskInstance; run: TaskRun } | undefined> {
    try {
      const [task, run] = await Promise.all([
        this.ctx.task.taskIn(binding.storeId, binding.taskId),
        this.ctx.task.runIn(binding.storeId, binding.runId),
      ])
      return { storeId: binding.storeId, task, run }
    } catch {
      return undefined
    }
  }

  private reindex(storeId: string, snapshot: TaskSnapshot): void {
    for (const run of snapshot.runs) {
      this.sessions.set(run.sessionId, { storeId, taskId: run.taskId, runId: run.runId })
    }
  }

  private orchestrateEnv(callerSessionId: string, actor: string): OrchestrateEnv {
    return {
      task: this.ctx.task,
      actor,
      ...(this.config.defaultPreset !== undefined ? { defaultPreset: this.config.defaultPreset } : {}),
      verifyTimeoutMs: this.config.verifyTimeoutMs,
      spawn: request => {
        const parent = this.liveAgent(callerSessionId)
        return this.ctx.agentRuntime.spawn(parent, {
          sessionId: SessionId(request.sessionId),
          name: request.name,
          prompt: [{ type: 'text', text: request.prompt }],
          ...(request.agentPreset !== undefined ? { agentPreset: request.agentPreset } : {}),
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      },
      verifyRun: async (storeId, runId, options = {}) => {
        const verifier = (this.ctx.get?.('verifier') ?? (this.ctx as unknown as { verifier?: RunVerifier }).verifier) as RunVerifier | undefined
        if (verifier === undefined || typeof verifier.verifyRun !== 'function') {
          throw new VerifierUnavailableError(
            `task-runtime: verifier service is not loaded; cannot verify run "${runId}" (expected plugin id "verifier", ticket C2)`,
          )
        }
        let cwd: string | undefined
        try {
          const graph = await this.ctx.graphs.graphForSession(SessionId(callerSessionId))
          cwd = ((this.ctx.get?.('envBuilder') ?? (this.ctx as unknown as { envBuilder?: EnvPathSource }).envBuilder) as EnvPathSource | undefined)
            ?.store.get(graph.envId).path
        } catch {
          cwd = undefined
        }
        return verifier.verifyRun(storeId, runId, { ...(cwd === undefined ? {} : { cwd }), ...options })
      },
      onRunBound: (sessionId, binding) => {
        this.sessions.set(sessionId, binding)
      },
    }
  }

  /** The `agents` registry is not an injected dependency; resolve it softly like the verifier. */
  private liveAgent(sessionId: string): Agent {
    const registry = (this.ctx.get?.('agents') ?? (this.ctx as unknown as { agents?: { get(id: string): Agent | undefined } }).agents) as
      | { get(id: string): Agent | undefined }
      | undefined
    const agent = registry?.get(sessionId)
    if (agent === undefined) {
      throw new Error(`task-runtime: caller session "${sessionId}" has no live agent; cannot spawn child workers`)
    }
    return agent
  }
}

export default TaskRuntime
