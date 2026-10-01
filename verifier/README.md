# dsh-singularity-verifier

Purpose: Judge each acceptance criterion of a task run and record the verdicts as an EvidenceBundle.

Package: `@dangosys/dsh-singularity-verifier`

Dependencies: task

config.yaml: optional `evidenceRoot` (default `$DSH_HOME/task-evidence`, falling back to `<repo>/.dsh/task-evidence`)

### Tools

none

### Web APIs

none

### Service state

1. ctx.verifier: ready / register / verifierIds / verifierVersions / verifyRun / logTail

2. built-ins: `command` (shell exit code, modes deterministic/simulation/measurement), `composite` (child-status conjunction plus the childEvidence map), `review` (never auto-passes review/formal)

3. every registration passes the executable selftest gate; only an explicit `{ testDouble: true }` skips it, with one warning

4. no events

## Design notes

The selftest gate (KISS §4.3) executes the samples a verifier declares — positive and negative sides required, a store-reading sample only against the registry's own composite judge — and refuses a registration that cannot be executed or that misses a sample. Samples are data the registry runs; a verifier's own description of itself is never consulted. `ready()` registers the built-ins behind the same gate, is idempotent, and stays fail-closed until it resolves; `verifyRun` readies it first.

`verifyRun` dispatches each criterion by explicit `verifierRef` or by mode (later registrations win), stamps each verdict with the registered instance's version (KISS §8.2), normalizes log paths under `evidenceRoot`, and records one claim per result through the task service. A missing judge or a throwing judge is a verifier-side unknown (`inconclusive` + `unknownKind: 'verifier'`), never a task failure. A composite criterion's `childEvidence` map is judged by the registry's own composite instance even when a plugin owns mode dispatch.

The composite judge (KISS §6 C2) judges a criterion by its child-status conjunction — pass iff the run's member sequence has at least one member and every position is verified, with an unfilled position failing by name — and, when the criterion declares a `childEvidence` map, by every entry resolving against the store: an incomplete map fails and names the missing items, and a heuristic criterion keeps the conjunction verdict but carries the explicit heuristic label (KISS §5.1). The judgement is pure: the criterion, the run's member sequence, and a snapshot getter are the whole input.

A criterion's protected inputs are re-read against the run's cwd and compared by sha256 with the admitted digest before anything is dispatched, so an acceptance script rewritten after admission can never be the thing that passes; a defect refuses the verdict with a `fail`.
