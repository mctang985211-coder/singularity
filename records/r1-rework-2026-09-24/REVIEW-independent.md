# Independent review — R1 rework round (2026-09-24)

Reviewer: independent agent, did not write any reviewed artifact. All experimental work was done in
temporary copies under `/tmp`; the only file created or edited is this report. Commands were run with
cwd `/home/ROXY/code/bb_work/harness` (no `pnpm` inside `thirdparty/deepseek-harness`), with no
network and no paid model call.

**Overall verdict: the round's claims hold.** I could not falsify any of the six items. The revision
is exactly the frozen module plus the two announced fixes (proved byte-for-byte, both directions);
the counterexamples are real and load-bearing (the red run reproduced independently, and reverting
either fix turns its case green again); the replay verdicts reproduce cell-for-cell; the accounting
recompute matches my own independent count of the raw logs; and the semantic re-judgment's every
citation resolves against the record. I found two documentation-level defects, neither of which
changes a verdict or a figure, and one claim I judge to be a defensible judgment call rather than a
derivation. Details below.

| item | verdict |
|---|---|
| 1. minimality, no loosening | **holds** — stored diff is the whole change (byte-identical both ways); 13/13 archive cases still behave; 4 000-input differential sweep found **0** loosening |
| 2. counterexamples real & load-bearing | **holds** — red run reproduced (8 failed / 1 passed, same 8 cases); fix-removed mutants go green |
| 3. replay verdicts | **holds** — regenerated matrix equals the delivered one cell-for-cell; all input hashes match disk |
| 4. accounting recompute | **holds** — 15/15 usage objects carry no `cacheWriteTokens`; totals confirmed independently; both trees byte-identical to their manifests |
| 5. semantic re-judgment | **holds as an honest, defensible judgment** — all citations resolve; `quarter: unknown` is within §4.2 and does not manufacture a rejection; it is a judgment, not a mechanical derivation (see §5.3) |
| 6. boundaries | **holds** — no archive/harness content change; zero network syscalls under `strace`; real `hitl_ask`/`userQuestions`/session-log path |

---

## 0. Method

Every test run was executed against an isolated copy of the specs at `/tmp/review/` (paths rewritten
to the copy) so that the deliverable `criteria/verdicts/*.json` could not be overwritten. The two
archive trees were mounted read-only in effect (symlinks) and re-hashed afterwards. The reviewer's
own probe files live under `/tmp/rev/`. The deliverable hashes are unchanged from the round's own
table (re-checked after all work; see §6.4).

Key commands (all reproduced verbatim below with their output):

```sh
# 1. minimality, both directions
cd /home/ROXY/code/bb_work && diff -u r1-supplemental-2026-09-24/driver/s3-criteria.ts \
  r1-rework-2026-09-24/criteria/s3-criteria-rev2.ts > /tmp/rev/recomputed.diff
cmp /tmp/rev/recomputed.diff r1-rework-2026-09-24/criteria/s3-criteria-rev2.diff
# then, in /tmp/rev with the two paths recreated:
patch -p0 < .../s3-criteria-rev2.diff && cmp r1-rework-.../s3-criteria-rev2.ts .../criteria/s3-criteria-rev2.ts

# 2. the round's replay, in the isolated copy
cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
  --config /tmp/review/criteria/vitest.rev2.config.ts

# 3. the archive's own 13 cases re-pointed at the revision (temp copy)
cd /home/ROXY/code/bb_work/harness && R1_ADJUDICATION=.../adjudication/original-s3.json \
  pnpm exec vitest run --config /tmp/rev/specs/vitest.mine.config.ts

# 4. my own adversarial probes and the differential sweep
node /tmp/rev/probe/adversarial.ts ; node /tmp/rev/probe/edges.ts ; node /tmp/rev/probe/sweep.ts

# 5. accounting, independently of the round's script
python3 - <<'PY'  # count assistant/message data.usage objects in the raw JSONL
PY
python3 /home/ROXY/code/bb_work/r1-rework-2026-09-24/accounting/cache-write-recompute.py

# 6. network
cd /home/ROXY/code/bb_work/harness && strace -f -e trace=%network -o /tmp/rev/strace-net.log \
  pnpm exec vitest run --config /tmp/review/criteria/vitest.rev2.config.ts
```

---

## 1. Minimality and no loosening — holds

### 1.1 The stored diff is the whole change, proved in both directions

```
$ cd /home/ROXY/code/bb_work && diff -u r1-supplemental-2026-09-24/driver/s3-criteria.ts \
    r1-rework-2026-09-24/criteria/s3-criteria-rev2.ts > /tmp/rev/recomputed.diff
$ cmp /tmp/rev/recomputed.diff r1-rework-2026-09-24/criteria/s3-criteria-rev2.diff
STORED DIFF == RECOMPUTED DIFF (byte-identical)      # 268 lines
```

```
$ cd /tmp/rev && patch -p0 < .../s3-criteria-rev2.diff
patching file r1-supplemental-2026-09-24/driver/s3-criteria.ts
$ cmp r1-rework-2026-09-24/criteria/s3-criteria-rev2.ts .../criteria/s3-criteria-rev2.ts
PATCH-APPLIED FROZEN == REV2 (byte-identical)
```

So `rev2 = frozen + stored_diff`, exactly. I then read all 268 diff lines: every hunk is either a
comment/docstring, or one of the two announced fixes (`fixedAnswerOf` + `classify` comparison +
`M1.fixedAnswer` + gate entry; `requiredContractCriteria` + required-set union + `M3.verifierPass` +
mechanical-fail line). The removed identifiers `criterionFilter`/`goalPasses` are not used anywhere
else in the frozen module (only their former definition/use sites at frozen `:643-644`, `:790`,
`:792` — all inside the rewritten M3 leg).

Public interface unchanged: all 25 exports and all exported type names are identical between the two
modules; the only new `checks` key is the announced `M1.fixedAnswer` (frozen has 14 keys, rev2 has
15).

### 1.2 The archive's own rejection cases still reject (13/13)

I re-pointed `r1-supplemental-2026-09-24/driver/s3-criteria.spec.ts` at the revision in a temp copy
(import rewritten, its `evidence/criteria-replay/` output redirected out of the archive,
`R1_ADJUDICATION` set to the archive's authoritative file):

```
✓ /tmp/rev/specs/frozen-spec-under-rev2.spec.ts (13 tests) 17ms
Test Files  1 passed (1)
     Tests  13 passed (13)
```

Every existing rejection still rejects and every existing pass still passes — including the case
that matters most for over-tightening, *"passes an activated limited goal that explicitly retains the
unknown while the clarification went unanswered"*. This matches the round's `frozen-spec-13-under-rev2.txt`.

### 1.3 My own adversarial records

Written from scratch (not reused from the round's spec), run through the frozen module, the revision,
and two fix-removed mutants. Full output: `ALL EXPECTATIONS HELD` (`/tmp/rev/probe/adversarial.ts`,
`/tmp/rev/probe/edges.ts`). The three cases the task named, plus more:

| case | construction | frozen /1 | rev2 /2 |
|---|---|---|---|
| C1b′ | desk = result = session log = the same **wrong** text, and the record **omits** `input.fixedAnswer` | `pass` | **`inconclusive`** (`M1.fixedAnswer` ok=false → blocker) |
| P1 | contract gains a `mandatory:false` criterion whose verifier result is `fail` | `pass` | `pass` — no over-tightening |
| P2 | contract gains a criterion with **no** `mandatory` field whose result is `fail` | `pass` | **`fail`** (required by default) |
| P3 | adjudication names `ac-1` (passes) **and** `ac-3` (flipped to `fail`) | `pass` (offset) | **`fail`** (`ac-3=missing … not passing: ac-3`) |
| P6 | `mandatory:false` criterion **missing** | `pass` | `pass` |
| P7 | duplicate id, one `mandatory:false` one `mandatory:true`, failing | `pass` | `fail` |
| P8 | `ac-3`'s only result has an **empty** `verifierId` | `pass` | `fail` |
| P9 | `ac-3` has both a `pass` and a `fail` result | `pass` | `fail` (`ac-3=not-pass`) |
| P10 | no `hitl_ask` call at all, adjudication still cites a user answer | `fail` (S3) | `fail` (S3) |
| P11 | no `hitl_ask`, adjudication cites no user answer | `inconclusive` | `inconclusive` |
| C1c | `input.fixedAnswer = ''` (empty string) | `pass` | `inconclusive` |

### 1.4 Differential sweep: zero loosening in 4 000 mutated inputs

`/tmp/rev/probe/sweep.ts` mutates the real record along 10 dimensions (chain text fixed/wrong/empty/
desk-only/log-only, `fixedAnswer` fixed/wrong/absent/empty, each of `ac-1…ac-4` kept/failed/missing,
child result, adjudicated criteria set, contract criteria edits incl. `mandatory` flags, terminal,
`claimsDelivery`, `artifactMatchesGoal`, artifacts, draft/unknown-label/missing adjudication):

```
sweep: 4000 mutated inputs
loosening (frozen != pass, rev2 == pass): 0
stricter  (frozen == pass, rev2 != pass): 200
```

The zero is also analytic, not just empirical: for rev2 to reach `pass` the required set must be
non-empty and every member must have a real verifier `pass` — which implies the frozen module's
`goalPasses.length > 0` too; and where the required set is empty the revision blocks the pass
(`inconclusive`). The revision's pass-set is therefore a subset of the frozen one, which is exactly
what "no loosening" means.

---

## 2. The two counterexamples are real and load-bearing — holds

### 2.1 The README commands re-run

```
$ cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
    --config /tmp/review/criteria/vitest.rev2.config.ts /tmp/review/criteria/s3-criteria-rev2.spec.ts
 ✓ .../s3-criteria-rev2.spec.ts (9 tests) 58ms
 Tests  9 passed (9)

$ cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run --config /tmp/review/criteria/vitest.rev2.config.ts
 ✓ s3-criteria-rev2.spec.ts (9 tests) 58ms
 ✓ rev2-wiring.spec.ts (1 test) 585ms
 ✓ verdict-matrix.spec.ts (4 tests) 35ms
 Test Files  3 passed (3)      Tests  14 passed (14)
```

The delivered `criteria/verdicts/*.json` reproduce exactly (identical modulo `writtenAt`/`decidedAt`
and my temp paths).

### 2.2 Red evidence is genuine — reproduced independently

I pointed the round's own spec at the **frozen module** in place of the revision (equivalent to the
claimed "byte-identical copy" state) and ran it:

```
× C1 control … × C1 … × C1b … × C2 control … × C2a … × C2b … × C2c … × C2d
✓ C2e
Test Files  1 failed (1)      Tests  8 failed | 1 passed (9)
```

Same 8 failures, same case list, same `Test Files / Tests` line as
`criteria/verdicts/c1c2-red-before-fix.txt`. The defect is real: **the frozen module passes the
wrong-answer chain** (my own C1 reproduction: `frozen: pass`, chain `complete`).

### 2.3 Green evidence is caused by the announced fix — mutant test

Two mutants of the revision were built in `/tmp` by removing exactly one fix each:

- `rev2-nofix1.ts` — the `classify` fixed-answer comparison block, the `M1.fixedAnswer` check and
  its gate entry removed;
- `rev2-nofix2.ts` — the `M3.verifierPass` ok-expression and mechanical-fail line restored to the
  frozen one-pass semantics.

```
C1  wrong answer everywhere: frozen (the defect)      pass   ✓ expected
C1  wrong answer everywhere: rev2                     fail   ✓ expected
C1  wrong answer everywhere: rev2 with Fix 1 reverted pass   ← the case goes red again
C2a ac-3 result removed: frozen (the offset)          pass   ✓
C2a ac-3 result removed: rev2                         fail   ✓
C2a ac-3 result removed: rev2 with Fix 2 reverted     pass   ← the case goes red again
C2b ac-3 flipped to fail: rev2 with Fix 2 reverted    pass
```

Causation is therefore pinned: remove the fix, the case is red again.

### 2.4 Defect found (documentation only): the README's C2b row

`criteria/README.md:111` claims C2b yields `ac-3=not-pass`. The delivered evidence says otherwise:

```
$ python3 -c "...counterexamples.json..."   # C2b cell
rev2 M3.verifierPass: required criteria: ac-1=pass, ac-2=pass, ac-3=missing, ac-4=pass;
  ... missing: ac-3; not passing: ac-3
```

The per-criterion label reads `ac-3=missing` because the label ternary checks `missingRequired`
("no passing result") first; `not-pass` is only reachable when a criterion has **both** a pass and a
non-pass result (my P9 confirms `ac-3=not-pass` there). The verdict (`fail`) and the round's own
assertion (`detail` contains `not passing`) are unaffected. Minimal fix: say `ac-3=missing (and
listed as not passing)` in the README row.

---

## 3. The replay verdicts — hold

`criteria/verdict-matrix.spec.ts` re-run in the isolated copy: 4/4 passed. The regenerated
`matrix.json` is equal to the delivered file cell-for-cell (the only differing fields are
`writtenAt`, per-cell `decidedAt`, and the two temp paths in `inputs`):

| record | adjudication | s3-criteria/1 | s3-criteria/2 |
|---|---|---|---|
| `original-s3` (349e6615…) | `original-s3.json` (7d2b91fc…) | `fail` (S1 ×5, S2) | `fail` (identical reasons) |
| `s3-run` (b8c9bb9d…) | `s3-run.json` (04ed69c4…) | `pass` / `path2-limited-goal` | `pass` / `path2-limited-goal` |
| `s3-run` | `s3-run-rejudged.json` (48af143e…) | `inconclusive`, reason `left plain unknown: quarter` | `inconclusive`, identical |

Input hashes verified against disk: records `349e6615f48bf096…` / `b8c9bb9db592266f…`, historical
session log `7b053f4067b8b830…`, adjudications `7d2b91fcbf8b7a87…` / `04ed69c40f90200c…` /
`48af143e18f1bffc…`, criteria `4ce8095ca0639242…` / `83d9ee3141c52f05…`. The rejudged cells show
`M1.chain`, `M1.accounted`, `M1.fixedAnswer`, `M3.verifierPass` all `ok` under the revision — the
blocker is the semantic side alone, as claimed.

Discovery was probed in my temp copy: a third `*.json` dropped into `/tmp/review/adjudication/` was
picked up with no edit to the spec, paired by `subject` (to `original-s3` in my probe), and the
matrix grew to 8 cells. The mechanism the README describes works.

---

## 4. The accounting recompute — holds

### 4.1 My own count, from the raw JSONL only

```
assistant/message usage objects: 15
has cacheWriteTokens key: 0
input 34518  output 16097  cacheRead 168704  total 219319
key counts: {'inputTokens': 15, 'outputTokens': 15, 'totalTokens': 15,
             'cacheReadTokens': 15, 'reasoningTokens': 15}
records where totalTokens != input+output+cacheRead: 0
cacheRead==0 records: s-root.jsonl lines 9 and 11
```

Per session: `s-root` 9 records / 24549 / 14727 / 129024; `s-b62da3c5…` 6 / 9969 / 1370 / 39680 —
identical to the ledger's `bySession`. `sg-t-s-root.jsonl` holds only `task/event` lines.

So: **15 of 15 responses carry no `cacheWriteTokens` key**, and the three real totals are exactly
input 34518 / output 16097 / cacheRead 168704. The claim `totalTokens == input + output + cacheRead`
holds on all 15. `cacheWriteTokens: 0` in the ledger is the recorder's `?? 0` fallback, not a
measurement — confirmed at the source:

```
$ grep -n cacheWriteTokens /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/r1-stack.ts
560:            cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0,
$ grep -n cacheWriteTokens .../protocols/chat-completions/translate.ts   # the protocol this run used
(no match, exit 1)
$ grep -n "cacheWriteTokens\|cache_creation_input_tokens" .../protocols/messages/translate.ts
36:  ... cache_creation_input_tokens: 'cacheWriteTokens' } as const
159:      usage.totalTokens = ... + (usage.cacheWriteTokens ?? 0)
```

The quoted originals all verify: `ledger.json` `accountingRules[1]` ("a figure the run never
reported is recorded as 'not recorded', never as 0") versus `attempts[1].usage.cacheWriteTokens: 0`;
`attemptCacheWriteTokens: 0` at the increment block; `run-meta.json:52`; `run-facts.json` totals
(15 records, cacheWrite 0); `run-console.log:14`.

### 4.2 The older round

```
total usage objects: 36 | with cacheWriteTokens: 0 | cacheRead present: 36 | cacheRead==0: 10
keys: {inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens}
per scenario: {'s1': 14, 's2': 5, 's3': 17} | files: 9
```

Matches §7 of the correction exactly. `budget.json` is `143978` / `44` with
`totalWithCacheReads 405098 = 143978 + 261120`, neither sum containing a cache-write term — so
re-reading that `0` as "not reported" moves neither lower bound, as claimed. The V6 figures
(175461 / 58 / 501349) are *restated, not recomputed*; the correction says so and the ledger's
`arithmeticCorrection` already records that the frozen §5 parenthetical (`96451`) is 200 too large
while `501349 = 405098 + 96251` stands.

### 4.3 The round's recompute script

`python3 accounting/cache-write-recompute.py` exits 0 and its output is byte-identical to the
captured `cache-write-recompute.txt` except the leading shell-prompt line:

```
$ diff /tmp/rev/recompute.out <(tail -n +2 accounting/cache-write-recompute.txt)
RECOMPUTE BODY == CAPTURED TXT MINUS PROMPT LINE (byte-identical)
```

### 4.4 Hash checks

| file | hash | expected |
|---|---|---|
| `r1-supplemental-2026-09-24/driver/s3-criteria.ts` | `4ce8095ca063924239cbadd8654284ae8a0d4b903961d1d604e4b046bdafe92c` | `4ce8095c…` ✓ |
| `evidence/s3/driver.json` | `b8c9bb9db592266f921641c84d0daaad706524cf41248b48f6a76811889c5621` | `b8c9bb9d…` ✓ |
| `evidence/ledger.json` | `20de0d8419d774dbfd795013627fb267f7818cc5ff4c862928eb897d21f38d3e` | `20de0d84…` ✓ |
| `evidence/adjudication/s3-run.json` | `04ed69c40f90200c96483b061138cf05200dd4faf3f18a684fdc3ede9d8f1b69` | `04ed69c4…` ✓ |
| `evidence/adjudication/original-s3.json` | `7d2b91fcbf8b7a87b51fdf05d81d68b001e90649aecd99d331cfbcd7b8386c36` | `7d2b91fc…` ✓ |
| `r1-evidence-2026-09-23/s3/driver.json` | `349e6615f48bf096bf3e8d09f4185ed463bfa86e4330c9493082661d800c452a` | `349e6615…` ✓ |

Re-checked **after** all my runs; unchanged. Both archive trees also match their per-file manifests
byte-for-byte (`diff` empty against `archive-r1-supplemental-2026-09-24.sha256`, 158 files, and
`archive-r1-evidence-2026-09-23.sha256`, 87 files).

### 4.5 Minor imprecision found

`V5-account-correction.md` §6 (and the JSON `missingUsage.rawSource`) call `s-root.jsonl:63` "an
inbox splice". Line 61 is the `agent/inbox/spliced` event; line 63 is a `user/message` carrying the
"batch … settled: 1 verified" notice. The substantive claim — turn 3 reached `step/start` and
produced no `assistant/message`, no `step/end`, no `turn/end` and no usage record — is correct
(verified at lines 60–63). No figure is affected.

---

## 5. The semantic re-judgment

### 5.1 Every citation resolves

Running the frozen module on the record + `adjudication/s3-run-rejudged.json`:

```
verdict inconclusive | path no allowed path: the record cannot be decided
reasons ["left plain unknown: quarter"]
 citation: RESOLVED | conditions.quarter (unknown) | rootContract.assumptions[0] carries
           "the report treats it generically as the current/final quarter"
 citation: RESOLVED | conditions.dataSource (user-confirmed) | the delivered answer of call
           chatcmpl-tool-947014ca192bbc58 carries "No data was provided; state that explicitly."
 citation: RESOLVED | conditions.deliveryScope (user-confirmed) | … carries "state that explicitly"
 citation: RESOLVED | goal (the activated goal's own field) | … carries the fixed answer
```

I checked each quoted string against the record by hand as well: `rootContract.assumptions[0]`
verbatim (`Assumption (mine): 'the quarter' has no defined date range, so the report treats it
generically as the current/final quarter.`), `assumptions[3]`, `constraints[1]`, the `ac-2`/`ac-3`
descriptions and commands, the child contract at `toolCalls[seq 6].args` (the `task_decompose` call
is indeed seq 6), the artifact text, `s-root.jsonl` lines 8 (user message), 11 (`…refers to the
current quarter (Q4 2025, or whatever)`), 20 (the `tool/result` for the call id), 23 (`…refers to the
most recent/final quarter (I'll treat it generically)` and `The human channel confirms: **no data was
provided**`), and the older round's objective/`assumptions[0]`. The artifact contains **no digit at
all** (no date, year or Q-number), so the "no period in the artifact" claim is exact. The JSON's
`criteria: [ac-1, ac-2, ac-3]` and `claimsDelivery: true` / `artifactMatchesGoal: true` are all
stated, so M3 is not left artificially unstated.

### 5.2 Is `quarter: unknown` a faithful application of §4.2?

§4.2 offers exactly three labels and provides `unknown` for a condition that is neither
user-confirmed nor explicitly retained. The re-judgment's position is: Reading A (its own) says the
clause records an absence and a generic treatment; Reading B says the same clause names a period
class the user never confirmed and S4's subject is 契约 as a whole, and S1's last sentence warns that
a quarter value does not escape by sitting in `assumptions` self-labelled. Both readings are
textually grounded — I verified the S4 wording ("契约中仍出现未经确认的季度…") and the S1 sentence in
the frozen file. The reviewer therefore declines to certify the retention, labels the condition
`unknown`, and records **no** freeze and **no** `unconfirmedContent` — i.e. it does not assert the
finding it does not hold. The outcome is `inconclusive`: not a rejection, not a pass. That is exactly
what the frozen module does with an `unknown` label, under both criteria versions.

I judge this **not** to be smuggling a rejection, and **not** a loosening:

- a rejection would require a resolved S1/S4 claim, and the file asserts none — S1/S4 read `ok`;
- a loosening would move the verdict toward `pass`; the re-judgment moves it from the archive
  adjudication's `pass` to `inconclusive`, i.e. stricter;
- `unknown` is one of §4.2's own labels, and the reviewer states plainly that its own preference is
  Reading A but that it cannot call Reading A unambiguous.

### 5.3 Where I would push back — it is a judgment, not a derivation

The frozen text does not *compel* `inconclusive`. A reviewer who reads `assumptions[0]`'s first
clause (`'the quarter' has no defined date range`) as an explicit retention citing a contract field —
which it plainly is — would label the condition `retained-unknown` and the record would `pass` by
`path1`/`path2`, as the archive's own adjudication did. The re-judgment's step from "Reading B is
available" to "the record cannot be decided" is a burden-of-proof choice (a pass requires the unknown
to be *explicitly* retained; a contested retention is not established), and it is honest about being
a choice. It is defensible, but the round should not present it as if §4.2 mechanically forced it —
the README is careful here ("that reviewer reads quarter as plain unknown (contested with
retained-unknown)"), and the re-judgment's §3/§5 record both readings and its own preference. I
accept the encoding; I would only insist that the *pass* on the archived S3 run (from the archive's
own adjudication, which both criteria versions still give) is a live disagreement, not a settled
result.

Two related notes, both pre-existing and not introduced by the rework:

- The module blocks a pass on `resolution.conditions` even when `path.limitedGoal` is true, so an
  `unknown` label always prevents a pass. That is a `s3-criteria/1` reading, unchanged by the
  revision; the re-judgment relies on it rather than introducing it.
- One provenance claim in the re-judgment is unverifiable from the artifacts: md §3 Reading B says
  "this round's instruction is explicit that assumptions are not exempt from S4". There is no such
  instruction file in the deliverable tree; I read it as a brief given to that reviewer, not as a
  frozen document. Its other grounds for Reading B are in the frozen text and I verified them. Note
  also that the archive's own adjudication had already flagged the same strict reading and set it
  aside, so Reading B is not novel.

---

## 6. Boundaries

### 6.1 No network, no paid call

Independent of the spec's own `net.Socket.prototype.connect` probe, I traced the whole replay
process tree:

```
$ cd /home/ROXY/code/bb_work/harness && strace -f -e trace=%network -o /tmp/rev/strace-net.log \
    pnpm exec vitest run --config /tmp/review/criteria/vitest.rev2.config.ts
 Test Files  3 passed (3)      Tests  14 passed (14)
$ grep -c AF_INET /tmp/rev/strace-net.log
0
$ grep -oE "[a-z_0-9]+\(" /tmp/rev/strace-net.log | sort | uniq -c
    313 recvmsg(   88 setsockopt(   33 getsockopt(   33 getsockname(
     22 socketpair(   16 shutdown(
```

No `connect`, no `sendto`/`sendmsg`, no AF_INET socket anywhere — only local IPC. The filter is
validated by a positive control (`node -e "net.connect('/tmp/definitely-not-there.sock')"` produces
the expected `connect(… AF_UNIX …)` line). With `modelAdapter: 'scripted'` the `else` branch that
constructs the production `DeepSeekAdapter` is never entered (`r1-stack.ts:512-530`). One honest
caveat, which the round itself discloses: importing `r1-stack.ts` transitively initialises
`r1-env.ts`'s `gateway` const, which reads `.dsh/api.env` and exports the key into the process
environment (`r1-env.ts:42-47`). The credential is read, never used and never sent — the trace shows
nothing leaves the process.

### 6.2 The wiring case really used the real path

`rev2-wiring.spec.ts` is a faithful copy of the archive's own positive case (same constants, same
`rootScript`/`workerScript`, same assertions (a)–(d)), plus the two-version decision and the network
probe. The stack it starts is the archive's own `r1-stack.ts`: `ctx.provide('userQuestions', …)`
routes to `answerHuman('userQuestions', …)` → the fixture desk; only `ctx.llm.registerAdapter` is
swapped for `ScriptedModelAdapter`. The spec asserts on the produced record and on the root session's
own JSONL bytes (`stack.logBytes(rootSessionId)`), and on the answer appearing in the next model
request — i.e. the real `hitl_ask` → `userQuestions` → fixed answer → session-log `tool/result` chain.
My replay produced `networkAttempts: []` and the same `pass` / `path2-limited-goal` / chains
`['complete']` under both versions.

### 6.3 Harness tree

`git status --porcelain` before and after my runs: identical, only the pre-existing
` M thirdparty/deepseek-harness` (submodule HEAD `0d1f5000…`). No tracked content changed
(`git diff` empty). The only file written under the harness tree by the test runs is vitest's own
cache (`node_modules/.vite/vitest/…/results.json`). Eight `packages/singularity/docs/*` files carry
today's mtimes (12:16–12:37) but **no content change** (`git diff --stat` empty) and those times
precede the rework round's first deliverable (12:58) and my runs (13:12+), so they are not from this
work.

### 6.4 The reviewed deliverables were not touched

All six criteria deliverable hashes re-checked after my work are identical to the README table, and
every file under `criteria/verdicts/`, `accounting/` and `adjudication/` still has its original
mtime (12:58–13:07, all before my first run at 13:12).

---

## 7. What I could not verify, and what I judge wrong

**Not verifiable from the artifacts (no defect implied):**

1. The historical claim that `s3-criteria-rev2.ts` was *at that time* a byte-identical copy of the
   frozen module during the red run. I reproduced the red outcome by substituting the frozen module
   for it (identical failure signature), which is equivalent for the claim's purpose, but the past
   file state itself cannot be inspected.
2. "Two temporary probe files were dropped into `adjudication/`, picked up the same way, and removed
   again" — no artifact remains. I reproduced the mechanism in a temp copy instead (a dropped file
   was discovered and paired by `subject` with no spec edit).
3. The V6 historical figures (`175461` / `58` / `501349`, and the first round's `31483`/`14`,
   `64768`). The round states these are restated, not recomputed, and the first round's complete
   logs are gone; I verified only their internal arithmetic and that no cache-write term enters them.
4. Whether the `current/final` gloss ever affected the work — the re-judgment lists this as
   unverifiable; I agree (the artifact has no digit and no criterion is value-dependent).
5. The `200 smoke tokens inside 143978` claim — restated, not recomputable from the surviving
   evidence.

**Judged wrong (documentation-level only, no verdict or figure changes):**

1. `criteria/README.md:111` — the C2b row says `ac-3=not-pass`; the delivered evidence and my
   reproduction say `ac-3=missing` (with `not passing: ac-3` in the trailing list). Minimal
   reproduction: run the C2b case, or read
   `criteria/verdicts/counterexamples.json` → C2b → `rev2.checks["M3.verifierPass"].detail`.
2. `accounting/V5-account-correction.md` §6 / `V5-account-correction.json:missingUsage.rawSource` —
   `s-root.jsonl:63` is described as an "inbox splice"; it is a `user/message` (the batch-settled
   notice). Line 61 is the splice. The substantive claim (no usage record for turn 3) is correct.

**Judgment call, accepted with a caveat:** the re-judgment's `quarter: unknown` encoding (§5.3). I
judge it faithful to §4.2 and honestly argued, but it is a burden-of-proof choice, not something the
frozen text mechanically compels; the archived run's `pass` under its own adjudication remains a live
disagreement rather than a settled result.

---

## 8. Bottom line

Nothing I tried falsified the round. The revision is provably minimal and provably non-loosening
(byte-identical diff reconstruction, 13/13 archive cases, 4 000-input differential sweep with zero
loosening); both counterexamples are real defects of the frozen module whose rejection by the
revision is caused by the announced fixes (mutant test); the replay verdicts reproduce exactly with
matching input hashes; the accounting correction is confirmed by an independent count of the raw
logs (15/15 responses without `cacheWriteTokens`, totals 34518 / 16097 / 168704, `totalTokens`
identity on all 15, older round 36/36); and the semantic re-judgment resolves every citation. Both
archive trees and the harness tree are byte-identical to their frozen state, and the replay makes no
network syscall at all.

The two documentation defects above should be corrected before the round is cited, and the
re-judgment's `inconclusive` should be reported as a considered reading, not as a forced outcome.
