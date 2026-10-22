# Model-shaped local accelerator RSI

This adapter prepares a reviewable environment for the chip-inference pilot. It
reuses the 2026-10-20 setup's independently sourced model configurations and local
eight-pair INT8 dot-product task. It replaces Icarus with module-level Verilator,
uses the locally available open SKY130 HD Liberty, adds SmolLM2-360M workloads, and
binds a useful measurement Tool and design Skill to the initial Method.

```sh
node domains/chip-inference/prepare.mjs \
  --source-setup /path/to/chip-rsi-setup-20261020 \
  --output /path/to/new-setup \
  --core-checkout /path/to/singularity-core \
  --liberty /path/to/sky130hd_tt_025C_1v80.lib
```

The command refuses a nonempty destination, verifies retained source digests,
pins resolved executables/library bytes, independently measures the baseline,
and writes `domain/task.json`, a suite, `initial-method.json`, public development
tools, protected Task inputs and measurement references, and a scoring review sheet. It
does not approve itself or launch RSI. A separate ordinary env-setup session can
inspect/modify this package before the authorized reviewer freezes it.

Each of eight cases is four dot products with a real reduction dimension from
Fun-CosyVoice3-0.5B-2512, Qwen2.5-0.5B, Qwen3-0.6B or SmolLM2-360M. No model
checkpoint is downloaded. Shapes are neither parameter-count scores nor full
model benchmarks. All cases share one primitive lineage, remain evolve cases,
and cannot establish transfer or a paper-level statistical result.

The frozen score is a dimensionless weighted geometric improvement in operator
latency (0.65) and mapped standard-cell area (0.35). The baseline scores 1 and
improvements are not saturated. Correctness and design integrity are hard guards.
Raw cycles, area, constrained period, latency, both weighted log contributions and
optional default-activity power remain visible. Scored cycles come from an
always-ready four-dot sequence; separate checks cover backpressure.
Power receives zero weight. Each run uses fresh temporary output
directories and one compile thread. Parallelism belongs to the existing RSI trial
scheduler; this adapter adds no scheduler or persistent execution service.
Compilation, simulation, mapping and timing share a 50-second evaluation bound,
leaving cleanup time within the core's 60-second confined-process limit.
The public Tool and host measurement import one score calculator, and both pass
the exact protected workload JSON to the same evaluator. No private case table
can silently select a different seed or workload from the one in the Task.

Only local Verilator, Yosys and OpenSTA are used. Full-chip simulation, bebop-p2e,
commercial EDA and complete model inference are explicitly outside the task.
Area excludes SRAM, layout, clock tree and physical infrastructure. Timing uses
fixed ideal-clock/I/O/load conditions, rather than post-layout Fmax. The independent
functional oracle includes signed extremes, reset, arbitrary input gaps, output
backpressure, short/long dots, output cardinality and INT32 overflow. Finite tests
are not formal proof.
