# dsh-singularity-evolution

Purpose: The evolution plane — the append-only proposal ledger, the two-sided
experiment that evaluates a candidate, the promotion gate, and the durable
apply/rollback commit into production (skill objects and capability rows).

Package: `@dangosys/dsh-singularity-evolution`

Dependencies: workspace `task`, `task-runtime`; peers `cordis` + `dsh-session`.

config.yaml: optional `root` (default `$DSH_HOME/evolution`), `skillRoot`
(default `$DSH_HOME/skills`), `capabilityConfig` (the deployment `config.yml`
whose `task-runtime` `capabilities:` row a capability commit writes); injected
by the assembly: `repoRoot`, `modelSelection`, `commitProbe` /
`capabilityConfigProbe` (typed test seams).

### Tools

none (the nine `evolution_*` tools are adapters in `@dangosys/dsh-singularity-agent`)

### Web APIs

none

### Service state

1. ctx.evolution: propose / candidate / prepare / gate / decide / apply /
   rollback / reconcile / openIntentTargets / openIntentCapabilities /
   experiment(s) / runExperiment / resumeExperiment /
   readSkillCandidate / readCapabilityCandidate / checkPromotion /
   checkProductionBaseline

2. ledger `<root>/proposals.jsonl` (formatVersion 4) + `<root>/sandbox/<proposalId>/`

## Design notes

**One ledger format, no migration (K3).** Every line declares `formatVersion: 4`;
the load refuses a v1/v2/v3, an unversioned or a mixed ledger by name, and every
write door refuses a record declaring anything else before a byte changes. There
is no dual-format reader and no fallback: the operator archives an older ledger
and starts a new one.

**The state machine.** proposed → candidate → prepared → gated → decided →
applied → rolledback. A candidate carries a materialized mutation; `prepared` is
the one state it admits. A prepared skill candidate gates straight from prepared:
its evaluation is the two-sided experiment, which is evidence and not a lifecycle
transition (it stays `prepared` while samples run). Only a PROMOTE on an
applyable, materialized, sub-L4 mutation can be applied, and only an applied
proposal can be rolled back.

**Commit durability (K2).** A production write is a commit: the `commit_intent`
line is durable before production changes (binding the proposal, direction, human
grant, the whole fixed file set, and the recoverable source bytes under the ledger
root); each target is then replaced atomically (same-directory staging file,
fsynced and renamed, never truncated) in the intent's own order; the completion
line closes the intent only after every file was read back and the whole object
was verified as one loadable object carrying this direction's identity.
Reconciliation settles an open intent from what production really holds — redo
when it still holds the pre-commit state, completion-only when it already holds
the committed content — and stops by name when a third party moved a file.

**Snapshot link policy.** An experiment's frozen input snapshot is walked as the
content it really names: a link that resolves inside the snapshot is followed and
materialized as real content; a link whose target escapes the snapshot root, whose
chain loops, or whose target cannot be resolved is a named refusal wherever the
tree is first read. Without this, a kept link would be a shared target a run could
write through into the production checkout the snapshot was taken from.

**Promotion evidence.** A promotion re-reads the proposal's newest completed
two-sided experiment from the ledger, recomputes the report, and checks the sides
are runs of that experiment's lineage, that frozen contracts, protected inputs,
judge versions and model selection still hold, that the verdict is `fixed`, and
that cost is known whenever the frozen budget declares a ceiling. Every condition
is a named refusal; a historical report is never upgraded into new evidence.

**Candidate scope.** Besides the same-name skill update (K3: `SKILL.md` plus the
derived `SKILL.contract.json` when the object is an execution provider), this
build admits exactly one capability candidate: one whole capability row plus an
optional new execution skill. The row and the files move in one commit, each
file's two sides may be `null` to mean "must not exist", and the capability
table's composed whole-file identity is frozen at prepare so a third party's
edit of the deployment `config.yml` is a named stop with nothing written.

**Provider pre-check.** `checkPromotion` runs the unified `validateSkillProvider`
before a human is asked, so a candidate whose verifier is unregistered or whose
required tools the deployment cannot grant is refused before an approval is
burned; the roles are reported (`renderProviderRoles`) and never persisted.

**Why the service is two files.** `EvolutionService` (lifecycle, promotion, experiment)
extends `EvolutionServiceCore` (ledger plumbing, commit host, recovery) only to stay under the 2000-line cap.

**Layout.** `types.ts` is the public vocabulary; `shared/` holds the cross-module
guards, digests, refusals and fs helpers; `ledger/` holds the state machine,
record validators and the fold; `service/` holds the service core (ledger
plumbing, durable commit host), sandbox materialization, the production-write
refusals and the soft service lookups; `replay/`, `promotion/` and `experiment/`
hold the comparer/validators, the evidence gates and the experiment itself.
`evolution.ts`, `replay.ts` and `commit.ts` keep their historical import paths
(`replay.ts` is a facade over its folder); `experiment/`, `promotion/` and the
rest are imported from their own modules.
