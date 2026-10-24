/** Unit-test reviewer port. Native campaign evidence always comes from actual reviewer sessions. */
import { join } from 'node:path'
import { createReviewCommands } from '../../src/review/commands.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun, type Finding } from '../../src/review/protocol.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { acceptanceSubject, submitReview } from '../src/review.ts'
import { declareCaller, taskStateOf, type Apparatus } from '../src/apparatus.ts'
import type { AcceptanceReview } from '../src/submission.ts'
import { sha256 } from '../src/ids.ts'

export function fixtureReview(apparatus: Apparatus, verdict: Finding['verdict'] = 'pass'): AcceptanceReview {
  return async (taskId, run, checks) => {
    const reviewId = 'test-review:' + sha256(`${taskId}/${run.runId}`).slice(0, 24)
    const commands = createReviewCommands(apparatus.store)
    let review = apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)
    if (review === undefined) {
      const agentId = String(agentSessionIdOf(reviewId)),
        key = declareCaller(apparatus, agentId)
      await apparatus.agents.open({ commandId: 'agent:' + agentId, agentId, sessionId: agentId, role: 'review' })
      const subject = Buffer.from(JSON.stringify(await acceptanceSubject(apparatus, taskId, run, checks)))
      const task = taskStateOf(apparatus, taskId)
      await commands.start('start:' + reviewId, reviewId, {
        target: {
          kind: 'acceptance',
          taskId,
          runId: run.runId,
          contractDigest: task.contractDigest!,
          artifactDigest: run.submission!.artifactDigest,
        },
        subject: await apparatus.attachments.saveFile({ name: 'subject.json', data: subject }),
        subjectDigest: sha256(subject),
        criteria: task.contract!.criteria,
        agentId,
        sessionId: agentId,
        identity: apparatus.store.identityOf(key)!,
        workspace: join(apparatus.workspaceRoot, 'reviews', reviewId),
        model: run.bubble!.model,
        method: run.revision,
      })
      review = apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!
    }
    return submitReview(
      apparatus,
      review,
      review.criteria.map(c => {
        const check = checks.find(check => check.criterionId === c.criterionId)
        return {
          criterionId: c.criterionId,
          verdict: check !== undefined && check.verdict !== 'pass' ? check.verdict : verdict,
          detail: check?.detail ?? 'Independent fixture judgment',
          evidence: ['attachment:' + run.submission!.files.artifact.attachmentId],
        }
      }),
    )
  }
}
