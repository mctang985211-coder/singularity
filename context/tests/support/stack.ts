/**
 * The read core's deterministic fixture: the **real** `TaskService` and its
 * reducer, an in-memory JSONL-shaped `sessionPersistence`, the real
 * `ExecutionGate`, and stand-ins for the three read-only planes this package is
 * allowed to touch (`graphs`, `taskRuntime`, `sessionQuery`) plus the
 * env-builder seam.
 *
 * Why this shape. The unit under test is the read path, and the facts a read
 * may trust are exactly the store's own records — so the fixture writes its
 * stores through the store's trusted entries (`createTaskIn`, `admitTaskIn`,
 * `startRunIn`, `recordHandoffIn`, `askParentQuestionIn`, …), the same ones a
 * store's writer uses, and never by poking at state. What is replaced is what a
 * read may only *observe* from the outside: the graph registry's membership
 * answer, the runtime's recovery status and binding re-check, and DSH's session
 * log — whose *shape* is real enough for the one fold the question plane reads,
 * a `user/message` event carrying a message id (`consumed`). Nothing here
 * recovers, spawns or approves anything — a read that did would be visible as a
 * fixture method that was called, and the specs assert that none is.
 *
 * The stand-ins are typed structurally (never as the real services) so a spec
 * can hand them deliberately broken answers — a ledger that raises
 * `binding-conflict`, a store that cannot be opened — without pretending to be
 * a whole deployment.
 * @module tests/support/stack
 */

import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { vi } from 'vitest'
import { questionOf, rootTaskStoreId, sha256Hex } from '../../../task/src/index.ts'
import { TaskService } from '../../../task/src/index.ts'
import type {
  AcceptanceCriterion,
  ArtifactRef,
  Diagnosis,
  EvidenceBundle,
  QuestionAnswerRecord,
  QuestionRecord,
  ReviewRecord,
  RunProviderBinding,
  SubmissionRecord,
  TaskEvent,
  TaskInstance,
  TaskRun,
  TaskSnapshot,
} from '../../../task/src/index.ts'
import { ExecutionGate } from '../../../task-runtime/src/gate.ts'
import type { RunBindingRead, StoreRecoveryStatus } from '../../../task-runtime/src/index.ts'
import { SessionNotInGraphError } from '../../../graphs/src/index.ts'
import { SingularityContextService } from '../../src/index.ts'
import type {
  CallerResolution,
  EnvPathSource,
  ProjectedRead,
  ProjectedReadOk,
  NamedRefusal,
  ReviewerBindingRecord,
  ReviewerBindingSource,
} from '../../src/index.ts'

/** One graph the fixture registry publishes. */
export interface GraphSpec {
  readonly id: string
  readonly rootSessionId: string
  readonly name?: string
  readonly envId?: string
  /** Sessions this graph publishes as members. The root session is one by construction. */
  readonly members?: readonly string[]
}

/** One store record the fixture seeds through the store's own entries. */
export interface TaskSpec {
  readonly taskId: string
  /** The session its run is bound to; also the session the fixture publishes in the graph. */
  readonly sessionId: string
  readonly runId: string
  readonly objective: string
  readonly parentTaskId?: string
  readonly depth?: number
  readonly criteria?: readonly AcceptanceCriterion[]
  readonly assumptions?: readonly string[]
  readonly constraints?: readonly string[]
  readonly providerBinding?: RunProviderBinding
  /** A replay run: lineage is this run id, not a task parent. */
  readonly parentRunId?: string
  /** Admit the task as `decomposable` (default `leaf`). */
  readonly decomposable?: boolean
  /** Phase of the seeded run; defaults to `active`. */
  readonly phase?: TaskRun['executionPhase']
  /** Seed the run with no phase at all — the record shape every reader must not guess a phase for. */
  readonly phaseUnknown?: boolean
  /** Edges `from → this task`, seeded after both tasks exist. */
  readonly dependencies?: readonly string[]
}

const SESSION_TEXT = (text: string, seq: number, time: number): SessionEvent =>
  ({
    type: 'user/message',
    seq: SessionSeq(seq),
    time,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }) as unknown as SessionEvent

const hex = (seed: number): string => seed.toString(16).padStart(64, '0')

/** Explicit read-plane responses for the standard chain's admitted methods. */
const guidanceBodies: Readonly<Record<string, string>> = {
  'release-coordination': 'Coordinate the release by checking the bridge and truss results against the release build. Retain the public API and accepted thresholds.',
  'bridge-construction': 'Build the bridge around its span and verified truss inputs. Delegate the deck as a separate result, then check its load and assembly evidence.',
  'truss-construction': 'Build the truss from the accepted dimensions. Verify joints and load support before publishing the truss artifact for the bridge.',
  'deck-construction': 'Build the deck from the verified truss and specified deck material. Check dimensions and fastening before publishing the deck artifact.',
  'champion-replay': 'Reproduce the champion from the recorded inputs and compare its output under the unchanged champion acceptance. Record the replay evidence.',
  'reference-integration': 'Resolve the handed-off artifact and evidence references by their recorded identities. Integrate their results under the accepted release contract and cite the supporting records.',
}

export const GUIDANCE_BINDINGS: Readonly<Record<keyof typeof guidanceBodies, RunProviderBinding>> = Object.fromEntries(
  Object.entries(guidanceBodies).map(([name, instructions]) => [name, {
    registryRevision: hex(31), capabilities: [name], mcpServers: [],
    snapshotRoot: `/fixture/run-bindings/${name}/skills`,
    skills: [{ name, role: 'guidance', capabilities: [name], description: name,
      contractDigest: null, contentDigest: sha256Hex(instructions), uncovered: [] }],
  }]),
)

/** A run binding whose snapshot the fixture's runtime stub reports as unreadable, and one it reports as fine. */
export const BINDING_WITH_SNAPSHOT: RunProviderBinding = {
  registryRevision: hex(11),
  capabilities: ['cap-a'],
  skills: [
    {
      name: 'skill-a',
      role: 'guidance',
      capabilities: ['cap-a'],
      description: 'fixture guidance skill',
      contractDigest: null,
      contentDigest: hex(12),
      uncovered: [],
    },
  ],
  mcpServers: [],
  snapshotRoot: '/fixture/run-bindings/r-1/skills',
}

export const BINDING_WITHOUT_SNAPSHOT: RunProviderBinding = {
  registryRevision: hex(21),
  capabilities: ['cap-b'],
  skills: [
    {
      name: 'skill-b',
      role: 'knowledge',
      capabilities: ['cap-b'],
      description: 'fixture knowledge skill',
      contractDigest: hex(22),
      contentDigest: hex(23),
      uncovered: [],
    },
  ],
  mcpServers: [],
}

export class FixtureStack {
  readonly ctx: Context
  readonly task: TaskService
  readonly service: SingularityContextService
  readonly gate = new ExecutionGate()
  /** Whether the runtime stub admits a run's own `task_decompose`; a spec flips it to read the projection's rule off. */
  runtimeDecomposition = true
  /** Every call the read path made into the runtime's observation surface, in order. */
  readonly observed = { recoveryStatus: vi.fn(), readRunBinding: vi.fn(), gatePhaseOf: vi.fn() }
  private readonly headers = new Map<string, SessionHeader>()
  private readonly logs = new Map<string, { header: SessionHeader; events: SessionEvent[] }>()
  private readonly stores = new Map<string, { header: SessionHeader; events: TaskEvent[] }>()
  private readonly graphs = new Map<string, { spec: Required<GraphSpec>; members: Set<string>; spawned: Set<string> }>()
  private readonly recovery = new Map<string, StoreRecoveryStatus>()
  private envPath: string | undefined
  private time = 1_760_000_000_000
  /** The registry stand-in itself, so a spec can break one of its reads without replacing the whole plane. */
  private graphsService!: {
    graphForSession(sessionId: string): Promise<unknown>
    list(): Promise<readonly unknown[]>
    view(id: string): Promise<{
      graph: {
        readonly agents: readonly { readonly id: string }[]
        readonly edges: readonly { kind: string; from: string; to: string }[]
      }
    }>
  }
  /** The session plane's stand-in, kept so one of its reads can be handed back broken. */
  private sessionQueryService!: {
    readSession(sessionId: string): Promise<unknown>
  }

  constructor() {
    this.ctx = new Context()
    const persistence = {
      list: async () => [...this.headers.values()].map(header => ({ header })),
      create: async (header: SessionHeader) => {
        this.headers.set(header.id, header)
        if (!this.stores.has(header.id)) this.stores.set(header.id, { header, events: [] })
        if (!this.logs.has(header.id)) this.logs.set(header.id, { header, events: [] })
        return this.handle(header.id)
      },
      open: async (id: string) => {
        if (!this.headers.has(id)) throw new Error(`missing session ${id}`)
        return this.handle(id)
      },
    }
    this.ctx.provide('sessionPersistence', persistence as never)
    this.task = new TaskService(this.ctx)

    const graphsService = {
      graphForSession: async (sessionId: string) => {
        for (const entry of this.graphs.values()) {
          if (entry.members.has(String(sessionId))) return this.record(entry)
        }
        // The registry's own fact ("no graph publishes this session"), which the
        // real registry answers with the same distinguishable error: a read
        // *failure* is a different answer and must not be read as a miss.
        throw new SessionNotInGraphError(sessionId)
      },
      list: async () => [...this.graphs.values()].map(entry => this.record(entry)),
      view: async (id: string) => {
        const entry = this.graphs.get(id)
        if (entry === undefined) throw new Error(`graphs: unknown graph "${id}"`)
        return {
          graph: {
            id,
            agents: [...entry.members].map(member => ({ id: member })),
            // The graph store's own record that these sessions were spawned into
            // the graph, which is what tells a spawned session's absent store
            // apart from a member's named state.
            edges: [...entry.spawned].map(spawned => ({ kind: 'spawn', from: entry.spec.rootSessionId, to: spawned })),
          },
        }
      },
    }
    this.graphsService = graphsService
    const gateView = {
      phaseOf: (sessionId: string) => {
        this.observed.gatePhaseOf(sessionId)
        return this.gate.phaseOf(sessionId)
      },
    }
    const runtimeService = {
      recoveryStatus: async (storeId: string): Promise<StoreRecoveryStatus> => {
        this.observed.recoveryStatus(storeId)
        const recorded = this.recovery.get(storeId)
        if (recorded !== undefined) return recorded
        try {
          await this.task.openStore(storeId)
          return { status: 'ready' }
        } catch (error) {
          return { status: 'not-activated', reason: error instanceof Error ? error.message : String(error) }
        }
      },
      readRunBinding: async (binding: RunProviderBinding): Promise<RunBindingRead | undefined> => {
        this.observed.readRunBinding(binding)
        if (binding.snapshotRoot === undefined) return undefined
        const admitted = Object.values(GUIDANCE_BINDINGS).find(candidate =>
          candidate.snapshotRoot === binding.snapshotRoot && JSON.stringify(candidate) === JSON.stringify(binding))
        if (admitted !== undefined) return {
          snapshotRoot: binding.snapshotRoot,
          skills: admitted.skills.map(skill => ({ name: skill.name, role: skill.role,
            readable: true, defects: [], instructions: guidanceBodies[skill.name] })),
          defects: [],
        }
        const skills = binding.skills.map(skill => ({
          name: skill.name,
          role: skill.role,
          readable: false,
          defects: [`content-mismatch: ${binding.snapshotRoot}/${skill.name} is not the bound content`],
        }))
        return { snapshotRoot: binding.snapshotRoot, skills, defects: skills.flatMap(skill => skill.defects) }
      },
      allowsRuntimeDecomposition: () => this.runtimeDecomposition,
      gate: gateView,
    }
    const sessionQuery = {
      readSurface: async (sessionId: string) => {
        const log = this.logs.get(String(sessionId))
        if (log === undefined)
          throw sessionError(`session "${String(sessionId)}" has no log`, 'SESSION_QUERY_SESSION_NOT_FOUND')
        return { capturedThroughSeq: log.events.at(-1)?.seq ?? null }
      },
      readSession: async (sessionId: string) => {
        const log = this.logs.get(String(sessionId))
        if (log === undefined)
          throw sessionError(`session "${String(sessionId)}" has no log`, 'SESSION_QUERY_SESSION_NOT_FOUND')
        // The fixture's logs are never fork-inherited: the whole log is the
        // session's own suffix, which is what the consumption fold reads.
        return { session: { id: String(sessionId) }, inheritedEventCount: 0, events: log.events }
      },
      readEvent: async (request: { sessionId: string; seq: number; before?: number; after?: number }) => {
        const log = this.logs.get(String(request.sessionId))
        if (log === undefined)
          throw sessionError(`session "${String(request.sessionId)}" has no log`, 'SESSION_QUERY_SESSION_NOT_FOUND')
        const target = log.events.find(event => event.seq === request.seq)
        if (target === undefined) {
          throw sessionError(
            `session "${request.sessionId}" has no event at seq ${request.seq}`,
            'SESSION_QUERY_EVENT_NOT_FOUND',
          )
        }
        const start = Math.max(0, request.seq - (request.before ?? 0))
        const end = Math.min(log.events.length - 1, request.seq + (request.after ?? 0))
        return { target, events: log.events.slice(start, end + 1), startSeq: start, endSeq: end }
      },
    }
    this.ctx.provide('graphs', graphsService as never)
    this.ctx.provide('taskRuntime', runtimeService as never)
    this.ctx.provide('sessionQuery', sessionQuery as never)
    this.sessionQueryService = sessionQuery
    this.service = new SingularityContextService(this.ctx)
  }

  /** Publish one graph, with its root session among its members. */
  graph(spec: GraphSpec): void {
    this.graphs.set(spec.id, {
      spec: {
        id: spec.id,
        rootSessionId: spec.rootSessionId,
        name: spec.name ?? spec.id,
        envId: spec.envId ?? `env-${spec.id}`,
        members: [spec.rootSessionId, ...(spec.members ?? [])],
      },
      members: new Set([spec.rootSessionId, ...(spec.members ?? [])]),
      spawned: new Set(),
    })
  }

  /** Publish one session as **spawned** into a graph: the graph store's own `spawn` edge. */
  spawned(graphId: string, sessionId: string): void {
    this.member(graphId, sessionId)
    this.graphs.get(graphId)!.spawned.add(sessionId)
  }

  /** Publish one more member in a graph (a session that exists without a run of its own). */
  member(graphId: string, sessionId: string): void {
    const entry = this.graphs.get(graphId)
    if (entry === undefined) throw new Error(`fixture: unknown graph "${graphId}"`)
    entry.members.add(sessionId)
  }

  /** Write one session's durable log, so a session read has history to page through. */
  sessionLog(sessionId: string, texts: readonly string[]): void {
    const header: SessionHeader = { id: sessionId, cwd: '/fixture/env' } as unknown as SessionHeader
    this.headers.set(sessionId, header)
    // Seqs are per-session and dense from 0, the way a real log numbers them.
    this.logs.set(sessionId, { header, events: texts.map((text, index) => SESSION_TEXT(text, index, this.stamp())) })
  }

  /**
   * Append one identified relay message to a session's log — the `user/message`
   * event DSH writes when a claimed inbox message is put in front of the model.
   * This is the durable fact a consumption proof is read off (A4 §7.3): the
   * fixture writes exactly that event and nothing else, so "the model has been
   * given this message id" is the log's own record.
   */
  consumed(sessionId: string, messageId: string, text = `message ${messageId}`): void {
    const log = this.logs.get(sessionId)
    if (log === undefined) throw new Error(`fixture: session "${sessionId}" has no log`)
    log.events.push({
      type: 'user/message',
      seq: SessionSeq(log.events.length),
      time: this.stamp(),
      data: {
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: sessionId },
      },
    } as unknown as SessionEvent)
  }

  /**
   * Ask one question through the store's own entry (`askParentQuestionIn`): the
   * fixture supplies the citation, the identity comes from the (run, request
   * key) pair the store derives it from, and the parent run is the one the store
   * resolves from the asking task's parent — never a caller's choice.
   */
  async ask(spec: {
    readonly childRunId: string
    readonly requestKey: string
    readonly blocking?: boolean
    /** Where the body is; defaults to seq 0 of the asking run's own session, which this fixture always has. */
    readonly questionRef?: { readonly sessionId: string; readonly seq: number }
    readonly messageId?: string
  }): Promise<QuestionRecord> {
    const child = this.runFactsOf(spec.childRunId)
    const result = await this.task.askParentQuestionIn(
      child.storeId,
      {
        childRunId: spec.childRunId,
        requestKey: spec.requestKey,
        // The body is the Session's `tool/call`; this fixture does not model the
        // call, so the digest is a fixture value rounded to the request key.
        questionDigest: sha256Hex(`question:${spec.childRunId}:${spec.requestKey}`),
        questionRef: spec.questionRef ?? { sessionId: child.sessionId, seq: 0 },
        messageId: spec.messageId ?? `m-question-${spec.requestKey}`,
        blocking: spec.blocking ?? true,
      },
      child.sessionId,
    )
    return result.question
  }

  /**
   * Answer one question through the store's own entry
   * (`answerParentQuestionIn`): the answering run is the question's own parent
   * run, resolved from the record, and the citation is that run's session — the
   * same two checks the reducer applies.
   */
  async answer(spec: {
    readonly questionId: string
    readonly requestKey: string
    readonly resolves?: boolean
    readonly answerRef?: { readonly sessionId: string; readonly seq: number }
    readonly messageId?: string
  }): Promise<QuestionAnswerRecord> {
    const found = await this.findQuestion(spec.questionId)
    const result = await this.task.answerParentQuestionIn(
      found.storeId,
      {
        questionId: spec.questionId,
        parentRunId: found.question.parentRunId,
        requestKey: spec.requestKey,
        answerDigest: sha256Hex(`answer:${spec.questionId}:${spec.requestKey}`),
        resolves: spec.resolves ?? true,
        answerRef: spec.answerRef ?? { sessionId: found.parentSessionId, seq: 0 },
        messageId: spec.messageId ?? `m-answer-${spec.requestKey}`,
      },
      found.parentSessionId,
    )
    return result.answer
  }

  /** Seed one task, its admission, and its running run through the store's own entries. */
  async seed(spec: TaskSpec): Promise<void> {
    const storeId = rootTaskStoreId(this.rootOf(spec.sessionId))
    await this.store(storeId)
    const criteria: AcceptanceCriterion[] = [
      ...(spec.criteria ?? [
        {
          criterionId: `${spec.taskId}-c1`,
          description: `fixture criterion for ${spec.taskId}`,
          verificationMode: 'deterministic' as const,
          requiredEvidence: [],
          mandatory: true,
          protectedInputs: [{ path: `spec/${spec.taskId}.json`, sha256: hex(99) }],
        },
      ]),
    ]
    const task: TaskInstance = {
      taskId: spec.taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      ...(spec.parentTaskId === undefined ? {} : { parentTaskId: spec.parentTaskId }),
      objective: spec.objective,
      depth: spec.depth ?? 0,
      acceptanceCriteria: criteria,
      requestedCapabilities: [...(spec.providerBinding?.capabilities ?? [])],
      decompositionStatus: spec.decomposable === true ? 'decomposable' : 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
      contract: {
        contractVersion: 1,
        objective: spec.objective,
        acceptanceCriteria: criteria,
        assumptions: [...(spec.assumptions ?? [])],
        constraints: [...(spec.constraints ?? [])],
        requiredCapabilities: [...(spec.providerBinding?.capabilities ?? [])],
      },
    }
    await this.task.createTaskIn(storeId, task, spec.sessionId)
    await this.task.admitTaskIn(storeId, spec.taskId, spec.sessionId, {
      decompositionStatus: spec.decomposable === true ? 'decomposable' : 'leaf',
    })
    const run: TaskRun = {
      runId: spec.runId,
      taskId: spec.taskId,
      sessionId: spec.sessionId,
      ...(spec.parentRunId === undefined ? {} : { parentRunId: spec.parentRunId }),
      capabilitySnapshot: spec.providerBinding?.skills.map(skill => skill.name) ?? [],
      ...(spec.providerBinding === undefined ? {} : { providerBinding: spec.providerBinding }),
      ...(spec.phaseUnknown === true ? {} : { executionPhase: spec.phase ?? 'active' }),
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date(this.stamp()).toISOString(),
    }
    await this.task.startRunIn(storeId, run, spec.sessionId)
    for (const from of spec.dependencies ?? []) await this.dependency(from, spec.taskId)
  }

  /** Record the handoff envelope a parent passed to a child. */
  async handoff(init: {
    readonly parentTaskId: string
    readonly parentRunId: string
    readonly childTaskId: string
    readonly sessionId: string
    readonly parentObjective: string
    readonly reason: string
    readonly constraints?: readonly string[]
    readonly decisions?: readonly string[]
    readonly assumptions?: readonly string[]
    readonly openQuestions?: readonly string[]
    readonly artifacts?: readonly ArtifactRef[]
    readonly evidence?: readonly string[]
  }): Promise<void> {
    await this.task.recordHandoffIn(
      rootTaskStoreId(this.rootOf(init.sessionId)),
      {
        handoffId: `h-${init.childTaskId}`,
        parentTaskId: init.parentTaskId,
        parentRunId: init.parentRunId,
        childTaskId: init.childTaskId,
        parentObjective: init.parentObjective,
        reasonForDelegation: init.reason,
        constraints: [...(init.constraints ?? [])],
        decisions: [...(init.decisions ?? [])],
        relevantArtifacts: [...(init.artifacts ?? [])],
        relevantEvidence: [...(init.evidence ?? [])],
        assumptions: [...(init.assumptions ?? [])],
        openQuestions: [...(init.openQuestions ?? [])],
        parentSessionRef: init.sessionId,
        createdAt: new Date(this.stamp()).toISOString(),
      },
      init.childTaskId,
    )
  }

  /** Record one evidence bundle on a still-running run. */
  async evidence(spec: {
    readonly evidenceId: string
    readonly taskId: string
    readonly runId: string
    readonly sessionId: string
    readonly artifacts?: readonly ArtifactRef[]
  }): Promise<void> {
    const bundle: EvidenceBundle = {
      evidenceId: spec.evidenceId,
      taskRunId: spec.runId,
      taskId: spec.taskId,
      artifacts: [...(spec.artifacts ?? [])],
      verifierResults: [
        { criterionId: `${spec.taskId}-c1`, status: 'pass', verifierId: 'fixture-verifier', exitCode: 0 },
      ],
      claims: [
        {
          claimId: `${spec.evidenceId}-claim`,
          criterionId: `${spec.taskId}-c1`,
          status: 'pass',
          verifierId: 'fixture-verifier',
          artifactRefs: [],
        },
      ],
      generatedAt: new Date(this.stamp()).toISOString(),
    }
    await this.task.recordEvidenceIn(rootTaskStoreId(this.rootOf(spec.sessionId)), bundle, spec.sessionId)
  }

  /** Drive one run to `verified` and write the terminal review record that settles it. */
  async verify(spec: {
    readonly taskId: string
    readonly runId: string
    readonly sessionId: string
    readonly evidenceRefs?: readonly string[]
  }): Promise<void> {
    const storeId = rootTaskStoreId(this.rootOf(spec.sessionId))
    await this.task.markRunStatusIn(storeId, spec.taskId, spec.runId, 'verifying', spec.sessionId)
    await this.task.markRunStatusIn(storeId, spec.taskId, spec.runId, 'verified', spec.sessionId, {
      finishedAt: new Date(this.stamp()).toISOString(),
    })
    const review: ReviewRecord = {
      taskId: spec.taskId,
      runId: spec.runId,
      sessionId: spec.sessionId,
      outcome: 'verified',
      evidenceRefs: [...(spec.evidenceRefs ?? [])],
      anomalies: [],
      relatedTaskIds: [],
      durationMs: 1_000,
      criteria: [{ criterionId: `${spec.taskId}-c1`, verdict: 'pass', exitCode: 0 }],
    }
    await this.task.recordReviewIn(storeId, review, spec.sessionId)
  }

  /** Record one diagnosis on a task; the prose and the suggestions are the caller's, the fixture's only when it names none. */
  async diagnose(spec: {
    readonly taskId: string
    readonly diagnosisId: string
    readonly sessionId: string
    readonly evidenceRefs: readonly string[]
    /** A postmortem observation other than the fixture's, when the case is about what the slot holds. */
    readonly observedFailure?: string
    /** Suggestions other than none — a target type outside the nine included (A5). */
    readonly proposals?: Diagnosis['proposals']
    /** Judge nothing by leaving it out: the reviewer's answer need not carry judgements. */
    readonly judgements?: Diagnosis['judgements']
  }): Promise<void> {
    await this.task.recordDiagnosisIn(
      rootTaskStoreId(this.rootOf(spec.sessionId)),
      {
        diagnosisId: spec.diagnosisId,
        taskId: spec.taskId,
        observedFailure: spec.observedFailure ?? 'fixture failure',
        scope: 'this task',
        localizedCause: 'a fixture cause',
        evidenceRefs: [...spec.evidenceRefs],
        reviewRefs: [],
        confidence: 'medium',
        proposals: spec.proposals === undefined ? [] : [...spec.proposals],
        ...(spec.judgements === undefined ? {} : { judgements: [...spec.judgements] }),
      },
      spec.sessionId,
    )
  }

  /**
   * Move one run through the phase protocol's own entries: a phase change
   * (`active → waiting_children` with the batch id, or `→ submitted` with the
   * submission record) and/or a no-progress marking on an `active` run — the
   * store's own transitions, so the records a spec reads are the records the
   * protocol writes.
   */
  async runFacts(spec: {
    readonly taskId: string
    readonly runId: string
    readonly sessionId: string
    readonly phase?: TaskRun['executionPhase']
    readonly batchId?: string
    readonly submission?: SubmissionRecord
    /** The note the store requires of a progress marking; a fixture sentence stands in for the observation a runtime writes. */
    readonly noProgress?: { readonly rounds: number; readonly factCount: number; readonly note?: string }
  }): Promise<void> {
    const storeId = rootTaskStoreId(this.rootOf(spec.sessionId))
    if (spec.phase !== undefined) {
      await this.task.changeRunPhaseIn(storeId, spec.taskId, spec.runId, spec.sessionId, {
        phase: spec.phase,
        ...(spec.batchId === undefined ? {} : { batchId: spec.batchId }),
        ...(spec.submission === undefined ? {} : { submission: spec.submission }),
      })
    }
    if (spec.noProgress !== undefined) {
      await this.task.markRunProgressIn(storeId, spec.taskId, spec.runId, spec.sessionId, {
        kind: 'unsubmitted-idle',
        rounds: spec.noProgress.rounds,
        factCount: spec.noProgress.factCount,
        note: spec.noProgress.note ?? 'fixture: the run made no progress',
      })
    }
  }

  /** Record one obligation raised by a task. */
  async oblige(spec: {
    readonly obligationId: string
    readonly taskId: string
    readonly sessionId: string
  }): Promise<void> {
    await this.task.recordObligationIn(
      rootTaskStoreId(this.rootOf(spec.sessionId)),
      { obligationId: spec.obligationId, goal: 'fixture gap', criterion: 'a fixture check', sourceTaskId: spec.taskId },
      spec.sessionId,
    )
  }

  /**
   * Seed a task that settled `blocked` **without a run** and the runless review
   * record that follows it: the shape a review reference uses `runId: null` for.
   * The blocked transition is the one event the store's typed entries cannot
   * express without a run id, so it is committed raw — through the same commit
   * entry, with the reducer still judging it.
   */
  async seedBlockedWithoutRun(spec: {
    readonly taskId: string
    readonly sessionId: string
    readonly objective: string
    readonly reason: string
  }): Promise<void> {
    const storeId = rootTaskStoreId(this.rootOf(spec.sessionId))
    await this.store(storeId)
    const instance: TaskInstance = {
      taskId: spec.taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: 't-root',
      objective: spec.objective,
      depth: 1,
      acceptanceCriteria: [],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }
    await this.task.createTaskIn(storeId, instance, spec.sessionId)
    await this.task.admitTaskIn(storeId, spec.taskId, spec.sessionId, { decompositionStatus: 'leaf' })
    await this.task.commitIn(storeId, [
      {
        kind: 'TaskBlocked',
        taskId: spec.taskId,
        actor: spec.sessionId,
        timestamp: new Date(this.stamp()).toISOString(),
        payload: { reason: spec.reason },
        schemaVersion: 1,
      } as TaskEvent,
    ])
    const review: ReviewRecord = {
      taskId: spec.taskId,
      outcome: 'blocked',
      evidenceRefs: [],
      anomalies: [spec.reason],
      blockedBy: [{ taskId: 't-c2', outcome: 'failed' }],
    }
    await this.task.recordReviewIn(storeId, review, spec.sessionId)
  }

  /** One dependency edge: `from` must verify before `to` starts. */
  async dependency(from: string, to: string): Promise<void> {
    await this.task.addDependencyIn(rootTaskStoreId(this.rootOf(this.sessionOf(from))), { from, to }, 'fixture')
  }

  /** Set the recovery status the runtime stub reports for one store. */
  recoveryStatus(storeId: string, status: StoreRecoveryStatus): void {
    this.recovery.set(storeId, status)
  }

  /**
   * Make the registry's own lookup fail. This is a *read failure*, not the
   * registry's "no graph publishes this session" fact: the read path must
   * report it as a named failure and must never read it as a miss.
   */
  breakGraphQuery(error: Error = new Error('the graph registry cannot be read')): void {
    this.graphsService.graphForSession = async () => {
      throw error
    }
  }

  /** Make one graph's published-members view fail (the read a delegation's actor is checked against). */
  breakGraphView(error: Error = new Error('the graph store cannot be read'), graphId?: string): void {
    const read = this.graphsService.view.bind(this.graphsService)
    this.graphsService.view = async (id: string) => {
      if (graphId === undefined || id === graphId) throw error
      return await read(id)
    }
  }

  /** Mount the env-builder seam with a path that holds no repository. */
  mountEnvBuilder(): void {
    const source: EnvPathSource = { store: { get: () => ({ path: '/fixture/checkout' }) } }
    this.envPath = '/fixture/checkout'
    this.ctx.provide('envBuilder', source as never)
  }

  /** Do not mount envBuilder at all (the deployment without one). */
  unmountEnvBuilder(): void {
    this.envPath = undefined
  }

  /** Register one reviewer delegation source; the disposer removes it again. */
  bindingSource(source: ReviewerBindingSource): () => void {
    return this.service.registerReviewerBindingSource(source)
  }

  /** A source that answers one fixed record, or nothing. */
  ledger(record?: ReviewerBindingRecord): ReviewerBindingSource {
    return { read: async () => record }
  }

  /**
   * Make the session plane's whole-log read fail for one session. The read that
   * folds a consumption proof has to answer "was this message put in front of the
   * model?" from the log; a log that cannot be read must not be answered as "no".
   */
  breakSessionRead(sessionId: string, error: Error = new Error('the session log cannot be read')): void {
    const read = this.sessionQueryService.readSession.bind(this.sessionQueryService)
    this.sessionQueryService.readSession = async (id: string) => {
      if (String(id) === sessionId) throw error
      return await read(id)
    }
  }

  async snapshot(storeId: string): Promise<TaskSnapshot> {
    return await this.task.snapshotIn(storeId)
  }

  storeEvents(storeId: string): readonly TaskEvent[] {
    return this.stores.get(storeId)?.events ?? []
  }

  /** Every read this fixture's planes saw, so a spec can assert a read happened without a write. */
  observedCalls(): { recoveryStatus: number; readRunBinding: number; gatePhaseOf: number } {
    return {
      recoveryStatus: this.observed.recoveryStatus.mock.calls.length,
      readRunBinding: this.observed.readRunBinding.mock.calls.length,
      gatePhaseOf: this.observed.gatePhaseOf.mock.calls.length,
    }
  }

  /** The root session a store belongs to, derived from the store id every seeded task uses. */
  private rootOf(sessionId: string): string {
    for (const entry of this.graphs.values()) {
      if (entry.members.has(sessionId)) return entry.spec.rootSessionId
    }
    throw new Error(`fixture: session "${sessionId}" is in no graph`)
  }

  private sessionOf(taskId: string): string {
    for (const store of this.stores.values()) {
      const event = store.events.find(item => item.kind === 'TaskStarted' && item.taskId === taskId)
      if (event !== undefined) return String(event.sessionId)
    }
    throw new Error(`fixture: no run was seeded for task "${taskId}"`)
  }

  /** Where one seeded run lives: its store, its session, and the task it executes. */
  private runFactsOf(runId: string): { readonly storeId: string; readonly sessionId: string; readonly taskId: string } {
    for (const [storeId, store] of this.stores) {
      const event = store.events.find(item => item.kind === 'TaskStarted' && item.runId === runId)
      if (event !== undefined) return { storeId, sessionId: String(event.sessionId), taskId: String(event.taskId) }
    }
    throw new Error(`fixture: no run "${runId}" was seeded`)
  }

  /** One stored question with the store and the answering session its record names. */
  private async findQuestion(
    questionId: string,
  ): Promise<{ readonly storeId: string; readonly question: QuestionRecord; readonly parentSessionId: string }> {
    for (const storeId of this.stores.keys()) {
      const snapshot = await this.snapshot(storeId).catch(() => undefined)
      const question = snapshot === undefined ? undefined : questionOf(snapshot, questionId)
      if (question === undefined) continue
      const parent = snapshot?.runs.find(run => run.runId === question.parentRunId)
      if (parent === undefined) throw new Error(`fixture: question "${questionId}" names no run of this store`)
      return { storeId, question, parentSessionId: String(parent.sessionId) }
    }
    throw new Error(`fixture: no store holds question "${questionId}"`)
  }

  private async store(storeId: string): Promise<void> {
    try {
      await this.task.createStore(storeId)
    } catch (error) {
      if (!(error instanceof Error) || !/already (open|exists)/.test(error.message)) throw error
      await this.task.openStore(storeId)
    }
  }

  private record(entry: { spec: Required<GraphSpec> }): {
    id: string
    name: string
    envId: string
    rootSessionId: string
    graphStoreId: string
    layoutStoreId: string
  } {
    const { id, name, envId, rootSessionId } = entry.spec
    return {
      id,
      name,
      envId,
      rootSessionId,
      graphStoreId: `sg-g-${rootSessionId}`,
      layoutStoreId: `sg-l-${rootSessionId}`,
    }
  }

  private handle(id: string) {
    return {
      read: async () => ({ events: this.stores.get(id)?.events ?? [] }),
      append: async (records: readonly SessionEvent[]) => {
        const store = this.stores.get(id)
        if (store === undefined) throw new Error(`fixture: store "${id}" was never created`)
        for (const record of records) store.events.push((record as unknown as { data: TaskEvent }).data)
      },
      flush: async () => {},
      close: async () => {},
    }
  }

  private stamp(): number {
    this.time += 1_000
    return this.time
  }
}

function sessionError(text: string, code: string): Error {
  return Object.assign(new Error(text), { code })
}

/** Assert one read answered, and hand back its text and continuation. */
export function expectOk(result: ProjectedRead): ProjectedReadOk {
  if (!result.ok) throw new Error(`expected an answer, got the refusal "${result.refusal}": ${result.detail}`)
  return result
}

/** Assert one read refused by name, and hand back the detail. */
export function expectRefused(result: ProjectedRead, refusal: NamedRefusal): string {
  if (result.ok) throw new Error(`expected the refusal "${refusal}", got an answer: ${result.text.slice(0, 200)}`)
  if (result.refusal !== refusal)
    throw new Error(`expected the refusal "${refusal}", got "${result.refusal}": ${result.detail}`)
  return result.detail
}

/** Assert one resolution resolved (not the unbound arm), for a spec that needs the fields. */
export function expectResolved(resolution: CallerResolution): Exclude<CallerResolution, { kind: 'unbound' }> {
  if (resolution.kind === 'unbound') throw new Error(`expected a resolved caller, got unbound: ${resolution.detail}`)
  return resolution
}

/**
 * The standard three-layer graph: a root, two children (one of them the other's
 * dependency), a grandchild, and a replay task that is parentless inside the
 * same store — the store shape that makes "the first parentless task is the
 * root" a wrong read.
 */
export interface Chain {
  readonly storeId: string
  readonly graph: string
  readonly rootSession: string
  readonly root: { taskId: string; runId: string }
  readonly child: { taskId: string; runId: string }
  readonly grandchild: { taskId: string; runId: string }
  readonly sibling: { taskId: string; runId: string }
  readonly replay: { taskId: string; runId: string }
  readonly replaySession: string
}

export async function seedChain(stack: FixtureStack, rootSession = 's-root', brokenChildBinding = false): Promise<Chain> {
  const storeId = rootTaskStoreId(rootSession)
  const graphId = `g-${rootSession}`
  stack.graph({
    id: graphId,
    rootSessionId: rootSession,
    members: ['s-c1', 's-c2', 's-g1', 's-review', 's-replay'],
  })
  for (const [sessionId, text] of [
    [rootSession, 'build the release'],
    ['s-c1', 'child one: build the bridge'],
    ['s-c2', 'sibling: build the truss'],
    ['s-g1', 'grandchild: build the deck'],
    ['s-review', 'review agent'],
    ['s-replay', 'replay of the champion'],
  ] as const) {
    stack.sessionLog(sessionId, [`${text} (request)`, `${text} (follow-up)`])
  }
  await stack.seed({
    taskId: 't-root',
    sessionId: rootSession,
    runId: 'r-root',
    objective: 'build the release',
    constraints: ['never rewrite the accepted contract', 'keep the public API stable'],
    criteria: [
      {
        criterionId: 'root-c1',
        description: 'the release builds',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'pnpm build',
        protectedInputs: [{ path: 'release/thresholds.json', sha256: hex(77) }],
      },
    ],
    providerBinding: GUIDANCE_BINDINGS['release-coordination'],
  })
  await stack.seed({
    taskId: 't-c1',
    sessionId: 's-c1',
    runId: 'r-c1',
    objective: 'child one: build the bridge',
    parentTaskId: 't-root',
    depth: 1,
    constraints: ['no new dependency'],
    providerBinding: brokenChildBinding ? BINDING_WITH_SNAPSHOT : GUIDANCE_BINDINGS['bridge-construction'],
  })
  await stack.seed({
    taskId: 't-c2',
    sessionId: 's-c2',
    runId: 'r-c2',
    objective: 'sibling: build the truss',
    providerBinding: GUIDANCE_BINDINGS['truss-construction'],
    parentTaskId: 't-root',
    depth: 1,
  })
  await stack.seed({
    taskId: 't-g1',
    sessionId: 's-g1',
    runId: 'r-g1',
    objective: 'grandchild: build the deck',
    providerBinding: GUIDANCE_BINDINGS['deck-construction'],
    parentTaskId: 't-c1',
    depth: 2,
    dependencies: ['t-c2'],
  })
  await stack.handoff({
    parentTaskId: 't-root',
    parentRunId: 'r-root',
    childTaskId: 't-c1',
    sessionId: rootSession,
    parentObjective: 'build the release',
    reason: 'split the work into the bridge and the truss',
    constraints: ['stay inside the accepted contract'],
    decisions: ['the bridge carries the span'],
    assumptions: ['the truss exists'],
    openQuestions: ['which span?'],
    evidence: ['e-c2'],
    artifacts: [{ artifactId: 'a-spec', kind: 'spec', uri: 'docs/spec.md' }],
  })
  await stack.handoff({
    parentTaskId: 't-c1',
    parentRunId: 'r-c1',
    childTaskId: 't-g1',
    sessionId: 's-c1',
    parentObjective: 'child one: build the bridge',
    reason: 'the deck is a separate deliverable',
    constraints: ['no new dependency'],
    decisions: ['deck material decided'],
    assumptions: ['the truss is verified'],
    openQuestions: [],
    artifacts: [{ artifactId: 'a-plan', kind: 'plan', uri: 'docs/plan.md' }],
    evidence: ['e-c2'],
  })
  await stack.evidence({
    evidenceId: 'e-c2',
    taskId: 't-c2',
    runId: 'r-c2',
    sessionId: 's-c2',
    artifacts: [{ artifactId: 'a-truss', kind: 'product', uri: 'out/truss.bin', digest: hex(31) }],
  })
  await stack.verify({ taskId: 't-c2', runId: 'r-c2', sessionId: 's-c2', evidenceRefs: ['e-c2'] })
  await stack.diagnose({ taskId: 't-c2', diagnosisId: 'd-c2', sessionId: 's-c2', evidenceRefs: ['e-c2'] })
  await stack.seed({
    taskId: 't-replay',
    sessionId: 's-replay',
    runId: 'r-replay',
    objective: 'replay the champion candidate',
    providerBinding: GUIDANCE_BINDINGS['champion-replay'],
    parentRunId: 'r-root',
  })
  return {
    storeId,
    graph: graphId,
    rootSession,
    root: { taskId: 't-root', runId: 'r-root' },
    child: { taskId: 't-c1', runId: 'r-c1' },
    grandchild: { taskId: 't-g1', runId: 'r-g1' },
    sibling: { taskId: 't-c2', runId: 'r-c2' },
    replay: { taskId: 't-replay', runId: 'r-replay' },
    replaySession: 's-replay',
  }
}
