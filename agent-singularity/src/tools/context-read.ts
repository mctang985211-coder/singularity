/** `context_read` (A2 §D, dispatch subgoal 3): the one reference reader of the deployment — one record of the caller's own graph domain, by the identity the record already has. @module dsh-singularity-agent/tools/context-read */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-context'
import { CONTEXT_OUTPUT_LIMIT_BYTES } from '@dangosys/dsh-singularity-context'
import { adaptRead, sessionId, text, undeclaredParameters } from '../shared.ts'

/** Every parameter this tool declares; anything else is refused by name before any read happens. */
const DECLARED = ['kind', 'ref', 'offset', 'limit'] as const

export function defineContextReadTool(ctx: Context) {
  return defineTool({
    name: 'context_read',
    description:
      'Read one record of the caller\'s own graph domain by its reference. Kinds and their references: ' +
      'Workers and delegated reviewers can read their task branch, ancestor context and dependency neighbours; roots and supervisors retain their domain view. ' +
      '`task` (a task id), `run` (a run id), `evidence` (an evidence id), `diagnosis` (a diagnosis id), ' +
      '`review` (`{taskId, runId}` — a review has no id of its own; use runId null for a task that blocked before any run), ' +
      'and `session`, which has two forms. `session` with a session id pages that session\'s log by DSH event seq: `offset` is an ' +
      'event seq and `limit` an event count (default 20, at most 100). An event too large for a listing page is never cut: the ' +
      'listing stops at that event\'s seq and names the exact `{sessionId, seq}` reference to read it with. `session` with ' +
      '`{sessionId, seq}` reads that one event\'s visible text (the same text the listing renders), paged in UTF-8 BYTES: `offset` ' +
      'is a byte offset into that text (default 0) and `limit` the page size in bytes (default the bound, clamped into 4..' +
      `${CONTEXT_OUTPUT_LIMIT_BYTES}). A successful single-event page is a JSON object carrying sessionId, seq, offset, ` +
      'nextOffset, hasMore and body (this page\'s fragment, so concatenating the pages\' body values by nextOffset restores ' +
      'the whole text); its last page says how to return to the listing. ' +
      'Task-class records are read whole and paged in UTF-8 BYTES: `offset` is a byte offset into the record text and `limit` ' +
      `is the page size in bytes (the whole answer never exceeds ${CONTEXT_OUTPUT_LIMIT_BYTES} bytes); an oversized record answers ` +
      'the first page with the next byte offset to continue from. The reference never widens the domain: an id this graph\'s store ' +
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
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string' },
              seq: { type: 'integer' },
            },
          },
        ],
        required: true,
        description:
          'The record\'s own identity: an id string for task/run/evidence/diagnosis/session, `{taskId, runId}` for review ' +
          '(both keys required there; runId null when the task blocked before any run), `{sessionId, seq}` for one session ' +
          'event. Ids from another graph are refused; there is no graphId/storeId/callerId here.',
      },
      offset: {
        type: 'number',
        description:
          'Where the page starts. Task-class kinds and `{sessionId, seq}`: UTF-8 byte offset into the record or event text ' +
          '(default 0). A session id: a DSH event seq (default 0)',
      },
      limit: {
        type: 'number',
        description:
          'How much one page carries. Task-class kinds and `{sessionId, seq}`: UTF-8 bytes (the event default is the whole ' +
          'bound, clamped into 4..' + String(CONTEXT_OUTPUT_LIMIT_BYTES) + '). A session id: events per page (default 20, at most 100)',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const refused = undeclaredParameters(
        args,
        DECLARED,
        'context_read',
        'and has no argument that names a graph, a store or a caller: the read domain is the calling session\'s own graph, and nothing here can widen it',
        'Nothing was read.',
      )
      if (refused !== undefined) return refused
      const caller = sessionId(exec, 'context_read')
      return adaptRead(
        'context_read',
        await ctx.singularityContext.contextRead(caller, {
          kind: args.kind as 'task' | 'run' | 'evidence' | 'review' | 'diagnosis' | 'session',
          ref: args.ref as string | { taskId: string; runId: string | null } | { sessionId: string; seq: number },
          ...(args.offset === undefined ? {} : { offset: args.offset as number }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
        }, exec.signal),
      )
    },
  })
}
