import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ProposalReviewChannel, ProposalReviewNotice, ProposalReviewRequest } from "@dangosys/dsh-singularity-task-runtime";
import { ModelSelection } from "@dangosys/dsh-singularity-evolution";
import "@dangosys/dsh-singularity-task";

//#region src/coordination/supervision.d.ts
/** When the automatic trigger accepts failures or completed successful goals for diagnosis. */
type AutoReviewMode = 'all' | 'failed' | 'off';
/** The `supervision` block of agent-singularity's configuration, with every member resolved. */
interface SupervisionConfig {
  /** `all` accepts failures at every node and successful roots; `failed` only failures, `off` none. */
  readonly autoReview: AutoReviewMode;
  /** Recovery attempts one failed source accepts before `iteration-cap`. */
  readonly maxRecoveryRounds: number;
  /** Improvement attempts one verified source accepts before `iteration-cap`. */
  readonly maxImprovementRounds: number;
  /** Review-agent runs (reviewers and supervisors together) one root store may start. */
  readonly coordinationBudget: number;
}
/** Diagnose local failures and completed successful goals; three recovery rounds, two improvement rounds, eight coordination runs per store. */
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
//#region src/index.d.ts
/** Plugin configuration — the deployment's composition, not a model's choice. */
interface Config {
  /** Whether this composition registers the nine `evolution_*` tools on the global layer. `off` — the shipped default, see {@link DEFAULT_EVOLUTION} — registers none of them: no model surface (root, granted worker, or the */
  evolution: 'off' | 'on';
  /** `auto` records deployment preauthorization for method publication; `ask` requests one exact-write approval. */
  publicationApproval?: 'ask' | 'auto';
  /** The review/supervision policy: which terminal reviews are diagnosed on their own, the per-source round caps, and the coordination allowance (see {@link SupervisionConfig}). */
  supervision?: SupervisionConfig;
}
/** The shipped switch position: `off`. */
declare const DEFAULT_EVOLUTION: 'off';
/** The evolution exposure this composition resolved, provided on the agent's own fiber as `ctx.singularityEvolution`. */
declare class EvolutionExposure extends Service {
  /** `true` when `Config.evolution` is `on`, i.e. the nine `evolution_*` tools are registered. */
  readonly enabled: boolean;
  readonly publicationApproval: 'ask' | 'auto';
  constructor(ctx: Context, enabled: boolean, publicationApproval: 'ask' | 'auto');
}
/** The supervision policy this composition resolved, provided on the agent's own fiber as `ctx.singularitySupervision` — what the task runtime's per-source round caps read. */
declare class SupervisionExposure extends Service {
  readonly autoReview: SupervisionConfig['autoReview'];
  readonly maxRecoveryRounds: number;
  readonly maxImprovementRounds: number;
  readonly coordinationBudget: number;
  constructor(ctx: Context, policy: SupervisionConfig);
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    singularityEvolution: EvolutionExposure;
    singularitySupervision: SupervisionExposure;
  }
}
/** The model selection the evolution plane freezes with an experiment and re-reads before a promotion (see `Config.modelSelection` of the evolution service). */
declare function deploymentModelSelection(ctx: Context): ModelSelection | undefined;
declare class SingularityAgent extends Service {
  static inject: string[];
  static Config: z<Config>;
  /** The evolution ledger this assembly owns — kept as a field because the startup reconciliation (`[Service.init]`, below) settles its open commit intents before this plugin becomes ready, whether or not. */
  private readonly evolution;
  constructor(ctx: Context, config?: Config);
  /** The startup reconciliation (K2): before this plugin is ready — and whatever the tool switch says — every commit intent the ledger left open is settled against what production actually holds. */
  protected [Service.init](): Promise<void>;
  /** Refuse a configuration member this plugin does not read. The schema keeps unknown keys on the object it validates, so this is where a caller's typo is caught: */
  private assertClosedConfig;
  /** Report a fact nobody should read as a startup failure — the same soft logger the task runtime uses, so a deployment that mounts no logger still gets the line rather than an exception about it. */
  private warn;
}
//#endregion
export { type AutoReviewMode, Config, DEFAULT_EVOLUTION, DEFAULT_SUPERVISION, EscalationService, type HitlAnswer, HitlService, ProposalReviewService, SingularityAgent, SingularityAgent as default, type SupervisionConfig, deploymentModelSelection };