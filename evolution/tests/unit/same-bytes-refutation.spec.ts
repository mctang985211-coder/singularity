/**
 * Same-bytes candidates close immediately (plan §4): a candidate whose content
 * digest already stands refuted in this library is refused without spending a
 * measurement. What makes that reachable is the digest's scope — the assets the
 * candidate revision holds, never the draft id it is filed under or the moment
 * it was staged. This spec stages the same skill body twice through the real
 * environment store and pins both halves: the two candidate manifests read one
 * content digest, and `refutationFor` hits on it.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEnvironmentDraft,
  ensureInitialRevision,
  libraryRoots,
  readEnvironmentDraft,
  stageEnvironmentEdit,
} from '@dangosys/dsh-singularity-task-runtime'
import { createDraft } from '../../src/draft/draft.ts'
import type { MethodLedger } from '../../src/draft/draft.ts'
import type { EvolutionRecordV5 } from '../../src/ledger/records.ts'
import { refutationFor } from '../../src/strategy/history.ts'
import type { HistoryFacts } from '../../src/strategy/history.ts'
import { LIBRARY } from './method-fixtures.ts'

const LIBRARY_ID = 's-root'

/** The same candidate body, staged twice: a different draft id and a later timestamp. */
const SKILL_MD = `---\nname: explore-metrics\ndescription: one fixture skill\n---\n\nThe same guidance, written twice.\n`

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function ledgerHarness(): MethodLedger {
  const appended: EvolutionRecordV5[] = []
  return {
    libraryId: LIBRARY,
    records: () => appended,
    append: async (record: EvolutionRecordV5) => {
      appended.push(record)
    },
  }
}

/** One fresh library under its own `$DSH_HOME`, holding the initial revision. */
async function freshLibrary() {
  const home = await mkdtemp(join(tmpdir(), 'same-bytes-'))
  roots.push(home)
  const library = libraryRoots(LIBRARY_ID, home)
  await ensureInitialRevision(library, { actor: 'tester' })
  return library
}

/** Stage the same skill body on one fresh draft and read the candidate revision it produced. */
async function stageOnce(library: Awaited<ReturnType<typeof freshLibrary>>, actor: string) {
  const draft = await createEnvironmentDraft(library, { actor })
  await stageEnvironmentEdit(library, draft.draftId, {
    kind: 'skill',
    edit: { name: 'explore-metrics', skillMd: SKILL_MD, expectedVersion: 0, actor },
  })
  const staged = await readEnvironmentDraft(library, draft.draftId)
  if (staged === undefined) throw new Error('fixture: the staged draft is absent')
  return { draftId: draft.draftId, manifest: staged.manifest }
}

describe('same-bytes candidates', () => {
  it('freezes one content digest for the same assets, whatever the draft is called', async () => {
    const library = await freshLibrary()
    const first = await stageOnce(library, 'first')
    const second = await stageOnce(library, 'second')
    expect(second.draftId).not.toBe(first.draftId)
    expect(second.manifest.revisionId).not.toBe(first.manifest.revisionId)
    expect(second.manifest.createdAt).not.toBe(first.manifest.createdAt)
    expect(second.manifest.contentDigest).toBe(first.manifest.contentDigest)
  })

  it('closes the second candidate by name without a measurement', async () => {
    // The ledger side of the same fact: the draft door records the revision's
    // own content digest, so the history a strategy folds and the digest a tool
    // looks up with are the same string.
    const ledger = ledgerHarness()
    const first = await createDraft(ledger, {
      draftId: 'd0001',
      kind: 'skill',
      identity: 'explore-metrics',
      baseRevision: { revisionId: 'r0001', digest: 'a'.repeat(64), libraryId: LIBRARY },
      candidateRevision: { revisionId: 'c-d0001', digest: 'b'.repeat(64), files: [] },
      rationale: 'the first attempt proposes these bytes',
      sourceRefs: ['diagnosis:d1'],
      actor: 'supervisor',
    })
    const second = await createDraft(ledger, {
      draftId: 'd0002',
      kind: 'skill',
      identity: 'explore-metrics',
      baseRevision: { revisionId: 'r0001', digest: 'a'.repeat(64), libraryId: LIBRARY },
      candidateRevision: { revisionId: 'c-d0002', digest: 'b'.repeat(64), files: [] },
      rationale: 'a later round proposes the very same bytes',
      sourceRefs: ['diagnosis:d2'],
      actor: 'supervisor',
    })
    expect(second.draft.candidateRevision.digest).toBe(first.draft.candidateRevision.digest)

    const facts: HistoryFacts = {
      candidates: [first, second].map((view, round) => ({
        candidateId: view.draft.draftId,
        libraryId: view.libraryId,
        contentDigest: view.draft.candidateRevision.digest,
        round,
        edits: [],
      })),
      evaluations: [],
      consumption: [],
      refutations: [
        {
          candidateId: first.draft.draftId,
          contentDigest: first.draft.candidateRevision.digest,
          reasonCode: 'not-measured',
          reason: 'the first attempt was discarded without an evaluation',
          evidenceRefs: [],
          round: 0,
        },
      ],
      versions: [],
    }
    expect(refutationFor(facts, LIBRARY, second.draft.candidateRevision.digest)).toEqual({
      kind: 'same-bytes',
      refutation: facts.refutations[0],
    })
    // And a candidate this library never refuted is not closed by it.
    expect(refutationFor(facts, 'another-library', second.draft.candidateRevision.digest)).toBeUndefined()
  })
})
