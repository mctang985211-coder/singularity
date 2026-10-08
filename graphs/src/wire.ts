/**
 * The one wire format Web and tools share for graph reads: pure data, no cordis.
 * Subpath export `@dangosys/dsh-singularity-graphs/wire`.
 * @module dsh-singularity-graphs/wire
 */

import type { GraphSnapshot, LayoutSnapshot } from '@dangosys/dsh-singularity-graph'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { graphAccess } from './protocol.ts'
import type { GraphProtocol } from './protocol.ts'
import type { GraphRecord } from './types.ts'

export type GraphAccessWire = { readonly mode: 'current' | 'legacy-readonly'; readonly reason?: string }

/** One graph record's access mode, as every wire and route reports it. */
export function graphAccessWire(graph: { readonly id: string; readonly protocol?: GraphProtocol }): GraphAccessWire {
  const access = graphAccess(graph)
  return access.mode === 'current' ? { mode: 'current' } : { mode: 'legacy-readonly', reason: access.reason }
}

export interface GraphProgressWire {
  /** 1-based round currently in flight; 0 when nothing is scheduled. */
  readonly round: number
  readonly rounds: number
  readonly phase: 'idle' | 'running' | 'awaiting_approval' | 'stopped' | 'finished'
  readonly note?: string
}

export interface GraphRevisionWire {
  readonly revisionId: string | null
  readonly manifestDigest: string | null
  readonly origin: 'graph-initial' | 'draft' | 'published' | 'rolled-back' | 'unknown'
  readonly publishedAt: string | null
}

export interface ApprovalSourceWire {
  readonly kind: 'human' | 'platform_policy'
  readonly actor?: string
  readonly policy?: string
}

export interface GraphEvaluationWire {
  readonly state: 'idle' | 'screening' | 'evaluating' | 'decided' | 'published' | 'rejected' | 'inconclusive'
  readonly reportRef: string | null
  readonly candidateRef: string | null
  readonly decidedAt: string | null
  readonly decision?: {
    readonly kind: 'promote' | 'retain' | 'trial' | 'discard' | 'rollback'
    readonly source: ApprovalSourceWire
    readonly by?: string
    readonly at: string
  }
}

/** The complete read facts of one graph; Web and tools read exactly this one projection. */
export interface GraphViewWire {
  readonly formatVersion: 2
  readonly graph: { readonly id: string; readonly name: string; readonly createdAt: number }
  readonly access: GraphAccessWire
  readonly revision: GraphRevisionWire | null
  readonly evaluation: GraphEvaluationWire | null
  readonly progress: GraphProgressWire
  /** The fact fingerprint of this view; caching and change detection judge by it alone. */
  readonly generation: number
}

/** One legacy completion-format row (note prefix / fenced JSON), kept verbatim and marked by format. */
export interface LegacyCompletionWire {
  readonly format: 'legacy-v1'
  readonly sessionId: string
  readonly taskId: string
  readonly note: string
  readonly recordedAt: string
}

/** Legacy graph history: a verbatim projection of legacy records, read-only and forever writable:false. */
export interface LegacyGraphViewWire {
  readonly formatVersion: 'legacy-v1'
  readonly writable: false
  readonly graph: GraphRecord
  readonly access: GraphAccessWire
  readonly topology: GraphSnapshot | null
  readonly layout: LayoutSnapshot | null
  readonly tasks: TaskSnapshot | null
  readonly proposals: readonly unknown[]
  readonly experiments: readonly unknown[]
  readonly completions: readonly LegacyCompletionWire[]
  /** Whether each store a read drew on exists, so the read's sources can be audited. */
  readonly sources: readonly { readonly id: string; readonly kind: 'topology' | 'layout' | 'tasks'; readonly exists: boolean }[]
}
