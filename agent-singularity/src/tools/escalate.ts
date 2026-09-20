import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { ESCALATION_TRIGGERS } from '../escalation.ts'
import type { Escalation, EscalationTrigger } from '../escalation.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('escalate: missing agent id')
  return id
}

/** The three KISS §7 elements, named the way the refusal and the record name them. */
const ELEMENTS = ['what', 'tried', 'suggested'] as const

/** One card as the approval reason shows it to the human. */
function cardLines(card: {
  trigger: EscalationTrigger
  what: string
  tried: string
  suggested: string
  sourceTaskId?: string
  sourceRefs?: readonly string[]
}): string[] {
  return [
    `trigger: ${card.trigger}`,
    `what: ${card.what}`,
    `tried: ${card.tried}`,
    `suggested: ${card.suggested}`,
    ...(card.sourceTaskId === undefined ? [] : [`source task: ${card.sourceTaskId}`]),
    ...(card.sourceRefs === undefined || card.sourceRefs.length === 0 ? [] : [`sourceRefs: [${card.sourceRefs.join(', ')}]`]),
  ]
}

function renderEscalation(escalation: Escalation): string {
  return [
    `- ${escalation.escalationId} [${escalation.status}] ${escalation.trigger} — what: ${escalation.what}`,
    `  tried: ${escalation.tried}`,
    `  suggested: ${escalation.suggested}`,
    `  source task: ${escalation.sourceTaskId ?? '(none)'} sourceRefs: [${escalation.sourceRefs.join(', ')}]`,
    `  approval: ${escalation.approvalRef} by ${escalation.actor} at ${escalation.at}`,
  ].join('\n')
}

export function defineEscalateTool(ctx: Context) {
  return defineTool({
    name: 'escalate',
    description:
      'Report work you cannot settle yourself to a human (KISS §7 L4): a capability gap, an exhausted budget, or an ' +
      'UNKNOWN(verifier) verdict. The card names what is missing, what was already tried, and what is suggested — an ' +
      'incomplete card is refused, because a human must be able to decide from it in ten minutes. The card is shown to ' +
      'the human through the native approval seam first and is recorded in the append-only escalation ledger ' +
      '(`.dsh/escalations.jsonl`) only after an explicit approve; a reject, cancel, or unavailable answerer records ' +
      'nothing. Set list to read the recorded cards back without asking a human.',
    parameters: {
      what: { type: 'string', description: 'What is missing — the gap, the exhausted budget, or the verdict that cannot be judged' },
      tried: { type: 'string', description: 'What was already tried before escalating' },
      suggested: { type: 'string', description: 'What you suggest the human do' },
      trigger: { type: 'string', enum: ESCALATION_TRIGGERS, description: 'What raised the card' },
      escalationId: { type: 'string', description: 'Stable id for the card; omitted derives one. A repeated id is refused, so a retry after a failed raise stays idempotent' },
      sourceTaskId: { type: 'string', description: 'The task the card is about, when it has one' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Evidence / task / diagnosis refs behind the card' },
      list: { type: 'boolean', description: 'Read-only: list the recorded escalations instead of raising one' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      if (args.list === true) {
        const escalations = await ctx.escalation.list()
        if (escalations.length === 0) return 'escalations: none recorded'
        return [`escalations (${escalations.length}):`, ...escalations.map(renderEscalation)].join('\n')
      }
      const caller = sessionId(exec)
      const agent = exec.agent
      if (agent === undefined) throw new Error('escalate: missing agent')

      // The acceptance standard, checked before the human is asked: a card a
      // human cannot decide from in ten minutes is not worth their time.
      const missing = ELEMENTS.filter(element => {
        const value = args[element]
        return typeof value !== 'string' || value.trim().length === 0
      })
      if (missing.length > 0) {
        return [
          `escalate rejected: incomplete L4 card — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`,
          'a human must be able to decide in ten minutes from what is missing, what was tried, and what is suggested',
          'nothing was recorded and no human was asked',
        ].join('; ')
      }
      if (args.trigger === undefined || !ESCALATION_TRIGGERS.includes(args.trigger as EscalationTrigger)) {
        return `escalate rejected: trigger must be one of ${ESCALATION_TRIGGERS.join(' / ')}; nothing was recorded and no human was asked`
      }
      const card = {
        trigger: args.trigger as EscalationTrigger,
        what: args.what as string,
        tried: args.tried as string,
        suggested: args.suggested as string,
        ...(args.escalationId === undefined ? {} : { escalationId: args.escalationId as string }),
        ...(args.sourceTaskId === undefined ? {} : { sourceTaskId: args.sourceTaskId as string }),
        ...(args.sourceRefs === undefined ? {} : { sourceRefs: args.sourceRefs as string[] }),
      }
      const reason = [
        'L4 escalation — a human decision is required',
        ...cardLines(card),
        'approving records the card in the escalation ledger; rejecting records nothing',
      ].join('\n')
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'escalate',
        callId: exec.callId,
        reason,
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        const why = outcome === 'rejected'
          ? 'the human rejected it'
          : outcome === 'cancelled'
            ? 'the request was cancelled before the human decided'
            : 'no approval answerer available'
        return `escalate: no escalation recorded — ${why}; the work stays where it was`
      }
      try {
        const escalation = await ctx.escalation.raise(card, caller, `approval:${exec.callId}`)
        return [
          `escalation ${escalation.escalationId} recorded [${escalation.status}] trigger: ${escalation.trigger}`,
          ...cardLines(escalation),
          'acceptance: all three elements present (what / tried / suggested) — a human can decide from this card in ten minutes',
          `recorded after human approval ${escalation.approvalRef}; ledger: ${ctx.escalation.file}`,
        ].join('\n')
      } catch (error) {
        return `escalate rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
