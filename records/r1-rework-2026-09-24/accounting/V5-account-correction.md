# V5 account correction — the cache-write column

| | |
|---|---|
| Round corrected | `r1-supplemental-2026-09-24` (its ledger, its derived views, its own console line) |
| Written in | `r1-rework-2026-09-24/accounting/` — **outside the archive** |
| Date | 2026-09-24 |
| Machine-readable twin | `accounting/V5-account-correction.json` |
| Recompute | `python3 /home/ROXY/code/bb_work/r1-rework-2026-09-24/accounting/cache-write-recompute.py` (captured verbatim in `accounting/cache-write-recompute.txt`) |
| Original entries | **not modified** — no file inside `r1-supplemental-2026-09-24/` or `r1-evidence-2026-09-23/` was created, edited or removed (see §9) |

## 1. What the original ledger said

The commit of the round's account is `r1-supplemental-2026-09-24/evidence/ledger.json`. Its
`attempts[1].usage` block (lines 111-124) reads, verbatim:

```json
      "usage": {
        "records": 15,
        "inputTokens": 34518,
        "outputTokens": 16097,
        "cacheReadTokens": 168704,
        "cacheWriteTokens": 0,
        "totalTokensReported": 219319,
        "bySession": [
          { "sessionId": "s-root", "records": 9, "inputTokens": 24549, "outputTokens": 14727, "cacheReadTokens": 129024, "cacheWriteTokens": 0 },
          { "sessionId": "s-b62da3c5-9506-4a65-81f9-441fc72de7ea", "records": 6, "inputTokens": 9969, "outputTokens": 1370, "cacheReadTokens": 39680, "cacheWriteTokens": 0 }
        ],
        "notRecorded": "one root-session model request (turn 3 step 1, the post-terminal 'batch settled' turn) produced no usage record: 10 requests reached the adapter boundary for s-root, 9 usage records exist. Its tokens are unrecorded, not zero.",
        "recorderCaveat": "r1-stack.ts stores `chunk.usage.cacheWriteTokens ?? 0`, so the 0 column means 'reported as 0 or absent'"
      },
```

The same `0` is repeated in the round's other artefacts:

- `evidence/ledger.json:191` — `"attemptCacheWriteTokens": 0` (under `thisRound.increment`)
- `evidence/s3/run-meta.json:52` — `"cacheWriteTokens": 0` (under `budget.soft.usage`)
- `evidence/run-facts.json:315-405` and `usage.totals` — `"cacheWriteTokens": 0` per record and in the total
- `evidence/run-console.log` — the run's own stdout:

  ```
  S3 attempt: root=verified toolCalls=17 usage={"inputTokens":34518,"outputTokens":16097,"cacheReadTokens":168704,"cacheWriteTokens":0} wallTimeMs=204678 clarifications=1
  ```

So the round's account states **a cache write of 0** for the S3 attempt, and prints it as a figure.

The ledger also states the rule it should have applied — `evidence/ledger.json:9`:

```json
    "a figure the run never reported is recorded as 'not recorded', never as 0",
```

The `0` column contradicts that rule. It was produced by the recorder, and the ledger itself names
the mechanism in `recorderCaveat`: `driver/r1-stack.ts:560` writes
`cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0`, which cannot tell **"the gateway reported 0"**
from **"the gateway reported nothing"**. The two cases were collapsed into one column.

## 2. What the raw evidence shows

The durable session logs of the run are the raw record: `evidence/s3/dsh-home/session-log/`
(`s-root.jsonl`, `s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl`, `sg-t-s-root.jsonl`). Each model
response is an `assistant/message` event carrying `data.usage`. Across all three logs there are
**exactly 15 such usage objects**, matching the ledger's 15 normalised records one for one
(`sg-t-s-root.jsonl` holds only `task/event` lines and carries no usage).

**Every one of the 15 has no `cacheWriteTokens` key.** Their keys are always exactly:

```
inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens
```

Example, `evidence/s3/dsh-home/session-log/s-root.jsonl:11` (turn 1 step 1):

```json
{"inputTokens":6537,"outputTokens":2499,"totalTokens":9036,"cacheReadTokens":0,"reasoningTokens":0}
```

That absence is meaningful precisely because the same format *does* carry genuine reported zeros:
`cacheReadTokens` is present on all 15 objects and its value is `0` on two of them (seq 1 and
seq 7) — real "reported as 0" cases — and `reasoningTokens` is present on all 15 with the value `0`
on all 15. A field genuinely reported as 0 appears as a key with value 0; a field never reported
does not appear at all. The cache-write column is in the second case on **15 of 15** responses.

Line references for all 15 (the same 1:1 mapping the recompute script re-derives by matching
token triples):

- `s-root.jsonl` lines [11, 18, 23, 29, 34, 39, 44, 51, 56]: turns 1 and 2 → seq 1-6, 8, 10, 11
- `s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl` lines [9, 16, 21, 26, 35, 40]: turn 1 → seq 7, 9, 12-15

A structural note, checked read-only against the adapter source this run used
(`protocol: 'chat-completions'`): `packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts`
`mapUsage` maps no cache-write field at all — the string `cacheWriteTokens` does not occur in that
file, and the function can emit only `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`
and `reasoningTokens`. The optional harness field exists and *is* filled by the other protocol,
`protocols/messages/translate.ts` (`cache_creation_input_tokens` → `cacheWriteTokens`), which this
run did not use. So on this run the `?? 0` fallback fired on every single response: the recorded
`0` is the fallback, not a measurement.

## 3. Corrected wording for the cache-write column

Wherever this round reports the cache-write figure, the column should read:

> **cacheWriteTokens: 未报告 (not reported)** — no response of this attempt reported the field.
> The `0` in the round's artefacts is the recorder's fallback
> (`driver/r1-stack.ts:560`, `chunk.usage.cacheWriteTokens ?? 0`), not a gateway figure.

and the per-session and increment lines likewise:

> `"cacheWriteTokens": "未报告 (not reported)"` (both `bySession` rows)
> `"attemptCacheWriteTokens": "未报告 (not reported)"`

This record does **not** edit `ledger.json`; it carries the replacement wording for whoever owns
the ledger. A genuine reported `0` would stay `0` — the rule is unchanged, and this correction
moves the column to 未报告 only because the evidence shows the field was never reported.

## 4. Per-response detail

| seq | session | recorded `cacheWriteTokens` | raw `cacheWriteTokens` in the durable usage object | raw source (file:line) | cacheRead | input | output |
|---|---|---|---|---|---|---|---|
| 1 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:11 (data.usage of the assistant/message; log seq 10, turn 1 step 1)` | 0 | 6537 | 2499 |
| 2 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:18 (data.usage of the assistant/message; log seq 17, turn 1 step 2)` | 6400 | 2864 | 1686 |
| 3 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:23 (data.usage of the assistant/message; log seq 22, turn 1 step 3)` | 9216 | 1757 | 7667 |
| 4 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:29 (data.usage of the assistant/message; log seq 28, turn 1 step 4)` | 10752 | 8197 | 500 |
| 5 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:34 (data.usage of the assistant/message; log seq 33, turn 1 step 5)` | 18688 | 908 | 1384 |
| 6 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:39 (data.usage of the assistant/message; log seq 38, turn 1 step 6)` | 19456 | 1805 | 329 |
| 7 | `s-b62da3c5…7ea` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl:9 (data.usage of the assistant/message; log seq 8, turn 1 step 1)` | 0 | 7109 | 180 |
| 8 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:44 (data.usage of the assistant/message; log seq 43, turn 1 step 7)` | 20992 | 876 | 322 |
| 9 | `s-b62da3c5…7ea` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl:16 (data.usage of the assistant/message; log seq 15, turn 1 step 2)` | 6912 | 983 | 217 |
| 10 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:51 (data.usage of the assistant/message; log seq 50, turn 2 step 1)` | 21504 | 818 | 203 |
| 11 | `s-root` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-root.jsonl:56 (data.usage of the assistant/message; log seq 55, turn 2 step 2)` | 22016 | 787 | 137 |
| 12 | `s-b62da3c5…7ea` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl:21 (data.usage of the assistant/message; log seq 20, turn 1 step 3)` | 7680 | 450 | 285 |
| 13 | `s-b62da3c5…7ea` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl:26 (data.usage of the assistant/message; log seq 25, turn 1 step 4)` | 7936 | 546 | 281 |
| 14 | `s-b62da3c5…7ea` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl:35 (data.usage of the assistant/message; log seq 34, turn 1 step 5)` | 8448 | 357 | 107 |
| 15 | `s-b62da3c5…7ea` | 0 | **`false`** (key absent) | `evidence/s3/dsh-home/session-log/s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl:40 (data.usage of the assistant/message; log seq 39, turn 1 step 6)` | 8704 | 524 | 300 |

Same totals the ledger states, restated per response: 15 records, input 34518, output 16097,
cacheRead 168704 — none of these three is touched by this correction.

## 5. The recomputation arithmetic

Two conventions, same 15 records:

| figure | A. as computed with `?? 0` (what the ledger states) | B. not reported (未报告) |
|---|---|---|
| records | 15 | 15 |
| inputTokens | 34518 | 34518 |
| outputTokens | 16097 | 16097 |
| cacheReadTokens | 168704 | 168704 |
| **cacheWriteTokens** | **0** | **未报告 (not reported) — not summable** |
| input + output | 50615 | 50615 |
| sum of `totalTokens` | 219319 | 219319 |

**The only column that changes is `cacheWriteTokens`.** Nothing else moves, and here is why, from
the detail: on all 15 records `totalTokens == inputTokens + outputTokens + cacheReadTokens`
(e.g. seq 2: 2864 + 1686 + 6400 = 10950, as recorded). Cache reads therefore stay in their own
column and are never folded into input/output — 50615 input+output and 168704 cacheRead are two
separate figures, and 219319 is the sum of the reported `totalTokens`. Because a cache-write number
is not an addend of any recorded total on this protocol, re-reading the column as 未报告 subtracts
nothing and inflates nothing.

**What cannot be determined, plainly:** the total cache write of the S3 attempt is
**not determinable** from the archived evidence. No response of the run reported the field, so there
is no figure and no lower or upper bound to put in its place. It is 未报告 — not 0, not a number,
and not to be added to any total. (The smoke is in the same position, for a different reason; see §6.)

To reproduce the whole thing from the script alone:

```
$ python3 /home/ROXY/code/bb_work/r1-rework-2026-09-24/accounting/cache-write-recompute.py
```

The script reads only the frozen evidence (no network, standard library only) and re-derives: the
15-row table above, both totals, the missing record, the smoke columns, the historical restatement,
the protocol check and the sha256 provenance. Its captured output is
`accounting/cache-write-recompute.txt`; it exits non-zero if any cross-check fails.

## 6. Two figures that stay 未报告 for other reasons

**Missing usage — turn 3 of the root session.** After turn 2 the runtime woke the root session for
the post-terminal "batch settled" turn: `s-root.jsonl:60` starts turn 3 and `s-root.jsonl:62` starts
step 1, and the log ends there (`:63` is the delivered `user/message` carrying the settled notice;
the inbox splices are `:59` and `:61`). No `assistant/message`, no `step/end`,
no `turn/end` follows. The adapter boundary saw 10 model requests for `s-root` against 9 usage
records (`evidence/s3/driver.json` notes[3]; `evidence/ledger.json:130` records the same as
`modelRequests.rootSession: 10`). This request's tokens stay **未报告 (missing)** — not 0 — exactly
as `evidence/ledger.json:122` already states ("Its tokens are unrecorded, not zero.").

**The smoke — both cache columns.** `evidence/smoke-1/result.json` holds only
`ok, baseUrl, keyLength, model, text, finishReason, inputTokens, outputTokens` (12 in, 409 out).
`driver/r1-smoke.ts` reads only `chunk.usage.inputTokens` and `chunk.usage.outputTokens`, so the
smoke has no cache-read and no cache-write column at all — **未报告**, not 0. This correction changes
nothing there; `evidence/ledger.json:185-186` already says "not recorded".

## 7. The historical lower bound (V6) — restated, not recomputed

The V6 figures are reproduced **exactly as they stand**; this correction neither recomputes nor
extends them. `fixtures/frozen-contract.md` §5 (line 92), verbatim:

> - 历史更正（V6）另附：已有记录至少 175461 输入/输出 token、58 次工具调用（= `budget.json` 143978/44 + `3b446cb` 记录的首轮 S1 31483/14；首轮两次冒烟 200 token 已在 143978 口径内，不重复相加）；含缓存至少 501349（= 405098 + 96451）。首轮完整日志缺失（仅残留 task-evidence 目录），为历史下界，不称精确全量。

and `evidence/ledger.json:historyCorrection` reproduces it with the round's own arithmetic note
(`arithmeticCorrection`: the cache-inclusive addend as corrected is 96251, the frozen paragraph's
parenthetical prints 96451 — the 200 smoke tokens again — and the total 501349 is unaffected either
way). So, as they stand:

- existing records ≥ **175461** input+output tokens
- existing records ≥ **58** tool calls
- including cache reads ≥ **501349** (cache-inclusive, i.e. input+output+cacheRead)

**Is the old round's cache-write column likewise "not reported"? Yes.** The surviving durable
session logs of `r1-evidence-2026-09-23/` hold **36** `assistant/message` usage objects
across nine logs (s1: 14, s2: 5, s3: 17), and **none** of them carries a `cacheWriteTokens`
key (36 of 36) — the same absence as this round, on the same
chat-completions protocol. The same objects again
show the contrast: `cacheReadTokens` is present on all 36, and its value is a genuine
reported `0` on 10 of them. `budget.json:11` states `"cacheWriteTokens": 0`, which
therefore has exactly the same collapsed meaning.

**What that does and does not change about the lower bound:**

- **Does not change it.** 175461 is the input+output lower bound and 501349 is the cache-inclusive
  figure (input+output + cacheRead). Neither sum contains a cache-write term — `budget.json`'s
  `totalWithCacheReads` 405098 = 143978 + 261120 is input+output plus cacheRead only. Re-reading the
  old cache-write `0` as "not reported" moves neither figure. The two lower bounds stand as written.
- **Does change how one cell is read, and forbids one extension.** `budget.json`'s
  `counted.cacheWriteTokens: 0` must be read as 未报告, like this round's. And because the field was
  never reported in the old round either, **no cache-write lower bound can be stated for it** — none
  is stated here, and none should be inferred later.

## 8. Provenance — every file read, with sha256

Rewritten in the same order as `V5-account-correction.json:provenance`; the recompute script
recomputes these hashes at each run.

| file | sha256 | why it was read |
|---|---|---|
| `r1-supplemental-2026-09-24/evidence/s3/driver.json` | `b8c9bb9db592266f921641c84d0daaad706524cf41248b48f6a76811889c5621` | the run's normalised usage records (the 15 rows this correction restates) |
| `r1-supplemental-2026-09-24/evidence/ledger.json` | `20de0d8419d774dbfd795013627fb267f7818cc5ff4c862928eb897d21f38d3e` | the round's ledger: the cache-write 0, the notRecorded and recorderCaveat notes, and the V6 historyCorrection |
| `r1-supplemental-2026-09-24/driver/r1-stack.ts` | `c227e843bc3de0da372ea38197e5e731b04d75a9af2460c4e547056ec6391437` | the recorder: cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0 (line 560) |
| `r1-supplemental-2026-09-24/driver/r1-s3.spec.ts` | `e099a1d49cf2b51faa27224cf5b73942eda34ad0f474096a414710f631e52773` | the spec that sums the normalised column and prints the run's own console line |
| `r1-supplemental-2026-09-24/driver/r1-smoke.ts` | `3e71b33571055a3e3bef22e59be7a57e91214a96bf5cfe513f8c404429c1d35e` | the smoke's own accounting: reads inputTokens/outputTokens only |
| `r1-supplemental-2026-09-24/fixtures/frozen-contract.md` | `1234da2fd0d5e43d9ef0eb693c617b99ed7708ab755debaa04a43dfd68b2df03` | frozen contract §5 (the V6 historical paragraph) and §5a |
| `r1-supplemental-2026-09-24/evidence/run-facts.json` | `661a4a45e12ee84efbfd64c8c754265bdedbdb58f9cabd193b66b7494b77d5d0` | the round's derived view: per-record and total cache-write 0 |
| `r1-supplemental-2026-09-24/evidence/s3/run-meta.json` | `6c9420fb7462c6616fbe174ae96f2159e723ff00b27aec856f124ec27a1be5a0` | the run's own meta: budget.soft.usage.cacheWriteTokens 0 (line 52) |
| `r1-supplemental-2026-09-24/evidence/run-console.log` | `8b18946220f4830edded3d9d78249cbe437b3a36ce5777e6c3be85a35cf914e8` | the run's stdout line, which prints usage with cacheWriteTokens 0 |
| `r1-supplemental-2026-09-24/evidence/smoke-1/result.json` | `88f18d2c9872d75a818a0bc53bb4896fd6a05e9f48b67177a1fbc2e6fd074c32` | the smoke record: inputTokens/outputTokens only, no cache column |
| `r1-evidence-2026-09-23/budget.json` | `d0ab6b0434bc5d8b148c69c9f9bc253c2c76045dadc129a84ea3a029c46c0f16` | the old round's ledger: counted.cacheWriteTokens 0 (line 11) |
| `r1-evidence-2026-09-23/s1/driver.json` | `68a45929ca91883e91bd0e38b700567c0446aa9180d9f128a62f268c97c5e88f` | the old round's normalised S1 usage records (cacheWriteTokens 0) |
| `r1-evidence-2026-09-23/s2/driver.json` | `ae9fd6e4321001ec4f644eedca9836bccee4ac6f40ee33d2ba6d49c2f9b53545` | the old round's normalised S2 usage records (cacheWriteTokens 0) |
| `r1-evidence-2026-09-23/s3/driver.json` | `349e6615f48bf096bf3e8d09f4185ed463bfa86e4330c9493082661d800c452a` | the old round's normalised S3 usage records (cacheWriteTokens 0) |
| `harness/thirdparty/deepseek-harness/packages/llm/llm-deepseek/src/protocols/chat-completions/translate.ts` | `66e8b1f96a90404d4e5ca67fc85b9e37a96bbee78ed52521e7b8fdc3f336ba32` | chat-completions mapUsage: no cache-write field exists on this protocol |
| `harness/thirdparty/deepseek-harness/packages/llm/llm-deepseek/src/protocols/messages/translate.ts` | `254f4b8fe292dadc5c24df3375b01920f5e5b345be09eae4290e91e9e810c1ba` | messages mapUsage: cache_creation_input_tokens -> cacheWriteTokens (the protocol this run did not use) |
| `r1-supplemental-2026-09-24/evidence/s3/dsh-home/session-log/s-b62da3c5-9506-4a65-81f9-441fc72de7ea.jsonl` | `d50ad4be9afac4f4ae7e47489313a93c3ef8ae0525531fbaac5e718de839698a` | durable session log: the raw assistant/message usage objects |
| `r1-supplemental-2026-09-24/evidence/s3/dsh-home/session-log/s-root.jsonl` | `51998c592a81278728ad331cdb23ceb41cca0bb347b4c26ae2dae58bd09be2b6` | durable session log: the raw assistant/message usage objects |
| `r1-supplemental-2026-09-24/evidence/s3/dsh-home/session-log/sg-t-s-root.jsonl` | `770aeba92c473c8ceaab2bf072cb454b8529077e2603cb78d19a6ac759e3cc5f` | durable session log: the raw assistant/message usage objects |
| `r1-evidence-2026-09-23/s1/dsh-home/session-log/s-59aabced-fcb3-4e22-ba85-38e673fa09e9.jsonl` | `21ad157f553fc3b555fdd123145a3f379c2cab57b1466b7200af034b91694a14` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s1/dsh-home/session-log/s-root.jsonl` | `922102ccffc896de1ba91bbc6613c4fd156b8605619948b974bdd952c90dc2a5` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s1/dsh-home/session-log/sg-t-s-root.jsonl` | `4a59a0d1d6db05c712f0540e7d99924a65b734da5506decdcc819b29d2721220` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s2/dsh-home/session-log/s-fb52f3b0-bf9b-43ac-86ec-97fd6893073c.jsonl` | `ae1a03a98418055738d936c5fd0307e7ecc8bacf408f449784fa3b14d03a8ae1` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s2/dsh-home/session-log/s-root.jsonl` | `24acd0de6b948e8fb02e2b45c42b20d9309a3424c32491eb8aa2ffc099476f57` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s2/dsh-home/session-log/sg-t-s-root.jsonl` | `cc03d9ca9f47ede1b12e1a08a8bd52f5b1199ce7d6d9425e19ecb239f96c905e` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s3/dsh-home/session-log/s-0e5b89a1-0687-43b5-b8a3-b25bcc975e03.jsonl` | `aea8e74760b6ea753258a88ebf7d28306f51c8e02e28b208b81b81d9244e4bde` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s3/dsh-home/session-log/s-root.jsonl` | `7b053f4067b8b8302487d67dbcd01ec20cd1a27d3551501d59bc91143d67efe3` | old-round durable session log: field-presence census only |
| `r1-evidence-2026-09-23/s3/dsh-home/session-log/sg-t-s-root.jsonl` | `8cdd7dae69a8dbeeb0e8881d6b4a91f0b94f8bedd3de80ba4c63314f95a7046d` | old-round durable session log: field-presence census only |

## 9. The frozen trees were not modified

- No file inside `r1-supplemental-2026-09-24/` or `r1-evidence-2026-09-23/` was created, edited,
  removed or renamed by this work; `evidence/ledger.json` is untouched, and so are the old attempts'
  `budget.json`, `driver.json` files and session logs.
- Every deliverable lives under `r1-rework-2026-09-24/accounting/`, which is outside both trees.
- Hash check: a per-file sha256 listing of both trees was captured **before any file of this recheck
  was read**, and re-captured after the deliverables were written. Comparing the two listings gives
  an empty diff for both trees.

| tree | files | manifest sha256 (byte order, LC_ALL=C) |
|---|---|---|
| `r1-supplemental-2026-09-24/` | 158 | `542789e03d2b2acb632f42660e9ca4b0b4ab71bb5f973f5b2439c029719e6f36` |
| `r1-evidence-2026-09-23/` | 87 | `efdba0cb4f0496064e6f8f37e14d828181ed094d3a70b36a37ea3f5321df0ee8` |

The listings and the method are kept beside this file: `accounting/frozen-trees-manifest.txt`,
`accounting/archive-r1-supplemental-2026-09-24.sha256`,
`accounting/archive-r1-evidence-2026-09-23.sha256`. Re-verification, reproducible in any locale:

```
cd /home/ROXY/code/bb_work/r1-supplemental-2026-09-24 && \
  LC_ALL=C find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum \
  | diff - /home/ROXY/code/bb_work/r1-rework-2026-09-24/accounting/archive-r1-supplemental-2026-09-24.sha256
```

(an empty diff means the tree still matches the frozen state).

## 10. What this means for this round's attempt

For the S3 attempt of `r1-supplemental-2026-09-24`, the corrected accounting is:

- inputTokens 34518, outputTokens 16097, cacheReadTokens 168704 — **unchanged**
- cacheReadTokens kept as its own column, never folded into input/output — **unchanged**
- one root-session request (turn 3 step 1) with no usage record — **still 未报告 (missing)**
- the smoke's cache columns — **still 未报告 (not recorded at all)**
- **cacheWriteTokens — 未报告 (not reported), not 0.** The attempt's total cache write cannot be
  determined from the evidence; the run's own artefacts printed a `0` that was never a
  measurement, and no replacement number exists or can be derived.

The attempt's verdict (`pass`, from `evidence/criteria-replay/s3-run.json` and the independent
adjudication) does not depend on the cache-write column, and no other figure of the round changes.
