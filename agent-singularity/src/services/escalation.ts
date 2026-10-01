/** The L4 ESCALATE ledger (KISS §7): an append-only record of the human-facing cards a root agent raises when it cannot settle work itself — a capability gap, an exhausted budget, or an UNKNOWN(verifier) verdict. @module dsh-singularity-agent */

import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { appendJsonlRow, readJsonlFile } from '../jsonl-ledger.ts'

/** What raised the card. The three non-human values are the orchestrator's trigger sites (plan phase 3.1). */
export type EscalationTrigger = 'capability-gap' | 'budget-exhausted' | 'unknown-convergence' | 'human'

export const ESCALATION_TRIGGERS: readonly EscalationTrigger[] = ['capability-gap', 'budget-exhausted', 'unknown-convergence', 'human']

export interface EscalationInput {
  /** Caller-supplied id; omitted derives one (`esc-<uuid>`). */
  escalationId?: string
  /** KISS §7 element 1: what is missing. */
  what: string
  /** KISS §7 element 2: what was already tried. */
  tried: string
  /** KISS §7 element 3: what is suggested. */
  suggested: string
  trigger: EscalationTrigger
  /** The task the card is about, when it has one. */
  sourceTaskId?: string
  /** Evidence / task / diagnosis refs behind the card. */
  sourceRefs?: readonly string[]
}

/** Folded view of one card. */
export interface Escalation {
  escalationId: string
  what: string
  tried: string
  suggested: string
  trigger: EscalationTrigger
  /** An open card awaits a human decision; the ledger records the card, never the decision. */
  status: 'open'
  sourceTaskId?: string
  sourceRefs: string[]
  /** Human-review evidence: the approval call id of the escalate request that granted this record. */
  approvalRef: string
  actor: string
  at: string
  /** One entry per ledger record — derived, never stored. */
  history: { status: 'open'; actor: string; at: string }[]
}

/** One immutable ledger line. A state migration appends a new record; nothing is ever rewritten in place. */
export type EscalationRecord = {
  formatVersion: 1
  kind: 'raised'
  escalationId: string
  what: string
  tried: string
  suggested: string
  trigger: EscalationTrigger
  sourceTaskId?: string
  sourceRefs: string[]
  approvalRef: string
  actor: string
  at: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    escalation: EscalationService
  }
}

/** Plugin config; every field optional — the constructor resolves the default. */
export interface Config {
  /** Directory of the ledger file `escalations.jsonl`. Omitted resolves to `$DSH_HOME`, falling back to `<repo root>/.dsh` when `DSH_HOME` is unset — the same derivation as the evolution ledger, whose file sits one level */
  root?: string
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`escalation: ${field} must be a non-empty string`)
  }
  return value
}

/** Payload validation shared by the write path (`raise`) and the fold, so a hand-forged ledger line fails load exactly as it would fail append: */
function assertRaised(record: Record<string, unknown>): void {
  if (record.kind !== 'raised') throw new Error(`escalation: unknown ledger kind "${String(record.kind)}"`)
  nonEmpty(record.escalationId, 'escalationId')
  nonEmpty(record.what, 'what')
  nonEmpty(record.tried, 'tried')
  nonEmpty(record.suggested, 'suggested')
  if (!ESCALATION_TRIGGERS.includes(record.trigger as EscalationTrigger)) {
    throw new Error(`escalation: unknown trigger "${String(record.trigger)}"`)
  }
  if (!Array.isArray(record.sourceRefs) || record.sourceRefs.some(ref => typeof ref !== 'string' || ref.trim().length === 0)) {
    throw new Error('escalation: sourceRefs must be an array of non-empty strings')
  }
  if (record.sourceTaskId !== undefined) nonEmpty(record.sourceTaskId, 'sourceTaskId')
  nonEmpty(record.approvalRef, 'approvalRef')
  nonEmpty(record.actor, 'actor')
  nonEmpty(record.at, 'at')
}

/** The escalation ledger (plane separation: this store is independent of the task store and refers to it by id only). */
export class EscalationService extends Service {
  /** Absolute ledger directory resolved at construction. */
  readonly root: string
  /** Repo root that relative paths resolve against. */
  readonly repoRoot: string
  private records: EscalationRecord[] = []
  private readonly loaded: Promise<void>
  private writes: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'escalation')
    this.repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
    const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, '.dsh')
    this.root = resolve(config.root ?? dshHome)
    this.loaded = this.load()
    ctx.effect(
      () => async () => {
        await this.writes
      },
      'escalation: drain writes',
    )
  }

  /** Ledger file path (`<root>/escalations.jsonl`). */
  get file(): string {
    return join(this.root, 'escalations.jsonl')
  }

  /** Record one card. The caller (the `escalate` tool) must hold a human grant from `ctx.approval.request` first and pass its call id as `approvalRef` (`approval:<callId>`, the evolution_decide shape): a rejected, cancelled, */
  async raise(input: EscalationInput, actor: string, approvalRef: string): Promise<Escalation> {
    const record: EscalationRecord = {
      formatVersion: 1,
      kind: 'raised',
      escalationId: nonEmpty(input.escalationId ?? `esc-${randomUUID()}`, 'escalationId'),
      what: nonEmpty(input.what, 'what'),
      tried: nonEmpty(input.tried, 'tried'),
      suggested: nonEmpty(input.suggested, 'suggested'),
      trigger: input.trigger,
      ...(input.sourceTaskId === undefined ? {} : { sourceTaskId: nonEmpty(input.sourceTaskId, 'sourceTaskId') }),
      sourceRefs: (input.sourceRefs ?? []).map((ref, index) => nonEmpty(ref, `sourceRefs[${index}]`)),
      approvalRef: nonEmpty(approvalRef, 'approvalRef'),
      actor,
      at: new Date().toISOString(),
    }
    if (!ESCALATION_TRIGGERS.includes(record.trigger)) {
      throw new Error(`escalation: unknown trigger "${String(input.trigger)}"`)
    }
    await this.append(record)
    return this.get(record.escalationId)
  }

  /** Folded view of one card, or throws on an unknown id. */
  async get(escalationId: string): Promise<Escalation> {
    await this.loaded
    const escalation = this.fold(this.records).get(escalationId)
    if (escalation === undefined) throw new Error(`escalation: unknown escalation "${escalationId}"`)
    return escalation
  }

  /** Folded views, newest card first. */
  async list(): Promise<Escalation[]> {
    await this.loaded
    return [...this.fold(this.records).values()].reverse()
  }

  /** Fold records into cards, enforcing the payload rules on every step: a `raised` line starts a new id, a repeated id is refused, and every field is re-validated, so an illegal line fails load exactly as it would fail */
  private fold(records: readonly EscalationRecord[]): Map<string, Escalation> {
    const escalations = new Map<string, Escalation>()
    for (const record of records) {
      assertRaised(record as unknown as Record<string, unknown>)
      if (escalations.has(record.escalationId)) {
        throw new Error(`escalation: escalation "${record.escalationId}" already exists`)
      }
      escalations.set(record.escalationId, {
        escalationId: record.escalationId,
        what: record.what,
        tried: record.tried,
        suggested: record.suggested,
        trigger: record.trigger,
        status: 'open',
        ...(record.sourceTaskId === undefined ? {} : { sourceTaskId: record.sourceTaskId }),
        sourceRefs: [...record.sourceRefs],
        approvalRef: record.approvalRef,
        actor: record.actor,
        at: record.at,
        history: [{ status: 'open', actor: record.actor, at: record.at }],
      })
    }
    return escalations
  }

  private async load(): Promise<void> {
    const records = (await readJsonlFile(this.file, (line, lineNumber) => {
      try {
        return JSON.parse(line) as EscalationRecord
      } catch {
        throw new Error(`escalation: corrupt ledger line ${lineNumber} in ${this.file}`)
      }
    })) ?? []
    for (const record of records) {
      if (record.formatVersion !== 1) throw new Error(`escalation: unsupported ledger formatVersion "${String(record.formatVersion)}"`)
    }
    this.records = records
    this.fold(this.records)
  }

  /** Validate the staged fold first; memory commits only after the line is on disk. */
  private async append(record: EscalationRecord): Promise<void> {
    await this.loaded
    const run = this.writes.then(async () => {
      this.fold([...this.records, record])
      await appendJsonlRow(this.file, record)
      this.records = [...this.records, record]
    })
    this.writes = run.then(
      () => undefined,
      () => undefined,
    )
    await run
  }
}

export default EscalationService
