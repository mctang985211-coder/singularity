# Port RRSI's decision layer, never its execution machinery

**Status:** accepted (2026-10-09)

## Decision

RRSI ([google-research/rrsi](https://github.com/google-research/rrsi) @ `be50316`) enters Singularity as a
**specification for the decision layer**, not as a service we run and not as a codebase we port wholesale.

We port to TypeScript only its **pure decision and regularization functions** — selection, the component
vocabulary and novelty, the annealed edit budget, the noise-band calibration, the score aggregation, and the
history summaries — together with the **mechanical constraints** that give them force. We do **not** port its
round orchestration (git worktrees, branches, `fast_forward`, its own JSONL state) or its LLM-agent pipeline
(proposer/critic/analyst/digester agent loops), because Singularity already owns those: a **bubble** is the
per-round isolated clone that a candidate worktree is, the **environment pointer** is what `fast_forward` is,
and the **agent runtime** is what the proposer/critic/analyst agents are. The Python checkout stays as an
**executable specification** and the source of the divergence vectors.

## Why this is the boundary

RRSI's regularization is not in its formulas. It is in its mechanical constraints: `done()` bounces an
over-budget, mislabelled or slot-violating submission back for repair (`propose.py:328-369`); the reserved
exploration slot is re-checked **against the diff** after the critic (`loop.py:523-530`); a candidate is
screened by four named gates before any measurement is spent (`no_proposal`, `critic_reject`, `smoke_fail`,
`eval_invalid`); each edit's `predicted_affected` is scored for hit rate and its unpredicted regressions are
fed back (`loop.py:159-178`); `ΔS`/`ΔC` are frozen at measurement (`history.py:91-92`); `S*` moves only when
a winner is accepted (`loop.py:335`).

Those all live in the orchestration and proposal layers — which is exactly where the previous system's port
stopped. It copied the pure functions correctly and dropped every constraint with them, which is why its
`novelty` became a constant, its historical gains were recomputed against the newest head, and its reserved
slot existed only in a prompt. Porting the formulas again without the constraints would reproduce that
outcome. Porting the orchestration too would put a second loop, a second state store and a second crash
semantics inside Singularity — the "one fact, one authoritative source" rule that the first review made the
acceptance criterion.

## Considered options

- **Keep RRSI in Python behind a process boundary.** Rejected: two truths about what happened in a round (its
  `frontier.json`/`history.jsonl` versus the method ledger), a reversed callback direction (its domain adapter
  would drive Singularity's task admission and verifier once per trial), two isolation models (git worktree
  versus bubble plus the DSH session lease), and two crash-recovery paths — against a checkpoint that requires
  recovering to the same round after a crash at four specific points.
- **Port it wholesale to TypeScript.** Rejected for the reason above: the previous system did exactly this and
  lost the constraints, because the constraints live in the layer this option would rewrite rather than copy.
- **Port only the constraints and keep calling upstream for decisions.** Rejected: the decisions are pure
  functions over frozen facts we already hold, so a call out would add a runtime without adding information.

## Consequences

- **The five deliberate tightenings must be recorded as deliberate**, or the next engineer will "fix" them:
  the budget anneals by `rounds-1` rather than `/T` (so the last round does reach `b_min`); the gaining branch
  of the cost rule is capped at +25% rather than `beta1` unbounded; the novelty term `w_n·ν` is removed from the
  in-band rule in favour of a deterministic tie-break; an unknown `ΔC` refuses instead of upstream's silent
  `0.0`; and a declared component tag is verified by a candidate adapter rather than recovered from the diff.
  Each needs its own counterexample test.
- **The `K` axis differs on purpose.** Upstream tags nine *harness components*; Singularity's vocabulary tags
  asset classes. Upstream's diff-signal fallback classification does not come with it.
- **Drift is answered mechanically, not by argument.** Pin the upstream commit; keep and extend the vector
  corpus with the previous system's three-way tags (`deterministic` / `port-adapted` / `upstream-native`); run
  a differential harness that puts upstream's `tests/test_core.py` and our TypeScript on the same synthetic
  inputs and compares verdicts; and keep a divergence ledger alongside the vectors.
- **Upstream updates are manual.** This is the accepted cost: on a bump we re-extract vectors and re-diff,
  rather than tracking a moving target at runtime.
- **Revisit this ADR if** a capability we need exists only in Python, or if upstream starts evolving fast
  enough that maintaining two implementations is dearer than maintaining a bridge.

See `docs/rrsi-upstream-reference.md` for the line-by-line comparison this rests on, and `docs/blueprint.md`
§2.3 for the per-row wiring status.
