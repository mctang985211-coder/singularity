# Environment setup reference

`reference/` is the repository's only example environment. It demonstrates protected
inputs, optional Task templates, artifact dependencies and independent verifier
selftests using a small ASCII transformation. It is also a fixture for generic
protocol integration tests. Its task names and scoring rules have no meaning to
the Singularity runtime.

The env setup agent should inspect this example and the current loader/measurement
interfaces, then create a new package in the user's chosen staging directory.
Domain-specific source, tools, evaluators, workloads, suites and their tests belong
to that package. They must not be added to `src/`, `assembly/src/`, or product specs.
Use the existing `setup-manifest.json` and approval digest to freeze the package.

Deploy a reviewed package by explicitly setting `SINGULARITY_DOMAIN` to its domain
directory. No domain is selected automatically. The reference is not a research
benchmark or a default deployment.

An environment may provide `verify.mjs` in its package root. Run it explicitly with
`pnpm verify:domain -- /path/to/environment`. It owns tool discovery and must report
unavailable tools as skips, while treating a failed available tool as a failure.
Required experiment checks must actually run before their results support a claim.
