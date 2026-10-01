/** What the two proposing tools (`task_decompose`, `task_intake`) share: the version/key/revision parameters, and the answer a subject waiting for review gets. @module @dangosys/dsh-singularity-agent/tools/proposal-shared */

import type { Context } from '@deepseek-ai/cordis'
import type { IntegerValueSchemaSpec, StringValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** How one tool words the three submission parameters: what its version line names, what a revision names, and where a missing request key comes from. */
export interface ProposalParameterWording {
  /** What the declared contract version is written for (`batch` / `intake`). */
  readonly versionSubject: string
  /** The record a revision supersedes (`batch` / `contract`). */
  readonly revisionSubject: string
  /** What the runtime derives a missing request key from. */
  readonly derivation: string
}

/** The three parameters both proposing tools declare. */
export interface ProposalSubmissionParameters {
  readonly contractVersion: IntegerValueSchemaSpec
  readonly requestKey: StringValueSchemaSpec
  readonly supersedes: StringValueSchemaSpec
}

/** The three parameters both proposing tools declare, worded for the tool handing them in. */
export function proposalSubmissionParameters(wording: ProposalParameterWording): ProposalSubmissionParameters {
  return {
    contractVersion: {
      type: 'integer',
      description:
        `Contract version this ${wording.versionSubject} is written under. The runtime stores version 1 and refuses a declared version it does not know, ` +
        'so callers normally omit this field and let the runtime write the current version',
    },
    requestKey: {
      type: 'string',
      description:
        'The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime ' +
        `derives one from ${wording.derivation} when this is omitted). One key names at most one proposal: repeating a ` +
        'request with the same key is answered with the proposal already stored, while the same key with different content is refused. A ' +
        'revision is different content, so it needs a new key',
    },
    supersedes: {
      type: 'string',
      description:
        `The proposal id this ${wording.revisionSubject} revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the ` +
        'history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the ' +
        'new request key this submission needs',
    },
  }
}

/** One subject waiting for a review, as the tool that proposed it answers. */
export interface PendingReviewTextInput {
  readonly ctx: Context
  readonly storeId: string
  readonly proposalId: string
  readonly detail: string
  /** The tool whose call is waiting, as it names itself (`task_decompose`). */
  readonly tool: string
  /** What the wait holds, completing the first line: `this batch, and t1 has not been decomposed`. */
  readonly holding: string
  /** The lines after the detail line: what approval and refusal mean, and what not to repeat. */
  readonly lines: readonly string[]
}

/** The answer a proposing tool gives while its subject waits for review: the policy read back off the record, and the caller's next move. */
export async function pendingReviewText(input: PendingReviewTextInput): Promise<string> {
  let policy = 'unknown — the proposal record could not be read back'
  try {
    policy = `${(await input.ctx.taskRuntime.proposalIn(input.storeId, input.proposalId)).policy}`
  } catch {
    // The subject is recorded and waiting either way; only this rendering is thin.
  }
  return [
    `${input.tool} is waiting for a review: proposal ${input.proposalId} (policy ${policy}) holds ${input.holding}.`,
    `- ${input.detail}`,
    ...input.lines,
  ].join('\n')
}
