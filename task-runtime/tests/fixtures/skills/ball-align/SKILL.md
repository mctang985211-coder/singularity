---
name: ball-align
description: Align a Buckyball Ball across ctest, BEMU, compiler, MLIR, RTL and UVM to one contract. Use when layers disagree about a Ball's semantics or when an ISA field is renamed.
---

Gold is the **ctest semantics**. BEMU, compiler, MLIR, RTL and UVM must share the same contract; a layer that
disagrees is a defect in that layer, not a second source of truth.

## Phase 0 — lock the contract (before any code)

Write down, and confirm, every item below. Stop when one is missing:

1. ISA fields and shape sources (mset / instruction)
2. Element width and the per-`iter` read/write footprint
3. The illegal-input table, identical at every layer
4. Output layout (tile / dense-pack / zero-fill)
5. Names match semantics; a rename updates ISA macros, emu, compiler, ctest and regression manifests together

## Phase 1 — change every layer in one change

No layer is left "for later". Dead fields are deleted or given one meaning immediately; addressing follows
mvin/mvout and the bank row width, never an invented stride.

## Phase 2 — prove the layers agree

Re-run the ctest and the emu/RTL pair for the touched Ball and attach both results to the task. The alignment
is done when the same inputs produce the same observable contract at every layer.
