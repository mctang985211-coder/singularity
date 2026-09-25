/**
 * A whole deployment whose model is scripted: the real DSH loop, the real
 * singularity tool surface, and one script per session instead of a provider.
 *
 * What is replaced, and why:
 * - the model provider — {@link ScriptedModelAdapter} answers each request from
 *   the script of the session that asked (keyed by `GenerateOptions.sessionId`,
 *   the field the loop sets on every request). No network, no key, and the
 *   requests themselves are the record: their messages are what the loop would
 *   have sent, plugin notices included.
 * - `sessionPersistence` — an in-memory backend with the JSONL backend's
 *   contract shape, so the session log a spec reads back is the log the loop
 *   really appended through. Living sessions route their events into their
 *   write handle, which is what makes `eventsOf` a read of the durable surface
 *   and not of a fixture copy.
 * - the human seam (`ctx.approval`) — the review channel of the deployment is
 *   mounted as the deployment mounts it (`ProposalReviewService` at the service
 *   assembly) and asks through an answerer the spec drives: {@link
 *   ScriptedLoopOptions.approvalAnswer} decides each ask, or holds it until the
 *   spec answers it ({@link ScriptedLoop.review}). What the review *does* with
 *   an answer is the deployment's own code, never a fixture shortcut.
 *
 * Everything else is the deployment's own: `LlmRuntime`, `SessionStore`,
 * `SessionProjectionRegistry`, `SystemPrompt`, `ToolRuntime`, `AgentRegistry`,
 * `AgentLoop`, the real `AgentRuntime` (so `spawn` goes through
 * `ctx.agents.create` and the loop really starts the worker's turn), the real
 * `TaskService`/`TaskRuntime`/`VerifierRegistry`, and the real singularity
 * tools. The tool plane is the global registry rather than a mounted preset
 * scope: both the root's own allow-list (`ROOT_TOOLS`, applied by
 * `AgentRuntime`) and the worker grant (`grants.ts`) filter the inherited plane
 * the same way, so the surfaces here are the deployment's.
 *
 * Crash recovery is deliberately *not* this fixture's subject (a process-local
 * log cannot die): `tests/integration/a3-recovery.spec.ts` mounts the real JSONL
 * backend for that.
 * @module tests/support/scripted-loop
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { toolCallResponse, textResponse } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import LlmRuntime, { LlmAdapter, boundContextSummary, createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { ContentBlock, GenerateOptions, Message, StreamChunk } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import SessionStore, { SessionId, SESSION_FORMAT_VERSION } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent, SessionHeader } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../../thirdparty/deepseek-harness/packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../../../thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import AgentLoop from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/lib/index.js'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Agent, ToolDefinition } from '@deepseek-ai/dsh-agent'
import type { TaskInstance, TaskRun } from '../../task/src/types.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { TaskEvent, TaskSnapshot } from '../../task/src/index.ts'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../agent-runtime/src/types.ts'
import { SingularityContextService } from '../../context/src/index.ts'
import { ProposalReviewService } from '../../agent-singularity/src/proposal-review.ts'
import { defineCapabilityListTool } from '../../agent-singularity/src/tools/capability-list.ts'
import { defineContextReadTool } from '../../agent-singularity/src/tools/context-read.ts'
import { defineTaskAnswerTool } from '../../agent-singularity/src/tools/task-answer.ts'
import { defineTaskAskParentTool } from '../../agent-singularity/src/tools/task-ask-parent.ts'
import { defineTaskCancelTool } from '../../agent-singularity/src/tools/task-cancel.ts'
import { defineTaskDecomposeTool } from '../../agent-singularity/src/tools/task-decompose.ts'
import { defineTaskIntakeTool } from '../../agent-singularity/src/tools/task-intake.ts'
import { defineTaskProposalCancelTool } from '../../agent-singularity/src/tools/task-proposal-cancel.ts'
import { defineTaskProposalContinueTool } from '../../agent-singularity/src/tools/task-proposal-continue.ts'
import { defineTaskProposalReadTool } from '../../agent-singularity/src/tools/task-proposal-read.ts'
import { defineTaskReadTool } from '../../agent-singularity/src/tools/task-read.ts'
import { defineTaskStatusTool } from '../../agent-singularity/src/tools/task-status.ts'
import { defineTaskSubmitResultTool } from '../../agent-singularity/src/tools/task-submit-result.ts'
import type { CapabilityConfig, Config, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'
import { graphRegistry, sessionQueryReads } from './context-plane.ts'

/** The root agent's allow-list, exactly as `agent-runtime` composes it. Exported so a fixture that mounts no loop still composes the deployment's root surface. */
export const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_read', 'capability_list', 'context_read', 'skill', 'task_intake', 'task_decompose',
  'task_submit_result', 'task_answer', 'task_cancel', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'evolution_propose',
  'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'evolution_decide', 'evolution_apply', 'evolution_rollback', 'evolution_list', 'escalate',
]

/**
 * The deployment's other global tools: the worker baseline's plane plus the four
 * raw cross-session readers a deployment's `tool-session-query` mounts. Those
 * four are registered here as stand-ins on purpose — the seal this deployment
 * puts on them is an execution guard (`agent-runtime/src/raw-session-guard.ts`),
 * and a guard can only be shown to hold against a surface that would otherwise
 * answer the call.
 *
 * The global plane a fixture enumerates is `ROOT_TOOLS` plus this list, and the
 * two never overlap: `task_answer` (A4 §F.1) rides the root's own allow-list
 * (the root is a legal addressee), while `task_ask_parent` — which no root may
 * call — is named here. This fixture registers the **shipped** definition of
 * both, because a spec built on it runs the deployment's own tool surface. A
 * spec whose subject is the runtime entry rather than the tool asks for the
 * stand-in instead (`questionTools: 'stand-in'`), so the scripted call does not
 * perform the effect the spec is about to drive itself.
 */
export const OTHER_TOOLS = [
  'bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'ask_user_question',
  'web_fetch', 'subagent_fetchless', 'session_search', 'session_event_read', 'session_event_trace', 'session_trace',
  'task_ask_parent',
]

/** The tools this fixture registers for real; every other name is a stand-in. */
const REAL_TOOLS = [
  'task_read', 'task_status', 'context_read', 'capability_list', 'task_intake', 'task_decompose', 'task_submit_result', 'task_cancel',
  'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel',
  'task_ask_parent', 'task_answer',
]

/** The two question tools a spec can keep as stand-ins while it drives the runtime entries itself (`questionTools: 'stand-in'`). */
const QUESTION_TOOLS: readonly string[] = ['task_ask_parent', 'task_answer']

/**
 * The arguments of one scripted tool call: fixed, or derived at request time
 * from the calls already dispatched. The derived form is what lets a script
 * model a caller that acts on what it was told — a proposal id the previous
 * answer named, for instance — without the spec having to know it in advance.
 */
export type ScriptArguments =
  | Readonly<Record<string, unknown>>
  | ((calls: readonly ToolCallRecord[]) => Readonly<Record<string, unknown>>)

/** One scripted model answer: a tool call, a final text, a latch that blocks the request, or a hang. */
export type ScriptEntry =
  | { readonly tool: string; readonly args?: ScriptArguments }
  | { readonly text: string }
  /**
   * Block this request until the latch resolves, then answer from the *next*
   * entry in the same request. That is what keeps a session mid-turn ("in
   * flight") for as long as a spec needs, without ending its turn — an idle
   * session would be a different state for the runtime to read.
   */
  | { readonly waitFor: () => Promise<void> }
  /** Answer nothing and never finish: the request stays in flight until the turn is cancelled. */
  | { readonly hang: true }

/** One model request the adapter answered or is answering, with the texts the loop would have sent. */
export interface ScriptedRequest {
  readonly options: GenerateOptions
  /** Every text block of every message in the request, flattened for assertions. */
  readonly texts: readonly string[]
}

/** One tool call this deployment dispatched, in dispatch order. */
export interface ToolCallRecord {
  readonly order: number
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly args: unknown
  /** The settled answer, once the call reported a result — a deny is a result too. */
  result?: { readonly isError: boolean; readonly text: string }
}

/** One spawn the runtime asked the real `AgentRuntime` for. */
export interface ScriptedSpawn {
  readonly sessionId: string
  readonly name: string
  /**
   * The message the spawn carried, when it carried one. A task worker's spawn
   * carries none (A2): its contract and state are the context assembly's, and
   * its first user message is the runtime's default kickoff.
   */
  readonly prompt?: string
  /** Whether the spawn declared the child a task worker (`SpawnRequest.taskWorker`). */
  readonly taskWorker?: boolean
}

export interface ScriptedLoopOptions {
  readonly capabilities?: Readonly<Record<string, CapabilityConfig>>
  /** Root sessions of this deployment, in order; the first is the primary. Defaults to `['s-root']`. */
  readonly roots?: readonly string[]
  /** No-progress rounds before an unsubmitted worker is stopped. Defaults to the runtime's own (3). */
  readonly noProgressRounds?: number
  readonly verifyTimeoutMs?: number
  readonly writeDrainTimeoutMs?: number
  /** The per-run budget this deployment enforces (`Config.budget`) — the deadline a spec drives a blocked wait into. */
  readonly budget?: Readonly<{ maxToolCalls?: number; tokens?: number; wallTimeMs?: number; attempts?: number }>
  /** Tools whose recorded execution also keeps its arguments — the side-effect probe a denial is asserted against. */
  readonly probes?: readonly string[]
  /**
   * The root session the graph reports for one session, when a case needs a
   * session whose graph root is somebody else — `task_intake`'s own membership
   * rule (graph and root session) is then the thing under test. Defaults to the
   * deployment's own mapping: a root session is its own graph's root, and a
   * spawned session belongs to the tree that spawned it.
   */
  readonly graphRootFor?: (sessionId: string) => string | undefined
  /** The review policy this deployment runs under (`Config.generatedTaskReview`). Defaults to the runtime's own (`off`). */
  readonly generatedTaskReview?: 'off' | 'all'
  /**
   * Which `task_ask_parent`/`task_answer` a scripted call reaches: the shipped
   * definitions — the default, so a spec built on this fixture runs the
   * deployment's own tool surface — or the fixture's stand-ins, for a spec that
   * drives the runtime entries itself and needs the *call* to leave nothing but
   * its `tool/call` citation behind.
   */
  readonly questionTools?: 'shipped' | 'stand-in'
  /**
   * How the approval seam answers one review ask. Defaults to answering every
   * ask `allowed-once` — an answerer that decides without a person. Returning
   * `undefined`, or a promise for it, holds the ask open until the spec answers
   * it through {@link ScriptedReview.answer}, which is how a spec decides *when*
   * a person decides; the other three outcomes are the seam's own
   * (`rejected`, `cancelled`, `unavailable`).
   */
  readonly approvalAnswer?: (ask: ScriptedReviewAsk, index: number) => ApprovalOutcome | undefined | Promise<ApprovalOutcome | undefined>
  /**
   * The script of one session: index 0 is the primary root, 1..n the sessions
   * the runtime spawned, in spawn order. Entries are consumed one request at a
   * time; an exhausted script answers an empty text, which ends the turn.
   */
  readonly script: (sessionId: string, index: number) => readonly ScriptEntry[]
}

/** One review request the channel put to the approval seam, as the answerer saw it. */
export interface ScriptedReviewAsk {
  /** The owner session the review was shown in — the channel's own routing. */
  readonly sessionId: string
  /** The tool the ask names: `task_decompose` for a batch, `task_intake` for a root contract (A0 §1.3, stage C's rendering). */
  readonly toolName: string
  /** The rendered review material: the whole batch, the limits and the identity a decision would bind. */
  readonly reason: string
}

/** The name the deployment's channel gives a batch review ask (`proposal-review.ts:BATCH_REVIEW_TOOL_NAME`). */
const BATCH_REVIEW_TOOL = 'task_decompose'

/** The name the channel gives a root contract review ask (`proposal-review.ts:ROOT_REVIEW_TOOL_NAME`). */
const ROOT_REVIEW_TOOL = 'task_intake'

/**
 * The human seam of this deployment (T2/T3 §5–§6): the real review channel
 * mounted at the service assembly, over an approval answerer the spec drives.
 * Every ask is recorded, unanswered asks stay open for as long as the spec
 * wants a person to think, and the answer travels back through the channel's
 * own `decideProposal` path — so what a spec asserts is the deployment's
 * routing, not a fixture's shortcut.
 */
export interface ScriptedReview {
  /** Every review ask, in ask order — the channel call count a refusal asserts on. */
  readonly asks: readonly ScriptedReviewAsk[]
  /**
   * Every ask about a **batch** ({@link BATCH_REVIEW_TOOL}), in ask order. A
   * store's root contract is a subject of its own with its own lifecycle
   * (A0 §1.3), so a case about a batch's review reads and answers batch asks
   * rather than counting the setup's own.
   */
  readonly batchAsks: readonly ScriptedReviewAsk[]
  /** Every ask about a **root contract** ({@link ROOT_REVIEW_TOOL}), in ask order. */
  readonly rootAsks: readonly ScriptedReviewAsk[]
  /** Answer one held ask (ask order). An ask that has no answer held is refused by name. */
  answer(index: number, outcome: ApprovalOutcome): void
  /** Answer the `index`-th **batch** ask. An index no batch ask holds is refused by name. */
  answerBatch(index: number, outcome: ApprovalOutcome): void
  /** Answer the `index`-th **root contract** ask. An index no root ask holds is refused by name. */
  answerRoot(index: number, outcome: ApprovalOutcome): void
  /** How many asks were made and not answered yet. */
  pending(): number
}

export interface ScriptedLoop {
  readonly ctx: Context
  readonly runtime: TaskRuntime
  readonly task: TaskService
  readonly verifier: VerifierRegistry
  /**
   * The real `AgentRuntime` this stack mounts, for the deployment's own door into
   * a session: `prompt` is how `graphs.create` writes the setup text, and a case
   * needs it to model a graph whose root session holds the deployment's message
   * and no person's (A0 §1.10 — `source.kind === 'user'` is the person's marker).
   * Typed structurally so the fixture's recording subclass stays private.
   */
  readonly agentRuntime: { prompt(agent: Agent, prompt: readonly ContentBlock[]): Promise<void> }
  /** The review channel's asks and answers (T2/T3). */
  readonly review: ScriptedReview
  /** The tmp directory the whole fixture lives in. */
  readonly workspace: string
  /** The pinned `$DSH_HOME`/`$HOME`. */
  readonly home: string
  /** The env checkout every worker runs in and the verifier's commands run from. */
  readonly checkout: string
  /** Every spawn request, in order. */
  readonly spawns: readonly ScriptedSpawn[]
  /** Every tool call dispatched here, in order, deny included. */
  readonly calls: readonly ToolCallRecord[]
  /** Every stand-in body that actually ran, in order (`name`, or `name:{args}` for a probed tool) — a denied call never reaches one. */
  readonly executed: readonly string[]
  /** The requests of one session, in order, as the adapter saw them. */
  requestsOf(sessionId: SessionId | string): readonly ScriptedRequest[]
  /** One session's events, read back from the persistence backend the loop appended through. */
  eventsOf(sessionId: SessionId | string): readonly SessionEvent[]
  /** The store's snapshot as the store itself holds it. */
  snapshot(storeId: string): Promise<TaskSnapshot>
  /** The live agent of one session, as the registry holds it. */
  agent(sessionId?: SessionId | string): Agent
  /** The tool names one agent's own composition offers, from the registry's view. */
  visible(agent: Agent): string[]
  /**
   * Activate the root session's tree through the real intake entry and start the
   * root's first turn (A0 §1.1–§1.4). The contract is the spec's own — there is no
   * default, because the root's acceptance is the thing under test and a fixture
   * that invented one would be answering the question for it.
   *
   * Under policy `off` the intake activates in the same call and this returns its
   * ids. Under `all` the contract waits for a review (A0 §1.3) and the **fixture
   * plays the reviewer**: it answers the root contract's own ask through the same
   * desk a person's answer travels, and waits for the activation the channel's
   * recorded decision then performs. What the cases built on this see afterwards
   * is the state they assert on — an active root, and batch reviews of their own
   * ({@link ScriptedReview.batchAsks}). A spec whose subject *is* the intake
   * itself drives the tool instead, from the root agent's own script
   * (`tests/integration/root-intake.spec.ts`).
   */
  begin(contract: RootContractSpec): Promise<{ storeId: string; taskId: string; runId: string }>
  /**
   * Put one user message on a session's log and let its turn read it — what a
   * person typing at the root produces, and the entry a spec uses when the root's
   * *own* scripted turn is the thing under test (accepting the contract with
   * `task_intake`, reading the not-activated view first). The text lands on the
   * session's own log as a `user/message` event, so "which session carried the
   * request" is a fact a spec reads back rather than assumes.
   *
   * A session already running a turn queues the message for its next one, exactly
   * as the loop queues a person's follow-up.
   */
  userSays(text: string, sessionId?: SessionId | string): void
  /**
   * Put one **plugin-sourced** message on a session's log and let its turn read it
   * — {@link ScriptedLoop.userSays} in the runtime's own voice (`notify`'s shape,
   * `source.kind === 'plugin'`). A case that has to drive a root's turn *without*
   * any request of the person's on that session's log uses this: what the session
   * holds afterwards is a notice, which is exactly what a root contract's origin
   * must not accept (A0 §1.10).
   */
  pluginSays(text: string, sessionId?: SessionId | string): void
  /**
   * Record the person's request on a session's own durable log, **without**
   * driving a turn: the same `user/message` event with `source.kind === 'user'`
   * that `userSays` produces once the loop claims the queued message — written
   * through the session itself, so the logged event is the loop's own shape.
   *
   * A case whose subject is a *direct service call* states what the person asked
   * with this (there is no turn to carry the request), and the fixture's own
   * {@link ScriptedLoop.begin} does the same before it intakes — the runtime reads
   * a root contract's origin from that log and from nowhere else (A0 §1.10).
   */
  recordRequest(text: string, sessionId?: SessionId | string): void
  /** The run a session is bound to, with the store and task it belongs to. */
  runForSession(sessionId: SessionId | string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }>
  dispose(): Promise<void>
}

/** The stacks in play, so a spec's `afterEach` can dispose whatever a failed test left behind. */
const stacks: ScriptedLoopImpl[] = []

/** Dispose every stack started since the last call and release the pinned environment. */
export async function disposeScriptedLoops(): Promise<void> {
  for (const stack of stacks.splice(0)) await stack.dispose()
  vi.unstubAllEnvs()
}

/** Boot the stack. Every tmp path is created inside one newly minted workspace. */
export async function startScriptedLoop(options: ScriptedLoopOptions): Promise<ScriptedLoop> {
  const stack = new ScriptedLoopImpl(options)
  stacks.push(stack)
  return stack.start()
}

/** A stand-in for one tool name: it answers its own name, and records that its body ran. */
function standIn(name: string, ran: (name: string, args: unknown) => void): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
    execute: async (args: unknown) => {
      ran(name, args)
      return `${name}: fixture answer`
    },
  }
}

/** Wait for one latch, or reject when the turn is cancelled: a parked request must not outlive its turn. */
async function raceAbort(latch: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return await latch
  if (signal.aborted) throw new Error('aborted')
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { reject(new Error('aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
    void latch.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error as Error)
      },
    )
  })
}

/** Every text block the loop put in one request, in message order. */
function requestTexts(messages: readonly Message[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'text') texts.push(block.text)
  }
  return texts
}

/**
 * The scripted provider: one script per session, consumed one request at a
 * time. The chunk builders are DSH's own (`agent-loop/tests/mock-adapter.ts`),
 * so what a scripted tool call looks like on the wire is the shape the real
 * loop's tests use, not a second implementation of it.
 */
class ScriptedModelAdapter extends LlmAdapter {
  private readonly requests = new Map<string, ScriptedRequest[]>()
  private readonly queues = new Map<string, ScriptEntry[]>()
  private callSeq = 0

  constructor(
    private readonly script: (sessionId: string, index: number) => readonly ScriptEntry[],
    private readonly indexOf: (sessionId: string) => number,
    private readonly calls: () => readonly ToolCallRecord[],
  ) {
    super()
  }

  requestsOf(sessionId: string): readonly ScriptedRequest[] {
    return this.requests.get(sessionId) ?? []
  }

  private queueFor(sessionId: string): ScriptEntry[] {
    const existing = this.queues.get(sessionId)
    if (existing !== undefined) return existing
    const created = [...this.script(sessionId, this.indexOf(sessionId))]
    this.queues.set(sessionId, created)
    return created
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = String(options.sessionId ?? '')
    const queue = this.queueFor(sessionId)
    const recorded = this.requests.get(sessionId) ?? []
    recorded.push({ options, texts: requestTexts(options.messages) })
    this.requests.set(sessionId, recorded)

    let entry: ScriptEntry | undefined
    for (;;) {
      entry = queue.shift()
      if (entry === undefined) break
      if ('waitFor' in entry) {
        await raceAbort(entry.waitFor(), options.signal)
        continue
      }
      break
    }
    if (entry === undefined) {
      // The script is spent: the model answers nothing and the turn ends, which
      // is how a scripted session finishes the work it was given.
      yield* textResponse('')
      return
    }
    if ('hang' in entry) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'still working' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      return
    }
    if ('text' in entry) {
      yield* textResponse(entry.text)
      return
    }
    this.callSeq += 1
    const args = typeof entry.args === 'function' ? entry.args(this.calls()) : entry.args ?? {}
    yield* toolCallResponse(`call-${sessionId}-${this.callSeq}`, entry.tool, { ...args })
  }
}

/** One stored session: the header and the events every handle of it shares. */
interface StoredSession {
  header: SessionHeader
  events: SessionEvent[]
}

/**
 * The answerer half of the deployment's review channel: it records every ask,
 * and answers each one only when the spec says so — or immediately, when an
 * `approvalAnswer` is configured. A held ask is the seam's own shape: a person
 * takes as long as they take, and the channel settles it asynchronously.
 */
class ReviewDesk implements ScriptedReview {
  readonly asks: ScriptedReviewAsk[] = []
  private readonly held = new Map<number, (outcome: ApprovalOutcome) => void>()

  constructor(private readonly answer_: ScriptedLoopOptions['approvalAnswer']) {}

  async request(request: { toolName?: string; reason?: string; agent?: { id?: string } }): Promise<ApprovalOutcome> {
    const index = this.asks.length
    this.asks.push({
      sessionId: String(request.agent?.id ?? ''),
      toolName: String(request.toolName ?? ''),
      reason: String(request.reason ?? ''),
    })
    const decided = await this.answer_?.(this.asks[index]!, index)
    if (decided !== undefined) return decided
    return await new Promise<ApprovalOutcome>(resolve => { this.held.set(index, resolve) })
  }

  answer(index: number, outcome: ApprovalOutcome): void {
    const resolve = this.held.get(index)
    if (resolve === undefined) throw new Error(`review ask ${index} is not waiting for an answer`)
    this.held.delete(index)
    resolve(outcome)
  }

  get batchAsks(): readonly ScriptedReviewAsk[] {
    return this.asks.filter(ask => ask.toolName === BATCH_REVIEW_TOOL)
  }

  get rootAsks(): readonly ScriptedReviewAsk[] {
    return this.asks.filter(ask => ask.toolName === ROOT_REVIEW_TOOL)
  }

  answerBatch(index: number, outcome: ApprovalOutcome): void {
    this.answer(this.indexOfAsk(this.batchAsks, index, 'batch'), outcome)
  }

  answerRoot(index: number, outcome: ApprovalOutcome): void {
    this.answer(this.indexOfAsk(this.rootAsks, index, 'root contract'), outcome)
  }

  /** The ask's position in the raw list a subject-scoped index names, refused by name when that ask does not exist. */
  private indexOfAsk(asks: readonly ScriptedReviewAsk[], index: number, subject: string): number {
    const ask = asks[index]
    if (ask === undefined) {
      throw new Error(
        `no ${subject} review ask ${index} was made (this desk was asked about ${asks.length} ${subject}(s) out of ${this.asks.length} ask(s))`,
      )
    }
    return this.asks.indexOf(ask)
  }

  pending(): number {
    return this.held.size
  }
}

class ScriptedLoopImpl implements ScriptedLoop {
  readonly workspace: string
  readonly home: string
  readonly checkout: string
  private readonly roots: readonly SessionId[]
  readonly ctx: Context
  readonly task: TaskService
  readonly review: ReviewDesk
  /** Assigned by `start()`, after the plugins they are mounted as. */
  verifier!: VerifierRegistry
  runtime!: TaskRuntime
  private readonly storeId: string
  readonly adapter: ScriptedModelAdapter
  private readonly log = new Map<string, StoredSession>()
  private readonly sessionRoot = new Map<string, string>()
  private readonly spawnRecords: ScriptedSpawn[] = []
  private readonly callRecords: ToolCallRecord[] = []
  private readonly executedNames: string[] = []
  private readonly primary: SessionId
  private previousHome: string | undefined
  private callOrder = 0

  constructor(private readonly options: ScriptedLoopOptions) {
    this.workspace = mkdtempSync(join(tmpdir(), 'singularity-scripted-loop-'))
    this.checkout = join(this.workspace, 'env')
    this.home = join(this.workspace, 'dsh-home')
    mkdirSync(this.checkout, { recursive: true })
    mkdirSync(join(this.home, 'skills'), { recursive: true })
    this.roots = (options.roots ?? ['s-root']).map(id => id as SessionId)
    this.primary = this.roots[0]!
    this.storeId = rootTaskStoreId(this.primary)
    this.ctx = new Context()
    this.previousHome = process.env.DSH_HOME
    vi.stubEnv('DSH_HOME', this.home)
    vi.stubEnv('HOME', this.home)
    process.env.DSH_HOME = this.home
    for (const root of this.roots) this.sessionRoot.set(root, root)
    this.review = new ReviewDesk(options.approvalAnswer)
    this.adapter = new ScriptedModelAdapter(options.script, sessionId => {
      const rootIndex = this.roots.indexOf(sessionId as SessionId)
      if (rootIndex >= 0) return rootIndex
      const spawned = this.spawnRecords.findIndex(record => record.sessionId === sessionId)
      return spawned < 0 ? this.roots.length : this.roots.length + spawned
    }, () => this.callRecords)
    this.task = new TaskService(this.ctx)
  }

  async start(): Promise<this> {
    const ctx = this.ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.effect(() => ctx.llm.registerAdapter(['mock'], this.adapter))
    for (const header of this.roots) {
      this.log.set(header, {
        header: {
          version: SESSION_FORMAT_VERSION,
          id: header,
          createdAt: Date.now(),
          isSeeded: false,
          cwd: this.checkout,
          agentPreset: 'standard',
        } as unknown as SessionHeader,
        events: [],
      })
    }
    ctx.provide('sessionPersistence', {
      list: async () => [...this.log.values()].map(stored => ({ header: stored.header })),
      create: async (header: SessionHeader) => {
        if (this.log.has(header.id)) throw new Error(`session "${header.id}" already exists`)
        this.log.set(header.id, { header, events: [] })
        return this.handle(header.id, 'write')
      },
      open: async (id: SessionId, access: 'read' | 'write' = 'read') => {
        if (!this.log.has(id)) throw new Error(`missing session ${id}`)
        return this.handle(id, access)
      },
      flush: async () => {},
    } as never)
    // The fixture's backend appends into its own log synchronously, so its
    // durability barrier has nothing left to do — but the barrier has to *exist*:
    // the A4 delivery path flushes a Session before it trusts a cited body, and a
    // Session with no `session/flush` participant is refused by name
    // (`source-not-durable`). One no-op listener is this in-memory backend's way
    // of saying "what you appended is already where the next reader finds it".
    ctx.on('session/flush', () => {})
    // The deployment's other services. The loop's own turn drives everything
    // else, so these are the seams a graph deployment provides and nothing more.
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
    ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
    ctx.provide('permissionPresets', { set: vi.fn(), resolve: () => ({}) })
    // The human seam, driven by the spec: the channel below asks through it, and
    // a spec that cares about *whether* a person was asked asserts on `review`.
    ctx.provide('approval', { request: (request: { toolName?: string; reason?: string; agent?: { id?: string } }) => this.review.request(request) })
    ctx.provide('userQuestions', { ask: async () => ({ answers: [] }) })
    ctx.provide('layout', { setIn: async () => {} })
    const graphState = {
      version: 1,
      id: 'g1',
      roots: [...this.roots],
      agents: this.roots.map(id => ({ id, name: 'Singularity', status: 'idle' as const })),
      groups: [] as unknown[],
      edges: [] as unknown[],
    }
    ctx.provide('graph', {
      snapshotIn: async () => structuredClone(graphState),
      commitIn: async (_storeId: string, events: readonly { kind: string; agent?: { id: string; name: string; status: string }; edge?: unknown }[]) => {
        for (const event of events) {
          if (event.kind === 'agent/add' && event.agent !== undefined) graphState.agents.push(event.agent as never)
          if (event.kind === 'edge/add' && event.edge !== undefined) graphState.edges.push(event.edge)
        }
      },
      setStatusIn: async () => {},
      addAgentIn: async (_storeId: string, agent: { id: string; name: string; status: string }) => { graphState.agents.push(agent as never) },
    } as never)
    ctx.provide('graphs', graphRegistry({
      graphForSession: async (sessionId: SessionId) => ({
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: this.options.graphRootFor?.(String(sessionId)) ?? this.sessionRoot.get(sessionId) ?? this.primary,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }),
      list: async () => [{
        id: 'g1',
        name: 'graph',
        envId: 'env1',
        rootSessionId: this.primary,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }],
      // Membership is the graph store's own record — the node a root or a spawn
      // published — so a session reference is checked against it before any log
      // is read.
      members: () => [
        ...this.roots.map(String),
        ...graphState.agents.map(agent => String(agent.id)),
        ...this.sessionRoot.keys(),
      ],
      // The graph store's own edges, the record a spawned session leaves behind.
      edges: () => graphState.edges.flatMap(edge => {
        const candidate = edge as { kind?: string; from?: string; to?: string }
        return typeof candidate.kind === 'string' && typeof candidate.from === 'string' && typeof candidate.to === 'string'
          ? [{ kind: candidate.kind, from: candidate.from, to: candidate.to }]
          : []
      }),
    }) as never)
    // The session plane's read-only half (A2): exact reads over this fixture's own
    // log, the same records `eventsOf` returns.
    ctx.provide('sessionQuery', sessionQueryReads(sessionId => this.log.get(String(sessionId))?.events) as never)
    ctx.provide('envBuilder', { store: { get: (envId: string) => (envId === 'env1' ? { path: this.checkout, components: [] } : undefined) } } as never)

    // The tool plane: the real singularity tools, stand-ins for the rest, and a
    // probe for the names a spec wants proof about.
    const probe = new Set(this.options.probes ?? [])
    const register = (name: string): void => {
      ctx.tools.register(standIn(name, (ran, args) => {
        if (probe.has(ran)) this.executedNames.push(`${ran}:${JSON.stringify(args ?? {})}`)
        else this.executedNames.push(ran)
      }))
    }
    const shippedQuestionTools = this.options.questionTools !== 'stand-in'
    for (const name of [...ROOT_TOOLS, ...OTHER_TOOLS]) {
      if (REAL_TOOLS.includes(name) && (shippedQuestionTools || !QUESTION_TOOLS.includes(name))) continue
      register(name)
    }
    ctx.tools.register(defineTaskReadTool(ctx))
    ctx.tools.register(defineTaskStatusTool(ctx))
    ctx.tools.register(defineContextReadTool(ctx))
    ctx.tools.register(defineCapabilityListTool(ctx))
    // The real root intake (A0 stage C): a spec that drives the root's own turn
    // reaches activation through the deployment's tool, not through a service call
    // the tool would have made.
    ctx.tools.register(defineTaskIntakeTool(ctx))
    ctx.tools.register(defineTaskDecomposeTool(ctx))
    ctx.tools.register(defineTaskSubmitResultTool(ctx))
    ctx.tools.register(defineTaskCancelTool(ctx))
    ctx.tools.register(defineTaskProposalReadTool(ctx))
    ctx.tools.register(defineTaskProposalContinueTool(ctx))
    ctx.tools.register(defineTaskProposalCancelTool(ctx))
    // The shipped question tools (A4 §F.1, sub-goal ③c): a scripted
    // `task_ask_parent`/`task_answer` runs the deployment's own definition, so a
    // spec that never calls a runtime entry itself still exercises the whole
    // path — the model's call, the tool, the store, the delivery.
    if (shippedQuestionTools) {
      ctx.tools.register(defineTaskAskParentTool(ctx))
      ctx.tools.register(defineTaskAnswerTool(ctx))
    }

    // The dispatch record: every call the deployment ran through the registry,
    // deny included (a denied call reports a result too), in order.
    ctx.on('tools/result', (exec, result) => {
      const record = this.callRecords.find(item => item.callId === String(exec.callId))
      if (record === undefined) return
      const text = (result.content ?? [])
        .map(block => (block.type === 'text' ? block.text : `[${block.type}]`))
        .join('\n')
      record.result = { isError: result.isError === true, text }
    })
    // Live events of every announced session land in its stored log, which is
    // what makes `eventsOf` a read of the durable surface.
    ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
      this.log.get(String(session.id))?.events.push(event)
    })

    this.agentRuntime = new RecordingAgentRuntime(ctx, request => this.spawnRecords.push({
      sessionId: String(request.sessionId),
      name: request.name,
      ...(request.prompt === undefined
        ? {}
        : { prompt: request.prompt.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n') }),
      ...(request.taskWorker === undefined ? {} : { taskWorker: request.taskWorker }),
    }))
    await ctx.plugin(AgentLoop, { agents: [] })
    // The verifier and the runtime are mounted the way the deployment's loader
    // mounts them, not constructed beside it: `[Service.init]` is what registers
    // the runtime's gate on `tools/pre-execute`/`tools/result`, so a fixture that
    // built the service with `new` would run every tool call ungated.
    await ctx.plugin(VerifierRegistry, { evidenceRoot: join(this.workspace, 'evidence') })
    this.verifier = ctx.get('verifier') as VerifierRegistry
    await ctx.plugin(TaskRuntime, {
      capabilities: { ...(this.options.capabilities ?? {}) },
      ...(this.options.noProgressRounds === undefined ? {} : { noProgressRounds: this.options.noProgressRounds }),
      ...(this.options.verifyTimeoutMs === undefined ? {} : { verifyTimeoutMs: this.options.verifyTimeoutMs }),
      ...(this.options.writeDrainTimeoutMs === undefined ? {} : { writeDrainTimeoutMs: this.options.writeDrainTimeoutMs }),
      ...(this.options.budget === undefined ? {} : { budget: { ...this.options.budget } }),
      ...(this.options.generatedTaskReview === undefined ? {} : { generatedTaskReview: this.options.generatedTaskReview }),
      runBindingRoot: join(this.home, 'singularity', 'run-bindings'),
    } as Config)
    this.runtime = ctx.get('taskRuntime') as TaskRuntime
    // The read core and the prompt assembly (A2): mounted where the deployment's
    // bundle mounts it — after the runtime it observes, before the agent plane it
    // serves — so every model request this fixture runs is assembled with the
    // real sections and read by the real tools.
    await ctx.plugin(SingularityContextService)
    // The review channel, mounted where the deployment mounts it — at the service
    // assembly, not on any agent's tool plane — so a review of this store's
    // batches is routed through the approval seam above, and a worker can never
    // decide one.
    new ProposalReviewService(ctx)
    // The call record goes in front of the gate's own pre-execute listener,
    // because a denial short-circuits the waterfall and would otherwise leave a
    // refused call unrecorded. Registered here — after the runtime's own
    // `prepend` — so `unshift` puts this listener first.
    ctx.on('tools/pre-execute', (exec, next) => {
      const known = this.callRecords.find(record => record.callId === String(exec.callId))
      if (known !== undefined) return next()
      this.callOrder += 1
      this.callRecords.push({
        order: this.callOrder,
        sessionId: String(exec.agent?.id ?? ''),
        callId: String(exec.callId),
        name: String(exec.name),
        args: exec.arguments,
      })
      return next()
    }, { prepend: true })
    // The root agents the real loop's own entry mints: `resumeRoot` reads the
    // graph, the persisted header and the agent preset, so what runs here is the
    // deployment's root composition (its prompt section and its allow-list).
    for (const root of this.roots) await this.agentRuntime.ensureRoot(root, { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' })
    return this
  }

  agentRuntime!: RecordingAgentRuntime

  private handle(id: SessionId, access: 'read' | 'write') {
    const stored = (): StoredSession => {
      const found = this.log.get(String(id))
      if (found === undefined) throw new Error(`missing session ${id}`)
      return found
    }
    return {
      id,
      header: stored().header,
      access,
      inheritedEventCount: 0,
      read: async (offset = 0, length?: number) => ({ eventState: 'detached' as const, events: stored().events.slice(offset, length === undefined ? undefined : offset + length) }),
      append: async (events: readonly SessionEvent[]) => {
        stored().events.push(...events)
      },
      flush: async () => {},
      close: async () => {},
    }
  }

  get spawns(): readonly ScriptedSpawn[] {
    return this.spawnRecords
  }

  get calls(): readonly ToolCallRecord[] {
    return this.callRecords
  }

  get executed(): readonly string[] {
    return this.executedNames
  }

  requestsOf(sessionId: SessionId | string): readonly ScriptedRequest[] {
    return this.adapter.requestsOf(String(sessionId))
  }

  eventsOf(sessionId: SessionId | string): readonly SessionEvent[] {
    return this.log.get(String(sessionId))?.events ?? []
  }

  async snapshot(storeId: string): Promise<TaskSnapshot> {
    return await this.task.snapshotIn(storeId)
  }

  /** The live agent of one session, from the real loop's registry. */
  agent(sessionId: SessionId | string = this.primary): Agent {
    const agent = this.ctx.agents.get(String(sessionId))
    if (agent === undefined) throw new Error(`the stack holds no live agent for "${sessionId}"`)
    return agent
  }

  /** The tool names one agent's own composition offers, from the registry's view. */
  visible(agent: Agent): string[] {
    return this.ctx.tools.schemas(agent).map(schema => schema.name).sort()
  }

  async runForSession(sessionId: SessionId | string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }> {
    return await this.runtime.runForSession(String(sessionId))
  }

  async begin(contract: RootContractSpec): Promise<{ storeId: string; taskId: string; runId: string }> {
    // The person asked for exactly this objective, and that request is on the root
    // session's own durable log before the intake reads it (A0 §1.10): `begin` is a
    // direct service call, so the request is recorded rather than queued, and the
    // root's scripted turn below still starts with its script untouched.
    this.recordRequest(contract.objective)
    const rootAsksBefore = this.review.rootAsks.length
    const submitted = await this.runtime.intakeRootContract(this.storeId, this.primary, contract)
    let rootTaskId: string
    let rootRunId: string
    if (submitted.status === 'activated') {
      rootTaskId = submitted.taskId
      rootRunId = submitted.runId
    } else {
      // Under policy `all` the root contract is held for a review exactly as a
      // batch is (A0 §1.3), and nothing exists until a decision is recorded. The
      // fixture answers that ask through the desk — decided by the owner session,
      // as a person's answer is — and reads the ids back from the store instead of
      // calling an admission entry a person could not reach. The deployment's own
      // channel is the one that was asked: a root contract's rendering is stage C's,
      // and the ask it raised here is the review this case's setup stands on.
      await this.awaitRootAsk(rootAsksBefore, submitted.proposalId)
      this.review.answerRoot(rootAsksBefore, 'allowed-once')
      const activated = await this.awaitRootActivation(submitted.proposalId)
      rootTaskId = activated.taskId
      rootRunId = activated.runId
    }
    this.userSays('begin')
    return { storeId: this.storeId, taskId: rootTaskId, runId: rootRunId }
  }

  userSays(text: string, sessionId: SessionId | string = this.primary): void {
    this.agent(sessionId).followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  }

  pluginSays(text: string, sessionId: SessionId | string = this.primary): void {
    this.agent(sessionId).followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'task-runtime', form: 'notice', summary: boundContextSummary(text) },
    }))
  }

  recordRequest(text: string, sessionId: SessionId | string = this.primary): void {
    const id = SessionId(String(sessionId))
    const session = this.ctx.sessions.get(id)
    if (session === undefined) throw new Error(`the stack holds no live session for "${String(sessionId)}"`)
    // The session's own `append` is what the loop itself uses to put the message it
    // claimed on the log, so the event a reader finds here is the loop's shape —
    // including the surface intent and the sequence number the session assigns.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }

  /** Wait for the review the submission asked for to reach the desk, or report why no ask came. */
  private async awaitRootAsk(rootAsksBefore: number, proposalId: string): Promise<void> {
    try {
      await vi.waitFor(
        () => { expect(this.review.rootAsks.length).toBeGreaterThan(rootAsksBefore) },
        { timeout: 20_000, interval: 25 },
      )
    } catch (error) {
      const waiting = await this.runtime.proposalIn(this.storeId, proposalId).catch(() => undefined)
      throw new Error(
        `the fixture expected the review channel to ask about root contract ${proposalId}, but no root review ask was made: the proposal is ` +
        `${waiting?.status ?? 'unreadable'} (${waiting?.detail ?? String(error)})`,
      )
    }
  }

  /**
   * Wait for the root task the approved contract became, read from the store. The
   * recording of a decision is deliberately off the asking tick (§5: the channel
   * settles the ask asynchronously, so the runtime's per-store lock is not held
   * while a person thinks), so the activation that follows the fixture's answer is
   * observed here rather than awaited from a call this fixture made.
   */
  private async awaitRootActivation(proposalId: string): Promise<{ taskId: string; runId: string }> {
    let root: { taskId: string; runId: string } | undefined
    try {
      await vi.waitFor(async () => {
        const snapshot = await this.task.snapshotIn(this.storeId)
        const task = snapshot.tasks.find(candidate => candidate.parentTaskId === undefined)
        const run = task === undefined
          ? undefined
          : snapshot.runs.find(candidate => candidate.taskId === task.taskId && candidate.sessionId === String(this.primary))
        if (task === undefined || run === undefined) {
          throw new Error(
            `the store holds ${snapshot.tasks.length} task(s) and no root run for session "${String(this.primary)}"`,
          )
        }
        root = { taskId: task.taskId, runId: run.runId }
      }, { timeout: 20_000, interval: 25 })
    } catch (error) {
      const waiting = await this.runtime.proposalIn(this.storeId, proposalId).catch(() => undefined)
      throw new Error(
        `the fixture approved root contract ${proposalId} but no root task was activated: the proposal is ${waiting?.status ?? 'unreadable'} ` +
        `(${waiting?.detail ?? String(error)})`,
      )
    }
    return root!
  }

  async dispose(): Promise<void> {
    if (this.previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = this.previousHome
    await this.ctx.fiber.dispose()
    rmSync(this.workspace, { recursive: true, force: true })
  }
}

/**
 * The real `AgentRuntime`, with the root agent minted by the real loop
 * (`ensureRoot`) and every spawn recorded. Nothing about the spawn path is
 * replaced: `spawn` resolves the live parent from the registry, calls
 * `ctx.agents.create` (the loop's own factory), which mints the worker's
 * session, scope and first turn.
 */
class RecordingAgentRuntime extends AgentRuntime {
  constructor(
    ctx: Context,
    private readonly onSpawn: (request: SpawnRequest) => void,
  ) {
    super(ctx)
  }

  override async spawn(parent: Agent, request: SpawnRequest) {
    this.onSpawn(request)
    return await super.spawn(parent, request)
  }
}
