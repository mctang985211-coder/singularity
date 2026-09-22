# Regression manifest rules

One manifest line per test:

| Field | Meaning |
|---|---|
| `test` | path of the test source, relative to the workload root |
| `platform` | `-baremetal` or `-toolchain`, matching the binary the runner expects |
| `expect` | `pass`, or the failure the test is kept for |
| `ball` | the Ball under test, for per-ball aggregation |

Rules that make a manifest reviewable: no entry without a file, no file without an entry, no duplicate test path,
and the entry order follows the tree so two reviewers see one order.
