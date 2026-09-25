/**
 * The question plane in a real assembled request (A4 §F.1, §7.2, §7.3): what a
 * deployment's model request carries once a child has asked its parent
 * something, and what leaves it only when the Session's own log shows the model
 * was given the answer.
 *
 * What is real here: the `system-prompt/assemble` waterfall the deployment
 * mounts, the real `TaskService` and its store, the real graph registry facts
 * the caller is resolved from, the read core mounted where the bundle mounts it,
 * and the real JSONL session log the consumption fold reads. What the case
 * writes through the store's own entries is the question fact itself
 * (`askParentQuestionIn` / `answerParentQuestionIn`): turning a model's
 * `task_ask_parent` call into that entry is the tool layer's job (subgoal ③c,
 * pinned in `a4-question-coordination.spec.ts`), and the entry is what the
 * projection reads. The one Session fact the child side needs — the answer put
 * in front of the model — is appended in the exact shape the loop writes it
 * (`AssemblyStack.appendMessage`).
 *
 * The tree is root → child → grandchild, all three runs live: the grandchild
 * asks the child (so the child is a *worker* parent with an open question), the
 * child asks the root (so the root is a parent too, and the child has an answer
 * addressed to it), and the root answers the child.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { questionIdOf, rootTaskStoreId, sha256Hex } from '../../task/src/index.ts'
import type { RootContractSpec } from '../../task-runtime/src/index.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/** Every stack a case booted, so a failing case cannot leak a workspace. */
const stacks: AssemblyStack[] = []

async function boot(): Promise<AssemblyStack> {
  const stack = await startAssemblyStack({
    graphs: [{ id: 'g1', rootSessionId: 's-root', members: ['s-child', 's-gchild'] }],
  })
  stacks.push(stack)
  return stack
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await Promise.race([stack.dispose({ remove: stack.dir.includes('singularity-assembly-') }), new Promise(resolve => { setTimeout(resolve, 2_000).unref() })])
  }
  vi.unstubAllEnvs()
})

/** The root contract every case runs under (A0 §1.2). */
const ROOT_CONTRACT: RootContractSpec = {
  objective: 'ship the release',
  acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
}

/** One worker seeded through the store's own entries, with its run already active. */
interface SeededWorker {
  readonly taskId: string
  readonly runId: string
}

async function seedWorker(
  stack: AssemblyStack,
  spec: { readonly taskId: string; readonly sessionId: string; readonly runId: string; readonly parentTaskId: string; readonly depth: number; readonly objective: string },
): Promise<SeededWorker> {
  const storeId = stack.storeIdOf('s-root')
  await stack.seedLog(spec.sessionId, [`${spec.objective} (request)`])
  const criteria = [{
    criterionId: `${spec.taskId}-c1`,
    description: `${spec.objective} works`,
    verificationMode: 'deterministic' as const,
    requiredEvidence: [],
    mandatory: true,
    command: 'true',
  }]
  await stack.task.createTaskIn(storeId, {
    taskId: spec.taskId,
    definitionRef: { taskType: 'subtask', version: 1 },
    parentTaskId: spec.parentTaskId,
    objective: spec.objective,
    depth: spec.depth,
    acceptanceCriteria: criteria,
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, spec.sessionId)
  await stack.task.admitTaskIn(storeId, spec.taskId, spec.sessionId, { decompositionStatus: 'leaf' })
  await stack.task.startRunIn(storeId, {
    runId: spec.runId,
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    executionPhase: 'active',
    startedAt: new Date().toISOString(),
  }, spec.sessionId)
  return { taskId: spec.taskId, runId: spec.runId }
}

/**
 * The three-layer tree, with both questions asked and (when `answer` is set)
 * answered: the grandchild asks the child, the child asks the root, and the root
 * answers the child. Nothing here delivers a message — the delivery path has its
 * own specs — so the answer's own `messageId` is what a case then hands the
 * child's Session, if it wants the answer to count as read.
 */
async function questionTree(stack: AssemblyStack, options: { readonly answer?: boolean } = {}): Promise<{
  storeId: string
  rootRunId: string
  child: SeededWorker
  grandchild: SeededWorker
  childQuestionId: string
  grandchildQuestionId: string
  childAnswerMessageId: string
}> {
  const storeId = stack.storeIdOf('s-root')
  await stack.seedLog('s-root', ['ship the release'])
  const root = await stack.runtime.intakeRootContract(storeId, 's-root', ROOT_CONTRACT)
  const child = await seedWorker(stack, {
    taskId: 't-child',
    sessionId: 's-child',
    runId: 'r-child',
    parentTaskId: root.taskId,
    depth: 1,
    objective: 'child: build the bridge',
  })
  const grandchild = await seedWorker(stack, {
    taskId: 't-gchild',
    sessionId: 's-gchild',
    runId: 'r-gchild',
    parentTaskId: child.taskId,
    depth: 2,
    objective: 'grandchild: build the deck',
  })

  // The child asks the root. The citation is a seq in the asking run's own
  // Session, which is what the store checks; the digest stands for the body the
  // Session holds.
  await stack.task.askParentQuestionIn(storeId, {
    childRunId: child.runId,
    requestKey: 'k-child-1',
    questionDigest: sha256Hex('which span does the bridge carry?'),
    questionRef: { sessionId: 's-child', seq: 0 },
    messageId: 'm-question-child-1',
    blocking: true,
  }, 's-child')
  // The grandchild asks the child: the same question plane, one layer down.
  await stack.task.askParentQuestionIn(storeId, {
    childRunId: grandchild.runId,
    requestKey: 'k-gchild-1',
    questionDigest: sha256Hex('which material for the deck?'),
    questionRef: { sessionId: 's-gchild', seq: 0 },
    messageId: 'm-question-gchild-1',
    blocking: false,
  }, 's-gchild')

  const childQuestionId = questionIdOf({ childRunId: child.runId, requestKey: 'k-child-1' })
  const grandchildQuestionId = questionIdOf({ childRunId: grandchild.runId, requestKey: 'k-gchild-1' })
  const childAnswerMessageId = 'm-answer-child-1'
  if (options.answer === true) {
    await stack.task.answerParentQuestionIn(storeId, {
      questionId: childQuestionId,
      parentRunId: root.runId,
      requestKey: 'a-child-1',
      answerDigest: sha256Hex('the span is fixed by the accepted contract'),
      resolves: true,
      answerRef: { sessionId: 's-root', seq: 0 },
      messageId: childAnswerMessageId,
    }, 's-root')
  }
  return { storeId, rootRunId: root.runId, child, grandchild, childQuestionId, grandchildQuestionId, childAnswerMessageId }
}

/** The names of the runtime contexts one session's request is assembled with. */
async function contextNames(stack: AssemblyStack, sessionId: string): Promise<string[]> {
  return (await stack.assemble(sessionId)).contexts.map(context => context.name)
}

describe('the questions a parent owes an answer to reach its request (A4 §F.1)', () => {
  it('shows the root the question its child asked, and a worker parent the question its own child asked', async () => {
    const stack = await boot()
    // Nothing to say before anything is asked: a root whose graph holds no
    // contract yet assembles no question plane at all — no header, no empty
    // context, nothing for the loop to deduplicate.
    expect(await contextNames(stack, 's-root')).toEqual([])

    const tree = await questionTree(stack)

    const rootSnapshot = await stack.contextSnapshot('s-root')
    expect(rootSnapshot).toContain('# Pending questions (coordination)')
    expect(rootSnapshot).toContain('role: root')
    expect(rootSnapshot).toContain('## Questions waiting for your answer (1)')
    expect(rootSnapshot).toContain(`- ${tree.childQuestionId} — from child run r-child (task t-child), blocking: yes`)
    expect(rootSnapshot).toContain('ref:{"sessionId":"s-child","seq":0}')
    expect(rootSnapshot).toContain('Answer a question with `task_answer`')
    // The question the grandchild asked is not the root's business.
    expect(rootSnapshot).not.toContain(tree.grandchildQuestionId)

    const childSnapshot = await stack.contextSnapshot('s-child')
    expect(childSnapshot).toContain('role: worker')
    expect(childSnapshot).toContain('## Questions waiting for your answer (1)')
    expect(childSnapshot).toContain(`- ${tree.grandchildQuestionId} — from child run r-gchild (task t-gchild), blocking: no`)
    expect(childSnapshot).toContain('ref:{"sessionId":"s-gchild","seq":0}')
    // The same assembled request carries the dynamic plane, with the child's own
    // open blocking question shown as `waiting_answer` — derived, not written;
    // the root's own request has its stored phase and no derived word.
    expect(childSnapshot).toContain('gate phase:')
    expect(childSnapshot).toContain('your run: run r-child [running] — phase waiting_answer')
    expect(rootSnapshot).not.toContain('waiting_answer')
    expect(await contextNames(stack, 's-child')).toEqual(['singularity:state', 'singularity:questions'])
    // The grandchild has no question of its own and nothing addressed to it.
    expect(await contextNames(stack, 's-gchild')).toEqual(['singularity:state'])
  })
})

describe('an unread answer reaches the asking request and leaves only on proof (A4 §7.3)', () => {
  it('shows the child its unread answer, and drops it once the Session log holds the message', async () => {
    const stack = await boot()
    const tree = await questionTree(stack, { answer: true })

    // The question is gone from the root's request — it answered it — and the
    // answer is in the asking child's request.
    const rootSnapshot = await stack.contextSnapshot('s-root')
    expect(rootSnapshot).not.toContain(tree.childQuestionId)
    expect(rootSnapshot).not.toContain('# Pending questions (coordination)')

    const childSnapshot = await stack.contextSnapshot('s-child')
    expect(childSnapshot).toContain('## Answers waiting to be read (1)')
    expect(childSnapshot).toContain(`the answer to question ${tree.childQuestionId}, resolves: yes`)
    expect(childSnapshot).toContain('ref:{"sessionId":"s-root","seq":0}')
    // The resolving answer released the child's own block, so the derived phase
    // is the stored one again.
    expect(childSnapshot).toContain('your run: run r-child [running] — phase active')
    expect(childSnapshot).toContain('## Questions waiting for your answer (1)')

    // The proof: the answer's own message id as a `user/message` event in the
    // child's Session — what the loop writes when the message reaches a request.
    await stack.appendMessage('s-child', tree.childAnswerMessageId)
    const afterReading = await stack.contextSnapshot('s-child')
    expect(afterReading).not.toContain('## Answers waiting to be read')
    expect(afterReading).not.toContain(tree.childQuestionId)
    // The grandchild's question is still the child's own open item: proving one
    // answer was read says nothing about anything else.
    expect(afterReading).toContain('## Questions waiting for your answer (1)')
    expect(afterReading).toContain(tree.grandchildQuestionId)

    // A grandchild answered in turn shows the same shape one layer down.
    const storeId = stack.storeIdOf('s-root')
    await stack.task.answerParentQuestionIn(storeId, {
      questionId: tree.grandchildQuestionId,
      parentRunId: tree.child.runId,
      requestKey: 'a-gchild-1',
      answerDigest: sha256Hex('the deck is aluminium'),
      resolves: true,
      answerRef: { sessionId: 's-child', seq: 1 },
      messageId: 'm-answer-gchild-1',
    }, 's-child')
    expect(await stack.contextSnapshot('s-gchild')).toContain('the answer to question ' + tree.grandchildQuestionId)
    await stack.appendMessage('s-gchild', 'm-answer-gchild-1', 'the deck is aluminium')
    expect(await stack.contextSnapshot('s-gchild')).not.toContain(tree.grandchildQuestionId)
    expect(await contextNames(stack, 's-gchild')).toEqual(['singularity:state'])
  })
})

describe('assembling the question plane changes nothing', () => {
  it('is byte-stable across assemblies and writes no store event', async () => {
    const stack = await boot()
    const tree = await questionTree(stack)
    const events = (await stack.events(tree.storeId)).length

    const root = await stack.contextSnapshot('s-root')
    const child = await stack.contextSnapshot('s-child')
    expect(root).toContain(tree.childQuestionId)
    expect(child).toContain(tree.grandchildQuestionId)

    // Three more assemblies of both requests, plus the prompt itself: the same
    // bytes every time, and the store exactly where it stood.
    for (let index = 0; index < 3; index += 1) {
      expect(await stack.contextSnapshot('s-root')).toBe(root)
      expect(await stack.contextSnapshot('s-child')).toBe(child)
      await stack.prompt('s-root')
      await stack.prompt('s-child')
    }
    expect((await stack.events(tree.storeId)).length).toBe(events)
    // The run's stored phase is the protocol's own, never the derived word.
    const snapshot = await stack.snapshot(tree.storeId)
    expect(snapshot.runs.find(run => run.runId === tree.child.runId)?.executionPhase).toBe('active')
    // The store still holds exactly the one question per layer.
    expect(snapshot.questions?.all.map(question => question.questionId).sort())
      .toEqual([tree.childQuestionId, tree.grandchildQuestionId].sort())
    expect(rootTaskStoreId('s-root')).toBe(tree.storeId)
  })
})
