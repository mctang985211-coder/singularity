/**
 * The **legacy root** fixture (A0 §1.6, stage B): a store seeded in the shape the
 * graph entry used to create — a root task whose objective is the graph's own
 * name, carrying the fixed `RootTaskSpec` contract whose only mandatory criterion
 * is the composite conjunction ("all mandatory children verified") — plus its
 * root run, bound to the root session and born `active`.
 *
 * Why a fixture and not an entry. The intake cannot produce this shape, and that
 * is the point: a root contract must carry at least one mandatory criterion
 * judged by something other than the composite conjunction
 * (`rootIntakeDefects`), so the old shape is no longer reachable by any caller.
 * Historical stores, however, are full of it, and A0 §1.6 says what must happen
 * to them: read, decompose, verify and complete exactly as they always did, with
 * the intake refusing by name on top of them. A test that is *about* that
 * history therefore has to seed it, and seeding it through the store's own
 * trusted service — `createTaskIn` / `admitTaskIn` / `startRunIn`, the entries a
 * store's own writer uses — is the only honest way to put it there.
 *
 * **This is a test fixture, never a production path.** It lives under
 * `tests/support`, nothing in `src/` imports it, and it deliberately does not
 * offer a shorter route to a *new* root: a spec that wants a fresh graph uses
 * the real intake, which is the behaviour under test. What the fixture does add
 * on top of the raw store writes is the process-side half a test needs to use
 * such a store — `adoptRoot` binds the session, derives the gate phase from the
 * run record, reconciles what the store left in flight and takes the checkout
 * into this process's workspace ownership — so a seeded legacy root is usable
 * exactly like an adopted one, which is how the recovery stats find it after a
 * restart.
 *
 * The test-only convenience types live here too (R3-3): `TaskDefinition` (the
 * §5.1 template shape) and `RootTaskSpec` (the fixed definition fields the old
 * graph entry seeded a root with) had no production consumer left — the real
 * root contract has come from the intake (`RootContractSpec`) since A0 — so
 * production code must not import them and no package exports them.
 *
 * @module tests/support/legacy-root
 */

import { randomUUID } from 'node:crypto'
import type { AcceptanceCriterion } from '../../task/src/types.ts'
import type { TaskInstance, TaskRun } from '../../task/src/types.ts'
import type { TaskService } from '../../task/src/index.ts'
import type { CapabilityConfig, TaskRuntime } from '../../task-runtime/src/index.ts'
import { bindRunProviders, resolveCapabilities } from '../../task-runtime/src/index.ts'
import { capabilitySnapshot } from '../../task-runtime/src/capability.ts'
import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'

/**
 * The task-template definition shape (§5.1), kept only for the fixtures below:
 * the definition fields a seeded task's `definitionRef` cites. Production holds
 * no definitions registry (W14's fidelity cap), so nothing in `src/` uses this
 * shape.
 */
export interface TaskDefinition {
  taskType: string
  version: number
  objective: string
  acceptanceCriteria: AcceptanceCriterion[]
  requiredCapabilities: string[]
  decompositionPolicy: { allowed: boolean; maxDepth?: number; maxChildren?: number }
}

/** The fixed definition fields of a graph's root task, as the old graph entry seeded them (see seedLegacyRoot). */
export const RootTaskSpec: Pick<TaskDefinition, 'taskType' | 'version' | 'acceptanceCriteria' | 'requiredCapabilities' | 'decompositionPolicy'> = {
  taskType: 'root',
  version: 1,
  acceptanceCriteria: [
    {
      criterionId: 'root-children-verified',
      description: 'all mandatory children verified',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
    },
  ],
  requiredCapabilities: ['execute-task'],
  decompositionPolicy: { allowed: true },
}

export interface LegacyRootSeed {
  /** The store's own service: the fixture writes through it, exactly as a store's writer does. */
  readonly task: TaskService
  /** The runtime that will adopt the seeded root (its workspace registry and session map are the process side of the seed). */
  readonly runtime: TaskRuntime
  /** The store to seed; it is created when it does not exist yet. */
  readonly storeId: string
  /** The root session the seeded run is bound to. */
  readonly rootSessionId: string
  /**
   * The objective the old entry wrote: the graph's name. It is a parameter rather
   * than a constant because a spec that seeds two trees needs to tell them apart,
   * and because naming it here is what makes it visible that this fixture is
   * planting a goal nobody asked for.
   */
  readonly objective: string
  /** The capability table the run's binding is measured against; defaults to the runtime's own effective table. */
  readonly capabilities?: Readonly<Record<string, CapabilityConfig>>
  /** Where a run's bound content would be materialized; defaults to the runtime's configured root. */
  readonly runBindingRoot?: string
}

/**
 * Seed one legacy root and adopt it. Returns the ids the store now holds — the
 * same pair the old entry returned, because a spec written against that entry
 * asserts on them.
 *
 * The order is the old entry's: create-or-open the store, mint both ids, write
 * the task and its admission with an empty capability manifest, bind the run
 * (the empty binding record a root that grants nothing gets — no snapshot, no
 * invented content), start it `active`, and then adopt, which is what binds the
 * session, derives the gate phase from the run record and claims the checkout.
 */
export async function seedLegacyRoot(seed: LegacyRootSeed): Promise<{ taskId: string; runId: string }> {
  const { task, runtime, storeId, rootSessionId, objective } = seed
  try {
    await task.createStore(storeId)
  } catch (error) {
    if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error
    await task.openStore(storeId)
  }
  const taskId = `t-${randomUUID()}`
  const runId = `r-${randomUUID()}`
  // The table the session's own admission resolves against, not the deployment's
  // raw configuration: a session's effective table is its graph library's rows
  // merged over the configured ones (`TaskRuntime.capabilitiesForSession`), and
  // the provider pre-check below is asked for exactly this session.
  const table = { ...TASK_GUIDANCE, ...(seed.capabilities ?? await runtime.capabilitiesForSession(rootSessionId)) }
  const manifest = resolveCapabilities(RootTaskSpec.requiredCapabilities, table)
  const contract = {
    contractVersion: 1 as const,
    objective,
    acceptanceCriteria: structuredClone(RootTaskSpec.acceptanceCriteria),
    assumptions: [],
    constraints: [],
    requiredCapabilities: [...RootTaskSpec.requiredCapabilities],
  }
  const instance: TaskInstance = {
    taskId,
    definitionRef: { taskType: RootTaskSpec.taskType, version: RootTaskSpec.version },
    objective: contract.objective,
    depth: 0,
    acceptanceCriteria: contract.acceptanceCriteria,
    requestedCapabilities: [...contract.requiredCapabilities],
    decompositionStatus: 'decomposable',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract,
  }
  await task.createTaskIn(storeId, instance, rootSessionId)
  await task.admitTaskIn(storeId, taskId, rootSessionId, { decompositionStatus: 'decomposable', manifest })
  const providerBinding = await bindRunProviders({
    storeId,
    runId,
    manifest,
    table,
    providers: await runtime.capabilityProviderReport(rootSessionId, contract.requiredCapabilities),
    root: seed.runBindingRoot ?? runtime.config.runBindingRoot,
  })
  const run: TaskRun = {
    runId,
    taskId,
    sessionId: rootSessionId,
    capabilitySnapshot: capabilitySnapshot(manifest),
    ...(providerBinding === undefined ? {} : { providerBinding }),
    executionPhase: 'active',
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  await task.startRunIn(storeId, run, rootSessionId)
  await runtime.adoptRoot(storeId, rootSessionId)
  return { taskId, runId }
}
