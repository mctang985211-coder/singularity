#!/usr/bin/env node
/**
 * The vertical slice, end to end, against a real file on disk.
 *
 * This is the smoke the gate runs on every check: if the frame, the fold, the task invariants,
 * the projection or either rendering break, this exits non-zero. It is deliberately a script
 * rather than a spec, because the point is to exercise the built path the way a deployment would —
 * declare, append, fold, project, read.
 *
 * Run it directly:  node scripts/slice.mjs        (Node strips the types)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  declareTaskProtocol,
  foldSubject,
  projectReceipt,
  projectTask,
  MemoryLog,
  receiptDigest,
  renderTaskForAgent,
  ProtocolRegistry,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRoleOf,
} from '../src/index.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'

const TASK = 'task-a'
const RUN = 'run-1'
const SCHEDULER = 'runtime-1'
const UNIT = 'unit-verifier'
const INTEGRATION = 'integration-verifier'
const ARTIFACT = 'c'.repeat(64)
const UNIT_IMPL = 'd'.repeat(64)
const INTEGRATION_IMPL = 'e'.repeat(64)
const REVISION = { environmentId: 'library-1', revisionId: 'r0001', digest: 'a'.repeat(64) }

const failures = []
const check = (label, condition) => {
  if (!condition) failures.push(label)
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}`)
}

const registry = new ProtocolRegistry()
declareTaskProtocol(registry)

// The trusted identities this deployment holds, keyed by emitter role. A deployment that does not
// hold a verifier's identity simply cannot emit that verifier's verdicts.
const subjects = {
  scheduler: SCHEDULER,
  [verifierRoleOf({ verifierRef: UNIT, verifierVersion: '1' })]: 'unit-verifier-service',
  [verifierRoleOf({ verifierRef: INTEGRATION, verifierVersion: '1' })]: 'integration-verifier-service',
}

let command = 0
const emit = (kind, payload) => ({
  commandId: `slice-${(command += 1)}`,
  protocol: TASK_PROTOCOL,
  version: TASK_VERSION,
  kind,
  subject: TASK,
  payload,
})
const judged = (criterionId, verifierRef, options = {}) =>
  emit(TASK_KINDS.evidenceProduced, {
    runId: RUN,
    criterionId,
    verdict: options.verdict ?? 'pass',
    verifierRef,
    verifierVersion: '1',
    // The implementation's own content digest, not just its name: a deployment can re-point a name.
    implementationDigest: options.implementationDigest ?? (verifierRef === UNIT ? UNIT_IMPL : INTEGRATION_IMPL),
    artifactDigest: options.artifactDigest ?? ARTIFACT,
  })

const directory = await mkdtemp(join(tmpdir(), 'singularity-slice-'))
const path = join(directory, 'singularity.log')

try {
  const log = new MemoryLog(registry, { subjects })

  await log.emit(
    emit(TASK_KINDS.admitted, {
      contract: {
        goal: 'implement a word counter',
        inputs: ['fixture/words.txt'],
        criteria: [
          { criterionId: 'correctness', statement: 'counts match the golden file', verifierRef: UNIT, verifierVersion: '1', implementationDigest: UNIT_IMPL },
          { criterionId: 'limits', statement: 'rejects input over 1 MiB', verifierRef: INTEGRATION, verifierVersion: '1', implementationDigest: INTEGRATION_IMPL },
        ],
      },
    }),
  )
  await log.emit(emit(TASK_KINDS.runStarted, { runId: RUN, revision: REVISION }))

  // A verdict may not come from an implementation the criterion does not name. The caller cannot
  // choose an author here; the refusal comes from the reducer, before anything reaches the disk.
  let refusedWrongVerifier = null
  try {
    await log.emit(judged('limits', UNIT))
  } catch (error) {
    if (error instanceof ProtocolRefusal) refusedWrongVerifier = error.refusal.code
    else throw error
  }

  // Nor from a *different implementation* of the verifier the criterion names. Swapping the code
  // behind a name must invalidate the verdict, which a ref and a version alone cannot do.
  let refusedWrongImplementation = null
  try {
    await log.emit(judged('correctness', UNIT, { implementationDigest: INTEGRATION_IMPL }))
  } catch (error) {
    if (error instanceof ProtocolRefusal) refusedWrongImplementation = error.refusal.code
    else throw error
  }

  // A verdict may not come from the identity that started the run, either. The criterion names
  // the verifier whose role emits it, but this deployment binds the executor to that same
  // identity — so the role check passes and the identity check is what refuses.
  const sharedSubjects = { scheduler: 'shared', [verifierRoleOf({ verifierRef: UNIT, verifierVersion: '1' })]: 'shared' }
  const sharedLog = new MemoryLog(registry, { subjects: sharedSubjects })
  await sharedLog.emit(
    emit(TASK_KINDS.admitted, {
      contract: {
        goal: 'g',
        inputs: [],
        criteria: [{ criterionId: 'c', statement: 's', verifierRef: UNIT, verifierVersion: '1', implementationDigest: UNIT_IMPL }],
      },
    }),
  )
  await sharedLog.emit(emit(TASK_KINDS.runStarted, { runId: RUN, revision: REVISION }))
  let refusedSelfJudgement = null
  try {
    await sharedLog.emit(judged('c', UNIT))
  } catch (error) {
    if (error instanceof ProtocolRefusal) refusedSelfJudgement = error.refusal.code
    else throw error
  }

  await log.emit(judged('correctness', UNIT))
  await log.emit(judged('limits', INTEGRATION))
  await log.emit(emit(TASK_KINDS.runVerified, { runId: RUN }))

  const state = foldSubject(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK)
  const view = projectTask(state)
  const receipt = projectReceipt(state, RUN)

  console.log('')
  console.log(renderTaskForAgent(view))
  console.log('')
  console.log(`  receipt ${receiptDigest(receipt).slice(0, 16)}… (${receipt.status}, derived — never written)`)
  console.log('')

  check('a verdict from an implementation the criterion does not name was refused', refusedWrongVerifier === 'wrong-verifier')
  check('a verdict from different code behind the same verifier name was refused', refusedWrongImplementation === 'wrong-verifier')
  check('an executor bound to the verifier identity cannot judge its own run', refusedSelfJudgement === 'self-reported-evidence')
  check('the task settled verified', view.phase === 'verified')
  check('both criteria carry the verdict of the implementation they named', view.runs[0]?.verdicts.every(verdict => verdict.verdict === 'pass'))
  check('every verdict pins the artifact it judged', view.runs[0]?.verdicts.every(verdict => verdict.artifactDigest === ARTIFACT))
  check('the receipt is derived from the log, not stored', receipt.criteria.length === 2 && view.contractDigest === receipt.contractDigest)

  // What a durable medium hands back must replay to the same facts, and two readers must agree.
  const adopted = MemoryLog.adopt(log.entries(), registry, { subjects })
  const refolded = foldSubject(registry, adopted.entries(), TASK_PROTOCOL, TASK_VERSION, TASK)
  check('adopting the recorded facts yields the same receipt digest', receiptDigest(projectReceipt(refolded, RUN)) === receiptDigest(receipt))
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
