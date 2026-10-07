/** Opt-in real-model cross-module engineering: a log-analytics CLI grown through the production loop and verified by an independent checker. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { textResponse, toolCallResponse } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { resolveApiConfig } from '../../../../tools/scripts/api-config.mjs'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { disposeScriptedLoops, REAL_TOOLS, startScriptedLoop } from '../support/scripted-loop.ts'
import {
  CASES,
  CHECKER,
  checkoutTools,
  expectedLog,
  LOG_CONSTRAINTS,
  registerLogLibrary,
  stageCriteria,
} from '../support/log-pipeline.ts'

const enabled = process.env.SINGULARITY_LIVE_LOG_PIPELINE === '1'
const PROGRESS_PATH = '/tmp/singularity-live-log-pipeline-progress.json'
const REQUEST_ALLOWANCE = 160

afterEach(disposeScriptedLoops)

it.skipIf(!enabled)('grows a log-analytics CLI tree with an independent checker and template reuse', async () => {
  const api = resolveApiConfig()
  const evidence: unknown[] = []
  for (const testCase of CASES) {
    // Every assertion below reads this case's own expectation, recomputed from its
    // log — no expected value is a literal here.
    const expectation = expectedLog(testCase.log)
    const h = await startScriptedLoop({
      capabilities: { 'coordinate-tasks': { skills: ['task-coordination'] },
        'local-files': { skills: ['task-execution'], tools: ['filesystem'] } },
      script: () => [], tools: checkoutTools(),
    })
    // The live request presents only executable tools; the fixture keeps other names registered for role validation.
    h.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next()
      assembled.tools = assembled.tools.filter(tool => REAL_TOOLS.includes(tool.name) ||
        ['read', 'write', 'bash', 'task_verify'].includes(tool.name))
      return assembled
    })
    mkdirSync(join(h.checkout, 'checks'), { recursive: true })
    writeFileSync(join(h.checkout, 'events.log'), testCase.log)
    writeFileSync(join(h.checkout, 'checks/verify.mjs'), CHECKER)
    // Case 1 runs against the healthy library; case 2 runs against the post-repair
    // library, where the defective aggregate v1 and the corrected v2 are both
    // present and the recipe pins the runtime's current version (v2).
    await registerLogLibrary(h.runtime, { aggregate: testCase.name === 'case-2' ? 'repaired' : 'correct', distractors: 30 })
    const requests: { sessionId: string; text: string; tools: string[] }[] = []
    h.ctx.on('llm/stream', async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (requests.length >= REQUEST_ALLOWANCE) throw new Error('live validation exceeded its request allowance')
      requests.push({ sessionId: String(options.sessionId), text: JSON.stringify(options.messages), tools: options.tools?.map(tool => tool.name) ?? [] })
      const messages = options.messages.flatMap(message => {
        const content = message.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n')
        if (message.role === 'developer') return content ? [{ role: 'user', content }] : []
        if (message.role === 'tool') return [{ role: 'tool', tool_call_id: message.toolCallId, content }]
        const calls = message.content.filter(block => block.type === 'tool-call').map(block => block.type === 'tool-call'
          ? { id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } } : undefined)
        return [{ role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) }]
      })
      const startedAt = Date.now()
      process.stderr.write(`[live] request #${requests.length} start ${new Date().toISOString()} messages=${messages.length}\n`)
      const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(240000)])
      let response: Awaited<ReturnType<typeof fetch>>
      try {
        response = await fetch(`${api.upstream}/v1/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${api.key}`, 'User-Agent': api.userAgent },
          body: JSON.stringify({ model: api.model, messages, tools: options.tools?.map(tool => ({ type: 'function', function: tool })), max_tokens: 5000, stream: false }),
          signal,
        })
      } catch (error) {
        // The turn owning this request was superseded (a batch-end notice, a new
        // person message, or the test's own deadline): end the stream cleanly so
        // the loop can start the next turn instead of treating it as a step fault.
        process.stderr.write(`[live] request #${requests.length} aborted after ${Date.now() - startedAt}ms aborted=${signal.aborted} reason=${String(signal.reason)}\n`)
        if (signal.aborted) { yield* textResponse(''); return }
        throw error
      }
      if (!response.ok) throw new Error(`live model returned HTTP ${response.status}`)
      const result = await response.json()
      process.stderr.write(`[live] request #${requests.length} ok in ${Date.now() - startedAt}ms\n`)
      await writeFile(PROGRESS_PATH, JSON.stringify({
        requests, calls: h.calls, snapshot: await h.snapshot(rootTaskStoreId('s-root')),
      }, null, 2) + '\n')
      const answer = result.choices?.[0]?.message
      if (!answer) throw new Error('live model returned no assistant message')
      const calls = answer.tool_calls ?? []
      if (!calls.length) { yield* textResponse(answer.content ?? ''); return }
      let block = 0
      for (const call of calls) {
        const chunks = toolCallResponse(call.id, call.function.name, JSON.parse(call.function.arguments))
        for (const chunk of chunks) if (chunk.type !== 'usage' && chunk.type !== 'finish') yield 'index' in chunk ? { ...chunk, index: block } : chunk
        block++
      }
      yield { type: 'usage', usage: { inputTokens: result.usage?.prompt_tokens ?? 0, outputTokens: result.usage?.completion_tokens ?? 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    // A progress watchdog: the persisted snapshot keeps the true state even when
    // a run stalls between two model requests, and names any tool call still
    // waiting for a result.
    const watchdog = setInterval(() => {
      const pending = h.calls.filter(call => call.result === undefined).map(call => `${call.sessionId}:${call.name}`)
      process.stderr.write(`[live] watchdog requests=${requests.length} calls=${h.calls.length} pending=${pending.join(',') || 'none'}\n`)
      void h.snapshot(rootTaskStoreId('s-root')).then(async snapshot => {
        await writeFile(PROGRESS_PATH, JSON.stringify({ requests, calls: h.calls, snapshot }, null, 2) + '\n')
      }).catch(() => undefined)
    }, 15000)
    watchdog.unref?.()
    const root = await h.begin({
      objective: 'Deliver a log-analytics CLI: cli.mjs must run the whole pipeline end to end for the log file and output ' +
        'directory it is given, and the pipeline itself must produce out/events.json (parse.mjs), out/stats.json (aggregate.mjs) ' +
        'and out/report.md (report.mjs) from events.log. Own the analytics pipeline as an owned responsibility; its worker decides ' +
        'the independently checkable stage children. Author the CLI contract yourself when no template applies; a child that reads ' +
        'or writes files must require the local-files capability. Use available Task templates where applicable.',
      acceptanceCriteria: stageCriteria('all'), requiredCapabilities: ['coordinate-tasks'], templateScope: [['logs']],
      constraints: [
        ...LOG_CONSTRAINTS,
        'parse.mjs reads events.log and writes out/events.json as an array of {ts, level, message}; aggregate.mjs reads ' +
          'out/events.json and writes out/stats.json as {total, perLevel: {INFO, WARN, ERROR}, errorRate} with errorRate ' +
          'rounded to exactly 3 decimals; report.mjs reads out/stats.json and writes out/report.md; cli.mjs runs the three ' +
          'stages for the log path and output directory it is given.',
        'The CLI stage is independently judged by `node checks/verify.mjs cli`; the pipeline stages by ' +
          '`node checks/verify.mjs parse`, `node checks/verify.mjs aggregate`, `node checks/verify.mjs report` and ' +
          '`node checks/verify.mjs pipeline`.',
      ],
    })
    await vi.waitFor(async () => expect(['verified', 'failed', 'cancelled']).toContain(
      (await h.snapshot(root.storeId)).tasks.find(task => task.taskId === root.taskId)?.status,
    ), { timeout: 480000, interval: 500 })
    clearInterval(watchdog)
    const snapshot = await h.snapshot(root.storeId)
    await writeFile(PROGRESS_PATH, JSON.stringify({ requests, calls: h.calls, snapshot }, null, 2) + '\n')
    expect(snapshot.tasks.find(task => task.taskId === root.taskId)?.status).toBe('verified')
    expect(Math.max(...snapshot.tasks.map(task => task.depth))).toBeGreaterThanOrEqual(2)
    expect(snapshot.edges.length).toBeGreaterThanOrEqual(1)
    expect(snapshot.tasks.filter(task => task.templateRef !== undefined).length).toBeGreaterThanOrEqual(2)
    expect(snapshot.tasks.filter(task => task.templateRef === undefined).length).toBeGreaterThanOrEqual(1)
    expect(snapshot.tasks.every(task => task.contract !== undefined)).toBe(true)
    expect(snapshot.runs.every(run => (run.providerBinding?.skills.length ?? 0) > 0)).toBe(true)
    expect(requests.every(request => !request.text.includes('UNRELATED_DOMAIN_MARKER'))).toBe(true)
    const stats = JSON.parse(await readFile(join(h.checkout, 'out/stats.json'), 'utf8'))
    const report = await readFile(join(h.checkout, 'out/report.md'), 'utf8')
    expect(stats).toEqual(expectation.stats)
    const reportLines = new Set(report.split('\n').map(line => line.trim()))
    for (const line of expectation.reportLines) expect(reportLines.has(line)).toBe(true)
    if (testCase.name === 'case-2') {
      // The repaired library's current aggregate version is what the tree consumed.
      expect(snapshot.tasks.find(task => task.templateRef?.id === 'aggregate-event-stats')?.templateRef?.version).toBe(2)
    }
    evidence.push({
      name: testCase.name,
      input: { logFile: 'events.log', lines: expectation.events.length, perLevel: expectation.stats.perLevel, errorRate: expectation.stats.errorRate },
      requestCount: requests.length,
      tasks: snapshot.tasks.map(task => ({ taskId: task.taskId, parentTaskId: task.parentTaskId, depth: task.depth, objective: task.objective, templateRef: task.templateRef, status: task.status })),
      edges: snapshot.edges,
      runs: snapshot.runs.map(run => ({ taskId: run.taskId, skills: run.providerBinding?.skills, capabilities: run.providerBinding?.capabilities })),
      stats,
      report: report.split('\n').filter(line => line.trim() !== ''),
    })
    await h.dispose()
  }
  await writeFile('/tmp/singularity-live-log-pipeline.json', JSON.stringify(evidence, null, 2) + '\n')
}, 1000000)
