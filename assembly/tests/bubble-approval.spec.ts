import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Fs from '@deepseek-ai/dsh-fs-local'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { expect, it } from 'vitest'
import { mountBubbleWorld } from '../src/bubble.ts'

it('uses native headless rejection without pending approval while retaining confined execution and readonly roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bubble-approval-'))
  const ctx = new Context()
  try {
    const workspace = join(root, 'workspace'), reference = join(root, 'reference'), protectedDir = join(workspace, 'inputs')
    await Promise.all([mkdir(protectedDir, { recursive: true }), mkdir(reference)])
    await writeFile(join(reference, 'source.c'), 'frozen source\n')
    await writeFile(join(protectedDir, 'contract.json'), 'frozen contract\n')
    for (const plugin of [Llm, Sessions, Projections, SystemPrompt, Tools, AgentRegistry, Subprocess, ShellEnv]) await ctx.plugin(plugin)
    await ctx.plugin(Fs, { cwd: root })
    await ctx.plugin(Approval, { policy: 'ask' })
    await ctx.plugin(AgentLoop, { agents: [] })
    let answererCalls = 0
    ctx.on('approval/request', async () => { answererCalls++; return 'allowed-once' }, { prepend: true })
    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) })
    const create = async (id: string, readOnly: boolean) => {
      const agent = await ctx.agentLoop.create(SessionId(id), {}, { cwd: root })
      setApprovalPolicy(agent.session, 'ask')
      await mountBubbleWorld(agent, () => ({ root: workspace, writable: true, protected: [protectedDir], references: [reference] }), readOnly)
      expect(ctx.approval.overrideOf(agent.session)).toBe('never')
      const prompt = await ctx.systemPrompt.assemble({ scope: agent, agent })
      expect(prompt.contexts.find(section => section.name === 'approval:policy')?.text).toContain('Approval prompts are disabled')
      agent.session.append('turn/start', { turn: 1 })
      return agent
    }
    const child = await create('child', false)
    let call = 0
    const execute = (agent: typeof child, name: string, args: Record<string, unknown>) => ctx.tools.execute({
      agent, name, arguments: args, callId: ToolCallId(`approval-probe-${call++}`), signal: AbortSignal.timeout(2_000),
    })
    const written = await execute(child, 'write', { file_path: 'candidate.c', content: 'workspace candidate\n' })
    expect(written.isError, JSON.stringify(written)).not.toBe(true)
    expect(await readFile(join(workspace, 'candidate.c'), 'utf8')).toBe('workspace candidate\n')
    const compiled = await execute(child, 'bash', { command: 'cat candidate.c > checked.c', description: 'Check workspace execution.' })
    expect(compiled.isError, JSON.stringify(compiled)).not.toBe(true)
    expect(await readFile(join(workspace, 'checked.c'), 'utf8')).toBe('workspace candidate\n')
    const source = join(reference, 'source.c')
    expect((await execute(child, 'read', { file_path: source })).isError).not.toBe(true)
    for (const path of [source, join(protectedDir, 'contract.json')]) {
      const denied = await execute(child, 'write', { file_path: path, content: 'overwrite' })
      expect(denied.isError, JSON.stringify(denied)).toBe(true)
      const escalated = await execute(child, 'write', { file_path: path, content: 'overwrite',
        sandbox_permissions: 'danger-full-access', justification: 'Try overwriting frozen input.' })
      expect(escalated.isError, JSON.stringify(escalated)).toBe(true)
      expect(JSON.stringify(escalated)).toContain('rejected escalating')
    }
    const shellDenied = await execute(child, 'bash', { command: `printf overwrite > '${source}'`, description: 'Check reference isolation.' })
    expect(JSON.stringify(shellDenied)).toMatch(/Read-only file system|Permission denied/)
    const rootAgent = await create('readonly-root', true)
    expect((await execute(rootAgent, 'read', { file_path: 'candidate.c' })).isError).not.toBe(true)
    const rootWrite = await execute(rootAgent, 'write', { file_path: 'forbidden.c', content: 'overwrite' })
    expect(rootWrite.isError, JSON.stringify(rootWrite)).toBe(true)
    expect(JSON.stringify(rootWrite)).toContain('Bubble write denied')
    const rootEscalation = await execute(rootAgent, 'write', { file_path: 'forbidden.c', content: 'overwrite',
      sandbox_permissions: 'workspace-write', justification: 'Try enabling root writes.' })
    expect(rootEscalation.isError, JSON.stringify(rootEscalation)).toBe(true)
    expect(JSON.stringify(rootEscalation)).toContain('rejected escalating')
    expect(answererCalls).toBe(0)
    const asked = events.filter(event => event.type === 'approval/asked')
    const decided = events.filter(event => event.type === 'approval/decided')
    expect(asked).toHaveLength(3)
    expect(decided.map(event => event.data.outcome)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(decided.map(event => event.data.id)).toEqual(asked.map(event => event.data.id))
    expect(await readFile(source, 'utf8')).toBe('frozen source\n')
    expect(await readFile(join(protectedDir, 'contract.json'), 'utf8')).toBe('frozen contract\n')
    for (const agent of [child, rootAgent]) agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
