import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SKILL_SIDECAR_FILE, serializeSkillSidecar, skillContentDigest } from '../../task-runtime/src/index.ts'
import type { VerificationResult, Verifier, VerifyRequest } from '../../verifier/src/index.ts'
import type { ExperimentReport } from '../../evolution/src/index.ts'
import { sha256Of, type RunStack } from '../support/run-stack.ts'
import {
  SKILL,
  loadedSkillFile,
  ledgerRoot,
  boot,
  writeSkillObject,
  skillBody,
  ROOT_A,
  rootContract,
  writeHistory,
  walkToGated,
  P1,
  derivedSidecar,
  bindingOf,
  boundObject,
  productionObject,
  decideThroughTool,
  applyThroughTool,
  ledgerLines,
  intentFiles,
  commitTargets,
  admitChild,
  MARKER,
  kindsOf,
  ledgerBytes,
  SAMPLES,
  HOLDOUT,
  ROW,
  CLEAN_SKILL,
  writeSample,
  criterion,
  GUIDE_ROW,
  P2,
  productionSkill,
  productionSidecar,
} from './k3-skill-unit.fixture.ts'

/** The `SKILL.md` file one worker's own layer resolves for `name`, read back off disk. */
async function workerSkillFile(h: RunStack, sessionId: SessionId, name = SKILL): Promise<string> {
  const agent = h.agent(sessionId)
  if (agent === undefined) throw new Error(`the stack holds no live agent for "${String(sessionId)}"`)
  return loadedSkillFile(h, agent, name)
}

/** The stack's own human seam: every `approval.request` the tools made, in order. */
function approvalCalls(h: RunStack): { toolName: string; reason: string }[] {
  const approval = (
    h.ctx as unknown as {
      get(name: string): { request: { mock: { calls: [{ toolName: string; reason: string }][] } } }
    }
  ).get('approval')
  return approval.request.mock.calls.map(call => call[0])
}

/** The report one experiment names, read back from disk. */
async function reportOnDisk(h: RunStack, reportPath: string): Promise<ExperimentReport> {
  return JSON.parse(await readFile(join(ledgerRoot(h), reportPath), 'utf8')) as ExperimentReport
}

/** One sample's side detail in a report. */
function side(report: ExperimentReport, taskId: string, which: 'baseline' | 'candidate') {
  const sample = report.samples.find(item => item.taskId === taskId)
  if (sample === undefined) throw new Error(`the report holds no sample ${taskId}`)
  return sample[which]
}

/** The directory digest of one side's workspace, computed here so the frozen value is never confirmed against itself. */
async function independentDigest(directory: string): Promise<string> {
  const lines: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(current, entry.name), rel)
      else
        lines.push(
          `${rel}\0${createHash('sha256')
            .update(await readFile(join(current, entry.name)))
            .digest('hex')}`,
        )
    }
  }
  await walk(directory, '')
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/**
 * The judge one case registers as a test double, so it can be *taken away*
 * again: the drift a deployment shows when a registrar moves after the human
 * decided. It judges the answer files the criteria name, like the built-in
 * `command` verifier, so the runs it decides are real runs.
 */
function testJudge(id: string, version: string): Verifier {
  const answerOf: Readonly<Record<string, string>> = {
    'ac-fix': 'fix.txt',
    'ac-keep': 'keep.txt',
    'ac-holdout': 'holdout.txt',
  }
  return {
    id,
    version,
    supports: (mode: string) => mode === 'deterministic',
    verify: async (request: VerifyRequest): Promise<VerificationResult[]> =>
      request.criteria.map(item => ({
        criterionId: item.criterionId,
        status: existsSync(join(request.cwd, answerOf[item.criterionId] ?? 'fix.txt')) ? 'pass' : 'fail',
        verifierId: id,
      })),
    selftest: {
      samples: [
        {
          name: 'positive',
          role: 'positive',
          expect: 'pass',
          criterion: {
            criterionId: 'ac-fix',
            description: 'x',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
          },
        },
        {
          name: 'negative',
          role: 'negative',
          expect: 'fail',
          criterion: {
            criterionId: 'ac-fix',
            description: 'x',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
          },
        },
      ],
    },
  } as unknown as Verifier
}

/* ------------------------------------------------------------------------- *
 * K3-2 — every refusal that happens before a write
 * ------------------------------------------------------------------------- */

/** The sandbox sidecar one prepared proposal materialized. */
function sandboxSidecar(h: RunStack, proposalId: string, name: string = SKILL): string {
  return join(ledgerRoot(h), 'sandbox', proposalId, 'skills', name, SKILL_SIDECAR_FILE)
}

/* ------------------------------------------------------------------------- *
 * K3-1 — the whole object, end to end
 * ------------------------------------------------------------------------- */

describe('K3-1: a registered execution skill is improved and applied as one whole object', () => {
  it('fails on the old body and passes on the new one, and the derived two-file object lands through one real publication approval', async () => {
    const s = await boot()
    const h = s.h
    const production = await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
      sidecar: 'execution',
    })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await writeFile(join(h.checkout, 'input.txt'), 'the frozen input\n', 'utf8')

    const candidateBody = skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'])
    const walked = await walkToGated(s, { proposalId: P1, content: candidateBody })
    const report = await reportOnDisk(h, walked.reportPath)
    expect(report).toEqual(walked.report)

    // --- the frozen block is the complete object on both ends, not a file digest ---
    const proposal = await s.svc.get(P1)
    expect(report.frozen.candidate).toEqual(proposal.prepared!.skillContent)
    expect(report.frozen.productionBaseline).toEqual(proposal.prepared!.skillBaseline)
    expect(report.frozen.candidate.contract).toBeDefined()
    expect(report.frozen.candidate.sha256).toBe(sha256Of(candidateBody))
    expect(report.frozen.productionBaseline!.contract!.sha256).toBe(production.identity.contract!.sha256)

    // --- the experiment's own verdict: fixed where the old body failed, nothing degraded ---
    expect(report.samples.map(sample => [sample.taskId, sample.role, sample.verdict])).toEqual([
      ['t-fix', 'observed-failure', 'fixed'],
      ['t-keep', 'observed-regression', 'maintained'],
      ['t-holdout', 'holdout', 'maintained'],
    ])
    expect(report.verdict).toBe('fixed')
    expect(side(report, 't-fix', 'baseline').outcome).toBe('failed')
    expect(side(report, 't-fix', 'candidate').outcome).toBe('verified')

    // --- each side really ran its own object, read out of the binding's own snapshot ---
    const candidateSha = sha256Of(candidateBody)
    const derived = derivedSidecar(JSON.parse(production.sidecar!), candidateSha)
    const derivedBytes = serializeSkillSidecar(derived as never)
    for (const sample of report.samples) {
      const baselineDetail = side(report, sample.taskId, 'baseline')
      const candidateDetail = side(report, sample.taskId, 'candidate')
      const baselineBinding = await bindingOf(h, root.storeId, baselineDetail.runId!)
      const candidateBinding = await bindingOf(h, root.storeId, candidateDetail.runId!)
      const baselineObject = await boundObject(baselineBinding)
      const candidateObject = await boundObject(candidateBinding)
      // The bytes: the baseline side ran production, the candidate side the derived object.
      expect(baselineObject).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
      expect(candidateObject).toEqual({ skillMd: candidateBody, sidecar: derivedBytes })
      // …and the candidate's declaration is the production one with exactly one field
      // rewritten — compared field by field, not just by digest.
      const candidateDeclaration = JSON.parse(candidateObject.sidecar!) as Record<string, unknown>
      const productionDeclaration = JSON.parse(production.sidecar!) as Record<string, unknown>
      expect({ ...candidateDeclaration, content: null }).toEqual({ ...productionDeclaration, content: null })
      expect(candidateDeclaration.content).toEqual({
        ...(productionDeclaration.content as object),
        skillMdSha256: candidateSha,
      })
      // The declared digests agree with the bytes in the same snapshot (both files).
      expect(sha256Of(candidateObject.sidecar!)).toBe(report.frozen.candidate.contract!.sha256)
      expect(sha256Of(baselineObject.skillMd)).toBe(report.frozen.productionBaseline!.sha256)
      // Each side bound the revision and the provider identity the freeze recorded for it.
      const frozenSample = report.frozen.samples.find(item => item.taskId === sample.taskId)!
      expect(baselineBinding.registryRevision).toBe(frozenSample.provider.registryRevision)
      expect(candidateBinding.registryRevision).toBe(frozenSample.provider.candidateRegistryRevision)
      expect(candidateBinding.registryRevision).not.toBe(baselineBinding.registryRevision)
      expect(baselineBinding.skills).toEqual([
        expect.objectContaining({
          name: SKILL,
          role: 'execution-provider',
          contractDigest: report.frozen.productionBaseline!.contract!.contractDigest,
          contentDigest: skillContentDigest({ skillMdSha256: production.skillMdSha256, resources: [] }),
        }),
      ])
      expect(candidateBinding.skills).toEqual([
        expect.objectContaining({
          name: SKILL,
          role: 'execution-provider',
          contractDigest: report.frozen.candidate.contract!.contractDigest,
          contentDigest: skillContentDigest({ skillMdSha256: candidateSha, resources: [] }),
        }),
      ])
    }

    // --- the model decision: the decision changes the ledger and nothing else ---
    const beforeDecision = await productionObject(h)
    await decideThroughTool(s, P1)
    expect(await productionObject(h)).toEqual(beforeDecision)
    expect(approvalCalls(h).map(call => call.toolName)).toEqual([])

    // --- the publication approval: the write ---
    await applyThroughTool(s, P1)
    expect(approvalCalls(h).map(call => call.toolName)).toEqual(['evolution_apply'])
    expect(await productionObject(h)).toEqual({ skillMd: candidateBody, sidecar: derivedBytes })

    // --- one commit, two files: the intent named both, the completion closed both ---
    const lines = await ledgerLines(h)
    expect(lines.every(line => line.formatVersion === 4)).toBe(true)
    const intent = lines.filter(line => line.kind === 'commit_intent').at(-1)!
    const applied = lines.filter(line => line.kind === 'applied').at(-1)!
    expect(intent).toMatchObject({ proposalId: P1, direction: 'apply', intentId: `${P1}/apply` })
    expect(intentFiles(intent).map(file => file.target)).toEqual(commitTargets(h))
    expect(intentFiles(intent)[0]).toMatchObject({
      baselineSha256: production.identity.sha256,
      contentSha256: candidateSha,
      source: `sandbox/${P1}/skills/${SKILL}/SKILL.md`,
    })
    expect(intentFiles(intent)[1]).toMatchObject({
      baselineSha256: production.identity.contract!.sha256,
      contentSha256: sha256Of(derivedBytes),
      source: `sandbox/${P1}/skills/${SKILL}/${SKILL_SIDECAR_FILE}`,
    })
    expect(applied).toMatchObject({ proposalId: P1, intentId: `${P1}/apply`, targets: commitTargets(h) })
    expect(applied.approvalRef).toBe(intent.approvalRef)
    expect((await s.svc.get(P1)).status).toBe('applied')
    expect(await s.svc.openIntentTargets()).toEqual([])

    // --- the production declaration moved in exactly one field, and by derivation ---
    const appliedDeclaration = JSON.parse((await productionObject(h)).sidecar!) as Record<string, unknown>
    const originalDeclaration = JSON.parse(production.sidecar!) as Record<string, unknown>
    expect({ ...appliedDeclaration, content: null }).toEqual({ ...originalDeclaration, content: null })
    expect(appliedDeclaration.content).toEqual({
      ...(originalDeclaration.content as object),
      skillMdSha256: candidateSha,
    })
    expect(sha256Of((await productionObject(h)).sidecar!)).toBe(report.frozen.candidate.contract!.sha256)
    expect(sha256Of((await productionObject(h)).sidecar!)).not.toBe(production.identity.contract!.sha256)

    // --- the next run is admitted against the recovered object: both files ---
    const admitted = await admitChild(h, ROOT_A, root)
    const newBinding = await bindingOf(h, root.storeId, admitted.childRunId)
    expect(await boundObject(newBinding)).toEqual({ skillMd: candidateBody, sidecar: derivedBytes })
    expect(newBinding.registryRevision).toBe(report.frozen.samples[0]!.provider.candidateRegistryRevision)
    expect(newBinding.skills[0]).toMatchObject({
      role: 'execution-provider',
      contractDigest: report.frozen.candidate.contract!.contractDigest,
      contentDigest: skillContentDigest({ skillMdSha256: candidateSha, resources: [] }),
    })
    // The worker's own layer loaded the new body and acted on it.
    expect(await workerSkillFile(h, admitted.workerSessionId)).toBe(candidateBody)
    expect(await readFile(join(h.agent(admitted.workerSessionId)!.session.header.cwd, MARKER), 'utf8')).toBe(
      `${candidateSha}\n`,
    )

    // --- a run bound to the previous version is not hot-swapped ---
    const oldBaseline = side(report, 't-fix', 'baseline')
    const oldBinding = await bindingOf(h, root.storeId, oldBaseline.runId!)
    expect(await boundObject(oldBinding)).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
    expect((await h.task.runIn(root.storeId, oldBaseline.runId!)).providerBinding).toEqual(oldBinding)
    expect((await h.runtime.readRunBinding(oldBinding))?.defects).toEqual([])
    await h.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 180_000)
})

describe('K3-2: the refusals that come before any write', () => {
  it('refuses to prepare a knowledge skill by name, writing no sandbox and no prepared line', async () => {
    const s = await boot({ quiet: true })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt']), sidecar: 'knowledge' })
    const proposal = {
      proposalId: P1,
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: SKILL,
      rationale: 'improve it',
      sourceRefs: ['diagnosis:k3'],
    }
    expect((await s.call('evolution_propose', proposal)).isError).toBe(false)
    expect(
      (
        await s.call('evolution_candidate', {
          proposalId: P1,
          versionSet: { skill: 'v2' },
          mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }),
        })
      ).isError,
    ).toBe(false)

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain('knowledge sidecar')
    expect(refused.text).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
    expect((await s.call('evolution_prepare', { proposalId: P1 })).text).toContain('knowledge sidecar')
  })

  it('refuses to prepare a production object that declares resources, by name and with nothing written', async () => {
    const s = await boot({ quiet: true })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt']),
      sidecar: 'execution',
      resources: [{ path: 'references/notes.md', bytes: 'the declared notes\n' }],
    })
    await s.call('evolution_propose', {
      proposalId: P1,
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: SKILL,
      rationale: 'improve it',
      sourceRefs: ['diagnosis:k3'],
    })
    await s.call('evolution_candidate', {
      proposalId: P1,
      versionSet: { skill: 'v2' },
      mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }),
    })

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain('resource(s)')
    expect(refused.text).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
  })

  it.each([
    { label: 'a file at a supported resource position', file: 'references/notes.md' },
    { label: 'an entry outside the supported vocabulary', file: 'helper.sh' },
  ])('refuses to prepare a guidance object that leaves a file undeclared — $label', async ({ file }) => {
    const s = await boot({ quiet: true })
    const h = s.h
    // Guidance: no sidecar anywhere, so nothing declares this file and nothing
    // covers it — the one shape where the loader has no declaration to compare
    // against and the file would otherwise be left behind silently.
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt']),
      resources: [{ path: file, bytes: 'a file nobody declared\n' }],
    })
    await s.call('evolution_propose', {
      proposalId: P1,
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: SKILL,
      rationale: 'improve it',
      sourceRefs: ['diagnosis:k3'],
    })
    await s.call('evolution_candidate', {
      proposalId: P1,
      versionSet: { skill: 'v2' },
      mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }),
    })

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain(file)
    expect(refused.text).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
    expect((await s.svc.get(P1)).status).toBe('candidate')

    // The service entry behind the tool refuses the same way, and still writes
    // nothing: the refusal is prepare's own, not the tool's rendering of it.
    const direct = await s.svc.prepare(P1, ROOT_A).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    expect(direct).toContain(file)
    expect(direct).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
    expect((await s.svc.get(P1)).status).toBe('candidate')
  })

  it('refuses a production declaration whose content digest is not the bytes it covers, before anything is frozen', async () => {
    const s = await boot({ quiet: true })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt']),
      sidecar: 'execution',
      declaredSkillMdSha256: 'f'.repeat(64),
    })
    await s.call('evolution_propose', {
      proposalId: P1,
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: SKILL,
      rationale: 'improve it',
      sourceRefs: ['diagnosis:k3'],
    })
    await s.call('evolution_candidate', {
      proposalId: P1,
      versionSet: { skill: 'v2' },
      mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }),
    })

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain('content-mismatch:')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
  })

  it.each([
    {
      label: 'a non-digest field (requiredTools) moved',
      move: (declaration: Record<string, unknown>) => ({ ...declaration, requiredTools: ['bash'] }),
    },
    {
      label: 'the content digest no longer matches the candidate body',
      move: (declaration: Record<string, unknown>) => ({
        ...declaration,
        content: { ...(declaration.content as object), skillMdSha256: '0'.repeat(64) },
      }),
    },
  ])(
    'refuses the apply when the sandbox sidecar was rewritten after prepare — $label',
    async ({ move }) => {
      const s = await boot()
      const h = s.h
      await writeSkillObject(join(h.home, 'skills'), {
        body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
        sidecar: 'execution',
      })
      const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
      await writeHistory(h, root.storeId)
      await mkdir(join(h.checkout, 'nested'), { recursive: true })
      await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
      await decideThroughTool(s, P1)

      const path = sandboxSidecar(h, P1)
      const rewritten = move(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)
      await writeFile(path, serializeSkillSidecar(rewritten as never), 'utf8')
      const before = await ledgerBytes(h)
      const productionBefore = await productionObject(h)
      const approvalsBefore = approvalCalls(h).length

      const refused = await s.call('evolution_apply', { proposalId: P1 })
      expect(refused.text).toContain('evolution_apply rejected:')
      expect(refused.text).toContain('no longer matches the content identity recorded at prepare')
      // Nothing was written and nothing was recorded — and no human was asked.
      expect(await productionObject(h)).toEqual(productionBefore)
      expect(await ledgerBytes(h)).toBe(before)
      expect(kindsOf(await ledgerLines(h)).slice(-1)).toEqual(['decided'])
      expect(approvalCalls(h)).toHaveLength(approvalsBefore)
      // The service entry says the same thing, not only the tool.
      const direct = await s.svc.apply(P1, ROOT_A, 'approval:k3-direct').then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect(direct).toContain('no longer matches the content identity recorded at prepare')
      expect(await ledgerBytes(h)).toBe(before)
    },
    180_000,
  )

  it('refuses a candidate whose SKILL.md declares another name, where the object is admitted', async () => {
    const s = await boot()
    const h = s.h
    const production = await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
      sidecar: 'execution',
    })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await s.call('evolution_propose', {
      proposalId: P1,
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: SKILL,
      rationale: 'improve it',
      sourceRefs: ['diagnosis:k3'],
    })
    // The model's own text names another skill: `prepare` materializes exactly the
    // bytes it was handed, so the object the candidate side would load declares a
    // name the row does not grant.
    const renamed = skillBody('k3-a-different-skill-name', ['fix.txt', 'keep.txt', 'holdout.txt'])
    await s.call('evolution_candidate', {
      proposalId: P1,
      versionSet: { skill: 'v2' },
      mutationJson: JSON.stringify({ name: SKILL, content: renamed }),
    })
    expect((await s.call('evolution_prepare', { proposalId: P1 })).text).toContain('[prepared]')

    const spawnsBefore = h.spawns.length
    const refused = await s.call('evolution_replay', {
      proposalId: P1,
      taskIds: [...SAMPLES],
      holdoutTaskIds: [...HOLDOUT],
    })
    expect(refused.text).toContain('evolution_replay rejected:')
    expect(refused.text).toContain('skill-name-mismatch')
    expect(refused.text).toContain(join(ledgerRoot(h), 'sandbox', P1, 'skills', SKILL))

    // No promotion can be reached from here: nothing is gated, nothing is decided,
    // nothing is written, and no human is asked.
    const kinds = kindsOf(await ledgerLines(h))
    expect(kinds.slice(0, 3)).toEqual(['proposed', 'candidate', 'prepared'])
    expect(kinds).not.toContain('gated')
    expect(kinds).not.toContain('decided')
    expect(kinds).not.toContain('commit_intent')
    expect((await s.svc.get(P1)).status).toBe('prepared')
    expect(await productionObject(h)).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
    expect(approvalCalls(h).map(call => call.toolName)).toEqual([])
    expect(h.spawns.length).toBeGreaterThanOrEqual(spawnsBefore)
  }, 180_000)

  it('refuses the apply when the judge the declaration pins was unregistered after the decision', async () => {
    const s = await boot()
    const h = s.h
    const offJudge = await h.verifier.register(testJudge('k3-judge', '1'), { testDouble: true })
    try {
      await writeSkillObject(join(h.home, 'skills'), {
        body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
        sidecar: 'execution',
        verifierRef: 'k3-judge',
      })
      const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
      await writeHistory(h, root.storeId)
      await mkdir(join(h.checkout, 'nested'), { recursive: true })
      await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
      await decideThroughTool(s, P1)

      // The registrar moves after the human decided: the judge the declaration
      // counts on is gone, so the write must not go ahead.
      offJudge()
      const before = await ledgerBytes(h)
      const productionBefore = await productionObject(h)
      const refused = await s.call('evolution_apply', { proposalId: P1 })
      expect(refused.text).toContain('evolution_apply rejected:')
      expect(refused.text).toContain('verifier-unknown')
      expect(refused.text).toContain('k3-judge')
      expect(await productionObject(h)).toEqual(productionBefore)
      expect(await ledgerBytes(h)).toBe(before)
      expect((await s.svc.get(P1)).status).toBe('decided')
    } finally {
      offJudge()
    }
  }, 180_000)

  it('refuses the apply when the capability grant the promotion counted on is gone', async () => {
    const s = await boot()
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
      sidecar: 'execution',
    })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
    await decideThroughTool(s, P1)

    // The row that grants the skill is withdrawn before the write: the declaration
    // the promotion would install names a capability the deployment no longer
    // holds, so the grant is not the one the candidate was evaluated under.
    expect(h.runtime.listCapabilities()[ROW]).toBeDefined()
    await h.runtime.applyCapabilityRow(ROW, null)
    expect(h.runtime.listCapabilities()[ROW]).toBeUndefined()

    const before = await ledgerBytes(h)
    const productionBefore = await productionObject(h)
    const refused = await s.call('evolution_apply', { proposalId: P1 })
    expect(refused.text).toContain('evolution_apply rejected:')
    expect(refused.text).toContain('capability-unknown')
    expect(refused.text).toContain(ROW)
    expect(await productionObject(h)).toEqual(productionBefore)
    expect(await ledgerBytes(h)).toBe(before)
    expect((await s.svc.get(P1)).status).toBe('decided')
  }, 180_000)

  it('refuses to freeze an experiment for a provider whose required tools its row does not grant, starting no run', async () => {
    const s = await boot({ capabilities: { [ROW]: { skills: [SKILL], tools: ['filesystem'] } } })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
      sidecar: 'execution',
      requiredTools: ['bash'],
    })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await s.call('evolution_propose', {
      proposalId: P1,
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: SKILL,
      rationale: 'improve it',
      sourceRefs: ['diagnosis:k3'],
    })
    await s.call('evolution_candidate', {
      proposalId: P1,
      versionSet: { skill: 'v2' },
      mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) }),
    })
    expect((await s.call('evolution_prepare', { proposalId: P1 })).isError).toBe(false)

    const spawnsBefore = h.spawns.length
    const refused = await s.call('evolution_replay', {
      proposalId: P1,
      taskIds: [...SAMPLES],
      holdoutTaskIds: [...HOLDOUT],
    })
    expect(refused.text).toContain('evolution_replay rejected:')
    expect(refused.text).toContain('tool-not-covered:')
    expect(refused.text).toContain('bash')
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate', 'prepared'])
    expect(h.spawns).toHaveLength(spawnsBefore)
  }, 180_000)

  it('still promotes a guidance skill through the whole chain, one file at a time', async () => {
    const s = await boot()
    const h = s.h
    // The one file the guidance object has, with no declaration anywhere near it.
    const guidance = await writeSkillObject(join(h.home, 'skills'), {
      name: CLEAN_SKILL,
      body: skillBody(CLEAN_SKILL, ['keep.txt', 'holdout.txt']),
    })
    expect(guidance.sidecar).toBeUndefined()
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate guidance skill'))
    await writeSample(h, root.storeId, {
      taskId: 't-fix',
      runId: 'r-fix-history',
      objective: 'the answer file is produced',
      acceptance: criterion('ac-fix', 'test -f fix.txt'),
      outcome: 'failed',
      capability: GUIDE_ROW,
    })
    await writeSample(h, root.storeId, {
      taskId: 't-holdout',
      runId: 'r-holdout-history',
      objective: 'the held-out answer file is produced',
      acceptance: criterion('ac-holdout', 'test -f holdout.txt'),
      outcome: 'verified',
      capability: GUIDE_ROW,
    })
    await mkdir(join(h.checkout, 'nested'), { recursive: true })

    const candidateBody = skillBody(CLEAN_SKILL, ['fix.txt', 'holdout.txt'])
    const walked = await walkToGated(s, {
      proposalId: P2,
      name: CLEAN_SKILL,
      content: candidateBody,
      samples: ['t-fix'],
      holdout: ['t-holdout'],
    })
    expect(walked.report.frozen.candidate.contract).toBeUndefined()
    expect(walked.report.verdict).toBe('fixed')
    await decideThroughTool(s, P2)
    await applyThroughTool(s, P2)

    // One file, replaced; and no declaration appeared beside it.
    expect(await readFile(productionSkill(h, CLEAN_SKILL), 'utf8')).toBe(candidateBody)
    expect(existsSync(productionSidecar(h, CLEAN_SKILL))).toBe(false)
    const lines = await ledgerLines(h)
    const intent = lines.filter(line => line.kind === 'commit_intent').at(-1)!
    expect(intentFiles(intent).map(file => file.target)).toEqual([productionSkill(h, CLEAN_SKILL)])
    expect(intentFiles(intent)[0]).toMatchObject({
      baselineSha256: guidance.skillMdSha256,
      contentSha256: sha256Of(candidateBody),
    })
    expect(lines.filter(line => line.kind === 'applied').at(-1)!.targets).toEqual([productionSkill(h, CLEAN_SKILL)])

    const admitted = await admitChild(h, ROOT_A, root, GUIDE_ROW)
    const binding = await bindingOf(h, root.storeId, admitted.childRunId)
    expect(await boundObject(binding, CLEAN_SKILL)).toEqual({ skillMd: candidateBody })
    expect(binding.skills[0]).toMatchObject({ role: 'guidance', contractDigest: null })
    await h.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 180_000)
})

/* ------------------------------------------------------------------------- *
 * K3-3 — drift after the freeze
 * ------------------------------------------------------------------------- */

describe('K3-3: a file that moves after the freeze refuses by name, and the two sides stay complete and isolated', () => {
  it.each([
    { label: 'the candidate SKILL.md', file: 'SKILL.md' },
    { label: 'the candidate SKILL.contract.json', file: SKILL_SIDECAR_FILE },
  ])(
    'refuses to freeze the experiment when $label moved in the sandbox after prepare, starting nothing',
    async ({ file }) => {
      const s = await boot()
      const h = s.h
      await writeSkillObject(join(h.home, 'skills'), {
        body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
        sidecar: 'execution',
      })
      const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
      await writeHistory(h, root.storeId)
      await mkdir(join(h.checkout, 'nested'), { recursive: true })
      await s.call('evolution_propose', {
        proposalId: P1,
        level: 'L2',
        baseVersion: 'v1',
        targetType: 'skill',
        targetId: SKILL,
        rationale: 'improve it',
        sourceRefs: ['diagnosis:k3'],
      })
      await s.call('evolution_candidate', {
        proposalId: P1,
        versionSet: { skill: 'v2' },
        mutationJson: JSON.stringify({
          name: SKILL,
          content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']),
        }),
      })
      expect((await s.call('evolution_prepare', { proposalId: P1 })).text).toContain('[prepared]')

      // The sandbox file moves after the prepare recorded its identity — the state
      // every later stage must refuse rather than evaluate.
      const at = join(ledgerRoot(h), 'sandbox', P1, 'skills', SKILL, file)
      await writeFile(
        at,
        file === 'SKILL.md'
          ? `${skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'])}the sandbox was rewritten after prepare\n`
          : serializeSkillSidecar({
              ...(JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>),
              requiredTools: ['bash'],
            } as never),
        'utf8',
      )

      const spawnsBefore = h.spawns.length
      const refused = await s.call('evolution_replay', {
        proposalId: P1,
        taskIds: [...SAMPLES],
        holdoutTaskIds: [...HOLDOUT],
      })
      expect(refused.text).toContain('evolution_replay rejected:')
      expect(refused.text).toContain('no longer matches the content identity recorded at prepare')
      expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate', 'prepared'])
      expect(h.spawns).toHaveLength(spawnsBefore)
      expect((await s.svc.get(P1)).status).toBe('prepared')
    },
    180_000,
  )

  it.each([
    { label: 'the production SKILL.md', file: 'SKILL.md' },
    { label: 'the production SKILL.contract.json', file: SKILL_SIDECAR_FILE },
  ])(
    'refuses the write when $label moved after the decision, and never overwrites it',
    async ({ file }) => {
      const s = await boot()
      const h = s.h
      const production = await writeSkillObject(join(h.home, 'skills'), {
        body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
        sidecar: 'execution',
      })
      const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
      await writeHistory(h, root.storeId)
      await mkdir(join(h.checkout, 'nested'), { recursive: true })
      await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
      await decideThroughTool(s, P1)

      // A third party rewrites one of the two production files the commit would
      // replace: the baseline prepare recorded is gone, so the write is refused.
      const at = file === 'SKILL.md' ? productionSkill(h) : productionSidecar(h)
      const thirdParty =
        file === 'SKILL.md'
          ? skillBody(SKILL, ['keep.txt', 'holdout.txt'], 'a third party rewrote the body')
          : serializeSkillSidecar({
              ...(JSON.parse(production.sidecar!) as Record<string, unknown>),
              precondition: 'a third party rewrote the declaration',
            } as never)
      await writeFile(at, thirdParty, 'utf8')

      const before = await ledgerBytes(h)
      const approvalsBefore = approvalCalls(h).length
      const refused = await s.call('evolution_apply', { proposalId: P1 })
      expect(refused.text).toContain('evolution_apply rejected:')
      expect(refused.text).toContain('changed since prepare')
      expect(await ledgerBytes(h)).toBe(before)
      expect(kindsOf(await ledgerLines(h)).slice(-1)).toEqual(['decided'])
      expect(approvalCalls(h)).toHaveLength(approvalsBefore)
      // The third party's bytes stand exactly as they were left.
      expect(await readFile(at, 'utf8')).toBe(thirdParty)
      expect(await readFile(file === 'SKILL.md' ? productionSidecar(h) : productionSkill(h), 'utf8')).toBe(
        file === 'SKILL.md' ? production.sidecar! : production.skillMd,
      )
      // A source that moved is the same refusal, asked of the service entry directly.
      const direct = await s.svc.apply(P1, ROOT_A, 'approval:k3-direct').then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect(direct).toContain('changed since prepare')
      expect(await ledgerBytes(h)).toBe(before)
    },
    180_000,
  )

  it('runs both sides of every sample as complete, isolated objects from one frozen input', async () => {
    const s = await boot()
    const h = s.h
    const production = await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
      sidecar: 'execution',
    })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await writeFile(join(h.checkout, 'input.txt'), 'the frozen input\n', 'utf8')

    const candidateBody = skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'])
    const walked = await walkToGated(s, { proposalId: P1, content: candidateBody })
    const report = walked.report

    // The frozen input is the caller's own workspace, digested independently here.
    expect(report.frozen.snapshot.digest).toBe(await independentDigest(h.checkout))
    const candidateSha = sha256Of(candidateBody)
    for (const sample of report.samples) {
      const baseline = side(report, sample.taskId, 'baseline')
      const candidate = side(report, sample.taskId, 'candidate')
      const frozenSample = report.frozen.samples.find(item => item.taskId === sample.taskId)!
      // The historical record locates the case; it is nobody's baseline.
      expect(baseline.taskId).not.toBe(sample.taskId)
      expect(candidate.taskId).not.toBe(sample.taskId)
      expect(baseline.runId).not.toBe(frozenSample.observed.runId)
      expect(candidate.runId).not.toBe(frozenSample.observed.runId)
      expect(baseline.workspace).not.toBe(candidate.workspace)
      for (const [detail, object] of [
        [baseline, report.frozen.productionBaseline!],
        [candidate, report.frozen.candidate],
      ] as const) {
        // Each workspace started from the frozen input…
        expect(detail.initialDigest).toBe(report.frozen.snapshot.digest)
        // …wrote only in its own copy, and recorded the object it really loaded.
        expect(await readFile(join(detail.workspace!, MARKER), 'utf8')).toBe(`${object.sha256}\n`)
        const binding = await bindingOf(h, root.storeId, detail.runId!)
        const bound = await boundObject(binding)
        expect(sha256Of(bound.skillMd)).toBe(object.sha256)
        expect(sha256Of(bound.sidecar!)).toBe(object.contract!.sha256)
      }
      // Neither side holds the other's object: the two markers are the two identities.
      const baselineMarker = await readFile(join(baseline.workspace!, MARKER), 'utf8')
      expect(baselineMarker).toBe(`${report.frozen.productionBaseline!.sha256}\n`)
      expect(baselineMarker).not.toBe(`${candidateSha}\n`)
    }
    // The sides wrote their copies, never the frozen input itself.
    expect(existsSync(join(h.checkout, MARKER))).toBe(false)
    expect(existsSync(join(h.checkout, 'fix.txt'))).toBe(false)
    expect(await independentDigest(h.checkout)).toBe(report.frozen.snapshot.digest)
    // And production still holds exactly what it held before the experiment.
    expect(await productionObject(h)).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
  }, 180_000)
})
