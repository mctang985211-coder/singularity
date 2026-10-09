/**
 * The shared method-chain fixture: a scripted loop with one supervisor walking
 * `method_draft` → `method_evaluate` → `method_publish` over the run the root's
 * business task produced. The evaluation's baseline side spends one extra
 * request so the frozen strategy's cost relief admits the candidate; everything
 * else is the deployment's own pipeline, runtime and ledger.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, vi } from 'vitest'
import { libraryRoots } from '../../task-runtime/src/environment/index.ts'
import { startScriptedLoop, type ScriptEntry, type ScriptedLoop, type ScriptedLoopOptions } from '../support/scripted-loop.ts'

export const ROOT = 's-root'
export const SUPERVISOR = 's-supervisor'

export const criterion = (command: string) => [{ criterionId: 'goal', description: 'the delivered answer holds', command, verifierRef: 'command' }]

/** A minimal `SKILL.md` the environment draft staging accepts. */
export const SKILL_MD = `---\nname: verify\ndescription: a candidate skill the method chain publishes\n---\n\n# candidate: check the acceptance before answering\n`

export function draftIdOf(h: ScriptedLoop): string {
  const call = h.calls.find(record => record.name === 'method_draft')
  const match = /draft (d[0-9]{4})/.exec(call?.result?.text ?? '')
  if (match === null) throw new Error(`no draft id in ${call?.result?.text ?? '(no method_draft call)'}`)
  return match[1]!
}

/** The library's own ledger lines, parsed; the evaluation record names the report path a tamper edits. */
export function ledgerRecords(h: ScriptedLoop): Record<string, unknown>[] {
  const path = join(libraryRoots(ROOT, h.home).root, 'methods.jsonl')
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

export function reportPathOf(h: ScriptedLoop, draftId: string): string {
  const record = ledgerRecords(h).find(entry => entry.kind === 'evaluation' && entry.draftId === draftId)
  if (record === undefined || typeof record.report !== 'string') throw new Error('no evaluation record in the ledger')
  return resolve(libraryRoots(ROOT, h.home).root, record.report)
}

export interface MethodChainOptions {
  /** The graph's own rsi settings, as the loop publishes them; absent means no rsi record at all. */
  readonly rsi?: ScriptedLoopOptions['rsi']
  /** How the approval seam answers; absent answers every ask `allowed-once` at once. */
  readonly approvalAnswer?: ScriptedLoopOptions['approvalAnswer']
  /** Run the publish entry twice: the repeat meets the moved pointer. */
  readonly extraPublish?: boolean
  /** Runs between the measurement and the publication, from the publish call's own argument resolver. */
  readonly tamper?: (h: ScriptedLoop, draftId: string) => void
  /** The root's second turn: its own attempt at the pointer tool, refused by the execution seal. */
  readonly rootPublishes?: boolean
}

function scriptOf(
  h: () => ScriptedLoop,
  root: () => { taskId: string },
  inputDir: () => string,
  options: MethodChainOptions,
): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, index): readonly ScriptEntry[] => {
    if (sessionId === SUPERVISOR) {
      const publish = {
        tool: 'method_publish',
        args: () => {
          const draftId = draftIdOf(h())
          options.tamper?.(h(), draftId)
          return { draftId, expectedActiveRevision: 'r0001', expectedGeneration: 1 }
        },
      } satisfies ScriptEntry
      return [
        {
          tool: 'method_draft',
          args: {
            kind: 'skill',
            identity: 'verify',
            edits: [{ id: 'e1', mechanism: 'skill', targets: ['skills/verify/SKILL.md'] }],
            editPayload: JSON.stringify({ skillMd: SKILL_MD }),
            rationale: 'answer the observed failure',
            sourceRefs: ['diagnosis:d1'],
            expectedBaseRevision: 'r0001',
            round: 0,
            critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
          },
        },
        {
          tool: 'method_evaluate',
          args: () => ({
            draftId: draftIdOf(h()),
            round: 0,
            samples: [{ taskId: root().taskId, role: 'observed-success' }],
            quality: { metricId: 'acceptance', extractor: 'acceptance' },
            repetition: 0,
            input: { sourceDir: inputDir() },
            maxParallel: 1,
          }),
        },
        publish,
        // A second publication of the same draft under the same compare-and-swap
        // pair: the pointer the first call moved refuses it before anyone is asked.
        ...(options.extraPublish === true ? [publish] : []),
        { text: 'done' },
      ]
    }
    if (index === 0) {
      // The root's own attempt at the pointer tool comes first, while its run
      // is still active, so the authority seal — not the terminal phase gate —
      // is what answers it.
      return [
        ...(options.rootPublishes === true
          ? [{ tool: 'method_publish', args: { draftId: 'd0001', expectedActiveRevision: 'r0001', expectedGeneration: 1 } } satisfies ScriptEntry]
          : []),
        { tool: 'task_submit_result', args: { summary: 'the answer is delivered' } },
        { text: 'delivered' },
      ]
    }
    // Replay workers spawn in the plan's own order (maxParallel 1): baseline,
    // candidate, then any post-publish replay the spec itself starts. The
    // baseline's extra request is the cost difference the strategy admits
    // relief from; every other side submits with the least it can.
    const replayOrder = h().spawns.filter(spawn => spawn.sessionId !== SUPERVISOR).findIndex(spawn => spawn.sessionId === sessionId)
    return replayOrder === 0
      ? [{ tool: 'task_status', args: {} }, { tool: 'task_submit_result', args: { summary: 'replayed answer' } }, { text: 'done' }]
      : [{ tool: 'task_submit_result', args: { summary: 'replayed answer' } }, { text: 'done' }]
  }
}

/** Start the loop, run the root's business task to verified, and hand back the handles the spec asserts on. */
export async function startMethodChain(options: MethodChainOptions = {}): Promise<{
  h: ScriptedLoop
  root: { storeId: string; taskId: string; runId: string }
}> {
  let h!: ScriptedLoop
  let root!: { storeId: string; taskId: string; runId: string }
  let inputDir!: string
  h = await startScriptedLoop({
    evolution: { ledgerRoot: mkdtempSync(join(tmpdir(), 'method-ledger-')) },
    supervisors: [SUPERVISOR],
    approvalAnswer: options.approvalAnswer ?? (() => 'allowed-once'),
    ...(options.rsi === undefined ? {} : { rsi: options.rsi }),
    script: scriptOf(() => h, () => root, () => inputDir, options),
  })
  inputDir = join(h.workspace, 'eval-input')
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'input.txt'), 'the frozen input\n', { encoding: 'utf8' })
  root = await h.begin({
    objective: 'deliver the answer',
    requiredCapabilities: ['execute-task'],
    acceptanceCriteria: criterion('true'),
  })
  await h.agent(ROOT).whenIdle()
  expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified')
  return { h, root }
}

export function settledCalls(h: ScriptedLoop, name: string) {
  return h.calls.filter(record => record.name === name && record.result !== undefined)
}

export function lastCall(h: ScriptedLoop, name: string, occurrence = 0) {
  const call = settledCalls(h, name)[occurrence]
  if (call === undefined) throw new Error(`no settled ${name} call ${occurrence} (of ${settledCalls(h, name).length})`)
  return call
}

export async function waitForCalls(h: ScriptedLoop, name: string, count: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(settledCalls(h, name).length).toBe(count)
    },
    { timeout: 30_000, interval: 100 },
  )
}
