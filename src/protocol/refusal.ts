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
  /** The envelope names a protocol this build declares no version of. */
  'unknown-protocol',
  /** The protocol is declared, but not at the version the fact claims. */
  'version-mismatch',
  /** The protocol and version are declared, but this kind is not. */
  'unknown-kind',
  /** A declaration itself is wrong: an empty name, a bad version, or no kinds. */
  'malformed-declaration',
  /** A declaration names a guarantee outside G1..G4. */
  'unknown-guarantee',
  /** A derived (G4) kind was offered for persistence. Derived state is never stored. */
  'g4-not-persistable',
  /** A second protocol claimed the one compare-and-swap guarantee. */
  'second-g3-instance',
  /** The same protocol and version were declared twice. */
  'duplicate-declaration',
  /** The envelope's own digest does not match its body. */
  'digest-mismatch',
  /** A fact does not link to its predecessor, or its sequence number is not contiguous. */
  'chain-broken',
  /** A reducer met a fact it cannot accept in the state it is in. */
  'illegal-transition',
  /** A write was acknowledged but the bytes read back differently. */
  'write-not-durable',
  /** The log changed underneath this writer: another writer holds the append path. */
  'concurrent-writer',
  /** A task contract is not a contract: no goal, no criteria, or a malformed criterion. */
  'malformed-contract',
  /** A criterion names a verifier this deployment has not registered at that version. */
  'unregistered-verifier',
  /** A fact names a run this task never started. */
  'unknown-run',
  /** A fact names a criterion this task's contract does not declare. */
  'unknown-criterion',
  /** The actor that executed a run tried to judge it, or a verifier judged a criterion that is not its own. */
  'self-reported-evidence',
  /** A criterion already carries a verdict for this run; one criterion has one verdict. */
  'evidence-conflict',
  /** A run cannot settle verified while a criterion has no passing verdict. */
  'unadjudicated-criterion',
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
