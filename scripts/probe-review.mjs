/** Offline protocol probes: seal real bytes and record the independent checker as a ReviewRun. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { digestOf } from '../src/protocol/envelope.ts'
import { TASK_PROTOCOL, TASK_VERSION } from '../src/task/protocol.ts'
import { createAgentNodeCommands } from '../src/agent/commands.ts'
import { createReviewCommands } from '../src/review/commands.ts'
import { REVIEW_ROLE } from '../src/review/protocol.ts'
import { createHash } from 'node:crypto'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export async function reviewed(store, registry, commands, taskId, verdict) {
  const task = store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, taskId),
    run = task.runs[verdict.runId]
  const save = async (name, bytes) => {
    const digest = sha256(bytes),
      dir = join(run.bubble.workspace.ref, '.probe-sealed')
    await mkdir(dir, { recursive: true })
    try {
      await writeFile(join(dir, digest), bytes, { flag: 'wx', mode: 0o400 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    return { attachmentId: 'sha256:' + digest, name, bytes: bytes.length }
  }
  if (run.stage === 'working')
    await commands.submitRun({
      commandId: 'seal:' + taskId + '/' + run.runId,
      taskId,
      runId: run.runId,
      submission: {
        requestId: 'probe:' + taskId + '/' + run.runId,
        requestDigest: digestOf({ taskId, runId: run.runId }),
        artifactDigest: verdict.artifactDigest,
        inputDigests: verdict.inputDigests,
        files: {
          artifact: await save(
            task.contract.artifact,
            await readFile(join(run.bubble.workspace.ref, task.contract.artifact)),
          ),
          inputs: await Promise.all(
            run.bubble.inputs.map(async (input) => ({
              name: input.name,
              attachment: await save(input.name, await readFile(join(run.bubble.workspace.ref, input.name))),
            })),
          ),
        },
        source: {
          sessionId: String(store.sessionId),
          eventCount: store.load().entries().length,
          digest: digestOf(store.load().entries()),
        },
      },
    })
  const agentId = 'probe-independent-checker',
    as = 'agent:' + agentId,
    reviewId = 'probe-review:' + taskId + '/' + run.runId
  store.declareSubject(as, 'probe-independent-checker-identity')
  store.declareSubject(REVIEW_ROLE, 'probe-review-service')
  await createAgentNodeCommands({ store, registry }).open({
    commandId: 'probe-review-agent',
    agentId,
    sessionId: agentId,
    role: 'review',
  })
  const review = createReviewCommands(store),
    subject = Buffer.from(
      JSON.stringify({
        taskId,
        runId: run.runId,
        contract: task.contract,
        artifactDigest: verdict.artifactDigest,
        checks: [verdict],
      }),
    )
  await review.start('start:' + reviewId, reviewId, {
    target: {
      kind: 'acceptance',
      taskId,
      runId: run.runId,
      contractDigest: task.contractDigest,
      artifactDigest: verdict.artifactDigest,
    },
    subject: await save('subject.json', subject),
    subjectDigest: sha256(subject),
    criteria: task.contract.criteria,
    agentId,
    sessionId: agentId,
    identity: store.identityOf(as),
    workspace: run.bubble.workspace.ref,
    method: run.revision,
    model: run.bubble.model,
  })
  const findings = task.contract.criteria.map((c) => ({
    criterionId: c.criterionId,
    verdict: verdict.verdict,
    detail: verdict.detail ?? 'Real protected checker result',
    evidence: [verdict.artifactDigest],
  }))
  await review.complete(
    'complete:' + reviewId,
    reviewId,
    findings,
    await save('review.json', Buffer.from(JSON.stringify(findings))),
    as,
  )
  return { ...verdict, reviewId }
}
