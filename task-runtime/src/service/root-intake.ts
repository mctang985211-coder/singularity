/**
 * Root contract intake: adoption, origin checks, submission and activation.
 */

import type { TaskRuntime } from './runtime.ts'
import { randomUUID } from 'node:crypto'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  CapabilityManifest,
  ExecutionPhase,
  RootProposalIdentity,
  RunId,
  TaskContract,
  TaskId,
  TaskInstance,
  TaskProposal,
  TaskProposalRoot,
  TaskProposalRootConsumption,
  TaskProposalStatus,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import {
  ROOT_PROPOSAL_TASK_ID,
  TASK_CONTRACT_VERSION,
  admissionContextDigest,
  contractDigest,
  taskContractIdentity,
  reviewContextDigest,
  rootProposalDigest,
  rootProposalId,
  rootTaskStoreId,
} from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, capabilitySnapshot } from '../capability.ts'
import { commandSyntaxDefects, contractDefects, rootIndependenceDefects } from '../admission.ts'
import { providerContentIdentities, providerRefusals } from '../provider-precheck.ts'
import { bindRunProviders, readRunBinding } from '../run-binding.ts'
import { bindTaskTemplate } from '../task-template.ts'
import { normalizeRootContract } from '../normalize.ts'
import { isOpenProposal, reviewContextDelta, reviewContextOf, rootProposalRequestKey } from '../proposal.ts'
import { fixCriteriaProtectedInputs } from '../protected-inputs.ts'
import { VerifierUnavailableError } from '../orchestration/types.ts'
import { applyStoreQuestionBlocking, pendingCoordinationOf } from '../question.ts'
import type { WorkspaceOwner } from '../workspace.ts'
import type { EvolutionCommitRecovery, SessionLogReader, StoreRecoveryState } from '../config.ts'
import type { CommitReconcileOutcome } from '../types.ts'
import type {
  RootContractSpec,
  RootIntakeOptions,
  RootIntakeResult,
  RootAdoption,
  ProposalSubmission,
  ProposalContinuation,
  RootPrecheck,
  CheckRootContractRequest,
  ActivateRootContractRequest,
} from '../types.ts'
import { message, now } from '../helpers.ts'
import * as svcDrivers from './drivers.ts'
import * as svcEnv from './env.ts'
import * as svcEnvironment from './environment.ts'
import * as svcNotify from './notify.ts'
import * as svcProposals from './proposals.ts'
import * as svcRootRecovery from './root-recovery.ts'
import * as svcSessions from './sessions.ts'

export async function adoptRoot(self: TaskRuntime, storeId: string, rootSessionId: string): Promise<RootAdoption> {
  /**
   * The barrier already in flight for this store is the one to wait for: the
   * join is the dedupe, so two explicit entries cannot run two recovery
   */
  const inflight = self.storeRecovery.get(storeId)
  if (inflight !== undefined && (inflight.status === 'recovering' || inflight.status === 'ready')) {
    await inflight.promise
    // Re-read through a function so the outer narrowing cannot freeze the
    // verdict: the barrier this caller joined may have failed while awaited.
    const settledStatus = (state: StoreRecoveryState): StoreRecoveryState['status'] => state.status
    if (self.storeRecovery.get(storeId) === inflight && settledStatus(inflight) === 'failed') throw inflight.failure
    return inflight.adoption!
  }
  let complete!: () => void
  const completed = new Promise<void>(resolve => {
    complete = resolve
  })
  let release!: (start: boolean) => void
  const released = new Promise<boolean>(resolve => {
    release = resolve
  })
  const state: StoreRecoveryState = {
    status: 'recovering',
    promise: completed,
    release,
    released,
    pendingDrivers: [],
    pendingNotices: [],
    wokenSessions: new Set(),
    pendingBatchResults: [],
  }
  self.storeRecovery.set(storeId, state)
  try {
    const adoption = await adoptRootThroughBarrier(self, storeId, rootSessionId)
    state.adoption = adoption
    // One post-pass read hands every known session its gate phase (A2 §E). Kept on the facade: recovery tests spy on it.
    await self.initializeStoreGates(storeId)
    if (state.cancelled) {
      /**
       * A cancellation or the unload invalidated this barrier: it finished
       * its pass into a store that cancellation owns, so it leaves no ready
       */
      self.storeRecovery.delete(storeId)
    } else {
      state.status = 'ready'
    }
    /**
     * The wakes this barrier deferred run now and only now: the gates are in
     * place and the store is `ready`, so the first request each one starts is
     */
    const deferred = state.pendingQuestionDelivery
    state.pendingQuestionDelivery = undefined
    if (!state.cancelled) {
      if (deferred !== undefined) await deferred()
      for (const result of state.pendingBatchResults.splice(0)) await svcNotify.deliverBatchResultNow(self, result)
      while (state.pendingNotices.length > 0) {
        const notice = state.pendingNotices[0]!
        if (state.wokenSessions.has(notice.sessionId)) {
          state.pendingNotices.shift()
          continue
        }
        svcNotify.notify(self, notice.sessionId, notice.text)
        state.pendingNotices.shift()
      }
    }
    /**
     * The drivers start only now — after the facts, the gates and the
     * registrations are settled. The barrier never waits for what they do;
     */
    state.pendingDrivers.length = 0
    release(!state.cancelled)
    return adoption
  } catch (error) {
    state.status = 'failed'
    state.reason = message(error)
    state.failure = error
    /**
     * The failed barrier's deferred wake is dropped with it: a store that never
     * reached `ready` wakes no model, and the record keeps the intents for the
     */
    state.pendingQuestionDelivery = undefined
    for (const notice of state.pendingNotices) self.startedSessions.delete(notice.sessionId)
    state.pendingNotices.length = 0
    state.wokenSessions.clear()
    state.pendingBatchResults.length = 0
    /**
     * Not-started is not executed (A2 §E): the drivers this barrier
     * registered are aborted and removed, nothing is written on their behalf,
     */
    svcDrivers.standDownPendingDrivers(self, state)
    release(false)
    // The temporary resources this barrier acquired go back; committed
    // recovery facts stay on the record.
    try {
      await svcSessions.releaseStoreWorkspace(self, storeId)
    } catch (cleanup) {
      self.warn(`store ${storeId}: its workspace could not be released after a failed recovery (${message(cleanup)})`)
    }
    throw error
  } finally {
    complete()
  }
}

export async function reconcileEvolutionCommits(self: TaskRuntime): Promise<void> {
  const evolution = self.softService<EvolutionCommitRecovery>('evolution')
  if (evolution?.reconcile === undefined) return
  let outcomes: readonly CommitReconcileOutcome[]
  try {
    outcomes = await evolution.reconcile()
  } catch (error) {
    throw new Error(
      'task-runtime: the evolution ledger could not be reconciled before this store was recovered ' +
        `(${message(error)}); the recovery barrier fails rather than taking a store over ` +
        'while an unsettled production commit may stand behind it',
    )
  }
  for (const outcome of outcomes) {
    if (outcome.result !== 'blocked') continue
    self.warn(
      `evolution: the commit intent "${outcome.intentId}" (${outcome.direction} of proposal "${outcome.proposalId}") targeting ` +
        `${outcome.targets.join(', ')} could not be settled — ${outcome.detail ?? 'no reason reported'}`,
    )
  }
}

async function adoptRootThroughBarrier(
  self: TaskRuntime,
  storeId: string,
  rootSessionId: string,
): Promise<RootAdoption> {
  /**
   * K2-3/§E: production is reconciled before this barrier takes anything over.
   * A graph activation arrives here (activate → adoptRoot), so an interrupted
   */
  await reconcileEvolutionCommits(self)
  await openOrCreateStore(self, storeId)
  let snapshot = await self.context.task.snapshotIn(storeId)
  svcSessions.reindex(self, storeId, snapshot)
  let root = snapshot.tasks.find(task => task.parentTaskId === undefined)
  if (root === undefined) {
    /**
     * No root on the record is not the end of the question: the recovery pass
     * is what continues an approval that was recorded before the process died
     */
    await self.reconcileStore(storeId, rootSessionId)
    snapshot = await self.context.task.snapshotIn(storeId)
    root = snapshot.tasks.find(task => task.parentTaskId === undefined)
    if (root === undefined) {
      return { adopted: false, detail: nothingAdoptedDetail(storeId, rootSessionId, snapshot) }
    }
  }
  const run = [...snapshot.runs].reverse().find(item => item.taskId === root.taskId && item.sessionId === rootSessionId)
  if (run === undefined) {
    throw new Error(
      `task-runtime: store "${storeId}" already has root task "${root.taskId}" without a run for session "${rootSessionId}"`,
    )
  }
  /**
   * Re-entering a run (a restarted root session adopts the run bound to it):
   * the record's own content identity is re-checked before the run is handed
   */
  if (run.providerBinding !== undefined) {
    const read = await readRunBinding(run.providerBinding)
    if (read !== undefined && read.defects.length > 0) {
      throw new Error(
        `task-runtime: run "${run.runId}" cannot be re-entered: the content it is bound to is not readable:\n- ${read.defects.join('\n- ')}`,
      )
    }
  }
  const phase = runGatePhase(run)
  const rootWasStarted = self.startedSessions.has(rootSessionId)
  self.sessions.set(rootSessionId, { storeId, taskId: root.taskId, runId: run.runId })
  self.startedSessions.add(rootSessionId)
  if (run.taskTemplatesRoot !== undefined) self.sessionExecutionBindings.set(rootSessionId, {
    ...self.sessionExecutionBindings.get(rootSessionId), taskTemplatesRoot: run.taskTemplatesRoot,
  })
  if (
    !rootWasStarted &&
    (phase === 'active' || (phase === 'waiting_children' && pendingCoordinationOf(snapshot, run.runId).length > 0))
  ) {
    svcNotify.notifyWhenReady(self, 
      rootSessionId,
      'task-runtime: continue this same Run from the persisted conversation. Check any interrupted tool action without a receipt before repeating it; handle any unresolved Task questions from the conversation, then continue work allowed in your current execution phase and submit when ready.',
    )
  }
  if (phase === 'terminal') self.executionGate.setTerminal(rootSessionId)
  else if (phase !== undefined) self.executionGate.setPhase(rootSessionId, phase)
  /**
   * A submitted run left by a dead process is independently verified by the
   * recovery pass. Take over this tree's checkout first so that verification
   */
  if (snapshot.runs.some(item => item.status === 'running' && item.executionPhase === 'submitted')) {
    await self.rebuildWorkspaceOwnership(storeId)
  }
  /**
   * Adoption is the recovery entry (§3.6): runs this process is not driving
   * are settled or restarted, then the workspace layers are rebuilt from the
   */
  await self.reconcileStore(storeId, rootSessionId)
  await self.rebuildWorkspaceOwnership(storeId)
  return {
    adopted: true,
    taskId: root.taskId,
    runId: run.runId,
    phase: phase ?? 'terminal',
    detail:
      `store "${storeId}" holds root task "${root.taskId}" with run "${run.runId}" for session "${rootSessionId}"; ` +
      `the session is bound and its gate is "${phase ?? 'ungated'}"`,
  }
}

export async function initializeStoreGates(self: TaskRuntime, storeId: string): Promise<void> {
  const tokens = new Map<string, number>()
  for (const [sessionId, binding] of self.sessions) {
    if (binding.storeId === storeId) tokens.set(sessionId, self.executionGate.decisionToken(sessionId))
  }
  let snapshot: TaskSnapshot
  try {
    snapshot = await self.context.task.snapshotIn(storeId)
  } catch (error) {
    throw new Error(
      `store ${storeId} could not be read to initialize its sessions' gates after recovery ` +
        `(${message(error)}); the recovery barrier fails rather than leaving the store half-gated`,
    )
  }
  for (const run of snapshot.runs) {
    svcSessions.gatePhaseFromStore(self, run.sessionId, run, storeId, tokens.get(run.sessionId) ?? 0)
  }
  /**
   * The question blocks come from the same read and the same tokens (A4 §F.1):
   * a restarted session whose run is waiting on an unresolved blocking question
   */
  applyStoreQuestionBlocking(self.executionGate, snapshot, sessionId => tokens.get(sessionId) ?? 0)
}

function nothingAdoptedDetail(storeId: string, rootSessionId: string, snapshot: TaskSnapshot): string {
  const open = (snapshot.proposals?.all ?? []).filter(isOpenProposal)
  const waiting =
    open.length === 0
      ? 'no proposal is open on it'
      : `${open.length === 1 ? '1 proposal is' : `${open.length} proposals are`} still open: ` +
        open.map(proposal => `"${proposal.proposalId}" (${proposal.status})`).join(', ')
  return (
    `store "${storeId}" holds no root task for session "${rootSessionId}" after its recovery pass, which created no task, no run and no proposal; ` +
    `${waiting}; a root task is created by a root contract intake, never by adoption`
  )
}

export function runGatePhase(run: TaskRun): ExecutionPhase | 'terminal' | undefined {
  if (run.status !== 'running') return 'terminal'
  return run.executionPhase
}

async function openOrCreateStore(self: TaskRuntime, storeId: string): Promise<void> {
  try {
    await self.context.task.createStore(storeId)
  } catch (error) {
    if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error
    await self.context.task.openStore(storeId)
  }
}

export async function intakeRootContract(
  self: TaskRuntime,
  storeId: string,
  rootSessionId: string,
  spec: RootContractSpec,
  options: RootIntakeOptions = {},
): Promise<RootIntakeResult> {
  if (options.exec?.signal?.aborted === true) {
    throw new Error(
      `task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`,
    )
  }
  await svcRootRecovery.assertRecoveryReady(self, storeId, 'the intake of a root contract')
  const submission = await submitRootContractProposal(self, storeId, rootSessionId, spec, options)
  const continued = await self.continueProposal(storeId, submission.proposalId, rootSessionId)
  if (continued.status === 'activated') {
    return {
      status: 'activated',
      proposalId: continued.proposalId,
      taskId: continued.taskId,
      runId: continued.runId,
      detail: continued.detail,
    }
  }
  if (continued.status === 'pending_review') {
    return { status: 'pending_review', proposalId: continued.proposalId, detail: continued.detail }
  }
  throw new Error(
    `task-runtime: root contract of session "${rootSessionId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}`,
  )
}

export async function submitRootContractProposal(
  self: TaskRuntime,
  storeId: string,
  rootSessionId: string,
  spec: RootContractSpec,
  options: RootIntakeOptions = {},
): Promise<ProposalSubmission> {
  await svcRootRecovery.assertRecoveryReady(self, storeId, 'a root contract proposal')
  return await serializeRootIntake(self, storeId, () =>
    submitRootProposalOnce(self, storeId, rootSessionId, spec, options),
  )
}

function rootRequestKey(
  storeId: string,
  rootSessionId: string,
  contract: TaskContract,
  requested?: string,
): string {
  return (
    requested ??
    rootProposalRequestKey({
      storeId,
      rootSessionId,
      contractDigest: contractDigest(contract),
    })
  )
}

async function rootProposalForRequest(
  self: TaskRuntime,
  storeId: string,
  requestKey: string,
  contract: TaskContract,
): Promise<TaskProposalRoot | undefined> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  const stored = snapshot.proposals?.byRequestKey[requestKey]
  if (stored === undefined) return undefined
  if (stored.kind !== 'root') {
    throw new Error(
      `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", which is a decomposition batch; ` +
        "a request key names one proposal, and a root intake cannot take over a batch's key",
    )
  }
  if (stored.identity.contractDigest !== contractDigest(contract)) {
    throw new Error(
      `task-runtime: request key "${requestKey}" is already bound to proposal "${stored.proposalId}", whose root contract is a different one ` +
        `(digest ${stored.identity.contractDigest} ≠ ${contractDigest(contract)}); a revision is new content under a new key (§6)`,
    )
  }
  return stored
}

export async function assertRootContractOrigin(
  self: TaskRuntime,
  storeId: string,
  rootSessionId: string,
): Promise<void> {
  const own = rootTaskStoreId(rootSessionId)
  if (storeId !== own) {
    throw originRefusal(
      rootSessionId,
      `store "${storeId}" is not this session's own store ("${own}"), and a root contract is intaken into the store of the session that asked ` +
        "(A0 §1.10) — never into another session's, whatever the contract says",
    )
  }
  const { header, events } = await rootSessionLog(self, rootSessionId)
  /**
   * The session's kind, before its log: a spawned session works on a task its
   * parent already admitted, and no message on its log can make it the
   */
  if (header?.origin === 'subagent') {
    throw originRefusal(
      rootSessionId,
      'this session is a delegated child (its header records origin "subagent"), and a root contract belongs to the top-level session a graph ' +
        'created — the task a spawned session works on was already admitted by its parent (A0 §1.10)',
    )
  }
  const depth = header?.delegationDepth ?? 0
  if (depth > 0) {
    throw originRefusal(
      rootSessionId,
      `this session is a delegated child (its header records delegation depth ${depth}), and a root contract belongs to the top-level session a ` +
        'graph created — the task a spawned session works on was already admitted by its parent (A0 §1.10)',
    )
  }
  if (events.some(event => event.type === 'user/message' && event.data.source.kind === 'user')) return
  throw originRefusal(
    rootSessionId,
    'this session\'s own log holds no message from the person (no `user/message` event with source.kind "user", the marker DSH reserves for ' +
      'host-attested human input), so the request the contract stands on cannot be established here; the messages this deployment writes to a ' +
      'session of its own are attributed to their producers — its prompts carry source.kind "runtime-prompt" (the graph setup text and a spawn\'s ' +
      'delegated task) and its notices carry "plugin" — and neither is a request of the person\'s (A0 §1.10)',
  )
}

async function rootSessionLog(
  self: TaskRuntime,
  rootSessionId: string,
): Promise<{ readonly header: SessionHeader | undefined; readonly events: readonly SessionEvent[] }> {
  const persistence = self.softService<SessionLogReader>('sessionPersistence')
  if (persistence === undefined || typeof persistence.open !== 'function') {
    throw originRefusal(
      rootSessionId,
      'this deployment mounts no session-persistence service, so its own log cannot be read (A0 §1.10)',
    )
  }
  let handle: Awaited<ReturnType<SessionLogReader['open']>> | undefined
  try {
    handle = await persistence.open(SessionId(rootSessionId), 'read')
    const { events } = await handle.read(0)
    return { header: handle.header, events }
  } catch (error) {
    throw originRefusal(rootSessionId, `its own log could not be read (${message(error)})`)
  } finally {
    /**
     * A close that fails is not this call's answer: the log was already read —
     * or already refused by name — and the handle's teardown is best-effort
     */
    if (handle !== undefined) await handle.close().catch(() => undefined)
  }
}

function originRefusal(rootSessionId: string, reason: string): Error {
  return new Error(`task-runtime: the root contract of session "${rootSessionId}" was refused: ${reason}`)
}

async function submitRootProposalOnce(
  self: TaskRuntime,
  storeId: string,
  rootSessionId: string,
  spec: RootContractSpec,
  options: RootIntakeOptions,
): Promise<ProposalSubmission> {
  // An already-cancelled call persists nothing — the same rule the batch path
  // holds its own admission call to (A3 §3.1's signal boundary).
  if (options.exec?.signal?.aborted === true) {
    throw new Error(
      `task-runtime: the intake of a root contract for session "${rootSessionId}" was cancelled before anything was persisted`,
    )
  }
  /**
   * Where the request came from, before anything is opened or written: a store
   * that is not the session's own, a session that is a delegated child, or one
   */
  await assertRootContractOrigin(self, storeId, rootSessionId)
  /**
   * The root session's store exists before its contract does (A0 §1.1): a graph
   * creates the session, and the intake is what fills the store — so this is the
   */
  await openOrCreateStore(self, storeId)
  /**
   * The session's checkout is resolved once: the directory the contract's
   * protected acceptance inputs are read against, the provider pre-check
   */
  const envPath = await self.envPathForSession(rootSessionId)
  const derived = await deriveRootContract(self, spec, envPath, rootSessionId)
  if (!derived.ok) throw derived.refusal
  const { contract } = derived
  const requestKey = rootRequestKey(storeId, rootSessionId, contract, options.requestKey)
  const stored = await rootProposalForRequest(self, storeId, requestKey, contract)
  if (stored !== undefined) {
    /**
     * The caller asked again for the contract this request names: the record
     * already carries it, so the answer is the record — and a proposal still
     */
    const review =
      stored.status === 'pending_review'
        ? await svcProposals.requestProposalReview(self, {
            kind: 'root',
            storeId,
            trigger: 'submitted',
            proposal: stored,
            rootSessionId,
            contract: structuredClone(stored.contract),
            manifests: await rootManifests(self, stored.contract, rootSessionId),
          })
        : undefined
    return {
      proposalId: stored.proposalId,
      status: stored.status,
      policy: stored.policy,
      existing: true,
      detail: rootSubmissionDetail(self, stored, true),
      ...(review === undefined ? {} : { review }),
    }
  }

  /**
   * A genuinely new root contract: the store must not already hold a root (the
   * same gate the reducer enforces inside the commit, asked here so the caller
   */
  const root = await existingRootTask(self, storeId)
  if (root !== undefined) {
    throw new Error(
      `task-runtime: store "${storeId}" already holds root task "${root.taskId}", so a root contract cannot be intaken here (§1.6: ` +
        "an old graph's root is history and is not re-intaken; a new goal is a new graph)",
    )
  }
  const checked = await checkRootContract(self, {
    rootSessionId,
    contract,
    ...(envPath === undefined ? {} : { envPath }),
  })
  if (!checked.ok) throw checked.refusal.error
  const { manifests, providers } = checked
  const reviewContext = reviewContextOf({
    manifests,
    criteria: contract.acceptanceCriteria,
    providers: providerContentIdentities(providers.capabilities),
  })
  const policy = self.config.generatedTaskReview
  const identity: RootProposalIdentity = {
    contractVersion: TASK_CONTRACT_VERSION,
    storeId,
    rootSessionId,
    requestKey,
    contractDigest: contractDigest(contract),
  }
  const proposal: TaskProposalRoot = {
    kind: 'root',
    proposalId: rootProposalId(identity),
    requestKey,
    ...(options.supersedes === undefined ? {} : { supersedes: options.supersedes }),
    status: policy === 'all' ? 'pending_review' : 'ready',
    policy,
    identity,
    /**
     * The contract travels with the proposal, not only its digest: a reviewer,
     * a resumed approval request after a restart and the activation itself all
     */
    contract: structuredClone(contract),
    proposalDigest: rootProposalDigest(identity),
    admissionContext: svcEnv.admissionContext(self, ),
    admissionContextDigest: admissionContextDigest(svcEnv.admissionContext(self, )),
    reviewContext,
    reviewContextDigest: reviewContextDigest(reviewContext),
    createdAt: now(),
  }
  try {
    await self.context.task.submitProposalIn(storeId, proposal, rootSessionId)
  } catch (error) {
    /**
     * A store that already holds *this* contract is a race, not a failure: the
     * request is answered from the record exactly as a retry is. Anything else
     */
    const raced = await svcProposals.readProposal(self, storeId, proposal.proposalId).catch(() => undefined)
    if (raced === undefined || raced.kind !== 'root' || raced.proposalDigest !== proposal.proposalDigest) throw error
    return {
      proposalId: raced.proposalId,
      status: raced.status,
      policy: raced.policy,
      existing: true,
      detail: rootSubmissionDetail(self, raced, true),
    }
  }
  if (proposal.status !== 'pending_review') {
    return {
      proposalId: proposal.proposalId,
      status: proposal.status,
      policy: proposal.policy,
      existing: false,
      detail: rootSubmissionDetail(self, proposal, false),
    }
  }
  const review = await svcProposals.requestProposalReview(self, {
    kind: 'root',
    storeId,
    trigger: 'submitted',
    proposal,
    rootSessionId,
    contract: structuredClone(contract),
    manifests,
  })
  return {
    proposalId: proposal.proposalId,
    status: proposal.status,
    policy: proposal.policy,
    existing: false,
    detail: rootSubmissionDetail(self, proposal, false),
    review,
  }
}

async function deriveRootContract(
  self: TaskRuntime,
  spec: RootContractSpec,
  envPath: string | undefined,
  callerSessionId?: string,
): Promise<{ ok: true; contract: TaskContract } | { ok: false; refusal: Error }> {
  try {
    const retired = callerSessionId === undefined ? new Set<string>() : await svcEnvironment.retiredTemplatesFor(self, callerSessionId)
    spec = await bindTaskTemplate(await self.taskTemplatesRootFor(callerSessionId), spec, undefined, retired)
  } catch (error) {
    return { ok: false, refusal: rootRefusal([message(error)]) }
  }
  const declared = Array.isArray(spec?.acceptanceCriteria) ? spec.acceptanceCriteria : []
  const fixed = await fixCriteriaProtectedInputs(declared, envPath, 'root contract')
  const presented = fixed.reasons.length === 0 ? { ...spec, acceptanceCriteria: fixed.criteria } : spec
  const normalized = normalizeRootContract(presented)
  const reasons = [...fixed.reasons, ...(normalized.ok ? [] : normalized.reasons)]
  if (!normalized.ok || reasons.length > 0) return { ok: false, refusal: rootRefusal(reasons) }
  return { ok: true, contract: normalized.contract }
}

function rootRefusal(reasons: readonly string[]): Error {
  return new Error(`task-runtime: root contract rejected:\n- ${reasons.join('\n- ')}`)
}

async function rootManifests(self: TaskRuntime, contract: TaskContract, sessionId?: string): Promise<CapabilityManifest[]> {
  return [resolveCapabilities(contract.requiredCapabilities, sessionId === undefined ? self.config.capabilities : await self.capabilitiesForSession(sessionId), self.config.mcpServers)]
}

export async function existingRootTask(self: TaskRuntime, storeId: string): Promise<TaskInstance | undefined> {
  const snapshot = await self.context.task.snapshotIn(storeId)
  return snapshot.tasks.find(task => task.parentTaskId === undefined)
}

async function checkRootContract(self: TaskRuntime, request: CheckRootContractRequest): Promise<RootPrecheck> {
  const { rootSessionId, contract } = request
  const label = `root contract of session "${rootSessionId}"`
  const defects = [
    ...contractDefects(contract.acceptanceCriteria, label),
    ...rootIndependenceDefects(contract.acceptanceCriteria, label),
    // The structural rules above are synchronous and pure; parsing a command
    // needs a shell, so the syntax pass is the one awaited step here.
    ...(await commandSyntaxDefects(contract.acceptanceCriteria, label)),
  ]
  if (defects.length > 0) {
    return { ok: false, refusal: { error: rootRefusal(defects), reasons: defects } }
  }
  const manifests = await rootManifests(self, contract, rootSessionId)
  const manifest = manifests[0] as CapabilityManifest
  const precheck = await svcEnv.providerPrecheck(self, Object.keys(manifest.capabilities), {
    ...(request.envPath === undefined ? {} : { cwd: request.envPath }),
    extraRoots: (await self.skillViewForSession(rootSessionId)).extraRoots,
  }, await self.capabilitiesForSession(rootSessionId), self.config.mcpServers ?? {}, rootSessionId)
  const refusals = providerRefusals(precheck, Object.keys(manifest.capabilities))
  if (refusals.length > 0) {
    return {
      ok: false,
      refusal: {
        error: rootRefusal([`the provider pre-check rejected ${label}:`, ...refusals]),
        reasons: refusals,
      },
    }
  }
  try {
    await svcEnv.assertKnownVerifierRefs(self, 
      contract.acceptanceCriteria.map(criterion => ({ childIndex: 0, criterion })),
      label,
    )
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    return { ok: false, refusal: { error: failure, reasons: [failure.message] } }
  }
  return { ok: true, manifests, providers: precheck }
}

export async function continueRootProposalIn(
  self: TaskRuntime,
  storeId: string,
  proposal: TaskProposalRoot,
): Promise<ProposalContinuation> {
  const rootSessionId = proposal.identity.rootSessionId
  /**
   * The origin rule again, before the ladder's first write (§1.10): a proposal
   * recorded before this rule existed, or written into the store by any other
   */
  await assertRootContractOrigin(self, storeId, rootSessionId)
  const existing = await existingRootTask(self, storeId)
  if (existing !== undefined) {
    return await svcProposals.expireProposal(self, 
      storeId,
      proposal,
      `store "${storeId}" already holds root task "${existing.taskId}"; a root contract is one per store and a changed goal is a new graph ` +
        "(§1.6), so this proposal can no longer become the store's root",
    )
  }
  /**
   * The policy gate (§5), the same rule the batch path follows: a contract born
   * under `off` that has not been activated is subject to the deployment's
   */
  const envPath = await self.envPathForSession(rootSessionId)
  const contract = structuredClone(proposal.contract)
  if (proposal.status === 'ready' && proposal.policy === 'off' && self.config.generatedTaskReview === 'all') {
    await self.context.task.changeProposalPhaseIn(
      storeId,
      {
        proposalId: proposal.proposalId,
        to: 'pending_review',
        reason:
          'the deployment tightened the review policy to "all" while this contract had not been activated yet (§5: only tightening is allowed, and it reaches whatever has not run)',
      },
      rootSessionId,
    )
    let detail = 'it is now waiting for a review'
    const reviewed = await checkRootContract(self, {
      rootSessionId,
      contract,
      ...(envPath === undefined ? {} : { envPath }),
    })
    const tightened = await svcProposals.requireProposal(self, storeId, proposal.proposalId)
    if (reviewed.ok) {
      const review = await svcProposals.requestProposalReview(self, {
        kind: 'root',
        storeId,
        trigger: 'tightened',
        proposal: tightened,
        rootSessionId,
        contract,
        manifests: reviewed.manifests,
      })
      detail += `; ${review.detail}`
    } else {
      detail += `, and its contract no longer passes admission (${reviewed.refusal.reasons.join('; ')})`
    }
    return {
      proposalId: proposal.proposalId,
      status: 'pending_review',
      detail: `proposal "${proposal.proposalId}" was sent for review: ${detail}`,
    }
  }
  const contextDigest = admissionContextDigest(svcEnv.admissionContext(self, ))
  if (contextDigest !== proposal.admissionContextDigest) {
    return await svcProposals.staleProposal(self, 
      storeId,
      proposal,
      `the limits in force moved since the contract was proposed and reviewed (admission context ${proposal.admissionContextDigest} → ${contextDigest})`,
    )
  }
  const checked = await checkRootContract(self, {
    rootSessionId,
    contract,
    ...(envPath === undefined ? {} : { envPath }),
  })
  if (!checked.ok) {
    if (checked.refusal.error instanceof VerifierUnavailableError) throw checked.refusal.error
    return await svcProposals.staleProposal(self, 
      storeId,
      proposal,
      `the contract no longer passes admission: ${checked.refusal.reasons.join('; ')}`,
    )
  }
  const { manifests, providers } = checked
  const reviewContext = reviewContextOf({
    manifests,
    criteria: contract.acceptanceCriteria,
    providers: providerContentIdentities(providers.capabilities),
  })
  const reviewDigest = reviewContextDigest(reviewContext)
  if (reviewDigest !== proposal.reviewContextDigest) {
    return await svcProposals.staleProposal(self, 
      storeId,
      proposal,
      `the resolution this contract was reviewed against moved: ${reviewContextDelta(proposal.reviewContext, reviewContext)}`,
    )
  }
  if (proposal.status === 'approved') {
    await self.context.task.changeProposalPhaseIn(
      storeId,
      {
        proposalId: proposal.proposalId,
        to: 'ready',
        reason:
          'the post-approval re-check passed: the store holds no root, the limits are the ones reviewed, and the capability resolution and the judging verifiers are the ones reviewed',
      },
      rootSessionId,
    )
  }
  return await activateRootContract(self, {
    storeId,
    rootSessionId,
    proposal,
    contract,
    manifests,
    providers,
  })
}

async function activateRootContract(
  self: TaskRuntime,
  request: ActivateRootContractRequest,
): Promise<ProposalContinuation> {
  const { storeId, rootSessionId, proposal, contract } = request
  const manifest = request.manifests[0] as CapabilityManifest
  const taskId: TaskId = `t-${randomUUID()}`
  const runId: RunId = `r-${randomUUID()}`
  const workspacePath = await svcSessions.workspacePathForSession(self, rootSessionId)
  let claimed: WorkspaceOwner | undefined
  if (workspacePath !== undefined && self.workspaces !== undefined) {
    await self.workspaces.claim(workspacePath, { kind: 'run', storeId, taskId, runId, since: now() })
    claimed = self.workspaces.ownerOf(workspacePath)
  }
  try {
    const environment = await self.ensureInitialEnvironment(rootSessionId, rootSessionId)
    const revision = environment.revision
    const providerBinding = await bindRunProviders({
      mcpRegistry: self.config.mcpServers,
      storeId,
      runId,
      manifest,
      providers: request.providers,
      table: await self.capabilitiesForSession(rootSessionId),
      root: self.config.runBindingRoot,
      ...(revision === undefined ? {} : { revision }),
    })
    const task: TaskInstance = {
      taskId,
      ...taskContractIdentity(contract),
      objective: contract.objective,
      depth: 0,
      acceptanceCriteria: contract.acceptanceCriteria,
      requestedCapabilities: [...contract.requiredCapabilities],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
      contract: structuredClone(contract),
    }
    const run: TaskRun = {
      runId,
      taskId,
      sessionId: rootSessionId,
      capabilitySnapshot: capabilitySnapshot(manifest),
      taskTemplatesRoot: await self.taskTemplatesRootFor(rootSessionId),
      ...(revision === undefined ? {} : { environmentRevisionId: revision.manifest.revisionId }),
      providerBinding,
      /**
       * Born active (§1.1): the root decides its own work — it may decompose,
       * and it must submit — until its batch or its own submission closes the
       */
      executionPhase: 'active',
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: now(),
    }
    const consumption: TaskProposalRootConsumption = {
      kind: 'root',
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      reviewContextDigest: proposal.reviewContextDigest,
      rootTaskId: taskId,
      rootRunId: runId,
      admittedAt: now(),
    }
    const obligations = manifest.missing.map(capability => ({
      obligationId: `ob-root-${taskId}-${capability}`,
      sourceTaskId: taskId,
      goal: `Resolve capability ${capability} required by: ${contract.objective}`,
      criterion: `Root session ${rootSessionId} must arrange an available provider or propose the missing capability before executing work that requires ${capability}. Keep the original objective and acceptance.`,
    }))
    await self.context.task.admitRootProposalIn(storeId, task, run, rootSessionId, { consumption, manifest, obligations })
  } catch (error) {
    /**
     * Nothing was committed (the commit is all-or-nothing), so the claim this
     * call made is the only thing to undo: leaving it would hold a checkout for
     */
    if (workspacePath !== undefined && claimed !== undefined) {
      await self.workspaces?.release(workspacePath, claimed).catch(cause => {
        self.warn(`workspace ${workspacePath} could not be released after a refused activation (${message(cause)})`)
      })
    }
    throw error
  }
  self.sessions.set(rootSessionId, { storeId, taskId, runId })
  self.startedSessions.add(rootSessionId)
  self.executionGate.setPhase(rootSessionId, 'active')
  svcNotify.notifyWhenReady(self, 
    rootSessionId,
    `the root contract of this session was activated: task ${taskId}, run ${runId} (proposal ${proposal.proposalId}, policy ${proposal.policy}). ` +
      'This session may now decompose, submit its own result, or cancel.' +
      (manifest.missing.length === 0 ? '' : ` Missing capabilities [${manifest.missing.join(', ')}] are recorded as obligations owned by this root session. Plan available work or propose the required capability change; do not execute missing capabilities or weaken the goal. If the gap prevents delivery, submit its original evidence so verification and diagnosis can hand it to supervision.`),
  )
  return {
    proposalId: proposal.proposalId,
    status: 'activated',
    taskId,
    runId,
    detail: `proposal "${proposal.proposalId}" is activated as root task ${taskId} with run ${runId}` +
      (manifest.missing.length === 0 ? '' : `; root session ${rootSessionId} owns missing-capability obligations [${manifest.missing.join(', ')}]`),
  }
}

function rootSubmissionDetail(self: TaskRuntime, proposal: TaskProposal, existing: boolean): string {
  const head = existing
    ? `request answered from proposal "${proposal.proposalId}" (policy ${proposal.policy}, status ${proposal.status})`
    : `proposal "${proposal.proposalId}" was recorded under policy ${proposal.policy} as ${proposal.status}`
  switch (proposal.status) {
    case 'ready':
      return `${head}; continue it to activate the root (policy off activates without a review, and the record says policy-off)`
    case 'pending_review':
      return `${head}; it needs a recorded decision before the root may exist, and nothing is created, spawned or notified until then`
    case 'approved':
      return `${head}; the approval is on record and the root is not activated yet — continue it to run the post-approval re-check`
    case 'admitted':
      return `${head}; its root is activated already and will not be activated again`
    default:
      return `${head}; a ${proposal.status} proposal is not activated, and a revision is new content under a new key`
  }
}

export async function serializeRootIntake<T>(self: TaskRuntime, storeId: string, work: () => Promise<T>): Promise<T> {
  return await self.serializeParent(storeId, ROOT_PROPOSAL_TASK_ID, work)
}

export async function reconcileRootProposal(
  self: TaskRuntime,
  storeId: string,
  proposal: TaskProposalRoot,
  report: (proposal: TaskProposal, status: TaskProposalStatus, reason: string) => Promise<void>,
): Promise<void> {
  const proposalId = proposal.proposalId
  await assertRootContractOrigin(self, storeId, proposal.identity.rootSessionId)
  if (proposal.status === 'pending_review') {
    const existing = await existingRootTask(self, storeId)
    if (existing !== undefined) {
      /**
       * Somebody else became this store's root while the contract waited. It can
       * no longer become one, so the proposal is expired with the reason named
       */
      const expired = await svcProposals.expireProposal(self, 
        storeId,
        proposal,
        `store "${storeId}" already holds root task "${existing.taskId}", so this contract can no longer become its root`,
      )
      await report(proposal, 'expired', expired.detail)
      return
    }
    const rootSessionId = proposal.identity.rootSessionId
    const contract = structuredClone(proposal.contract)
    const envPath = await self.envPathForSession(rootSessionId)
    const checked = await checkRootContract(self, {
      rootSessionId,
      contract,
      ...(envPath === undefined ? {} : { envPath }),
    })
    if (!checked.ok) {
      await report(
        proposal,
        proposal.status,
        `it waits for a review and its contract no longer passes admission (${checked.refusal.reasons.join('; ')}); the proposal stays pending_review`,
      )
      return
    }
    await svcProposals.requestProposalReview(self, {
      kind: 'root',
      storeId,
      trigger: 'recovered',
      proposal,
      rootSessionId,
      contract,
      manifests: checked.manifests,
    })
    return
  }
  /**
   * `ready` or `approved`: the tightening rule and the post-approval re-check
   * both live in the continuation, which is also what re-binds an activation
   */
  const continuation = await serializeRootIntake(self, storeId, () =>
    svcProposals.continueProposalIn(self, storeId, proposalId, proposal.identity.rootSessionId, {}),
  )
  if (continuation.status === 'activated') {
    // The root is live; this process binds it (and derives the phase rather than
    // assuming one).
    await rebindActivatedRoot(self, storeId, proposal.identity.rootSessionId, continuation.taskId, continuation.runId)
    return
  }
  await report(proposal, continuation.status, continuation.detail)
}

async function rebindActivatedRoot(
  self: TaskRuntime,
  storeId: string,
  rootSessionId: string,
  taskId: TaskId,
  runId: RunId,
): Promise<void> {
  self.sessions.set(rootSessionId, { storeId, taskId, runId })
  self.startedSessions.add(rootSessionId)
  let phase: ExecutionPhase | 'terminal' | undefined
  try {
    phase = runGatePhase(await self.context.task.runIn(storeId, runId))
  } catch {
    // A run this process cannot read is not a phase to guess at: the session is
    // bound for lookups, and the gate stays as the store's own recovery left it.
    phase = undefined
  }
  if (phase === 'terminal') self.executionGate.setTerminal(rootSessionId)
  else if (phase !== undefined) self.executionGate.setPhase(rootSessionId, phase)
  svcNotify.notifyWhenReady(self, 
    rootSessionId,
    `recovery bound this session to its activated root contract: task ${taskId}, run ${runId}` +
      `${phase === 'terminal' ? ' (that run is terminal, so this session is closed to new work)' : ''}. ` +
      'A late intake for a different contract is refused because the store already holds this root.',
  )
}
