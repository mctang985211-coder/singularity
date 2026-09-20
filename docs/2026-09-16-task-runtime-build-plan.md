# Task Runtime Build Plan — 2026-09-16

> Historical implementation plan. Its schemas, defaults, and out-of-scope list describe the 2026-09-16 build, not the current checkout. Current direction: [working guide](singularity-harness-guide.md); current tickets: [build plan](2026-09-20-vrtc-code-change-plan.md). Do not reimplement these completed tickets or use their inline types as the current API.

Source documents (read first, they are the contract):

- RFC (frozen): `/home/ROXY/code/ref/docs/细化想法4.md` — Architecture Freeze RFC v1.0
- Analysis: `/home/ROXY/code/ref/docs/细化想法2.md`

This plan decomposes the RFC's P0–P3 into engineering tickets for the
`packages/singularity` workspace. It is the single handoff document for all
implementation agents for that historical round. KISS applied to the RFC §47 MVP loop
needs, nothing more.

## 1. Scope

**In scope (this round):**

- `task` package: domain types + event-sourced TaskStore (decomposition tree +
  dependency DAG) + task state machine.
- `verifier` package: VerifierRegistry + deterministic command verifier +
  EvidenceBundle construction.
- `task-runtime` package: capability registry/resolution (Config-driven),
  admission, decomposition checks, dependency readiness, run orchestration on
  the agent-runtime spawn seam, parent acceptance aggregation, TaskHandoff.
- `agent-singularity`: model-facing tools `task_read`, `task_decompose`,
  `task_status`, `task_verify`.
- Wiring: workspace membership, bundle registration, `config.yml.example`.

**Out of scope (recorded follow-ups, do NOT build):** graph-web/map overlay,
review/diagnosis/evolution packages (P4/P5), permission-profile enforcement
(seam only — document), long-term memory, parallel child execution (sequential
MVP), graph removal cleanup of task stores.

## 2. Engineering constraints (binding on all tickets)

From the harness repo conventions (verified 2026-09-16):

1. New packages live at `packages/singularity/<pkg>/` and must be added to
   `packages/singularity/pnpm-workspace.yaml`, to `bundle/package.json`
   dependencies (`workspace:*`), and to `bundle/cordis.patch.yml` insert list.
2. package.json template: name `@dangosys/dsh-singularity-<pkg>`,
   `type: module`, `main`/`types` → `lib/`, `files: ["lib/", "cordis.patch.yml"]`,
   `scripts.build: tsdown`, `dsh.bundle.patch: "./cordis.patch.yml"`,
   peerDependencies on `@deepseek-ai/*` as `"*"`, devDependencies with
   `link:../../../thirdparty/...` (copy the mapping from
   `agent-runtime/package.json`), plus `tsdown`, `typescript`, `@types/node`.
   Add a `.npmrc` with `auto-install-peers=false`.
3. `tsdown.config.ts`: entry `src/index.ts`, outDir `lib`, format esm,
   platform node, dts true, clean true. tsconfig: NodeNext, strict, noEmit,
   `allowImportingTsExtensions`, `verbatimModuleSyntax` — **relative imports
   must carry the `.ts` suffix**. Cross-package imports in `src/` use the
   package name; tests import via relative `../../<pkg>/src/...ts` paths.
4. Entry `src/index.ts` must start with a `/** ... @module dsh-singularity ... */`
   header comment (enforced by `tests/integration/workspace.spec.ts`), use
   named exports `name` / `inject` / `Config` / `apply` (schemastery for
   Config), no default export.
5. Each cordis plugin ships a `cordis.patch.yml` of the form
   `- insert: - id: <id>` + `name: '<package name>'` (see
   `graph/cordis.patch.yml`). New ids: `task`, `verifier`, `task-runtime`.
   Insert order in `bundle/cordis.patch.yml`: after `layout`, before
   `agent-runtime`.
6. **No hardcoded absolute paths anywhere in source.** Deployment differences
   (dirs, thresholds, maps) become schemastery `Config` fields, overridable
   from `$ROOT/config.yml` doc1 by plugin id. Persisted data holds only
   relative paths.
7. Tests: `<pkg>/tests/unit/**/*.spec.ts`, import from `../../src/...ts`,
   hand-written fake Context objects + `vi.fn()` spies (pattern:
   `agent-runtime/tests/unit/agent-runtime.spec.ts`). For the persistence mock
   copy the in-memory `sessionPersistence` fake from
   `tests/integration/graph-service-scopes.spec.ts`.
8. Event sourcing template (mandatory — mirror `graph/src/index.ts:114-191`
   and `graphs/src/index.ts:275-328`): augment `SessionEventMap`
   (`declare module '@deepseek-ai/dsh-session/types'`) with the event type;
   `XxxState` reducer (clone → apply → validate-or-throw); per-store serial
   write queue; commit appends via `sessionPersistence` handle then emits
   cordis event; startup `open()` replays. Validation failures must NOT be
   enqueued (the "write-queue poisoning" finding of the 2026-09-11 review).
9. All service methods take an explicit `storeId` (`*In(storeId, ...)`).
   Never introduce a global active-store pointer.
10. Every package must be left built (`lib/` present) and its unit tests green
    from repo root: `pnpm vitest run --project unit <path>`.

## 3. Domain model (normative — implement exactly these shapes)

RFC section numbers in parentheses. All types live in `task/src/types.ts`.

```ts
export type TaskId = string
export type RunId = string

export interface ArtifactRef { artifactId: string; kind: string; uri: string; digest?: string }

export type VerificationMode =
  | 'deterministic' | 'simulation' | 'formal' | 'measurement' | 'review' | 'composite'

export interface AcceptanceCriterion {              // (§9.2)
  criterionId: string
  description: string
  verificationMode: VerificationMode
  requiredEvidence: string[]
  mandatory: boolean
  command?: string        // required for deterministic|simulation|measurement
}

export interface TaskDefinition {                   // (§5.1)
  taskType: string
  version: number
  objective: string
  acceptanceCriteria: AcceptanceCriterion[]
  requiredCapabilities: string[]
  decompositionPolicy: { allowed: boolean; maxDepth?: number; maxChildren?: number }
  budgetPolicy?: { tokens?: number; wallTimeMs?: number; attempts?: number }
}

export type TaskStatus =
  | 'created' | 'admitted' | 'ready' | 'running' | 'blocked'
  | 'verifying' | 'verified' | 'failed' | 'cancelled'
export type DecompositionStatus = 'leaf' | 'decomposable' | 'decomposing' | 'decomposed'

export interface TaskInstance {                     // (§5.2)
  taskId: TaskId
  definitionRef: { taskType: string; version: number }
  parentTaskId?: TaskId
  objective: string
  depth: number
  acceptanceCriteria: AcceptanceCriterion[]
  requestedCapabilities: string[]
  decompositionStatus: DecompositionStatus
  status: TaskStatus
  runIds: RunId[]
  childTaskIds: TaskId[]
}

export interface DependencyEdge { from: TaskId; to: TaskId }  // `from` must verify before `to` starts

export type RunStatus = 'running' | 'blocked' | 'failed' | 'verified' | 'cancelled'

export interface TaskRun {                          // (§5.3)
  runId: RunId
  taskId: TaskId
  sessionId: string
  parentRunId?: RunId
  capabilitySnapshot: string[]
  agentPreset?: string
  artifacts: ArtifactRef[]
  verifierResults: VerificationResult[]
  status: RunStatus
  startedAt: string
  finishedAt?: string
}

export interface VerificationResult {
  criterionId: string
  status: 'pass' | 'fail' | 'inconclusive'
  verifierId: string
  command?: string
  exitCode?: number
  logRef?: string       // path relative to verifier evidenceRoot, never absolute
  details?: string
}

export interface EvidenceClaim {                    // (§10)
  claimId: string
  criterionId: string
  status: 'pass' | 'fail' | 'inconclusive'
  verifierId: string
  artifactRefs: string[]
  details?: string
}

export interface EvidenceBundle {
  evidenceId: string
  taskRunId: RunId
  taskId: TaskId
  artifacts: ArtifactRef[]
  verifierResults: VerificationResult[]
  claims: EvidenceClaim[]
  generatedAt: string
}

export interface TaskHandoff {                      // (§18)
  handoffId: string
  parentTaskId: TaskId
  parentRunId: RunId
  childTaskId: TaskId
  parentObjective: string
  reasonForDelegation: string
  constraints: string[]
  decisions: string[]
  relevantArtifacts: ArtifactRef[]
  relevantEvidence: string[]
  assumptions: string[]
  openQuestions: string[]
  parentSessionRef?: string
  createdAt: string
}

export interface CapabilityManifest {               // (§11–12)
  capabilities: Record<string, { skills: string[]; tools: string[]; preset?: string }>
  missing: string[]
  closure: 'closed' | 'partial' | 'gap'
}

export interface Verifier {                         // implemented by verifier package
  id: string
  supports(mode: VerificationMode): boolean
  verify(req: VerifyRequest): Promise<VerificationResult[]>
}

export interface VerifyRequest {
  taskId: TaskId
  runId: RunId
  criteria: AcceptanceCriterion[]
  cwd: string          // absolute dir to run commands in (the graph env checkout)
  logDir: string       // absolute dir for this run's logs; results store paths relative to evidenceRoot
  timeoutMs?: number
}
```

### 3.1 Task events (`'task/event'` in SessionEventMap) (§42 subset)

`TaskCreated TaskAdmitted TaskRejected TaskDecomposed DependencyAdded
TaskStarted TaskBlocked TaskVerifying TaskVerified TaskFailed TaskRetried
CapabilityResolved CapabilityGapDetected EvidenceProduced HandoffCreated`

Envelope: `{ taskId, runId?, sessionId?, parentTaskId?, timestamp, actor,
payload, schemaVersion: 1 }`.

### 3.2 State machine (§6) — the reducer enforces legality

```
created → admitted | blocked(rejected)
admitted → ready
ready → running | decomposing | blocked
decomposing → decomposed            (only via TaskDecomposed)
decomposed → (terminal for this task; children carry the work)
running → verifying | blocked | failed | cancelled
verifying → verified | failed
failed → ready                       (TaskRetried; attempts budget)
verified | cancelled → terminal
```

Reducer validations: legal transition; tree integrity (single parent);
DependencyAdded must not create a cycle (DFS over DependencyEdge, cf.
`graph/src/service/state.ts:93-104`); TaskDecomposed requires ≥1 admitted
child; TaskVerified requires an EvidenceProduced for the current run.

## 4. Ticket graph

```
C1 task          (blocks C2, C3)
C2 verifier      (blocked by C1) ─┐
C3 task-runtime  (blocked by C1) ─┤── parallel OK: C3 consumes only the
C4 tools+wiring  (blocked by C2,C3)   Verifier/VerifyRequest interfaces from C1
C5 verification  (blocked by C4)
```

### C1 — `packages/singularity/task`

Files: `package.json`, `.npmrc`, `tsconfig.json`, `tsdown.config.ts`,
`cordis.patch.yml`, `src/types.ts` (section 3 verbatim),
`src/service/state.ts` (TaskState reducer: snapshot/apply/validate),
`src/index.ts` (`TaskService extends Service`, `static inject = ['sessionPersistence']`;
methods all `*In(storeId, …)`: `createTaskIn`, `admitTaskIn`, `rejectTaskIn`,
`decomposeIn`, `addDependencyIn`, `startRunIn`, `markRunStatusIn`,
`recordEvidenceIn`, `recordHandoffIn`, `snapshotIn`, `taskIn`, `runIn`,
`childrenIn`, plus store lifecycle `openStore(storeId)` replay +
`createStore(storeId)`; store id convention `sg-t-<rootSessionId>`),
`tests/unit/task-state.spec.ts`, `tests/unit/task-service.spec.ts`.

Also export from `task/src/types.ts` a `RootTaskSpec` constant shape and a
helper `rootTaskStoreId(rootSessionId: string): string` returning
`sg-t-<rootSessionId>`.

Tests: state machine legality matrix; cycle detection; tree integrity;
event replay roundtrip (append → close → open → same snapshot);
evidence-gated verification (TaskVerified without evidence throws).

### C2 — `packages/singularity/verifier`

Files: boilerplate as above; `src/index.ts` (`VerifierRegistry extends Service`,
`static inject = ['task']`; `register(v: Verifier)`; `verifyRun(storeId, runId)`
→ reads run + task criteria from task service → dispatches per-criterion to
supporting verifier → builds EvidenceBundle (claims 1:1 with results) →
`task.recordEvidenceIn` → returns bundle); `src/command-verifier.ts`
(`CommandVerifier` supports `deterministic|simulation|measurement` with
`criterion.command`; runs via `child_process.spawn` shell in `req.cwd`,
captures combined stdout+stderr to `<logDir>/<criterionId>.log`, exitCode 0 =
pass, else fail; missing command → inconclusive; kill on timeoutMs →
inconclusive); `src/composite-verifier.ts` (`composite` mode: pass iff every
mandatory child task of taskId is `verified`; reads via task service);
`src/review-verifier.ts` (`review|formal` → always `inconclusive`, details
'manual review required'; never auto-pass).
Config: `{ evidenceRoot: string }` — default resolved in `apply` from
`process.env.DSH_HOME` (fallback: repo-root-derived `.dsh`) + `/task-evidence`;
logDir for a run = `<evidenceRoot>/<storeId>/<runId>/`.
Tests: command verifier pass/fail/timeout/missing-command with `node -e`
commands in a tmp dir; composite aggregation over a fake task store; registry
dispatch by mode; bundle shape + relative logRef.

### C3 — `packages/singularity/task-runtime`

Files: boilerplate; `src/index.ts` (`TaskRuntime extends Service`,
`static inject = ['task', 'verifier', 'agentRuntime', 'graphs']`);
`src/capability.ts` (resolver against Config map);
`src/admission.ts` (pure functions, unit-testable);
`src/orchestrate.ts` (run cascade); `src/handoff.ts` (envelope + prompt render).
Config:

```ts
{
  capabilities: Record<string, { skills?: string[]; tools?: string[]; preset?: string }>,
  defaultPreset?: string,
  verifyTimeoutMs?: number   // default 10 * 60 * 1000
}
```

Ship buckyball defaults in the schema (overridable from config.yml):
`design-chip`→skill chip-designer; `design-ball`→skill ball-align + tools
filesystem/bash; `check-ball-registration`→skill check; `verify-ball-functional`
→skill verify + preset `bb-verify`; `run-bemu-regression`,
`run-verilator-regression`→skill verify + preset `bb-verify`;
`analyze-waveform`→skill waveform; `research`→preset default.

Admission (pure): `checkDecomposition(parentTask, children, existingEdges)`
enforces §36 — decompositionPolicy.allowed; depth+1 ≤ maxDepth; count ≤
maxChildren; each child: non-empty objective, ≥1 acceptance criterion, every
criterion with executable mode has `command`; DAG stays acyclic after edges.
`resolveCapabilities(required)` → CapabilityManifest; admission rule: all
found → proceed; missing + decompositionPolicy.allowed → admit as
`decomposable` (must decompose, cannot run); missing + not allowed → reject
with `CapabilityGapDetected`.

Orchestration (sequential MVP): `runChildren(storeId, parentRun, childTasks,
execCtx)` — topologically iterate: child whose deps all `verified` → build
TaskHandoff + prompt (render: objective, acceptance criteria table, handoff
envelope, constraints; few-K tokens) → resolve preset
(`manifest … preset ?? config.defaultPreset`) → `ctx.agentRuntime.spawn` with
caller session as parent (tool mints the child sessionId, so run↔session
binding is direct) → `TaskStarted` → await child idle (same `whenIdle`
mechanism as `agent-singularity/src/tools/spawn.ts`) →
`verifier.verifyRun` → evidence → `TaskVerified`/`TaskFailed` → re-evaluate
readiness of remaining siblings → continue. Aggregate per-child
`{ taskId, runId, status, evidenceId? }` result. Respect `signal` abort:
cancel child agent, mark runs cancelled.
`createRootTask(storeId, { objective, rootSessionId })`: root TaskInstance
(composite acceptance "all mandatory children verified",
decompositionPolicy.allowed, depth 0) + root TaskRun bound to rootSessionId.
`runForSession(sessionId)`: reverse lookup (scan snapshot runs; keep an
in-memory index, rebuilt on open).

Tests: admission matrix (allowed/depth/count/cycle/missing-command/capability
gap); resolver closed/gap; orchestrator over a fake `agentRuntime`
(`vi.fn()` spawn resolving) + fake verifier — assert spawn order respects DAG,
evidence recorded, failure of a dependency blocks dependents, abort cancels.

### C4 — tools + wiring

In `agent-singularity` (pattern: `src/tools/spawn.ts`,
registration in `src/index.ts:19-30`, caller graph via
`ctx.graphs.graphForSession(exec.agent.id)`):

- `src/tools/task-read.ts` — caller's task contract + children statuses.
  Root resolves via graphForSession → taskStoreId → snapshot root task;
  workers via `taskRuntime.runForSession(exec.agent.id)`.
- `src/tools/task-decompose.ts` — parameters: `children: array of
  { objective, acceptanceCriteria: [{ description, command?, mode? }],
  requiredCapabilities?, dependsOn?: number[] }`, `reason: string`. Executes
  admission → create → orchestrate cascade (C3) → returns per-child verdicts +
  evidence ids.
- `src/tools/task-status.ts` — task tree snapshot for caller's graph
  (id/objective/status/runs/evidence ids, compact).
- `src/tools/task-verify.ts` — re-run `verifier.verifyRun` for caller's
  current run; returns results; records nothing (self-check only).

Wiring:

1. `agent-runtime/src/index.ts:20` ROOT_TOOLS: add the four names.
2. `agent-runtime/src/prompts/root.prompts.ts`: short section — root receives
   an objective, decomposes via `task_decompose`, never claims done itself;
   verifiers decide. Keep it ≤15 lines.
3. Root task creation: in `graphs/src/index.ts` `create()` (around :159-188),
   after root session exists, call
   `taskRuntime.createRootTask(sg-t-<rootSessionId>, …)` with the graph
   objective. graphs gains `taskRuntime` in inject; update
   `tests/integration/graphs-lifecycle.spec.ts` fakes accordingly.
   (Lazy alternative if graphs change proves invasive: provision root task on
   first `task_read`/`task_status` from that root session. Prefer the direct
   call; fall back only with a note in the ticket report.)
4. `pnpm-workspace.yaml`, `bundle/package.json`, `bundle/cordis.patch.yml`:
   register `task`, `verifier`, `task-runtime` (order: after `layout`, before
   `agent-runtime`).
5. `$ROOT/config.yml.example`: commented `task-runtime` section documenting
   the capabilities map override.
6. Tests: `agent-singularity/tests/unit/task-tools.spec.ts` — fake
   graphs/taskRuntime/verifier/agentRuntime; decompose happy path + admission
   rejection + abort. Update `tests/integration/workspace.spec.ts` only if it
   enumerates members explicitly.

### C5 — verification (chief engineer + fixer)

1. `cd packages/singularity && pnpm install && pnpm build` — green, topo order.
2. Repo root `pnpm vitest run --project unit` — all green (old + new).
3. `pnpm vitest run --project integration packages/singularity` — green.
4. Structural smoke: script asserts `bundle/cordis.patch.yml` inserts
   `task`, `verifier`, `task-runtime`; `pnpm dsh plugin` reconcile not run
   (no network) — assert `dsh.bundle.patch` present in each new package.json.
5. Review pass against RFC §49 invariants 1–10: checklist in the final report.

## 5. Invariants checklist (RFC §49) for the C5 review

1. Agent never self-declares completion — only Verifier sets `verified`. ✔ reducer gates TaskVerified on evidence.
2. Tasks pass admission. ✔ task-runtime admission.
3. TaskDefinition versioned. ✔ definitionRef carries version; no in-place mutation API.
4. Session ≠ Task identity. ✔ TaskRun binds sessionId; multiple runs per task.
5. Success carries EvidenceBundle. ✔ recordEvidenceIn before verified.
6. Parent consumes evidence. ✔ composite verifier reads child status which is evidence-gated.
7. Tree vs DAG. ✔ parentTaskId tree + DependencyEdge DAG with cycle check.
8. Capability/Skill/Tool/Permission layered. ✔ capability map indirection; permission seam documented.
9. Review produces candidates only — N/A this round (no review package).
10. Verifier changes are privileged — verifier ids/commands ship in Config, overridable only via config.yml.
