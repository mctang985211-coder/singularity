# Reviewer scratch tree (independent review of the frozen S3 criteria)

Everything here was produced by `r1-criteria-review` while reviewing
`driver/s3-criteria.ts` against `fixtures/frozen-contract.md` §4. Nothing outside
`evidence/review/` and `evidence/adjudication/original-s3.json` was written; the
`driver/`, `fixtures/`, `harness/` and `r1-evidence-2026-09-23/` trees are
untouched (hashes re-checked after the review).

## Layout

- `vitest.scratch.config.ts` — the reviewer's runner (root = the harness checkout, so repo dependencies resolve; no network, no credential use).
- `build-mutants.py` — builds `mutants/<name>/` (a copy of the criteria module + spec per mutated rule; asserts each anchor matched once).
- `build-v1-copy.py` — builds `v1-copy/` (four stack modules copied with an injected recording failure).
- `mutants/<name>/s3-criteria.ts` + `s3-criteria.spec.ts` — one neutralised rule per directory; the spec copy points `WORKDIR` at this tree so no round evidence is overwritten.
- `probes/records.ts` — scratch record/log builders.
- `probes/adjudication.spec.ts` — strict check of `evidence/adjudication/original-s3.json` (every claimed citation must resolve).
- `probes/evasion.spec.ts` — PROBE A/A2/B/C/D: evasion routes, documented as characterization tests.
- `probes/real-hitl-ask.spec.ts` — the real `hitl_ask` tool and the real `userQuestions` seam, proven by the production tool's own guard message.
- `cases/s2-only*.spec.ts` — the S2 rule isolated (pristine module and `no-s2` mutant).
- `cases/no-s1-replay.spec.ts` — control: the replay still fails on S2 alone.
- `cases/recording-failure.spec.ts` — the injected recording failure (uses `v1-copy/`).
- `v1-copy/` — the copied stack modules with `throw new Error('injected recording failure (reviewer probe)')` as the first statement of `answerHuman`'s recording block.
- `evidence/` — the mutant run's own adjudication copy and replay output (kept here, never in the round's evidence tree).
- `results/` — every log; `mutations.diff` and `v1-copy.diff` are the exact diffs of the copies.

## Expected colours

- Green: `deterministic-suite.txt` (the driver's own suite, 15/15), `probes.txt`, `pristine-probes-and-cases.txt`, `s2-only.txt`, `real-hitl-ask.txt`, `recording-failure.txt`.
- Red by design: every `mutant-*.txt` — the frozen test set is supposed to catch each neutralised rule. Summary: `mutant-matrix.txt`.
- `all-probes-and-cases.txt` is a whole-tree run that includes the mutants, so it is red by design as well; use `mutant-matrix.txt` for the per-mutant results.

## Commands

```sh
cd /home/ROXY/code/bb_work/harness
# the driver's own deterministic suite (criteria + wiring)
pnpm exec vitest run --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1.config.ts
# reviewer probes and controls (pristine modules)
pnpm exec vitest run --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/evidence/review/scratch/vitest.scratch.config.ts probes/ cases/
# one mutant
pnpm exec vitest run --config .../scratch/vitest.scratch.config.ts mutants/no-s2/s3-criteria.spec.ts
```
