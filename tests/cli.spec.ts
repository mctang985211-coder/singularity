import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { digestOf } from '../src/protocol/envelope.ts'

const { connectHost, submitTask, runExperiment, cleanError, taskReport, waitForTask } = await import(
  fileURLToPath(new URL('../scripts/singularity.mjs', import.meta.url))
)
const { hostInstall, hostFindings } = await import(
  fileURLToPath(new URL('../scripts/host-config.mjs', import.meta.url))
)
let server: Server | undefined
afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(done => server!.close(() => done()))
    server = undefined
  }
})

it('exchanges the native launch token once and reuses the authenticated cookie for native commands', async () => {
  const seen: string[] = []
  server = createServer(async (request, response) => {
    seen.push(request.url!)
    if (request.url === '/?token=private-launch') {
      response.writeHead(303, { 'set-cookie': ['dsh-auth=private-cookie; HttpOnly; SameSite=Strict'], location: './' })
      response.end()
      return
    }
    if (request.headers.cookie !== 'dsh-auth=private-cookie') {
      response.writeHead(401)
      response.end()
      return
    }
    if (request.url === '/singularity/tasks') {
      response.end(JSON.stringify({ formatVersion: 15, tasks: [] }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const command = JSON.parse(Buffer.concat(chunks).toString())
    if (command.method === 'session/modelCatalog') {
      expect(command.payload.args).toEqual({})
      response.end(JSON.stringify({ result: { ok: true, value: { routableProviders: ['test'] } } }))
      return
    }
    if (request.url === '/singularity/cancel') {
      expect(command).toEqual({ sessionId: 'stable-session' })
      response.end(JSON.stringify({ accepted: true }))
      return
    }
    expect(command.type).toBe('client-request')
    expect(command.method).toBe('session/create')
    response.end(JSON.stringify({ result: { ok: true, value: { sessionId: command.payload.args.request.sessionId } } }))
  })
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done))
  const address = server.address() as { port: number }
  const host = await connectHost({ url: `http://127.0.0.1:${address.port}`, token: 'private-launch' })
  expect(await host.rpc('session/modelCatalog')).toEqual({ routableProviders: ['test'] })
  expect(await host.rpc('session/create', { sessionId: 'stable-session' })).toEqual({ sessionId: 'stable-session' })
  expect(await host.snapshot()).toEqual({ formatVersion: 15, tasks: [] })
  expect(await host.cancel({ sessionId: 'stable-session' })).toEqual({ accepted: true })
  expect(seen).toEqual([
    '/?token=private-launch',
    '/api/session/modelCatalog',
    '/api/session/create',
    '/singularity/tasks',
    '/singularity/cancel',
  ])
})

it.each([401, 403])('surfaces HTTP %s once and removes sensitive server details', async status => {
  let calls = 0
  const host = await connectHost({
    cookie: 'private-cookie',
    fetcher: async () => {
      calls++
      return new Response('private-cookie authorization: Bearer ABC api_key="DEF" ?token=GHI', { status })
    },
  })
  await expect(host.snapshot()).rejects.toThrow(`HTTP ${status}`)
  expect(calls).toBe(1)
  const scrubbed = cleanError(
    'private-cookie authorization: Bearer ABC api_key="DEF" ?token=GHI {"authorization":"Bearer JKL","token":"MNO"}',
    ['private-cookie'],
  )
  for (const secret of ['private-cookie', 'ABC', 'DEF', 'GHI', 'JKL', 'MNO']) expect(scrubbed).not.toContain(secret)
})

it('redelivers the same session/prompt identities without an independent campaign state file', async () => {
  const sessions = new Set(),
    prompts = new Set(),
    commands: unknown[] = []
  const host = {
    rpc: async (method: string, input: { sessionId: string; requestId?: string }) => {
      commands.push({ method, input })
      if (method === 'session/create') {
        sessions.add(input.sessionId)
        return { sessionId: input.sessionId }
      }
      prompts.add(input.requestId)
      return { accepted: true }
    },
  }
  const first = await submitTask(host, 'Deliver one result.', { requestId: 'frozen-request', cwd: '/tmp' })
  expect(await submitTask(host, 'Deliver one result.', { requestId: 'frozen-request', cwd: '/tmp' })).toEqual(first)
  expect(sessions.size).toBe(1)
  expect(prompts.size).toBe(1)
  expect(commands).toHaveLength(4)
})

it('refuses a missing or differently built private host with an actionable setup instruction', () => {
  expect(() => hostInstall('/absent-checkout', '/absent-private-host')).toThrow('pnpm setup:host')
  const findings = hostFindings(hostInstall(), {
    packages: [],
    artifacts: { 'dsh-session/lib/index.js': '0'.repeat(64) },
  })
  expect(findings).toEqual(['dsh-session/lib/index.js: private host patch/build digest differs from dsh-baseline.json'])
})

it('does not prompt or mint a replacement session when native adoption reports a cwd conflict', async () => {
  const calls: string[] = []
  const host = {
    rpc: async (method: string) => {
      calls.push(method)
      throw new Error('session/conflict: requestedCwd differs from existingCwd')
    },
  }
  await expect(submitTask(host, 'same task', { requestId: 'existing', cwd: '/different-cwd' })).rejects.toThrow(
    'session/conflict',
  )
  expect(calls).toEqual(['session/create'])
})

it('requires the configured frozen suite and sends only an evolve contract to native admission', async () => {
  const contract = {
    goal: 'one evolve task',
    artifact: 'result.txt',
    inputs: [],
    criteria: [{ criterionId: 'correct', statement: 'deliver the requested result' }],
  }
  const suite = {
    version: 1,
    suiteId: 'frozen',
    failureQuality: 0,
    cases: [
      { caseId: 'e', familyId: 'a', sourceId: 'a', split: 'evolve', weight: 1, trials: 3, contract, hardGuards: [] },
      {
        caseId: 'v',
        familyId: 'b',
        sourceId: 'b',
        split: 'validation',
        weight: 1,
        trials: 3,
        contract: { ...contract, goal: 'secret unseen problem' },
        hardGuards: [],
      },
    ],
  }
  const requests: { method: string; input: { sessionId: string; content?: unknown } }[] = []
  const host = {
    snapshot: async () => ({ suiteDigest: digestOf(suite) }),
    rpc: async (method: string, input: { sessionId: string; content?: unknown }) => {
      requests.push({ method, input })
      return { sessionId: input.sessionId }
    },
  }
  const result = await runExperiment(host, suite, { requestId: 'experiment' })
  expect(result.expectedEvolveTrials).toBe(3)
  expect(JSON.stringify(requests)).not.toContain('secret unseen problem')
  expect(requests.at(-1)?.input.content).toEqual([{ type: 'text', text: JSON.stringify({ contract, learning: true }) }])
  const count = requests.length
  await expect(runExperiment({ ...host, snapshot: async () => ({ suiteDigest: 'wrong' }) }, suite)).rejects.toThrow(
    'Suite differs',
  )
  expect(requests).toHaveLength(count)
})

it('exports the committed campaign terminal reason with its suite and measurement evidence', () => {
  const task = { taskId: 'root', sessionId: 'session', purpose: 'solve', closure: { reason: 'accepted' } }
  const improve = {
    taskId: 'campaign',
    purpose: 'improve',
    relatedTo: { taskId: 'root' },
    search: { outcome: 'no-improvement' },
  }
  const snapshot = {
    controlId: 'control',
    cutoff: 42,
    suiteDigest: 'frozen-suite',
    tasks: [task, improve],
    plans: [],
    rounds: [{ plan: { campaignId: 'campaign' }, evaluations: ['raw-measurement'] }],
    reviews: [],
    consumption: [],
    releases: [],
    methods: [],
  }
  const report = taskReport(snapshot, 'session')
  expect(report.suiteDigest).toBe('frozen-suite')
  expect(report.campaigns).toEqual([
    { campaignId: 'campaign', closure: undefined, search: { outcome: 'no-improvement' } },
  ])
  expect(report.rounds[0].evaluations).toEqual(['raw-measurement'])
})

it('exports validation, heldout, descendant trials and their review evidence with the campaign', () => {
  const root = { taskId: 'root', sessionId: 'session', purpose: 'solve' }
  const campaign = {
    taskId: 'campaign',
    purpose: 'improve',
    relatedTo: { taskId: 'root' },
    transfer: { roundId: 'campaign:validation' },
    transferReport: { paired: { status: 'improved' }, heldout: { status: 'no-improvement' } },
    search: { batches: [{ outcomes: [{ revision: { environmentId: 'methods', revisionId: 'critic-rejected' } }] }] },
  }
  const trial = { taskId: 'trial', purpose: 'evaluation', relatedTo: { taskId: 'campaign' } }
  const snapshot = {
    controlId: 'control',
    cutoff: 42,
    suiteDigest: 'frozen',
    tasks: [root, campaign, trial, { taskId: 'child', purpose: 'evaluation' }],
    plans: [{ parentTaskId: 'trial', children: [{ taskId: 'child' }] }],
    rounds: ['campaign', 'campaign:validation', 'campaign:heldout', 'unrelated'].map(id => ({
      plan: { campaignId: id },
      submissions: [{ revision: { environmentId: 'methods', revisionId: id } }],
      evaluations: [{ state: { observed: ['raw'] } }],
    })),
    reviews: [
      { target: { taskId: 'child' } },
      { target: { kind: 'proposal', environmentId: 'methods', revisionId: 'campaign' } },
      { target: { kind: 'publication', environmentId: 'methods', revisionId: 'campaign' } },
      { target: { kind: 'proposal', environmentId: 'methods', revisionId: 'critic-rejected' } },
      { target: { kind: 'publication', environmentId: 'methods', revisionId: 'unrelated' } },
    ],
    consumption: [{ taskId: 'child' }],
    releases: [],
    methods: [],
  }
  const report = taskReport(snapshot, 'session')
  expect(report.tasks.map((item: { taskId: string }) => item.taskId)).toEqual(['root', 'campaign', 'trial', 'child'])
  expect(report.tasks[1].transferReport).toEqual(campaign.transferReport)
  expect(report.rounds.map((round: { plan: { campaignId: string } }) => round.plan.campaignId)).toEqual([
    'campaign',
    'campaign:validation',
    'campaign:heldout',
  ])
  expect(report.evidence).toEqual({ reviews: snapshot.reviews.slice(0, 4), consumption: snapshot.consumption })
})

it.each(['cancelled', 'learning-off'])(
  'finishes --wait-learning for %s without waiting for an RSI that will never start',
  async mode => {
    let polls = 0
    const task = {
      taskId: 'root',
      sessionId: 'session',
      purpose: 'solve',
      rsi: null,
      learning: mode !== 'learning-off',
      closure: { reason: mode === 'cancelled' ? 'cancelled' : 'accepted' },
    }
    const snapshot = {
      controlId: 'control',
      cutoff: 42,
      suiteDigest: null,
      tasks: [task],
      plans: [],
      rounds: [],
      reviews: [],
      consumption: [],
      releases: [],
      methods: [],
    }
    const report = await waitForTask(
      {
        snapshot: async () => {
          polls++
          return snapshot
        },
      },
      'session',
      { learning: true, signal: AbortSignal.timeout(100) },
    )
    expect(report.task).toEqual(task)
    expect(polls).toBe(1)
  },
)
