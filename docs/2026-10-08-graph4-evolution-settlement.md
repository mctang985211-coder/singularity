# graph4 Evolution settlement repair

The executable proposal `graph4-r1-promote-ctest-build-bemu-run` stopped round 1
at `prepared`. Its candidate and graph-library Skill had the same SHA-256
(`1a84a9ed9395475f20e12405475c8a3509f73af4bc4695dc62c34ed95a2542a6`).
The supervisor attempted REJECT, but the platform required gate for every
decision. Gate required an experiment whose observed source Task did not bind
the Skill being replaced. Thus an unnecessary candidate could neither publish
nor conclude. The verified round-1 delivery was not the obstruction.

## Change

The service, tool preflight and ledger fold share `assertDecisionTransition`.
REJECT and KEEP_FOR_FURTHER_RESEARCH may conclude proposed, candidate or prepared
with a non-empty reason and native decision approval. These terminal decisions
leave production bytes unchanged. PROMOTE retains the gated experiment checks;
apply still requires PROMOTE. The supervisor receives concise positive guidance
for both paths. Existing formatVersion-4 records and event schemas are retained.

## Verification

- `pnpm build`: passed across the Singularity workspace.
- Nine relevant test files: 202 tests passed. Regression coverage includes all
  three early stages for both decisions, restart replay, required reason and
  approval, denied approval, forged records, ungated PROMOTE refusal, and a real
  tool integration where gate refuses a prepared no-op candidate before it is
  declined without an experiment or production write.
- `pnpm verify-persistence` and `git diff --check`: passed.

## Runtime recovery

Only the isolated service on port 3082 was restarted. The existing graph4 RSI
configuration was re-applied through its graph API to resume the blocked
supervisor. Graph identity, root session, task store and original delivery were
preserved. Evidence is recorded under
`/home/ROXY/code/bb_work/cv-rsi-goal-only-2026-10-07/settlement-fix-*.json`.

The resumed supervisor `315ff9fb-3548-4fdf-9ce2-922174848484` recorded REJECT
through `evolution_decide` at `2026-10-07T16:06:17.946Z`, with its native approval
reference and a detailed no-op rationale. The Skill digest stayed unchanged and
the driver opened round 2, observed `running`. Runtime confirmation is in
`settlement-fix-confirmed.json`. Further progress checks stop at this point.

One read-projection limitation remains observed: the HTTP Evolution list still
returned `prepared` after the durable decision and round-2 opening. The append-only
ledger and graph progress establish actual settlement; the HTTP cache should be
audited separately. This repair changes settlement rules, not cache ownership.
