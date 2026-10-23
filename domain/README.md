# Environment setup reference

`reference/` is the repository's only example environment. It demonstrates protected
inputs, optional Task templates, artifact dependencies and independent verifier
selftests using a small ASCII transformation. It is also a fixture for generic
protocol integration tests. Its task names and scoring rules have no meaning to
the Singularity runtime.

The env setup agent reads the current contract/domain/suite interfaces and creates
a minimal package in the user's staging directory: task content, acceptance, scoring
and an agent-facing score tool. This template example is optional reading. Method,
Skill, TaskTemplate and standalone Task files require an explicit user request;
the host supplies an empty method seed when the domain has no templates.
Domain-specific source, tools, evaluators, workloads, suites and their tests belong
to that package. They must not be added to `src/`, `assembly/src/`, or product specs.
Use the existing `setup-manifest.json` and approval digest to freeze the package.

Deploy a reviewed package by explicitly setting `SINGULARITY_DOMAIN` to its domain
directory. No domain is selected automatically. The reference is not a research
benchmark or a default deployment.

Existing environments may provide `verify.mjs`; the builder does not generate it
by default. Run it explicitly with
`pnpm verify:domain -- /path/to/environment`. It owns tool discovery and must report
unavailable tools as skips, while treating a failed available tool as a failure.
Required experiment checks must actually run before their results support a claim.
