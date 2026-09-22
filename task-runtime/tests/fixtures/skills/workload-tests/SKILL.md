---
name: workload-tests
description: Design, add or reorganize Buckyball workload tests and their regression manifests. Use when a Ball, core or chip test is added, moved or retired, or when a regression manifest must match the tree.
---

A workload test is only useful when its manifest entry, its platform names and its expected result agree with the
tree it lives in.

## Where tests live

- Ball-level CTests under `bb-tests/`, one test per behavior, named after the behavior and not after the ball.
- Chip-level tests under the chip's own workload directory, listed by the chip's regression manifest.
- BEMU and RTL share the binary; the platform suffix picks the runner (`-baremetal`, `-toolchain`).

## Manifest rules

1. Every test file appears in exactly one manifest, with its platform and its expected result.
2. A retired test's entry is removed in the same change that removes the file.
3. A renamed test keeps no alias: manifests name the current path only.
4. Manifest order follows tree order, so two trees produce two identical manifests only when they hold the same tests.

## Evidence

Attach the manifest you changed and the run that exercised it. A green run over a manifest that does not list the
new test proves nothing about that test.
