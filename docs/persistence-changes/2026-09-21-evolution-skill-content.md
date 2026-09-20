# Evolution skill candidate content binding

kind: persistence-change

The external `proposals.jsonl` ledger adds optional `skillContent` to its
`prepared` record and view, and the skill replay report gains
`candidateContent`. Both carry the same identity: the skill name plus the
lowercase SHA-256 of the exact bytes of the materialized
`sandbox/<proposalId>/skills/<name>/SKILL.md` (no trim, no newline
conversion). The field is recorded for `targetType: skill` only; other target
types carry no skill fields. Ledger formatVersion remains 1.

Old records without the field remain readable and fold unchanged; old applied
proposals remain eligible for rollback, which restores the champion snapshot
and never reads the candidate. Old un-applied skill candidates cannot be newly
promoted: the replay service entry, the promotion precheck, and the
decide(PROMOTE)/apply service entries refuse with a message stating that a new
candidate must be proposed and re-evaluated. Fixing a candidate is a new
proposal — the append-only ledger never re-digests an old record. Older readers
ignore the optional field but do not enforce the new binding, so downgrading the
runtime loses that gate.

This is not a SessionEventMap root. The four tracked event fingerprints and
their schema inventory are unchanged; no synthetic Session root or schema
version is introduced. `verify-persistence` only covers those four roots. The
evolution unit and integration tests cover the recorded identity, the
missing/forged-identity refusals, candidate modification at each stage,
symlink and non-regular-file rejections, the mid-apply read/write consistency
race, service reopen, and reading/rolling back pre-binding ledgers.
