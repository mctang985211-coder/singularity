/**
 * The stage-C review channel: what a person is shown when a batch waits for a
 * review (§5's display list, rendered from the saved proposal), who is asked,
 * and how a human answer becomes a recorded decision. The channel is the only
 * writer of a decision in this deployment, so these tests are about its
 * boundaries as much as about its rendering: nobody is asked when there is no
 * owner session to ask, a non-approval answer records nothing, and `decidedBy`
 * is the channel's own identity — never a value a model could hand in.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Obligation, TaskContract, TaskInstance, TaskProposal, TaskProposalRoot } from '@dangosys/dsh-singularity-task'
import type { NormalizedBatch } from '../../../task-runtime/src/normalize.ts'
import type { ProposalReviewRequest, RootContractReviewRequest } from '../../../task-runtime/src/index.ts'
import { ProposalReviewService, ownerSessionOfStore, renderProposalReview } from '../../src/proposal-review.ts'

const OWNER = 'root-1'
const STORE = `sg-t-${OWNER}`

function criterion(overrides: Partial<TaskContract['acceptanceCriteria'][number]> = {}) {
  return {
    criterionId: 'ac1-1',
    description: 'the parser parses every fixture',
    verificationMode: 'deterministic' as const,
    requiredEvidence: [],
    mandatory: true,
    command: 'pnpm test parser',
    ...overrides,
  }
}

function contract(objective: string, overrides: Partial<TaskContract> = {}): TaskContract {
  return {
    contractVersion: 1,
    objective,
    acceptanceCriteria: [criterion()],
    assumptions: [],
    constraints: [],
    requiredCapabilities: [],
    ...overrides,
  }
}

/** The two-child batch every rendering test reads: one deterministic child, one heuristic child that depends on it. */
function batch(): NormalizedBatch['children'] {
  return [
    {
      contract: contract('Implement the parser', {
        assumptions: ['the fixture corpus stays readable'],
        constraints: ['no network access', 'write only inside the checkout'],
        requiredCapabilities: ['design-ball'],
      }),
      dependsOn: [],
      decomposable: false,
      requiresIndependentAcceptance: false,
    },
    {
      contract: contract('Judge the parser', {
        acceptanceCriteria: [
          criterion({ criterionId: 'ac2-1', description: 'the parser looks right', verificationMode: 'review', heuristic: true, command: undefined }),
        ],
        requiredCapabilities: ['fly-to-moon'],
      }),
      dependsOn: [0],
      decomposable: false,
      requiresIndependentAcceptance: true,
    },
  ]
}

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  const children = batch()
  return {
    proposalId: 'p-0123456789abcdef',
    requestKey: 'rk-abcdef',
    status: 'pending_review',
    policy: 'all',
    identity: {
      contractVersion: 1,
      storeId: STORE,
      parentTaskId: 't-root',
      parentRunId: 'r-root',
      callerSessionId: OWNER,
      reason: 'split the release work',
      children: [
        { contractDigest: '1'.repeat(64), dependsOn: [], decomposable: false, requiresIndependentAcceptance: false },
        { contractDigest: '2'.repeat(64), dependsOn: [0], decomposable: false, requiresIndependentAcceptance: true },
      ],
    },
    batch: children,
    proposalDigest: 'd'.repeat(64),
    admissionContext: { maxDepth: 2, maxChildren: 4, wallTimeMs: 600_000, auditOnly: { maxToolCalls: 40, attempts: 1 } },
    admissionContextDigest: 'e'.repeat(64),
    reviewContext: { capabilityManifestDigest: 'f'.repeat(64), verifiers: [{ verifierId: 'command' }] },
    reviewContextDigest: 'a'.repeat(64),
    createdAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

const parentTask: TaskInstance = {
  taskId: 't-root',
  definitionRef: { taskType: 'root', version: 1 },
  objective: 'ship the release',
  depth: 0,
  acceptanceCriteria: [
    {
      criterionId: 'root-children-verified',
      description: 'every mandatory child is verified',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
    },
  ],
  requestedCapabilities: [],
  decompositionStatus: 'decomposable',
  status: 'running',
  runIds: ['r-root'],
  childTaskIds: [],
}

const obligations: Obligation[] = [
  {
    obligationId: 'o-1',
    goal: 'capability "fly-to-moon" required by child 1 ("Judge the parser") is not granted by the registry',
    criterion: 'capability "fly-to-moon" resolves in the capability registry',
    sourceTaskId: 't-root',
  },
]

function reviewRequest(overrides: Partial<ProposalReviewRequest> = {}): ProposalReviewRequest {
  const stored = proposal()
  return {
    storeId: STORE,
    trigger: 'submitted',
    proposal: stored,
    parentTask,
    batch: { contractVersion: 1, reason: 'split the release work', children: [...stored.batch] },
    manifests: [
      { capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['read', 'write'] } }, missing: [], closure: 'closed' },
      { capabilities: {}, missing: ['fly-to-moon'], closure: 'gap' },
    ],
    registeredVerifiers: ['command', 'review'],
    obligations,
    ...overrides,
  }
}

describe('renderProposalReview (§5 display list)', () => {
  const text = renderProposalReview(reviewRequest())

  it('names the proposal, where it stands, its policy and both context fingerprints in full', () => {
    expect(text).toContain('p-0123456789abcdef')
    expect(text).toContain('pending_review')
    expect(text).toContain('policy all')
    expect(text).toContain('trigger: submitted')
    // The fingerprints are printed whole: a truncated digest cannot be compared
    // with the record a decision binds.
    expect(text).toContain('d'.repeat(64))
    expect(text).toContain('e'.repeat(64))
    expect(text).toContain('a'.repeat(64))
    expect(text).toContain('f'.repeat(64))
    expect(text).toContain('rk-abcdef')
  })

  it('shows the parent objective and its acceptance criteria', () => {
    expect(text).toContain('ship the release')
    expect(text).toContain('root-children-verified')
    expect(text).toContain('every mandatory child is verified')
  })

  it('walks every child: objective, criteria, assumptions, constraints and dependencies', () => {
    expect(text).toContain('Implement the parser')
    expect(text).toContain('Judge the parser')
    expect(text).toContain('ac1-1')
    expect(text).toContain('ac2-1')
    expect(text).toContain('the parser parses every fixture')
    expect(text).toContain('the parser looks right')
    expect(text).toContain('the fixture corpus stays readable')
    expect(text).toContain('no network access')
    expect(text).toContain('write only inside the checkout')
    // A dependency is listed as the sibling it waits for, not as a bare index.
    expect(text).toContain('depends on:')
    expect(text).toContain('child 0 (Implement the parser)')
    expect(text).toContain('1'.repeat(64))
    expect(text).toContain('2'.repeat(64))
  })

  it('marks a heuristic criterion as such and keeps the deterministic one unmarked', () => {
    expect(text).toContain('heuristic')
    expect(text).toMatch(/ac1-1 \[deterministic, mandatory\]/)
    expect(text).toMatch(/ac2-1 \[review[^\]]*heuristic/)
  })

  it('resolves every declared capability, naming the gap a missing one leaves', () => {
    expect(text).toContain('design-ball')
    expect(text).toContain('ball-align')
    expect(text).toContain('fly-to-moon')
    expect(text).toContain('NOT GRANTED')
  })

  it('states the limits the batch is admitted under, and which of them are audited only', () => {
    expect(text).toContain('maxDepth 2')
    expect(text).toContain('maxChildren 4')
    expect(text).toContain('600000')
    expect(text).toContain('audited after the run')
    expect(text).toContain('40')
  })

  it('names the obligations the parent carries, read from the store', () => {
    expect(text).toContain('o-1')
    expect(text).toContain('fly-to-moon')
    expect(text).toContain('not granted by the registry')
  })

  it('says what the deployment cannot pin: manifest names are not bytes, and a verifier id carries no version', () => {
    expect(text).toContain('command')
    expect(text).toContain('registered verifiers now: command, review')
    expect(text.toLowerCase()).toContain('not the bytes')
  })

  it('renders every child of a batch that is at the batch limit, never a truncated summary', () => {
    const stored = proposal()
    const many = Array.from({ length: 8 }, (_, index) => ({
      contract: contract(`child ${index} objective`, {
        acceptanceCriteria: [criterion({ criterionId: `ac-${index}`, description: `criterion ${index}` })],
      }),
      dependsOn: [],
      decomposable: false,
      requiresIndependentAcceptance: false,
    }))
    const request = reviewRequest({
      proposal: { ...stored, batch: many },
      batch: { contractVersion: 1, reason: 'split the release work', children: many },
      manifests: many.map(() => ({ capabilities: {}, missing: [], closure: 'closed' as const })),
    })
    const rendered = renderProposalReview(request)
    for (let index = 0; index < many.length; index++) {
      expect(rendered).toContain(`child ${index} objective`)
      expect(rendered).toContain(`criterion ${index}`)
    }
  })
})

describe('ownerSessionOfStore', () => {
  it('reads the owner session off a store id and answers nothing for a foreign id', () => {
    expect(ownerSessionOfStore(STORE)).toBe(OWNER)
    expect(ownerSessionOfStore('some-other-store')).toBeUndefined()
  })
})

/** A deferred the tests resolve when the human answers. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fixture(options: { outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'; ownerLive?: boolean; policy?: 'ask' | 'never' | undefined } = {}) {
  const answered = deferred<string>()
  const approval = {
    request: vi.fn(async () => await answered.promise),
    overrideOf: vi.fn(() => options.policy),
    config: { policy: 'ask' as const },
  }
  const ownerAgent = { id: OWNER, session: { header: { id: OWNER } } }
  const decideProposal = vi.fn(async () => ({ proposalId: 'p-0123456789abcdef', outcome: 'approved', status: 'ready', detail: 'recorded' }))
  const disposers: (() => unknown)[] = []
  const services: Record<string, unknown> = options.ownerLive === false ? {} : { agents: { get: (id: string) => (id === OWNER ? ownerAgent : undefined) } }
  const ctx = {
    reflect: { provide: () => {} },
    effect: (callback: () => () => unknown) => { disposers.push(callback()) },
    get: (name: string) => services[name],
    approval,
    taskRuntime: { decideProposal },
  }
  return {
    ctx: ctx as never,
    approval,
    decideProposal,
    ownerAgent,
    answered,
    disposers,
    setOutcome: (outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable') => answered.resolve(outcome),
    setPolicy: (policy: 'ask' | 'never' | undefined) => { approval.overrideOf.mockReturnValue(policy) },
    setOwnerLive: (live: boolean) => { if (live) services.agents = { get: (id: string) => (id === OWNER ? ownerAgent : undefined) }; else delete services.agents },
  }
}

describe('ProposalReviewService.requestReview', () => {
  it('asks the owner session of the store, carrying the whole batch in the reason', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    const notice = await service.requestReview(reviewRequest())

    expect(notice.requested).toBe(true)
    expect(notice.detail).toContain(OWNER)
    expect(h.approval.request).toHaveBeenCalledTimes(1)
    const ask = h.approval.request.mock.calls[0]![0] as unknown as { agent: unknown; reason: string; toolName: string }
    expect(ask.agent).toBe(h.ownerAgent)
    expect(ask.toolName).toBe('task_decompose')
    // What a person reads is the rendered dossier, children included.
    expect(ask.reason).toContain('Implement the parser')
    expect(ask.reason).toContain('Judge the parser')
    expect(ask.reason).toContain('ship the release')
  })

  it('records an approval through decideProposal, under the channel\'s own decider identity', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    await service.requestReview(reviewRequest())

    h.setOutcome('allowed-once')
    await vi.waitFor(() => expect(h.decideProposal).toHaveBeenCalledTimes(1))
    expect(h.decideProposal).toHaveBeenCalledExactlyOnceWith(
      STORE,
      'p-0123456789abcdef',
      { outcome: 'approved' },
      `approval:${OWNER}`,
    )
  })

  it('records a refusal as rejected, with the reason the channel can honestly state, and never as an approval', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    await service.requestReview(reviewRequest())

    h.setOutcome('rejected')
    await vi.waitFor(() => expect(h.decideProposal).toHaveBeenCalledTimes(1))
    const [storeId, proposalId, decision, decidedBy] = h.decideProposal.mock.calls[0]! as unknown as [string, string, { outcome: string; reason?: string }, string]
    expect(storeId).toBe(STORE)
    expect(proposalId).toBe('p-0123456789abcdef')
    expect(decision.outcome).toBe('rejected')
    expect(decision.reason).toBeTruthy()
    expect(decidedBy).toBe(`approval:${OWNER}`)
  })

  it('records nothing when no answerer was available: the proposal stays where the store holds it', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    await service.requestReview(reviewRequest())

    h.setOutcome('unavailable')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.decideProposal).not.toHaveBeenCalled()
  })

  it('records nothing when the ask was withdrawn before anyone decided', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    await service.requestReview(reviewRequest())

    h.setOutcome('cancelled')
    await Promise.resolve()
    await Promise.resolve()
    expect(h.decideProposal).not.toHaveBeenCalled()
  })

  it('asks nobody when the owner session has no live agent', async () => {
    const h = fixture({ ownerLive: false })
    const service = new ProposalReviewService(h.ctx)
    const notice = await service.requestReview(reviewRequest())

    expect(notice.requested).toBe(false)
    expect(notice.detail).toContain(OWNER)
    expect(h.approval.request).not.toHaveBeenCalled()
    expect(h.decideProposal).not.toHaveBeenCalled()
  })

  it('refuses to pretend when the owner session never asks a person', async () => {
    const h = fixture({ policy: 'never' })
    const service = new ProposalReviewService(h.ctx)
    const notice = await service.requestReview(reviewRequest())

    // A 'never' policy auto-rejects before any answerer sees the ask, so a request
    // there would be a rejection nobody made — the channel asks nobody instead.
    expect(notice.requested).toBe(false)
    expect(notice.detail).toContain('never')
    expect(h.approval.request).not.toHaveBeenCalled()
    expect(h.decideProposal).not.toHaveBeenCalled()
  })

  it('asks nobody for a store id that names no owner session', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    const notice = await service.requestReview(reviewRequest({ storeId: 'foreign-store' }))

    expect(notice.requested).toBe(false)
    expect(notice.detail).toContain('foreign-store')
    expect(h.approval.request).not.toHaveBeenCalled()
  })

  it('reports a channel that could not even ask, instead of claiming a person was asked', async () => {
    const h = fixture()
    h.approval.request.mockRejectedValueOnce(new Error('approval.request() outside an open turn'))
    const service = new ProposalReviewService(h.ctx)
    const notice = await service.requestReview(reviewRequest())

    // An ask the approval seam refuses before it reaches an answerer (no open
    // turn, a session that is gone) is nobody being asked: the notice says so
    // and no decision is written.
    expect(notice.requested).toBe(false)
    expect(notice.detail).toContain('outside an open turn')
    expect(notice.detail).toContain('pending_review')
    expect(h.decideProposal).not.toHaveBeenCalled()
  })

  it('mounts on a real cordis context and is what the runtime resolves as ctx.proposalReviewChannel', async () => {
    // The seam the service assembly depends on: the runtime resolves the channel
    // softly by name (`optionalService(ctx, 'proposalReviewChannel')`), so what
    // matters is that a real context hands back this service from a sibling's
    // `ctx.get` — not that the fake context of the tests above does.
    const root = new Context()
    const asked: { agent: unknown; toolName: string; reason: string }[] = []
    const decided: unknown[][] = []
    await root.plugin((ctx: Context) => {
      ctx.provide('approval', {
        request: async (request: { agent: unknown; toolName: string; reason: string }) => {
          asked.push(request)
          return 'allowed-once'
        },
        overrideOf: () => undefined,
        config: { policy: 'ask' },
      })
      ctx.provide('agents', { get: (id: string) => (id === OWNER ? { id: OWNER, session: { header: { id: OWNER } } } : undefined) })
      ctx.provide('taskRuntime', {
        decideProposal: async (...args: unknown[]) => {
          decided.push(args)
          return { detail: 'recorded' }
        },
      })
      new ProposalReviewService(ctx)
    })

    const channel = root.get('proposalReviewChannel') as ProposalReviewService | undefined
    expect(typeof channel?.requestReview).toBe('function')
    const notice = await channel!.requestReview(reviewRequest())
    expect(notice.requested).toBe(true)
    await vi.waitFor(() => expect(decided).toHaveLength(1))
    expect(asked[0]!.toolName).toBe('task_decompose')
    expect(asked[0]!.reason).toContain('Implement the parser')
    expect(decided[0]![3]).toBe(`approval:${OWNER}`)
    await root.fiber.dispose()
  })

  it('withdraws a pending ask when the service is disposed', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    await service.requestReview(reviewRequest())

    const ask = h.approval.request.mock.calls[0]![0] as unknown as { signal?: AbortSignal }
    expect(ask.signal).toBeDefined()
    expect(ask.signal?.aborted).toBe(false)
    for (const dispose of h.disposers) dispose()
    expect(ask.signal?.aborted).toBe(true)
  })
})

/**
 * The same channel for the other kind of proposal (A0 §3 stage C): a root
 * contract has no parent task and no children, so its review has to render the
 * contract the root session would be admitted as — objective, every criterion
 * with its markings, assumptions, constraints, declared capabilities with their
 * resolution, the limits, the digests — and no parent section at all. Before
 * this, a root request reached a renderer that read `parentTask` off it and
 * threw, which the runtime recorded as "the review channel failed": the
 * contract stayed `pending_review` with nobody asked.
 */
function rootContractValue(): TaskContract {
  return {
    contractVersion: 1,
    objective: 'ship the release to the customer',
    acceptanceCriteria: [
      criterion({
        criterionId: 'ac-1',
        description: 'the release artifact is published',
        protectedInputs: [{ path: 'release/check.sh', sha256: 'b'.repeat(64) }],
      }),
      criterion({
        criterionId: 'ac-2',
        description: 'the changelog reads honestly',
        verificationMode: 'review',
        heuristic: true,
        command: undefined,
      }),
      criterion({
        criterionId: 'ac-3',
        description: 'every child of this goal is verified',
        verificationMode: 'composite',
        command: undefined,
      }),
    ],
    assumptions: ['the release branch stays frozen'],
    constraints: ['no network access'],
    requiredCapabilities: ['design-ball'],
  }
}

function rootProposal(overrides: Partial<TaskProposalRoot> = {}): TaskProposalRoot {
  const contract = rootContractValue()
  return {
    kind: 'root',
    proposalId: 'p-root-0123456789abcdef',
    requestKey: 'rk-root',
    status: 'pending_review',
    policy: 'all',
    identity: { contractVersion: 1, storeId: STORE, rootSessionId: OWNER, requestKey: 'rk-root', contractDigest: 'c'.repeat(64) },
    contract,
    proposalDigest: 'd'.repeat(64),
    admissionContext: { maxDepth: 2, maxChildren: 4, wallTimeMs: 600_000, auditOnly: { maxToolCalls: 40, attempts: 1 } },
    admissionContextDigest: 'e'.repeat(64),
    reviewContext: { capabilityManifestDigest: 'f'.repeat(64), verifiers: [{ verifierId: 'command' }] },
    reviewContextDigest: 'a'.repeat(64),
    createdAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

function rootReviewRequest(overrides: Partial<RootContractReviewRequest> = {}): RootContractReviewRequest {
  const proposal = rootProposal()
  return {
    kind: 'root',
    storeId: STORE,
    trigger: 'submitted',
    proposal,
    rootSessionId: OWNER,
    contract: proposal.contract,
    manifests: [
      { capabilities: { 'design-ball': { skills: ['ball-align'], tools: ['read', 'write'] } }, missing: [], closure: 'closed' },
    ],
    registeredVerifiers: ['command', 'review'],
    obligations: [],
    ...overrides,
  }
}

describe('renderProposalReview for a root contract', () => {
  const text = renderProposalReview(rootReviewRequest())

  it('names the subject, the session and both context fingerprints in full', () => {
    expect(text).toContain('Root contract review — proposal p-root-0123456789abcdef [pending_review] (policy all, trigger: submitted)')
    expect(text).toContain(`store: ${STORE}`)
    expect(text).toContain(`root session: ${OWNER}`)
    expect(text).toContain('d'.repeat(64))
    expect(text).toContain('e'.repeat(64))
    expect(text).toContain('a'.repeat(64))
    expect(text).toContain('rk-root')
  })

  it('renders the contract whole and invents no parent section', () => {
    expect(text).toContain('ship the release to the customer')
    expect(text).toContain('the release artifact is published')
    expect(text).toContain('the changelog reads honestly')
    expect(text).toContain('the release branch stays frozen')
    expect(text).toContain('no network access')
    expect(text).toContain('design-ball')
    expect(text).toContain('ball-align')
    expect(text).not.toContain('## Parent task')
    expect(text).not.toContain('## Children')
    // No parent task belongs to a contract that is not a task yet: the
    // decomposition arm prints `parent task <id> run <id>`, this one prints the
    // session it is the goal of and nothing above it.
    expect(text).not.toContain('parent task')
  })

  it('marks every criterion: mode, mandatory or optional, heuristic, protected inputs and command', () => {
    expect(text).toMatch(/ac-1 \[deterministic, mandatory\]/)
    expect(text).toMatch(/ac-2 \[review, mandatory[^\]]*heuristic/)
    expect(text).toMatch(/ac-3 \[composite, mandatory\]/)
    expect(text).toContain('release/check.sh sha256:' + 'b'.repeat(64))
  })

  it('shows the declared capabilities with the resolution this intake recorded', () => {
    expect(text).toContain('required capabilities:')
    expect(text).toContain('resolution (the manifests this batch resolved to):')
    expect(text).toContain('skills: ball-align')
  })

  it('states the limits, the digests a decision would bind, and what nothing here can promise', () => {
    expect(text).toContain('maxDepth 2')
    expect(text).toContain('wallTimeMs 600000')
    expect(text).toContain('audited after the run')
    expect(text).toContain("judging verifiers (the ids this contract's criteria pin): command")
    expect(text).toContain('registered verifiers now: command, review')
    // The two boundary statements §5 requires survive into this arm.
    expect(text).toContain('not the bytes')
    expect(text.toLowerCase()).toContain('cannot name the version')
  })

  it('says no root task exists while the decision waits', () => {
    expect(text).toContain('no root task, no run and no worker')
  })
})

describe('ProposalReviewService.requestReview for a root contract', () => {
  it('asks about the intake under its own tool name and records the decision as it does for a batch', async () => {
    const h = fixture()
    const service = new ProposalReviewService(h.ctx)
    const notice = await service.requestReview(rootReviewRequest())

    expect(notice.requested).toBe(true)
    expect(notice.detail).not.toContain('channel failed')
    const ask = h.approval.request.mock.calls[0]![0] as unknown as { agent: unknown; reason: string; toolName: string }
    expect(ask.agent).toBe(h.ownerAgent)
    expect(ask.toolName).toBe('task_intake')
    expect(ask.reason).toContain('Root contract review')
    expect(ask.reason).toContain('ship the release to the customer')

    h.setOutcome('allowed-once')
    await vi.waitFor(() => expect(h.decideProposal).toHaveBeenCalledTimes(1))
    // One decision path for both kinds: the channel's own identity, bound to the
    // proposal the contract was submitted as.
    expect(h.decideProposal).toHaveBeenCalledExactlyOnceWith(
      STORE,
      'p-root-0123456789abcdef',
      { outcome: 'approved' },
      `approval:${OWNER}`,
    )
  })

  it('never throws on a root request: an absent owner session stays a reported state', async () => {
    const h = fixture({ ownerLive: false })
    const service = new ProposalReviewService(h.ctx)
    const notice = await service.requestReview(rootReviewRequest())

    expect(notice.requested).toBe(false)
    expect(notice.detail).toContain(OWNER)
    expect(h.decideProposal).not.toHaveBeenCalled()
  })
})
