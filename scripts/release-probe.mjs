#!/usr/bin/env node
/**
 * `release@1` + `environment@2` in one real process, over a real DSH session.
 *
 * The unit specs prove each rule against a live store; this probe proves the *publication path*
 * end to end, on bytes that survive a close and a reopen, and it is the check a gate can run:
 *
 *   1. a draft binds the content digest the log holds, and an approval binds the digest that was
 *      drafted — an approval of other content is refused (`stale-approval`), and the head does not
 *      move onto a revision that is only drafted (`unapproved-revision`);
 *   2. the head only moves by compare-and-swap: a stale expectation and a no-op are both refused
 *      (`illegal-transition`), and of two switches sharing one expected head exactly one commits;
 *   3. the head never names a revision this environment did not create, and never names content
 *      this environment does not hold under that id — including the same revision id in another
 *      environment, which is legal because ids are unique per environment;
 *   4. the pointer is derived: folding the facts again yields the same head, the head is not a
 *      member of any payload, and a **reopened store** reads the same head from the same bytes;
 *   5. `environment@1` is refused by name, and `environment@2` is the one conditional owner.
 *
 * Any check failing exits non-zero.
 *
 * Run: node scripts/release-probe.mjs
 *
 * @module singularity-core/scripts/release-probe
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openPersistence } from './dsh-control-runtime.mjs'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'
import { foldSubjects } from '../src/protocol/fold.ts'
import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  PUBLISHER_ROLE,
} from '../src/environment/protocol.ts'
import { APPROVER_ROLE, declareReleaseProtocol, RELEASE_PROTOCOL, RELEASE_VERSION } from '../src/release/protocol.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import { SCHEDULER_ROLE } from '../src/task/protocol.ts'

const LIBRARY = 'library-1'
const OTHER_LIBRARY = 'library-2'
const R1 = 'r0001'
const R2 = 'r0002'
const R3 = 'r0003'
const R4 = 'r0004'
const R5 = 'r0005'
const R6 = 'r0006'

const MANIFEST_A = { skills: ['count-words'] }
const MANIFEST_B = { skills: ['count-words', 'bounded-size'] }
const MANIFEST_C = { skills: ['count-words', 'bounded-size', 'cited'] }

/** The deployment's identities. Drafting, approving, creating revisions and publishing differ. */
const SUBJECTS = {
  [SCHEDULER_ROLE]: 'scheduler-service',
  [APPROVER_ROLE]: 'approval-seam',
  [ENVIRONMENT_ROLE]: 'environment-service',
  [PUBLISHER_ROLE]: 'publisher-service',
}

const ALICE = 'human:alice'

const failures = []
/** How many acts this probe observed being refused: the other half of "the rules are real". */
let refusals = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

async function asyncRefusalOf(run) {
  try {
    await run()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected a refusal')
}

function refusalOf(run) {
  try {
    run()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected a refusal')
}

async function main() {
  // Resolved dynamically, after `dsh-control-runtime` registered its resolve hook: ESM links static
  // imports before evaluating any of them, so a hook registered during evaluation is too late.
  const { ControlSessionStore } = await import('../src/control/session-store.ts')

  const root = await mkdtemp(join(tmpdir(), 'singularity-release-probe-'))
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  declareReleaseProtocol(registry)

  const open = persistence =>
    ControlSessionStore.open({ persistence, controlId: 'release-probe', registry, subjects: SUBJECTS })

  try {
    const runtime = await openPersistence(join(root, 'sessions'))
    let store = await open(runtime.persistence)
    const commands = createReleaseCommands({ store })

    const environmentOf = subject =>
      store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, subject)
    const revisionOf = (subject, revisionId) => {
      const revision = environmentOf(subject)?.revisions?.[revisionId]
      if (revision === undefined) throw new Error(`revision ${revisionId} of ${subject} was not created`)
      return revision
    }
    const createRevision = async (subject, revisionId, manifest) => {
      await store.emit({
        commandId: `create-${subject}-${revisionId}`,
        protocol: ENVIRONMENT_PROTOCOL,
        version: ENVIRONMENT_VERSION,
        kind: ENVIRONMENT_KINDS.revisionCreated,
        subject,
        payload: { revisionId, manifest },
      })
      return revisionOf(subject, revisionId).contentDigest
    }
    const approved = async (subject, revisionId, digest) => {
      await commands.draft({ commandId: `draft-${revisionId}`, revision: { environmentId: subject, revisionId, digest } })
      await commands.approve({ commandId: `approve-${revisionId}`, revisionId, draftDigest: digest, approvedBy: ALICE })
    }
    const pointerFacts = () =>
      store.load().entriesOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).filter(entry => entry.kind === ENVIRONMENT_KINDS.pointerSwitched)

    // ---------------------------------------------------------------- 1. draft, approve, publish
    const digestA = await createRevision(LIBRARY, R1, MANIFEST_A)
    const digestB = await createRevision(LIBRARY, R2, MANIFEST_B)
    const digestC = await createRevision(LIBRARY, R3, MANIFEST_C)
    const digestAElsewhere = await createRevision(OTHER_LIBRARY, R1, MANIFEST_C)

    await commands.draft({ commandId: 'draft-r1', revision: { environmentId: LIBRARY, revisionId: R1, digest: digestA } })
    const releaseOf = revisionId => store.load().stateOf(RELEASE_PROTOCOL, RELEASE_VERSION, revisionId)
    const drafted = releaseOf(R1)
    check('the draft records the digest the log holds', drafted?.draftDigest === digestA, drafted?.draftDigest)

    refusals += 1
    const wrongDraft = await asyncRefusalOf(() =>
      commands.draft({
        commandId: 'draft-r1-wrong',
        revision: { environmentId: LIBRARY, revisionId: R1, digest: digestB },
      }),
    )
    check('a draft whose digest is not the created content is refused, by name', wrongDraft.code === 'unknown-revision', wrongDraft.code)

    refusals += 1
    const early = await asyncRefusalOf(() =>
      commands.approve({ commandId: 'approve-r3-early', revisionId: R3, draftDigest: digestA, approvedBy: ALICE }),
    )
    check('an approval of a revision with no draft is refused', early.code === 'illegal-transition', early.code)

    await commands.draft({ commandId: 'draft-r3', revision: { environmentId: LIBRARY, revisionId: R3, digest: digestC } })
    refusals += 1
    const stale = await asyncRefusalOf(() =>
      commands.approve({ commandId: 'approve-r3-stale', revisionId: R3, draftDigest: digestB, approvedBy: ALICE }),
    )
    check('an approval whose digest is not the draft’s is refused as stale', stale.code === 'stale-approval', stale.code)

    await commands.approve({ commandId: 'approve-r1', revisionId: R1, draftDigest: digestA, approvedBy: ALICE })
    check('the approval records the human and the release state', releaseOf(R1)?.approvedBy === ALICE)

    // ---------------------------------------------------------------- 2. the head is a CAS
    refusals += 1
    const unapproved = await asyncRefusalOf(() =>
      commands.publish({ commandId: 'publish-r3', environmentId: LIBRARY, expected: '', to: R3 }),
    )
    check('the head does not move onto a revision nobody approved', unapproved.code === 'unapproved-revision', unapproved.code)
    check('and that refusal left the head empty', environmentOf(LIBRARY)?.pointer === undefined)

    await commands.publish({ commandId: 'publish-r1', environmentId: LIBRARY, expected: '', to: R1 })
    check('the first switch names the empty head and sets it', environmentOf(LIBRARY)?.pointer === R1)

    await approved(LIBRARY, R2, digestB)
    await commands.publish({ commandId: 'publish-r2', environmentId: LIBRARY, expected: R1, to: R2 })
    check('a switch based on the current head moves it', environmentOf(LIBRARY)?.pointer === R2)

    refusals += 1
    const staleSwitch = await asyncRefusalOf(() =>
      commands.publish({ commandId: 'publish-stale', environmentId: LIBRARY, expected: R1, to: R2 }),
    )
    check('a switch whose expected head already moved is refused', staleSwitch.code === 'illegal-transition', staleSwitch.code)

    refusals += 1
    const noop = await asyncRefusalOf(() =>
      commands.publish({ commandId: 'publish-noop', environmentId: LIBRARY, expected: R2, to: R2 }),
    )
    check('a no-op switch is refused rather than treated as idempotent', noop.code === 'illegal-transition', noop.code)
    check('neither refused switch is in the log', pointerFacts().length === 2, String(pointerFacts().length))

    // ---------------------------------------------------------------- 3. content, not just an id
    refusals += 1
    const foreign = await asyncRefusalOf(() =>
      commands.publish({ commandId: 'publish-foreign', environmentId: OTHER_LIBRARY, expected: '', to: R1 }),
    )
    check(
      'a head onto the same id in another environment, holding other content, is refused',
      foreign.code === 'unknown-revision',
      foreign.code,
    )
    check('that environment’s head is still empty', environmentOf(OTHER_LIBRARY)?.pointer === undefined)
    check('the two environments hold different content under one id', digestA !== digestAElsewhere)

    refusals += 1
    const ghostSwitch = await asyncRefusalOf(() =>
      commands.publish({ commandId: 'publish-ghost', environmentId: LIBRARY, expected: R2, to: 'r9999' }),
    )
    check('a head onto a revision no release names is refused', ghostSwitch.code === 'unapproved-revision', ghostSwitch.code)

    // ---------------------------------------------------------------- 4. concurrent switches
    const digest5 = await createRevision(LIBRARY, R5, MANIFEST_A)
    const digest6 = await createRevision(LIBRARY, R6, MANIFEST_B)
    await approved(LIBRARY, R5, digest5)
    await approved(LIBRARY, R6, digest6)
    const factsBefore = pointerFacts().length

    const results = await Promise.allSettled([
      commands.publish({ commandId: 'publish-r5', environmentId: LIBRARY, expected: R2, to: R5 }),
      commands.publish({ commandId: 'publish-r6', environmentId: LIBRARY, expected: R2, to: R6 }),
    ])
    const won = results.filter(result => result.status === 'fulfilled')
    const lost = results.filter(result => result.status === 'rejected')
    check(
      'of two concurrent switches with one expected head, exactly one commits',
      won.length === 1 && lost.length === 1,
      `${won.length} fulfilled, ${lost.length} rejected`,
    )
    check('the loser is refused as a stale expectation', lost[0]?.reason?.refusal?.code === 'illegal-transition', lost[0]?.reason?.refusal?.code)
    check('exactly one pointer fact was appended', pointerFacts().length === factsBefore + 1, String(pointerFacts().length - factsBefore))
    const winner = won[0]?.value
    check('the head is the winner’s target', environmentOf(LIBRARY)?.pointer === winner?.payload?.to, environmentOf(LIBRARY)?.pointer)
    check('the recorded pointer fact is the winner’s own fact', pointerFacts().at(-1)?.commandId === winner?.commandId)

    // ---------------------------------------------------------------- 5. the head is derived
    const head = environmentOf(LIBRARY)?.pointer
    const refolded = foldSubjects(registry, store.load().entries(), ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).get(LIBRARY)
    check('folding the same facts again yields the same head', refolded?.pointer === head, refolded?.pointer)
    check('a new revision does not move the head', (await createRevision(LIBRARY, R4, MANIFEST_C)) !== undefined && environmentOf(LIBRARY)?.pointer === head)
    check(
      'the head is a member of no payload, only of the fold',
      pointerFacts().every(entry => !Object.hasOwn(entry.payload, 'pointer')),
    )

    const facts = store.load().entries().length
    const sessionId = store.sessionId
    await store.close()

    // ---------------------------------------------------------------- 6. the same bytes, reopened
    store = await open(runtime.persistence)
    check('the reopened store is the same session', String(store.sessionId) === String(sessionId))
    check('the reopened store holds every committed fact', store.load().entries().length === facts, String(store.load().entries().length))
    check('the reopened store reads the same head', environmentOf(LIBRARY)?.pointer === head, environmentOf(LIBRARY)?.pointer)
    check(
      'the reopened facts re-verify: the fold agrees with the live cut',
      foldSubjects(registry, store.load().entries(), ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).get(LIBRARY)?.pointer === head,
    )

    // ---------------------------------------------------------------- 7. version discipline
    refusals += 1
    const v1 = refusalOf(() => registry.ruleFor(ENVIRONMENT_PROTOCOL, 1, ENVIRONMENT_KINDS.revisionCreated))
    check('environment@1 is refused by name', v1.code === 'version-mismatch' && v1.detail.includes('declared at 2'), v1.detail)
    const guarantees = registry.ruleFor(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT_KINDS.pointerSwitched).guarantees
    check(
      'pointer/switched is appended, conditional and atomic',
      guarantees.appended === true && guarantees.conditional === true && guarantees.atomicFact === true,
      JSON.stringify(guarantees),
    )
    check('exactly one protocol owns the conditional discipline', registry.conditionalOwner() === ENVIRONMENT_PROTOCOL, registry.conditionalOwner())
    check(
      'release@1 declares its two kinds and claims no conditional update',
      registry.kindsOf(RELEASE_PROTOCOL, RELEASE_VERSION).length === 2 && registry.conditionalOwner() === ENVIRONMENT_PROTOCOL,
    )

    console.log('')
      console.log(`  facts ${facts}; head ${head}; pointer facts ${pointerFacts().length}; refused acts ${refusals}`)

    await store.close()
    await runtime.context.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()

if (failures.length > 0) {
  console.error(`\nrelease-probe: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('\nrelease-probe: OK — approval binds content, and the head moves only by compare-and-swap')
}
