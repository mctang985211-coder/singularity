import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  CapabilityConfig,
  DecomposeSpec,
  RootContractSpec,
  SkillProviderVerdict,
} from '../../task-runtime/src/index.ts'
import { parseObligationTemplates, precheckProviders, skillSearchRoots } from '../../task-runtime/src/index.ts'
import { findSkillFile, findSkillFileIn, readSkillFile } from '../../agent-runtime/src/skill-file.ts'
import { disposeRunStacks, startRunStack, type RunStack } from '../support/run-stack.ts'

/**
 * BB2-2: the BB skills are installed into the graph runtime's own cwd, and the
 * real loader, run binding and admission are shown reading exactly those files.
 *
 * Everything asserted here is the deployment's machinery: the real `TaskService`
 * and `TaskRuntime` (normalization, admission, the provider pre-check, the run
 * binding and its snapshot materialization), the real `AgentRuntime.spawn` over
 * the real DSH skill plane, and the real filesystem. The model loop is replaced
 * by the support stack's stub factory — the substitution
 * `provider-version-binding.spec.ts` already makes — because every verdict below
 * is a filesystem and store fact, not a model behaviour.
 *
 * The install is the deployment's own file operation and nothing more: a plain
 * recursive copy of the canonical BB-1 skill directories (Buckyball
 * `3d9ad0b9`, its `.agents/skills` submodule
 * `ef89fa7e20e0871b9c461d09b0a49df223c6f4c8`) plus the Harness Task reference
 * `bb-pipeline` into `<checkout>/.agents/skills/` — the first root the runtime's
 * own loader searches from a worker's cwd (`agent-runtime/src/skill-file.ts`).
 * There is no installer service, and this spec does not invent one: the env root
 * is a directory the deployment's env setup created
 * (`env-builder/src/service/store.ts`), the copy is the same operation the
 * existing provider-precheck/binding specs already apply to the same root
 * (`tests/integration/provider-precheck.spec.ts`), and the deployment's own
 * `config.yml.example` `task-runtime` comment spells the same command out for an
 * operator provisioning an env.
 *
 * What the two global roots hold here is a *decoy*: a loadable same-name
 * `SKILL.md` with different bytes, planted under `$DSH_HOME/skills` and under
 * the user root `~/.agents/skills` — both pinned inside this fixture's tmp
 * workspace, so no skill installed on the machine running the suite can decide a
 * verdict. The run must still load the checkout's copy, and the binding records
 * that as a digest of the bytes on disk rather than as a claim.
 *
 * The method-skill cases need a buckyball `.agents/skills` tree on this machine
 * (a sibling `buckyball` checkout, a deployment env's own checkout, or whatever
 * `BB_SKILLS_ROOT` names); without one they are skipped, the missing tree being
 * the whole reason. The other describe installs the repository's own
 * `.agents/skills` and always runs.
 * @module tests/integration/bb-skill-install
 */

const ROOT = 's-root' as SessionId

/** The checkout's project skill root: what a worker's own discovery walks first. */
const SKILLS_DIR = join('.agents', 'skills')

/** The one reference file the task contract table lives in, inside `bb-pipeline`. */
const REFERENCE = join('references', 'tasks.md')

/** The Harness-side BB skills: the Task reference and the obligation templates. */
const REFERENCE_SKILL = 'bb-pipeline'
const OBLIGATIONS_SKILL = 'bb-obligations'

/** The BB-1 method skills, named exactly as the deployment's capability rows declare them. */
const METHOD_SKILLS = ['ball-align', 'check', 'chip-designer', 'model-integration', 'verify', 'waveform'] as const

/** The two capability rows `bb-pipeline/references/tasks.md` lists. */
const LISTED_CHECK = 'check-ball-registration'
const LISTED_MODEL = 'integrate-model'
/** A legal capability row the reference does *not* list: the table is the admission gate, not the reference. */
const UNLISTED = 'track-bb-obligations'

/** The body a decoy carries: bytes that must never reach a run's snapshot. */
const DECOY_MARK = 'DECOY: this copy must never be bound'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
/** The Harness repository's own skills — the Task reference's canonical home. */
const REPO_SKILLS = join(REPO_ROOT, '.agents', 'skills')

/** One skill checkout candidate: a directory holding `<name>/SKILL.md` for every method skill. */
function candidateSkillRoots(): string[] {
  const candidates: (string | undefined)[] = [
    process.env.BB_SKILLS_ROOT,
    join(REPO_ROOT, '..', 'buckyball', '.agents', 'skills'),
  ]
  // A deployment env's own buckyball checkout: `<envRoot>/<owner>/buckyball`.
  const environments = join(REPO_ROOT, 'environment')
  if (existsSync(environments)) {
    for (const env of readdirSync(environments, { withFileTypes: true })) {
      if (!env.isDirectory()) continue
      for (const owner of readdirSync(join(environments, env.name), { withFileTypes: true })) {
        if (owner.isDirectory()) candidates.push(join(environments, env.name, owner.name, 'buckyball', SKILLS_DIR))
      }
    }
  }
  return candidates.filter((path): path is string => path !== undefined)
}

/** Where the BB-1 method skills are installed from, or `undefined` on a machine that has no such checkout. */
const METHOD_SOURCE = candidateSkillRoots().find(root =>
  METHOD_SKILLS.every(name => existsSync(join(root, name, 'SKILL.md'))),
)

afterEach(async () => {
  await disposeRunStacks()
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The guidance content identity of one installed directory, computed here with
 * node's own hasher: the `SKILL.md` bytes plus every file under `references/`
 * and `scripts/`, serialized as the contract's own canonical JSON (sorted keys,
 * arrays in order) and hashed once more. Written out rather than imported so the
 * digest a run records is compared against the bytes on disk instead of against
 * the code that produced the record.
 */
async function guidanceDigest(directory: string): Promise<string> {
  const resources: { path: string; sha256: string }[] = []
  for (const sub of ['references', 'scripts']) {
    const entries = await readdir(join(directory, sub), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile()) continue
      resources.push({ path: `${sub}/${entry.name}`, sha256: sha256(await readFile(join(directory, sub, entry.name))) })
    }
  }
  resources.sort((left, right) => (left.path < right.path ? -1 : 1))
  const identity = [
    `{"resources":[${resources.map(item => `{"path":${JSON.stringify(item.path)},"sha256":${JSON.stringify(item.sha256)}}`).join(',')}]`,
    `"skillMdSha256":${JSON.stringify(sha256(await readFile(join(directory, 'SKILL.md'))))}}`,
  ].join(',')
  return sha256(Buffer.from(identity, 'utf8'))
}

/**
 * Install one skill directory the way this deployment provisions a run's cwd: a
 * recursive copy of the canonical directory into `<checkout>/.agents/skills/`.
 * Nothing is transformed on the way — the bytes admission judges, the bytes the
 * run snapshots and the bytes the worker reads are the source's.
 */
async function installSkill(checkout: string, source: string, name: string): Promise<string> {
  const target = join(checkout, SKILLS_DIR, name)
  await cp(join(source, name), target, { recursive: true })
  return target
}

/** Write one loadable decoy skill — `SKILL.md` alone, declaring the name it must not be bound for. */
async function writeDecoy(root: string, name: string): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a decoy for ${name}\n---\n\n${DECOY_MARK}\n`,
    'utf8',
  )
  return directory
}

/** Every installed skill's path, as the loader answers for it — inside the checkout, whatever the globals hold. */
async function assertInstalledIsWhatDiscoveryFinds(
  checkout: string,
  installed: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [name, directory] of Object.entries(installed)) {
    expect(await findSkillFile(name, checkout)).toBe(join(directory, 'SKILL.md'))
  }
}

/** The one verdict the pre-check took for a skill, or a thrown refusal naming every defect. */
function accepted(verdict: SkillProviderVerdict, name: string): Extract<SkillProviderVerdict, { valid: true }> {
  if (!verdict.valid) {
    throw new Error(
      `the pre-check refused "${name}": ${verdict.defects.map(defect => `${defect.code}: ${defect.detail}`).join('; ')}`,
    )
  }
  return verdict
}

/** The one child contract this spec instantiates: an objective, a criterion a command settles, and the row it asks for. */
function child(objective: string, capability: string): DecomposeSpec['children'][number] {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} is delivered`, command: 'true' }],
    requiredCapabilities: [capability],
  }
}

function rootContract(objective: string): RootContractSpec {
  return {
    objective, requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
  }
}

/** The binding one settled child run recorded — never a run that claimed no content. */
async function bindingOf(
  h: RunStack,
  storeId: string,
  runId: string,
): Promise<{ capabilities: string[]; skills: { name: string; contentDigest: string }[] }> {
  const run = await h.task.runIn(storeId, runId)
  const binding = run.providerBinding
  if (binding === undefined) throw new Error(`run "${runId}" recorded no provider binding`)
  return binding
}

describe('BB2-2: the installed layout is what discovery, the run binding and admission read', () => {
  it('installs the Task reference into the run checkout, and a run binds the installed bytes rather than the global copy', async () => {
    const table: Record<string, CapabilityConfig> = { [UNLISTED]: { skills: [OBLIGATIONS_SKILL] } }
    const h = await startRunStack({ capabilities: table })

    const installed: Record<string, string> = {
      [REFERENCE_SKILL]: await installSkill(h.checkout, REPO_SKILLS, REFERENCE_SKILL),
      [OBLIGATIONS_SKILL]: await installSkill(h.checkout, REPO_SKILLS, OBLIGATIONS_SKILL),
    }

    // The decoy sits in `$DSH_HOME/skills` — a root the deployment's own
    // discovery does search — and is a *loadable* skill declaring the same name,
    // so only the order of the roots decides which one a worker would read.
    const decoy = await writeDecoy(join(h.home, 'skills'), OBLIGATIONS_SKILL)
    expect((await readSkillFile(join(decoy, 'SKILL.md'), OBLIGATIONS_SKILL)).content).toContain(DECOY_MARK)

    const roots = await skillSearchRoots({ cwd: h.checkout })
    expect(roots[0]).toBe(join(h.checkout, SKILLS_DIR))
    expect(roots).toContain(join(h.home, 'skills'))
    expect(roots).toContain(join(h.home, '.agents', 'skills'))
    await assertInstalledIsWhatDiscoveryFinds(h.checkout, installed)
    // The decoy root itself is live: read on its own it answers with the decoy,
    // so what protects the run is the checkout root's precedence, not the
    // decoy's absence.
    expect(await findSkillFileIn([join(h.home, 'skills')], OBLIGATIONS_SKILL)).toBe(join(decoy, 'SKILL.md'))
    // The Task reference arrives whole — the contract table travels with it.
    expect(await readFile(join(installed[REFERENCE_SKILL]!, REFERENCE), 'utf8')).toBe(
      await readFile(join(REPO_SKILLS, REFERENCE_SKILL, REFERENCE), 'utf8'),
    )

    const precheck = await precheckProviders({
      capabilities: Object.keys(table),
      table,
      view: { cwd: h.checkout },
      verifierRefs: h.verifier.verifierIds(),
    })
    expect(precheck.roots).toEqual(roots)
    const verdict = accepted(precheck.capabilities[0]!.skills[0]!, OBLIGATIONS_SKILL)
    if (verdict.role !== 'guidance') throw new Error(`"${OBLIGATIONS_SKILL}" was admitted as "${verdict.role}"`)
    expect(verdict.directory).toBe(installed[OBLIGATIONS_SKILL])
    expect(verdict.contentDigest).toBe(await guidanceDigest(installed[OBLIGATIONS_SKILL]!))
    expect(verdict.contentDigest).not.toBe(await guidanceDigest(decoy))
    // The machine template is a bound resource, not an uncovered side file.
    expect(verdict.uncovered).toEqual([])
    expect(
      parseObligationTemplates(
        await readFile(join(installed[OBLIGATIONS_SKILL]!, 'references', 'obligations.yml'), 'utf8'),
        `${OBLIGATIONS_SKILL}/references/obligations.yml`,
      ).length,
    ).toBeGreaterThan(0)

    const root = await h.root(ROOT, rootContract('keep the domain obligations of a BB goal visible'))
    const admitted = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'the reference names no such row, and the table does',
      children: [child('answer the obligation list for the goal', UNLISTED)],
    })
    expect(admitted.status).toBe('admitted')
    const outcomes = await h.runtime.awaitBatch(root.storeId, admitted.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])

    const run = await h.task.runIn(root.storeId, outcomes[0]!.runId!)
    const binding = run.providerBinding!
    expect(binding.capabilities).toEqual([UNLISTED])
    expect(binding.skills.map(skill => skill.name)).toEqual([OBLIGATIONS_SKILL])
    const skill = binding.skills[0]!
    expect(skill.role).toBe('guidance')
    expect(skill.contractDigest).toBeNull()
    expect(skill.capabilities).toEqual([UNLISTED])
    expect(skill.uncovered).toEqual([])
    expect(skill.contentDigest).toBe(await guidanceDigest(installed[OBLIGATIONS_SKILL]!))
    expect(skill.contentDigest).not.toBe(await guidanceDigest(decoy))

    // The snapshot is the installed bytes, under the run's own directory, and
    // the record reads back against them with nothing to report.
    const snapshotRoot = join(h.home, 'singularity', 'run-bindings', root.storeId, run.runId, 'skills')
    expect(binding.snapshotRoot).toBe(snapshotRoot)
    expect(await readFile(join(snapshotRoot, OBLIGATIONS_SKILL, 'SKILL.md'), 'utf8')).toBe(
      await readFile(join(installed[OBLIGATIONS_SKILL]!, 'SKILL.md'), 'utf8'),
    )
    expect(await readFile(join(snapshotRoot, OBLIGATIONS_SKILL, 'SKILL.md'), 'utf8')).not.toContain(DECOY_MARK)
    const snapshotTemplate = join(snapshotRoot, OBLIGATIONS_SKILL, 'references', 'obligations.yml')
    const installedTemplate = join(installed[OBLIGATIONS_SKILL]!, 'references', 'obligations.yml')
    const originalTemplate = await readFile(installedTemplate, 'utf8')
    expect(await readFile(snapshotTemplate, 'utf8')).toBe(originalTemplate)
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])

    await writeFile(installedTemplate, `${originalTemplate}\n`)
    const changed = await precheckProviders({
      capabilities: Object.keys(table),
      table,
      view: { cwd: h.checkout },
      verifierRefs: h.verifier.verifierIds(),
    })
    const changedVerdict = accepted(changed.capabilities[0]!.skills[0]!, OBLIGATIONS_SKILL)
    expect(changedVerdict.contentDigest).not.toBe(skill.contentDigest)
    expect(await readFile(snapshotTemplate, 'utf8')).toBe(originalTemplate)
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])

    // The worker's own layer registers the snapshot, not the catalog: the grant
    // hands the spawn the snapshot root, and the body it holds is those bytes.
    const spawn = h.spawns.find(request => String(request.sessionId) === String(run.sessionId))
    if (spawn === undefined) throw new Error(`the runtime spawned no worker for run "${run.runId}"`)
    expect(spawn.grant?.skillRoots).toEqual([snapshotRoot])
    const worker = h.agent(run.sessionId as SessionId)!
    const registered = await registeredSkill(h, worker, OBLIGATIONS_SKILL)
    expect(registered.path?.startsWith(snapshotRoot)).toBe(true)
    expect(registered.content).toBe(
      (await readSkillFile(join(installed[OBLIGATIONS_SKILL]!, 'SKILL.md'), OBLIGATIONS_SKILL)).content,
    )
  })
})

describe.skipIf(METHOD_SOURCE === undefined)(
  'BB2-2: the BB-1 method skills installed from the canonical buckyball tree',
  () => {
    it('admits three contracts — two the Task reference lists, one it does not — and binds each to its installed skill', async () => {
      const source = METHOD_SOURCE!
      const table: Record<string, CapabilityConfig> = {
        [LISTED_CHECK]: { skills: ['check'] },
        [LISTED_MODEL]: { skills: ['model-integration'] },
        [UNLISTED]: { skills: [OBLIGATIONS_SKILL] },
      }
      const h = await startRunStack({ capabilities: table })

      const installed: Record<string, string> = {}
      for (const name of METHOD_SKILLS) installed[name] = await installSkill(h.checkout, source, name)
      for (const name of [REFERENCE_SKILL, OBLIGATIONS_SKILL])
        installed[name] = await installSkill(h.checkout, REPO_SKILLS, name)
      // The copy carried the source bytes: what admission judges below is the
      // canonical BB-1 content, not a reshaped stand-in.
      for (const name of METHOD_SKILLS) {
        expect(await readFile(join(installed[name]!, 'SKILL.md'), 'utf8')).toBe(
          await readFile(join(source, name, 'SKILL.md'), 'utf8'),
        )
      }

      // The user root `~/.agents/skills` is inside this fixture's pinned home, and
      // holds a same-name decoy for one of the installed method skills.
      const decoy = await writeDecoy(join(h.home, '.agents', 'skills'), 'check')
      expect((await readSkillFile(join(decoy, 'SKILL.md'), 'check')).content).toContain(DECOY_MARK)

      await assertInstalledIsWhatDiscoveryFinds(h.checkout, installed)
      expect(await findSkillFileIn([join(h.home, '.agents', 'skills')], 'check')).toBe(join(decoy, 'SKILL.md'))

      const roots = await skillSearchRoots({ cwd: h.checkout })
      expect(roots[0]).toBe(join(h.checkout, SKILLS_DIR))
      const precheck = await precheckProviders({
        capabilities: Object.keys(table),
        table,
        view: { cwd: h.checkout },
        verifierRefs: h.verifier.verifierIds(),
      })
      expect(precheck.roots).toEqual(roots)
      const verdictFor = (capability: string, skill: string): SkillProviderVerdict => {
        const row = precheck.capabilities.find(entry => entry.capability === capability)
        if (row === undefined) throw new Error(`the pre-check reported no row "${capability}"`)
        const verdict = row.skills.find(entry => entry.name === skill)
        if (verdict === undefined) throw new Error(`the pre-check reported no skill "${skill}" under "${capability}"`)
        return verdict
      }
      const checkVerdict = accepted(verdictFor(LISTED_CHECK, 'check'), 'check')
      expect(checkVerdict.directory).toBe(installed['check'])
      expect(checkVerdict.contentDigest).toBe(await guidanceDigest(installed['check']!))
      expect(checkVerdict.contentDigest).not.toBe(await guidanceDigest(decoy))
      const modelVerdict = accepted(verdictFor(LISTED_MODEL, 'model-integration'), 'model-integration')
      expect(modelVerdict.directory).toBe(installed['model-integration'])
      expect(modelVerdict.contentDigest).toBe(await guidanceDigest(installed['model-integration']!))

      // The reference the run's own checkout carries names two of the three rows
      // and not the third: what admits the third is the capability table.
      const reference = await readFile(join(installed[REFERENCE_SKILL]!, REFERENCE), 'utf8')
      expect(reference).toContain(LISTED_CHECK)
      expect(reference).toContain(LISTED_MODEL)
      expect(reference).not.toContain(UNLISTED)

      const root = await h.root(ROOT, rootContract('advance one Buckyball goal over the installed method skills'))
      const admitted = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
        reason: 'three rows the deployment holds: two the reference lists, one it does not',
        children: [
          child('check the ball registration of the target chip', LISTED_CHECK),
          child('integrate the named model into a Buckyball workload', LISTED_MODEL),
          child('answer the domain obligation list for the goal', UNLISTED),
        ],
      })
      expect(admitted.status).toBe('admitted')
      const outcomes = await h.runtime.awaitBatch(root.storeId, admitted.batchId)
      expect(outcomes.map(outcome => outcome.status)).toEqual(['verified', 'verified', 'verified'])

      const expected: Readonly<Record<string, string>> = {
        [LISTED_CHECK]: 'check',
        [LISTED_MODEL]: 'model-integration',
        [UNLISTED]: OBLIGATIONS_SKILL,
      }
      const seen: string[] = []
      const workerFor: Record<string, SessionId> = {}
      for (const outcome of outcomes) {
        const run = await h.task.runIn(root.storeId, outcome.runId!)
        const binding = await bindingOf(h, root.storeId, outcome.runId!)
        expect(binding.capabilities).toHaveLength(1)
        const capability = binding.capabilities[0]!
        const skillName = expected[capability]!
        seen.push(capability)
        workerFor[capability] = run.sessionId as SessionId
        expect(binding.skills.map(skill => skill.name)).toEqual([skillName])
        const skill = binding.skills[0]!
        expect(skill.role).toBe('guidance')
        expect(skill.contentDigest).toBe(await guidanceDigest(installed[skillName]!))
        const snapshotRoot = join(h.home, 'singularity', 'run-bindings', root.storeId, run.runId, 'skills')
        expect(binding.snapshotRoot).toBe(snapshotRoot)
        expect(await readFile(join(snapshotRoot, skillName, 'SKILL.md'), 'utf8')).toBe(
          await readFile(join(installed[skillName]!, 'SKILL.md'), 'utf8'),
        )
        expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])
        const spawn = h.spawns.find(request => String(request.sessionId) === String(run.sessionId))
        expect(spawn?.grant?.skillRoots).toEqual([snapshotRoot])
      }
      // Three contracts, three rows, three runs — every one of them admitted and settled.
      expect([...seen].sort()).toEqual([LISTED_CHECK, LISTED_MODEL, UNLISTED].sort())

      // The decoy is never what the worker holds: the granted `check` body is the
      // snapshot's copy of the installed bytes.
      const checkWorker = h.agent(workerFor[LISTED_CHECK]!)!
      const registered = await registeredSkill(h, checkWorker, 'check')
      expect(registered.content).not.toContain(DECOY_MARK)
      expect(registered.content).toBe((await readSkillFile(join(installed['check']!, 'SKILL.md'), 'check')).content)
    })
  },
)

/** The body a worker's own skill layer holds for one name, as its scope serves it. */
async function registeredSkill(h: RunStack, agent: Agent, name: string): Promise<{ content: string; path?: string }> {
  const skill = await h.ctx.skills.get(name, { scope: agent, cwd: h.checkout })
  if (skill === undefined) throw new Error(`the worker's skill layer holds no "${name}"`)
  return skill as { content: string; path?: string }
}
