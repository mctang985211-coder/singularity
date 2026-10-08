# dsh-singularity-context

Purpose: Derive a live session's read domain from durable facts — published graph membership, the persistent `TaskStarted` run, and the coordination ledger — project it into the prompt assembly and the three read tools (`task_read`, `task_status`, `context_read`), and answer the one graph read projection (`GraphViewService`) every Web route and tool reads; it never recovers, adopts, reconciles or waits.

Package: `@dangosys/dsh-singularity-context`

Dependencies: injected services `task` / `graphs` / `taskRuntime` / `sessionQuery`; optional `envBuilder` (read via `ctx.get`, absent in a deployment without one); consumed library `@deepseek-ai/dsh-output-retention`. The coordination ledger is owned by `agent-singularity` and injected through the narrow `CoordinationBindingSource` seam, so this package never imports the tool package that owns it; the view's facts arrive the same way, through `registerCoordinationFacts` / `registerMethodFacts`.

config.yaml: none

### Tools

none (the `task_read` / `task_status` / `context_read` adapters live in `agent-singularity`)

### Web APIs

none

### Service state

1. `ctx.singularityContext`: `resolveCaller` / `taskRead` / `taskStatus` / `contextRead` / `contractProjection` / `dynamicProjection` / `questionProjection` / `registerCoordinationBindingSource`; `load` plus `contractFor` / `dynamicFor` / `questionsFor` resolve one caller once and read every plane of that same resolution (the assembly's own door).
2. Prompt assembly: the contract section `singularity:worker-contract` (order 80), and the runtime contexts `singularity:state` (order 130) and `singularity:questions` (order 140). A worker gets both halves and the question plane, an activated root the contract and the question plane, a coordinator the delegated contract; a plain member, a root before activation, a session outside this domain, and a diagnostic assembly are passed through. A bound caller whose projection refuses rejects the model request with an `AssemblyRefusalError` named after the refusal.
3. The output bound `CONTEXT_OUTPUT_LIMIT_BYTES` (50 000 UTF-8 bytes) with `OutputBudget`, `sliceUtf8`, `utf8Bytes` and `omissionLine`; every read stays inside it, a cut never splits a character, and a list that does not fit says how much it left out.
4. The eight named refusals (`NAMED_REFUSALS`): `not-activated`, `unbound`, `binding-conflict`, `cross-graph`, `not-found`, `stale-reference`, `unreadable`, `context-too-large`. A refusal is a result, never an exception; recovery markers ride inside results as observations.
5. Source layout: `src/index.ts` (service + exports), `src/assembly.ts` (the one waterfall listener), `src/types.ts` (read-side types), `src/refusals.ts` (the refusal algebra and the two error-text helpers), `src/limits.ts` (the output bound, the UTF-8 slice and the one budgeted-list primitive); `src/bindings/` (`types`, `resolve`, `coordination`), `src/view/` (`types` — the fact inputs — `facts` — the one progress reduction and the completion guard — `service` — the cached `GraphViewService`), `src/reads/` (`guards` — page limits, the projection preamble and the not-activated view — `contract`, `dynamic`, `questions`, `task-read`, `task-status`, `reference-read`), `src/session/` (`session-read`, `session-event-read`, `page`), `src/render/` (`fields`, `records`).

## Design notes

The read domain is derived, never granted: the caller is resolved from its own live session (published membership, the last `TaskStarted` run naming it, or a recorded delegation whose delegator the graph actually publishes), and only then is a reference looked up inside that domain. A reference never widens it. A failure to read those facts is not the fact "no binding exists": the registry's `SESSION_NOT_IN_GRAPH` miss, a domain store that does not exist yet, and a store a bound session was spawned into but that cannot be opened are three different answers (`placement: 'outside'` versus `'failed'`), and the assembly refuses a bound session's request rather than assemble it with nothing.

Resolution is once per model request: `load()` returns the loaded caller and the three `…For` doors read every plane of that one resolution (registry lookup + store open + recovery status + ledger read happen once, not four times).

Every read is a projection, not an authority. Two reads of unchanged content are byte-identical — no counters, no "as of" timestamps, every list in its store order — which is what lets the runtime-context plane deduplicate. Nothing writes, nothing adopts, nothing reconciles, and no read waits for a recovery barrier: a store still recovering answers with its facts plus a `recovery` marker.

The delegation seam is single-record and single-source: the ledger implementation decides how it finds rows, and a ledger that holds conflicting rows raises `CoordinationBindingError` (the ledger owns conflict detection); this package maps its `kind` onto `binding-conflict` / `unreadable`, and a record whose role is missing onto `binding-conflict` naming the missing role. A binding's `role` is required and never defaulted.

The output bound is the deployment's own inline cap (the same 50 000 bytes `@deepseek-ai/dsh-spill-policy` treats as inline), so a Singularity read is never replaced by a spill preview. The omission wording comes from `@deepseek-ai/dsh-output-retention`; the cursor (`nextOffset`) and the per-line budget (`OutputBudget`) are what the library deliberately does not model. `limits.ts` holds the one primitive every bounded list uses: it lays out whole units until the budget (minus any follow reserve) runs out, then the closing lines, dropping the last unit until the tail fits — so a list that returns always carries its closing lines whole.

A delegated contract is labelled by the role it was granted for — review-only for a reviewer, supervision for a supervisor, coordination for a coordinator — the answer-vs-question plane is derived from the store's question facts (`waiting_answer` is never written back), and `not-activated` states the root's real state without inventing a substitute objective.
