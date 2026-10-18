# Development

Use Node >=22.19 and the pnpm version pinned in package.json. Install public dependencies with
`pnpm install --frozen-lockfile`, then configure an authorized patched DSH installation with
`pnpm setup:host /path/to/dsh/node_modules/@deepseek-ai`. This validates package and artifact hashes;
it never substitutes registry packages. Local resolution files under `.singularity/` are ignored.

Run `pnpm verify`. Deterministic checks do not use model credentials. Native/model experiments are
separate, explicitly invoked checks with their environment, complete costs and raw evidence retained.

Read the current plan linked from README before changing protocol behavior. Use the existing control
log and Task/Review runtime. Add behavior tests for new integrity, isolation, recovery or statistical
boundaries. Protocol changes require a version bump and protocol-baseline.json update. Old graphs
have no compatibility promise. Do not commit credentials, sessions, generated bundles or local host paths.

A change description should state the concrete trigger and resulting behavior, checks run and any
unverified product or domain claim. Preserve upstream license and provenance notices.
