# Evolution replay report digest

kind: persistence-change

The external `proposals.jsonl` ledger adds optional `reportDigest` to its
`replayed` record and view. The value is the lowercase SHA-256 of the exact
UTF-8 report bytes written by replay. Ledger formatVersion remains 1.

Old records without the field remain readable and existing applied proposals
remain eligible for rollback. New gate/promotion/apply operations require the
digest and validated replay evidence. A proposal lacking the digest needs a
new proposal/candidate evaluation; the append-only state machine does not
rewrite old replay records. Older readers ignore this optional field but do
not enforce the new promotion gate, so downgrading the runtime loses that gate.

This is not a SessionEventMap root. The four tracked event fingerprints and
their schema inventory are unchanged; no synthetic Session root or schema
version is introduced. `verify-persistence` only covers those four roots.
The evolution unit tests cover digest preservation and replacement detection
after reopening the ledger, plus reading historical records and rollback.
