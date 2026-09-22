---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-run-provider-binding

## Summary

Adds `TaskRun.providerBinding?: RunProviderBinding` — carried inside the `TaskStarted` payload's `TaskRun` — plus the three types it is made of (`RunProviderBinding`, `RunSkillBinding`, `RunMcpServerBinding`), all from S1-C stage 3 ("Run-level content binding"). The field records what one run resolved against and *loaded*: the registry revision the admission-time provider pre-check computed, every selected skill's name/role/granting capabilities/declared purpose/`contractDigest`/`contentDigest` (plus the source entries the identity does not cover), the granted MCP servers with the canonical digest of the registry template each resolved through, and the absolute path of the run-scoped snapshot the granted skills were materialized into. The runtime also gained a same-version behaviour: the bytes a run loads come from that snapshot rather than from the mutable production skill path, and a reader that re-reads one (`task_read`, a run re-entry) re-checks the snapshot against the record instead of falling back to production. No event kind, envelope, reducer rule, or tool input shape changes; the only new writer-side rule is that a malformed binding is refused on apply rather than stored.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-run-provider-binding
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the added field lives on the `TaskStarted` payload's `TaskRun`, a type the payload text refers to |

`RunProviderBinding` is `{ registryRevision: string; capabilities: string[]; skills: RunSkillBinding[]; mcpServers: RunMcpServerBinding[]; snapshotRoot?: string }`:

- `registryRevision` — the pre-check's own revision for the run's capability table plus every accepted provider's `contractDigest` (`provider-precheck.ts:registryRevision`), so two runs citing the same revision resolved the same rows over the same declared content.
- `capabilities` — the run's matched capability rows, sorted, including a row that grants no skill (its tools are granted without a provider).
- `skills` — one entry per skill the run's grant was built from, sorted by name; a skill two rows declare appears once, naming both. Each entry is `{ name; role: 'execution-provider' | 'knowledge' | 'guidance'; capabilities: string[]; description: string; contractDigest: string | null; contentDigest: string; uncovered: string[] }`, with `contractDigest` null exactly for a skill that declares no sidecar and `uncovered` naming the source-directory entries the identity does not cover (empty for an identity that covers its whole directory).
- `mcpServers` — `{ serverName: string; templateDigest: string | null }` per granted server, in first-declaration order; the digest is `sha256Hex(canonicalize(template))` over `mcp-servers.ts`'s registry entry, and `null` means the registry holds no such key (which the spawn then refuses by name).
- `snapshotRoot` — the absolute path of the run-scoped skill root the grant registered (`<configured root>/<storeId>/<runId>/skills`, default `Config.runBindingRoot` = `<DSH_HOME or ~/.dsh>/singularity/run-bindings`), present exactly when the run materialized content.

`TaskState.assertProviderBinding` (reducer, `task/src/service/state.ts`) refuses a malformed record on apply: a missing registry revision, a non-array list, an empty skill name, a role outside the three, a missing description, non-string capability/uncovered entries, a digest that is not lowercase SHA-256 hex (`contractDigest`/`templateDigest` may be null, `contentDigest` may not) and a non-string `snapshotRoot` when present. It judges shape only: whether the snapshot still holds those bytes is the runtime's business, and a mismatch is reported by the reader rather than rejecting the event that already happened.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and the added field sits on a transitively referenced type (`TaskRun`). Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest — the same situation as `2026-09-21-verifier-selftest-protected-inputs`, `2026-09-21-task-contract-normalization` and `2026-09-20-obligation-recorded`.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding an optional event-body property. Every old store contains no `providerBinding`, so replaying it under this build is unchanged: the reducer validates none of the new fields when the record is absent (`run.providerBinding !== undefined` gates the check), each reader treats absence exactly as before — `task_read` renders the run exactly as it did, the review pack prints no binding line, and a run re-entry performs no content check — and no run is retroactively given a claim about content it may not have loaded. Older readers ignore the field without changing replay. The envelope keeps `ignorable: true`, writer and reducer ship together, and a task store is scoped to one root session, so a single store is never replayed by mixed-version code. The external Evolution ledger (`proposals.jsonl`) is untouched, and the snapshot directories live outside any store (a missing one is reported by the record's own reader, never silently substituted).

Two behaviours change without changing any stored shape, and are named here so they are not read as compatibility breaks: a run now loads its granted skills from the run-scoped snapshot rather than resolving them at spawn from the production path (a batch admitted before this build has no snapshot, so its grant simply carries no `skillRoots` and behaves as before), and a provider whose bytes moved between admission and the run's start now fails that run by name instead of quietly loading the newer bytes (the pre-check already refused such a provider at admission; this closes the window between admission and spawn). Neither rewrites history: runs, evidence, and review records written earlier are appended to and read exactly as they were.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, `task/event` digest unchanged — no `--write` needed): `verify-persistence: OK — 4 event roots match docs/persistence-schema.json.` `pnpm build` in `packages/singularity` passed for all workspace packages. The batch was executed test-first: the pre-check's frontmatter-name rule and the binding's behaviour were each fixed as failing tests before the implementation landed (recorded in the S1-C stage-3 report).

New coverage, all reading its conclusions back from the store's event log, the snapshot bytes on disk, or the worker's own skill layer — never from a writer's return value:

- `task-runtime/tests/unit/run-binding.spec.ts` — materialization byte-for-byte (SKILL.md, sidecar, resources), the recorded `contentDigest` recomputed independently over the copied files, the read-back reporting a changed body, a changed resource, a changed declaration and an unrecorded directory by name, a removed snapshot reported without any fallback to the production path, a refusal when the admitted bytes moved after admission (with no half-materialized directory left behind), a refusal to write into an existing run directory, a refusal to bind a skill no verdict accepted, no binding at all for a hand-assembled plan, the root case (revision only, nothing materialized), the MCP template identity and its sensitivity to an edited template, and the summary renderer (capabilities with and without a provider, no body text, no readability claim without a read, the explicit refusal with one, and the uncovered-entry line).
- `task-runtime/tests/unit/orchestrate.spec.ts` — the real `TaskRuntime` + `TaskService` cascade: the run's record and the grant's `skillRoots` agree, the snapshot holds the admitted bytes, the read-back is clean, a production rewrite after the binding leaves both the snapshot and the next admission's new binding correct, a provider rewritten inside the batch window fails that run by name with no worker spawned and no binding recorded, and the summary lists every capability including the tool-only row.
- `agent-singularity/tests/unit/task-tools.spec.ts` — `task_read` renders the run's binding from the record after re-reading it, reports unreadable content by name without falling back, renders nothing extra for a run with no binding, and the review pack prints one binding line per run that has one and nothing for a run that does not.
- `task-runtime/tests/unit/handoff.spec.ts` — the spawn prompt and the contract block carry the same section from the one renderer, and both render exactly as before for a run with no binding.
- `tests/integration/worker-binding.spec.ts` — the full stack (real `TaskService` + `TaskRuntime` + `AgentRuntime.spawn` + real DSH tool/skill planes + real files): the worker's own skill layer registers the snapshot bytes with `path`/`resourceBase` inside the run's snapshot and outside the checkout, the bound bytes survive a production rewrite while a later admission binds the new ones, a removed or edited snapshot is named by the read-back, an unselected skill stays reachable from the deployment catalog yet adds no tool authorization and never enters the run's snapshot, the record round-trips through the store's event log, MCP identity is recorded next to the existing `mcp:bbdev` capability marker, and a re-entered run whose record names unreadable content is refused by name.
- `task-runtime/tests/unit/sidecar.spec.ts`, `task-runtime/tests/unit/provider-precheck.spec.ts`, `tests/integration/provider-precheck.spec.ts` — the frontmatter-name rule this batch carries in from stage 2: a `SKILL.md` whose frontmatter declares another name, or whose frontmatter does not parse, is refused in the spawn's own words, while the same directory is admitted once the declared name is the granted name.

In the harness root, `pnpm vitest run --project unit packages/singularity` passed 35 files / 917 tests and `--project integration packages/singularity` passed 29 files / 184 tests (final S1-C acceptance run; this record landed at stage 3 with 34 / 889 and 24 / 169); `task` and `agent-singularity` `pnpm exec tsc --noEmit` reported 0 errors, `agent-runtime`'s 2 and `task-runtime`'s 8 diagnostics are the pre-existing baselines (none at a line this change touches), and `git diff --check` is clean.
