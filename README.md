# singularity-core

The one protocol stack. Built from the spine in `docs/blueprint.md`, not by porting code.

**Read [`docs/blueprint.md`](docs/blueprint.md) first.** It states what Singularity is for, what
the previous system did and did not achieve, the root causes of its complexity, why the rebuild
is organised this way, and where each remaining layer attaches.

```sh
pnpm install
pnpm verify   # tsc --noEmit && vitest run && node scripts/gates.mjs
```

## What is here

Five protocol things, and only five. Every durable fact in the future system travels through
them. Storage itself is DSH's job, not this package's (see *Next*, below).

| Module | The one thing it owns |
|---|---|
| `src/protocol/envelope.ts` | **The frame.** A closed shape: `protocol, version, kind, subject, actor, at, seq, prevDigest, payload, digest`. An unknown member is a refusal. The digest covers the body, so a tampered fact is named, never reinterpreted. |
| `src/protocol/log.ts` | **The append path.** Write, fsync, read those exact bytes back, verify the seal. Loading verifies each line's framing, digest, chain link, contiguous `seq`, **and the version gate**. This is the only module allowed to write durably. |
| `src/protocol/registry.ts` | **The version gate and the guarantee ladder.** One declaration per `(protocol, version)`: one initial state, one closed kind set. Unknown protocol / version / kind are three distinct refusals. `G4` kinds are refused at the log boundary; exactly one protocol may own `G3`. |
| `src/protocol/fold.ts` | **The fold engine.** State is derived, never stored. Two scopes, deliberately: `foldSubjects` is the whole-store read and fails closed; `foldSubject` is the isolation boundary. Neither invents state for a subject with no facts. |
| `src/protocol/refusal.ts` | **The refusal contract.** One shape, stable codes, one error type. Callers branch on `code`, never on message text. |

Payloads stay typed per kind. **The frame never interprets a payload** — that is the discipline that keeps a unified stack from becoming a unified mess.

## The guarantee ladder

One fact has exactly one level. Nothing is "also atomic".

| | Guarantee | Who needs it |
|---|---|---|
| `G1` | append + fold | the default |
| `G2` | multi-record atomic | a batch: all-visible or all-invisible |
| `G3` | compare-and-swap | **exactly one instance** — the environment-version pointer |
| `G4` | derived | never persisted; folded from `G1` facts |

## The gates are the first asset

The previous system had good design documents and still grew twelve persisted shape owners and 197 unreferenced exports, because only two gates existed and neither constrained *shape proliferation*. So the gates live here from the first commit, and **each one has been observed to fail** (see below).

| Gate | The mess it blocks |
|---|---|
| `no-export-star` | a barrel that hides what a module promises |
| `single-durable-writer` | a second writer, which is how a stack grows a second format |
| `no-unreferenced-export` | a public surface larger than what is used |
| `no-duplicate-type-body` | one type declared twice, which is two places to keep in step |
| `source-size` | 400 lines; a starting bound, not a target |
| `single-g3-claim` | a second compare-and-swap instance |
| `vertical-slice-smoke` | a frame that no longer folds: it runs the slice end to end |

**Falsification is required, not assumed.** Every gate was proved to fire by injecting a probe file that violates all six, then deleting it. That exercise found a real bug in `no-unreferenced-export`: it had a shortcut that treated "the entry file exists" as a reference, so it could never fail. A gate that has never failed is not known to work — so add a probe case whenever a gate is added.

## Decisions recorded here

1. **Two fold scopes are deliberate.** `foldSubjects` fails closed on any subject's illegal sequence, because a store that cannot be replayed in full is not one whose full state you may trust. `foldSubject` narrows to one subject so a reader can answer for its own state without being poisoned by a stranger's broken sequence. Choose by what the caller answers for.
2. **No optional durable field, ever.** A missing required fact is a named refusal. `payload` is required and reads `{}` when a fact truly carries nothing — the frame always has the member, so "absent" and "empty" never blur.
3. **Version gate applies on load, not only on append.** A log written by a build that knew a kind this one does not is refused by name, never skipped.
4. **One writer per log**, enforced by a size check on both sides of every append.
5. **Digests are over canonical JSON** (keys sorted), so a fact's identity does not depend on member order.

## What S2 added: one vertical slice

The smallest flow that crosses every layer — and the first place a real invariant is enforced by
the frame rather than by a prompt.

```
task/admitted → run/started → evidence/produced (per criterion) → run/verified
```

| Module | The one thing it owns |
|---|---|
| `src/task/contract.ts` | A contract that can be adjudicated: at least one criterion, each bound to a **registered** verifier at a named version. A criterion nobody can decide is not an acceptance condition. |
| `src/task/protocol.ts` | The five kinds and their reducers. The verifier registry is captured by the declaration's closures, so the fold enforces it purely. |
| `src/task/view.ts` | The one projection (`TaskView`), the derived receipt, and the agent rendering. The UI consumes the same `TaskView` unchanged. |

Three invariants live in the reducers, which is why nothing can talk around them:

1. **A criterion is decided by the verifier it names** — not a similar one, not a proxy.
2. **An executor never judges its own run** — including when the executor happens to *be* a registered verifier, which is the dangerous case.
3. **A run settles verified only when every criterion has a passing verdict.** No partial acceptance, and the refusal names the criterion that is missing.

### The ladder pays off: a receipt is derived, never stored

An execution receipt is G4: recomputed from the run's own facts at read time. The protocol declares no receipt kind, so storing one is refused as `unknown-kind` — and two readers of the same facts agree on `receiptDigest` by construction. The previous system persisted a second scan of the same session facts; there is nothing here to keep in step.

### Append asks the reducer first

`emit` runs the fact's own reducer against that subject's state **before** writing, so the log never records a sequence its own fold would reject. `open` replays every subject too, so a log written by an older or buggier build is refused when it is *opened*, not when a reader happens to ask. The incremental cursor is an optimization, never a second interpreter: a spec asserts it equals a fresh `foldSubject` of the same entries.

## What is deliberately absent

No decomposition, no questions, no proposals, no budget, no pointer. No second file format. No `export *`. No default-substitution. No compatibility shim. Adding any of these is a change to the blueprint (`docs/blueprint.md`), not a local decision.

## Next (S3'): the storage swap, and why the pointer needs no file

`ProtocolLog` self-builds what DSH already owns: append, fsync, read-back, a single-writer size check, a digest chain. That was a mistake — it re-implements a worse `session-persistence-jsonl`. It becomes a memory-only test backend, and durability moves behind a `SessionEventSink` adapter copying the shape of the previous system's `EventStoreSet`.

The measurement that settles it (blueprint §4.1): over the JSON backend, `ctx.storageDomain` has **no cross-process exclusion and silently loses concurrent writes** — a second process's record was overwritten by a whole-document rewrite. Session persistence has a kernel `flock(2)` lease, released on process death, pinned by DSH's own two-process e2e test.

That also **removes** a mechanism rather than adding one: the G3 pointer needs **no intent file**. Single writer comes from the lease, the compare-and-swap from the reducer, and crash reconciliation from replaying the session. The previous system's `pointer.json` plus persisted intent plus atomic replace plus startup reconcile all disappear.

### Dependency rule (learn it before it bites you)

npm publishes `@deepseek-ai/dsh-*` at **`0.0.1-rc.1`**; the local CLI runs **`0.2.0-rc.2`**. Never install these from the registry. Point them at `thirdparty/deepseek-harness` or at the CLI's own installed copy, exactly as the previous system did.
