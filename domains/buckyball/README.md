# Buckyball restricted adapter

This directory provides a restricted text change-set verifier, a reproducible C/ISA pilot and a versioned research protocol. The pilot contains six explicitly labelled synthetic defects across DMA layout, ReLU boundaries and Gemmini composition. The original 2026-10-18 run stopped during method evaluation after DeepSeek HTTP 402. The 2026-10-19 repair run completed a measured RSI round and its independently accepted report, with no winner: one candidate increased cost without improving quality; the other lost a trial to a child contract demanding a host-only check, misclassified as infrastructure failure. The 2026-10-20 repair separates those private commands from public Task inputs and preserves delegated failure causes. See [RSI evidence](../../docs/rsi-repair-evidence.md). No domain-transfer benefit has been established.

`assembly/src/buckyball.ts` freezes the requested Git commit and every recursively pinned submodule, then exports committed objects into a fresh trial. Dirty author files and generated outputs are excluded. Missing dependencies fail explicitly. A private archive repository prevents mutable Git attributes and hooks from changing the exported baseline. Trials contain no Git metadata.

The submitted `change-set.json` has exactly three fields: `baseCommit`, `inputTreeDigest`, and `patch`. The restricted patch supports at most 32 ordinary text files and 1MiB of diff. The host rejects protected paths, traversal, renames, mode changes, binary payloads, symlink escapes and patching through symlinks. Context mismatch fails instead of searching for a similar baseline. Every trial has separate configuration, generated sources, build outputs, Cargo targets and logs.

`verifier.mjs` uses the existing sealed-submission verifier process. Its outer Bubble owns isolation, timeout, cancellation and descendant cleanup; this adapter adds no session, service, scheduler or recovery log. It creates the clean trial under the Bubble's private `/tmp`, invokes the frozen external oracle and emits the input/patch identity, commands, output and verdict. Invalid candidate patches and ordinary oracle failure are `fail`; missing tools, frozen-tool drift or an incomplete environment are `unknown` (reserved exit 4). The current 60-second verifier limit supports cheap checks; expensive RTL flows need an explicitly frozen resource policy before use.

For a real Domain, name `verifier.mjs` as the declared verifier program with `args: ["{artifact}", "{input}"]`. Keep the complete `BuckyballVerificationInput` host-only: version 1, repository path, source manifest, allowed/protected paths, external check argv and SHA256-pinned oracle/tool files. Pin executables and absolute script arguments, plus `assembly/src/buckyball.ts` and `assembly/src/ids.ts`; the wrapper itself is covered by the ordinary Domain verifier digest.

Create the protected public Task input with `buckyballTaskInput(verification)`. It contains only version, repository, source, policy and an opaque `verificationDigest`. Save the complete private manifest as canonical `JSON.stringify(verification)` bytes, without a trailing newline, at `private-oracle/manifests/<verificationDigest>.json`, beside the `domain` directory. The verifier resolves that manifest relative to its own program, verifies its byte digest and checks that its public projection exactly matches the sealed Task input. Workers receive neither check argv nor private file locations. Root delegates obligations executable with the child's declared inputs and tools; host-owned checks run on sealed submissions and must not become extra child criteria.

References needed only for evaluation belong in `task.json.verifierReferences`, outside the domain directory and outside shared `references`. Mount `private-oracle` and this checkout's `assembly/src` there for verifier selftests and submission checks only. The ordinary worker world cannot read them. Do not expose hidden oracle bodies or execution recipes through domain references or worker inputs. The generator below writes this layout and projection directly.

Before admitting a task, the author must supply known pass/fail change-sets for the ordinary verifier selftest, a reproduced problem and an independent oracle. Agent tests may supplement that oracle. A BEMU check supports emulator behavior; it does not establish RTL timing, synthesis area or full PPA. This adapter does not turn one subsystem's self-consistency into independent correctness.

Inspect a checkout without changing it:

```sh
node domains/buckyball/inspect.mjs /path/to/buckyball > /tmp/buckyball-environment.json
```

The author checkout at `c3317d2f0739f829c93a86bee145acc191898e81` has incomplete recursive dependencies and existing dirty files. `prepare-environment.py` exports a committed C/ISA source projection into an independent repository, records upstream provenance and omitted modules, then freezes generated toy configuration after successful MCP operations. The pilot projection is commit `6daecf88c741d8c1a3b898b8e49f5fdd3a35672f`. Author files remain untouched. `mcp-call.py` calls the repository's real stdio MCP server and records asynchronous traces through termination; the server resolves paths inside the projection. RISC-V GCC, host GCC, BEMU, generated ISA files and oracle inputs are SHA256-pinned in the generated manifests.

The oracle compiles each submitted kernel in a clean RISC-V trial, links a private harness, and compares full BEMU output against a separately compiled host scalar reference that never links the candidate. Seeds 17, 101 and 991 are compile-time inputs. Complete instruction traces must show the target Buckyball instructions. This proves instruction execution, not formal exclusion of CPU fallback; independent review also checks ISA use and scope. All six known-good repairs pass and all six known-bad submissions fail. Tool-pin drift returns `unknown`; a wrong-stride hypothesis is refuted at the oracle level. Worker read isolation and concurrent verifier cancellation passed. The latter refutation is not a completed model investigation Task.

Generate a pilot after preparing and finalizing its environment:

```sh
node domains/buckyball/generate-pilot.mjs \
  --repository /path/to/environment/source \
  --output /path/to/pilot \
  --core-checkout /path/to/frozen/singularity-core \
  --tools /path/to/environment/tools.json
```

The generated `domain` holds task inputs, suite and selftest samples. Only the current Task's inputs and public references reach workers; `private-oracle`, suite and known-pass samples remain verifier-only. Family/source connected components never cross splits: DMA is evolve, ReLU validation and Gemmini heldout, two cases and two trials per case. One family per split is insufficient for the frozen minimum of three; thresholds remain unchanged.

The launched pilot is `/home/ROXY/singularity-next/buckyball-pilot-20261018`, served at `http://127.0.0.1:7340`. `launch.json` records identities and evidence paths; `experiment-spec.json` freezes suite, model, search, statistical and resource rules. The read-only progress inspection at cutoff 247 is saved as `progress-check-20261018.json`: one candidate passed critic/materialization, baseline observations completed 2/4 slots and candidate observations completed 0/4 before infrastructure failure. Missing observations do not represent a zero success rate. Use `node /home/ROXY/singularity-next/buckyball-pilot-20261018/control.mjs status` to inspect or replace `status` with `cancel` to stop the Task. `host.log` contains a private launch token; do not publish it. Preflight evidence is in `private-oracle/selftest-results.json`, `private-oracle/probes/results.json` and `isolation-check.json` under that run directory.

This environment supports C/ISA+BEMU functionality. It does not reproduce all upstream dependencies, MLIR, RTL timing, synthesis or PPA. Broad toy CTest still needs missing generated AlexNet `conv.c`; the six pilot kernels are independently rebuilt and tested. Formal transfer requires more independent families, frozen unseen comparison and completed bounded-search evidence. [protocol.json](protocol.json) records inclusion, grouping, failure accounting and stopping rules; [research.md](research.md) positions hypotheses against eleven primary-source papers without making a novelty claim.
