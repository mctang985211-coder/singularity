# Persistence-type change records

Discipline for singularity's custom Session event types, adapted (single-language, declaration-level fingerprints) from the upstream mechanism in `thirdparty/deepseek-harness/docs/persistence-changes/README.md`.

## Files and ownership

`../persistence-schema.json` is the fingerprint inventory: one root per `SessionEventMap` member declared in this workspace, carrying the event name, payload type text, a sha256 digest, and its source file. Regenerate it only through `node scripts/verify-persistence.mjs --write`.

Each dated record has two sibling files:

| File | Content |
|---|---|
| `YYYY-MM-DD-slug.md` | Acknowledgement with `kind: persistence-change`, one machine declaration (`yaml persistence-change` block), compatibility reasoning, and verification evidence |
| `YYYY-MM-DD-slug.schema.json` | The after fingerprints for the affected roots |

A declaration names each affected root, its predecessor record (`previous: null` for a new root), its after digest, and its compatibility decision. The first record is the baseline; later records use their predecessor's after digest as the before digest.

## Compatibility rules

Every detected structural change requires a record. The minimum decision follows the upstream rules:

| Detected change | Minimum decision |
|---|---|
| Add an optional event-body property | `same-version` |
| Make a required event-body property optional | `same-version` |
| Add an ordinary event type | `same-version` |
| Make an optional property required, add a required property, change an existing type, or remove/rename a property or event | `version-bump` |
| Change the Session header or event envelope | `version-bump` (upstream-owned; never done here) |

A same-version explanation states why old records can omit the addition and why older readers can ignore it without changing replay. All four singularity events persist with the envelope's `ignorable: true`, so builds that do not know a type skip it.

## Workflow

1. Change the event declaration (and its JSDoc — undocumented members fail the check).
2. `node scripts/verify-persistence.mjs --write` to refresh the inventory.
3. Add the next dated record here (declaration + compatibility + verification).
4. `pnpm run verify-persistence` must pass before commit.

## Limitations

Digests cover the declaration-level contract (event name + payload type text), not the transitively referenced types: editing `GraphEvent`'s members in `types.ts` does not move the digest, so those changes are acknowledged by record alone. Comments and source locations do not affect digests. Unlike upstream, records are single-language (English) and there is no i18n pairing.
