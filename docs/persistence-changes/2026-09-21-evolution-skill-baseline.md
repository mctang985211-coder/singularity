# Evolution skill production baseline

kind: persistence-change

The external `proposals.jsonl` ledger adds optional `skillBaseline` to its
`prepared` record and view. It carries the same `{ name, sha256 }` identity
shape as P2's `skillContent`: the skill name plus the lowercase SHA-256 of the
exact bytes of the production `skills/<name>/SKILL.md` as it stood at prepare.
Prepare produces the champion snapshot and this digest from ONE verified read
of that file, so the snapshot and the digest can never describe two different
reads. A `champion: 'missing'` prepare records no baseline — the absence is the
recorded fact. The field is written for `targetType: skill` only; other target
types carry no skill fields. Ledger formatVersion remains 1.

Old records without the field remain readable and fold unchanged; old applied
proposals remain eligible for rollback, which restores the champion snapshot
and never reads the production baseline. A `champion: 'captured'` record with
no `skillBaseline` cannot prove which production content it was evaluated
against, so a new apply is refused — it never defaults to "matches". A
`champion: 'missing'` record needs no digest: its recorded absence is the
proof, and an apply is allowed only while the target is still absent. The
refusal message directs the caller to create a new candidate from the current
production state and re-evaluate it; the append-only ledger never re-digests
an old record. Older readers ignore the optional field but do not enforce the
baseline check, so downgrading the runtime loses that gate.

The check runs on the apply seams only: the `evolution_apply` tool runs
`EvolutionService.checkProductionBaseline` before asking a human, and
`EvolutionService.apply` runs it again immediately before the production write,
so a direct service call cannot bypass it. `decide` keeps the P2 gates
unchanged. Rollback keeps its existing overwrite semantics. The guarantee
covers serial single-process calls plus external changes between two calls; it
is not a cross-process lock and does not make apply atomic against a writer
that writes concurrently with it.

This is not a SessionEventMap root. The four tracked event fingerprints and
their schema inventory are unchanged; no synthetic Session root or schema
version is introduced. `verify-persistence` only covers those four roots. The
evolution unit and integration tests cover the unchanged-baseline apply, the
modified/deleted/appeared baselines, the directory and symlink refusals, the
serial two-candidate case, the pre-approval and approval-window checks, the
reopened-service conflict, rollback after a later external edit, and reading /
refusing pre-baseline ledgers.
