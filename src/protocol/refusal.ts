/**
 * The one refusal contract.
 *
 * Every rejection in this codebase is a named refusal carrying a stable code. Callers branch
 * on `code`, never on message text; no path throws a bare string, invents a default, or
 * continues with partial data.
 *
 * @module singularity-core/protocol/refusal
 */

/** Every way this protocol stack may refuse. Adding one is a protocol change, not a detail. */
export const REFUSAL_CODES = [
  /** The framing itself is wrong: a missing member, an unknown member, or a wrong type. */
  'malformed-envelope',
  /** A payload carries a member its kind does not declare, or a member has the wrong type. */
  'malformed-payload',
  /**
   * A value offered as content identity is not losslessly JSON. JSON turns `NaN` into `null` and
   * drops `undefined` members, so without this restriction two different facts could carry one
   * content identity.
   */
  'not-lossless-json',
  /** The envelope names a protocol this build declares no version of. */
  'unknown-protocol',
  /** The protocol is declared, but not at the version the fact claims. */
  'version-mismatch',
  /** The protocol and version are declared, but this kind is not. */
  'unknown-kind',
  /** A declaration itself is wrong: an empty name, a bad version, an empty kind set, or no emitter. */
  'malformed-declaration',
  /** A declaration names a guarantee combination that cannot hold. */
  'unknown-guarantee',
  /** A fact's kind names an emitter role this deployment has no trusted identity for. */
  'unknown-emitter-role',
  /** A derived kind was offered for persistence. Derived state is folded, never written. */
  'derived-not-persistable',
  /** A second protocol claimed the one conditional-update (compare-and-swap) discipline. */
  'second-conditional-owner',
  /** The same protocol and version were declared twice. */
  'duplicate-declaration',
  /** The log changed underneath this writer: another writer holds the append path. */
  'concurrent-writer',
  /** The same command id arrived carrying a different request. */
  'command-conflict',
  /** A write was acknowledged but the bytes read back differently, or did not arrive at all. */
  'write-not-durable',
  /** A fact does not link to its predecessor, or its sequence number is not contiguous. */
  'chain-broken',
  /** The envelope's own digest does not match its body. */
  'digest-mismatch',
  /** A reducer met a fact it cannot accept in the state it is in. */
  'illegal-transition',
  /** A decomposition declares a dependency cycle. The shape is legal; no execution order satisfies it. */
  'cyclic-dependency',
  /** The actor is not the agent currently responsible for the task, or nobody is. */
  'not-responsible',
  /** A verdict was formed on inputs other than the ones the run's bubble declared. */
  'evidence-input-mismatch',
  /** A task contract is not a contract: no goal, no criteria, an unknown member, or a bad criterion. */
  'malformed-contract',
  /** A criterion names a verifier this deployment cannot currently run at that version. */
  'unregistered-verifier',
  /** A fact names a run this task never started. */
  'unknown-run',
  /** A run is pinned to a revision this log never recorded, or the wrong content for that id. */
  'unknown-revision',
  /** A fact names a criterion this task's contract does not declare. */
  'unknown-criterion',
  /** The emitter role that produced a verdict may not judge this run, or may not decide this criterion. */
  'self-reported-evidence',
  /** A verdict came from a different verifier implementation than the criterion names. */
  'wrong-verifier',
  /** A criterion already carries a verdict for this run, or a trial slot already carries an observation. */
  'evidence-conflict',
  /** A revision id was offered twice with different content; content addressing forbids it. */
  'revision-conflict',
  /** A run cannot settle verified while a criterion has no passing verdict. */
  'unadjudicated-criterion',
  /** Two measurements are not comparable: their frozen calibers differ, so pooling their scores would compare different questions. */
  'caliber-mismatch',
  /** An approval names a draft digest that is no longer the draft's: the content moved after it was approved. */
  'stale-approval',
  /** A pointer would move the head to a revision that exists but nobody approved. */
  'unapproved-revision',
] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

/** The one shape a refusal has. `code` is the contract; `detail` is for the reader. */
export interface Refusal {
  readonly code: RefusalCode
  readonly detail: string
}

/** The one error type. A refusal is data, so callers and the UI can render it identically. */
export class ProtocolRefusal extends Error {
  readonly refusal: Refusal

  constructor(refusal: Refusal) {
    super(`${refusal.code}: ${refusal.detail}`)
    this.name = 'ProtocolRefusal'
    this.refusal = refusal
  }
}

/** Refuse, by name, with no way to continue. */
export function refuse(code: RefusalCode, detail: string): never {
  throw new ProtocolRefusal({ code, detail })
}
