/**
 * A console deployment over the method-tool world: the scripted library and v5
 * ledger (with one evaluated draft and the strategy decision that refused it),
 * the graph registry the routes resolve a library through, one pending
 * publication approval, and the web server they register on. Both the API spec
 * and the parity spec run against this one world, so what they compare is the
 * same bytes read twice.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import {
  DEFAULT_STRATEGY_POLICY,
  aggregateEvaluation,
  calibrateNoise,
  foldHistory,
  reportPathOf,
  scaleOf,
  sideMeasurementOf,
  strategyDecisionOf,
} from '@dangosys/dsh-singularity-evolution'
import type { EvaluationReport, StrategyDecisionRecord } from '@dangosys/dsh-singularity-evolution'
import { GRAPH, forgeEvaluation, methodWorld } from '../../../agent-singularity/tests/unit/method-tools.fixture.ts'
import type { MethodWorld } from '../../../agent-singularity/tests/unit/method-tools.fixture.ts'

export { GRAPH, forgeEvaluation, methodWorld }

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void

export function mockRes() {
  const chunks: string[] = []
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    destroyed: false,
    writeHead(code: number, headers?: Record<string, string>) {
      this.statusCode = code
      if (headers) Object.assign(this.headers, headers)
    },
    write(chunk: string) {
      chunks.push(chunk)
      this.body = chunks.join('')
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) chunks.push(chunk)
      this.body = chunks.join('')
    },
    on() {},
    destroy() {},
  }
}

export function mockReq(method: string, url: string): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage
  req.method = method
  req.url = url
  return req
}

/** A deployment's own web server and event bus, with the services it was handed. */
export function consoleCtx(services: Record<string, unknown>) {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, Set<(...args: never[]) => void>>()
  const ctx = {
    ...services,
    webServer: {
      register: ({ kind, path, handler }: { kind: 'exact' | 'prefix'; path: string; handler: Handler }) => {
        const key = kind === 'exact' ? path : `${path}/*`
        handlers.set(key, handler)
        return () => handlers.delete(key)
      },
    },
    on(event: string, listener: (...args: never[]) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    get(name: string) {
      return services[name]
    },
  }
  return { ctx, handlers, listeners }
}

export function json(res: ReturnType<typeof mockRes>): any {
  return JSON.parse(res.body)
}

/** Every environment entry a read must never reach, with how often the world saw it. */
export function writesOf(calls: Record<string, number>): [string, number][] {
  return Object.entries(calls)
    .filter(([name]) => /createDraft|stageDraftEdit|removeEnvironmentDraft|freezeDraft|publishRevision|rollbackRevision|reconcilePointer/.test(name))
    .sort(([a], [b]) => (a < b ? -1 : 1))
}

/** The graph-level projection a deployment's `GraphViewService` answers with. */
export const graphViewWire = {
  formatVersion: 2 as const,
  graph: { id: GRAPH, name: 'the graph', createdAt: 1 },
  access: { mode: 'current' as const },
  revision: { revisionId: 'r0001', manifestDigest: 'a'.repeat(64), origin: 'graph-initial' as const, publishedAt: null },
  evaluation: null,
  progress: { round: 0, rounds: 3, phase: 'idle' as const },
  generation: 7,
}

/** The one publication approval this deployment is holding. */
export const publicationCard = {
  id: 'hitl-1',
  kind: 'approve',
  prompt: 'Method publish for skill verify (draft d0001, base r0001, bundle no)\nversion switch: active r0001 g0',
  sessionId: 's-supervisor',
  createdAt: 5,
}

/** The graph registry these routes resolve a library through, with the world's own `rsi` settings. */
export function graphRegistryFor(world: MethodWorld) {
  return {
    get: async (id: string) => {
      if (id !== GRAPH) throw new Error(`graphs: unknown graph "${id}"`)
      return { id, rootSessionId: GRAPH }
    },
    graphForSession: async () => ({ id: GRAPH, rootSessionId: GRAPH, rsi: world.rsi }),
  }
}

/**
 * The landed strategy decision of one forged evaluation, written where the
 * strategy writes it, by the strategy's own pure functions — the same record
 * `pipeline/evaluate.ts` lands in production. The forged candidate is measured
 * without a sealed cost reading, so the strategy refuses it: a reader has to read
 * the refusal rather than recompute one.
 */
export async function writeDecision(world: MethodWorld, draftId: string, evaluationId: string): Promise<StrategyDecisionRecord> {
  const report = JSON.parse(
    await readFile(join(world.library.root, reportPathOf(draftId, evaluationId)), 'utf8'),
  ) as EvaluationReport
  const policy = DEFAULT_STRATEGY_POLICY
  const scale = scaleOf(report)
  const baseline = sideMeasurementOf({ report, side: 'baseline', scale, policy })
  const incumbent = aggregateEvaluation(baseline)
  const decision = strategyDecisionOf({
    report,
    policy,
    incumbent,
    bestQuality: incumbent.quality,
    calibration: calibrateNoise([baseline], policy),
    history: foldHistory({ candidates: [], evaluations: [], consumption: [], refutations: [], versions: [] }, policy, 0),
    guards: report.guards.filter(guard => !guard.ok).map(guard => guard.id),
    at: '2026-10-08T00:00:00.000Z',
  })
  const path = join(dirname(join(world.library.root, reportPathOf(draftId, evaluationId))), 'strategy-decision.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(decision)}\n`, 'utf8')
  return decision
}

/** One method-tool world with an evaluated draft, its landed decision, and a console bound to it. */
export async function methodConsole() {
  const world = await methodWorld({ humanReview: false })
  const forged = await forgeEvaluation(world, { cost: 'unknown' })
  const decision = await writeDecision(world, forged.draftId, forged.evaluationId)
  const { ctx, handlers, listeners } = consoleCtx({
    ...world.ctx,
    graphs: graphRegistryFor(world),
    hitl: {
      list: () => [
        publicationCard,
        { id: 'hitl-2', kind: 'approve', prompt: 'Approve task_library?', sessionId: 's', createdAt: 6 },
      ],
    },
    singularityGraphView: { view: async () => graphViewWire },
  })
  return { world, ...forged, decision, ctx, handlers, listeners }
}
