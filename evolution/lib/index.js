import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SKILL_SIDECAR_FILE, capabilityToolQuery, loadSkillSidecar, optionalService, readVerifiedFile, registeredVerifierIds, registeredVerifierVocabulary, registryRevision, serializeSkillSidecar, sidecarWithSkillMd, skillContentDigest, skillContractDigest, unlistableVerifierRefusal, validateSkillProvider, walkVerified } from "@dangosys/dsh-singularity-task-runtime";
import { createHash, randomBytes } from "node:crypto";
import { rootTaskStoreId } from "@dangosys/dsh-singularity-task";

//#region src/replay.ts
/** verified outranks failed; anything else (cancelled) has no rank and reads inconclusive. */
const OUTCOME_RANK = {
	verified: 1,
	failed: 0
};
/**
* Compare one task's two sides. A regression is mechanical: the candidate's
* outcome ranks below the champion's, or a criterion both sides report flipped
* from pass to anything else. An unrankable candidate outcome (cancelled) is
* inconclusive — it says nothing about the candidate's quality. The v2 comparer
* ({@link compareExperimentSides}) reads exactly this answer off one sample's
* two sides.
*/
function compareReplaySides(champion, candidate) {
	const championCriteria = new Map(champion.criteria.map((item) => [item.criterionId, item.verdict]));
	const candidateCriteria = new Map(candidate.criteria.map((item) => [item.criterionId, item.verdict]));
	const criteriaDiff = [];
	for (const criterionId of new Set([...championCriteria.keys(), ...candidateCriteria.keys()])) {
		const before = championCriteria.get(criterionId);
		const after = candidateCriteria.get(criterionId);
		if (before !== after) criteriaDiff.push({
			criterionId,
			...before === void 0 ? {} : { champion: before },
			...after === void 0 ? {} : { candidate: after }
		});
	}
	const verdictMatch = champion.outcome === candidate.outcome && criteriaDiff.length === 0;
	const championRank = OUTCOME_RANK[champion.outcome];
	const candidateRank = OUTCOME_RANK[candidate.outcome];
	if (candidateRank === void 0 || championRank === void 0) return {
		verdictMatch,
		criteriaDiff,
		relation: "inconclusive"
	};
	const regressedCriterion = criteriaDiff.some((diff) => diff.champion === "pass");
	const changedContract = criteriaDiff.some((diff) => diff.champion === void 0 || diff.candidate === void 0) || champion.criteria.some((before) => candidate.criteria.find((after) => after.criterionId === before.criterionId)?.command !== before.command);
	return {
		verdictMatch,
		criteriaDiff,
		relation: candidateRank < championRank || regressedCriterion ? "worse" : changedContract ? "inconclusive" : "not-worse"
	};
}
/**
* The comparer a report names, and the only one this build can re-check:
* the verdict rules of {@link compareExperimentSides} and
* {@link overallExperimentVerdict}. A report naming anything else is refused by
* {@link assertExperimentReport} instead of being re-derived with rules this
* build does not have.
*/
const EXPERIMENT_COMPARER_VERSION = "experiment-comparer@2";
const EXPERIMENT_SAMPLE_ROLES = [
	"observed-failure",
	"observed-regression",
	"holdout"
];
const EXPERIMENT_SIDES = ["baseline", "candidate"];
const EXPERIMENT_OUTCOMES = [
	"verified",
	"failed",
	"cancelled",
	"interrupted"
];
const EXPERIMENT_SAMPLE_VERDICTS = [
	"fixed",
	"both-failed",
	"not-fixed",
	"maintained",
	"regressed",
	"inconclusive"
];
const EXPERIMENT_VERDICTS = [
	"fixed",
	"fixed-with-regression",
	"not-fixed",
	"both-failed",
	"regressed",
	"inconclusive"
];
/**
* Read one selection as the structured identity, or `undefined` when it names
* no route. A selection without a provider or without a model is not a
* structured selection — a caller that cannot produce one is refused rather
* than given a placeholder (`provider` empty means the request would be routed
* by adapter defaults nobody froze).
*/
function modelSelectionOf(selection) {
	const provider = typeof selection?.provider === "string" && selection.provider.length > 0 ? selection.provider : void 0;
	const model = typeof selection?.model === "string" && selection.model.length > 0 ? selection.model : void 0;
	if (provider === void 0 || model === void 0) return void 0;
	const reasoningEffort = typeof selection?.reasoningEffort === "string" && selection.reasoningEffort.length > 0 ? selection.reasoningEffort : void 0;
	const maxTokens = typeof selection?.maxTokens === "number" && Number.isFinite(selection.maxTokens) && selection.maxTokens > 0 ? selection.maxTokens : void 0;
	return {
		provider,
		model,
		...reasoningEffort === void 0 ? {} : { reasoningEffort },
		...maxTokens === void 0 ? {} : { maxTokens },
		label: `${provider}/${model}`
	};
}
/** The `AgentOptions` a frozen selection travels as: the four members, verbatim, with no label. */
function agentOptionsOf(selection) {
	return {
		provider: selection.provider,
		model: selection.model,
		...selection.reasoningEffort === void 0 ? {} : { reasoningEffort: selection.reasoningEffort },
		...selection.maxTokens === void 0 ? {} : { maxTokens: selection.maxTokens }
	};
}
/**
* JSON with object keys sorted recursively — the one serialization every digest
* in this schema is taken over. `undefined` members are dropped, so a digest is
* the same whether an absent optional member was omitted or written as
* `undefined`, and the digest of a value never depends on key insertion order.
*/
function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
/** Lowercase SHA-256 hex over {@link canonicalJson} of a value — the frozen-block digest primitive. */
function digestOf(value) {
	return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
/** The digest of a whole frozen identity block; a report and its ledger record agree only when these agree. */
function frozenDigestOf(frozen) {
	return digestOf(frozen);
}
/** SHA-256 over a criterion's protected input identities, in path order — the acceptance input identity of one criterion. */
function protectedInputsDigest(inputs) {
	const lines = inputs.map((input) => `${input.path}\0${input.sha256}`).sort();
	return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
/** One side as the v1 comparer reads it: the same outcome rank and criterion semantics, so v1's rules stay the rules. */
function asReplaySide(side) {
	return {
		taskId: "",
		outcome: side.outcome === "interrupted" ? "cancelled" : side.outcome,
		criteria: side.criteria.map((criterion) => ({
			criterionId: criterion.criterionId,
			verdict: criterion.verdict,
			...criterion.command === void 0 ? {} : { command: criterion.command },
			...criterion.exitCode === void 0 ? {} : { exitCode: criterion.exitCode }
		}))
	};
}
/**
* One sample's mechanical verdict. An unrankable side (cancelled / interrupted)
* and a comparison whose two contracts differ (a criterion added, removed or
* re-commanded) are both `inconclusive` — the v1 semantics, unchanged. A role of
* `observed-failure` asks whether the target failure was reproduced and then
* fixed. A regression or holdout sample stands for a historical success that
* must still hold: its own baseline must be `verified` for the sample to be
* comparable at all — a baseline that did not pass reproduced nothing, so the
* sample is `inconclusive` whatever the candidate did — and only then does the
* candidate's relation answer `regressed` or `maintained`.
*/
function compareExperimentSides(role, baseline, candidate) {
	const relation = compareReplaySides(asReplaySide(baseline), asReplaySide(candidate)).relation;
	if (relation === "inconclusive") return "inconclusive";
	const baselineRank = OUTCOME_RANK[baseline.outcome];
	const candidateRank = OUTCOME_RANK[candidate.outcome];
	if (role === "observed-failure") {
		if (baselineRank === 0 && candidateRank === 0) return "both-failed";
		return baselineRank === 0 && candidateRank === 1 ? "fixed" : "not-fixed";
	}
	if (baselineRank !== 1) return "inconclusive";
	return relation === "worse" ? "regressed" : "maintained";
}
/**
* The overall verdict over every sample, from the sample verdicts alone: any
* evidence that could not settle makes the whole experiment inconclusive; a
* reproduced-and-unfixed failure is `both-failed`; an unfixed target failure
* with a degraded regression/holdout sample is `regressed`; an unfixed target
* with nothing worse is `not-fixed`; a fixed target with a degraded sample is
* `fixed-with-regression`; and a fixed target with nothing worse is `fixed`.
* The six are distinguishable by construction, and a report whose `verdict` is
* not this value is refused.
*/
function overallExperimentVerdict(samples) {
	if (samples.some((sample) => sample.verdict === "inconclusive")) return "inconclusive";
	if (samples.some((sample) => sample.verdict === "both-failed")) return "both-failed";
	const failures = samples.filter((sample) => sample.role === "observed-failure");
	const fixedAll = failures.length > 0 && failures.every((sample) => sample.verdict === "fixed");
	const regressedAny = samples.some((sample) => sample.verdict === "regressed");
	if (!fixedAll) return regressedAny ? "regressed" : "not-fixed";
	return regressedAny ? "fixed-with-regression" : "fixed";
}
const EXPERIMENT_OUTCOME_SET = new Set(EXPERIMENT_OUTCOMES);
const EXPERIMENT_CONDITION_VERDICTS = [
	"pass",
	"fail",
	"inconclusive"
];
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHex64$1(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function assertIdentity(value, field) {
	if (!isRecord$1(value) || typeof value.name !== "string" || value.name.length === 0 || !isHex64$1(value.sha256)) throw new Error(`evolution: experiment report ${field} must be a content identity { name, sha256, contract? }`);
	if (value.contract !== void 0) {
		const contract = value.contract;
		if (!isRecord$1(contract) || !isHex64$1(contract.sha256) || !isHex64$1(contract.contractDigest)) throw new Error(`evolution: experiment report ${field}.contract must be { sha256, contractDigest } with both a SHA-256 hex — a frozen object with an execution sidecar names that file by its exact bytes and by the canonical declaration identity together`);
	}
}
/**
* Validate a frozen identity block: every member present and shaped, the
* comparison rules named, and §F.2's two non-empty groups (at least one
* observed failure, at least one holdout) enforced — a block missing either is
* not a two-sided experiment whatever it is called. Used by the report
* assertion and by the ledger fold, so a hand-written record fails the same
* checks a live run's record passes.
*/
function assertFrozenExperiment(value) {
	if (!isRecord$1(value)) throw new Error("evolution: experiment report frozen must be an object");
	if (typeof value.proposalId !== "string" || value.proposalId.length === 0) throw new Error("evolution: experiment report frozen.proposalId must be a non-empty string");
	if (!Number.isInteger(value.repetition) || value.repetition < 0) throw new Error("evolution: experiment report frozen.repetition must be a non-negative integer");
	assertIdentity(value.candidate, "frozen.candidate");
	if (value.productionBaseline !== void 0) assertIdentity(value.productionBaseline, "frozen.productionBaseline");
	assertModelSelection(value.model, "frozen.model");
	assertExperimentBudget(value.budget, "frozen.budget");
	if (!isRecord$1(value.snapshot) || typeof value.snapshot.sourceDir !== "string" || value.snapshot.sourceDir.length === 0 || !isHex64$1(value.snapshot.digest)) throw new Error("evolution: experiment report frozen.snapshot must be { sourceDir, digest } with a SHA-256 content digest");
	if (value.comparerVersion !== EXPERIMENT_COMPARER_VERSION) throw new Error(`evolution: experiment report frozen.comparerVersion must be "${EXPERIMENT_COMPARER_VERSION}" — got ${JSON.stringify(value.comparerVersion)}; a report this build cannot re-derive is refused, not trusted`);
	if (!isRecord$1(value.overlay) || typeof value.overlay.baseline !== "string" || value.overlay.baseline.length === 0 || typeof value.overlay.candidate !== "string" || value.overlay.candidate.length === 0) throw new Error("evolution: experiment report frozen.overlay must name what each side ran under");
	if (!Array.isArray(value.samples) || value.samples.length === 0) throw new Error("evolution: experiment report frozen.samples must be a non-empty array");
	const taskIds = /* @__PURE__ */ new Set();
	value.samples.forEach((sample, index) => assertFrozenSample(sample, `frozen.samples[${index}]`, taskIds));
	const roles = value.samples.map((sample) => sample.role);
	if (!roles.includes("observed-failure")) throw new Error("evolution: an experiment frozen block needs at least one observed-failure sample (§F.2: the target failure must be reproduced)");
	if (!roles.includes("holdout")) throw new Error("evolution: an experiment frozen block needs at least one holdout sample (§F.2: the candidate must not be selected on every case)");
}
function assertExperimentBudget(value, field) {
	if (!isRecord$1(value)) throw new Error(`evolution: ${field} must be an object (the whole experiment's token ceiling)`);
	for (const key of Object.keys(value)) {
		if (key === "wallTimeMs") throw new Error(`evolution: ${field}.wallTimeMs is removed — an experiment has no wall-clock ceiling; freeze an optional \`maxTokens\` total instead, and bound a run's time with the deployment's own limits (rootBudget.wallTimeMs, or the per-run Config.budget.wallTimeMs). A budget this build cannot enforce is refused rather than ignored`);
		if (key !== "maxTokens" && key !== "note") throw new Error(`evolution: ${field} has unknown key "${key}"`);
	}
	const member = value.maxTokens;
	if (member !== void 0 && (typeof member !== "number" || !Number.isFinite(member) || member < 0)) throw new Error(`evolution: ${field}.maxTokens must be a non-negative number`);
	if (value.note !== void 0 && (typeof value.note !== "string" || value.note.length === 0)) throw new Error(`evolution: ${field}.note must be a non-empty string`);
}
function assertModelSelection(value, field) {
	if (!isRecord$1(value)) throw new Error(`evolution: experiment report ${field} must be the structured model selection { provider, model } this build froze — a record that froze a bare string cannot name the route its runs took, so it is refused rather than read as one`);
	for (const key of Object.keys(value)) if (![
		"provider",
		"model",
		"reasoningEffort",
		"maxTokens",
		"label"
	].includes(key)) throw new Error(`evolution: experiment report ${field} has unknown key "${key}"`);
	if (typeof value.provider !== "string" || value.provider.length === 0) throw new Error(`evolution: experiment report ${field}.provider must be the provider route the runs go through`);
	if (typeof value.model !== "string" || value.model.length === 0) throw new Error(`evolution: experiment report ${field}.model must be the model id the runs go through`);
	if (value.reasoningEffort !== void 0 && (typeof value.reasoningEffort !== "string" || value.reasoningEffort.length === 0)) throw new Error(`evolution: experiment report ${field}.reasoningEffort must be a non-empty string when present`);
	if (value.maxTokens !== void 0 && (typeof value.maxTokens !== "number" || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0)) throw new Error(`evolution: experiment report ${field}.maxTokens must be a positive number when present`);
	if (value.label !== `${value.provider}/${value.model}`) throw new Error(`evolution: experiment report ${field}.label must be the derived display form "${value.provider}/${value.model}" — the label is a rendering of the structured members, never an identity of its own`);
}
function assertFrozenProviderSkill(value, field) {
	if (!isRecord$1(value) || typeof value.name !== "string" || value.name.length === 0 || ![
		"execution-provider",
		"knowledge",
		"guidance"
	].includes(value.role) || value.contractDigest !== null && !isHex64$1(value.contractDigest) || !isHex64$1(value.contentDigest)) throw new Error(`evolution: experiment report ${field} must be a resolved skill identity { name, role, contractDigest, contentDigest }`);
}
function assertFrozenProviderIdentity(value, field) {
	if (!isRecord$1(value)) throw new Error(`evolution: experiment report ${field} must be the frozen provider identity of the sample's production baseline (capabilities, registryRevision, mcpServers, preset, skills) — a sample frozen before that identity was recorded cannot constrain what its sides really ran against`);
	if (!Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`evolution: experiment report ${field}.capabilities must be an array of capability names`);
	if (typeof value.registryRevision !== "string" || value.registryRevision.length === 0) throw new Error(`evolution: experiment report ${field}.registryRevision must be the revision the runtime's pre-check produced`);
	if (typeof value.candidateRegistryRevision !== "string" || value.candidateRegistryRevision.length === 0) throw new Error(`evolution: experiment report ${field}.candidateRegistryRevision must be the revision the candidate side's run has to bind — the production revision over the same rows with the improved skill's own declaration digest substituted; a block that records only the production value cannot say what the candidate side was compared against`);
	if (!Array.isArray(value.mcpServers) || value.mcpServers.some((item) => typeof item !== "string" || item.length === 0)) throw new Error(`evolution: experiment report ${field}.mcpServers must be an array of MCP server names`);
	if (value.preset !== null && (typeof value.preset !== "string" || value.preset.length === 0)) throw new Error(`evolution: experiment report ${field}.preset must be the declared preset or null (the deployment default governs)`);
	if (!Array.isArray(value.skills)) throw new Error(`evolution: experiment report ${field}.skills must be an array`);
	const names = /* @__PURE__ */ new Set();
	for (const skill of value.skills) {
		assertFrozenProviderSkill(skill, `${field}.skills[${skill.name}]`);
		if (names.has(skill.name)) throw new Error(`evolution: experiment report ${field} repeats skill "${skill.name}"`);
		names.add(skill.name);
	}
}
function assertFrozenSample(value, field, seen) {
	if (!isRecord$1(value) || typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: experiment report ${field} must carry a taskId`);
	if (seen.has(value.taskId)) throw new Error(`evolution: experiment report ${field} repeats task "${value.taskId}"`);
	seen.add(value.taskId);
	if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role)) throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(" / ")}`);
	if (!isHex64$1(value.contractDigest)) throw new Error(`evolution: experiment report ${field}.contractDigest must be a SHA-256 hex`);
	if (!Array.isArray(value.criteria) || value.criteria.length === 0) throw new Error(`evolution: experiment report ${field}.criteria must be a non-empty array (the acceptance the replay mirrors)`);
	const criterionIds = /* @__PURE__ */ new Set();
	for (const criterion of value.criteria) {
		if (!isRecord$1(criterion) || typeof criterion.criterionId !== "string" || criterion.criterionId.length === 0 || criterionIds.has(criterion.criterionId) || typeof criterion.verificationMode !== "string" || criterion.verificationMode.length === 0 || criterion.command !== void 0 && typeof criterion.command !== "string" || !isHex64$1(criterion.protectedInputsDigest)) throw new Error(`evolution: experiment report ${field} has an invalid or duplicate frozen criterion`);
		if (typeof criterion.verifierRef !== "string" || criterion.verifierRef.length === 0) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must pin the judge it was frozen with — a criterion whose judge nobody can name cannot be recalled against the instance that decides it`);
		if (typeof criterion.verifierVersion !== "string" || criterion.verifierVersion.length === 0) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must carry the version of the pinned judge it was frozen with — a verdict belongs to the instance that judged it`);
		if (typeof criterion.verifierAnchor !== "string" || criterion.verifierAnchor.length === 0) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must name how its judge identity is anchored`);
		criterionIds.add(criterion.criterionId);
	}
	if (!isRecord$1(value.observed) || value.observed.outcome !== "verified" && value.observed.outcome !== "failed" || value.observed.runId !== void 0 && (typeof value.observed.runId !== "string" || value.observed.runId.length === 0)) throw new Error(`evolution: experiment report ${field}.observed must record the historical outcome (and run, when known) the sample was chosen for`);
	assertFrozenProviderIdentity(value.provider, `${field}.provider`);
}
function assertCriterionDetail(value, field) {
	if (!isRecord$1(value) || typeof value.criterionId !== "string" || value.criterionId.length === 0 || !EXPERIMENT_CONDITION_VERDICTS.includes(value.verdict) || value.verifierId !== void 0 && (typeof value.verifierId !== "string" || value.verifierId.length === 0) || value.verifierVersion !== void 0 && (typeof value.verifierVersion !== "string" || value.verifierVersion.length === 0) || value.command !== void 0 && typeof value.command !== "string" || value.exitCode !== void 0 && typeof value.exitCode !== "number") throw new Error(`evolution: experiment report ${field} has an invalid criterion verdict`);
}
function assertCost(value, field) {
	if (!isRecord$1(value)) throw new Error(`evolution: experiment report ${field} must be a cost object`);
	if (value.status === "unknown") {
		if (typeof value.reason !== "string" || value.reason.length === 0) throw new Error(`evolution: experiment report ${field} must say why the cost is unknown`);
		return;
	}
	if (value.status !== "reported" || !isRecord$1(value.metrics)) throw new Error(`evolution: experiment report ${field} must be { status: "reported", metrics } or { status: "unknown", reason }`);
}
function assertSideDetail(value, field, sampleTaskId, observedRunId) {
	if (!isRecord$1(value)) throw new Error(`evolution: experiment report ${field} must be an object`);
	if (value.taskId !== void 0 && (typeof value.taskId !== "string" || value.taskId.length === 0)) throw new Error(`evolution: experiment report ${field}.taskId must be a non-empty string when present`);
	if (value.taskId === sampleTaskId) throw new Error(`evolution: experiment report ${field} names the sample's own historical task "${sampleTaskId}" as a run of this experiment — the historical task is the case, not a baseline; both sides must be new replayed tasks`);
	if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role)) throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(" / ")}`);
	if (!EXPERIMENT_SIDES.includes(value.side)) throw new Error(`evolution: experiment report ${field}.side must be one of ${EXPERIMENT_SIDES.join(" / ")}`);
	if (!EXPERIMENT_OUTCOME_SET.has(value.outcome)) throw new Error(`evolution: experiment report ${field}.outcome must be one of ${EXPERIMENT_OUTCOMES.join(" / ")}`);
	for (const key of ["runId", "reviewRef"]) {
		const member = value[key];
		if (member !== void 0 && (typeof member !== "string" || member.length === 0)) throw new Error(`evolution: experiment report ${field}.${key} must be a non-empty string when present`);
	}
	if (observedRunId !== void 0 && value.runId === observedRunId) throw new Error(`evolution: experiment report ${field} cites run "${observedRunId}", the sample's own historical run — the historical champion locates the case and is never this experiment's baseline; both sides must be new runs`);
	if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)) throw new Error(`evolution: experiment report ${field}.evidenceRefs must be an array of non-empty evidence ids`);
	if (typeof value.workspace !== "string" || value.workspace.length === 0) throw new Error(`evolution: experiment report ${field}.workspace must be the directory the run went through`);
	if (value.initialDigest !== void 0 && !isHex64$1(value.initialDigest)) throw new Error(`evolution: experiment report ${field}.initialDigest must be the SHA-256 of the frozen workspace content`);
	if (!Array.isArray(value.criteria)) throw new Error(`evolution: experiment report ${field}.criteria must be an array`);
	const ids = /* @__PURE__ */ new Set();
	for (const criterion of value.criteria) {
		assertCriterionDetail(criterion, `${field}.criteria[${criterion.criterionId}]`);
		if (ids.has(criterion.criterionId)) throw new Error(`evolution: experiment report ${field} has a duplicate criterion`);
		ids.add(criterion.criterionId);
	}
	assertCost(value.cost, `${field}.cost`);
	if (value.outcome === "interrupted") {
		if (typeof value.reason !== "string" || value.reason.length === 0) throw new Error(`evolution: experiment report ${field} is interrupted and must carry the reason it has no terminal run`);
		return;
	}
	if (typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: experiment report ${field} settled a run and must name the replayed task it created`);
	if (value.initialDigest === void 0) throw new Error(`evolution: experiment report ${field} settled a run and must carry the workspace's initial digest`);
	if (value.outcome === "verified" && ids.size === 0) throw new Error(`evolution: experiment report ${field} verified outcome needs criterion evidence`);
}
/**
* Validate a v3 report against itself — and further than a shape check: every
* verdict the report carries must equal the one its own details recompute
* (`compareExperimentSides` per sample,
* `overallExperimentVerdict` overall), and the frozen block must hash to the
* `frozenDigest` the report names. A report whose judgement and evidence
* disagree is refused rather than read.
*
* The one thing this schema cannot check is where a side's run came from: a
* forged report could name any task and run. It closes the forgery that matters
* — a side citing the sample's *historical* run (or its historical task) as its
* own — from the frozen block alone, and the service that owns the ledger
* closes the rest by checking each recorded run against the store record the
* experiment's own lineage names.
*/
function assertExperimentReport(report) {
	if (!isRecord$1(report)) throw new Error("evolution: experiment report must be an object");
	if (report.formatVersion !== 3) throw new Error(`evolution: experiment report formatVersion must be 3 — got ${JSON.stringify(report.formatVersion)}; this build writes and reads one report schema, the one whose frozen block carries the improved skill's complete content identity and both sides' provider identities, and a report from another build is refused by name rather than read with fields it does not have`);
	if (typeof report.proposalId !== "string" || report.proposalId.length === 0) throw new Error("evolution: experiment report.proposalId must be a non-empty string");
	if (typeof report.experimentId !== "string" || report.experimentId.length === 0) throw new Error("evolution: experiment report.experimentId must be a non-empty string");
	if (typeof report.at !== "string" || report.at.length === 0) throw new Error("evolution: experiment report.at must be a non-empty string");
	assertFrozenExperiment(report.frozen);
	const frozen = report.frozen;
	if (frozen.proposalId !== report.proposalId) throw new Error(`evolution: experiment report frozen.proposalId "${frozen.proposalId}" does not match "${report.proposalId}"`);
	if (report.frozenDigest !== frozenDigestOf(frozen)) throw new Error("evolution: experiment report frozenDigest does not match its frozen identity block");
	if (!Array.isArray(report.samples)) throw new Error("evolution: experiment report.samples must be an array");
	const reportSamples = report.samples;
	const byTask = new Map(frozen.samples.map((sample) => [sample.taskId, sample]));
	if (reportSamples.length !== frozen.samples.length) throw new Error("evolution: experiment report must carry exactly one comparison per frozen sample");
	const seen = /* @__PURE__ */ new Set();
	reportSamples.forEach((entry, index) => {
		const field = `samples[${index}]`;
		if (!isRecord$1(entry)) throw new Error(`evolution: experiment report ${field} must be an object`);
		const taskId = entry.taskId;
		const frozenSample = typeof taskId === "string" ? byTask.get(taskId) : void 0;
		if (frozenSample === void 0) throw new Error(`evolution: experiment report ${field}.taskId is not one of the frozen samples`);
		if (seen.has(frozenSample.taskId)) throw new Error(`evolution: experiment report ${field} repeats sample "${frozenSample.taskId}"`);
		seen.add(frozenSample.taskId);
		if (entry.role !== frozenSample.role) throw new Error(`evolution: experiment report ${field}.role does not match the frozen sample's role`);
		if (!EXPERIMENT_SAMPLE_VERDICTS.includes(entry.verdict)) throw new Error(`evolution: experiment report ${field}.verdict must be one of ${EXPERIMENT_SAMPLE_VERDICTS.join(" / ")}`);
		assertSideDetail(entry.baseline, `${field}.baseline`, frozenSample.taskId, frozenSample.observed.runId);
		assertSideDetail(entry.candidate, `${field}.candidate`, frozenSample.taskId, frozenSample.observed.runId);
		const baseline = entry.baseline;
		const candidate = entry.candidate;
		if (baseline.side !== "baseline" || candidate.side !== "candidate") throw new Error(`evolution: experiment report ${field} must carry one baseline and one candidate side`);
		if (baseline.role !== frozenSample.role || candidate.role !== frozenSample.role) throw new Error(`evolution: experiment report ${field} sides must carry the sample's role`);
		if (baseline.workspace === candidate.workspace) throw new Error(`evolution: experiment report ${field} sides share one workspace "${baseline.workspace}" — two sides need two workspaces`);
		const computed = compareExperimentSides(frozenSample.role, baseline, candidate);
		if (entry.verdict !== computed) throw new Error(`evolution: experiment report ${field}.verdict "${String(entry.verdict)}" does not match its own evidence ("${computed}")`);
	});
	const computedVerdict = overallExperimentVerdict(reportSamples);
	if (report.verdict !== computedVerdict) throw new Error(`evolution: experiment report.verdict "${String(report.verdict)}" does not match its samples ("${computedVerdict}")`);
	if (!EXPERIMENT_VERDICTS.includes(report.verdict)) throw new Error(`evolution: experiment report.verdict must be one of ${EXPERIMENT_VERDICTS.join(" / ")}`);
}

//#endregion
//#region src/commit.ts
/** Lowercase SHA-256 hex over exact bytes — the content identity primitive the commit path reuses (P2/P3). */
function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/**
* Replace `target` with exactly `bytes`, atomically: the staging files a dead
* attempt of this target left beside it are swept, then a sibling temp file in
* the same directory is opened exclusively, written, fsynced and closed, then
* renamed over the target (one filesystem operation, so a reader sees the old
* complete file or the new one), then the directory is fsynced so the rename
* itself survives a power cut. The target file is never opened for writing,
* never truncated and never partially visible.
*
* The sweep is what keeps a real process death from accumulating garbage: a
* killed attempt leaves its staging file behind (`catch` never runs for a real
* exit), and a later redo would otherwise stage a second temp and rename that
* one, leaving the first forever. It removes only entries whose name begins with
* this target's own staging prefix, in the target's own directory, and only
* non-directories — never a directory that merely shares the prefix, and never
* anything of another target. A failure to sweep throws by name rather than
* being swallowed: the commit must not stage its own bytes beside a leftover it
* could not account for.
*
* `onStaged` fires between the fsync and the rename — the point where the new
* bytes are durable beside the target but have not replaced it. A failure before
* the rename — that hook included — removes the temp file and throws: a failed
* write leaves no half-installed version behind, and the caller's intent stays
* open. A failure of the directory fsync *after* the rename is the one failure
* that leaves the target replaced with the durability of the rename unknown: it
* throws by name, the intent stays open and no completion is recorded, because a
* rename whose directory entry is not durable is not a settled commit.
*/
async function writeFileAtomic(target, bytes, onStaged) {
	const directory = dirname(target);
	const staging = join(directory, `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	let handle;
	try {
		await mkdir(directory, { recursive: true });
		await sweepStaging(directory, target);
		handle = await open(staging, "wx");
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = void 0;
		onStaged?.();
		await rename(staging, target);
		try {
			await syncDirectory(directory);
		} catch (error) {
			throw new Error(`evolution: the directory "${directory}" of the production target "${target}" could not be fsynced after the atomic rename (${error instanceof Error ? error.message : String(error)}) — the rename may or may not be durable, so this is not a settled commit: the commit intent stays open, no completion is recorded, and the state must not be treated as settled; production holds one of the two complete versions and a reconciliation settles the intent by name`);
		}
	} catch (error) {
		if (handle !== void 0) await handle.close().catch(() => {});
		await rm(staging, { force: true }).catch(() => {});
		throw error;
	}
}
/**
* Remove every entry beside `target` whose name begins with this target's own
* staging prefix (`.<target basename>.tmp-`) — the staging files of *this*
* target that a process which died before its rename left behind. Commits are
* serialized per process (`commitExclusive`) and the deployment is single-writer
* (the documented constraint), so such a sibling cannot be a concurrent writer's
* file; the sweep is confined to the target's own directory and the target's own
* prefix, and a directory is left alone even when it shares the prefix, so
* nothing else in that directory is ever touched. A failure to read the
* directory or to remove a leftover is a named stop: a leftover this commit
* cannot account for is not one it stages beside.
*/
async function sweepStaging(directory, target) {
	const prefix = `.${basename(target)}.tmp-`;
	const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
		throw new Error(`evolution: the production directory "${directory}" could not be read to sweep the staging files of "${target}" (${error instanceof Error ? error.message : String(error)}) — a leftover of a killed attempt cannot be accounted for, so the commit stops by name before it stages anything`);
	});
	for (const entry of entries) {
		if (!entry.name.startsWith(prefix) || entry.isDirectory()) continue;
		const leftover = join(directory, entry.name);
		try {
			await rm(leftover, { force: true });
		} catch (error) {
			throw new Error(`evolution: the stale staging file "${leftover}" beside the production target "${target}" could not be removed (${error instanceof Error ? error.message : String(error)}) — the commit stops by name before it stages anything rather than stage its own bytes beside a leftover it cannot account for`);
		}
	}
}
/**
* Persist one commit and carry it out, in the order the recovery rule fixes:
* every recoverable source is verified and made durable, the directory the
* commit would write is checked to be the object's own files and nothing else,
* then the intent line is appended, then the atomic production writes with their
* read-back verification, then the whole-object verification, then the
* completion that closes the intent. `bytes` are the already-verified bytes the
* caller read through its own identity checks (P2 for a candidate, the champion
* digests for a rollback), one entry per file of the request and in the same
* order; each digest must be that file's `contentSha256`, so what the intent
* promises and what the writes install cannot disagree — for either file of a
* two-file object.
*
* The sources come first because the intent *names* them as the bytes a recovery
* would write again — a line naming a source that no longer holds those bytes is
* a recovery that can never complete. So before anything is recorded every
* source is confined to the ledger root, re-read through
* {@link CommitHost.readSource} (which re-digests and refuses a source that is
* gone, changed type or changed content), and fsynced together with the
* directories that hold it. Any failure there is a named stop with no line
* recorded and nothing written. The object check comes next and also before the
* line: the digests above describe the files the intent names, and an entry the
* directory grew that nobody names is exactly what they cannot see — so
* {@link CommitHost.objectWriteRefusal} reads the *directory* first, and a
* refusal there is a named stop with no line recorded and nothing written,
* instead of a commit that lands and then discovers the directory was not the
* object it committed. Only then is the intent appended — through the service's
* own durable append, so the line is on disk before production moves — and only
* after every rename has been read back and verified, and the whole object has
* passed {@link CommitHost.verifyCommitted}, is the completion appended.
*
* A throw from any stage leaves the intent open and is the caller's to report:
* the intent is the record of what was underway, and reconciliation — not a
* second guess — is what settles it.
*/
async function commitIntent(host, request, bytes) {
	if (request.files.length === 0) throw new Error(`evolution: the ${request.direction} for proposal "${request.proposalId}" names no file to commit — a commit replaces the fixed file set of one skill object (SKILL.md, and SKILL.contract.json when the object carries an execution sidecar), so a request with nothing in it records nothing and writes nothing`);
	if (bytes.length !== request.files.length) throw new Error(`evolution: the ${request.direction} for proposal "${request.proposalId}" carries ${bytes.length} file(s) of verified bytes for ${request.files.length} target file(s) — the bytes and the intent's files are the same list in the same order, so a mismatch stops by name with nothing written`);
	request.files.forEach((file, index) => {
		const digest = sha256Hex(bytes[index]);
		if (digest !== file.contentSha256) throw new Error(`evolution: the bytes this ${request.direction} would write to "${file.target}" hash to sha256 ${digest}, not the content identity ${file.contentSha256} its commit records — nothing was written`);
	});
	const targets = request.files.map((file) => productionRelative(host, file.target));
	const sources = request.files.map((file) => ledgerRelative(host, request, file));
	for (const file of request.files) try {
		await host.readSource(file.source, file.contentSha256);
	} catch (error) {
		throw new Error(`evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" does not hold the bytes its commit recorded (${error instanceof Error ? error.message : String(error)}) — the source an intent names must be re-verifiable before the intent is recorded, so the commit stops by name: no line is recorded and nothing is written`);
	}
	for (const [index, file] of request.files.entries()) await syncSource(host, request, file, sources[index]);
	const intent = {
		intentId: `${request.proposalId}/${request.direction}`,
		proposalId: request.proposalId,
		direction: request.direction,
		approvalRef: request.approvalRef,
		files: request.files.map((file) => ({ ...file })),
		actor: request.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	const refusal = await host.objectWriteRefusal(intent);
	if (refusal !== null) throw new Error(`evolution: the ${request.direction} of proposal "${request.proposalId}" cannot write the skill object "${dirname(intent.files[0].target)}" — ${refusal}; a commit replaces one complete object and nothing beside it, so the commit stops by name: nothing was written and no commit intent was recorded`);
	await host.append({
		formatVersion: 4,
		kind: "commit_intent",
		...intent
	});
	host.probe("intent-recorded");
	await installAndVerify(host, intent, bytes, targets);
	await host.verifyCommitted(intent);
	host.probe("commit-verified");
	await appendCompletion(host, intent);
}
/**
* Settle one open intent against the filesystem, or stop by name: re-read every
* one of the intent's own recoverable sources and verify it still hashes to what
* the intent committed; read every production file again and classify it as the
* pre-commit state (`old`), the committed content (`new`), absent or something
* else — a source that is gone or changed, or a file that is missing or foreign,
* stops by name right there, in that file's own words — and then ask
* {@link CommitHost.objectWriteRefusal} what the *directory* holds beyond the
* files the intent names. If nothing refused, then
*
* - every file still holds its `baselineSha256` — the commit never landed — so
*   the same bytes are written atomically, in intent order, and the completion
*   recorded (`completed-redone`);
* - the files are mixed (a process that died between the two renames): the files
*   still holding their baseline are written, and the files already carrying the
*   committed content have their own staging leftovers swept and their
*   directories fsynced, so the earlier rename's durability is re-established
*   too; the completion is recorded only once the whole object verifies
*   (`completed-redone`);
* - every file already holds `contentSha256` — the writes landed but their
*   completion did not — so each target's staging leftovers are swept, each
*   production directory is fsynced, and then only the completion is recorded,
*   with production's bytes left exactly as they are (`completed-written`);
* - a missing file, a file holding neither digest, or a source that is gone or
*   changed — a `blocked` outcome naming the intent, the file and what was
*   actually found, with nothing written and the intent left open;
* - the directory holding an entry the intent does not name — the object check
*   above — a `blocked` outcome naming the entry, with nothing written: a
*   recovery settles an intent over the object it commits, never over a
*   directory a third party turned into something else.
*
* The `completed-written` branch still fsyncs the production directories, even
* though it writes no bytes: the completion is the claim that production holds
* the committed content *durably*, and a rename is durable only once the
* directory that holds it is fsynced. A rename whose directory fsync failed when
* its commit ran (or a process that died before it) left production on the new
* bytes with that durability unestablished — so recording the completion without
* re-establishing it would be exactly the "completion recorded for a write that
* may be lost" state the commit order exists to prevent, and nothing would ever
* reconcile it again, because the completion closes the intent. The same branch
* sweeps each target's own staging leftovers, so the invariant is total: settling
* an intent leaves no staging file of that object behind, whichever branch
* settled it. The deliberate consequence: on a filesystem whose production
* directory cannot be fsynced, a recovery stops by name — the completion is not
* recorded and the intent stays open — instead of recording a completion it
* cannot stand behind.
*
* Every branch that records a completion calls
* {@link CommitHost.verifyCommitted} first: a mixed pair a recovery finished
* must load as one object carrying this direction's identity before the ledger
* may say the commit is settled, exactly as a fresh commit must.
*
* It never throws for a blocked commit: one batch of reconciliations reports
* every intent it could not settle. A real I/O failure of a redo write, of a
* directory fsync or of a sweep is *not* a blocked commit and is propagated:
* the caller must not read a failed write as "settled".
*/
async function reconcileIntent(host, intent) {
	const targets = intent.files.map((file) => file.target);
	const outcome = (result, detail) => ({
		intentId: intent.intentId,
		proposalId: intent.proposalId,
		direction: intent.direction,
		targets,
		result,
		...detail === void 0 ? {} : { detail }
	});
	const bytes = [];
	for (const file of intent.files) try {
		bytes.push(await host.readSource(file.source, file.contentSha256));
	} catch (error) {
		return outcome("blocked", `evolution: the recoverable source "${file.source}" of commit intent "${intent.intentId}" for the file "${file.target}" is no longer readable as the bytes it committed (${error instanceof Error ? error.message : String(error)}) — the source bytes cannot be re-verified under ${host.root}, so the commit stops by name and the intent stays open; nothing was written`);
	}
	const relatives = [];
	const states = [];
	const digests = [];
	for (const file of intent.files) {
		let relative$1;
		let current;
		try {
			relative$1 = productionRelative(host, file.target);
			current = await host.readProduction(relative$1);
		} catch (error) {
			return outcome("blocked", `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" cannot be read as a regular file (${error.message.replace(/^(evolution|verified-read): /, "")}) — the commit stops by name and the intent stays open; nothing was written`);
		}
		relatives.push(relative$1);
		digests.push(current?.sha256 ?? "missing");
		states.push(current === null ? "missing" : current.sha256 === file.baselineSha256 ? "old" : current.sha256 === file.contentSha256 ? "new" : "other");
	}
	const absent = intent.files.findIndex((_file, index) => states[index] === "missing");
	if (absent >= 0) {
		const file = intent.files[absent];
		return outcome("blocked", `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" is missing — it holds neither the state before the commit (sha256 ${file.baselineSha256}) nor the content it committed (sha256 ${file.contentSha256}); a third party removed it, so the commit stops by name and the intent stays open (nothing is written, nothing is recreated)`);
	}
	const foreign = intent.files.findIndex((_file, index) => states[index] === "other");
	if (foreign >= 0) {
		const file = intent.files[foreign];
		return outcome("blocked", `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" holds sha256 ${digests[foreign]}, which is neither the state before the commit (sha256 ${file.baselineSha256}) nor the content it committed (sha256 ${file.contentSha256}) — a third party changed it, so the commit stops by name and the intent stays open; nothing is overwritten and the completion is never recorded`);
	}
	const refusal = await host.objectWriteRefusal(intent);
	if (refusal !== null) return outcome("blocked", `evolution: the ${intent.direction} of proposal "${intent.proposalId}" cannot write the skill object "${dirname(intent.files[0].target)}" of commit intent "${intent.intentId}" — ${refusal}; a commit replaces one complete object and nothing beside it, so nothing is written and the intent stays open until a human settles what the directory holds`);
	if (states.every((state) => state === "new")) {
		for (const file of intent.files) await sweepStaging(dirname(file.target), file.target);
		for (const file of intent.files) await syncTargetDirectory(host, intent, file.target);
		await host.verifyCommitted(intent);
		host.probe("commit-verified");
		await appendCompletion(host, intent);
		return outcome("completed-written");
	}
	for (const [index, file] of intent.files.entries()) {
		if (states[index] === "old") {
			await writeFileAtomic(file.target, bytes[index], () => host.probe("write-staged", file.target));
			const readback = await host.readProduction(relatives[index]);
			if (readback === null || readback.sha256 !== file.contentSha256) throw new Error(`evolution: the production file "${file.target}" does not hold the committed content after the atomic replace (sha256 ${readback?.sha256 ?? "missing"} != ${file.contentSha256}) — the intent stays open and a reconciliation reports what production actually carries by name`);
			host.probe("write-renamed", file.target);
			continue;
		}
		await sweepStaging(dirname(file.target), file.target);
		await syncTargetDirectory(host, intent, file.target);
	}
	await host.verifyCommitted(intent);
	host.probe("commit-verified");
	await appendCompletion(host, intent);
	return outcome("completed-redone");
}
/**
* Make one production target's directory durable before a completion is recorded
* over bytes this process did not just rename into place (the
* `completed-written` reconciliation, and the file a mixed-state recovery finds
* already carrying the content).
*
* The completion is the claim that production holds the committed content
* *durably*; a rename is durable only once the directory entry that names it is
* fsynced. Re-establishing that is the one thing missing after a commit whose
* own directory fsync failed (or a process that died before it), so a recovery
* that skips it would close the intent on a write that may be lost — and with
* the intent closed, nothing would ever look at the target again. The bytes are
* never touched here: the branch's whole point is "the content is already there,
* only the record is missing".
*
* A failure is a named stop: nothing is recorded, the intent stays open, and the
* state is not settled. On a filesystem whose production directory cannot be
* fsynced, a recovery therefore stops by name instead of recording a completion
* it cannot stand behind.
*/
async function syncTargetDirectory(host, intent, target) {
	const directory = dirname(target);
	try {
		await syncDirectory(directory);
	} catch (error) {
		throw new Error(`evolution: the directory "${directory}" of the production target "${target}" could not be fsynced before recording the completion of commit intent "${intent.intentId}" (${error instanceof Error ? error.message : String(error)}) — the rename that put the committed content there may not be durable, so the completion is not recorded, the intent stays open and the state must not be treated as settled; a reconciliation that can make the directory durable records the completion then`);
	}
}
/**
* The write half of one commit, shared by a fresh commit and a redo: for every
* file in intent order, atomic replace, read back, verify the target now carries
* exactly the committed content, and only then report the rename stage.
* `relativeTargets` are the targets' paths under the skill root, already
* confined by the caller (a target that escapes the root is refused before this
* runs, so nothing is ever staged outside it). The read-back is not a formality
* — it is what makes "the rename happened" and "production carries this content"
* the same fact, so a completion is never recorded over bytes the commit did not
* install.
*/
async function installAndVerify(host, intent, bytes, relativeTargets) {
	for (const [index, file] of intent.files.entries()) {
		await writeFileAtomic(file.target, bytes[index], () => host.probe("write-staged", file.target));
		const readback = await host.readProduction(relativeTargets[index]);
		if (readback === null || readback.sha256 !== file.contentSha256) throw new Error(`evolution: the production file "${file.target}" does not hold the committed content after the atomic replace (sha256 ${readback?.sha256 ?? "missing"} != ${file.contentSha256}) — the intent stays open and a reconciliation reports what production actually carries by name`);
		host.probe("write-renamed", file.target);
	}
}
/**
* Close one intent: the completion line, written for the intent's own grant and
* its whole file set — its `approvalRef`, every `target` the intent committed in
* intent order, and its actor, so a completion can never describe a second
* approval or a second path. The fold refuses a completion with no matching open
* intent, which is what makes a repeat (a retry, a restart, a double
* reconciliation) cost nothing: the second line has nothing to close.
*/
async function appendCompletion(host, intent) {
	await host.append({
		formatVersion: 4,
		kind: intent.direction === "apply" ? "applied" : "rolledback",
		proposalId: intent.proposalId,
		targets: intent.files.map((file) => file.target),
		approvalRef: intent.approvalRef,
		intentId: intent.intentId,
		actor: intent.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	});
}
/**
* One commit target relative to the production skill root: the shape the
* walk-verified production read takes, and the check that a target can only
* ever resolve inside the root it claims — a target that escapes it (or *is*
* the root) is refused before any read or write.
*/
function productionRelative(host, target) {
	const rel = relative(host.skillRoot, resolve(target));
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`evolution: the commit target "${target}" is not inside the production skill root ${host.skillRoot} — a commit replaces the fixed file set of one skill object under that root (SKILL.md, and SKILL.contract.json when the object carries an execution sidecar) and nothing else`);
	return rel;
}
/**
* The check that the recoverable source an intent will name for one file
* resolves inside the ledger root — the same confinement
* {@link productionRelative} gives a target, applied to the bytes a recovery
* reads back. A source that escapes the root (or *is* the root) is refused by
* name before the intent is recorded and before anything is written: the root is
* what a reconciliation is allowed to read a source from, and a commit's
* durability claim covers exactly those files.
*/
function ledgerRelative(host, request, file) {
	const rel = relative(host.root, resolve(host.root, file.source));
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" is not inside the ledger root ${host.root} — a commit names the bytes it could write again from under that root and nothing else, so it stops by name before the intent is recorded and nothing is written`);
	return rel;
}
/**
* Make one file's recoverable source durable *before* the intent that names
* it — the bytes *and* the path: fsync the file itself, then every directory on
* the chain from the one that holds it up to and including the ledger root. The
* bytes alone are not enough: a directory entry that never reached the disk takes
* the name inside it with it, so a durable `commit_intent` could name a `source`
* that no longer resolves and the recovery could only report `blocked` — a named
* stop, but the commit was supposed to have a recoverable source. The source
* exists (the verified read above just walked it through real entries), so every
* directory on that chain exists too; the walk stops at the ledger root, which
* the source's confinement already guarantees is an ancestor, and a two-file
* commit runs this for each of its sources, so both halves of an object are
* durable before the line that names them.
*
* A failure of any step is the same named stop, naming the file or the directory
* that failed: nothing is recorded and nothing is written — an intent that names
* a source which may not survive is exactly the state the commit order exists to
* prevent.
*/
async function syncSource(host, request, file, sourceRelative) {
	const source = resolve(host.root, sourceRelative);
	let handle;
	try {
		handle = await open(source, "r");
		await handle.sync();
	} catch (error) {
		throw new Error(`evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" could not be fsynced at "${source}" (${error instanceof Error ? error.message : String(error)}) — the source must be durable, bytes and path, before the intent that names it is recorded, so the commit stops by name: no line is recorded and nothing is written`);
	} finally {
		await handle?.close().catch(() => {});
	}
	for (const directory of sourceDirectories(host.root, source)) try {
		await syncDirectory(directory);
	} catch (error) {
		throw new Error(`evolution: the directory "${directory}" holding the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" could not be fsynced (${error instanceof Error ? error.message : String(error)}) — the source must be durable, bytes and path, before the intent that names it is recorded, so the commit stops by name: no line is recorded and nothing is written`);
	}
}
/**
* The directories that make a source's *path* durable, inside-out: the one that
* holds the file, then each ancestor up to and including the ledger root. The
* walk stops at the root because the source is confined to it (see
* {@link ledgerRelative}); the extra `dirname` guard only keeps a malformed call
* from looping, since a confined source always reaches the root first.
*/
function sourceDirectories(root, source) {
	const directories = [];
	for (let directory = dirname(source);; directory = dirname(directory)) {
		directories.push(directory);
		if (directory === root || dirname(directory) === directory) break;
	}
	return directories;
}
/**
* fsync one directory so an entry created or renamed inside it is durable.
*
* It is exported because the ledger's own durable append (`evolution.ts`) needs
* the same primitive: one implementation, so "this directory was fsynced" means
* the same operation on the commit path and on the ledger path. It does not
* swallow: a filesystem that refuses the open or the sync throws, and the caller
* decides what that means — for a production rename it means the rename is not
* settled ({@link writeFileAtomic}), and for a ledger line it means the line is
* not durable.
*/
async function syncDirectory(directory) {
	const handle = await open(directory, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close().catch(() => {});
	}
}

//#endregion
//#region src/snapshot-input.ts
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Is the real path `abs` inside the real path `base` — or `base` itself? */
function inside(base, abs) {
	return abs === base || abs.startsWith(`${base}${sep}`);
}
/**
* Resolve one symbolic link to the real path it names. A chain that loops
* (`ELOOP`), a target that is missing or otherwise cannot be resolved, and a
* target outside the snapshot root are all refusals that name the link, its
* target text and the reason.
*/
async function resolveLink(lex, base) {
	const text = await readlink(lex).catch(() => "?");
	let target;
	try {
		target = await realpath(lex);
	} catch (error) {
		const reason = error.code === "ELOOP" ? "its target chain loops" : message(error);
		throw new Error(`experiment: the input snapshot link "${lex}" -> "${text}" cannot be resolved: ${reason}`);
	}
	if (!inside(base, target)) throw new Error(`experiment: the input snapshot link "${lex}" -> "${text}" resolves to "${target}", outside the snapshot root "${base}" — a frozen input may hold only files and links that resolve inside it`);
	return target;
}
/**
* Walk the snapshot at `root` in sorted relative-path order, awaiting `visit`
* for every directory and every regular file of the tree **as the content it
* really names**: a link is resolved first, so a caller that rebuilds the tree
* (the copy) writes a parent before its children, and a link position becomes
* real content rather than a pointer at a shared target. The root itself may be
* named through a link; the policy measures containment in real paths, so what
* the snapshot *is* is what is compared.
*/
async function walkSnapshotInput(root, visit) {
	let base;
	try {
		base = await realpath(root);
	} catch (error) {
		throw new Error(`experiment: the input snapshot "${root}" cannot be resolved: ${message(error)}`);
	}
	const open$1 = new Set([base]);
	const walk = async (current, prefix) => {
		let names;
		try {
			names = [...await readdir(current)].sort();
		} catch (error) {
			throw new Error(`experiment: the input snapshot directory "${current}" cannot be read: ${message(error)}`);
		}
		for (const name of names) {
			const rel = prefix === "" ? name : `${prefix}/${name}`;
			const lex = join(current, name);
			let entry;
			try {
				entry = await lstat(lex);
			} catch (error) {
				throw new Error(`experiment: the input snapshot entry "${lex}" cannot be read: ${message(error)}`);
			}
			const real = entry.isSymbolicLink() ? await resolveLink(lex, base) : lex;
			let stat = entry;
			if (real !== lex) try {
				stat = await lstat(real);
			} catch (error) {
				throw new Error(`experiment: the input snapshot entry "${real}", the target of the link "${lex}", cannot be read: ${message(error)}`);
			}
			if (stat.isDirectory()) {
				if (open$1.has(real)) {
					const named = real === lex ? `directory "${lex}"` : `link "${lex}" -> "${real}"`;
					throw new Error(`experiment: the input snapshot ${named} is already on the way here — the tree it names has no end, so it cannot be frozen as input`);
				}
				open$1.add(real);
				await visit({
					kind: "directory",
					rel,
					mode: stat.mode & 4095
				});
				await walk(real, rel);
				open$1.delete(real);
				continue;
			}
			if (!stat.isFile()) {
				const through = real === lex ? "" : ` (through the link "${lex}")`;
				throw new Error(`experiment: the input snapshot holds "${real}"${through}, which is neither a regular file nor a directory — only regular files, directories and links into the snapshot can be frozen as input`);
			}
			let bytes;
			try {
				bytes = await readFile(real);
			} catch (error) {
				throw new Error(`experiment: the input snapshot file "${lex}" cannot be read: ${message(error)}`);
			}
			await visit({
				kind: "file",
				rel,
				mode: stat.mode & 4095,
				bytes
			});
		}
	};
	await walk(base, "");
}

//#endregion
//#region src/experiment.ts
/**
* The idempotency key's content member (K3): the digest of the candidate's
* **complete** content identity — {@link digestOf} of the identity `prepare`
* recorded, so the name, the `SKILL.md` bytes and, when the object has an
* execution sidecar, the sidecar's exact bytes and canonical declaration are all
* part of the key. Two candidates that differ in any of them are two objects,
* and a key spent on one is never reused for the other.
*/
function preparedContentDigestOf(candidate) {
	return digestOf(candidate);
}
/** True for a record of the experiment family — the lines the proposal fold must leave alone. */
function isExperimentRecord(record) {
	return record.kind === "experiment_started" || record.kind === "experiment_sample";
}
/** A run state that means the run is over, whatever it settled to. */
const TERMINAL_RUN_STATUSES = [
	"verified",
	"failed",
	"cancelled"
];
function nonEmpty$1(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`experiment: ${field} must be a non-empty string`);
	return value;
}
/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
function safeSegment(value, field) {
	const text = nonEmpty$1(value, field);
	if (text === "." || text === ".." || text.includes("/") || text.includes("\\") || isAbsolute(text)) throw new Error(`experiment: ${field} must be a single safe path segment, got "${text}"`);
	return text;
}
function isHex64(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
/** Lowercase SHA-256 hex over exact bytes. */
function sha256Hex$2(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/** The lineage tag one sample side's replayed task carries — how a run is found again after a crash. */
function experimentLineage(experimentId, sampleTaskId, side) {
	return `evolution-experiment:${experimentId}:${sampleTaskId}:${side}`;
}
/** The experiment id: a digest of the proposal and the frozen block, so a differently frozen experiment never shares one. */
function experimentIdOf(proposalId, frozenDigest) {
	return digestOf({
		proposalId,
		frozenDigest
	}).slice(0, 16);
}
/** The report path one experiment's evidence lands at, relative to the ledger root. */
function experimentReportPath(proposalId, experimentId) {
	return `sandbox/${proposalId}/exp-${experimentId}/experiment-report.json`;
}
/** The one string form of a sample key (map key, refusals, the ledger's own uniqueness check). */
function experimentSampleKey(key) {
	return [
		key.proposalId,
		key.preparedContentDigest,
		key.sampleTaskId,
		key.side,
		key.repetition
	].join("\0");
}
/** A sample key as a reader sees it: the sample and the side it names. */
function experimentSampleLabel(key) {
	return `${key.sampleTaskId}/${key.side}#${key.repetition}`;
}
/**
* The recursive content digest of a directory — the input snapshot identity
* (§F.2): every regular file's relative path and byte digest, sorted by path,
* hashed together. A symbolic link is not an input of its own: the snapshot's
* policy (`snapshot-input.ts`) resolves every link inside the root first, so the
* digest covers the bytes a workspace built from the snapshot holds — a link to
* a file contributes that file's bytes, a link to a directory contributes the
* subtree it names, and whatever the target text spells contributes nothing. A
* link that escapes the root, loops, or names something unreadable is refused by
* name, never ignored into a digest the source does not have.
*/
async function directoryDigest(directory) {
	const lines = [];
	await walkSnapshotInput(directory, async (entry) => {
		if (entry.kind !== "file") return;
		lines.push(`${entry.rel}\0${sha256Hex$2(entry.bytes)}`);
	});
	return sha256Hex$2(lines.join("\n"));
}
/** The task's latest review record — its terminal outcome is what makes a sample a sample. */
function latestReview(snapshot, task) {
	const runId = task.runIds[task.runIds.length - 1];
	return snapshot.reviews.find((item) => item.runId === runId);
}
function reviewRefOf(review) {
	return `${review.taskId}#${review.runId ?? "no-run"}`;
}
/**
* What one side cost, as the run's own review record reported it. `unknown` is
* a first-class answer and never a zero: a record that carries no metrics, or
* metrics with no token and no tool-call counters, is reported with the reason
* it could not be read.
*/
function costOf(review) {
	if (review === void 0) return {
		status: "unknown",
		reason: "the run settled no review record, so no cost was reported for it"
	};
	const metrics = review.metrics;
	if (metrics === void 0) return {
		status: "unknown",
		reason: "the run's review record carries no metrics, so no cost was reported for it"
	};
	if (metrics.tokens === void 0 && metrics.toolCalls === void 0) return {
		status: "unknown",
		reason: "the run's review record carries metrics but no token and no tool-call counters"
	};
	return {
		status: "reported",
		metrics: structuredClone(metrics)
	};
}
/**
* The evidence ids of one run: the review record's own list, or the store's
* bundles for that run when there is no review. Exported because the promotion
* gate re-reads exactly this fact from the store — one rule for what a side's
* evidence is, not two.
*/
function evidenceRefsOf(snapshot, runId, review) {
	if (review !== void 0) return [...review.evidenceRefs];
	if (runId === void 0) return [];
	return snapshot.evidence.filter((bundle) => bundle.taskRunId === runId).map((bundle) => bundle.evidenceId);
}
/** The review record's criteria, or the run's own verdicts when the review carries none. */
function criteriaOf(review, outcome) {
	return structuredClone([...review?.criteria ?? outcome?.criteria ?? []]);
}
/** One criterion as the report carries it: the verdict plus the verifier that decided it (v1's report dropped the identity). */
function criterionDetail(criterion) {
	return {
		criterionId: criterion.criterionId,
		verdict: criterion.verdict,
		...criterion.verifierId === void 0 ? {} : { verifierId: criterion.verifierId },
		...criterion.verifierVersion === void 0 ? {} : { verifierVersion: criterion.verifierVersion },
		...criterion.command === void 0 ? {} : { command: criterion.command },
		...criterion.exitCode === void 0 ? {} : { exitCode: criterion.exitCode }
	};
}
/**
* The proposal this experiment may evaluate, and the candidate object it runs
* against. A skill candidate only: this plane's two-sided experiment replaces an
* existing skill object's bytes, and every other target type either has no such
* evaluation (A6's capability candidates) or none at all. The candidate's files
* are re-verified here (P2) before anything runs — the `SKILL.md` alone for
* guidance, both files when the object carries an execution sidecar.
*/
async function experimentCandidate(sources, proposalId) {
	const proposal = await sources.evolution.get(proposalId);
	if (proposal.targetType !== "skill") throw new Error(`proposal ${proposalId} targets "${proposal.targetType}"; the two-sided experiment evaluates a skill candidate only`);
	if (proposal.status !== "prepared") throw new Error(`proposal ${proposalId} is ${proposal.status}; only a prepared proposal can be evaluated`);
	const prepared = proposal.prepared;
	if (prepared === void 0 || prepared.sandbox === null || !prepared.mechanical) throw new Error(`proposal ${proposalId} has no materialized candidate; prepare it before evaluating it`);
	const candidate = prepared.skillContent;
	if (candidate === void 0) throw new Error(`proposal ${proposalId} carries no candidate content identity — propose a new candidate and prepare it`);
	await sources.evolution.readSkillCandidate(proposalId);
	return {
		proposal,
		sandbox: prepared.sandbox,
		candidate
	};
}
/** The specification's own shape, before anything is read or frozen. */
function validateSpec(spec) {
	nonEmpty$1(spec.proposalId, "proposalId");
	if (spec.model === null || typeof spec.model !== "object" || typeof spec.model.provider !== "string" || spec.model.provider.length === 0 || typeof spec.model.model !== "string" || spec.model.model.length === 0) throw new Error("experiment: model must be the structured selection { provider, model } the runs are placed under — a bare string names no route a spawn can be given, so nothing may be frozen under it");
	if (typeof spec.snapshot?.sourceDir !== "string" || spec.snapshot.sourceDir.trim().length === 0) throw new Error("experiment: snapshot.sourceDir must be the directory both sides are built from");
	if (!Number.isInteger(spec.repetition) || spec.repetition < 0) throw new Error("experiment: repetition must be the experiment's non-negative integer repeat index");
	if (!Array.isArray(spec.samples) || spec.samples.length === 0) throw new Error("experiment: samples must name at least one sample");
	const seen = /* @__PURE__ */ new Set();
	for (const [index, sample] of spec.samples.entries()) {
		safeSegment(sample.taskId, `samples[${index}].taskId`);
		if (seen.has(sample.taskId)) throw new Error(`experiment: samples[${index}] repeats task "${sample.taskId}"`);
		seen.add(sample.taskId);
		if (!EXPERIMENT_SAMPLE_ROLES.includes(sample.role)) throw new Error(`experiment: samples[${index}].role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(" / ")}`);
	}
}
/** The role a sample must have been chosen for, against the historical record it carries. */
function assertSampleRole(sample, task, review) {
	const required = sample.role === "observed-failure" ? "failed" : "verified";
	if (review.outcome !== required) throw new Error(`sample "${sample.taskId}" is an ${sample.role} but its latest review record is "${review.outcome}", not "${required}" — a sample must be the case its role names`);
	if (task.status !== review.outcome) throw new Error(`sample "${sample.taskId}" is ${task.status} but its latest review record is "${review.outcome}"; the two must agree`);
}
/**
* One criterion's frozen judge identity (S4-E §Q3), read from the criterion's
* own declaration and the registry as it stands *before* the first run.
*
* An experiment's judge must be nameable before it runs, so every criterion
* must pin a `verifierRef` the registry holds *and* declares a version for:
* the registered instance is what the verdicts are recalled against, and a
* criterion that leaves the choice to mode dispatch — or names a judge nobody
* can find or version — is refused here, before the ledger and before any run.
* Ordinary tasks keep mode dispatch; this rule is the experiment freeze's own.
*/
function frozenCriterionOf(criterion, where, vocabulary) {
	const inputs = criterion.protectedInputs ?? [];
	for (const input of inputs) if (typeof input?.path !== "string" || input.path.length === 0 || !isHex64(input?.sha256)) throw new Error(`the sample's criterion "${criterion.criterionId}" carries a protected input that was never fixed to { path, sha256 } — an acceptance input nobody fixed is not a frozen input`);
	const ref = criterion.verifierRef;
	if (ref === void 0) throw new Error(`${where} criterion "${criterion.criterionId}" pins no verifierRef — the judge a verdict belongs to is fixed before the first run, so a criterion that lets the registry choose by mode cannot be frozen; pin the registered, versioned verifier that decides it`);
	if (vocabulary === void 0) throw new Error(`${where} criterion "${criterion.criterionId}" pins verifier "${ref}" but this deployment cannot list its verifier registry (verifierIds()/verifierVersions() are unavailable), so the judge identity cannot be frozen — an experiment whose judge nobody can name is refused before it runs`);
	if (!vocabulary.ids.includes(ref)) throw new Error(`${where} criterion "${criterion.criterionId}" pins verifier "${ref}", which the registry does not hold (registered: ${vocabulary.ids.length === 0 ? "none" : vocabulary.ids.join(", ")}) — the criterion would be judged inconclusive by a judge that does not exist; name a registered verifier before freezing the experiment`);
	const declared = vocabulary.versions[ref];
	if (declared === void 0) throw new Error(`${where} criterion "${criterion.criterionId}" pins verifier "${ref}", which the registry holds but declares no version for — a verdict belongs to the instance that judged it, so a judge nobody can recall by version is refused before the experiment runs`);
	return {
		criterionId: criterion.criterionId,
		verificationMode: criterion.verificationMode,
		...criterion.command === void 0 ? {} : { command: criterion.command },
		protectedInputsDigest: protectedInputsDigest(inputs),
		verifierRef: ref,
		verifierVersion: declared,
		verifierAnchor: `registered verifier "${ref}" declares version "${declared}"`
	};
}
/**
* The provider identity the production baseline side of one sample must bind
* (S4-E §Q3): the runtime's own pre-check over the rows the sample's required
* capabilities resolve to, run from the caller's viewpoint before anything
* runs, plus the MCP servers and preset the effective table declares for those
* rows. Every value here is read from the deployment's own configuration — the
* pre-check's revision is the runtime's own conclusion, not a guess this plane
* makes.
*
* The candidate side's expectation is frozen beside it (K3): with the improved
* skill's declaration digest substituted by the candidate object's own
* ({@link candidateRegistryRevisionOf}), the same pure function the runtime
* itself uses. The substituting entry must be in the resolved list — the skill
* this experiment replaces is what its rows grant — so a list that does not hold
* it is a named refusal, not a revision derived over half a configuration.
*
* Refused by name when the deployment cannot answer (no runtime pre-check, a
* row the table does not hold, a refused provider, conflicting presets): a
* sample whose provider identity cannot be fixed is not an experiment this
* build may run.
*/
async function frozenProviderIdentity(input) {
	const { sources, caller, required, candidate, where } = input;
	const table = sources.taskRuntime.listCapabilities?.();
	if (table === void 0) throw new Error(`${where} cannot fix the provider identity the production baseline runs under: this deployment's task runtime exposes no capability table (listCapabilities), so which rows, servers and skills the sample resolves to is not knowable before it runs — the experiment is refused rather than run under an identity nobody can compare against`);
	const missing = [...new Set(required)].filter((name) => table[name] === void 0).sort();
	if (missing.length > 0) throw new Error(`${where} requires ${missing.length > 1 ? "capabilities" : "capability"} [${missing.join(", ")}], which the effective capability table does not hold — the runtime would refuse the replay for a capability gap after freezing; name rows the deployment has`);
	const rows = [...new Set(required)].sort();
	let precheck;
	try {
		precheck = await sources.taskRuntime.capabilityProviderReport(caller, rows);
	} catch (error) {
		throw new Error(`${where} cannot run the runtime's provider pre-check over rows [${rows.join(", ") || "none"}] (${error instanceof Error ? error.message : String(error)}) — the provider identity the production baseline would bind cannot be fixed, so the experiment is refused before it runs`);
	}
	const refused = precheck.capabilities.flatMap((row) => row.skills.filter((skill) => !skill.valid).map((skill) => `${row.capability}: skill "${skill.name}" (${(skill.defects ?? []).map((defect) => `${defect.code}: ${defect.detail}`).join("; ")})`));
	if (refused.length > 0) throw new Error(`${where} resolves to providers the deployment cannot use, so the production baseline could not run under them:\n- ${refused.join("\n- ")}`);
	const skills = precheck.capabilities.flatMap((row) => row.skills).filter((skill) => skill.valid).filter((skill, index, all) => all.findIndex((entry) => entry.name === skill.name) === index).map((skill) => {
		const role = skill.role;
		if (role !== "execution-provider" && role !== "knowledge" && role !== "guidance") throw new Error(`${where} resolved skill "${skill.name}" to an unknown role "${String(role)}"; the provider identity cannot be frozen`);
		if (typeof skill.contentDigest !== "string" || skill.contentDigest.length === 0) throw new Error(`${where} resolved skill "${skill.name}" without a content digest; the provider identity cannot be frozen`);
		return {
			name: skill.name,
			role,
			contractDigest: skill.contractDigest ?? null,
			contentDigest: skill.contentDigest
		};
	}).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
	const mcpServers = [...new Set(rows.flatMap((row) => table[row]?.mcpServers ?? []))].sort();
	const declaredPresets = new Set(rows.flatMap((row) => {
		const preset = table[row]?.preset;
		return preset === void 0 ? [] : [preset];
	}));
	if (declaredPresets.size > 1) throw new Error(`${where}'s rows declare conflicting presets (${[...declaredPresets].sort().join(", ")}); one worker requires one preset, so the runtime would refuse the replay — split the rows or align the presets before freezing the experiment`);
	return {
		capabilities: rows,
		registryRevision: precheck.revision,
		candidateRegistryRevision: candidateRegistryRevisionOf({
			table,
			skills,
			candidate,
			where
		}),
		mcpServers,
		preset: declaredPresets.size === 0 ? null : [...declaredPresets][0],
		skills
	};
}
/**
* The registry revision the **candidate** side of one sample must bind (K3):
* the runtime's own {@link registryRevision} over the same capability table and
* the same resolved provider list, with the improved skill's declaration digest
* replaced by the candidate object's own (`null` for a guidance candidate —
* which leaves the revision equal to the production one, because nothing about
* the list changed).
*
* This is the one substitution the candidate overlay is supposed to produce: an
* execution candidate's sidecar rewrites `content.skillMdSha256`, its canonical
* declaration digest moves with the body, and the revision that folds every
* provider's declaration absorbs that. Recomputing it here — rather than
* letting a promotion derive it — is what makes the value a *frozen
* expectation* both sides are compared against separately.
*
* A provider list that does not hold the improved skill is refused by name: the
* list is what the substitution is defined over, and the experiment is refused
* before it runs rather than frozen with a revision nobody can re-derive.
*/
function candidateRegistryRevisionOf(input) {
	const { table, skills, candidate, where } = input;
	if (!skills.some((skill) => skill.name === candidate.name)) throw new Error(`${where} resolves no provider named "${candidate.name}", the skill this experiment replaces — the candidate side's registry revision is the frozen provider list with that skill's declaration digest substituted, so a list that does not hold it cannot say what the candidate side resolves to; the experiment is refused before it runs`);
	const candidateDigest = candidate.contract?.contractDigest ?? null;
	return registryRevision(table, skills.map((skill) => ({
		name: skill.name,
		contractDigest: skill.name === candidate.name ? candidateDigest : skill.contractDigest
	})));
}
/** Freeze one sample from its store record: what the case is, the acceptance the replay mirrors into both sides, and the provider identity. */
function frozenSampleOf$1(sample, task, review, provider, vocabulary) {
	if (task.acceptanceCriteria.length === 0) throw new Error(`sample "${sample.taskId}" carries no acceptance criteria; there is nothing for the two sides to be judged by`);
	const where = `sample "${sample.taskId}"`;
	return {
		taskId: sample.taskId,
		role: sample.role,
		contractDigest: digestOf({
			objective: task.objective,
			acceptanceCriteria: task.acceptanceCriteria,
			requiredCapabilities: task.requestedCapabilities
		}),
		criteria: task.acceptanceCriteria.map((criterion) => frozenCriterionOf(criterion, where, vocabulary)),
		observed: {
			outcome: review.outcome === "failed" ? "failed" : "verified",
			...review.runId === void 0 ? {} : { runId: review.runId }
		},
		provider
	};
}
/** One content identity as a frozen block carries it: the whole object's identity, copied member by member (never shared). */
function frozenIdentityOf(identity) {
	return {
		name: identity.name,
		sha256: identity.sha256,
		...identity.contract === void 0 ? {} : { contract: {
			sha256: identity.contract.sha256,
			contractDigest: identity.contract.contractDigest
		} }
	};
}
/**
* Build the frozen identity block (§F.2), then check it against the schema the
* report and the ledger share. The candidate and production-baseline identities
* are frozen whole (K3): the `SKILL.md` digest and, when the object carries an
* execution sidecar, the sidecar's exact-byte digest and canonical declaration
* digest — so a promotion can compare the evidence's object with prepare's
* member by member, and an object that changed shape cannot borrow the other
* shape's diff.
*/
function freezeExperiment(input) {
	const frozen = {
		proposalId: input.proposalId,
		repetition: input.spec.repetition,
		candidate: frozenIdentityOf(input.candidate),
		...input.productionBaseline === void 0 ? {} : { productionBaseline: frozenIdentityOf(input.productionBaseline) },
		model: {
			provider: input.spec.model.provider,
			model: input.spec.model.model,
			...input.spec.model.reasoningEffort === void 0 ? {} : { reasoningEffort: input.spec.model.reasoningEffort },
			...input.spec.model.maxTokens === void 0 ? {} : { maxTokens: input.spec.model.maxTokens },
			label: `${input.spec.model.provider}/${input.spec.model.model}`
		},
		budget: { ...input.spec.budget },
		samples: input.samples,
		snapshot: {
			sourceDir: resolve(input.spec.snapshot.sourceDir),
			digest: input.snapshotDigest
		},
		comparerVersion: EXPERIMENT_COMPARER_VERSION,
		overlay: {
			baseline: "none — the baseline runs under the production configuration",
			candidate: `extraSkillRoots: [${input.sandbox}/skills] — the complete candidate object: ${input.candidate.contract === void 0 ? `the guidance object "${input.candidate.name}" (SKILL.md alone, no sidecar)` : `the execution object "${input.candidate.name}" (SKILL.md plus the derived SKILL.contract.json)`}, loaded whole through the runtime's own discovery`
		}
	};
	assertFrozenExperiment(frozen);
	return frozen;
}
/**
* Build one side's workspace from the frozen snapshot, then prove it holds
* exactly the frozen bytes.
*
* The copy is the snapshot's own traversal (`snapshot-input.ts`), not `cp`.
* `cp` keeps a symbolic link a link, and a kept link is a shared target: a run
* that writes through it writes the source the snapshot was taken from, or
* another side's copy. Rebuilding the tree's resolved content instead gives this
* side a real file where a link to a file was and a real directory where a link
* to a directory was, so the workspace is private by construction — and it is
* what lets the digest below describe the snapshot and this copy as one input.
*/
async function buildWorkspace(sourceDir, target, snapshotDigest) {
	await rm(target, {
		recursive: true,
		force: true
	});
	await mkdir(target, { recursive: true });
	await walkSnapshotInput(sourceDir, async (entry) => {
		const at = join(target, entry.rel);
		if (entry.kind === "directory") {
			await mkdir(at, {
				recursive: true,
				mode: entry.mode
			});
			return;
		}
		await mkdir(dirname(at), { recursive: true });
		await writeFile(at, entry.bytes, { mode: entry.mode });
	});
	const real = await realpath(target);
	const digest = await directoryDigest(real);
	if (digest !== snapshotDigest) throw new Error(`the workspace "${real}" was built from the frozen snapshot but hashes to ${digest}, not the frozen ${snapshotDigest}; the build did not reproduce the frozen input, so nothing runs in it`);
	return real;
}
function runFactsOf(snapshot, task, settled) {
	const runId = settled?.runId ?? task.runIds[task.runIds.length - 1];
	const run = runId === void 0 ? void 0 : snapshot.runs.find((item) => item.runId === runId);
	const review = runId === void 0 ? void 0 : snapshot.reviews.find((item) => item.runId === runId);
	const outcome = review !== void 0 && TERMINAL_RUN_STATUSES.includes(review.outcome) ? review.outcome : run !== void 0 && TERMINAL_RUN_STATUSES.includes(run.status) ? run.status : void 0;
	const detail = runId === void 0 ? "the store holds no run of this side's task" : run === void 0 ? `the store holds no run "${runId}" of this side's task` : `the store holds run ${run.runId} as ${run.status}${run.executionPhase === void 0 ? "" : ` (${run.executionPhase})`} with no terminal review record`;
	return {
		outcome: outcome === void 0 ? "interrupted" : outcome,
		taskId: task.taskId,
		...runId === void 0 ? {} : { runId },
		...review === void 0 ? {} : { review },
		criteria: criteriaOf(review, settled),
		evidenceRefs: evidenceRefsOf(snapshot, runId, review),
		terminal: outcome !== void 0,
		detail
	};
}
/** The one ledger line a sample side writes, from the facts its run settled to. */
function sampleRecord(input) {
	return {
		formatVersion: 4,
		kind: "experiment_sample",
		proposalId: input.view.proposalId,
		experimentId: input.view.experimentId,
		preparedContentDigest: preparedContentDigestOf(input.view.frozen.candidate),
		sampleTaskId: input.sample.taskId,
		side: input.side,
		repetition: input.view.frozen.repetition,
		...input.taskId === void 0 ? {} : { taskId: input.taskId },
		...input.runId === void 0 ? {} : { runId: input.runId },
		outcome: input.outcome,
		...input.review === void 0 ? {} : { reviewRef: reviewRefOf(input.review) },
		evidenceRefs: [...input.evidenceRefs],
		criteria: input.criteria,
		workspace: input.workspace,
		...input.initialDigest === void 0 ? {} : { initialDigest: input.initialDigest },
		cost: input.cost,
		...input.reason === void 0 ? {} : { reason: input.reason },
		actor: input.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/**
* One sample side that has a run in the store but no record: a process died
* between starting the run and recording it. The store's terminal state is what
* gets recorded — as it stands, never re-run. A run that never settled is
* recorded `interrupted` with the store's own description of where it stands,
* and the workspace's frozen digest is the one it was built from (the run has
* written into the directory since; see the module doc).
*/
function recoveredSampleRecord(input) {
	const facts = runFactsOf(input.snapshot, input.task, void 0);
	if (!facts.terminal) return sampleRecord({
		view: input.view,
		sample: input.sample,
		side: input.side,
		outcome: "interrupted",
		...facts.taskId === void 0 ? {} : { taskId: facts.taskId },
		...facts.runId === void 0 ? {} : { runId: facts.runId },
		criteria: [],
		evidenceRefs: [],
		workspace: input.workspace,
		cost: {
			status: "unknown",
			reason: "the run never settled, so it reported no cost"
		},
		reason: `${facts.detail} — the experiment settles what the store holds and never re-runs an in-flight sample; resume it, or freeze a new experiment at a higher repetition, to run this side again`,
		actor: input.actor
	});
	return sampleRecord({
		view: input.view,
		sample: input.sample,
		side: input.side,
		outcome: facts.outcome,
		...facts.taskId === void 0 ? {} : { taskId: facts.taskId },
		...facts.runId === void 0 ? {} : { runId: facts.runId },
		...facts.review === void 0 ? {} : { review: facts.review },
		criteria: facts.criteria,
		evidenceRefs: facts.evidenceRefs,
		workspace: input.workspace,
		initialDigest: input.view.frozen.snapshot.digest,
		cost: costOf(facts.review),
		actor: input.actor
	});
}
/** One side's detail as the report carries it, read off the ledger record and nothing else. */
function sideDetailOf(view, sample, side) {
	const record = view.samples.find((item) => item.sampleTaskId === sample.taskId && item.side === side);
	if (record === void 0) throw new Error(`experiment: sample ${sample.taskId}/${side} has no record`);
	return {
		...record.taskId === void 0 ? {} : { taskId: record.taskId },
		role: sample.role,
		side,
		outcome: record.outcome,
		...record.runId === void 0 ? {} : { runId: record.runId },
		...record.reviewRef === void 0 ? {} : { reviewRef: record.reviewRef },
		evidenceRefs: [...record.evidenceRefs],
		workspace: record.workspace,
		...record.initialDigest === void 0 ? {} : { initialDigest: record.initialDigest },
		criteria: record.criteria.map(criterionDetail),
		cost: record.cost,
		...record.reason === void 0 ? {} : { reason: record.reason }
	};
}
/** The key one frozen sample's side has under one experiment. */
function experimentSampleKeyOf(view, sampleTaskId, side) {
	return {
		proposalId: view.proposalId,
		preparedContentDigest: preparedContentDigestOf(view.frozen.candidate),
		sampleTaskId,
		side,
		repetition: view.frozen.repetition
	};
}
/**
* Build the v3 report from the ledger records alone — the same records always
* give the same report, its `at` included. An experiment missing a side has no
* report: an incomplete comparison is not evidence, and saying so is the honest
* answer.
*/
function buildExperimentReport(view) {
	const missing = view.frozen.samples.flatMap((sample) => EXPERIMENT_SIDES.filter((side) => !view.samples.some((item) => item.sampleTaskId === sample.taskId && item.side === side)).map((side) => `${sample.taskId}/${side}`));
	if (missing.length > 0) throw new Error(`experiment ${view.experimentId} is incomplete — no record for ${missing.join(", ")}; the settled runs stay recorded`);
	const samples = view.frozen.samples.map((sample) => {
		const baseline = sideDetailOf(view, sample, "baseline");
		const candidate = sideDetailOf(view, sample, "candidate");
		return {
			taskId: sample.taskId,
			role: sample.role,
			baseline,
			candidate,
			verdict: compareExperimentSides(sample.role, baseline, candidate)
		};
	});
	const at = [view.at, ...view.samples.map((record) => record.at)].reduce((left, right) => left > right ? left : right);
	const report = {
		formatVersion: 3,
		proposalId: view.proposalId,
		experimentId: view.experimentId,
		at,
		frozen: view.frozen,
		frozenDigest: view.frozenDigest,
		samples,
		verdict: overallExperimentVerdict(samples)
	};
	assertExperimentReport(report);
	return report;
}
/** The store one experiment reads: the caller's graph root, exactly as the v1 replay resolves it. */
async function experimentStore(sources, caller) {
	try {
		const storeId = rootTaskStoreId((await sources.graphs.graphForSession(caller)).rootSessionId);
		return {
			storeId,
			snapshot: await sources.task.openStore(storeId)
		};
	} catch (error) {
		throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`);
	}
}
/**
* The token total one settled side reported: the four buckets the run's own
* session projection carries, summed exactly the way the runtime's own post-hoc
* budget check sums them (`budgetBreaches`). `undefined` for a side that
* reported none — what nobody reported adds nothing to what is known, and is
* never read as a zero.
*/
function tokensOfRecord(record) {
	if (record.cost.status !== "reported") return void 0;
	const tokens = record.cost.metrics.tokens;
	if (tokens === void 0 || typeof tokens !== "object") return void 0;
	const total = tokens.uncachedInputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens;
	return Number.isFinite(total) && total >= 0 ? total : void 0;
}
/** The known token total of a set of settled sides: every reported four-bucket sum, added up. */
function reportedTokensSpent(records) {
	return records.reduce((sum, record) => sum + (tokensOfRecord(record) ?? 0), 0);
}
/**
* Whether the frozen budget still leaves room for one more side to start (S4-E
* §F.2; the progress review's Q1: the maximum bounds the *whole experiment*, not
* one side).
*
* `maxTokens` is the one ceiling: the sides already settled report a known
* total, and no further side is started once that total has consumed the
* ceiling. The next side's own spend is not knowable before it settles, so
* starting one into an exhausted budget could only overshoot, and the promotion
* gate refuses a recorded total above the ceiling either way.
*
* The refusal is named and carries the numbers; the settled runs stay in the
* task store and the ledger as what this experiment spent.
*/
function assertBudgetAllowsStart(input) {
	const { experimentId, budget, spentTokens, settledSides, where } = input;
	if (budget.maxTokens !== void 0 && spentTokens >= budget.maxTokens) {
		const left = budget.maxTokens - spentTokens;
		const position = left > 0 ? `${left} tokens left` : left === 0 ? "the ceiling exactly consumed" : `${-left} over the ceiling`;
		throw new Error(`evolution: experiment "${experimentId}" is stopped by its frozen budget — maxTokens ${budget.maxTokens} is the whole experiment's ceiling and its ${settledSides} settled side(s) already report ${spentTokens} tokens (${position}), so no further sample side is started (${where} would have been next); the settled runs stay in the task store and the ledger as what this experiment spent, and a promotion whose recorded total passes the ceiling is refused rather than inferred`);
	}
}
/**
* Run — or continue — the frozen two-sided experiment, and return the report the
* ledger records. Idempotent per sample key: a recorded side is reused, an
* in-flight side is settled from the store and never re-run, and only a side
* that never ran is started. Every refusal throws with its reason, and the runs
* that did settle stay in the task store and in the ledger.
*
* The frozen budget bounds this whole experiment on the one entry point this
* plane has: the token total the settled sides reported. A side the budget has no
* room for is not started, and the refusal names the ceiling and the recorded
* total; what a settled side really spent is the gate's half of the same rule.
* Each Run's clock is the runtime's own — this plane places none.
*/
async function runExperiment(sources, request) {
	const { spec, caller, actor } = request;
	validateSpec(spec);
	const { sandbox, candidate, proposal } = await experimentCandidate(sources, spec.proposalId);
	const { storeId, snapshot } = await experimentStore(sources, caller);
	const vocabulary = await sources.verifierVocabulary?.();
	const samples = [];
	for (const sample of spec.samples) {
		const task = snapshot.tasks.find((item) => item.taskId === sample.taskId);
		if (task === void 0) throw new Error(`unknown sample task "${sample.taskId}" in this graph's task store`);
		if (task.status !== "verified" && task.status !== "failed") throw new Error(`sample "${sample.taskId}" is ${task.status}; only a terminal (verified or failed) sample can be evaluated`);
		const review = latestReview(snapshot, task);
		if (review === void 0) throw new Error(`sample "${sample.taskId}" has no review record on its latest run; there is no case to reproduce`);
		assertSampleRole(sample, task, review);
		const provider = await frozenProviderIdentity({
			sources,
			caller,
			sampleTaskId: sample.taskId,
			required: task.requestedCapabilities,
			candidate,
			where: `sample "${sample.taskId}"`
		});
		samples.push(frozenSampleOf$1(sample, task, review, provider, vocabulary));
	}
	const frozen = freezeExperiment({
		proposalId: spec.proposalId,
		spec,
		candidate,
		...proposal.prepared?.skillBaseline === void 0 ? {} : { productionBaseline: proposal.prepared.skillBaseline },
		sandbox,
		snapshotDigest: await directoryDigest(spec.snapshot.sourceDir),
		samples
	});
	const agentOptions = agentOptionsOf(frozen.model);
	const frozenDigest = frozenDigestOf(frozen);
	const experimentId = experimentIdOf(spec.proposalId, frozenDigest);
	const sandboxRel = `${sandbox}/exp-${experimentId}`;
	const recorded = /* @__PURE__ */ new Map();
	for (const previous of await sources.evolution.experiments(spec.proposalId)) for (const record of previous.samples) recorded.set(experimentSampleKey(record), record);
	for (const sample of frozen.samples) for (const side of EXPERIMENT_SIDES) {
		const key = experimentSampleKeyOf({
			proposalId: spec.proposalId,
			frozen
		}, sample.taskId, side);
		const prior = recorded.get(experimentSampleKey(key));
		if (prior !== void 0 && prior.experimentId !== experimentId) throw sameKeyRefusal(key, prior, experimentId);
	}
	await sources.evolution.recordExperimentStart({
		formatVersion: 4,
		kind: "experiment_started",
		proposalId: spec.proposalId,
		experimentId,
		frozen,
		frozenDigest,
		budget: { ...frozen.budget },
		report: experimentReportPath(spec.proposalId, experimentId),
		storeId,
		actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	});
	const view = await sources.evolution.experiment(experimentId);
	const budget = view.frozen.budget;
	let spentTokens = reportedTokensSpent(view.samples);
	let settledSides = view.samples.length;
	let started = 0;
	try {
		sampleLoop: for (const sample of view.frozen.samples) for (const side of EXPERIMENT_SIDES) {
			const key = experimentSampleKeyOf(view, sample.taskId, side);
			const lineage = experimentLineage(view.experimentId, sample.taskId, side);
			const workspace = resolve(sources.evolution.root, sandboxRel, sample.taskId, side);
			const prior = recorded.get(experimentSampleKey(key));
			if (prior !== void 0) {
				assertRecordedRunOrigin(snapshot, lineage, key, prior);
				continue;
			}
			if (request.signal?.aborted) break sampleLoop;
			const inFlight = snapshot.tasks.find((item) => item.objective.startsWith(`[${lineage}] `));
			if (inFlight !== void 0) {
				const recovered = recoveredSampleRecord({
					view,
					sample,
					side,
					task: inFlight,
					snapshot,
					workspace,
					actor
				});
				await sources.evolution.recordExperimentSample(recovered);
				recorded.set(experimentSampleKey(key), recovered);
				spentTokens += tokensOfRecord(recovered) ?? 0;
				settledSides += 1;
				continue;
			}
			assertBudgetAllowsStart({
				experimentId: view.experimentId,
				budget,
				spentTokens,
				settledSides,
				where: `sample "${sample.taskId}" ${side} side`
			});
			const real = await buildWorkspace(spec.snapshot.sourceDir, workspace, view.frozen.snapshot.digest);
			const outcome = await sources.taskRuntime.replayTask(storeId, sample.taskId, {
				lineage,
				workspace: { path: real },
				agentOptions: { ...agentOptions },
				...side === "candidate" ? { overlay: { extraSkillRoots: [resolve(sources.evolution.root, sandbox, "skills")] } } : {},
				...request.signal === void 0 ? {} : { signal: request.signal }
			}, caller);
			if (outcome.workspace !== void 0 && outcome.workspace !== real) throw new Error(`the replay of "${sample.taskId}" reported workspace "${outcome.workspace}" but was given "${real}"; a side's frozen input and the directory its run went through must be the same directory`);
			const after = await sources.task.openStore(storeId);
			const replayed = after.tasks.find((item) => item.taskId === outcome.taskId);
			if (replayed === void 0) throw new Error(`the replay of "${sample.taskId}" created task "${outcome.taskId}", which the store does not hold`);
			const facts = runFactsOf(after, replayed, outcome);
			const fresh = sampleRecord({
				view,
				sample,
				side,
				outcome: facts.outcome,
				...facts.taskId === void 0 ? {} : { taskId: facts.taskId },
				...facts.runId === void 0 ? {} : { runId: facts.runId },
				...facts.review === void 0 ? {} : { review: facts.review },
				criteria: facts.criteria,
				evidenceRefs: facts.evidenceRefs,
				workspace: real,
				initialDigest: view.frozen.snapshot.digest,
				cost: costOf(facts.review),
				actor
			});
			await sources.evolution.recordExperimentSample(fresh);
			recorded.set(experimentSampleKey(key), fresh);
			spentTokens += tokensOfRecord(fresh) ?? 0;
			settledSides += 1;
			started += 1;
			if (facts.outcome === "cancelled") break sampleLoop;
		}
	} catch (error) {
		const message$1 = error instanceof Error ? error.message : String(error);
		if (started === 0) throw error instanceof Error ? error : new Error(message$1);
		throw new Error(`${message$1} (the experiment stopped; ${started} sample run(s) it started settled and stay in the ledger and the task store as evidence — resume experiment ${experimentId} to continue it)`);
	}
	const finalView = await sources.evolution.experiment(experimentId);
	let report;
	try {
		report = buildExperimentReport(finalView);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)} — resume experiment ${experimentId} to continue it`);
	}
	const abs = resolve(sources.evolution.root, finalView.report);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	return {
		proposalId: finalView.proposalId,
		experimentId,
		report,
		reportPath: finalView.report,
		experiment: finalView
	};
}
/**
* Resume a frozen experiment by id: its specification *is* the frozen block, so
* a caller needs to remember nothing but the id. The block is re-derived from
* the current world before anything runs, and the re-derivation must reproduce
* the recorded one — a candidate, a sample contract, a model or a snapshot that
* moved since the experiment froze is refused by name rather than run under a
* different identity.
*/
async function resumeExperiment(sources, request) {
	const view = await sources.evolution.experiment(request.experimentId);
	return runExperiment(sources, {
		spec: {
			proposalId: view.proposalId,
			samples: view.frozen.samples.map((sample) => ({
				taskId: sample.taskId,
				role: sample.role
			})),
			snapshot: { sourceDir: view.frozen.snapshot.sourceDir },
			model: view.frozen.model,
			budget: view.frozen.budget,
			repetition: view.frozen.repetition
		},
		caller: request.caller,
		actor: request.actor,
		...request.signal === void 0 ? {} : { signal: request.signal }
	});
}
/**
* A recorded sample that cites a run this experiment did not create is refused:
* the historical champion locates the case and is never a baseline, so a record
* whose run no run of this experiment's own lineage created is not reused, and
* nothing downstream is allowed to read it as evidence.
*/
function assertRecordedRunOrigin(snapshot, lineage, key, record) {
	if (record.runId === void 0) return;
	const task = snapshot.tasks.find((item) => item.objective.startsWith(`[${lineage}] `));
	if (task === void 0 || !task.runIds.includes(record.runId)) throw new Error(`experiment: the recorded sample ${experimentSampleLabel(key)} cites run "${record.runId}", which no run of this experiment's own replay (lineage ${lineage}) created — the historical record locates the case and is never a baseline; the record and the store disagree, so nothing here is reused`);
}
/** One sample key a different frozen experiment already spent (§F.2: a re-run needs an explicit new experiment). */
function sameKeyRefusal(key, prior, experimentId) {
	return /* @__PURE__ */ new Error(`experiment: sample ${experimentSampleLabel(key)} is already recorded by experiment ${prior.experimentId} (frozen at ${prior.at}), which is not this one (${experimentId}) — the key is spent and its record is never overwritten; freeze a new experiment at a higher repetition to run this side again`);
}
/**
* Validate one `experiment_started` line in its own right: the proposal it names
* exists, the experiment id, frozen digest, budget and report path are exactly
* what the frozen block derives. Used by the fold and by the service's own write
* path, so a line that reaches the append is checked the same way one read back
* from the file is.
*/
function assertExperimentStartRecord(record, proposals) {
	if (proposals.get(record.proposalId) === void 0) throw new Error(`evolution: experiment_started record for unknown proposal "${record.proposalId}"`);
	if (typeof record.experimentId !== "string" || !/^[a-f0-9]{16}$/.test(record.experimentId)) throw new Error(`evolution: experiment_started record for "${record.proposalId}" has an invalid experiment id`);
	assertFrozenExperiment(record.frozen);
	if (record.frozen.proposalId !== record.proposalId) throw new Error(`evolution: experiment_started record for "${record.proposalId}" freezes proposal "${record.frozen.proposalId}"`);
	if (record.frozenDigest !== frozenDigestOf(record.frozen)) throw new Error(`evolution: experiment_started record for "${record.proposalId}" has a digest that does not match its frozen block`);
	if (canonicalJson(record.budget) !== canonicalJson(record.frozen.budget)) throw new Error(`evolution: experiment_started record for "${record.proposalId}" carries a budget that is not the frozen one`);
	if (record.experimentId !== experimentIdOf(record.proposalId, record.frozenDigest)) throw new Error(`evolution: experiment_started record for "${record.proposalId}" has an id that does not match its frozen identity`);
	if (record.report !== experimentReportPath(record.proposalId, record.experimentId)) throw new Error(`evolution: experiment_started record for "${record.proposalId}" names a report path outside its own sandbox`);
	if (record.storeId !== void 0 && (typeof record.storeId !== "string" || record.storeId.length === 0)) throw new Error(`evolution: experiment_started record for "${record.proposalId}" has a malformed task store id`);
	nonEmpty$1(record.actor, "experiment_started actor");
	nonEmpty$1(record.at, "experiment_started at");
}
function assertSampleCriteria(criteria, field) {
	if (!Array.isArray(criteria)) throw new Error(`evolution: ${field} must be an array`);
	const ids = /* @__PURE__ */ new Set();
	for (const criterion of criteria) {
		if (criterion === null || typeof criterion !== "object" || typeof criterion.criterionId !== "string" || criterion.criterionId.length === 0 || ![
			"pass",
			"fail",
			"inconclusive"
		].includes(criterion.verdict) || ids.has(criterion.criterionId)) throw new Error(`evolution: ${field} has an invalid or duplicate criterion verdict`);
		const detail = criterion;
		for (const member of [
			"verifierId",
			"verifierVersion",
			"command"
		]) if (detail[member] !== void 0 && (typeof detail[member] !== "string" || detail[member].length === 0)) throw new Error(`evolution: ${field} has a malformed ${member}`);
		if (detail.exitCode !== void 0 && typeof detail.exitCode !== "number") throw new Error(`evolution: ${field} has a malformed exit code`);
		ids.add(detail.criterionId);
	}
}
function assertExperimentSample(record, view, key) {
	const field = `experiment_sample record for ${experimentSampleLabel(key)}`;
	if (view === void 0) throw new Error(`evolution: ${field} names unknown experiment "${record.experimentId}"`);
	if (view.proposalId !== record.proposalId) throw new Error(`evolution: ${field} names a different proposal than its experiment`);
	if (record.preparedContentDigest !== preparedContentDigestOf(view.frozen.candidate)) throw new Error(`evolution: ${field} names a candidate content identity that is not the experiment's own`);
	if (record.repetition !== view.frozen.repetition) throw new Error(`evolution: ${field} names a repetition that is not the experiment's own`);
	if (!view.frozen.samples.some((sample) => sample.taskId === record.sampleTaskId)) throw new Error(`evolution: ${field} names sample "${record.sampleTaskId}", which the experiment never froze`);
	if (!EXPERIMENT_SIDES.includes(record.side)) throw new Error(`evolution: ${field} has an unknown side "${String(record.side)}"`);
	if (![
		"verified",
		"failed",
		"cancelled",
		"interrupted"
	].includes(record.outcome)) throw new Error(`evolution: ${field} has an unknown outcome "${String(record.outcome)}"`);
	for (const member of [
		"taskId",
		"runId",
		"reviewRef"
	]) if (record[member] !== void 0 && (typeof record[member] !== "string" || record[member].length === 0)) throw new Error(`evolution: ${field} has a malformed ${member}`);
	if (typeof record.workspace !== "string" || record.workspace.length === 0) throw new Error(`evolution: ${field} names no workspace`);
	if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)) throw new Error(`evolution: ${field} has a malformed evidence ref list`);
	assertSampleCriteria(record.criteria, `${field} criteria`);
	if (record.cost === null || typeof record.cost !== "object") throw new Error(`evolution: ${field} has no cost`);
	if (record.cost.status === "unknown") {
		if (typeof record.cost.reason !== "string" || record.cost.reason.length === 0) throw new Error(`evolution: ${field} reports an unknown cost without saying why`);
	} else if (record.cost.status !== "reported" || record.cost.metrics === null || typeof record.cost.metrics !== "object") throw new Error(`evolution: ${field} has a malformed cost report`);
	if (record.outcome === "interrupted") {
		if (typeof record.reason !== "string" || record.reason.length === 0) throw new Error(`evolution: ${field} is interrupted and must carry the reason it has no terminal run`);
		return;
	}
	if (record.initialDigest === void 0 || !isHex64(record.initialDigest)) throw new Error(`evolution: ${field} settled a run and must carry the frozen digest its workspace was built from`);
}
/**
* Fold the ledger's experiment family: every `experiment_started` opens an
* experiment, every `experiment_sample` must belong to one, and the sample key
* is unique across the whole ledger. A hand-forged line fails exactly the checks
* a live write passes — the frozen block is re-hashed, the id re-derived, the
* budget re-compared, and the record's key parts re-checked against the
* experiment it claims — so the read path and the write path agree on what a
* record is.
*
* The proposal fold is the other half of the same ledger and is not this
* function's business; the caller passes its result in for the one cross-check
* that spans the two (`experiment_started` must name a real proposal).
*/
function foldExperiments(records, proposals) {
	const views = /* @__PURE__ */ new Map();
	const keys = /* @__PURE__ */ new Set();
	for (const raw of records) {
		if (!isExperimentRecord(raw)) continue;
		const record = raw;
		if (record.kind === "experiment_started") {
			if (views.has(record.experimentId)) throw new Error(`evolution: experiment "${record.experimentId}" is recorded twice`);
			assertExperimentStartRecord(record, proposals);
			views.set(record.experimentId, {
				experimentId: record.experimentId,
				proposalId: record.proposalId,
				frozen: record.frozen,
				frozenDigest: record.frozenDigest,
				budget: record.budget,
				report: record.report,
				...record.storeId === void 0 ? {} : { storeId: record.storeId },
				at: record.at,
				samples: []
			});
			continue;
		}
		const view = views.get(record.experimentId);
		const key = {
			proposalId: record.proposalId,
			preparedContentDigest: record.preparedContentDigest,
			sampleTaskId: record.sampleTaskId,
			side: record.side,
			repetition: record.repetition
		};
		assertExperimentSample(record, view, key);
		const id = experimentSampleKey(key);
		if (keys.has(id)) throw new Error(`evolution: sample ${experimentSampleLabel(key)} is recorded twice; a recorded run is never overwritten or re-run`);
		keys.add(id);
		view.samples.push(record);
	}
	return views;
}

//#endregion
//#region src/promotion.ts
/**
* Whether two object identities are the same identity, member by member (K3):
* the name, the `SKILL.md` digest, and — exactly when the object carries an
* execution sidecar — the sidecar's exact-byte digest and its canonical
* declaration digest. Presence itself is compared, so a guidance identity never
* equals an execution one even if both digests happen to sound similar.
*/
function sameIdentity(left, right) {
	if (left.name !== right.name || left.sha256 !== right.sha256) return false;
	if (left.contract === void 0 !== (right.contract === void 0)) return false;
	if (left.contract === void 0 || right.contract === void 0) return true;
	return left.contract.sha256 === right.contract.sha256 && left.contract.contractDigest === right.contract.contractDigest;
}
/** One identity as a refusal names it, sidecar half included. */
function identityLabel(identity) {
	const base = `${identity.name}@${identity.sha256}`;
	return identity.contract === void 0 ? base : `${base} + ${identity.contract.sha256} (declaration ${identity.contract.contractDigest})`;
}
function sha256Hex$1(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/**
* The refusal every other target type gets: no evaluator, no promotion. This
* build evaluates a replacement of an existing skill object's bytes;
* capability, agent_preset, task_definition, the bookkeeping-only types and L4
* have no evidence this gate could read, so no record of one is reused to
* promote it (§F.2: "没有支持的评估器就拒绝新晋升"). Their records stay
* readable.
*/
function noEvaluatorRefusal(proposal) {
	return /* @__PURE__ */ new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}", which has no evaluator in this build — the two-sided experiment (§F.2) evaluates a replacement of an existing skill object only, and a promotion without supported evaluation evidence is refused rather than granted from an older record.`);
}
/** The refusal of a skill proposal nothing has evaluated yet. */
function noExperimentRefusal(proposal) {
	return /* @__PURE__ */ new Error(`evolution: skill proposal "${proposal.proposalId}" carries no two-sided experiment — a PROMOTE needs both sides of every frozen sample run as this experiment's own new runs; evaluate the candidate with evolution_replay before promoting it`);
}
/** One verdict's refusal text: the six outcomes §F.2 makes distinguishable, each named for what it means. */
const VERDICT_REFUSALS = {
	"fixed": "",
	"fixed-with-regression": "the target failure is fixed, but a regression or holdout sample degraded under the candidate",
	"regressed": "a regression or holdout sample degraded and the target failure is not fixed",
	"not-fixed": "the candidate did not fix the target failure",
	"both-failed": "the target failure was reproduced on the baseline and still fails on the candidate (both sides failed)",
	"inconclusive": "the experiment could not settle, so it says nothing about the candidate"
};
/** `sample <taskId> [<role>]: <verdict>` per sample — the detail a verdict refusal carries. */
function sampleVerdictLines(samples) {
	return samples.map((sample) => `sample ${sample.taskId} [${sample.role}]: ${sample.verdict}`);
}
/** The report's byte serialization, exactly as the orchestrator writes it. */
function reportBytes(report) {
	return `${JSON.stringify(report, null, 2)}\n`;
}
/**
* Whether one report side's evidence exists in the store as the side says it
* does: a replayed task of this experiment's own lineage whose run this side
* cites, the review record that settles that run with the outcome and criteria
* the side reports, and the evidence bundles that run produced.
*/
function assertSideEvidence(input) {
	const { sample, detail, experimentId, snapshot, where } = input;
	if (detail.outcome === "interrupted") return void 0;
	const lineage = experimentLineage(experimentId, sample.taskId, detail.side);
	const task = snapshot.tasks.find((item) => item.objective?.startsWith(`[${lineage}] `));
	if (task === void 0) throw new Error(`evolution: the experiment report's ${where} does not cite a replayed task this experiment created — the store holds no task of lineage "${lineage}" (${detail.taskId ?? "no task"}/${detail.runId ?? "no run"}); a side that is not one of this experiment's own runs is not a baseline, whatever the record says`);
	if (detail.taskId !== task.taskId) throw new Error(`evolution: the experiment report's ${where} names task "${String(detail.taskId)}" but the run it cites belongs to replayed task "${task.taskId}" of this experiment's own lineage — the identity a promotion reads must be the task the run ran as`);
	if (detail.runId === void 0 || !task.runIds.includes(detail.runId)) throw new Error(`evolution: the experiment report's ${where} cites run "${String(detail.runId)}", which no run of this experiment's own replay (lineage ${lineage}) created — the historical record locates the case and is never a baseline`);
	const runId = detail.runId;
	const review = snapshot.reviews.find((item) => item.runId === runId);
	if (review === void 0) throw new Error(`evolution: the experiment report's ${where} cites run "${runId}", which the store settles with no review record — a side without a terminal review record is not a settled run`);
	if (review.taskId !== task.taskId) throw new Error(`evolution: the review record for run "${runId}" belongs to task "${review.taskId}", not the replayed task "${task.taskId}" the experiment report's ${where} cites`);
	if (review.outcome !== detail.outcome) throw new Error(`evolution: the experiment report's ${where} reports outcome "${detail.outcome}" but the store's review record for run "${runId}" settled "${review.outcome}" — the report and the store disagree about what ran`);
	if (detail.reviewRef !== `${task.taskId}#${runId}`) throw new Error(`evolution: the experiment report's ${where} cites review ref "${String(detail.reviewRef)}" but its run "${runId}" settles as "${task.taskId}#${runId}" — the reference a promotion reads must name the record that exists`);
	const recorded = review.criteria ?? [];
	const reported = detail.criteria;
	if (recorded.length > 0) {
		const byId = new Map(recorded.map((criterion) => [criterion.criterionId, criterion]));
		for (const criterion of reported) {
			const stored = byId.get(criterion.criterionId);
			if (stored === void 0) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}", which the store's review record for run "${runId}" does not carry`);
			if (stored.verdict !== criterion.verdict || stored.verifierId !== criterion.verifierId || stored.verifierVersion !== criterion.verifierVersion) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" as ${criterion.verdict}${criterion.verifierId === void 0 ? "" : ` (${criterion.verifierId}${criterion.verifierVersion === void 0 ? "" : `@${criterion.verifierVersion}`})`}, but run "${runId}" settled it as ${stored.verdict}${stored.verifierId === void 0 ? "" : ` (${stored.verifierId}${stored.verifierVersion === void 0 ? "" : `@${stored.verifierVersion}`})`} — the verdicts a promotion reads are the ones the store recorded`);
		}
		if (reported.length !== recorded.length) throw new Error(`evolution: the experiment report's ${where} carries ${reported.length} criterion verdicts while run "${runId}" settled ${recorded.length} — a side must report exactly the criteria its review record carries`);
	}
	const expected = evidenceRefsOf(snapshot, runId, review);
	const reportedRefs = [...detail.evidenceRefs].sort();
	const storedRefs = [...expected].sort();
	if (reportedRefs.length !== storedRefs.length || reportedRefs.some((ref, index) => ref !== storedRefs[index])) throw new Error(`evolution: the experiment report's ${where} cites evidence [${detail.evidenceRefs.join(", ")}] but run "${runId}" holds [${expected.join(", ")}] — the evidence a promotion reads must be the bundles that run produced`);
	for (const ref of detail.evidenceRefs) {
		const bundle = snapshot.evidence.find((item) => item.evidenceId === ref);
		if (bundle === void 0) throw new Error(`evolution: the experiment report's ${where} cites evidence "${ref}", which the store does not hold`);
		if (bundle.taskRunId !== runId) throw new Error(`evolution: the experiment report's ${where} cites evidence "${ref}" of run "${String(bundle.taskRunId)}", not of its own run "${runId}" — evidence from another run cannot stand for this side`);
	}
	if (detail.initialDigest === void 0) throw new Error(`evolution: the experiment report's ${where} settled a run and records no workspace digest — the frozen input the side ran from cannot be re-proved`);
	return task;
}
/** The store's contract of one sample, as the freeze derived its digest: objective, criteria, required capabilities. */
function contractDigestOf(task) {
	return digestOf({
		objective: task.objective,
		acceptanceCriteria: task.acceptanceCriteria,
		requiredCapabilities: task.requestedCapabilities
	});
}
/**
* Whether one frozen sample still stands as it was frozen: the store's contract
* hashes to the frozen digest, every frozen criterion is still there with the
* same mode, command and protected-input identity, and every declared protected
* input still holds the bytes it was fixed against — re-read in the production
* workspace the experiment froze, with the same rule the verifier's own
* pre-judgement check uses (`resolve(cwd, path)`, byte digest, a missing or
* changed input is a defect).
*/
async function assertSampleInputsIntact(input) {
	const { sample, snapshot, productionWorkspace } = input;
	const task = snapshot.tasks.find((item) => item.taskId === sample.taskId);
	if (task === void 0) throw new Error(`evolution: the experiment froze sample "${sample.taskId}", which this graph's task store no longer holds — the case the candidate was evaluated against cannot be re-read, so the evidence cannot be re-checked`);
	const digest = contractDigestOf(task);
	if (digest !== sample.contractDigest) throw new Error(`evolution: sample "${sample.taskId}" changed since the experiment froze it (contract digest ${digest} != ${sample.contractDigest}) — the case, its acceptance or its required capabilities moved, so the runs on record were judged against a contract this proposal is no longer evaluated against`);
	const criteria = Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [];
	for (const frozen of sample.criteria) {
		const criterion = criteria.find((item) => item.criterionId === frozen.criterionId);
		if (criterion === void 0) throw new Error(`evolution: sample "${sample.taskId}" no longer carries the frozen criterion "${frozen.criterionId}"`);
		assertFrozenCriterionIntact(sample.taskId, frozen, criterion);
		for (const protectedInput of criterion.protectedInputs ?? []) await assertProtectedInputIntact(sample.taskId, protectedInput, productionWorkspace);
	}
}
/** One criterion's frozen identity against the store's current one. */
function assertFrozenCriterionIntact(taskId, frozen, criterion) {
	const currentDigest = protectedInputsDigest(criterion.protectedInputs ?? []);
	if (criterion.verificationMode !== frozen.verificationMode || criterion.command !== frozen.command || currentDigest !== frozen.protectedInputsDigest) throw new Error(`evolution: criterion "${frozen.criterionId}" of sample "${taskId}" changed since the experiment froze it (mode ${String(criterion.verificationMode)}/${frozen.verificationMode}, protected inputs ${currentDigest} != ${frozen.protectedInputsDigest}) — the acceptance the two sides ran under is no longer the frozen one`);
}
/** One declared protected input, re-read where the criterion's judge would read it. */
async function assertProtectedInputIntact(taskId, input, productionWorkspace) {
	let bytes;
	try {
		bytes = await readFile(resolve(productionWorkspace, input.path));
	} catch (error) {
		throw new Error(`evolution: the protected input "${input.path}" of sample "${taskId}" cannot be read in the production workspace "${productionWorkspace}" (${error instanceof Error ? error.message : String(error)}) — the input the acceptance rests on is gone, so the experiment's judging cannot be re-proved`);
	}
	const digest = sha256Hex$1(bytes);
	if (digest !== input.sha256) throw new Error(`evolution: the protected input "${input.path}" of sample "${taskId}" changed since the experiment froze it (sha256 ${digest} != ${input.sha256}) — a criterion whose input moved is not the criterion the candidate was judged by`);
}
/**
* Whether every criterion verdict a report side carries was decided by the
* judge the frozen block fixed *before* the run (S4-E §Q3), and whether that
* judge is still the registered instance it was.
*
* The frozen half: a criterion was frozen with a registered, versioned
* `verifierRef` — the freeze refuses anything else — so the verdict must name
* that ref, at exactly the frozen version. Re-registering a same-named judge
* with a new version after the freeze is a refusal that names the frozen value.
* The registry half then re-checks that the judge the verdict names is still
* registered at the version it judged with. Fail-closed: a deployment that
* cannot list its verifier vocabulary refuses rather than assuming the judge is
* there.
*/
function assertJudgeUnchanged(sample, detail, where, vocabulary) {
	const frozenById = new Map(sample.criteria.map((criterion) => [criterion.criterionId, criterion]));
	for (const criterion of detail.criteria) {
		const frozen = frozenById.get(criterion.criterionId);
		if (frozen === void 0) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" of sample "${sample.taskId}", which the frozen block does not carry — a verdict outside the frozen acceptance is not evidence this promotion may read`);
		if (criterion.verifierId === void 0) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" without the verifier that decided it — a verdict nobody can be recalled against is not evidence a promotion may read`);
		if (criterion.verifierId !== frozen.verifierRef) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by verifier "${criterion.verifierId}", but the frozen block pinned "${frozen.verifierRef}" (${frozen.verifierAnchor}) — the verdicts a promotion reads must be the ones the frozen judge produced`);
		if (criterion.verifierVersion !== frozen.verifierVersion) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by "${frozen.verifierRef}" at version ${criterion.verifierVersion === void 0 ? "(none declared)" : criterion.verifierVersion}, but the block froze it at ${frozen.verifierVersion} (${frozen.verifierAnchor}) — a verdict belongs to the instance that judged, so a judge that moved since the freeze invalidates the evidence`);
		if (!vocabulary.ids.includes(criterion.verifierId)) throw new Error(`evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}", which is no longer registered (registered: ${vocabulary.ids.length === 0 ? "none" : vocabulary.ids.join(", ")}) — the judge moved, so the verdicts on record cannot be reproduced`);
		const current = vocabulary.versions[criterion.verifierId];
		if (criterion.verifierVersion !== current) throw new Error(`evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}" at version ${criterion.verifierVersion === void 0 ? "(none declared)" : criterion.verifierVersion}, but the registered instance declares ${current === void 0 ? "(none)" : current} now — a verdict belongs to the instance that judged, so a re-registered version invalidates the evidence`);
	}
}
/**
* Every request identity one session's own log records, in order: one entry per
* `request/header` event, read from the event data the live loop appended (its
* canonical header, not a summary). A session with no such event is reported as
* an empty list — the caller decides whether that is the no-worker exemption or
* a refusal, and this function never invents an identity.
*/
function requestIdentities(events) {
	const identities = [];
	for (const event of events) {
		if (event.type !== "request/header") continue;
		const config = event.data.header?.config;
		if (config === void 0 || typeof config.provider !== "string" || typeof config.model !== "string") continue;
		identities.push({
			provider: config.provider,
			model: config.model,
			...typeof config.reasoningEffort === "string" ? { reasoningEffort: config.reasoningEffort } : {},
			...typeof config.maxTokens === "number" ? { maxTokens: config.maxTokens } : {}
		});
	}
	return identities;
}
/** Whether one request identity is the frozen selection: the route exactly, and each declared option exactly. */
function requestMatchesSelection(identity, selection) {
	if (identity.provider !== selection.provider || identity.model !== selection.model) return false;
	if (selection.reasoningEffort !== void 0 && identity.reasoningEffort !== selection.reasoningEffort) return false;
	if (selection.maxTokens !== void 0 && identity.maxTokens !== selection.maxTokens) return false;
	return true;
}
/**
* Whether one run is the runtime's own no-worker criteria replay — the one
* recorded shape with no model path at all (`spawn: false`: the run is born
* `submitted` with a runtime-origin submission, and no worker ever existed to
* make a request). This is the *only* exemption from the model check, and it is
* read from the run's own record rather than assumed from an empty log.
*/
function isNoWorkerRun(run) {
	return run.executionPhase === "submitted" && run.submission?.origin === "runtime";
}
/** The side's task and every task below it — the subtree whose runs are this side's execution. */
function subtreeOf(snapshot, rootTaskId) {
	const root = new Map(snapshot.tasks.map((task) => [task.taskId, task])).get(rootTaskId);
	if (root === void 0) return [];
	const found = [];
	const pending = [root];
	const seen = /* @__PURE__ */ new Set();
	while (pending.length > 0) {
		const task = pending.pop();
		if (seen.has(task.taskId)) continue;
		seen.add(task.taskId);
		found.push(task);
		for (const child of snapshot.tasks) if (child.parentTaskId === task.taskId) pending.push(child);
	}
	return found;
}
/**
* The model half of the gate (S4-E §Q3): what the side's runs *really* went
* through, re-read from the durable session logs of the side's task and every
* sub-execution below it.
*
* Every run of the subtree that had a worker must have a readable session log,
* and every request it recorded must have been made on the frozen selection —
* the route exactly, and the reasoning effort / output ceiling when the frozen
* selection declared them. A log that cannot be read, a session with no request
* at all, or one request on another route is a named refusal: a run whose
* identity cannot be proved is not a side this promotion may read, and the one
* exemption is the runtime's own criteria replay, whose run record says no
* worker ever existed.
*
* This is deliberately *not* a comparison of the experiment's start value with
* today's value: the deployment's selection may move and move back without ever
* touching these requests, and a run that really went through another route is
* caught here whatever the deployment resolves now.
*/
async function assertSideModelBinding(input) {
	const { sources, detail, task, snapshot, selection, where } = input;
	if (detail.outcome === "interrupted" || task === void 0) return;
	const runs = [];
	for (const subtreeTask of subtreeOf(snapshot, task.taskId)) for (const runId of subtreeTask.runIds) {
		const run = snapshot.runs.find((item) => item.runId === runId);
		if (run === void 0) throw new Error(`evolution: the experiment report's ${where} names task "${subtreeTask.taskId}" of this experiment, but the store holds no run "${runId}" of it — the execution this side rests on cannot be re-read`);
		runs.push(run);
	}
	for (const run of runs) {
		if (isNoWorkerRun(run)) continue;
		let events;
		try {
			events = await sources.sessionLog(run.sessionId);
		} catch (error) {
			throw new Error(`evolution: the session log of run "${run.runId}" (session "${run.sessionId}") of the ${where} cannot be read (${error instanceof Error ? error.message : String(error)}) — the requests that run really made are the evidence this promotion compares against the frozen selection, so a run whose log is gone cannot be promoted on`);
		}
		if (events === void 0) throw new Error(`evolution: this deployment cannot read session logs (sessionQuery.readSession is unavailable), so the requests of run "${run.runId}" of the ${where} cannot be compared against the frozen model selection "${selection.label}" — the promotion is refused rather than granted on an unverifiable model binding`);
		const identities = requestIdentities(events);
		if (identities.length === 0) throw new Error(`evolution: run "${run.runId}" (session "${run.sessionId}") of the ${where} recorded no request at all, so the frozen model selection "${selection.label}" cannot be shown to be what it ran under — a run with no request identity to check is refused (the runtime's own criteria replay, the one no-worker path, is exempt; this run records a worker)`);
		for (const identity of identities) {
			if (requestMatchesSelection(identity, selection)) continue;
			throw new Error(`evolution: run "${run.runId}" (session "${run.sessionId}") of the ${where} really made its requests on ${identity.provider}/${identity.model}${identity.reasoningEffort === void 0 ? "" : ` (effort ${identity.reasoningEffort})`}${identity.maxTokens === void 0 ? "" : ` (maxTokens ${identity.maxTokens})`}, not on the frozen selection "${selection.label}"${selection.reasoningEffort === void 0 ? "" : ` (effort ${selection.reasoningEffort})`}${selection.maxTokens === void 0 ? "" : ` (maxTokens ${selection.maxTokens})`} — the runs a promotion reads must be the runs the frozen selection was fixed for`);
		}
	}
}
/**
* Whether one side's run binding is the provider identity the experiment froze
* for the sample (S4-E §Q3): the capability rows, the registry revision, the MCP
* servers (with a resolved template each) and every resolved skill's identity.
*
* The improved skill's own **content** is the one difference the frozen block
* allows, and it is checked *per side* against the frozen object that side was
* supposed to run (K3): the baseline side against `frozen.productionBaseline`,
* the candidate side against `frozen.candidate` — each object's own declaration
* digest and the content digest of its own bytes, plus the registry revision the
* freeze recorded for that side (`registryRevision` for production,
* `candidateRegistryRevision` for the candidate, which absorbs the improved
* skill's moved declaration). Every other skill is compared against the single
* production value, on both sides.
*
* The bytes are then re-proved from the run's own snapshot: what that side's
* worker really loaded has to hash to the frozen object's two digests, so a
* binding that merely *records* the right values is not enough. A role change is
* refused here on both sides — the frozen production role is the one the
* provider must keep — and a candidate whose bytes are the production bytes is
* refused as a candidate that never really ran.
*/
async function assertSideProviderBinding(input) {
	const { sample, detail, run, frozen, where } = input;
	if (detail.outcome === "interrupted") return;
	const expected = sample.provider;
	const binding = run.providerBinding;
	if (binding === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} records no provider binding — which rows, servers and skills it resolved against cannot be re-read, so the frozen provider identity cannot be compared and the promotion is refused`);
	const rows = [...binding.capabilities].sort();
	if (rows.join(", ") !== [...expected.capabilities].sort().join(", ")) throw new Error(`evolution: run "${run.runId}" of the ${where} bound capabilities [${rows.join(", ") || "none"}] but the experiment froze [${expected.capabilities.join(", ") || "none"}] — the rows this side ran under are not the frozen production configuration's`);
	const expectedRevision = detail.side === "candidate" ? expected.candidateRegistryRevision : expected.registryRevision;
	if (binding.registryRevision !== expectedRevision) {
		const expectation = detail.side === "candidate" ? "the frozen provider list with the improved skill's own candidate declaration substituted" : "the production configuration as it stood at the freeze";
		throw new Error(`evolution: run "${run.runId}" of the ${where} bound registry revision ${binding.registryRevision}, but the experiment froze ${expectedRevision} for the ${detail.side} side — a capability row, a tool label or a declared provider contract moved since the freeze, so the ${detail.side} side did not run under the configuration the experiment froze for it (its expectation is ${expectation}, the revision that absorbs those declarations)`);
	}
	const servers = [...binding.mcpServers].map((server) => server.serverName).sort();
	if (servers.join(", ") !== [...expected.mcpServers].sort().join(", ")) throw new Error(`evolution: run "${run.runId}" of the ${where} bound MCP servers [${servers.join(", ") || "none"}] but the experiment froze [${expected.mcpServers.join(", ") || "none"}] — the granted server plane moved since the freeze`);
	for (const server of binding.mcpServers) if (server.templateDigest === null) throw new Error(`evolution: run "${run.runId}" of the ${where} bound MCP server "${server.serverName}" with no resolvable template — the run recorded no identity for the server it was granted, so the frozen server plane cannot be compared`);
	if (expected.preset !== null && run.agentPreset !== expected.preset) throw new Error(`evolution: run "${run.runId}" of the ${where} ran under agent preset ${run.agentPreset === void 0 ? "(none)" : `"${run.agentPreset}"`}, but the frozen provider identity declares "${expected.preset}" — the preset plane this side ran under is not the frozen one`);
	const frozenSkills = new Map(expected.skills.map((skill) => [skill.name, skill]));
	const boundSkills = new Map(binding.skills.map((skill) => [skill.name, skill]));
	for (const name of boundSkills.keys()) if (!frozenSkills.has(name)) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}", which the frozen production configuration does not resolve (frozen: ${expected.skills.map((skill) => skill.name).join(", ") || "none"}) — content the freeze never admitted reached this run`);
	for (const [name, expectedSkill] of frozenSkills) {
		const bound = boundSkills.get(name);
		if (bound === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound no skill "${name}", which the frozen production configuration resolves — the run under this side did not load content the freeze named`);
		if (bound.role !== expectedSkill.role) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" as ${bound.role}, but the experiment froze it as ${expectedSkill.role} — the role production resolved is the role both sides must keep (the frozen candidate replaced that object's bytes, never its kind); a candidate that turned the provider into another kind of object is refused rather than promoted as something the experiment never evaluated`);
		if (name !== frozen.candidate.name) {
			if ((bound.contractDigest ?? null) !== expectedSkill.contractDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" declaration ${bound.contractDigest === null ? "(none)" : bound.contractDigest}, but the frozen identity is ${expectedSkill.contractDigest === null ? "(none)" : expectedSkill.contractDigest} — the provider this side loaded is not the one the experiment froze`);
			if (bound.contentDigest !== expectedSkill.contentDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the production configuration's content at freeze was ${expectedSkill.contentDigest} — the bytes this side loaded moved since the freeze`);
			continue;
		}
		const sideObject = detail.side === "candidate" ? frozen.candidate : frozen.productionBaseline;
		if (sideObject === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound the improved skill "${name}", but the frozen block records no production baseline to compare the baseline side's object against — the evidence predates the two-file baseline and is refused rather than promoted against a shape nobody froze`);
		const expectedContract = sideObject.contract?.contractDigest ?? null;
		const expectedContentDigest = skillContentDigest({
			skillMdSha256: sideObject.sha256,
			resources: []
		});
		if ((bound.contractDigest ?? null) !== expectedContract) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" declaration ${bound.contractDigest === null ? "(none)" : bound.contractDigest}, but the ${detail.side} side's frozen object declares ${expectedContract === null ? "(none)" : expectedContract} (${identityLabel(sideObject)}) — the promoted skill's own sidecar is the one difference the candidate overlay is there to produce, and each side must bind the declaration of the object it loaded`);
		if (bound.contentDigest !== expectedContentDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the ${detail.side} side's frozen object hashes to ${sideObject.sha256} (content digest ${expectedContentDigest}) — the content this side loaded is not the frozen one`);
	}
	if (boundSkills.get(frozen.candidate.name) !== void 0) {
		const sideObject = detail.side === "candidate" ? frozen.candidate : frozen.productionBaseline;
		if (sideObject === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound the improved skill "${frozen.candidate.name}" but the frozen block records no production baseline — the bytes the baseline side loaded cannot be re-proved`);
		if (binding.snapshotRoot === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${frozen.candidate.name}" but records no snapshot root — the bytes it loaded cannot be re-read, so the frozen content identity cannot be compared`);
		const frozenFiles = [{
			file: "SKILL.md",
			sha256: sideObject.sha256
		}, ...sideObject.contract === void 0 ? [] : [{
			file: SKILL_SIDECAR_FILE,
			sha256: sideObject.contract.sha256
		}]];
		for (const frozenFile of frozenFiles) {
			const digest = sha256Hex$1(await readSideSnapshotFile({
				snapshotRoot: binding.snapshotRoot,
				name: frozen.candidate.name,
				file: frozenFile.file,
				where,
				runId: run.runId,
				side: detail.side
			}));
			if (digest !== frozenFile.sha256) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${frozen.candidate.name}" whose ${frozenFile.file} hashes to ${digest}, but the experiment froze ${frozenFile.sha256} for the ${detail.side} side — the bytes this side ran are not the frozen ones`);
		}
		if (detail.side === "candidate" && sideObject.sha256 === frozen.productionBaseline?.sha256) throw new Error(`evolution: the candidate side of the ${where} loaded the production bytes ("${frozen.candidate.name}" hashes to ${sideObject.sha256}, the frozen production baseline) — the candidate was never really run, so the comparison proves nothing`);
	}
}
/**
* One frozen file of the improved skill, read where the run really loaded it:
* `<snapshotRoot>/<name>/<file>`. A snapshot that no longer holds the file is a
* named refusal (the bytes cannot be re-proved), never a comparison against the
* record the run made of itself.
*/
async function readSideSnapshotFile(input) {
	const { snapshotRoot, name, file, where, runId, side } = input;
	try {
		return await readFile(join(snapshotRoot, name, file));
	} catch (error) {
		throw new Error(`evolution: the ${file} of skill "${name}" at the content run "${runId}" of the ${where} was bound to cannot be read (${error instanceof Error ? error.message : String(error)}) — the ${side} side's frozen bytes cannot be re-proved from the snapshot its run recorded, so the promotion is refused`);
	}
}
/**
* Whether the two sides' bindings agree everywhere the frozen block allows
* agreement and nowhere else (S4-E §Q3): every field of the run binding and the
* run's preset must match between the baseline and the candidate side, except
* the promoted skill's own content digest and declaration digest — the two
* differences the experiment's overlay is supposed to produce, each of which is
* already pinned per side by {@link assertSideProviderBinding}.
*
* The two registry revisions are not compared here either, for the same reason:
* the candidate's legitimately differs (it absorbs the improved skill's moved
* declaration digest), and both values are pinned separately — production for
* one side, candidate for the other — so "the sides agree" is not the claim that
* holds them; the frozen block is. Everything else (the capability rows, the
* granted servers, the preset, and every other skill's role, declaration and
* content) has one frozen value and must be identical on both sides.
*/
function assertSidesAgree(frozen, baseline, candidate, where) {
	const comparable = (binding) => ({
		capabilities: [...binding.capabilities].sort(),
		mcpServers: [...binding.mcpServers].sort((left$1, right$1) => left$1.serverName < right$1.serverName ? -1 : left$1.serverName > right$1.serverName ? 1 : 0),
		skills: [...binding.skills].sort((left$1, right$1) => left$1.name < right$1.name ? -1 : left$1.name > right$1.name ? 1 : 0).map((skill) => ({
			name: skill.name,
			role: skill.role,
			...skill.name === frozen.candidate.name ? {} : {
				contractDigest: skill.contractDigest ?? null,
				contentDigest: skill.contentDigest
			}
		}))
	});
	const left = JSON.stringify(comparable(baseline.binding));
	const right = JSON.stringify(comparable(candidate.binding));
	if (left !== right) throw new Error(`evolution: the two sides of ${where} did not bind the same provider identity — apart from the promoted skill's own content and declaration, which the candidate overlay is what changes, every field must agree:\n- baseline: ${left}\n- candidate: ${right}`);
	if (baseline.run.agentPreset !== candidate.run.agentPreset) throw new Error(`evolution: the two sides of ${where} ran under different agent presets (${baseline.run.agentPreset === void 0 ? "(none)" : `"${baseline.run.agentPreset}"`} vs ${candidate.run.agentPreset === void 0 ? "(none)" : `"${candidate.run.agentPreset}"`}) — a preset that moved between the sides is not the frozen execution`);
}
/**
* Whether one side's cost is known enough for a frozen budget that declares a
* ceiling — the per-side half of the rule (S4-E §F.2; Q1 of the progress
* review: the ceiling bounds the *whole experiment*).
*
* A declared `maxTokens` refuses a side whose cost is `unknown` (an unknown
* cannot be shown to fit a ceiling) and requires the run's `tokens` four
* buckets: tool-call counters alone do not show tokens, and neither does a
* numeric total nobody reported.
*/
function assertCostWithinDeclaredBudget(report, where, detail) {
	const budget = report.frozen.budget;
	if (budget.maxTokens === void 0) return;
	if (detail.cost.status === "unknown") throw new Error(`evolution: the frozen budget declares a cost ceiling (maxTokens ${budget.maxTokens}) and the ${where} reports no cost (${detail.cost.reason}) — an unknown cost cannot be shown to fit a ceiling the frozen budget set, so the promotion is refused rather than inferred`);
	tokenTotalOf(detail, where, budget.maxTokens);
}
/**
* The four token buckets one settled side reports, summed the way the runtime's
* own post-hoc budget check sums them. A side without the `tokens` projection,
* or with counters that are not four readable numbers, is refused by name
* rather than counted as zero: an unknown is never a zero, and only a total
* that is really readable can be compared with a ceiling.
*/
function tokenTotalOf(detail, where, ceiling) {
	const tokens = detail.cost.status === "reported" ? detail.cost.metrics.tokens : void 0;
	if (tokens === void 0 || typeof tokens !== "object") throw new Error(`evolution: the frozen budget declares maxTokens ${ceiling} for the whole experiment, and the ${where} reports cost metrics without the \`tokens\` projection (tool-call counters alone do not show tokens) — a ceiling this side cannot be measured against is not evidence the promotion may read`);
	const buckets = [
		"uncachedInputTokens",
		"outputTokens",
		"cacheReadTokens",
		"cacheWriteTokens"
	];
	const values = buckets.map((bucket) => tokens[bucket]);
	if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`evolution: the ${where} reports token usage that is not four readable counters (${buckets.map((bucket, index) => `${bucket}: ${String(values[index])}`).join(", ")}) — an unreadable total is not a total the frozen maxTokens ${ceiling} can be checked against, so the promotion is refused`);
	return values.reduce((sum, value) => sum + value, 0);
}
/**
* The whole experiment's cost against the frozen budget (S4-E §F.2; Q1 of the
* progress review): the token four buckets summed over every settled side,
* compared with the `maxTokens` ceiling the freeze declared. Equality fits; only
* exceeding refuses. The experiment has no wall-clock ceiling — a Run's time is
* the runtime's own limit — so nothing here reads the report's timestamps.
*
* A recorded total that passed its ceiling is refused here. The orchestrator
* stops starting sides once the total the settled ones reported has consumed
* the ceiling, but a run's own counts are only readable once it settled, so the
* side that crossed the ceiling stays recorded — and this half refuses to pass
* the overspend off as a fit. With no ceiling declared, an unreadable cost stays
* the honest observation it is: recorded, never zeroed, never a refusal.
*/
function assertExperimentCostWithinBudget(report) {
	const budget = report.frozen.budget;
	if (budget.maxTokens === void 0) return;
	let spent = 0;
	let sides = 0;
	for (const sample of report.samples) for (const detail of [sample.baseline, sample.candidate]) {
		spent += tokenTotalOf(detail, `sample "${sample.taskId}" ${detail.side} side`, budget.maxTokens);
		sides += 1;
	}
	if (spent > budget.maxTokens) throw new Error(`evolution: the frozen budget declares maxTokens ${budget.maxTokens} for the whole experiment, but its ${sides} settled sides report ${spent} tokens together (${spent - budget.maxTokens} over the ceiling) — the budget bounds the experiment as a whole and not one side, and a total its own records place above the ceiling is refused rather than promoted`);
}
/**
* The whole skill promotion gate, as reads. Returns the experiment it validated
* so the caller can report the id, the report and the path; throws a named
* refusal for the first condition that does not hold, having written nothing.
*/
async function assertSkillPromotionEvidence(sources, proposal) {
	const prepared = proposal.prepared;
	const candidate = prepared?.skillContent;
	if (candidate === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" records no candidate content identity — it was prepared before content binding; propose a new candidate and evaluate it (prepare records the SHA-256 of the materialized SKILL.md)`);
	const [experiment] = await sources.experiments(proposal.proposalId);
	if (experiment === void 0) throw noExperimentRefusal(proposal);
	let report;
	try {
		report = buildExperimentReport(experiment);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)} — a promotion reads a completed experiment only; resume experiment ${experiment.experimentId} (evolution_replay) or freeze a new one`);
	}
	const reportPath = experiment.report;
	let content;
	try {
		content = await readFile(resolve(sources.root, reportPath), "utf8");
	} catch (error) {
		throw new Error(`evolution: the experiment report "${reportPath}" of proposal "${proposal.proposalId}" cannot be read (${error instanceof Error ? error.message : String(error)}) — the ledger cites evidence the sandbox no longer holds`);
	}
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(`evolution: the experiment report "${reportPath}" is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	assertExperimentReport(parsed);
	if (content !== reportBytes(report)) throw new Error(`evolution: the experiment report "${reportPath}" is not the report its ledger records recompute to — it was changed after the experiment (a verdict, a cost or a criterion in it is not what ran); a promotion takes evidence from the experiment's own records, never from an edited file`);
	const frozen = report.frozen;
	if (!sameIdentity(frozen.candidate, candidate)) throw new Error(`evolution: the experiment froze candidate ${identityLabel(frozen.candidate)} but proposal "${proposal.proposalId}" now prepares ${identityLabel(candidate)} — the evidence belongs to different candidate bytes; propose a new candidate and evaluate it`);
	const baseline = prepared?.skillBaseline;
	const frozenBaseline = frozen.productionBaseline;
	if (baseline === void 0 || frozenBaseline === void 0 || !sameIdentity(frozenBaseline, baseline)) throw new Error(`evolution: the experiment's frozen production baseline (${frozenBaseline === void 0 ? "none" : identityLabel(frozenBaseline)}) is not the baseline prepare recorded for proposal "${proposal.proposalId}" (${baseline === void 0 ? "none" : identityLabel(baseline)}) — the candidate was evaluated against another production state`);
	const storeId = experiment.storeId;
	if (storeId === void 0) throw new Error(`evolution: experiment "${experiment.experimentId}" records no task store, so the runs its sides cite cannot be re-read — run the two-sided experiment again so its evidence names the store it ran in`);
	const snapshot = await sources.task.openStore(storeId);
	const vocabulary = await sources.verifierVocabulary();
	if (vocabulary === void 0) throw new Error("evolution: the verifier registry cannot be listed in this context, so the judges behind the experiment's verdicts cannot be re-checked — the promotion is refused rather than granted on unverifiable evidence");
	for (const sample of report.samples) {
		const frozenSample = frozenSampleOf(report, sample.taskId);
		const sideRuns = {};
		for (const side of ["baseline", "candidate"]) {
			const detail = side === "baseline" ? sample.baseline : sample.candidate;
			const label = `sample "${sample.taskId}" ${side} side`;
			const task = assertSideEvidence({
				sample: frozenSample,
				detail,
				experimentId: experiment.experimentId,
				snapshot,
				where: label
			});
			assertJudgeUnchanged(frozenSample, detail, label, vocabulary);
			assertCostWithinDeclaredBudget(report, label, detail);
			if (detail.outcome === "interrupted") continue;
			if (detail.initialDigest !== frozen.snapshot.digest) throw new Error(`evolution: the experiment report's ${label} ran from workspace digest ${detail.initialDigest}, not the frozen snapshot ${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`);
			await assertSideModelBinding({
				sources,
				detail,
				task,
				snapshot,
				selection: frozen.model,
				where: label
			});
			const run = detail.runId === void 0 ? void 0 : snapshot.runs.find((item) => item.runId === detail.runId);
			if (run === void 0) throw new Error(`evolution: the experiment report's ${label} cites run "${String(detail.runId)}", which the store no longer holds — its provider binding cannot be re-read, so the promotion is refused`);
			await assertSideProviderBinding({
				sample: frozenSample,
				detail,
				run,
				frozen,
				where: label
			});
			if (run.providerBinding !== void 0) sideRuns[side] = {
				run,
				binding: run.providerBinding
			};
		}
		if (sideRuns.baseline !== void 0 && sideRuns.candidate !== void 0) assertSidesAgree(frozen, sideRuns.baseline, sideRuns.candidate, `sample "${sample.taskId}"`);
		await assertSampleInputsIntact({
			sample: frozenSample,
			snapshot,
			productionWorkspace: frozen.snapshot.sourceDir
		});
	}
	assertExperimentCostWithinBudget(report);
	const currentSelection = sources.modelSelection();
	if (currentSelection.provider !== frozen.model.provider || currentSelection.model !== frozen.model.model || currentSelection.reasoningEffort !== frozen.model.reasoningEffort || currentSelection.maxTokens !== frozen.model.maxTokens) throw new Error(`evolution: the experiment froze model selection "${frozen.model.label}"${frozen.model.reasoningEffort === void 0 ? "" : ` (effort ${frozen.model.reasoningEffort})`}${frozen.model.maxTokens === void 0 ? "" : ` (maxTokens ${frozen.model.maxTokens})`}, but this deployment resolves "${currentSelection.label}"${currentSelection.reasoningEffort === void 0 ? "" : ` (effort ${currentSelection.reasoningEffort})`}${currentSelection.maxTokens === void 0 ? "" : ` (maxTokens ${currentSelection.maxTokens})`} now — the runs on record were not run under the selection this promotion would be judged against`);
	if (report.verdict !== "fixed") throw new Error(`evolution: the two-sided experiment "${experiment.experimentId}" did not show a clean fix — ${VERDICT_REFUSALS[report.verdict]}:\n${sampleVerdictLines(report.samples).map((line) => `- ${line}`).join("\n")}`);
	return {
		experimentId: experiment.experimentId,
		report,
		reportPath
	};
}
/** The frozen sample one report sample was compared under. */
function frozenSampleOf(report, taskId) {
	const sample = report.frozen.samples.find((item) => item.taskId === taskId);
	if (sample === void 0) throw new Error(`evolution: the experiment report holds no frozen sample "${taskId}"`);
	return sample;
}

//#endregion
//#region src/evolution.ts
const EVOLUTION_LEVELS = [
	"L1",
	"L2",
	"L3",
	"L4"
];
const EVOLUTION_DECISIONS = [
	"PROMOTE",
	"REJECT",
	"KEEP_FOR_FURTHER_RESEARCH"
];
/**
* The one target type `evolution_apply` promotes mechanically (W16): the
* sandbox copy lands on the production skill root. Every other type has no
* executor in this build — a capability row, an agent_preset directory and a
* task_definition were written by an older build and are not written here.
*/
const APPLYABLE_TARGET_TYPES = ["skill"];
/**
* Whether a decided proposal's `applied` record is admissible: the decision is
* PROMOTE, the level is not L4 (L4 harness evolution is human-run by rule,
* §2.7.7 / §2.9.2), the target type is one this build can execute
* ({@link APPLYABLE_TARGET_TYPES} — skill and nothing else), and a sandbox was
* actually materialized. The state machine admits exactly what the current write
* path writes: an `applied` record of a type no executor here has is refused at
* the fold, the same way {@link EvolutionService.apply} refuses it live.
*/
function applyable(proposal) {
	return proposal.decision === "PROMOTE" && proposal.level !== "L4" && APPLYABLE_TARGET_TYPES.includes(proposal.targetType) && proposal.prepared?.sandbox != null;
}
/** One accepted verdict as a promotion report entry: the role, the content it was taken from, and the verifier ref only an execution provider has. */
function promotionProviderOf(verdict) {
	return {
		name: verdict.name,
		role: verdict.role,
		contentDigest: verdict.contentDigest,
		...verdict.role === "execution-provider" ? { verifierRef: verdict.verifierRef } : {}
	};
}
/** One provider role per line, for a decision or apply report. */
function renderProviderRoles(providers) {
	return providers.map((provider) => {
		if (provider.role === "execution-provider") return `provider: skill \`${provider.name}\` → execution-provider (verifier ${provider.verifierRef})`;
		if (provider.role === "knowledge") return `provider: skill \`${provider.name}\` → knowledge (loadable content; it does not close an execution gap)`;
		return `provider: skill \`${provider.name}\` → guidance (no sidecar; loadable guidance, not an execution provider)`;
	});
}
function nonEmpty(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: ${field} must be a non-empty string`);
	return value;
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertOnlyKeys(value, allowed, field) {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`evolution: ${field} has unknown key "${key}"`);
}
/** A single safe path segment (one directory name): no separators, never `.`/`..`, never absolute. */
function assertSegment(value, field) {
	const text = nonEmpty(value, field);
	if (text === "." || text === ".." || text.includes("/") || text.includes("\\") || isAbsolute(text)) throw new Error(`evolution: ${field} must be a single safe path segment, got "${text}"`);
	return text;
}
/**
* Resolve `rel` under `base`, refusing anything that would land outside — the sandbox confinement belt.
*/
function resolveWithin(base, rel) {
	const abs = resolve(base, rel);
	if (abs !== base && !abs.startsWith(`${base}${sep}`)) throw new Error(`evolution: sandbox path "${rel}" escapes ${base}`);
	return abs;
}
/**
* The directories a durable ledger append must fsync, in the order it fsyncs
* them: the ledger root (the file's own entry), and — when the recursive `mkdir`
* created directories — every directory between the root and the outermost one
* it created, plus the parent that names that outermost directory. `mkdir` with
* `recursive: true` returns exactly that outermost created directory (or
* `undefined` when nothing was created), so walking up from the root always
* reaches it: without this chain a power cut can take a freshly created ledger
* directory, or a freshly created ledger file, while the write that referenced
* it survives.
*/
function ledgerDirectories(root, created) {
	if (created === void 0) return [root];
	const directories = [];
	for (let directory = root;; directory = dirname(directory)) {
		directories.push(directory);
		if (directory === created) break;
	}
	return [...directories, dirname(created)];
}
/**
* The production skill target as it stands right now (P3): null when nothing
* is there, otherwise the exact bytes plus their SHA-256. Read through the same
* component walk as the ledger root (`walkVerified`, shared with the skill
* sidecar loader in task-runtime), so a production path that became a
* directory, or that is a symbolic link (the file itself or an ancestor), is a
* conflict the caller refuses — never a silent follow. `relative` is the target
* as a path under the skill root (`<name>/SKILL.md`); a commit's own target is
* reduced to that shape before it is read here.
*/
async function readProductionSkill(skillRoot, relative$1) {
	const walked = await walkVerified(skillRoot, relative$1);
	if (walked.missing) return null;
	const bytes = await readFile(walked.abs);
	return {
		bytes,
		sha256: sha256Hex(bytes)
	};
}
/** The production path of one skill object's `SKILL.md`, as the executor writes and reads it. */
function productionSkillRelative(name) {
	return join(name, "SKILL.md");
}
/** The production path of one skill object's sidecar file, beside the `SKILL.md`. */
function productionSidecarRelative(name) {
	return join(name, SKILL_SIDECAR_FILE);
}
/**
* One skill object's declared sidecar, parsed from the exact bytes that were
* read — the same bytes its identity covers. Callers only reach this with bytes
* the loader has already accepted as a text JSON declaration, so the parse is a
* reading of what was verified, not a second guess at it.
*/
function loadedSidecar(bytes) {
	return JSON.parse(bytes.toString("utf8"));
}
/**
* The candidate sidecar of one execution object: the production declaration with
* exactly `content.skillMdSha256` replaced by the candidate `SKILL.md` digest,
* serialized deterministically. This is the one place a candidate object gains
* its second file, and it is a *derivation*, never an authored patch: the
* capabilities, ports, required tools, verifier and (empty) resource list are
* the production object's, so a content update cannot escalate a declaration —
* the derivation consistency check at promotion re-derives the same bytes from
* the champion snapshot and refuses any candidate whose sidecar disagrees.
*/
function candidateSidecar(production, skillMdSha256) {
	return serializeSkillSidecar(sidecarWithSkillMd(production, skillMdSha256));
}
/**
* Fold a sidecar's declared data into a {@link SkillContractIdentity}: the exact
* bytes' SHA-256 and the canonical declaration digest a registry revision and a
* run binding use. Both come from the same bytes, so an identity is never
* assembled from two different reads.
*/
function contractIdentityOf(bytes) {
	return {
		sha256: sha256Hex(bytes),
		contractDigest: skillContractDigest(loadedSidecar(bytes))
	};
}
/**
* Validate a candidate's mutation. This build has exactly one candidate
* mutation — the `SKILL.md` text replacing an existing skill object's own
* (§F.2) — so the schema is the skill one and the only callers are the paths
* that already admitted a skill candidate (the write path and the fold, which
* refuses a candidate of any other target type first). A mutation of another
* target type has no schema here, and is named rather than silently accepted:
* the old schemas (agent_preset, capability, task_definition) and the
* bookkeeping-only default belonged to a lifecycle this build no longer has.
* The unknown key check is the "no sidecar patch" rule: the model submits
* `{ name, content }` and nothing else, and a sidecar is derived at prepare
* rather than accepted here.
*/
function validateMutation(targetType, mutation) {
	if (!isRecord(mutation)) throw new Error("evolution: mutation must be an object");
	if (targetType !== "skill") throw new Error(`evolution: a "${targetType}" mutation has no schema in this build — the only candidate lifecycle here is a SKILL.md replacement of an existing skill object, and every other target type is a recorded proposal`);
	assertOnlyKeys(mutation, ["name", "content"], "skill mutation");
	assertSegment(mutation.name, "mutation.name");
	nonEmpty(mutation.content, "mutation.content");
}
/**
* Candidate versionSet payload validation, shared by the write path
* (`candidate`) and the fold: a hand-forged ledger line must fail the same
* checks a live append does.
*/
function validateVersionSet(versionSet) {
	if (!isRecord(versionSet)) throw new Error("evolution: versionSet must be an object");
	const entries = Object.entries(versionSet);
	if (entries.length === 0) throw new Error("evolution: versionSet must record at least one version");
	for (const [key, value] of entries) {
		nonEmpty(key, "versionSet key");
		if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: versionSet["${key}"] must be a non-empty string`);
	}
}
/**
* Gate-answers payload validation, shared by the write path (`gate`) and the
* fold: all six answers non-empty, at least one regression evidence ref, every
* ref a non-empty string. Evidence existence (disk path / caller-resolved id /
* the replay report still sitting in the sandbox) stays write-path-only — the
* fold never touches disk, so a ledger stays replayable after evidence files
* rotate away.
*/
function validateGateAnswers(answers) {
	if (!isRecord(answers)) throw new Error("evolution: gate answers must be an object");
	nonEmpty(answers.targetFailureFixed, "gate answer \"1. Target failure fixed?\"");
	nonEmpty(answers.originalAcceptanceMaintained, "gate answer \"2. Original acceptance maintained?\"");
	nonEmpty(answers.existingRegressionMaintained, "gate answer \"3. Existing regression maintained?\"");
	nonEmpty(answers.noUnacceptableSideEffects, "gate answer \"4. No unacceptable side effects?\"");
	nonEmpty(answers.holdoutPerformanceAcceptable, "gate answer \"5. Holdout performance acceptable?\"");
	nonEmpty(answers.resourceCostAcceptable, "gate answer \"6. Resource cost acceptable?\"");
	if (!Array.isArray(answers.regressionEvidenceRefs) || answers.regressionEvidenceRefs.length === 0) throw new Error("evolution: the regression/replay answer must cite at least one evidence ref");
	for (const ref of answers.regressionEvidenceRefs) nonEmpty(ref, "regression evidence ref");
}
/**
* The state machine. A candidate is a mutation — this build's candidate is a
* `SKILL.md` replacement of an existing skill object — so a candidate has
* exactly one next state: `prepared` (sandbox materialization). There is no
* mutation-less candidate and no direct candidate → gated arc: a proposal with
* nothing to evaluate is a recorded proposal, not a flow.
*
* A prepared **skill** candidate gates straight from prepared: its evaluation is
* the two-sided experiment (§F.2), which is recorded in the ledger's experiment
* family and is deliberately *not* a lifecycle transition — the proposal stays
* `prepared` while its samples run — so {@link EvolutionService.gate} requires
* the completed experiment. The machine admits what the current entries write
* and nothing else: `candidate` admits a skill candidate — this build's one
* candidate type — and there is no other arc to take. After the human decision,
* only a PROMOTE on an applyable, materialized, sub-L4 mutation can be applied
* (W16), and only an applied proposal can be rolled back.
*/
function nextStates(proposal) {
	switch (proposal.status) {
		case "proposed": return ["candidate"];
		case "candidate": return ["prepared"];
		case "prepared": return ["gated"];
		case "gated": return ["decided"];
		case "decided": return applyable(proposal) ? ["applied"] : [];
		case "applied": return ["rolledback"];
		case "rolledback": return [];
	}
}
/** The one transition check shared by live appends and replay, so an illegal migration reads identically in both. */
function assertTransition(current, kind) {
	if (nextStates(current).includes(kind)) return;
	const hint = current.status === "candidate" ? " — record \"prepared\" first (evolution_prepare), the sandbox materialization this candidate's mutation needs" : current.status === "decided" && kind === "applied" ? current.decision !== "PROMOTE" ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied` : " — only a materialized skill mutation at L1–L3 applies in this build" : "";
	throw new Error(`evolution: proposal "${current.proposalId}" is ${current.status}; cannot record "${kind}"${hint}`);
}
/**
* The production write targets of an apply (and its matching rollback), for
* the approval reason and the audit record — the human sees exactly what a
* grant will touch. The object's fixed file set: the candidate's `SKILL.md`,
* plus the `SKILL.contract.json` beside it when the prepared object carries an
* execution sidecar — one or two paths, in commit order.
*/
function applyTargets(proposal, roots) {
	if (proposal.targetType !== "skill") return [];
	const name = proposal.mutation.name;
	const files = [join(roots.skillRoot, name, "SKILL.md")];
	if (proposal.prepared?.skillContent?.contract !== void 0) files.push(join(roots.skillRoot, name, SKILL_SIDECAR_FILE));
	return files;
}
/**
* One format, one check (K3): every line this ledger reads, folds or writes
* declares `formatVersion: 4`, and nothing else — no v1, no v2, no v3, no
* missing version, no mix. The same refusal guards all three doors the record
* type cannot guard on its own: the load (per line, naming the file and the
* line), the {@link EvolutionService.append} funnel every lifecycle, commit and
* sample write goes through, and
* {@link EvolutionService.recordExperimentStart}, which folds the experiment
* family first and then appends through the same durable append that funnel
* uses. A record that declares anything else is refused before it is folded or
* written, and the caller's step is the persistence contract's: archive the old
* ledger and start a new one.
*
* The version moved with the object a commit covers: a v3 ledger records one
* file per intent (`target`, `baselineSha256`, `contentSha256`, `source`) and a
* prepare's identity without a sidecar half, so it cannot describe a two-file
* commit and a write beside it could not be reconciled — reading one is refused
* instead of appending beside it.
*
* `position` names the line or the record in the operator's own vocabulary
* (e.g. `ledger line 3 in /…/proposals.jsonl`), so the message points at the
* bytes that are wrong rather than at the entry that noticed them.
*/
function assertLedgerFormatVersion(record, position) {
	if (record.formatVersion === 4) return;
	throw new Error(`evolution: ${position} declares formatVersion ${JSON.stringify(record.formatVersion ?? null)} — this build reads and writes formatVersion 4 only, so a v1, a v2, a v3, an unversioned or a mixed ledger is refused before any new record is appended (archive the old ledger and start a new one; no migration, no dual-format read and no older-record reader is offered, because a ledger written before v4 records one file per commit intent and no sidecar half in a prepare identity, so a two-file commit against it could not be reconciled)`);
}
/**
* Commit-intent payload validation, shared by the write path ({@link
* EvolutionService.apply} / {@link EvolutionService.rollback} through
* `commit.ts`) and the fold: every field a recovery needs is present, the file
* set has the fixed shape of one skill object (one or two entries, in commit
* order: `SKILL.md` first, the `SKILL.contract.json` of the same directory
* second when there is one), every digest is real SHA-256 hex, every target is
* absolute, and the direction is one of the two the commit path has. A
* hand-forged line fails exactly as a live append would.
*/
function validateCommitIntent(record) {
	const nonEmptyFields = [
		["proposalId", record.proposalId],
		["intentId", record.intentId],
		["approvalRef", record.approvalRef],
		["actor", record.actor],
		["at", record.at]
	];
	for (const [field, value] of nonEmptyFields) if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: commit_intent record for proposal "${String(record.proposalId)}" has no ${field} — an intent names the proposal, the direction, the human approval, the fixed file set it commits, the bytes to write again for every file and its actor, so a line missing any of them cannot be reconciled`);
	if (record.direction !== "apply" && record.direction !== "rollback") throw new Error(`evolution: commit_intent record for proposal "${record.proposalId}" declares direction ${JSON.stringify(record.direction ?? null)} — a commit intent is "apply" or "rollback"`);
	const files = record.files;
	if (!Array.isArray(files) || files.length === 0 || files.length > 2) throw new Error(`evolution: commit_intent record for proposal "${record.proposalId}" names ${Array.isArray(files) ? `${files.length} file(s)` : "no file list"} — one skill object is a fixed file set of one or two files: SKILL.md, and SKILL.contract.json when the object carries an execution sidecar`);
	files.forEach((file, index) => {
		const at = `commit_intent record for proposal "${record.proposalId}" file ${index}`;
		if (!isRecord(file)) throw new Error(`evolution: ${at} is not an object carrying target, baselineSha256, contentSha256, source`);
		for (const [field, value] of [["target", file.target], ["source", file.source]]) if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: ${at} has no ${field} — every file names its absolute production path and its recoverable source`);
		for (const [field, value] of [["baselineSha256", file.baselineSha256], ["contentSha256", file.contentSha256]]) if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`evolution: ${at} has no valid ${field} (${JSON.stringify(value ?? null)}) — an intent binds, for every file, the exact bytes production must hold before the write and the exact bytes it must hold after`);
		if (file.target !== resolve(file.target)) throw new Error(`evolution: ${at} names target "${file.target}" — an intent names the absolute production paths it commits`);
		if (basename(file.target) !== (index === 0 ? "SKILL.md" : SKILL_SIDECAR_FILE)) throw new Error(`evolution: ${at} names target "${file.target}" — the file set of one skill object is ordered and fixed: SKILL.md first, and, when the object carries an execution sidecar, ${SKILL_SIDECAR_FILE} second`);
		if (index > 0 && dirname(file.target) !== dirname(files[0].target)) throw new Error(`evolution: ${at} names target "${file.target}" beside "${files[0].target}" — the files of one skill object live in one directory, the one a loader reads whole`);
	});
}
/**
* One half of a prepared record's frozen identity, validated and normalized: the
* skill name, the `SKILL.md` digest, and — when, and only when, the object
* carries an execution sidecar — the sidecar's exact-byte digest and canonical
* declaration digest. Shared by the write path's shape (its producer is
* `prepare`) and the fold, so a hand-forged line fails exactly as a live append
* would.
*
* `field` is the record's own member name (`skillContent` / `skillBaseline`),
* which is also what the refusal names — the operator reads the line, not this
* function.
*/
function preparedIdentity(value, field, proposalId) {
	const at = `prepared record for "${proposalId}"`;
	if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error(`evolution: ${at} has no valid ${field} identity — every prepare records the content identity of the object's files (${field === "skillContent" ? "the materialized candidate SKILL.md" : "the production SKILL.md it read before materializing the candidate"})`);
	const contract = value.contract;
	if (contract === void 0) return {
		name: value.name,
		sha256: value.sha256
	};
	if (!isRecord(contract) || typeof contract.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(contract.sha256) || typeof contract.contractDigest !== "string" || !/^[a-f0-9]{64}$/.test(contract.contractDigest)) throw new Error(`evolution: ${at} ${field}.contract must be { sha256, contractDigest } with both lowercase 64-character hex digests — an object with an execution sidecar records that file by its exact bytes and by the declaration identity a registry revision absorbs`);
	return {
		name: value.name,
		sha256: value.sha256,
		contract: {
			sha256: contract.sha256,
			contractDigest: contract.contractDigest
		}
	};
}
/**
* The Evolution plane ledger (plane separation: this store is independent of
* the task store and refers to it by id only). Folding and appending share one
* fold, so a corrupt or out-of-order log fails loudly instead of silently
* drifting. Writes are serialized, and every line is appended durably — the file
* is opened for append, written, fsynced and closed per line, and the
* directories that hold it are fsynced too — so closing the service is just
* draining the write queue. Sandbox materialization is the only other write,
* confined to `<root>/sandbox/<proposalId>/`.
*/
var EvolutionService = class extends Service {
	/** Absolute ledger directory resolved at construction. */
	root;
	/** Production skill root — champion snapshots read from here; apply/rollback write here. */
	skillRoot;
	/** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
	repoRoot;
	/** The injected model-selection resolver, if the assembly wired one (see {@link Config.modelSelection}). */
	resolveModelSelection;
	/** The commit path's typed test seam, if this instance was built with one (see {@link Config.commitProbe}). */
	commitProbe;
	records = [];
	loaded;
	writes = Promise.resolve();
	commits = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "evolution");
		this.repoRoot = config.repoRoot ?? process.cwd();
		this.resolveModelSelection = config.modelSelection;
		this.commitProbe = config.commitProbe;
		const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, ".dsh");
		this.root = resolve(config.root ?? join(dshHome, "evolution"));
		this.skillRoot = resolve(config.skillRoot ?? join(dshHome, "skills"));
		this.loaded = this.load();
		ctx.effect(() => async () => {
			await this.commits;
			await this.writes;
		}, "evolution: drain writes");
	}
	/** Ledger file path (`<root>/proposals.jsonl`). */
	get file() {
		return join(this.root, "proposals.jsonl");
	}
	/**
	* The model selection this deployment's runs share — the one the experiment
	* freezes before anything runs, passes to each replayed spawn verbatim, and
	* the promotion gate re-reads from the runs' own session logs
	* ({@link Config.modelSelection}).
	*
	* Fail-closed: no resolver, a resolver that throws, or one that answers
	* anything but a structured selection with a provider and a model is a named
	* refusal. The experiment tool freezes this value, so a deployment that cannot
	* name its selection can neither evaluate nor promote a candidate — and
	* neither case silently skips the check.
	*/
	modelSelection() {
		let resolved;
		try {
			resolved = modelSelectionOf(this.resolveModelSelection?.());
		} catch (error) {
			throw new Error(`evolution: the model selection cannot be resolved (${error instanceof Error ? error.message : String(error)}) — the experiment freezes the selection its runs share and a promotion re-reads it, so a deployment that cannot name one neither evaluates nor promotes a candidate`);
		}
		if (resolved === void 0) throw new Error("evolution: this deployment cannot name the model selection its runs share — no model-selection resolver was injected (or it answered without a structured { provider, model } route); the two-sided experiment freezes the selection before anything runs and the promotion gate re-reads it from the runs' own session logs, so a deployment that cannot name it can neither evaluate nor promote a candidate");
		return resolved;
	}
	async propose(input, actor) {
		const record = {
			formatVersion: 4,
			kind: "proposed",
			proposalId: nonEmpty(input.proposalId, "proposalId"),
			targetType: input.targetType,
			targetId: nonEmpty(input.targetId, "targetId"),
			baseVersion: nonEmpty(input.baseVersion, "baseVersion"),
			level: input.level,
			rationale: nonEmpty(input.rationale, "rationale"),
			sourceRefs: input.sourceRefs,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (!EVOLUTION_LEVELS.includes(record.level)) throw new Error(`evolution: unknown level "${String(input.level)}"`);
		if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length === 0) throw new Error("evolution: sourceRefs must name at least one source (diagnosisId / reviewRef / evidenceId)");
		input.sourceRefs.forEach((ref, index) => nonEmpty(ref, `sourceRefs[${index}]`));
		await this.append(record);
		return this.get(record.proposalId);
	}
	/**
	* Move proposed → candidate, recording the complete version set the candidate
	* aligns to and the structured patch it carries. `mutation` is required and
	* shaped by the proposal's targetType: a candidate the ledger cannot
	* materialize and evaluate is a flow going nowhere, so it is refused here,
	* before the first candidate line is written. A proposal whose mutation does
	* not survive {@link validateMutation} stays exactly as it was.
	*
	* **A skill candidate only** (§F.2): a capability, agent_preset,
	* task_definition or bookkeeping-only proposal stays the recorded suggestion
	* `evolution_propose` wrote and is refused here by name, before the first
	* ledger line of the candidate lifecycle. Its proposal keeps its place in the
	* ledger — a record is not a candidate.
	*/
	async candidate(proposalId, versionSet, actor, mutation) {
		const current = await this.assertNext(proposalId, "candidate");
		if (current.targetType !== "skill") throw new Error(`evolution: proposal "${proposalId}" targets "${current.targetType}", which cannot become a candidate in this build — the only candidate lifecycle here is a SKILL.md replacement of an existing skill object (evolution_prepare → the two-sided experiment evolution_replay → evolution_gate → evolution_apply), and no other target type has an evaluator until A6 introduces one, so its proposal stays a recorded proposal`);
		validateVersionSet(versionSet);
		validateMutation(current.targetType, mutation);
		await this.append({
			formatVersion: 4,
			kind: "candidate",
			proposalId,
			versionSet: { ...versionSet },
			mutation: structuredClone(mutation),
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move candidate → prepared: confirm the production skill **object** this
	* candidate replaces, materialize the mutation into
	* `<root>/sandbox/<proposalId>/` and snapshot those same production bytes
	* under `champion/` — the anchor for the experiment's baseline and for
	* rollback.
	*
	* The production read comes first, before any sandbox or ledger write, and it
	* is one verified read of the whole directory (`loadSkillSidecar`, the same
	* loader a worker's provider check uses), so the object is frozen as it really
	* is. A production directory with no readable `SKILL.md` has nothing to
	* replace and is refused before anything is written. Anything else that makes
	* the directory *not* the object it claims — a declaration that does not match
	* the bytes, a file no sidecar names, an unreadable or unsupported entry —
	* carries loader defects and is refused by name, because a candidate built
	* from a directory nobody could describe would let a file disappear between
	* prepare and apply. A knowledge sidecar and an execution sidecar with
	* declared resources are refused too: this ticket's object is guidance or an
	* execution provider with `resources: []`. A guidance directory has no
	* declaration for the loader to hold it to, so the files the loader found
	* beyond `SKILL.md` there — resources nobody declared, entries outside the
	* supported vocabulary — are refused here by name for that same reason: the
	* two identities below describe the fixed file set, and a directory holding
	* more than that is not the object they would claim to be.
	*
	* What is materialized is the object's fixed file set. Guidance is the
	* candidate `SKILL.md` and the champion `SKILL.md`. An execution object also
	* gets the candidate's `SKILL.contract.json` — the production declaration with
	* only `content.skillMdSha256` rewritten to the candidate's bytes, serialized
	* deterministically — and the production sidecar's exact bytes under
	* `champion/`.
	*
	* The candidate and the baseline each record a full content identity
	* (`skillContent` P2 / `skillBaseline` P3): the name, the SHA-256 of the exact
	* bytes of every materialized file (read back from disk, never re-rendered
	* from the mutation string), and — for an execution object — the file digest
	* and canonical digest of its sidecar. The two identities' shapes agree by
	* construction, so the fold can treat a disagreement as a role change it must
	* refuse.
	*/
	async prepare(proposalId, actor) {
		const current = await this.assertNext(proposalId, "prepared");
		const mutation = current.mutation;
		validateMutation(current.targetType, mutation);
		assertSegment(proposalId, "proposalId");
		const { name } = mutation;
		const directory = join(this.skillRoot, name);
		const loaded = await loadSkillSidecar(directory);
		if (loaded.content === void 0) throw new Error(`evolution: the production skill "${join(directory, "SKILL.md")}" does not exist, so proposal "${proposalId}" has nothing to replace — this build prepares and promotes a replacement of an existing loadable skill object only; a new skill cannot be evaluated or promoted by this path`);
		if (loaded.defects.length > 0) {
			const defects = loaded.defects.map((item) => `${item.code}: ${item.detail}`).join("; ");
			throw new Error(`evolution: the production skill "${directory}" is not the loadable object its files claim — ${defects}; this build freezes a complete object (SKILL.md, and the SKILL.contract.json it declares when the object has one), and a directory a loader refuses cannot be the baseline a candidate must reproduce: nothing was written`);
		}
		if (loaded.sidecar?.type === "knowledge") throw new Error(`evolution: the production skill "${directory}" carries a knowledge sidecar, and a same-name improvement of a knowledge skill is refused by name in this build — the object this executor promotes is guidance (no sidecar) or an execution provider (SKILL.md plus SKILL.contract.json with no resources), so nothing was written`);
		if (loaded.sidecar !== void 0 && loaded.sidecar.content.resources.length > 0) throw new Error(`evolution: the production skill "${directory}" declares ${loaded.sidecar.content.resources.length} resource(s) (${loaded.sidecar.content.resources.map((resource) => JSON.stringify(resource.path)).join(", ")}), and this build promotes an object whose content identity covers SKILL.md alone — resources need an executor that writes them, so nothing was written`);
		const undeclaredFiles = [...loaded.content.resources.map((resource) => resource.path), ...loaded.uncovered];
		if (undeclaredFiles.length > 0) throw new Error(`evolution: the production skill "${directory}" holds ${undeclaredFiles.length} file(s) beyond the object this build freezes (${undeclaredFiles.map((path) => JSON.stringify(path)).join(", ")}), and the object is fixed — guidance is SKILL.md alone, and an execution provider is SKILL.md plus the SKILL.contract.json beside it with no resources — so a directory carrying more is not the object a candidate reproduces: nothing was written`);
		const productionSkillMd = await readVerifiedFile(this.skillRoot, productionSkillRelative(name));
		if (sha256Hex(productionSkillMd) !== loaded.content.skillMdSha256) throw new Error(`evolution: the production skill "${join(directory, "SKILL.md")}" changed while proposal "${proposalId}" was being prepared (its bytes no longer hash to the digest the loader had just validated) — freezing a second read would record a baseline nothing checked, so nothing was written`);
		const productionSidecar = loaded.sidecar === void 0 ? void 0 : await readVerifiedFile(this.skillRoot, productionSidecarRelative(name));
		if (productionSidecar !== void 0 && skillContractDigest(loadedSidecar(productionSidecar)) !== skillContractDigest(loaded.sidecar)) throw new Error(`evolution: the production skill "${join(directory, SKILL_SIDECAR_FILE)}" changed while proposal "${proposalId}" was being prepared (its declaration is no longer the one the loader had just validated) — nothing was written`);
		const dir = join(this.root, "sandbox", proposalId);
		const written = await this.materialize(dir, mutation, {
			skillMd: productionSkillMd,
			...productionSidecar === void 0 ? {} : { sidecar: productionSidecar }
		});
		const sandbox = `sandbox/${proposalId}`;
		const skillContent = {
			name,
			sha256: sha256Hex(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`)),
			...loaded.sidecar === void 0 ? {} : { contract: contractIdentityOf(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`)) }
		};
		await this.append({
			formatVersion: 4,
			kind: "prepared",
			proposalId,
			sandbox,
			mechanical: true,
			champion: "captured",
			skillBaseline: written.skillBaseline,
			skillContent,
			files: written.files,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move prepared → gated: all six Gate answers plus regression evidence refs.
	* Every ref must exist — a path on disk (relative to the repo root or
	* absolute) or an id the caller-side resolver knows (task-store evidence).
	* Existence only; nothing here executes anything. A **skill** proposal must
	* have a completed two-sided experiment and cite that experiment's report
	* (§F.2); the six answers are recorded over it.
	*/
	async gate(proposalId, answers, actor, refKnown) {
		const current = await this.assertNext(proposalId, "gated");
		validateGateAnswers(answers);
		let experimentReport;
		if (current.targetType === "skill") {
			const [experiment] = await this.experiments(proposalId);
			if (experiment === void 0) throw new Error(`evolution: skill proposal "${proposalId}" has no two-sided experiment — the gate answers must rest on both sides of every frozen sample, so evaluate the candidate with evolution_replay before gating it`);
			try {
				buildExperimentReport(experiment);
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)} — a skill candidate gates on a completed experiment only; resume experiment ${experiment.experimentId} (evolution_replay) before answering the gate`);
			}
			experimentReport = experiment.report;
		}
		if (experimentReport !== void 0) {
			if (!answers.regressionEvidenceRefs.includes(experimentReport)) throw new Error(`evolution: a skill candidate's regression evidence must cite its experiment report "${experimentReport}" — the six answers are answered over that experiment, and the gate records the evidence they rest on`);
			if (!existsSync(resolveWithin(this.root, experimentReport))) throw new Error(`evolution: the experiment report "${experimentReport}" no longer exists under the ledger root`);
		}
		for (const ref of answers.regressionEvidenceRefs) {
			if (experimentReport !== void 0 && ref === experimentReport) continue;
			if (!(this.refExistsOnDisk(ref) || refKnown !== void 0 && await refKnown(ref))) throw new Error(`evolution: regression evidence ref "${ref}" matches no known evidence id and no existing path`);
		}
		await this.append({
			formatVersion: 4,
			kind: "gated",
			proposalId,
			gate: {
				...answers,
				regressionEvidenceRefs: [...answers.regressionEvidenceRefs]
			},
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move gated → decided. Callers (the evolution_decide tool) must have a
	* human grant from `ctx.approval.request` before calling this and pass its
	* call id as `approvalRef` (`approval:<callId>`, the applied/rolledback
	* shape) — the service only records, and the ref makes the human review
	* auditable from the ledger alone. A rejected or cancelled ask must never
	* reach this method.
	*/
	async decide(proposalId, decision, actor, approvalRef, note) {
		await this.assertNext(proposalId, "decided");
		if (!EVOLUTION_DECISIONS.includes(decision)) throw new Error(`evolution: decision must be one of ${EVOLUTION_DECISIONS.join(" / ")}`);
		nonEmpty(approvalRef, "approvalRef");
		if (note !== void 0) nonEmpty(note, "note");
		if (decision === "PROMOTE") await this.checkPromotion(proposalId);
		await this.append({
			formatVersion: 4,
			kind: "decided",
			proposalId,
			decision,
			approvalRef,
			...note === void 0 ? {} : { note },
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move decided → applied: copy the sandbox materialization into production
	* (W16), as one commit. Reachable only for a PROMOTE decision on a materialized
	* skill mutation at L1–L3 (the state machine itself refuses anything else —
	* every other target type has no executor in this build); the caller (the
	* evolution_apply tool) must hold a human grant from `ctx.approval.request`
	* first, exactly as for decide. The candidate object's fixed file set
	* replaces production's — `SKILL.md` and, when the object carries an execution
	* sidecar, the derived `SKILL.contract.json` (the champion snapshot covers
	* those files only, so the write is file-level, never a directory delete).
	*
	* The commit order is the recovery rule (K2): the `commit_intent` line is
	* persisted first — proposal, direction, this approval, every target of the
	* object's file set, the content identities production must hold before
	* (`prepared.skillBaseline` P3) and after (`prepared.skillContent` P2) for
	* each file, and the sandbox candidate files as the recoverable sources — then
	* each file is replaced atomically, then the `applied` record closes the
	* intent. A failure at any stage leaves the intent open and nothing
	* half-written: every production file is one complete version or the other,
	* and {@link reconcile} (or a retry of this call) settles the intent from what
	* production actually holds — including the window where only the first file
	* was replaced. Nothing here trusts a promise or a caller-supplied "approved".
	*
	* A skill apply re-verifies the production baseline (P3) after the human
	* grant and before the intent is recorded: the production object must still be
	* the one prepare recorded, both files. A direct service call therefore cannot
	* bypass the check the tool already ran before asking for approval. The
	* *directory* is checked as well, by the commit path, before the intent line:
	* a file that arrived beside the baseline while the human was deciding — a
	* resource nobody declared, a sidecar where the baseline had none — is refused
	* by name with nothing written ({@link objectWriteRefusal}), because the digest
	* checks describe the files this commit names and this one names two files at
	* most.
	*
	* A fresh commit also refuses, before that baseline check, a production
	* **directory** another proposal's open commit intent touches
	* ({@link assertTargetUncommitted}): the serial queue spans one process, and
	* without the per-object gate the second of two proposals prepared against the
	* same bytes would read the version the first is still committing over, pass
	* its own baseline check and move the target.
	*
	* The promotion check (S1-C item 3) runs here too, before the intent is
	* recorded: a candidate whose provider role or file shape changed while the
	* human was deciding (a sidecar that appeared in or vanished from the sandbox,
	* a declaration that moved, a verifier that was unregistered) is refused here,
	* so no entry can write something a later admission would have refused.
	*
	* When this proposal already has an open intent — the process died before the
	* completion landed — this call does not ask for another approval and does not
	* re-run the promotion gate: the recorded intent already binds the grant and
	* the content it was approved against, and the only question left is what
	* production holds. It settles that intent ({@link reconcile}, one intent) and
	* reports it as {@link ApplyOutcome.recovered}.
	*/
	async apply(proposalId, actor, approvalRef) {
		await this.assertNext(proposalId, "applied");
		nonEmpty(approvalRef, "approvalRef");
		return this.commitExclusive(async () => {
			const proposal = await this.get(proposalId);
			const open$1 = proposal.openIntent;
			if (open$1 !== void 0) {
				if (open$1.direction !== "apply") throw new Error(`evolution: proposal "${proposalId}" has an open rollback commit intent ("${open$1.intentId}") — apply cannot complete a rollback; settle that intent (reconcile, or evolution_rollback) before applying anything`);
				const recovered = await this.settleOpenIntent(open$1);
				return {
					targets: open$1.files.map((file) => file.target),
					recovered,
					proposal: await this.get(proposalId)
				};
			}
			this.assertTargetUncommitted(proposal);
			const promotion = await this.checkPromotion(proposalId);
			await this.checkProductionBaseline(proposalId);
			const candidate = await this.readVerifiedSkillCandidate(proposal);
			const request = this.commitRequest(proposal, "apply", actor, approvalRef);
			await commitIntent(this.commitHost(), request, [candidate.skillMd, ...candidate.sidecar === void 0 ? [] : [candidate.sidecar]]);
			return {
				targets: request.files.map((file) => file.target),
				providers: promotion.providers,
				proposal: await this.get(proposalId)
			};
		});
	}
	/**
	* Preflight for tools before asking for approval; mutation methods repeat the
	* check. Returns the providers the promotion would put in place, each with the
	* role it may be counted as, so the callers that already gate on this check
	* can report them.
	*
	* Only a `skill` proposal is promotable in this build (EVAL-4/§F.2): every
	* other target type is refused by name — a type with no evaluator gets no
	* promotion, and a record of one is never upgraded into new evidence
	* ({@link noEvaluatorRefusal}).
	*
	* For a skill candidate three checks run here, in this order, all of them
	* shared with the service entry the tools ultimately call:
	*
	* 1. P2: the candidate bytes must still be the ones prepare recorded.
	* 2. S1-C item 3: the provider check. The candidate's sandbox directory is
	*    judged by the same {@link validateSkillProvider} admission and config
	*    load the rest of the system uses, so `evolution_apply` is not the only
	*    entry that knows what a usable provider is — and a candidate carrying an
	*    execution sidecar with an unregistered verifier or ungranted tools is
	*    refused here, before a human is asked, before `decided` is recorded, and
	*    before anything is written.
	* 3. The evidence gate (`assertSkillPromotionEvidence`): a completed two-sided
	*    experiment whose report, runs, reviews, evidence, frozen inputs, judge,
	*    model, verdict and cost still hold. Every one of them is re-read from the
	*    ledger, the store and the production workspace — the tools run all of it
	*    before asking a human, and decide(PROMOTE) / apply run it again on the
	*    service entry, so evidence that moved while the human was deciding is
	*    still refused.
	*/
	async checkPromotion(proposalId) {
		const proposal = await this.get(proposalId);
		if (proposal.targetType !== "skill") throw noEvaluatorRefusal(proposal);
		if (proposal.prepared?.mechanical !== true || proposal.prepared.sandbox == null) throw new Error(`evolution: skill proposal "${proposal.proposalId}" has no materialized candidate — nothing this proposal names was ever evaluated; record a structured candidate and prepare it (evolution_candidate / evolution_prepare) before promoting it`);
		await this.readVerifiedSkillCandidate(proposal);
		const providers = [await this.assertSkillCandidateProvider(proposal)];
		await assertSkillPromotionEvidence(this.promotionSources(), proposal);
		return { providers };
	}
	/**
	* The services the promotion gate re-reads from this context: the experiment
	* family of this same ledger, the task store the experiment names, the live
	* verifier vocabulary, this deployment's model selection and its session
	* logs. Resolved softly
	* one by one, so a context that cannot offer one gets a refusal naming it
	* rather than a gate that silently checks less.
	*/
	promotionSources() {
		const task = optionalService(this.ctx, "task");
		if (task === void 0) throw new Error("evolution: the promotion gate re-reads the experiment's runs, reviews and evidence from the task store, and this context has no task service — the evidence cannot be checked, so nothing is promoted");
		return {
			root: this.root,
			experiments: (proposalId) => this.experiments(proposalId),
			task,
			verifierVocabulary: async () => {
				const vocabulary = await registeredVerifierVocabulary(this.ctx);
				return vocabulary === void 0 ? void 0 : {
					ids: vocabulary.ids,
					versions: vocabulary.versions
				};
			},
			modelSelection: () => this.modelSelection(),
			sessionLog: (sessionId) => this.sessionLog(sessionId)
		};
	}
	/**
	* One session's own durable log, read through the deployment's session plane
	* (`sessionQuery.readSession`) — the source the promotion gate re-reads a
	* run's real requests from (S4-E §Q3). `undefined` when the deployment cannot
	* serve the read at all, which the gate reports as a named refusal rather than
	* skipping the check; a session the store does not hold throws, and the gate
	* names that too.
	*/
	async sessionLog(sessionId) {
		const query = optionalService(this.ctx, "sessionQuery");
		if (query === void 0 || typeof query.readSession !== "function") return void 0;
		return (await query.readSession(SessionId(sessionId))).events;
	}
	/**
	* The candidate object's provider verdict, taken from the directory the
	* promotion would write — plus the two boundaries this promotion cannot cross.
	*
	* The shape boundary (K3): the commit promotes the **fixed file set of one
	* skill object** — `SKILL.md`, plus the `SKILL.contract.json` beside it when
	* and only when the prepared identity says the object has an execution
	* sidecar. So a candidate directory that carries anything else (`references/`,
	* `scripts/`, a stray file) is refused by name, and so is a directory whose
	* file set does not match the frozen shape in either direction: a sidecar that
	* appeared where the identity records none, or one that is missing where the
	* identity records it. The role must agree with that shape too — two files
	* load as an execution provider, one file as guidance — so a candidate that
	* turned into the other kind of object is refused here rather than promoted as
	* something the frozen experiment never evaluated.
	*
	* The derivation boundary: for an execution object the candidate sidecar is
	* not the model's to write. It is re-derived here from the champion snapshot's
	* own sidecar bytes and the candidate `SKILL.md` digest, and compared with the
	* sandbox sidecar byte for byte (and by canonical digest) — so an escalated
	* `requiredTools`, a swapped verifier or any other declaration change between
	* prepare and promotion is refused by name. The champion side is checked too:
	* its bytes must still hash to the baseline identity's sidecar digest, or the
	* derivation would be built on bytes the prepare never recorded.
	*
	* Both the shape and the declaration are named when both are wrong: the
	* validator's own defects stay in the message with their codes, so this entry
	* reports the same defect vocabulary admission, config load and capability
	* replacement report for the same directory.
	*/
	async assertSkillCandidateProvider(proposal) {
		const sandbox = proposal.prepared?.sandbox;
		const identity = proposal.prepared?.skillContent;
		const baseline = proposal.prepared?.skillBaseline;
		const { name } = proposal.mutation;
		if (sandbox == null || identity === void 0) throw new Error(`evolution: proposal "${proposal.proposalId}" names no sandbox or no candidate identity; the candidate's provider role cannot be judged`);
		const directory = resolveWithin(this.root, `${sandbox}/skills/${name}`);
		const expectedFiles = identity.contract === void 0 ? ["SKILL.md"] : ["SKILL.md", SKILL_SIDECAR_FILE];
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			entries = [];
		}
		const present = entries.map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
		const unexpected = present.filter((entry) => !expectedFiles.includes(entry));
		const missing = expectedFiles.filter((file) => !present.includes(file));
		if (unexpected.length > 0 || missing.length > 0) {
			const parts = [unexpected.length === 0 ? void 0 : `carries ${unexpected.map((entry) => JSON.stringify(entry)).join(", ")}`, missing.length === 0 ? void 0 : `is missing ${missing.map((entry) => JSON.stringify(entry)).join(", ")}`].filter((part) => part !== void 0);
			throw new Error(`evolution: skill candidate "${name}" at ${directory} ${parts.join(" and ")} — one skill object is a fixed file set (${expectedFiles.map((file) => JSON.stringify(file)).join(", ")}, the shape prepare froze), so a candidate whose files moved is refused rather than promoted as an object the frozen evidence never described`);
		}
		const verdict = await this.providerVerdict({
			name,
			directory
		});
		const defects = verdict.valid ? "" : verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ");
		if (!verdict.valid) throw new Error(`evolution: skill candidate "${name}" at ${directory} is not a usable provider — ${defects}; a promotion writes only a skill a worker could load and, when it claims execution, only one whose verifier and tools the deployment can grant`);
		if (identity.contract === void 0) {
			if (verdict.role !== "guidance") throw new Error(`evolution: skill candidate "${name}" at ${directory} loads as ${verdict.role}, but the object prepare froze is guidance (no sidecar) — a candidate that changed roles is not the object the experiment evaluated, so the promotion is refused`);
			return promotionProviderOf(verdict);
		}
		if (verdict.role !== "execution-provider") throw new Error(`evolution: skill candidate "${name}" at ${directory} loads as ${verdict.role}, but the object prepare froze carries an execution sidecar — a candidate that changed roles is not the object the experiment evaluated, so the promotion is refused`);
		const contract = identity.contract;
		const championSidecar = await readVerifiedFile(this.root, `${sandbox}/champion/skills/${name}/${SKILL_SIDECAR_FILE}`);
		if (baseline?.contract === void 0 || sha256Hex(championSidecar) !== baseline.contract.sha256) throw new Error(`evolution: the champion snapshot of proposal "${proposal.proposalId}" no longer holds the sidecar bytes prepare recorded (sha256 ${sha256Hex(championSidecar)} != ${baseline?.contract?.sha256 ?? "none recorded"}) — the candidate sidecar is derived from those bytes, so a snapshot that moved cannot be the declaration this promotion would install`);
		const candidate = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`);
		if (sha256Hex(candidate) !== identity.sha256) throw new Error(`evolution: skill candidate "${sandbox}/skills/${name}/SKILL.md" no longer matches the content identity recorded at prepare (sha256 ${sha256Hex(candidate)} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		const expectedSidecar = candidateSidecar(loadedSidecar(championSidecar), identity.sha256);
		const sandboxSidecar = await readVerifiedFile(this.root, `${sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`);
		if (sandboxSidecar.toString("utf8") !== expectedSidecar || sha256Hex(sandboxSidecar) !== contract.sha256) throw new Error(`evolution: the candidate sidecar of skill "${name}" is not the declaration derived from production — the production object (the champion snapshot) with only content.skillMdSha256 rewritten to the candidate SKILL.md digest; a content update may not move capabilities, required tools, verifier or any other declaration field, so the promotion is refused`);
		if (verdict.contractDigest !== contract.contractDigest) throw new Error(`evolution: the candidate sidecar of skill "${name}" loads to declaration digest ${verdict.contractDigest}, not the ${contract.contractDigest} prepared and recorded — a declaration the record does not name is not one this promotion may install`);
		return promotionProviderOf(verdict);
	}
	/**
	* One provider candidate judged by the unified validator, with the sources the
	* deployment actually has:
	*
	* - the effective capability table (the runtime registry — what a restart
	*   re-reads from `config.yml`), asked through `capabilityToolQuery`, so a
	*   capability's grant is read by the same resolution admission performs;
	* - the registered verifier vocabulary, `ready()` first, fail-closed: an
	*   execution sidecar whose ref cannot be proven registered against a live
	*   registry is refused with the same named defect the admission pre-check
	*   uses rather than assumed valid.
	*
	* A context with no runtime registry at all answers every capability question
	* as unreadable instead of as "granting nothing": an execution provider is then
	* refused (fail-closed), while knowledge and guidance — which make no tool
	* claim — are judged by the same validator as everywhere else.
	*/
	async providerVerdict(candidate) {
		const verifierRefs = await registeredVerifierIds(this.ctx);
		if (verifierRefs === void 0 && candidate.directory !== void 0) {
			const loaded = await loadSkillSidecar(candidate.directory);
			if (loaded.sidecar?.type === "execution") return unlistableVerifierRefusal(candidate.name, candidate.directory, loaded.sidecar.verifier.ref);
		}
		return validateSkillProvider(candidate, {
			verifierRefs: verifierRefs === void 0 ? [] : [...verifierRefs],
			capabilityTools: this.capabilityToolAnswer()
		});
	}
	/**
	* The capability table this service judges providers against: the running
	* registry, which is the table a restart re-reads from `config.yml` and the one
	* `evolution_prepare` snapshots the champion from. Absent (no task-runtime in
	* this context) means the table cannot be read — reported as an unreadable
	* grant rather than mistaken for an empty table.
	*/
	capabilityToolAnswer() {
		const table = this.effectiveCapabilities();
		if (table !== void 0) return capabilityToolQuery(table);
		return () => ({
			known: false,
			reason: "the effective capability registry cannot be read in this context (no task-runtime service), so the tools this capability grants cannot be resolved"
		});
	}
	/** The effective capability table, or `undefined` when this context cannot read one (no task-runtime service). */
	effectiveCapabilities() {
		const runtime = optionalService(this.ctx, "taskRuntime");
		try {
			return runtime?.listCapabilities?.();
		} catch {
			return;
		}
	}
	/**
	* Read a prepared skill candidate's materialized object and verify it against
	* the content identity recorded at prepare (P2): the `SKILL.md` bytes, plus
	* the sidecar bytes when and only when the identity records a sidecar. The one
	* read path every stage shares: the experiment's pre-run check, every promotion
	* gate, and the apply write. Throws — never silently re-digests — when a
	* recorded file is missing, is not a regular file, its path crosses a symbolic
	* link, its bytes no longer match the recorded digest, or the sidecar's
	* presence does not match the recorded shape.
	*/
	async readSkillCandidate(proposalId) {
		return this.readVerifiedSkillCandidate(await this.get(proposalId));
	}
	/**
	* The production-baseline check (P3), on the apply seams only: the
	* evolution_apply tool runs it before asking a human, and `apply` runs it
	* again immediately before the production write, so a baseline that moved
	* while the human was deciding is still refused and a direct service call
	* cannot bypass it. Nothing here writes, merges, or overwrites — a conflict
	* only throws.
	*
	* The prepare-time baseline is a real, complete object: its `SKILL.md` bytes
	* still hash to the recorded digest, and — when the baseline records a
	* sidecar — the production `SKILL.contract.json` is there with exactly the
	* bytes prepare recorded. A missing file, a file that changed, changed type
	* (now a directory), or sits behind a symbolic link (the file itself or an
	* ancestor) is a conflict, and so is a sidecar that appeared beside a baseline
	* that had none: the shape production would be loaded in has changed, which is
	* a third party's edit like any other. Only `targetType: skill` carries a
	* baseline; every other targetType passes untouched.
	*/
	async checkProductionBaseline(proposalId) {
		await this.assertProductionBaseline(await this.get(proposalId));
	}
	async assertProductionBaseline(proposal) {
		if (proposal.targetType !== "skill") return;
		const prepared = proposal.prepared;
		if (prepared?.mechanical !== true || prepared.sandbox == null) return;
		const { name } = proposal.mutation;
		const target = `${this.skillRoot}/${name}/SKILL.md`;
		const guidance = "create a new candidate from the current production state and re-evaluate it; an apply never overwrites a production skill it cannot verify";
		const identity = prepared.skillBaseline;
		if (identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" records no production baseline identity — ${guidance}`);
		let current;
		try {
			current = await readProductionSkill(this.skillRoot, productionSkillRelative(name));
		} catch (error) {
			throw new Error(`evolution: the production skill "${target}" is no longer a readable regular file (${error.message.replace(/^evolution: /, "")}) — ${guidance}`);
		}
		if (current === null) throw new Error(`evolution: the production skill "${target}" recorded at prepare (sha256 ${identity.sha256}) no longer exists — ${guidance}`);
		if (current.sha256 !== identity.sha256) throw new Error(`evolution: the production skill "${target}" changed since prepare (sha256 ${current.sha256} != ${identity.sha256}) — ${guidance}`);
		let sidecar;
		try {
			sidecar = await readProductionSkill(this.skillRoot, productionSidecarRelative(name));
		} catch (error) {
			throw new Error(`evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" is no longer a readable regular file (${error.message.replace(/^evolution: /, "")}) — ${guidance}`);
		}
		if (identity.contract !== void 0) {
			if (sidecar === null) throw new Error(`evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" recorded at prepare (sha256 ${identity.contract.sha256}) no longer exists — ${guidance}`);
			if (sidecar.sha256 !== identity.contract.sha256) throw new Error(`evolution: the production sidecar "${this.skillRoot}/${name}/${SKILL_SIDECAR_FILE}" changed since prepare (sha256 ${sidecar.sha256} != ${identity.contract.sha256}) — ${guidance}`);
			return;
		}
		if (sidecar !== null) throw new Error(`evolution: the production skill "${name}" now carries a ${SKILL_SIDECAR_FILE} the baseline prepare recorded did not have (sha256 ${sidecar.sha256}) — the object production would load is not the object the candidate was prepared and evaluated against; ${guidance}`);
	}
	async readVerifiedSkillCandidate(proposal) {
		if (proposal.targetType !== "skill") throw new Error(`evolution: candidate content identity binds skill proposals only, not "${proposal.targetType}"`);
		const sandbox = proposal.prepared?.sandbox;
		const identity = proposal.prepared?.skillContent;
		if (sandbox == null || identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" carries no recorded candidate content identity — propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized files)`);
		const rel = `${sandbox}/skills/${identity.name}/SKILL.md`;
		const skillMd = await readVerifiedFile(this.root, rel);
		const digest = sha256Hex(skillMd);
		if (digest !== identity.sha256) throw new Error(`evolution: skill candidate "${rel}" no longer matches the content identity recorded at prepare (sha256 ${digest} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		const sidecarRel = `${sandbox}/skills/${identity.name}/${SKILL_SIDECAR_FILE}`;
		let sidecar;
		try {
			sidecar = await readVerifiedFile(this.root, sidecarRel);
		} catch (error) {
			const reason = error.message.replace(/^verified-read: /, "");
			if (identity.contract === void 0) {
				if (/is missing under/.test(error.message)) return { skillMd };
				throw new Error(`evolution: skill candidate "${sidecarRel}" is present but cannot be read as a real file (${reason}), while the content identity recorded at prepare is guidance (no sidecar) — propose a new candidate and re-evaluate it`);
			}
			throw new Error(`evolution: skill candidate "${sidecarRel}" recorded at prepare (sha256 ${identity.contract.sha256}) cannot be read as a real file (${reason}) — propose a new candidate and re-evaluate it`);
		}
		if (identity.contract === void 0) throw new Error(`evolution: skill candidate "${sidecarRel}" exists in the sandbox, but the content identity recorded at prepare is guidance (no sidecar) — the candidate is no longer the object the experiment evaluated: propose a new candidate and re-evaluate it`);
		const sidecarDigest = sha256Hex(sidecar);
		if (sidecarDigest !== identity.contract.sha256) throw new Error(`evolution: skill candidate "${sidecarRel}" no longer matches the content identity recorded at prepare (sha256 ${sidecarDigest} != ${identity.contract.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		return {
			skillMd,
			sidecar
		};
	}
	/**
	* Move applied → rolledback: undo the apply by restoring the champion snapshot
	* taken at prepare, as one commit — the same intent → atomic write →
	* completion order as apply, so an interrupted rollback is recoverable the
	* same way, including between the two files of one object. A record of another
	* target type has no executor here: this build writes and restores the fixed
	* file set of one skill object only, and an applied capability row or preset
	* directory is refused by name rather than touched. Same approval discipline
	* as apply: the tool asks a human first, the service only executes and records.
	*
	* A rollback restores *this* proposal's baseline and nothing else, so both
	* ends are re-verified per file before the intent is recorded: every
	* production file must still carry exactly the content this proposal applied
	* (`prepared.skillContent`, P2), and every champion snapshot file must still
	* hash to the baseline prepare recorded (`prepared.skillBaseline`, P3). A file
	* a later proposal — or any other writer — changed since is refused by name
	* with nothing written, and so is a snapshot that can no longer reproduce the
	* bytes it captured: neither may be papered over by restoring an old version
	* on top of a newer one. The *directory* is checked too, by the same
	* pre-write read of the whole object a fresh commit and a recovery both run
	* ({@link objectWriteRefusal}): a rollback of a guidance object whose
	* directory grew a `SKILL.contract.json` or a file at a supported resource
	* position is refused by name before the intent line, because writing the
	* champion `SKILL.md` back would otherwise leave that entry standing — as a
	* role the completion never claimed, or a file nothing declared.
	*
	* As in {@link apply}, an open intent of this proposal is settled rather than
	* duplicated, and the result reports the recovery; an open intent of another
	* proposal that commits the same skill directory refuses this rollback by name
	* before anything is read or written ({@link assertTargetUncommitted}).
	*/
	async rollback(proposalId, actor, approvalRef) {
		await this.assertNext(proposalId, "rolledback");
		nonEmpty(approvalRef, "approvalRef");
		return this.commitExclusive(async () => {
			const proposal = await this.get(proposalId);
			const open$1 = proposal.openIntent;
			if (open$1 !== void 0) {
				if (open$1.direction !== "rollback") throw new Error(`evolution: proposal "${proposalId}" has an open apply commit intent ("${open$1.intentId}") — rollback cannot complete an apply; settle that intent (reconcile, or evolution_apply) before rolling anything back`);
				const recovered = await this.settleOpenIntent(open$1);
				return {
					targets: open$1.files.map((file) => file.target),
					recovered,
					proposal: await this.get(proposalId)
				};
			}
			this.assertTargetUncommitted(proposal);
			const request = this.commitRequest(proposal, "rollback", actor, approvalRef);
			const prepared = proposal.prepared;
			const applied = prepared.skillContent;
			const name = proposal.mutation.name;
			for (const [index, file] of request.files.entries()) {
				const relative$1 = index === 0 ? productionSkillRelative(name) : productionSidecarRelative(name);
				const expected = index === 0 ? applied.sha256 : applied.contract.sha256;
				const current = await readProductionSkill(this.skillRoot, relative$1);
				if (current === null || current.sha256 !== expected) throw new Error(`evolution: the production file "${file.target}" does not hold the content proposal "${proposalId}" applied (sha256 ${current?.sha256 ?? "missing"} != ${expected}) — a rollback restores the baseline of the object this proposal applied, and a file another writer (or a later proposal) changed is left exactly as it is: nothing was written and no commit intent was recorded`);
			}
			const championFiles = [];
			for (const [index, file] of request.files.entries()) {
				const expected = index === 0 ? prepared.skillBaseline.sha256 : prepared.skillBaseline.contract.sha256;
				const snapshot = await readVerifiedFile(this.root, file.source);
				const digest = sha256Hex(snapshot);
				if (digest !== expected) throw new Error(`evolution: the champion snapshot "${file.source}" of proposal "${proposalId}" no longer hashes to the production baseline recorded at prepare (sha256 ${digest} != ${expected}) — the snapshot cannot restore the bytes it captured: nothing was written and no commit intent was recorded`);
				championFiles.push(snapshot);
			}
			await commitIntent(this.commitHost(), request, championFiles);
			return {
				targets: request.files.map((file) => file.target),
				proposal: await this.get(proposalId)
			};
		});
	}
	/**
	* Settle every open commit intent, in ledger order (K2) — the explicit startup
	* and resume entry. Nothing calls this implicitly: no read path, no `get` /
	* `list`, and no tool call reconciles as a side effect, so a query stays a
	* query and a deployment decides when a recovery is due.
	*
	* Each intent is settled by {@link settleOpenIntent} under the same serial
	* queue a fresh commit takes, and each outcome is reported by name:
	* `completed-redone` (production still held the pre-commit state, so the same
	* write was carried out), `completed-written` (production already held the
	* committed content, so only the completion was recorded) or `blocked` (a
	* source that is gone or changed, a target that holds neither state — the
	* intent stays open and nothing is overwritten). A blocked intent does not
	* throw: the rest of the batch is still settled, and the caller decides what a
	* human does about it. A real I/O failure of a redo write is not a blocked
	* commit and does throw.
	*
	* Repeating it is free: a settled intent has no open intent left, so the fold
	* refuses a second completion and this call reports nothing for it.
	*/
	async reconcile() {
		await this.loaded;
		const outcomes = [];
		for (const intent of this.openIntents(this.fold(this.records))) {
			const outcome = await this.commitExclusive(async () => {
				const open$1 = this.fold(this.records).get(intent.proposalId)?.openIntent;
				if (open$1 === void 0 || open$1.intentId !== intent.intentId) return void 0;
				return reconcileIntent(this.commitHost(), open$1);
			});
			if (outcome !== void 0) outcomes.push(outcome);
		}
		return outcomes;
	}
	/**
	* The production targets a commit has left open (K2), in ledger order — the
	* pure read an admission gate or a loader uses to see what must not be loaded
	* until a reconciliation settled it. It writes nothing, and it never
	* reconciles: settling is {@link reconcile}'s call to make, at the moment the
	* deployment decides recovery is due.
	*/
	async openIntentTargets() {
		await this.loaded;
		return this.openIntents(this.fold(this.records)).flatMap((intent) => intent.files.map((file) => file.target));
	}
	/** Every commit intent still open, in ledger order — one per proposal at most, validated by the fold. */
	openIntents(proposals) {
		const open$1 = [];
		const seen = /* @__PURE__ */ new Set();
		for (const record of this.records) {
			if (record.kind !== "commit_intent") continue;
			const intent = proposals.get(record.proposalId)?.openIntent;
			if (intent === void 0 || intent.intentId !== record.intentId || seen.has(intent.intentId)) continue;
			seen.add(intent.intentId);
			open$1.push(intent);
		}
		return open$1;
	}
	/**
	* Settle one open intent for a caller that named it (an apply/rollback retry),
	* where a blocked commit is the caller's answer and not a batch's footnote:
	* the named stop is thrown with the reason intact.
	*/
	async settleOpenIntent(intent) {
		const outcome = await reconcileIntent(this.commitHost(), intent);
		if (outcome.result === "blocked") throw new Error(outcome.detail ?? `evolution: commit intent "${intent.intentId}" cannot be settled`);
		return outcome.result === "completed-redone" ? "redone" : "written";
	}
	/**
	* The commit request one apply/rollback binds, read off the prepared record
	* the proposal already carries: every file of the object's fixed set with its
	* absolute target (the same paths {@link applyTargets} names to the human), the
	* content identity production must hold before and after that file, and the
	* recoverable source under the ledger root. `apply` commits the candidate files
	* over the recorded baseline; `rollback` commits the champion snapshot files
	* over the content the apply installed — the two identities swap per file, and
	* nothing else about the two directions differs. The order is the object's:
	* `SKILL.md` first, the sidecar second when there is one.
	*/
	commitRequest(proposal, direction, actor, approvalRef) {
		if (proposal.targetType !== "skill") throw new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores the fixed file set of one skill object only, so there is no executor to ${direction} an applied ${proposal.targetType} record`);
		const prepared = proposal.prepared;
		const content = prepared?.skillContent;
		const baseline = prepared?.skillBaseline;
		if (prepared?.sandbox == null || prepared.champion !== "captured" || proposal.mutation === void 0 || content === void 0 || baseline === void 0) throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`);
		const { name } = proposal.mutation;
		if (content.name !== name || baseline.name !== name) throw new Error(`evolution: proposal "${proposal.proposalId}" records content identities for skill "${content.name}/${baseline.name}" but its mutation names "${name}" — the commit cannot write one skill's verified bytes onto another skill's target`);
		const contentContract = content.contract;
		const baselineContract = baseline.contract;
		if (contentContract === void 0 !== (baselineContract === void 0)) throw new Error(`evolution: proposal "${proposal.proposalId}" records a candidate object and a production baseline of different shapes (${contentContract === void 0 ? "guidance" : "execution"} vs ${baselineContract === void 0 ? "guidance" : "execution"}) — a commit moves one object between two versions of the same shape`);
		const targets = this.commitTargets(proposal);
		const files = [direction === "apply" ? {
			target: targets[0],
			baselineSha256: baseline.sha256,
			contentSha256: content.sha256,
			source: `${prepared.sandbox}/skills/${name}/SKILL.md`
		} : {
			target: targets[0],
			baselineSha256: content.sha256,
			contentSha256: baseline.sha256,
			source: `${prepared.sandbox}/champion/skills/${name}/SKILL.md`
		}];
		if (contentContract !== void 0 && baselineContract !== void 0) files.push(direction === "apply" ? {
			target: targets[1],
			baselineSha256: baselineContract.sha256,
			contentSha256: contentContract.sha256,
			source: `${prepared.sandbox}/skills/${name}/${SKILL_SIDECAR_FILE}`
		} : {
			target: targets[1],
			baselineSha256: contentContract.sha256,
			contentSha256: baselineContract.sha256,
			source: `${prepared.sandbox}/champion/skills/${name}/${SKILL_SIDECAR_FILE}`
		});
		return {
			proposalId: proposal.proposalId,
			direction,
			approvalRef,
			files,
			actor
		};
	}
	/**
	* The production paths a commit of this proposal may write: the object's fixed
	* file set under `<skillRoot>/<name>/` — `SKILL.md` always, and the
	* `SKILL.contract.json` beside it when the prepared identity records an
	* execution sidecar — each confined to the skill root, in commit order.
	*/
	commitTargets(proposal) {
		const name = proposal.mutation.name;
		const targets = [resolveWithin(this.skillRoot, productionSkillRelative(name))];
		if (proposal.prepared?.skillContent?.contract !== void 0) targets.push(resolveWithin(this.skillRoot, productionSidecarRelative(name)));
		return targets;
	}
	/**
	* A fresh commit of `proposal` refuses, by name, a production **directory**
	* another proposal's open commit intent touches. {@link commitExclusive}
	* serializes one process's commits and nothing else, so a second commit queued
	* behind an unfinished first one would read the pre-commit bytes, pass its own
	* baseline check and move the target, leaving the first intent with no commit
	* path left to settle it: `blocked` by name, its target refused by admission
	* until something restores the bytes that intent names as its baseline. The
	* per-object gate is what stops that; it matches on the directory that holds
	* the files, because one intent covers a skill's fixed file set together — a
	* second proposal prepared against the same skill is blocked by whichever file
	* of the other intent this proposal's file set shares a directory with. It is
	* in-process, per production object and under the deployment's existing
	* single-writer constraint — not a distributed lock, not a queue and not a
	* retry loop; the intent is settled first, by {@link reconcile} or by a retry
	* of the proposal that owns it.
	*
	* Only a materialized skill mutation has commit targets this build may write:
	* every other proposal keeps the named refusal its own entry produces
	* ({@link checkPromotion}, {@link commitRequest}).
	*/
	assertTargetUncommitted(proposal) {
		if (proposal.targetType !== "skill" || proposal.mutation === void 0) return;
		const directories = new Set(this.commitTargets(proposal).map((target) => dirname(target)));
		for (const other of this.fold(this.records).values()) {
			const intent = other.openIntent;
			if (intent === void 0 || other.proposalId === proposal.proposalId) continue;
			const shared = intent.files.map((file) => dirname(resolve(file.target))).find((directory) => directories.has(directory));
			if (shared === void 0) continue;
			throw new Error(`evolution: the open commit intent "${intent.intentId}" of proposal "${other.proposalId}" (direction "${intent.direction}") commits the production skill directory "${shared}" — proposal "${proposal.proposalId}" does not commit over another proposal's unsettled intent; settle that intent first (reconcile, or a retry of the proposal that owns it): nothing was written and no commit intent was recorded`);
		}
	}
	/**
	* The named reason a commit intent must not write the directory its file set
	* lives in, or `null` when that directory holds this object's own files and
	* nothing else — the *pre-write* half of the whole-object rule (K3-4: a third
	* party's change is never overwritten, and the object a completion claims is
	* the object the directory really holds).
	*
	* The per-file digests an intent records describe the files it *names*, so an
	* entry it does not name is exactly what they cannot see: a directory that grew
	* one — a guidance skill wearing a declaration nobody wrote through this
	* service, a resource no identity covers — passes every pre-write check, is
	* written anyway, and only the whole-object verification *after* the write
	* notices, with production already moved and the intent left open. This asks
	* the same question of the same directory before a byte moves, and it is the
	* only check that can answer it there.
	*
	* An execution object's fixed file set is two named files in one directory and
	* its declaration names every file the object covers, so the directory must
	* name exactly those two basenames back — plus each target's own staging
	* leftovers (`.${basename}.tmp-`, non-directories: the same rule, in the same
	* directory, the commit path's own sweep uses, so a recovery can still sweep
	* the temp file a killed attempt left). Any other entry — an undeclared
	* resource, a stranger's file, a directory under a supported resource name — is
	* refused by name: an execution object that does not name every file in its
	* directory is not the object its declaration describes. The loader's tolerance
	* for entries outside the supported vocabulary does not apply here for the same
	* reason: an execution declaration covers files, not a word list.
	*
	* A guidance object is one file with no declaration for a loader to hold the
	* directory to, so the question is asked of the loader ({@link loadSkillSidecar}
	* — the same read prepare, admission and the write-time verification use) and
	* the directory is refused when it now carries a sidecar (guidance that turned
	* into an execution object: the role this intent's committed file set does not
	* describe), when it holds a file at a supported resource position (a file no
	* identity covers, which a one-file commit would leave in place while claiming
	* to have written the object), or when it is no longer a loadable object at all
	* (`defects`). Entries the supported vocabulary does not cover (`uncovered`)
	* are deliberately tolerated: the guidance verdict judges those no defect, and
	* a guidance commit has always left them exactly where they are.
	*
	* A mixed pair — one file still at the baseline, the other already holding the
	* committed content — passes, as it must: that is the window an interrupted
	* two-file commit leaves for a recovery to finish, not a foreign change. This
	* reads the directory and writes nothing.
	*/
	async objectWriteRefusal(intent) {
		const skillMd = intent.files[0];
		const directory = dirname(skillMd.target);
		if (intent.files.length === 1) {
			const loaded = await loadSkillSidecar(directory);
			if (loaded.sidecar !== void 0) return `the guidance object this intent commits is the single file "${basename(skillMd.target)}", and the directory now carries a ${SKILL_SIDECAR_FILE} the intent does not name — it is an execution object the committed file set does not describe`;
			const resources = loaded.content?.resources.map((resource) => resource.path) ?? [];
			if (resources.length > 0) return `the guidance object this intent commits is the single file "${basename(skillMd.target)}", and the directory now holds ${resources.length} file(s) at a supported resource position the intent does not name (${resources.map((path) => JSON.stringify(path)).join(", ")}) — nothing declares them and no commit of this build writes them`;
			if (loaded.defects.length > 0) return "the directory is not the loadable object its files claim — " + loaded.defects.map((item) => `${item.code}: ${item.detail}`).join("; ");
			return null;
		}
		const own = new Set(intent.files.map((file) => basename(file.target)));
		const staging = [...own].map((name) => `.${name}.tmp-`);
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			return `the production directory "${directory}" cannot be read to check what it holds (${error instanceof Error ? error.message : String(error)}) — an execution object's identity names every file in its directory, so the entries this commit would leave beside its own are unknown`;
		}
		const foreign = entries.filter((entry) => !own.has(entry.name) && !(staging.some((prefix) => entry.name.startsWith(prefix)) && !entry.isDirectory())).map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
		if (foreign.length === 0) return null;
		return `an execution object's fixed file set names every file in its directory (${[...own].sort().map((name) => JSON.stringify(name)).join(", ")}), and the directory holds ${foreign.length} entr${foreign.length === 1 ? "y" : "ies"} the intent does not name (${foreign.map((name) => JSON.stringify(name)).join(", ")})`;
	}
	/**
	* The narrow host the commit path runs on (see `commit.ts`): the roots a
	* target and a source resolve against, the service's own verified reads — P2
	* for a candidate, the walk-verified production read, the ledger-root read for
	* a snapshot — the append funnel every line goes through (format check, staged
	* fold, serialized write), the whole-object checks that open and close a commit
	* (what the directory must be before anything is written, what it is after),
	* and the probe seam. The commit path owns the order; the service owns what
	* may be read, what a line must say, and what "production is the object this
	* direction promised" means.
	*/
	commitHost() {
		return {
			root: this.root,
			skillRoot: this.skillRoot,
			append: (record) => this.append(record),
			readSource: async (source, sha256) => {
				const bytes = await readVerifiedFile(this.root, source);
				const digest = sha256Hex(bytes);
				if (digest !== sha256) throw new Error(`the recorded source "${source}" no longer holds the committed bytes (sha256 ${digest} != ${sha256}); recorded identities are never re-digested`);
				return bytes;
			},
			readProduction: (relative$1) => readProductionSkill(this.skillRoot, relative$1),
			objectWriteRefusal: (intent) => this.objectWriteRefusal(intent),
			verifyCommitted: (intent) => this.verifyCommitted(intent),
			probe: (stage, target) => this.commitProbe?.(stage, target)
		};
	}
	/**
	* The whole-object verification a commit runs after its last file is written
	* and before the completion is recorded — in a fresh commit and in every
	* reconciliation branch that records one.
	*
	* It reads production the way a loader does (`loadSkillSidecar` through the
	* same {@link providerVerdict} every promotion uses, so the verdict carries
	* the verifier vocabulary and the capability table this deployment really
	* has) and requires that the directory *is* one loadable object carrying the
	* identity this direction promised:
	*
	* - the verdict is valid — no defect of any kind: a `SKILL.md` a declaration
	*   does not cover, a declaration the bytes do not match, a file nobody
	*   declares, a file set the shape rules refuse;
	* - the role matches the file set the intent committed: two files load as an
	*   execution provider, one file as guidance (a knowledge verdict is
	*   impossible here, and would be refused by the same comparison);
	* - `SKILL.md` carries the digest the first file's record named;
	* - with two files, the production sidecar's exact bytes hash to the second
	*   file's record, and the loaded declaration digest is the one the direction
	*   promised — for an apply the candidate identity prepare recorded, for a
	*   rollback the production baseline it recorded. This is also what makes the
	*   completion a statement about the registry: `contractDigest` is exactly the
	*   identity a registry revision absorbs, so by the time the completion line
	*   is written, the registry's own view of the skill is already the new object.
	*
	* A throw is a named refusal: the intent stays open, no completion is
	* recorded, and the caller and the next reconciliation both see the same
	* refusal rather than a settled commit a loader would not accept. It never
	* writes: this check reads production as it stands. Its counterpart is the
	* *before* picture, {@link objectWriteRefusal}, asked of the same directory
	* before the intent line and before any branch of a recovery writes — this one
	* closes the window after the write, that one keeps a directory which is not
	* the object from being written at all.
	*/
	async verifyCommitted(intent) {
		const skillMd = intent.files[0];
		const directory = dirname(skillMd.target);
		const name = basename(directory);
		const twoFiles = intent.files.length === 2;
		const verdict = await this.providerVerdict({
			name,
			directory
		});
		const defects = verdict.valid ? "" : verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ");
		if (!verdict.valid) throw new Error(`evolution: the production skill object "${directory}" does not load after the ${intent.direction} of proposal "${intent.proposalId}" — ${defects}; the commit intent stays open and no completion is recorded, because production is neither the state before the commit nor a loadable object`);
		const expectedRole = twoFiles ? "execution-provider" : "guidance";
		if (verdict.role !== expectedRole) throw new Error(`evolution: the production skill object "${directory}" loads as ${verdict.role} after the ${intent.direction} of proposal "${intent.proposalId}", not as the ${expectedRole} its committed file set describes — the commit intent stays open and no completion is recorded`);
		if (verdict.content.skillMdSha256 !== skillMd.contentSha256) throw new Error(`evolution: the production file "${skillMd.target}" does not carry the committed content after the ${intent.direction} of proposal "${intent.proposalId}" (sha256 ${verdict.content.skillMdSha256} != ${skillMd.contentSha256}) — the commit intent stays open and no completion is recorded`);
		if (!twoFiles) return;
		if (verdict.role !== "execution-provider") return;
		const sidecarFile = intent.files[1];
		const sidecarDigest = sha256Hex(await readVerifiedFile(this.skillRoot, productionSidecarRelative(name)));
		if (sidecarDigest !== sidecarFile.contentSha256) throw new Error(`evolution: the production file "${sidecarFile.target}" does not carry the committed content after the ${intent.direction} of proposal "${intent.proposalId}" (sha256 ${sidecarDigest} != ${sidecarFile.contentSha256}) — the commit intent stays open and no completion is recorded`);
		const proposal = await this.get(intent.proposalId);
		const promised = intent.direction === "apply" ? proposal.prepared?.skillContent : proposal.prepared?.skillBaseline;
		if (promised?.contract === void 0 || verdict.contractDigest !== promised.contract.contractDigest) throw new Error(`evolution: the production skill "${name}" loads to declaration digest ${verdict.contractDigest} after the ${intent.direction} of proposal "${intent.proposalId}", not the ${promised?.contract?.contractDigest ?? "identity without a sidecar half"} this direction recorded — the commit intent stays open and no completion is recorded, because the object a registry would absorb is not the one the proposal promised`);
	}
	/**
	* Serialize one commit — its intent, its production write and its completion —
	* behind every commit already running or queued, and behind every write the
	* ledger funnel has not appended yet. This is a single-process queue, not a
	* cross-process lock: the deployment's one-writer constraint still stands, and
	* a second process is not excluded. Serialization is not what keeps two
	* proposals on one target apart — a queued second commit would read the
	* pre-commit bytes and refuse only if its own baseline check happened to
	* disagree — so a fresh commit also refuses a target another proposal's open
	* intent names ({@link assertTargetUncommitted}).
	*/
	async commitExclusive(run) {
		const chained = this.commits.then(run);
		this.commits = chained.then(() => void 0, () => void 0);
		return chained;
	}
	/** Folded view of one proposal, or throws on an unknown id. */
	async get(proposalId) {
		await this.loaded;
		const proposal = this.fold(this.records).get(proposalId);
		if (proposal === void 0) throw new Error(`evolution: unknown proposal "${proposalId}"`);
		return proposal;
	}
	/** Folded views, newest proposal first, optionally filtered. */
	async list(filter = {}) {
		await this.loaded;
		return [...this.fold(this.records).values()].reverse().filter((proposal) => (filter.status === void 0 || proposal.status === filter.status) && (filter.targetType === void 0 || proposal.targetType === filter.targetType) && (filter.targetId === void 0 || proposal.targetId === filter.targetId));
	}
	refExistsOnDisk(ref) {
		return existsSync(isAbsolute(ref) ? ref : resolve(this.repoRoot, ref));
	}
	/**
	* Early state-machine check so a wrong-state call reports the transition
	* error before any payload validation; `append` re-checks under the write
	* lock, which is the authoritative gate. Returns the folded proposal so
	* callers can validate payloads against targetType / baseVersion / mutation.
	*/
	async assertNext(proposalId, kind) {
		await this.loaded;
		const current = this.fold(this.records).get(proposalId);
		if (current === void 0) throw new Error(`evolution: unknown proposal "${proposalId}"`);
		assertTransition(current, kind);
		return current;
	}
	/**
	* Write the candidate object into the sandbox dir `dir`, then the champion
	* snapshot from the production bytes the caller already read (P3: one read of
	* the production files, before anything was written — those bytes become the
	* snapshot and the recorded `skillBaseline` identity together, so the two can
	* never describe two different reads). The candidate's sidecar, when the
	* object has one, is *derived* here ({@link candidateSidecar}) and not taken
	* from the mutation: the model submits `SKILL.md` text and nothing else. Every
	* path goes through `resolveWithin`, so a write can never land outside the
	* sandbox; the production skill root is read-only here.
	*/
	async materialize(dir, mutation, production) {
		const files = [];
		const write = async (rel, content$1) => {
			const abs = resolveWithin(dir, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content$1);
			files.push(rel);
		};
		const { name, content } = mutation;
		const candidateMd = Buffer.from(content, "utf8");
		await write(`skills/${name}/SKILL.md`, candidateMd);
		if (production.sidecar !== void 0) await write(`skills/${name}/${SKILL_SIDECAR_FILE}`, candidateSidecar(loadedSidecar(production.sidecar), sha256Hex(candidateMd)));
		await write(`champion/skills/${name}/SKILL.md`, production.skillMd);
		if (production.sidecar !== void 0) {
			await write(`champion/skills/${name}/${SKILL_SIDECAR_FILE}`, production.sidecar);
			return {
				files,
				skillBaseline: {
					name,
					sha256: sha256Hex(production.skillMd),
					contract: contractIdentityOf(production.sidecar)
				}
			};
		}
		return {
			files,
			skillBaseline: {
				name,
				sha256: sha256Hex(production.skillMd)
			}
		};
	}
	/**
	* Fold records into proposals, enforcing the state machine on every step:
	* proposed starts a new id; each later kind must be exactly an allowed next
	* state, and payload-bearing kinds re-run the write path's payload
	* validation (candidate versionSet/mutation, gate answers, the
	* prepared/applied/rolledback shapes), so a hand-forged line fails
	* load exactly as it would fail append. The same rules guard folding and live
	* appends, so an illegal migration is rejected identically in both paths.
	*
	* The fold admits the shape the current entries write and nothing else (S4-E
	* 收尾): a candidate is a skill mutation, a prepared record carries both
	* content identities a prepare captured, and a decided record names the human
	* approval that granted it. A line missing any of them is refused here,
	* before any later entry can act on the state it would have folded to.
	*
	* Commit intents (K2) fold here too, because they are the one place where a
	* ledger line is judged against the *other* lines around it: a `commit_intent`
	* is admitted only for a proposal in the state its direction commits (`apply`
	* from decided, `rollback` from applied), only with the derived id
	* `<proposalId>/<direction>`, only with a well-formed fixed file set, and only
	* when the proposal has no other open intent; an `applied`/`rolledback`
	* completion is admitted only when it closes the open intent of its own
	* direction — same id, same approval, that exact file set in the intent's own
	* order — and it closes it. So a completion cannot be recorded without its
	* intent, cannot borrow another approval or another target, and cannot be
	* recorded twice: the second line has nothing left to close.
	*
	* The experiment family is not a lifecycle transition and is skipped here;
	* {@link foldLedger} folds it beside this fold.
	*/
	fold(records) {
		const proposals = /* @__PURE__ */ new Map();
		for (const record of records) {
			if (isExperimentRecord(record)) continue;
			if (record.kind === "commit_intent") {
				const current$1 = proposals.get(record.proposalId);
				if (current$1 === void 0) throw new Error(`evolution: unknown proposal "${record.proposalId}"`);
				validateCommitIntent(record);
				const intent = {
					intentId: record.intentId,
					proposalId: record.proposalId,
					direction: record.direction,
					approvalRef: record.approvalRef,
					files: record.files.map((file) => ({ ...file })),
					actor: record.actor,
					at: record.at
				};
				if (record.intentId !== `${record.proposalId}/${record.direction}`) throw new Error(`evolution: commit_intent record for "${record.proposalId}" names intentId "${record.intentId}" — an intent's id is "<proposalId>/<direction>", so this one is "${record.proposalId}/${record.direction}"`);
				if (current$1.openIntent !== void 0) throw new Error(`evolution: proposal "${record.proposalId}" already has the open commit intent "${current$1.openIntent.intentId}" — one commit at a time: the intent for "${record.intentId}" is refused until that one is completed or settled`);
				const requiredStatus = record.direction === "apply" ? "decided" : "applied";
				if (current$1.status !== requiredStatus) throw new Error(`evolution: commit_intent record "${record.intentId}" needs proposal "${record.proposalId}" to be ${requiredStatus} (it is ${current$1.status}) — an apply commits a decided proposal and a rollback an applied one`);
				current$1.openIntent = intent;
				continue;
			}
			const current = proposals.get(record.proposalId);
			if (record.kind === "proposed") {
				if (current !== void 0) throw new Error(`evolution: proposal "${record.proposalId}" already exists`);
				proposals.set(record.proposalId, {
					proposalId: record.proposalId,
					targetType: record.targetType,
					targetId: record.targetId,
					baseVersion: record.baseVersion,
					level: record.level,
					rationale: record.rationale,
					sourceRefs: [...record.sourceRefs],
					status: "proposed",
					history: [{
						status: "proposed",
						actor: record.actor,
						at: record.at
					}]
				});
				continue;
			}
			if (current === void 0) throw new Error(`evolution: unknown proposal "${record.proposalId}"`);
			assertTransition(current, record.kind);
			current.history.push({
				status: record.kind,
				actor: record.actor,
				at: record.at
			});
			switch (record.kind) {
				case "candidate":
					if (current.targetType !== "skill") throw new Error(`evolution: candidate record for "${record.proposalId}" targets "${current.targetType}" — this build's candidate lifecycle is a SKILL.md replacement of an existing skill object, and no other target type has an evaluator here`);
					validateVersionSet(record.versionSet);
					validateMutation(current.targetType, record.mutation);
					current.mutation = structuredClone(record.mutation);
					current.versionSet = { ...record.versionSet };
					break;
				case "prepared": {
					if (record.mechanical !== true || record.champion !== "captured" || typeof record.sandbox !== "string" || record.sandbox.length === 0) throw new Error(`evolution: prepared record for "${record.proposalId}" is not a materialized skill prepare (mechanical=${String(record.mechanical)}, champion=${JSON.stringify(record.champion ?? null)}, sandbox=${JSON.stringify(record.sandbox ?? null)}) — this build prepares a replacement of one skill object only`);
					if (!Array.isArray(record.files) || record.files.some((file) => typeof file !== "string")) throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`);
					const skillContent = preparedIdentity(record.skillContent, "skillContent", record.proposalId);
					const skillBaseline = preparedIdentity(record.skillBaseline, "skillBaseline", record.proposalId);
					if (skillContent.contract === void 0 !== (skillBaseline.contract === void 0)) throw new Error(`evolution: prepared record for "${record.proposalId}" mixes object shapes — its candidate identity is ${skillContent.contract === void 0 ? "guidance (no sidecar)" : "an execution object (with a sidecar)"} while its production baseline is ${skillBaseline.contract === void 0 ? "guidance (no sidecar)" : "an execution object (with a sidecar)"} — one prepare freezes one object, so a candidate that changed roles is refused at the fold`);
					current.prepared = {
						sandbox: record.sandbox,
						mechanical: true,
						champion: "captured",
						skillContent,
						skillBaseline,
						files: [...record.files]
					};
					break;
				}
				case "gated":
					validateGateAnswers(record.gate);
					current.gate = record.gate;
					break;
				case "decided":
					current.decision = record.decision;
					if (record.note !== void 0) current.decisionNote = record.note;
					if (typeof record.approvalRef !== "string" || record.approvalRef.length === 0) throw new Error(`evolution: decided record for "${record.proposalId}" has no human-approval evidence ref — every decision this build records was granted through a human approval and carries that call id`);
					current.decisionApprovalRef = record.approvalRef;
					break;
				case "applied":
				case "rolledback": {
					if (!Array.isArray(record.targets) || record.targets.length === 0 || record.targets.some((target) => typeof target !== "string" || target.length === 0)) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has a malformed target list`);
					if (typeof record.approvalRef !== "string" || record.approvalRef.length === 0) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has no human-approval evidence ref`);
					if (typeof record.intentId !== "string" || record.intentId.length === 0) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" names no commit intent — every completion this build writes closes the \`commit_intent\` line its commit persisted before the write, and carries that intentId`);
					const open$1 = current.openIntent;
					const expectedDirection = record.kind === "applied" ? "apply" : "rollback";
					if (open$1 === void 0) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" closes no open commit intent — a production write is recorded as one commit (commit_intent first, the atomic write, then ${record.kind}), so a completion with no matching open intent is refused`);
					if (open$1.direction !== expectedDirection || open$1.intentId !== record.intentId) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" names commit intent "${record.intentId}", but the open intent of that proposal is "${open$1.intentId}" (${open$1.direction}) — a ${expectedDirection} completion closes its own ${expectedDirection} intent and nothing else`);
					if (record.approvalRef !== open$1.approvalRef) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" carries approval ${JSON.stringify(record.approvalRef)}, not the approval the open intent "${open$1.intentId}" recorded (${JSON.stringify(open$1.approvalRef)}) — the completion is written for the grant the commit was authorised by, never a second one`);
					const expectedTargets = open$1.files.map((file) => file.target);
					if (record.targets.length !== expectedTargets.length || record.targets.some((target, index) => target !== expectedTargets[index])) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" names targets ${JSON.stringify(record.targets)}, but the open intent "${open$1.intentId}" commits ${JSON.stringify(expectedTargets)} — a completion records the exact file set its intent committed, in the intent's own order`);
					current[record.kind] = {
						targets: [...record.targets],
						approvalRef: record.approvalRef
					};
					current.openIntent = void 0;
					break;
				}
			}
			current.status = record.kind;
		}
		return proposals;
	}
	async load() {
		let text;
		try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const records = text.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`evolution: corrupt ledger line ${index + 1} in ${this.file}`);
			}
		});
		for (const [index, record] of records.entries()) assertLedgerFormatVersion(record, `ledger line ${index + 1} in ${this.file}`);
		this.records = records;
		this.foldLedger(this.records);
	}
	/**
	* Validate a whole ledger: the proposal lifecycle fold, then the experiment
	* fold beside it. Neither family's rules change because the other exists —
	* a lifecycle line is judged exactly as it always was, and an experiment line
	* gets its own checks ({@link foldExperiments}).
	*/
	foldLedger(records) {
		const proposals = this.fold(records);
		foldExperiments(records, proposals);
		return proposals;
	}
	/**
	* Validate the staged fold first; memory commits only once the line's bytes
	* have reached the file. The format check runs before the fold, so a record
	* declaring another version is refused before it can be folded — and, because
	* nothing is written until the fold has accepted the staged ledger, before a
	* byte changes on disk. The line itself goes through
	* {@link appendLedgerLine}, the ledger's one durable append.
	*/
	async append(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
			assertLedgerFormatVersion(record, `the ${record.kind} record for proposal "${record.proposalId}"`);
			this.foldLedger([...this.records, record]);
			await this.appendLedgerLine(record, () => {
				this.records = [...this.records, record];
			});
		});
		this.writes = run.then(() => void 0, () => void 0);
		await run;
	}
	/**
	* The ledger's one durable write path: append one whole line and make it
	* durable before returning — `open` for append, write the entire line, `fsync`
	* the file, close, and then `fsync` the ledger root together with every
	* directory the recursive `mkdir` just created (plus the parent that names the
	* outermost of them), so neither a freshly created ledger file nor a freshly
	* created ledger directory can be lost by a power cut while the write that
	* referenced it survives. {@link append} and {@link recordExperimentStart} both
	* come through here, so nothing writes the ledger beside this method — the
	* funnel every lifecycle, commit and sample line takes is also the funnel that
	* makes it durable.
	*
	* The line goes out through `writeFile`, not a single `write`: `writeFile`
	* writes the whole payload in as many calls as that takes (the behaviour
	* `appendFile` had), so a filesystem that accepts only part of the payload in
	* one call cannot leave a truncated JSON line behind — a fragment would be
	* fsynced as if it were the record, and the ledger would no longer load.
	*
	* `adopt` runs exactly once, immediately after the whole line reaches the
	* file: from that moment the caller's in-memory ledger holds the record the
	* file holds, so a later call in this process sees the line it is really
	* looking at instead of appending a second one.
	*
	* What a failure leaves behind, step by step:
	*
	* - the directory could not be created or the file could not be opened —
	*   nothing was written: the file is byte-identical to what it held and memory
	*   is untouched;
	* - the write failed — a mid-write failure (a full disk, an I/O error) can have
	*   put part of the line in the file before it reported, so the file is
	*   truncated back to the size it had before this call: a fragment is never
	*   left for the next load to refuse the whole ledger over, and memory stays
	*   untouched. If even that truncate fails, the error says so and says the
	*   ledger may hold a partial line — it never pretends the file is clean;
	* - the file's or a directory's fsync failed — the *whole* line is in the file
	*   (and adopted in memory) but is not durable: a named error naming the ledger
	*   path and the failed step, because the caller must not continue as if the
	*   write the line would justify had happened.
	*/
	async appendLedgerLine(record, adopt) {
		const line = `${JSON.stringify(record)}\n`;
		const step = `the ${record.kind} record for proposal "${record.proposalId}"`;
		const reason = (error) => error instanceof Error ? error.message : String(error);
		let created;
		try {
			created = await mkdir(this.root, { recursive: true });
		} catch (error) {
			throw new Error(`evolution: the ledger directory ${this.root} could not be created (${reason(error)}) — ${step} is not written and not durable, so nothing may depend on it`);
		}
		let handle;
		try {
			try {
				handle = await open(this.file, "a");
			} catch (error) {
				throw new Error(`evolution: the ledger file ${this.file} could not be opened for append (${reason(error)}) — ${step} is not written: the line is not durable and nothing may depend on it`);
			}
			let length;
			try {
				length = (await handle.stat()).size;
			} catch (error) {
				throw new Error(`evolution: the ledger file ${this.file} could not be measured before appending ${step} (${reason(error)}) — the line is not written and nothing may depend on it`);
			}
			try {
				await handle.writeFile(line, "utf8");
				adopt();
			} catch (error) {
				try {
					await handle.truncate(length);
				} catch (restore) {
					throw new Error(`evolution: ${step} could not be written to the ledger ${this.file} (${reason(error)}) and the file could not be truncated back to the ${length} bytes it held before this call (${reason(restore)}) — the ledger may hold a partial line no record explains; the line is not durable, so nothing may depend on it and no write it would have justified may proceed`);
				}
				throw new Error(`evolution: ${step} could not be written to the ledger ${this.file} (${reason(error)}) — the ledger is back to the ${length} bytes it held before this call, so no fragment was left behind; the line is not durable and nothing may depend on it, so no write it would have justified may proceed`);
			}
			try {
				await handle.sync();
			} catch (error) {
				throw new Error(`evolution: ${step} was written to the ledger ${this.file} but could not be fsynced (${reason(error)}) — the line is not durable, so nothing may depend on it and no write it would have justified may proceed`);
			}
		} finally {
			await handle?.close().catch(() => {});
		}
		for (const directory of ledgerDirectories(this.root, created)) try {
			await syncDirectory(directory);
		} catch (error) {
			throw new Error(`evolution: the ledger directory ${directory} could not be fsynced after appending ${step} to ${this.file} (${reason(error)}) — whether the line survives a power cut is unknown, so it must not be treated as durable`);
		}
	}
	/** The folded views of every experiment, one per id — the ledger's experiment family, validated. */
	experimentViews() {
		return foldExperiments(this.records, this.fold(this.records));
	}
	/**
	* One experiment's folded view (its frozen block and every sample record
	* written under it), or a named refusal for an unknown id. This is the read
	* the promotion gate will take: the report is a function of these records, so
	* re-deriving it here is what lets a later stage refuse a report that no
	* longer matches the ledger.
	*/
	async experiment(experimentId) {
		await this.loaded;
		const view = this.experimentViews().get(experimentId);
		if (view === void 0) throw new Error(`evolution: unknown experiment "${experimentId}"`);
		return view;
	}
	/** Every experiment's folded view, newest first, optionally narrowed to one proposal. */
	async experiments(proposalId) {
		await this.loaded;
		return [...this.experimentViews().values()].filter((view) => proposalId === void 0 || view.proposalId === proposalId).reverse();
	}
	/**
	* Record the frozen experiment, before its first run. Idempotent by identity:
	* the same frozen block under the same id is a no-op (a repeat call resumes
	* the same experiment rather than starting a second one), and a record that
	* already holds a different frozen block, budget or report path is refused —
	* the experiment id *is* the frozen identity, so a disagreement means the
	* ledger and the caller are not talking about the same experiment.
	*/
	async recordExperimentStart(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
			assertLedgerFormatVersion(record, `the experiment_started record for "${record.experimentId}"`);
			assertExperimentStartRecord(record, this.fold(this.records));
			const prior = this.experimentViews().get(record.experimentId);
			if (prior !== void 0) {
				if (prior.frozenDigest !== record.frozenDigest || prior.proposalId !== record.proposalId || prior.report !== record.report || prior.storeId !== record.storeId || canonicalJson(prior.frozen) !== canonicalJson(record.frozen)) throw new Error(`evolution: experiment "${record.experimentId}" is already recorded with a different frozen identity — an experiment id names one frozen block, its own report path and the task store its runs live in; changing any of them freezes a different experiment`);
				return;
			}
			const staged = [...this.records, record];
			foldExperiments(staged, this.fold(staged));
			await this.appendLedgerLine(record, () => {
				this.records = staged;
			});
		});
		this.writes = run.then(() => void 0, () => void 0);
		await run;
	}
	/**
	* Record one sample side, once. The key carries the run: a second record for
	* the same key is refused by the fold whatever it says, and a record that
	* disagrees with the experiment it names (a different candidate identity, a
	* different repetition, a sample the experiment never froze) is refused
	* before the line lands. Nothing here re-runs anything — the caller only
	* writes what a run already settled to.
	*/
	async recordExperimentSample(record) {
		await this.append(record);
	}
	/**
	* The two-sided experiment entry (§F.2). The orchestrator itself lives in
	* `experiment.ts`; this method is the service's own door to it, resolving the
	* graph, task and runtime services from this context so the tool layer above
	* has exactly one call to make. It does not touch the promotion gate or the
	* lifecycle: an experiment is evidence, and what may be promoted from it is a
	* later stage's question.
	*/
	async runExperiment(spec, caller, actor, options = {}) {
		return runExperiment(this.experimentSources(), {
			spec,
			caller,
			actor,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
	}
	/**
	* Continue a frozen experiment by id. Its specification *is* the recorded
	* frozen block, so a caller that lost the spec — a restart — can resume what
	* was frozen rather than guess at it; the block is re-derived and must
	* reproduce the recorded identity, so a candidate, contract, model or
	* snapshot that moved is refused rather than run under a new identity.
	*/
	async resumeExperiment(experimentId, caller, actor, options = {}) {
		return resumeExperiment(this.experimentSources(), {
			experimentId,
			caller,
			actor,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
	}
	/**
	* The services one experiment runs on, resolved softly: an experiment needs
	* the graph (for this graph's task store), the task store's reads, and the
	* runtime's replay entry. A context that cannot offer one refuses by name
	* instead of running an experiment that could not be judged against a store.
	*/
	experimentSources() {
		const graphs = optionalService(this.ctx, "graphs");
		const task = optionalService(this.ctx, "task");
		const taskRuntime = optionalService(this.ctx, "taskRuntime");
		if (graphs === void 0 || task === void 0 || taskRuntime === void 0) throw new Error(`evolution: the two-sided experiment needs the graphs, task and taskRuntime services in this context (missing: ${[
			graphs === void 0 ? "graphs" : void 0,
			task === void 0 ? "task" : void 0,
			taskRuntime === void 0 ? "taskRuntime" : void 0
		].filter(Boolean).join(", ")})`);
		return {
			evolution: this,
			graphs,
			task,
			taskRuntime,
			verifierVocabulary: async () => {
				const vocabulary = await registeredVerifierVocabulary(this.ctx);
				return vocabulary === void 0 ? void 0 : {
					ids: vocabulary.ids,
					versions: vocabulary.versions
				};
			}
		};
	}
};
var evolution_default = EvolutionService;

//#endregion
export { APPLYABLE_TARGET_TYPES, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EXPERIMENT_COMPARER_VERSION, EXPERIMENT_OUTCOMES, EXPERIMENT_SAMPLE_ROLES, EXPERIMENT_SAMPLE_VERDICTS, EXPERIMENT_SIDES, EXPERIMENT_VERDICTS, EvolutionService, agentOptionsOf, applyTargets, assertExperimentReport, assertExperimentStartRecord, assertFrozenExperiment, buildExperimentReport, canonicalJson, compareExperimentSides, compareReplaySides, evolution_default as default, digestOf, directoryDigest, evidenceRefsOf, experimentIdOf, experimentLineage, experimentReportPath, experimentSampleKey, experimentSampleKeyOf, experimentSampleLabel, foldExperiments, frozenDigestOf, isExperimentRecord, modelSelectionOf, overallExperimentVerdict, preparedContentDigestOf, protectedInputsDigest, renderProviderRoles, resumeExperiment, runExperiment };