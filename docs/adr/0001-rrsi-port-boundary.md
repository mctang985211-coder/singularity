# Use the RRSI loop through Harness execution

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](../architecture.md)，分类和来源见[文档目录](../documentation-index.md)。

**Status:** accepted (2026-10-09)

**Implementation audit (2026-10-17):** this ADR records the intended boundary, not proof that every regularizer is implemented. The current code lacks several orchestration constraints and uses single-task evaluation; see the [source audit and implementation plan](../task-first-domain-rsi-plan.md), sections 4–7. That plan retains the TypeScript/DSH execution boundary and explicitly schedules the missing work.

## Decision

RRSI ([google-research/rrsi](https://github.com/google-research/rrsi) @ `be50316`) enters Singularity as a
**specification for the method-evolution loop**, not as a service we run and not as a codebase we port wholesale.

We port its pure decision functions and the sequence in `rrsi/loop.py`: analyze the incumbent's
sealed evidence, propose a small reusable change, screen it before evaluation, evaluate isolated trials,
select from frozen measurements and publish the approved winner. `rrsi/critic.py` supplies the screening
contract: reject task answers, task-specific state, grader gaming, inert changes and unbounded work;
return objections to the proposer before spending business execution. `rrsi/propose.py` supplies the
repair boundary: a rejected proposal returns concrete reasons rather than ending the loop.

The model exposes one proposal operation, `singularity_propose_method({path})`; incumbent and round
identity are host-bound. The runtime reuses the sealed business root as the incumbent evaluation, then
executes candidates through Harness Tasks and independent acceptance. No-winner outcomes resume the same
RSI session for bounded revision or an honest negative report; publication has its own independent review. Costs include only the business
root, its delegated work and acceptance through submission. RSI usage never enters any comparison.
The analyst initially receives a compact evidence summary, lists sealed event metadata, then pages
the selected native event by UTF-8 bytes. Its tools read evidence, edit files, propose and submit;
it has no shell, web, benchmark or delegation executor.
Proposal and publication reviewers can only read frozen evidence, write their judgment and submit it; they do not
receive execution, web or delegation tools.

Harness owns sessions, bubbles, the control log and the environment pointer. We do not copy RRSI's git
worktrees, Python agent executor or JSONL persistence. The implementation and all RSI contracts are TypeScript. Decision regression tests use frozen
reference outcomes; the Python checkout is read only as a design reference.

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
  a differential harness that compares our TypeScript with frozen upstream outcomes on the same synthetic
  inputs; and keep a divergence ledger alongside the vectors.
- **Upstream updates are manual.** This is the accepted cost: on a bump we re-extract vectors and re-diff,
  rather than tracking a moving target at runtime.
- **Revisit this ADR if** a capability we need exists only in Python, or if upstream starts evolving fast
  enough that maintaining two implementations is dearer than maintaining a bridge.

See `docs/rrsi-upstream-reference.md` for the line-by-line comparison this rests on, and `docs/blueprint.md`
§2.3 for the per-row wiring status.
