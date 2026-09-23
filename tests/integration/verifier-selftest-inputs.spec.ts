import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { EvidenceBundle, TaskEvent, VerificationResult, Verifier } from '../../task/src/index.ts'
import { TaskService, rootTaskStoreId } from '../../task/src/index.ts'
import type { CriterionSpec, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { TaskRuntime } from '../../task-runtime/src/index.ts'
import { VerifierRegistry } from '../../verifier/src/index.ts'

/**
 * S1-V slice 2 on the real chain: the real `TaskService` and its store, the
 * real `TaskRuntime` cascade, and the real `VerifierRegistry` with its real
 * built-ins. Three rules are exercised end to end — a plugin judge is admitted
 * only after the registry has executed the samples it declared, a criterion's
 * declared protected acceptance input is re-read against the admitted bytes
 * before anything is judged, and every verdict a run produces is stamped with
 * the version of the instance that decided it and is found again by it.
 *
 * What is stubbed, and why: `sessionPersistence` (a memory handle),
 * `agentRuntime.spawn` (no model loop runs here — the stub's only job is to act
 * on the checkout the way a worker can, which is what makes the rewrite attack
 * below real: the file is genuinely rewritten between admission and judging),
 * the `agents` lookup, and `graphs` (a fixed env binding). `envBuilder` is a
 * fixture whose env path is this test's temp checkout, so the directory
 * admission reads the declared input from and the directory the verifier's
 * command would run in are the same real directory.
 *
 * Every conclusion is read back from the persisted `task/event` log or a store
 * snapshot — never off a writer's return value — and every refusal is asserted
 * together with the side effects it did *not* leave behind.
 */

const ROOT_SESSION = 's-root'
const STORE = rootTaskStoreId(ROOT_SESSION)
const ACCEPTANCE = 'acceptance.sh'

/**
 * The admission-time acceptance check: it reads the product and fails while the
 * product is wrong, so a wrong product reaches the judge as a non-zero exit.
 */
const ACCEPTANCE_SCRIPT = `#!/bin/sh
echo "checked $(cat product.txt)"
grep -q "^ok$" product.txt
`

/**
 * What a worker writes over the acceptance script: the same file made to pass
 * whatever the product says. It also leaves a trace of its own execution, so
 * "the command never ran" is checked as an absence, not as an exit code.
 */
const REWRITTEN_SCRIPT = `#!/bin/sh
echo rewritten > dispatch-marker.txt
exit 0
`

/** SHA-256 of bytes, computed here so the implementation is never confirmed against itself. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface Harness {
  task: TaskService
  runtime: TaskRuntime
  verifier: VerifierRegistry
  /** The real directory admission reads protected inputs from and the verifier's command runs in. */
  checkout: string
  log: Map<string, SessionEvent[]>
  /** One entry per worker the cascade spawned. */
  spawned: string[]
  /** What the stubbed worker does inside the checkout the moment it is spawned. */
  onSpawn(action: (checkout: string) => void | Promise<void>): void
  /** Registration warnings the registry reported through the cordis logger. */
  warnings: string[]
}

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness(): Promise<Harness> {
  const ctx = new Context()
  const checkout = await mkdtemp(join(tmpdir(), 'selftest-checkout-'))
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'selftest-evidence-'))
  tempDirs.push(checkout, evidenceRoot)

  const log = new Map<string, SessionEvent[]>()
  const headers = new Map<string, SessionHeader>()
  ctx.provide('sessionPersistence', {
    list: async () => [...headers.values()].map(header => ({ header })),
    create: async (header: SessionHeader) => {
      headers.set(header.id, header)
      log.set(header.id, [])
      return {
        read: async () => ({ events: log.get(header.id) ?? [] }),
        append: async (records: readonly SessionEvent[]) => { log.get(header.id)?.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
    open: async (id: SessionId) => {
      const stored = log.get(id)
      if (stored === undefined) throw new Error('missing session ' + id)
      return {
        read: async () => ({ events: stored }),
        append: async (records: readonly SessionEvent[]) => { stored.push(...records) },
        flush: async () => {},
        close: async () => {},
      }
    },
  } as never)

  let workerAction: (checkout: string) => void | Promise<void> = () => {}
  const spawned: string[] = []
  ctx.provide('agentRuntime', {
    spawn: async (_parent: unknown, request: { sessionId: string }) => {
      spawned.push(request.sessionId)
      // The worker's whole effect on the world: it runs inside the checkout.
      await workerAction(checkout)
      return {
        agent: {
          id: request.sessionId,
          cancel: () => {},
          // A live worker hands its result in before it goes idle (A3 §3.2): an
          // idle session is not a completion, so a stub that only went idle would
          // be stopped by the no-progress rule instead of being verified.
          whenIdle: async () => { await runtime.submitResult(request.sessionId, { summary: 'worker finished (fixture auto-submit)' }) },
        },
        dispose: async () => {},
      }
    },
  } as never)
  ctx.provide('agents', { get: (sessionId: string) => ({ id: sessionId }) } as never)
  ctx.provide('graphs', {
    graphForSession: async () => ({ id: 'g1', envId: 'env1', rootSessionId: ROOT_SESSION }),
  } as never)
  ctx.provide('envBuilder', { store: { get: (_envId: string) => ({ path: checkout }) } } as never)

  // The registry reports a declared test double through the cordis logger, so
  // the sink is attached to the real logger service rather than faked: what a
  // deployment would see in its log is what this test reads back. The level
  // threshold is raised because a bare context exports only `error` by default.
  const warnings: string[] = []
  const logger = ctx.logger as unknown as { exporter(sink: unknown): unknown }
  logger.exporter({
    levels: { default: 3 },
    export: (message: { type: string; args: unknown[] }) => {
      if (message.type === 'warn') warnings.push(String(message.args[0]))
    },
  })

  const task = new TaskService(ctx)
  const verifier = new VerifierRegistry(ctx, { evidenceRoot })
  // Cordis readies the service when it loads the plugin; a hand-built registry
  // has to be readied explicitly, and `ready()` is what the built-ins register
  // through — including the gate the plugin judges below are held to.
  await verifier.ready()
  const runtime = new TaskRuntime(ctx)
  return {
    task,
    runtime,
    verifier,
    checkout,
    log,
    spawned,
    onSpawn: action => { workerAction = action },
    warnings,
  }
}

/** Every task event the store actually appended, read back off its session log. */
function taskEvents(h: Harness): TaskEvent[] {
  return [...h.log.values()].flatMap(events => events.flatMap(event =>
    event.type === 'task/event' ? [event.data as unknown as TaskEvent] : []))
}

/** The payload of one task's event of one kind, or undefined when it never landed. */
function payloadOf<K extends TaskEvent['kind']>(h: Harness, kind: K, taskId: string): Extract<TaskEvent, { kind: K }>['payload'] | undefined {
  const event = taskEvents(h).find(item => item.kind === kind && item.taskId === taskId) as Extract<TaskEvent, { kind: K }> | undefined
  return event?.payload
}

/** The evidence bundles the store persisted under one run. */
function evidenceFor(h: Harness, runId: string): EvidenceBundle[] {
  return taskEvents(h).flatMap(item => item.kind === 'EvidenceProduced' && item.runId === runId ? [item.payload.evidence] : [])
}

/** The one verdict about one criterion across those bundles. */
function verdictFor(bundles: readonly EvidenceBundle[], criterionId: string): VerificationResult | undefined {
  return bundles.flatMap(bundle => bundle.verifierResults).find(result => result.criterionId === criterionId)
}

/** The one claim about one criterion across those bundles. */
function claimFor(bundles: readonly EvidenceBundle[], criterionId: string) {
  return bundles.flatMap(bundle => bundle.claims).find(claim => claim.criterionId === criterionId)
}

/** The run one child task started, read back off the persisted start event. */
function runOf(h: Harness, taskId: string): string {
  const started = payloadOf(h, 'TaskStarted', taskId)
  if (started === undefined) throw new Error(`task "${taskId}" never started a run`)
  return started.run.runId
}

/** The one child a batch created, read back off the persisted decomposition event. */
function onlyChild(h: Harness, parentTaskId: string): string {
  const decomposed = payloadOf(h, 'TaskDecomposed', parentTaskId)
  expect(decomposed?.childTaskIds).toHaveLength(1)
  return decomposed!.childTaskIds[0]!
}

/** The message of a registration the registry refused; an accepted one is this test's own failure. */
async function refusalOf(registration: Promise<unknown>): Promise<string> {
  const failure = await registration.then(() => undefined, (error: Error) => error)
  if (failure === undefined) throw new Error('the registry accepted a registration it was supposed to refuse')
  return failure.message
}

/** A criterion whose verdict rests on the acceptance script — declared, so its identity is fixed at admission. */
function productCriterion(overrides: Partial<CriterionSpec> = {}): CriterionSpec {
  return {
    criterionId: 'product-check',
    description: 'the product passes the acceptance check it was admitted against',
    command: `sh ${ACCEPTANCE}`,
    mode: 'deterministic',
    protectedInputs: [ACCEPTANCE],
    ...overrides,
  }
}

/** The same criterion declaring *no* protected input at all: the honest boundary the fix must not overstate. */
function undeclaredCriterion(): CriterionSpec {
  const { protectedInputs: _declared, ...rest } = productCriterion()
  return rest
}

/** A criterion judged by a pinned verifier, with no acceptance input involved: the shape the gate tests use. */
function pinnedCriterion(criterionId: string, verifierRef: string): CriterionSpec {
  return {
    criterionId,
    description: `the "${verifierRef}" judge decides this criterion`,
    command: 'true',
    mode: 'deterministic',
    verifierRef,
  }
}

/**
 * The session's real root task, bound to the run every entry resolves the caller
 * through — activated through the real intake (A0 §1.2), with this spec's own
 * root contract stated below rather than defaulted.
 */
function rootContract(objective: string): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [
      // The goal's own independent check (A0 §1.2's structural rule needs one) …
      { criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' },
      // … and the conjunction, because the cases below read the root's verdict as
      // the tree's: a child that failed cannot be a delivered goal.
      { criterionId: 'root-children-verified', description: 'all mandatory children verified', mode: 'composite', mandatory: true },
    ],
  }
}

async function createRoot(h: Harness): Promise<{ taskId: string; runId: string }> {
  const activated = await h.runtime.intakeRootContract(STORE, ROOT_SESSION, rootContract('ship the release'))
  if (activated.status !== 'activated') throw new Error(`the root contract was not activated: ${activated.detail}`)
  return { taskId: activated.taskId, runId: activated.runId }
}

/** Decompose the root into one child carrying exactly the given acceptance criteria. */
async function decomposeToChild(h: Harness, criteria: readonly CriterionSpec[]): Promise<{ parentTaskId: string; childTaskId: string }> {
  const root = await createRoot(h)
  const { batchId } = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION, {
    reason: 'split the work',
    children: [{ objective: 'produce the product the acceptance check reads', acceptanceCriteria: [...criteria] }],
  })
  await h.runtime.awaitBatch(STORE, batchId)
  return { parentTaskId: root.taskId, childTaskId: onlyChild(h, root.taskId) }
}

/**
 * A shell runner for the plugin judge below: it starts the command in the
 * run's checkout and reports the exit code, the way any executable judge does.
 */
function runShell(command: string, cwd: string): Promise<number> {
  return new Promise(resolve => {
    execFile('sh', ['-c', command], { cwd }, error => {
      if (error === null) return resolve(0)
      const code = (error as { code?: unknown }).code
      resolve(typeof code === 'number' ? code : 1)
    })
  })
}

/**
 * A real plugin judge, not a test double: it runs the criterion's command in
 * the run's checkout and judges by exit code, so the samples it declares are
 * discriminated by its own behaviour rather than by anything this test decides.
 * It also drops a marker in the log dir the registry hands it, which is how a
 * test can tell a judge that executed from one that was merely described.
 */
function shellJudge(): Verifier {
  const id = 'pinned-runner'
  const sample = (criterionId: string, command: string) => ({
    criterionId,
    description: `the shell exits ${command}`,
    verificationMode: 'deterministic' as const,
    requiredEvidence: [],
    mandatory: true,
    command,
  })
  return {
    id,
    version: '2',
    owner: 'integration-tests',
    selftest: {
      samples: [
        { role: 'positive', name: 'a command that exits zero', criterion: sample('judge-selftest-pass', 'true'), expect: 'pass' },
        { role: 'negative', name: 'a command that exits non-zero', criterion: sample('judge-selftest-fail', 'false'), expect: 'fail' },
      ],
    },
    supports: mode => mode === 'deterministic',
    verify: async req => {
      await mkdir(req.logDir, { recursive: true })
      const results: VerificationResult[] = []
      for (const criterion of req.criteria) {
        const exitCode = await runShell(criterion.command ?? '', req.cwd)
        await writeFile(join(req.logDir, `${criterion.criterionId}.ran`), '')
        results.push({
          criterionId: criterion.criterionId,
          status: exitCode === 0 ? 'pass' : 'fail',
          verifierId: id,
          exitCode,
        })
      }
      return results
    },
  }
}

/** A judge that cannot tell its own declared sides apart: it returns `pass` whatever it is handed. */
function alwaysPassJudge(): Verifier {
  return {
    id: 'always-pass',
    version: '9',
    selftest: {
      samples: [
        {
          role: 'positive', name: 'a command that exits zero', expect: 'pass',
          criterion: { criterionId: 'judge-selftest-pass', description: 'exits zero', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
        },
        {
          role: 'negative', name: 'a command that exits non-zero', expect: 'fail',
          criterion: { criterionId: 'judge-selftest-fail', description: 'exits non-zero', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'false' },
        },
      ],
    },
    supports: mode => mode === 'deterministic',
    verify: async req => req.criteria.map(criterion => ({
      criterionId: criterion.criterionId,
      status: 'pass' as const,
      verifierId: 'always-pass',
    })),
  }
}

describe('V2-4: a protected acceptance input is fixed at admission and re-read before judging', () => {
  it('refuses a child whose worker rewrote the protected script, naming the path, without ever dispatching the command', async () => {
    const h = await harness()
    await writeFile(join(h.checkout, 'product.txt'), 'broken\n')
    await writeFile(join(h.checkout, ACCEPTANCE), ACCEPTANCE_SCRIPT)
    // The attack under test: the worker leaves the product wrong and rewrites
    // the acceptance input so the wrong product would pass.
    h.onSpawn(checkout => writeFile(join(checkout, ACCEPTANCE), REWRITTEN_SCRIPT))

    const { parentTaskId, childTaskId } = await decomposeToChild(h, [productCriterion()])
    const runId = runOf(h, childTaskId)
    const criterionId = (await h.task.taskIn(STORE, childTaskId)).acceptanceCriteria[0]!.criterionId

    // Admission fixed the identity of the bytes it read, and the contract the
    // store holds is the one carrying that digest.
    const created = payloadOf(h, 'TaskCreated', childTaskId)!.task
    expect(created.contract!.acceptanceCriteria[0]!.protectedInputs)
      .toEqual([{ path: ACCEPTANCE, sha256: sha256Of(ACCEPTANCE_SCRIPT) }])

    // The child settled failed, in the store and in the persisted verdict.
    expect((await h.task.taskIn(STORE, childTaskId)).status).toBe('failed')
    expect((await h.task.taskIn(STORE, parentTaskId)).status).toBe('failed')
    expect(payloadOf(h, 'TaskVerified', childTaskId)).toBeUndefined()
    expect(payloadOf(h, 'TaskFailed', childTaskId)?.reason).toContain(criterionId)

    const evidence = evidenceFor(h, runId)
    expect(evidence).toHaveLength(1)
    const verdict = verdictFor(evidence, criterionId)!
    expect(verdict).toMatchObject({ status: 'fail', verifierId: 'command' })
    expect(verdict.details).toContain(`protected input "${ACCEPTANCE}" changed since admission`)
    expect(verdict.details).toContain(`admitted sha256 ${sha256Of(ACCEPTANCE_SCRIPT)}`)
    expect(verdict.details).toContain(sha256Of(REWRITTEN_SCRIPT))
    expect(claimFor(evidence, criterionId)).toMatchObject({ status: 'fail', verifierId: 'command' })

    // Nothing was dispatched: the judge reported no exit code and no log, the
    // criterion's own log file was never created, and the rewritten script's
    // side effect never happened.
    expect(verdict.exitCode).toBeUndefined()
    expect(verdict.logRef).toBeUndefined()
    expect(verdict.unknownKind).toBeUndefined()
    await expect(stat(join(h.verifier.evidenceRoot, STORE, runId, `${criterionId}.log`))).rejects.toThrow()
    await expect(stat(join(h.checkout, 'dispatch-marker.txt'))).rejects.toThrow()
    // The worker did run; it is only the acceptance command that did not.
    expect(h.spawned).toHaveLength(1)
  })

  it('verifies a child whose protected script is untouched and whose product really passes', async () => {
    const h = await harness()
    await writeFile(join(h.checkout, 'product.txt'), 'ok\n')
    await writeFile(join(h.checkout, ACCEPTANCE), ACCEPTANCE_SCRIPT)

    const { parentTaskId, childTaskId } = await decomposeToChild(h, [productCriterion()])
    const runId = runOf(h, childTaskId)
    const criterionId = (await h.task.taskIn(STORE, childTaskId)).acceptanceCriteria[0]!.criterionId

    expect((await h.task.taskIn(STORE, childTaskId)).status).toBe('verified')
    expect((await h.task.taskIn(STORE, parentTaskId)).status).toBe('verified')

    const evidence = evidenceFor(h, runId)
    const verdict = verdictFor(evidence, criterionId)!
    expect(verdict).toMatchObject({ status: 'pass', verifierId: 'command', verifierVersion: '1', exitCode: 0 })
    // The real command ran: the log the verdict names is the script's own output.
    expect(verdict.logRef).toBe(join(STORE, runId, `${criterionId}.log`))
    expect(await h.verifier.logTail(verdict.logRef!)).toContain('checked ok')

    // The claim the store holds carries the deciding instance's version (V2-3).
    expect(claimFor(evidence, criterionId)).toMatchObject({
      status: 'pass', verifierId: 'command', verifierVersion: '1',
    })
  })

  it('is honest about the boundary: a criterion that declares no protected input is not protected', async () => {
    const h = await harness()
    await writeFile(join(h.checkout, 'product.txt'), 'broken\n')
    await writeFile(join(h.checkout, ACCEPTANCE), ACCEPTANCE_SCRIPT)
    // The same rewrite, on a criterion that declared nothing: no identity was
    // fixed, nothing claims the input, and the cheat works exactly as it looks.
    h.onSpawn(checkout => writeFile(join(checkout, ACCEPTANCE), REWRITTEN_SCRIPT))

    const { parentTaskId, childTaskId } = await decomposeToChild(h, [undeclaredCriterion()])
    const child = await h.task.taskIn(STORE, childTaskId)

    expect(child.status).toBe('verified')
    expect((await h.task.taskIn(STORE, parentTaskId)).status).toBe('verified')
    expect(child.acceptanceCriteria[0]).not.toHaveProperty('protectedInputs')
    // The rewritten script really is what ran: its own trace is on disk.
    expect(await readFile(join(h.checkout, 'dispatch-marker.txt'), 'utf8')).toBe('rewritten\n')
    // No protected-input vocabulary appears anywhere in what the store holds.
    const persisted = JSON.stringify(taskEvents(h))
    expect(persisted).not.toContain('protectedInputs')
    expect(persisted).not.toContain('protected input')
  })

  it('refuses a batch whose declared protected input cannot be read, before anything persists', async () => {
    const h = await harness()
    const root = await createRoot(h)
    const eventsBefore = taskEvents(h).length

    await expect(h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [{ objective: 'the child whose acceptance input is missing', acceptanceCriteria: [productCriterion()] }],
    } as DecomposeSpec)).rejects.toThrow(
      /contract rejected decomposition of ".+":\n- child 0 criterion "product-check" protectedInputs path "acceptance\.sh" cannot be read/,
    )

    // No id was minted, no child exists, nothing was spawned, nothing judged.
    expect(taskEvents(h)).toHaveLength(eventsBefore)
    expect(h.spawned).toEqual([])
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.map(task => task.taskId)).toEqual([root.taskId])
    expect(snapshot.evidence).toEqual([])
    expect(payloadOf(h, 'TaskDecomposed', root.taskId)).toBeUndefined()
    expect(payloadOf(h, 'TaskVerifying', root.taskId)).toBeUndefined()
  })
})

describe('V2-1/V2-2: the executable selftest gate at the real registry', () => {
  it('refuses a judge that misses its own negative sample, and the refusal leaves no trace anywhere', async () => {
    const h = await harness()
    const registration = h.verifier.register(alwaysPassJudge())
    await expect(registration).rejects.toThrow(/selftest failed/)
    const refusal = await refusalOf(registration)
    expect(refusal).toContain('verifier "always-pass" selftest failed')
    expect(refusal).toContain('sample "a command that exits non-zero" (role negative) expected "fail" but the judge returned "pass"')
    // Refused means absent from the vocabulary, not merely reported.
    expect(h.verifier.verifierIds()).toEqual(['command', 'composite', 'review'])

    // A criterion pinning the refused judge is rejected at the real admission
    // entry: no child, no evidence, no spawn, no byte appended.
    const root = await createRoot(h)
    const eventsBefore = taskEvents(h).length
    await expect(h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT_SESSION, {
      reason: 'split the work',
      children: [{
        objective: 'the child whose judge was refused',
        acceptanceCriteria: [pinnedCriterion('product-check', 'always-pass')],
      }],
    } as DecomposeSpec)).rejects.toThrow(
      /admission rejected decomposition of ".+": child 0 criterion "product-check" references unknown verifier "always-pass"; registered verifiers: command, composite, review/,
    )
    expect(taskEvents(h)).toHaveLength(eventsBefore)
    expect(h.spawned).toEqual([])
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.map(task => task.taskId)).toEqual([root.taskId])
    expect(snapshot.evidence).toEqual([])
  })

  it('registers a judge whose samples it honours, dispatches it by ref, and takes a declared test double without the gate', async () => {
    const h = await harness()
    await h.verifier.register(shellJudge())
    expect(h.verifier.verifierIds()).toEqual(['command', 'composite', 'pinned-runner', 'review'])
    // The gate executed the samples for real: the judge's own trace is in the
    // scratch log dir the registry handed it, one file per sample.
    const selftestDir = join(h.verifier.evidenceRoot, 'selftest', 'pinned-runner')
    expect((await stat(join(selftestDir, '0', 'judge-selftest-pass.ran'))).isFile()).toBe(true)
    expect((await stat(join(selftestDir, '1', 'judge-selftest-fail.ran'))).isFile()).toBe(true)

    // The declared channel: no samples, no gate, one warning, and it dispatches.
    await h.verifier.register({
      id: 'declared-double',
      supports: mode => mode === 'deterministic',
      verify: async req => req.criteria.map(criterion => ({
        criterionId: criterion.criterionId,
        status: 'pass' as const,
        verifierId: 'declared-double',
      })),
    }, { testDouble: true })
    expect(h.verifier.verifierIds()).toEqual(['command', 'composite', 'declared-double', 'pinned-runner', 'review'])

    const { childTaskId } = await decomposeToChild(h, [
      pinnedCriterion('pinned-passes', 'pinned-runner'),
      pinnedCriterion('double-passes', 'declared-double'),
    ])
    const runId = runOf(h, childTaskId)
    expect((await h.task.taskIn(STORE, childTaskId)).status).toBe('verified')

    const evidence = evidenceFor(h, runId)
    expect(verdictFor(evidence, 'pinned-passes')).toMatchObject({
      status: 'pass', verifierId: 'pinned-runner', verifierVersion: '2', exitCode: 0,
    })
    // The plugin-supplied version is never trusted: the registry stamps the
    // registered instance's, and an instance that declares none acquires none.
    expect(verdictFor(evidence, 'double-passes')).toMatchObject({ status: 'pass', verifierId: 'declared-double' })
    expect(verdictFor(evidence, 'double-passes')).not.toHaveProperty('verifierVersion')
    expect(claimFor(evidence, 'pinned-passes')).toMatchObject({ verifierId: 'pinned-runner', verifierVersion: '2' })
    expect(claimFor(evidence, 'double-passes')).not.toHaveProperty('verifierVersion')
    // The pinned judge was dispatched into this very run, not merely registered.
    expect((await stat(join(h.verifier.evidenceRoot, STORE, runId, 'pinned-passes.ran'))).isFile()).toBe(true)
    // Only the double's registration warned; the gated judge went through silently.
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('declared-double')
  })
})
