import { describe, expect, test } from 'vitest'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcceptanceCriterion } from '../../../task/src/index.ts'
import { pinSkillHome } from '../support/skill-roots.ts'
import type { Config } from '../../src/index.ts'
import { DEFAULT_VERIFY_TIMEOUT_MS } from '../../src/index.ts'
import {
  type Harness,
  createRoot,
  decomposeAndSettle,
  STORE,
  ROOT_SESSION,
  childSpec,
  harness,
  runEventKinds,
  createAcceptanceParent,
  settleRunNested,
} from './orchestrate.fixture.ts'

describe('TaskRuntime.replayTask (evolution replay, W15)', () => {
  /** One verified champion child, spawned with the given capability table. */
  async function champion(h: Harness, objective = 'champion work', overrides: Record<string, unknown> = {}) {
    const { taskId: rootTaskId, runId: rootRunId } = await createRoot(h)
    const outcomes = await decomposeAndSettle(h, STORE, rootTaskId, rootRunId, ROOT_SESSION, {
      reason: 'split the work',
      children: [childSpec(objective, { requiredCapabilities: ['research'], ...overrides })],
    })
    expect(outcomes[0]!.status).toBe('verified')
    return { championTaskId: outcomes[0]!.taskId, championRunId: outcomes[0]!.runId!, rootTaskId }
  }

  test('a capability override applies for the replay run only, and the replay task stands apart from the champion', async () => {
    pinSkillHome('verify')
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId, championRunId } = await champion(h)
    const before = await h.task.taskIn(STORE, championTaskId)

    const outcome = await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:p1',
        overlay: { capabilityOverrides: { research: { preset: 'other-preset', skills: ['verify'] } } },
      },
      ROOT_SESSION,
    )

    expect(outcome.status).toBe('verified')
    // the spawn saw the override row, not the configured one
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.agentPreset).toBe('other-preset')
    expect(spawn.grant!.capabilities).toEqual([{ capability: 'research', tools: [], skills: ['verify'] }])
    expect(spawn.grant!.keepPresetTools).toBe(true)

    // the replay task is parentless and tagged; the champion is untouched
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.parentTaskId).toBeUndefined()
    expect(replayTask.depth).toBe(0)
    expect(replayTask.objective).toBe('[evolution-replay:p1] champion work')
    expect(replayTask.status).toBe('verified')
    const after = await h.task.taskIn(STORE, championTaskId)
    expect(after).toEqual(before)

    // execution lineage: the replay run descends from the champion run
    const replayRun = await h.task.runIn(STORE, outcome.runId)
    expect(replayRun.parentRunId).toBe(championRunId)
    expect(replayRun.agentPreset).toBe('other-preset')
    expect(replayRun.capabilitySnapshot).toContain('verify')

    // the replay run's review record carries the lineage tag
    const snapshot = await h.task.snapshotIn(STORE)
    const record = snapshot.reviews.find(item => item.runId === outcome.runId)
    expect(record).toBeDefined()
    expect(record!.outcome).toBe('verified')
    expect(record!.anomalies).toEqual(['evolution-replay:p1'])
    expect(record!.criteria).toHaveLength(1)
    // event walk matches any verified run's
    expect(runEventKinds(h, outcome.runId)).toEqual([
      'TaskStarted',
      'TaskVerifying',
      'EvidenceProduced',
      'TaskVerified',
      'ReviewRecorded',
    ])
  })

  test('extra skill roots are forwarded to the worker grant, and the prompt never invites a split', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:p2',
        overlay: { extraSkillRoots: ['/sandbox/p2/skills'] },
      },
      ROOT_SESSION,
    )
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.grant!.skillRoots).toContain('/sandbox/p2/skills')
    // the overlay did not change the capability resolution
    expect(spawn.agentPreset).toBe('standard')
    // A replay never invites a split (its projection carries no decomposition
    // guidance at all — `context/tests/unit/reads.spec.ts`, "a replay reads …"),
    // and the spawn request carries no prompt to invite one either: the replay
    // task's own objective, tagged `[evolution-replay:p2]`, is what the context
    // projection briefs it with, read from the store.
    expect(spawn.prompt).toBeUndefined()
    expect(spawn.taskWorker).toBe(true)
    const replay = (await h.task.snapshotIn(STORE)).tasks.find(task => task.objective.includes('[evolution-replay:p2]'))
    expect(replay?.objective).toContain('[evolution-replay:p2]')
  })

  test("a spawning replay binds its own content: the overlay root stays first and the run's snapshot follows it", async () => {
    const home = pinSkillHome('verify')
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    // The candidate skill a skill replay passes: a sandbox directory the overlay
    // root exposes, with no sidecar (loadable guidance for the row under test).
    const sandbox = join(home, 'sandbox', 'p3', 'skills')
    await mkdir(join(sandbox, 'verify'), { recursive: true })
    await writeFile(
      join(sandbox, 'verify', 'SKILL.md'),
      '---\nname: verify\ndescription: candidate verify\n---\n\nCANDIDATE BODY\n',
    )

    const outcome = await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:binding',
        overlay: {
          extraSkillRoots: [sandbox],
          capabilityOverrides: { research: { preset: 'standard', skills: ['verify'] } },
        },
      },
      ROOT_SESSION,
    )

    expect(outcome.status).toBe('verified')
    const run = await h.task.runIn(STORE, outcome.runId)
    const binding = run.providerBinding
    if (binding === undefined) throw new Error('the replay run recorded no provider binding')
    expect(binding.skills.map(skill => skill.name)).toEqual(['verify'])
    expect(binding.skills[0]!.role).toBe('guidance')
    // P2's order is preserved — the candidate is registered first — and the run's
    // snapshot of what the pre-check judged follows it.
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.grant!.skillRoots).toEqual([sandbox, binding.snapshotRoot])
    // The snapshot holds the overlay's bytes, because the overlay is what this
    // replay's admission judged.
    expect(await readFile(join(binding.snapshotRoot!, 'verify', 'SKILL.md'), 'utf8')).toContain('CANDIDATE BODY')
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])
  })

  test("the replay renders the champion's own declarations and persists the same two lists", async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const assumptions = ['a cycle-accurate reference model exists']
    const constraints = ['no network access', 'finish inside ten minutes']
    const { championTaskId } = await champion(h, 'champion work', { assumptions, constraints })
    const championContract = (await h.task.taskIn(STORE, championTaskId)).contract!

    const outcome = await h.runtime.replayTask(
      STORE,
      championTaskId,
      { lineage: 'evolution-replay:declarations' },
      ROOT_SESSION,
    )

    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    const stored = replayTask.contract!
    const spawn = h.spawned[h.spawned.length - 1]!
    // The store is the source, so the rendered views have to say what it says:
    // every item the persisted contract carries is in the spawn prompt and in
    // the contract block the loop reprojects — and the persisted lists are the
    // champion's own, element for element, not merely two non-empty lists.
    // The declarations a worker is shown are its assembled contract's, projected
    // from this very record (A2 — `context/tests/unit/reads.spec.ts` and
    // `tests/integration/context-assembly.spec.ts` assert that rendering), and the
    // spawn request carries no text of its own.
    expect(spawn.taskWorker).toBe(true)
    expect(spawn.prompt).toBeUndefined()
    expect(spawn.contract).toBeUndefined()
    for (const item of [...stored.assumptions, ...stored.constraints]) expect(item.length).toBeGreaterThan(0)
    expect(stored.assumptions).toEqual(championContract.assumptions)
    expect(stored.constraints).toEqual(championContract.constraints)
    expect(championContract.assumptions).toHaveLength(1)
    expect(championContract.constraints).toHaveLength(2)
  })

  test("a capability override granting an MCP server binds it against the replay run's env", async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    h.ctx.envBuilder = {
      store: {
        get: (envId: string) => ({
          path: `/fake/env/${envId}`,
          components: [{ owner: 'fork', repo: 'buckyball', url: 'u', dir: 'fork/buckyball', status: 'ready' }],
        }),
      },
    }
    const { championTaskId } = await champion(h)
    const outcome = await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:p-mcp',
        overlay: { capabilityOverrides: { research: { skills: ['task-execution'], preset: 'standard', mcpServers: ['bbdev'] } } },
      },
      ROOT_SESSION,
    )
    expect(outcome.status).toBe('verified')
    const spawn = h.spawned[h.spawned.length - 1]!
    expect(spawn.grant!.mcpServers).toEqual([
      {
        serverName: 'bbdev',
        command: '/fake/env/env1/fork/buckyball/scripts/claude/run_mcp_server.sh',
        args: [],
        env: {},
        cwd: '/fake/env/env1/fork/buckyball',
      },
    ])
    const replayRun = await h.task.runIn(STORE, outcome.runId)
    expect(replayRun.capabilitySnapshot).toContain('mcp:bbdev')
  })

  test('a replay in a caller-named workspace resolves its spawn, its verifier and its MCP servers there', async () => {
    // S4-E: the two-sided evaluation runs each side in a workspace built from the
    // same initial snapshot, so everything one side resolves against — the
    // worker's cwd, the verifier's cwd, and what a capability's MCP server is
    // bound to — has to follow the directory the caller named.
    pinSkillHome('check')
    const parent = mkdtempSync(join(tmpdir(), 's4e-named-replay-'))
    const checkoutRoot = join(parent, 'checkout')
    const named = join(parent, 'candidate-side')
    mkdirSync(checkoutRoot, { recursive: true })
    mkdirSync(named, { recursive: true })
    try {
      const realNamed = await realpath(named)
      const h = harness({
        config: { capabilities: { 'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] } } },
      })
      h.ctx.envBuilder = {
        store: {
          get: (envId: string) => ({
            path: checkoutRoot,
            components: [{ owner: 'fork', repo: 'buckyball', url: 'u', dir: 'fork/buckyball', status: 'ready' }],
          }),
        },
      }
      const { championTaskId } = await champion(h, 'champion work', {
        requiredCapabilities: ['check-ball-registration'],
      })

      const outcome = await h.runtime.replayTask(
        STORE,
        championTaskId,
        {
          lineage: 'evolution-replay:named-workspace',
          workspace: { path: named },
        },
        ROOT_SESSION,
      )

      expect(outcome.status).toBe('verified')
      // The outcome names the workspace, normalized — the identity a report and a
      // marker both key by.
      expect(outcome.workspace).toBe(realNamed)
      // The worker starts in it.
      const spawn = h.spawned[h.spawned.length - 1]!
      expect(spawn.cwd).toBe(realNamed)
      // So does the MCP server the capability grants: the env root a server's cwd
      // and `{repoRoot:…}` placeholders resolve against is the named workspace.
      expect(spawn.grant!.mcpServers).toEqual([
        {
          serverName: 'bbdev',
          command: join(realNamed, 'fork/buckyball/scripts/claude/run_mcp_server.sh'),
          args: [],
          env: {},
          cwd: join(realNamed, 'fork/buckyball'),
        },
      ])
      // And the verifier judges there.
      expect(h.verifier.verifyRun).toHaveBeenCalledWith(STORE, outcome.runId, {
        cwd: realNamed,
        timeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
      })
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('a presetOverride wins over the capability resolution; absent it, the capability preset stands', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const first = await champion(h)
    await h.runtime.replayTask(
      STORE,
      first.championTaskId,
      {
        lineage: 'evolution-replay:p3',
        overlay: { presetOverride: 'custom-preset' },
      },
      ROOT_SESSION,
    )
    expect(h.spawned[h.spawned.length - 1]!.agentPreset).toBe('custom-preset')

    const h2 = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const second = await champion(h2)
    await h2.runtime.replayTask(STORE, second.championTaskId, { lineage: 'evolution-replay:p4' }, ROOT_SESSION)
    expect(h2.spawned[h2.spawned.length - 1]!.agentPreset).toBe('standard')
  })

  test('spawn: false runs the deterministic criteria replay: no worker, the verifier settles the candidate contract', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const spawnedBefore = h.spawned.length

    const outcome = await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:p5',
        spawn: false,
        contract: {
          objective: 'candidate definition replay',
          acceptanceCriteria: [
            {
              criterionId: 'cd-1',
              description: 'candidate criterion',
              verificationMode: 'deterministic',
              requiredEvidence: [],
              mandatory: true,
              command: 'make candidate',
            },
          ],
          requiredCapabilities: ['research'],
        },
      },
      ROOT_SESSION,
    )

    expect(outcome.status).toBe('verified')
    expect(h.spawned).toHaveLength(spawnedBefore)
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.acceptanceCriteria.map(item => item.criterionId)).toEqual(['cd-1'])
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcome.runId)
    expect(record!.criteria).toEqual([
      { criterionId: 'cd-1', verdict: 'pass', verifierId: 'fake-verifier', command: 'make candidate' },
    ])
    expect(record!.anomalies).toEqual(['evolution-replay:p5'])
  })

  test('a failing replay settles failed with the lineage tag and a localized cause', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } }, verifier: 'by-objective' })
    const { championTaskId } = await champion(h, 'champion work')
    const outcome = await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:p6',
        contract: {
          objective: 'fail-me candidate',
          acceptanceCriteria: [
            {
              criterionId: 'cd-1',
              description: 'fails',
              verificationMode: 'deterministic',
              requiredEvidence: [],
              mandatory: true,
              command: 'false',
            },
          ],
          requiredCapabilities: ['research'],
        },
        spawn: false,
      },
      ROOT_SESSION,
    )

    expect(outcome.status).toBe('failed')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcome.runId)
    expect(record!.outcome).toBe('failed')
    expect(record!.localizedCause).toContain('cd-1 fail')
    expect(record!.anomalies).toEqual(['evolution-replay:p6'])
  })

  test('replay uses the same preset conflict rule before creating a candidate task', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const original = await h.task.taskIn(STORE, championTaskId)
    const before = await h.task.snapshotIn(STORE)
    const spawnCount = h.spawned.length
    await expect(
      h.runtime.replayTask(
        STORE,
        championTaskId,
        {
          lineage: 'evolution-replay:conflicting-presets',
          contract: {
            objective: original.objective,
            acceptanceCriteria: original.acceptanceCriteria,
            requiredCapabilities: ['research', 'verify'],
          },
          overlay: { capabilityOverrides: { verify: { skills: ['task-execution'], preset: 'bb-verify' } } },
        },
        ROOT_SESSION,
      ),
    ).rejects.toThrow(/conflicting capability presets/)
    expect(await h.task.snapshotIn(STORE)).toEqual(before)
    expect(h.spawned).toHaveLength(spawnCount)
  })

  test('rejects a non-terminal champion, an unknown task, and a capability gap under the overlay', async () => {
    // a still-running root is not a replayable champion
    const running = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { taskId: runningRootId } = await createRoot(running)
    await expect(
      running.runtime.replayTask(STORE, runningRootId, { lineage: 'evolution-replay:p7' }, ROOT_SESSION),
    ).rejects.toThrow(/is running; only a terminal/)

    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    await expect(
      h.runtime.replayTask(STORE, 't-ghost', { lineage: 'evolution-replay:p7' }, ROOT_SESSION),
    ).rejects.toThrow('unknown task "t-ghost"')
    await expect(
      h.runtime.replayTask(
        STORE,
        championTaskId,
        {
          lineage: 'evolution-replay:p7',
          contract: {
            objective: 'gap replay',
            acceptanceCriteria: [
              {
                criterionId: 'cd-1',
                description: 'x',
                verificationMode: 'deterministic',
                requiredEvidence: [],
                mandatory: true,
                command: 'true',
              },
            ],
            requiredCapabilities: ['fly-to-moon'],
          },
        },
        ROOT_SESSION,
      ),
    ).rejects.toThrow(/capability gap \[fly-to-moon\]/)
    // nothing was persisted for the rejected replays
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.tasks.filter(task => task.objective.startsWith('[evolution-replay:'))).toHaveLength(0)
  })

  test('a spawn refusal fails the replay run with the cause and the lineage tag', async () => {
    const options: { config?: Partial<Config>; spawnError?: string } = {
      config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } },
    }
    const h = harness(options)
    const { championTaskId } = await champion(h)
    // the spawn seam starts failing after the champion settled
    options.spawnError = 'Unknown agent preset: standard'

    const outcome = await h.runtime.replayTask(STORE, championTaskId, { lineage: 'evolution-replay:p8' }, ROOT_SESSION)
    expect(outcome.status).toBe('failed')
    const replayTask = await h.task.taskIn(STORE, outcome.taskId)
    expect(replayTask.status).toBe('failed')
    const record = (await h.task.snapshotIn(STORE)).reviews.find(item => item.runId === outcome.runId)
    expect(record!.outcome).toBe('failed')
    expect(record!.localizedCause).toBe('spawn failed: Unknown agent preset: standard')
    expect(record!.anomalies).toEqual(['evolution-replay:p8'])
    expect(runEventKinds(h, outcome.runId)).toEqual(['TaskStarted', 'TaskFailed', 'ReviewRecorded'])
  })

  describe('candidate contracts under the shared structural rules (T1, construction guide §4)', () => {
    /** A candidate contract as the replay entry takes it: valid unless the test overrides it. */
    function candidate(
      overrides: Partial<{
        objective: string
        acceptanceCriteria: AcceptanceCriterion[]
        requiredCapabilities: string[]
      }> = {},
    ) {
      return {
        objective: 'candidate definition replay',
        acceptanceCriteria: [
          {
            criterionId: 'cd-1',
            description: 'the candidate definition holds',
            verificationMode: 'deterministic' as const,
            requiredEvidence: [],
            mandatory: true,
            command: 'make candidate',
          },
        ],
        requiredCapabilities: ['research'],
        ...overrides,
      }
    }

    test('refuses a candidate whose every criterion is optional, naming the rule, and persists nothing', async () => {
      const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
      const { championTaskId } = await champion(h)
      const before = await h.task.snapshotIn(STORE)
      const spawnCount = h.spawned.length

      await expect(
        h.runtime.replayTask(
          STORE,
          championTaskId,
          {
            lineage: 'evolution-replay:all-optional',
            contract: candidate({
              acceptanceCriteria: [
                {
                  criterionId: 'cd-1',
                  description: 'nothing is required',
                  verificationMode: 'deterministic',
                  requiredEvidence: [],
                  mandatory: false,
                  command: 'true',
                },
              ],
            }),
          },
          ROOT_SESSION,
        ),
      ).rejects.toThrow(
        /replay of "[^"]+" rejected:\n- replay of "[^"]+" requires at least one mandatory acceptance criterion/,
      )

      expect(await h.task.snapshotIn(STORE)).toEqual(before)
      expect(h.spawned).toHaveLength(spawnCount)
    })

    test('refuses a candidate with one criterion id declared twice, naming the duplicate, and persists nothing', async () => {
      const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
      const { championTaskId } = await champion(h)
      const before = await h.task.snapshotIn(STORE)
      const spawnCount = h.spawned.length

      await expect(
        h.runtime.replayTask(
          STORE,
          championTaskId,
          {
            lineage: 'evolution-replay:duplicate-id',
            contract: candidate({
              acceptanceCriteria: [
                {
                  criterionId: 'cd-dup',
                  description: 'first',
                  verificationMode: 'deterministic',
                  requiredEvidence: [],
                  mandatory: true,
                  command: 'true',
                },
                {
                  criterionId: 'cd-dup',
                  description: 'second',
                  verificationMode: 'review',
                  verifierRef: 'command',
                  requiredEvidence: [],
                  mandatory: true,
                },
              ],
            }),
          },
          ROOT_SESSION,
        ),
      ).rejects.toThrow(
        /replay of "[^"]+" rejected:\n- replay of "[^"]+" declares criterion id "cd-dup" more than once/,
      )

      expect(await h.task.snapshotIn(STORE)).toEqual(before)
      expect(h.spawned).toHaveLength(spawnCount)
    })

    test("persists the effective candidate contract: the tagged objective, the candidate's criteria and capabilities, the champion's declarations", async () => {
      const h = harness({
        config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' }, verify: { skills: ['task-execution'], preset: 'bb-verify' } } },
      })
      const assumptions = ['a cycle-accurate reference model exists']
      const constraints = ['no network access']
      const { championTaskId } = await champion(h, 'champion work', { assumptions, constraints })
      // The candidate differs from the champion in all three fields it owns:
      // its objective, its criteria, and the capability it requires.
      const contract = candidate({ requiredCapabilities: ['verify'] })

      const outcome = await h.runtime.replayTask(
        STORE,
        championTaskId,
        {
          lineage: 'evolution-replay:candidate',
          contract,
          spawn: false,
        },
        ROOT_SESSION,
      )

      expect(outcome.status).toBe('verified')
      const replayTask = await h.task.taskIn(STORE, outcome.taskId)
      expect((await h.task.taskIn(STORE, championTaskId)).requestedCapabilities).toEqual(['research'])
      // The effective contract, field for field: the candidate's three fields
      // plus the champion's own conditions, under the lineage tag. The store
      // refuses a contract that disagrees with the instance it describes, so
      // this is what both a `task_read` and the run's own criteria see.
      expect(replayTask.contract).toEqual({
        contractVersion: 1,
        objective: '[evolution-replay:candidate] candidate definition replay',
        acceptanceCriteria: [
          {
            criterionId: 'cd-1',
            description: 'the candidate definition holds',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
            command: 'make candidate',
          },
        ],
        assumptions,
        constraints,
        requiredCapabilities: ['verify'],
      })
      expect(replayTask.contract!.contractVersion).toBe(1)
    })

    test('replays a champion created before contracts existed, with empty assumptions and constraints', async () => {
      const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
      // Raw store calls, the shape the legacy-style tests use: a task admitted
      // and settled before the contract existed carries none.
      const { taskId: championTaskId, runId: championRunId } = await createAcceptanceParent(h, [
        {
          criterionId: 'legacy-1',
          description: 'the legacy criterion holds',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'true',
        },
      ])
      await settleRunNested(h.task, STORE, championTaskId, championRunId, 'tester')
      const champion = await h.task.taskIn(STORE, championTaskId)
      expect(champion.contract).toBeUndefined()
      expect(champion.status).toBe('verified')

      const outcome = await h.runtime.replayTask(
        STORE,
        championTaskId,
        { lineage: 'evolution-replay:legacy' },
        ROOT_SESSION,
      )

      expect(outcome.status).toBe('verified')
      const replayTask = await h.task.taskIn(STORE, outcome.taskId)
      expect(replayTask.contract!.objective).toBe('[evolution-replay:legacy] prove the combination, not only the parts')
      expect(replayTask.contract!.acceptanceCriteria.map(item => item.criterionId)).toEqual(['legacy-1'])
      expect(replayTask.contract!.assumptions).toEqual([])
      expect(replayTask.contract!.constraints).toEqual([])
      // Nothing was invented for it either: the two rendered sections say so.
      const spawn = h.spawned[h.spawned.length - 1]!
      // Nothing is invented for the record either: its stored contract is what the
      // worker's context is projected from, and it carries the empty lists.
      expect(spawn.taskWorker).toBe(true)
      expect(spawn.prompt).toBeUndefined()
      expect(replayTask.contract!.assumptions).toEqual([])
      expect(replayTask.contract!.constraints).toEqual([])
    })
  })

  /*
   * S4-E (Q3, rework): the execution binding one replay run is placed under.
   *
   * An experiment freezes a model selection before it runs either side, and the
   * frozen value has to reach the worker that really runs — not only the report
   * that describes it. These cases pin the one narrow pipe left: `agentOptions`
   * through to `SpawnRequest`, and the sub-execution a replayed worker decomposes
   * into inherits it, because the two sides of an experiment are only comparable
   * if the whole subtree ran under the same selection. The run's clock is the
   * runtime's own (`Config.budget.wallTimeMs`, the root budget) — a replay names
   * none.
   */
  const FROZEN_OPTIONS = { provider: 'frozen-provider', model: 'frozen-model' }

  test('a replay carries its frozen agent options into the worker spawn; absent them the spawn is unchanged', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const before = h.spawned.length

    const frozen = await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:agent-options',
        agentOptions: { ...FROZEN_OPTIONS },
      },
      ROOT_SESSION,
    )

    expect(frozen.status).toBe('verified')
    const worker = h.spawned[before]!
    // The value the real AgentRuntime received, which is what its creation merges
    // over the deployment default for this worker alone.
    expect(worker.agentOptions).toEqual(FROZEN_OPTIONS)
    // A replay that names none keeps the default: nothing was invented for it.
    const plain = await h.runtime.replayTask(
      STORE,
      championTaskId,
      { lineage: 'evolution-replay:agent-options-default' },
      ROOT_SESSION,
    )
    expect(plain.status).toBe('verified')
    expect(h.spawned[before + 1]!.agentOptions).toBeUndefined()
  })

  test('a replayed worker keeps its frozen model through library restoration and passes both bindings to children', async () => {
    const h = harness({ config: { capabilities: { research: { skills: ['task-execution'], preset: 'standard' } } } })
    const { championTaskId } = await champion(h)
    const graph = await h.graphs.graphForSession(ROOT_SESSION)
    h.graphs.graphForSession.mockResolvedValue({ ...graph, model: { provider: 'graph-provider', model: 'graph-model' } })
    const before = h.spawned.length
    h.setIdleBehavior(async sessionId => {
      const bound = await h.runtime.runForSession(sessionId)
      if (bound.task.parentTaskId !== undefined) {
        await h.runtime.submitResult(sessionId, { summary: 'done' })
        return
      }
      await h.runtime.resumeAdoptedWorkerSession({
        storeId: bound.storeId,
        run: bound.run,
        grant: h.spawned.find(spawn => spawn.sessionId === sessionId)!.grant!,
        taskWorker: true,
      })
      await decomposeAndSettle(h, bound.storeId, bound.task.taskId, bound.run.runId, sessionId, {
        reason: 'the replayed work is not atomic',
        children: [childSpec('the child of the replayed work')],
      })
      // The nested batch ended and handed the replayed worker its run back
      // (K1 §2): the worker's own submission is what settles it now.
      await h.runtime.submitResult(sessionId, { summary: 'the split ran; the replayed work continues under the child' })
    })

    const outcome = await h.runtime.replayTask(
      STORE,
      championTaskId,
      {
        lineage: 'evolution-replay:sub-execution',
        agentOptions: { ...FROZEN_OPTIONS },
        overlay: { taskTemplatesRoot: '/sandbox/sub-execution/task-templates' },
      },
      ROOT_SESSION,
    )

    expect(outcome.status).toBe('verified')
    const [worker, child] = h.spawned.slice(before)
    expect(worker!.agentOptions).toEqual(FROZEN_OPTIONS)
    // The child was spawned from the replayed worker's own session, and it carries
    // the binding of the experiment it belongs to — the same options the worker
    // itself was created under, so the two sides of the comparison really ran the
    // same way.
    expect(child!.agentOptions).toEqual(FROZEN_OPTIONS)
    expect(child!.sessionId).not.toBe(worker!.sessionId)
    expect((await h.runtime.runForSession(child!.sessionId)).run.taskTemplatesRoot).toBe('/sandbox/sub-execution/task-templates')
  })
})
