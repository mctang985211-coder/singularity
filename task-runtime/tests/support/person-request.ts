/**
 * The person's own request — and, beside it, the runtime's own notice: the two
 * shapes of a session-log event a root contract's origin is judged against
 * (A0 §1.10).
 *
 * A **request** is a `user/message` whose `source.kind` is `'user'` — the kind DSH
 * reserves for **host-attested human input** ("An omitted `Agent.followup()` /
 * `steer()` source resolves to `user`, so non-human producers must supply their own
 * source rather than inheriting this authority",
 * `tool-goal/src/authority.ts:hasDirectHumanInput`). It is the event the loop
 * writes when it claims a message a person queued, and the only thing that lets a
 * contract be attributed to somebody.
 *
 * Everything else on a session's log is attributed to **its producer**: a
 * **notice** is the same event type with `source.kind: 'task-runtime'` — what
 * `task-runtime`'s own `notify()` sends a session — and this deployment's own
 * prompts carry `runtime-prompt` (`agent-runtime/src/types.ts`: the graph setup
 * text and a spawn's delegated task). The notice lives here rather than assembled
 * ad hoc in each spec because the difference between these shapes *is* the rule:
 * a session that only ever heard from the deployment has no request to attribute a
 * contract to, and reading a deployment-written prompt as one is how an invented
 * goal gets accepted.
 *
 * What a fixture needs is a function of these two shapes: the stored session a
 * harness puts in its persistence stub ({@link requestedSession}) and the raw
 * event a spec seeds onto a log of its own ({@link personRequest}).
 *
 * The message builders are imported by package, not by the thirdparty source
 * path the integration fixtures use: this module is included by
 * `task-runtime/tsconfig.json` through the unit specs that import it, and only the
 * package entry point carries the declarations those settings need.
 * @module dsh-singularity-task-runtime/tests/support/person-request
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'

/** One stored session as the in-memory persistence stubs hold it: a header and the events it logged. */
export interface StoredRequestSession {
  readonly header: SessionHeader
  readonly events: SessionEvent[]
}

/**
 * One request of the person's own, in the shape the loop records: the
 * `user/message` with a user source that a root contract's origin is read from,
 * surface intent included (it is a surface event on a real log).
 */
export function personRequest(text: string, seq = 0): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: Date.now(),
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }
}

/**
 * One notice the runtime sent a session — `notify()`'s own shape. It is a
 * `user/message` on the log without being anybody's request: a producer-attributed
 * message, which is what makes it one of the shapes the origin rule exists for.
 */
export function pluginNotice(text: string, seq = 0): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: Date.now(),
    data: createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'task-runtime', form: 'notice', summary: boundContextSummary(text) },
    }),
    surfaceOp: 'append',
  }
}

/**
 * One session's stored log carrying the person's request — what a harness seeds
 * into its persistence stub so its intakes stand on a request somebody made. The
 * rule is the *existence* of a user-sourced message, not its wording, so one
 * `text` stands for the request; a spec that asserts on the wording records its
 * own through the deployment's surface (`scripted-loop.recordRequest`).
 */
export function requestedSession(
  sessionId: string,
  text = 'the request this contract stands on',
): StoredRequestSession {
  return {
    header: { id: sessionId, cwd: '.', agentPreset: 'standard' } as unknown as SessionHeader,
    events: [personRequest(text)],
  }
}
