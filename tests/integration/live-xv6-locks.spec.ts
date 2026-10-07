/** Opt-in real-model validation: the xv6 locks lab optimized through the production loop and judged by the lab's own grader. */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  textResponse,
  toolCallResponse,
} from '../../../../thirdparty/deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { resolveApiConfig } from '../../../../tools/scripts/api-config.mjs'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { disposeScriptedLoops, REAL_TOOLS, startScriptedLoop } from '../support/scripted-loop.ts'
import {
  ensureXv6ToolchainOnPath,
  prepareXv6Checkout,
  registerXv6Library,
  requireXv6Testbed,
  XV6_BASH_TIMEOUT_MS,
  XV6_CONSTRAINTS,
  XV6_VERIFY_TIMEOUT_MS,
  xv6CheckoutTools,
  xv6Criteria,
} from '../support/xv6-locks.ts'

const enabled = process.env.SINGULARITY_LIVE_XV6_LOCKS === '1'
const PROGRESS_PATH = '/tmp/singularity-live-xv6-locks-progress.json'
const EVIDENCE_PATH = new URL('../../docs/2026-10-03-live-xv6-locks.json', import.meta.url)
const REQUEST_ALLOWANCE = 400
/** The pristine-tree baseline this deployment starts from (env report, `baseline.json`). */
const BASELINE = {
  score: '49/70',
  wallSeconds: 189.31,
  note: 'kalloctest test1 and bcachetest test0 fail on lock contention; no time.txt',
}

if (enabled) {
  ensureXv6ToolchainOnPath()
  requireXv6Testbed()
}

afterEach(disposeScriptedLoops)

it.skipIf(!enabled)(
  'optimizes the xv6 locks lab to a full grade with an independent checker and template reuse',
  async () => {
    const api = resolveApiConfig()
    const startedAt = Date.now()
    const h = await startScriptedLoop({
      capabilities: {
        'coordinate-tasks': { skills: ['task-coordination'] },
        'local-files': { skills: ['task-execution'], tools: ['filesystem'] },
      },
      // A full grade is ~3 min under TCG but the budget must clear a slow host: the
      // runtime's own default is only 600_000 ms, so the harness names the xv6 budget.
      verifyTimeoutMs: XV6_VERIFY_TIMEOUT_MS,
      script: () => [],
      tools: xv6CheckoutTools(),
    })
    // Plumbing first: the runtime the harness just mounted must carry the xv6 budget,
    // or a grade would be cut off at the 10-minute default.
    expect((h.ctx as unknown as { taskRuntime: { verifyTimeoutMs: number } }).taskRuntime.verifyTimeoutMs).toBe(
      XV6_VERIFY_TIMEOUT_MS,
    )
    // The live request presents only executable tools; the fixture keeps other names registered for role validation.
    h.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next()
      assembled.tools = assembled.tools.filter(
        tool => REAL_TOOLS.includes(tool.name) || ['read', 'write', 'bash', 'task_verify'].includes(tool.name),
      )
      return assembled
    })
    prepareXv6Checkout(h.checkout)
    await registerXv6Library(h.runtime, { distractors: 30 })
    const requests: { sessionId: string; text: string; tools: string[] }[] = []
    // Stall resilience: a live model may end its turn with plain text while its run
    // stays active (observed in this lab). Track the in-flight fetch so the watchdog
    // below can tell a silent turn-end from a slow request, and nudge the idle
    // session through the runtime's own prompt door. Nudges are recorded as evidence.
    let fetchInFlight = false
    let lastProgressAt = Date.now()
    let lastCounts = ''
    const nudges: { at: string; sessionId: string; taskId: string }[] = []
    h.ctx.on('llm/stream', async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (requests.length >= REQUEST_ALLOWANCE) throw new Error('live validation exceeded its request allowance')
      requests.push({
        sessionId: String(options.sessionId),
        text: JSON.stringify(options.messages),
        tools: options.tools?.map(tool => tool.name) ?? [],
      })
      const messages = options.messages.flatMap(message => {
        const content = message.content
          .filter(block => block.type === 'text')
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('\n')
        if (message.role === 'developer') return content ? [{ role: 'user', content }] : []
        if (message.role === 'tool') return [{ role: 'tool', tool_call_id: message.toolCallId, content }]
        const calls = message.content
          .filter(block => block.type === 'tool-call')
          .map(block =>
            block.type === 'tool-call'
              ? { id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }
              : undefined,
          )
        return [{ role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) }]
      })
      const requestStartedAt = Date.now()
      process.stderr.write(
        `[live] request #${requests.length} start ${new Date().toISOString()} messages=${messages.length}\n`,
      )
      const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(240000)])
      // Transient gateway failures must not stall a multi-hour run: retry network
      // errors and retryable HTTP statuses with backoff. A superseded turn
      // (signal.aborted) still ends the stream cleanly without retrying.
      let response: Awaited<ReturnType<typeof fetch>> | undefined
      fetchInFlight = true
      try {
        for (let attempt = 1; attempt <= 8 && response === undefined; attempt++) {
          try {
            const candidate = await fetch(`${api.upstream}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${api.key}`,
                'User-Agent': api.userAgent,
              },
              body: JSON.stringify({
                model: api.model,
                messages,
                tools: options.tools?.map(tool => ({ type: 'function', function: tool })),
                max_tokens: 8000,
                stream: false,
              }),
              signal,
            })
            const retryable = [408, 409, 429, 500, 502, 503, 504].includes(candidate.status)
            if (!retryable || attempt === 8) {
              response = candidate
            } else {
              const detail = (await candidate.text()).slice(0, 300)
              process.stderr.write(
                `[live] request #${requests.length} attempt ${attempt} got HTTP ${candidate.status}: ${detail}\n`,
              )
              await new Promise(resolve => setTimeout(resolve, Math.min(attempt * 5000, 30000)))
            }
          } catch (error) {
            process.stderr.write(
              `[live] request #${requests.length} attempt ${attempt} aborted after ${Date.now() - requestStartedAt}ms aborted=${signal.aborted} reason=${String(signal.reason)}\n`,
            )
            if (signal.aborted) {
              yield* textResponse('')
              return
            }
            if (attempt === 8) throw error
            await new Promise(resolve => setTimeout(resolve, Math.min(attempt * 5000, 30000)))
          }
          if (response === undefined && signal.aborted) {
            yield* textResponse('')
            return
          }
        }
        if (response === undefined) throw new Error('live model request failed after 8 attempts')
        if (!response.ok) throw new Error(`live model returned HTTP ${response.status}`)
      } finally {
        fetchInFlight = false
      }
      const result = await response.json()
      process.stderr.write(`[live] request #${requests.length} ok in ${Date.now() - requestStartedAt}ms\n`)
      await writeFile(
        PROGRESS_PATH,
        JSON.stringify({ requests, calls: h.calls, snapshot: await h.snapshot(rootTaskStoreId('s-root')) }, null, 2) +
          '\n',
      )
      const answer = result.choices?.[0]?.message
      if (!answer) throw new Error('live model returned no assistant message')
      const calls = answer.tool_calls ?? []
      if (!calls.length) {
        yield* textResponse(answer.content ?? '')
        return
      }
      let block = 0
      for (const call of calls) {
        const chunks = toolCallResponse(call.id, call.function.name, JSON.parse(call.function.arguments))
        for (const chunk of chunks)
          if (chunk.type !== 'usage' && chunk.type !== 'finish')
            yield 'index' in chunk ? { ...chunk, index: block } : chunk
        block++
      }
      yield {
        type: 'usage',
        usage: { inputTokens: result.usage?.prompt_tokens ?? 0, outputTokens: result.usage?.completion_tokens ?? 0 },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })
    // A progress watchdog: the persisted snapshot keeps the true state even when a
    // run stalls between two model requests. When nothing has moved for
    // NUDGE_AFTER_MS — no new request, no new tool call, none pending, no fetch in
    // flight — a run still marked active has silently ended its turn, so nudge its
    // session through the runtime's own prompt door and record the nudge.
    const NUDGE_AFTER_MS = 360_000
    const watchdog = setInterval(() => {
      const pending = h.calls.filter(call => call.result === undefined).map(call => `${call.sessionId}:${call.name}`)
      process.stderr.write(
        `[live] watchdog requests=${requests.length} calls=${h.calls.length} pending=${pending.join(',') || 'none'} nudges=${nudges.length}\n`,
      )
      const counts = `${requests.length}:${h.calls.length}`
      if (counts !== lastCounts) {
        lastCounts = counts
        lastProgressAt = Date.now()
      }
      void h
        .snapshot(rootTaskStoreId('s-root'))
        .then(async snapshot => {
          await writeFile(
            PROGRESS_PATH,
            JSON.stringify({ requests, calls: h.calls, nudges, snapshot }, null, 2) + '\n',
          )
          if (pending.length > 0 || fetchInFlight || Date.now() - lastProgressAt <= NUDGE_AFTER_MS) return
          for (const run of snapshot.runs.filter(candidate => candidate.executionPhase === 'active')) {
            if (nudges.filter(nudge => nudge.sessionId === run.sessionId).length >= 10) continue
            try {
              await h.agentRuntime.prompt(h.agent(run.sessionId), [
                {
                  type: 'text',
                  text:
                    'Your previous turn ended without a tool call, but your task is still active. Continue now: ' +
                    'build with `make`, grade with `bash checks/verify.sh <stage>` or `python3 grade-lab-lock <filter>`, ' +
                    'and when your criterion passes call task_submit_result with a short summary. Do not end a turn ' +
                    'with plain text before your result is submitted.',
                },
              ])
              nudges.push({ at: new Date().toISOString(), sessionId: String(run.sessionId), taskId: String(run.taskId) })
              lastProgressAt = Date.now()
              process.stderr.write(`[live] nudged ${run.sessionId} (task ${run.taskId})\n`)
            } catch (error) {
              process.stderr.write(`[live] nudge of ${run.sessionId} failed: ${String(error).slice(0, 160)}\n`)
            }
          }
        })
        .catch(() => undefined)
    }, 15000)
    watchdog.unref?.()
    const root = await h.begin({
      objective:
        "Deliver the completed xv6 locks lab: eliminate the kernel's lock contention so the physical page allocator and " +
        "the buffer cache no longer serialize on a single global lock, and the lab's own grader prints a full score. " +
        '`python3 grade-lab-lock` must print `Score: 70/70`, including the `time.txt` point: the file `time.txt` must ' +
        'exist at the repository root and contain a single positive integer (the hours spent on the lab). Own the ' +
        'optimization effort as exactly one coordinating child: call task_decompose once with a reason and ' +
        '`children: [{ "templateRef": { "id": "xv6-lock-lab-optimization", "version": 1 }, "decomposable": true }]`, ' +
        "and nothing else. That child then expands the template's recipe itself into the allocator, buffer-cache and " +
        'regression grandchildren, so you must NOT pass templateRef at the top level of your call (that would replace ' +
        'your own decomposition with the recipe leaves at your level), and you must not enumerate the stage leaves ' +
        'yourself.',
      acceptanceCriteria: xv6Criteria('all'),
      requiredCapabilities: ['coordinate-tasks'],
      templateScope: [['kernel']],
      constraints: [
        ...XV6_CONSTRAINTS,
        "The lab is graded by the lab's own grader and by the independent checker `bash checks/verify.sh <stage>` " +
          '(stages: kalloc, bcache, regression, modules, all). Do not reimplement, bypass or weaken either judge.',
        'Build with plain `make`; the RISC-V cross toolchain and the qemu wrapper are already on PATH, and a full grade ' +
          'takes minutes, so give the grader room rather than assuming it hung.',
        'Decompose exactly once: call task_decompose with a `reason` plus `children: [{ "templateRef": { "id": ' +
          '"xv6-lock-lab-optimization", "version": 1 }, "decomposable": true }]`. Never pass a top-level `templateRef` ' +
          'from the root (it replaces your own decomposition with the recipe leaves), and never enumerate the ' +
          'allocator/buffer-cache/regression leaves at your own level — the coordinating child expands that recipe into ' +
          'those grandchildren.',
        'Every worker (including you) must keep calling tools until its result is submitted: never end a turn with ' +
          'plain text while your task is active — build, grade with `bash checks/verify.sh <stage>`, and finish with ' +
          'task_submit_result.',
      ],
    })
    let waitError: unknown
    try {
      await vi.waitFor(
        async () =>
          expect(['verified', 'failed', 'cancelled']).toContain(
            (await h.snapshot(root.storeId)).tasks.find(task => task.taskId === root.taskId)?.status,
          ),
        { timeout: 10_800_000, interval: 1000 },
      )
    } catch (error) {
      // Even when the run outlives the wait, the snapshot and regrade below still
      // describe the final state honestly — always write the evidence.
      waitError = error
    }
    clearInterval(watchdog)
    const snapshot = await h.snapshot(root.storeId)
    await writeFile(PROGRESS_PATH, JSON.stringify({ requests, calls: h.calls, snapshot }, null, 2) + '\n')
    const rootTask = snapshot.tasks.find(task => task.taskId === root.taskId)!
    const wallSeconds = (Date.now() - startedAt) / 1000
    // The spec re-runs the independent checker itself, outside the runtime: the
    // belt-and-suspenders read of the final checkout.
    const regrade = spawnSync('bash', ['checks/verify.sh', 'all'], {
      cwd: h.checkout,
      encoding: 'utf8',
      timeout: XV6_BASH_TIMEOUT_MS,
      maxBuffer: 128 * 1024 * 1024,
    })
    const gradeOutput = String(regrade.stdout ?? '') + String(regrade.stderr ?? '')
    const gradeScore = /Score: [0-9]+\/[0-9]+/.exec(gradeOutput)?.[0] ?? 'Score: ?/?'
    const templateBound = snapshot.tasks.filter(task => task.templateRef !== undefined)
    const leafVerdicts = snapshot.tasks
      .filter(
        task =>
          task.templateRef?.id.startsWith('xv6-') === true && task.templateRef?.id !== 'xv6-lock-lab-optimization',
      )
      .map(task => {
        const run = snapshot.runs.filter(candidate => candidate.taskId === task.taskId).at(-1)
        const verdicts = snapshot.evidence
          .filter(item => item.taskRunId === run?.runId)
          .flatMap(item => item.verifierResults)
          .map(result => ({ criterionId: result.criterionId, status: result.status, exitCode: result.exitCode }))
        return { templateId: task.templateRef!.id, taskId: task.taskId, status: task.status, verdicts }
      })
    const assertions = {
      rootVerified: rootTask.status === 'verified',
      depthAtLeastTwo: Math.max(...snapshot.tasks.map(task => task.depth)) >= 2,
      dependencyEdgesAtLeastTwo: snapshot.edges.length >= 2,
      atLeastThreeTemplateBoundInstances: templateBound.length >= 3,
      allRunsBindSkills: snapshot.runs.every(run => (run.providerBinding?.skills.length ?? 0) > 0),
      noUnrelatedTemplatesInRequests: requests.every(request => !request.text.includes('UNRELATED_DOMAIN_MARKER')),
      specRegradeScoreFull: regrade.status === 0 && gradeScore === 'Score: 70/70',
    }
    const evidence = {
      date: '2026-10-03',
      test: 'tests/integration/live-xv6-locks.spec.ts',
      command:
        'SINGULARITY_LIVE_XV6_LOCKS=1 pnpm exec vitest run --project integration packages/singularity/tests/integration/live-xv6-locks.spec.ts',
      model: api.model,
      result: Object.values(assertions).every(Boolean) ? 'passed' : 'failed',
      method:
        'A real model decomposes the root xv6 locks contract through the production TaskRuntime and TaskTemplate ' +
        'retrieval: four `kernel` templates are available (per-CPU kalloc leaf, fine-grained bcache leaf, full-regression ' +
        'leaf, and a coordinating xv6-lock-lab-optimization template whose recipe composes the three leaves with the ' +
        'regression gated on both fixes), alongside thirty unrelated `web` distractors. An independent test-authored ' +
        "checker (checks/verify.sh) is written into the checkout before admission: it runs the lab's own grader " +
        "(grade-lab-lock, singular) under an internal 1500s timeout, parses the grader's OK/FAIL lines and final " +
        '`Score: X/70`, and exits 0 only when the stage passes. read/write/bash are real tool bodies bounded to the ' +
        'checkout, with the bash timeout raised to 1500s for grading; the llm/stream hook forwards each model request to ' +
        'the real gateway. The task-runtime verifier budget is 1_500_000 ms, asserted at start so a plumbing regression ' +
        'fails fast instead of silently reverting to the 600_000 ms default. The spec re-runs `bash checks/verify.sh all` ' +
        'itself after the run, outside the runtime.',
      assertions,
      cases: [
        {
          name: 'xv6-locks-lab',
          baseline: BASELINE,
          final: { score: gradeScore, wallSeconds, regradeExit: regrade.status ?? null },
          requestCount: requests.length,
          tree: {
            tasks: snapshot.tasks.map(task => ({
              taskId: task.taskId,
              parentTaskId: task.parentTaskId,
              depth: task.depth,
              objective: task.objective,
              templateRef: task.templateRef,
              status: task.status,
            })),
            edges: snapshot.edges,
            runs: snapshot.runs.map(run => ({
              taskId: run.taskId,
              skills: run.providerBinding?.skills.map(skill => skill.name),
              capabilities: run.providerBinding?.capabilities,
            })),
          },
          leafVerdicts,
          gradeOutput,
          nudges,
        },
      ],
      limits:
        'One lab task under a TCG-emulated RISC-V guest: the grade itself takes minutes and is sensitive to host load, ' +
        'so the verifier budget is 1_500_000 ms and the terminal wait is 10_800_000 ms (an 80-minute wait was measured ' +
        'insufficient: the model iterated the buffer-cache locking for the whole budget with kalloc already verified). The run records one model and one ' +
        'machine; it does not measure long-term autonomous improvement quality, and the lock-contention thresholds in ' +
        'kalloctest/bcachetest can be flaky under a heavily loaded host. The harness watchdog nudges a run whose turn ' +
        'ended silently (no tool call, nothing in flight, no progress for 6 minutes) through the runtime’s own prompt ' +
        'door; every nudge is recorded per case and counted in the run log.',
    }
    await writeFile(PROGRESS_PATH, JSON.stringify({ requests, calls: h.calls, nudges, snapshot }, null, 2) + '\n')
    writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n')
    await writeFile('/tmp/singularity-live-xv6-locks.json', JSON.stringify(evidence, null, 2) + '\n')
    await h.dispose()
    if (waitError) throw waitError
    expect(assertions.rootVerified).toBe(true)
    expect(assertions.depthAtLeastTwo).toBe(true)
    expect(assertions.dependencyEdgesAtLeastTwo).toBe(true)
    expect(assertions.atLeastThreeTemplateBoundInstances).toBe(true)
    expect(assertions.allRunsBindSkills).toBe(true)
    expect(assertions.noUnrelatedTemplatesInRequests).toBe(true)
    expect(assertions.specRegradeScoreFull).toBe(true)
  },
  12_600_000,
)
