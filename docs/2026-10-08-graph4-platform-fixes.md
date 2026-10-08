# Graph4 platform fixes

Graph4 finished all four attempts, but its Web Evolution view showed only the
first prepared proposal while the graph ledger held four decided proposals.
The same audit found that bound Skills were not consistently loaded before
execution and that replay copied the entire large checkout and retained absolute
workspace paths.

## Result

- Scoped Evolution services resolve through their owner and shared graph cache.
  Native Web and worker integration verifies that a newly settled proposal is
  visible immediately, including nested scope resolution and cross-graph pins.
- Workers receive full frozen bound Skill bodies before the first model action.
  Delivery is recorded as a task-skills user/message source and observed by
  skillFit.loaded without fabricated tool calls. Instructions are reused from
  the visible Session surface across steps and reload, then restored after
  compaction removes their original node. The native-loop regression caught and
  prevented repeated injection on every step.
- Replay accepts optional snapshot.paths and snapshot.rebaseFrom. Selected
  inputs are copied independently with reflink where supported and hashed as
  streams. Explicit root mapping moves declared contract/protected paths and
  measurement commands into each side. Frozen original content identities and
  report/promotion checks remain in place, and resume preserves the selection
  and mapping. Aliased workspace overlap is refused before destructive cleanup.

## Validation

The workspace build passed, as did the agent-runtime typecheck, an Evolution
source typecheck, persistence fingerprints, and git diff --check. Twenty focused
test files passed, covering 220 unique cases across the relevant test batches:
157 cases in the initial focused batch, two additional native Web/history cases,
and 61 cases for replay validators, template promotion, Web routes and worker
resume. Evolution's combined source-and-tests tsconfig still encounters the
existing duplicate source/lib TaskRuntime service declaration; the isolated
source check passes.

Only the isolated service on port 3082 was restarted. The read-only comparison
before and after restart preserved graph4's 4/4 done progress, all 10 verified
Tasks, all 13 verified Runs and all 18 idle agents. Its Web API now reports all
four decided proposals: one REJECT and three KEEP_FOR_FURTHER_RESEARCH. The
experiment count remains zero. No new graph or iteration was started.

Runtime evidence:

- /home/ROXY/code/bb_work/cv-rsi-goal-only-2026-10-07/platform-fix-before-restart.json
- /home/ROXY/code/bb_work/cv-rsi-goal-only-2026-10-07/platform-fix-after-restart.json

These fixes establish delivery and replay mechanics. They do not turn graph4's
retained experience into measured formal promotion or demonstrate transfer to
unseen Tasks. Replay copies file contents unchanged; scripts and binaries with
embedded absolute paths still need task-specific adaptation. Skill loading is
observed separately from its benefit, and missing monetary pricing stays unknown.
