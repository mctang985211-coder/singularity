import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { createScope } from '@deepseek-ai/dsh-scope'
import { applyWorkerGrant, installGraphSkillCatalog } from '../../src/grants.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'singularity-catalog-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolSkill)
  cleanups.push(async () => { await ctx.fiber.dispose() })
  ctx.skills.register({ name: 'host-bb', description: 'Host BB method', source: 'runtime', content: 'host only' })
  ctx.skills.register({ name: 'deploy-method', description: 'Granted deployment method', source: 'runtime', content: 'deployment body' })
  const id = SessionId('catalog-agent')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: dir, isSeeded: false })
  const agent = { id, session } as Agent
  let scoped!: Context
  await ctx.plugin({
    inject: ['tools', 'skills', 'agents'],
    apply(inner: Context) { scoped = createScope(inner, agent).ctx },
  })
  const hostTool = ctx.tools.get('skill', agent)
  return { dir, ctx, agent, scoped, hostTool }
}

async function writeSkill(root: string, name: string, body: string) {
  await mkdir(join(root, name), { recursive: true })
  await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} guidance\n---\n${body}\n`)
}

async function step(ctx: Context, agent: Agent, messages: ReturnType<typeof createUserMessage>[] = []) {
  const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages, turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'enter' as const, messages }))
  if (decision.kind === 'reject') throw new Error('unexpected rejection')
  return decision.messages
}

const catalogs = (messages: Awaited<ReturnType<typeof step>>) => messages.filter(message => message.source.kind === 'skill-catalog')
const names = (messages: Awaited<ReturnType<typeof step>>) => catalogs(messages).flatMap(message =>
  message.source.kind === 'skill-catalog' ? message.source.entries.map(entry => entry.name) : [])

describe('agent-scoped Skill catalog on native DSH services', () => {
  test('graph catalog shadows the host once and refreshes additions, edits and retirement', async () => {
    const f = await fixture()
    const root = join(f.dir, 'graph-skills')
    await writeSkill(root, 'graph-method', 'version one')
    const rows = [{ name: 'graph-method', status: 'temporary' }]
    const local = await installGraphSkillCatalog(f.scoped, { skillRoots: [root], readLibrary: async () => ({ skills: rows }) })
    const localSkills = local.get('skills') as SkillRegistry
    f.scoped.tools.restrict({ allow: ['skill'] })
    expect(f.ctx.tools.get('skill', f.agent)).not.toBe(f.hostTool)
    expect(f.ctx.tools.schemas(f.agent).filter(tool => tool.name === 'skill')).toHaveLength(1)
    const initial = await step(f.ctx, f.agent)
    expect(catalogs(initial)).toHaveLength(1)
    expect(names(initial)).toEqual(['graph-method'])
    expect(await localSkills.get('host-bb', { scope: f.agent, cwd: f.dir })).toBeUndefined()
    await writeSkill(root, 'new-method', 'new experience')
    rows.push({ name: 'new-method', status: 'temporary' })
    expect(names(await step(f.ctx, f.agent))).toEqual(['graph-method', 'new-method'])
    await writeSkill(root, 'graph-method', 'version two')
    await step(f.ctx, f.agent)
    expect((await localSkills.get('graph-method', { scope: f.agent }))?.content).toContain('version two')
    rows[0]!.status = 'retired'
    expect(names(await step(f.ctx, f.agent))).toEqual(['new-method'])
  })

  test('worker exposes only frozen granted names and pins explicit deployment methods', async () => {
    const f = await fixture()
    const root = join(f.dir, 'run-skills')
    await writeSkill(root, 'run-method', 'frozen run body')
    await writeSkill(root, 'ungranted', 'unrelated method')
    await applyWorkerGrant(f.scoped, f.agent, {
      capabilities: [{ capability: 'execute', tools: [], skills: ['run-method', 'deploy-method'] }],
      baseline: ['skill'], keepPresetTools: false, skillRoots: [root],
    })
    expect(names(await step(f.ctx, f.agent))).toEqual(['deploy-method', 'run-method'])
    const initial = await step(f.ctx, f.agent)
    const bound = initial.filter(message => message.source.kind === 'task-skills')
    expect(bound).toHaveLength(1)
    expect(bound[0]!.source).toMatchObject({ names: ['run-method', 'deploy-method'] })
    expect(JSON.stringify(bound[0]!.content)).toContain('frozen run body')
    expect(JSON.stringify(bound[0]!.content)).not.toContain('unrelated method')
    const repeated = await step(f.ctx, f.agent, initial as never)
    expect(repeated.filter(message => message.source.kind === 'task-skills')).toHaveLength(1)
    const tool = f.ctx.tools.get('skill', f.agent)!
    const exec = { agent: f.agent, signal: new AbortController().signal } as Parameters<typeof tool.execute>[1]
    expect(await tool.execute({ name: 'run-method' }, exec)).toMatchObject({ content: 'frozen run body\n' })
    expect(await tool.execute({ name: 'deploy-method' }, exec)).toMatchObject({ content: 'deployment body' })
    await writeSkill(root, 'run-method', 'changed after grant')
    expect(JSON.stringify((await step(f.ctx, f.agent)).find(message => message.source.kind === 'task-skills')!.content)).toContain('frozen run body')
    expect(await tool.execute({ name: 'run-method' }, exec)).toMatchObject({ content: 'frozen run body\n' })
    await expect(tool.execute({ name: 'host-bb' }, exec)).rejects.toThrow('unknown or no longer available')
    await expect(tool.execute({ name: 'ungranted' }, exec)).rejects.toThrow('unknown or no longer available')
    const invoked = await step(f.ctx, f.agent, [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/host-bb' }] })])
    expect(invoked.filter(message => message.source.kind === 'skill-invocation')).toHaveLength(0)
    const grantedInvocation = await step(f.ctx, f.agent, [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/deploy-method' }] })])
    expect(grantedInvocation.filter(message => message.source.kind === 'skill-invocation')).toHaveLength(1)
  })

  test('local loader does not add skill access to a worker whose allow-list omits it', async () => {
    const f = await fixture()
    await applyWorkerGrant(f.scoped, f.agent, { capabilities: [], baseline: [], keepPresetTools: false })
    expect(f.ctx.tools.get('skill', f.agent)).toBeUndefined()
    expect(catalogs(await step(f.ctx, f.agent))).toHaveLength(0)
  })

  test('visible instructions survive Session reload and return once compaction replaces their node', async () => {
    const f = await fixture()
    await applyWorkerGrant(f.scoped, f.agent, {
      capabilities: [{ capability: 'execute', tools: [], skills: ['deploy-method'] }],
      baseline: [], keepPresetTools: false,
    })
    const initial = await step(f.ctx, f.agent)
    const message = initial.find(message => message.source.kind === 'task-skills')!
    const event = f.agent.session.append('user/message', message, { surfaceOp: 'append' })
    const original = f.agent.session
    const events = Array.from({ length: original.seq }, (_, index) => original.eventAt(SessionSeq(index))!)
    const reloaded = Session.create(original.id, JSON.parse(JSON.stringify(events)), original.header)
    Object.defineProperty(f.agent, 'session', { value: reloaded })
    expect((await step(f.ctx, f.agent)).filter(message => message.source.kind === 'task-skills')).toHaveLength(0)
    reloaded.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted task context' }] }), {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
      sourceEventSeqs: [event.seq],
    })
    const restored = (await step(f.ctx, f.agent)).filter(message => message.source.kind === 'task-skills')
    expect(restored).toHaveLength(1)
    expect(JSON.stringify(restored[0])).toContain('deployment body')
  })
})
