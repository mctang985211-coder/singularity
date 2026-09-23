# Runtime prompt attribution (A0 rework, Q2)

kind: persistence-change

`agent-runtime`'s two own doors into a session — `spawn` (a parent's delegated
task prompt) and `prompt` (`graphs.create`'s setup text) — used to write their
message with `source: { kind: 'user' }`. That marker is DSH's *host-attested
human input* (`user/message`'s `source.kind === 'user'`; upstream
`packages/goal/tool-goal/src/authority.ts:hasDirectHumanInput`, and the rule that
an omitted `Agent.followup`/`steer` source resolves to `user`, so non-human
producers must supply their own source). Writing our own prompts under it put
the deployment's voice on the same record as a person's, and the A0 root-contract
origin rule reads exactly that record to attribute a contract to the person whose
request it is.

Both call sites now carry a source kind owned by this workspace:
`RuntimePromptSource` = `{ kind: 'runtime-prompt', channel: 'spawn' | 'prompt' }`
(`agent-runtime/src/types.ts`), declared by merging a member into
`@deepseek-ai/dsh-llm`'s `MessageSourceMap` — the extension point that union is
built for, and the same pattern upstream's `agent-instructions`, `goal` and
`subagent` plugins use. Message content, order, turn-driving and durability are
unchanged: the loop appends a claimed message verbatim and the surface
projection passes `user/message` data through, so only the attribution moves.
`task-runtime`'s `notify` keeps `source.kind === 'plugin'`, and only a person's
message carries `user` in this workspace (person stand-ins in tests included).

**Compatibility.** Old records remain readable unchanged: readers that do not
know `runtime-prompt` switch on `source.kind` and fall through unknowns (upstream
documents the union as merge-extensible), and a session's log is data, never
re-judged. Old readers downgraded after this change would see `spawn`/setup
prompts as an unrecognized source rather than as a person's message — for the
origin rule that is fail-closed in the right direction (no request established),
and nothing else in this workspace switches on `kind === 'user'` for those
messages. Session replay/compaction keep working because the payload is upstream
`UserMessage` with a source union member, not a new event type.

This is not a `SessionEventMap` root, and it changes no singularity-declared
payload type text. The four tracked event fingerprints and their schema
inventory are unchanged; no synthetic Session root or schema version is
introduced. `verify-persistence` only covers those four roots, and it passes with
the unchanged inventory (`verify-persistence: OK — 4 event roots match
docs/persistence-schema.json`, no `--write`, `docs/persistence-schema.json`
untouched).

The change is covered by `agent-runtime/tests/unit/agent-runtime.spec.ts` (both
doors carry `{ kind: 'runtime-prompt', channel: 'spawn' | 'prompt' }`), and its
consequences by `tests/integration/root-intake.spec.ts` (a session whose only
message is the deployment's own setup prompt is refused by the tool and by the
service; a spawned session's store is refused by name; a person's `user` message
still activates) — recorded in the plan's「A0 返工（Q2/Q3）执行与验收记录」and the
main guide §5.13.
