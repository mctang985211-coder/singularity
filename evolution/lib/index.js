import { appendFile, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { capabilityToolQuery, loadSkillSidecar, optionalService, readVerifiedFile, registeredVerifierIds, registeredVerifierVocabulary, unlistableVerifierRefusal, validateSkillProvider, walkVerified } from "@dangosys/dsh-singularity-task-runtime";
import { rootTaskStoreId } from "@dangosys/dsh-singularity-task";

//#region src/replay.ts
const REPLAY_VERDICTS = [
	"not-worse",
	"worse",
	"inconclusive",
	"manual"
];
const REPLAY_RELATIONS = [
	"not-worse",
	"worse",
	"inconclusive",
	"manual"
];
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
		if (criterion.verifierRef !== null && (typeof criterion.verifierRef !== "string" || criterion.verifierRef.length === 0)) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must pin the judge it was frozen with — a criterion that names neither a ref nor "no ref" cannot be recalled against the judge that decides it`);
		if (criterion.verifierVersion !== void 0 && (typeof criterion.verifierVersion !== "string" || criterion.verifierVersion.length === 0)) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" has a malformed frozen verifier version`);
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
	const open = new Set([base]);
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
				if (open.has(real)) {
					const named = real === lex ? `directory "${lex}"` : `link "${lex}" -> "${real}"`;
					throw new Error(`experiment: the input snapshot ${named} is already on the way here — the tree it names has no end, so it cannot be frozen as input`);
				}
				open.add(real);
				await visit({
					kind: "directory",
					rel,
					mode: stat.mode & 4095
				});
				await walk(real, rel);
				open.delete(real);
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
	if (prepared.champion !== "captured") throw new Error(`proposal ${proposalId} was prepared with no production skill to replace — this experiment evaluates a replacement of an existing single-file SKILL.md only; promoting a brand-new skill is not what its evidence can show`);
	const candidate = prepared.skillContent;
	if (candidate === void 0) throw new Error(`proposal ${proposalId} carries no candidate content identity (it was prepared before content binding) — propose a new candidate and prepare it`);
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
* A pinned ref (`AcceptanceCriterion.verifierRef`) is exactly recallable: the
* registry names the instance, and when that instance declares a version the
* version is frozen beside it. A pinned judge that declares no version is
* anchored by its registration id, named here. A criterion that pins no ref
* lets the registry dispatch by `verificationMode`, which this plane cannot
* resolve into one instance without re-implementing dispatch — so the anchor
* says exactly that, and the gate requires the deciding judge's id and version
* (read from the run's own verdicts) to still be registered at the version it
* judged with.
*/
function frozenCriterionOf(criterion, where, vocabulary) {
	const inputs = criterion.protectedInputs ?? [];
	for (const input of inputs) if (typeof input?.path !== "string" || input.path.length === 0 || !isHex64(input?.sha256)) throw new Error(`the sample's criterion "${criterion.criterionId}" carries a protected input that was never fixed to { path, sha256 } — an acceptance input nobody fixed is not a frozen input`);
	const ref = criterion.verifierRef;
	let verifierVersion;
	let verifierAnchor;
	if (ref === void 0) verifierAnchor = `the criterion pins no verifierRef; the registry dispatches mode "${criterion.verificationMode}" to a registered judge, and the deciding judge's id and version are read from the run's verdicts and re-checked against the registry`;
	else if (vocabulary === void 0) throw new Error(`${where} pins verifier "${ref}" but this deployment cannot list its verifier registry (verifierIds()/verifierVersions() are unavailable), so the judge identity cannot be frozen — an experiment whose judge nobody can name is refused before it runs`);
	else if (!vocabulary.ids.includes(ref)) throw new Error(`${where} pins verifier "${ref}", which the registry does not hold (registered: ${vocabulary.ids.length === 0 ? "none" : vocabulary.ids.join(", ")}) — the criterion would be judged inconclusive by a judge that does not exist; name a registered verifier before freezing the experiment`);
	else {
		const declared = vocabulary.versions[ref];
		if (declared === void 0) verifierAnchor = `registered verifier "${ref}" declares no version; its registration id is the anchor the gate re-checks`;
		else {
			verifierVersion = declared;
			verifierAnchor = `registered verifier "${ref}" declares version "${declared}"`;
		}
	}
	return {
		criterionId: criterion.criterionId,
		verificationMode: criterion.verificationMode,
		...criterion.command === void 0 ? {} : { command: criterion.command },
		protectedInputsDigest: protectedInputsDigest(inputs),
		verifierRef: ref ?? null,
		...verifierVersion === void 0 ? {} : { verifierVersion },
		verifierAnchor
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
		formatVersion: 1,
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
		formatVersion: 1,
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
* The frozen half: a criterion that pinned a `verifierRef` at freeze must have
* been decided by that ref — and, when the registry declared a version then, at
* exactly that version — so re-registering a same-named judge with a new version
* after the freeze is a refusal that names the frozen value. A criterion that
* pinned nothing was dispatched by mode, which the frozen block says; there the
* run's own verdicts name the judge, and the registry half below re-checks it.
* Fail-closed: a deployment that cannot list its verifier vocabulary refuses
* rather than assuming the judge is there.
*/
function assertJudgeUnchanged(sample, detail, where, vocabulary) {
	const frozenById = new Map(sample.criteria.map((criterion) => [criterion.criterionId, criterion]));
	for (const criterion of detail.criteria) {
		const frozen = frozenById.get(criterion.criterionId);
		if (frozen === void 0) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" of sample "${sample.taskId}", which the frozen block does not carry — a verdict outside the frozen acceptance is not evidence this promotion may read`);
		if (criterion.verifierId === void 0) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" without the verifier that decided it — a verdict nobody can be recalled against is not evidence a promotion may read`);
		if (frozen.verifierRef !== null && criterion.verifierId !== frozen.verifierRef) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by verifier "${criterion.verifierId}", but the frozen block pinned "${frozen.verifierRef}" (${frozen.verifierAnchor}) — the verdicts a promotion reads must be the ones the frozen judge produced`);
		if (frozen.verifierRef !== null && criterion.verifierVersion !== frozen.verifierVersion) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" decided by "${frozen.verifierRef}" at version ${criterion.verifierVersion === void 0 ? "(none declared)" : criterion.verifierVersion}, but the block froze it at ${frozen.verifierVersion === void 0 ? "(no version declared)" : frozen.verifierVersion} (${frozen.verifierAnchor}) — a verdict belongs to the instance that judged, so a judge that moved since the freeze invalidates the evidence`);
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
* The ledger's vocabulary of mechanical target types: the four whose mutations
* older records materialized into a sandbox (`mechanical: true`). Mutations on
* the other five target types (tool / decomposition_policy / workflow_policy /
* verifier / runtime_policy) are free-form structured descriptions, recorded
* with `mechanical: false` — bookkeeping only, never materialized.
*
* The fold validates an old record against this vocabulary, so the four stay
* named here; `candidate` admits a **skill** candidate only, which is the one
* type this build materializes, evaluates and promotes (§F.2).
*/
const MECHANICAL_TARGET_TYPES = [
	"skill",
	"agent_preset",
	"capability",
	"task_definition"
];
/** True for the target types whose mutations materialize mechanically into the sandbox. */
function mutationMechanical(targetType) {
	return MECHANICAL_TARGET_TYPES.includes(targetType);
}
/**
* The one target type `evolution_apply` promotes mechanically (W16): the
* sandbox copy lands on the production skill root. Every other type has no
* executor in this build — a capability row, an agent_preset directory and a
* task_definition were written by an older build and are not written here.
*/
const APPLYABLE_TARGET_TYPES = ["skill"];
/**
* The target types whose `applied` record the state machine still admits, so a
* ledger written by an older build — which applied a preset directory or a
* `config.yml` row — folds and stays readable. It is the recorded vocabulary,
* not a capability of this build: {@link APPLYABLE_TARGET_TYPES} names the one
* type an executor here has, and every other type is refused by name at
* {@link EvolutionService.apply} and at the tools.
*/
const LEDGER_APPLIED_TARGET_TYPES = [
	"skill",
	"agent_preset",
	"capability"
];
/**
* Whether a decided proposal's `applied` record is admissible: the decision is
* PROMOTE, the level is not L4 (L4 harness evolution is human-run by rule,
* §2.7.7 / §2.9.2), the target type is one the ledger admits, and a sandbox was
* actually materialized (a mutation-less manual candidate has nothing to copy).
*/
function applyable(proposal) {
	return proposal.decision === "PROMOTE" && proposal.level !== "L4" && LEDGER_APPLIED_TARGET_TYPES.includes(proposal.targetType) && proposal.prepared?.sandbox != null;
}
const CHAMPION_STATES = [
	"captured",
	"missing",
	"none"
];
const CHAMPION_SOURCES = [
	"config-text",
	"code-default",
	"missing"
];
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
/** A clean relative path: never absolute (posix or drive-letter), no `\`, no empty / `.` / `..` segments. */
function assertSandboxPath(value, field) {
	const text = nonEmpty(value, field);
	if (isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) || text.includes("\\") || text.includes("\0")) throw new Error(`evolution: ${field} must be a relative path inside the sandbox, got "${text}"`);
	if (text.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`evolution: ${field} must be a clean relative path (no empty / "." / ".." segments), got "${text}"`);
	return text;
}
/** Resolve `rel` under `base`, refusing anything that would land outside — the sandbox confinement belt. */
function resolveWithin(base, rel) {
	const abs = resolve(base, rel);
	if (abs !== base && !abs.startsWith(`${base}${sep}`)) throw new Error(`evolution: sandbox path "${rel}" escapes ${base}`);
	return abs;
}
/** Lowercase SHA-256 hex over exact bytes — the content identity primitive (P2). */
function sha256Hex(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}
/**
* The production skill target as it stands right now (P3): null when nothing
* is there, otherwise the exact bytes plus their SHA-256. Read through the same
* component walk as the ledger root (`walkVerified`, shared with the skill
* sidecar loader in task-runtime), so a production path that became a
* directory, or that is a symbolic link (the file itself or an ancestor), is a
* conflict the caller refuses — never a silent follow.
*/
async function readProductionSkill(skillRoot, name) {
	const walked = await walkVerified(skillRoot, join(name, "SKILL.md"));
	if (walked.missing) return null;
	const bytes = await readFile(walked.abs);
	return {
		bytes,
		sha256: sha256Hex(bytes)
	};
}
/**
* Validate a candidate's mutation against the proposal's targetType. The four
* mechanical types have fixed schemas and every path field is checked to stay
* inside the sandbox; the five other types take any structured object and are
* bookkeeping-only (mechanical: false).
*/
function validateMutation(targetType, mutation, baseVersion) {
	if (!isRecord(mutation)) throw new Error("evolution: mutation must be an object");
	switch (targetType) {
		case "skill":
			assertOnlyKeys(mutation, ["name", "content"], "skill mutation");
			assertSegment(mutation.name, "mutation.name");
			nonEmpty(mutation.content, "mutation.content");
			return;
		case "agent_preset":
			assertOnlyKeys(mutation, ["presetId", "files"], "agent_preset mutation");
			assertSegment(mutation.presetId, "mutation.presetId");
			if (!Array.isArray(mutation.files) || mutation.files.length === 0) throw new Error("evolution: mutation.files must be a non-empty array of { path, content }");
			mutation.files.forEach((file, index) => {
				if (!isRecord(file)) throw new Error(`evolution: mutation.files[${index}] must be an object`);
				assertOnlyKeys(file, ["path", "content"], `mutation.files[${index}]`);
				assertSandboxPath(file.path, `mutation.files[${index}].path`);
				nonEmpty(file.content, `mutation.files[${index}].content`);
			});
			return;
		case "capability":
			assertOnlyKeys(mutation, ["name", "entry"], "capability mutation");
			nonEmpty(mutation.name, "mutation.name");
			if (!isRecord(mutation.entry)) throw new Error("evolution: mutation.entry must be an object");
			assertOnlyKeys(mutation.entry, [
				"skills",
				"tools",
				"preset",
				"permission",
				"mcpServers"
			], "mutation.entry");
			if (Object.keys(mutation.entry).length === 0) throw new Error("evolution: mutation.entry must grant at least one of skills / tools / preset / permission / mcpServers");
			for (const list of [
				"skills",
				"tools",
				"mcpServers"
			]) {
				const value = mutation.entry[list];
				if (value === void 0) continue;
				if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) throw new Error(`evolution: mutation.entry.${list} must be an array of non-empty strings`);
			}
			for (const scalar of ["preset", "permission"]) if (mutation.entry[scalar] !== void 0) nonEmpty(mutation.entry[scalar], `mutation.entry.${scalar}`);
			return;
		case "task_definition": {
			assertOnlyKeys(mutation, ["baseVersion", "definition"], "task_definition mutation");
			const base = nonEmpty(mutation.baseVersion, "mutation.baseVersion");
			if (base !== baseVersion) throw new Error(`evolution: mutation.baseVersion "${base}" must equal the proposal's baseVersion "${baseVersion}"`);
			if (!isRecord(mutation.definition) || Object.keys(mutation.definition).length === 0) throw new Error("evolution: mutation.definition must be a non-empty object (the new version's definition fields)");
			return;
		}
		default: return;
	}
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
* The state machine, data-dependent at candidate: a candidate carrying a
* mutation must be prepared (sandbox materialization) before anything else; a
* mutation-less (manual) candidate gates directly — the pre-mutation shape old
* ledgers replay against.
*
* A prepared **skill** candidate gates straight from prepared: its evaluation is
* the two-sided experiment (§F.2), which is recorded in the ledger's experiment
* family and is deliberately *not* a lifecycle transition — the proposal stays
* `prepared` while its samples run — so {@link EvolutionService.gate} requires
* the completed experiment instead of a `replayed` record.
*
* `replayed` and the `prepared → replayed → gated` arc of the four mechanical
* types stay admissible for one reason only: a ledger written before this
* build's narrowing holds those lines, and the fold has to replay the state
* machine over them exactly as it was recorded. No current entry writes one —
* `candidate` admits a skill candidate, this build's one candidate type, and
* nothing evaluates a non-skill one. After the human decision, only a PROMOTE
* on an applyable, materialized, sub-L4 mutation can be applied (W16), and only
* an applied proposal can be rolled back.
*/
function nextStates(proposal) {
	switch (proposal.status) {
		case "proposed": return ["candidate"];
		case "candidate": return proposal.mutation === void 0 ? ["gated"] : ["prepared"];
		case "prepared":
			if (proposal.targetType === "skill") return ["gated", "replayed"];
			return mutationMechanical(proposal.targetType) ? ["replayed"] : ["gated"];
		case "replayed": return ["gated"];
		case "gated": return ["decided"];
		case "decided": return applyable(proposal) ? ["applied"] : [];
		case "applied": return ["rolledback"];
		case "rolledback": return [];
	}
}
/** The one transition check shared by live appends and replay, so an illegal migration reads identically in both. */
function assertTransition(current, kind) {
	if (nextStates(current).includes(kind)) return;
	const hint = current.status === "candidate" && current.mutation !== void 0 && kind === "gated" ? " — this candidate carries a mutation; record \"prepared\" first (evolution_prepare)" : current.status === "decided" && kind === "applied" ? current.decision !== "PROMOTE" ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied` : " — only a materialized skill mutation at L1–L3 applies; anything else stays a manual human edit" : "";
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
	/**
	* Production agent-preset root, resolved for the ledger's own root vocabulary
	* (an old record's targets name it). No current entry writes here: the only
	* executor this build has writes a single `SKILL.md`.
	*/
	presetRoot;
	/**
	* Production config.yml, resolved for the ledger's own root vocabulary (an
	* old capability record's targets name it). No current entry edits it.
	*/
	configFile;
	/** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
	repoRoot;
	/** The injected model-selection resolver, if the assembly wired one (see {@link Config.modelSelection}). */
	resolveModelSelection;
	records = [];
	loaded;
	writes = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "evolution");
		this.repoRoot = config.repoRoot ?? process.cwd();
		this.resolveModelSelection = config.modelSelection;
		const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, ".dsh");
		this.root = resolve(config.root ?? join(dshHome, "evolution"));
		this.skillRoot = resolve(config.skillRoot ?? join(dshHome, "skills"));
		this.presetRoot = resolve(config.presetRoot ?? join(dshHome, ".agent-presets"));
		this.configFile = resolve(config.configFile ?? join(this.repoRoot, "config.yml"));
		this.loaded = this.load();
		ctx.effect(() => async () => {
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
			formatVersion: 1,
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
	* aligns to. `mutation` is the optional structured patch description, shaped
	* and checked against the proposal's targetType; a candidate carrying one
	* must be prepared before it can gate.
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
		if (mutation !== void 0) validateMutation(current.targetType, mutation, current.baseVersion);
		await this.append({
			formatVersion: 1,
			kind: "candidate",
			proposalId,
			versionSet: { ...versionSet },
			...mutation === void 0 ? {} : { mutation: structuredClone(mutation) },
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move candidate → prepared: materialize the skill mutation into
	* `<root>/sandbox/<proposalId>/` and snapshot the champion (the production
	* `SKILL.md`) under `champion/` — the anchor for the experiment's baseline and
	* for rollback. A production target that does not exist yet records
	* `champion: 'missing'` (champion: null). Materialization runs before the
	* ledger append; every write is confined to the sandbox dir.
	*
	* The candidate also records `skillContent` (P2): the name plus the SHA-256 of
	* the exact bytes of the file that was actually materialized (read back from
	* disk, never re-rendered from the mutation string), so the experiment, the
	* gates, and apply can verify this exact content later. The same single read
	* of the production file also yields `skillBaseline` (P3), the digest the
	* later apply compares the production target against.
	*/
	async prepare(proposalId, actor) {
		const current = await this.assertNext(proposalId, "prepared");
		const mutation = current.mutation;
		if (mutation === void 0) throw new Error(`evolution: proposal "${proposalId}" carries no mutation; nothing to prepare`);
		validateMutation(current.targetType, mutation, current.baseVersion);
		assertSegment(proposalId, "proposalId");
		const dir = join(this.root, "sandbox", proposalId);
		const written = await this.materialize(dir, current, mutation);
		const sandbox = `sandbox/${proposalId}`;
		const { name } = mutation;
		const skillContent = {
			name,
			sha256: sha256Hex(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`))
		};
		await this.append({
			formatVersion: 1,
			kind: "prepared",
			proposalId,
			sandbox,
			mechanical: true,
			champion: written.champion,
			...written.skillBaseline === void 0 ? {} : { skillBaseline: written.skillBaseline },
			skillContent,
			files: written.files,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move candidate → gated (manual candidates), prepared → gated (skill
	* candidates), or replayed → gated (a ledger written before this build's
	* narrowing): all six Gate answers plus regression evidence refs. Every ref
	* must exist — a path on disk (relative to the repo root or absolute) or an id
	* the caller-side resolver knows (task-store evidence). Existence only;
	* nothing here executes anything. A **skill** proposal must have a completed
	* two-sided experiment and cite that experiment's report (§F.2); the six
	* answers are recorded over it.
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
			formatVersion: 1,
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
			formatVersion: 1,
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
	* (W16). Reachable only for a PROMOTE decision on a materialized skill
	* mutation at L1–L3 (the state machine itself refuses anything else — every
	* other target type has no executor in this build); the caller (the
	* evolution_apply tool) must hold a human grant from `ctx.approval.request`
	* first, exactly as for decide. The production write runs BEFORE the ledger
	* append, so a failed write leaves the proposal decided and retryable: the
	* sandbox `SKILL.md` replaces the production one (the champion snapshot
	* covers that file only, so the write is file-level, never a directory
	* delete).
	*
	* A skill apply re-verifies the production baseline (P3) after the human
	* grant and immediately before the write: the production target must still be
	* the one prepare recorded. A direct service call therefore cannot bypass the
	* check the tool already ran before asking for approval.
	*
	* The promotion check (S1-C item 3) runs here too, immediately before the
	* write and after the grant: a candidate whose provider role changed while the
	* human was deciding (a sidecar that appeared in the sandbox, a verifier that
	* was unregistered) is refused here, so no entry can write something a later
	* admission would have refused.
	*/
	async apply(proposalId, actor, approvalRef) {
		const current = await this.assertNext(proposalId, "applied");
		nonEmpty(approvalRef, "approvalRef");
		const promotion = await this.checkPromotion(proposalId);
		await this.checkProductionBaseline(proposalId);
		const outcome = await this.writeProduction(current, "apply");
		await this.append({
			formatVersion: 1,
			kind: "applied",
			proposalId,
			targets: outcome.targets,
			approvalRef,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return {
			...outcome,
			providers: promotion.providers,
			proposal: await this.get(proposalId)
		};
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
	* The boundary: `writeProduction` promotes a **single `SKILL.md`**, so a
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
	* `captured` requires a real regular file whose bytes still hash to the
	* digest prepare recorded; `missing` requires the target to still be absent.
	* A file that appeared, changed, disappeared, changed type (now a directory),
	* or sits behind a symbolic link (the file itself or an ancestor) is a
	* conflict. Only `targetType: skill` carries a baseline; every other
	* targetType passes untouched.
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
			current = await readProductionSkill(this.skillRoot, name);
		} catch (error) {
			throw new Error(`evolution: the production skill "${target}" is no longer a readable regular file (${error.message.replace(/^evolution: /, "")}) — ${guidance}`);
		}
		if (prepared.champion === "missing") {
			if (current !== null) throw new Error(`evolution: skill proposal "${proposal.proposalId}" was prepared with no production "${target}", but the file exists now (sha256 ${current.sha256}) — ${guidance}`);
			return;
		}
		const identity = prepared.skillBaseline;
		if (identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" records no production baseline identity (it was prepared before the baseline was recorded) — ${guidance}`);
		if (current === null) throw new Error(`evolution: the production skill "${target}" recorded at prepare (sha256 ${identity.sha256}) no longer exists — ${guidance}`);
		if (current.sha256 !== identity.sha256) throw new Error(`evolution: the production skill "${target}" changed since prepare (sha256 ${current.sha256} != ${identity.sha256}) — ${guidance}`);
	}
	async readVerifiedSkillCandidate(proposal) {
		if (proposal.targetType !== "skill") throw new Error(`evolution: candidate content identity binds skill proposals only, not "${proposal.targetType}"`);
		const sandbox = proposal.prepared?.sandbox;
		const identity = proposal.prepared?.skillContent;
		if (sandbox == null || identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" carries no recorded candidate content identity — it was prepared before content binding; propose a new candidate and re-evaluate it (prepare records the SHA-256 of the materialized SKILL.md)`);
		const rel = `${sandbox}/skills/${identity.name}/SKILL.md`;
		const bytes = await readVerifiedFile(this.root, rel);
		const digest = sha256Hex(bytes);
		if (digest !== identity.sha256) throw new Error(`evolution: skill candidate "${rel}" no longer matches the content identity recorded at prepare (sha256 ${digest} != ${identity.sha256}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		return bytes;
	}
	/**
	* Move applied → rolledback: undo the apply. Champion captured → restore the
	* champion `SKILL.md` snapshot; champion missing → delete the skill directory
	* the apply created. A record of another target type has no executor here:
	* this build writes and restores a single `SKILL.md` only, and an applied
	* capability row or preset directory is refused by name rather than touched.
	* Same approval discipline as apply: the tool asks a human first, the service
	* only executes and records.
	*/
	async rollback(proposalId, actor, approvalRef) {
		const current = await this.assertNext(proposalId, "rolledback");
		nonEmpty(approvalRef, "approvalRef");
		const outcome = await this.writeProduction(current, "rollback");
		await this.append({
			formatVersion: 1,
			kind: "rolledback",
			proposalId,
			targets: outcome.targets,
			approvalRef,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return {
			...outcome,
			proposal: await this.get(proposalId)
		};
	}
	/**
	* The production write behind apply/rollback: one `SKILL.md` at the candidate
	* name under the production skill root. `apply` writes the verified candidate
	* bytes, `rollback` the champion snapshot. Every path goes through
	* `resolveWithin`, so a write can never leave the production root it targets.
	*/
	async writeProduction(proposal, direction) {
		if (proposal.targetType !== "skill") throw new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores a single SKILL.md only, so there is no executor to ${direction} an applied ${proposal.targetType} record`);
		const sandbox = proposal.prepared?.sandbox;
		const champion = proposal.prepared?.champion;
		if (sandbox == null || champion === void 0 || proposal.mutation === void 0) throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`);
		const { name } = proposal.mutation;
		const dst = resolveWithin(this.skillRoot, join(name, "SKILL.md"));
		if (direction === "rollback" && champion === "missing") {
			await rm(resolveWithin(this.skillRoot, name), {
				recursive: true,
				force: true
			});
			return { targets: [`${resolveWithin(this.skillRoot, name)} (deleted — the apply had created it)`] };
		}
		if (direction === "apply") {
			const bytes = await this.readVerifiedSkillCandidate(proposal);
			await mkdir(dirname(dst), { recursive: true });
			await writeFile(dst, bytes);
			return { targets: [dst] };
		}
		const content = await readVerifiedFile(this.root, `${sandbox}/champion/skills/${name}/SKILL.md`);
		await mkdir(dirname(dst), { recursive: true });
		await writeFile(dst, content);
		return { targets: [dst] };
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
	* snapshot. Every path goes through `resolveWithin`, so a write can never
	* land outside the sandbox; the production skill root is read-only here. The
	* champion is read exactly once (P3): those bytes become both the snapshot
	* and the recorded `skillBaseline` digest, so the two can never describe two
	* different reads of the production file.
	*/
	async materialize(dir, proposal, mutation) {
		const files = [];
		const write = async (rel, content$1) => {
			const abs = resolveWithin(dir, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content$1, "utf8");
			files.push(rel);
		};
		const { name, content } = mutation;
		await write(`skills/${name}/SKILL.md`, content);
		const production = await readProductionSkill(this.skillRoot, name);
		if (production === null) return {
			files,
			champion: "missing"
		};
		await write(`champion/skills/${name}/SKILL.md`, production.bytes.toString("utf8"));
		return {
			files,
			champion: "captured",
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
	* prepared/replayed/applied/rolledback shapes), so a hand-forged line fails
	* load exactly as it would fail append. The same rules guard folding and live
	* appends, so an illegal migration is rejected identically in both paths —
	* including a record kind this build no longer writes, whose line still has
	* to be the shape the build that recorded it validated.
	*
	* The experiment family is not a lifecycle transition and is skipped here;
	* {@link foldLedger} folds it beside this fold.
	*/
	fold(records) {
		const proposals = /* @__PURE__ */ new Map();
		for (const record of records) {
			if (isExperimentRecord(record)) continue;
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
					validateVersionSet(record.versionSet);
					if (record.mutation !== void 0) {
						validateMutation(current.targetType, record.mutation, current.baseVersion);
						current.mutation = structuredClone(record.mutation);
					}
					current.versionSet = { ...record.versionSet };
					break;
				case "prepared": {
					const mechanical = mutationMechanical(current.targetType);
					if (record.mechanical !== mechanical) throw new Error(`evolution: prepared record for "${record.proposalId}" marks mechanical=${record.mechanical}, but targetType "${current.targetType}" implies ${mechanical}`);
					if (!CHAMPION_STATES.includes(record.champion)) throw new Error(`evolution: prepared record for "${record.proposalId}" has unknown champion state "${String(record.champion)}"`);
					if (record.sandbox !== null && typeof record.sandbox !== "string") throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string sandbox`);
					if (!Array.isArray(record.files) || record.files.some((file) => typeof file !== "string")) throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`);
					if (mechanical && (record.sandbox === null || record.champion === "none")) throw new Error(`evolution: prepared record for "${record.proposalId}" is mechanical but names no sandbox`);
					if (!mechanical && (record.sandbox !== null || record.champion !== "none" || record.files.length > 0)) throw new Error(`evolution: prepared record for "${record.proposalId}" is bookkeeping-only but carries sandbox artifacts`);
					if (record.championSource !== void 0) {
						if (!CHAMPION_SOURCES.includes(record.championSource)) throw new Error(`evolution: prepared record for "${record.proposalId}" has unknown championSource "${String(record.championSource)}"`);
						if (current.targetType !== "capability") throw new Error(`evolution: prepared record for "${record.proposalId}" carries championSource but targetType "${current.targetType}" is not capability`);
						if (record.championSource === "missing" !== (record.champion === "missing")) throw new Error(`evolution: prepared record for "${record.proposalId}" has championSource "${record.championSource}" but champion "${record.champion}"`);
					}
					if (record.skillContent !== void 0) {
						if (current.targetType !== "skill") throw new Error(`evolution: prepared record for "${record.proposalId}" carries skillContent but targetType "${current.targetType}" is not skill`);
						if (!isRecord(record.skillContent) || typeof record.skillContent.name !== "string" || record.skillContent.name.length === 0 || typeof record.skillContent.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.skillContent.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillContent identity`);
					}
					if (record.skillBaseline !== void 0) {
						if (current.targetType !== "skill") throw new Error(`evolution: prepared record for "${record.proposalId}" carries skillBaseline but targetType "${current.targetType}" is not skill`);
						if (!isRecord(record.skillBaseline) || typeof record.skillBaseline.name !== "string" || record.skillBaseline.name.length === 0 || typeof record.skillBaseline.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.skillBaseline.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillBaseline identity`);
					}
					current.prepared = {
						sandbox: record.sandbox,
						mechanical: record.mechanical,
						champion: record.champion,
						...record.championSource === void 0 ? {} : { championSource: record.championSource },
						...record.skillContent === void 0 ? {} : { skillContent: {
							name: record.skillContent.name,
							sha256: record.skillContent.sha256
						} },
						...record.skillBaseline === void 0 ? {} : { skillBaseline: {
							name: record.skillBaseline.name,
							sha256: record.skillBaseline.sha256
						} },
						files: [...record.files]
					};
					break;
				}
				case "replayed":
					if (typeof record.report !== "string" || record.report.length === 0) throw new Error(`evolution: replayed record for "${record.proposalId}" has no report path`);
					if (!REPLAY_VERDICTS.includes(record.verdict)) throw new Error(`evolution: replayed record for "${record.proposalId}" has unknown verdict "${String(record.verdict)}"`);
					if (!Array.isArray(record.tasks) || record.tasks.some((item) => !isRecord(item) || typeof item.taskId !== "string" || !REPLAY_RELATIONS.includes(item.relation) || typeof item.holdout !== "boolean")) throw new Error(`evolution: replayed record for "${record.proposalId}" has a malformed task summary`);
					if (record.reportDigest !== void 0 && !/^[a-f0-9]{64}$/.test(record.reportDigest)) throw new Error(`evolution: replayed record for "${record.proposalId}" has an invalid report digest`);
					current.replayed = {
						report: record.report,
						verdict: record.verdict,
						tasks: record.tasks.map((item) => ({ ...item })),
						...record.reportDigest === void 0 ? {} : { reportDigest: record.reportDigest }
					};
					break;
				case "gated":
					validateGateAnswers(record.gate);
					current.gate = record.gate;
					break;
				case "decided":
					current.decision = record.decision;
					if (record.note !== void 0) current.decisionNote = record.note;
					if (record.approvalRef !== void 0) {
						if (typeof record.approvalRef !== "string" || record.approvalRef.length === 0) throw new Error(`evolution: decided record for "${record.proposalId}" has an empty human-approval evidence ref`);
						current.decisionApprovalRef = record.approvalRef;
					}
					break;
				case "applied":
				case "rolledback":
					if (!Array.isArray(record.targets) || record.targets.length === 0 || record.targets.some((target) => typeof target !== "string" || target.length === 0)) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has a malformed target list`);
					if (typeof record.approvalRef !== "string" || record.approvalRef.length === 0) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has no human-approval evidence ref`);
					current[record.kind] = {
						targets: [...record.targets],
						approvalRef: record.approvalRef
					};
					break;
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
		for (const record of records) if (record.formatVersion !== 1) throw new Error(`evolution: unsupported ledger formatVersion "${String(record.formatVersion)}"`);
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
	/** Validate the staged fold first; memory commits only after the line is on disk. */
	async append(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
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
export { APPLYABLE_TARGET_TYPES, CHAMPION_SOURCES, CHAMPION_STATES, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EXPERIMENT_COMPARER_VERSION, EXPERIMENT_OUTCOMES, EXPERIMENT_SAMPLE_ROLES, EXPERIMENT_SAMPLE_VERDICTS, EXPERIMENT_SIDES, EXPERIMENT_VERDICTS, EvolutionService, MECHANICAL_TARGET_TYPES, REPLAY_RELATIONS, REPLAY_VERDICTS, agentOptionsOf, applyTargets, assertExperimentReport, assertExperimentStartRecord, assertFrozenExperiment, buildExperimentReport, canonicalJson, compareExperimentSides, compareReplaySides, evolution_default as default, digestOf, directoryDigest, evidenceRefsOf, experimentIdOf, experimentLineage, experimentReportPath, experimentSampleKey, experimentSampleKeyOf, experimentSampleLabel, foldExperiments, frozenDigestOf, isExperimentRecord, modelSelectionOf, mutationMechanical, overallExperimentVerdict, protectedInputsDigest, renderProviderRoles, resumeExperiment, runExperiment };