/**
 * R1: the real singularity deployment with a real model provider.
 *
 * What this stack is, and what it is not:
 * - Everything that judges, spawns, verifies, decomposes, intakes, submits and
 * settles is the production code: `LlmRuntime`/`SessionStore`/
 * `SessionProjectionRegistry`/`SystemPrompt`/`ToolRuntime`/`AgentRegistry`/
 * `AgentLoop`, the real `TaskRuntime` (with the fixed `rootBudget` and
 * `generatedTaskReview: 'off'`), the real `AgentRuntime.spawn`, the real
 * `VerifierRegistry` with its built-in `CommandVerifier`/`CompositeVerifier`,
 * and the real singularity tools (`task_intake`, `task_decompose`,
 * `task_submit_result`, `task_read`, …, plus the real `hitl_ask`/`hitl_approve`
 * and the real worker file tools).
 * - What is replaced: the model provider is the production `DeepSeekAdapter`
 * pointed at the configured StepFun gateway (chat-completions protocol,
 * `step-5-preview`, reasoning effort `high`); the session log is a real JSONL
 * file under the scenario's isolated `dsh-home`; the human seams
 * (`approval`, `userQuestions`) are answered by a fixture desk whose answers
 * are fixed and recorded; `graph`/`graphs`/`envBuilder` are the fixed fixtures
 * `tests/support/scripted-loop.ts` uses, with the checkout being the
 * scenario's own `repo/` directory. `evolution_*` are stand-ins and are
 * absent from the root surface (the deployment's evolution switch is off).
 *
 * The worker file tools (`read`/`write`/`edit`/`glob`/`grep`/`bash`/
 * `ask_user_question`) are the real DSH tool plugins mounted once on the
 * shared plane, exactly as a deployment's host plane mounts them; a spawned
 * worker inherits that plane and the capability grant (`grants.ts`) filters
 * it. The root's own allow-list (`ROOT_TOOLS`) filters the same plane, so the
 * root surface carries no file tool.
 *
 * Usage accounting is the adapter layer: an `llm/stream` waterfall listener
 * records every response's usage per session, and `tools/pre-execute`
 * records every dispatched tool call per session. There is no in-flight
 * enforcement — the fixed contract counts after each scenario.
 */

import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../../../../../../harness/thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import LlmRuntime, { createUserMessage } from '../../../../../../harness/thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { GenerateOptions, StreamChunk } from '../../../../../../harness/thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import SessionStore, { SESSION_FORMAT_VERSION } from '../../../../../../harness/thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '../../../../../../harness/thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../../../../harness/thirdparty/deepseek-harness/packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../../../../../harness/thirdparty/deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../../../../harness/thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import { AgentRegistry } from '../../../../../../harness/thirdparty/deepseek-harness/packages/core/agent/lib/index.js'
import AgentLoop from '../../../../../../harness/thirdparty/deepseek-harness/packages/core/agent-loop/lib/index.js'
import { DeepSeekAdapter, resolveAdapterOptions } from '../../../../../../harness/thirdparty/deepseek-harness/packages/llm/llm-deepseek/lib/index.js'
import * as LocalFileSystem from '../../../../../../harness/thirdparty/deepseek-harness/packages/fs/fs-local/lib/index.js'
import * as FsPolicy from '../../../../../../harness/thirdparty/deepseek-harness/packages/fs/fs-observation-policy/lib/index.js'
import * as ToolFs from '../../../../../../harness/thirdparty/deepseek-harness/packages/fs/tool-fs/lib/index.js'
import * as ToolFsSearch from '../../../../../../harness/thirdparty/deepseek-harness/packages/fs/tool-fs-search/lib/index.js'
import * as LocalSubprocessRuntime from '../../../../../../harness/thirdparty/deepseek-harness/packages/subprocess/subprocess-local/lib/index.js'
import * as BashEnvPlugin from '../../../../../../harness/thirdparty/deepseek-harness/packages/shell/shell-env/lib/index.js'
import * as LocalBashExecutor from '../../../../../../harness/thirdparty/deepseek-harness/packages/shell/bash-local/lib/index.js'
import * as ToolBash from '../../../../../../harness/thirdparty/deepseek-harness/packages/shell/tool-bash/lib/index.js'
import * as LocalJobRegistry from '../../../../../../harness/thirdparty/deepseek-harness/packages/jobs/jobs-local/lib/index.js'
import * as ToolJobs from '../../../../../../harness/thirdparty/deepseek-harness/packages/jobs/tool-jobs/lib/index.js'
import * as ToolAskUser from '../../../../../../harness/thirdparty/deepseek-harness/packages/interaction/tool-ask-user/lib/index.js'
import type { TaskInstance, TaskRun } from '../../../../../../harness/packages/singularity/task/src/types.ts'
import { TaskService, rootTaskStoreId } from '../../../../../../harness/packages/singularity/task/src/index.ts'
import type { TaskEvent, TaskSnapshot } from '../../../../../../harness/packages/singularity/task/src/index.ts'
import { AgentRuntime } from '../../../../../../harness/packages/singularity/agent-runtime/src/index.ts'
import type { SpawnRequest } from '../../../../../../harness/packages/singularity/agent-runtime/src/types.ts'
import { ProposalReviewService } from '../../../../../../harness/packages/singularity/agent-singularity/src/proposal-review.ts'
import { defineCapabilityListTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/capability-list.ts'
import { defineTaskCancelTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-cancel.ts'
import { defineTaskDecomposeTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-decompose.ts'
import { defineTaskIntakeTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-intake.ts'
import { defineTaskProposalCancelTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-proposal-cancel.ts'
import { defineTaskProposalContinueTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-proposal-continue.ts'
import { defineTaskProposalReadTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-proposal-read.ts'
import { defineTaskReadTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-read.ts'
import { defineTaskStatusTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-status.ts'
import { defineTaskSubmitResultTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/task-submit-result.ts'
import { defineAskTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/ask.ts'
import { defineApproveTool } from '../../../../../../harness/packages/singularity/agent-singularity/src/tools/approve.ts'
import type { Config, RootContractSpec } from '../../../../../../harness/packages/singularity/task-runtime/src/index.ts'
import { TaskRuntime } from '../../../../../../harness/packages/singularity/task-runtime/src/index.ts'
import { VerifierRegistry } from '../../../../../../harness/packages/singularity/verifier/src/index.ts'
import { MODEL, PROVIDER, gateway, redact } from './r1-env.ts'
import { ScriptedModelAdapter } from './r1-scripted-model.ts'
import type { ScriptEntry } from './r1-scripted-model.ts'

/** The root agent's allow-list, exactly as `agent-runtime` composes it (evolution off). */
export const ROOT_TOOLS = [
  'graph_spawn', 'graph_mark_ready', 'hitl_ask', 'hitl_approve', 'task_read', 'capability_list', 'skill', 'task_intake', 'task_decompose',
  'task_submit_result', 'task_cancel', 'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel', 'task_status', 'task_verify', 'task_review_pack', 'task_review_agent', 'task_diagnose', 'escalate',
]

/** The deployment's other global tools: the worker baseline's plane plus the session readers. */
export const OTHER_TOOLS = [
  'bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'ask_user_question',
  'web_fetch', 'subagent_fetchless', 'session_search', 'session_event_read', 'session_trace',
]

/** The tools this stack registers for real; every other name is a stand-in. */
const REAL_TOOLS = [
  'task_read', 'task_status', 'capability_list', 'task_intake', 'task_decompose', 'task_submit_result', 'task_cancel',
  'task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel',
  'hitl_ask', 'hitl_approve',
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'job_output', 'job_list', 'job_kill', 'ask_user_question',
]

/** The fixed per-scenario root budget (A3 §3.5), from the experiment contract. */
export const ROOT_BUDGET = { wallTimeMs: 300_000, maxRuns: 8 } as const

/** One model request's accounting, as the adapter layer observed it. */
export interface UsageRecord {
  readonly seq: number
  readonly sessionId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens?: number
  readonly finishReason?: string
}

/** One dispatched tool call, as the registry observed it. */
export interface ToolCallRecord {
  readonly seq: number
  readonly sessionId: string
  readonly callId: string
  readonly name: string
  readonly at: string
  readonly args: unknown
  readonly isError?: boolean
  readonly resultText?: string
}

/** One spawn the real `AgentRuntime` performed. */
export interface SpawnRecord {
  readonly sessionId: string
  readonly name: string
  readonly prompt: string
  readonly at: string
}

/**
 * One question the human seams were asked, with the answer the fixture desk
 * gave. Every field is plain data: the request object the real `hitl_ask` tool
 * hands to `ctx.userQuestions.ask` carries a live cordis `Agent` and an abort
 * signal, and serializing either of those throws inside the seam — the recorded
 * cause of the previous round's S3 failure. Only string-valued questions and
 * answers are kept; anything else is dropped rather than coerced.
 */
export interface HumanQuestionRecord {
  readonly seam: 'approval' | 'userQuestions'
  readonly sessionId: string
  /** The asked questions as `{id, question}` pairs; `[]` when the request carried none. */
  readonly questions: readonly { readonly id: string; readonly question: string }[]
  /** The desk's answers as `{id, text}` pairs, so a question and its answer correspond by id. */
  readonly answers: readonly { readonly id: string; readonly text: string }[]
  /** The desk's own answer value, JSON-encoded from plain data only. */
  readonly answered: string
  readonly at: string
}

/** One `hitl_ask` call's whole clarification chain: the call, the desk record, and the delivery into the session log. */
export interface ClarificationRecord {
  readonly callId: string
  readonly sessionId: string
  /** The tool call's own `prompt` argument, verbatim. */
  readonly prompt: string
  readonly isError: boolean
  /** The tool result text the dispatch accounting recorded for this call. */
  readonly resultText: string
  /** What the desk recorded for this call, matched by session and question text; `null` when nothing matched. */
  readonly desk: {
    /** The question id the ask carried (`hitl-ask`, the real tool's own id). */
    readonly questionId: string
    readonly question: string
    /** The answer text the desk returned for that id. */
    readonly answer: string
    readonly at: string
  } | null
  /** The `tool/result` event the result was appended as, read from the session's own JSONL — what the loop actually fed the model. */
  readonly delivered: {
    readonly source: 'session-log'
    readonly sessionId: string
    readonly callId: string
    readonly text: string
    readonly isError: boolean
  } | null
}

/** One model request the adapter boundary saw, with the texts the loop sent. */
export interface ModelRequestRecord {
  readonly seq: number
  readonly sessionId: string
  readonly at: string
  /** Every text block of every message in the request, in message order. */
  readonly texts: readonly string[]
}

export interface R1StackOptions {
  /** Scenario id (`s1`/`s2`/`s3`), used for logs and evidence naming. */
  readonly scenario: string
  /** Isolated DSH_HOME for this scenario (`<scratch>/s<N>/dsh-home`). */
  readonly home: string
  /** The checkout every worker runs in and every verifier command runs from (`<scratch>/s<N>/repo`). */
  readonly repo: string
  /** Root session id; defaults to the deployment's own (`s-root`). */
  readonly rootSessionId?: string
  /**
   * The fixture desk's answerer for the human seams: `approval` (the review
   * channel's seam) and `userQuestions` (the `hitl_ask` / `ask_user_question`
   * seam). Fixed by the experiment contract for S3; recorded verbatim either
   * way. Returning `undefined` for an approval holds it open.
   */
  readonly humanAnswer?: (seam: 'approval' | 'userQuestions', asked: unknown) => unknown
  /**
   * Which provider the stack registers: the production `DeepSeekAdapter` over
   * the configured gateway (`'gateway'`, the run's own mode), or a scripted
   * adapter that answers from {@link R1StackOptions.script} (`'scripted'`).
   * A scripted stack makes no network call and never touches a credential; the
   * model output is the only thing it replaces — the tools, the human seams,
   * the session log, the task runtime and the verifiers stay the real ones.
   * Defaults to `'gateway'`.
   */
  readonly modelAdapter?: 'gateway' | 'scripted'
  /** The script the `'scripted'` adapter answers from: index 0 is the root, 1..n the spawned sessions in spawn order. */
  readonly script?: (sessionId: string, index: number) => readonly ScriptEntry[]
  /**
   * Test-only fault hook, inert unless set: the fixture's own recording step is
   * made to throw the way the old live-`Agent` serialization did, so a spec can
   * pin that a recording failure cannot change or swallow the product path. The
   * paid run never sets it.
   */
  readonly recordingFault?: boolean
}

export interface R1Stack {
  readonly ctx: Context
  readonly runtime: TaskRuntime
  readonly task: TaskService
  readonly verifier: VerifierRegistry
  readonly home: string
  readonly repo: string
  readonly storeId: string
  readonly rootSessionId: SessionId
  readonly reviewAsks: readonly { readonly toolName: string; readonly reason: string; readonly sessionId: string }[]
  readonly startedAt: number
  /** The durable bytes of one session's JSONL log, as the store holds them. */
  logBytes(sessionId: string): string
  rootAgent(): unknown
  userSays(text: string): void
  snapshot(storeId: string): Promise<TaskSnapshot>
  eventsOf(sessionId: string): readonly SessionEvent[]
  taskEvents(storeId: string): readonly TaskEvent[]
  runForSession(sessionId: string): Promise<{ storeId: string; task: TaskInstance; run: TaskRun }>
  usage(): readonly UsageRecord[]
  toolCalls(): readonly ToolCallRecord[]
  spawns(): readonly SpawnRecord[]
  humanQuestions(): readonly HumanQuestionRecord[]
  /** Every `hitl_ask` call's chain, read back from the dispatch record, the desk record and the session JSONL. */
  clarifications(): readonly ClarificationRecord[]
  /** Failures the fixture's own recording caught: recorded as facts, never allowed to decide the product path. */
  recordErrors(): readonly string[]
  /** Every model request the adapter boundary saw for one session, in order. */
  requestsOf(sessionId: string): readonly ModelRequestRecord[]
  visibleTools(agent: unknown): string[]
  intakeRootContract(contract: RootContractSpec): ReturnType<TaskRuntime['intakeRootContract']>
  decomposeAndRun(taskId: string, runId: string, spec: Parameters<TaskRuntime['decomposeAndRun']>[4]): ReturnType<TaskRuntime['decomposeAndRun']>
  /** Poll the store until the root run reaches a terminal status, or report the timeout. */
  awaitRootTerminal(timeoutMs: number): Promise<{ status: string; reason?: string }>
  dispose(): Promise<void>
}

/** The in-memory + JSONL session log: the same handle shape the JSONL backend publishes. */
class FileSessionLog {
  private readonly events = new Map<string, SessionEvent[]>()
  private readonly headers = new Map<string, SessionHeader>()

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  list(): { header: SessionHeader }[] {
    return [...this.headers.values()].map(header => ({ header }))
  }

  create(header: SessionHeader): void {
    if (this.headers.has(header.id)) throw new Error(`session "${header.id}" already exists`)
    this.headers.set(header.id, header)
    this.events.set(header.id, [])
  }

  has(id: string): boolean {
    return this.headers.has(id)
  }

  headerOf(id: string): SessionHeader {
    const found = this.headers.get(id)
    if (found === undefined) throw new Error(`missing session ${id}`)
    return found
  }

  append(id: string, events: readonly SessionEvent[]): void {
    const bucket = this.events.get(id)
    if (bucket === undefined) throw new Error(`missing session ${id}`)
    bucket.push(...events)
    const lines = events.map(event => JSON.stringify(event)).join('\n')
    if (lines.length > 0) appendFileSync(join(this.dir, `${id}.jsonl`), `${lines}\n`, 'utf8')
  }

  read(id: string): readonly SessionEvent[] {
    return this.events.get(id) ?? []
  }

  /** The durable bytes of one session's log, as the file holds them. */
  bytesOf(id: string): string {
    try {
      return readFileSync(join(this.dir, `${id}.jsonl`), 'utf8')
    } catch {
      return ''
    }
  }
}

/** A plain string, or `undefined`: a live object is never coerced into text. */
function plainText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The asked questions, keeping only `{id, question}` pairs whose both members are plain strings. */
function plainQuestions(asked: unknown): { id: string; question: string }[] {
  if (typeof asked !== 'object' || asked === null) return []
  const questions = (asked as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return []
  const out: { id: string; question: string }[] = []
  for (const item of questions) {
    if (typeof item !== 'object' || item === null) continue
    const id = plainText((item as { id?: unknown }).id)
    const question = plainText((item as { question?: unknown }).question)
    if (id === undefined || question === undefined) continue
    out.push({ id, question })
  }
  return out
}

/**
 * The desk's answers as `{id, text}` pairs, rendered by the rule the real
 * `hitl_ask` tool reads them with (`custom ?? selected.join(', ') ?? ''`), so
 * what the record shows is the text the tool would hand the model.
 */
function plainAnswers(answered: unknown, seam: 'approval' | 'userQuestions'): { id: string; text: string }[] {
  if (seam === 'approval') {
    const outcome = plainText(answered)
    return outcome === undefined ? [] : [{ id: '', text: outcome }]
  }
  if (typeof answered !== 'object' || answered === null) return []
  const items = (answered as { answers?: unknown }).answers
  if (!Array.isArray(items)) return []
  const out: { id: string; text: string }[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const id = plainText((item as { id?: unknown }).id)
    if (id === undefined) continue
    const custom = plainText((item as { custom?: unknown }).custom)
    const selected = (item as { selected?: unknown }).selected
    const labels = Array.isArray(selected) ? selected.flatMap(entry => plainText(entry) ?? []) : []
    const text = custom ?? (labels.length > 0 ? labels.join(', ') : '')
    out.push({ id, text })
  }
  return out
}

/** Plain JSON of a well-formed value; a value that cannot be serialized is reported as its type instead of throwing. */
function plainJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch (error) {
    return `(unserializable: ${error instanceof Error ? error.message : String(error)})`
  }
}

/** One `tool/result` event of one session's JSONL, as the log holds it. */
interface LoggedToolResult {
  readonly callId: string
  readonly text: string
  readonly isError: boolean
}

/** Every `tool/result` the session's own JSONL records, in log order. */
function loggedToolResults(bytes: string): LoggedToolResult[] {
  const out: LoggedToolResult[] = []
  for (const line of bytes.split('\n')) {
    if (line.trim().length === 0) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event !== 'object' || event === null) continue
    const entry = event as { type?: unknown; data?: unknown }
    if (entry.type !== 'tool/result') continue
    const message = (entry.data as { message?: { content?: unknown } } | undefined)?.message
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      const item = block as { type?: unknown; toolCallId?: unknown; content?: unknown; isError?: unknown }
      if (item.type !== 'tool-result') continue
      const parts = Array.isArray(item.content) ? item.content : []
      const text = parts.flatMap(part => {
        if (typeof part !== 'object' || part === null) return []
        const text = plainText((part as { text?: unknown }).text)
        return text === undefined ? [] : [text]
      }).join('\n')
      out.push({ callId: plainText(item.toolCallId) ?? '', text, isError: item.isError === true })
    }
  }
  return out
}

/** Every text block of every message, tool-result contents included — what the model actually reads. */
function requestTexts(messages: readonly Message[]): string[] {
  const texts: string[] = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') texts.push(block.text)
      if (block.type === 'tool-result') for (const part of block.content) if (part.type === 'text') texts.push(part.text)
    }
  }
  return texts
}

/** The arguments one recorded tool call declared, as a plain object (never a live value). */
function callArguments(call: ToolCallRecord): Record<string, unknown> {
  const args = call.args
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) return args as Record<string, unknown>
  if (typeof args !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(args)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export async function startR1Stack(options: R1StackOptions): Promise<R1Stack> {
  const { home, repo } = options
  const rootSessionId = (options.rootSessionId ?? 's-root') as SessionId
  const storeId = rootTaskStoreId(rootSessionId)
  const log = new FileSessionLog(join(home, 'session-log'))
  const usageRecords: UsageRecord[] = []
  const requestRecords: ModelRequestRecord[] = []
  const toolCallRecords: ToolCallRecord[] = []
  const spawnRecords: SpawnRecord[] = []
  const humanQuestions: HumanQuestionRecord[] = []
  const recordErrors: string[] = []
  const reviewAsks: { toolName: string; reason: string; sessionId: string }[] = []
  const held = new Map<number, (outcome: string) => void>()
  let usageSeq = 0
  let requestSeq = 0
  const startedAt = Date.now()

  log.create({
    version: SESSION_FORMAT_VERSION,
    id: rootSessionId,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: repo,
    agentPreset: 'standard',
  } as unknown as SessionHeader)

  const ctx = new Context()
  const previous = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME }
  process.env.DSH_HOME = home
  process.env.HOME = home

  const answerHuman = async (seam: 'approval' | 'userQuestions', asked: unknown, sessionId: string): Promise<unknown> => {
    const answered = options.humanAnswer === undefined
      ? seam === 'approval' ? 'allowed-once' : { answers: [] }
      : options.humanAnswer(seam, asked)
    // The record is written beside the answer and can never decide it: `answered`
    // is returned whether or not the recording succeeded. The ask request itself
    // is never serialized — it carries a live agent and signal — and a recording
    // failure is kept as its own fact rather than turned into an answer.
    try {
      // The fault hook throws inside the recording step alone — after the desk's
      // answer is computed and before anything is pushed — which is exactly the
      // pre-fix shape the old live-`Agent` serialization produced.
      // MUTANT pass2-no-hook: the recording-fault hook no longer fires
      humanQuestions.push({
        seam,
        sessionId,
        questions: plainQuestions(asked).map(item => ({ id: redact(item.id), question: redact(item.question) })),
        answers: plainAnswers(answered, seam).map(item => ({ id: redact(item.id), text: redact(item.text) })),
        answered: redact(plainJson(answered)),
        at: new Date().toISOString(),
      })
    } catch (error) {
      recordErrors.push(`answerHuman(${seam}, session ${sessionId}): recording failed: ${redact(error instanceof Error ? error.message : String(error))}`)
    }
    return answered
  }

  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)

  // --- the model provider: the production DeepSeek adapter over the gateway,
  // or the scripted adapter when the caller asks for one (no network, no key) ---
  if (options.modelAdapter === 'scripted') {
    const script = options.script
    if (script === undefined) throw new Error('startR1Stack: modelAdapter "scripted" needs a script')
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new ScriptedModelAdapter(script, sessionId => {
      if (String(rootSessionId) === sessionId) return 0
      const spawned = spawnRecords.findIndex(record => record.sessionId === sessionId)
      return spawned < 0 ? 1 + spawnRecords.length : 1 + spawned
    })))
  } else {
    const connection = () => resolveAdapterOptions({
      protocol: 'chat-completions',
      baseURL: gateway.baseUrl,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      reasoningEffort: 'high',
      models: [{ id: MODEL, contextWindow: 128_000 }],
    })
    const adapter = new DeepSeekAdapter({
      options: connection,
      resolveApiKey: async () => gateway.apiKey,
      resolveUserId: () => 'r1-driver' as never,
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    })
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
  }

  // The usage ledger: one waterfall over the adapter boundary, so every model
  // response of every session is counted where it is actually observed. The
  // requests themselves are recorded beside it: the texts the loop sent are how
  // a spec reads back what a session's model actually received.
  ctx.on('llm/stream', ((options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const sessionId = String(options.sessionId ?? '')
    requestSeq += 1
    requestRecords.push({
      seq: requestSeq,
      sessionId,
      at: new Date().toISOString(),
      texts: requestTexts(options.messages),
    })
    return (async function* counting(): AsyncIterable<StreamChunk> {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') {
          usageSeq += 1
          usageRecords.push({
            seq: usageSeq,
            sessionId,
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
            cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0,
            ...(chunk.usage.totalTokens === undefined ? {} : { totalTokens: chunk.usage.totalTokens }),
          })
        }
        if (chunk.type === 'finish') {
          const last = usageRecords[usageRecords.length - 1]
          if (last !== undefined && last.sessionId === sessionId && last.finishReason === undefined) {
            (last as { finishReason?: string }).finishReason = JSON.stringify(chunk.reason)
          }
        }
        yield chunk
      }
    })()
  }) as never)

  // --- the deployment's other services (the same provides the fixtures use) ---
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) })
  ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
  ctx.provide('permissionPresets', { set: () => {}, resolve: () => ({}) })
  ctx.provide('approval', {
    request: async (request: { toolName?: string; reason?: string; agent?: { id?: string } }) => {
      const index = reviewAsks.length
      reviewAsks.push({ toolName: String(request.toolName ?? ''), reason: redact(String(request.reason ?? '')), sessionId: String(request.agent?.id ?? '') })
      const decided = await answerHuman('approval', request, String(request.agent?.id ?? ''))
      if (decided !== undefined) return decided
      return await new Promise<string>(resolve => { held.set(index, resolve) })
    },
  })
  ctx.provide('userQuestions', {
    ask: async (request: unknown & { agent?: { id?: string } }) => {
      const answered = await answerHuman('userQuestions', request, String(request.agent?.id ?? ''))
      return answered as { answers: { id: string; selected: string[]; custom?: string }[] }
    },
  })
  ctx.provide('layout', { setIn: async () => {} })
  ctx.provide('sessionPersistence', {
    list: async () => log.list(),
    create: async (header: SessionHeader) => {
      log.create(header)
      return {
        id: header.id,
        header,
        access: 'write',
        inheritedEventCount: 0,
        read: async (offset = 0, length?: number) => ({ eventState: 'detached' as const, events: log.read(header.id).slice(offset, length === undefined ? undefined : offset + length) }),
        append: async (events: readonly SessionEvent[]) => { log.append(header.id, events) },
        flush: async () => {},
        close: async () => {},
      }
    },
    open: async (id: SessionId, _access: 'read' | 'write' = 'read') => {
      if (!log.has(String(id))) throw new Error(`missing session ${id}`)
      const header = log.headerOf(String(id))
      return {
        id,
        header,
        access: 'read',
        inheritedEventCount: 0,
        read: async (offset = 0, length?: number) => ({ eventState: 'detached' as const, events: log.read(String(id)).slice(offset, length === undefined ? undefined : offset + length) }),
        append: async (events: readonly SessionEvent[]) => { log.append(String(id), events) },
        flush: async () => {},
        close: async () => {},
      }
    },
    flush: async () => {},
  } as never)

  const graphState = {
    version: 1,
    id: 'g1',
    roots: [rootSessionId],
    agents: [{ id: rootSessionId, name: 'Singularity', status: 'idle' as const }],
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
  ctx.provide('graphs', {
    graphForSession: async (sessionId: SessionId) => ({
      id: 'g1',
      name: 'graph',
      envId: 'env1',
      rootSessionId: graphState.roots.includes(sessionId) ? sessionId : rootSessionId,
      graphStoreId: 'sg-g-root',
      layoutStoreId: 'sg-l-root',
    }),
  } as never)
  ctx.provide('envBuilder', { store: { get: (envId: string) => (envId === 'env1' ? { path: repo, components: [] } : undefined) } } as never)

  // The worker plane's real file tools, mounted once on the shared plane the
  // way a deployment's host composition mounts them; the capability grant and
  // the root allow-list filter the inherited surface per agent.
  await ctx.plugin(LocalFileSystem.LocalFileSystem as never, { cwd: repo })
  await ctx.plugin(FsPolicy as never)
  await ctx.plugin(ToolFs as never)
  await ctx.plugin(ToolFsSearch as never)
  await ctx.plugin(LocalSubprocessRuntime.LocalSubprocessRuntime as never)
  await ctx.plugin(BashEnvPlugin as never)
  await ctx.plugin(LocalBashExecutor.LocalBashExecutor as never, { timeoutMs: 120_000, graceMs: 500 })
  await ctx.plugin(ToolBash as never)
  await ctx.plugin(LocalJobRegistry.LocalJobRegistry as never)
  await ctx.plugin(ToolJobs as never)
  await ctx.plugin(ToolAskUser as never)

  // The tool plane: the real singularity tools, stand-ins for the rest.
  const standIn = (name: string): void => {
    ctx.tools.register({
      name,
      description: `tool ${name}`,
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
      execute: async () => `${name}: fixture answer`,
    } as never)
  }
  for (const name of [...ROOT_TOOLS, ...OTHER_TOOLS]) {
    if (REAL_TOOLS.includes(name)) continue
    standIn(name)
  }
  ctx.tools.register(defineTaskReadTool(ctx))
  ctx.tools.register(defineTaskStatusTool(ctx))
  ctx.tools.register(defineCapabilityListTool(ctx))
  ctx.tools.register(defineTaskIntakeTool(ctx))
  ctx.tools.register(defineTaskDecomposeTool(ctx))
  ctx.tools.register(defineTaskSubmitResultTool(ctx))
  ctx.tools.register(defineTaskCancelTool(ctx))
  ctx.tools.register(defineTaskProposalReadTool(ctx))
  ctx.tools.register(defineTaskProposalContinueTool(ctx))
  ctx.tools.register(defineTaskProposalCancelTool(ctx))
  ctx.tools.register(defineAskTool(ctx))
  ctx.tools.register(defineApproveTool(ctx))

  // The dispatch record: every call the deployment ran through the registry,
  // deny included, in order.
  ctx.on('tools/result', (exec: { callId?: unknown }, result: { isError?: unknown; content?: readonly { type: string; text?: string }[] }) => {
    const record = toolCallRecords.find(item => item.callId === String(exec.callId))
    if (record === undefined) return
    const text = (result.content ?? []).map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')
    ;(record as { isError?: boolean; resultText?: string }).isError = result.isError === true
    ;(record as { resultText?: string }).resultText = redact(text)
  })
  // Live session events route into the active write handle, exactly as the
  // real persistence backend routes them: the loop's own publication append
  // carries only the pre-publication seed suffix, which never re-emits through
  // `session/event`, so this listener adds every live event once.
  ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
    log.append(String(session.id), [event])
  })

  class RecordingAgentRuntime extends AgentRuntime {
    override async spawn(parent: { id: SessionId }, request: SpawnRequest) {
      spawnRecords.push({
        sessionId: String(request.sessionId),
        name: request.name,
        prompt: redact(request.prompt.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')),
        at: new Date().toISOString(),
      })
      return await super.spawn(parent as never, request)
    }
  }
  const agentRuntime = new RecordingAgentRuntime(ctx)
  const task = new TaskService(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  // The verifier and the runtime are mounted the way the deployment's loader
  // mounts them, not constructed beside it: `[Service.init]` is what registers
  // the built-in verifiers through the executable selftest gate.
  await ctx.plugin(VerifierRegistry, { evidenceRoot: join(home, 'task-evidence') })
  await ctx.plugin(TaskRuntime, {
    capabilities: {},
    generatedTaskReview: 'off',
    rootBudget: { ...ROOT_BUDGET },
    runBindingRoot: join(home, 'singularity', 'run-bindings'),
  } as Config)
  // The review channel, mounted where the deployment mounts it — at the service
  // assembly — so a review of this store's proposals is routed through the
  // approval seam above, and a worker can never decide one.
  new ProposalReviewService(ctx)

  // The call record goes in front of the gate's own pre-execute listener, so a
  // denial short-circuits the waterfall and is still recorded.
  ctx.on('tools/pre-execute', (exec: { callId?: unknown; agent?: { id?: unknown }; name?: unknown; arguments?: unknown }, next: () => unknown) => {
    const callId = String(exec.callId)
    if (!toolCallRecords.some(item => item.callId === callId)) {
      toolCallRecords.push({
        seq: toolCallRecords.length + 1,
        sessionId: String(exec.agent?.id ?? ''),
        callId,
        name: String(exec.name ?? ''),
        at: new Date().toISOString(),
        args: redact(JSON.stringify(exec.arguments ?? {})),
      })
    }
    return next()
  }, { prepend: true } as never)

  const runtime = ctx.get('taskRuntime') as TaskRuntime
  const verifier = ctx.get('verifier') as VerifierRegistry
  await agentRuntime.ensureRoot(rootSessionId, { graphStoreId: 'sg-g-root', layoutStoreId: 'sg-l-root' } as never)

  return {
    ctx,
    runtime,
    task,
    verifier,
    home,
    repo,
    storeId,
    rootSessionId,
    reviewAsks,
    startedAt,
    logBytes: (id: string) => log.bytesOf(id),
    rootAgent: () => {
      const agent = ctx.agents.get(rootSessionId)
      if (agent === undefined) throw new Error(`the stack holds no live root agent for "${rootSessionId}"`)
      return agent
    },
    userSays: (text: string) => {
      const agent = rootAgentLike(ctx, rootSessionId)
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    },
    snapshot: async (id: string) => await task.snapshotIn(id),
    eventsOf: (id: string) => log.read(id),
    taskEvents: (id: string) => log.read(id).flatMap(event => (event as { type?: string; data?: unknown }).type === 'task/event' ? [(event as { data: unknown }).data as TaskEvent] : []),
    runForSession: async (id: string) => await runtime.runForSession(id),
    usage: () => usageRecords,
    toolCalls: () => toolCallRecords,
    spawns: () => spawnRecords,
    humanQuestions: () => humanQuestions,
    clarifications: () => {
      const results = loggedToolResults(log.bytesOf(String(rootSessionId)))
      const claimed = new Set<number>()
      return toolCallRecords.filter(call => call.name === 'hitl_ask').map(call => {
        const prompt = plainText(callArguments(call)['prompt'])
        const index = humanQuestions.findIndex((record, position) =>
          !claimed.has(position)
          && record.seam === 'userQuestions'
          && record.sessionId === call.sessionId
          && (prompt === undefined || record.questions.length === 0 || record.questions[0]?.question === prompt))
        const record = index < 0 ? undefined : humanQuestions[index]
        if (index >= 0) claimed.add(index)
        const answer = record?.answers.find(item => item.id === 'hitl-ask') ?? record?.answers[0]
        const delivered = results.find(result => result.callId === call.callId)
        return {
          callId: call.callId,
          sessionId: call.sessionId,
          prompt: prompt ?? '',
          isError: call.isError === true,
          resultText: call.resultText ?? '',
          // A desk record the ask reached is recorded even when the desk answered
          // nothing: `answer` is then `''`, which is the "unanswered" fact the
          // frozen contract asks for — not the same as no record at all.
          desk: record === undefined
            ? null
            : { questionId: answer?.id ?? 'hitl-ask', question: record.questions[0]?.question ?? '', answer: answer?.text ?? '', at: record.at },
          delivered: delivered === undefined
            ? null
            : { source: 'session-log', sessionId: String(rootSessionId), callId: delivered.callId, text: delivered.text, isError: delivered.isError },
        }
      })
    },
    recordErrors: () => recordErrors,
    requestsOf: (sessionId: string) => requestRecords.filter(record => record.sessionId === sessionId),
    visibleTools: (agent: unknown) => ctx.tools.schemas(agent as never).map(schema => schema.name).sort(),
    intakeRootContract: (contract: RootContractSpec) => runtime.intakeRootContract(storeId, rootSessionId, contract, { exec: { signal: new AbortController().signal } }),
    decomposeAndRun: (taskId: string, runId: string, spec: Parameters<TaskRuntime['decomposeAndRun']>[4]) =>
      runtime.decomposeAndRun(storeId, taskId, runId as never, rootSessionId, spec, {}),
    awaitRootTerminal: async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs
      let last = 'no snapshot yet'
      for (;;) {
        let root: { taskId: string; status: string } | undefined
        let run: { status: string; failureReason?: string; reason?: string } | undefined
        try {
          const snapshot = await task.snapshotIn(storeId)
          const found = snapshot.tasks.find(item => item.parentTaskId === undefined)
          if (found !== undefined) {
            root = { taskId: found.taskId, status: found.status }
            const foundRun = snapshot.runs.find(item => item.taskId === found.taskId && item.sessionId === rootSessionId)
            if (foundRun !== undefined) {
              run = { status: foundRun.status, failureReason: (foundRun as { failureReason?: string }).failureReason, reason: (foundRun as { reason?: string }).reason }
            }
          }
          last = root !== undefined ? `root task ${root.taskId} status ${root.status}` : 'the store holds no root task yet'
        } catch (error) {
          // The store opens with the intake; before that there is nothing to read.
          last = `the store is not readable yet (${error instanceof Error ? error.message : String(error)})`
        }
        if (run !== undefined && run.status !== 'running') {
          return {
            status: run.status,
            ...(run.status === 'failed' || run.status === 'cancelled'
              ? { reason: run.failureReason ?? run.reason }
              : {}),
          }
        }
        if (Date.now() > deadline) return { status: 'timeout', reason: last }
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    },
    dispose: async () => {
      if (previous.DSH_HOME === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous.DSH_HOME
      if (previous.HOME === undefined) delete process.env.HOME
      else process.env.HOME = previous.HOME
      await ctx.fiber.dispose()
    },
  }
}

function rootAgentLike(ctx: Context, rootSessionId: SessionId): { followup: (message: unknown) => void } {
  const agent = ctx.agents.get(rootSessionId)
  if (agent === undefined) throw new Error(`the stack holds no live root agent for "${rootSessionId}"`)
  return agent as unknown as { followup: (message: unknown) => void }
}

/** A fresh scratch root outside the repository. */
export function scratchRoot(name: string): string {
  return join(tmpdir(), `r1-${name}-`)
}

/** Remove a scenario's scratch tree (evidence archiving only, never mid-run). */
export function removeScratch(path: string): void {
  rmSync(path, { recursive: true, force: true })
}
