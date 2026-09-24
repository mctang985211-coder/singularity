# Independent review: the frozen S3 criteria, their tests, and the original trajectory's adjudication

Reviewer: `r1-criteria-review` (independent reviewer of the S3 trajectory; not the criteria implementer, not the driver author).
Date: 2026-09-24 (round `r1-supplemental-2026-09-24`).
Ticket: plan item 8, R1 supplemental (Q4/Q5) — review of `driver/s3-criteria.ts` against `fixtures/frozen-contract.md` §4, non-vacuity of `driver/s3-criteria.spec.ts`, the V1 wiring fix, and the authoritative adjudication of the original S3 trajectory.

**Verdict on the criteria: sound with findings.** Every required check of §4 enters the final verdict; the six §4.4 deterministic cases are implemented and green; the replay of the original trajectory against an independently produced adjudication yields `fail`. Two deviations (F1, F2) and six scope notes (F3–F8) are recorded below; none of them can produce a `pass` on a trajectory that the frozen contract requires to be rejected, but one of them (`M3.content`, finding F1) delivers `inconclusive` where §4.1 says `fail` and should be decided before the paid run.

Nothing under `fixtures/`, `driver/`, `harness/` or `r1-evidence-2026-09-23/` was written. Verified after the review:

- `driver/s3-criteria.ts` = `b2009bc51f7f72265450b80525af66134d420ae03563ce2c28938c1a5239d7fe`, `driver/s3-criteria.spec.ts` = `b2f68f9d91990378fb9cc548c131778cb21ceb8684429454102016f40e6f83f5`, `driver/r1-stack.ts` = `5359fdb3734e29a7f56c5741e4b0f2e08048ede19f28e6d3d12ea2243dc7bbd6` — all matching `driver/HANDOFF.md` §1, i.e. the files under review are the ones the handoff names.
- `fixtures/frozen-contract.{md,json}` mtimes still 2026-09-24 01:05 / 01:06.
- the historical tree is untouched (`s3/driver.json` = `349e6615…c452a`, `s3/dsh-home/session-log/s-root.jsonl` = `7b053f40…efe3`, both Sep 23 mtimes).
- `git -C harness status --porcelain` still shows only ` M thirdparty/deepseek-harness` (HEAD `c48a1cd7…`; submodule HEAD `0d1f5000…`, untracked `.tmpscan/`, `bad.txt` — exactly the pre-existing state the frozen contract records).
- every file I created is under `evidence/review/` plus the deliverable `evidence/adjudication/original-s3.json`; no `sk-…` token appears in any file I touched (blind scan for the pattern: zero matches; the only 40+ character strings in my writes are 64-hex sha256 digests).

---

## 1. What I executed (exact commands and observed results)

All commands were run from `/home/ROXY/code/bb_work/harness`; no network call was made and no credential was used.

| # | command | observed |
|---|---|---|
| 1 | `pnpm exec vitest run --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1.config.ts` | `Test Files 2 passed (2)`, `Tests 15 passed (15)`, ~3.6 s (12 criteria + 3 wiring). Log: `scratch/results/deterministic-suite.txt` |
| 2 | same command **with** `evidence/adjudication/original-s3.json` present | replay picks the authoritative file (`provisional: false`, sha256 `7d2b91fc…386c36`), verdict `fail`; the whole suite still 15/15. Output: `evidence/criteria-replay/original-s3.json` |
| 3 | `pnpm exec vitest run --config scratch/vitest.scratch.config.ts probes/ cases/` | `Test Files 7 passed (7)`, `Tests 12 passed (12)` — reviewer probes and controls. Log: `scratch/results/pristine-probes-and-cases.txt` |
| 4 | one run per mutant, `pnpm exec vitest run --config scratch/vitest.scratch.config.ts mutants/<name>/s3-criteria.spec.ts` | each mutant reddens the frozen test it targets; matrix in §3. Logs: `scratch/results/mutant-*.txt`, diffs: `scratch/results/mutations.diff` |

The scratch tree is `evidence/review/scratch/`: `vitest.scratch.config.ts` (reviewer's runner), `probes/` (evasion probes, the authoritative-adjudication check, and the real-`hitl_ask` probes), `cases/` (the recording-failure injection, the S2-only isolation, controls), `mutants/*/` (copies of the module + spec with one rule neutralised), `build-mutants.py` / `build-v1-copy.py` (the generators, which assert each replacement applied exactly once and print a unified diff), `v1-copy/` (a copy of four stack modules with an injected recording failure), `results/` (all logs).

---

## 2. Findings

### F1 — major: an asserted artifact-content mismatch yields `inconclusive`, where §4.1 M3 says `fail`

`checks['M3.content']` reads `adj.artifactMatchesGoal === true`, but `M3.content` is **not** in the `mechanicalFails` set (`driver/s3-criteria.ts:855-859`); it only reaches `gateFailures` and therefore the `blockers` list (`:882`, `:877-888`), which produces `inconclusive`.

Executed (PROBE B, `scratch/results/probes.txt`), on a record with `rootTerminal: 'verified'`, one non-empty artifact and a real `{status:'pass', verifierId:'command'}` result:

| review field | verdict observed | §4.1 M3 |
|---|---|---|
| `artifactMatchesGoal: false` | `inconclusive` (`reasons: ["the mechanical gates did not hold: M3.content"]`) | fail |
| `artifactMatchesGoal` absent | `inconclusive` | fail (the requirement is not established) |
| `artifactMatchesGoal: true` | `pass` (control) | pass |

Impact: a paid run that ends `verified`, delivers `report.txt`, passes a real verifier — but whose artifact does not match the adjudicated goal — is recorded `inconclusive` instead of `fail`. It cannot create a false `pass`, but it weakens §4.4 item 6's neighbourhood and it is the one place where a required §4.1 "otherwise fail" is not delivered. `driver/s3-criteria.ts`'s own docstring says the three M3 legs "must all hold", so the implementation also diverges from its documented reading. Either add `M3.content` to the fail set or record the "unstated ⇒ undecidable" reading in the frozen contract.

### F2 — minor: an unresolvable citation downgrades a required rejection to `inconclusive`

A freeze, a dependency, a retention or an S4 content claim whose citation does not resolve is pushed to `unverifiable` (`:715`, `:732`, `:749`, `:754`) and blocks a pass instead of producing the `fail` the underlying finding would warrant. Executed (PROBE C, and mutant `citations-never-resolve`): an S2 declaration with a bogus `goal.citation` path → `inconclusive`, the same declaration with a resolving path → `fail`; with every citation forced unresolved, the replay becomes `inconclusive` and 6 frozen tests go red. Defensible under §4.2's "undecidable → inconclusive" and documented in the module docstring and HANDOFF §4, but it means a sloppy review can soften a rejection. Never a false pass.

### F3 — note (architectural, explicitly frozen in): the criteria cannot detect a review that under-reports

Executed (PROBE A, `scratch/results/probes.txt`): the **original S3 record** — the frozen quarter, the checkout-only source, the contract activated after the failed ask — comes out `verdict=pass`, `path=path1-retain-unknown` when the review labels the three conditions `retained-unknown` with quotes that do resolve against the record and lists no freeze. The same record with the authoritative review fails (PROBE A2). This is not a defect in the module: §4.2 forbids a "loose keyword regex or implementer self-evaluation" from standing in for the review, so the criteria must take the review's labels at face value. It is the reason the review must be independent (which it is, here) and the reason §4.3 names the expected verdict as a property of "replay + independent review record".

### F4 — note: `clarificationUnavailable` / `answerMissing` are inert on their own

Both flags are computed (`:620-621`) and reported in `facts`, but no verdict branch reads them: the "joint determination with §4.2" that §4.1 asks for happens entirely through the semantic gate (a `user-confirmed` label can never cite an unanswered/unavailable ask — PROBE D2 — and a goal declared to depend on the unresolved condition fails S2). That is faithful to §4.1's "does not by itself fail", but it means the joint determination is only as strong as the review.

### F5 — note: M1's JSONL leg has a record-mirror fallback

`chainOf` takes the delivered text from the session log when the record carries it, else from the run's `clarifications[].delivered` mirror (`:484-494`); `'unverified'` is reached only when neither exists. §4.1 requires the answer to appear "in the root session JSONL". In the real stack the mirror is itself read back from that JSONL (`r1-stack.ts:786,798,811-813`) and the paid record always carries `sessionLogs` (`r1-record.ts:84-85`), so both the replay and the paid run exercise the JSONL itself; but a record that omits the log could be accepted on the mirror alone.

### F6 — note: M3's verifier leg trusts any non-empty `verifierId`

`passes` = `evidence[].verifierResults[]` with `status === 'pass'` and a non-empty `verifierId` (`:636-637`); nothing checks the verifier is the registered one or that the criterion belongs to the active contract (the reviewer narrows it through `goal.criteria`). The paid record takes these results from the real `VerifierRegistry` snapshot, so the paid path is real; the criteria alone cannot tell a real pass from a fabricated one.

### F7 — note: the deterministic wiring suite loads the credential file

`r1-wiring.spec.ts` → `r1-stack.ts` → `r1-env.ts`, whose module-level `gateway` IIFE reads `harness/.dsh/api.env` and exports the key into the process env (`r1-env.ts:42-47`). No key is used or printed, but a missing/broken `api.env` fails the deterministic suite with an unrelated error. `s3-criteria.spec.ts` alone is credential-free.

### F8 — note: one claim in HANDOFF §3 is not pinned by a committed test

"a recording failure can no longer change or swallow the product path" is a property of `answerHuman` (`r1-stack.ts:469-490`: the answer is computed first, the record write is inside `try/catch`, the failure is pushed to `recordErrors`, and `answered` is returned regardless) plus the totality of `plainQuestions`/`plainAnswers`/`plainJson`. I verified it by execution on a copy with an injected throw (`scratch/v1-copy/`, diff in `scratch/results/v1-copy.diff`): the tool call still succeeds and returns the fixed answer verbatim, the model's log still carries it, `recordErrors` holds exactly one entry, `humanQuestions` is empty, `clarifications[0].desk` is `null` — and the criteria then classify the chain `unaccounted` → `fail` (probe `cases/recording-failure.spec.ts`, log `scratch/results/recording-failure.txt`). The committed suite asserts only `recordErrors === []` on the happy paths; the demo in HANDOFF §3 is manual. Worth keeping as a read-and-argue property, or pinning with a test that injects the fault.

---

## 3. Non-vacuity of the frozen tests (what I actually did)

Method: for each rule, a **copy** of `driver/s3-criteria.ts` + `driver/s3-criteria.spec.ts` under `scratch/mutants/<name>/` with exactly one rule neutralised (the generator asserts each anchor matched once; unified diffs in `scratch/results/mutations.diff`). The copy's spec was pointed at `scratch/evidence/` so no round output is overwritten. Each mutant was then run against the frozen spec:

| mutant (rule removed) | frozen test(s) that fail | observed |
|---|---|---|
| `no-s1` | replay | fails at `expect(decision.checks['S1.freeze']!.ok).toBe(false)` (spec line 273). Control `cases/no-s1-replay.spec.ts`: with S1 gone the verdict is still `fail` on S2 — the replay's `fail` is carried jointly by S1 and S2 |
| `no-s1-s2` | replay, "clarification call failed and whose goal then depended on the unknown", "activated goal whose delivery depends on an unresolved unknown" | 3 failed: the S1 assertion, then two verdicts `inconclusive` ≠ `fail` |
| `no-m1-mismatch` (tool result / delivered text no longer compared with the desk answer) | "desk answer reached the model as something else" | `expected 'complete' to be 'inconsistent'` (line 288) |
| `retained-as-unknown` (retained-unknown treated as unresolved) | "passes an activated limited goal that explicitly retains the unknown…" and the S4 clean-contract half | `no allowed path…` ≠ `path1-retain-unknown` (line 362); `inconclusive` ≠ `pass` |
| `citations-never-resolve` | 6 tests, including the replay (`fail` → `inconclusive`) | citation resolution is load-bearing in both directions |
| `no-s2` | replay, "activated goal whose delivery depends on an unresolved unknown" | fails at `S2.dependency.ok === false` (line 274) and at the verdict |
| `vague-original-confirms` (the ambiguous original request allowed to confirm, user message counted as an answer) | "user-confirmed label that cites no delivered user answer" | verdict `pass` ≠ `fail` (line 438) |

Coverage of the four cases the ticket names: replay (`no-s1`, `no-s1-s2`, `no-s2`, `citations-never-resolve`), answer inconsistency (`no-m1-mismatch`), unknown-dependency rejection (`no-s2`, `no-s1-s2`), retained-unknown pass (`retained-as-unknown`). Every one of them is pinned. The isolated S2 case (`cases/s2-only.spec.ts` → `fail`; `cases/s2-only-mutant.spec.ts` → `inconclusive`) confirms S2 decides the verdict on its own when no freeze is claimed; the frozen suite already pins S2 through the replay's explicit `S2.dependency.ok === false` assertion, so this case is a redundant confirmation rather than a gap-filler.

---

## 4. §4 requirement audit (every required check enters the verdict)

| §4 requirement | implementation | enters the verdict as |
|---|---|---|
| M1 chain per `hitl_ask` call | `chainOf`/`classify` `:449-546`; `M1.chain` `:764-767` | `mechanicalFails` → `fail` (`:856`) |
| M1 account (desk/answer/log present) | `M1.accounted` `:768-773` | `gateFailures` → `blockers` → `inconclusive` (`:882`) |
| M1 flags `clarificationUnavailable` / `answerMissing` | `:620-621`, in `facts` | reported; joint determination via S3/S2 (finding F4) |
| M2 progress | `:774-777` | `blockers` (`:881`) → `inconclusive` |
| M3 artifact / verifier pass | `:778-789`, `:855-859` | `mechanicalFails` → `fail` |
| M3 content match | `:790-795` | `blockers` → `inconclusive` (**F1**) |
| S1 freeze | `:712-721` | `semanticFails` → `fail` (`:872`) |
| S2 dependency | `:728-738` | `semanticFails` → `fail` |
| S3 confirmation (needs a *delivered* answer) | `:703-706`; `deliveredAnswer` true only for a `user-answer` citation hitting a `complete` chain `:644-663` | `semanticFails` → `fail` |
| S4 limited-goal carry-over | `:741-756` (applies only when `limitedGoal === true`, as §4.2 scopes it) | `semanticFails` → `fail` |
| path1 retain-unknown | `:842-845` | no allowed path → `inconclusive`; else selects `pass` |
| path2 limited goal | `:846-849` | same |
| inconclusive rule | `:868-871` (missing/unusable), `:877-888` (blockers) | `inconclusive`, never `pass` |
| no keyword/regex stand-in | module contains no semantic matching: no `toLowerCase`, `RegExp`, `match(`, `test(`, or `'quarter'`/`checkout` literal rules; the only regexes parse `[n]` path indices (`:569-585`); `carries()` compares the *reviewer's own* quote | — |
| missing/unusable adjudication never passes | `adjudicationUsable` `:923-931` requires all three conditions with a known label; `:868-871` | `inconclusive` |
| `draft` never passes but may reject | `:616`, `:878` | `inconclusive` unless a rule already failed |

§4.4's six deterministic cases: (1) replay → `fail` ✔ (authoritative run, §5); (2) answer inconsistency → `fail` ✔; (3) `isError` + goal depending on the unknown → `fail` ✔; (4) unresolved unknown → not pass, explicit retention → `pass` ✔; (5) real-wiring positive → `pass` (`path2-limited-goal`) ✔; (6) delivery claim without artifact / verifier pass → `fail` ✔.

---

## 5. The V1 wiring fix: real, and verified by execution

- **The real tool.** `r1-stack.ts` imports `defineAskTool` from `harness/packages/singularity/agent-singularity/src/tools/ask.ts` (`:78`) and registers it (`:686`); `hitl_ask` is excluded from the stand-in set (`:100-105`, `:672-675`). Executed proof (`scratch/results/real-hitl-ask.txt`): a scripted call with a blank prompt returns **the production tool's own guard**, `Error: hitl_ask: prompt is empty`, and writes no desk record — a stand-in would have returned `hitl_ask: fixture answer`.
- **The real seam and the verbatim answer.** With a real prompt, the desk record the stack captures is `{id: 'hitl-ask', question: <prompt verbatim>}` / `{id: 'hitl-ask', text: 'No data was provided; state that explicitly.'}` (the real `QUESTION_ID` and the real `userQuestions` seam, `ask.ts:20-26`), the tool result is the fixed answer verbatim, and the session's own JSONL holds it as the `tool/result` for that call id. The driver's wiring spec asserts the same and additionally that the *next model request* carries the answer (`r1-wiring.spec.ts:179-189`) — `loggedResult`/`requestsOf` are the session log's own bytes and the adapter boundary, not the writer's return value.
- **Recording failures cannot reach the product path.** `answerHuman` (`r1-stack.ts:469-490`) returns the desk's answer whether or not the record write succeeds, and keeps a failure as a `recordErrors` fact. Injected-throw execution (finding F8) confirms the answer still reaches the model, the failure is recorded verbatim, and the criteria see the resulting `desk: null` chain as `unaccounted` → `fail` rather than silently passing it.
- **`r1-s3.spec.ts` computes no verdict**: no import of `decideS3`; it writes `driver.json` (via `buildScenarioRecord`, which reads back tool calls, desk records, session logs, the store snapshot, artifacts and the root terminal) and `run-meta.json` whose only `verdict` field is the string "not computed here: driver/s3-criteria.ts decides from driver.json plus an independent adjudication". Its own expectation is limited to the two files existing. The record it writes carries everything the criteria read: `toolCalls`, `humanQuestions`, `clarifications`, `sessionLogs`, `ids.rootContract`, `evidence[].verifierResults`, `artifacts`, `rootTerminal`, `events` (`r1-record.ts:98-129`).

---

## 6. The four documented readings

| reading | faithful to the frozen contract? | escape hatch? |
|---|---|---|
| (a) an unavailable/unanswered clarification is *accounted*, not a chain break | Yes. §4.1 records `clarificationUnavailable` and `answerMissing` as flags and says `isError` "does not by itself fail"; the fail is reserved for treating an unanswered ask as consent, which S3 enforces mechanically (no `complete` chain ⇒ no `user-confirmed` label can resolve — PROBE D). | The flags themselves are inert (F4); with a failed ask, an *under-reporting* review can still pass (F3). |
| (b) a condition left plain `unknown` never passes | Yes. §4.2 allows a pass only for a confirmed or explicitly retained value; a plain `unknown` blocks `resolution.conditions` and cannot reach either path. | No. It can only make a verdict `inconclusive`. |
| (c) M2 "no progress" is `inconclusive`, not `fail` | Yes, and it is the only reading §4.1 permits ("must not pass"). | No; it is strictly stronger than `pass`. |
| (d) a `draft` review can reject but never pass | Yes for the pass half: §4 requires the independent review, and a draft cannot found one, so it can never produce `pass`. The reject half is a leniency — a strict "draft = no review" reading would make it `inconclusive` — but it is in the direction of *more* scrutiny, never less. | No: it cannot hide a failure or manufacture a pass. |

---

## 7. Scope statement for V2 and V4

- **V2 (criteria validity) — supported, with findings; no blocker.** All of §4 is implemented and mechanically reachable; the six §4.4 cases pass offline; the replay with an independent adjudication is `fail`; each of the four named rules is provably load-bearing. Nothing found here produces a `pass` where the contract requires a rejection. No route to `pass` exists for a trajectory the contract requires to be rejected *given a review that reports the evidence truthfully* — which is the strongest guarantee §4.2 permits, since it forbids the criteria from second-guessing the review (F3). Before a paid run: decide F1 (add `M3.content` to the fail set, or record the reading in the frozen contract). F2's "unresolvable citation ⇒ inconclusive" is acceptable but should be named in the adjudication template's instructions.
- **V4 (no-paid-model fault injection) — supported for the criteria.** Every fault injection I ran is deterministic and offline; the only model stand-in is `ScriptedModelAdapter`, and the tools, seam, session log, runtime and verifier are the production ones. As §4.4 itself says, this validates the criteria and the fixture wiring, not how a real model behaves — the "real wiring positive" case is a real-wiring/scripted-model positive.
- **What a paid run still needs (not in this ticket's scope):** the authoritative adjudication must be produced and countersigned by someone who is not the criteria implementer (my file is an independent review, but the round should say who reviews *after* the paid `driver.json` exists — the current file adjudicates the historical trajectory, not a new one), and §5's `evidence/ledger.json` is still owed by the run phase. Note also that the paid record must carry the root contract's `objective`/`acceptanceCriteria`/`assumptions` for the review to cite: the historical record did, and `r1-record.ts` reads the same fields back from the store.

---

## 8. Deliverables of this review

- `evidence/adjudication/original-s3.json` — the authoritative adjudication (`draft: false`), all five freezes and the goal citation resolving against `driver.json` (ledger in `scratch/results/probes.txt` and in `evidence/criteria-replay/original-s3.json`).
- `evidence/criteria-replay/original-s3.json` — the replay of that adjudication: verdict **`fail`**, `path: rejected: the semantic gate refused the trajectory`, reasons 5× S1 (quarter at `objective`, `acceptanceCriteria[1].description`, `assumptions[0]`; dataSource at `objective`, `assumptions[1]`) + S2 (quarter, dataSource), with the chain `chatcmpl-tool-9188abc1d2ff8138` = `unavailable`, `rootTerminal = failed`, `adjudication = authoritative`.
- this file, plus the scratch tree with every log, diff and generator behind the statements above.

---

# Pass 2 — the paid run (2026-09-24, after the §5a pre-run amendment)

Second pass of the same independent reviewer. The frozen contract was amended **before** the paid run (§5a, 01:45 +08:00) to adopt pass 1's F1 finding; the run happened once (01:46:29–01:49:53). What changed in the driver since pass 1 — `s3-criteria.ts` `b2009bc5…` → `4ce8095c…`, `s3-criteria.spec.ts` `b2f68f9d…` → `a569f30d…`, `r1-stack.ts` `5359fdb3…` → `c227e843…`, `r1-wiring.spec.ts` `0a28d18e…` → `3e7be980…` — was diffed against the copies preserved in `scratch/` and consists of exactly: the M3 content leg added to `mechanicalFails` (`artifactMatchesGoal === false` under a delivery claim ⇒ fail; unstated ⇒ still inconclusive), one new criteria test pinning both halves, a test-only `recordingFault` hook on `startR1Stack` plus one new wiring test pinning the recording-failure property, and docstring/HANDOFF updates. No other rule moved.

## 0. Verdict of the paid attempt

**`pass`, path `path2-limited-goal`.** All 14 checks hold; reasons: `["every mechanical check and every semantic condition holds (path2-limited-goal)"]`. Decision recorded at `evidence/criteria-replay/s3-run.json` (adjudication sha256 `04ed69c4…`, record sha256 `b8c9bb9d…`, `draft: false`), decided with `driver/s3-criteria.ts` `4ce8095c…`.

Facts read back: one `hitl_ask` call `chatcmpl-tool-947014ca192bbc58`, `isError false`, chain `complete` (prompt → desk → answer → tool result → root JSONL, verbatim); `M2.progress` ok (clarification consumed *and* root contract activated); `M3` ok (`deliveryClaimed` true from `rootTerminal.status = 'verified'`, `artifactBytes = 822`, verifier passes `ac-1/ac-2/ac-3:command` and `ac-4:composite` plus the child's `c-1/c-2/c-3`, `artifactMatchesGoal` stated `true` by the review); `S1.freeze`, `S2.dependency`, `S3.confirmation`, `S4.limitedGoal` all ok; conditions `{quarter: retained-unknown, dataSource: user-confirmed, deliveryScope: user-confirmed}`; `rootTerminal = verified`; `recordErrors = []`.

Counterfactual (F1 fix): the same record and review with `artifactMatchesGoal` flipped to `false` ⇒ **`fail`**, `path: rejected: a mechanical check failed`, reason `M3: the run claims delivery but the adjudication states the artifact does not match the adjudicated goal`. The amendment works as specified.

## 1. The three conditions, with citations (the semantic answer)

| condition | label | citation (resolves against `evidence/s3/driver.json`) | what supports it / what stays unknown |
|---|---|---|---|
| `quarter` | `retained-unknown` | `contract-field` `rootContract.assumptions[0]` :: `'the quarter' has no defined date range` | The user never named a quarter: the only user-sourced statements are the request `Create report.txt summarizing the quarter.` (root JSONL line 8, `source.kind 'user'`) and the delivered answer `No data was provided; state that explicitly.` Neither names a quarter. The objective is the request verbatim; no AC or constraint names a period; ac-2 requires only the word "quarter"; the artifact carries no date/year/Q-number. **The judgment call**: `assumptions[0]` continues "…so the report treats it generically as the current/final quarter". I read that as a hedged generic treatment, not a freeze (reasons in the adjudication's note: S1's scope is objective/AC/constraints; the phrase is self-cancelling and sits inside the clause that records the undefined range; nothing value-bearing reaches the artifact or the verifier; the model's own archived reasoning treats the quarter as unknown). The counter-reading — "current/final quarter" is a fixed value ⇒ S1 ⇒ fail — is recorded, not hidden. |
| `dataSource` | `user-confirmed` | `user-answer` `chatcmpl-tool-947014ca192bbc58` (s-root) :: `No data was provided; state that explicitly.` | The ask explicitly asked for a data source; the delivered answer established there is none. What is confirmed is the **absence** of any provided data — not a positive source, and not "the checkout only" (frozen §2). The contract asserts no source (`assumptions[3]`: "No repository or data source is assumed to exist for the summary"), so nothing positive rides on the label. |
| `deliveryScope` | `user-confirmed` | same delivered answer | The answer bounds the delivery: state explicitly that no data was provided. The artifact name (`report.txt`, task checkout root) comes from the user's own message and the contract's first constraint; ac-3 verifies the no-data statement against the file. |

`freezes: []`, `goalDependsOnUnknowns: false`, `goal.limitedGoal: true` (citation = the delivered answer; `criteria: [ac-1, ac-2, ac-3]`), `claimsDelivery: true`, `artifactMatchesGoal: true`. S4 was considered and rejected as material: ac-2's reference to the quarter is the user's own subject, instantiated with no period; the five placeholder sections are explicitly unfilled ("No data is available. [To be filled in: …]") and the file states "no figures are stated here"; the child's `task_submit_result` summary describes the artifact accurately and claims no quarterly analysis.

## 2. V1–V6

## V1 — fixture wiring: **supported**

- The chain is checkable leg by leg: the call (`toolCalls[2]`, `chatcmpl-tool-947014ca192bbc58`, 17:47:21.313Z, `isError false`, `args.prompt` = the question) → the desk record (`humanQuestions[0]`, seam `userQuestions`, `{id:'hitl-ask', question:<prompt verbatim>}`, `{id:'hitl-ask', text:'No data was provided; state that explicitly.'}`) → the tool result (`resultText` byte-equal to the fixed answer) → the root JSONL (`dsh-home/session-log/s-root.jsonl` line 20 holds that text as the `tool/result` for that call id, `isError false`).
- The answer reached the model: the next assistant message (root JSONL line 23) says "The human channel confirms: **no data was provided**", and the contract it then wrote restates it (`assumptions[1]`). The verifier ran as the real registry (evidence bundles carry `verifierId: command` / `composite` with exit codes and log refs).
- `recordErrors: []`, zero tool errors, no swallowed exception; the smoke is a separate adapter-level call (`evidence/smoke-1/result.json`) and cannot be re-scored as the product path. The reverse property is now pinned by the fourth wiring case through the new `recordingFault` hook (test green; mutant `pass2-no-hook` — hook removed — turns it red at `expect(call.desk).toBeNull()`), and the hook is inert unless set (`grep`: only `r1-wiring.spec.ts:395` sets it; the paid spec does not).
- Note (traceability): the desk leg has no durable surface other than `driver.json` (the seam writes no file) — that is exactly the evidence M1 names, but an independent reader can verify legs 1/3/4/5 from the JSONL itself and leg 2 only from the record.

## V2 — criteria validity: **supported**

- The frozen criteria still reject the original S3 trajectory: `evidence/criteria-replay/original-s3.json`, re-generated at 02:01 with the amended module — `fail`, `path: rejected: the semantic gate refused the trajectory`, 5× S1 + S2, adjudication `provisional: false`.
- Every required check enters the verdict (audited in pass 1; the amendment only *strengthens* M3 by moving an explicit content mismatch into `mechanicalFails` while an unstated one stays a pass-blocker).
- Deterministic suite: `17 passed (17)` = 13 criteria + 4 wiring (command below). It covers answer-consistency failure, tool failure (`isError`), unanswered clarification, unresolved unknown rejection, explicit retention acceptance, the real-wiring positive, delivery-claim failures, and now the content mismatch and the recording-failure injection.
- Changed rules are pinned: mutant `pass2-no-f1` (the amended line removed) turns the new criteria test red (`inconclusive` where the test demands `fail`); mutant `pass2-no-hook` turns the new wiring test red. Both executed this pass.

## V3 — this round's real run: **supported**

- Ran under the frozen contract, once: `run-meta.json` records the fixed model config (`step-5-preview`, `reasoningEffort high`, gateway `https://api.stepfun.com/step_plan/v1`, only the key *length* recorded), the Singularity SHA `9f8ba922…` (repo clean), and driver hashes identical to the frozen ones; `pre-run.json` shows `evidence/s3/` did not exist before, and the fixtures' §5a mtimes predate the run.
- Clarification was available (not an error) and was consumed — chain `complete`, model's next message quotes it.
- The trajectory matches an allowed path: **path2** (and also path1: nothing frozen, goal independent of the unknown, quarter explicitly retained). No unknown was silently frozen — with the `quarter` judgment call recorded above.
- Quarter: **no user information**; explicitly recorded as undefined in `assumptions[0]` and instantiated nowhere. Data source: the delivered answer confirms **no data was provided / no source exists** (no positive source is asserted anywhere). Delivery scope: the delivered answer's instruction to state the absence + the user's own report.txt request.

## V4 — unavailable branches (no-paid-model fault injection): **supported**

- Clarification failure: wiring case 2 (`unavailableDesk`) — `isError true`, chain `unavailable`, criteria `fail` on the frozen goal that follows; criteria-spec case 4 covers the same shape synthetically.
- Unanswered: wiring case 3 (`silentDesk`) — `answerMissing`, a goal depending on it fails, the same ask with an explicitly retained unknown passes; criteria case 6 asserts the retained-unknown pass.
- Unresolved-unknown rejection and explicit retention: criteria cases 5/6 and the pass-1 mutants (`no-s1`, `no-s1-s2`, `no-s2`, `retained-as-unknown`) that pin them.
- Labels: the wiring spec's header states it is *criteria/fixture validation*, "not a claim that a general production semantic gate exists", and that the scripted model stands in for a real one; frozen §4.4 says the same. No claim of a production semantic gate is made anywhere in the run's evidence.

## V5 — experiment ledger: **partly (one open item)**

Present and verified: one directory per attempt (`evidence/smoke-1/`, `evidence/s3/` with `driver.json`, `run-meta.json`, `dsh-home/`, `repo/`), input config, versions (Singularity SHA, driver file hashes, contract hashes), times, Session/Task/Run/Evidence references (with a named non-creation reason for the smoke: it opens no store/task/run), raw responses (archived session JSONL for both sessions, byte-identical to the record's copies), actual usage broken down per session and recomputed exactly (34518/16097/168704/0 in+out/cache, 15 records = 9 root + 6 worker), the smoke counted (12/409), tool calls (17, names in order, 0 errors), stop reason (`root terminal: verified`), soft limits not exceeded, no accidental repeats (single `evidence/s3`, no second smoke dir, `run/s3` is the live scratch), old evidence untouched, missing usage recorded as missing ("one root-session model request … no usage record … Missing, not zero") and cache reads kept in their own column (no double add).
**Open item:** both ledger entries still carry `"verdict": "pending adjudication"`. That was accurate when written, but the adjudication now exists; §5's ledger column must be filled with the replay verdict (`s3 → pass`, with a reference to `evidence/criteria-replay/s3-run.json`; the smoke has no verdict) by the round owner — my write scope excludes `ledger.json`.

## V6 — history correction: **partly (one arithmetic defect, inherited)**

Recomputed from `budget.json` + commit `3b446cb` + the plan's Q5 row:

- `143978` in+out ✓ (per-scenario 49001 + 23227 + 70855 = 143083, plus smoke 895), `44` tool calls ✓ (14 + 6 + 24), `405098` with cache reads ✓ (261120 cache + 143978).
- `175461 = 143978 + 31483` ✓; `58 = 44 + 14` ✓ — the first-round S1 figures come from commit `3b446cb` ("S1 单独消耗 31483 输入+输出 token … 计入缓存读为 96251"), and the plan's Q5 row carries the same figures. Old records are preserved (historical tree hashes/mtimes unchanged) and nothing claims the first round's raw evidence is complete ("lower bound", "first-round session log was overwritten").
- **Defect:** `501349` is stated as `405098 + 96451`, but `405098 + 96451 = 501549`. `501349 = 405098 + 96251`, where `96251` is S1-only and `96451` is the same commit's *with-smoke* figure — and the frozen contract's own rule ("首轮两次冒烟 200 token 已在 143978 口径内，不重复相加") is what forbids adding the smoke-bearing 96451. So the total is right under the no-double-count rule and the parenthetical is wrong by the smoke's 200 tokens. `ledger.json` reproduces the contract's line verbatim ("reproduced, not recomputed") and is internally consistent with the correct total (`226497` in+out and `670053 = 501349 + 168704` with cache; `75 = 58 + 17` tool calls ✓). No claim is false (it says "at least"), but the derivation should be corrected in the next amendment or in the round's narrative.

## 3. Blockers, findings, and things a progress reviewer should not accept as written

- **No blocker to the verdict.** The attempt passes on the frozen decision procedure, and the amendment that pass 1 asked for is in place, pinned, and load-bearing.
- **BL-1 (must fix before sign-off):** the ledger still says `pending adjudication` for both entries (V5 above).
- **F-1 (must be acknowledged in the round's narrative):** 501349's parenthetical is off by 200 (V6 above). The ledger must not be read as recomputing it.
- **F-2 (the pass rests on two documented judgment calls):** (i) `assumptions[0]`'s "current/final quarter" read as retention, not freeze; (ii) the placeholder template read as inside the user's limited instruction rather than smuggled content. Both are argued at length in `evidence/adjudication/s3-run.json`; a stricter reviewer could reject on either — a progress reviewer should see them, not just the green verdict.
- **F-3 (the pass also rests on `artifactMatchesGoal: true`),** which is the independent reviewer's semantic statement; the mechanically checked legs (real artifact, real verifier passes) do not judge content. In this run the contract's own criteria are shallow grep checks (`grep -i quarter`, `grep -i "no data"`, `test -s`-style find), so the verifier verdicts certify almost nothing about the report's substance — every substantive claim in this pass's V3 answer comes from reading the 822-byte artifact itself, not from the verifier.
- **F-4 (verdict loopholes that survive, executed on this attempt's record, `scratch/results/pass2-loopholes.txt`):** (a) PROBE E — the same record with `rootTerminal.status = 'failed'` and `claimsDelivery: false` **passes even with `artifactMatchesGoal: false`**, because M3 is conditioned on a delivery claim (§4.1's own conditioning; the mitigation is the review's `claimsDelivery` honesty); (b) PROBE F — a `retained-unknown` label only has to cite something that resolves: citing the user's own objective instead of the retention clause still passes. These are the pass-1 F2/F3 loopholes, still open by design (no keyword stand-in is allowed).
- **F-5 (evidence honesty, not a defect):** the root session's last turn never produced a model response — the log ends at `step/start` after the "batch settled" splice, with no usage record for that request. The delivered artifact, verifier verdicts and root terminal are complete; the *user-facing wrap-up message* is not. The round's evidence states this explicitly; no claim that the model answered the user at the end should appear in the summary.
- **F-6 (traceability note):** M1's desk leg lives only in `driver.json` (the seam writes no file); everything else in the chain is in the archived JSONL. Also, the smoke's cache tokens are unrecorded (not zero) and one request's usage is missing — both disclosed.

## 4. Commands run this pass (all offline, no model call, no credential use)

```sh
cd /home/ROXY/code/bb_work/harness
# the frozen deterministic suite (13 criteria + 4 wiring)
pnpm exec vitest run --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1.config.ts
#   -> Test Files 2 passed (2); Tests 17 passed (17); 4.11 s   (results/pass2-deterministic-suite.txt)

# decide the paid run and write evidence/criteria-replay/s3-run.json (+ counterfactual)
pnpm exec vitest run --config .../evidence/review/scratch/vitest.scratch.config.ts "cases/pass2-s3-run"
#   -> 1 passed; verdict=pass path=path2-limited-goal; counterfactual verdict=fail   (results/pass2-s3-run.txt)

# the two changed rules, each removed in a scratch copy and caught by the frozen tests
pnpm exec vitest run --config .../scratch/vitest.scratch.config.ts "mutants/pass2-no-f1/"
#   -> 1 failed | 12 passed  ("rejects a delivered run whose adjudication states the artifact does not match the goal")
pnpm exec vitest run --config .../scratch/vitest.scratch.config.ts "mutants/pass2-no-hook/"
#   -> 1 failed | 3 passed   ("pins that a recording failure cannot change or swallow the product path")

# loophole probes on the paid record
pnpm exec vitest run --config .../scratch/vitest.scratch.config.ts "probes/pass2-loopholes"
#   -> 2 passed (characterization: PROBE E / PROBE F above)
```

Verification reads (read-only, no writes outside `evidence/review/`, `evidence/criteria-replay/`, `evidence/adjudication/`): `sha256sum` over `driver/*`, `fixtures/*`, `evidence/s3/**`; Python comparisons of `driver.json`'s `sessionLogs` against the archived JSONL (identical), of `record.rootContract` against the JSONL `task_intake` arguments (normalization only: `mode`→`verificationMode`, `requiredEvidence`, `contractVersion`, `requiredCapabilities`), of the ledger's per-session usage against `usage[]` (exact), of the artifact's bytes/sha256 (822 / `befd505d…`), and of the V6 figures against `budget.json` and `git show 3b446cb` in `harness/packages/singularity`. The derived `evidence/s3/conversation.md` was spot-checked against the primary JSONL rather than trusted: of 402 root-session strings of ≥25 characters, 399 appear in it byte-identically and the 3 misses are explained by the documented JSON-escaped rendering (a `…`/`—` kept literal where my check escaped it; an embedded newline rendered as `\n` inside a JSON block) — all three are present, none is paraphrased, and the fixed answer and call id appear verbatim.

## 5. Is the criteria + evidence set enough to sign off?

- **V2 (criteria validity): yes** — with pass 1's F2/F3 boundary notes and the new F-2/F-3 caveats that the paid pass rests on documented review judgments.
- **V3 (this round's real run): yes** — real model, frozen config and hashes, complete clarification chain, converging limited goal, one allowed path, nothing silently frozen (the quarter judgment call is recorded).
- **V1 (fixture wiring): yes** — checkable chain from the durable surface, no swallowed failure, and the recording-failure property now pinned by a test.
- **V4 (no-paid-model fault injection): yes** — the required branches are covered and labelled as criteria/fixture validation only.
- **V5 (ledger): not yet** — BL-1 (verdict column still `pending adjudication`).
- **V6 (history correction): not yet** — F-1 (the `501349 = 405098 + 96451` parenthetical; the totals themselves are correct as lower bounds).

Both open items are small, arithmetical/administrative, and outside my write scope; with them fixed (or explicitly accepted in the round's narrative) I would sign off this round's criteria + evidence as supporting V1–V6.

---

# Pass 3 — V5/V6 confirmation (2026-09-24, after the round owner's two fixes)

Scope: verify the two items that pass 2 left open (`evidence/ledger.json`'s verdict column and the cache-inclusive arithmetic), recompute the whole chain, and state whether V5 and V6 become **supported**. Nothing outside `evidence/review/` was written; `driver/**`, `fixtures/**`, the harness tree and the historical evidence are untouched (hashes re-checked: `s3-criteria.ts` `4ce8095c…`, spec `a569f30d…`, stack `c227e843…`, wiring `3e7be980…`, `frozen-contract.md` `1234da2f…`, historical `s3/driver.json` `349e6615…`, `budget.json` `d0ab6b04…`).

## 1. V5 — ledger verdict column: fixed, **supported**

- `attempts[s3].verdict` = `"pass"`; `attempts[s3].verdictSource` = `"evidence/criteria-replay/s3-run.json — decided by the frozen driver/s3-criteria.ts (sha256 4ce8095c…) on this attempt's driver.json plus the independent adjudication evidence/adjudication/s3-run.json …; path2-limited-goal, all 14 checks ok"` — the same verdict I recorded, pointing at the decision file and naming the frozen criteria hash. `attempts[smoke-1].verdict` = `"not a scenario attempt: the connectivity gate reported ok=true with finishReason stop; it is judged by nothing but its own record"` — accurate; the smoke is not a scenario and no criteria module judges it.
- `grep "pending adjudication"` over the ledger: 0 occurrences.
- My deliverables are unchanged and still self-consistent: the adjudication file's sha256 is still `04ed69c4…`, matching the sha256 recorded inside `evidence/criteria-replay/s3-run.json`, and `evidence/s3/driver.json` still hashes to `b8c9bb9d…` as recorded there (so no post-decision edit to the record or the review).
- The rest of the V5 checklist, re-read and re-verified in this pass: independent directory per attempt (`evidence/smoke-1/`, `evidence/s3/` with `driver.json`, `run-meta.json`, `repo/`, `dsh-home/`); input config per entry; versions (Singularity SHA, driver and contract hashes incl. the frozen criteria); times (`startedAt`/`endedAt`, scenario wall clock); references for the S3 attempt (store/session/task/run/proposal/evidence/artifact) and a named non-creation reason for the smoke; raw responses in the archived JSONL; actual usage with the missing record named, not zeroed (`"Its tokens are unrecorded, not zero."`; smoke cacheRead/cacheWrite `"not recorded"`); tool calls (17, names in order, 0 errors); stop reason (`root terminal: verified`); smoke counted, no failures/cancellations, no accidental repeat (`R1_ALLOW_RERUN` unset, single attempt dir); cache kept in its own column; old evidence untouched.
- One cosmetic note: the ledger attributes the review to "reviewer agent-1" while the adjudication file names itself `r1-criteria-review`; both refer to the same artifact, whose sha256 is carried in the replay file. Not a defect.

## 2. V6 — arithmetic: fixed, **supported**

Recomputed end to end by execution (script over `budget.json`, `git show 3b446cb`, and `evidence/ledger.json`):

| step | computation | result | matches |
|---|---|---|---|
| budget.json in+out | 117645 + 26333 | 143978 | ✓ `totalTokens`, and per scenario 49001 + 23227 + 70855 + smoke 895 |
| budget.json with cache | 143978 + 261120 | 405098 | ✓ |
| budget.json tool calls | 14 + 6 + 24 | 44 | ✓ |
| first round S1 (`3b446cb`) | 31483 in+out; with cache 96251 ⇒ cache 64768 | 96251 | ✓ commit text; first-round total incl. its two smokes 31683 / 96451, i.e. exactly +200 |
| historical lower bounds | 143978 + 31483 = 175461; 44 + 14 = 58; 405098 + **96251** = 501349 | 175461 / 58 / 501349 | ✓ all three printed figures |
| this round | 34518 + 16097 + 12 + 409 = 51036 in+out; cache 168704; tool calls 17 | 51036 / 168704 / 17 | ✓ ledger increment and `usage[]` |
| cumulative | 175461 + 51036 = 226497; 58 + 17 = 75; 501349 + 51036 + 168704 = **721089** | 226497 / 75 / 721089 | ✓ ledger `thisRound.cumulative` |
| cross-check | (175461 + 51036) + (325888 + 168704) = 226497 + 494592 | 721089 | ✓ same figure |

- The `arithmeticCorrection` note is exactly right, and I verified its premise from the sources rather than taking it: `budget.json`'s smoke figure 895 is the sum of the four archived smoke records (`smoke.json` = 12/54 + 12/122 = 200, `smoke-s2s3.json` = 12/136 + 12/535 = 695), and `3b446cb` records the first round's own two smokes as 12/54 and 12/122 with the same texts — so the first round's 200 is inside the 895, `96451 = 96251 + 200` would double-count it, and `501349` is unaffected. The plan's new V6 table (`2026-09-20-vrtc-code-change-plan.md`, section "R1 补验证（Q4/Q5）执行与验收记录") carries the same corrected figures (`≥175461`, `≥58`, `≥501349 = 405098 + 96251`, `200 = 12/54 + 12/122`, this round `51036 / 17 / 168704`, cumulative `226497 / 75 / 721089 = 501349+51036+168704`) — all recomputable and consistent with my numbers.
- **Correction to my own pass-2 wording:** I wrote that the old `670053 = 501349 + 168704` was "internally consistent". It added the historical cache-inclusive total to this round's cache column alone, silently dropping this round's 51036 in+out, so it was not a coherent cache-inclusive cumulative; the round owner's `721089` is. My pass-2 check verified the addition but not the coherence of the columns — recorded here so the review's history is accurate.
- The ledger's `accountingRules` line "historical figures are reproduced from frozen contract §5, not recomputed and not extended" still holds for the historical figures (none changed); the new `arithmeticCorrection` explains a derivation instead of rewriting a figure, and the only changed number is `thisRound.cumulative.withCacheReadsLowerBound`, which is this round's own figure.

## 3. One new documentation observation (not a V-item defect)

The round owner also updated the Singularity docs (plan + guide + execution-prompt README, documentation only: `git diff --name-only` shows exactly `docs/2026-09-20-vrtc-code-change-plan.md`, `docs/singularity-harness-guide.md`, `docs/execution-prompts/README.md`; HEAD is still `9f8ba92` and no `src/` or test file is touched). Their claims match this review (single scenario, path2 pass, historical account corrected, production code unchanged). One phrase overclaims: the plan's delivery row says "Singularity 收尾仍 `9f8ba92`，工作区干净", but the worktree is **not** clean now — `git status --porcelain` in `packages/singularity` shows those three uncommitted doc files. Either commit them (HEAD moves, so the sentence needs rewording) or change the phrase to "生产代码与测试零改动；仅 docs/ 下的本票记录尚未提交". The run-time claim (the verified SHA at freeze/run time) is unaffected.

## 4. Sign-off

| item | status | one-line basis |
|---|---|---|
| V1 fixture wiring | **supported** | real `hitl_ask` → real `userQuestions` → fixed answer verbatim → root JSONL `tool/result`; answer quoted by the model's next message; `recordErrors []`; recording-failure property pinned by the new hook test (mutant red) |
| V2 criteria validity | **supported** | original trajectory replayed `fail` (5×S1 + S2, `provisional: false`); every §4 check enters the verdict; 17/17 deterministic; changed rules pinned by mutants |
| V3 real run | **supported** | one real attempt under the frozen config/hashes; clarification available and consumed; `pass` via path2 (path1 also holds); quarter retained-unknown, source/scope confirmed by the delivered answer; the quarter judgment call is recorded, not hidden |
| V4 fault injection | **supported** | tool failure, unanswered, unresolved-unknown rejection, retained-unknown acceptance, real-wiring positive, content mismatch, recording-failure — all offline and labelled criteria/fixture validation |
| V5 ledger | **supported** | verdict column now `pass` + `verdictSource`; smoke marked not a scenario; every §5 item present; missing usage named not zeroed; cache kept separate; no repeats or overwrites |
| V6 history correction | **supported** | every printed figure recomputed and correct (`175461`, `58`, `501349 = 405098 + 96251`, increment `51036 / 17 / 168704`, cumulative `226497 / 75 / 721089`); the 96451 double-count is explained and the total is unaffected; old records preserved, first round stated as a lower bound |

**Final: V1–V6 all supported.** Remaining items are documentation precision (the "工作区干净" phrase above) and the standing boundary notes already recorded in pass 2 (the semantic face of the criteria depends on an honest independent review; M3 content is judged only under a delivery claim; this round's contract criteria are shallow greps; one usage record is missing; the first round's raw log is unrecoverable, so the historical figures are lower bounds).
