# Illegal-input table (fail-hard)

Every layer panics or asserts on these inputs. No soft default may turn a fail into a pass.

| Input | ctest | BEMU | RTL |
|---|---|---|---|
| Bank row crossing | assert | assert | assert |
| Out-of-range element index | assert | assert | assert |
| Zero-length tile with a non-zero `iter` | assert | assert | assert |
| Misaligned base address | assert | assert | assert |

Extending this table is part of the alignment: a new illegal input is added to all layers in the same change.
