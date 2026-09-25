import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { AssemblyRefusalError } from '../../context/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptedLoop } from '../support/scripted-loop.ts'

/**
 * Q1 (2026-09-25 rework), at the one door that actually spends model input: the
 * real DSH loop, with the real `system-prompt/assemble` waterfall, the real
 * task runtime and the real context read core, and one scripted provider whose
 * requests are the evidence.
 *
 * `context-assembly.spec.ts` proves the refusal exists and is named on the
 * assembly and tool doors; this case proves what the refusal *costs*: nothing.
 * A request whose binding cannot be read never reaches the provider — the
 * agent's own turn records the named failure instead — for a session this
 * deployment published as its own. The counter-example these cases are written
 * against is a request that goes out with no contract at all, which is what the
 * review's Q1 found: the adapter's request list is the surface that would show
 * it, and it stays empty for the session under test.
 *
 * The two faults are the two the review named for a published role: a ledger can
 * only fail for a session without a run of its own (that case is the reviewer's,
 * covered in `context-assembly.spec.ts` against the real ledger), and here the
 * graph registry and the domain store are handed a failing read — the exact
 * reads `context/src/bindings.ts` derives a binding from.
 */

const ROOT = 's-root' as SessionId
const CHILD = 'the child work' as const

afterEach(async () => {
  await disposeScriptedLoops()
})

/** The root contract these cases run under (A0 §1.2). */
const CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** One child spec: a goal and a criterion a command can settle. */
const children = (objective: string): DecomposeSpec['children'] => [{
  objective,
  acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
}]

/** The named refusals one loop recorded, by the session they were raised for. */
function errorsOf(loop: ScriptedLoop): { sessionId: string; error: unknown }[] {
  const heard: { sessionId: string; error: unknown }[] = []
  loop.ctx.on('agent/error', ({ agent, error }: { agent: { id: SessionId }; error: unknown }) => {
    heard.push({ sessionId: String(agent.id), error })
  })
  return heard
}

/** Wait until the loop recorded a named assembly refusal for one session, and hand back the first. */
async function refusedTurn(loop: ScriptedLoop, heard: { sessionId: string; error: unknown }[], sessionId: string): Promise<AssemblyRefusalError> {
  await vi.waitFor(() => {
    expect(heard.filter(entry => entry.sessionId === sessionId).length).toBeGreaterThan(0)
  })
  const entry = heard.find(candidate => candidate.sessionId === sessionId)!
  expect(entry.error).toBeInstanceOf(AssemblyRefusalError)
  return entry.error as AssemblyRefusalError
}

/** Wait for one session's turn to have finished, so what follows is a fresh request and not this one. */
async function idle(loop: ScriptedLoop, sessionId: string | SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect((loop.agent(sessionId) as unknown as { status: string }).status).toBe('idle')
  })
}

describe('a bound request whose facts cannot be read spends no model input (Q1)', () => {
  it('refuses a root\'s next turn by name when the domain store cannot be read', async () => {
    const loop = await startScriptedLoop({
      script: (_sessionId, index) => (index === 0 ? [{ text: 'root: ready' }] : [{ text: 'root: this turn must never be sent' }]),
    })
    const heard = errorsOf(loop)
    const root = await loop.begin(CONTRACT)
    await idle(loop, ROOT)
    const served = loop.requestsOf(ROOT).length
    expect(served).toBeGreaterThan(0)
    // While the store was readable the request carried the contract; the refusal
    // below is what keeps a request from going out without one.
    expect(loop.requestsOf(ROOT)[0]!.texts.join('\n')).toContain('objective: ship the release')

    // The store the root's own contract lives in stops being readable. A request
    // assembled after this point has no contract to carry, and is refused rather
    // than sent with nothing in it.
    const readStore = loop.task.openStore.bind(loop.task)
    vi.spyOn(loop.task, 'openStore').mockImplementation(async (storeId: string) => {
      if (storeId === root.storeId) throw new Error('input/output error while reading the store log')
      return await readStore(storeId)
    })
    loop.userSays('the store is unreadable now')

    const refusal = await refusedTurn(loop, heard, String(ROOT))
    expect(refusal.refusal).toBe('unreadable')
    expect(refusal.message).toContain('system-prompt assembly refused (unreadable)')
    // The refused request is the one that never happened: the provider served
    // exactly the turns that ran while the store was readable, and the request
    // that would have carried no contract is not among them.
    expect(loop.requestsOf(ROOT)).toHaveLength(served)
  })

  it('never lets a spawned worker reach the provider when the graph query fails', async () => {
    const loop = await startScriptedLoop({
      // The root decomposes and finishes its own turn; the worker's script would
      // answer one request — the request this case proves is never made.
      script: (_sessionId, index) => index === 0
        ? [
          { tool: 'task_decompose', args: { reason: 'split the work', children: children(CHILD) } },
          { text: 'root: the batch owns the child now' },
        ]
        : [{ text: 'worker: the provider must never see this' }],
    })
    const heard = errorsOf(loop)
    // The registry keeps answering for the root it published, and fails for
    // every other session: a read failure, not "no graph publishes this
    // session". It is installed before the decomposition, so the worker's very
    // first request meets it.
    const graphs = loop.ctx.get('graphs') as { graphForSession: (sessionId: SessionId) => Promise<unknown> }
    const published = graphs.graphForSession.bind(graphs)
    graphs.graphForSession = async (sessionId: SessionId) => {
      if (String(sessionId) === String(ROOT)) return await published(sessionId)
      throw new Error('the graph registry store is corrupt')
    }

    const root = await loop.begin(CONTRACT)
    await vi.waitFor(() => expect(loop.spawns).toHaveLength(1))
    const worker = String(loop.spawns[0]!.sessionId)

    const refusal = await refusedTurn(loop, heard, worker)
    expect(refusal.refusal).toBe('unreadable')
    expect(refusal.message).toContain('the graph registry store is corrupt')
    // Zero model input for the worker: not one request reached the adapter, and
    // nothing claims the child was ever asked to work.
    expect(loop.requestsOf(worker)).toEqual([])
    expect(loop.requestsOf(ROOT).length).toBeGreaterThan(0)
    expect(root.taskId).toBeDefined()
  })
})
