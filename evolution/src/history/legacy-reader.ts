/**
 * The legacy projection: a `formatVersion: 4` ledger read for display only. It
 * never adopts, restores, publishes or writes progress — a graph without the new
 * protocol marker is history, and this is the one reader that shows its shape.
 */

import { readFile } from 'node:fs/promises'
import { isRecord } from '../shared.ts'

/** The seven legacy lifecycle states, kept only so a reader can name what it saw. */
export type LegacyMethodStatus = 'proposed' | 'candidate' | 'prepared' | 'gated' | 'decided' | 'applied' | 'rolledback'

/** One open legacy commit intent, as the projection shows it. */
export interface LegacyCommitIntent {
  readonly intentId: string
  readonly direction: 'apply' | 'rollback'
  readonly approvalRef: string
  readonly files: readonly string[]
  readonly capability?: string
}

/** One legacy proposal, projected read-only. */
export interface LegacyMethodView {
  readonly proposalId: string
  readonly targetType: string
  readonly targetId: string
  readonly baseVersion: string
  readonly level: string
  readonly rationale: string
  readonly status: LegacyMethodStatus
  readonly decision?: string
  readonly decisionNote?: string
  readonly intent?: LegacyCommitIntent
  readonly appliedTargets?: readonly string[]
  readonly rolledbackTargets?: readonly string[]
  /** The experiments the ledger recorded under this proposal, in ledger order. */
  readonly experiments: readonly string[]
  readonly history: readonly { readonly status: string; readonly actor: string; readonly at: string }[]
}

/** The status one projected proposal reads as — the record kind itself, never a recomputation. */
export function legacyStatusOf(view: LegacyMethodView): LegacyMethodStatus {
  return view.status
}

function ownerOf(record: Record<string, unknown>): string | undefined {
  if (typeof record.libraryId === 'string') return record.libraryId
  const frozen = record.frozen
  return isRecord(frozen) && typeof frozen.libraryId === 'string' ? frozen.libraryId : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read one legacy ledger file and project it. Pure: the file is opened for
 * reading and nothing else, and a v5 line is refused by name rather than folded
 * into a shape that would pretend to be history.
 */
export function readLegacyMethodsSync(text: string, filter: { libraryId?: string } = {}): LegacyMethodView[] {
  const proposals = new Map<string, {
    view: LegacyMethodView
    experiments: string[]
    history: { status: string; actor: string; at: string }[]
    intents: LegacyCommitIntent[]
    applied?: readonly string[]
    rolledback?: readonly string[]
    decision?: string
    decisionNote?: string
    status: LegacyMethodStatus
    libraryIds: (string | undefined)[]
  }>()
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      throw new Error(`evolution: corrupt ledger line ${index + 1} in the legacy ledger`)
    }
    if (!isRecord(raw)) throw new Error(`evolution: legacy ledger line ${index + 1} is not an object`)
    if (raw.formatVersion === 5) {
      throw new Error(
        `evolution: ledger line ${index + 1} is a v5 record; the legacy reader projects formatVersion ≤ 4 only — a new-protocol graph is ` +
          'read through the draft views, never through this projection',
      )
    }
    const proposalId = stringOf(raw.proposalId)
    if (proposalId === undefined) continue
    let entry = proposals.get(proposalId)
    if (entry === undefined) {
      if (raw.kind !== 'proposed') throw new Error(`evolution: legacy ledger line ${index + 1} names proposal "${proposalId}" before it is proposed`)
      entry = {
        view: {
          proposalId,
          targetType: String(raw.targetType ?? 'unknown'),
          targetId: String(raw.targetId ?? ''),
          baseVersion: String(raw.baseVersion ?? ''),
          level: String(raw.level ?? ''),
          rationale: String(raw.rationale ?? ''),
          status: 'proposed',
          history: [],
          experiments: [],
        },
        experiments: [],
        history: [],
        intents: [],
        libraryIds: [ownerOf(raw)],
        status: 'proposed',
      }
      proposals.set(proposalId, entry)
    }
    entry.libraryIds.push(ownerOf(raw))
    const actor = String(raw.actor ?? '')
    const at = String(raw.at ?? '')
    entry.history.push({ status: String(raw.kind), actor, at })
    switch (raw.kind) {
      case 'proposed':
        break
      case 'candidate':
      case 'prepared':
      case 'gated':
        entry.status = raw.kind
        break
      case 'decided':
        entry.status = 'decided'
        entry.decision = stringOf(raw.decision)
        entry.decisionNote = stringOf(raw.note)
        break
      case 'applied':
        entry.status = 'applied'
        entry.applied = (Array.isArray(raw.targets) ? raw.targets : []).map(String)
        entry.intents = []
        break
      case 'rolledback':
        entry.status = 'rolledback'
        entry.rolledback = (Array.isArray(raw.targets) ? raw.targets : []).map(String)
        entry.intents = []
        break
      case 'commit_intent': {
        const capability = isRecord(raw.capability) ? stringOf(raw.capability.name) : undefined
        entry.intents = [
          {
            intentId: String(raw.intentId ?? ''),
            direction: raw.direction === 'rollback' ? 'rollback' : 'apply',
            approvalRef: String(raw.approvalRef ?? ''),
            files: (Array.isArray(raw.files) ? raw.files : []).map(file => (isRecord(file) ? String(file.target ?? '') : '')),
            ...(capability === undefined ? {} : { capability }),
          },
        ]
        break
      }
      case 'experiment_started': {
        const experimentId = stringOf(raw.experimentId)
        if (experimentId !== undefined) entry.experiments.push(experimentId)
        break
      }
      default:
        break
    }
  }
  const wanted = filter.libraryId
  const views: LegacyMethodView[] = []
  for (const entry of proposals.values()) {
    if (wanted !== undefined && entry.libraryIds.some(id => id !== undefined && id !== wanted)) continue
    views.push({
      ...entry.view,
      status: entry.status,
      ...(entry.decision === undefined ? {} : { decision: entry.decision }),
      ...(entry.decisionNote === undefined ? {} : { decisionNote: entry.decisionNote }),
      ...(entry.intents.length === 0 ? {} : { intent: entry.intents[0]! }),
      ...(entry.applied === undefined ? {} : { appliedTargets: entry.applied }),
      ...(entry.rolledback === undefined ? {} : { rolledbackTargets: entry.rolledback }),
      experiments: entry.experiments,
      history: entry.history,
    })
  }
  return views
}

/** Read one legacy ledger file and project it; a file that does not exist holds no history. */
export async function readLegacyMethods(
  ledgerPath: string,
  filter: { libraryId?: string } = {},
): Promise<LegacyMethodView[]> {
  let text: string
  try {
    text = await readFile(ledgerPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return readLegacyMethodsSync(text, filter)
}
