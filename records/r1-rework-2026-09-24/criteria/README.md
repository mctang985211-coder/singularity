# `s3-criteria/2` — the R1 rework round's criteria revision

Round: R1 rework, 2026-09-24 (`/home/ROXY/code/bb_work/r1-rework-2026-09-24/`).
Subject: the two checks the progress review found missing from the frozen S3 criteria
(`r1-supplemental-2026-09-24/driver/s3-criteria.ts`, `s3-criteria/1`), the targeted
counterexamples that are red on the frozen module and green on the revision, and the replay of
this round's required trajectories under both versions.

| what | path | sha256 |
|---|---|---|
| frozen module `s3-criteria/1` (read-only reference) | `r1-supplemental-2026-09-24/driver/s3-criteria.ts` | `4ce8095ca063924239cbadd8654284ae8a0d4b903961d1d604e4b046bdafe92c` |
| revision `s3-criteria/2` | `criteria/s3-criteria-rev2.ts` | `83d9ee3141c52f0548c62b3e9cf68c6af7d006d5d08a859b37ff0baee602d1c9` |
| minimal edit (audit diff) | `criteria/s3-criteria-rev2.diff` | `5032972491764bfbfae55e30ac30306c0941830dbb5bd4d263887775073aca2a` (268 lines) |
| counterexamples | `criteria/s3-criteria-rev2.spec.ts` | `a9b53bf60ce43af8679faa3684176734b1386e5b79ad2a5023ccbe8268e38052` |
| verdict matrix spec | `criteria/verdict-matrix.spec.ts` | `15e3b2a0736d6fc8530349bd548036aa891f6cb0b93e3f77c5db58388e8c2371` |
| real-wiring positive spec | `criteria/rev2-wiring.spec.ts` | `e1add01081491931ac043ea1c4648f4b050a325489715f8eaeda8ff58b5e289a` |
| runner | `criteria/vitest.rev2.config.ts` | `6e0399affd556ed395915f5bb6a6c31d309bd384c9853b2aeeb3b1396abfaf12` |

The revision is an exact copy of the frozen module with the two fixes below and nothing else —
no renames, no refactors, no new dependency, the public interface (`decideS3`, every exported
type, every existing `checks` key) unchanged. `criteria/s3-criteria-rev2.diff` is
`diff -u <frozen> <revision>`; it is the whole change.

## 1. The two edits

### Fix 1 — M1 must verify the frozen fixed answer (§4.1 M1)

Frozen contract §4.1 M1, verbatim:

> 每次 `hitl_ask` 调用必须可核对：真实工具调用（args.prompt = 问题原文）→ 真实
> `userQuestions` 服务收到（desk 记录，问题 id/文本对应）→ 固定答复逐字返回 → 工具结果
> 逐字等于固定答复 → 该答复在根会话 JSONL 中作为工具结果出现（模型实际消费）。任一环节不符 →
> 该检查失败。

(The “固定答复” and the result legs are the ones the revision now checks against the record; the
quotation is verbatim, without added emphasis.) 固定答复 is the scenario's frozen answer,
`record.input.fixedAnswer` (§2 of the contract fixes it as
`No data was provided; state that explicitly.`). `s3-criteria/1` only compared the desk answer,
the tool result and the delivered/session-log text **with each other**, so three places agreeing on
the same wrong text read `complete`.

In `criteria/s3-criteria-rev2.ts`:

- `fixedAnswerOf(record)` (`:489`) reads `input.fixedAnswer`; `chainOf` (`:503`) passes it into
  `classify`;
- `classify` gains `readonly fixedAnswer: string` (`:560`) and a comparison block after the
  desk-answer/tool-result comparison (`:582-603`): the desk answer, the tool result and the
  delivered/session-log text must each equal the frozen answer verbatim, else the entry's status is
  `inconsistent` and its detail names the frozen answer and the observed text;
- a new gate check `M1.fixedAnswer` (`:874`) and the gate list (`:967`). `ok = fixedAnswer present
  && no chain that returned an answer disagrees with it`. When `input.fixedAnswer` is absent or
  empty the leg **cannot be verified**: the record is not failed for that (`nothing contradicts it`),
  but the check is `ok: false`, so it lands in `gateFailures`/`blockers` and the verdict is
  `inconclusive` — never `pass`. This reading is recorded in the module docstring (`:79-82`).

Unchanged: an errored call is still `unavailable`, an unanswered desk still `unanswered`, an
unmatched desk record still `unaccounted`, and none of those alone fails (§4.1 keeps them
accounted; the fail is for treating an unanswered ask as consent).

### Fix 2 — M3 requires every required criterion to pass (§4.1 M3)

Frozen contract §4.1 M3, verbatim:

> 若运行宣称交付成功（根 run 终态 `verified`，或契约/产物声明成功），则必须：真实产物存在且非空、
> 内容与语义复核认定的有限目标一致、且**实际 verifier** 对该目标的判据给出 `pass`
> （inconclusive/缺失不算）。否则 fail。

`s3-criteria/1` asked only for
`goalPasses.length > 0`, filtered by `adj.goal.criteria` when non-empty — one pass covered all
criteria, so a missing or failing required criterion was silently offset.

In `criteria/s3-criteria-rev2.ts`:

- `requiredContractCriteria(contract)` (`:628`) collects `acceptanceCriteria[].criterionId` with
  `mandatory !== false` (a criterion without a `mandatory` field counts as required);
- the required set (`:735`) is the ordered unique union of the adjudicated `goal.criteria` and the
  contract's required criteria;
- `M3.verifierPass` (`:892`) is ok only when every required criterion has at least one real verifier
  result (`status === 'pass'`, non-empty `verifierId` — the “实际 verifier” rule) and **no**
  recorded result for that id with any other status; its detail names each required criterion as
  `pass`/`missing`/`not-pass`, the passes among them, and the missing/not-passing ids list;
- a missing or not-passing required criterion is a mechanical failure (`:977`): the whole verdict is
  `fail`, never offset by another criterion's pass;
- if a delivery is claimed and **no** required criterion can be established at all (no adjudicated
  `goal.criteria`, no contract criteria), §4.1's `inconclusive/缺失不算` applies: the check is not
  ok, so a pass is blocked (`inconclusive`), never vacuous success. Recorded in the docstring
  (`:83-87`).

Unchanged: the artifact leg (non-empty artifacts), the content leg (an explicit
`artifactMatchesGoal: false` is a fail; an unstated one only blocks a pass), and every other rule.

## 2. The counterexamples (red on `s3-criteria/1`, green on `s3-criteria/2`)

`criteria/s3-criteria-rev2.spec.ts` runs **both** modules on the **same** input. The records are the
paid run's own record and adjudication (`evidence/s3/driver.json`, `evidence/adjudication/s3-run.json`)
mutated in memory; nothing is written to the archive.

Red evidence: the spec was first run with `criteria/s3-criteria-rev2.ts` a **byte-identical copy** of
the frozen module (sha256 `4ce8095c…`) — every counterexample assertion fails, which is exactly the
defect being reproduced. Log: `criteria/verdicts/c1c2-red-before-fix.txt`
(`Tests 8 failed | 1 passed (9)`); raw verdicts: `criteria/verdicts/counterexamples.json`
(taken with the revision fixed — the red-run verdict table is embedded below).

| case | fault | `s3-criteria/1` | `s3-criteria/2` |
|---|---|---|---|
| C1 control | the real record, fixed answer verbatim | `pass` / `path2-limited-goal` / chain `complete` | `pass` / `path2-limited-goal` / chain `complete`, `M1.fixedAnswer` ok |
| **C1** | desk answer = tool result = session-log `tool/result` = the same **wrong** text ≠ `input.fixedAnswer` | **`pass`** (chain `complete` — the defect) | **`fail`**: chain `inconsistent`, `M1.chain` false, `M1.fixedAnswer` false; details name `"No data was provided; state that explicitly."` and `"The quarter is Q3 2025; summarize the checkout."` |
| **C1b** | the same record without `input.fixedAnswer` | **`pass`** (the defect) | **`inconclusive`**: `M1.fixedAnswer` ok false → in `gateFailures` → reason “the mechanical gates did not hold: M1.fixedAnswer …” |
| C2 control | every required criterion (`ac-1…ac-4`) passing | `pass` | `pass`, `M3.verifierPass` ok and naming `ac-1…ac-4` |
| **C2a** | `ac-3`'s verifier result removed (`ac-1`, `ac-2`, `ac-4` still pass) | **`pass`** (the offset — the defect) | **`fail`**: `ac-3=missing`; reason names M3 and `ac-3` |
| **C2b** | `ac-3` flipped to `fail` | **`pass`** (the defect) | **`fail`**: `ac-3=missing; not passing: ac-3`; reason names `ac-3` |
| **C2c** | adjudication names an extra required criterion `ac-9` with no result (all contract criteria pass) | **`pass`** (the defect) | **`fail`**: `ac-9=missing` |
| **C2d** | delivery claimed, no required criterion establishable (contract criteria emptied, adjudicated criteria emptied) | **`pass`** (the defect: vacuous success) | **`inconclusive`**: `M3.verifierPass` ok false, blocks a pass |
| C2e control | the same extended adjudication with `ac-9` really passing | `pass` | `pass` |

C1 shows the fixed-answer leg is load-bearing; C1b and C2d show the two new `ok: false` readings
land in the gates/blockers of the final verdict rather than in a silent pass.

## 3. The verdict matrix

`criteria/verdict-matrix.spec.ts` decides every (record, adjudication) pair with both versions and
writes `criteria/verdicts/matrix.json` (cells: `record`, `recordPath`, `recordSha256`,
`adjudicationFile`, `adjudicationSha256`, `pairing`, `criteria`, `criteriaSha256`, `verdict`, `path`,
`reasons`, `checks` — every non-ok check plus the four mechanical keys — `decidedAt`; the same file
carries the raw inputs and their sha256 so a reviewer can recompute every cell).

| record | adjudication | `s3-criteria/1` | `s3-criteria/2` |
|---|---|---|---|
| `original-s3` (`r1-evidence-2026-09-23/s3/driver.json`, sha `349e6615…c452a`) | `evidence/adjudication/original-s3.json` (sha `7d2b91fc…386c36`) | **`fail`** (S1 freeze ×5, S2 dependency) | **`fail`** (identical reasons) |
| `s3-run` (`r1-supplemental-2026-09-24/evidence/s3/driver.json`, sha `b8c9bb9d…c5621`) | `evidence/adjudication/s3-run.json` (sha `04ed69c4…8f1b69`) | **`pass`** / `path2-limited-goal` | **`pass`** / `path2-limited-goal` |
| `s3-run` (same record) | `adjudication/s3-run-rejudged.json` (discovered at run time; paired by `subject`, which carries the record's sha) | **`inconclusive`** — `resolution.conditions` false, reason `left plain unknown: quarter` | **`inconclusive`**, identical reason |

Both pinned expectations of the frozen contract hold under **both** modules, and the spec fails
loudly if they do not: the original trajectory is rejected and this round's paid trajectory passes —
the two fixes do not change that record's mechanical facts (`M1.chain` `complete`,
`M3.verifierPass` ok with `ac-1…ac-4`, `M1.fixedAnswer` ok).

The third row is the independent re-judgment another agent wrote into
`r1-rework-2026-09-24/adjudication/` while this round was running. The same replay command picked it
up with **no edit** to the spec and re-decided it — the matrix grew from 4 to 6 cells by itself. That
reviewer reads `quarter` as plain `unknown` (contested with `retained-unknown`), and §4.2 sends an
undecidable record to `inconclusive` rather than `pass`; **both** criteria versions decide it
`inconclusive` with the identical reason, so the revision neither loosens nor tightens that
trajectory. On that record `M1.chain`, `M1.accounted`, `M1.fixedAnswer` and `M3.verifierPass` all
hold under the revision: what blocks the pass is the semantic side alone, exactly as the frozen
criterion intends.

Discovery was also probed deliberately earlier: two temporary probe files (one per record) were
dropped into `adjudication/`, picked up the same way, and removed again. Pairing is by `subject`
(historical path / original record sha / `original-s3` versus current path / current record sha /
`s3-run`; only one match counts) and otherwise defaults to `s3-run`, with the pairing stated in the
cell and in `matrix.pairing`.

`matrix.json` is a snapshot of the run that wrote it (`writtenAt`); re-running the replay command
regenerates it, so a later edit of a re-judgment file is reflected without touching this spec.

## 4. The real legitimate positive example (§4.4 item 5) under both versions

`criteria/rev2-wiring.spec.ts` runs the archive's real-wiring positive case: the real `hitl_ask`
tool → the real `userQuestions` desk → the fixed answer verbatim → the root session's own JSONL
`tool/result` the loop appended → the real `TaskRuntime` and the real command verifier, with the
archive's scripted provider standing in for the model output only. Result
(`criteria/verdicts/wiring-positive.json`):

- the real chain holds: `isError false`, tool result = desk answer = `delivered.text` =
  session-log `tool/result` = `No data was provided; state that explicitly.`, the answer present in
  the next model request, `recordErrors []`;
- root terminal `verified`, artifact `report.txt` non-empty;
- **both** versions: `pass`, path `path2-limited-goal`, chains `['complete']`;
- the revision's new legs: `M1.fixedAnswer` ok (naming the frozen answer),
  `M3.verifierPass` ok with `required criteria: artifact-exists=pass, no-data-stated=pass`;
- **no network attempt at all**: `net.Socket.prototype.connect` was instrumented for the run and
  recorded zero calls. Importing the archive's `r1-stack.ts` does transitively load `r1-env.ts`
  (which reads `.dsh/api.env` into the process environment); with `modelAdapter: 'scripted'` the
  gateway adapter is never constructed, and the probe confirms nothing dials out.

This is criteria/fixture validation with a scripted model on real wiring — it is not a real-model
result and says nothing about how a real model behaves.

## 5. No regression: the frozen 13 deterministic cases under the revision

Temporary verification (not a deliverable): the archive's `s3-criteria.spec.ts` was copied, its
imports re-pointed at `criteria/s3-criteria-rev2.ts` and its one output file redirected out of the
archive, and run — **13/13 passed**
(`criteria/verdicts/frozen-spec-13-under-rev2.txt`; the redirect's own output is
`criteria/verdicts/frozen-spec-under-rev2.json`). Every existing rejection still rejects and
every existing pass still passes, so the revision adds the two checks and changes no other rule.
The temporary spec and config were deleted afterwards; re-running the copy needs the same two
redirections (the original spec writes into the archive and must not be run as-is).

## 6. Exact commands

```sh
# the replay (all three specs: counterexamples + matrix + real wiring)
cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
  --config /home/ROXY/code/bb_work/r1-rework-2026-09-24/criteria/vitest.rev2.config.ts

# the counterexamples alone (the run that was red before Fix 1/Fix 2 and is green after)
cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
  --config /home/ROXY/code/bb_work/r1-rework-2026-09-24/criteria/vitest.rev2.config.ts \
  criteria/s3-criteria-rev2.spec.ts

# the audit diff (the exact command that produced criteria/s3-criteria-rev2.diff)
cd /home/ROXY/code/bb_work && diff -u \
  r1-supplemental-2026-09-24/driver/s3-criteria.ts \
  r1-rework-2026-09-24/criteria/s3-criteria-rev2.ts
```

Observed on 2026-09-24: the full replay is `Test Files 3 passed (3)`, `Tests 14 passed (14)`
(9 counterexamples + 4 matrix + 1 wiring), ~9 s, no network, no model call
(`criteria/verdicts/rev2-replay.log`). Before the fix, the same counterexample command was
`Tests 8 failed | 1 passed (9)` with the revision still byte-identical to the frozen module
(`criteria/verdicts/c1c2-red-before-fix.txt`).

## 7. Boundaries

- `s3-criteria/2` is a **revision of the criteria**, not a re-run of the scenario: it decides the
  same inputs differently only where the two missing checks apply. The paid trajectory of the
  previous round is read back read-only; its verdict (`pass`, `path2-limited-goal`) is unchanged.
- The counterexamples and the wiring spec are deterministic fixture validations. The scripted model
  replaces the model output only; runtime, tool, desk, session log and verifier are the production
  components. A green run says nothing about real-model behaviour.
- The frozen-contract criteria text (§4.1, §4.2, §4.4) is quoted, not amended: the revision records
  its readings of the two clauses it implements in the module docstring, and the frozen
  `fixtures/frozen-contract.{md,json}` remain untouched.
- Nothing under `r1-supplemental-2026-09-24/`, `r1-evidence-2026-09-23/` or `harness/` was modified
  or added: after the whole round the archived files still hash to their frozen values
  (`s3-criteria.ts` `4ce8095c…`, `evidence/s3/driver.json` `b8c9bb9d…`, `s3-run.json`
  `04ed69c4…`, `original-s3.json` `7d2b91fc…`), and `git -C harness status --porcelain` still shows
  only the pre-existing ` M thirdparty/deepseek-harness` (submodule HEAD `0d1f5000…`, untracked
  `.tmpscan/`, `bad.txt`). The only thing vitest wrote under the harness tree is its own
  `node_modules/.vite` cache.
- The remaining judge decision (whether the revision is adopted, and whether the round is accepted)
  belongs to the reviewer/parent agent; this round only produces the revision, its evidence and the
  replay.
