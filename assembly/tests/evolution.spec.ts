import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { ControlSessionStore } from '../../src/control/session-store.ts'
import { createEnvironmentCommands } from '../../src/environment/commands.ts'
import { declareEnvironmentProtocol } from '../../src/environment/protocol.ts'
import { createMeasureCommands } from '../../src/measure/commands.ts'
import { declareMeasureProtocol, MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState,
} from '../../src/measure/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRegistry } from '../../src/protocol/registry.ts'
import type { VerifierCriterion } from '../../src/task/contract.ts'
import { declareStrategyProtocol, STRATEGY_KINDS, STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState,
} from '../../src/strategy/protocol.ts'
import { declareTaskProtocol, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf, type RevisionRef,
} from '../../src/task/protocol.ts'
import { createEvolution, structuralEditsOf, type SolveResult } from '../src/evolution.ts'
import { FakePersistence } from './seam.ts'
import { structuralEditDetailsOf } from '../../src/strategy/edits.ts'

const criterion: VerifierCriterion = {
  criterionId: 'correct', statement: 'independent fixture acceptance', verifierRef: 'accept',
  verifierVersion: '1', implementationDigest: 'a'.repeat(64),
}
const inputs = [{ name: 'letters.txt', digest: 'b'.repeat(64) }]
const initial = {
  rootTemplate: 'root', templates: [{ id: 'root', goal: 'count letters' }, { id: 'part', goal: 'read letters' },
  ],
  skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'count carefully' }], tools: [{ name: 'tool', source: 'export const count = input => input.length' }],
}
const calibration = { floor: 0, source: 'declared' as const }
const stores: ControlSessionStore[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.close() })

async function fixture() {
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareEnvironmentProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  const store = await ControlSessionStore.open({
    persistence: new FakePersistence() as unknown as SessionPersistence, controlId: 'evolution', registry,
    subjects: { scheduler: 'executor', environment: 'environment', strategy: 'strategy', [verifierRoleOf(criterion)]: 'acceptance',
    },
  })
  stores.push(store)
  const methods = new Map<string, typeof initial>()
  const quality = new Map<string, number>()
  const accepted = new Map<string, boolean>()
  const contexts = new Map<string, readonly string[]>()
  const calls: { revision: RevisionRef; operationId: string }[] = []
  const environments = createEnvironmentCommands({ store, registry })
  async function revision(id: string, assets: typeof initial, passed: number, met = passed === 1,
  ): Promise<RevisionRef> {
    await environments.createRevision({ commandId: `revision:${id}`, environmentId: 'methods', revisionId: id, manifest: assets,
    })
    methods.set(id, assets)
    quality.set(id, passed)
    accepted.set(id, met)
    return { environmentId: 'methods', revisionId: id, digest: digestOf(assets) }
  }
  // This solve double establishes real core Task/Run/Bubble facts; native execution and token
  // accounting are the host port's separate integration contract.
  async function solve({ revision, operationId, started,
  }: {
    revision: RevisionRef
    operationId: string
    started: (run: { taskId: string; runId: string }) => Promise<void> }): Promise<SolveResult> {
    calls.push({ revision, operationId })
    const taskId = `${operationId}:task`
    const runId = `${operationId}:run`
    const facts: readonly { readonly kind: string; readonly payload: unknown }[] = [
      { kind: TASK_KINDS.admitted, payload: { contract: {
            artifact: 'artifact.json',
            goal: 'count letters', template: { id: 'root', digest: 'c'.repeat(64) },
        inputs: [{ name: inputs[0]!.name, source: { kind: 'protected', ref: 'letters', digest: inputs[0]!.digest } },
            ],
            criteria: [{ criterionId: criterion.criterionId, statement: criterion.statement }],
          },
        },
      },
      { kind: TASK_KINDS.assigned, payload: { agentId: 'worker', agentIdentity: 'executor' } },
      { kind: TASK_KINDS.runStarted, payload: { purpose: 'solve', runId, revision } },
      { kind: TASK_KINDS.bubbleOpened, payload: { runId, inputs,
        model: { provider: 'test', model: 'fixture' }, tools: [{ name: 'node', version: '1', implementationDigest: 'd'.repeat(64) }],
        conditions: contexts.get(operationId) ?? ['frozen fixture'], workspace: { kind: 'dir', ref: `/tmp/${operationId}` },
      },
      },
    ]
    for (const [index, fact] of facts.entries())
      await store.emit({ commandId: `${operationId}:${index}`, protocol: TASK_PROTOCOL, version: TASK_VERSION, subject: taskId, ...fact,
      })
    await started({ taskId, runId })
    return { taskId, runId, quality: quality.get(revision.revisionId)!, met: accepted.get(revision.revisionId)!, cost: 100,
      artifactDigest: digestOf({ taskId }), inputDigests: inputs, implementationDigest: criterion.implementationDigest,
      acceptanceDigest: criterion.implementationDigest,
    }
  }
  const metric = { measured: { ...criterion, criterionId: 'correct:quality' }, unit: 'pass', direction: 'higher' as const,
  }
  const options = { store, registry, criterion, metric, trials: 1, weights: { quality: 1, cost: 0 }, calibration, loadMethod: async (ref: RevisionRef) => methods.get(ref.revisionId)!, baseline: solve, solve,
  }
  const evolution = createEvolution(options)
  return { store, registry, revision, evolution, calls, solve, contexts, options }
}

describe('method evolution', () => {
  it('records unknown native costs and completes evaluation without blocking later rounds', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 1)
    const candidate = await live.revision('unknown-cost', { ...initial, templates: [{ ...initial.templates[0]!, goal: 'stream letters' }, initial.templates[1]!] }, 1)
    const evolution = createEvolution({ ...live.options, solve: async request => ({ ...(await live.solve(request)), cost: null }) })
    expect((await evolution.runRound({ roundId: 'unknown-cost-1', round: 1, incumbent, candidates: [candidate] })).winner).toBeNull()
    expect((await evolution.runRound({ roundId: 'unknown-cost-2', round: 2, incumbent, candidates: [candidate] })).winner).toBeNull()
    expect(evolution.history()).toHaveLength(2)
  })

  it('selects an independently accepted cost-only improvement with positive cost weight', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 1)
    const candidate = await live.revision('cheaper', { ...initial, templates: [{ ...initial.templates[0]!, goal: 'stream letters' }, initial.templates[1]!] }, 1,
    )
    const evolution = createEvolution({ ...live.options, weights: { quality: 1, cost: 1 }, solve: async (request) => ({
        ...(await live.solve(request)), cost: request.revision.digest === candidate.digest ? 50 : 100,
    }),
    })
    expect((await evolution.runRound({ roundId: 'cost-only', round: 1, incumbent, candidates: [candidate] })).winner,
    ).toBe(0)
  })

  it('projects changed relationships and bindings without creating separate strategy edits per edge', () => {
    const baseline = { ...initial, templates: [{ ...initial.templates[0]!, skills: ['skill'], decomposition: {
      children: [{ key: 'part', template: 'part', dependsOn: [], supports: ['correct'], maxRuns: 1, requirement: 'required' as const }],
    },
        },
        initial.templates[1]!,
      ],
    }
    const candidate = { ...baseline, templates: [{ ...baseline.templates[0]!, skills: [], decomposition: {
      children: [{ key: 'part', template: 'part', dependsOn: ['earlier'], supports: ['correct'], maxRuns: 1, requirement: 'required' as const }],
    },
        },
        initial.templates[1]!,
      ],
    }
    expect(structuralEditsOf(baseline, candidate)).toEqual([{ asset: 'template', target: 'root' }])
    expect(structuralEditDetailsOf(baseline, candidate)).toEqual([{ asset: 'template', target: 'root',
      paths: ['decomposition.children[0].dependsOn[0]', 'skills[0]'] },
    ])
  })

  it('resumes an interrupted round without repeating committed trials', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision('good', { ...initial, tools: [{ name: 'tool', source: 'improved tool' }] }, 1)
    const input = { roundId: 'resumed', round: 1, incumbent, candidates: [good] }
    const interrupted = createEvolution({ ...live.options, solve: async (request) => {
      if (request.revision.revisionId === 'good') throw new Error('process stopped before candidate solve')
      return live.solve(request)
    },
    })
    await expect(interrupted.runRound(input)).rejects.toThrow('process stopped')
    expect(live.calls).toHaveLength(1)
    const result = await createEvolution(live.options).runRound(input)
    expect(result.winner).toBe(0)
    expect(live.calls.map((call) => call.revision.revisionId)).toEqual(['initial', 'good'])
    const count = live.store.load().entries().length
    expect(await createEvolution(live.options).runRound(input)).toEqual(result)
    expect(live.calls).toHaveLength(2)
    expect(live.store.load().entries()).toHaveLength(count)
  })

  it('counts actual template identities and the shared skill/tool content', () => {
    expect(structuralEditsOf(initial, {
      ...initial, templates: [{ id: 'root', goal: 'count exactly' }, { id: 'new', goal: 'new part' },
        ],
      skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'count twice' }], tools: [{ name: 'tool', source: 'export const count = input => [...input].length' }],
    }),
    ).toEqual([
      { asset: 'template', target: 'new' }, { asset: 'template', target: 'part' }, { asset: 'template', target: 'root' },
      { asset: 'skill', target: 'skill' }, { asset: 'tool', target: 'tool' },
    ])
    expect(structuralEditsOf(initial, { ...initial, templates: [...initial.templates].reverse() })).toEqual([])
  })

  it('compares each candidate with the frozen incumbent and reads closed history and reads frozen closed history', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision('good', { ...initial, skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'correct method' },
        ],
      },
      1,
    )
    const bad = await live.revision('bad', { ...initial, tools: [{ name: 'tool', source: 'broken method' }] }, 0)
    const first = await live.evolution.runRound({ roundId: 'r1', round: 1, incumbent, candidates: [good, bad] })
    expect(first.winner).toBe(0)
    expect(first.slots.map((slot) => slot.quality)).toEqual([1, 0])
    expect(first.outcomes[1]?.admitted).toBe(false)
    expect(live.calls.map((call) => call.revision.revisionId)).toEqual(['initial', 'good', 'bad'])
    const submitted = live.store.load().stateOf<RoundState>(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'r1')!.submissions
    expect(submitted.map((candidate) => ({ edits: candidate.edits }))).toEqual([
      { edits: [{ asset: 'skill', target: 'skill' }] },
      { edits: [{ asset: 'tool', target: 'tool' }] },
    ])

    const consumedHistory = live.evolution.history()
    expect(consumedHistory).toEqual([first])
    const next = await live.revision('next', { ...initial, skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'correct method' },
        ], tools: [{ name: 'tool', source: 'different method' }],
      },
      1,
    )
    const worse = await live.revision('worse', { ...initial, skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'incorrect method' },
        ],
      },
      0,
    )
    // The second proposal's incumbent and revisions are chosen from the committed first history.
    const previous = consumedHistory[0]!
    expect(previous.winner).toBe(0)
    const second = await live.evolution.runRound({ roundId: 'r2', round: 2, incumbent: good, candidates: [next, worse],
    })
    expect(second.winner).toBeNull()
    expect(live.calls).toHaveLength(6)

    const late = await live.solve({ revision: good, operationId: 'late', started: async () => undefined })
    const measure = createMeasureCommands({ store: live.store, registry: live.registry,
      implementations: [{ ref: criterion.verifierRef, version: criterion.verifierVersion, implementationDigest: criterion.implementationDigest,
        },
      ],
    })
    await measure.openEvaluation({ commandId: 'late:open', evaluationId: 'late', baseline: good, candidate: good,
      run: { taskId: late.taskId, runId: late.runId }, metric: { measured: { ...criterion, criterionId: 'correct:quality' }, unit: 'pass', direction: 'higher' }, weights: { quality: 1, cost: 0 }, trials: 1, judgement: [criterion],
    })
    await measure.recordTrial({ commandId: 'late:trial', evaluationId: 'late', trial: { ...late, cost: late.cost!, slot: 0, quality: 0 },
    })
    expect(live.evolution.history()).toEqual([first, second])
    const reopened = createEvolution({ ...live.options, calibration: { floor: 999, source: 'declared' }, loadMethod: async () => initial, solve: live.solve,
    })
    expect(reopened.history()).toEqual([first, second])
    const decisions = live.store.load().entriesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION).filter((entry) => entry.kind === STRATEGY_KINDS.roundDecided)
    expect(decisions).toHaveLength(2)
    expect(live.store.load().statesOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION).size).toBe(7)
  })

  it('freezes two independent area trials before execution and rejects a faster invalid implementation', async () => {
    const live = await fixture()
    const incumbent = await live.revision('baseline', initial, 1, true)
    const smaller = await live.revision('smaller', { ...initial, skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'optimize the schedule',
          },
        ],
      },
      0.95,
      true,
    )
    const invalid = await live.revision('invalid', { ...initial, tools: [{ name: 'tool', source: 'drops schedule words' }] }, 0.5, false,
    )
    const evolution = createEvolution({ ...live.options, trials: 2,
      metric: { ...live.options.metric, unit: 'baseline area ratio', direction: 'lower' },
      calibration: { floor: 0.01, source: 'declared' }, weights: { quality: 100, cost: 15 },
    })
    const round = await evolution.runRound({ roundId: 'area', round: 1, incumbent, candidates: [smaller, invalid] })
    expect(round.winner).toBe(0)
    expect(round.slots.map((slot) => [slot.quality, slot.denominator, slot.constraintsMet])).toEqual([[0.95, 2, true], [0.5, 2, false],
    ])
    expect(live.calls).toHaveLength(6)
    const candidate = live.store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'area:0:candidate:evaluation')!
    expect(candidate.observed.map((trial) => JSON.parse(trial.detail!))).toEqual([
      expect.objectContaining({ taskId: 'area:0:candidate:trial:0:task' }),
      expect.objectContaining({ taskId: 'area:0:candidate:trial:1:task' }),
    ])
  })

  it('accepts one candidate and rejects an empty comparison', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const candidate = await live.revision('candidate', { ...initial, skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'new' }],
      },
      1,
    )
    await expect(live.evolution.runRound({ roundId: 'empty', round: 1, incumbent, candidates: [] })).rejects.toThrow('at least one',
    )
    const result = await live.evolution.runRound({ roundId: 'r1', round: 1, incumbent, candidates: [candidate] })
    expect(result.winner).toBe(0)
  })

  it.each([1, 2])('excludes changed candidate contexts for %i candidates without failing or retrying the round', async (count) => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const candidates = []
    for (let slot = 0; slot < count; slot++) {
      candidates.push(await live.revision(`changed-${slot}`, { ...initial, tools: [{ name: 'tool', source: `changed ${slot}` }] }, 1))
      live.contexts.set(`excluded:${slot}:candidate:trial:0`, [`other conditions ${slot}`])
    }
    const request = { roundId: 'excluded', round: 1, incumbent, candidates }
    const result = await live.evolution.runRound(request)
    expect(result.decided).toBe(true)
    expect(result.winner).toBeNull()
    expect(result.outcomes).toHaveLength(count)
    expect(result.outcomes.every(outcome => !outcome.admitted && outcome.reason.includes('conditions'))).toBe(true)
    const calls = live.calls.length
    expect(await live.evolution.runRound(request)).toEqual(result)
    expect(live.calls).toHaveLength(calls)
  })

  it('excludes a changed candidate context without losing other candidates, but propagates unexpected solve failures', async () => {
    const live = await fixture()
    const incumbent = await live.revision('initial', initial, 0)
    const good = await live.revision('good', { ...initial, skills: [{ name: 'skill', description: 'method', capabilities: [], requiredTools: [], content: 'correct method' },
        ],
      },
      1,
    )
    const bad = await live.revision('bad', { ...initial, tools: [{ name: 'tool', source: 'another method' }] }, 1)
    live.contexts.set('r1:0:candidate:trial:0', ['changed dataset conditions'])
    const result = await live.evolution.runRound({ roundId: 'r1', round: 1, incumbent, candidates: [good, bad] })
    expect(result.winner).toBe(1)
    expect(result.slots[0]).toMatchObject({ admissible: false, reason: expect.stringContaining('changed dataset conditions') })
    expect(result.slots[0]!.reason).toContain('conditions')
    expect(result.slots[1]!.admissible).toBe(true)
    expect(live.calls.map(call => call.revision.revisionId)).toEqual(['initial', 'good', 'bad'])
    const count = live.store.load().entries().length
    expect(await live.evolution.runRound({ roundId: 'r1', round: 1, incumbent, candidates: [good, bad] })).toEqual(result)
    expect(live.store.load().entries()).toHaveLength(count)
    const failed = createEvolution({ ...live.options, solve: async () => { throw new Error('native agent failed') },
    })
    await expect(failed.runRound({ roundId: 'r2', round: 2, incumbent, candidates: [good, bad] })).rejects.toThrow('native agent failed',
    )
    expect(live.evolution.history()).toEqual([result])
  })
})
