# Development

Use Node >=22.19 and the pnpm version pinned in package.json. Install public dependencies with
`pnpm install --frozen-lockfile` and run `pnpm verify:core` without a private host.
For full native integration, rebuild the pinned host with
`pnpm build-private-dsh -- /path/to/new-dsh` and configure it with
`pnpm setup:host /path/to/new-dsh/installed/node_modules/@deepseek-ai`. This validates package and artifact hashes;
it never substitutes registry packages. Local resolution files under `.singularity/` are ignored.

Run `pnpm verify`. Deterministic checks do not use model credentials. Native/model experiments are
separate, explicitly invoked checks with their environment, complete costs and raw evidence retained.

Read docs/architecture.md linked from README before changing protocol behavior. Use the existing control
log and Task/Review runtime. Add behavior tests for new integrity, isolation, recovery or statistical
boundaries. Protocol changes require a version bump and protocol-baseline.json update. Old graphs
have no compatibility promise. Do not commit credentials, sessions, generated bundles or local host paths.

A change description should state the concrete trigger and resulting behavior, checks run and any
unverified product or domain claim. Preserve upstream license and provenance notices.

Protocol/decision modules cannot load DSH or assembly. `src/runtime` and
`src/control/session-store.ts` are the explicit DSH adapter seams. The package-boundaries
gate enforces the import direction. Domain adapters, workloads and toolchain tests
belong to the external environment package, never product source/specs. Use the
single `domain/reference` example when preparing an environment.

Use `pnpm lint`, `pnpm format:check` and `pnpm format` for one ESLint/Prettier policy across TS/TSX/JS/JSON/YAML.
Historical documents and frozen legacy fixture bytes are excluded from mechanical formatting.
`pnpm coverage:core` writes HTML and json-summary reports under ignored `coverage/core`; use uncovered
branches to guide review, without a coverage percentage target. Core CI uploads this report.
When formatting changes mutation anchors, preserve the intended mutant and witness; do not delete a
mutation to make formatting pass. Source and shipped third-party notices are checked by
`pnpm audit:distribution` and `pnpm audit:distribution --pack` respectively.

For formal research, follow research/README.md. Freeze outside the checkout before collecting results,
retain every scheduled observation and unknown cost, and record external freeze/manifest identities.
Never relabel engineering fixtures as study data or treat artifact verification as a fresh model run.
