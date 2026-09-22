# Ball contract checklist

One row per contract item, one column per layer. Every layer carries the same value, or the change is not done.

| Item | Where it is written |
|---|---|
| ISA fields and shape sources | ISA macro file, emu decode, compiler lowering |
| Element width, per-`iter` footprint | ctest assertions, emu functional model, RTL state machine |
| Illegal-input table | every layer's panic/assert path |
| Output layout | ctest golden output, emu result, verilator trace |
| Names | ISA macros, emu, compiler, ctest, regression manifest |

A rename that reaches four of five layers is an unfinished change, not a follow-up task.
