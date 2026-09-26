import { appendFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { capabilityToolQuery, loadSkillSidecar, optionalService, readVerifiedFile, registeredVerifierIds, registeredVerifierVocabulary, unlistableVerifierRefusal, validateSkillProvider, walkVerified } from "@dangosys/dsh-singularity-task-runtime";
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
* The comparer a v2 report names, and the only one this build can re-check:
* the verdict rules of {@link compareExperimentSides} and
* {@link overallExperimentVerdict}. A report naming anything else is refused
* by {@link assertExperimentReport} instead of being re-derived with rules this
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
	if (!isRecord$1(value) || typeof value.name !== "string" || value.name.length === 0 || !isHex64$1(value.sha256)) throw new Error(`evolution: experiment report ${field} must be a content identity { name, sha256 }`);
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
* Validate a v2 report against itself — and further than a shape check: every
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
	if (report.formatVersion !== 2) throw new Error("evolution: experiment report formatVersion must be 2");
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
* Replace `target` with exactly `bytes`, atomically: a sibling temp file in the
* same directory is opened exclusively, written, fsynced and closed, then
* renamed over the target (one filesystem operation, so a reader sees the old
* complete file or the new one), then the directory is fsynced best-effort so
* the rename itself survives a power cut. The target file is never opened for
* writing, never truncated and never partially visible.
*
* `onStaged` fires between the fsync and the rename — the point where the new
* bytes are durable beside the target but have not replaced it. Every failure,
* that hook included, removes the temp file and throws: a failed write leaves no
* half-installed version behind, and the caller's intent stays open.
*/
async function writeFileAtomic(target, bytes, onStaged) {
	const directory = dirname(target);
	const staging = join(directory, `.${basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
	let handle;
	try {
		await mkdir(directory, { recursive: true });
		handle = await open(staging, "wx");
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = void 0;
		onStaged?.();
		await rename(staging, target);
		await syncDirectory(directory);
	} catch (error) {
		if (handle !== void 0) await handle.close().catch(() => {});
		await rm(staging, { force: true }).catch(() => {});
		throw error;
	}
}
/**
* Persist one commit and carry it out: the intent line, then the atomic
* production write with its read-back verification, then the completion that
* closes the intent. `bytes` are the already-verified bytes the caller read
* through its own identity check (P2 for a candidate, the champion digest for a
* rollback); their digest must be the request's `contentSha256`, so what the
* intent promises and what the write installs cannot disagree.
*
* A throw from any stage leaves the intent open and is the caller's to report:
* the intent is the record of what was underway, and reconciliation — not a
* second guess — is what settles it.
*/
async function commitIntent(host, request, bytes) {
	const digest = sha256Hex(bytes);
	if (digest !== request.contentSha256) throw new Error(`evolution: the bytes this ${request.direction} would write hash to sha256 ${digest}, not the content identity ${request.contentSha256} its commit records — nothing was written`);
	const intent = {
		intentId: `${request.proposalId}/${request.direction}`,
		proposalId: request.proposalId,
		direction: request.direction,
		approvalRef: request.approvalRef,
		target: request.target,
		baselineSha256: request.baselineSha256,
		contentSha256: request.contentSha256,
		source: request.source,
		actor: request.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	await host.append({
		formatVersion: 3,
		kind: "commit_intent",
		...intent
	});
	host.probe("intent-recorded");
	await installAndVerify(host, intent, bytes);
	await appendCompletion(host, intent);
}
/**
* Settle one open intent against the filesystem, or stop by name: re-read the
* intent's own recoverable source and verify it still hashes to what the intent
* committed; read production again; then
*
* - production still holds `baselineSha256` — the commit never landed — so the
*   same bytes are written atomically and the completion recorded
*   (`completed-redone`);
* - production already holds `contentSha256` — the write landed but its
*   completion did not — so only the completion is recorded, and production is
*   left exactly as it is (`completed-written`);
* - a missing target, a target holding neither digest, or a source that is gone
*   or changed — a `blocked` outcome naming the intent, the target and what was
*   actually found, with nothing written and the intent left open.
*
* It never throws for a blocked commit: one batch of reconciliations reports
* every intent it could not settle. A real I/O failure of the redo write is
* *not* a blocked commit and is propagated: the caller must not read a failed
* write as "settled".
*/
async function reconcileIntent(host, intent) {
	const outcome = (result, detail) => ({
		intentId: intent.intentId,
		proposalId: intent.proposalId,
		direction: intent.direction,
		target: intent.target,
		result,
		...detail === void 0 ? {} : { detail }
	});
	let bytes;
	try {
		bytes = await host.readSource(intent.source, intent.contentSha256);
	} catch (error) {
		return outcome("blocked", `evolution: the recoverable source "${intent.source}" of commit intent "${intent.intentId}" is no longer readable as the bytes it committed (${error instanceof Error ? error.message : String(error)}) — the source bytes cannot be re-verified under ${host.root}, so the commit stops by name and the intent stays open; nothing was written`);
	}
	let current;
	let relativeTarget;
	try {
		relativeTarget = productionRelative(host, intent.target);
		current = await host.readProduction(relativeTarget);
	} catch (error) {
		return outcome("blocked", `evolution: the production target "${intent.target}" of commit intent "${intent.intentId}" cannot be read as a regular file (${error.message.replace(/^(evolution|verified-read): /, "")}) — the commit stops by name and the intent stays open; nothing was written`);
	}
	if (current === null) return outcome("blocked", `evolution: the production target "${intent.target}" of commit intent "${intent.intentId}" is missing — it holds neither the state before the commit (sha256 ${intent.baselineSha256}) nor the content it committed (sha256 ${intent.contentSha256}); a third party removed it, so the commit stops by name and the intent stays open (nothing is written, nothing is recreated)`);
	if (current.sha256 === intent.baselineSha256) {
		await installAndVerify(host, intent, bytes);
		await appendCompletion(host, intent);
		return outcome("completed-redone");
	}
	if (current.sha256 === intent.contentSha256) {
		await appendCompletion(host, intent);
		return outcome("completed-written");
	}
	return outcome("blocked", `evolution: the production target "${intent.target}" of commit intent "${intent.intentId}" holds sha256 ${current.sha256}, which is neither the state before the commit (sha256 ${intent.baselineSha256}) nor the content it committed (sha256 ${intent.contentSha256}) — a third party changed it, so the commit stops by name and the intent stays open; the target is never overwritten and the completion is never recorded`);
}
/**
* The write half of one commit, shared by a fresh commit and a redo: atomic
* replace, read back, verify the target now carries exactly the committed
* content, and only then report the rename stage. The read-back is not a
* formality — it is what makes "the rename happened" and "production carries
* this content" the same fact, so a completion is never recorded over bytes the
* commit did not install.
*/
async function installAndVerify(host, intent, bytes) {
	await writeFileAtomic(intent.target, bytes, () => host.probe("write-staged"));
	const readback = await host.readProduction(productionRelative(host, intent.target));
	if (readback === null || readback.sha256 !== intent.contentSha256) throw new Error(`evolution: the production target "${intent.target}" does not hold the committed content after the atomic replace (sha256 ${readback?.sha256 ?? "missing"} != ${intent.contentSha256}) — the intent stays open and a reconciliation reports what production actually carries by name`);
	host.probe("write-renamed");
}
/**
* Close one intent: the completion line, written for the intent's own grant and
* target — its `approvalRef`, its `target` and its actor, so a completion can
* never describe a second approval or a second path. The fold refuses a
* completion with no matching open intent, which is what makes a repeat (a
* retry, a restart, a double reconciliation) cost nothing: the second line has
* nothing to close.
*/
async function appendCompletion(host, intent) {
	await host.append({
		formatVersion: 3,
		kind: intent.direction === "apply" ? "applied" : "rolledback",
		proposalId: intent.proposalId,
		targets: [intent.target],
		approvalRef: intent.approvalRef,
		intentId: intent.intentId,
		actor: intent.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	});
}
/**
* A commit target relative to the production skill root: the shape the
* walk-verified production read takes, and the check that a target can only
* ever resolve inside the root it claims — a target that escapes it (or *is*
* the root) is refused before any read or write.
*/
function productionRelative(host, target) {
	const rel = relative(host.skillRoot, resolve(target));
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`evolution: the commit target "${target}" is not inside the production skill root ${host.skillRoot} — a commit writes one SKILL.md under that root and nothing else`);
	return rel;
}
/** fsync a directory so a rename inside it is durable — best effort: a filesystem that refuses the open still has the rename. */
async function syncDirectory(directory) {
	let handle;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch {
		return;
	} finally {
		await handle?.close().catch(() => {});
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
* The proposal this experiment may evaluate, and the candidate bytes it runs
* against. A skill candidate only: this plane's two-sided experiment replaces an
* existing single-file `SKILL.md`, and every other target type either has no such
* evaluation (A6's capability candidates) or none at all. The candidate's bytes
* are re-verified here (P2) before anything runs.
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
* Refused by name when the deployment cannot answer (no runtime pre-check, a
* row the table does not hold, a refused provider, conflicting presets): a
* sample whose provider identity cannot be fixed is not an experiment this
* build may run.
*/
async function frozenProviderIdentity(input) {
	const { sources, caller, sampleTaskId, required, where } = input;
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
		mcpServers,
		preset: declaredPresets.size === 0 ? null : [...declaredPresets][0],
		skills
	};
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
/** Build the frozen identity block (§F.2), then check it against the schema the report and the ledger share. */
function freezeExperiment(input) {
	const frozen = {
		proposalId: input.proposalId,
		repetition: input.spec.repetition,
		candidate: {
			name: input.candidate.name,
			sha256: input.candidate.sha256
		},
		...input.productionBaseline === void 0 ? {} : { productionBaseline: { ...input.productionBaseline } },
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
			candidate: `extraSkillRoots: [${input.sandbox}/skills]`
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
		formatVersion: 3,
		kind: "experiment_sample",
		proposalId: input.view.proposalId,
		experimentId: input.view.experimentId,
		preparedContentDigest: input.view.frozen.candidate.sha256,
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
		preparedContentDigest: view.frozen.candidate.sha256,
		sampleTaskId,
		side,
		repetition: view.frozen.repetition
	};
}
/**
* Build the v2 report from the ledger records alone — the same records always
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
		formatVersion: 2,
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
		formatVersion: 3,
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
	if (record.preparedContentDigest !== view.frozen.candidate.sha256) throw new Error(`evolution: ${field} names a candidate content identity that is not the experiment's own`);
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
function sha256Hex$1(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/**
* The refusal every other target type gets: no evaluator, no promotion. This
* build evaluates a replacement of an existing single-file `SKILL.md`;
* capability, agent_preset, task_definition, the bookkeeping-only types and L4
* have no evidence this gate could read, so no record of one is reused to
* promote it (§F.2: "没有支持的评估器就拒绝新晋升"). Their records stay
* readable.
*/
function noEvaluatorRefusal(proposal) {
	return /* @__PURE__ */ new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}", which has no evaluator in this build — the two-sided experiment (§F.2) evaluates a replacement of an existing single-file SKILL.md only, and a promotion without supported evaluation evidence is refused rather than granted from an older record.`);
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
* The promoted skill's *content* is the one difference the frozen block allows,
* and it is checked against the bytes the run actually bound: the side's
* snapshot must hold the frozen `SKILL.md` — the production baseline's bytes for
* the baseline side, the candidate's for the candidate side.
*/
async function assertSideProviderBinding(input) {
	const { sample, detail, run, frozen, where } = input;
	if (detail.outcome === "interrupted") return;
	const expected = sample.provider;
	const binding = run.providerBinding;
	if (binding === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} records no provider binding — which rows, servers and skills it resolved against cannot be re-read, so the frozen provider identity cannot be compared and the promotion is refused`);
	const rows = [...binding.capabilities].sort();
	if (rows.join(", ") !== [...expected.capabilities].sort().join(", ")) throw new Error(`evolution: run "${run.runId}" of the ${where} bound capabilities [${rows.join(", ") || "none"}] but the experiment froze [${expected.capabilities.join(", ") || "none"}] — the rows this side ran under are not the frozen production configuration's`);
	if (binding.registryRevision !== expected.registryRevision) throw new Error(`evolution: run "${run.runId}" of the ${where} bound registry revision ${binding.registryRevision}, but the experiment froze ${expected.registryRevision} — a capability row, a tool label or a declared provider contract moved since the freeze, so the side did not run under the frozen production configuration`);
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
		if (bound.role !== expectedSkill.role || (bound.contractDigest ?? null) !== expectedSkill.contractDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" as ${bound.role}${bound.contractDigest === null ? "" : ` (contract ${bound.contractDigest})`}, but the frozen identity is ${expectedSkill.role}${expectedSkill.contractDigest === null ? "" : ` (contract ${expectedSkill.contractDigest})`} — the provider this side loaded is not the one the experiment froze`);
		if (name === frozen.candidate.name) {
			if (detail.side === "baseline" && bound.contentDigest !== expectedSkill.contentDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the production configuration's content at freeze was ${expectedSkill.contentDigest} — the bytes this side loaded moved since the freeze`);
			continue;
		}
		if (bound.contentDigest !== expectedSkill.contentDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the production configuration's content at freeze was ${expectedSkill.contentDigest} — the bytes this side loaded moved since the freeze`);
	}
	if (boundSkills.get(frozen.candidate.name) !== void 0) {
		const expectedBytes = detail.side === "candidate" ? frozen.candidate.sha256 : frozen.productionBaseline?.sha256;
		if (expectedBytes !== void 0) {
			if (binding.snapshotRoot === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${frozen.candidate.name}" but records no snapshot root — the bytes it loaded cannot be re-read, so the frozen content identity cannot be compared`);
			let bytes;
			try {
				bytes = await readFile(join(binding.snapshotRoot, frozen.candidate.name, "SKILL.md"));
			} catch (error) {
				throw new Error(`evolution: the content run "${run.runId}" of the ${where} was bound to cannot be read (${error instanceof Error ? error.message : String(error)}) — the promoted skill's frozen bytes cannot be re-proved, so the promotion is refused`);
			}
			const digest = sha256Hex$1(bytes);
			if (digest !== expectedBytes) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${frozen.candidate.name}" whose SKILL.md hashes to ${digest}, but the experiment froze ${expectedBytes} for the ${detail.side} side — the bytes this side ran are not the frozen ones`);
			if (detail.side === "candidate" && digest === frozen.productionBaseline?.sha256) throw new Error(`evolution: the candidate side of the ${where} loaded the production bytes ("${frozen.candidate.name}" hashes to ${digest}, the frozen production baseline) — the candidate was never really run, so the comparison proves nothing`);
		}
	}
}
/**
* Whether the two sides' bindings agree everywhere the frozen block allows
* agreement and nowhere else (S4-E §Q3): every field of the run binding and the
* run's preset must match between the baseline and the candidate side, except
* the promoted skill's own content digest — the one difference the experiment's
* overlay is supposed to produce.
*/
function assertSidesAgree(frozen, baseline, candidate, where) {
	const comparable = (binding) => ({
		capabilities: [...binding.capabilities].sort(),
		registryRevision: binding.registryRevision,
		mcpServers: [...binding.mcpServers].sort((left$1, right$1) => left$1.serverName < right$1.serverName ? -1 : left$1.serverName > right$1.serverName ? 1 : 0),
		skills: [...binding.skills].sort((left$1, right$1) => left$1.name < right$1.name ? -1 : left$1.name > right$1.name ? 1 : 0).map((skill) => ({
			name: skill.name,
			role: skill.role,
			contractDigest: skill.contractDigest ?? null,
			...skill.name === frozen.candidate.name ? {} : { contentDigest: skill.contentDigest }
		}))
	});
	const left = JSON.stringify(comparable(baseline.binding));
	const right = JSON.stringify(comparable(candidate.binding));
	if (left !== right) throw new Error(`evolution: the two sides of ${where} did not bind the same provider identity — apart from the promoted skill's own content, which the candidate overlay is what changes, every field must agree:\n- baseline: ${left}\n- candidate: ${right}`);
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
	if (frozen.candidate.name !== candidate.name || frozen.candidate.sha256 !== candidate.sha256) throw new Error(`evolution: the experiment froze candidate ${frozen.candidate.name}@${frozen.candidate.sha256} but proposal "${proposal.proposalId}" now prepares ${candidate.name}@${candidate.sha256} — the evidence belongs to different candidate bytes; propose a new candidate and evaluate it`);
	const baseline = prepared?.skillBaseline;
	if (baseline === void 0 || frozen.productionBaseline?.name !== baseline.name || frozen.productionBaseline?.sha256 !== baseline.sha256) throw new Error(`evolution: the experiment's frozen production baseline (${frozen.productionBaseline?.name ?? "none"}@${frozen.productionBaseline?.sha256 ?? "none"}) is not the baseline prepare recorded for proposal "${proposal.proposalId}" (${baseline?.name ?? "none"}@${baseline?.sha256 ?? "none"}) — the candidate was evaluated against another production state`);
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
/** The production path of one skill's single file, as the executor writes and reads it. */
function productionSkillRelative(name) {
	return join(name, "SKILL.md");
}
/**
* Validate a candidate's mutation. This build has exactly one candidate
* mutation — the single-file `SKILL.md` replacement of §F.2 — so the schema is
* the skill one and the only callers are the paths that already admitted a
* skill candidate (the write path and the fold, which refuses a candidate of
* any other target type first). A mutation of another target type has no
* schema here, and is named rather than silently accepted: the old schemas
* (agent_preset, capability, task_definition) and the bookkeeping-only default
* belonged to a lifecycle this build no longer has.
*/
function validateMutation(targetType, mutation) {
	if (!isRecord(mutation)) throw new Error("evolution: mutation must be an object");
	if (targetType !== "skill") throw new Error(`evolution: a "${targetType}" mutation has no schema in this build — the only candidate lifecycle here is a single-file SKILL.md replacement, and every other target type is a recorded proposal`);
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
* single-file `SKILL.md` replacement — so a candidate has exactly one next
* state: `prepared` (sandbox materialization). There is no mutation-less
* candidate and no direct candidate → gated arc: a proposal with nothing to
* evaluate is a recorded proposal, not a flow.
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
* grant will touch. One file: the candidate's `SKILL.md`, which is what this
* build's executor writes and restores.
*/
function applyTargets(proposal, roots) {
	if (proposal.targetType !== "skill") return [];
	return [join(roots.skillRoot, proposal.mutation.name, "SKILL.md")];
}
/**
* The entries of a candidate's own directory beyond the one file the skill
* executor writes — `SKILL.md`'s siblings, a directory read as `name/`, sorted.
* Empty for a single-file candidate, and also for a directory that cannot be
* listed: a candidate with nothing there is then refused by the validator with
* the defect its absence deserves (`skill-missing`), not by this boundary.
*/
async function unsupportedCandidateEntries(directory) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.name !== "SKILL.md").map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
}
/**
* One format, one check (K2): every line this ledger reads, folds or writes
* declares `formatVersion: 3`, and nothing else — no v1, no v2, no missing
* version, no mix. The same refusal guards all three doors the record type
* cannot guard on its own: the load (per line, naming the file and the line),
* the {@link EvolutionService.append} funnel every lifecycle, commit and sample
* write goes through, and {@link EvolutionService.recordExperimentStart}, which
* appends beside that funnel. A record that declares anything else is refused
* before it is folded or written, and the caller's step is the persistence
* contract's: archive the old ledger and start a new one.
*
* The version moved with the commit mechanism: a v2 ledger has no
* `commit_intent` lines and its completions carry no `intentId`, so a write to
* such a ledger could not be reconciled — reading one is refused instead of
* appending beside it.
*
* `position` names the line or the record in the operator's own vocabulary
* (e.g. `ledger line 3 in /…/proposals.jsonl`), so the message points at the
* bytes that are wrong rather than at the entry that noticed them.
*/
function assertLedgerFormatVersion(record, position) {
	if (record.formatVersion === 3) return;
	throw new Error(`evolution: ${position} declares formatVersion ${JSON.stringify(record.formatVersion ?? null)} — this build reads and writes formatVersion 3 only, so a v1, a v2, an unversioned or a mixed ledger is refused before any new record is appended (archive the old ledger and start a new one; no migration, no dual-format read and no older-record reader is offered, because a v2 ledger carries no commit intent for a production write to be reconciled against)`);
}
/**
* Commit-intent payload validation, shared by the write path ({@link
* EvolutionService.apply} / {@link EvolutionService.rollback} through
* `commit.ts`) and the fold: every field a recovery needs is present, both
* content identities are real SHA-256 hex, and the direction is one of the two
* the commit path has. A hand-forged line fails exactly as a live append would.
*/
function validateCommitIntent(record) {
	const nonEmptyFields = [
		["proposalId", record.proposalId],
		["intentId", record.intentId],
		["approvalRef", record.approvalRef],
		["target", record.target],
		["source", record.source],
		["actor", record.actor],
		["at", record.at]
	];
	for (const [field, value] of nonEmptyFields) if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: commit_intent record for proposal "${String(record.proposalId)}" has no ${field} — an intent names the proposal, the direction, the human approval, the production target, both content identities, the bytes to write again and its actor, so a line missing any of them cannot be reconciled`);
	if (record.direction !== "apply" && record.direction !== "rollback") throw new Error(`evolution: commit_intent record for proposal "${record.proposalId}" declares direction ${JSON.stringify(record.direction ?? null)} — a commit intent is "apply" or "rollback"`);
	for (const [field, value] of [["baselineSha256", record.baselineSha256], ["contentSha256", record.contentSha256]]) if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`evolution: commit_intent record for proposal "${record.proposalId}" has no valid ${field} (${JSON.stringify(value ?? null)}) — an intent binds the exact bytes production must hold before the write and the exact bytes it must hold after`);
	if (record.target !== resolve(record.target)) throw new Error(`evolution: commit_intent record for proposal "${record.proposalId}" names target "${record.target}" — an intent names the absolute production path it commits`);
}
/**
* The Evolution plane ledger (plane separation: this store is independent of
* the task store and refers to it by id only). Folding and appending share one
* fold, so a corrupt or out-of-order log fails loudly instead of silently
* drifting. Writes are serialized; the file is opened per append, so closing
* the service is just draining the write queue. Sandbox materialization is the
* only other write, confined to `<root>/sandbox/<proposalId>/`.
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
			formatVersion: 3,
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
		if (current.targetType !== "skill") throw new Error(`evolution: proposal "${proposalId}" targets "${current.targetType}", which cannot become a candidate in this build — the only candidate lifecycle here is a single-file SKILL.md replacement (evolution_prepare → the two-sided experiment evolution_replay → evolution_gate → evolution_apply), and no other target type has an evaluator until A6 introduces one, so its proposal stays a recorded proposal`);
		validateVersionSet(versionSet);
		validateMutation(current.targetType, mutation);
		await this.append({
			formatVersion: 3,
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
	* Move candidate → prepared: confirm the production `SKILL.md` this candidate
	* replaces, materialize the skill mutation into `<root>/sandbox/<proposalId>/`
	* and snapshot those same champion bytes under `champion/` — the anchor for
	* the experiment's baseline and for rollback.
	*
	* The production read comes first, before any sandbox or ledger write: this
	* build replaces an existing single-file `SKILL.md`, so a target that is not
	* there has nothing to prepare, and a prepare that found none writes nothing
	* at all. That one read yields both the snapshot and `skillBaseline` (P3),
	* the digest the later apply compares the production target against.
	*
	* The candidate also records `skillContent` (P2): the name plus the SHA-256 of
	* the exact bytes of the file that was actually materialized (read back from
	* disk, never re-rendered from the mutation string), so the experiment, the
	* gates, and apply can verify this exact content later.
	*/
	async prepare(proposalId, actor) {
		const current = await this.assertNext(proposalId, "prepared");
		const mutation = current.mutation;
		validateMutation(current.targetType, mutation);
		assertSegment(proposalId, "proposalId");
		const { name } = mutation;
		const production = await readProductionSkill(this.skillRoot, productionSkillRelative(name));
		if (production === null) throw new Error(`evolution: the production skill "${join(this.skillRoot, name, "SKILL.md")}" does not exist, so proposal "${proposalId}" has nothing to replace — this build prepares and promotes a replacement of an existing single-file SKILL.md only; a new skill cannot be evaluated or promoted by this path`);
		const dir = join(this.root, "sandbox", proposalId);
		const written = await this.materialize(dir, mutation, production);
		const sandbox = `sandbox/${proposalId}`;
		const skillContent = {
			name,
			sha256: sha256Hex(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`))
		};
		await this.append({
			formatVersion: 3,
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
			formatVersion: 3,
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
			formatVersion: 3,
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
	* first, exactly as for decide. The sandbox `SKILL.md` replaces the production
	* one (the champion snapshot covers that file only, so the write is
	* file-level, never a directory delete).
	*
	* The commit order is the recovery rule (K2): the `commit_intent` line is
	* persisted first — proposal, direction, this approval, the absolute target,
	* the content identity production must hold before (`prepared.skillBaseline`
	* P3) and after (`prepared.skillContent` P2), and the sandbox candidate as the
	* recoverable source — then the target is replaced atomically, then the
	* `applied` record closes the intent. A failure at any stage leaves the intent
	* open and nothing half-written: the production file is one complete version or
	* the other, and {@link reconcile} (or a retry of this call) settles the intent
	* from what production actually holds. Nothing here trusts a promise or a
	* caller-supplied "approved".
	*
	* A skill apply re-verifies the production baseline (P3) after the human
	* grant and before the intent is recorded: the production target must still be
	* the one prepare recorded. A direct service call therefore cannot bypass the
	* check the tool already ran before asking for approval.
	*
	* The promotion check (S1-C item 3) runs here too, before the intent is
	* recorded: a candidate whose provider role changed while the human was
	* deciding (a sidecar that appeared in the sandbox, a verifier that was
	* unregistered) is refused here, so no entry can write something a later
	* admission would have refused.
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
					targets: [open$1.target],
					recovered,
					proposal: await this.get(proposalId)
				};
			}
			const promotion = await this.checkPromotion(proposalId);
			await this.checkProductionBaseline(proposalId);
			const bytes = await this.readVerifiedSkillCandidate(proposal);
			await commitIntent(this.commitHost(), this.commitRequest(proposal, "apply", actor, approvalRef), bytes);
			return {
				targets: [this.commitTarget(proposal)],
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
	* The candidate skill's provider verdict, taken from the directory the
	* promotion would write — plus the executor boundary this promotion cannot
	* cross.
	*
	* The boundary: the commit promotes a **single `SKILL.md`**, so a
	* candidate whose directory carries anything else (`SKILL.contract.json`, a
	* `references/` or `scripts/` tree, any other file) is refused here by name.
	* The executor is not being extended to multi-file candidates; what is being
	* refused is the promotion of a candidate whose declaration or resources
	* production would never receive — a promotion that reported an
	* `execution-provider` role (or a content identity covering files nobody
	* wrote) for content that does not exist is exactly the false record this
	* refusal prevents.
	*
	* Both the shape and the declaration are named when both are wrong: the
	* validator's own defects stay in the message with their codes, so this entry
	* reports the same defect vocabulary admission, config load and capability
	* replacement report for the same directory.
	*/
	async assertSkillCandidateProvider(proposal) {
		const sandbox = proposal.prepared?.sandbox;
		const { name } = proposal.mutation;
		if (sandbox == null) throw new Error(`evolution: proposal "${proposal.proposalId}" names no sandbox; the candidate's provider role cannot be judged`);
		const directory = resolveWithin(this.root, `${sandbox}/skills/${name}`);
		const unsupported = await unsupportedCandidateEntries(directory);
		const verdict = await this.providerVerdict({
			name,
			directory
		});
		const defects = verdict.valid ? "" : verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ");
		if (unsupported.length > 0) throw new Error(`evolution: skill candidate "${name}" at ${directory} carries ${unsupported.map((entry) => JSON.stringify(entry)).join(", ")} — the skill executor promotes single-file SKILL.md candidates only, so a sidecar or resource this promotion would not write is refused rather than silently dropped${verdict.valid ? "" : `; the declared provider is unusable too — ${defects}`}`);
		if (!verdict.valid) throw new Error(`evolution: skill candidate "${name}" at ${directory} is not a usable provider — ${defects}; a promotion writes only a skill a worker could load and, when it claims execution, only one whose verifier and tools the deployment can grant`);
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
	* Read a prepared skill candidate's materialized bytes and verify them
	* against the content identity recorded at prepare (P2). The one read path
	* every stage shares: the experiment's pre-run check, every promotion gate,
	* and the apply write.
	* Throws — never silently re-digests — when the candidate file is missing,
	* is not a regular file, its path crosses a symbolic link, or its bytes no
	* longer match the recorded digest.
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
	* The prepare-time baseline is a real regular file whose bytes still hash to
	* the digest prepare recorded. A file that changed, disappeared, changed type
	* (now a directory), or sits behind a symbolic link (the file itself or an
	* ancestor) is a conflict. Only `targetType: skill` carries a baseline; every
	* other targetType passes untouched.
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
		let current;
		try {
			current = await readProductionSkill(this.skillRoot, productionSkillRelative(name));
		} catch (error) {
			throw new Error(`evolution: the production skill "${target}" is no longer a readable regular file (${error.message.replace(/^evolution: /, "")}) — ${guidance}`);
		}
		const identity = prepared.skillBaseline;
		if (identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" records no production baseline identity — ${guidance}`);
		if (current === null) throw new Error(`evolution: the production skill "${target}" recorded at prepare (sha256 ${identity.sha256}) no longer exists — ${guidance}`);
		if (current.sha256 !== identity.sha256) throw new Error(`evolution: the production skill "${target}" changed since prepare (sha256 ${current.sha256} != ${identity.sha256}) — ${guidance}`);
	}
	async readVerifiedSkillCandidate(proposal) {
		if (proposal.targetType !== "skill") throw new Error(`evolution: candidate content identity binds skill proposals only, not "${proposal.targetType}"`);
		const sandbox = proposal.prepared?.sandbox;
		const identity = proposal.prepared?.skillContent;
		if (sandbox == null || identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" carries no recorded candidate content identity — propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized SKILL.md)`);
		const rel = `${sandbox}/skills/${identity.name}/SKILL.md`;
		const bytes = await readVerifiedFile(this.root, rel);
		const digest = sha256Hex(bytes);
		if (digest !== identity.sha256) throw new Error(`evolution: skill candidate "${rel}" no longer matches the content identity recorded at prepare (sha256 ${digest} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		return bytes;
	}
	/**
	* Move applied → rolledback: undo the apply by restoring the champion
	* `SKILL.md` snapshot taken at prepare, as one commit — the same intent →
	* atomic write → completion order as apply, so an interrupted rollback is
	* recoverable the same way. A record of another target type has no executor
	* here: this build writes and restores a single `SKILL.md` only, and an
	* applied capability row or preset directory is refused by name rather than
	* touched. Same approval discipline as apply: the tool asks a human first, the
	* service only executes and records.
	*
	* A rollback restores *this* proposal's baseline and nothing else, so both
	* ends are re-verified before the intent is recorded: production must still
	* carry exactly the content this proposal applied (`prepared.skillContent`,
	* P2), and the champion snapshot must still hash to the baseline prepare
	* recorded (`prepared.skillBaseline`, P3). A target a later proposal — or any
	* other writer — changed since is refused by name with nothing written, and so
	* is a snapshot that can no longer reproduce the bytes it captured: neither
	* may be papered over by restoring an old version on top of a newer one.
	*
	* As in {@link apply}, an open intent of this proposal is settled rather than
	* duplicated, and the result reports the recovery.
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
					targets: [open$1.target],
					recovered,
					proposal: await this.get(proposalId)
				};
			}
			const request = this.commitRequest(proposal, "rollback", actor, approvalRef);
			const prepared = proposal.prepared;
			const identity = prepared.skillContent;
			const current = await readProductionSkill(this.skillRoot, productionSkillRelative(proposal.mutation.name));
			if (current === null || current.sha256 !== identity.sha256) throw new Error(`evolution: the production skill "${request.target}" does not hold the content proposal "${proposalId}" applied (sha256 ${current?.sha256 ?? "missing"} != ${identity.sha256}) — a rollback restores the baseline of the version this proposal applied, and a target another writer (or a later proposal) changed is left exactly as it is: nothing was written and no commit intent was recorded`);
			const champion = await readVerifiedFile(this.root, request.source);
			const digest = sha256Hex(champion);
			if (digest !== prepared.skillBaseline.sha256) throw new Error(`evolution: the champion snapshot "${request.source}" of proposal "${proposalId}" no longer hashes to the production baseline recorded at prepare (sha256 ${digest} != ${prepared.skillBaseline.sha256}) — the snapshot cannot restore the bytes it captured: nothing was written and no commit intent was recorded`);
			await commitIntent(this.commitHost(), request, champion);
			return {
				targets: [request.target],
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
		return this.openIntents(this.fold(this.records)).map((intent) => intent.target);
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
	* the proposal already carries: the absolute target (the same path
	* {@link applyTargets} names to the human), the content identity production
	* must hold before and after, and the recoverable source under the ledger
	* root. `apply` commits the candidate over the recorded baseline; `rollback`
	* commits the champion snapshot over the content the apply installed — the two
	* digests swap, and nothing else about the two directions differs.
	*/
	commitRequest(proposal, direction, actor, approvalRef) {
		if (proposal.targetType !== "skill") throw new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores a single SKILL.md only, so there is no executor to ${direction} an applied ${proposal.targetType} record`);
		const prepared = proposal.prepared;
		const content = prepared?.skillContent;
		const baseline = prepared?.skillBaseline;
		if (prepared?.sandbox == null || prepared.champion !== "captured" || proposal.mutation === void 0 || content === void 0 || baseline === void 0) throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`);
		const { name } = proposal.mutation;
		if (content.name !== name || baseline.name !== name) throw new Error(`evolution: proposal "${proposal.proposalId}" records content identities for skill "${content.name}/${baseline.name}" but its mutation names "${name}" — the commit cannot write one skill's verified bytes onto another skill's target`);
		return direction === "apply" ? {
			proposalId: proposal.proposalId,
			direction,
			approvalRef,
			target: this.commitTarget(proposal),
			baselineSha256: baseline.sha256,
			contentSha256: content.sha256,
			source: `${prepared.sandbox}/skills/${name}/SKILL.md`,
			actor
		} : {
			proposalId: proposal.proposalId,
			direction,
			approvalRef,
			target: this.commitTarget(proposal),
			baselineSha256: content.sha256,
			contentSha256: baseline.sha256,
			source: `${prepared.sandbox}/champion/skills/${name}/SKILL.md`,
			actor
		};
	}
	/** The one production path a commit of this proposal may write: `<skillRoot>/<name>/SKILL.md`, confined to the skill root. */
	commitTarget(proposal) {
		return resolveWithin(this.skillRoot, productionSkillRelative(proposal.mutation.name));
	}
	/**
	* The narrow host the commit path runs on (see `commit.ts`): the roots a
	* target and a source resolve against, the service's own verified reads — P2
	* for a candidate, the walk-verified production read, the ledger-root read for
	* a snapshot — the append funnel every line goes through (format check, staged
	* fold, serialized write), and the probe seam. The commit path owns the order;
	* the service owns what may be read and what a line must say.
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
			probe: (stage) => this.commitProbe?.(stage)
		};
	}
	/**
	* Serialize one commit — its intent, its production write and its completion —
	* behind every commit already running or queued, and behind every write the
	* ledger funnel has not appended yet. Two proposals competing for one target
	* therefore never interleave a read-back with another commit's rename: the
	* second sees the first's result and refuses on its own baseline check. This
	* is a single-process queue, not a cross-process lock: the deployment's
	* one-writer constraint still stands, and a second process is not excluded.
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
	* Write the skill mutation into the sandbox dir `dir`, then the champion
	* snapshot from the production bytes the caller already read (P3: one read,
	* before anything was written — those bytes become the snapshot and the
	* recorded `skillBaseline` digest together, so the two can never describe two
	* different reads of the production file). Every path goes through
	* `resolveWithin`, so a write can never land outside the sandbox; the
	* production skill root is read-only here.
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
		await write(`skills/${name}/SKILL.md`, content);
		await write(`champion/skills/${name}/SKILL.md`, production.bytes);
		return {
			files,
			skillBaseline: {
				name,
				sha256: production.sha256
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
	* `<proposalId>/<direction>`, and only when the proposal has no other open
	* intent; an `applied`/`rolledback` completion is admitted only when it closes
	* the open intent of its own direction — same id, same approval, that exact
	* target — and it closes it. So a completion cannot be recorded without its
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
					target: record.target,
					baselineSha256: record.baselineSha256,
					contentSha256: record.contentSha256,
					source: record.source,
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
					if (current.targetType !== "skill") throw new Error(`evolution: candidate record for "${record.proposalId}" targets "${current.targetType}" — this build's candidate lifecycle is a single-file SKILL.md replacement only, and no other target type has an evaluator here`);
					validateVersionSet(record.versionSet);
					validateMutation(current.targetType, record.mutation);
					current.mutation = structuredClone(record.mutation);
					current.versionSet = { ...record.versionSet };
					break;
				case "prepared": {
					if (record.mechanical !== true || record.champion !== "captured" || typeof record.sandbox !== "string" || record.sandbox.length === 0) throw new Error(`evolution: prepared record for "${record.proposalId}" is not a materialized skill prepare (mechanical=${String(record.mechanical)}, champion=${JSON.stringify(record.champion ?? null)}, sandbox=${JSON.stringify(record.sandbox ?? null)}) — this build prepares a single-file SKILL.md replacement only`);
					if (!Array.isArray(record.files) || record.files.some((file) => typeof file !== "string")) throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`);
					const skillContent = record.skillContent;
					if (!isRecord(skillContent) || typeof skillContent.name !== "string" || skillContent.name.length === 0 || typeof skillContent.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(skillContent.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has no valid skillContent identity — every prepare records the content identity of the materialized candidate SKILL.md`);
					const skillBaseline = record.skillBaseline;
					if (!isRecord(skillBaseline) || typeof skillBaseline.name !== "string" || skillBaseline.name.length === 0 || typeof skillBaseline.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(skillBaseline.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has no valid skillBaseline identity — every prepare records the production baseline it read before materializing the candidate`);
					current.prepared = {
						sandbox: record.sandbox,
						mechanical: true,
						champion: "captured",
						skillContent: {
							name: skillContent.name,
							sha256: skillContent.sha256
						},
						skillBaseline: {
							name: skillBaseline.name,
							sha256: skillBaseline.sha256
						},
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
					if (record.targets.length !== 1 || record.targets[0] !== open$1.target) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" names targets ${JSON.stringify(record.targets)}, but the open intent "${open$1.intentId}" commits ${JSON.stringify([open$1.target])} — a completion records the exact target its intent committed`);
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
	* Validate the staged fold first; memory commits only after the line is on
	* disk. The format check runs before the fold, so a record declaring another
	* version is refused before it can be folded — and, because nothing is
	* written until the fold has accepted the staged ledger, before a byte
	* changes on disk.
	*/
	async append(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
			assertLedgerFormatVersion(record, `the ${record.kind} record for proposal "${record.proposalId}"`);
			this.foldLedger([...this.records, record]);
			await mkdir(this.root, { recursive: true });
			await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
			this.records = [...this.records, record];
		});
		this.writes = run.then(() => void 0, () => void 0);
		await run;
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
			await mkdir(this.root, { recursive: true });
			await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
			this.records = staged;
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
export { APPLYABLE_TARGET_TYPES, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EXPERIMENT_COMPARER_VERSION, EXPERIMENT_OUTCOMES, EXPERIMENT_SAMPLE_ROLES, EXPERIMENT_SAMPLE_VERDICTS, EXPERIMENT_SIDES, EXPERIMENT_VERDICTS, EvolutionService, agentOptionsOf, applyTargets, assertExperimentReport, assertExperimentStartRecord, assertFrozenExperiment, buildExperimentReport, canonicalJson, compareExperimentSides, compareReplaySides, evolution_default as default, digestOf, directoryDigest, evidenceRefsOf, experimentIdOf, experimentLineage, experimentReportPath, experimentSampleKey, experimentSampleKeyOf, experimentSampleLabel, foldExperiments, frozenDigestOf, isExperimentRecord, modelSelectionOf, overallExperimentVerdict, protectedInputsDigest, renderProviderRoles, resumeExperiment, runExperiment };