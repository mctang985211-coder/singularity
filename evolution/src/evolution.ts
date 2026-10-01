/** The evolution plane service: the proposal lifecycle, its two-sided experiment, the promotion gate and the durable apply/rollback commit.
 * @module dsh-singularity-evolution/evolution */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, type Dirent } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import {
  loadSkillSidecar,
  optionalService,
  precheckProviders,
  precheckReplacedCapabilityRow,
  readVerifiedFile,
  registeredVerifierIds,
  serializeSkillSidecar,
  skillSearchRoots,
  SKILL_SIDECAR_FILE,
  skillContractDigest,
} from '@dangosys/dsh-singularity-task-runtime'
import type { ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import type { CapabilityRow, CapabilityStoreView, PreparedCapability } from './capability-candidate.ts'
import {
  assertCapabilityCandidateAdmissible,
  capabilityRowBytes,
  capabilityRowDigest,
  capabilityRowIdentity,
  capabilityTableWith,
  discoverSkill,
  readPreparedCapability,
  validateCapabilityMutation,
} from './capability-candidate.ts'
import type { SkillContentIdentity } from './replay.ts'
import type { CommitRequest } from './commit.ts'
import { commitIntent } from './commit.ts'
import { capabilityTableIdentity } from './capability-config.ts'

import type { ExperimentSources } from './experiment/freeze.ts'
import type { ExperimentResult } from './experiment/record.ts'
import type { ExperimentSpec } from './experiment/spec.ts'
import { buildExperimentReport } from './experiment/record.ts'
import { resumeExperiment, runExperiment } from './experiment/runner.ts'
import { assertCapabilityPromotionEvidence } from './promotion/capability.ts'
import { noEvaluatorRefusal } from './promotion/shared.ts'
import { assertSkillPromotionEvidence } from './promotion/skill.ts'
import type { CapabilityPromotionSources } from './promotion/capability.ts'
import type { SkillPromotionSources } from './promotion/shared.ts'
import { EvolutionServiceCore } from './service/core.ts'
import { capabilityBytes, readVerifiedSkillCandidate } from './service/skill-files.ts'
import { materialize } from './service/sandbox.ts'
import { sessionLog, verifierVocabularyOf } from './service/sources.ts'
import { validateGateAnswers, validateMutation, validateVersionSet } from './ledger/records.ts'
import {
  candidateSidecar,
  contractIdentityOf,
  loadedSidecar,
  productionSidecarRelative,
  productionSkillRelative,
  readProductionSkill,
} from './service/skill-files.ts'
import { assertSegment, nonEmpty, refExistsOnDisk, resolveWithin } from './shared.ts'
import type {
  ApplyOutcome,
  EvolutionDecision,
  EvolutionProposal,
  EvolutionRecord,
  GateAnswers,
  PromotionCheck,
  PromotionProvider,
  ProposeInput,
  SkillMutation,
} from './types.ts'
import { EVOLUTION_DECISIONS, EVOLUTION_LEVELS, promotionProviderOf } from './types.ts'

export class EvolutionService extends EvolutionServiceCore {
  async propose(input: ProposeInput, actor: string): Promise<EvolutionProposal> {
    const record: EvolutionRecord = {
      formatVersion: 4,
      kind: 'proposed',
      proposalId: nonEmpty(input.proposalId, 'proposalId'),
      targetType: input.targetType,
      targetId: nonEmpty(input.targetId, 'targetId'),
      baseVersion: nonEmpty(input.baseVersion, 'baseVersion'),
      level: input.level,
      rationale: nonEmpty(input.rationale, 'rationale'),
      sourceRefs: input.sourceRefs,
      actor,
      at: new Date().toISOString(),
    }
    if (!EVOLUTION_LEVELS.includes(record.level)) throw new Error(`evolution: unknown level "${String(input.level)}"`)
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) {
      throw new Error('evolution: sourceRefs must name at least one source (diagnosisId / reviewRef / evidenceId)')
    }
    input.sourceRefs.forEach((ref, index) => nonEmpty(ref, `sourceRefs[${index}]`))
    await this.append(record)
    return this.get(record.proposalId)
  }

  /** Move proposed → candidate, recording the complete version set the candidate aligns to. */
  async candidate(
    proposalId: string,
    versionSet: Record<string, string>,
    actor: string,
    mutation: unknown,
  ): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'candidate')
    if (current.targetType !== 'skill' && current.targetType !== 'capability') {
      throw new Error(
        `evolution: proposal "${proposalId}" targets "${current.targetType}", which cannot become a candidate in this build — ` +
          'the candidate lifecycles here are a SKILL.md replacement of an existing skill object (evolution_prepare → the two-sided ' +
          'experiment evolution_replay → evolution_gate → evolution_apply) and one whole capability row with an optional new execution ' +
          'skill (A6), so its proposal stays a recorded proposal',
      )
    }
    validateVersionSet(versionSet)
    validateMutation(current.targetType, mutation)
    await this.append({
      formatVersion: 4,
      kind: 'candidate',
      proposalId,
      versionSet: { ...versionSet },
      mutation: structuredClone(mutation),
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /** Move candidate → prepared: confirm the production skill **object** this proposal replaces and materialize the candidate. */
  async prepare(proposalId: string, actor: string): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'prepared')
    // Every candidate the fold admits carries a validated mutation: `candidate`
    const mutation = current.mutation
    validateMutation(current.targetType, mutation)
    assertSegment(proposalId, 'proposalId')
    // The two candidate lifecycles materialize different objects and share
    if (current.targetType === 'capability') return this.prepareCapability(current, actor)
    const { name } = mutation as unknown as SkillMutation
    const directory = join(this.skillRoot, name)
    // P3: one verified read of the production object, before anything is materialized.
    const loaded = await loadSkillSidecar(directory)
    if (loaded.content === undefined) {
      throw new Error(
        `evolution: the production skill "${join(directory, 'SKILL.md')}" does not exist, so proposal ` +
          `"${proposalId}" has nothing to replace — this build prepares and promotes a replacement of an existing loadable skill ` +
          'object only; a new skill cannot be evaluated or promoted by this path',
      )
    }
    if (loaded.defects.length > 0) {
      const defects = loaded.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
      throw new Error(
        `evolution: the production skill "${directory}" is not the loadable object its files claim — ${defects}; this build freezes ` +
          'a complete object (SKILL.md, and the SKILL.contract.json it declares when the object has one), and a directory a loader ' +
          'refuses cannot be the baseline a candidate must reproduce: nothing was written',
      )
    }
    if (loaded.sidecar?.type === 'knowledge') {
      throw new Error(
        `evolution: the production skill "${directory}" carries a knowledge sidecar, and a same-name improvement of a knowledge skill ` +
          'is refused by name in this build — the object this executor promotes is guidance (no sidecar) or an execution provider ' +
          '(SKILL.md plus SKILL.contract.json with no resources), so nothing was written',
      )
    }
    if (loaded.sidecar !== undefined && loaded.sidecar.content.resources.length > 0) {
      throw new Error(
        `evolution: the production skill "${directory}" declares ${loaded.sidecar.content.resources.length} resource(s) ` +
          `(${loaded.sidecar.content.resources.map(resource => JSON.stringify(resource.path)).join(', ')}), and this build promotes an ` +
          'object whose content identity covers SKILL.md alone — resources need an executor that writes them, so nothing was written',
      )
    }
    // The other direction of the same rule, and the one place it can be missed: the side that already landed.
    const undeclaredFiles = [...loaded.content.resources.map(resource => resource.path), ...loaded.uncovered]
    if (undeclaredFiles.length > 0) {
      throw new Error(
        `evolution: the production skill "${directory}" holds ${undeclaredFiles.length} file(s) beyond the object this build freezes ` +
          `(${undeclaredFiles.map(path => JSON.stringify(path)).join(', ')}), and the object is fixed — guidance is SKILL.md alone, and ` +
          'an execution provider is SKILL.md plus the SKILL.contract.json beside it with no resources — so a directory carrying more is ' +
          'not the object a candidate reproduces: nothing was written',
      )
    }
    // The bytes the object is frozen from: read once, through the same verified read the candidate goes through.
    const productionSkillMd = await readVerifiedFile(this.skillRoot, productionSkillRelative(name))
    if (sha256Hex(productionSkillMd) !== loaded.content.skillMdSha256) {
      throw new Error(
        `evolution: the production skill "${join(directory, 'SKILL.md')}" changed while proposal "${proposalId}" was being prepared ` +
          '(its bytes no longer hash to the digest the loader had just validated) — freezing a second read would record a baseline ' +
          'nothing checked, so nothing was written',
      )
    }
    const productionSidecar =
      loaded.sidecar === undefined ? undefined : await readVerifiedFile(this.skillRoot, productionSidecarRelative(name))
    if (
      productionSidecar !== undefined &&
      skillContractDigest(loadedSidecar(productionSidecar)) !== skillContractDigest(loaded.sidecar!)
    ) {
      throw new Error(
        `evolution: the production skill "${join(directory, SKILL_SIDECAR_FILE)}" changed while proposal "${proposalId}" was being ` +
          'prepared (its declaration is no longer the one the loader had just validated) — nothing was written',
      )
    }
    const dir = join(this.root, 'sandbox', proposalId)
    const written = await materialize(dir, mutation, {
      skillMd: productionSkillMd,
      ...(productionSidecar === undefined ? {} : { sidecar: productionSidecar }),
    })
    const sandbox = `sandbox/${proposalId}`
    const candidateSkillMd = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`)
    const skillContent: SkillContentIdentity = {
      name,
      sha256: sha256Hex(candidateSkillMd),
      ...(loaded.sidecar === undefined
        ? {}
        : {
            contract: contractIdentityOf(
              await readVerifiedFile(this.root, `${sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`),
            ),
          }),
    }
    await this.append({
      formatVersion: 4,
      kind: 'prepared',
      proposalId,
      sandbox,
      mechanical: true,
      champion: 'captured',
      skillBaseline: written.skillBaseline,
      skillContent,
      files: written.files,
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /** Move candidate → prepared for a **capability candidate** (A6): freeze the one row and the table's composed identity. */
  private async prepareCapability(current: EvolutionProposal, actor: string): Promise<EvolutionProposal> {
    const proposalId = current.proposalId
    const candidate = validateCapabilityMutation(current.mutation)
    const store = await this.capabilityStore()
    const baselineEntry = store.table[candidate.row.name] ?? null
    await assertCapabilityCandidateAdmissible(store, candidate, baselineEntry)
    // The table file's composed identity, frozen before anything of this candidate
    const capabilityTable =
      this.capabilityConfigPath === undefined
        ? undefined
        : capabilityTableIdentity({
            text: await this.capabilityTableText(),
            file: this.capabilityConfigPath,
            name: candidate.row.name,
            entry: candidate.row.entry,
            restored: baselineEntry,
          })
    const dir = join(this.root, 'sandbox', proposalId)
    const sandbox = `sandbox/${proposalId}`
    const rowRelative = `capability/${candidate.row.name}.json`
    const championRelative = `champion/capability/${candidate.row.name}.json`
    const files: string[] = []
    const write = async (rel: string, content: string | Buffer): Promise<void> => {
      const abs = resolveWithin(dir, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
      files.push(rel)
    }
    await write(rowRelative, capabilityRowBytes(candidate.row.entry))
    if (baselineEntry !== null) await write(championRelative, capabilityRowBytes(baselineEntry))
    if (candidate.skill !== undefined) {
      await write(`skills/${candidate.skill.name}/SKILL.md`, Buffer.from(candidate.skill.content, 'utf8'))
      await write(
        `skills/${candidate.skill.name}/${SKILL_SIDECAR_FILE}`,
        serializeSkillSidecar(candidate.skill.sidecar),
      )
    }
    const refusals = await this.capabilityRowRefusals(
      candidate.row,
      candidate.skill === undefined ? undefined : join(dir, 'skills'),
    ).catch(async (error: unknown) => {
      // The pre-check itself could not run (an unreadable registry, a ledger
      await rm(dir, { recursive: true, force: true })
      throw error
    })
    if (refusals.length > 0) {
      await rm(dir, { recursive: true, force: true })
      throw new Error(
        `evolution: skill-candidate-invalid: capability candidate "${proposalId}" grants providers this deployment refuses — ` +
          `${refusals.join('; ')}; the sandbox was removed and nothing was recorded`,
      )
    }
    const rowBytes = await readVerifiedFile(this.root, `${sandbox}/${rowRelative}`)
    const capabilityRow = capabilityRowIdentity({ name: candidate.row.name, entry: candidate.row.entry })
    if (sha256Hex(rowBytes) !== capabilityRow.digest) {
      throw new Error(
        `evolution: the frozen row "${rowRelative}" of proposal "${proposalId}" does not hash to the identity just recorded ` +
          `(sha256 ${sha256Hex(rowBytes)} != ${capabilityRow.digest}) — nothing this plane writes may be unreproducible`,
      )
    }
    const capabilityBaseline =
      baselineEntry === null ? null : capabilityRowIdentity({ name: candidate.row.name, entry: baselineEntry })
    let skillContent: SkillContentIdentity | undefined
    if (candidate.skill !== undefined) {
      const skillMd = await readVerifiedFile(this.root, `${sandbox}/skills/${candidate.skill.name}/SKILL.md`)
      const sidecarBytes = await readVerifiedFile(
        this.root,
        `${sandbox}/skills/${candidate.skill.name}/${SKILL_SIDECAR_FILE}`,
      )
      skillContent = {
        name: candidate.skill.name,
        sha256: sha256Hex(skillMd),
        contract: contractIdentityOf(sidecarBytes),
      }
    }
    await this.append({
      formatVersion: 4,
      kind: 'prepared',
      proposalId,
      sandbox,
      mechanical: true,
      champion: 'absent',
      ...(skillContent === undefined ? {} : { skillContent }),
      ...(skillContent === undefined ? {} : { skillBaseline: null }),
      capabilityRow,
      capabilityBaseline,
      ...(capabilityTable === undefined ? {} : { capabilityTable }),
      files,
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /** The capability table's own text (A6), read at prepare: the file the composed identity is taken from. */
  private async capabilityTableText(): Promise<string> {
    const file = this.capabilityConfigPath!
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      throw new Error(
        `evolution: the capability table "${file}" this deployment names cannot be read ` +
          `(${error instanceof Error ? error.message : String(error)}), so the file a later apply writes its row into cannot be frozen — ` +
          'nothing was materialized, nothing was recorded and no row was changed; configure a readable capability table file ' +
          '(Config.capabilityConfig) and prepare again',
      )
    }
  }

  /** The store a capability candidate is judged against: the running registry, the verifier vocabulary and the skill roots. */
  private async capabilityStore(): Promise<CapabilityStoreView> {
    const table = this.effectiveCapabilities()
    if (table === undefined) {
      throw new Error(
        'evolution: the effective capability registry cannot be read in this context (no task-runtime service, or its listCapabilities ' +
          'failed), so a capability row cannot be prepared, promoted or written — the candidate would be judged against a table nobody can ' +
          'read, and nothing was changed',
      )
    }
    const vocabulary = await verifierVocabularyOf(this.ctx)
    return {
      table,
      ...(vocabulary === undefined ? {} : { verifierVocabulary: vocabulary }),
      skillRoots: await this.skillDiscoveryRoots(),
      skillRoot: this.skillRoot,
    }
  }

  /** Every root a worker's own discovery searches, the production skill root this plane writes first. */
  private async skillDiscoveryRoots(): Promise<string[]> {
    return [this.skillRoot, ...(await skillSearchRoots({ cwd: process.cwd() }))]
  }

  /** The row as it would read after the write, judged by the admission pre-check. */
  private async capabilityRowRefusals(
    row: CapabilityRow,
    sandboxSkillRoot: string | undefined,
  ): Promise<readonly string[]> {
    const table = this.effectiveCapabilities()
    if (table === undefined) {
      throw new Error(
        'evolution: the effective capability registry cannot be read in this context, so the capability row cannot be pre-checked — ' +
          'nothing was changed',
      )
    }
    const verifierRefs = await registeredVerifierIds(this.ctx)
    const { refusals } = await precheckReplacedCapabilityRow({
      name: row.name,
      entry: row.entry,
      table,
      view: { cwd: process.cwd(), ...(sandboxSkillRoot === undefined ? {} : { extraRoots: [sandboxSkillRoot] }) },
      ...(verifierRefs === undefined ? {} : { verifierRefs }),
      commitLedger: this,
    })
    return refusals
  }

  /** Move prepared → gated: all six Gate answers plus regression evidence refs. */
  async gate(
    proposalId: string,
    answers: GateAnswers,
    actor: string,
    refKnown?: (ref: string) => Promise<boolean>,
  ): Promise<EvolutionProposal> {
    const current = await this.assertNext(proposalId, 'gated')
    validateGateAnswers(answers)
    let experimentReport: string | undefined
    if (current.targetType === 'skill' || current.targetType === 'capability') {
      const [experiment] = await this.experiments(proposalId)
      if (experiment === undefined) {
        throw new Error(
          `evolution: ${current.targetType} proposal "${proposalId}" has no two-sided experiment — the gate answers must rest on ` +
            'both sides of every frozen sample, so evaluate the candidate with evolution_replay before gating it',
        )
      }
      try {
        buildExperimentReport(experiment)
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} — a ${current.targetType} candidate gates on a completed ` +
            `experiment only; resume experiment ${experiment.experimentId} (evolution_replay) before answering the gate`,
        )
      }
      experimentReport = experiment.report
    }
    if (experimentReport !== undefined) {
      if (!answers.regressionEvidenceRefs.includes(experimentReport)) {
        throw new Error(
          `evolution: a ${current.targetType} candidate's regression evidence must cite its experiment report "${experimentReport}" — ` +
            'the six answers are answered over that experiment, and the gate records the evidence they rest on',
        )
      }
      if (!existsSync(resolveWithin(this.root, experimentReport))) {
        throw new Error(`evolution: the experiment report "${experimentReport}" no longer exists under the ledger root`)
      }
    }
    for (const ref of answers.regressionEvidenceRefs) {
      if (experimentReport !== undefined && ref === experimentReport) continue
      const exists = refExistsOnDisk(this.repoRoot, ref) || (refKnown !== undefined && (await refKnown(ref)))
      if (!exists) {
        throw new Error(`evolution: regression evidence ref "${ref}" matches no known evidence id and no existing path`)
      }
    }
    await this.append({
      formatVersion: 4,
      kind: 'gated',
      proposalId,
      gate: { ...answers, regressionEvidenceRefs: [...answers.regressionEvidenceRefs] },
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /** Move gated → decided. Callers (the evolution_decide tool) must have a human grant to pass as approval evidence. */
  async decide(
    proposalId: string,
    decision: EvolutionDecision,
    actor: string,
    approvalRef: string,
    note?: string,
  ): Promise<EvolutionProposal> {
    await this.assertNext(proposalId, 'decided')
    if (!EVOLUTION_DECISIONS.includes(decision)) {
      throw new Error(`evolution: decision must be one of ${EVOLUTION_DECISIONS.join(' / ')}`)
    }
    nonEmpty(approvalRef, 'approvalRef')
    if (note !== undefined) nonEmpty(note, 'note')
    if (decision === 'PROMOTE') await this.checkPromotion(proposalId)
    await this.append({
      formatVersion: 4,
      kind: 'decided',
      proposalId,
      decision,
      approvalRef,
      ...(note === undefined ? {} : { note }),
      actor,
      at: new Date().toISOString(),
    })
    return this.get(proposalId)
  }

  /** Move decided → applied: copy the sandbox materialization into production through the one commit path. */
  async apply(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome> {
    await this.assertNext(proposalId, 'applied')
    nonEmpty(approvalRef, 'approvalRef')
    return this.commitExclusive(async () => {
      const proposal = await this.get(proposalId)
      await this.assertSupportedSource(proposal)
      const open = proposal.openIntent
      if (open !== undefined) {
        if (open.direction !== 'apply') {
          throw new Error(
            `evolution: proposal "${proposalId}" has an open rollback commit intent ("${open.intentId}") — apply cannot complete a ` +
              'rollback; settle that intent (reconcile, or evolution_rollback) before applying anything',
          )
        }
        const recovered = await this.settleOpenIntent(open)
        return { targets: open.files.map(file => file.target), recovered, proposal: await this.get(proposalId) }
      }
      this.assertTargetUncommitted(proposal)
      const promotion = await this.checkPromotion(proposalId)
      await this.checkProductionBaseline(proposalId)
      const request = this.commitRequest(proposal, 'apply', actor, approvalRef)
      // P2: read the candidate object once, verify every digest prepare
      const bytes =
        proposal.targetType === 'capability'
          ? await capabilityBytes(this.root, proposal, 'apply')
          : await (async () => {
              const candidate = await readVerifiedSkillCandidate(this.root, this.skillRoot, proposal)
              return [candidate.skillMd, ...(candidate.sidecar === undefined ? [] : [candidate.sidecar])]
            })()
      await commitIntent(this.commitHost(), request, bytes)
      return {
        targets: request.files.map(file => file.target),
        providers: promotion.providers,
        proposal: await this.get(proposalId),
      }
    })
  }

  /** Preflight for tools before asking for approval; mutation methods repeat the same checks with the grant in hand. */
  async checkPromotion(proposalId: string): Promise<PromotionCheck> {
    const proposal = await this.get(proposalId)
    await this.assertSupportedSource(proposal)
    if (proposal.targetType === 'capability') return this.checkCapabilityPromotion(proposal)
    if (proposal.targetType !== 'skill') throw noEvaluatorRefusal(proposal)
    if (proposal.prepared?.mechanical !== true || proposal.prepared.sandbox == null) {
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" has no materialized candidate — nothing this proposal names was ever ` +
          'evaluated; record a structured candidate and prepare it (evolution_candidate / evolution_prepare) before promoting it',
      )
    }
    // P2: the candidate bytes must still be the ones prepare recorded. This is the verified read a promotion takes.
    await readVerifiedSkillCandidate(this.root, this.skillRoot, proposal)
    const providers = [await this.assertSkillCandidateProvider(proposal)]
    await assertSkillPromotionEvidence(this.promotionSources(), proposal)
    return { providers }
  }

  /** The capability promotion gate, plus the one report a tool needs from it: the roles it proved. */
  private async checkCapabilityPromotion(proposal: EvolutionProposal): Promise<PromotionCheck> {
    await assertCapabilityPromotionEvidence(this.capabilityPromotionSources(), proposal)
    const prepared = await readPreparedCapability(this.root, proposal)
    if (prepared.skill === undefined || prepared.skillDirectory === undefined) return { providers: [] }
    const table = this.effectiveCapabilities()
    if (table === undefined) {
      throw new Error(
        `evolution: the effective capability registry cannot be read in this context, so the provider role of capability candidate ` +
          `"${proposal.proposalId}" cannot be judged — nothing was promoted`,
      )
    }
    const verdict = await this.providerVerdict(
      { name: prepared.skill.name, directory: prepared.skillDirectory, sidecar: prepared.skill.sidecar },
      capabilityTableWith(table, prepared.row),
    )
    if (!verdict.valid) {
      throw new Error(
        `evolution: the new skill "${prepared.skill.name}" of capability candidate "${proposal.proposalId}" is not a usable provider — ` +
          `${verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')}; a promotion installs only a provider a worker could ` +
          'load and whose verifier and tools the deployment can grant',
      )
    }
    return { providers: [promotionProviderOf(verdict)] }
  }

  /** The store and the row pre-check a capability promotion reads, resolved from this context. */
  private capabilityPromotionSources(): CapabilityPromotionSources {
    return {
      ...this.promotionSources(),
      store: () => this.capabilityStore(),
      rowRefusals: (row, sandboxSkillRoot) => this.capabilityRowRefusals(row, sandboxSkillRoot),
    }
  }

  /** The services the promotion gate re-reads from this context: the experiments, the task store, the judges and the session plane. */
  private promotionSources(): SkillPromotionSources {
    const task = optionalService<SkillPromotionSources['task']>(this.ctx, 'task')
    if (task === undefined) {
      throw new Error(
        "evolution: the promotion gate re-reads the experiment's runs, reviews and evidence from the task store, and this " +
          'context has no task service — the evidence cannot be checked, so nothing is promoted',
      )
    }
    return {
      root: this.root,
      experiments: proposalId => this.experiments(proposalId),
      task,
      verifierVocabulary: () => verifierVocabularyOf(this.ctx),
      modelSelection: () => this.modelSelection(),
      sessionLog: sessionId => sessionLog(this.ctx, sessionId),
    }
  }

  /** The candidate object's provider verdict, taken from the directory the run would load it from. */
  private async assertSkillCandidateProvider(proposal: EvolutionProposal): Promise<PromotionProvider> {
    const sandbox = proposal.prepared?.sandbox
    const identity = proposal.prepared?.skillContent
    const baseline = proposal.prepared?.skillBaseline
    const { name } = proposal.mutation as unknown as SkillMutation
    if (sandbox == null || identity === undefined) {
      throw new Error(
        `evolution: proposal "${proposal.proposalId}" names no sandbox or no candidate identity; the candidate's provider role cannot be judged`,
      )
    }
    const directory = resolveWithin(this.root, `${sandbox}/skills/${name}`)
    const expectedFiles = identity.contract === undefined ? ['SKILL.md'] : ['SKILL.md', SKILL_SIDECAR_FILE]
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // A directory that cannot be listed is the validator's to refuse, with
      // the defect its absence deserves (`skill-missing`), not this boundary's.
      entries = []
    }
    const present = entries.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort()
    const unexpected = present.filter(entry => !expectedFiles.includes(entry))
    const missing = expectedFiles.filter(file => !present.includes(file))
    if (unexpected.length > 0 || missing.length > 0) {
      const parts = [
        unexpected.length === 0 ? undefined : `carries ${unexpected.map(entry => JSON.stringify(entry)).join(', ')}`,
        missing.length === 0 ? undefined : `is missing ${missing.map(entry => JSON.stringify(entry)).join(', ')}`,
      ].filter((part): part is string => part !== undefined)
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} ${parts.join(' and ')} — one skill object is a fixed file set ` +
          `(${expectedFiles.map(file => JSON.stringify(file)).join(', ')}, the shape prepare froze), so a candidate whose files moved ` +
          'is refused rather than promoted as an object the frozen evidence never described',
      )
    }
    const verdict = await this.providerVerdict({ name, directory })
    const defects = verdict.valid ? '' : verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')
    if (!verdict.valid) {
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} is not a usable provider — ${defects}; ` +
          'a promotion writes only a skill a worker could load and, when it claims execution, only one whose verifier and tools the deployment can grant',
      )
    }
    if (identity.contract === undefined) {
      if (verdict.role !== 'guidance') {
        throw new Error(
          `evolution: skill candidate "${name}" at ${directory} loads as ${verdict.role}, but the object prepare froze is guidance ` +
            '(no sidecar) — a candidate that changed roles is not the object the experiment evaluated, so the promotion is refused',
        )
      }
      return promotionProviderOf(verdict)
    }
    if (verdict.role !== 'execution-provider') {
      throw new Error(
        `evolution: skill candidate "${name}" at ${directory} loads as ${verdict.role}, but the object prepare froze carries an ` +
          'execution sidecar — a candidate that changed roles is not the object the experiment evaluated, so the promotion is refused',
      )
    }
    const contract = identity.contract
    const championSidecar = await readVerifiedFile(
      this.root,
      `${sandbox}/champion/skills/${name}/${SKILL_SIDECAR_FILE}`,
    )
    if (baseline?.contract === undefined || sha256Hex(championSidecar) !== baseline.contract.sha256) {
      throw new Error(
        `evolution: the champion snapshot of proposal "${proposal.proposalId}" no longer holds the sidecar bytes prepare recorded ` +
          `(sha256 ${sha256Hex(championSidecar)} != ${baseline?.contract?.sha256 ?? 'none recorded'}) — the candidate sidecar is derived ` +
          'from those bytes, so a snapshot that moved cannot be the declaration this promotion would install',
      )
    }
    const candidate = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`)
    if (sha256Hex(candidate) !== identity.sha256) {
      throw new Error(
        `evolution: skill candidate "${sandbox}/skills/${name}/SKILL.md" no longer matches the content identity recorded at prepare ` +
          `(sha256 ${sha256Hex(candidate)} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`,
      )
    }
    const expectedSidecar = candidateSidecar(loadedSidecar(championSidecar), identity.sha256)
    const sandboxSidecar = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`)
    const sandboxText = sandboxSidecar.toString('utf8')
    if (sandboxText !== expectedSidecar || sha256Hex(sandboxSidecar) !== contract.sha256) {
      throw new Error(
        `evolution: the candidate sidecar of skill "${name}" is not the declaration derived from production — the production object ` +
          '(the champion snapshot) with only content.skillMdSha256 rewritten to the candidate SKILL.md digest; a content update may not ' +
          'move capabilities, required tools, verifier or any other declaration field, so the promotion is refused',
      )
    }
    if (verdict.contractDigest !== contract.contractDigest) {
      throw new Error(
        `evolution: the candidate sidecar of skill "${name}" loads to declaration digest ${verdict.contractDigest}, not the ` +
          `${contract.contractDigest} prepared and recorded — a declaration the record does not name is not one this promotion may install`,
      )
    }
    return promotionProviderOf(verdict)
  }

  /** Read a prepared skill candidate's materialized object and verify it against the identity recorded at prepare. */
  async readSkillCandidate(proposalId: string): Promise<{ skillMd: Buffer; sidecar?: Buffer }> {
    return readVerifiedSkillCandidate(this.root, this.skillRoot, await this.get(proposalId))
  }

  /** Read a prepared **capability** candidate back out of its sandbox and verify it. */
  async readCapabilityCandidate(proposalId: string): Promise<PreparedCapability> {
    return readPreparedCapability(this.root, await this.get(proposalId))
  }

  /** The production-baseline check (P3), on the apply seams only: production must still hold the object prepare read. */
  async checkProductionBaseline(proposalId: string): Promise<void> {
    const proposal = await this.get(proposalId)
    if (proposal.targetType === 'capability') return this.assertCapabilityBaseline(proposal)
    await this.assertProductionBaseline(proposal)
  }

  /** The capability candidate's production baseline (A6): the row this proposal replaces must still be the one prepare froze. */
  private async assertCapabilityBaseline(proposal: EvolutionProposal): Promise<void> {
    const prepared = proposal.prepared
    if (prepared?.mechanical !== true || prepared.sandbox == null) return
    const identity = prepared.capabilityRow
    if (identity === undefined) {
      // The fold requires the row identity on every capability prepare, so this
      // branch is a belt for the view's optional field rather than a live state.
      throw new Error(
        `evolution: capability proposal "${proposal.proposalId}" records no frozen row identity — create a new candidate from the current ` +
          'registry state and re-evaluate it',
      )
    }
    const guidance =
      'create a new candidate from the current registry state and re-evaluate it; an apply never overwrites a registry row it cannot verify'
    const table = this.effectiveCapabilities()
    if (table === undefined) {
      throw new Error(
        `evolution: capability-registry-unreadable: the effective capability registry cannot be read in this context, so the row ` +
          `"${identity.name}" proposal "${proposal.proposalId}" was prepared against cannot be compared — nothing was written; ${guidance}`,
      )
    }
    const currentEntry = table[identity.name] ?? null
    const currentDigest = currentEntry === null ? null : capabilityRowDigest(currentEntry)
    const baseline = prepared.capabilityBaseline ?? null
    const preparedDigest = baseline === null ? null : baseline.digest
    if (currentDigest !== preparedDigest) {
      throw new Error(
        `evolution: capability-registry-changed: the registry row "${identity.name}" reads ` +
          `${currentDigest === null ? 'no row' : `sha256 ${currentDigest}`} since prepare (recorded: ${preparedDigest === null ? 'no row' : `sha256 ${preparedDigest}`}) — ` +
          `a row a third party moved is a conflict, so nothing was written; ${guidance}`,
      )
    }
    const skill = prepared.skillContent
    if (skill === undefined) return
    const found = await discoverSkill(await this.skillDiscoveryRoots(), skill.name)
    if (found !== undefined) {
      throw new Error(
        `evolution: skill-baseline-changed: the production skill "${skill.name}" this candidate adds appeared at "${found}" since prepare — ` +
          `this candidate installs a new object and never covers a same-name one, so nothing was written; ${guidance}`,
      )
    }
  }

  private async assertProductionBaseline(proposal: EvolutionProposal): Promise<void> {
    if (proposal.targetType !== 'skill') return
    const prepared = proposal.prepared
    if (prepared?.mechanical !== true || prepared.sandbox == null) return
    const { name } = proposal.mutation as unknown as SkillMutation
    const target = `${this.skillRoot}/${name}/SKILL.md`
    const guidance =
      'create a new candidate from the current production state and re-evaluate it; ' +
      'an apply never overwrites a production skill it cannot verify'
    const identity = prepared.skillBaseline
    if (identity === undefined || identity === null) {
      // The fold requires a non-null baseline on every skill prepare, so this branch is a belt for the view's optional field.
      throw new Error(
        `evolution: skill proposal "${proposal.proposalId}" records no production baseline identity — ${guidance}`,
      )
    }
    let current: { bytes: Buffer; sha256: string } | null
    try {
      current = await readProductionSkill(this.skillRoot, productionSkillRelative(name))
    } catch (error) {
      throw new Error(
        `evolution: the production skill "${target}" is no longer a readable regular file ` +
          `(${(error as Error).message.replace(/^evolution: /, '')}) — ${guidance}`,
      )
    }
    if (current === null) {
      throw new Error(
        `evolution: the production skill "${target}" recorded at prepare (sha256 ${identity.sha256}) no longer exists — ${guidance}`,
      )
    }
    if (current.sha256 !== identity.sha256) {
      throw new Error(
        `evolution: the production skill "${target}" changed since prepare ` +
          `(sha256 ${current.sha256} != ${identity.sha256}) — ${guidance}`,
      )
    }
    let sidecar: { bytes: Buffer; sha256: string } | null
    try {
      sidecar = await readProductionSkill(this.skillRoot, productionSidecarRelative(name))
    } catch (error) {
      throw new Error(
        `evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" is no longer a readable regular file ` +
          `(${(error as Error).message.replace(/^evolution: /, '')}) — ${guidance}`,
      )
    }
    if (identity.contract !== undefined) {
      if (sidecar === null) {
        throw new Error(
          `evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" recorded at prepare ` +
            `(sha256 ${identity.contract.sha256}) no longer exists — ${guidance}`,
        )
      }
      if (sidecar.sha256 !== identity.contract.sha256) {
        throw new Error(
          `evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" changed since prepare ` +
            `(sha256 ${sidecar.sha256} != ${identity.contract.sha256}) — ${guidance}`,
        )
      }
      return
    }
    if (sidecar !== null) {
      throw new Error(
        `evolution: the production skill "${name}" now carries a ${SKILL_SIDECAR_FILE} the baseline prepare recorded did not have ` +
          `(sha256 ${sidecar.sha256}) — the object production would load is not the object the candidate was prepared and evaluated ` +
          `against; ${guidance}`,
      )
    }
  }

  /** Move applied → rolledback: undo the apply by restoring the champion snapshot through the same commit path. */
  async rollback(proposalId: string, actor: string, approvalRef: string): Promise<ApplyOutcome> {
    await this.assertNext(proposalId, 'rolledback')
    nonEmpty(approvalRef, 'approvalRef')
    return this.commitExclusive(async () => {
      const proposal = await this.get(proposalId)
      const open = proposal.openIntent
      if (open !== undefined) {
        if (open.direction !== 'rollback') {
          throw new Error(
            `evolution: proposal "${proposalId}" has an open apply commit intent ("${open.intentId}") — rollback cannot complete an ` +
              'apply; settle that intent (reconcile, or evolution_apply) before rolling anything back',
          )
        }
        const recovered = await this.settleOpenIntent(open)
        return { targets: open.files.map(file => file.target), recovered, proposal: await this.get(proposalId) }
      }
      this.assertTargetUncommitted(proposal)
      const request = this.commitRequest(proposal, 'rollback', actor, approvalRef)
      if (proposal.targetType === 'capability') {
        await this.assertCapabilityApplied(proposal, request)
        await commitIntent(this.commitHost(), request, await capabilityBytes(this.root, proposal, 'rollback'))
        return { targets: request.files.map(file => file.target), proposal: await this.get(proposalId) }
      }
      const prepared = proposal.prepared!
      const applied = prepared.skillContent!
      const name = (proposal.mutation as SkillMutation).name
      // Both files the proposal applied must still be exactly what it applied,
      for (const [index, file] of request.files.entries()) {
        const relative = index === 0 ? productionSkillRelative(name) : productionSidecarRelative(name)
        const expected = index === 0 ? applied.sha256 : applied.contract!.sha256
        const current = await readProductionSkill(this.skillRoot, relative)
        if (current === null || current.sha256 !== expected) {
          throw new Error(
            `evolution: the production file "${file.target}" does not hold the content proposal "${proposalId}" applied ` +
              `(sha256 ${current?.sha256 ?? 'missing'} != ${expected}) — a rollback restores the baseline of the object this proposal ` +
              'applied, and a file another writer (or a later proposal) changed is left exactly as it is: nothing was written and no ' +
              'commit intent was recorded',
          )
        }
      }
      const championFiles: Buffer[] = []
      for (const [index, file] of request.files.entries()) {
        const expected = index === 0 ? prepared.skillBaseline!.sha256 : prepared.skillBaseline!.contract!.sha256
        const snapshot = await readVerifiedFile(this.root, file.source!)
        const digest = sha256Hex(snapshot)
        if (digest !== expected) {
          throw new Error(
            `evolution: the champion snapshot "${file.source}" of proposal "${proposalId}" no longer hashes to the production ` +
              `baseline recorded at prepare (sha256 ${digest} != ${expected}) — the snapshot cannot restore the bytes it captured: ` +
              'nothing was written and no commit intent was recorded',
          )
        }
        championFiles.push(snapshot)
      }
      await commitIntent(this.commitHost(), request, championFiles)
      return { targets: request.files.map(file => file.target), proposal: await this.get(proposalId) }
    })
  }

  /** What a capability rollback must still find before it may be recorded (A6): the row this apply installed. */
  private async assertCapabilityApplied(proposal: EvolutionProposal, request: CommitRequest): Promise<void> {
    const prepared = proposal.prepared!
    const identity = prepared.capabilityRow!
    const table = this.effectiveCapabilities()
    if (table === undefined) {
      throw new Error(
        `evolution: the effective capability registry cannot be read in this context, so the row proposal "${proposal.proposalId}" ` +
          'applied cannot be compared — nothing was written and no commit intent was recorded',
      )
    }
    const current = table[identity.name] ?? null
    const digest = current === null ? null : capabilityRowDigest(current)
    if (digest !== identity.digest) {
      throw new Error(
        `evolution: the registry row "${identity.name}" does not hold the row proposal "${proposal.proposalId}" applied ` +
          `(${digest === null ? 'no row' : `sha256 ${digest}`} != sha256 ${identity.digest}) — a rollback restores the baseline of the ` +
          'state this proposal installed, and a row another writer (or a later proposal) changed is left exactly as it is: nothing was ' +
          'written and no commit intent was recorded',
      )
    }
    for (const [index, file] of request.files.entries()) {
      const expected = index === 0 ? prepared.skillContent!.sha256 : prepared.skillContent!.contract!.sha256
      const currentFile = await readProductionSkill(this.skillRoot, relative(this.skillRoot, file.target))
      if (currentFile === null || currentFile.sha256 !== expected) {
        throw new Error(
          `evolution: the production file "${file.target}" does not hold the content proposal "${proposal.proposalId}" applied ` +
            `(sha256 ${currentFile?.sha256 ?? 'missing'} != ${expected}) — a file another writer (or a later proposal) changed is left ` +
            'exactly as it is: nothing was written and no commit intent was recorded',
        )
      }
    }
  }

  /** Settle every open commit intent, in ledger order (K2) — the explicit startup entry. */

  /** The two-sided experiment entry (§F.2). The orchestrator itself lives in `experiment/`. */
  async runExperiment(
    spec: ExperimentSpec,
    caller: SessionId,
    actor: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExperimentResult> {
    await this.assertSupportedSource(await this.get(spec.proposalId), await this.storeOfSession(String(caller)))
    return runExperiment(this.experimentSources(), {
      spec,
      caller,
      actor,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  /** Continue a frozen experiment by id. Its specification *is* the recorded spec. */
  async resumeExperiment(
    experimentId: string,
    caller: SessionId,
    actor: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExperimentResult> {
    const experiment = await this.experiment(experimentId)
    await this.assertSupportedSource(
      await this.get(experiment.proposalId),
      experiment.storeId ?? (await this.storeOfSession(String(caller))),
    )
    return resumeExperiment(this.experimentSources(), {
      experimentId,
      caller,
      actor,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  }

  /** Re-read the proposal's Diagnosis against the experiment's own task store before any executable step. */
  private async assertSupportedSource(proposal: EvolutionProposal, storeId?: string): Promise<void> {
    const diagnosisIds = proposal.sourceRefs
      .filter(ref => ref.startsWith('diagnosis:'))
      .map(ref => ref.slice('diagnosis:'.length))
    if (diagnosisIds.length === 0) return
    const experimentStoreId = storeId ?? (await this.experiments(proposal.proposalId))[0]?.storeId
    if (experimentStoreId === undefined) return
    const task = optionalService<{ openStore(storeId: string): Promise<TaskSnapshot> }>(this.ctx, 'task')
    if (task === undefined) return
    const snapshot = await task.openStore(experimentStoreId)
    for (const diagnosisId of diagnosisIds) {
      const diagnosis = snapshot.diagnoses?.find(item => item.diagnosisId === diagnosisId)
      // Generic S4-E proposals historically carry opaque sourceRefs; only a resolvable diagnosis ref yields a hand-off target.
      if (diagnosis === undefined) continue
      const source = snapshot.tasks.find(item => item.taskId === diagnosis.taskId)
      if (source === undefined) {
        throw new Error(
          `evolution: diagnosis "${diagnosisId}" names a task absent from store "${experimentStoreId}"; no experiment, promotion or application was started`,
        )
      }
      const successfulRun = diagnosis.reviewRefs.some(ref => {
        const separator = ref.lastIndexOf('#')
        if (separator < 0 || ref.slice(0, separator) !== source.taskId) return false
        const runId = ref.slice(separator + 1)
        return snapshot.runs.some(
          run => run.runId === runId && run.taskId === source.taskId && run.status === 'verified',
        )
      })
      if (source.status === 'verified' || successfulRun) {
        throw new Error(
          `evolution: diagnosis "${diagnosisId}" names a successful source task/run, and this build has no frozen metric or comparator ` +
            'for "faster or cheaper"; its suggestion remains recorded, with zero experiment, promotion, application or new business Run',
        )
      }
    }
  }

  /** The services one experiment runs on, resolved softly: the ledger, the task store, the runtime seam and the judge vocabulary. */
  private experimentSources(): ExperimentSources {
    const graphs = optionalService<ExperimentSources['graphs']>(this.ctx, 'graphs')
    const task = optionalService<ExperimentSources['task']>(this.ctx, 'task')
    const taskRuntime = optionalService<ExperimentSources['taskRuntime']>(this.ctx, 'taskRuntime')
    if (graphs === undefined || task === undefined || taskRuntime === undefined) {
      throw new Error(
        'evolution: the two-sided experiment needs the graphs, task and taskRuntime services in this context ' +
          `(missing: ${[graphs === undefined ? 'graphs' : undefined, task === undefined ? 'task' : undefined, taskRuntime === undefined ? 'taskRuntime' : undefined].filter(Boolean).join(', ')})`,
      )
    }
    return {
      evolution: this,
      graphs,
      task,
      taskRuntime: {
        replayTask: (storeId: string, championTaskId: string, options: ReplayTaskOptions, callerSessionId: string) =>
          taskRuntime.replayTask(storeId, championTaskId, options, callerSessionId),
        capabilityProviderReport: (sessionId: string, capabilities?: readonly string[]) =>
          taskRuntime.capabilityProviderReport(sessionId, capabilities),
        ...(typeof (taskRuntime as { listCapabilities?: unknown }).listCapabilities === 'function'
          ? {
              listCapabilities: () =>
                (taskRuntime as { listCapabilities(): Readonly<Record<string, CapabilityConfig>> }).listCapabilities(),
            }
          : {}),
        /** The runtime's own provider pre-check over the overlay table (A6): the candidate's composed table. */
        precheckCapabilityTable: async (request: {
          capabilities: readonly string[]
          table: Readonly<Record<string, CapabilityConfig>>
          extraRoots: readonly string[]
        }) => {
          const verifierRefs = await registeredVerifierIds(this.ctx)
          return precheckProviders({
            capabilities: request.capabilities,
            table: request.table,
            view: { extraRoots: [...request.extraRoots] },
            ...(verifierRefs === undefined ? {} : { verifierRefs }),
            commitLedger: this,
          })
        },
      },
      // Both freeze-time reads go through the same entries every other consumer
      verifierVocabulary: () => verifierVocabularyOf(this.ctx),
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    evolution: EvolutionService
  }
  interface Events {
    'evolution/change'(change: { proposalId: string }): void
  }
}

export { APPLYABLE_TARGET_TYPES, EVOLUTION_DECISIONS, renderProviderRoles } from './types.ts'
export type {
  ApplyOutcome,
  CommitCapability,
  CommitDirection,
  CommitIntentRecord,
  CommitIntentView,
  Config,
  EvolutionDecision,
  EvolutionLevel,
  EvolutionProposal,
  EvolutionRecord,
  EvolutionStatus,
  GateAnswers,
  PreparedView,
  PromotionCheck,
  ProposeInput,
  SkillMutation,
} from './types.ts'
export { applyTargets } from './ledger/state-machine.ts'
export type {
  RecoveryCoordinationCaller,
  RecoveryCoordinationOutcome,
  RecoveryCoordinationRequest,
  SupervisorDelegation,
} from './ledger/records.ts'

export default EvolutionService
