import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeKnowledgeSkill } from '../support/run-stack.ts'
import { disposeScriptedLoops, startScriptedLoop } from '../support/scripted-loop.ts'

afterEach(disposeScriptedLoops)

it('delivers frozen bound methods to the first native model request and records actual loading in the Run review', async () => {
  const method = 'bound-route'
  const h = await startScriptedLoop({
    capabilities: { explore: { skills: [method] } },
    script: (_session, index) => index === 0 ? [{ tool: 'task_decompose', args: {
      reason: 'Explore the selected route',
      children: [{ objective: 'Use the bound route', requiredCapabilities: ['explore'],
        acceptanceCriteria: [{ description: 'The Task is completed', command: 'true' }] }],
    } }] : [
      { waitFor: async () => { await writeKnowledgeSkill(join(h.home, 'skills'), method, 'CHANGED AFTER FREEZE') } },
      { tool: 'task_read' },
      { tool: 'task_submit_result', args: { summary: 'Route explored' } },
    ],
  })
  await writeKnowledgeSkill(join(h.home, 'skills'), method, 'FROZEN BOUND ROUTE')
  const root = await h.begin({ objective: 'Explore the route', requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: 'Exploration complete', command: 'true' }] })
  await vi.waitFor(async () => {
    const snapshot = await h.snapshot(root.storeId)
    expect(snapshot.tasks.find(task => task.parentTaskId === root.taskId)?.status).toBe('verified')
  }, { timeout: 10_000, interval: 25 })
  const snapshot = await h.snapshot(root.storeId)
  const run = snapshot.runs.find(run => run.taskId !== root.taskId)!
  const requests = h.requestsOf(run.sessionId)
  expect(requests.length).toBeGreaterThanOrEqual(2)
  for (const request of requests) {
    const bound = request.options.messages.filter(message => message.source.kind === 'task-skills')
    expect(bound).toHaveLength(1)
    expect(JSON.stringify(bound[0])).toContain('FROZEN BOUND ROUTE')
    expect(JSON.stringify(bound[0])).not.toContain('CHANGED AFTER FREEZE')
  }
  const events = h.eventsOf(run.sessionId).filter(event => event.type === 'user/message' && event.data.source.kind === 'task-skills')
  expect(events).toHaveLength(1)
  expect(h.calls.filter(call => call.sessionId === run.sessionId && call.name === 'skill')).toHaveLength(0)
  expect(snapshot.reviews.find(review => review.runId === run.runId)?.dimensions?.skillFit?.loaded).toContain(method)
})
