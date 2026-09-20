---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-18-capability-manifest-mcp-servers

## Summary

Adds one optional field to the per-capability entry of `CapabilityManifest` — the payload carried by the `CapabilityResolved` member of `task/event`: `mcpServers?: string[]`, the MCP server names the capability grants (keys of the task runtime's `MCP_SERVER_REGISTRY`), copied verbatim from the capability table at admission and mounted per worker at spawn (`mcp__<server>__<tool>` on the worker's own tool layer). Motivation is the #8 capability-table gap read with the 2026-09-17 ruling that capabilities ship as MCP servers: the bbdev server lives in the per-env checkout, so the grant must be resolved at spawn against the run's env — and the manifest is the one artifact the cascade and the replay runner both carry from admission to spawn.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-18-capability-manifest-mcp-servers
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the `CapabilityResolved` member's manifest entry gains one optional field |

New optional field on the manifest entry (in `task/src/types.ts`, JSDoc-documented):

| Field | Presence | Content |
|---|---|---|
| `mcpServers?: string[]` | when the capability declares server grants | MCP server names (registry keys), in declaration order; absent on entries that grant none |

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and this change lives inside the transitively referenced `CapabilityManifest` type. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: the addition is an optional event-body property, nested two levels inside the payload. Old records omit the field and replay identically — the reducer (`TaskState.resolveCapabilities`) copies the manifest wholesale without field-level validation, so an absent shape rejects nothing and an old record is never invalidated. New writers emit the field only when the entry declares servers; older readers ignore unknown properties on replay. The envelope keeps `ignorable: true`, so a build that does not know the type skips the event entirely.

<a id="verification"></a>
## Verification

`node scripts/verify-persistence.mjs --check` reports OK — 4 event roots match `docs/persistence-schema.json`; the inventory was not regenerated because no declaration-level digest moved. New coverage: admission copies `mcpServers` onto the manifest and rejects unknown server names with the registry vocabulary (`task-runtime/tests/unit/capability.spec.ts`); spawn-time materialization binds `{envRoot}` / `{repoRoot:<repo>}` and fails loudly on a missing binding or repo (`task-runtime/tests/unit/mcp-servers.spec.ts`); the cascade and the replay runner carry resolved specs on the spawn grant and settle a failed run when binding fails (`task-runtime/tests/unit/orchestrate.spec.ts`).
