---
name: verify
description: Verify functional correctness of a Buckyball Ball. Use when a Ball must be built and simulated, when BEMU and RTL results must be compared, or when a completed Ball change needs evidence.
---

Build, simulation and test operations go through the project MCP server; the `bbdev` CLI and `nix develop` are not
the entry points. If the MCP server is not loaded, stop and report it instead of working around it.

## Phase 1 — completeness

Check the Ball's registration entry, its ISA macro, its CTest and its RTL configuration. A missing artifact is
reported as the gap it is; this skill does not create the Ball.

## Phase 2 — build and simulate

1. Build the CTests for the chip.
2. Run BEMU first and read its log; a BEMU failure is a finding, not something RTL can answer.
3. Run the Verilator RTL simulation for the same binary and config.
4. Compare both results: the Ball is verified when the same criterion passes on both sides.

## Phase 3 — evidence

Attach the BEMU log and the RTL report to the task, with the exact commands that produced them. Performance numbers
are reported separately from the pass/fail result and never replace it.
