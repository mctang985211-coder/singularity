# Goal-only RSI smoke run

The isolated service on port 3082 ran `graph3` with root session
`a1591ec7-4d65-46e2-8c36-548561a6e202`. Its input was a natural-language
Python word-frequency task and three metrics: correctness, runtime, and model
usage/cost. The empty workspace had no domain fixture. The model authored its
task contract, acceptance checks, implementation/verifier decomposition, a
TaskTemplate, and a Skill in this graph's library.

`iterationRounds: 4` means the initial execution followed by three autonomous
iterations. The saved graph reports round 4, phase `done`, with final task
verification and library review settled. All four root Runs and both child
Runs are verified; all graph agents are idle.

The root Run's frozen `frozen-oracle-delivery` Skill content digest changed
from `be799973f57252db…` on the initial execution to `93dccfa6112c0bb4…` on
each later iteration. This demonstrates consumption of the revised method.
The final supervisor retained Skill v2 and the TaskTemplate and retired
Skill v1. The root task contract has no `templateRef`: the supervisor's prose
claim of four template-bound executions is not evidence of that binding.

The run exercised library revision, review, reuse, and justified no-change
decisions. It created no formal Evolution proposal or experiment and therefore
does not establish experimental promotion or transfer to another task. Later
iterations reused completed artifacts; lower token/tool counts do not establish
a causal improvement from the Skill. Model prices were unavailable, so monetary
cost remains unknown.

Evidence is saved under `harness/.dsh-rsi-smoke-20261007/` in `launch.json`,
`graph-latest.json`, `task-latest.json`, `library-latest.json`, and
`evolution-latest.json`. No production graph was used for this run.

## Readiness check after completion

A live read confirmed the completed state. The isolated service was then
restarted on the final build: all six Run identities and verified outcomes
remained unchanged, with all ten agents idle. The one-time 22:25 Shanghai
progress check also completed without read errors.

The review found and fixed a supervisor startup defect: agent setup runs before
publication of its graph node, so initial library discovery must use its
already-published parent. Later dynamic catalog reads use the supervisor's own
published identity. A regression test reproduced the premature lookup failure
and now passes. Binding tests now read through the model's scoped Skill loader
and check that ungranted methods remain unavailable.

The full workspace build, agent-runtime TypeScript check and persistence gate
passed. The final focused suite covering the graph library, scoped catalog,
Run bindings, RSI driver and template/Skill evolution passed 139/139 tests.
The broader Singularity run recorded 2702 passed, 247 failed and 8 skipped
tests across 190 files. That run preceded the final worker-binding fixture
adjustment; it was not rerun afterward. Representative failures include older
fixtures missing context isolation, graph-list APIs, verifier services or the
root's newly available tools. Other failures include publication, recovery,
budget and coordination cases and remain untriaged. They cannot all be assumed
to be fixture problems.

The graph demonstrates a working main loop suitable for controlled complex-task
exploration. It does not establish complete architecture readiness. Before
relying on long complex runs, reconcile the broader regression failures and
measure exact template reuse, method transfer and quality/performance/cost on
fresh task inputs. Readiness evidence is saved alongside the smoke snapshots
in `readiness-summary.json`, `readiness-focused.json`, and
`readiness-failed-cases.json`.
