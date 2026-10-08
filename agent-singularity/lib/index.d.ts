import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ProposalReviewChannel, ProposalReviewNotice, ProposalReviewRequest } from "@dangosys/dsh-singularity-task-runtime";
import { ModelSelection, aggregateEvaluation, calibrateNoise, exploration, refutationFor, renderHistory, screenBeforeMeasurement } from "@dangosys/dsh-singularity-evolution";

//#region src/coordination/supervision.d.ts

/** The supervision policy in force for this deployment — agent-singularity's `supervision` config, resolved once at plugin construction and read by the coordination ledger and the RSI loop driver. @module @dangosys/dsh-singularity-agent/supervision */
/**
 * The `supervision` block of agent-singularity's configuration, with every
 * member resolved. It carries the one knob this deployment still owns: the
 * coordination allowance. The per-source round caps a *store* runs under belong
 * to the graph whose RSI loop schedules it (see {@link graphImprovementCap}), and
 * the runtime's own constants are the backstop for a store without one.
 */
interface SupervisionConfig {
  /** Review-agent runs (reviewers and the RSI loop's supervisors together) one root store may start. */
  readonly coordinationBudget: number;
}
/** Eight coordination runs per store. */
declare const DEFAULT_SUPERVISION: SupervisionConfig;
//#endregion
//#region src/services/hitl.d.ts
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
/** The canvas answerer on the native interaction seams: root tools ask through `ctx.userQuestions` / `ctx.approval` (audit events and fail-closed semantics live there), and this service is the answerer. */
declare class HitlService extends Service {
  static inject: string[];
  private readonly waiters;
  private readonly lifetime;
  constructor(ctx: Context);
  list(): readonly HitlPending[];
  answer(id: string, answer: HitlAnswer): void;
  private enqueue;
  /**
   * Ask only when the graph runs with a human: `rsi.humanReview === false` resolves the card on the spot
   * (approve → approved, ask → {@link UNMANNED_ASK_ANSWER}) and never queues one, so the pending list cannot grow.
   */
  private enqueueForGraph;
  private queue;
}
//#endregion
//#region src/services/escalation.d.ts
/** What raised the card. The three non-human values are the orchestrator's trigger sites (plan phase 3.1). */
type EscalationTrigger = 'capability-gap' | 'budget-exhausted' | 'unknown-convergence' | 'human';
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
declare module '@deepseek-ai/cordis' {
  interface Context {
    escalation: EscalationService;
  }
}
/** Plugin config; every field optional — the constructor resolves the default. */
interface Config$1 {
  /** Directory of the ledger file `escalations.jsonl`. Omitted resolves to `$DSH_HOME`, falling back to `<repo root>/.dsh` when `DSH_HOME` is unset — the same derivation as the evolution ledger, whose file sits one level */
  root?: string;
}
/** The escalation ledger (plane separation: this store is independent of the task store and refers to it by id only). */
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
  /** Record one card. The caller (the `escalate` tool) must hold a human grant from `ctx.approval.request` first and pass its call id as `approvalRef` (`approval:<callId>`, the evolution_decide shape): a rejected, cancelled, */
  raise(input: EscalationInput, actor: string, approvalRef: string): Promise<Escalation>;
  /** Folded view of one card, or throws on an unknown id. */
  get(escalationId: string): Promise<Escalation>;
  /** Folded views, newest card first. */
  list(): Promise<Escalation[]>;
  /** Fold records into cards, enforcing the payload rules on every step: a `raised` line starts a new id, a repeated id is refused, and every field is re-validated, so an illegal line fails load exactly as it would fail */
  private fold;
  private load;
  /** Validate the staged fold first; memory commits only after the line is on disk. */
  private append;
}
//#endregion
//#region src/services/proposal-review.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    proposalReviewChannel: ProposalReviewService;
  }
}
/** The decider identity the channel records: the approval surface of the owner session the review was shown in. */

/** The review channel this deployment mounts (T2/T3 §5–§6). It renders, asks, and records; */
declare class ProposalReviewService extends Service implements ProposalReviewChannel {
  private readonly lifetime;
  constructor(ctx: Context);
  requestReview(request: ProposalReviewRequest): Promise<ProposalReviewNotice>;
  /** One human answer, turned into the only thing that can move a waiting proposal: a decision on the record. An approval is recorded as `approved` (the runtime then re-checks the batch and admits it); an explicit refusal as */
  private record;
  /** The live agent behind one session, or `undefined` — an absent registry or a departed session is a state, not a throw. */
  private liveAgent;
  /** Whether one session's approval policy asks a person at all. The policy is the approval service's own (a session override, else the configured default): under `never` the service answers `rejected` without dispatching */
  private asksAPerson;
  /** The runtime that owns the store; resolved lazily, because the store is opened after this service is mounted. */
  private runtime;
  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn;
  /** The same seam at info level, for the trace of a decision that landed. */
  private info;
}
//#endregion
//#region src/tools/method-shared.d.ts
/**
 * One method change, as the console reads it off the event stream. The id is
 * whichever store moved: a draft, a published revision, or the pointer switch a
 * publication or rollback opened. The producer is the method plane; the console
 * re-reads `/singularity/methods` when one arrives rather than assembling a
 * projection from the frame.
 */
interface MethodsChangeFrame {
  readonly draftId?: string;
  readonly revisionId?: string;
  readonly intentId?: string;
  readonly actor?: string;
  readonly at?: string;
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A method store moved: a draft, a measurement, a publication or a pointer switch. */
    'methods/change'(frame: MethodsChangeFrame): void;
  }
}
/** Which decision path a graph's own record puts method publication in. */
//#endregion
//#region src/index.d.ts
/** Plugin configuration — the deployment's composition, not a model's choice. */
interface Config {
  /** Whether this composition registers the six `method_*` tools on the global layer. `on` — the shipped default, see {@link DEFAULT_METHOD_TOOLS} — registers all six; `off` registers none, so no model surface (root, granted worker) can read, draft or publish a method. */
  methodTools: 'off' | 'on';
  /** The review/supervision policy: the coordination allowance a store's coordination agents spend (see {@link SupervisionConfig}). */
  supervision?: SupervisionConfig;
}
/** The shipped switch position: `on` — the method tools are the one way a method changes. */
declare const DEFAULT_METHOD_TOOLS: 'on';
/** The method-tool exposure this composition resolved, provided on the agent's own fiber as `ctx.singularityMethods`. */
declare class MethodToolsExposure extends Service {
  /** `true` when `Config.methodTools` is `on`, i.e. the six `method_*` tools are registered. */
  readonly enabled: boolean;
  constructor(ctx: Context, enabled: boolean);
}
/** The supervision policy this composition resolved, provided on the agent's own fiber as `ctx.singularitySupervision` — the coordination allowance the ledger reads, and the per-store round cap the task runtime's recovery entry reads. */
declare class SupervisionExposure extends Service {
  readonly coordinationBudget: number;
  constructor(ctx: Context, policy: SupervisionConfig);
  /**
   * The round cap in force for one store: the round count its graph's RSI
   * settings declare when that graph runs a platform loop (the driver registers
   * it — see `coordination/driver.ts`), `undefined` otherwise, so the
   * runtime's own constant stands for every store without one. The runtime's
   * `iteration-cap` check reads this per store, so a graph-scheduled loop may
   * open exactly the rounds its graph names — and since the driver is the only
   * caller that opens a round any more, the same answer governs its recoveries.
   */
  maxImprovementRoundsFor(storeId: string): number | undefined;
  /** The recovery-round cap in force for one store: the graph's own round count for a driver-scheduled store, `undefined` otherwise (the runtime's constant then stands). */
  maxRecoveryRoundsFor(storeId: string): number | undefined;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityMethods: MethodToolsExposure;
    singularitySupervision: SupervisionExposure;
  }
}
/** The model selection the evolution plane freezes with an experiment and re-reads before a promotion (see `Config.modelSelection` of the evolution service). */
declare function deploymentModelSelection(ctx: Context): ModelSelection | undefined;
declare class SingularityAgent extends Service {
  static inject: string[];
  static Config: z<Config>;
  /** The v4 evolution ledger this assembly mounts — kept as a field so `[Service.init]` can await its readiness (see below); its commit intents are settled by the task runtime's barrier, not here. */
  private readonly evolution;
  constructor(ctx: Context, config?: Config);
  /**
   * The startup readiness gate: before this plugin is ready, the legacy ledger
   * this assembly mounts is read once, so an unreadable one is refused by name
   * here rather than surfacing later as an unhandled rejection. Its open commit
   * intents are not settled — the task runtime's activation barrier calls
   * `reconcileEvolutionCommits` when a graph is taken over, and the v5 pointer
   * intent is the task runtime's `reconcilePointer`.
   */
  protected [Service.init](): Promise<void>;
  /** Refuse a configuration member this plugin does not read. The schema keeps unknown keys on the object it validates, so this is where a caller's typo is caught: */
  private assertClosedConfig;
  /** Report a fact nobody should read as a startup failure — the same soft logger the task runtime uses, so a deployment that mounts no logger still gets the line rather than an exception about it. */
  private warn;
}
//#endregion
export { Config, DEFAULT_METHOD_TOOLS, DEFAULT_SUPERVISION, EscalationService, type HitlAnswer, HitlService, type MethodsChangeFrame, ProposalReviewService, SingularityAgent, SingularityAgent as default, type SupervisionConfig, deploymentModelSelection };