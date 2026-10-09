# @dangosys/dsh-singularity

Singularity is the graph-based agent execution and verifiable task runtime for DeepSeek Harness. Graph nodes carry sessions, a Task fixes the goal and acceptance, and a TaskRun records one execution attempt. This 13-package workspace is aligned to DSH `0.2.0-rc.2`: producer message-source kinds, the v4 session format (replay tolerates the `plugin:`-prefixed migrated event names), and agent presets through `agent-preset-registry`.

## Requirements

- DSH checkout at `thirdparty/deepseek-harness` (harness root; tag `dsh-v0.2.0-rc.2`). The workspace `devDependencies` link `@deepseek-ai/*` from there.
- pnpm, and Node per the harness `engines` (`>=22.19.0`).

## Install

Into a DSH profile:

```sh
pnpm dsh plugin --profile web add @dangosys/dsh-singularity@0.1.0
```

From a local checkout, add the bundle directory — it composes the whole workspace:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/packages/singularity/bundle
```

## Start from a goal

Create a graph with a task and optional natural-language metrics. A new environment can be empty; repositories, model selection, round count and human review are optional launch choices. For example:

```json
{"createEnv":true,"rsi":{"task":"Implement and improve a Python word counter","metrics":["correctness","latency","model cost"]}}
```

The default launch runs three task attempts with autonomous review. The root investigates the workspace, defines measurements and this task's acceptance, then delegates useful independent results. The model creates task-specific checks as needed.

Every graph owns a Task/Skill library at `$DSH_HOME/singularity/environments/<rootSessionId>/`: immutable environment **revisions** hold the Skills (with resources), TaskTemplates and the graph's capability/MCP manifest, all addressed by manifest and content digest; `pointer.json` names the one active revision. `task_library` and `task_template_list` are read-only views for every role; `method:<skill-name>` binds a method through `requiredCapabilities`. A method changes only as a draft revision that a publish switches into effect. Each Run pins its environment revision at admission, so later publishes preserve historical execution evidence.

Execution workers receive the full frozen bodies of their bound Skills before the first model action. The Session records actual delivery for review, reuses visible instructions across steps and resume, and restores them after compaction removes their original message.

Method search on a current-protocol graph runs one main path: business execution → supervisor investigation → a candidate environment revision (`method_draft`) → screening, two-sided evaluation and RRSI selection (`method_evaluate`, one frozen plan, one `EvaluationReport`, both sides' facts from the runtime's sealed `ExecutionReceipt`) → retain, explicit trial (a Run bound with `trialCandidateRef`, never moving the active revision) or an approved publish (`method_publish`) → the supervisor's explicit `supervisor_complete({businessAction})` → the next round. Publishing and rollback switch exactly one pointer through a compare-and-swap transaction (`expected.revisionId` + `expected.generation`, persisted intent, fsync, read-back); discard needs no approval. The retired nine-step `evolution_*` chain, the `evolution` config switch, the text gates and the reminder loop no longer exist; a graph without the protocol marker is sealed history — adoptable by nobody, published by nobody, served read-only. Recorded execution, replay and coordination token/tool costs are accounted together; auxiliary measurement-plan/judge calls retain their actual usage, and monetary cost is unknown without a price source.

Read the selected graph's library at `GET /singularity/graphs/:id/library` and its method state — the active revision, the latest evaluation and the derived progress — at `GET /singularity/view?graphId=:id`; a graph without the protocol marker is sealed history and is served read-only at `GET /singularity/graphs/:id/history`.

## Quick start: bundled tutorial

[tutorial/](tutorial/) is a small React kanban app (no EDA dependencies) whose red-baseline test suite is the spec. From the harness root:

1. Run `node packages/singularity/tutorial/seed-env.mjs` — creates `environment/projectN` bound to a local copy of the app (no clone).
2. In the DSH web UI, use the Singularity rail icon → New → pick the tutorial env.
3. Paste `tutorial/root-prompt.md` as a human chat message and watch the decomposition across the six map tabs; verify by running the app's own tests.

Full guide: [tutorial/TUTORIAL.md](tutorial/TUTORIAL.md).

## Packages

| Package | Role |
|---|---|
| [`@dangosys/dsh-singularity`](bundle/README.md) | Bundle: the workspace's composition rows plus the `bb-verify` / `singularity-coordinator` agent-preset declarations |
| [`@dangosys/dsh-singularity-graph`](graph/README.md) | Per-graph plane: agent topology and session canvas geometry; exports `.` and `./layout` |
| [`@dangosys/dsh-singularity-graphs`](graphs/README.md) | Graph registry and lifecycle — each graph binds one environment and one root session; exactly one is active |
| [`@dangosys/dsh-singularity-task`](task/README.md) | Event-sourced task store: decomposition tree, dependency DAG, run state machine, proposals, questions, budget extensions; shared `EventStoreSet` factory and types |
| [`@dangosys/dsh-singularity-task-runtime`](task-runtime/README.md) | Orchestration facade (`service/` + `orchestration/`): intake, decomposition admission, capability resolution, worker/verifier execution, recovery, handoff |
| [`@dangosys/dsh-singularity-agent-runtime`](agent-runtime/README.md) | Root and worker sessions: composition, permissions, presets via `agent-preset-registry`, tracked message delivery, worker resume, subagent descriptor publishing |
| [`@dangosys/dsh-singularity-agent`](agent-singularity/README.md) | Root tool surface (`tools/`, `coordination/`, `services/`): delegation, task intake/decompose, review agents, HITL, escalation, the six `method_*` tools |
| [`@dangosys/dsh-singularity-context`](context/README.md) | Reads, bindings, session and render projections: derive a live session's read domain and feed prompt assembly plus the read tools |
| [`@dangosys/dsh-singularity-evolution`](evolution/README.md) | Evolution plane: the v5 method draft ledger, the one two-sided evaluation pipeline, the RRSI strategy and the publish pointer switch; legacy ledgers are a read-only projection |
| [`@dangosys/dsh-singularity-verifier`](verifier/README.md) | Verifier registry: command, composite and review judges; verdicts are recorded as an EvidenceBundle |
| [`@dangosys/dsh-singularity-graph-web`](graph-web/README.md) | HTTP + SSE boundary: `/singularity/graph\|view\|layout\|events\|graphs[/<id>/history]\|graph-envs\|methods[/:draftId]\|task\|recovery\|review\|hitl\|map/` (plus `repo-check`) |
| [`@dangosys/dsh-singularity-map`](map/README.md) | React 19 SPA served at `/singularity/map/`: Canvas / View / Methods / Tasks / Recovery / Verifier tabs plus the graph switcher |
| [`@dangosys/dsh-singularity-canvas-view`](canvas-view/README.md) | DSH shell citizen: `sidebar.panellist` entry `singularity` and the `main` page hosting the map iframe; postMessage chat bridge (retain/release + inbox projection) |

Each package README carries its own service state, web APIs and design notes.

## Real-environment binding

An environment's component directory may be a symlink to a real checkout instead of a clone: this harness runs `environment/project46` (label `bb-local`) with `DangoSys/buckyball` linked to the live Buckyball checkout, so a graph binds to real work with no copy. Graph deletion only stops sessions, unbinds the env and archives the graph record — it never spawns a cleanup session and never touches the checkout, so symlinked envs are safe to delete.

## Develop

From this directory:

```sh
pnpm install
pnpm build                 # builds all 13 packages
pnpm verify-persistence    # persistence-schema gate
```

Tests run from the harness root (`../..`), where the vitest unit + integration projects pick up this workspace:

```sh
pnpm test:all
```

Per-package notes live in each package README; `map/` also has a dev server (`pnpm dev`).

## Persistence discipline

The custom Session event types (`graph/event`, `graphs/event`, `layout/event`, `task/event`) are fingerprinted in `docs/persistence-schema.json`. After an intended event-declaration change: regenerate with `node scripts/verify-persistence.mjs --write`, add a dated record under `docs/persistence-changes/` (compatibility rules in its README), and keep `pnpm verify-persistence` green.

## Docs

- [Working guide](docs/singularity-harness-guide.md): direction, current facts, gaps, Task/Skill responsibilities.
- [Docs entry](docs/README.md): which docs are current, which are historical.
- [Build plan](docs/2026-09-20-vrtc-code-change-plan.md): tickets and acceptance criteria.
- [Domain language](CONTEXT.md): Task, TaskRun, Capability, Skill, Evidence.
- [Persistence changes](docs/persistence-changes/README.md).
