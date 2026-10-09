import { TASK_GUIDANCE } from '../../task-runtime/tests/support/skill-roots.ts'
/** Replay descendants consume the side's candidate through real admission, tool loading and MCP dispatch. */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import type { CapabilityConfig } from '../../task-runtime/src/index.ts'
import type { ReplayOverlay } from '../../task-runtime/src/orchestration/types.ts'
import { disposeRunStacks, startRunStack, type RunStack } from '../support/run-stack.ts'

const ROOT = 's-root' as SessionId
const ROW = 'replay-child-provider'
const ANSWER = 'answer.txt'
const command = 'test "$(cat answer.txt)" = candidate'
const SERVER = { serverName: 'replay-child', description: 'candidate child echo', command: process.execPath,
  args: [fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url))] }

afterEach(async () => { await disposeRunStacks() })

async function fixture() {
  const rows: Record<string, CapabilityConfig> = {}
  const loaded: { sessionId: string; text: string }[] = []
  let h!: RunStack
  h = await startRunStack({ roots: [ROOT], capabilities: rows, tools: true, worker: async (sessionId, agent) => {
    const { task } = await h.runtime.runForSession(sessionId)
    if (task.parentTaskId === undefined) {
      await h.call(agent, 'task_decompose', { reason: 'delegate the provider result', children: [{
        objective: 'provider child', requiredCapabilities: ['execute-task', ROW],
        acceptanceCriteria: [{ criterionId: 'child-result', description: 'provider writes the candidate result', command }],
      }] })
      // A baseline with no new row is a real admission refusal, then its unchanged
      // parent acceptance fails because no child delivered the answer.
      return
    }
    const result = await h.call(agent, 'mcp__replay-child__echo', { text: 'candidate' })
    expect(result.isError).toBe(false)
    loaded.push({ sessionId, text: result.text })
    await writeFile(join(agent.session.header.cwd, ANSWER), result.text.includes('candidate') ? 'candidate' : 'baseline')
  } })
  const overlay: ReplayOverlay = { capabilityOverrides: { [ROW]: { mcpServers: ['echo'] } }, mcpServers: { echo: SERVER } }
  await writeFile(join(h.checkout, ANSWER), 'candidate')
  const source = await h.root(ROOT, { objective: 'delegate and deliver the answer', requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'parent-result', description: 'the independently checked answer', command }] })
  await h.runtime.submitResult(ROOT, { summary: 'historical result' })
  expect((await h.task.runIn(source.storeId, source.runId)).status).toBe('verified')
  await rm(join(h.checkout, ANSWER))
  return { h, source, rows, overlay, loaded }
}

describe('candidate replay configuration in descendants', () => {
  it('loads the candidate MCP server in a real child and keeps baseline and production independent', async () => {
    const f = await fixture()
    const replay = async (side: string, overlay?: ReplayOverlay) => {
      const workspace = join(f.h.workspace, side)
      await mkdir(workspace)
      return f.h.runtime.replayTask(f.source.storeId, f.source.taskId, {
        lineage: `overlay:${side}`, workspace: { path: workspace }, ...(overlay === undefined ? {} : { overlay }),
      }, ROOT)
    }
    const baseline = await replay('baseline')
    expect(baseline.status).toBe('failed')
    const candidate = await replay('candidate', f.overlay)
    expect(candidate.status).toBe('verified')
    const snapshot = await f.h.snapshot(f.source.storeId)
    const child = snapshot.runs.find(run => run.parentRunId === candidate.runId)!
    expect(child.status).toBe('verified')
    expect(f.loaded.find(item => item.sessionId === child.sessionId)?.text).toContain('candidate')
    expect(child.providerBinding?.mcpServers).toEqual([{ serverName: 'echo', templateDigest: expect.any(String) }])
    expect(f.h.spawns.find(spawn => spawn.sessionId === child.sessionId)?.grant?.mcpServers)
      .toEqual([expect.objectContaining({ serverName: SERVER.serverName, command: SERVER.command, args: SERVER.args })])
    expect(f.h.runtime.listCapabilities()).toEqual({ ...TASK_GUIDANCE, ...f.rows })
    expect(f.h.runtime.listMcpServers()).toEqual({})
    // The existing experiment re-entry creates a new side under the frozen
    // overlay; no old session binding may be required to reconstruct it.
    f.h.runtime.sessionExecutionBindings.clear()
    const reopened = await replay('reopened-candidate', f.overlay)
    expect(reopened.status).toBe('verified')
    const finalBaseline = await replay('final-baseline')
    expect(finalBaseline.status).toBe('failed')
    expect(f.h.runtime.listCapabilities()).toEqual({ ...TASK_GUIDANCE, ...f.rows })
    expect(f.h.runtime.listMcpServers()).toEqual({})
  }, 20_000)
})
