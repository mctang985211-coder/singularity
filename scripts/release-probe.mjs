#!/usr/bin/env node
/**
 * `release@1` + `environment@2` + the native approval seam, in one real process.
 *
 * The unit specs decide each rule against a live control store; this probe observes the **publication
 * path end to end**, on bytes that survive a close and a reopen, with the real runtime mounted:
 *
 *   1. **the native seam answers, and only one answer is consent.** With no answerer composed the ask
 *      resolves `'unavailable'` and the command refuses; with an answerer that rejects it refuses
 *      too; with an answerer that grants once, `release/approved` is recorded carrying the
 *      `approval/asked` id the service logged on the asking agent's session;
 *   2. **the draft binds the content the log holds**, and a draft whose digest is not that content is
 *      refused by name;
 *   3. **the head only moves by compare-and-swap**, onto a revision this environment created, whose
 *      approved content this environment holds;
 *   4. **one environment's release never answers for another's** — the same revision id in two
 *      environments is two different contents, and each head moves on its own;
 *   5. **the pointer is derived**: folding the facts again yields the same head, and a reopened store
 *      reads the same head from the same bytes.
 *
 * **What the granting observation is, and is not.** An answerer composed here is a listener on the
 * deployment's `approval/request` waterfall — which is what a UI answerer is — so what is observed is
 * the *seam plumbing*: the real service issues the audit pair, and our fact carries that id. It is
 * **not** observed that a human decided anything: no real UI answerer is composed in this process,
 * and that stays unobserved rather than simulated.
 *
 * Run: node scripts/release-probe.mjs
 *
 * @module singularity-core/scripts/release-probe
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshModule, openPersistence } from './dsh-control-runtime.mjs'
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
import { askForApproval } from '../src/runtime/approval.ts'
import { SCHEDULER_ROLE } from '../src/task/protocol.ts'

const LIBRARY = 'library-1'
const OTHER_LIBRARY = 'library-2'
const R1 = 'r0001'
const R2 = 'r0002'

const MANIFEST_A = { skills: ['count-words'] }
const MANIFEST_B = { skills: ['count-words', 'bounded-size'] }

/** The deployment's identities. Drafting, approving, creating revisions and publishing differ. */
const SUBJECTS = {
  [SCHEDULER_ROLE]: 'scheduler-service',
  [APPROVER_ROLE]: 'approval-seam',
  [ENVIRONMENT_ROLE]: 'environment-service',
  [PUBLISHER_ROLE]: 'publisher-service',
}

const ALICE = 'human:alice'
const CONTROL = 'release-probe'

const failures = []
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

/** The smallest real runtime that can drive a turn: the agent loop plus a scripted adapter. */
async function mountRuntime(root) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionStore } = await dshModule('@deepseek-ai/dsh-session')
  const { default: AgentRegistry } = await dshModule('@deepseek-ai/dsh-agent')
  const { default: LlmRuntime, LlmAdapter } = await dshModule('@deepseek-ai/dsh-llm')
  const { default: ToolRuntime } = await dshModule('@deepseek-ai/dsh-tools')
  const { default: SystemPrompt } = await dshModule('@deepseek-ai/dsh-system-prompt')
  const { default: SessionProjectionRegistry } = await dshModule('@deepseek-ai/dsh-session-projection')
  const { default: AgentLoop } = await dshModule('@deepseek-ai/dsh-agent-loop')
  const approval = await dshModule('@deepseek-ai/dsh-user-approval')

  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  // The real service: the answerer waterfall, per-session policy, and the log-only audit pair.
  await ctx.plugin(approval.default, {})
  return { ctx, LlmAdapter }
}

/** An adapter that asks for the approval tool on its first stream and answers with text after. */
function scriptedAdapter(LlmAdapter) {
  return class Scripted extends LlmAdapter {
    constructor() {
      super()
      this.step = 0
    }

    async *stream() {
      this.step += 1
      if (this.step % 2 === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: `call-${this.step}`, name: 'release_approve', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${this.step}`, name: 'release_approve', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function main() {
  // Resolved dynamically, after `dsh-control-runtime` registered its resolve hook: ESM links static
  // imports before evaluating any of them, so a hook registered during evaluation is too late.
  const { ControlSessionStore } = await import('../src/control/session-store.ts')
  const { SessionId } = await dshModule('@deepseek-ai/dsh-session')
  const { createUserMessage } = await dshModule('@deepseek-ai/dsh-llm')

  const root = await mkdtemp(join(tmpdir(), 'singularity-release-probe-'))
  const sessions = join(root, 'sessions')
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  declareReleaseProtocol(registry)

  const { ctx, LlmAdapter } = await mountRuntime(sessions)
  const { persistence } = await openPersistence(sessions)
  // The deployment's two approval seams: the service, and the context whose append feed carries the
  // service-issued audit id. A context is the feed (`ctx.on('session/event', …)` is the signature).
  const approvalSeams = { approval: ctx.approval, feed: ctx }
  let store = await ControlSessionStore.open({ persistence, controlId: CONTROL, registry, subjects: SUBJECTS })
  let commands = createReleaseCommands({ store, approvalSeams })

  try {
    // ---------------------------------------------------------------- the seam, live
    ctx.llm.registerAdapter(['scripted'], new (scriptedAdapter(LlmAdapter))())
    const handle = await ctx.agents.create({
      sessionId: SessionId('probe-release-agent'),
      meta: { cwd: root },
      agentOptions: { provider: 'scripted', model: 'stub-1' },
    })
    const userMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

    /** The one approval the next tool call is asked to record, and the answerer chain's answer. */
    let pending
    let decision = 'allowed-once'
    let answerer

    ctx.tools.register({
      name: 'release_approve',
      description: 'record a human authorisation of the drafted revision',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (_args, exec) => {
        const request = pending
        if (request === undefined) return { skipped: true }
        try {
          const envelope = await commands.approve({
            commandId: request.commandId,
            environmentId: request.environmentId,
            revisionId: request.revisionId,
            draftDigest: request.draftDigest,
            approvedBy: ALICE,
            ask: {
              agent: exec.agent,
              toolName: 'release_approve',
              callId: exec.callId,
              reason: 'publishing this content is a decision',
              ...(request.signal === undefined ? {} : { signal: request.signal }),
            },
          })
          return { approved: true, approvalId: envelope.payload.approvalId }
        } catch (error) {
          if (error instanceof ProtocolRefusal) return { refused: error.refusal.code, detail: error.refusal.detail }
          throw error
        }
      },
    })

    /** Drive one turn whose tool call asks the seam for the queued approval. */
    const askOnce = async (request, label) => {
      pending = request
      handle.agent.followup(userMessage(label))
      await handle.agent.whenIdle()
      const events = handle.agent.session.snapshotEvents()
      return {
        result: events.filter(event => event.type === 'tool/result').at(-1)?.data?.message?.content,
        asked: events.filter(event => event.type === 'approval/asked').at(-1)?.data,
        decided: events.filter(event => event.type === 'approval/decided').at(-1)?.data,
      }
    }
    const contentOf = result => JSON.parse(result?.[0]?.text ?? '{}')

    const environmentOf = subject => store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, subject)
    const createRevision = async (subject, revisionId, manifest) => {
      await store.emit({
        commandId: `create-${subject}-${revisionId}`,
        protocol: ENVIRONMENT_PROTOCOL,
        version: ENVIRONMENT_VERSION,
        kind: ENVIRONMENT_KINDS.revisionCreated,
        subject,
        payload: { revisionId, manifest },
      })
      return environmentOf(subject).revisions[revisionId].contentDigest
    }
    const draft = async (subject, revisionId, digest) => {
      await commands.draft({ commandId: `draft-${subject}-${revisionId}`, revision: { environmentId: subject, revisionId, digest } })
      return digest
    }
    const releaseOf = subject => store.load().stateOf(RELEASE_PROTOCOL, RELEASE_VERSION, subject)
    const pointerFacts = () =>
      store.load().entriesOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).filter(entry => entry.kind === ENVIRONMENT_KINDS.pointerSwitched)

    console.log(`session ${store.sessionId}; agent ${handle.agent.id}`)

    // ---------------------------------------------------------------- 1. no answerer: fail closed
    const digestA = await createRevision(LIBRARY, R1, MANIFEST_A)
    await draft(LIBRARY, R1, digestA)
    const unavailable = await askOnce({ commandId: 'approve-unavailable', environmentId: LIBRARY, revisionId: R1, draftDigest: digestA }, 'ask with no answerer')
    check('a draft records the content digest the log holds', releaseOf(LIBRARY)?.draftDigest === digestA, releaseOf(LIBRARY)?.draftDigest)
    check('with no answerer composed, the ask resolves unavailable', unavailable.decided?.outcome === 'unavailable', JSON.stringify(unavailable.decided))
    check('an unavailable answerer is not consent: the command refuses', contentOf(unavailable.result).refused === 'unapproved-revision', JSON.stringify(contentOf(unavailable.result)))
    check('and no approval fact was written', releaseOf(LIBRARY)?.approvedBy === undefined)

    // ---------------------------------------------------------------- 2. an answerer that says no
    answerer = ctx.on('approval/request', async () => decision)
    decision = 'rejected'
    const rejected = await askOnce({ commandId: 'approve-rejected', environmentId: LIBRARY, revisionId: R1, draftDigest: digestA }, 'ask a rejecting answerer')
    check('a rejecting answerer is not consent either', contentOf(rejected.result).refused === 'unapproved-revision', JSON.stringify(contentOf(rejected.result)))
    check('the refusal names the native outcome', contentOf(rejected.result).detail?.includes('rejected') === true, contentOf(rejected.result).detail)
    check('and still no approval fact exists', releaseOf(LIBRARY)?.approvedBy === undefined)

    // ---------------------------------------------------------------- 2b. a withdrawn question
    const controller = new AbortController()
    controller.abort()
    const cancelled = await askOnce({ commandId: 'approve-cancelled', environmentId: LIBRARY, revisionId: R1, draftDigest: digestA, signal: controller.signal }, 'ask with a withdrawn question')
    check('a withdrawn question settles cancelled', cancelled.decided?.outcome === 'cancelled', JSON.stringify(cancelled.decided))
    check('and a cancelled ask is not consent either', contentOf(cancelled.result).refused === 'unapproved-revision', JSON.stringify(contentOf(cancelled.result)))
    check('so the release is still unapproved', releaseOf(LIBRARY)?.approvedBy === undefined)

    // ---------------------------------------------------------------- 3. an answerer that grants
    decision = 'allowed-once'
    const granted = await askOnce({ commandId: 'approve-granted', environmentId: LIBRARY, revisionId: R1, draftDigest: digestA }, 'ask a granting answerer')
    const recorded = releaseOf(LIBRARY)
    check('the grant is recorded as an approval', contentOf(granted.result).approved === true, JSON.stringify(contentOf(granted.result)))
    check('the approval carries the audit id of the question the service logged', recorded?.approvalId === granted.asked?.id, `${recorded?.approvalId} vs ${granted.asked?.id}`)
    check('the audit pair pairs one id with the granted outcome', granted.asked?.id === granted.decided?.id && granted.decided?.outcome === 'allowed-once')
    check('the approval names the human and the content on the table', recorded?.approvedBy === ALICE && recorded?.draftDigest === digestA)

    // ---------------------------------------------------------------- 4. the head moves by CAS
    const unapproved = await asyncRefusalOf(() => commands.publish({ commandId: 'publish-r2-unapproved', environmentId: LIBRARY, expected: '', to: R2 }))
    check('the head does not move onto a revision nobody approved', unapproved.code === 'unapproved-revision', unapproved.code)

    await commands.publish({ commandId: 'publish-r1', environmentId: LIBRARY, expected: '', to: R1 })
    check('a switch from the empty head sets it', environmentOf(LIBRARY)?.pointer === R1)

    const stale = await asyncRefusalOf(() => commands.publish({ commandId: 'publish-r1-stale', environmentId: LIBRARY, expected: '', to: R1 }))
    check('a switch whose expected head already moved is refused', stale.code === 'illegal-transition', stale.code)
    const noop = await asyncRefusalOf(() => commands.publish({ commandId: 'publish-r1-noop', environmentId: LIBRARY, expected: R1, to: R1 }))
    check('a no-op switch is refused rather than treated as idempotent', noop.code === 'illegal-transition', noop.code)
    check('neither refused switch reached the log', pointerFacts().length === 1, String(pointerFacts().length))

    // ---------------------------------------------------------------- 5. one id, two environments
    const digestAElsewhere = await createRevision(OTHER_LIBRARY, R1, MANIFEST_B)
    check('two environments hold one revision id at different content', digestA !== digestAElsewhere)
    await draft(OTHER_LIBRARY, R1, digestAElsewhere)
    const grantedElsewhere = await askOnce({ commandId: 'approve-elsewhere', environmentId: OTHER_LIBRARY, revisionId: R1, draftDigest: digestAElsewhere }, 'ask for the other environment')
    check('the other environment approves its own content', contentOf(grantedElsewhere.result).approved === true, JSON.stringify(contentOf(grantedElsewhere.result)))
    await commands.publish({ commandId: 'publish-elsewhere', environmentId: OTHER_LIBRARY, expected: '', to: R1 })
    check('each environment publishes its own r0001', environmentOf(OTHER_LIBRARY)?.pointer === R1 && environmentOf(LIBRARY)?.pointer === R1)
    check(
      'and the two heads name different content',
      environmentOf(OTHER_LIBRARY).revisions[R1].contentDigest !== environmentOf(LIBRARY).revisions[R1].contentDigest,
    )

    // ---------------------------------------------------------------- 6. a second release, and the race
    const digestB = await createRevision(LIBRARY, R2, MANIFEST_B)
    await draft(LIBRARY, R2, digestB)
    const grantedAgain = await askOnce({ commandId: 'approve-r2', environmentId: LIBRARY, revisionId: R2, draftDigest: digestB }, 'ask for the next revision')
    check('a new draft supersedes the consumed approval, and its own grant is recorded', contentOf(grantedAgain.result).approved === true && releaseOf(LIBRARY)?.revisionId === R2)

    const race = await Promise.allSettled([
      commands.publish({ commandId: 'publish-race-a', environmentId: LIBRARY, expected: R1, to: R2 }),
      commands.publish({ commandId: 'publish-race-b', environmentId: LIBRARY, expected: R1, to: R2 }),
    ])
    const won = race.filter(result => result.status === 'fulfilled')
    const lost = race.filter(result => result.status === 'rejected')
    check('of two concurrent switches with one expected head, exactly one commits', won.length === 1 && lost.length === 1, `${won.length}/${lost.length}`)
    check('the loser is refused as a stale expectation', lost[0]?.reason?.refusal?.code === 'illegal-transition', lost[0]?.reason?.refusal?.code)
    check('the head is the winner’s target', environmentOf(LIBRARY)?.pointer === R2)
    check('and exactly one more pointer fact was appended', pointerFacts().length === 3, String(pointerFacts().length))

    // ---------------------------------------------------------------- 7. content the log does not hold
    await store.emit({
      commandId: 'forged-draft',
      protocol: RELEASE_PROTOCOL,
      version: RELEASE_VERSION,
      kind: 'release/drafted',
      subject: OTHER_LIBRARY,
      payload: { revisionId: R2, draftDigest: digestA },
    })
    await store.emit({
      commandId: 'forged-approval',
      protocol: RELEASE_PROTOCOL,
      version: RELEASE_VERSION,
      kind: 'release/approved',
      subject: OTHER_LIBRARY,
      payload: { revisionId: R2, draftDigest: digestA, approvedBy: 'human:mallory', approvalId: 'audit-forged' },
    })
    await store.emit({
      commandId: 'forged-revision',
      protocol: ENVIRONMENT_PROTOCOL,
      version: ENVIRONMENT_VERSION,
      kind: ENVIRONMENT_KINDS.revisionCreated,
      subject: OTHER_LIBRARY,
      payload: { revisionId: R2, manifest: MANIFEST_B },
    })
    const forged = await asyncRefusalOf(() => commands.publish({ commandId: 'publish-forged', environmentId: OTHER_LIBRARY, expected: R1, to: R2 }))
    check('a head whose approved content this environment does not hold is refused', forged.code === 'unknown-revision', forged.code)
    check('and that environment’s head did not move', environmentOf(OTHER_LIBRARY)?.pointer === R1)

    // ---------------------------------------------------------------- 7b. an ask with no open turn
    const idle = await asyncRefusalOf(() => askForApproval(approvalSeams, { agent: handle.agent, toolName: 'release_approve' }))
    check('an ask outside any turn is refused by name, not taken as an answer', idle.code === 'write-not-durable' && idle.detail.includes('outside an open turn'), idle.detail)

    // ---------------------------------------------------------------- 8. the head is derived
    const head = environmentOf(LIBRARY)?.pointer
    const facts = store.load().entries().length
    const refolded = foldSubjects(registry, store.load().entries(), ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).get(LIBRARY)
    check('folding the same facts again yields the same head', refolded?.pointer === head, refolded?.pointer)
    check('the head is a member of no payload, only of the fold', pointerFacts().every(entry => !Object.hasOwn(entry.payload, 'pointer')))
    check('the approval fact carries the audit id, not a digest of tool arguments', releaseOf(LIBRARY)?.approvalId === contentOf(grantedAgain.result).approvalId)

    answerer?.()
    await handle.dispose()
    await store.close()

    store = await ControlSessionStore.open({ persistence, controlId: CONTROL, registry, subjects: SUBJECTS })
    commands = createReleaseCommands({ store, approvalSeams })
    check('the reopened store holds every committed fact', store.load().entries().length === facts, String(store.load().entries().length))
    check('the reopened store reads the same head', environmentOf(LIBRARY)?.pointer === head, environmentOf(LIBRARY)?.pointer)
    check(
      'the reopened facts re-verify: the fold agrees with the live cut',
      foldSubjects(registry, store.load().entries(), ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).get(LIBRARY)?.pointer === head,
    )
    check('the reopened release still carries its audit id', releaseOf(LIBRARY)?.approvedBy === ALICE && releaseOf(LIBRARY)?.approvalId === contentOf(grantedAgain.result).approvalId)

    // ---------------------------------------------------------------- 9. version discipline
    const v1 = refusalOf(() => registry.ruleFor(ENVIRONMENT_PROTOCOL, 1, ENVIRONMENT_KINDS.revisionCreated))
    check('environment@1 is refused by name', v1.code === 'version-mismatch' && v1.detail.includes('declared at 2'), v1.detail)
    const guarantees = registry.ruleFor(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT_KINDS.pointerSwitched).guarantees
    check('pointer/switched is appended, conditional and atomic', guarantees.appended === true && guarantees.conditional === true && guarantees.atomicFact === true)
    check('exactly one protocol owns the conditional discipline', registry.conditionalOwner() === ENVIRONMENT_PROTOCOL, registry.conditionalOwner())

    console.log('')
    console.log(`  facts ${facts}; head ${head}; pointer facts ${pointerFacts().length}; approvals 3; non-grant answers 3; failed asks 1`)

    await store.close()
    await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()

if (failures.length > 0) {
  console.error(`\nrelease-probe: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('\nrelease-probe: OK — the native seam grants, the approval binds content, and the head moves only by compare-and-swap')
}
