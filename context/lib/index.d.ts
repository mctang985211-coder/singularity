import { Context, Service } from "@deepseek-ai/cordis";
import { AcceptanceCriterion, Diagnosis, EvidenceBundle, ExecutionPhase, ReviewRecord, RunProviderBinding, TaskHandoff, TaskInstance, TaskProposalRoot, TaskRun, TaskSnapshot } from "@dangosys/dsh-singularity-task";
import { RunBindingRead, StoreRecoveryStatus } from "@dangosys/dsh-singularity-task-runtime";
import { SessionEvent } from "@deepseek-ai/dsh-session";
import { AssembleContext, PromptAssembly } from "@deepseek-ai/dsh-system-prompt";

//#region src/refusals.d.ts

/**
 * The named vocabulary every read in this package answers in (A2 §D). One closed
 * union, shared by the tool adapters and the prompt assembly, so a caller that
 * handles `cross-graph` is handling exactly what a service can say — and a new
 * outcome cannot be invented by a tool that needs one.
 *
 * A refusal is a *result*, never an exception: the reads here are for a model
 * that has to be told what a fact is, and "this session is not bound" or "that
 * record is not in your graph" are answers, not crashes. `recoveryStatus`'s
 * markers (`recovering`, `recovery-failed`, `needs-recovery`, `not-activated`)
 * ride along inside results as display facts, never as triggers.
 * @module @dangosys/dsh-singularity-context/refusals
 */
/** Every outcome a read can refuse with, by name. */
type NamedRefusal = 'not-activated' | 'unbound' | 'binding-conflict' | 'cross-graph' | 'not-found' | 'stale-reference' | 'unreadable' | 'context-too-large';
/**
 * The same vocabulary as a value, so a tool schema or a test can pin the whole
 * set instead of trusting that no ninth name was added quietly.
 */
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
  /**
   * True when more of the same read is available: another record page, the rest
   * of a session window, or further status entries.
   */
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
//#region src/bindings.d.ts

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
/**
 * Where a reviewer's delegation is read from. One method, read-only: the ledger
 * implementation decides how it finds the rows, and this package decides what a
 * row means.
 */
interface ReviewerBindingSource {
  read(sessionId: string): Promise<ReviewerBindingRecord | undefined>;
}
/** Why a binding source could not answer the single-record question. */
type ReviewerBindingFailure = 'binding-conflict' | 'unreadable';
/**
 * The one thing the single-record seam cannot express: a ledger that holds
 * several *conflicting* rows for one session (or a ledger this process cannot
 * read at all). A source that finds itself in either state raises this instead
 * of picking a row — silently answering one of two delegations would make the
 * read domain depend on file order. The service maps `kind` onto the named
 * refusals `binding-conflict` / `unreadable`.
 */
declare class ReviewerBindingError extends Error {
  readonly kind: ReviewerBindingFailure;
  constructor(kind: ReviewerBindingFailure, message: string);
}
/** A published graph member, as the graph store holds it. */
interface MembershipNode {
  readonly id: string;
}
/** The graph registry, read-only: which graph a session belongs to, and who that graph publishes. */
interface ReadOnlyGraphs {
  graphForSession(sessionId: string): Promise<GraphRecordFacts>;
  list(): Promise<readonly GraphRecordFacts[]>;
  /** One graph's published members, read by the registry's own graph id. */
  view(id: string): Promise<{
    readonly graph: {
      readonly agents: readonly MembershipNode[];
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
  /**
   * Whether this deployment admits a run's own `task_decompose` — the fact the
   * worker projection's runtime-split rule hangs on. Read-only: the projection
   * *reports* the rule; admission still decides every call.
   */
  allowsRuntimeDecomposition(): boolean;
}
/** Everything the binding resolver reads. */
interface BindingDeps {
  readonly task: ReadOnlyTaskStore;
  readonly graphs: ReadOnlyGraphs;
  readonly taskRuntime: ReadOnlyTaskRuntime;
  /** The registered delegation sources, in registration order. */
  readonly reviewerSources: readonly ReviewerBindingSource[];
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
  /**
   * Which of the two situations this is, since the two reads that produce it
   * answer a caller differently (2026-09-25 rework, Q1):
   *
   * - `outside`: no durable fact in this deployment binds the session — it is
   *   not a member of any graph and no ledger names it. Its assembly is somebody
   *   else's business, and a read of it refuses `unbound`.
   * - `failed`: the session **is** bound (or a delegation names it) and a fact
   *   the binding is derived from could not be read — the graph lookup, the
   *   domain store's open, or the ledger. The read still refuses by name, and
   *   the prompt assembly refuses the model request outright: a bound session
   *   never gets a request assembled from nothing.
   */
  readonly placement: 'outside' | 'failed';
}
/**
 * What a caller may read. `root` carries its task and run when the graph's root
 * contract is activated — absent on both means the graph is `not-activated`. A
 * `reviewer` carries its delegated task when the store still holds it (absent
 * means the delegation names a task this store does not have: `not-found`). A
 * `member` is a published session of the graph with no run and no delegation of
 * its own: it may read the domain, and it has no contract to read.
 */
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
/**
 * Resolve one live session to the domain it may read, from durable facts only.
 *
 * The order is the contract's: the caller's own graph membership, then its own
 * persisted run, then a recorded delegation, then "a member with no binding of
 * its own". Nothing in this function writes: opening the store is the store's
 * own read-only open, and the runtime calls are observations.
 *
 * Every read that can fail says so in the resolution it returns: the graph
 * lookup, the store's open and the ledger all answer `placement: 'failed'` when
 * they cannot answer at all, so that the assembly (which is the one consumer
 * that must not carry on regardless) can tell that apart from a session this
 * deployment simply does not know (`placement: 'outside'`).
 */
declare function loadCaller(deps: BindingDeps, sessionId: string, signal?: AbortSignal): Promise<LoadedCaller>;
/**
 * Whether one session is a published member of the caller's graph — the check a
 * `session` reference passes before any session history is read. Membership is
 * the graph store's own record (read through the registry, which resolves the
 * graph id to its store), so a guessed session id is refused before DSH is asked
 * anything about it.
 */
declare function isGraphMember(graphs: ReadOnlyGraphs, graphId: string, sessionId: string): Promise<boolean>;
//#endregion
//#region src/projections.d.ts
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
/** What one reference read asks for, by kind. */
interface ContextReadQuery {
  readonly kind: 'task' | 'run' | 'evidence' | 'review' | 'diagnosis' | 'session';
  /** The record's own identity, in the shape its kind uses. */
  readonly ref: string | ReviewReference;
  /** Task-class kinds: UTF-8 byte offset into the record text. Session: event seq. */
  readonly offset?: number;
  /**
   * Task-class kinds: how many UTF-8 bytes of the record this page may carry
   * (the whole answer still never exceeds the output bound). Session: events per
   * page.
   */
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
/**
 * The immutable half of the context one role is assembled with (A2 §D/§9): the
 * root objective and its hard constraints, the caller's own complete contract,
 * the persisted handoff envelope, and — for replay or a reviewer — the honest
 * label that says which lineage this contract belongs to.
 *
 * Two projections of unchanged content are byte-identical: no read counters, no
 * "as of" timestamp, and every list in its store order.
 */
declare function contractProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead>;
/** One related task with the direction labels it earns in the caller's view. */
interface RelatedEntry {
  readonly task: TaskInstance;
  readonly roles: string[];
}
/**
 * The tasks one caller's status view covers: the caller's own task, its direct
 * children, and the tasks adjacent to it through a dependency edge — both
 * directions, each labelled with what the edge means (`from` must verify before
 * `to`). Sorted by task id, so the list is stable across reads.
 */
declare function relatedEntries(snapshot: TaskSnapshot, self: TaskInstance): RelatedEntry[];
/**
 * The dynamic half (A2 §D/§9): the run's status and phase, the effective gate
 * phase, the recovery marker, and the related tasks. For a reviewer, whose
 * domain is real but whose run is not, the delegated task's state is shown under
 * its review-only label instead of a "your run" line that would be a fiction.
 *
 * Nothing accumulates and nothing varies with the act of reading: two
 * projections of unchanged content are byte-identical, which is what lets the
 * session log deduplicate them.
 */
declare function dynamicProjection(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead>;
/**
 * `task_read` (A2 §D/A2-5), the tool-facing read of the caller's own contract:
 *
 * - a root with an accepted contract reads that contract and its children; a
 *   root whose graph has none reads the named `not-activated` state (whatever
 *   proposal is open, and how a goal is accepted);
 * - a worker reads its own task, criteria, run and re-checked bound content;
 * - a reviewer reads the delegated task's contract, marked review-only, and is
 *   never presented as the executor of a business run;
 * - a member with no run of its own gets `unbound`, never the root's contract.
 */
declare function taskRead(deps: ReadDeps, loaded: LoadedCaller): Promise<ProjectedRead>;
/**
 * `task_status` (A2 §D/A2-5): the caller's own task, its direct children and the
 * tasks directly adjacent to it through a dependency edge (`related`, the
 * default), or every task in the same domain (`graph`). Entries are sorted by
 * task id and paged with an explicit offset; the result states its source and
 * says outright that its pages are not a consistent snapshot of the store.
 *
 * The limit is clamped into 1–100 and a clamp is stated in the result, so a
 * caller that asked for 1000 gets 100 entries *and* knows it asked for more.
 *
 * Every page in this read advances: an entry line is shown whole or the page
 * ends before it. When the page's *first* entry cannot be shown, the page would
 * repeat the same offset forever, so the entry is refused by name
 * (`context-too-large`) with both ways forward — its own record read and the
 * offset that continues the listing past it.
 */
declare function taskStatus(deps: ReadDeps, loaded: LoadedCaller, query: StatusQuery): Promise<ProjectedRead>;
/**
 * `context_read` (A2 §D/A2-5): one record of the caller's own domain, by
 * reference. The reference never authorizes — the caller was resolved first, and
 * the record is looked up inside the caller's graph store. A session reference
 * is checked against the graph's published members before DSH is asked anything,
 * so a session of another graph is refused as `cross-graph` without its history
 * being touched.
 *
 * Task-class records are read whole and paged in UTF-8 bytes when they exceed
 * the output bound; a session read pages by DSH event seq, its own read unit.
 */
declare function contextRead(deps: ReadDeps, loaded: LoadedCaller, query: ContextReadQuery, signal?: AbortSignal): Promise<ProjectedRead>;
//#endregion
//#region src/assembly.d.ts
/**
 * Section name of the assembled contract. The name the old contract-reinjection
 * registered, kept: it is the one slot the immutable half has ever had, now
 * filled from the store at every assembly instead of rendered once at spawn.
 */
declare const WORKER_CONTRACT_SECTION = "singularity:worker-contract";
/** Placement: after the root's `singularity:root` (70) and the worker policy's `singularity:worker` (75). */
declare const WORKER_CONTRACT_ORDER = 80;
/** The dynamic half's context name on the runtime-context plane. */
declare const STATE_CONTEXT_NAME = "singularity:state";
/** Placement among the runtime contexts, after the centrally allocated ones (`CONTEXT_ORDERS` ends at 120). */
declare const STATE_CONTEXT_ORDER = 130;
/** The error a refused assembly throws: the refusal is its name, the detail its message. */
declare class AssemblyRefusalError extends Error {
  readonly refusal: ProjectedReadRefused['refusal'];
  constructor(refusal: ProjectedReadRefused['refusal'], detail: string);
}
/**
 * The one assembly step this package runs (see the module doc for who gets
 * what). Mutates the assembly and delegates; a bound caller whose projection
 * refuses rejects the whole waterfall, which is what refuses the model request.
 */
declare function assembleSingularityContext(service: SingularityContextService, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>;
//#endregion
//#region src/limits.d.ts
/**
 * The one output bound this package has (A2 §D): 16 KiB for a single read —
 * whether that read is a tool-facing record, the reference lists a projection
 * carries, or the outer text of a status page. There is no second budget and no
 * configuration surface: one constant, one accounting, so "how much can a read
 * put in front of a model" has exactly one answer.
 *
 * What the bound never does is truncate silently. A record read pages with an
 * explicit continuation offset; a core contract that cannot fit is refused by
 * name (`context-too-large`) rather than cut; a reference list that does not fit
 * says how many entries it did not show.
 * @module @dangosys/dsh-singularity-context/limits
 */
/** The outer output bound of one context read, in UTF-8 bytes. */
declare const CONTEXT_OUTPUT_LIMIT_BYTES: number;
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
/**
 * Take at most `maxBytes` bytes starting at `offsetBytes` from `text`, never
 * splitting a UTF-8 character.
 *
 * An offset that lands inside a character starts at the next character (the
 * partial bytes belong to a character the caller's page boundary cut, and
 * re-emitting a fraction of one would corrupt it). A page always carries at
 * least one character: a bound smaller than the first character still advances,
 * so a caller that feeds `nextOffset` back never loops on the same offset.
 */
declare function sliceUtf8(text: string, offsetBytes: number, maxBytes: number): Utf8Slice;
/**
 * A byte-metered line list: every line either fits whole — the newline included
 * — or is refused, so no line a caller sees is a cut one. `remaining` is what a
 * caller that wants to bound a *part* of its output (a reference list, say) has
 * left to spend.
 */
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
/** The one-word name of an omission a bounded list reports, so a reader can tell a short list from a cut one. */
declare function omittedLine(noun: string, omitted: number, how: string): string;
//#endregion
//#region src/not-activated.d.ts
/** Every root proposal still going to move: one waiting for a decision, or one waiting to be activated. */
declare function openRootProposals(snapshot: TaskSnapshot | undefined): TaskProposalRoot[];
/** How a store with no root task stands, in the store's own terms. */
declare function storeStateText(snapshot: TaskSnapshot | undefined): string;
/**
 * The not-activated view: the state named, whatever proposal is open, and the
 * one action that changes it — accepting the user's own goal with `task_intake`.
 * The last line is the point of the whole view: no objective is reported,
 * because none has been accepted.
 */
declare function notActivatedLines(graph: CallerGraph, storeId: string, snapshot: TaskSnapshot | undefined): string[];
//#endregion
//#region src/render.d.ts
/**
 * The phase, batch, submission and no-progress facts of one run, appended to a
 * run line: where this run sits in the protocol, in that order, with the batch
 * id only where a batch exists to name. A phase change and a progress marking
 * rewrite these fields, so this is the run's current position, never a history.
 */
declare function runPhaseSuffix(run: TaskRun): string;
/** The same fact for a denser line, where only the phase and the old-record marker fit. */
declare function runPhaseCell(run: TaskRun): string;
/** The acceptance criteria, one line per criterion, in declaration order. */
declare function criteriaLines(criteria: readonly AcceptanceCriterion[]): string[];
/**
 * The two contract facts a reader cannot read off the objective and the criteria
 * table: what the contract assumes and what it constrains. A task created before
 * the contract existed has neither, and renders exactly what it rendered before:
 * nothing is invented for the part the store never held.
 */
declare function contractLines(task: TaskInstance): string[];
/** One contract list on its own — the hard constraints a root briefing carries, or its assumptions. */
declare function constraintItems(task: TaskInstance): readonly string[];
/**
 * The run the caller (or a referenced run) is executing, as the store recorded
 * it: the providers this run was bound to, re-checked against the snapshot the
 * record names before they are shown.
 *
 * Why the re-check is not optional: the record says which bytes the run loaded,
 * and the snapshot path is the only place those bytes still exist. A snapshot
 * that is missing or edited is reported as such, naming the skill — the one
 * thing a read must never do is quietly show what stands at the production skill
 * path now, which would read as "this is what you are running".
 *
 * A run with no binding record, or one whose record names no snapshot, has
 * nothing to claim and renders nothing.
 */
declare function bindingLines(taskRuntime: ReadOnlyTaskRuntime, binding: RunProviderBinding | undefined): Promise<string[]>;
/**
 * The root most distant ancestor of one task: the top of its real parent chain,
 * which is what carries the objective and hard constraints a descendant works
 * under. `brokenAt` names the parent the walk stopped at when the store does not
 * hold it — a chain that leaves the store is reported, never filled in.
 */
declare function rootAncestor(snapshot: TaskSnapshot, task: TaskInstance): {
  readonly task: TaskInstance;
  readonly brokenAt?: string;
};
/** The latest run a task started, by the store's own run order. */
declare function latestRun(snapshot: TaskSnapshot, task: TaskInstance): TaskRun | undefined;
/** The handoff a task was delegated with, when a parent recorded one. */
declare function handoffFor(snapshot: TaskSnapshot, taskId: string): TaskHandoff | undefined;
/**
 * The handoff envelope as a projection (A2 §D): the delegation terms, the
 * decided/assumed/open items, and the references a worker may read for itself.
 * The parent session is named as a `context_read` reference — the one session
 * entry this deployment offers — never as a raw cross-session tool.
 */
declare function handoffLines(handoff: TaskHandoff): string[];
/** The reference lists a handoff carries, as their own lines: what to read for itself. */
declare function handoffReferences(handoff: TaskHandoff): {
  readonly artifacts: string[];
  readonly evidence: string[];
};
/** The complete rendering of one task record. */
declare function taskRecordText(task: TaskInstance): string;
/** The complete rendering of one run record, with the binding re-check appended. */
declare function runRecordText(taskRuntime: ReadOnlyTaskRuntime, run: TaskRun): Promise<string>;
/** The complete rendering of one evidence bundle. */
declare function evidenceRecordText(snapshot: TaskSnapshot, evidence: EvidenceBundle): string;
/**
 * The complete rendering of one review record. A record is identified by its
 * `(taskId, runId)` pair — a review has no id of its own — so the pair is
 * printed first, and a task that settled before any run started says so instead
 * of printing an invented run id.
 */
declare function reviewRecordText(review: ReviewRecord): string;
/** The complete rendering of one diagnosis record. */
declare function diagnosisRecordText(diagnosis: Diagnosis): string;
/**
 * The one-line identity of one task, in the shape both status reads use: status,
 * objective, the latest run with its phase, evidence ids, the most recent review
 * outcome with the detail a reader can act on, and the diagnosis count.
 */
declare function taskSummaryLine(snapshot: TaskSnapshot, task: TaskInstance, roles?: readonly string[]): string;
//#endregion
//#region src/run-binding.d.ts
/**
 * Render one run's binding summary.
 *
 * `read` is the re-check result when the caller re-read the snapshot. A caller
 * that has not read it omits it, and then no readability claim is made in either
 * direction. When it is given and reports defects, they are rendered under a
 * named refusal so a reader is never told to trust content that is not there.
 */
declare function renderRunBinding(binding: RunProviderBinding | undefined, read?: RunBindingRead): string;
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityContext: SingularityContextService;
  }
}
declare class SingularityContextService extends Service {
  static inject: string[];
  /** The registered delegation sources, in registration order; a later registration answers after an earlier one. */
  private readonly reviewerSources;
  constructor(ctx: Context);
  /**
   * Mount the one `system-prompt/assemble` waterfall listener this service owns
   * (`./assembly.ts`): the door the projections reach a real model request
   * through. The registration rides this service's fiber, so it leaves when the
   * service does.
   */
  [Service.init](): void;
  /**
   * Register the narrow source this deployment reads reviewer delegations from
   * (the reviewer ledger). Returns the disposer that removes it again, so a
   * plugin that unloads takes its binding source with it.
   */
  registerReviewerBindingSource(source: ReviewerBindingSource): () => void;
  /**
   * The domain a live session may read, from durable facts. Tools and assembly
   * call this directly when they need the role (or the store) rather than a
   * rendered read.
   */
  resolveCaller(sessionId: string, signal?: AbortSignal): Promise<CallerResolution>;
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
  private load;
  private bindingDeps;
  private readDeps;
  /**
   * The env builder, when this deployment mounts one: the optional source the
   * obligation-coverage line walks up from. Read through `ctx.get`, because a
   * deployment without it must still answer every other read.
   */
  private envBuilder;
}
//#endregion
export { AssemblyRefusalError, BindingDeps, CONTEXT_OUTPUT_LIMIT_BYTES, CallerBase, CallerGraph, CallerResolution, CallerUnbound, ContextReadQuery, EnvPathSource, GraphRecordFacts, LoadedCaller, MembershipNode, NAMED_REFUSALS, NamedRefusal, OutputBudget, ProjectedRead, ProjectedReadOk, ProjectedReadRefused, ReadContinuation, ReadDeps, ReadOnlyGraphs, ReadOnlyTaskRuntime, ReadOnlyTaskStore, RelatedEntry, ReviewReference, ReviewerBindingError, ReviewerBindingFailure, ReviewerBindingRecord, ReviewerBindingSource, STATE_CONTEXT_NAME, STATE_CONTEXT_ORDER, SessionQueryReads, SingularityContextService, SingularityContextService as default, StatusQuery, StatusScope, Utf8Slice, WORKER_CONTRACT_ORDER, WORKER_CONTRACT_SECTION, assembleSingularityContext, bindingLines, constraintItems, contextRead, contractLines, contractProjection, criteriaLines, diagnosisRecordText, dynamicProjection, evidenceRecordText, handoffFor, handoffLines, handoffReferences, isGraphMember, latestRun, loadCaller, notActivatedLines, omittedLine, openRootProposals, read, refused, relatedEntries, renderRunBinding, reviewRecordText, rootAncestor, runPhaseCell, runPhaseSuffix, runRecordText, sliceUtf8, storeStateText, taskRead, taskRecordText, taskStatus, taskSummaryLine, utf8Bytes };