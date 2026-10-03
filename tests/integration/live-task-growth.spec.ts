/** Opt-in real-model Task growth and reuse through the production loop and verifiers. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defineTool } from '../../../../thirdparty/deepseek-harness/packages/core/tools/lib/index.js'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { textResponse, toolCallResponse } from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { resolveApiConfig } from '../../../../tools/scripts/api-config.mjs'
import { rootTaskStoreId, type TaskTemplate } from '../../task/src/index.ts'
import { disposeScriptedLoops, REAL_TOOLS, startScriptedLoop } from '../support/scripted-loop.ts'

const enabled = process.env.SINGULARITY_LIVE_TASK_GROWTH === '1'
afterEach(disposeScriptedLoops)

it.skipIf(!enabled)('grows a responsibility tree with dependency edges and reuses scoped Tasks on new inputs', async () => {
  const api = resolveApiConfig()
  const evidence: unknown[] = []
  const criteria = (kind: string) => [{ criterionId: `${kind}-result`, description: `${kind} agrees with the original input`,
    command: `node checks/verify.mjs ${kind}`, protectedInputs: ['checks/verify.mjs', 'numbers.json'] }]
  const leaf = (id: string, objective: string, kind: string): TaskTemplate => ({
    id, version: 1, catalogPath: ['numbers'], appliesTo: [objective],
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
    contract: { objective, acceptanceCriteria: criteria(kind), requiredCapabilities: ['local-files'] },
  })
  const templates: TaskTemplate[] = [
    leaf('square-numbers', 'Read numbers.json and deliver squares.json with the elementwise squares in input order.', 'squares'),
    leaf('absolute-numbers', 'Read numbers.json and deliver absolute.json with the elementwise absolute values in input order.', 'absolute'),
    { ...leaf('transform-numbers', 'Own the transformation subsystem: deliver and independently verify both squares.json and absolute.json.', 'transforms'),
      contract: { objective: 'Own the transformation subsystem: deliver and independently verify both squares.json and absolute.json.',
        acceptanceCriteria: criteria('transforms'), requiredCapabilities: ['coordinate-tasks'] } },
    leaf('summarize-transforms', 'Consume verified squares.json and absolute.json; deliver summary.json with count, sumSquares and sumAbsolute.', 'summary'),
  ]
  // This is an available decomposition recipe, not a prescribed root tree.
  templates[2]!.decomposition = { reason: 'The two transformations have independently checkable results.',
    children: [
      { objective: templates[0]!.contract.objective, acceptanceCriteria: criteria('squares'), requiredCapabilities: ['local-files'] },
      { objective: templates[1]!.contract.objective, acceptanceCriteria: criteria('absolute'), requiredCapabilities: ['local-files'] },
    ] }
  for (const numbers of [[3, 7, -2], [2, -5]]) {
    const h = await startScriptedLoop({
      capabilities: { 'coordinate-tasks': { skills: ['task-coordination'] },
        'local-files': { skills: ['task-execution'], tools: ['filesystem'] } },
      script: () => [], supervision: { autoReview: 'off' },
      tools: ['read', 'write'].map(name => defineTool({
        name, description: name === 'read' ? 'Read a UTF-8 file in this checkout.' : 'Write a UTF-8 file in this checkout.',
        parameters: { path: { type: 'string', required: true }, ...(name === 'write' ? { content: { type: 'string', required: true } } : {}) },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async (args, exec) => {
          const checkout = exec.agent!.session.header.cwd!
          const target = resolve(checkout, args.path)
          if (!target.startsWith(checkout + '/')) throw new Error('live validation files must stay inside the checkout')
          if (name === 'read') return await readFile(target, 'utf8')
          await writeFile(target, String(args.content))
          return `wrote ${args.path}`
        },
      })),
    })
    // The live request presents only executable tools; the fixture keeps other names registered for role validation.
    h.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next()
      assembled.tools = assembled.tools.filter(tool => REAL_TOOLS.includes(tool.name) ||
        ['read', 'write', 'task_verify'].includes(tool.name))
      return assembled
    })
    mkdirSync(join(h.checkout, 'checks'), { recursive: true })
    writeFileSync(join(h.checkout, 'numbers.json'), JSON.stringify(numbers))
    writeFileSync(join(h.checkout, 'checks/verify.mjs'), `import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = name => JSON.parse(readFileSync(name+'.json','utf8'));
const numbers=read('numbers'), squares=numbers.map(x=>x*x), absolute=numbers.map(Math.abs);
const kind=process.argv[2];
if(['squares','transforms','all'].includes(kind))assert.deepEqual(read('squares'),squares);
if(['absolute','transforms','all'].includes(kind))assert.deepEqual(read('absolute'),absolute);
if(['summary','all'].includes(kind))assert.deepEqual(read('summary'),{count:numbers.length,sumSquares:squares.reduce((a,b)=>a+b,0),sumAbsolute:absolute.reduce((a,b)=>a+b,0)});
console.log(kind+' verified');\n`)
    for (const template of templates) await h.runtime.registerTaskTemplate(template)
    for (let index = 0; index < 30; index++) await h.runtime.registerTaskTemplate({
      ...leaf(`unrelated-${index}`, 'UNRELATED_DOMAIN_MARKER: paint a webpage.', 'squares'), catalogPath: ['web'],
    })
    const requests: { sessionId: string; text: string; tools: string[] }[] = []
    h.ctx.on('llm/stream', async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (requests.length >= 64) throw new Error('live validation exceeded its request allowance')
      requests.push({ sessionId: String(options.sessionId), text: JSON.stringify(options.messages), tools: options.tools?.map(tool => tool.name) ?? [] })
      const messages = options.messages.flatMap(message => {
        const content = message.content.filter(block => block.type === 'text').map(block => block.type === 'text' ? block.text : '').join('\n')
        if (message.role === 'developer') return content ? [{ role: 'user', content }] : []
        if (message.role === 'tool') return [{ role: 'tool', tool_call_id: message.toolCallId, content }]
        const calls = message.content.filter(block => block.type === 'tool-call').map(block => block.type === 'tool-call'
          ? { id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } } : undefined)
        return [{ role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) }]
      })
      const response = await fetch(`${api.upstream}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${api.key}`, 'User-Agent': api.userAgent },
        body: JSON.stringify({ model: api.model, messages, tools: options.tools?.map(tool => ({ type: 'function', function: tool })), max_tokens: 5000, stream: false }),
        signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(90000)]),
      })
      if (!response.ok) throw new Error(`live model returned HTTP ${response.status}`)
      const result = await response.json()
      await writeFile('/tmp/singularity-round3-live-growth-progress.json', JSON.stringify({
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
    const root = await h.begin({
      objective: 'Deliver a transformation subsystem producing squares.json and absolute.json from numbers.json, and a summary.json consuming those verified results with count, sumSquares and sumAbsolute. Coordinate the subsystem as an owned responsibility; its worker decides the independently checkable transformation children. Use available Task templates where applicable.',
      acceptanceCriteria: criteria('all'), requiredCapabilities: ['coordinate-tasks'], templateScope: [['numbers']],
      constraints: ['Keep numbers.json and checks/verify.mjs unchanged. Read and write only inside the checkout.'],
    })
    await vi.waitFor(async () => expect(['verified', 'failed', 'cancelled']).toContain(
      (await h.snapshot(root.storeId)).tasks.find(task => task.taskId === root.taskId)?.status,
    ), { timeout: 480000, interval: 500 })
    const snapshot = await h.snapshot(root.storeId)
    await writeFile('/tmp/singularity-round3-live-growth-progress.json', JSON.stringify({ requests, calls: h.calls, snapshot }, null, 2) + '\n')
    expect(snapshot.tasks.find(task => task.taskId === root.taskId)?.status).toBe('verified')
    expect(Math.max(...snapshot.tasks.map(task => task.depth))).toBeGreaterThanOrEqual(2)
    expect(snapshot.edges.length).toBeGreaterThan(0)
    expect(snapshot.tasks.filter(task => task.templateRef !== undefined).length).toBeGreaterThanOrEqual(2)
    expect(snapshot.tasks.every(task => task.contract !== undefined)).toBe(true)
    expect(snapshot.runs.every(run => (run.providerBinding?.skills.length ?? 0) > 0)).toBe(true)
    expect(requests.every(request => !request.text.includes('UNRELATED_DOMAIN_MARKER'))).toBe(true)
    evidence.push({ numbers, model: api.model, tasks: snapshot.tasks.map(task => ({ taskId: task.taskId, parentTaskId: task.parentTaskId, depth: task.depth, objective: task.objective, templateRef: task.templateRef, status: task.status })), edges: snapshot.edges,
      requests: requests.map(({ sessionId, tools }) => ({ sessionId, tools })), summary: JSON.parse(await readFile(join(h.checkout, 'summary.json'), 'utf8')) })
    await h.dispose()
  }
  await writeFile('/tmp/singularity-round3-live-growth.json', JSON.stringify(evidence, null, 2) + '\n')
}, 1000000)
