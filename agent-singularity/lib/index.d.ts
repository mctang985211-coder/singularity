import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ProposalReviewChannel, ProposalReviewNotice, ProposalReviewRequest } from "@dangosys/dsh-singularity-task-runtime";
import { ModelSelection } from "@dangosys/dsh-singularity-evolution";
import "@dangosys/dsh-singularity-task";

//#region src/hitl.d.ts
type HitlKind = 'ask' | 'approve';
interface HitlPending {
  readonly id: string;
  readonly kind: HitlKind;
  readonly prompt: string;
  readonly sessionId: string;
  readonly createdAt: number;
}
type HitlAnswer = {
  readonly kind: 'ask';
  readonly text: string;
} | {
  readonly kind: 'approve';
  readonly decision: 'approve' | 'reject';
};
declare module '@deepseek-ai/cordis' {
  interface Context {
    hitl: HitlService;
  }
  interface Events {
    'hitl/change'(pending: readonly HitlPending[]): void;
  }
}
/**
 * The canvas answerer on the native interaction seams: root tools ask through
 * `ctx.userQuestions` / `ctx.approval` (audit events and fail-closed semantics
 * live there), and this service is the answerer that bridges those waterfalls
 * onto the pending-card store the canvas UI polls over `GET/POST
 * /singularity/hitl` and the `hitl/change` SSE. A card the canvas cannot
 * present faithfully (a multi-question batch) is delegated to `next()`, so the
 * native NO_PROVIDER / 'unavailable' fail-closed path stays intact.
 *
 * Both listeners are registered with `prepend`, ahead of every listener
 * already on the event. The gateway's mux forwarder (api-remotes) claims
 * `approval/request` by position and parks the request until a browser mux
 * client answers or delegates; with zero clients attached it never calls
 * `next()`, so a later listener never sees the request at all (guide §4.2
 * #17). Claiming first makes this service the decision surface either way;
 * the native answerer chain below it is untouched.
 */
declare class HitlService extends Service {
  static inject: string[];
  private readonly waiters;
  private readonly lifetime;
  constructor(ctx: Context);
  list(): readonly HitlPending[];
  answer(id: string, answer: HitlAnswer): void;
  private enqueue;
}
//#endregion
//#region src/escalation.d.ts
/** What raised the card. The three non-human values are the orchestrator's trigger sites (plan phase 3.1). */
type EscalationTrigger = 'capability-gap' | 'budget-exhausted' | 'unknown-convergence' | 'human';
declare const ESCALATION_TRIGGERS: readonly EscalationTrigger[];
interface EscalationInput {
  /** Caller-supplied id; omitted derives one (`esc-<uuid>`). */
  escalationId?: string;
  /** KISS §7 element 1: what is missing. */
  what: string;
  /** KISS §7 element 2: what was already tried. */
  tried: string;
  /** KISS §7 element 3: what is suggested. */
  suggested: string;
  trigger: EscalationTrigger;
  /** The task the card is about, when it has one. */
  sourceTaskId?: string;
  /** Evidence / task / diagnosis refs behind the card. */
  sourceRefs?: readonly string[];
}
/** Folded view of one card. */
interface Escalation {
  escalationId: string;
  what: string;
  tried: string;
  suggested: string;
  trigger: EscalationTrigger;
  /** An open card awaits a human decision; the ledger records the card, never the decision. */
  status: 'open';
  sourceTaskId?: string;
  sourceRefs: string[];
  /** Human-review evidence: the approval call id of the escalate request that granted this record. */
  approvalRef: string;
  actor: string;
  at: string;
  /** One entry per ledger record — derived, never stored. */
  history: {
    status: 'open';
    actor: string;
    at: string;
  }[];
}
/** One immutable ledger line. A state migration appends a new record; nothing is ever rewritten in place. */
type EscalationRecord = {
  formatVersion: 1;
  kind: 'raised';
  escalationId: string;
  what: string;
  tried: string;
  suggested: string;
  trigger: EscalationTrigger;
  sourceTaskId?: string;
  sourceRefs: string[];
  approvalRef: string;
  actor: string;
  at: string;
};
declare module '@deepseek-ai/cordis' {
  interface Context {
    escalation: EscalationService;
  }
}
/** Plugin config; every field optional — the constructor resolves the default. */
interface Config$1 {
  /**
   * Directory of the ledger file `escalations.jsonl`. Omitted resolves to
   * `$DSH_HOME`, falling back to `<repo root>/.dsh` when `DSH_HOME` is unset —
   * the same derivation as the evolution ledger, whose file sits one level
   * deeper at `.dsh/evolution/proposals.jsonl`.
   */
  root?: string;
}
/**
 * The escalation ledger (plane separation: this store is independent of the
 * task store and refers to it by id only). Append and replay share one fold,
 * so a corrupt or duplicated line fails loudly instead of silently drifting.
 * Writes are serialized; the file is opened per append, so closing the service
 * is just draining the write queue.
 */
declare class EscalationService extends Service {
  /** Absolute ledger directory resolved at construction. */
  readonly root: string;
  /** Repo root that relative paths resolve against. */
  readonly repoRoot: string;
  private records;
  private readonly loaded;
  private writes;
  constructor(ctx: Context, config?: Config$1);
  /** Ledger file path (`<root>/escalations.jsonl`). */
  get file(): string;
  /**
   * Record one card. The caller (the `escalate` tool) must hold a human grant
   * from `ctx.approval.request` first and pass its call id as `approvalRef`
   * (`approval:<callId>`, the evolution_decide shape): a rejected, cancelled,
   * or unavailable ask must never reach this method. Payload validation runs
   * before anything touches disk.
   */
  raise(input: EscalationInput, actor: string, approvalRef: string): Promise<Escalation>;
  /** Folded view of one card, or throws on an unknown id. */
  get(escalationId: string): Promise<Escalation>;
  /** Folded views, newest card first. */
  list(): Promise<Escalation[]>;
  /**
   * Fold records into cards, enforcing the payload rules on every step: a
   * `raised` line starts a new id, a repeated id is refused, and every field
   * is re-validated, so an illegal line fails load exactly as it would fail
   * append.
   */
  private fold;
  private load;
  /** Validate the staged fold first; memory commits only after the line is on disk. */
  private append;
}
//#endregion
//#region src/proposal-review.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    proposalReviewChannel: ProposalReviewService;
  }
}
/**
 * The owner session of a task store — whose approval surface a review of that
 * store's batches belongs on — or `undefined` for an id this deployment did not
 * build.
 *
 * The parse is re-checked through {@link rootTaskStoreId} rather than trusted:
 * the mapping from a root session to its store belongs to the task package, and
 * a string that merely looks like one must not name a session that never owned
 * a store (which would route a review into a stranger's conversation).
 */
declare function ownerSessionOfStore(storeId: string): string | undefined;
/**
 * The decider identity the channel records: the approval surface of the owner
 * session the review was shown in. Deliberately a channel-shaped value — the
 * same `approval:` family the native grants use (`escalate`, `evolution_decide`)
 * — because a reader of the record must be able to tell a human grant apart
 * from a session id and from anything a model could have written.
 */
declare function reviewDecider(ownerSessionId: string): string;
/**
 * The review material one person is shown (§5), rendered from the saved facts:
 * for a batch, the parent, every child, the limits, the obligations, the
 * identity a decision binds and what this record honestly cannot promise; for a
 * root contract, the contract itself and no parent at all — the task it becomes
 * does not exist while it waits.
 *
 * The subject is discriminated by kind, and the two arms share every part that
 * means the same thing in both (the limits, the identity, the boundary
 * statements): a reviewer deciding a root intake is answering a different
 * question, not reading a one-child batch of nobody.
 *
 * A pure function of the request, so what a deployment shows and what a test
 * asserts are the same rendering.
 */
declare function renderProposalReview(request: ProposalReviewRequest): string;
/**
 * The review channel this deployment mounts (T2/T3 §5–§6). It renders, asks, and
 * records; it never admits anything itself — a recorded decision is what moves a
 * proposal, and the runtime performs the post-approval re-check and the
 * admission on its own.
 */
declare class ProposalReviewService extends Service implements ProposalReviewChannel {
  private readonly lifetime;
  constructor(ctx: Context);
  requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice>;
  /**
   * One human answer, turned into the only thing that can move a waiting
   * proposal: a decision on the record. An approval is recorded as `approved`
   * (the runtime then re-checks the batch and admits it); an explicit refusal as
   * `rejected`, naming who refused. Nothing else is written: `unavailable` and
   * `cancelled` are states of the ask, and §6 allows exactly one decision per
   * proposal — so a store that refuses this write because the proposal moved on
   * meanwhile is warned about, never retried into a second decision.
   */
  private record;
  /** The live agent behind one session, or `undefined` — an absent registry or a departed session is a state, not a throw. */
  private liveAgent;
  /**
   * Whether one session's approval policy asks a person at all. The policy is
   * the approval service's own (a session override, else the configured
   * default): under `never` the service answers `rejected` without dispatching
   * anything, so a request routed there would look like a human refusal.
   * Reading it before asking is what keeps that outcome from being invented.
   */
  private asksAPerson;
  /** The runtime that owns the store; resolved lazily, because the store is opened after this service is mounted. */
  private runtime;
  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn;
  /** The same seam at info level, for the trace of a decision that landed. */
  private info;
}
//#endregion
//#region src/index.d.ts
/**
 * Plugin configuration — the deployment's composition, not a model's choice.
 *
 * R0's contract (§1.3 of the guide, defect G15) is that the default run
 * exposes only what the current role needs, so the evolution chain is something
 * a deployment turns *on*: the tools it is reached through are registered by
 * this plugin, and with the chain off none of them exists on any surface. The
 * switch cannot be a permission check inside a tool for the same reason: a
 * spawned worker keeps the global layer when its grant does not override it, so
 * "who may call this" is not a question this deployment gets to ask at call
 * time — "does this tool exist here" is.
 */
interface Config {
  /**
   * Whether this composition registers the nine `evolution_*` tools on the
   * global layer. `off` — the shipped default, see {@link DEFAULT_EVOLUTION} —
   * registers none of them: no model surface (root, granted worker, or the
   * un-granted spawn worker that inherits the global layer) can call one, and
   * the ledger, its history, its validation and its approvals are left exactly
   * as they are rather than deleted. `on` registers all nine and changes
   * nothing else about them: the previous assembly, byte for byte.
   */
  evolution: 'off' | 'on';
}
/**
 * The shipped switch position: `off`.
 *
 * The default run is the one nobody configured, and R0 asks that this run not
 * carry the evolution chain (guide §1.3: "默认运行只提供当前角色需要的能力").
 * `on` is therefore an explicit act by a deployment, and what it resolved to is
 * readable back from the context ({@link EvolutionExposure}) — a switch whose
 * position cannot be read is one nobody can tell from an unwired exposure.
 */
declare const DEFAULT_EVOLUTION: 'off';
/**
 * The evolution exposure this composition resolved, provided on the agent's own
 * fiber as `ctx.singularityEvolution`.
 *
 * The registration gate in {@link SingularityAgent} is the enforcement; this
 * service is the fact a sibling assembly reads to keep its own surface in step
 * — the root agent's tool allow-list names these nine names and has to leave
 * them out when they were never registered. Read it softly:
 *
 * ```ts
 * const evolution = ctx.get('singularityEvolution')?.enabled ?? false
 * ```
 *
 * A composition that does not mount this plugin provides no such service, and
 * that absence reads as the closed state: a deployment that never turned the
 * chain on must not be assembled as if it had.
 */
declare class EvolutionExposure extends Service {
  /** `true` when `Config.evolution` is `on`, i.e. the nine `evolution_*` tools are registered. */
  readonly enabled: boolean;
  constructor(ctx: Context, enabled: boolean);
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityEvolution: EvolutionExposure;
  }
}
/**
 * The model selection the evolution plane freezes with an experiment and
 * re-reads before a promotion (see `Config.modelSelection` of the evolution
 * service).
 *
 * One source for both ends: the deployment's own default selection
 * (`agentDefaultModel.currentSelection()`), which is the configuration a session
 * without an explicit selection runs under — and the selection every replay the
 * runtime spawns for an experiment is now placed under verbatim. The experiment
 * tool freezes exactly this value, so the selection a report is frozen under is
 * the one the gate later re-checks against the runs' own session logs; a
 * deployment that mounts no such service answers `undefined`, and the ledger
 * then refuses to evaluate or promote rather than skipping the check.
 */
declare function deploymentModelSelection(ctx: Context): ModelSelection | undefined;
declare class SingularityAgent extends Service {
  static inject: string[];
  static Config: z<Config>;
  /**
   * The evolution ledger this assembly owns — kept as a field because the startup
   * reconciliation (`[Service.init]`, below) settles its open commit intents
   * before this plugin becomes ready, whether or not the deployment registered the
   * nine tools.
   */
  private readonly evolution;
  constructor(ctx: Context, config?: Config);
  /**
   * The startup reconciliation (K2): before this plugin is ready — and whatever
   * the tool switch says — every commit intent the ledger left open is settled
   * against what production actually holds. The switch is a statement about the
   * model surface, not about recovery: an `off` deployment registers none of the
   * nine tools, and still keeps production consistent with its own ledger.
   *
   * A `blocked` intent is reported by name and does not fail the load: the intent
   * stays open, the admission gate keeps refusing the provider whose target it
   * names, and settling it (a retry of the apply/rollback, the next startup)
   * remains the way forward. A failure of the reconciliation itself is not
   * `blocked` and does fail the load, naming the cause: a deployment that cannot
   * read its ledger cannot promise anything about the production behind it.
   */
  protected [Service.init](): Promise<void>;
  /**
   * Refuse a configuration member this plugin does not read. The schema keeps
   * unknown keys on the object it validates, so this is where a caller's typo
   * is caught: a misspelled member would otherwise read as a configuration that
   * took effect while the switch stayed at its default.
   */
  private assertClosedConfig;
  /**
   * The switch position this assembly acts on. The schema types the member, but
   * a deployment that constructs this plugin directly (a test, an embedding
   * process) bypasses the schema, and a near miss must not be read as "not on,
   * therefore off": a caller who asked for something this build does not
   * implement would get the closed composition while believing otherwise.
   */
  private resolveEvolution;
  /**
   * Report a fact nobody should read as a startup failure — the same soft logger
   * the task runtime uses, so a deployment that mounts no logger still gets the
   * line rather than an exception about it.
   */
  private warn;
}
//#endregion
export { Config, DEFAULT_EVOLUTION, ESCALATION_TRIGGERS, type Escalation, type EscalationInput, type EscalationRecord, EscalationService, type EscalationTrigger, EvolutionExposure, type HitlAnswer, type HitlKind, type HitlPending, HitlService, ProposalReviewService, SingularityAgent, SingularityAgent as default, deploymentModelSelection, ownerSessionOfStore, renderProposalReview, reviewDecider };