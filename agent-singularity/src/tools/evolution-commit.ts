/**
 * What the two commit tools report when they settle an intent a proposal already
 * had open (K2).
 *
 * `evolution_apply` and `evolution_rollback` are the two model-facing entries to
 * the one commit path, and both of them find the same thing after a process died
 * between a commit's durable writes: a proposal carrying an open commit intent.
 * That call is a retry, and its answer has to say so truthfully — which intent
 * was settled, what the reconciliation found, and that the grant it was
 * authorised by is the one recorded on the intent rather than a second human
 * approval. One function for both tools, so the same situation reads the same
 * way in either of them.
 * @module dsh-singularity-agent/tools/evolution-commit
 */

import type { ApplyOutcome, CommitIntentView } from '@dangosys/dsh-singularity-evolution'

/**
 * The lines a commit tool reports for an intent it settled instead of starting a
 * second commit: the intent's own id, what the reconciliation found against
 * production, and the grant the intent already binds.
 * @param intent - the open intent the call found on the proposal.
 * @param recovered - what the service reported for it: `redone` (production still
 * held the state before the commit, so the write was carried out), `written`
 * (production already held the committed content, so only the completion was
 * recorded), or absent — which a service that settled an open intent does not
 * answer, and which is reported rather than guessed.
 */
export function renderOpenIntentRecovery(intent: CommitIntentView, recovered: ApplyOutcome['recovered']): string[] {
  return [
    `recovered commit intent ${intent.intentId} (${recovered ?? 'unreported'}): ${recoveryNote(recovered)}`,
    `no second approval was asked — the intent already binds ${intent.approvalRef}`,
  ]
}

/** What the recovery result means for production, in the words of the commit that performed it. */
function recoveryNote(recovered: ApplyOutcome['recovered']): string {
  switch (recovered) {
    case 'redone':
      return 'production still held the state before this commit, so the same write was carried out and its completion recorded'
    case 'written':
      return 'production already held the content this commit installed, so only its completion was recorded and production was not written again'
    default:
      return 'the service reported no recovery result for a proposal that had an open commit intent — production was left exactly as the intent found it'
  }
}
