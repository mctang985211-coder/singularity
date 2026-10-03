import { Context, Service } from "@deepseek-ai/cordis";
import { AcceptanceCriterion, Diagnosis, EvidenceBundle, ExecutionPhase, ReviewRecord, RunProviderBinding, TaskHandoff, TaskInstance, TaskRun, TaskSnapshot } from "@dangosys/dsh-singularity-task";
import { RetentionNotice } from "@deepseek-ai/dsh-output-retention";
import { RunBindingRead, StoreRecoveryStatus } from "@dangosys/dsh-singularity-task-runtime";
import { SessionEvent } from "@deepseek-ai/dsh-session";
import { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";

//#region src/refusals.d.ts
/** The named vocabulary every read answers in, the read algebra built on it, and the one place an error is read. @module @dangosys/dsh-singularity-context/refusals */
/** Every outcome a read can refuse with, by name. */
type NamedRefusal = 'not-activated' | 'unbound' | 'binding-conflict' | 'cross-graph' | 'not-found' | 'stale-reference' | 'unreadable' | 'context-too-large';
/** The same vocabulary as a value, so a tool schema or a test can pin the whole set. */
declare const NAMED_REFUSALS: readonly ["not-activated", "unbound", "binding-conflict", "cross-graph", "not-found", "stale-reference", "unreadable", "context-too-large"];
/** How much of a longer read one page carried, and where to continue. */
interface ReadContinuation {
  readonly hasMore: boolean;
  readonly nextOffset: number;
}
/** A read that answered: the text, where it came from, and whether it is complete. */
interface ProjectedReadOk {
  readonly ok: true;
  readonly text: string;
  /** True when more of the same read is available: another record page, the rest of a window, further entries. */
  readonly hasMore?: boolean;
  /** The offset the next page starts at — the read's own unit (UTF-8 bytes, event seq, entry index). */
  readonly nextOffset?: number;
  /** What was read and how much of it one observation covers, in one line. */
  readonly source: string;
}
/** A read that refused: the named outcome and the detail a caller can act on or show. */
interface ProjectedReadRefused {
  readonly ok: false;
  readonly refusal: NamedRefusal;
  readonly detail: string;
}
/** What every read in this package returns. */
type ProjectedRead = ProjectedReadOk | ProjectedReadRefused;
/** One successful read; the continuation fields appear only when something is left. */
declare function read(text: string, source: string, continuation?: ReadContinuation): ProjectedReadOk;
/** One refused read: the name first, then the detail a caller renders as-is. */
declare function refused(refusal: NamedRefusal, detail: string): ProjectedReadRefused;
//#endregion
//#region src/bindings/types.d.ts
/** One recorded reviewer delegation, exactly the fields the ledger holds. */
interface ReviewerBindingRecord {
  /** The root task store the delegated graph reads through. */
  readonly rootStoreId: string;
  /** The task the reviewer was delegated to review. */
  readonly taskId: string;
  /** The session that started the reviewer. */
  readonly actor: string;
  /** When the delegation was recorded. */
  readonly at: string;
}
/** Where a reviewer's delegation is read from: the ledger finds the rows, this package reads them. */
interface ReviewerBindingSource {
  read(sessionId: string): Promise<ReviewerBindingRecord | undefined>;
}
/** Why a binding source could not answer: a conflicting ledger, or one this process cannot read. */
type ReviewerBindingFailure = 'binding-conflict' | 'unreadable';
/** What a source raises instead of picking a row: a conflict, or a ledger this process cannot read. */
declare class ReviewerBindingError extends Error {
  readonly kind: ReviewerBindingFailure;
  constructor(kind: ReviewerBindingFailure, message: string);
}
/** A published graph member, as the graph store holds it. */
interface MembershipNode {
  readonly id: string;
}
/** One published graph edge, as the graph store holds it (`agent-runtime` publishes `spawn` edges). */
interface MembershipEdge {
  readonly kind: string;
  readonly from: string;
  readonly to: string;
}
/** The graph registry, read-only: which graph a session belongs to, and who that graph publishes. */
interface ReadOnlyGraphs {
  graphForSession(sessionId: string): Promise<GraphRecordFacts>;
  list(): Promise<readonly GraphRecordFacts[]>;
  /** One graph's published members and edges, read by the registry's own graph id. */
  view(id: string): Promise<{
    readonly graph: {
      readonly agents: readonly MembershipNode[];
      readonly edges: readonly MembershipEdge[];
    };
  }>;
}
/** The fields of a registry graph this package reads. */
interface GraphRecordFacts {
  readonly id: string;
  readonly name: string;
  readonly envId: string;
  readonly rootSessionId: string;
  readonly graphStoreId: string;
}
/** The task service's read-only open (A2 §D: `openStore` / `snapshotIn`, never a write). */
interface ReadOnlyTaskStore {
  openStore(storeId: string): Promise<TaskSnapshot>;
}
/** The runtime's read-only observation surface; nothing here can start, recover or settle anything. */
interface ReadOnlyTaskRuntime {
  recoveryStatus(storeId: string): Promise<StoreRecoveryStatus>;
  readRunBinding(binding: RunProviderBinding): Promise<RunBindingRead | undefined>;
  readonly gate: {
    phaseOf(sessionId: string): ExecutionPhase | 'terminal' | undefined;
  };
  /** Whether this deployment admits a run's own `task_decompose`. */
  allowsRuntimeDecomposition(): boolean;
}
/** Everything the binding resolver reads. */
interface BindingDeps {
  readonly task: ReadOnlyTaskStore;
  readonly graphs: ReadOnlyGraphs;
  readonly taskRuntime: ReadOnlyTaskRuntime;
  /** The one registered delegation source, when this deployment has one. */
  readonly reviewerSource?: ReviewerBindingSource;
}
/** The graph facts a resolution carries, so a reader never has to re-derive them. */
interface CallerGraph {
  readonly id: string;
  readonly name: string;
  readonly envId: string;
  readonly rootSessionId: string;
}
/** What every resolved caller has: the domain it may read, and how that domain stands. */
interface CallerBase {
  readonly sessionId: string;
  readonly graph: CallerGraph;
  /** The graph's root task store — the whole read domain for every reference read. */
  readonly storeId: string;
  /** The store's recovery marker, read-only; a read never triggers or waits for recovery. */
  readonly recovery: StoreRecoveryStatus;
}
/** A caller with no usable binding: no graph, no delegation, or a binding that contradicts itself. */
interface CallerUnbound {
  readonly kind: 'unbound';
  readonly sessionId: string;
  readonly refusal: NamedRefusal;
  readonly detail: string;
  /** Present when the caller's graph was resolvable and only the binding failed. */
  readonly graph?: CallerGraph;
  /** `outside`: no durable fact binds the session. `failed`: the session is bound and a fact could not be read. */
  readonly placement: 'outside' | 'failed';
}
/** What a caller may read, by role; each optional field means the state it names is absent. */
type CallerResolution = (CallerBase & {
  readonly kind: 'root';
  readonly task?: TaskInstance;
  readonly run?: TaskRun;
}) | (CallerBase & {
  readonly kind: 'worker';
  readonly task: TaskInstance;
  readonly run: TaskRun;
}) | (CallerBase & {
  readonly kind: 'reviewer';
  readonly task?: TaskInstance;
  readonly delegation: ReviewerBindingRecord;
}) | (CallerBase & {
  readonly kind: 'member';
}) | CallerUnbound;
/** One resolved caller plus the single snapshot its read runs against. */
interface LoadedCaller {
  readonly resolution: CallerResolution;
  /** The domain store's snapshot; absent when the store does not exist yet, or for an unbound caller. */
  readonly snapshot?: TaskSnapshot;
}
/** Whether one session is a published member of a graph — the check every session reference passes. */
declare function isGraphMember(graphs: ReadOnlyGraphs, graphId: string, sessionId: string): Promise<boolean>;
//#endregion
//#region src/types.d.ts
/** The status scopes a caller may ask for (A2 §D). */
type StatusScope = 'related' | 'graph';
/** What one status read asks for: how much of which scope. */
interface StatusQuery {
  readonly scope?: StatusScope;
  /** Entry offset, from 0. */
  readonly offset?: number;
  /** Entries per page; default 20, range 1–100. */
  readonly limit?: number;
}
/** A review's identity: the pair a `ReviewRecord` carries, since a review has no id of its own. */
interface ReviewReference {
  readonly taskId: string;
  /** `null` for a task that blocked before any run started. */
  readonly runId: string | null;
}
/** One session event's identity: the session it belongs to and the event's own DSH seq. */
interface SessionEventReference {
  readonly sessionId: string;
  readonly seq: number;
}
/** What one reference read asks for, by kind. */
interface ContextReadQuery {
  readonly kind: 'task' | 'run' | 'evidence' | 'review' | 'diagnosis' | 'session';
  /** The record's own identity, in the shape its kind uses. */
  readonly ref: string | ReviewReference | SessionEventReference;
  /** Task-class: byte offset into the record. Session listing: event seq. Session event: byte offset. */
  readonly offset?: number;
  /** Task-class/session-event: UTF-8 bytes per page. Session listing: events per page. */
  readonly limit?: number;
}
/** The session plane's read-only half, as this package uses it. */
interface SessionQueryReads {
  readSurface(sessionId: string): Promise<{
    readonly capturedThroughSeq: number | null;
  }>;
  readEvent(request: {
    readonly sessionId: string;
    readonly seq: number;
    readonly before?: number;
    readonly after?: number;
  }, signal?: AbortSignal): Promise<{
    readonly target: SessionEvent;
    readonly events: readonly SessionEvent[];
    readonly startSeq: number;
    readonly endSeq: number;
  }>;
  /** One Session's whole log, live-preferred, with the number of fork-inherited events at its head. */
  readSession(sessionId: string): Promise<{
    readonly inheritedEventCount: number;
    readonly events: readonly SessionEvent[];
  }>;
}
/** Soft view of the env-builder store: the graph env's path is where template discovery walks up from. */
interface EnvPathSource {
  readonly store: {
    get(envId: string): {
      readonly path: string;
    };
  };
}
/** Everything a projection reads from. */
interface ReadDeps extends BindingDeps {
  readonly sessionQuery: SessionQueryReads;
  /** Absent in a deployment without an env builder: the obligation-coverage line is then omitted. */
  readonly envBuilder?: EnvPathSource;
}
//#endregion
//#region src/assembly.d.ts
/** Section name of the assembled contract: the one slot the immutable half has ever had. */
declare const WORKER_CONTRACT_SECTION = "singularity:worker-contract";
/** Placement: after the root's `singularity:root` (70) and the worker policy's `singularity:worker` (75). */
declare const WORKER_CONTRACT_ORDER = 80;
/** The dynamic half's context name on the runtime-context plane. */
declare const STATE_CONTEXT_NAME = "singularity:state";
/** Placement among the runtime contexts, after the centrally allocated ones (`CONTEXT_ORDERS` ends at 120). */
declare const STATE_CONTEXT_ORDER = 130;
/** The question plane's context name (A4 §F.1): a separate name, so planes deduplicate separately. */
declare const QUESTIONS_CONTEXT_NAME = "singularity:questions";
/** Placement among the runtime contexts: right behind the state plane. */
declare const QUESTIONS_CONTEXT_ORDER = 140;
/** The error a refused assembly throws: the refusal is its name, the detail its message. */
declare class AssemblyRefusalError extends Error {
  readonly refusal: ProjectedReadRefused['refusal'];
  constructor(refusal: ProjectedReadRefused['refusal'], detail: string);
}
/** The one assembly step: one caller resolution, then the planes that role is owed (README: who gets what). */
declare function assembleSingularityContext(service: SingularityContextService, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>;
//#endregion
//#region src/bindings/resolve.d.ts
/** Resolve one live session to the domain it may read, from durable facts only. */
declare function loadCaller(deps: BindingDeps, sessionId: string, signal?: AbortSignal): Promise<LoadedCaller>;
//#endregion
//#region src/limits.d.ts
/** The outer output bound of one context read, in UTF-8 bytes: the deployment's own inline cap. */
declare const CONTEXT_OUTPUT_LIMIT_BYTES = 50000;
/** UTF-8 byte length of `text`. */
declare function utf8Bytes(text: string): number;
/** One page out of a longer text: the bytes taken, the offset after them, and whether the source ended. */
interface Utf8Slice {
  readonly text: string;
  /** Byte offset the next page starts at; always on a character boundary. */
  readonly nextOffset: number;
  /** True when this page reached the end of the source. */
  readonly done: boolean;
}
/** Take at most `maxBytes` bytes from `offsetBytes`, never splitting a character, and report the next offset. */
declare function sliceUtf8(text: string, offsetBytes: number, maxBytes: number): Utf8Slice;
/** A byte-metered line list: every line fits whole — newline included — or is refused, never cut. */
declare class OutputBudget {
  readonly maxBytes: number;
  private readonly lines;
  private used;
  constructor(maxBytes: number);
  get bytes(): number;
  get remaining(): number;
  /** Append one line when it fits; false leaves the budget untouched. */
  add(line: string): boolean;
  /** Append every line that fits; returns how many were left out. */
  addAll(lines: readonly string[]): number;
  text(): string;
}
/** One bounded list's omission, in the shape the platform's notice vocabulary takes. */
interface OmissionReport {
  /** What was bounded, e.g. `related tasks` — the notice's scope label. */
  readonly scope: string;
  /** What the omitted units are, in the library's own vocabulary. */
  readonly unit: RetentionNotice['unit'];
  /** How many units the page carried. */
  readonly kept: number;
  /** The bound the page filled, in units. */
  readonly limit: number;
  /** The exact number of units left out. */
  readonly omitted: number;
  /** This read's own recovery sentence — the half the library leaves to the tool. */
  readonly recovery: string;
}
/** One bounded list's omission line: the platform's clause plus this read's recovery sentence. */
declare function omissionLine(report: OmissionReport): string;
//#endregion
//#region src/reads/contract.d.ts
/** The immutable half of the context one role is assembled with (A2 §D/§9). */
declare function contractProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead>;
//#endregion
//#region src/reads/dynamic.d.ts
/** One related task with the direction labels it earns in the caller's view. */
interface RelatedEntry {
  readonly task: TaskInstance;
  readonly roles: string[];
}
/** The tasks one caller's status view covers: itself, its direct children, and its dependency neighbours. */
declare function relatedEntries(snapshot: TaskSnapshot, self: TaskInstance): RelatedEntry[];
/** The dynamic half (A2 §D/§9): run state, gate phase, related tasks; byte-stable per content. */
declare function dynamicProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead>;
//#endregion
//#region src/reads/guards.d.ts
/** The not-activated view: the state named, whatever proposal is open, and the one action that changes it. */
declare function notActivatedLines(graph: CallerGraph, storeId: string, snapshot: TaskSnapshot | undefined): string[];
//#endregion
//#region src/reads/questions.d.ts
/** The question plane (A4 §F.1/§7.3): open questions owed, and answers no read has been shown. */
declare function questionProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead>;
//#endregion
//#region src/reads/reference-read.d.ts
/** `context_read` (A2 §D/A2-5): one record of the caller's own domain, by reference. */
declare function contextRead(deps: ReadDeps, loaded: LoadedCaller, query: ContextReadQuery, signal?: AbortSignal): Promise<ProjectedRead>;
//#endregion
//#region src/reads/task-read.d.ts
/** `task_read` (A2 §D/A2-5): the caller's own contract, children, run and re-checked binding. */
declare function taskRead(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead>;
//#endregion
//#region src/reads/task-status.d.ts
/** `task_status` (A2 §D/A2-5): the caller's related tasks, or the whole domain, paged by offset. */
declare function taskStatus(deps: ReadDeps, loaded: LoadedCaller, query: StatusQuery): Promise<ProjectedRead>;
//#endregion
//#region src/render/fields.d.ts
/** The phase, batch, submission and no-progress facts of one run, appended to a run line. */
declare function runPhaseSuffix(run: TaskRun, snapshot?: TaskSnapshot): string;
/** The same fact for a denser line, where only the phase and the old-record marker fit. */
declare function runPhaseCell(run: TaskRun, snapshot?: TaskSnapshot): string;
/** The acceptance criteria, one line per criterion, in declaration order. */
declare function criteriaLines(criteria: readonly AcceptanceCriterion[]): string[];
/** The two contract facts a reader cannot read off the objective and the criteria table. */
declare function contractLines(task: TaskInstance): string[];
/** One contract list on its own — the hard constraints a root briefing carries, or its assumptions. */
declare function constraintItems(task: TaskInstance): readonly string[];
/** The root most distant ancestor of one task: the top of its real parent chain. */
declare function rootAncestor(snapshot: TaskSnapshot, task: TaskInstance): {
  readonly task: TaskInstance;
  readonly brokenAt?: string;
};
/** The latest run a task started, by the store's own run order. */
declare function latestRun(snapshot: TaskSnapshot, task: TaskInstance): TaskRun | undefined;
/** The handoff a task was delegated with, when a parent recorded one. */
declare function handoffFor(snapshot: TaskSnapshot, taskId: string): TaskHandoff | undefined;
/** The handoff envelope as a projection: the delegation terms and the references a worker may read. */
declare function handoffLines(handoff: TaskHandoff): string[];
/** The reference lists a handoff carries, as their own lines: what to read for itself. */
declare function handoffReferences(handoff: TaskHandoff): {
  readonly artifacts: string[];
  readonly evidence: string[];
};
/** The one-line identity of one task, in the shape both status reads use. */
declare function taskSummaryLine(snapshot: TaskSnapshot, task: TaskInstance, roles?: readonly string[]): string;
//#endregion
//#region src/render/records.d.ts
/** Render one run's binding summary; without `read` no readability claim is made. */
declare function renderRunBinding(binding: RunProviderBinding | undefined, read?: RunBindingRead): string;
/** The run binding block: the summary re-checked, or its re-check failure stated in its place. */
declare function bindingLines(taskRuntime: ReadOnlyTaskRuntime, binding: RunProviderBinding | undefined): Promise<string[]>;
/** The complete rendering of one task record. */
declare function taskRecordText(task: TaskInstance): string;
/** The complete rendering of one run record, with the binding re-check appended. */
declare function runRecordText(taskRuntime: ReadOnlyTaskRuntime, run: TaskRun, snapshot?: TaskSnapshot): Promise<string>;
/** The complete rendering of one evidence bundle. */
declare function evidenceRecordText(snapshot: TaskSnapshot, evidence: EvidenceBundle): string;
/** The complete rendering of one review record, identified by its `(taskId, runId)` pair. */
declare function reviewRecordText(review: ReviewRecord): string;
/** The complete rendering of one diagnosis record. */
declare function diagnosisRecordText(diagnosis: Diagnosis): string;
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityContext: SingularityContextService;
  }
}
declare class SingularityContextService extends Service {
  static inject: string[];
  /** The one registered delegation source, when this deployment has one. */
  private reviewerSource;
  constructor(ctx: Context);
  /** Mount the one `system-prompt/assemble` waterfall listener this service owns. */
  [Service.init](): void;
  /** Register the one reviewer-delegation source; the returned disposer removes it again. */
  registerReviewerBindingSource(source: ReviewerBindingSource): () => void;
  /** The domain a live session may read, from durable facts. */
  resolveCaller(sessionId: string, signal?: AbortSignal): Promise<LoadedCaller['resolution']>;
  /** The caller's own complete contract and run (A2 §D `task_read`). */
  taskRead(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead>;
  /** The project status view: the caller's relations, or the whole domain (A2 §D `task_status`). */
  taskStatus(sessionId: string, query?: StatusQuery, signal?: AbortSignal): Promise<ProjectedRead>;
  /** One record of the caller's own domain, by reference (A2 §D `context_read`). */
  contextRead(sessionId: string, query: ContextReadQuery, signal?: AbortSignal): Promise<ProjectedRead>;
  /** The immutable half of the caller's context: contract, root briefing, handoff (A2 §D/§9). */
  contractProjection(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead>;
  /** The dynamic half: run state, gate phase, recovery marker, related tasks (A2 §D/§9). */
  dynamicProjection(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead>;
  /** The question plane (A4 §F.1/§7.3): open questions, and answers no read has been shown. */
  questionProjection(sessionId: string, signal?: AbortSignal): Promise<ProjectedRead>;
  /** The caller's own loaded domain, resolved once for every plane of one model request. */
  load(sessionId: string, signal?: AbortSignal): Promise<LoadedCaller>;
  /** One plane of a caller already loaded — the assembly's own doors. */
  contractFor(caller: LoadedCaller): Promise<ProjectedRead>;
  dynamicFor(caller: LoadedCaller): Promise<ProjectedRead>;
  questionsFor(caller: LoadedCaller): Promise<ProjectedRead>;
  /** Retrieve the current visible catalog before the model decides its next children. */
  templatesFor(caller: LoadedCaller): Promise<string>;
  private bindingDeps;
  private readDeps;
  /** The env builder this deployment mounts, when it mounts one. */
  private envBuilder;
}
//#endregion
export { AssemblyRefusalError, type BindingDeps, CONTEXT_OUTPUT_LIMIT_BYTES, type CallerBase, type CallerGraph, type CallerResolution, type CallerUnbound, type ContextReadQuery, type EnvPathSource, type GraphRecordFacts, type LoadedCaller, type MembershipEdge, type MembershipNode, NAMED_REFUSALS, type NamedRefusal, type OmissionReport, OutputBudget, type ProjectedRead, type ProjectedReadOk, type ProjectedReadRefused, QUESTIONS_CONTEXT_NAME, QUESTIONS_CONTEXT_ORDER, type ReadContinuation, type ReadDeps, type ReadOnlyGraphs, type ReadOnlyTaskRuntime, type ReadOnlyTaskStore, type RelatedEntry, type ReviewReference, ReviewerBindingError, type ReviewerBindingRecord, type ReviewerBindingSource, STATE_CONTEXT_NAME, STATE_CONTEXT_ORDER, type SessionEventReference, type SessionQueryReads, SingularityContextService, SingularityContextService as default, type StatusQuery, type StatusScope, type Utf8Slice, WORKER_CONTRACT_ORDER, WORKER_CONTRACT_SECTION, assembleSingularityContext, bindingLines, constraintItems, contextRead, contractLines, contractProjection, criteriaLines, diagnosisRecordText, dynamicProjection, evidenceRecordText, handoffFor, handoffLines, handoffReferences, isGraphMember, latestRun, loadCaller, notActivatedLines, omissionLine, questionProjection, read, refused, relatedEntries, renderRunBinding, reviewRecordText, rootAncestor, runPhaseCell, runPhaseSuffix, runRecordText, sliceUtf8, taskRead, taskRecordText, taskStatus, taskSummaryLine, utf8Bytes };