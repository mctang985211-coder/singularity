/**
 * `context_read` (A2 §D, dispatch subgoal 3): the one reference reader of the
 * deployment — one record of the caller's own graph domain, by the identity the
 * record already has.
 *
 * The authorization is the caller, never the reference: the service resolves
 * the live session to its graph domain first, then looks the reference up
 * inside that domain — so an id from another graph is a named refusal, and
 * there is deliberately NO `graphId`, `storeId` or `callerId` parameter a model
 * could widen the domain with. This tool replaces the raw cross-session readers
 * (`session_event_read` and its siblings), which are sealed on every
 * runtime-owned agent.
 * @module dsh-singularity-agent/tools/context-read
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-context'
import { CONTEXT_OUTPUT_LIMIT_BYTES } from '@dangosys/dsh-singularity-context'
import { adaptRead, callerSessionId } from './projected-read.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** Every parameter this tool declares; anything else is refused by name before any read happens. */
const DECLARED = ['kind', 'ref', 'offset', 'limit'] as const

/**
 * Refuse a call carrying a key this tool does not declare — a `graphId`,
 * `storeId` or `callerId` above all: the reference never authorizes, and an
 * undeclared key is named rather than silently ignored.
 */
function undeclared(args: Record<string, unknown>): string | undefined {
  const extra = Object.keys(args).filter(key => !(DECLARED as readonly string[]).includes(key))
  if (extra.length === 0) return undefined
  return [
    `context_read rejected: undeclared parameter${extra.length === 1 ? '' : 's'} ${extra.map(key => `"${key}"`).join(', ')} —`,
    `this tool accepts ${DECLARED.join(', ')} and has no argument that names a graph, a store or a caller:`,
    'the read domain is the calling session\'s own graph, and nothing here can widen it. Nothing was read.',
  ].join(' ')
}

export function defineContextReadTool(ctx: Context) {
  return defineTool({
    name: 'context_read',
    description:
      'Read one record of the caller\'s own graph domain by its reference. Kinds and their references: ' +
      '`task` (a task id), `run` (a run id), `evidence` (an evidence id), `diagnosis` (a diagnosis id), ' +
      '`review` (`{taskId, runId}` — a review has no id of its own; use runId null for a task that blocked before any run), ' +
      'and `session` (a DSH session id of a published member of the caller\'s graph, paged by event seq). ' +
      'Task-class records are read whole and paged in UTF-8 BYTES: `offset` is a byte offset into the record text and `limit` ' +
      `is the page size in bytes (the whole answer never exceeds ${CONTEXT_OUTPUT_LIMIT_BYTES} bytes); an oversized record answers ` +
      'the first page with the next byte offset to continue from. A session read pages by DSH event offset: `offset` is an event ' +
      'seq and `limit` an event count (default 20, at most 100). The reference never widens the domain: an id this graph\'s store ' +
      'does not hold, a stale reference, an unreadable record and a session of another graph each come back as a named refusal ' +
      '(not-found, stale-reference, unreadable, cross-graph, context-too-large).',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['task', 'run', 'evidence', 'review', 'diagnosis', 'session'],
        description: 'Which record plane the reference names',
      },
      ref: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              taskId: { type: 'string' },
              runId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
        ],
        required: true,
        description:
          'The record\'s own identity: an id string for task/run/evidence/diagnosis/session, `{taskId, runId}` for review ' +
          '(both keys required there; runId null when the task blocked before any run). Ids from another graph are refused; there is no graphId/storeId/callerId here.',
      },
      offset: {
        type: 'number',
        description: 'Where the page starts. Task-class kinds: UTF-8 byte offset into the record text. Session: a DSH event seq. Default 0',
      },
      limit: {
        type: 'number',
        description: 'How much one page carries. Task-class kinds: UTF-8 bytes. Session: events per page (default 20, at most 100)',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const refused = undeclared(args)
      if (refused !== undefined) return refused
      const caller = callerSessionId(exec, 'context_read')
      return adaptRead(
        'context_read',
        await ctx.singularityContext.contextRead(caller, {
          kind: args.kind as 'task' | 'run' | 'evidence' | 'review' | 'diagnosis' | 'session',
          ref: args.ref as string | { taskId: string; runId: string | null },
          ...(args.offset === undefined ? {} : { offset: args.offset as number }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
        }, exec.signal),
      )
    },
  })
}
