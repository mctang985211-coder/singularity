---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-verifier-selftest-protected-inputs

## Summary

Adds optional fields to types carried inside `task/event` payloads, all from the S1-V slice 2 batch (plan "验证器自测与输入身份"): `AcceptanceCriterion.protectedInputs?: ProtectedInputRef[]` (carried inside the `TaskCreated`/`TaskDecomposed` payloads' `TaskInstance`), `VerificationResult.verifierVersion?: string` (carried inside the `TaskStarted` payload's `TaskRun` and the `EvidenceProduced` payload's `EvidenceBundle`), `EvidenceClaim.verifierVersion?: string` (same bundle), and `ReviewCriterion.verifierId?: string` / `ReviewCriterion.verifierVersion?: string` (inside the `ReviewRecorded` payload's `ReviewRecord`). The batch makes the verifier registry execute declared executable selftest samples before a judge may register, stamps every verdict and claim with the registered instance's version, and fixes the identity of a criterion's declared protected acceptance inputs at admission (`{ path, sha256 }`) so the registry can refuse a verdict whose input moved. No event kind, envelope, reducer rule, or tool input shape changes — the reducer copies payloads verbatim and validates none of the new fields.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-verifier-selftest-protected-inputs
baseline: false
changes:
  - root: "event:task/event"
    previous: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    after: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    decision: same-version
```

<a id="registered-shapes"></a>
## Registered shapes

| Root | Payload | Current shape |
|---|---|---|
| `event:task/event` | `TaskEvent` | Unchanged declaration; every added field lives on a type the payload text refers to |

`ProtectedInputRef` is `{ path: string; sha256: string }`: the path as declared by the caller, plus the SHA-256 of the file's bytes fixed at admission against the session's checkout. The runtime converts the authoring string form (`CriterionSpec.protectedInputs: readonly string[]`) into this fixed form before the single normalization entry, so the contract and both content identities describe the digest rather than a re-readable path. A criterion that declares no protected inputs carries no such field.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and every added field sits on a transitively referenced type (`AcceptanceCriterion`, `VerificationResult`, `EvidenceClaim`, `ReviewCriterion`). Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest — the same situation as `2026-09-21-parent-acceptance-evidence-identity` and `2026-09-21-task-contract-normalization`.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding optional event-body properties, several times over. Old stores contain none of the new fields, so replaying them under the new build is unchanged: every field is optional everywhere it appears, the reducer validates and copies none of them, and every reader treats absence exactly as before — no `protectedInputs` adds no pre-judgement gate, a verdict without `verifierVersion` is simply a verdict from before the field existed (the `(verifierRef, version)` index still returns it when no version is requested), and a review criterion without `verifierId` renders without the judge suffix. Older readers ignore the fields without changing replay. Version changes never rewrite stored evidence: bundles are append-only and the registry only stamps verdicts it is producing now. The envelope keeps `ignorable: true`, writer and reducer ship together, and a task store is scoped to one root session, so a single store is never replayed by mixed-version code. The external Evolution ledger (`proposals.jsonl`) and the verifier registry state (never persisted as an event) are untouched.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, `task/event` digest unchanged — no `--write` needed; the run was executed after all code changes, including the review-fix follow-up). `pnpm build` in `packages/singularity` passed for all workspace packages. New coverage: the registry selftest gate, version stamping, the protected-input re-check (including malformed stored declarations yielding a readable `fail`, never a crash) and the `(verifierRef, version)` index (`verifier/tests/unit/verifier-registry.spec.ts`, `composite-verifier.spec.ts`, `command-verifier.spec.ts`); admission-time identity fixing, normalization carry, the shared fixed-form rule, replay handling and rendering (`task-runtime/tests/unit/protected-inputs.spec.ts`, `orchestrate.spec.ts`, `normalize.spec.ts`, `admission.spec.ts`, `handoff.spec.ts`, `contract.spec.ts`, `agent-singularity/tests/unit/task-tools.spec.ts`); and the whole chain on the real `TaskService` + `TaskRuntime` + `VerifierRegistry` with a real checkout directory, read back from the persisted event log, including the worker-rewrites-protected-input counterexample and the undeclared-is-not-protected boundary (`packages/singularity/tests/integration/verifier-selftest-inputs.spec.ts`). In the harness root, `pnpm vitest run --project unit packages/singularity` passed 28 files / 777 tests and `--project integration packages/singularity` passed 22 files / 145 tests; `task`, `verifier` and `agent-singularity` `pnpm exec tsc --noEmit` reported 0 errors, and `task-runtime`'s 8 diagnostics are the pre-existing G9 baseline, every one at a line outside this change's diff hunks.
