/**
 * `method_draft`: propose one candidate method. The model names one mechanism,
 * the asset's identity and its complete new content; the tool checks the base
 * revision, the round's edit budget, the asset's structure and the pre-measurement
 * screen, and only then records the draft. A candidate the screen refuses leaves
 * no ledger line and consumes no evaluation budget.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-draft
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityConfig, McpServerTemplate } from '@dangosys/dsh-singularity-task-runtime'
import type { TaskTemplate } from '@dangosys/dsh-singularity-task'
import type { CriticVerdict, DeclaredEdit, MethodAssetKind } from '@dangosys/dsh-singularity-evolution'
import type { EnvironmentEdit } from '@dangosys/dsh-singularity-task-runtime'
import { message, sessionId, text, undeclaredParameters } from '../shared.ts'
import { environmentPlaneOf, methodLedgerPlaneOf, strategyPlaneOf } from './method-shared.ts'

const PARAMETERS = [
  'kind', 'identity', 'edits', 'editPayload', 'rationale', 'sourceRefs', 'expectedBaseRevision', 'round', 'critic',
] as const

/** One declared edit, as the tool's own parameter shape reads it. */
function declaredEditsOf(raw: unknown): DeclaredEdit[] {
  if (!Array.isArray(raw)) throw new Error('edits must be an array of {id, mechanism, hypothesis?, targets?}')
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`edits[${index}] must be an object`)
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) throw new Error(`edits[${index}].id must be a non-empty string`)
    if (typeof record.mechanism !== 'string') throw new Error(`edits[${index}].mechanism must name a mechanism`)
    return {
      id: record.id,
      mechanism: record.mechanism as DeclaredEdit['mechanism'],
      ...(typeof record.hypothesis === 'string' ? { hypothesis: record.hypothesis } : {}),
      targets: Array.isArray(record.targets) ? record.targets.filter((item): item is string => typeof item === 'string') : [],
    }
  })
}

function criticOf(raw: unknown): CriticVerdict | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null) throw new Error('critic must be an object {verdict, reason, evidenceRefs}')
  const record = raw as Record<string, unknown>
  if (record.verdict !== 'accept' && record.verdict !== 'reject') throw new Error('critic.verdict must be accept or reject')
  if (typeof record.reason !== 'string' || record.reason.length === 0) throw new Error('critic.reason must be non-empty free text')
  if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0) throw new Error('critic.evidenceRefs must cite at least one reference')
  return {
    verdict: record.verdict,
    reason: record.reason,
    evidenceRefs: record.evidenceRefs.filter((item): item is string => typeof item === 'string'),
    criticId: `draft-critic:${record.verdict}`,
    at: new Date().toISOString(),
  }
}

/** The complete asset content one candidate stages, in this asset kind's own shape. */
function editOf(kind: MethodAssetKind, identity: string, payload: string, actor: string, currentVersion: number): EnvironmentEdit {
  if (kind === 'skill') {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      parsed = undefined
    }
    if (typeof parsed === 'string') return { kind: 'skill', edit: { name: identity, skillMd: parsed, actor, expectedVersion: currentVersion } }
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'skill', edit: { name: identity, skillMd: payload, actor, expectedVersion: currentVersion } }
    const record = parsed as Record<string, unknown>
    if (typeof record.skillMd !== 'string' || record.skillMd.trim().length === 0) {
      throw new Error('a skill candidate\'s editPayload must carry skillMd (the complete SKILL.md), or be the SKILL.md text itself')
    }
    const resources = record.resources
    return {
      kind: 'skill',
      edit: {
        name: identity,
        skillMd: record.skillMd,
        ...(resources === undefined || typeof resources !== 'object' || resources === null
          ? {}
          : { resources: resources as Record<string, string> }),
        // The version the candidate is written against comes from the active
        // revision, never from a number the model filled in.
        expectedVersion: currentVersion,
        actor,
      },
    }
  }
  if (kind === 'task-template') {
    const parsed = parsePayload(payload)
    const template = parsed.template
    if (typeof template !== 'object' || template === null) throw new Error('a task-template candidate\'s editPayload must carry template (the complete template)')
    if ((template as { id?: unknown }).id !== identity) {
      throw new Error(`a task-template candidate's identity "${identity}" must be the template's own id`)
    }
    return { kind: 'task', edit: { template: template as unknown as TaskTemplate, actor } }
  }
  const parsed = parsePayload(payload)
  const entry = parsed.entry === undefined ? { ...parsed } : parsed.entry
  if (entry !== null && (typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error('a capability candidate\'s editPayload must carry entry (the complete row, or null to remove it)')
  }
  const mcpServers = parsed.mcpServers
  return {
    kind: 'capability',
    edit: {
      name: identity,
      entry: entry as CapabilityConfig | null,
      ...(mcpServers === undefined || typeof mcpServers !== 'object' || mcpServers === null
        ? {}
        : { mcpServers: mcpServers as Record<string, McpServerTemplate | null> }),
      actor,
    },
  }
}

function parsePayload(payload: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    throw new Error(`editPayload is not readable JSON (${message(error)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('editPayload must be a JSON object')
  return parsed as Record<string, unknown>
}

/** The version of one skill in the active revision, `0` when the name is new. */
function versionOf(skills: readonly { readonly name: string; readonly version: number }[], identity: string): number {
  return skills.find(skill => skill.name === identity)?.version ?? 0
}

export function defineMethodDraftTool(ctx: Context) {
  return defineTool({
    name: 'method_draft',
    description:
      'Propose one candidate method for this graph library. Name one asset kind, its stable identity, the complete new content, ' +
      'the experiments this evidence answers and the independent mechanism you are testing. The base revision must be the active ' +
      'one, and the number of independent edits must fit the round\'s frozen edit budget. The candidate is checked for structure ' +
      'and screened before any measurement: a refusal names its reason and consumes no evaluation budget. Nothing becomes effective ' +
      'until method_publish switches the pointer. Next: method_evaluate.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['skill', 'task-template', 'capability'], description: 'Which asset class this candidate changes' },
      identity: { type: 'string', required: true, description: 'The asset\'s stable identity: a skill name, a template id, or a capability row name' },
      edits: {
        type: 'array',
        required: true,
        description: 'The independent mechanism(s) this candidate declares: [{id, mechanism, hypothesis?, targets?}]',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', description: 'This edit\'s own id' },
            mechanism: { type: 'string', enum: ['skill', 'capability', 'task-template', 'text', 'parameter'], description: 'The mechanism the change belongs to' },
            hypothesis: { type: 'string', description: 'What this edit is testing' },
            targets: { type: 'array', items: { type: 'string' }, description: 'The asset paths the edit really touches' },
          },
        },
      },
      editPayload: { type: 'string', required: true, description: 'The complete new content as JSON: {"skillMd":…,"resources":…} for a skill (or the SKILL.md text itself), {"template":…} for a task template, {"entry":…,"mcpServers":…} for a capability row' },
      rationale: { type: 'string', required: true, description: 'Why this candidate is worth measuring' },
      sourceRefs: { type: 'array', required: true, items: { type: 'string' }, description: 'The recorded evidence this candidate answers: diagnosis:<id>, task:<taskId>#<runId>, or an evidence id' },
      expectedBaseRevision: { type: 'string', required: true, description: 'The active revision id this candidate was written against; a pointer that moved refuses the draft' },
      round: { type: 'integer', required: true, description: 'The search round this candidate belongs to; the edit budget is derived from it' },
      critic: {
        type: 'object',
        description: 'The one independent pre-measurement critic verdict: {verdict: accept|reject, reason, evidenceRefs}',
        additionalProperties: true,
        properties: {
          verdict: { type: 'string', enum: ['accept', 'reject'] },
          reason: { type: 'string' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args as Record<string, unknown>, PARAMETERS, 'method_draft')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'method_draft')
      const kind = args.kind as MethodAssetKind
      try {
        if (typeof args.identity !== 'string' || args.identity.length === 0) throw new Error('identity must be a non-empty string')
        if (typeof args.rationale !== 'string' || args.rationale.length === 0) throw new Error('rationale must be non-empty free text')
        if (typeof args.editPayload !== 'string' || args.editPayload.length === 0) throw new Error('editPayload must carry the complete new content')
        if (typeof args.expectedBaseRevision !== 'string' || args.expectedBaseRevision.length === 0) throw new Error('expectedBaseRevision is required')
        if (!Array.isArray(args.sourceRefs) || args.sourceRefs.length === 0) throw new Error('sourceRefs must name at least one recorded reference')
        if (!Number.isInteger(args.round) || (args.round as number) < 0) throw new Error('round must be a non-negative integer')
        const edits = declaredEditsOf(args.edits)
        const critic = criticOf(args.critic)

        const env = environmentPlaneOf(ctx)
        const ledger = await methodLedgerPlaneOf(ctx, caller)
        // The graph's own strategy switch: the budget and the screen run under
        // the same policy the evaluation will freeze into its plan.
        const strategy = strategyPlaneOf(ledger.policy)
        const view = await env.activeEnvironmentView(caller)
        if (view.readOnly) {
          return [
            `method_draft rejected: library "${view.libraryId}" is read-only (${view.protocol}); a sealed or legacy graph takes no draft.`,
            'nothing was created.',
          ].join(' ')
        }
        if (view.revisionId !== args.expectedBaseRevision) {
          return [
            `method_draft rejected: the active revision is "${view.revisionId}", not the "${args.expectedBaseRevision}" this candidate was written against —`,
            'the pointer moved (this round, or another session); re-read the library and re-author the candidate.',
            'nothing was created.',
          ].join(' ')
        }
        const budget = strategy.editBudget(args.round as number, strategy.policy)
        const verified = edits.filter(edit => edit.mechanismUnverified !== true)
        if (edits.length === 0) return 'method_draft rejected: a candidate declares at least one independent edit; nothing was created.'
        if (verified.length > budget) {
          return [
            `method_draft rejected: ${verified.length} independent edits exceed the round ${String(args.round)} budget of ${budget}`,
            '(the frozen policy anneals the budget down to one edit in the last round); nothing was created and no evaluation budget was consumed,',
            'so this refusal does not enter the measured history.',
          ].join(' ')
        }

        const draft = await env.createDraft(caller, { basedOn: view.revisionId, purpose: args.rationale })
        const refuse = async (detail: string): Promise<string> => {
          await env.removeEnvironmentDraft(caller, draft.draftId)
          return `${detail} (draft ${draft.draftId} removed; nothing was recorded and no evaluation budget was consumed)`
        }
        let staged
        try {
          staged = await env.stageDraftEdit(caller, draft.draftId, editOf(kind, args.identity, args.editPayload, caller, versionOf(view.skills, args.identity)))
        } catch (error) {
          return await refuse(`method_draft rejected: the candidate content is not a ${kind} this library can hold — ${message(error)};`)
        }
        const baseRevision = { revisionId: view.revisionId, digest: view.manifestDigest, libraryId: view.libraryId }
        const structure = await ledger.prepareStructure({
          draftId: staged.draftId,
          kind,
          identity: args.identity,
          baseRevision,
          candidateRevision: { revisionId: staged.manifest.revisionId, digest: staged.manifest.contentDigest },
          rationale: args.rationale,
          sourceRefs: [...(args.sourceRefs as string[])],
          actor: caller,
        })
        const screen = strategy.screenBeforeMeasurement({
          round: args.round as number,
          edits,
          structure: { ok: structure.ok, findings: structure.findings },
          ...(critic === undefined ? {} : { critic }),
          policy: strategy.policy,
        })
        if (!screen.ok) {
          const criticNote =
            screen.reasonCode === 'critic-missing'
              ? ' This round carries no independent critic verdict, and the frozen policy requires one before any measurement — the candidate is refused rather than measured silently.'
              : ''
          return await refuse(`method_draft rejected: ${screen.reasonCode} — ${screen.reason}.${criticNote}`)
        }

        const facts = await ledger.history()
        const refutation = strategy.refutationFor(facts, view.libraryId, staged.manifest.contentDigest)
        if (refutation !== undefined) {
          return await refuse(
            `method_draft rejected: this candidate's bytes (${staged.manifest.contentDigest.slice(0, 12)}…) were already refused by ` +
              `draft ${refutation.refutation.candidateId} (${refutation.kind}) — ${refutation.refutation.reason}. Use method_discard on this draft, or add new evidence and a new repetition.`,
          )
        }

        await ledger.createDraft({
          draftId: staged.draftId,
          kind,
          identity: args.identity,
          baseRevision,
          candidateRevision: { revisionId: staged.manifest.revisionId, digest: staged.manifest.contentDigest, files: structure.files },
          rationale: args.rationale,
          sourceRefs: [...(args.sourceRefs as string[])],
          actor: caller,
        })
        return [
          `method_draft: ${kind} "${args.identity}" recorded as draft ${staged.draftId}`,
          `  base revision ${view.revisionId} (${view.manifestDigest.slice(0, 12)}) → candidate ${staged.manifest.revisionId} (${staged.manifest.contentDigest.slice(0, 12)})`,
          `  name: ${structure.change.identity}; before ${structure.change.before === null ? '(absent)' : structure.change.before.slice(0, 12)} → after ${structure.change.after.slice(0, 12)}`,
          `  bundle level: ${screen.bundleLevel ? 'yes (more than one independent edit)' : 'no'}; round ${String(args.round)} edit budget ${budget}`,
          `  files: ${structure.files.map(file => file.path).join(', ') || '(none)'}`,
          '  no production change; next: method_evaluate (frozen cohort, both sides, at least three repetitions)',
        ].join('\n')
      } catch (error) {
        return `method_draft rejected: ${message(error)}`
      }
    },
  })
}
