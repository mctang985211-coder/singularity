# dsh-singularity

Purpose: Meta-bundle for the Singularity workspace. The package itself only carries an empty `apply`; its content is `cordis.patch.yml`, which inserts the twelve plugin rows of the workspace into the harness, plus `presets/*.patch.yml`, which declare the workspace's two agent presets (`bb-verify`, `singularity-reviewer`) as `@deepseek-ai/dsh-agent-preset` rows.

Package: `@dangosys/dsh-singularity`

Dependencies: every `@dangosys/dsh-singularity-*` workspace plugin (graph, graphs, task, verifier, task-runtime, context, agent-runtime, agent-singularity, graph-web, map, canvas-view)

Peers: `@deepseek-ai/dsh-agent-preset-registry` (the `agentPresets` service the preset rows register into) and `@deepseek-ai/dsh-agent-preset` (the declaration rows in `presets/`); both are supplied by the dsh installation (the web profile's `@deepseek-ai/dsh-web-app` layer mounts the registry).

config.yaml: none

### Tools

none

### Web APIs

none (rows inserted by this bundle register their own routes)

### Service state

none

## Design notes

- `cordis.patch.yml` inserts twelve rows: `singularity`, `graph`, `graphs`, `layout`, `task`, `verifier`, `task-runtime`, `singularity-context`, `agent-runtime`, `singularity-agent`, `graph-web`, `canvas-view`. `dsh.bundle.patch` points at it, so installing the bundle installs the whole workspace.
- `presets/bb-verify.patch.yml` and `presets/singularity-reviewer.patch.yml` declare the two workspace agent presets with `@deepseek-ai/dsh-agent-preset` rows (dsh 0.2.0: the registry plus one declaration row per preset replaces the directory-scanning `@deepseek-ai/dsh-agent-presets`; `$DSH_HOME/.agent-presets/` is no longer read). Both files are in `dsh.bundle.patch` after the main patch, so a profile that mounts this bundle can `ctx.agentPresets.mount(agentCtx, 'bb-verify' | 'singularity-reviewer')`. The definitions mirror the former `.dsh/.agent-presets/<id>/` directories (same rows, same `preset.yml` metadata).
- The web profile consumes the bundle through `dsh.profile.bundles` in `.dsh/profiles/web/package.json`; the verify-smoke profile instead links `graph`, `agent-runtime`, `@deepseek-ai/dsh-agent-preset-registry`, `@deepseek-ai/dsh-agent-preset` and `@dangosys/dsh-verify-runner` directly, without this bundle (its patch inserts the `layout` row from the graph subpath and declares the `minimal` preset, since no web-app bundle carries the shipped preset rows).
