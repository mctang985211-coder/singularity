# Divergence ledger: the RRSI decision layer

**Subject:** `src/strategy/decision.ts`, ported from [google-research/rrsi](https://github.com/google-research/rrsi)
@ `be50316` (Apache-2.0). **Contract:** `docs/phase-cd-design.md` §6.3 and §11.
**Harness:** `node scripts/strategy-vectors.mjs` — it fails on any divergence that is not a row below,
and on any `port-adapted` vector whose two sides agree.

An unexplained divergence is a bug; an explained one is a decision. The tags are the ones the previous
system's vector corpus used:

| Tag | Meaning |
|---|---|
| `deterministic` | The port and upstream answer the same on the same synthetic numbers. Agreement is required, and the harness fails if it breaks. |
| `port-adapted` | The port departs from upstream on purpose. Every row below is a decision, and each carries the counterexample that tells the two apart. |
| `upstream-native` | The case is one upstream's own tests or defaults define; the port agrees, and the expectation was measured by running the checkout. |

## 1. Divergences from upstream (`port-adapted`)

| # | Rule | Upstream | This port | Why | Vectors | Counterexample test | Mutation that must fail |
|---|---|---|---|---|---|---|---|
| D1 | Annealed edit budget | `b_t = ceil(b_min + (b_max-b_min)·½(1+cos(πt/T)))`, `t` 0-based, `range(T)` (`rrsi/schedule.py:43-54`) | Same curve with `π(round-1)/(rounds-1)`, rounds 1-based (`editBudgetFor`) | ADR tightening #1: with `T` in the denominator the last in-range round is one step above `b_min` (round 20 of 20 gives 2, not 1) and only the out-of-range endpoint reaches it, which `budget_table` never asks for. The last round must be sparse and attributable or the annealing is decorative. | `schedule.anneal.last-round`, `schedule.anneal.mid-round`, `schedule.anneal.table-20`, `schedule.anneal.one-round` | `editBudgetFor: reaches the minimum in the last round, where upstream stays one step above it` | `/(last - 1)` → `/last` |
| D2 | Gaining branch of the cost rule | `ΔC ≤ β0 + β1·ΔS`, `β1 = 40`, no ceiling (`rrsi/selection.py:84-86`) | `ΔC ≤ min(0.10 + 40·ΔS, 0.25)` (`MAX_COST_INCREASE`) | ADR tightening #2: `β1 = 40` is an unbounded exchange rate, so a +5pp gain may buy +210% cost. The cap is inclusive (`+25.0%` passes, `+30%` does not) and a gain cannot fund past it however large the gain is. | `select.cost.capped`, `select.cost.cap-boundary` | `select: caps what a gain may buy at +25%` | drop `Math.min(..., MAX_COST_INCREASE)` from the budget |
| D3 | In-band rule | `w_s·ΔS − w_c·ΔC + w_n·ν > 0` with `w_n = 0.5` (`rrsi/selection.py:90`) | `weights.quality·ΔS − weights.cost·ΔC > 0`; novelty enters nothing | ADR tightening #3: `w_n·ν` lets a candidate with no measured gain and no cost relief be admitted for touching an untried mechanism class — novelty compensating for evidence. The tie it might have broken is broken by slot number instead, which is stable across a replay. | `select.in-band.novelty-cannot-buy`, `select.tie.novelty-ignored`, `select.tie.slot-order` | `select: breaks a quality tie by slot number ascending, not by novelty` | re-add `+ 0.5 * noveltyOf(...)` to the in-band rate |
| D4 | Unknown cost change | `relative_cost_change` returns `0.0` when either side has no token count (`rrsi/evaluate.py:131-135`) | A `deltaCost` of `null` refuses, in both branches, before the branch is chosen | ADR tightening #4: `0.0` means "no cost change", which is a claim nobody measured. Upstream's gaining branch then passes on a budget of 2.10 and its in-band branch passes on `w_n·ν`; both are admissions on a fabricated number. | `select.cost.unknown.gaining`, `select.cost.unknown.in-band` | `select: refuses an unknown cost change instead of reading it as 0.0` | treat `null` as `0` before the branches (`const cost = delta.deltaCost ?? 0`) |
| D5 | Component tag | A declared tag survives only with diff evidence, otherwise `classify_diff` recovers one, defaulting to the non-structural `prompt` (`rrsi/components.py:82-100`) | The verified declaration is the class; `noveltyOf` has no diff parameter at all | ADR tightening #5: measured on upstream, a real tool change in `harness/tools/registry.py` normalizes to `prompt` (novelty 0) while a text edit under a `skills/` path normalizes to `skill` (novelty 1). A regex over the diff is wrong in both directions, and it is also a second opinion about what changed that the adapter cannot check. | `novelty.no-declaration`, `novelty.diff-signal-missed` | `noveltyOf: takes the verified declaration as truth instead of recovering one from the diff` | pass the diff into `noveltyOf` and re-derive the class from it |
| D6 | The K axis | Nine harness components, `K_STR = {client_tool, skill, memory, subagent}` (`rrsi/components.py:44-46`) | Three asset classes, all structural: `skill`, `tool`, `template` | ADR 0001: upstream tags harness components, this port tags asset classes. A task template is evolvable structure here and has no upstream member of its own; upstream's `prompt` is its default bucket for anything unclassified, so the two vocabularies are not a rename of each other. | `novelty.template-class` | `noveltyOf: counts two skill edits as one class and two classes as two` | map `template` to a non-structural upstream class in `VOCABULARY` |
| D7 | Argmax tie-break | `max(admissible, key=S')` returns the first candidate in iteration order (`rrsi/selection.py:136`), i.e. the order the round happened to finish in | Highest measured quality, ties by slot number ascending | ADR tightening #3 and R07: a selection that changes with completion order cannot be replayed against a frozen cutoff. The previous port's tie-break (novelty first, then bundle size, then candidate id) is not used either: it made novelty a preference after making it an admission term. | `select.tie.slot-order`, `select.tie.novelty-ignored` | `select: produces the same selection for the same facts in any arrival order` | drop the `[...candidates].sort(...)` before the loop |
| D8 | Incomplete measurement | `missing` never reaches the judge: the scorer is obliged to materialise a missing trial as reward `0.0` with the full denominator (`rrsi/evaluate.py:33-36,53,104-119`), and `aggregate` only counts it | `missing > 0` makes the candidate inadmissible and the denominator is named in the reason | R06: a run whose denominator was never filled is not evidence about the method, and "count it as 0" is a claim about the missing trial that only the plan may make. §6.3 step 1 makes observation completeness an admissibility condition, ahead of every score. | `select.measurement.incomplete`, `select.measurement.incomplete.only` | `select: refuses an incomplete measurement instead of scoring it` | drop the `measurement.missing > 0` guard |
| D9 | The `S*` floor | `admissible iff S' ≥ S* − δ`, where `S*` is the running max over accepted heads (`rrsi/selection.py:107-111`) | No floor. `S*` is not an input of §11's `select`, so a candidate below the round's incumbent can be admitted if the caller's exchange rate says the cost saving is worth it | **Decided (the clearing batch): absent by design until a trajectory makes it load-bearing.** No caller supplies `S*` today, and both interfaces §3 sketches are version bumps, so building one now would be mechanism without a consumer. The floor only bites when a deployment's accepted trajectory first holds `S*` above its incumbent's quality — a cost-rule acceptance of a quality-lowering candidate — and until one exists, `select.sstar-floor.absent` pins the absence and the two interface sketches stand ready for whoever revisits. | `select.sstar-floor.absent` | `select: the frozen gain of a slot is read by slot number, not by position` (the floor has no line to disable; the vector pins the behaviour) | none: there is no floor code to remove. The vector is the record. |

## 2. Load-bearing agreement (`deterministic` and `upstream-native`)

These rows are not divergences. They are here because a rule that agrees with upstream today is one
edit away from not agreeing, and the harness fails the moment one of them drifts.

| Rule | Tag | Upstream | This port | Vectors |
|---|---|---|---|---|
| Hard constraints are non-compensatory | `upstream-native` | A domain guard is checked after the cost rule and rejects regardless of score (`rrsi/selection.py:116-118`, `tests/test_core.py:123`) | `constraintsMet === false` and a non-null `inadmissible` refuse *before* the noise band, so a high score is never compared against a violated constraint | `selection.guard.noncompensatory` |
| Novelty counts types, not edits (R05) | `deterministic` | `set()` dedup, only `K_STR`, only classes with no accepted edit (`rrsi/components.py:103-108`) | Same, over asset classes: `['skill','skill']` is 1, `['skill','tool']` is 2, an accepted class is 0 | `novelty.two-edits-one-class`, `novelty.two-classes`, `novelty.already-accepted` |
| The noise band separates a gain from a non-gain (R06) | `deterministic` | `ΔS > δ` chooses the branch, and the band is calibrated, not assumed (`rrsi/calibrate.py`) | Same branch test on the frozen `ΔS`; the band's source (`measured`/`declared`) is written into the reason, so a report can say which it was, and an in-band candidate cannot fund a cost increase | `select.noise.inside-band.costly`, `select.noise.outside-band.costly`, `select.noise.inside-band.cheaper`, `select.noise.neutral` |
| Cost relief is the in-band currency | `deterministic` | `w_s·ΔS − w_c·ΔC + w_n·ν > 0` with `ν = 0` is `100·ΔS > 15·ΔC` | The same rate with the caller's weights; the vectors are upstream's own `test_core.py:91,93` cases | `select.noise.inside-band.cheaper`, `select.noise.neutral` |
| The cost rule can refuse a big gain | `deterministic` | `tests/test_core.py:117`: a +0.2 gain with `ΔC = 8.6` exceeds `β0 + β1·0.2 = 8.1` | The same refusal, and a fortiori under the +25% cap | `selection.cost.blocked` |
| Argmax over the admissible set, none ⇒ `null` | `upstream-native` | `max` over admissible `S'`, `None` when the set is empty (`rrsi/selection.py:133-136`, `tests/test_core.py:99`) | Same, with the incumbent kept when `winner` is `null` | `selection.floor.argmax`, `select.argmax.highest-quality`, `select.no-winner` |
| A candidate without a measurement is refused | `deterministic` | `judge` returns `gate_failure or "not evaluated"` (`rrsi/selection.py:100-101`) | `measurement === null` refuses with `not measured` and nothing else is read | `select.unmeasured`, `select.inadmissible.caliber` |
| An out-of-range round clamps to the nearest end | `deterministic` | `t = max(0, min(int(t), T))` (`rrsi/schedule.py:47`) | `round` clamps to `[1, rounds]` | `schedule.anneal.round-zero`, `schedule.anneal.upstream-endpoint` |
| The anneal starts at `b_max` | `deterministic` | `budget_table(T)[0] == b_max` (`tests/test_core.py:63`) | Round 1 is `first` | `schedule.anneal.first-round` |

## 3. Hand-back notes for the coordinator

1. **D9 — decided: absent for now.** `select` cannot see `S*`, and no caller supplies it; the row
   above records the decision and the revisit condition. The two interface sketches (`sStar`/`floor`
   as a plan input, or `Candidate.belowFloor`) stand for whoever revisits; until then
   `select.sstar-floor.absent` keeps the behaviour visible instead of smuggling it in.
2. **`Measurement.cost` is not read by `select`.** The cost rule reads the frozen round-relative
   `deltaCost`; the absolute cost would need the incumbent's cost, which is deliberately not an input
   (that is the R03 fix). The field is still required by §11 and is carried for the record.
3. **`Candidate.exploratory` and `Candidate.assets` are not read by `select` either.** `assets` feeds
   `noveltyOf` (`U_t`/`E_t` for the proposer); `exploratory` is enforced where the submission is
   admitted (`strategy@1`). A second, softer reading of the reserved slot inside selection would let a
   candidate be admitted *for* being exploratory.
4. **`select` cannot check that every frozen delta shares one incumbent.** The incumbent's own `S`/`C`
   are not inputs, so `quality − deltaQuality` is the only reconstruction available, and upstream
   itself rounds `ΔS` to 6 decimals when it records it (`rrsi/history.py:91-92`), which makes an
   equality check spurious. Caliber consistency is therefore the caller's `inadmissible`, per §11.

## 4. Mutation table

Each row disables exactly one load-bearing line and reports what `npx vitest run tests/strategy-decision.spec.ts`
did with it (baseline: 24 passed, 0 failed). A rule whose mutation is not caught is deleted rather than
tested around; the last row records the one rule that has no line to disable. Every mutation was applied
to `src/strategy/decision.ts`, run, reverted, and the file was byte-identical to the baseline afterwards.

| Rule | Mutation (the single line disabled) | Result |
|---|---|---|
| Hard constraints are not compensable | delete the `if (!candidate.constraintsMet) return …` guard | **caught** — 2 failed: `refuses a high-scoring candidate whose hard constraint is violated` (`expected +0 to be 1`) and `returns winner null when the only high scorer violates a constraint` (`expected +0 to be null`). The quality-0.9 violator wins again. |
| The +25% cap (D2) | drop the `Math.min(…, MAX_COST_INCREASE)` around the gaining branch's budget | **caught** — 1 failed: `caps what a gain may buy at +25%` (`expected +0 to be null`): `ΔC = +30%` is admitted again on a budget of 2.10. |
| The `rounds-1` anneal (D1) | `(Math.PI * step) / (last - 1)` → `(Math.PI * step) / last` | **caught** — 3 failed: `reaches the minimum in the last round` (`expected 2 to be 1`), the 20-round table, and the out-of-range clamp (round 21 becomes 2 instead of 1). |
| The noise band | `if (gain > calibration.floor)` → `if (gain > Number.NEGATIVE_INFINITY)` (every candidate is a gaining candidate) | **caught** — 5 failed, including `does not let a gain inside the band buy a cost increase` (`expected +0 to be null`): an inside-band gain funds a +24% cost increase again. |
| The deterministic tie-break (D7) | drop `[...candidates].sort((left, right) => left.slot - right.slot)` | **caught** — 2 failed: `breaks a quality tie by slot number ascending` (`expected 2 to be +0`) and `produces the same selection … in any arrival order` (the outcomes come back in arrival order). |
| Novelty counts classes (R05) | `for (const asset of new Set(assets))` → `for (const asset of assets)` | **caught** — 1 failed: `counts two skill edits as one class and two classes as two` (`expected 2 to be 1`). |
| Unknown `ΔC` refuses (D4) | delete the `cost === null` guard and read `delta.deltaCost ?? 0` — upstream's exact semantics | **caught** — 1 failed: `refuses an unknown cost change instead of reading it as 0.0` (`expected +0 to be null`): the unmeasured cost side passes the gaining branch again. |
| Incomplete measurements refuse (D8) | delete the `if (measurement.missing > 0) return …` guard | **caught** — 1 failed: `refuses an incomplete measurement instead of scoring it` (`expected +0 to be 1`): the 1-of-2 candidate outranks the complete one. |
| The frozen gain is read by slot (R03) | replace the slot-keyed lookup with `history.deltas[ordered.indexOf(candidate)]` (positional) | **caught** — 3 failed: `refuses a slot whose frozen gain is missing rather than inventing one`, `produces the same selection … in any arrival order`, and `reads the frozen gain of a slot by slot number, not by position`. |
| The `S*` floor (D9) | no line exists to disable: `S*` is not an input of `select` | not applicable — the rule is absent by construction, and `select.sstar-floor.absent` records the behaviour instead of a mutation. |
