# @dangosys/dsh-singularity

Singularity graph runtime workspace for DeepSeek Harness.

Install into a profile:

```sh
pnpm dsh plugin --profile web add @dangosys/dsh-singularity@0.1.0
```

Local checkout:

```sh
pnpm dsh plugin --profile web add /absolute/path/to/packages/singularity/bundle
```

## Packages

| Package | Role |
|---|---|
| `@dangosys/dsh-singularity` | meta-bundle (`dsh.bundle`) |
| `@dangosys/dsh-singularity-graph` | per-graph agent topology store |
| `@dangosys/dsh-singularity-graphs` | graph registry + env binding |
| `@dangosys/dsh-singularity-layout` | per-graph session geometry |
| `@dangosys/dsh-singularity-agent-runtime` | scoped root / spawn / stop / prompt |
| `@dangosys/dsh-singularity-task` | task contract / instances / runs + event-sourced store |
| `@dangosys/dsh-singularity-verifier` | verifier registry + EvidenceBundle |
| `@dangosys/dsh-singularity-task-runtime` | orchestration / admission / capability / handoff / MCP server registry (spawn-level per-env mounts) |
| `@dangosys/dsh-singularity-agent` | root tools: graph_spawn / mark_ready / HITL + task_read / capability_list / context_read / task_intake / task_decompose / task_submit_result / task_answer / task_cancel / task_status / task_verify / task_review_pack / task_review_agent / task_diagnose / task_proposal_read / task_proposal_continue / task_proposal_cancel / escalate + 9 evolution_* (propose / candidate / prepare / replay / gate / decide / apply / rollback / list) |
| `@dangosys/dsh-singularity-graph-web` | `/singularity/*` HTTP + SSE + map static |
| `@dangosys/dsh-singularity-map` | xyflow map SPA + FocusPanel |
| `@dangosys/dsh-singularity-canvas-view` | 对话 \| Singularity shell |

## Develop (as ruyi submodule)

`devDependencies` link `@deepseek-ai/*` into `ruyi/thirdparty/deepseek-harness`. From this directory:

```sh
pnpm install
pnpm build
```

### Docs

- [Working guide](docs/singularity-harness-guide.md): current direction, implementation limits, and Task/Skill responsibilities.
- [Build plan](docs/2026-09-20-vrtc-code-change-plan.md): ordered tickets and acceptance criteria; updated 2026-09-26.
- [Domain language](CONTEXT.md): Task, TaskRun, Capability, Skill, and Evidence.
- [Historical guide](docs/history/2026-09-21-harness-guide-snapshot.md): old gap numbers and W/M execution records, not current build instructions.
- [Persistence changes](docs/persistence-changes/README.md): custom session-event discipline.

### Persistence-type discipline

The four custom Session event types (`graph/event`, `graphs/event`, `layout/event`, `task/event`) are fingerprinted in `docs/persistence-schema.json`. After changing an event declaration: refresh the inventory with `node scripts/verify-persistence.mjs --write`, add a dated record under `docs/persistence-changes/` (compatibility rules in its README), and keep `pnpm run verify-persistence` green.
