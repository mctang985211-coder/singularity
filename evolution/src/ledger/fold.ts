/** Folding the append-only ledger into the proposal map: the one fold every read path of this plane goes through.
 * @module dsh-singularity-evolution/ledger/fold */

import { isExperimentRecord } from '../experiment/freeze.ts'
import {
  preparedCapabilityTable,
  preparedIdentity,
  preparedRowIdentity,
  validateCommitIntent,
  validateGateAnswers,
  validateMutation,
  validateVersionSet,
} from './records.ts'
import { assertTransition } from './state-machine.ts'
import type {
  CommitDirection,
  CommitIntentView,
  EvolutionProposal,
  EvolutionRecord,
  EvolutionStatus,
} from '../types.ts'

/** Fold records into proposals, enforcing the state machine on every step, so one wrong transition refuses the whole ledger. */
export function fold(records: readonly EvolutionRecord[]): Map<string, EvolutionProposal> {
  const proposals = new Map<string, EvolutionProposal>()
  for (const record of records) {
    if (isExperimentRecord(record)) continue
    if (record.kind === 'commit_intent') {
      const current = proposals.get(record.proposalId)
      if (current === undefined) throw new Error(`evolution: unknown proposal "${record.proposalId}"`)
      validateCommitIntent(record)
      const intent: CommitIntentView = {
        intentId: record.intentId,
        proposalId: record.proposalId,
        direction: record.direction,
        approvalRef: record.approvalRef,
        files: record.files.map(file => ({ ...file })),
        ...(record.capability === undefined ? {} : { capability: { ...record.capability } }),
        actor: record.actor,
        at: record.at,
      }
      if (record.intentId !== `${record.proposalId}/${record.direction}`) {
        throw new Error(
          `evolution: commit_intent record for "${record.proposalId}" names intentId "${record.intentId}" — an intent's id is ` +
            `"<proposalId>/<direction>", so this one is "${record.proposalId}/${record.direction}"`,
        )
      }
      if (current.openIntent !== undefined) {
        throw new Error(
          `evolution: proposal "${record.proposalId}" already has the open commit intent "${current.openIntent.intentId}" — one ` +
            `commit at a time: the intent for "${record.intentId}" is refused until that one is completed or settled`,
        )
      }
      const requiredStatus: EvolutionStatus = record.direction === 'apply' ? 'decided' : 'applied'
      if (current.status !== requiredStatus) {
        throw new Error(
          `evolution: commit_intent record "${record.intentId}" needs proposal "${record.proposalId}" to be ${requiredStatus} ` +
            `(it is ${current.status}) — an apply commits a decided proposal and a rollback an applied one`,
        )
      }
      current.openIntent = intent
      continue
    }
    const current = proposals.get(record.proposalId)
    if (record.kind === 'proposed') {
      if (current !== undefined) throw new Error(`evolution: proposal "${record.proposalId}" already exists`)
      proposals.set(record.proposalId, {
        proposalId: record.proposalId,
        targetType: record.targetType,
        targetId: record.targetId,
        baseVersion: record.baseVersion,
        level: record.level,
        rationale: record.rationale,
        sourceRefs: [...record.sourceRefs],
        status: 'proposed',
        history: [{ status: 'proposed', actor: record.actor, at: record.at }],
      })
      continue
    }
    if (current === undefined) throw new Error(`evolution: unknown proposal "${record.proposalId}"`)
    assertTransition(current, record.kind)
    current.history.push({ status: record.kind, actor: record.actor, at: record.at })
    switch (record.kind) {
      case 'candidate': {
        // One candidate lifecycle per admissible target type (S4-E 收尾, A6): a skill replacement or one capability row.
        if (current.targetType !== 'skill' && current.targetType !== 'capability') {
          throw new Error(
            `evolution: candidate record for "${record.proposalId}" targets "${current.targetType}" — this build's candidate ` +
              'lifecycles are a SKILL.md replacement of an existing skill object and one whole capability row with an optional new ' +
              'execution skill, and no other target type has an evaluator here',
          )
        }
        validateVersionSet(record.versionSet)
        validateMutation(current.targetType, record.mutation)
        current.mutation = structuredClone(record.mutation)
        current.versionSet = { ...record.versionSet }
        break
      }
      case 'prepared': {
        // One prepared shape per candidate lifecycle: the materialized skill
        const capabilityPrepare = current.targetType === 'capability'
        const champion = capabilityPrepare ? 'absent' : 'captured'
        if (
          record.mechanical !== true ||
          record.champion !== champion ||
          typeof record.sandbox !== 'string' ||
          record.sandbox.length === 0
        ) {
          throw new Error(
            `evolution: prepared record for "${record.proposalId}" is not a materialized prepare of its own candidate type ` +
              `(mechanical=${String(record.mechanical)}, champion=${JSON.stringify(record.champion ?? null)}, ` +
              `sandbox=${JSON.stringify(record.sandbox ?? null)}, targetType=${JSON.stringify(current.targetType)}) — this build prepares a ` +
              'replacement of one existing skill object (champion "captured") or one capability row with an optional new skill object ' +
              '(champion "absent", A6), and nothing else',
          )
        }
        if (!Array.isArray(record.files) || record.files.some(file => typeof file !== 'string')) {
          throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`)
        }
        if (capabilityPrepare) {
          // The capability half (A6): the frozen row is required, the row the registry held is optional (`null` when it held none).
          const capabilityRow = preparedRowIdentity(record.capabilityRow, 'capabilityRow', record.proposalId)
          if (record.capabilityBaseline === undefined) {
            throw new Error(
              `evolution: prepared record for "${record.proposalId}" records no capabilityBaseline — every capability prepare records ` +
                'the row the registry held, or `null` for the absence it read, so "this candidate adds the row" and "this candidate ' +
                'replaces it" can never be confused',
            )
          }
          const capabilityBaseline =
            record.capabilityBaseline === null
              ? null
              : preparedRowIdentity(record.capabilityBaseline, 'capabilityBaseline', record.proposalId)
          const skillContent =
            record.skillContent === undefined
              ? undefined
              : preparedIdentity(record.skillContent, 'skillContent', record.proposalId)
          if (skillContent === undefined) {
            if (record.skillBaseline !== undefined) {
              throw new Error(
                `evolution: prepared record for "${record.proposalId}" records a skill baseline without a candidate identity — a ` +
                  'capability prepare that carries no new skill records neither half',
              )
            }
          } else {
            if (record.skillBaseline !== null) {
              throw new Error(
                `evolution: prepared record for "${record.proposalId}" records a production skill baseline for a capability candidate's ` +
                  'new object — a capability candidate adds a skill, so its baseline is the recorded absence (`null`); improving an ' +
                  'existing object is the same-name path',
              )
            }
            if (skillContent.contract === undefined) {
              throw new Error(
                `evolution: prepared record for "${record.proposalId}" records a new skill without a declaration — a capability ` +
                  "candidate's skill is an execution provider (SKILL.md plus SKILL.contract.json)",
              )
            }
          }
          const capabilityTable = preparedCapabilityTable(record.capabilityTable, 'capabilityTable', record.proposalId)
          current.prepared = {
            sandbox: record.sandbox,
            mechanical: true,
            champion: 'absent',
            ...(skillContent === undefined ? {} : { skillContent }),
            ...(skillContent === undefined ? {} : { skillBaseline: null }),
            capabilityRow,
            capabilityBaseline,
            ...(capabilityTable === undefined ? {} : { capabilityTable }),
            files: [...record.files],
          }
          break
        }
        // P2/P3, required (S4-E 收尾): a prepare without the candidate's
        const skillContent = preparedIdentity(record.skillContent, 'skillContent', record.proposalId)
        const skillBaseline = preparedIdentity(record.skillBaseline, 'skillBaseline', record.proposalId)
        // The object's shape is fixed at prepare: one half with a sidecar and the other without is a mixed object, refused.
        if ((skillContent.contract === undefined) !== (skillBaseline.contract === undefined)) {
          throw new Error(
            `evolution: prepared record for "${record.proposalId}" mixes object shapes — its candidate identity is ` +
              `${skillContent.contract === undefined ? 'guidance (no sidecar)' : 'an execution object (with a sidecar)'} while its ` +
              `production baseline is ${skillBaseline.contract === undefined ? 'guidance (no sidecar)' : 'an execution object (with a sidecar)'} ` +
              '— one prepare freezes one object, so a candidate that changed roles is refused at the fold',
          )
        }
        if (record.capabilityTable !== undefined) {
          throw new Error(
            `evolution: prepared record for "${record.proposalId}" records a capability table identity — a prepare freezes the table file ` +
              'of the one row a *capability* candidate writes, and a skill prepare writes no row at all',
          )
        }
        current.prepared = {
          sandbox: record.sandbox,
          mechanical: true,
          champion: 'captured',
          skillContent,
          skillBaseline,
          files: [...record.files],
        }
        break
      }
      case 'gated':
        validateGateAnswers(record.gate)
        current.gate = record.gate
        break
      case 'decided':
        current.decision = record.decision
        if (record.note !== undefined) current.decisionNote = record.note
        // The human review is not optional (S4-E 收尾): `decide` writes the approval ref every decision must carry.
        if (typeof record.approvalRef !== 'string' || record.approvalRef.length === 0) {
          throw new Error(
            `evolution: decided record for "${record.proposalId}" has no human-approval evidence ref — every decision this build ` +
              'records was granted through a human approval and carries that call id',
          )
        }
        current.decisionApprovalRef = record.approvalRef
        break
      case 'applied':
      case 'rolledback': {
        if (
          !Array.isArray(record.targets) ||
          record.targets.some(target => typeof target !== 'string' || target.length === 0) ||
          (record.targets.length === 0 && current.openIntent?.capability === undefined)
        ) {
          throw new Error(
            `evolution: ${record.kind} record for "${record.proposalId}" has a malformed target list — a completion records the file set its ` +
              'commit wrote, and only a row-only capability commit writes no file at all',
          )
        }
        if (typeof record.approvalRef !== 'string' || record.approvalRef.length === 0) {
          throw new Error(
            `evolution: ${record.kind} record for "${record.proposalId}" has no human-approval evidence ref`,
          )
        }
        // K2: the completion closes the open intent of its own direction, and must name it.
        if (typeof record.intentId !== 'string' || record.intentId.length === 0) {
          throw new Error(
            `evolution: ${record.kind} record for "${record.proposalId}" names no commit intent — every completion this build ` +
              'writes closes the `commit_intent` line its commit persisted before the write, and carries that intentId',
          )
        }
        const open = current.openIntent
        const expectedDirection: CommitDirection = record.kind === 'applied' ? 'apply' : 'rollback'
        if (open === undefined) {
          throw new Error(
            `evolution: ${record.kind} record for "${record.proposalId}" closes no open commit intent — a production write is ` +
              `recorded as one commit (commit_intent first, the atomic write, then ${record.kind}), so a completion with no matching ` +
              'open intent is refused',
          )
        }
        if (open.direction !== expectedDirection || open.intentId !== record.intentId) {
          throw new Error(
            `evolution: ${record.kind} record for "${record.proposalId}" names commit intent "${record.intentId}", but the open ` +
              `intent of that proposal is "${open.intentId}" (${open.direction}) — a ${expectedDirection} completion closes its own ` +
              `${expectedDirection} intent and nothing else`,
          )
        }
        if (record.approvalRef !== open.approvalRef) {
          throw new Error(
            `evolution: ${record.kind} record for "${record.proposalId}" carries approval ${JSON.stringify(record.approvalRef)}, not ` +
              `the approval the open intent "${open.intentId}" recorded (${JSON.stringify(open.approvalRef)}) — the completion is ` +
              'written for the grant the commit was authorised by, never a second one',
          )
        }
        const expectedTargets = open.files.map(file => file.target)
        if (
          record.targets.length !== expectedTargets.length ||
          record.targets.some((target, index) => target !== expectedTargets[index])
        ) {
          throw new Error(
            `evolution: ${record.kind} record for "${record.proposalId}" names targets ${JSON.stringify(record.targets)}, but the ` +
              `open intent "${open.intentId}" commits ${JSON.stringify(expectedTargets)} — a completion records the exact file set its ` +
              "intent committed, in the intent's own order",
          )
        }
        current[record.kind] = { targets: [...record.targets], approvalRef: record.approvalRef }
        current.openIntent = undefined
        break
      }
    }
    current.status = record.kind
  }
  return proposals
}
