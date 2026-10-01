import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EscalationService } from '../../src/services/escalation.ts'
import type { EscalationInput } from '../../src/services/escalation.ts'
import { defineEscalateTool } from '../../src/tools/escalate.ts'

function fixtureCtx() {
  return { reflect: { provide: () => {} }, effect: () => {} } as never
}

async function service() {
  const root = await mkdtemp(join(tmpdir(), 'escalation-'))
  return new EscalationService(fixtureCtx(), { root })
}

const card: EscalationInput = {
  escalationId: 'esc-1',
  what: 'capability "fly-to-moon" is not granted by the registry',
  tried: 'capability_list and the children\'s declared capabilities',
  suggested: 'grant the capability, or mark the child decomposable',
  trigger: 'capability-gap',
  sourceTaskId: 't-root',
  sourceRefs: ['task:t-root'],
}

function toolCtx(svc: EscalationService, approvalOutcome: string = 'allowed-once') {
  const approval = { request: vi.fn(async () => approvalOutcome) }
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    escalation: svc,
    approval,
  }
  return { ctx: ctx as never, approval }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

describe('EscalationService ledger', () => {
  it('records one immutable card per id and derives its history from the appended line', async () => {
    const svc = await service()
    const raised = await svc.raise(card, 'root-1', 'approval:call-1')
    expect(raised.status).toBe('open')
    expect(raised.history).toEqual([{ status: 'open', actor: 'root-1', at: raised.at }])

    // The ledger is the service's own file under its root, one JSON object per line.
    expect(svc.file).toBe(join(svc.root, 'escalations.jsonl'))
    const lines = (await readFile(svc.file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      formatVersion: 1,
      kind: 'raised',
      escalationId: 'esc-1',
      trigger: 'capability-gap',
      approvalRef: 'approval:call-1',
      actor: 'root-1',
    })

    expect(await svc.get('esc-1')).toMatchObject({ escalationId: 'esc-1', what: card.what })
    expect((await svc.list()).map(item => item.escalationId)).toEqual(['esc-1'])
  })

  it('derives an id when the caller supplies none and lists newest first', async () => {
    const svc = await service()
    const { escalationId } = await svc.raise({ ...card, escalationId: undefined }, 'root-1', 'approval:call-1')
    expect(escalationId).toMatch(/^esc-/)
    await svc.raise({ ...card, escalationId: 'esc-2' }, 'root-1', 'approval:call-2')
    expect((await svc.list()).map(item => item.escalationId)).toEqual(['esc-2', escalationId])
  })

  it('refuses a repeated id', async () => {
    const svc = await service()
    await svc.raise(card, 'root-1', 'approval:call-1')
    await expect(svc.raise(card, 'root-1', 'approval:call-2')).rejects.toThrow('already exists')
  })

  it('requires the three KISS §7 elements, a known trigger, and human-approval evidence', async () => {
    const svc = await service()
    await expect(svc.raise({ ...card, what: '   ' }, 'root-1', 'approval:call-1')).rejects.toThrow('what must be a non-empty string')
    await expect(svc.raise({ ...card, tried: '' }, 'root-1', 'approval:call-1')).rejects.toThrow('tried must be a non-empty string')
    await expect(svc.raise({ ...card, suggested: '' }, 'root-1', 'approval:call-1')).rejects.toThrow('suggested must be a non-empty string')
    await expect(svc.raise({ ...card, trigger: 'nudge' as never }, 'root-1', 'approval:call-1')).rejects.toThrow('unknown trigger')
    await expect(svc.raise(card, 'root-1', '')).rejects.toThrow('approvalRef must be a non-empty string')
    await expect(svc.raise({ ...card, sourceRefs: ['ok', ' '] }, 'root-1', 'approval:call-1')).rejects.toThrow('sourceRefs')
    expect(existsSync(svc.file)).toBe(false)
  })

  it('rejects a forged ledger line on load: unknown kind, missing field, unsupported formatVersion, corrupt JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'escalation-forged-'))
    const file = join(root, 'escalations.jsonl')
    const line = (record: unknown) => `${JSON.stringify({ formatVersion: 1, kind: 'raised', ...(record as object) })}\n`

    await writeFile(file, line({ ...card, kind: 'resolved' }))
    await expect(new EscalationService(fixtureCtx(), { root }).list()).rejects.toThrow('unknown ledger kind "resolved"')

    const { what: _what, ...withoutWhat } = card
    await writeFile(file, line(withoutWhat))
    await expect(new EscalationService(fixtureCtx(), { root }).list()).rejects.toThrow('what must be a non-empty string')

    await writeFile(file, `${JSON.stringify({ ...card, formatVersion: 2 })}\n`)
    await expect(new EscalationService(fixtureCtx(), { root }).list()).rejects.toThrow('unsupported ledger formatVersion "2"')

    await writeFile(file, 'not json\n')
    await expect(new EscalationService(fixtureCtx(), { root }).list()).rejects.toThrow('corrupt ledger line 1')
  })

  it('rejects a ledger that records the same id twice, on load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'escalation-dup-'))
    await writeFile(join(root, 'escalations.jsonl'), `${JSON.stringify(cardLine(card))}\n${JSON.stringify(cardLine(card))}\n`)
    await expect(new EscalationService(fixtureCtx(), { root }).list()).rejects.toThrow('escalation "esc-1" already exists')
  })

  it('replays the ledger through append → close → open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'escalation-replay-'))
    const first = new EscalationService(fixtureCtx(), { root })
    await first.raise(card, 'root-1', 'approval:call-1')
    const reopened = new EscalationService(fixtureCtx(), { root })
    expect((await reopened.list())[0]).toMatchObject({ escalationId: 'esc-1', approvalRef: 'approval:call-1', status: 'open' })
  })
})

/** A full raised line, for hand-forged ledgers. */
function cardLine(input: EscalationInput) {
  return {
    formatVersion: 1 as const,
    kind: 'raised' as const,
    escalationId: input.escalationId!,
    what: input.what,
    tried: input.tried,
    suggested: input.suggested,
    trigger: input.trigger,
    sourceRefs: [...(input.sourceRefs ?? [])],
    approvalRef: 'approval:call-1',
    actor: 'root-1',
    at: new Date().toISOString(),
  }
}

describe('escalate tool', () => {
  it('records the card only after a human approve through the native approval seam', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc, 'allowed-once')
    const result = (await defineEscalateTool(ctx).execute({ ...card }, exec('root-1'))) as string

    expect(approval.request).toHaveBeenCalledOnce()
    const request = approval.request.mock.calls[0]![0] as { toolName: string; reason: string }
    expect(request.toolName).toBe('escalate')
    expect(request.reason).toContain('L4 escalation — a human decision is required')
    expect(request.reason).toContain(`what: ${card.what}`)
    expect(request.reason).toContain(`tried: ${card.tried}`)
    expect(request.reason).toContain(`suggested: ${card.suggested}`)

    expect(result).toContain('escalation esc-1 recorded [open] trigger: capability-gap')
    expect(result).toContain(`what: ${card.what}`)
    expect(result).toContain(`tried: ${card.tried}`)
    expect(result).toContain(`suggested: ${card.suggested}`)
    expect(result).toContain('acceptance: all three elements present (what / tried / suggested)')
    expect(result).toContain('recorded after human approval approval:call-1')
    expect(result).toContain(`ledger: ${svc.file}`)

    const lines = (await readFile(svc.file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'raised', approvalRef: 'approval:call-1' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'escalate records nothing when the approval comes back %s',
    async outcome => {
      const svc = await service()
      const { ctx, approval } = toolCtx(svc, outcome)
      const result = (await defineEscalateTool(ctx).execute({ ...card }, exec('root-1'))) as string
      expect(approval.request).toHaveBeenCalledOnce()
      expect(result).toContain('no escalation recorded')
      expect(existsSync(svc.file)).toBe(false)
    },
  )

  it('refuses an incomplete card loudly, without asking the human', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc)
    const result = (await defineEscalateTool(ctx).execute(
      { what: card.what, trigger: 'budget-exhausted' },
      exec('root-1'),
    )) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('incomplete L4 card — tried, suggested are missing')
    expect(result).toContain('a human must be able to decide in ten minutes')
    expect(existsSync(svc.file)).toBe(false)
  })

  it('refuses an omitted trigger without asking the human, and the schema refuses an unknown one', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc)
    const tool = defineEscalateTool(ctx)
    const result = (await tool.execute(
      { what: card.what, tried: card.tried, suggested: card.suggested },
      exec('root-1'),
    )) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('trigger must be one of capability-gap / budget-exhausted / unknown-convergence / human')
    expect(existsSync(svc.file)).toBe(false)

    await expect(tool.execute({ ...card, trigger: 'nudge' }, exec('root-1'))).rejects.toThrow(/must be one of/)
  })

  it('lists the recorded cards in read-only mode, without asking the human', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc)
    const tool = defineEscalateTool(ctx)
    expect(await tool.execute({ list: true })).toBe('escalations: none recorded')

    await tool.execute({ ...card }, exec('root-1'))
    const listed = (await tool.execute({ list: true })) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(listed).toContain('escalations (1):')
    expect(listed).toContain('- esc-1 [open] capability-gap')
    expect(listed).toContain(`what: ${card.what}`)
    expect(listed).toContain('approval: approval:call-1 by root-1')
  })
})
