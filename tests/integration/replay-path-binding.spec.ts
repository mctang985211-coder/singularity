import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { disposeRunStacks, startRunStack } from '../support/run-stack.ts'

afterEach(disposeRunStacks)

it('verifies relocated commands and frozen protected inputs in two sides while preserving the original contract', async () => {
  const rootSession = 's-root' as SessionId
  const h = await startRunStack({ roots: [rootSession] })
  const originalInput = join(h.checkout, 'input.txt')
  await writeFile(originalInput, 'frozen')
  const root = await h.root(rootSession, {
    objective: `Check ${originalInput}`,
    requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ description: 'Frozen input matches expected output',
      command: `cmp '${originalInput}' expected.txt`, protectedInputs: [originalInput] }],
  })
  await writeFile(join(h.checkout, 'expected.txt'), 'frozen')
  expect(await h.runtime.submitResult(rootSession, { summary: 'Original input verified' })).toMatchObject({ status: 'verified' })
  const original = await h.task.taskIn(root.storeId, root.taskId)
  const sides = [join(h.workspace, 'baseline'), join(h.workspace, 'candidate')]
  for (const side of sides) {
    await mkdir(side)
    await writeFile(join(side, 'input.txt'), 'frozen')
    await writeFile(join(side, 'expected.txt'), 'frozen')
  }
  // The source no longer satisfies its old criterion. Both replays must judge
  // their own copies under the original protected content identity.
  await writeFile(originalInput, 'changed source')
  for (const [index, side] of sides.entries()) {
    const outcome = await h.runtime.replayTask(root.storeId, root.taskId, {
      lineage: `mapped-side-${index}`, spawn: false, workspace: { path: side, rebaseFrom: h.checkout },
    }, rootSession)
    expect(outcome.status).toBe('verified')
    const task = await h.task.taskIn(root.storeId, outcome.taskId)
    expect(task.acceptanceCriteria[0]!.command).toBe(`cmp '${join(side, 'input.txt')}' expected.txt`)
    expect(task.acceptanceCriteria[0]!.protectedInputs).toEqual([
      { ...original.acceptanceCriteria[0]!.protectedInputs![0]!, path: join(side, 'input.txt') },
    ])
    expect(task.objective).toContain(join(side, 'input.txt'))
  }
  expect(await h.task.taskIn(root.storeId, root.taskId)).toEqual(original)
  expect(await readFile(originalInput, 'utf8')).toBe('changed source')
})
