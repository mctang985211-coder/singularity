/** The shipped coordinator patch is mounted by the actual preset registry; the spawn role owns its policy. */
import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'
import { supervisorGrant } from '../../agent-singularity/src/coordination/roles.ts'

let stack: AssemblyStack | undefined
afterEach(async () => {
  await stack?.dispose()
  stack = undefined
  vi.unstubAllEnvs()
})

it('loads the coordinator host, installs only the supervisor policy, and records ask approval', async () => {
  stack = await startAssemblyStack({ coordinatorPreset: true })
  expect((await stack.ctx.agentPresets.resolve('singularity-coordinator')).id).toBe('singularity-coordinator')
  await expect(stack.ctx.agentPresets.resolve('singularity-reviewer')).rejects.toThrow()
  const rootSession = stack.roots[0]!
  await stack.seedLog(rootSession, ['review the recorded source'])
  const root = await stack.runtime.intakeRootContract(stack.storeIdOf(rootSession), rootSession, { requiredCapabilities: ['execute-task'],
    objective: 'review the recorded source', acceptanceCriteria: [{ criterionId: 'goal', description: 'the source is reviewed', command: 'true' }],
  })
  const handle = await stack.agentRuntime.spawn(stack.agent(stack.roots[0]!)!, {
    sessionId: SessionId('s-supervisor'), name: 'supervisor policy probe', agentPreset: 'singularity-coordinator',
    taskId: root.taskId, coordinationRole: 'supervisor', grant: supervisorGrant(), prompt: [{ type: 'text', text: 'Read the recorded source.' }],
  })
  expect(stack.spawns[0]).toMatchObject({ agentPreset: 'singularity-coordinator', coordinationRole: 'supervisor' })
  const prompt = await stack.prompt('s-supervisor')
  expect(prompt).toContain('You are a Singularity supervisor.')
  expect(prompt).not.toContain('You are a Singularity reviewer.')
  expect(prompt).not.toContain('Return the requested fenced JSON.')
  expect(handle.agent.session.append).toHaveBeenCalledWith('approval/policy', { policy: 'ask' })
  const skillFile = join(stack.checkout, 'SKILL.md')
  const toolFile = join(stack.checkout, 'resources', 'feedback.py')
  const skillText = '---\nname: target-method\ndescription: exact production method\n---\n\nRead resources/feedback.py.\n'
  const toolText = 'def score(cycles, cells):\n    return 1 / (cycles * cells)\n'
  mkdirSync(join(stack.checkout, 'resources'))
  writeFileSync(skillFile, skillText)
  writeFileSync(toolFile, toolText)
  const schemas = stack.ctx.tools.schemas(handle.agent).map(tool => tool.name)
  expect(schemas).toEqual(expect.arrayContaining(['read', 'glob', 'grep', 'skill']))
  for (const forbidden of ['write', 'edit', 'bash']) expect(schemas).not.toContain(forbidden)
  const skillRead = await stack.call('s-supervisor', 'read', { file_path: skillFile })
  const toolRead = await stack.call('s-supervisor', 'read', { file_path: toolFile })
  expect(skillRead.isError, skillRead.text).toBe(false)
  expect(skillRead.text).toContain('name: target-method')
  expect(skillRead.text).toContain('Read resources/feedback.py.')
  expect(toolRead.isError, toolRead.text).toBe(false)
  expect(toolRead.text).toContain('return 1 / (cycles * cells)')
})
