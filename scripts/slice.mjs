#!/usr/bin/env node
/**
 * The vertical slice, end to end, against a real file on disk.
 *
 * This is the smoke the gate runs on every check: if the frame, the fold, the task invariants,
 * the projection or either rendering break, this exits non-zero. It is deliberately a script
 * rather than a spec, because the point is to exercise the *built* path the way a deployment
 * would — declare, append, fold, project, read.
 *
 * Run it directly:  node scripts/slice.mjs        (Node strips the types)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  declareTaskProtocol,
  foldSubject,
  ProtocolLog,
  projectReceipt,
  projectTask,
  receiptDigest,
  renderTaskForAgent,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRegistryOf,
  ProtocolRegistry,
} from '../src/index.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'

const TASK = 'task-a'
const RUN = 'run-1'
const EXECUTOR = 'worker-session'
const VERIFIERS = ['unit-verifier@1', 'integration-verifier@1']
const REVISION = { revisionId: 'r0001', digest: 'a'.repeat(64) }

const failures = []
const check = (label, condition) => {
  if (!condition) failures.push(label)
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}`)
}

const emit = (kind, actor, payload) => ({
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind,
  subject: TASK,
  actor,
  payload,
})

const registry = new ProtocolRegistry()
declareTaskProtocol(registry, verifierRegistryOf(VERIFIERS))

const directory = await mkdtemp(join(tmpdir(), 'singularity-slice-'))
const path = join(directory, 'singularity.log')

try {
  const log = await ProtocolLog.open(path, registry)

  await log.emit(
    emit(TASK_KINDS.admitted, 'root', {
      contract: {
        goal: 'implement a word counter',
        inputs: ['fixture/words.txt'],
        criteria: [
          { criterionId: 'correctness', statement: 'counts match the golden file', verifierRef: 'unit-verifier', verifierVersion: '1' },
          { criterionId: 'limits', statement: 'rejects input over 1 MiB', verifierRef: 'integration-verifier', verifierVersion: '1' },
        ],
      },
    }),
  )
  await log.emit(emit(TASK_KINDS.runStarted, EXECUTOR, { runId: RUN, revision: REVISION }))

  // An executor judging its own run must be refused, before anything reaches the disk.
  let refusedSelfJudgement = null
  try {
    await log.emit(emit(TASK_KINDS.evidenceProduced, EXECUTOR, { runId: RUN, criterionId: 'correctness', verdict: 'pass' }))
  } catch (error) {
    if (error instanceof ProtocolRefusal) refusedSelfJudgement = error.refusal.code
    else throw error
  }

  await log.emit(emit(TASK_KINDS.evidenceProduced, 'unit-verifier', { runId: RUN, criterionId: 'correctness', verdict: 'pass' }))
  await log.emit(emit(TASK_KINDS.evidenceProduced, 'integration-verifier', { runId: RUN, criterionId: 'limits', verdict: 'pass' }))
  await log.emit(emit(TASK_KINDS.runVerified, 'root', { runId: RUN }))

  const state = foldSubject(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK)
  const view = projectTask(state)
  const receipt = projectReceipt(state, RUN)

  console.log('')
  console.log(renderTaskForAgent(view))
  console.log('')
  console.log(`  receipt ${receiptDigest(receipt).slice(0, 16)}… (${receipt.status}, derived — never written)`)
  console.log('')

  check('the executor\'s own verdict was refused as self-reported-evidence', refusedSelfJudgement === 'self-reported-evidence')
  check('the task settled verified', view.phase === 'verified')
  check('both criteria carry the verdict of the verifier they named', view.runs[0]?.verdicts.every(verdict => verdict.verdict === 'pass'))
  check('the receipt is derived from the log, not stored', receipt.criteria.length === 2 && view.contractDigest === receipt.contractDigest)

  // Reopening replays everything, and two readers must agree on the receipt.
  const reopened = await ProtocolLog.open(path, registry)
  const refolded = foldSubject(registry, reopened.entries(), TASK_PROTOCOL, TASK_VERSION, TASK)
  check('a reopened log yields the same receipt digest', receiptDigest(projectReceipt(refolded, RUN)) === receiptDigest(receipt))
  check('no receipt kind exists, so a receipt can never be persisted', !Object.values(TASK_KINDS).includes('receipt/sealed'))
} finally {
  await rm(directory, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`slice: ${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('slice: OK — the vertical slice runs end to end')
}
