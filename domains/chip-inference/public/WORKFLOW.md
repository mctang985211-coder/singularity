# Local inference datapath design

Deliver one reusable `accelerator.sv`: eight signed INT8 pairs per accepted beat,
with an `in_last` end marker and one INT32 wraparound result per dot. Input gaps
and output backpressure are legal. Hold output data and valid until accepted.
Only the rising edge of `clk` updates state; `rst_n` is synchronous and discards
partially accumulated work. See `inputs/baseline.sv` for the exact fixed ports.

This is one module-level dot-product PE, not a model. The workload is a
config-derived synthetic linear-projection reduction, not checkpoint execution.
The model releases contribute real hidden/intermediate dimensions; the byte
values are synthetic. INT8 accuracy for these models has not been validated.
A dot-product PE is one part of a future accelerator: SRAM, weight/activation
movement, attention, model lowering, integration, audio quality and full-model
latency remain outside this pilot. Do not call an operator measurement
end-to-end inference, a model speedup or routed silicon PPA.

## Measurement contract

For each case, with the baseline measured under the same apparatus:

```
latency_ns     = four_dot_cycles * constrained_period_ns
quality        = exp(weights.latency * ln(reference_latency_ns / latency_ns)
                   + weights.area * ln(reference_area_um2 / candidate_area_um2))
```

`quality` is positive and has no upper bound; the baseline is 1.0. Latency and
area are lower-is-better. The frozen scoring-policy.json supplies the weights (defaults 0.65 and 0.35); they sum to 1.
Power and energy have weight 0: OpenSTA's default-activity value is diagnostic
only, not workload activity. There is no rounding, clipping, saturation or
reference imputation in the calculator. The 0.5% noise floor is a separate
decision threshold; it does not change the reported score.

`correctness` and `design-integrity` are non-compensating hard guards. A failed
guard is a failure even when the weighted quality is high. Missing apparatus
evidence is unknown, not zero: a tool/library digest mismatch, missing reference
or absent timing report is reported as unknown and the trial is missed. A
design that fails compilation, arithmetic, protocol, port, latch or
STA coverage checks is a business failure with quality 0. A failed finite-RTL
check is not a proof about all inputs.

## Baseline workflow

1. Measure the supplied baseline once with the bound `chip-local-measure` Tool.
2. Read the raw cycles, period and area; compute or inspect both weighted
   contributions. Do not optimize a score you cannot explain from raw values.
3. Investigate one concrete mechanism: resource sharing, partial unrolling, a
   balanced reduction tree, pipelining or an elastic handshake. Keep the exact
   ports, synchronous reset, arbitrary legal dot lengths and wraparound.
4. Measure each candidate under identical apparatus. Retain unsuccessful results
   and negative evidence. Compare at least one genuinely different design.
5. Use independent exploratory Tasks only for genuinely separate datapath/timing
   and protocol/correctness questions. Give each a small scope, the common global
   goal, frozen interface and expected artifact; integrate a chosen measured
   result once. A focused change may stay atomic.

The Tool accepts the frozen workload and candidate paths and returns the raw
observation, ratios, weighted contributions and score as text. It recomputes the
candidate in an isolated temporary directory; do not report candidate-supplied
PPA. The public CLI equivalent is:

```
python public/evaluate.py accelerator.sv <caseId> \
  --workload inputs/workload.json --evidence local-evidence
```

Resolve the actual public directory from the frozen reference/tool source.
`--evidence` keeps local build logs; without it the temporary build is removed.
Neither route modifies the source or a Buckyball checkout. All evaluation stages
share a frozen 50-second bound, leaving cleanup time within the core process limit.

## Boundaries

Run only module-level Verilator, Yosys and OpenSTA -- one EDA job per trial, one
compiler thread. The host may schedule four independent suite trials at once;
do not run multiple EDA jobs concurrently inside one Task. Never use full-chip
Verilator, bebop-p2e, FPGA, commercial EDA or an end-to-end model flow here.
Yosys area is mapped standard-cell area without SRAM, macros, wiring, clock tree
or placement overhead. OpenSTA uses an ideal 20ns clock, 1ns I/O delays and
0.01pF output loads at SKY130 HD TT 1.8V 25C; the constrained period is
`20ns - worst setup slack`, not signoff Fmax. Report only observed results and
label these estimates as pre-layout proxies.

The independent host checks use fresh builds and protected workload bytes.
Public local tests support development and do not replace sealed acceptance.
