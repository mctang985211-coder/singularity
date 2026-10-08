import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { CommitDirection } from '../../evolution/src/index.ts'
import type { CommitStage } from '../../evolution/src/commit.ts'
import { replaySessionLogs, type RunStack } from '../support/run-stack.ts'
import {
  type DecidedWorld,
  sideState,
  type CommitWindow,
  APPLY_WINDOWS,
  ROLLBACK_WINDOWS,
  sharedDirectory,
  decidedWorld,
  commitTargets,
  P1,
  ROOT_A,
  productionObject,
  kindsOf,
  ledgerLines,
  intentFiles,
  interruptedState,
  assertInterruptedState,
  stagedNow,
  boot,
  rootContract,
  captureWarnings,
  settledComplete,
  admitChild,
  boundObject,
  bindingOf,
  type UnitStack,
  productionSidecar,
  productionSkill,
} from './k3-skill-unit.fixture.ts'

/**
 * The env a nested child is started with: the durable window it dies at, the
 * direction it commits in, which file of the object it dies before, and the
 * workspace both processes share. A run that sets none is a parent — the child
 * case below is skipped and nothing here kills anything; a run whose parent set
 * them *is* the child.
 */
const EXIT_WINDOW = process.env.K3_REAL_EXIT_WINDOW as CommitStage | undefined

const EXIT_DIRECTION = (process.env.K3_REAL_EXIT_DIRECTION ?? 'apply') as CommitDirection

const EXIT_FILE = (process.env.K3_REAL_EXIT_FILE ?? 'skill') as 'skill' | 'sidecar'

const EXIT_WORKSPACE = process.env.K3_REAL_EXIT_WORKSPACE

/** The file a child writes its own pid into, before its commit — the parent's proof of which process image died. */
const EXIT_MARKER = 'k3-child-exit.json'

/** The file the boot's own session logs travel in when a nested child has to re-read them. */
const SESSION_HANDOVER = 'k3-child-sessions.json'

/** The one case a nested run is filtered to; no other case of this spec runs there. */
const CHILD_CASE = 'the child process dies by SIGKILL at its armed window'

/** The repo root a nested run starts from, and this spec's own file — the one file a nested run collects. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

const SPEC_PATH = fileURLToPath(new URL('./k3-skill-process-death.spec.ts', import.meta.url))

/**
 * The real forced exit: a nested run of this very spec, told by env which window
 * to die at. `--pool=threads` is what makes the signal the parent observes the
 * case body's own, and `-t` keeps every other case of this spec — this spawner
 * included — out of the nested run.
 */
function spawnCommitChild(
  window: CommitStage,
  direction: CommitDirection,
  file: 'skill' | 'sidecar',
  workspace: string,
): SpawnSyncReturns<string> {
  const args = [
    join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--project',
    'integration',
    '--pool=threads',
    SPEC_PATH,
    '-t',
    CHILD_CASE,
  ]
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      K3_REAL_EXIT_WINDOW: window,
      K3_REAL_EXIT_DIRECTION: direction,
      K3_REAL_EXIT_FILE: file,
      K3_REAL_EXIT_WORKSPACE: workspace,
    },
  })
}

/** What the parent proves about the child process image that performed the commit. */
interface ForcedExit {
  readonly window: CommitStage
  readonly direction: CommitDirection
  readonly file: 'skill' | 'sidecar'
  /** The child's own pid — the process image the commit ran in, and the one that is gone. */
  readonly pid: number
}

/** The null probe to a pid answered: `undefined` when it exists, `ESRCH` when it is gone. */
function pidProbe(pid: number): string | undefined {
  try {
    process.kill(pid, 0)
    return undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
}

/**
 * The forced exit itself, asserted before anything about the durable state: the
 * nested run answered a *signal*, the marker it wrote before its commit names the
 * pid `spawnSync` started and not this process's, and that pid is dead.
 */
async function forcedExit(directory: string, child: SpawnSyncReturns<string>): Promise<ForcedExit> {
  const transcript = `nested run status ${String(child.status)}, signal ${String(child.signal)}, error ${String(child.error)}\n${child.stdout}\n${child.stderr}`
  expect(child.signal, `the nested run exited instead of being killed by its own commit — ${transcript}`).toBe(
    'SIGKILL',
  )
  expect(child.status, `a killed process has no exit code — ${transcript}`).toBeNull()
  const marker = JSON.parse(await readFile(join(directory, EXIT_MARKER), 'utf8')) as ForcedExit
  expect(marker.pid, 'the marker must name the process image that performed the commit, not the reader').not.toBe(
    process.pid,
  )
  expect(marker.pid).toBe(child.pid)
  expect(pidProbe(marker.pid)).toBe('ESRCH')
  return marker
}

/**
 * Hand the child the session plane it cannot mint for itself, the way
 * `k2-evolution-commit.spec.ts` does: this fixture's persistence is memory, so a
 * second process image starts empty, while a deployment's next process simply
 * opens the log files its runs wrote.
 *
 * One difference from that spec's helper: the sessions this one carries include
 * the *replayed runs'* own logs. A spawn's request is recorded on its session's
 * log (which is the evidence the promotion gate re-reads), but this fixture
 * registers no header for it — and a session with a log but no header is one a
 * reader cannot enumerate. Both are carried here, verbatim, and nothing about a
 * session is transformed on the way.
 */
async function handOverSessions(h: RunStack, directory: string): Promise<void> {
  const persistence = sessionPersistenceOf(h)
  const sessions: { header: unknown; events: readonly unknown[] }[] = []
  const seen = new Set<string>()
  const carry = async (header: { id: unknown }): Promise<void> => {
    const id = String(header.id)
    if (seen.has(id)) return
    seen.add(id)
    let events: readonly unknown[]
    try {
      events = (await (await persistence.open(id)).read()).events
    } catch {
      // A run whose session never logged anything has nothing to carry.
      return
    }
    sessions.push({ header, events })
  }
  for (const entry of await persistence.list()) await carry(entry.header)
  for (const root of h.roots) {
    const snapshot = await h.task.snapshotIn(rootTaskStoreId(root)).catch(() => undefined)
    for (const run of snapshot?.runs ?? []) await carry({ id: run.sessionId, cwd: h.checkout, agentPreset: 'standard' })
  }
  await writeFile(join(directory, SESSION_HANDOVER), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8')
}

/** The fixture's own persistence handle, as `run-stack.ts` mounts it. */
function sessionPersistenceOf(h: RunStack): {
  list(): Promise<{ header: { id: unknown } }[]>
  open(id: string): Promise<{ read(): Promise<{ events: readonly unknown[] }> }>
} {
  return (h.ctx as unknown as { get(name: string): never }).get('sessionPersistence')
}

/** What production must hold once the intent is settled: the version this direction committed. */
function settledState(world: DecidedWorld, direction: CommitDirection): { skillMd: string; sidecar?: string } {
  return sideState(world, direction === 'apply' ? 'candidate' : 'production')
}

/** The windows the parent kills a nested process image at: three of the apply's, and the mixed one of the rollback's. */
const EXIT_CASES: readonly { direction: CommitDirection; window: CommitWindow }[] = [
  { direction: 'apply', window: APPLY_WINDOWS[0]! },
  { direction: 'apply', window: APPLY_WINDOWS[1]! },
  { direction: 'apply', window: APPLY_WINDOWS[2]! },
  { direction: 'rollback', window: ROLLBACK_WINDOWS[1]! },
]

/**
 * The killed half. The subject is a real process image: the nested run boots this
 * very stack over the parent's directory, builds the same service, and its probe
 * answers the armed window with `process.kill(process.pid, 'SIGKILL')` — no
 * `catch`, no `finally`, nothing cleaned up. That is what a killed deployment
 * leaves, and only a *second* process image settling it proves the recovery.
 *
 * A plain throw cannot stand in for it ({@link windowProbe} is the other, cheaper
 * seam) and the assertions keep the two apart: this case checks the signal, the
 * dead pid and the disk state a death leaves, where the throw cases check what an
 * unwind leaves.
 */
describe.skipIf(EXIT_WINDOW !== undefined)(
  'K3-4 (real exit): the process that commits is killed, and the host that reopens the directory settles it',
  () => {
    it.each(EXIT_CASES)(
      'settles a $direction killed after $window.label, redoing or completing it',
      async ({ direction, window }) => {
        const directory = await sharedDirectory()
        const world = await decidedWorld(directory)
        const h = world.s.h
        const targets = commitTargets(h)
        // The world a rollback starts from: the apply that landed, whole, by this
        // ledger — nothing interrupted, nothing killed.
        if (direction === 'rollback') {
          await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')
          expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))
        }
        const walked = kindsOf(await ledgerLines(h))
        expect(walked.slice(-(direction === 'rollback' ? 2 : 1))).toEqual(
          direction === 'rollback' ? ['commit_intent', 'applied'] : ['decided'],
        )

        // A process image of its own performs the commit and is killed inside it. The
        // session plane the child cannot mint for itself travels with the workspace,
        // as the logs a deployment's next process would simply open.
        await handOverSessions(h, directory)
        const child = await forcedExit(directory, spawnCommitChild(window.stage, direction, window.file, directory))
        expect(child.window).toBe(window.stage)
        expect(child.direction).toBe(direction)
        expect(child.file).toBe(window.file)

        // What the death left, read straight off the ledger and both production files:
        // the intent of this very commit, no completion, and one of the two complete
        // versions — or, in the mixed window, the new `SKILL.md` beside the old sidecar.
        const interrupted = await ledgerLines(h)
        expect(kindsOf(interrupted)).toEqual([...walked, 'commit_intent'])
        const intent = interrupted.at(-1)!
        expect(intent).toMatchObject({
          kind: 'commit_intent',
          intentId: `${P1}/${direction}`,
          proposalId: P1,
          direction,
          approvalRef: direction === 'apply' ? 'approval:k3-apply' : 'approval:k3-rollback',
        })
        expect(intentFiles(intent).map(file => file.target)).toEqual(targets)
        const left = interruptedState(world, direction, window)
        expect(await productionObject(h)).toEqual(left)
        assertInterruptedState(world, direction, window, left)
        // No staging file survives these windows: the temp of a file that was renamed
        // is gone with the rename, and the window before the first stage never wrote one.
        expect(await stagedNow(h)).toEqual([])

        // The reopen: a second process image over the same directory, and the one that
        // settles what the killed image left. The open intent is what this boot's own
        // recovery reads first, and reconciling it is the same settlement a real next
        // process runs before it serves anything: the intent closes and the directory
        // converges on the one complete version the intent named.
        await h.runtime.submitResult(ROOT_A, { summary: 'the first boot hands its checkout back' })
        const reopened = await boot({ workspace: directory })
        const h2 = reopened.h
        expect(await reopened.svc.openIntentTargets()).toEqual([])
        expect(await productionObject(h2)).toEqual(settledState(world, direction))

        // The host's own recovery entry over the same graph ledger — the barrier the
        // runtime runs before it takes a store over, through the instance this context
        // holds — finds nothing left to settle, and the settlement it must reach is
        // the whole object at the version this direction committed.
        const adoptedStore = rootTaskStoreId(ROOT_A)
        await h2.task.createStore(adoptedStore)
        const warnings = captureWarnings(h2)
        expect((await h2.runtime.adoptRoot(adoptedStore, ROOT_A)).adopted).toBe(false)
        expect(warnings.filter(line => line.includes('could not be settled'))).toEqual([])
        await settledComplete({ reopened, direction, intent, walked, target: settledState(world, direction) })

        // A run admitted after the recovery loads the complete object that direction left.
        const root = await h2.root(ROOT_A, rootContract('ship the recovered release'))
        const admitted = await admitChild(h2, ROOT_A, root)
        expect(await boundObject(await bindingOf(h2, root.storeId, admitted.childRunId))).toEqual(
          settledState(world, direction),
        )
        await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
      },
      240_000,
    )
  },
)

/**
 * The one case a nested run executes. It exists only under the env
 * {@link spawnCommitChild} sets: without it the whole describe — and with it the
 * only `process.kill` in this file — is skipped, so an ordinary suite can never
 * kill a process, whatever it runs.
 */
describe.skipIf(EXIT_WINDOW === undefined)(
  'K3-4 (nested child): the process image that dies inside a two-file commit',
  () => {
    it(
      CHILD_CASE,
      async () => {
        const window = EXIT_WINDOW!
        const workspace = EXIT_WORKSPACE
        if (workspace === undefined)
          throw new Error('the child case runs only under the env its parent sets: K3_REAL_EXIT_WORKSPACE is missing')

        // A process image of its own over the parent's directory: it reads the decided
        // proposal and both production files off disk, and its probe exits the process
        // at the armed window — the stage, and the file of the object — by SIGKILL.
        let stack!: UnitStack
        const armed = (): string => (EXIT_FILE === 'sidecar' ? productionSidecar(stack.h) : productionSkill(stack.h))
        const probed = await boot({
          workspace,
          quiet: true,
          commitProbe: (stage, target) => {
            if (stage !== window) return
            if ((stage === 'write-staged' || stage === 'write-renamed') && target !== armed()) return
            process.kill(process.pid, 'SIGKILL')
          },
        })
        stack = probed
        // The session plane the parent handed over, replayed into this boot's memory
        // before anything re-reads it: the apply re-checks the promotion against the
        // store and the side runs' own logs (S4-E §Q3).
        await replaySessionLogs(stack.h, await readFile(join(workspace, SESSION_HANDOVER), 'utf8'))
        // Written before the commit: this pid is the parent's proof of which process
        // image performed it. Everything below the call is dead code.
        await writeFile(
          join(workspace, EXIT_MARKER),
          `${JSON.stringify({ window, direction: EXIT_DIRECTION, file: EXIT_FILE, pid: process.pid }, null, 2)}\n`,
          'utf8',
        )
        if (EXIT_DIRECTION === 'rollback') await stack.svc.rollback(P1, ROOT_A, 'approval:k3-rollback')
        else await stack.svc.apply(P1, ROOT_A, 'approval:k3-apply')
      },
      240_000,
    )
  },
)
