import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { rootTaskStoreId } from "@dangosys/dsh-singularity-task";
import { SKILL_SIDECAR_FILE, capabilityToolQuery, inFlightRecoveryAttempt, loadSkillSidecar, optionalService, precheckProviders, precheckReplacedCapabilityRow, readVerifiedFile, recoveryAttemptWithKey, registeredVerifierIds, registeredVerifierVocabulary, registryRevision, resolveCapabilities, serializeSkillSidecar, sidecarWithSkillMd, skillContentDigest, skillContractDefects, skillContractDigest, skillSearchRoots, unlistableVerifierRefusal, validateSkillProvider, walkVerified } from "@dangosys/dsh-singularity-task-runtime";
import { createHash, randomBytes } from "node:crypto";

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
	"interrupted",
	"not-admitted"
];
const EXPERIMENT_ADMISSION_SOURCES = ["capability-gap", "provider-refused"];
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
*
* A side the runtime refused at admission (A6, `not-admitted`) has no outcome to
* rank and no criteria to compare, so it is answered before the v1 rules rather
* than read through them: a baseline the production configuration could not
* admit is the gap itself — the candidate passing the same frozen acceptance is
* the `fixed` verdict, and the candidate failing beside it is `both-failed` —
* while a candidate that could not be admitted is never a fix. A regression or
* holdout sample needs a reproduced baseline to be comparable, so a refused
* baseline there leaves it `inconclusive`, never `maintained`.
*/
function compareExperimentSides(role, baseline, candidate) {
	if (candidate.outcome === "not-admitted") return role === "observed-failure" ? "not-fixed" : "inconclusive";
	if (baseline.outcome === "not-admitted") {
		if (candidate.outcome !== "verified") return role === "observed-failure" ? "both-failed" : "inconclusive";
		return role === "observed-failure" ? "fixed" : "maintained";
	}
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
function isRecord$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHex64$1(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function assertIdentity(value, field) {
	if (!isRecord$2(value) || typeof value.name !== "string" || value.name.length === 0 || !isHex64$1(value.sha256)) throw new Error(`evolution: experiment report ${field} must be a content identity { name, sha256, contract? }`);
	if (value.contract !== void 0) {
		const contract = value.contract;
		if (!isRecord$2(contract) || !isHex64$1(contract.sha256) || !isHex64$1(contract.contractDigest)) throw new Error(`evolution: experiment report ${field}.contract must be { sha256, contractDigest } with both a SHA-256 hex — a frozen object with an execution sidecar names that file by its exact bytes and by the canonical declaration identity together`);
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
	if (!isRecord$2(value)) throw new Error("evolution: experiment report frozen must be an object");
	if (typeof value.proposalId !== "string" || value.proposalId.length === 0) throw new Error("evolution: experiment report frozen.proposalId must be a non-empty string");
	if (!Number.isInteger(value.repetition) || value.repetition < 0) throw new Error("evolution: experiment report frozen.repetition must be a non-negative integer");
	if (value.candidate === void 0 && value.capability === void 0) throw new Error("evolution: experiment report frozen must name the candidate it evaluates — a skill object identity (frozen.candidate) or a capability candidate (frozen.capability, with frozen.candidate only when the candidate carries a new skill); a block that names neither is not an experiment this build can re-read");
	if (value.candidate !== void 0) assertIdentity(value.candidate, "frozen.candidate");
	if (value.capability !== void 0) assertFrozenCapability(value.capability);
	if (value.productionBaseline !== void 0) {
		if (value.candidate === void 0) throw new Error("evolution: experiment report frozen.productionBaseline names the object a skill candidate replaces, but this block carries no frozen.candidate — a capability candidate's production baseline is the registry row it moves (frozen.capability.baseline), never a skill object it does not touch");
		assertIdentity(value.productionBaseline, "frozen.productionBaseline");
	}
	assertModelSelection(value.model, "frozen.model");
	assertExperimentBudget(value.budget, "frozen.budget");
	if (!isRecord$2(value.snapshot) || typeof value.snapshot.sourceDir !== "string" || value.snapshot.sourceDir.length === 0 || !isHex64$1(value.snapshot.digest)) throw new Error("evolution: experiment report frozen.snapshot must be { sourceDir, digest } with a SHA-256 content digest");
	if (value.comparerVersion !== EXPERIMENT_COMPARER_VERSION) throw new Error(`evolution: experiment report frozen.comparerVersion must be "${EXPERIMENT_COMPARER_VERSION}" — got ${JSON.stringify(value.comparerVersion)}; a report this build cannot re-derive is refused, not trusted`);
	if (!isRecord$2(value.overlay) || typeof value.overlay.baseline !== "string" || value.overlay.baseline.length === 0 || typeof value.overlay.candidate !== "string" || value.overlay.candidate.length === 0) throw new Error("evolution: experiment report frozen.overlay must name what each side ran under");
	if (!Array.isArray(value.samples) || value.samples.length === 0) throw new Error("evolution: experiment report frozen.samples must be a non-empty array");
	const taskIds = /* @__PURE__ */ new Set();
	value.samples.forEach((sample, index) => assertFrozenSample(sample, `frozen.samples[${index}]`, taskIds, value.capability !== void 0));
	const roles = value.samples.map((sample) => sample.role);
	if (!roles.includes("observed-failure")) throw new Error("evolution: an experiment frozen block needs at least one observed-failure sample (§F.2: the target failure must be reproduced)");
	if (!roles.includes("holdout")) throw new Error("evolution: an experiment frozen block needs at least one holdout sample (§F.2: the candidate must not be selected on every case)");
}
/** One capability candidate's frozen identity (A6): the row, the row it replaces, and the gap it came from. */
function assertFrozenCapability(value) {
	if (!isRecord$2(value)) throw new Error("evolution: experiment report frozen.capability must be the capability candidate { row, baseline, sourceRefs } — the whole row the candidate installs, the registry row it moves, and the proposal's source refs");
	assertFrozenCapabilityRow(value.row, "frozen.capability.row");
	if (value.baseline !== null) assertFrozenCapabilityRow(value.baseline, "frozen.capability.baseline");
	if (!Array.isArray(value.sourceRefs) || value.sourceRefs.some((ref) => typeof ref !== "string" || ref.length === 0)) throw new Error("evolution: experiment report frozen.capability.sourceRefs must be an array of non-empty source refs");
}
function assertFrozenCapabilityRow(value, field) {
	if (!isRecord$2(value) || typeof value.name !== "string" || value.name.length === 0 || !isHex64$1(value.digest) || !isRecord$2(value.entry) || !Array.isArray(value.entry.skills) || value.entry.skills.some((skill) => typeof skill !== "string" || skill.length === 0)) throw new Error(`evolution: experiment report ${field} must be one whole capability row { name, entry, digest } — the name, the row itself (at least its skills) and the SHA-256 of its canonical bytes`);
}
/** One side's frozen provider identity of a capability sample (A6). */
function assertFrozenCapabilitySide(value, field) {
	if (!isRecord$2(value) || !Array.isArray(value.capabilities) || value.capabilities.some((item) => typeof item !== "string" || item.length === 0) || typeof value.registryRevision !== "string" || value.registryRevision.length === 0 || !Array.isArray(value.mcpServers) || value.mcpServers.some((item) => typeof item !== "string" || item.length === 0) || value.preset !== null && (typeof value.preset !== "string" || value.preset.length === 0) || !Array.isArray(value.skills)) throw new Error(`evolution: experiment report ${field} must be one capability side's frozen identity (capabilities, registryRevision, mcpServers, preset, skills)`);
	const names = /* @__PURE__ */ new Set();
	for (const skill of value.skills) {
		assertFrozenProviderSkill(skill, `${field}.skills[${skill.name}]`);
		if (names.has(skill.name)) throw new Error(`evolution: experiment report ${field} repeats skill "${skill.name}"`);
		names.add(skill.name);
	}
}
/** One sample's frozen production refusal (A6). */
function assertFrozenSampleAdmission(value, field) {
	if (!isRecord$2(value) || !EXPERIMENT_ADMISSION_SOURCES.includes(value.source) || !Array.isArray(value.required) || value.required.some((item) => typeof item !== "string" || item.length === 0) || !Array.isArray(value.missing) || value.missing.some((item) => typeof item !== "string" || item.length === 0) || typeof value.reason !== "string" || value.reason.length === 0) throw new Error(`evolution: experiment report ${field} must record the production configuration's own refusal (source: one of ${EXPERIMENT_ADMISSION_SOURCES.join(" / ")}, required, missing, reason)`);
}
function assertExperimentBudget(value, field) {
	if (!isRecord$2(value)) throw new Error(`evolution: ${field} must be an object (the whole experiment's token ceiling)`);
	for (const key of Object.keys(value)) {
		if (key === "wallTimeMs") throw new Error(`evolution: ${field}.wallTimeMs is removed — an experiment has no wall-clock ceiling; freeze an optional \`maxTokens\` total instead, and bound a run's time with the deployment's own limits (rootBudget.wallTimeMs, or the per-run Config.budget.wallTimeMs). A budget this build cannot enforce is refused rather than ignored`);
		if (key !== "maxTokens" && key !== "note") throw new Error(`evolution: ${field} has unknown key "${key}"`);
	}
	const member = value.maxTokens;
	if (member !== void 0 && (typeof member !== "number" || !Number.isFinite(member) || member < 0)) throw new Error(`evolution: ${field}.maxTokens must be a non-negative number`);
	if (value.note !== void 0 && (typeof value.note !== "string" || value.note.length === 0)) throw new Error(`evolution: ${field}.note must be a non-empty string`);
}
function assertModelSelection(value, field) {
	if (!isRecord$2(value)) throw new Error(`evolution: experiment report ${field} must be the structured model selection { provider, model } this build froze — a record that froze a bare string cannot name the route its runs took, so it is refused rather than read as one`);
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
	if (!isRecord$2(value) || typeof value.name !== "string" || value.name.length === 0 || ![
		"execution-provider",
		"knowledge",
		"guidance"
	].includes(value.role) || value.contractDigest !== null && !isHex64$1(value.contractDigest) || !isHex64$1(value.contentDigest)) throw new Error(`evolution: experiment report ${field} must be a resolved skill identity { name, role, contractDigest, contentDigest }`);
}
function assertFrozenProviderIdentity(value, field) {
	if (!isRecord$2(value)) throw new Error(`evolution: experiment report ${field} must be the frozen provider identity of the sample's production baseline (capabilities, registryRevision, mcpServers, preset, skills) — a sample frozen before that identity was recorded cannot constrain what its sides really ran against`);
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
function assertFrozenSample(value, field, seen, capability) {
	if (!isRecord$2(value) || typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: experiment report ${field} must carry a taskId`);
	if (seen.has(value.taskId)) throw new Error(`evolution: experiment report ${field} repeats task "${value.taskId}"`);
	seen.add(value.taskId);
	if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role)) throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(" / ")}`);
	if (!isHex64$1(value.contractDigest)) throw new Error(`evolution: experiment report ${field}.contractDigest must be a SHA-256 hex`);
	if (!Array.isArray(value.criteria) || value.criteria.length === 0) throw new Error(`evolution: experiment report ${field}.criteria must be a non-empty array (the acceptance the replay mirrors)`);
	const criterionIds = /* @__PURE__ */ new Set();
	for (const criterion of value.criteria) {
		if (!isRecord$2(criterion) || typeof criterion.criterionId !== "string" || criterion.criterionId.length === 0 || criterionIds.has(criterion.criterionId) || typeof criterion.verificationMode !== "string" || criterion.verificationMode.length === 0 || criterion.command !== void 0 && typeof criterion.command !== "string" || !isHex64$1(criterion.protectedInputsDigest)) throw new Error(`evolution: experiment report ${field} has an invalid or duplicate frozen criterion`);
		if (typeof criterion.verifierRef !== "string" || criterion.verifierRef.length === 0) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must pin the judge it was frozen with — a criterion whose judge nobody can name cannot be recalled against the instance that decides it`);
		if (typeof criterion.verifierVersion !== "string" || criterion.verifierVersion.length === 0) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must carry the version of the pinned judge it was frozen with — a verdict belongs to the instance that judged it`);
		if (typeof criterion.verifierAnchor !== "string" || criterion.verifierAnchor.length === 0) throw new Error(`evolution: experiment report ${field} criterion "${criterion.criterionId}" must name how its judge identity is anchored`);
		criterionIds.add(criterion.criterionId);
	}
	if (!isRecord$2(value.observed) || value.observed.outcome !== "verified" && value.observed.outcome !== "failed" || value.observed.runId !== void 0 && (typeof value.observed.runId !== "string" || value.observed.runId.length === 0)) throw new Error(`evolution: experiment report ${field}.observed must record the historical outcome (and run, when known) the sample was chosen for`);
	if (!capability) {
		for (const member of ["admission", "candidateProvider"]) if (value[member] !== void 0) throw new Error(`evolution: experiment report ${field}.${member} belongs to a capability experiment (A6), and this frozen block carries no frozen.capability — a skill experiment's samples bind one production identity and nothing else`);
	}
	if (value.admission !== void 0) {
		assertFrozenSampleAdmission(value.admission, `${field}.admission`);
		if (value.provider !== void 0) throw new Error(`evolution: experiment report ${field} records both a production provider identity and the refusal that stands in its place — a baseline side either runs under the production configuration or is refused at admission, never both`);
	}
	if (value.provider !== void 0) assertFrozenProviderIdentity(value.provider, `${field}.provider`);
	if (capability) {
		if (value.candidateProvider === void 0) throw new Error(`evolution: experiment report ${field} is a capability sample and must record the overlay identity its candidate side binds (candidateProvider: capabilities, registryRevision, mcpServers, preset, skills) — a side whose configuration nobody froze cannot be compared against anything`);
		assertFrozenCapabilitySide(value.candidateProvider, `${field}.candidateProvider`);
		if (value.admission === void 0 && value.provider === void 0) throw new Error(`evolution: experiment report ${field} records neither the production provider identity nor the admission refusal that stands in its place — what its baseline side is or why it could not run must be frozen before the experiment runs`);
		return;
	}
	if (value.provider === void 0) throw new Error(`evolution: experiment report ${field}.provider must be the frozen provider identity of the sample's production baseline (capabilities, registryRevision, candidateRegistryRevision, mcpServers, preset, skills) — a sample frozen before that identity was recorded cannot constrain what its sides really ran against`);
}
function assertCriterionDetail(value, field) {
	if (!isRecord$2(value) || typeof value.criterionId !== "string" || value.criterionId.length === 0 || !EXPERIMENT_CONDITION_VERDICTS.includes(value.verdict) || value.verifierId !== void 0 && (typeof value.verifierId !== "string" || value.verifierId.length === 0) || value.verifierVersion !== void 0 && (typeof value.verifierVersion !== "string" || value.verifierVersion.length === 0) || value.command !== void 0 && typeof value.command !== "string" || value.exitCode !== void 0 && typeof value.exitCode !== "number") throw new Error(`evolution: experiment report ${field} has an invalid criterion verdict`);
}
function assertCost(value, field) {
	if (!isRecord$2(value)) throw new Error(`evolution: experiment report ${field} must be a cost object`);
	if (value.status === "unknown") {
		if (typeof value.reason !== "string" || value.reason.length === 0) throw new Error(`evolution: experiment report ${field} must say why the cost is unknown`);
		return;
	}
	if (value.status !== "reported" || !isRecord$2(value.metrics)) throw new Error(`evolution: experiment report ${field} must be { status: "reported", metrics } or { status: "unknown", reason }`);
}
function assertSideDetail(value, field, sample) {
	if (!isRecord$2(value)) throw new Error(`evolution: experiment report ${field} must be an object`);
	if (value.taskId !== void 0 && (typeof value.taskId !== "string" || value.taskId.length === 0)) throw new Error(`evolution: experiment report ${field}.taskId must be a non-empty string when present`);
	if (value.taskId === sample.taskId) throw new Error(`evolution: experiment report ${field} names the sample's own historical task "${sample.taskId}" as a run of this experiment — the historical task is the case, not a baseline; both sides must be new replayed tasks`);
	if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role)) throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(" / ")}`);
	if (!EXPERIMENT_SIDES.includes(value.side)) throw new Error(`evolution: experiment report ${field}.side must be one of ${EXPERIMENT_SIDES.join(" / ")}`);
	if (!EXPERIMENT_OUTCOME_SET.has(value.outcome)) throw new Error(`evolution: experiment report ${field}.outcome must be one of ${EXPERIMENT_OUTCOMES.join(" / ")}`);
	for (const key of ["runId", "reviewRef"]) {
		const member = value[key];
		if (member !== void 0 && (typeof member !== "string" || member.length === 0)) throw new Error(`evolution: experiment report ${field}.${key} must be a non-empty string when present`);
	}
	if (sample.observed.runId !== void 0 && value.runId === sample.observed.runId) throw new Error(`evolution: experiment report ${field} cites run "${sample.observed.runId}", the sample's own historical run — the historical champion locates the case and is never this experiment's baseline; both sides must be new runs`);
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
	if (value.outcome === "not-admitted") {
		if (value.side !== "baseline") throw new Error(`evolution: experiment report ${field} records the candidate side as not-admitted — a candidate the runtime will not admit produced no run, so it fixed nothing and cannot stand as a fix; only a baseline side may be not-admitted`);
		if (sample.admission === void 0) throw new Error(`evolution: experiment report ${field} is not-admitted, but the frozen sample records no production refusal to check it against — a side that never ran needs the admission identity frozen before the experiment`);
		assertAdmissionRecord(value.admission, field);
		if (value.taskId !== void 0 || value.runId !== void 0 || value.reviewRef !== void 0) throw new Error(`evolution: experiment report ${field} is not-admitted and cites a task, a run or a review — a refused side produced no run, and a failure run invented in its place is not evidence`);
		if (value.evidenceRefs.length > 0 || ids.size > 0) throw new Error(`evolution: experiment report ${field} is not-admitted and cites evidence or criteria — no run produced any`);
		return;
	}
	if (value.admission !== void 0) throw new Error(`evolution: experiment report ${field} carries an admission refusal but settled as "${String(value.outcome)}"`);
	if (value.outcome === "interrupted") {
		if (typeof value.reason !== "string" || value.reason.length === 0) throw new Error(`evolution: experiment report ${field} is interrupted and must carry the reason it has no terminal run`);
		return;
	}
	if (typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: experiment report ${field} settled a run and must name the replayed task it created`);
	if (value.initialDigest === void 0) throw new Error(`evolution: experiment report ${field} settled a run and must carry the workspace's initial digest`);
	if (value.outcome === "verified" && ids.size === 0) throw new Error(`evolution: experiment report ${field} verified outcome needs criterion evidence`);
}
/** The runtime's own refusal, as the report carries it for a `not-admitted` side (A6). */
function assertAdmissionRecord(value, field) {
	if (!isRecord$2(value) || !EXPERIMENT_ADMISSION_SOURCES.includes(value.source) || typeof value.proposalId !== "string" || value.proposalId.length === 0 || !Array.isArray(value.sourceRefs) || value.sourceRefs.some((ref) => typeof ref !== "string" || ref.length === 0) || !Array.isArray(value.required) || value.required.some((item) => typeof item !== "string" || item.length === 0) || !Array.isArray(value.missing) || value.missing.some((item) => typeof item !== "string" || item.length === 0) || typeof value.reason !== "string" || value.reason.length === 0) throw new Error(`evolution: experiment report ${field}.admission must record which admission rule refused the side (one of ${EXPERIMENT_ADMISSION_SOURCES.join(" / ")}), the proposal and source refs it belongs to, the required rows, the rows the table did not hold and the runtime's own refusal text`);
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
	if (!isRecord$2(report)) throw new Error("evolution: experiment report must be an object");
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
		if (!isRecord$2(entry)) throw new Error(`evolution: experiment report ${field} must be an object`);
		const taskId = entry.taskId;
		const frozenSample = typeof taskId === "string" ? byTask.get(taskId) : void 0;
		if (frozenSample === void 0) throw new Error(`evolution: experiment report ${field}.taskId is not one of the frozen samples`);
		if (seen.has(frozenSample.taskId)) throw new Error(`evolution: experiment report ${field} repeats sample "${frozenSample.taskId}"`);
		seen.add(frozenSample.taskId);
		if (entry.role !== frozenSample.role) throw new Error(`evolution: experiment report ${field}.role does not match the frozen sample's role`);
		if (!EXPERIMENT_SAMPLE_VERDICTS.includes(entry.verdict)) throw new Error(`evolution: experiment report ${field}.verdict must be one of ${EXPERIMENT_SAMPLE_VERDICTS.join(" / ")}`);
		assertSideDetail(entry.baseline, `${field}.baseline`, frozenSample);
		assertSideDetail(entry.candidate, `${field}.candidate`, frozenSample);
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
//#region src/capability-candidate.ts
/** The keys a capability row may declare — the whole vocabulary `CapabilityConfig` has. */
const ROW_KEYS = [
	"skills",
	"tools",
	"preset",
	"permission",
	"mcpServers"
];
/** The keys one capability mutation may declare: the rows, and the optional new skill. */
const MUTATION_KEYS = ["rows", "skill"];
/** The keys one carried new skill may declare. */
const SKILL_KEYS = [
	"name",
	"content",
	"sidecar"
];
/** The refusal of one rule, carrying its machine-readable code as the message's second word. */
function capabilityRefusal(code, detail) {
	return /* @__PURE__ */ new Error(`evolution: ${code}: ${detail}`);
}
/** The same refusal, as the one function every rule in this module reports through. */
function refusal$1(code, detail) {
	return capabilityRefusal(code, detail);
}
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function nonEmpty$2(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw refusal$1("capability-row-invalid", `${field} must be a non-empty string`);
	return value;
}
/** A single safe path segment: the skill-name rule every other entry of this plane uses. */
function assertSegment$1(value, field) {
	const text = nonEmpty$2(value, field);
	if (text === "." || text === ".." || text.includes("/") || text.includes("\\")) throw refusal$1("capability-row-invalid", `${field} must be a single safe path segment, got "${text}"`);
	return text;
}
/** The canonical bytes of one row — what a sandbox freezes and an intent's source holds. */
function capabilityRowBytes(entry) {
	return canonicalJson(entry);
}
/** SHA-256 of {@link capabilityRowBytes}: the identity a row is compared by, everywhere. */
function capabilityRowDigest(entry) {
	return digestOf(entry);
}
/** The frozen identity of one row, as a prepared record and a commit intent name it. */
function capabilityRowIdentity(row) {
	return {
		name: row.name,
		entry: row.entry,
		digest: capabilityRowDigest(row.entry)
	};
}
/** The table a candidate would produce: the store's rows with this one row folded in. */
function capabilityTableWith(table, row) {
	return {
		...table,
		[row.name]: row.entry
	};
}
/**
* Validate one capability row's shape and return it normalized — the whole row,
* with no field inherited from anywhere. `where` names the row in the refusal.
*/
function assertCapabilityRow(where, value) {
	if (!isRecord$1(value)) throw refusal$1("capability-row-invalid", `${where} must be an object carrying the row's own fields (${ROW_KEYS.join(", ")})`);
	for (const key of Object.keys(value)) if (!ROW_KEYS.includes(key)) throw refusal$1("capability-row-invalid", `${where} declares unknown field ${JSON.stringify(key)}; a capability row carries ${ROW_KEYS.join(", ")}`);
	const names = (field, list, minItems) => {
		if (list === void 0) return void 0;
		if (!Array.isArray(list)) throw refusal$1("capability-row-invalid", `${where}.${field} must be an array`);
		const seen = /* @__PURE__ */ new Set();
		for (const item of list) {
			if (typeof item !== "string" || item.trim().length === 0) throw refusal$1("capability-row-invalid", `${where}.${field} must hold non-empty strings`);
			if (seen.has(item)) throw refusal$1("capability-row-invalid", `${where}.${field} lists ${JSON.stringify(item)} twice`);
			seen.add(item);
		}
		if (list.length < minItems) throw refusal$1("capability-row-invalid", `${where}.${field} must name at least ${minItems} entry`);
		return [...list];
	};
	const skills = names("skills", value.skills, 1);
	if (skills === void 0) throw refusal$1("capability-row-invalid", `${where} declares no skills — a capability row that grants nothing is not a candidate this build prepares`);
	const entry = { skills };
	const tools = names("tools", value.tools, 0);
	if (tools !== void 0) entry.tools = tools;
	const mcpServers = names("mcpServers", value.mcpServers, 0);
	if (mcpServers !== void 0) entry.mcpServers = mcpServers;
	for (const field of ["preset", "permission"]) {
		const declared = value[field];
		if (declared === void 0) continue;
		if (typeof declared !== "string" || declared.trim().length === 0) throw refusal$1("capability-row-invalid", `${where}.${field} must be a non-empty string`);
		entry[field] = declared;
	}
	return entry;
}
/** The declaration of one carried new skill, validated: shape, loader acceptance, then the rules a new object must satisfy. */
function assertCarriedSkill(row, value) {
	if (!isRecord$1(value)) throw refusal$1("skill-invalid", "the candidate's skill must be an object carrying name, content and sidecar");
	for (const key of Object.keys(value)) if (!SKILL_KEYS.includes(key)) throw refusal$1("skill-invalid", `the candidate's skill declares unknown field ${JSON.stringify(key)}; it carries ${SKILL_KEYS.join(", ")}`);
	const name = assertSegment$1(value.name, "skill.name");
	if (typeof value.content !== "string" || value.content.length === 0) throw refusal$1("skill-invalid", "skill.content must be the whole non-empty SKILL.md text");
	const content = value.content;
	const defects = skillContractDefects(value.sidecar);
	if (defects.length > 0) throw refusal$1("skill-sidecar-invalid", `the declaration of the new skill "${name}" is not one this build reads — ${defects.map((defect) => `${defect.code}: ${defect.reason}`).join("; ")}`);
	const sidecar = value.sidecar;
	if (sidecar.type !== "execution") throw refusal$1("skill-sidecar-not-execution", `the new skill "${name}" carries a ${sidecar.type} declaration, and a capability candidate's skill is the execution provider its row grants — a knowledge or guidance object claims no capability and no verifier, so it is not the object this row would install`);
	if (sidecar.content.resources.length > 0) throw refusal$1("skill-resources-nonempty", `the new skill "${name}" declares ${sidecar.content.resources.length} resource(s) (${sidecar.content.resources.map((resource) => JSON.stringify(resource.path)).join(", ")}), and this build's candidate is SKILL.md plus the SKILL.contract.json beside it with \`resources: []\` — resources need an executor that writes them, so the candidate is refused before anything is written`);
	const digest = createHash("sha256").update(content, "utf8").digest("hex");
	if (sidecar.content.skillMdSha256 !== digest) throw refusal$1("skill-content-mismatch", `the new skill "${name}" declares content.skillMdSha256 ${sidecar.content.skillMdSha256}, but the submitted SKILL.md hashes to ${digest} — the declaration must be the identity of the bytes it authorises`);
	if (!sidecar.capabilities.includes(row.name)) throw refusal$1("skill-capabilities-missing-row", `the new skill "${name}" declares capabilities [${sidecar.capabilities.join(", ")}], which does not include the row "${row.name}" this candidate writes — a provider the candidate's own capability does not carry would be granted by nothing`);
	if (!row.entry.skills.includes(name)) throw refusal$1("capability-row-grants-no-skill", `the row "${row.name}" grants [${row.entry.skills.join(", ")}], which does not include the new skill "${name}" this candidate carries — the row is what grants the provider, so a candidate that writes a skill nothing grants is refused`);
	return {
		name,
		content,
		sidecar
	};
}
/**
* Validate one whole capability mutation and return it normalized. The entry
* point of both the live write path (`EvolutionService.candidate`) and the fold,
* so a hand-forged ledger line fails exactly as a live append would.
*/
function validateCapabilityMutation(mutation) {
	if (!isRecord$1(mutation)) throw refusal$1("capability-row-missing", "a capability mutation must be an object carrying exactly one row under `rows`");
	for (const key of Object.keys(mutation)) if (!MUTATION_KEYS.includes(key)) throw refusal$1("capability-row-invalid", `a capability mutation declares unknown key ${JSON.stringify(key)}; it carries ${MUTATION_KEYS.join(", ")}`);
	const rows = mutation.rows;
	if (!isRecord$1(rows)) throw refusal$1("capability-row-missing", "a capability mutation carries `rows` — an object holding exactly one capability row");
	const names = Object.keys(rows);
	if (names.length === 0) throw refusal$1("capability-row-missing", "a capability mutation carries no row: exactly one capability row is the unit this build prepares");
	if (names.length > 1) throw refusal$1("capability-row-multiple", `a capability mutation carries ${names.length} rows (${names.map((name) => JSON.stringify(name)).join(", ")}); exactly one whole row is the unit this build prepares, and a candidate that moved several rows is refused rather than split`);
	const row = {
		name: nonEmpty$2(names[0], "row name"),
		entry: assertCapabilityRow(`row "${names[0]}"`, rows[names[0]])
	};
	const skill = mutation.skill === void 0 ? void 0 : assertCarriedSkill(row, mutation.skill);
	return {
		row,
		...skill === void 0 ? {} : { skill }
	};
}
/** The real DSH tools and MCP servers a store's current capability table authorizes. */
function authorizedToolPlane(table) {
	const tools = /* @__PURE__ */ new Set();
	const servers = /* @__PURE__ */ new Set();
	const query = capabilityToolQuery(table);
	for (const name of Object.keys(table)) {
		const answer = query(name);
		if (!answer.known) continue;
		for (const tool of answer.tools) tools.add(tool);
		for (const server of answer.mcpServers) servers.add(server);
	}
	return {
		tools,
		servers
	};
}
/** Whether one tool a declaration requires is inside the store's authorized plane (`mcp__<server>__<tool>` counts when the server is mounted). */
function insidePlane(plane, tool) {
	if (plane.tools.has(tool)) return true;
	return [...plane.servers].some((server) => tool.startsWith(`mcp__${server}__`) && tool.length > `mcp__${server}__`.length);
}
/**
* Whether one candidate row may be written at all: no tool the store has not
* already authorized, and no preset / permission / MCP-server change against the
* row it replaces (a brand-new row declares none of them).
*/
function assertCapabilityRowAdmissible(store, row, baseline) {
	const answer = capabilityToolQuery(capabilityTableWith(store.table, row))(row.name);
	if (!answer.known) throw refusal$1("capability-row-invalid", `the row "${row.name}" does not resolve: ${answer.reason}`);
	const plane = authorizedToolPlane(store.table);
	const newTools = answer.tools.filter((tool) => !plane.tools.has(tool));
	if (newTools.length > 0) throw refusal$1("capability-new-tool", `the row "${row.name}" grants tool(s) this store's capability table does not authorize (${newTools.map((tool) => JSON.stringify(tool)).join(", ")}); this build composes granted capabilities and never authorizes a new tool — a provider that needs one is refused by name`);
	const newServers = answer.mcpServers.filter((server) => !plane.servers.has(server));
	if (newServers.length > 0) throw refusal$1("capability-new-server", `the row "${row.name}" mounts MCP server(s) this store's capability table does not mount (${newServers.map((server) => JSON.stringify(server)).join(", ")}); mounting a new server plane is a tool grant this build refuses by name`);
	for (const field of ["preset", "permission"]) {
		if (row.entry[field] === baseline?.[field]) continue;
		throw refusal$1("capability-policy-change", `the row "${row.name}" declares ${field} ${row.entry[field] === void 0 ? "(none)" : JSON.stringify(row.entry[field])}, while the store's row reads ${baseline?.[field] === void 0 ? "(none)" : JSON.stringify(baseline?.[field])} — a capability candidate composes granted capabilities and adds a provider, and never moves the permission or preset a worker runs under`);
	}
	const sorted = (list) => JSON.stringify([...list ?? []].sort());
	if (sorted(row.entry.mcpServers) !== sorted(baseline?.mcpServers)) throw refusal$1("capability-policy-change", `the row "${row.name}" mounts MCP servers ${sorted(row.entry.mcpServers)}, while the store's row mounts ${sorted(baseline?.mcpServers)} — a capability candidate never changes the server plane a worker is granted`);
}
/**
* The `SKILL.md` discovery finds for one skill name under `roots`, or `undefined`
* when no root holds one — the same walk (`walkVerified`) and the same
* `<root>/<name>/SKILL.md` shape the store's own discovery searches, so "this
* name is free" is answered about the roots a worker would load from. A root
* that cannot be listed, or a path that is a symbolic link, contributes nothing.
*/
async function discoverSkill(roots, name) {
	for (const root of [...new Set(roots)]) {
		let walked;
		try {
			walked = await walkVerified(root, join(name, "SKILL.md"));
		} catch {
			continue;
		}
		if (!walked.missing) return walked.abs;
	}
}
/**
* Every skill object discovery can see, read through the walk-verified read (a
* symbolic link or a wrong type on the way is a loud failure, never a silent
* follow). A root that cannot be listed contributes nothing: the store's own
* discovery would not find a skill there either.
*/
async function existingSkills(roots) {
	const found = [];
	for (const root of [...new Set(roots)]) {
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			let walked;
			try {
				walked = await walkVerified(root, join(entry.name, "SKILL.md"));
			} catch {
				continue;
			}
			if (walked.missing) continue;
			const bytes = await readFile(walked.abs);
			found.push({
				name: entry.name,
				body: skillBody(bytes.toString("utf8"))
			});
		}
	}
	return found;
}
/**
* Whether the declared verifier is one this deployment can judge a run with:
* registered *and* versioned. Fail-closed: a registry that cannot be listed, or
* a ref registered without a version, refuses the candidate rather than assuming
* a judge exists.
*/
function assertVerifierRegistered(store, name, ref) {
	const vocabulary = store.verifierVocabulary;
	if (vocabulary === void 0) throw refusal$1("skill-verifier-unregistered", `the new skill "${name}" declares execution verifier ${JSON.stringify(ref)}, and this deployment cannot list its verifier registry (no verifier service, or \`verifierIds()\` unavailable) — the ref is refused rather than assumed registered`);
	const registered = [...vocabulary.ids].sort();
	if (!vocabulary.ids.includes(ref)) throw refusal$1("skill-verifier-unregistered", `the new skill "${name}" declares execution verifier ${JSON.stringify(ref)}, which is not registered; registered verifiers: ${registered.length === 0 ? "none" : registered.join(", ")} — a candidate does not register its own judge`);
	const version = vocabulary.versions[ref];
	if (typeof version !== "string" || version.trim().length === 0) throw refusal$1("skill-verifier-unregistered", `the new skill "${name}" declares execution verifier ${JSON.stringify(ref)}, which the registry lists without a declared version — a judge no evidence can be pinned to is not one this build promotes against`);
}
/**
* Every rule the capability candidate itself must satisfy against the store it
* would land in, in one place — the write path (prepare) and the promotion gate
* both call it, against the store as it stands at that moment, so a store that
* moved between the two is refused by the same words.
*/
async function assertCapabilityCandidateAdmissible(store, candidate, baseline) {
	assertCapabilityRowAdmissible(store, candidate.row, baseline);
	const skill = candidate.skill;
	if (skill === void 0) return;
	assertVerifierRegistered(store, skill.name, skill.sidecar.type === "execution" ? skill.sidecar.verifier.ref : "");
	const plane = authorizedToolPlane(store.table);
	const unauthorized = skill.sidecar.type === "execution" ? skill.sidecar.requiredTools.filter((tool) => !insidePlane(plane, tool)) : [];
	if (unauthorized.length > 0) throw refusal$1("skill-tool-unauthorized", `the new skill "${skill.name}" requires tool(s) this store's capability table does not authorize (${unauthorized.map((tool) => JSON.stringify(tool)).sort().join(", ")}); this build composes the tools a deployment already grants, and a provider that needs a new one is refused by name rather than granted`);
	const body = skillBody(skill.content);
	const existing = await existingSkills([store.skillRoot, ...store.skillRoots]);
	if (existing.find((entry) => entry.name === skill.name) !== void 0) throw refusal$1("skill-name-taken", `the candidate's new skill is named "${skill.name}", which is already a skill object this store's discovery finds — a new directory may not cover a same-name production object; improving that object is the same-name update (a \`skill\` candidate), not a new skill`);
	const renamed = body.length === 0 ? void 0 : existing.find((entry) => entry.body === body);
	if (renamed !== void 0) throw refusal$1("skill-renamed-production", `the candidate's new skill "${skill.name}" carries the same body as the production skill "${renamed.name}" — a renamed copy is not a new object, and an existing object is improved through the same-name path rather than around it`);
}
/**
* The body of one `SKILL.md`: everything after its frontmatter block, trimmed.
* The part a rename does not change — the frontmatter carries the name, so a
* copy with its name rewritten would otherwise look like a new object, which is
* exactly the circumvention the same-name rule must not admit.
*/
function skillBody(content) {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") return content.trim();
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	return end === -1 ? content.trim() : lines.slice(end + 1).join("\n").trim();
}
/**
* The candidate-side overlay of one prepared capability proposal (A6 interface
* ②): the frozen row as a whole-row `capabilityOverrides` entry, and the sandbox
* skill root as an `extraSkillRoots` entry in front of the production roots.
* Read off the prepared record, so what an evaluation mounts is what the commit
* would install.
*/
function capabilityOverlay(proposal, roots) {
	const prepared = proposal.prepared;
	const row = prepared?.capabilityRow;
	if (prepared?.sandbox == null || row === void 0) throw refusal$1("capability-overlay-unprepared", `proposal "${proposal.proposalId}" carries no prepared capability candidate — an overlay is the identity prepare froze, so a proposal without one has nothing to mount`);
	return {
		capabilityOverrides: { [row.name]: row.entry },
		extraSkillRoots: prepared.skillContent === void 0 ? [] : [join(roots.root, prepared.sandbox, "skills")]
	};
}
/**
* Read one prepared capability candidate back from its sandbox and verify it
* against the identities prepare recorded (P2 for the row and the new skill's
* files, P3's bytes for the champion row): the one read path the promotion gate
* and the apply write share, so what is promoted and what is committed are
* provably the same bytes. Every mismatch is a named refusal and never a
* re-digest.
*/
async function readPreparedCapability(root, proposal) {
	const prepared = proposal.prepared;
	const identity = prepared?.capabilityRow;
	if (prepared?.sandbox == null || identity === void 0) throw refusal$1("capability-unprepared", `proposal "${proposal.proposalId}" has no materialized capability candidate — nothing this proposal names was ever prepared, so there is nothing to evaluate, promote or write`);
	const sandbox = prepared.sandbox;
	const rowRel = `${sandbox}/capability/${identity.name}.json`;
	const rowBytes = await readVerifiedFile(root, rowRel);
	const digest = createHash("sha256").update(rowBytes).digest("hex");
	if (digest !== identity.digest) throw refusal$1("capability-row-drifted", `the frozen row "${rowRel}" no longer hashes to the identity prepare recorded (sha256 ${digest} != ${identity.digest}) — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
	let parsed;
	try {
		parsed = JSON.parse(rowBytes.toString("utf8"));
	} catch (error) {
		throw refusal$1("capability-row-invalid", `the frozen row "${rowRel}" is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	const entry = assertCapabilityRow(`the frozen row "${identity.name}"`, parsed);
	if (capabilityRowDigest(entry) !== identity.digest) throw refusal$1("capability-row-drifted", `the frozen row "${rowRel}" holds data that hashes to ${capabilityRowDigest(entry)}, not the ${identity.digest} prepare recorded`);
	const result = {
		row: {
			name: identity.name,
			entry
		},
		rowBytes
	};
	if (prepared.capabilityBaseline != null) {
		const baselineRel = `${sandbox}/champion/capability/${identity.name}.json`;
		const bytes = await readVerifiedFile(root, baselineRel);
		const baselineDigest = createHash("sha256").update(bytes).digest("hex");
		if (baselineDigest !== prepared.capabilityBaseline.digest) throw refusal$1("capability-row-drifted", `the champion row "${baselineRel}" no longer hashes to the identity prepare recorded (sha256 ${baselineDigest} != ${prepared.capabilityBaseline.digest}) — the row this candidate would restore cannot be re-proved, so nothing is promoted`);
		result.baseline = {
			entry: prepared.capabilityBaseline.entry,
			bytes
		};
	}
	const content = prepared.skillContent;
	if (content === void 0) return result;
	const directory = `${sandbox}/skills/${content.name}`;
	const skillMd = await readVerifiedFile(root, `${directory}/SKILL.md`);
	const skillMdDigest = createHash("sha256").update(skillMd).digest("hex");
	if (skillMdDigest !== content.sha256) throw refusal$1("capability-skill-drifted", `the new skill's "${directory}/SKILL.md" no longer matches the identity prepare recorded (sha256 ${skillMdDigest} != ${content.sha256}) — propose a new candidate and re-evaluate it`);
	if (content.contract === void 0) throw refusal$1("capability-skill-drifted", `the prepared identity of the new skill "${content.name}" records no declaration, and a capability candidate's skill is an execution provider with its SKILL.contract.json beside it — the object prepare froze is not one this build writes`);
	const sidecarBytes = await readVerifiedFile(root, `${directory}/${SKILL_SIDECAR_FILE}`);
	const sidecarDigest = createHash("sha256").update(sidecarBytes).digest("hex");
	if (sidecarDigest !== content.contract.sha256) throw refusal$1("capability-skill-drifted", `the new skill's "${directory}/${SKILL_SIDECAR_FILE}" no longer matches the identity prepare recorded (sha256 ${sidecarDigest} != ${content.contract.sha256}) — propose a new candidate and re-evaluate it`);
	const sidecar = JSON.parse(sidecarBytes.toString("utf8"));
	const defects = skillContractDefects(sidecar);
	if (defects.length > 0) throw refusal$1("skill-sidecar-invalid", `the frozen declaration of the new skill "${content.name}" is not one this build reads — ${defects.map((defect) => `${defect.code}: ${defect.reason}`).join("; ")}`);
	return {
		...result,
		skill: {
			name: content.name,
			content: skillMd.toString("utf8"),
			sidecar,
			skillMd,
			sidecarBytes
		},
		skillRoot: join(root, sandbox, "skills"),
		skillDirectory: join(root, directory)
	};
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
* bytes are durable beside the target but have not replaced it. It is awaited,
* so a caller can make the last observation of the *target* here, after every
* seam of its own: the capability table's write re-reads the file and re-checks
* the whole-file identity in exactly this hook (A6, EVO-2 P2), because after it
* there is no seam left before the rename — and a rename is an unconditional
* replace, so a check that is not the last thing to observe the file is a check
* a third party's write can slip past. A failure before the rename — that hook
* included — removes the temp file and throws: a failed write leaves no
* half-installed version behind, the target keeps exactly the bytes it had, and
* the caller's intent stays open. A failure of the directory fsync *after* the
* rename is the one failure that leaves the target replaced with the durability
* of the rename unknown: it throws by name, the intent stays open and no
* completion is recorded, because a rename whose directory entry is not durable
* is not a settled commit.
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
		await onStaged?.();
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
* then the intent line is appended, then the production writes with their
* read-back verification, then the whole-object verification, then the
* completion that closes the intent. `bytes` are the already-verified bytes the
* caller read through its own identity checks (P2 for a candidate, the champion
* digests for a rollback), one entry per file of the request and in the same
* order; each digest must be that file's `contentSha256`, so what the intent
* promises and what the writes install cannot disagree — for either file of a
* two-file object. A file the direction removes has no bytes to write again and
* takes `undefined` in that slot.
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
* own durable append, so the line is on disk before production moves — and, once
* the line is recorded and before the first write, the capability table the row
* would be written into is re-read through {@link CommitHost.tableWriteRefusal}:
* it must still hold a state the direction's prepare froze (or the file this
* direction's own write leaves, so a retry settles), and a table a third party
* moved stops the commit with the intent open and production untouched — instead
* of being discovered once the files and the row had already moved. Only after
* every write has been read back and verified, the capability row is in place (a
* capability commit, A6) and the whole object has passed
* {@link CommitHost.verifyCommitted}, is the completion appended.
*
* The order of the two halves is the direction's, and it is the one that leaves
* nothing usable half-made: an **apply** writes the files first and moves the
* registry row last, so a provider whose files were written but whose row never
* landed is granted by nothing; a **rollback** moves the row first (reverting or
* removing the grant) and removes the files after it, so a skill whose row is
* already gone is unreachable while its files are still being removed. Either
* interruption leaves the intent open and the deployment's registry untouched by
* any later stage — reconciliation settles it, never a second path.
*
* A throw from any stage leaves the intent open and is the caller's to report:
* the intent is the record of what was underway, and reconciliation — not a
* second guess — is what settles it.
*/
async function commitIntent(host, request, bytes) {
	if (request.files.length === 0 && request.capability === void 0) throw new Error(`evolution: the ${request.direction} for proposal "${request.proposalId}" names nothing to commit — a commit replaces the fixed file set of one skill object (SKILL.md, and SKILL.contract.json when the object carries an execution sidecar) and/or moves exactly one capability row, so a request with nothing in it records nothing and writes nothing`);
	if (bytes.length !== request.files.length) throw new Error(`evolution: the ${request.direction} for proposal "${request.proposalId}" carries ${bytes.length} file(s) of verified bytes for ${request.files.length} target file(s) — the bytes and the intent's files are the same list in the same order, so a mismatch stops by name with nothing written`);
	request.files.forEach((file, index) => {
		const provided = bytes[index];
		if (file.contentSha256 === null) {
			if (provided !== void 0) throw new Error(`evolution: the ${request.direction} for proposal "${request.proposalId}" carries bytes for "${file.target}" while its intent records that this direction removes the file — a removal writes nothing, so the bytes and the record disagree: nothing was written`);
			return;
		}
		const digest = provided === void 0 ? void 0 : sha256Hex(provided);
		if (digest !== file.contentSha256) throw new Error(`evolution: the bytes this ${request.direction} would write to "${file.target}" hash to sha256 ${digest ?? "(none provided)"}, not the content identity ${file.contentSha256} its commit records — nothing was written`);
	});
	const targets = request.files.map((file) => productionRelative(host, file.target));
	const sources = request.files.map((file) => file.source === void 0 ? void 0 : ledgerRelative(host, request, file.source));
	for (const file of request.files) {
		if (file.source === void 0) continue;
		try {
			await host.readSource(file.source, file.contentSha256);
		} catch (error) {
			throw new Error(`evolution: the recoverable source "${file.source}" of the ${request.direction} for proposal "${request.proposalId}" does not hold the bytes its commit recorded (${error instanceof Error ? error.message : String(error)}) — the source an intent names must be re-verifiable before the intent is recorded, so the commit stops by name: no line is recorded and nothing is written`);
		}
	}
	if (request.capability !== void 0 && request.capability.source !== void 0) await assertCapabilitySource(host, request, request.capability);
	for (const [index, file] of request.files.entries()) {
		if (file.source === void 0) continue;
		await syncSource(host, request, file, sources[index]);
	}
	if (request.capability !== void 0 && request.capability.source !== void 0) await syncSourceRelative(host, request, request.capability.source, `capability row "${request.capability.name}"`);
	const intent = {
		intentId: `${request.proposalId}/${request.direction}`,
		proposalId: request.proposalId,
		direction: request.direction,
		approvalRef: request.approvalRef,
		files: request.files.map((file) => ({ ...file })),
		...request.capability === void 0 ? {} : { capability: { ...request.capability } },
		actor: request.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	const refusal$2 = await host.objectWriteRefusal(intent);
	if (refusal$2 !== null) throw new Error(`evolution: the ${request.direction} of proposal "${request.proposalId}" cannot write the skill object "${dirname(intent.files[0].target)}" — ${refusal$2}; a commit replaces one complete object and nothing beside it, so the commit stops by name: nothing was written and no commit intent was recorded`);
	await host.append({
		formatVersion: 4,
		kind: "commit_intent",
		...intent
	});
	host.probe("intent-recorded");
	const tableRefusal = await host.tableWriteRefusal(intent);
	if (tableRefusal !== null) throw new Error(`evolution: ${tableRefusal}; nothing was written for the ${request.direction} of proposal "${request.proposalId}", its commit intent "${intent.intentId}" is recorded and stays open and no completion is recorded, so the table keeps exactly the bytes it holds now and the row this commit was to install is not in it`);
	await installDirection(host, intent, bytes, targets);
	await host.verifyCommitted(intent);
	host.probe("commit-verified");
	await appendCompletion(host, intent);
}
/**
* Settle one open intent against the filesystem and the registry, or stop by
* name: re-read every one of the intent's own recoverable sources (every file's,
* and the capability row's when it has one) and verify it still hashes to what
* the intent committed; read every production file again and classify it as the
* pre-commit state, the committed content, absent or something else; read the
* registry row and classify it the same three ways — a source that is gone or
* changed, or a file or row that is missing or foreign, stops by name right
* there, in its own words — then ask
* {@link CommitHost.objectWriteRefusal} what the *directory* holds beyond the
* files the intent names, and {@link CommitHost.tableWriteRefusal} whether the
* capability table a row would be written into still reads as a state the prepare
* froze. If nothing refused, then
*
* - nothing has moved yet (every file still holds its baseline, the row its
*   baseline): the same operation is carried out — an apply writes the files and
*   then installs the row, a rollback reverts the row and then removes the files
*   — and the completion recorded (`completed-redone`);
* - the halves are mixed (a process that died between them): the side that did
*   not land is carried out, and the side that did has its durability
*   re-established; the completion is recorded only once
*   {@link CommitHost.verifyCommitted} confirms the whole state
*   (`completed-redone`);
* - everything already holds `contentSha256` — the writes landed but their
*   completion did not — so each target's staging leftovers are swept, each
*   production directory is fsynced, and then only the completion is recorded,
*   with production's bytes and the registry's row left exactly as they are
*   (`completed-written`);
* - a file that is missing where the intent expects a state, a file or row
*   holding neither digest, or a source that is gone or changed — a `blocked`
*   outcome naming the intent, the target and what was actually found, with
*   nothing written and the intent left open;
* - the directory holding an entry the intent does not name — the object check
*   above — a `blocked` outcome naming the entry, with nothing written: a
*   recovery settles an intent over the object it commits, never over a
*   directory a third party turned into something else;
* - the capability table a row would be written into reading as neither the
*   state the direction starts from nor the state its own write leaves (A6,
*   {@link CommitHost.tableWriteRefusal}) — a `blocked` outcome naming the file,
*   the row and the digests, with nothing written: the row is a capability
*   commit's last step, so a table a third party moved stops the recovery before
*   it redoes the files or the registry row, and before a settlement whose only
*   remaining step is that write records anything.
*
* The `completed-written` branch still fsyncs the production directories, even
* though it writes no bytes: the completion is the claim that production holds
* the committed content *durably*, and a rename (or a removal) is durable only
* once the directory that holds it is fsynced. A rename whose directory fsync
* failed when its commit ran (or a process that died before it) left production
* on the new bytes with that durability unestablished — so recording the
* completion without re-establishing it would be exactly the "completion
* recorded for a write that may be lost" state the commit order exists to
* prevent, and nothing would ever reconcile it again, because the completion
* closes the intent. The same branch sweeps each target's own staging leftovers,
* so the invariant is total: settling an intent leaves no staging file of that
* object behind, whichever branch settled it. The deliberate consequence: on a
* filesystem whose production directory cannot be fsynced, a recovery stops by
* name — the completion is not recorded and the intent stays open — instead of
* recording a completion it cannot stand behind.
*
* Every branch that records a completion calls
* {@link CommitHost.verifyCommitted} first: a state a recovery finished must load
* as one object carrying this direction's identity, and read as the row this
* direction installed, before the ledger may say the commit is settled, exactly
* as a fresh commit must.
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
	for (const file of intent.files) {
		if (file.source === void 0) {
			bytes.push(void 0);
			continue;
		}
		try {
			bytes.push(await host.readSource(file.source, file.contentSha256));
		} catch (error) {
			return outcome("blocked", `evolution: the recoverable source "${file.source}" of commit intent "${intent.intentId}" for the file "${file.target}" is no longer readable as the bytes it committed (${error instanceof Error ? error.message : String(error)}) — the source bytes cannot be re-verified under ${host.root}, so the commit stops by name and the intent stays open; nothing was written`);
		}
	}
	let rowEntry = null;
	if (intent.capability !== void 0 && intent.capability.contentSha256 !== null) try {
		rowEntry = await committedRow(host, intent.capability);
	} catch (error) {
		return outcome("blocked", `evolution: the capability row "${intent.capability.name}" of commit intent "${intent.intentId}" cannot be re-read from its recoverable bytes (${error instanceof Error ? error.message : String(error)}) — the row cannot be re-verified, so the commit stops by name and the intent stays open; nothing was written`);
	}
	let rowState = intent.capability === void 0 ? "content" : "baseline";
	if (intent.capability !== void 0) {
		const seen = await currentCapabilityRow(host, intent);
		if (seen === void 0) rowState = "unreadable";
		else rowState = seen.digest === intent.capability.baselineSha256 ? "baseline" : seen.digest === intent.capability.contentSha256 ? "content" : "other";
	}
	if (rowState === "unreadable") return outcome("blocked", `evolution: the capability registry cannot be read for the row "${intent.capability.name}" of commit intent "${intent.intentId}" — whether the row the intent records is in place cannot be established, so the commit stops by name and the intent stays open; nothing was written`);
	if (rowState === "other") return outcome("blocked", `evolution: the capability registry row "${intent.capability.name}" of commit intent "${intent.intentId}" reads as neither the row recorded before the commit (sha256 ${intent.capability.baselineSha256 ?? "absent"}) nor the row it committed (sha256 ${intent.capability.contentSha256 ?? "absent"}) — a third party changed it, so the commit stops by name and the intent stays open; nothing is overwritten and the completion is never recorded`);
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
		digests.push(current?.sha256 ?? "absent");
		const digest = current?.sha256 ?? null;
		states.push(digest === file.baselineSha256 ? "baseline" : digest === file.contentSha256 ? "content" : "other");
	}
	const foreign = intent.files.findIndex((_file, index) => states[index] === "other");
	if (foreign >= 0) {
		const file = intent.files[foreign];
		const absent = digests[foreign] === "absent";
		return outcome("blocked", `evolution: the production file "${file.target}" of commit intent "${intent.intentId}" ${absent ? "is missing" : `holds sha256 ${digests[foreign]}`} — it holds neither the state before the commit (${file.baselineSha256 === null ? "absent" : `sha256 ${file.baselineSha256}`}) nor the state it committed (${file.contentSha256 === null ? "absent" : `sha256 ${file.contentSha256}`}); a third party ${absent ? "removed" : "changed"} it, so the commit stops by name and the intent stays open; nothing is ${absent ? "recreated" : "overwritten"} and the completion is never recorded`);
	}
	if (intent.files.length > 0) {
		const refusal$2 = await host.objectWriteRefusal(intent);
		if (refusal$2 !== null) return outcome("blocked", `evolution: the ${intent.direction} of proposal "${intent.proposalId}" cannot write the skill object "${dirname(intent.files[0].target)}" of commit intent "${intent.intentId}" — ${refusal$2}; a commit replaces one complete object and nothing beside it, so nothing is written and the intent stays open until a human settles what the directory holds`);
	}
	const tableRefusal = await host.tableWriteRefusal(intent);
	if (tableRefusal !== null) return outcome("blocked", `evolution: ${tableRefusal}; nothing was written for the ${intent.direction} of proposal "${intent.proposalId}" and commit intent "${intent.intentId}" stays open — a commit writes its row into that file only while it reads as a state the prepare froze, and a human settles the table (or restores it, and this recovery is run again)`);
	if (!(states.every((state) => state === "content") && rowState === "content")) {
		const writeFiles = async () => {
			for (const [index, file] of intent.files.entries()) {
				if (states[index] === "content") continue;
				await installFile(host, intent, file, relatives[index], bytes[index]);
			}
		};
		if (intent.direction === "apply") {
			await writeFiles();
			if (intent.capability !== void 0 && rowState !== "content") await installCapability(host, intent, rowEntry);
		} else {
			if (intent.capability !== void 0 && rowState !== "content") await installCapability(host, intent, rowEntry);
			await writeFiles();
		}
		for (const file of intent.files) {
			if (file.contentSha256 === null) continue;
			await sweepStaging(dirname(file.target), file.target);
			await syncTargetDirectory(host, intent, file.target);
		}
		await host.verifyCommitted(intent);
		host.probe("commit-verified");
		await appendCompletion(host, intent);
		return outcome("completed-redone");
	}
	for (const file of intent.files) {
		if (file.contentSha256 === null) continue;
		await sweepStaging(dirname(file.target), file.target);
	}
	for (const file of intent.files) await syncTargetDirectory(host, intent, file.target);
	await host.verifyCommitted(intent);
	host.probe("commit-verified");
	await appendCompletion(host, intent);
	return outcome("completed-written");
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
* Carry out one commit — a fresh one, or the half a redo found missing — in the
* direction's own order (see {@link commitIntent}): the **apply** direction
* writes the files and installs the capability row after them; the **rollback**
* direction moves the row first and removes or restores the files after it. The
* order is what makes any interruption leave nothing usable half-made: a
* provider whose files exist but whose row never landed is granted by nothing,
* and a skill whose row is already gone is unreachable while its files are still
* being removed.
*
* `relativeTargets` are the targets' paths under the skill root, already confined
* by the caller. `bytes` may carry an entry per file — `undefined` exactly for a
* file this direction removes, which is written as a removal rather than a
* rename.
*/
async function installDirection(host, intent, bytes, relativeTargets) {
	const files = async () => {
		for (const [index, file] of intent.files.entries()) await installFile(host, intent, file, relativeTargets[index], bytes[index]);
	};
	const row = async () => {
		if (intent.capability === void 0) return;
		await installCapability(host, intent, intent.capability.contentSha256 === null ? null : await committedRow(host, intent.capability));
	};
	if (intent.direction === "apply") {
		await files();
		await row();
		return;
	}
	await row();
	await files();
}
/**
* One file of one commit: an atomic replace and its read-back when the direction
* writes it, a removal and its read-back when the direction ends without it. The
* read-back is not a formality — it is what makes "the write happened" and
* "production carries this state" the same fact, so a completion is never
* recorded over a state the commit did not install.
*/
async function installFile(host, intent, file, relativeTarget, bytes) {
	if (file.contentSha256 === null) {
		await removeFile(host, intent, file.target);
		return;
	}
	if (bytes === void 0) throw new Error(`evolution: the ${intent.direction} of proposal "${intent.proposalId}" reaches "${file.target}" with no bytes to install while its intent records content — nothing was written`);
	await writeFileAtomic(file.target, bytes, () => host.probe("write-staged", file.target));
	const readback = await host.readProduction(relativeTarget);
	if (readback === null || readback.sha256 !== file.contentSha256) throw new Error(`evolution: the production file "${file.target}" does not hold the committed content after the atomic replace (sha256 ${readback?.sha256 ?? "missing"} != ${file.contentSha256}) — the intent stays open and a reconciliation reports what production actually carries by name`);
	host.probe("write-renamed", file.target);
}
/**
* Remove one production file this direction ends without — only ever a file the
* candidate itself created, because a file that existed before it is *replaced*
* by the apply and *restored* by the rollback, never deleted — together with the
* directory the candidate created for it when that directory is now empty: the
* baseline recorded nothing there, so production is left exactly as the baseline
* described it (a fresh skill object is a directory that does not exist). The
* directory fsync that follows is the removal's durability, and it lands on the
* skill root when the directory itself went with the file.
*/
async function removeFile(host, intent, target) {
	const directory = dirname(target);
	try {
		await rm(target, { force: true });
	} catch (error) {
		throw new Error(`evolution: the production file "${target}" could not be removed for the ${intent.direction} of commit intent "${intent.intentId}" (${error instanceof Error ? error.message : String(error)}) — the intent stays open and the state must not be treated as settled`);
	}
	let directoryGone = false;
	if (directory !== host.skillRoot) directoryGone = await rmdir(directory).then(() => true, () => false);
	try {
		await syncDirectory(directoryGone ? dirname(directory) : directory);
	} catch (error) {
		throw new Error(`evolution: the directory "${directoryGone ? dirname(directory) : directory}" could not be fsynced after removing "${target}" for the ${intent.direction} of commit intent "${intent.intentId}" (${error instanceof Error ? error.message : String(error)}) — the removal may not be durable, so the completion is not recorded and the intent stays open`);
	}
	const readback = await host.readProduction(productionRelative(host, target));
	if (readback !== null) throw new Error(`evolution: the production file "${target}" still holds sha256 ${readback.sha256} after the ${intent.direction} of commit intent "${intent.intentId}" removed it — the intent stays open and a reconciliation reports what production actually carries by name`);
}
/**
* Install (or remove) the one capability row a commit carries, once the registry
* still reads as the intent recorded. The baseline check is the registry's own
* half of the object check a file commit gets from
* {@link CommitHost.objectWriteRefusal}: a row a third party moved between the
* decision and this write is refused by name with nothing written, and an intent
* whose row already sits at its content state is not written a second time.
*/
async function installCapability(host, intent, entry) {
	const capability = intent.capability;
	const seam = host.capability;
	if (seam === void 0) throw new Error(`evolution: the ${intent.direction} of proposal "${intent.proposalId}" carries capability row "${capability.name}" and this host offers no registry seam to move it — the row cannot be installed, so the commit stops by name with nothing recorded as applied`);
	const seen = await currentCapabilityRow(host, intent);
	if (seen === void 0) throw new Error(`evolution: the capability registry cannot be read for the row "${capability.name}" of the ${intent.direction} of proposal "${intent.proposalId}" — the row this commit would move cannot be compared against the one its intent recorded, so nothing was written`);
	if (seen.digest !== capability.baselineSha256) throw new Error(`evolution: the capability registry row "${capability.name}" of the ${intent.direction} of proposal "${intent.proposalId}" reads ${seen.digest === null ? "no row at all" : `as ${seen.digest}`}, not the state before the commit (${capability.baselineSha256 ?? "no row"}) — a third party moved it, so nothing was written and no completion is recorded; create a new candidate from the current registry state and re-evaluate it`);
	try {
		await seam.apply(intent, entry);
	} catch (error) {
		throw new Error(`evolution: the capability registry row "${capability.name}" of the ${intent.direction} of proposal "${intent.proposalId}" could not be written (${error instanceof Error ? error.message : String(error)}) — nothing was recorded as applied and the commit intent stays open, because the provider this commit installs is not the one the deployment would resolve`);
	}
	const after = await currentCapabilityRow(host, intent);
	if (after === void 0 || after.digest !== capability.contentSha256) throw new Error(`evolution: the capability registry row "${capability.name}" does not read as the row this ${intent.direction} committed after the write (${after?.digest === void 0 || after.digest === null ? "no row" : after.digest} != ${capability.contentSha256 ?? "no row"}) — the completion is not recorded and the intent stays open`);
}
/**
* The registry row a commit's own recoverable bytes hold, parsed and verified
* against the digest the intent recorded. Exported because the capability
* table's own text is written from the same read (A6,
* `EvolutionService.verifyCommitted`): one parse, one digest check, so the file
* and the registry can never disagree about what the commit installed.
*/
async function committedRow(host, capability) {
	const source = capability.source;
	if (source === void 0) throw new Error(`the capability row "${capability.name}" is recorded with content ${capability.contentSha256} and no recoverable source — the row cannot be read back, and an intent must name the bytes a recovery would write again`);
	const bytes = await host.readSource(source, capability.contentSha256);
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new Error(`the capability row source "${source}" is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	const entry = parsed;
	if (capabilityRowDigest(entry) !== capability.contentSha256) throw new Error(`the capability row source "${source}" holds a row that hashes to ${capabilityRowDigest(entry)}, not the ${capability.contentSha256} its commit recorded — a row whose bytes and identity disagree is not one this commit may install`);
	return entry;
}
/** The registry row as it reads now, digested — `{ digest: null }` for a name the registry does not hold, `undefined` when it cannot be read. */
async function currentCapabilityRow(host, intent) {
	const capability = intent.capability;
	if (capability === void 0) return void 0;
	const seam = host.capability;
	if (seam === void 0) return void 0;
	try {
		const entry = await seam.read(capability.name);
		return { digest: entry === null ? null : capabilityRowDigest(entry) };
	} catch {
		return;
	}
}
/** Read and verify a capability row's recoverable bytes before the intent that names them is recorded. */
async function assertCapabilitySource(host, request, capability) {
	try {
		await committedRow(host, capability);
	} catch (error) {
		throw new Error(`evolution: the recoverable source "${capability.source}" of the capability row "${capability.name}" in the ${request.direction} for proposal "${request.proposalId}" does not hold the row its commit recorded (${error instanceof Error ? error.message : String(error)}) — the source an intent names must be re-verifiable before the intent is recorded, so the commit stops by name: no line is recorded and nothing is written`);
	}
}
/**
* Close one intent: the completion line, written for the intent's own grant and
* its whole file set — its `approvalRef`, every `target` the intent committed in
* intent order (empty for a row-only capability commit, whose row is named by the
* intent line directly above it), and its actor, so a completion can never
* describe a second approval or a second path. The fold refuses a completion with
* no matching open intent, which is what makes a repeat (a retry, a restart, a
* double reconciliation) cost nothing: the second line has nothing to close.
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
function ledgerRelative(host, request, source) {
	const rel = relative(host.root, resolve(host.root, source));
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`evolution: the recoverable source "${source}" of the ${request.direction} for proposal "${request.proposalId}" is not inside the ledger root ${host.root} — a commit names the bytes it could write again from under that root and nothing else, so it stops by name before the intent is recorded and nothing is written`);
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
	await syncSourceRelative(host, request, sourceRelative, `"${file.source}"`);
}
/**
* The same durability rule for any source a commit names — a file's bytes, or
* the capability row's bytes — so both halves of a capability commit are durable
* before the one line that names them.
*/
async function syncSourceRelative(host, request, sourceRelative, label) {
	const source = resolve(host.root, sourceRelative);
	let handle;
	try {
		handle = await open(source, "r");
		await handle.sync();
	} catch (error) {
		throw new Error(`evolution: the recoverable source ${label} of the ${request.direction} for proposal "${request.proposalId}" could not be fsynced at "${source}" (${error instanceof Error ? error.message : String(error)}) — the source must be durable, bytes and path, before the intent that names it is recorded, so the commit stops by name: no line is recorded and nothing is written`);
	} finally {
		await handle?.close().catch(() => {});
	}
	for (const directory of sourceDirectories(host.root, source)) try {
		await syncDirectory(directory);
	} catch (error) {
		throw new Error(`evolution: the directory "${directory}" holding the recoverable source ${label} of the ${request.direction} for proposal "${request.proposalId}" could not be fsynced (${error instanceof Error ? error.message : String(error)}) — the source must be durable, bytes and path, before the intent that names it is recorded, so the commit stops by name: no line is recorded and nothing is written`);
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
//#region src/capability-config.ts
function asLines(text) {
	const trailingNewline = text.endsWith("\n");
	return {
		lines: text.split("\n"),
		trailingNewline
	};
}
/** The indentation of a line, or `-1` for a blank one (`\t` is refused by the callers that care). */
function indentOf(line) {
	if (line.trim().length === 0) return -1;
	return line.length - line.trimStart().length;
}
/** One refusal of this module, naming the file and never quoting it. */
function refusal(file, detail) {
	return /* @__PURE__ */ new Error(`evolution: the capability table "${file}" cannot be edited: ${detail}`);
}
/** The refusal a table that is not a frozen state is reported by (EVO-2 内容漂移), naming the file and never quoting it. */
function tableChanged(file, detail) {
	return /* @__PURE__ */ new Error(`evolution: capability-table-changed: the capability table "${file}" cannot be edited: ${detail}`);
}
/** The `- id: task-runtime` entry's `capabilities:` block inside the first YAML document. */
function capabilitiesBlock(lines, file) {
	const separator = lines.findIndex((line) => line.trim() === "---");
	const first = separator < 0 ? lines.length : separator;
	let header = -1;
	for (let index = 0; index < first; index += 1) {
		const line = lines[index];
		if (!/^- id:\s*task-runtime\s*$/.test(line)) continue;
		let end = first;
		for (let next = index + 1; next < first; next += 1) if (/^- /.test(lines[next])) {
			end = next;
			break;
		}
		for (let cursor = index + 1; cursor < end; cursor += 1) {
			if (/^\s*capabilities:\s*$/.test(lines[cursor])) {
				header = cursor;
				break;
			}
			if (/^\s*capabilities:\s*\S/.test(lines[cursor])) throw refusal(file, "the task-runtime entry declares `capabilities:` inline, and this writer edits a block mapping (nothing was written)");
		}
		if (header >= 0) {
			const indent = indentOf(lines[header]);
			let to = header + 1;
			for (; to < end; to += 1) {
				const line$1 = lines[to];
				if (indentOf(line$1) <= indent && line$1.trim().length > 0) break;
			}
			return {
				header,
				indent,
				from: header + 1,
				to
			};
		}
		throw refusal(file, "its task-runtime entry declares no `capabilities:` mapping, so the row this commit moves has nowhere to be written (nothing was written)");
	}
	throw refusal(file, "it holds no `- id: task-runtime` entry in its first document, so the capability table this deployment loads cannot be located (nothing was written)");
}
/**
* The row one name maps to inside the file, or `undefined` when the file holds no
* such row — its region (where to replace it) and the exact text it currently
* holds (what a reader may compare, never print).
*/
function capabilityRowRegion(text, file, name) {
	const { lines } = asLines(text);
	const block = capabilitiesBlock(lines, file);
	const rowPattern = /* @__PURE__ */ new RegExp(`^\\s*("?)([^:\\s][^:]*?)\\1:\\s*`);
	let insertAt = block.to;
	let indent;
	for (let index = block.from; index < block.to; index += 1) {
		const line = lines[index];
		const match = rowPattern.exec(line);
		if (match === null) continue;
		const rowIndent = line.slice(0, indentOf(line));
		if (indent === void 0 && indentOf(line) > block.indent) indent = rowIndent;
		if (rowIndent !== indent) continue;
		const rowName = match[2];
		if (rowName !== name) continue;
		let end = index + 1;
		while (end < block.to && indentOf(lines[end]) > indentOf(line)) end += 1;
		return {
			name: rowName,
			start: index,
			end,
			indent: rowIndent,
			insertAt: block.to
		};
	}
	return {
		name,
		start: block.to,
		end: block.to,
		indent: indent ?? " ".repeat(block.indent + 4),
		insertAt
	};
}
/** The row region's own text, as the file spells it right now. */
function capabilityRowText(text, file, name) {
	const { lines } = asLines(text);
	const region = capabilityRowRegion(text, file, name);
	if (region === void 0 || region.start === region.end) return null;
	return lines.slice(region.start, region.end).join("\n");
}
/**
* The one line this module writes for one row: `<indent>"<name>": <canonical json>`
* — a YAML flow mapping whose value is JSON, which is a YAML scalar, and whose
* key is quoted so a name with a colon or a space is still one key.
*/
function renderCapabilityRow(name, entry, indent) {
	return `${indent}${JSON.stringify(name)}: ${canonicalJson(entry)}`;
}
/**
* The file's text with one row written, removed, or added. Pure: the caller
* decides what the file's current state may be (the commit's own frozen-identity
* check) and this function only edits the one region.
*
* `entry === null` removes the row; a row the file does not hold is *added* at
* the end of the capabilities block.
*/
function applyCapabilityRowToConfig(input) {
	const { text, file, name, entry } = input;
	const { lines, trailingNewline } = asLines(text);
	const region = capabilityRowRegion(text, file, name);
	if (region === void 0) throw refusal(file, "no capabilities block was found (nothing was written)");
	const rendered = entry === null ? void 0 : renderCapabilityRow(name, entry, region.indent);
	const before = lines.slice(0, region.start);
	const after = lines.slice(region.end);
	const body = entry === null ? [] : [rendered];
	const edited = [
		...before,
		...body,
		...after
	];
	return trailingNewline && edited[edited.length - 1] === "" ? edited.slice(0, -1).join("\n") + "\n" : edited.join("\n");
}
/**
* Freeze one table file's composed identity for one candidate (pure): the file as
* read, the file with this candidate's row written in, and the file with the row
* a rollback restores written in — or, for a row this candidate adds, the file
* the rollback leaves after removing that row. The rollback's text is computed
* from the text the *apply* leaves, which is the text the rollback really edits;
* a row the file already holds is restored in this writer's own rendering, so the
* rollback's file is not generally the file prepare read, and the identity says
* exactly which file it is.
*/
function capabilityTableIdentity(input) {
	const { text, file, name, entry, restored } = input;
	const digest = (value) => sha256Hex(Buffer.from(value, "utf8"));
	const applied = applyCapabilityRowToConfig({
		text,
		file,
		name,
		entry
	});
	return {
		baselineSha256: digest(text),
		applySha256: digest(applied),
		rollbackSha256: digest(applyCapabilityRowToConfig({
			text: applied,
			file,
			name,
			entry: restored
		}))
	};
}
/**
* The named reason one whole-file digest is not a state a capability write may
* find, or `null` when it is one of them: `states.beforeSha256`, the state this
* write starts from, or `states.afterSha256`, the state its own write leaves (so
* a retry after a crash finds its own result and still settles). Names the row and
* the digests it compared — never a line of the file, which carries the
* deployment's credentials; the caller names the file itself.
*/
function capabilityTableDrift(input) {
	const { name, seen, states } = input;
	if (seen === states.beforeSha256 || seen === states.afterSha256) return null;
	return `it reads sha256 ${seen}, which is neither the whole-file state this write starts from (sha256 ${states.beforeSha256}) nor the state its own write leaves (sha256 ${states.afterSha256}) — the row "${name}" is not written over a third party's move of the file, and the bytes that move left are exactly the bytes it keeps`;
}
/**
* The row one rendered or read line holds, parsed back from the scalar this module
* writes: the same parse serves the pre-write check and the read-back, so what the
* file holds is compared on one basis.
*/
function parsedRow(file, name, line) {
	const separator = line.indexOf(": ");
	if (separator < 0) throw refusal(file, `its row "${name}" carries no value on the same line (nothing was written)`);
	let parsed;
	try {
		parsed = JSON.parse(line.slice(separator + 2));
	} catch (error) {
		throw refusal(file, `its row "${name}" does not hold the json this writer reads rows as (${error instanceof Error ? error.message : String(error)}) — a row this build writes is \`"<name>": <canonical json>\`, and a row in another style is not one it will edit (nothing was written)`);
	}
	return assertCapabilityRow(`the row "${name}" of ${file}`, parsed);
}
/**
* Persist one capability row into the deployment's config file, or refuse by
* name.
*
* The order is the write's own: read the file, compute the edit and the region,
* verify the row text this module is about to leave *parses back as the row it
* was given* (its JSON scalar and its name), hand the probe its `before-write`
* stage, prove the file is still the text that edit was computed from **and** that
* this text is one of the two whole-file states `states` names (the state this
* write starts from, or the state its own write leaves), stage the bytes, hand
* the probe its `staged` stage, verify the file one last time (same two checks,
* asked of the file as it reads now), rename, re-read the file and prove (a) the
* row region is exactly the rendered text and (b) every other byte is what the
* read found. Anything that fails is a named stop with the file untouched —
* except a failure after the rename, which is `read back after the write` and
* leaves the file holding the row while the commit intent stays open (the next
* reconciliation re-runs the same edit, which is idempotent: it writes the same
* bytes again, and finds the file its own write left among the states it
* accepts).
*
* The checks before the write are the drift gate the commit path never had:
* without them this writer carried a *stale* read — of the row's own bytes and of
* every other byte of the file — over whatever a third party wrote in the
* meantime. The state comparisons run after each probe stage, so a write made at
* a seam is refused as well; they are asked of the file's bytes, never of a
* parsed row, because the deployment's file is not this writer's to reformat.
*
* **The `staged` check is the last observation of the file before the rename,
* and that is a requirement, not an implementation detail** (EVO-2 P2): POSIX
* rename replaces the target unconditionally, so a third party's write that
* lands after the last read and before the rename would be silently overwritten.
* `writeFileAtomic` fires its hook between the staging file's fsync and the
* rename, and the re-read and the whole-file comparison run inside that hook —
* there is no injectable seam left after them. A file that changed under the
* staged bytes is `capability-table-changed`, the staging file is removed and the
* target keeps exactly the third party's bytes.
*/
async function writeCapabilityRowToConfig(input) {
	const { file, name, entry, states, probe } = input;
	let current;
	try {
		current = await readFile(file, "utf8");
	} catch (error) {
		throw refusal(file, `it cannot be read (${error instanceof Error ? error.message : String(error)}) — nothing was written`);
	}
	const region = capabilityRowRegion(current, file, name);
	if (region === void 0) throw refusal(file, "no capabilities block was found (nothing was written)");
	const rendered = entry === null ? void 0 : renderCapabilityRow(name, entry, region.indent);
	if (rendered !== void 0) {
		const parsed = parsedRow(file, name, rendered);
		if (capabilityRowDigest(parsed) !== capabilityRowDigest(entry)) throw refusal(file, `the row "${name}" cannot be rendered without changing it (the text reads back as ${capabilityRowDigest(parsed)}, not as ${capabilityRowDigest(entry)}); nothing was written`);
	}
	const next = applyCapabilityRowToConfig({
		text: current,
		file,
		name,
		entry
	});
	probe?.("before-write", name);
	let reread;
	try {
		reread = await readFile(file, "utf8");
	} catch (error) {
		throw refusal(file, `it could not be read again before the write (${error instanceof Error ? error.message : String(error)}) — nothing was written`);
	}
	if (reread !== current) throw tableChanged(file, `it changed between the read this write's edit was computed from and the write itself — the write that landed in that window is not one this commit may carry over, so the row "${name}" was not written into it and the file is left exactly as that write left it`);
	const drift = capabilityTableDrift({
		name,
		seen: sha256Hex(Buffer.from(reread, "utf8")),
		states
	});
	if (drift !== null) throw tableChanged(file, `${drift}; nothing was written`);
	const verifyStaged = async () => {
		probe?.("staged", name);
		let staged;
		try {
			staged = await readFile(file, "utf8");
		} catch (error) {
			throw refusal(file, `it could not be read again immediately before the rename (${error instanceof Error ? error.message : String(error)}) — nothing was written, and the staged bytes of the row "${name}" are removed`);
		}
		const changed = capabilityTableDrift({
			name,
			seen: sha256Hex(Buffer.from(staged, "utf8")),
			states
		});
		if (changed !== null) throw tableChanged(file, `${changed}; the write that landed in the window between this edit and the rename is not one this commit may carry over, so the staged bytes of the row "${name}" were removed and the file keeps exactly what that write left`);
	};
	await writeFileAtomic(file, Buffer.from(next, "utf8"), verifyStaged);
	probe?.("written", name);
	let back;
	try {
		back = await readFile(file, "utf8");
	} catch (error) {
		throw refusal(file, `it could not be read back after the write (${error instanceof Error ? error.message : String(error)}) — the row may be written, so the commit intent stays open and the next reconciliation re-runs the same edit`);
	}
	if (back !== next) throw refusal(file, "it changed between the write and the read back — the row may be written, so the commit intent stays open and no completion is recorded");
	const written = capabilityRowText(back, file, name);
	if (entry === null) {
		if (written !== null) throw refusal(file, `the row "${name}" is still there after removing it — the commit is not settled`);
		return {
			file,
			name,
			direction: "removed",
			rowDigest: null,
			textDigest: null
		};
	}
	const expected = renderCapabilityRow(name, entry, region.indent);
	if (written !== expected) throw refusal(file, `the row "${name}" does not read back as the text this write left — the commit is not settled`);
	return {
		file,
		name,
		direction: "written",
		rowDigest: capabilityRowDigest(parsedRow(file, name, written)),
		textDigest: sha256Hex(Buffer.from(expected, "utf8"))
	};
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
* The idempotency key's content member (K3, A6): the digest of the candidate's
* **complete** content identity — {@link digestOf} of the identity `prepare`
* recorded, so the name, the `SKILL.md` bytes and, when the object has an
* execution sidecar, the sidecar's exact bytes and canonical declaration are all
* part of the key. Two candidates that differ in any of them are two objects,
* and a key spent on one is never reused for the other.
*
* A capability candidate's identity is the **capability** block (the row it
* installs, the row it moves and the gap it came from) together with the new
* skill object when it carries one — the row alone would let two candidates
* that differ only in their skill bytes share a key, and the skill alone would
* let two rows share one.
*/
function preparedContentDigestOf(frozen) {
	if (frozen.capability !== void 0) return digestOf({
		capability: frozen.capability,
		...frozen.candidate === void 0 ? {} : { candidate: frozen.candidate }
	});
	if (frozen.candidate === void 0) throw new Error("experiment: a frozen block with neither a candidate object nor a capability candidate has no identity to key a sample by");
	return digestOf(frozen.candidate);
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
* The proposal this experiment may evaluate, and the candidate identity it runs
* against. Two candidate kinds have an evaluator in this build (A6):
*
* - a **skill** candidate replaces an existing skill object's bytes; the
*   candidate's files are re-verified here (P2) before anything runs — the
*   `SKILL.md` alone for guidance, both files when the object carries an
*   execution sidecar;
* - a **capability** candidate installs one whole capability row and may carry
*   one new execution skill; its frozen row, champion row and skill files are
*   re-read and re-verified the same way (`readPreparedCapability`), and the
*   overlay the candidate side runs under is read off that verified record
*   (`capabilityOverlay`), so the evaluation mounts exactly what a commit would
*   install.
*
* Every other target type has no evaluator: a record of one is never upgraded
* into evidence.
*/
async function experimentCandidate(sources, proposalId) {
	const proposal = await sources.evolution.get(proposalId);
	if (proposal.targetType !== "skill" && proposal.targetType !== "capability") throw new Error(`proposal ${proposalId} targets "${proposal.targetType}"; the two-sided experiment evaluates a skill candidate or a capability candidate (A6) only`);
	if (proposal.status !== "prepared") throw new Error(`proposal ${proposalId} is ${proposal.status}; only a prepared proposal can be evaluated`);
	const prepared = proposal.prepared;
	if (prepared === void 0 || prepared.sandbox === null || !prepared.mechanical) throw new Error(`proposal ${proposalId} has no materialized candidate; prepare it before evaluating it`);
	if (proposal.targetType === "capability") {
		if (prepared.capabilityRow === void 0) throw new Error(`proposal ${proposalId} carries no frozen capability row — a capability prepare records the row it installs and the row it moves, so a proposal without them has nothing this experiment could compare`);
		const verified = await sources.evolution.readCapabilityCandidate(proposalId);
		const identity = capabilityRowIdentity(verified.row);
		if (identity.digest !== prepared.capabilityRow.digest || identity.name !== prepared.capabilityRow.name) throw new Error(`proposal ${proposalId} prepared capability row "${prepared.capabilityRow.name}" (${prepared.capabilityRow.digest}), but the sandbox holds row "${identity.name}" (${identity.digest}) — the two must be the same row before anything runs`);
		const baselineRow = verified.baseline === void 0 ? null : capabilityRowIdentity({
			name: prepared.capabilityRow.name,
			entry: verified.baseline.entry
		});
		const recordedBaseline = prepared.capabilityBaseline ?? null;
		const baseline = recordedBaseline === null ? null : {
			name: recordedBaseline.name,
			entry: recordedBaseline.entry,
			digest: recordedBaseline.digest
		};
		if (baselineRow === null !== (baseline === null) || baselineRow !== null && baseline !== null && baselineRow.digest !== baseline.digest) throw new Error(`proposal ${proposalId} records capability baseline ${baseline?.digest ?? "no row"}, but the sandbox holds ${baselineRow?.digest ?? "none"} — the row this candidate moves cannot be re-proved, so nothing runs under it`);
		return {
			proposal,
			sandbox: prepared.sandbox,
			capability: {
				row: {
					name: prepared.capabilityRow.name,
					entry: verified.row.entry,
					digest: prepared.capabilityRow.digest
				},
				baseline,
				sourceRefs: [...proposal.sourceRefs]
			},
			...prepared.skillContent === void 0 ? {} : { candidate: prepared.skillContent },
			overlay: capabilityOverlay(proposal, { root: sources.evolution.root })
		};
	}
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
/** One frozen side identity built from one pre-check's verdicts, refusing a deployment whose providers are unusable or whose roles are unknown. */
function frozenCapabilitySideOf(input) {
	const { precheck, table, rows, where } = input;
	const refused = refusedProviderLines(precheck);
	if (refused.length > 0) throw new Error(`${where} resolves to providers the deployment cannot use:\n- ${refused.join("\n- ")}`);
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
	const declaredPresets = new Set(rows.flatMap((row) => {
		const preset = table[row]?.preset;
		return preset === void 0 ? [] : [preset];
	}));
	if (declaredPresets.size > 1) throw new Error(`${where}'s rows declare conflicting presets (${[...declaredPresets].sort().join(", ")}); one worker requires one preset, so the runtime would refuse the replay — split the rows or align the presets before freezing the experiment`);
	return {
		capabilities: [...rows],
		registryRevision: precheck.revision,
		mcpServers: [...new Set(rows.flatMap((row) => table[row]?.mcpServers ?? []))].sort(),
		preset: declaredPresets.size === 0 ? null : [...declaredPresets][0],
		skills
	};
}
/** Every provider one pre-check refused, as a refusal line names it — the one rendering the freeze and the admission record share. */
function refusedProviderLines(precheck) {
	return precheck.capabilities.flatMap((row) => row.skills.filter((skill) => !skill.valid).map((skill) => `${row.capability}: skill "${skill.name}" (${(skill.defects ?? []).map((defect) => `${defect.code}: ${defect.detail}`).join("; ")})`));
}
/**
* What the two sides of one **capability** sample are frozen against (A6).
*
* The candidate side runs under the prepared overlay: the capability table the
* overlay produces (the effective table with the candidate's one row folded in)
* and the sandbox skill root in front of discovery. That configuration must
* admit every row the sample requires — a candidate that cannot run the sample
* it is supposed to fix is refused here, before the first run — and its provider
* identity is read through the runtime's own pre-check over exactly that table
* (`precheckCapabilityTable`), so the revision the side's run has to bind is the
* runtime's own conclusion, not a value this plane derives.
*
* The production side runs under the effective table as it stands. A row the
* table does not hold, or a provider the pre-check refuses, is **not** a refusal
* of the experiment: it is the gap the candidate is evaluated against, and it is
* recorded as that sample's frozen admission expectation
* ({@link FrozenSampleAdmission}) — the baseline side is `not-admitted`, no run
* exists for it and none is invented. A production side that resolves cleanly
* freezes the ordinary provider identity beside the overlay one.
*/
async function frozenCapabilitySample(input) {
	const { sources, caller, overlay, sampleTaskId } = input;
	const where = `sample "${sampleTaskId}"`;
	const table = sources.taskRuntime.listCapabilities?.();
	if (table === void 0) throw new Error(`${where} cannot fix the provider identities a capability experiment compares: this deployment's task runtime exposes no capability table (listCapabilities), so which rows, servers and skills each side resolves to is not knowable before it runs — the experiment is refused rather than run under identities nobody can compare against`);
	const rows = [...new Set(input.required)].sort();
	const overlayTable = {
		...table,
		...overlay.capabilityOverrides
	};
	const overlayManifest = resolveCapabilities(rows, overlayTable);
	if (overlayManifest.missing.length > 0) throw new Error(`${where} requires ${overlayManifest.missing.length > 1 ? "capabilities" : "capability"} [${overlayManifest.missing.join(", ")}], which the candidate overlay does not resolve — the candidate side could not run the case the candidate is evaluated on, so the experiment is refused before it runs`);
	if (sources.taskRuntime.precheckCapabilityTable === void 0) throw new Error(`${where} cannot fix the provider identity the candidate overlay produces: this deployment's task runtime exposes no capability pre-check over a table the caller names, so what the candidate side would load cannot be frozen before it runs`);
	const candidateProvider = frozenCapabilitySideOf({
		precheck: await sources.taskRuntime.precheckCapabilityTable({
			capabilities: rows,
			table: overlayTable,
			extraRoots: [...overlay.extraSkillRoots]
		}),
		table: overlayTable,
		rows,
		where: `${where} candidate side`
	});
	const manifest = resolveCapabilities(rows, table);
	if (manifest.missing.length > 0) return {
		admission: {
			source: "capability-gap",
			required: rows,
			missing: [...manifest.missing].sort(),
			reason: `the effective capability table does not hold ${manifest.missing.map((name) => JSON.stringify(name)).join(", ")}, so the production configuration cannot admit this sample (the runtime's own resolution reports a closure gap)`
		},
		candidateProvider
	};
	const precheck = await sources.taskRuntime.capabilityProviderReport(caller, rows);
	const refused = refusedProviderLines(precheck);
	if (refused.length > 0) return {
		admission: {
			source: "provider-refused",
			required: rows,
			missing: [],
			reason: `the production configuration resolves providers this deployment cannot use:\n- ${refused.join("\n- ")}`
		},
		candidateProvider
	};
	const productionSide = frozenCapabilitySideOf({
		precheck,
		table,
		rows,
		where: `${where} production side`
	});
	return {
		provider: {
			capabilities: rows,
			registryRevision: productionSide.registryRevision,
			candidateRegistryRevision: productionSide.registryRevision,
			mcpServers: productionSide.mcpServers,
			preset: productionSide.preset,
			skills: productionSide.skills
		},
		candidateProvider
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
/** Freeze one sample from its store record: what the case is, the acceptance the replay mirrors into both sides, and the provider identities. */
function frozenSampleOf$1(sample, task, review, providers, vocabulary) {
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
		...providers
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
*
* A capability candidate (A6) freezes what it really has: the one row it
* installs and the registry row it moves, the gap it came from, and — when it
* carries a new skill — that object's whole identity. A row-only candidate has
* no skill identity, which is why `candidate` is optional here and the schema
* requires exactly one of the two to name the candidate.
*/
function freezeExperiment(input) {
	const candidate = input.candidate;
	const capability = input.capability;
	const frozen = {
		proposalId: input.proposalId,
		repetition: input.spec.repetition,
		...candidate === void 0 ? {} : { candidate: frozenIdentityOf(candidate) },
		...input.productionBaseline === void 0 ? {} : { productionBaseline: frozenIdentityOf(input.productionBaseline) },
		...capability === void 0 ? {} : { capability: {
			row: {
				name: capability.row.name,
				entry: structuredClone(capability.row.entry),
				digest: capability.row.digest
			},
			baseline: capability.baseline === null ? null : {
				name: capability.baseline.name,
				entry: structuredClone(capability.baseline.entry),
				digest: capability.baseline.digest
			},
			sourceRefs: [...capability.sourceRefs]
		} },
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
			candidate: capability === void 0 ? `extraSkillRoots: [${input.sandbox}/skills] — the complete candidate object: ${candidate.contract === void 0 ? `the guidance object "${candidate.name}" (SKILL.md alone, no sidecar)` : `the execution object "${candidate.name}" (SKILL.md plus the derived SKILL.contract.json)`}, loaded whole through the runtime's own discovery` : `capabilityOverrides: { "${capability.row.name}": the prepared row }${candidate === void 0 ? " and no extra skill root — a row-only candidate adds no object" : `, extraSkillRoots: [${input.sandbox}/skills] — the new execution object "${candidate.name}" (SKILL.md plus the SKILL.contract.json beside it), loaded whole through the runtime's own discovery`}`
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
		preparedContentDigest: preparedContentDigestOf(input.view.frozen),
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
		...input.admission === void 0 ? {} : { admission: structuredClone(input.admission) },
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
		...record.reason === void 0 ? {} : { reason: record.reason },
		...record.admission === void 0 ? {} : { admission: structuredClone(record.admission) }
	};
}
/** The key one frozen sample's side has under one experiment. */
function experimentSampleKeyOf(view, sampleTaskId, side) {
	return {
		proposalId: view.proposalId,
		preparedContentDigest: preparedContentDigestOf(view.frozen),
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
* Attempt one capability sample's baseline side for real, and return the
* runtime's own refusal text (A6).
*
* The frozen block already says the production configuration cannot admit this
* sample — the row is missing or its provider is refused — but *that* is not
* proof of anything at run time: the side is really offered to the runtime, its
* whole admission chain runs against the real table, and only a refusal that
* left nothing behind is recorded. What is checked around the attempt:
*
* - the replay must **refuse**, not run: an outcome here means the production
*   configuration admits the sample now, which contradicts the frozen block, so
*   the experiment stops by name instead of recording either story;
* - the store must hold **no task** of this side's lineage: anything persisted
*   is a run, and a run means this was not an admission refusal;
* - the runtime's own current answer must still say the same thing (the rows do
*   not resolve, or the pre-check refuses them) — an unrelated failure that
*   happened to precede a run is not an admission refusal of the frozen kind;
* - the refusal must be the runtime's own (`task-runtime: …`), never another
*   layer's error read as one.
*/
async function refusedBaselineRun(input) {
	const { sources, storeId, sample, lineage, workspace, caller } = input;
	const admission = sample.admission;
	let refusal$2;
	let returned;
	try {
		returned = await sources.taskRuntime.replayTask(storeId, sample.taskId, {
			lineage,
			workspace: { path: workspace },
			agentOptions: { ...input.agentOptions },
			...input.signal === void 0 ? {} : { signal: input.signal }
		}, caller);
	} catch (error) {
		refusal$2 = error instanceof Error ? error.message : String(error);
	}
	if (returned !== void 0) throw new Error(`evolution: the production configuration admitted sample "${sample.taskId}" (replay settled ${returned.status}) although the experiment froze its refusal at admission — the configuration moved since the experiment froze, so freeze a new experiment rather than record either story for this side`);
	const persisted = (await sources.task.openStore(storeId)).tasks.find((item) => item.objective.startsWith(`[${lineage}] `));
	if (persisted !== void 0) throw new Error(`evolution: the baseline side of sample "${sample.taskId}" was expected to be refused at admission, but the store holds task "${persisted.taskId}" of this side's own lineage — a side that reached the store is a run, and a run is not an admission refusal`);
	const message$1 = refusal$2 ?? "the runtime refused this replay without a message";
	if (!message$1.startsWith("task-runtime: ")) throw new Error(`evolution: the baseline side of sample "${sample.taskId}" failed before its run for a reason that is not the runtime's own admission refusal (${message$1}) — the side is not recorded as not-admitted`);
	const table = sources.taskRuntime.listCapabilities?.();
	if (table === void 0) throw new Error(`evolution: the effective capability table cannot be read now, so the admission refusal of sample "${sample.taskId}" cannot be re-proved — nothing was recorded for this side`);
	if (!(admission.source === "capability-gap" ? resolveCapabilities(admission.required, table).missing.length > 0 : refusedProviderLines(await sources.taskRuntime.capabilityProviderReport(caller, admission.required)).length > 0)) throw new Error(`evolution: sample "${sample.taskId}" was frozen as refused at admission (${admission.source}), but the runtime no longer refuses it — the configuration moved since the freeze; freeze a new experiment rather than record a refusal that no longer holds`);
	return message$1;
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
	const { sandbox, candidate, capability, overlay, proposal } = await experimentCandidate(sources, spec.proposalId);
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
		const providers = capability === void 0 ? { provider: await frozenProviderIdentity({
			sources,
			caller,
			sampleTaskId: sample.taskId,
			required: task.requestedCapabilities,
			candidate,
			where: `sample "${sample.taskId}"`
		}) } : await frozenCapabilitySample({
			sources,
			caller,
			sampleTaskId: sample.taskId,
			required: task.requestedCapabilities,
			overlay
		});
		samples.push(frozenSampleOf$1(sample, task, review, providers, vocabulary));
	}
	const frozen = freezeExperiment({
		proposalId: spec.proposalId,
		spec,
		...candidate === void 0 ? {} : { candidate },
		...proposal.prepared?.skillBaseline == null ? {} : { productionBaseline: proposal.prepared.skillBaseline },
		...capability === void 0 ? {} : { capability },
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
			if (side === "baseline" && sample.admission !== void 0) {
				const refusal$2 = await refusedBaselineRun({
					sources,
					storeId,
					sample,
					lineage,
					workspace: real,
					agentOptions,
					caller,
					...request.signal === void 0 ? {} : { signal: request.signal }
				});
				const admitted = sampleRecord({
					view,
					sample,
					side,
					outcome: "not-admitted",
					criteria: [],
					evidenceRefs: [],
					workspace: real,
					cost: {
						status: "unknown",
						reason: "the runtime refused this side at admission, so no run exists and no cost was reported for it"
					},
					admission: {
						source: sample.admission.source,
						proposalId: view.proposalId,
						sourceRefs: [...view.frozen.capability?.sourceRefs ?? []],
						required: [...sample.admission.required],
						missing: [...sample.admission.missing],
						reason: refusal$2
					},
					actor
				});
				await sources.evolution.recordExperimentSample(admitted);
				recorded.set(experimentSampleKey(key), admitted);
				settledSides += 1;
				continue;
			}
			const outcome = await sources.taskRuntime.replayTask(storeId, sample.taskId, {
				lineage,
				workspace: { path: real },
				agentOptions: { ...agentOptions },
				...side === "candidate" ? { overlay: overlay ?? { extraSkillRoots: [resolve(sources.evolution.root, sandbox, "skills")] } } : {},
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
	if (record.preparedContentDigest !== preparedContentDigestOf(view.frozen)) throw new Error(`evolution: ${field} names a candidate content identity that is not the experiment's own`);
	if (record.repetition !== view.frozen.repetition) throw new Error(`evolution: ${field} names a repetition that is not the experiment's own`);
	if (!view.frozen.samples.some((sample) => sample.taskId === record.sampleTaskId)) throw new Error(`evolution: ${field} names sample "${record.sampleTaskId}", which the experiment never froze`);
	if (!EXPERIMENT_SIDES.includes(record.side)) throw new Error(`evolution: ${field} has an unknown side "${String(record.side)}"`);
	if (!EXPERIMENT_OUTCOMES.includes(record.outcome)) throw new Error(`evolution: ${field} has an unknown outcome "${String(record.outcome)}"`);
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
	if (record.outcome === "not-admitted") {
		if (record.side !== "baseline") throw new Error(`evolution: ${field} records the candidate side as not-admitted — a candidate the runtime will not admit produced no run, so it fixed nothing and cannot stand as a fix; only a baseline side may be not-admitted`);
		if (record.admission === void 0) throw new Error(`evolution: ${field} is not-admitted without the runtime's refusal — a side with no run must record why`);
		assertAdmissionRecord(record.admission, field);
		if (record.taskId !== void 0 || record.runId !== void 0 || record.reviewRef !== void 0) throw new Error(`evolution: ${field} is not-admitted and cites a task, a run or a review — a refused side produced no run, and a failure run invented in its place is not evidence`);
		if (record.evidenceRefs.length > 0 || record.criteria.length > 0) throw new Error(`evolution: ${field} is not-admitted and cites evidence or criteria — no run produced any`);
		return;
	}
	if (record.admission !== void 0) throw new Error(`evolution: ${field} carries an admission refusal but settled as "${String(record.outcome)}"`);
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
* build evaluates a replacement of an existing skill object's bytes and — since
* A6 — one capability row with the new execution skill it grants;
* agent_preset, task_definition, the bookkeeping-only types and L4 have no
* evidence this gate could read, so no record of one is reused to promote it
* (§F.2: "没有支持的评估器就拒绝新晋升"). Their records stay readable.
*/
function noEvaluatorRefusal(proposal) {
	return /* @__PURE__ */ new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}", which has no evaluator in this build — the two-sided experiment (§F.2) evaluates a replacement of an existing skill object, and a capability candidate (A6) is measured by the same experiment against its own overlay, so no other target type has evidence a promotion may read and an older record is never upgraded into new evidence.`);
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
	const improved = frozen.candidate;
	if (expected === void 0 || improved === void 0) throw new Error(`evolution: the experiment report's ${where} cites a run, but the frozen sample records no production provider identity or no candidate object to check it against — a skill experiment freezes both before its sides run`);
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
		if (name !== improved.name) {
			if ((bound.contractDigest ?? null) !== expectedSkill.contractDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" declaration ${bound.contractDigest === null ? "(none)" : bound.contractDigest}, but the frozen identity is ${expectedSkill.contractDigest === null ? "(none)" : expectedSkill.contractDigest} — the provider this side loaded is not the one the experiment froze`);
			if (bound.contentDigest !== expectedSkill.contentDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the production configuration's content at freeze was ${expectedSkill.contentDigest} — the bytes this side loaded moved since the freeze`);
			continue;
		}
		const sideObject = detail.side === "candidate" ? improved : frozen.productionBaseline;
		if (sideObject === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound the improved skill "${name}", but the frozen block records no production baseline to compare the baseline side's object against — the evidence predates the two-file baseline and is refused rather than promoted against a shape nobody froze`);
		const expectedContract = sideObject.contract?.contractDigest ?? null;
		const expectedContentDigest = skillContentDigest({
			skillMdSha256: sideObject.sha256,
			resources: []
		});
		if ((bound.contractDigest ?? null) !== expectedContract) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" declaration ${bound.contractDigest === null ? "(none)" : bound.contractDigest}, but the ${detail.side} side's frozen object declares ${expectedContract === null ? "(none)" : expectedContract} (${identityLabel(sideObject)}) — the promoted skill's own sidecar is the one difference the candidate overlay is there to produce, and each side must bind the declaration of the object it loaded`);
		if (bound.contentDigest !== expectedContentDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" content ${bound.contentDigest}, but the ${detail.side} side's frozen object hashes to ${sideObject.sha256} (content digest ${expectedContentDigest}) — the content this side loaded is not the frozen one`);
	}
	if (boundSkills.get(improved.name) !== void 0) {
		const sideObject = detail.side === "candidate" ? improved : frozen.productionBaseline;
		if (sideObject === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound the improved skill "${improved.name}" but the frozen block records no production baseline — the bytes the baseline side loaded cannot be re-proved`);
		if (binding.snapshotRoot === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${improved.name}" but records no snapshot root — the bytes it loaded cannot be re-read, so the frozen content identity cannot be compared`);
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
				name: improved.name,
				file: frozenFile.file,
				where,
				runId: run.runId,
				side: detail.side
			}));
			if (digest !== frozenFile.sha256) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${improved.name}" whose ${frozenFile.file} hashes to ${digest}, but the experiment froze ${frozenFile.sha256} for the ${detail.side} side — the bytes this side ran are not the frozen ones`);
		}
		if (detail.side === "candidate" && sideObject.sha256 === frozen.productionBaseline?.sha256) throw new Error(`evolution: the candidate side of the ${where} loaded the production bytes ("${improved.name}" hashes to ${sideObject.sha256}, the frozen production baseline) — the candidate was never really run, so the comparison proves nothing`);
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
function assertSidesAgree(frozen, improved, baseline, candidate, where) {
	const comparable = (binding) => ({
		capabilities: [...binding.capabilities].sort(),
		mcpServers: [...binding.mcpServers].sort((left$1, right$1) => left$1.serverName < right$1.serverName ? -1 : left$1.serverName > right$1.serverName ? 1 : 0),
		skills: [...binding.skills].sort((left$1, right$1) => left$1.name < right$1.name ? -1 : left$1.name > right$1.name ? 1 : 0).map((skill) => ({
			name: skill.name,
			role: skill.role,
			...skill.name === improved.name ? {} : {
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
* The evidence both promotion gates read first (S4-E §F.2, A6): the proposal's
* newest two-sided experiment, its report recomputed from the ledger's own
* records, and the report file on disk — which must be exactly those bytes and
* must pass its own schema. An incomplete experiment has no report, and a file
* edited after the experiment is not the experiment's report.
*/
async function experimentEvidence(sources, proposal) {
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
	return {
		view: experiment,
		report
	};
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
	const { view, report } = await experimentEvidence(sources, proposal);
	const experiment = view;
	const frozen = report.frozen;
	if (frozen.capability !== void 0) throw new Error(`evolution: experiment "${experiment.experimentId}" froze a capability candidate, but proposal "${proposal.proposalId}" is a skill candidate — the evidence belongs to another kind of candidate, so nothing is promoted from it`);
	if (frozen.candidate === void 0 || !sameIdentity(frozen.candidate, candidate)) throw new Error(`evolution: the experiment froze candidate ${frozen.candidate === void 0 ? "(none)" : identityLabel(frozen.candidate)} but proposal "${proposal.proposalId}" now prepares ${identityLabel(candidate)} — the evidence belongs to different candidate bytes; propose a new candidate and evaluate it`);
	const baseline = prepared?.skillBaseline;
	const frozenBaseline = frozen.productionBaseline;
	if (baseline == null || frozenBaseline === void 0 || !sameIdentity(frozenBaseline, baseline)) throw new Error(`evolution: the experiment's frozen production baseline (${frozenBaseline === void 0 ? "none" : identityLabel(frozenBaseline)}) is not the baseline prepare recorded for proposal "${proposal.proposalId}" (${baseline == null ? "none" : identityLabel(baseline)}) — the candidate was evaluated against another production state`);
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
		if (sideRuns.baseline !== void 0 && sideRuns.candidate !== void 0) assertSidesAgree(frozen, candidate, sideRuns.baseline, sideRuns.candidate, `sample "${sample.taskId}"`);
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
		experimentId: view.experimentId,
		report,
		reportPath: view.report
	};
}
/** The frozen sample one report sample was compared under. */
function frozenSampleOf(report, taskId) {
	const sample = report.frozen.samples.find((item) => item.taskId === taskId);
	if (sample === void 0) throw new Error(`evolution: the experiment report holds no frozen sample "${taskId}"`);
	return sample;
}
/**
* Whether one frozen capability identity is the row the candidate prepared: the
* whole row member by member, and the digest of its canonical bytes. A row that
* moved — a skill added, a tool dropped, a policy key that appeared — is another
* row, whatever the name says.
*/
function sameCapabilityRow(left, right) {
	return left.name === right.name && left.digest === right.digest && canonicalJson(left.entry) === canonicalJson(right.entry);
}
/**
* Whether one recorded admission refusal is the refusal the experiment froze for
* that sample (A6): the same admission rule, the same required rows and the same
* rows the table did not hold. The runtime's own words are the record's, so they
* are compared as what they are — a text produced at run time — while the
* machine-readable half must be exactly the frozen one.
*/
function assertAdmissionMatchesFrozen(input) {
	const { sample, detail, where, proposalId } = input;
	const frozen = sample.admission;
	const recorded = detail.admission;
	if (frozen === void 0) throw new Error(`evolution: the experiment report's ${where} is not-admitted, but the frozen sample records no production refusal — a side that never ran needs the admission identity frozen before the experiment ran`);
	if (recorded === void 0) throw new Error(`evolution: the experiment report's ${where} is not-admitted without recording the runtime's own refusal`);
	if (recorded.source !== frozen.source) throw new Error(`evolution: the experiment report's ${where} records an admission refusal from "${recorded.source}", but the experiment froze "${frozen.source}" — the side the evidence describes is not the side the experiment refused`);
	const same = (left, right) => [...left].sort().join(", ") === [...right].sort().join(", ");
	if (!same(recorded.required, frozen.required) || !same(recorded.missing, frozen.missing)) throw new Error(`evolution: the experiment report's ${where} records an admission refusal over rows [${recorded.required.join(", ")}] (missing: [${recorded.missing.join(", ")}]), but the frozen refusal is over [${frozen.required.join(", ")}] (missing: [${frozen.missing.join(", ")}]) — the record and the frozen admission identity disagree about what was refused`);
	if (recorded.proposalId !== proposalId) throw new Error(`evolution: the experiment report's ${where} belongs the admission refusal to proposal "${recorded.proposalId}", not the proposal this promotion reads ("${proposalId}") — the gap a refusal stands for must be this candidate's own`);
	if (recorded.sourceRefs.length === 0) throw new Error(`evolution: the experiment report's ${where} names no source refs for the refusal — the gap it stands for is untraceable`);
}
/**
* Whether one side's run binding is the identity the capability experiment froze
* for that side (A6): the capability rows in play, the registry revision, the
* MCP servers (with a resolved template each), the preset, and every resolved
* provider's role, declaration digest and content digest. Both sides are
* compared against the identity frozen *for them* — the production configuration
* for a baseline side, the candidate overlay for the candidate side — because a
* capability candidate legitimately changes what its own side resolves (it adds
* a row and, usually, a provider), and that difference is exactly what the
* overlay is for.
*
* The candidate side's new skill is then re-proved from the run's own snapshot:
* what that side really loaded must hash to the frozen object's identity, so a
* binding that merely records the right values is not enough.
*/
async function assertCapabilitySideBinding(input) {
	const { sample, detail, run, frozen, where } = input;
	const expected = detail.side === "candidate" ? sample.candidateProvider : sample.provider;
	if (expected === void 0) throw new Error(`evolution: the experiment report's ${where} has no frozen provider identity for its ${detail.side} side — a capability sample freezes one for each side before it runs, and a side the freeze does not describe cannot be read as evidence`);
	const binding = run.providerBinding;
	if (binding === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} records no provider binding — which rows, servers and skills it resolved against cannot be re-read, so the frozen provider identity cannot be compared and the promotion is refused`);
	const rows = [...binding.capabilities].sort();
	if (rows.join(", ") !== [...expected.capabilities].sort().join(", ")) throw new Error(`evolution: run "${run.runId}" of the ${where} bound capabilities [${rows.join(", ") || "none"}] but the experiment froze [${expected.capabilities.join(", ") || "none"}] for the ${detail.side} side — the rows this side ran under are not the frozen ones`);
	if (binding.registryRevision !== expected.registryRevision) throw new Error(`evolution: run "${run.runId}" of the ${where} bound registry revision ${binding.registryRevision}, but the experiment froze ${expected.registryRevision} for the ${detail.side} side — a row, a tool label or a provider contract moved since the freeze, so the ${detail.side} side did not run under the configuration the experiment froze for it`);
	const servers = [...binding.mcpServers].map((server) => server.serverName).sort();
	if (servers.join(", ") !== [...expected.mcpServers].sort().join(", ")) throw new Error(`evolution: run "${run.runId}" of the ${where} bound MCP servers [${servers.join(", ") || "none"}] but the experiment froze [${expected.mcpServers.join(", ") || "none"}] — the granted server plane moved since the freeze`);
	for (const server of binding.mcpServers) if (server.templateDigest === null) throw new Error(`evolution: run "${run.runId}" of the ${where} bound MCP server "${server.serverName}" with no resolvable template — the run recorded no identity for the server it was granted, so the frozen server plane cannot be compared`);
	if (expected.preset !== null && run.agentPreset !== expected.preset) throw new Error(`evolution: run "${run.runId}" of the ${where} ran under agent preset ${run.agentPreset === void 0 ? "(none)" : `"${run.agentPreset}"`}, but the frozen provider identity declares "${expected.preset}" — the preset plane this side ran under is not the frozen one`);
	const frozenSkills = new Map(expected.skills.map((skill) => [skill.name, skill]));
	const boundSkills = new Map(binding.skills.map((skill) => [skill.name, skill]));
	for (const name of boundSkills.keys()) if (!frozenSkills.has(name)) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}", which the frozen provider identity does not resolve (frozen: ${expected.skills.map((skill) => skill.name).join(", ") || "none"}) — content the freeze never admitted reached this run`);
	for (const [name, frozenSkill] of frozenSkills) {
		const bound = boundSkills.get(name);
		if (bound === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound no skill "${name}", which the frozen provider identity resolves — the run under this side did not load content the freeze named`);
		if (bound.role !== frozenSkill.role || (bound.contractDigest ?? null) !== frozenSkill.contractDigest || bound.contentDigest !== frozenSkill.contentDigest) throw new Error(`evolution: run "${run.runId}" of the ${where} bound skill "${name}" as ${bound.role} declaration ${bound.contractDigest ?? "(none)"} content ${bound.contentDigest}, but the frozen identity is ${frozenSkill.role} declaration ${frozenSkill.contractDigest ?? "(none)"} content ${frozenSkill.contentDigest} — the provider this side loaded is not the one the experiment froze for it`);
	}
	const candidate = frozen.candidate;
	if (candidate === void 0 || detail.side !== "candidate") return;
	const frozenFiles = [{
		file: "SKILL.md",
		sha256: candidate.sha256
	}, ...candidate.contract === void 0 ? [] : [{
		file: SKILL_SIDECAR_FILE,
		sha256: candidate.contract.sha256
	}]];
	if (binding.snapshotRoot === void 0) throw new Error(`evolution: run "${run.runId}" of the ${where} bound the new skill "${candidate.name}" but records no snapshot root — the bytes it loaded cannot be re-read, so the frozen content identity cannot be compared`);
	for (const frozenFile of frozenFiles) {
		const digest = sha256Hex$1(await readSideSnapshotFile({
			snapshotRoot: binding.snapshotRoot,
			name: candidate.name,
			file: frozenFile.file,
			where,
			runId: run.runId,
			side: detail.side
		}));
		if (digest !== frozenFile.sha256) throw new Error(`evolution: run "${run.runId}" of the ${where} bound the new skill "${candidate.name}" whose ${frozenFile.file} hashes to ${digest}, but the experiment froze ${frozenFile.sha256} — the bytes this side ran are not the frozen ones`);
	}
}
/**
* The capability promotion gate (A6 §F.4 "候选支持范围固定" and
* "评估/应用必须同组补齐"): what a PROMOTE of a capability candidate must be able
* to prove before a human is asked. Every check is a read, and every failure is
* a named refusal that writes nothing:
*
* 1. the candidate is a materialized capability prepare (a frozen row, and the
*    new skill's files when it carries one), re-read from the sandbox and
*    verified against the identities prepare recorded;
* 2. the store's row still reads as the baseline prepare captured — a row that
*    moved between prepare and promotion is a conflict, not a candidate;
* 3. every rule the candidate itself must satisfy still holds against the store
*    as it stands now: no tool the store has not authorized, no preset /
*    permission / server change, a verifier that is registered and versioned, a
*    new skill name that is still free and still not a rename of an existing
*    object (`assertCapabilityCandidateAdmissible`);
* 4. every skill the row declares — the candidate's own new one, discovered from
*    the sandbox, and any existing ones the row grants — is a loadable provider
*    under the same pre-check admission runs;
* 5. **the evaluation evidence**: the proposal's newest two-sided experiment,
*    complete, whose report file is the report its own records recompute to, and
*    whose frozen identity is this candidate — the row, the row it moves, the
*    gap it came from and, when it carries one, the new skill object;
* 6. **the baseline the evidence records**: every sample's baseline side is
*    either the frozen production refusal (A6: `not-admitted`, no Task, no Run,
*    the refusal the freeze recorded — never a failed run standing in for it) or
*    a real run of this experiment that bound the frozen production identity;
* 7. **the candidate really ran and passed**: the candidate side of every sample
*    is a run of this experiment's own lineage, settled `verified`, with every
*    criterion the frozen judge decided reported `pass` — admission passing is
*    not a fix, so the run, its review record and its evidence are all re-read
*    from the store and compared against the ledger;
* 8. **no regression and no degraded holdout**: the verdict must be the clean
*    `fixed` — a `fixed-with-regression`, `regressed`, `not-fixed`, `both-failed`
*    or `inconclusive` experiment is refused by name with its sample verdicts.
*
* Nothing here writes: the whole gate is reads. The production write, its own
* re-check of the candidate and the human approvals stay where they are (the
* service's `apply` and the tools).
*/
async function assertCapabilityPromotionEvidence(sources, proposal) {
	const prepared = await readPreparedCapability(sources.root, proposal);
	const store = await sources.store();
	const current = store.table[prepared.row.name] ?? null;
	const currentDigest = current === null ? null : capabilityRowDigest(current);
	const baseline = proposal.prepared?.capabilityBaseline ?? null;
	const preparedDigest = baseline === null ? null : baseline.digest;
	if (currentDigest !== preparedDigest) throw capabilityRefusal("capability-registry-changed", `the capability registry row "${prepared.row.name}" reads ${currentDigest ?? "no row"}, not the state prepare recorded (${preparedDigest ?? "no row"}) — a row a third party moved is a conflict, so create a new candidate from the current registry state and re-evaluate it; nothing was promoted`);
	await assertCapabilityCandidateAdmissible(store, {
		row: prepared.row,
		...prepared.skill === void 0 ? {} : { skill: prepared.skill }
	}, current);
	const refusals = await sources.rowRefusals(prepared.row, prepared.skillRoot);
	if (refusals.length > 0) throw capabilityRefusal("skill-candidate-invalid", `capability candidate "${proposal.proposalId}" grants providers this deployment refuses:\n${refusals.map((line) => `- ${line}`).join("\n")}`);
	const preparedRow = {
		...prepared.row,
		digest: proposal.prepared.capabilityRow.digest
	};
	const { view, report } = await experimentEvidence(sources, proposal);
	const frozen = report.frozen;
	const capability = frozen.capability;
	if (capability === void 0) throw capabilityRefusal("capability-evidence-absent", `experiment "${view.experimentId}" froze a ${frozen.candidate === void 0 ? "candidate with no capability identity" : "skill object identity"} for proposal "${proposal.proposalId}", which is a capability candidate — the evidence belongs to another kind of candidate`);
	if (!sameCapabilityRow(capability.row, preparedRow)) throw capabilityRefusal("capability-evidence-drifted", `experiment "${view.experimentId}" froze row "${capability.row.name}" (${capability.row.digest}), but proposal "${proposal.proposalId}" now prepares row "${prepared.row.name}" (${proposal.prepared.capabilityRow.digest}) — the evidence belongs to different bytes; propose a new candidate and evaluate it`);
	const recordedBaseline = baseline;
	if (capability.baseline === null !== (recordedBaseline === null)) throw capabilityRefusal("capability-evidence-drifted", `experiment "${view.experimentId}" froze ${capability.baseline === null ? "no baseline row" : `baseline row ${capability.baseline.digest}`} , but proposal "${proposal.proposalId}" was prepared against ${recordedBaseline === null ? "no row" : `row ${recordedBaseline.digest}`} — the candidate was evaluated against another registry state`);
	if (capability.baseline !== null && recordedBaseline !== null && !sameCapabilityRow(capability.baseline, recordedBaseline)) throw capabilityRefusal("capability-evidence-drifted", `experiment "${view.experimentId}" froze baseline row ${capability.baseline.digest}, but prepare recorded ${recordedBaseline.digest} — the row this candidate would roll back to is not the row the experiment evaluated against`);
	const preparedSkill = proposal.prepared?.skillContent;
	if (frozen.candidate === void 0 !== (preparedSkill === void 0)) throw capabilityRefusal("capability-evidence-drifted", `experiment "${view.experimentId}" froze ${frozen.candidate === void 0 ? "no new skill object" : `the new skill ${identityLabel(frozen.candidate)}`}, but proposal "${proposal.proposalId}" prepares ${preparedSkill === void 0 ? "no new skill object" : identityLabel(preparedSkill)} — the candidate the experiment evaluated is not the candidate this promotion would write`);
	if (frozen.candidate !== void 0 && preparedSkill !== void 0 && !sameIdentity(frozen.candidate, preparedSkill)) throw capabilityRefusal("capability-evidence-drifted", `experiment "${view.experimentId}" froze candidate ${identityLabel(frozen.candidate)} but proposal "${proposal.proposalId}" now prepares ${identityLabel(preparedSkill)} — the evidence belongs to different candidate bytes; propose a new candidate and evaluate it`);
	if (frozen.productionBaseline !== void 0) throw capabilityRefusal("capability-evidence-drifted", `experiment "${view.experimentId}" froze a production skill baseline, which a capability candidate never has — its production baseline is the registry row it moves`);
	const sourceRefs = [...proposal.sourceRefs ?? []];
	if (canonicalJson([...capability.sourceRefs].sort()) !== canonicalJson([...sourceRefs].sort())) throw capabilityRefusal("capability-evidence-drifted", `experiment "${view.experimentId}" froze the gap it came from as [${capability.sourceRefs.join(", ")}], but proposal "${proposal.proposalId}" records [${sourceRefs.join(", ")}] — the refusal the evidence rests on belongs to another proposal`);
	const storeId = view.storeId;
	if (storeId === void 0) throw capabilityRefusal("capability-evidence-absent", `experiment "${view.experimentId}" records no task store, so the runs its sides cite cannot be re-read — run the two-sided experiment again so its evidence names the store it ran in`);
	const snapshot = await sources.task.openStore(storeId);
	const vocabulary = await sources.verifierVocabulary();
	if (vocabulary === void 0) throw capabilityRefusal("capability-evidence-unverifiable", "the verifier registry cannot be listed in this context, so the judges behind the experiment's verdicts cannot be re-checked — the promotion is refused rather than granted on unverifiable evidence");
	for (const sample of report.samples) {
		const frozenSample = frozenSampleOf(report, sample.taskId);
		const candidateLabel = `sample "${sample.taskId}" candidate side`;
		const candidateTask = assertSideEvidence({
			sample: frozenSample,
			detail: sample.candidate,
			experimentId: view.experimentId,
			snapshot,
			where: candidateLabel
		});
		assertJudgeUnchanged(frozenSample, sample.candidate, candidateLabel, vocabulary);
		assertCostWithinDeclaredBudget(report, candidateLabel, sample.candidate);
		if (sample.candidate.outcome !== "verified") throw capabilityRefusal("capability-candidate-not-verified", `the candidate side of ${candidateLabel} settled "${sample.candidate.outcome}" — a capability fix is a run that passed the frozen acceptance, never an admission that merely went through; the promotion is refused`);
		const failed = sample.candidate.criteria.filter((criterion) => criterion.verdict !== "pass");
		if (failed.length > 0) throw capabilityRefusal("capability-candidate-not-verified", `the candidate side of ${candidateLabel} reports ${failed.map((criterion) => `"${criterion.criterionId}" ${criterion.verdict}`).join(", ")} — every frozen criterion must pass on the candidate side before the candidate may be promoted`);
		if (sample.candidate.initialDigest !== frozen.snapshot.digest) throw capabilityRefusal("capability-evidence-drifted", `the candidate side of ${candidateLabel} ran from workspace digest ${sample.candidate.initialDigest}, not the frozen snapshot ${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`);
		await assertSideModelBinding({
			sources,
			detail: sample.candidate,
			task: candidateTask,
			snapshot,
			selection: frozen.model,
			where: candidateLabel
		});
		const candidateRun = sample.candidate.runId === void 0 ? void 0 : snapshot.runs.find((item) => item.runId === sample.candidate.runId);
		if (candidateRun === void 0) throw capabilityRefusal("capability-evidence-absent", `the experiment report's ${candidateLabel} cites run "${String(sample.candidate.runId)}", which the store no longer holds — its provider binding cannot be re-read, so the promotion is refused`);
		await assertCapabilitySideBinding({
			sample: frozenSample,
			detail: sample.candidate,
			run: candidateRun,
			frozen,
			where: candidateLabel
		});
		const baselineLabel = `sample "${sample.taskId}" baseline side`;
		if (frozenSample.admission !== void 0) {
			if (sample.baseline.outcome !== "not-admitted") throw capabilityRefusal("capability-baseline-not-refused", `the experiment froze the production configuration's refusal of ${baselineLabel}, but the record settled "${sample.baseline.outcome}" — the baseline the candidate is compared against is not the refusal the experiment proved`);
			assertAdmissionMatchesFrozen({
				sample: frozenSample,
				detail: sample.baseline,
				where: baselineLabel,
				proposalId: proposal.proposalId
			});
			const lineage = experimentLineage(view.experimentId, sample.taskId, "baseline");
			const persisted = snapshot.tasks.find((item) => item.objective.startsWith(`[${lineage}] `));
			if (persisted !== void 0) throw capabilityRefusal("capability-baseline-not-refused", `${baselineLabel} is recorded not-admitted, but the store holds replayed task "${persisted.taskId}" of this side's own lineage — a refused side produced no run, and a failure run standing in its place is not evidence`);
		} else {
			if (sample.baseline.outcome === "not-admitted") throw capabilityRefusal("capability-baseline-not-refused", `${baselineLabel} is recorded not-admitted, but the experiment froze the production configuration as admitting it — the record and the frozen identity disagree about whether the baseline ran`);
			const baselineTask = assertSideEvidence({
				sample: frozenSample,
				detail: sample.baseline,
				experimentId: view.experimentId,
				snapshot,
				where: baselineLabel
			});
			assertJudgeUnchanged(frozenSample, sample.baseline, baselineLabel, vocabulary);
			assertCostWithinDeclaredBudget(report, baselineLabel, sample.baseline);
			if (sample.baseline.initialDigest !== frozen.snapshot.digest) throw capabilityRefusal("capability-evidence-drifted", `the baseline side of ${baselineLabel} ran from workspace digest ${sample.baseline.initialDigest}, not the frozen snapshot ${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`);
			await assertSideModelBinding({
				sources,
				detail: sample.baseline,
				task: baselineTask,
				snapshot,
				selection: frozen.model,
				where: baselineLabel
			});
			const baselineRun = sample.baseline.runId === void 0 ? void 0 : snapshot.runs.find((item) => item.runId === sample.baseline.runId);
			if (baselineRun === void 0) throw capabilityRefusal("capability-evidence-absent", `the experiment report's ${baselineLabel} cites run "${String(sample.baseline.runId)}", which the store no longer holds — its provider binding cannot be re-read, so the promotion is refused`);
			await assertCapabilitySideBinding({
				sample: frozenSample,
				detail: sample.baseline,
				run: baselineRun,
				frozen,
				where: baselineLabel
			});
		}
		await assertSampleInputsIntact({
			sample: frozenSample,
			snapshot,
			productionWorkspace: frozen.snapshot.sourceDir
		});
	}
	assertExperimentCostWithinBudget(report);
	const currentSelection = sources.modelSelection();
	if (currentSelection.provider !== frozen.model.provider || currentSelection.model !== frozen.model.model || currentSelection.reasoningEffort !== frozen.model.reasoningEffort || currentSelection.maxTokens !== frozen.model.maxTokens) throw capabilityRefusal("capability-evidence-drifted", `the experiment froze model selection "${frozen.model.label}", but this deployment resolves "${currentSelection.label}" now — the runs on record were not run under the selection this promotion would be judged against`);
	const degraded = report.samples.filter((sample) => sample.verdict === "regressed");
	if (report.verdict !== "fixed") throw capabilityRefusal("capability-not-fixed", `the two-sided capability experiment "${view.experimentId}" did not show a clean fix — ${VERDICT_REFUSALS[report.verdict]}:\n${sampleVerdictLines(report.samples).map((line) => `- ${line}`).join("\n")}` + (degraded.length === 0 ? "" : ` — degraded sample(s): ${degraded.map((sample) => sample.taskId).join(", ")}`));
	return {
		rowName: prepared.row.name,
		rowDigest: proposal.prepared.capabilityRow.digest,
		...prepared.skill === void 0 ? {} : { newSkill: prepared.skill.name },
		experimentId: view.experimentId,
		report,
		reportPath: view.report
	};
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
* The target types `evolution_apply`/`evolution_rollback` move mechanically: a
* skill candidate's sandbox copy lands on the production skill root, and — since
* A6 — a capability candidate's one row lands in the capability registry
* together with the new skill object its file set contains. Every other type has
* no executor in this build — an agent_preset directory and a task_definition
* were written by an older build and are not written here.
*/
const APPLYABLE_TARGET_TYPES = ["skill", "capability"];
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
* Validate a candidate's mutation. This build has exactly two candidate
* mutations — the `SKILL.md` text replacing an existing skill object's own
* (§F.2), and the capability candidate's one whole row plus an optional new
* execution skill (A6) — so the schema is chosen by the proposal's target type
* and nothing else. A mutation of another target type has no schema here, and is
* named rather than silently accepted: the old schemas (agent_preset,
* task_definition) and the bookkeeping-only default belonged to a lifecycle this
* build no longer has. The unknown key check is the "no sidecar patch" rule for
* a skill, and for a capability the one-whole-row rule
* ({@link validateCapabilityMutation}): the model submits the row and the new
* skill's declaration, never a field patch and never a second row.
*/
function validateMutation(targetType, mutation) {
	if (!isRecord(mutation)) throw new Error("evolution: mutation must be an object");
	if (targetType === "capability") {
		validateCapabilityMutation(mutation);
		return;
	}
	if (targetType !== "skill") throw new Error(`evolution: a "${targetType}" mutation has no schema in this build — the candidate lifecycles here are a SKILL.md replacement of an existing skill object and one whole capability row with an optional new execution skill, and every other target type is a recorded proposal`);
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
* execution sidecar — one or two paths, in commit order. A capability candidate
* (A6) names its new skill's files the same way, and a row-only candidate names
* none: its one write is the registry row, which the intent line carries.
*/
function applyTargets(proposal, roots) {
	if (proposal.targetType === "capability") {
		const content = proposal.prepared?.skillContent;
		if (content === void 0) return [];
		const files$1 = [join(roots.skillRoot, content.name, "SKILL.md")];
		if (content.contract !== void 0) files$1.push(join(roots.skillRoot, content.name, SKILL_SIDECAR_FILE));
		return files$1;
	}
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
* set has the fixed shape of one skill object (up to two entries, in commit
* order: `SKILL.md` first, the `SKILL.contract.json` of the same directory
* second when there is one; empty for a row-only capability commit), every
* digest is real SHA-256 hex **or `null`** — `null` being the state "must not
* exist", which is how A6's create and removal commits say what they mean — and
* the one capability row a capability commit carries is well formed. Every
* target is absolute, and the direction is one of the two the commit path has. A
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
	if (!Array.isArray(files) || files.length > 2 || files.length === 0 && record.capability === void 0) throw new Error(`evolution: commit_intent record for proposal "${record.proposalId}" names ${Array.isArray(files) ? `${files.length} file(s)` : "no file list"} and ${record.capability === void 0 ? "no capability row" : `capability row "${record.capability.name}"`} — a commit carries a fixed file set of one or two files (SKILL.md, and SKILL.contract.json when the object carries an execution sidecar) and/or exactly one capability row`);
	files.forEach((file, index) => {
		const at$1 = `commit_intent record for proposal "${record.proposalId}" file ${index}`;
		if (!isRecord(file)) throw new Error(`evolution: ${at$1} is not an object carrying target, baselineSha256, contentSha256, source`);
		if (typeof file.target !== "string" || file.target.trim().length === 0) throw new Error(`evolution: ${at$1} has no target — every file names the absolute production path it writes`);
		for (const [field, value] of [["baselineSha256", file.baselineSha256], ["contentSha256", file.contentSha256]]) if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) throw new Error(`evolution: ${at$1} has no valid ${field} (${JSON.stringify(value ?? null)}) — an intent binds, for every file, the exact bytes production must hold before the write and the exact bytes it must hold after, or \`null\` for the state "no file here"`);
		if (file.baselineSha256 === null && file.contentSha256 === null) throw new Error(`evolution: ${at$1} records no file before the commit and no file after it — an intent that neither creates, replaces nor removes anything names nothing`);
		if (file.contentSha256 !== null) {
			if (typeof file.source !== "string" || file.source.trim().length === 0) throw new Error(`evolution: ${at$1} has no source — a file this commit writes must name the recoverable bytes a recovery would write again`);
		} else if (file.source !== void 0) throw new Error(`evolution: ${at$1} names the source ${JSON.stringify(file.source)} while it removes the file — a removal has no bytes to write again`);
		if (file.target !== resolve(file.target)) throw new Error(`evolution: ${at$1} names target "${file.target}" — an intent names the absolute production paths it commits`);
		if (basename(file.target) !== (index === 0 ? "SKILL.md" : SKILL_SIDECAR_FILE)) throw new Error(`evolution: ${at$1} names target "${file.target}" — the file set of one skill object is ordered and fixed: SKILL.md first, and, when the object carries an execution sidecar, ${SKILL_SIDECAR_FILE} second`);
		if (index > 0 && dirname(file.target) !== dirname(files[0].target)) throw new Error(`evolution: ${at$1} names target "${file.target}" beside "${files[0].target}" — the files of one skill object live in one directory, the one a loader reads whole`);
	});
	const capability = record.capability;
	if (capability === void 0) return;
	const at = `commit_intent record for proposal "${record.proposalId}" capability row`;
	if (!isRecord(capability) || typeof capability.name !== "string" || capability.name.trim().length === 0) throw new Error(`evolution: ${at} names no row — a capability commit carries the one row it moves, by name`);
	for (const [field, value] of [["baselineSha256", capability.baselineSha256], ["contentSha256", capability.contentSha256]]) if (value !== null && (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) throw new Error(`evolution: ${at} "${capability.name}" has no valid ${field} (${JSON.stringify(value ?? null)}) — the row's two states are the canonical digests the registry must hold before and after the write, or \`null\` for "no row of this name"`);
	if (capability.baselineSha256 === null && capability.contentSha256 === null) throw new Error(`evolution: ${at} "${capability.name}" moves nothing — an intent that neither installs nor removes a row names a row it does not move`);
	if (capability.contentSha256 !== null) {
		if (typeof capability.source !== "string" || capability.source.trim().length === 0) throw new Error(`evolution: ${at} "${capability.name}" has no source — the row this commit installs must name the recoverable bytes a recovery would write again`);
	} else if (capability.source !== void 0) throw new Error(`evolution: ${at} "${capability.name}" names the source ${JSON.stringify(capability.source)} while it removes the row — a removal has no bytes to write again`);
}
/**
* The prepared record's frozen row identity, validated: the row's name, the row
* itself (re-checked with the live schema, so a hand-forged entry with an unknown
* field is refused at the fold exactly as `candidate` would refuse it), and the
* digest of its canonical bytes. `field` names the record's own member in the
* refusal, because the operator reads the line.
*/
function preparedRowIdentity(value, field, proposalId) {
	const at = `prepared record for "${proposalId}"`;
	if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0 || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error(`evolution: ${at} has no valid ${field} identity — every capability prepare records the row it fixes (or the row the registry held) by name, by its data and by the SHA-256 of its canonical bytes`);
	const entry = assertCapabilityRow(`${at} ${field}`, value.entry);
	if (capabilityRowDigest(entry) !== value.digest) throw new Error(`evolution: ${at} ${field} "${value.name}" carries data hashing to ${capabilityRowDigest(entry)}, not the ${value.digest} it records — a row whose data and identity disagree is not one this plane froze`);
	return {
		name: value.name,
		entry,
		digest: value.digest
	};
}
/**
* A prepared record's frozen table identity (A6), validated: the three whole-file
* digests of the deployment's capability table as prepare froze them, or
* `undefined` when the record carries none (a prepare whose deployment named no
* table file, or a line written before this field existed — both fold, and a table
* write that cannot be checked refuses by name). `field` names the record's own
* member in the refusal, because the operator reads the line.
*/
function preparedCapabilityTable(value, field, proposalId) {
	if (value === void 0) return void 0;
	const at = `prepared record for "${proposalId}"`;
	if (!isRecord(value)) throw new Error(`evolution: ${at} has a ${field} that is not an object — a capability prepare freezes the composed identity of the table file its row is written into as three whole-file digests and nothing else`);
	const digestOf$1 = (half) => {
		const digest = value[half];
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`evolution: ${at} has no valid ${field}.${half} (${JSON.stringify(digest ?? null)}) — a capability prepare freezes the whole-file SHA-256 of the table as it read it (\`baselineSha256\`) and of the table its own apply and rollback leave (\`applySha256\` / \`rollbackSha256\`), so a file a third party moved is a named stop and the commit's own result is still recognized`);
		return digest;
	};
	return {
		baselineSha256: digestOf$1("baselineSha256"),
		applySha256: digestOf$1("applySha256"),
		rollbackSha256: digestOf$1("rollbackSha256")
	};
}
/**
* The two whole-file states one capability direction may find in the deployment's
* table file (A6, EVO-2): what it starts from — the file prepare read for an
* apply, the file the apply left for a rollback — and the state its own write
* leaves. The two directions therefore never accept each other's intermediate
* results, and a retry of either finds its own.
*/
function capabilityTableStates(direction, table) {
	return direction === "apply" ? {
		beforeSha256: table.baselineSha256,
		afterSha256: table.applySha256
	} : {
		beforeSha256: table.applySha256,
		afterSha256: table.rollbackSha256
	};
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
/** The fields a recovery-coordination request may carry: anything else is refused by name rather than ignored. */
const RECOVERY_COORDINATION_FIELDS = ["sourceDiagnosisId", "requestKey"];
/**
* Every reason a coordination request cannot be a recovery request at all: an
* unknown field (a caller may not smuggle a decision in), or a missing identity.
* Structural only — whether the named diagnosis exists, whether the caller is the
* hand-off's supervisor and whether the source may be recovered are answered
* after this, each as its own named refusal.
*/
function recoveryCoordinationDefects(request) {
	if (request === null || typeof request !== "object" || Array.isArray(request)) return ["the request must be an object carrying sourceDiagnosisId and requestKey"];
	const defects = [];
	for (const key of Object.keys(request)) if (!RECOVERY_COORDINATION_FIELDS.includes(key)) defects.push(`unknown field "${key}": a recovery request carries ${RECOVERY_COORDINATION_FIELDS.join(", ")} and nothing else — an approval, a decision or a permission is never part of what a caller passes`);
	const fields = request;
	for (const name of RECOVERY_COORDINATION_FIELDS) {
		const value = fields[name];
		if (typeof value !== "string" || value.trim().length === 0) defects.push(`${name} must be a non-empty string`);
	}
	return defects;
}
/**
* The failed run one diagnosis is about, as the store holds it: the run its own
* `reviewRefs` name (`<taskId>#<runId>`, or `<taskId>#no-run` for the failure
* that had none), else the source task's newest run that settled `failed`, else
* `null` when the task holds no run at all (a task blocked before it started).
*
* It mirrors the hand-off's own ref convention rather than reading it from the
* tool package, and it is only a *derivation*: the runtime answers the same
* question from its own store and refuses a run that is not that task's or not
* failed, so a wrong guess here can never become an attempt.
*/
function recoverySourceRunId(diagnosis, source, snapshot) {
	for (const ref of diagnosis.reviewRefs) {
		const separator = ref.lastIndexOf("#");
		if (separator < 0 || ref.slice(0, separator) !== diagnosis.taskId) continue;
		const runId = ref.slice(separator + 1);
		if (runId === "no-run") return null;
		if (snapshot.runs.find((item) => item.runId === runId && item.taskId === diagnosis.taskId)?.status === "failed") return runId;
	}
	return [...snapshot.runs].reverse().find((run) => run.taskId === source.taskId && run.status === "failed")?.runId ?? null;
}
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
	/** The injected supervisor-delegation source, if the assembly wired one (see {@link Config.supervisorDelegation}). */
	resolveSupervisorDelegation;
	/** The deployment's capability table file, when it named one (see {@link Config.capabilityConfig}). */
	capabilityConfigPath;
	/** The capability-config write's typed test seam, when this instance was built with one (see {@link Config.capabilityConfigProbe}). */
	capabilityConfigProbe;
	records = [];
	loaded;
	writes = Promise.resolve();
	commits = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "evolution");
		this.repoRoot = config.repoRoot ?? process.cwd();
		this.resolveModelSelection = config.modelSelection;
		this.commitProbe = config.commitProbe;
		this.resolveSupervisorDelegation = config.supervisorDelegation;
		this.capabilityConfigPath = config.capabilityConfig === void 0 ? void 0 : resolve(config.capabilityConfig);
		this.capabilityConfigProbe = config.capabilityConfigProbe;
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
	* **A skill candidate or a capability candidate** (§F.2, A6): a capability
	* mutation is exactly one whole row (`rows` holding one entry) plus an optional
	* new execution skill, and every rule about what that row and that skill may
	* say runs at prepare, against the store the candidate would land in — this
	* step only refuses shapes. An agent_preset, task_definition or
	* bookkeeping-only proposal stays the recorded suggestion `evolution_propose`
	* wrote and is refused here by name, before the first ledger line of the
	* candidate lifecycle. Its proposal keeps its place in the ledger — a record is
	* not a candidate.
	*/
	async candidate(proposalId, versionSet, actor, mutation) {
		const current = await this.assertNext(proposalId, "candidate");
		if (current.targetType !== "skill" && current.targetType !== "capability") throw new Error(`evolution: proposal "${proposalId}" targets "${current.targetType}", which cannot become a candidate in this build — the candidate lifecycles here are a SKILL.md replacement of an existing skill object (evolution_prepare → the two-sided experiment evolution_replay → evolution_gate → evolution_apply) and one whole capability row with an optional new execution skill (A6), so its proposal stays a recorded proposal`);
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
		if (current.targetType === "capability") return this.prepareCapability(current, actor);
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
	* Move candidate → prepared for a **capability candidate** (A6): freeze the one
	* row it changes and the new execution skill it may add into
	* `<root>/sandbox/<proposalId>/`, and record the identities a later promotion,
	* commit and rollback re-prove.
	*
	* Every rule runs before the first byte is written, against the store as it
	* stands right now: the row must grant no tool the store has not authorized,
	* must not move the preset, permission or server plane, the new skill's
	* verifier must be registered *and versioned*, its required tools must be
	* inside the same authorized plane, its name must not be a production object
	* this deployment discovers, and its bytes must not be a rename of one
	* (`assertCapabilityCandidateAdmissible`). The row's own admission pre-check
	* (`precheckReplacedCapabilityRow`) runs next, with the sandbox skill root in
	* front of production discovery, so the skill is judged from the exact bytes
	* this prepare just materialized — a refusal removes the sandbox and records
	* nothing, which is what "refused with zero writes" means here.
	*
	* What is materialized is the candidate row's canonical bytes
	* (`capability/<name>.json`), the champion row's bytes when the store held one
	* (`champion/capability/<name>.json` — the anchor a rollback restores), and the
	* new skill's two files under `skills/<name>/`. The recorded identity is the
	* row (its data plus the digest of those bytes) and the store's row at prepare
	* (`null` when it held none: this candidate adds the row), together with the
	* new skill's whole-object content identity and the recorded *absence* of a
	* production object for it — a capability candidate adds a skill, and
	* improving an existing one is the same-name path. The deployment's table file
	* is read once, beside the store, and its composed identity is frozen with all
	* of them ({@link PreparedView.capabilityTable}): three whole-file digests —
	* the file as read, and the files this proposal's own apply and rollback leave
	* — so a commit writes into that file only while it reads as one of those.
	*/
	async prepareCapability(current, actor) {
		const proposalId = current.proposalId;
		const candidate = validateCapabilityMutation(current.mutation);
		const store = await this.capabilityStore();
		const baselineEntry = store.table[candidate.row.name] ?? null;
		await assertCapabilityCandidateAdmissible(store, candidate, baselineEntry);
		const capabilityTable = this.capabilityConfigPath === void 0 ? void 0 : capabilityTableIdentity({
			text: await this.capabilityTableText(),
			file: this.capabilityConfigPath,
			name: candidate.row.name,
			entry: candidate.row.entry,
			restored: baselineEntry
		});
		const dir = join(this.root, "sandbox", proposalId);
		const sandbox = `sandbox/${proposalId}`;
		const rowRelative = `capability/${candidate.row.name}.json`;
		const championRelative = `champion/capability/${candidate.row.name}.json`;
		const files = [];
		const write = async (rel, content) => {
			const abs = resolveWithin(dir, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content);
			files.push(rel);
		};
		await write(rowRelative, capabilityRowBytes(candidate.row.entry));
		if (baselineEntry !== null) await write(championRelative, capabilityRowBytes(baselineEntry));
		if (candidate.skill !== void 0) {
			await write(`skills/${candidate.skill.name}/SKILL.md`, Buffer.from(candidate.skill.content, "utf8"));
			await write(`skills/${candidate.skill.name}/${SKILL_SIDECAR_FILE}`, serializeSkillSidecar(candidate.skill.sidecar));
		}
		const refusals = await this.capabilityRowRefusals(candidate.row, candidate.skill === void 0 ? void 0 : join(dir, "skills")).catch(async (error) => {
			await rm(dir, {
				recursive: true,
				force: true
			});
			throw error;
		});
		if (refusals.length > 0) {
			await rm(dir, {
				recursive: true,
				force: true
			});
			throw new Error(`evolution: skill-candidate-invalid: capability candidate "${proposalId}" grants providers this deployment refuses — ${refusals.join("; ")}; the sandbox was removed and nothing was recorded`);
		}
		const rowBytes = await readVerifiedFile(this.root, `${sandbox}/${rowRelative}`);
		const capabilityRow = capabilityRowIdentity({
			name: candidate.row.name,
			entry: candidate.row.entry
		});
		if (sha256Hex(rowBytes) !== capabilityRow.digest) throw new Error(`evolution: the frozen row "${rowRelative}" of proposal "${proposalId}" does not hash to the identity just recorded (sha256 ${sha256Hex(rowBytes)} != ${capabilityRow.digest}) — nothing this plane writes may be unreproducible`);
		const capabilityBaseline = baselineEntry === null ? null : capabilityRowIdentity({
			name: candidate.row.name,
			entry: baselineEntry
		});
		let skillContent;
		if (candidate.skill !== void 0) {
			const skillMd = await readVerifiedFile(this.root, `${sandbox}/skills/${candidate.skill.name}/SKILL.md`);
			const sidecarBytes = await readVerifiedFile(this.root, `${sandbox}/skills/${candidate.skill.name}/${SKILL_SIDECAR_FILE}`);
			skillContent = {
				name: candidate.skill.name,
				sha256: sha256Hex(skillMd),
				contract: contractIdentityOf(sidecarBytes)
			};
		}
		await this.append({
			formatVersion: 4,
			kind: "prepared",
			proposalId,
			sandbox,
			mechanical: true,
			champion: "absent",
			...skillContent === void 0 ? {} : { skillContent },
			...skillContent === void 0 ? {} : { skillBaseline: null },
			capabilityRow,
			capabilityBaseline,
			...capabilityTable === void 0 ? {} : { capabilityTable },
			files,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* The capability table's own text (A6), read at prepare: the file the composed
	* identity is frozen from. A deployment that names no table file has nothing to
	* freeze ({@link prepareCapability} records none, and a capability commit
	* refuses by name when it reaches the table write); a file this deployment names
	* but that cannot be read refuses here, before the candidate is materialized or
	* recorded, because a table nothing can read is a table no later commit can
	* prove it left alone.
	*/
	async capabilityTableText() {
		const file = this.capabilityConfigPath;
		try {
			return await readFile(file, "utf8");
		} catch (error) {
			throw new Error(`evolution: the capability table "${file}" this deployment names cannot be read (${error instanceof Error ? error.message : String(error)}), so the file a later apply writes its row into cannot be frozen — nothing was materialized, nothing was recorded and no row was changed; configure a readable capability table file (Config.capabilityConfig) and prepare again`);
		}
	}
	/**
	* The store a capability candidate is judged against: the running registry
	* (the table a restart re-reads from the deployment's configuration), the
	* registered verifier vocabulary — fail-closed when it cannot be listed — and
	* every root discovery searches, the production skill root first because this
	* plane is its writer.
	*/
	async capabilityStore() {
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error("evolution: the effective capability registry cannot be read in this context (no task-runtime service, or its listCapabilities failed), so a capability row cannot be prepared, promoted or written — the candidate would be judged against a table nobody can read, and nothing was changed");
		const vocabulary = await registeredVerifierVocabulary(this.ctx);
		return {
			table,
			...vocabulary === void 0 ? {} : { verifierVocabulary: {
				ids: vocabulary.ids,
				versions: vocabulary.versions
			} },
			skillRoots: await this.skillDiscoveryRoots(),
			skillRoot: this.skillRoot
		};
	}
	/** Every root a worker's own discovery searches, the production skill root this plane writes first. */
	async skillDiscoveryRoots() {
		return [this.skillRoot, ...await skillSearchRoots({ cwd: process.cwd() })];
	}
	/**
	* The row as it would read after the write, judged by the admission pre-check
	* itself (`precheckReplacedCapabilityRow`): every skill it declares must be a
	* loadable provider, discovered from `sandboxSkillRoot` when the candidate
	* carries a new one and from the deployment's own roots otherwise, and judged
	* against the same verifier vocabulary and capability table admission uses.
	* The deployment's evolution ledger is passed in, so a provider whose
	* directory another proposal's commit left open is refused here too — asking
	* admission's own question instead of restating it.
	*/
	async capabilityRowRefusals(row, sandboxSkillRoot) {
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error("evolution: the effective capability registry cannot be read in this context, so the capability row cannot be pre-checked — nothing was changed");
		const verifierRefs = await registeredVerifierIds(this.ctx);
		const { refusals } = await precheckReplacedCapabilityRow({
			name: row.name,
			entry: row.entry,
			table,
			view: {
				cwd: process.cwd(),
				...sandboxSkillRoot === void 0 ? {} : { extraRoots: [sandboxSkillRoot] }
			},
			...verifierRefs === void 0 ? {} : { verifierRefs },
			commitLedger: this
		});
		return refusals;
	}
	/**
	* Move prepared → gated: all six Gate answers plus regression evidence refs.
	* Every ref must exist — a path on disk (relative to the repo root or
	* absolute) or an id the caller-side resolver knows (task-store evidence).
	* Existence only; nothing here executes anything. A **skill** proposal must
	* have a completed two-sided experiment and cite that experiment's report
	* (§F.2); the six answers are recorded over it. A **capability** proposal (A6)
	* gates the same way — its two-sided experiment must be complete and its report
	* cited, and the promotion evidence gate reads the same facts — except that a
	* capability sample's baseline side may be the runtime's own `not-admitted`
	* refusal, which no report of a skill experiment ever carries.
	*/
	async gate(proposalId, answers, actor, refKnown) {
		const current = await this.assertNext(proposalId, "gated");
		validateGateAnswers(answers);
		let experimentReport;
		if (current.targetType === "skill" || current.targetType === "capability") {
			const [experiment] = await this.experiments(proposalId);
			if (experiment === void 0) throw new Error(`evolution: ${current.targetType} proposal "${proposalId}" has no two-sided experiment — the gate answers must rest on both sides of every frozen sample, so evaluate the candidate with evolution_replay before gating it`);
			try {
				buildExperimentReport(experiment);
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)} — a ${current.targetType} candidate gates on a completed experiment only; resume experiment ${experiment.experimentId} (evolution_replay) before answering the gate`);
			}
			experimentReport = experiment.report;
		}
		if (experimentReport !== void 0) {
			if (!answers.regressionEvidenceRefs.includes(experimentReport)) throw new Error(`evolution: a ${current.targetType} candidate's regression evidence must cite its experiment report "${experimentReport}" — the six answers are answered over that experiment, and the gate records the evidence they rest on`);
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
	* skill or capability mutation at L1–L3 (the state machine itself refuses
	* anything else — every other target type has no executor in this build); the
	* caller (the evolution_apply tool) must hold a human grant from
	* `ctx.approval.request` first, exactly as for decide. The candidate object's
	* fixed file set replaces production's — `SKILL.md` and, when the object
	* carries an execution sidecar, the derived `SKILL.contract.json` (the
	* champion snapshot covers those files only, so the write is file-level, never
	* a directory delete).
	*
	* A **capability** apply (A6) writes the new skill's files where production
	* holds nothing and installs the one row that grants them, as that same single
	* commit: the row's two states ride on the same `commit_intent` line, the files
	* are written first and the row last, and the `applied` record lands only once
	* the object loads and the registry reads the row this direction installed.
	* The registry check is the row's own baseline check — a row a third party
	* moved, and a skill name that appeared where the candidate adds one, are both
	* refused by name with nothing written.
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
			const request = this.commitRequest(proposal, "apply", actor, approvalRef);
			const bytes = proposal.targetType === "capability" ? await this.capabilityBytes(proposal, "apply") : await (async () => {
				const candidate = await this.readVerifiedSkillCandidate(proposal);
				return [candidate.skillMd, ...candidate.sidecar === void 0 ? [] : [candidate.sidecar]];
			})();
			await commitIntent(this.commitHost(), request, bytes);
			return {
				targets: request.files.map((file) => file.target),
				providers: promotion.providers,
				proposal: await this.get(proposalId)
			};
		});
	}
	/**
	* The verified bytes one capability commit writes, in the request's file order:
	* for an **apply** the new skill's two sandbox files (nothing to carry for a
	* row-only candidate), for a **rollback** nothing at all — the files of a new
	* object are removed, and a removal has no bytes to write again. Every byte is
	* read through {@link readPreparedCapability}, so what is committed is what the
	* prepared identity froze.
	*/
	async capabilityBytes(proposal, direction) {
		const content = proposal.prepared?.skillContent;
		if (content === void 0) return [];
		if (direction === "rollback") return content.contract === void 0 ? [void 0] : [void 0, void 0];
		const prepared = await readPreparedCapability(this.root, proposal);
		if (prepared.skill === void 0) throw new Error(`evolution: capability proposal "${proposal.proposalId}" commits a file set but its prepared identity records no readable new skill — the two cannot both be true, so nothing was written`);
		return [prepared.skill.skillMd, prepared.skill.sidecarBytes];
	}
	/**
	* Preflight for tools before asking for approval; mutation methods repeat the
	* check. Returns the providers the promotion would put in place, each with the
	* role it may be counted as, so the callers that already gate on this check
	* can report them.
	*
	* A `skill` proposal and — since A6 — a `capability` proposal are promotable in
	* this build; every other target type is refused by name, because a type with
	* no evaluator gets no promotion and a record of one is never upgraded into new
	* evidence ({@link noEvaluatorRefusal}).
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
	*
	* For a capability candidate the whole gate is
	* `assertCapabilityPromotionEvidence` (see `promotion.ts`): the frozen row and
	* the new skill re-read and re-verified against the identities prepare
	* recorded, the registry row still reading as the baseline prepare captured,
	* every candidate rule still holding against the store as it stands now, every
	* provider the row declares loadable under the admission pre-check — and the
	* two-sided capability experiment (§F.4 "评估/应用必须同组补齐"): the frozen
	* identity, the report file, and each sample's sides re-read from the store, so
	* a `not-admitted` baseline the runtime really refused and a candidate run that
	* really passed are the only evidence a capability PROMOTE rests on.
	*/
	async checkPromotion(proposalId) {
		const proposal = await this.get(proposalId);
		if (proposal.targetType === "capability") return this.checkCapabilityPromotion(proposal);
		if (proposal.targetType !== "skill") throw noEvaluatorRefusal(proposal);
		if (proposal.prepared?.mechanical !== true || proposal.prepared.sandbox == null) throw new Error(`evolution: skill proposal "${proposal.proposalId}" has no materialized candidate — nothing this proposal names was ever evaluated; record a structured candidate and prepare it (evolution_candidate / evolution_prepare) before promoting it`);
		await this.readVerifiedSkillCandidate(proposal);
		const providers = [await this.assertSkillCandidateProvider(proposal)];
		await assertSkillPromotionEvidence(this.promotionSources(), proposal);
		return { providers };
	}
	/**
	* The capability promotion gate, plus the one report a tool needs from it: the
	* provider role of the new skill the candidate installs, judged from the
	* sandbox directory against the table the row would produce — the same
	* validator admission runs, with the row this commit installs already folded
	* in, so the verdict is about the deployment the apply would create rather than
	* the one before it.
	*/
	async checkCapabilityPromotion(proposal) {
		await assertCapabilityPromotionEvidence(this.capabilityPromotionSources(), proposal);
		const prepared = await readPreparedCapability(this.root, proposal);
		if (prepared.skill === void 0 || prepared.skillDirectory === void 0) return { providers: [] };
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error(`evolution: the effective capability registry cannot be read in this context, so the provider role of capability candidate "${proposal.proposalId}" cannot be judged — nothing was promoted`);
		const verdict = await this.providerVerdict({
			name: prepared.skill.name,
			directory: prepared.skillDirectory,
			sidecar: prepared.skill.sidecar
		}, capabilityTableWith(table, prepared.row));
		if (!verdict.valid) throw new Error(`evolution: the new skill "${prepared.skill.name}" of capability candidate "${proposal.proposalId}" is not a usable provider — ${verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ")}; a promotion installs only a provider a worker could load and whose verifier and tools the deployment can grant`);
		return { providers: [promotionProviderOf(verdict)] };
	}
	/**
	* The store and the row pre-check a capability promotion reads, resolved from
	* this context: the effective registry, the registered verifier vocabulary and
	* the roots discovery searches (all through {@link capabilityStore}), plus the
	* same admission pre-check prepare ran — once more, against the store as it
	* stands at the gate, with the candidate's sandbox skill root in front of
	* production discovery.
	*
	* Since A6's evaluation interface the gate also reads the experiment evidence,
	* so it resolves the same four services the skill gate does
	* ({@link promotionSources}): the ledger's experiment family, the task store
	* the runs live in, the live judge vocabulary, this deployment's selection and
	* its session logs. One wiring, so the two gates cannot read different facts.
	*/
	capabilityPromotionSources() {
		return {
			...this.promotionSources(),
			store: () => this.capabilityStore(),
			rowRefusals: (row, sandboxSkillRoot) => this.capabilityRowRefusals(row, sandboxSkillRoot)
		};
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
	*
	* `table` is the table the candidate is judged against, and it is a parameter
	* only because a capability candidate's new skill must be judged against the
	* table *its own row would produce* (A6): the row is not in the deployment's
	* registry yet — the commit that installs it is what this promotion check is a
	* preflight for — so judging it against the table before the write would refuse
	* every provider that closes the very gap the candidate exists for. Every other
	* caller passes nothing and reads the deployment's own registry.
	*/
	async providerVerdict(candidate, table = this.effectiveCapabilities()) {
		const verifierRefs = await registeredVerifierIds(this.ctx);
		if (verifierRefs === void 0 && candidate.directory !== void 0) {
			const loaded = await loadSkillSidecar(candidate.directory);
			if (loaded.sidecar?.type === "execution") return unlistableVerifierRefusal(candidate.name, candidate.directory, loaded.sidecar.verifier.ref);
		}
		return validateSkillProvider(candidate, {
			verifierRefs: verifierRefs === void 0 ? [] : [...verifierRefs],
			capabilityTools: this.capabilityToolAnswer(table)
		});
	}
	/**
	* The capability table this service judges providers against: by default the
	* running registry, which is the table a restart re-reads from `config.yml` and
	* the one `evolution_prepare` snapshots the champion from. Absent (no
	* task-runtime in this context) means the table cannot be read — reported as an
	* unreadable grant rather than mistaken for an empty table.
	*/
	capabilityToolAnswer(table = this.effectiveCapabilities()) {
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
	* Read a prepared **capability** candidate back out of its sandbox and verify
	* every byte against the identities prepare recorded (A6): the frozen row, the
	* champion row when the registry held one, and the new skill's two files when
	* the candidate carries one. The one read path the experiment's freeze, the
	* promotion gate and the apply write share, so what is evaluated, promoted and
	* committed is provably the same bytes.
	*/
	async readCapabilityCandidate(proposalId) {
		return readPreparedCapability(this.root, await this.get(proposalId));
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
	* a third party's edit like any other.
	*
	* A **capability** candidate's baseline is the registry row it read at prepare
	* (and the absence of a production object for its new skill, A6): the row must
	* still read exactly as prepare recorded it — or still be absent, for a row this
	* candidate adds — and the new skill's name must still be free. Either conflict
	* refuses by name with nothing written; a target type this build has no
	* executor for passes untouched.
	*/
	async checkProductionBaseline(proposalId) {
		const proposal = await this.get(proposalId);
		if (proposal.targetType === "capability") return this.assertCapabilityBaseline(proposal);
		await this.assertProductionBaseline(proposal);
	}
	/**
	* The capability candidate's production baseline (A6): the registry row this
	* proposal read at prepare must still read exactly the same — a row a third
	* party replaced, added or removed is a conflict, not a candidate — and the
	* new skill's name must still be free where discovery looks. Nothing here
	* writes or merges; a conflict only throws, before the commit intent exists.
	*/
	async assertCapabilityBaseline(proposal) {
		const prepared = proposal.prepared;
		if (prepared?.mechanical !== true || prepared.sandbox == null) return;
		const identity = prepared.capabilityRow;
		if (identity === void 0) throw new Error(`evolution: capability proposal "${proposal.proposalId}" records no frozen row identity — create a new candidate from the current registry state and re-evaluate it`);
		const guidance = "create a new candidate from the current registry state and re-evaluate it; an apply never overwrites a registry row it cannot verify";
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error(`evolution: capability-registry-unreadable: the effective capability registry cannot be read in this context, so the row "${identity.name}" proposal "${proposal.proposalId}" was prepared against cannot be compared — nothing was written; ${guidance}`);
		const currentEntry = table[identity.name] ?? null;
		const currentDigest = currentEntry === null ? null : capabilityRowDigest(currentEntry);
		const baseline = prepared.capabilityBaseline ?? null;
		const preparedDigest = baseline === null ? null : baseline.digest;
		if (currentDigest !== preparedDigest) throw new Error(`evolution: capability-registry-changed: the registry row "${identity.name}" reads ${currentDigest === null ? "no row" : `sha256 ${currentDigest}`} since prepare (recorded: ${preparedDigest === null ? "no row" : `sha256 ${preparedDigest}`}) — a row a third party moved is a conflict, so nothing was written; ${guidance}`);
		const skill = prepared.skillContent;
		if (skill === void 0) return;
		const found = await discoverSkill(await this.skillDiscoveryRoots(), skill.name);
		if (found !== void 0) throw new Error(`evolution: skill-baseline-changed: the production skill "${skill.name}" this candidate adds appeared at "${found}" since prepare — this candidate installs a new object and never covers a same-name one, so nothing was written; ${guidance}`);
	}
	async assertProductionBaseline(proposal) {
		if (proposal.targetType !== "skill") return;
		const prepared = proposal.prepared;
		if (prepared?.mechanical !== true || prepared.sandbox == null) return;
		const { name } = proposal.mutation;
		const target = `${this.skillRoot}/${name}/SKILL.md`;
		const guidance = "create a new candidate from the current production state and re-evaluate it; an apply never overwrites a production skill it cannot verify";
		const identity = prepared.skillBaseline;
		if (identity === void 0 || identity === null) throw new Error(`evolution: skill proposal "${proposal.proposalId}" records no production baseline identity — ${guidance}`);
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
	* same way, including between the two files of one object. A **capability**
	* apply is undone by the same entry (A6): the registry row goes back to the row
	* prepare recorded — or is removed, when this candidate added it — and the new
	* skill's files are removed, because they did not exist before this proposal. A
	* record of another target type has no executor here: an applied preset
	* directory is refused by name rather than touched. Same approval discipline as
	* apply: the tool asks a human first, the service only executes and records.
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
	* proposal that commits the same skill directory — or moves the same capability
	* row — refuses this rollback by name before anything is read or written
	* ({@link assertTargetUncommitted}).
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
			if (proposal.targetType === "capability") {
				await this.assertCapabilityApplied(proposal, request);
				await commitIntent(this.commitHost(), request, await this.capabilityBytes(proposal, "rollback"));
				return {
					targets: request.files.map((file) => file.target),
					proposal: await this.get(proposalId)
				};
			}
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
	* What a capability rollback must still find before it may be recorded (A6):
	* the registry row this proposal installed, and — when it installs a new skill
	* — the files it applied. A row (or file) another writer or a later proposal
	* changed since is refused by name with nothing written and no intent recorded;
	* a rollback restores *this* proposal's baseline and never overwrites a newer
	* state.
	*/
	async assertCapabilityApplied(proposal, request) {
		const prepared = proposal.prepared;
		const identity = prepared.capabilityRow;
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error(`evolution: the effective capability registry cannot be read in this context, so the row proposal "${proposal.proposalId}" applied cannot be compared — nothing was written and no commit intent was recorded`);
		const current = table[identity.name] ?? null;
		const digest = current === null ? null : capabilityRowDigest(current);
		if (digest !== identity.digest) throw new Error(`evolution: the registry row "${identity.name}" does not hold the row proposal "${proposal.proposalId}" applied (${digest === null ? "no row" : `sha256 ${digest}`} != sha256 ${identity.digest}) — a rollback restores the baseline of the state this proposal installed, and a row another writer (or a later proposal) changed is left exactly as it is: nothing was written and no commit intent was recorded`);
		for (const [index, file] of request.files.entries()) {
			const expected = index === 0 ? prepared.skillContent.sha256 : prepared.skillContent.contract.sha256;
			const currentFile = await readProductionSkill(this.skillRoot, relative(this.skillRoot, file.target));
			if (currentFile === null || currentFile.sha256 !== expected) throw new Error(`evolution: the production file "${file.target}" does not hold the content proposal "${proposal.proposalId}" applied (sha256 ${currentFile?.sha256 ?? "missing"} != ${expected}) — a file another writer (or a later proposal) changed is left exactly as it is: nothing was written and no commit intent was recorded`);
		}
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
	/**
	* The capability rows a commit has left open (A6), in ledger order — the
	* sibling of {@link openIntentTargets} for the half of a capability commit
	* that is not a file. A row-only candidate (an L1 one that composes the
	* deployment's existing providers) has an empty file set, so nothing about it
	* can be keyed on a directory; and a candidate that also carries a new skill
	* moves its row *last*, after the files, so a commit stopped between the two
	* leaves a registry row nothing else names.
	*
	* The same fold, over the same open intents: one intent list, two projections,
	* so an admission gate that reads both cannot see two different pictures of
	* what is in flight. Pure, like its sibling — a read never settles anything.
	*/
	async openIntentCapabilities() {
		await this.loaded;
		const rows = [];
		for (const intent of this.openIntents(this.fold(this.records))) {
			const name = intent.capability?.name;
			if (name !== void 0 && !rows.includes(name)) rows.push(name);
		}
		return rows;
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
		if (proposal.targetType === "capability") return this.capabilityCommitRequest(proposal, direction, actor, approvalRef);
		if (proposal.targetType !== "skill") throw new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}" — this build writes and restores the fixed file set of one skill object and moves one capability row, so there is no executor to ${direction} an applied ${proposal.targetType} record`);
		const prepared = proposal.prepared;
		const content = prepared?.skillContent;
		const baseline = prepared?.skillBaseline;
		if (prepared?.sandbox == null || prepared.champion !== "captured" || proposal.mutation === void 0 || content === void 0 || baseline === void 0 || baseline === null) throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`);
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
	* The commit one capability candidate binds (A6): the one row it moves, and —
	* when it carries a new skill — that skill's two files, as a create on apply
	* (`baselineSha256: null`: the target must not exist) and a removal on rollback
	* (`contentSha256: null`, no source: there are no bytes to write again). The
	* row's two sides mirror the files': an apply installs the candidate row over
	* the recorded baseline (or over the absence of any row), a rollback restores
	* the baseline row — or removes the row this candidate added. The request is
	* read off the prepared record only, so what the intent says is what prepare
	* froze.
	*/
	capabilityCommitRequest(proposal, direction, actor, approvalRef) {
		const prepared = proposal.prepared;
		const row = proposal.mutation === void 0 ? void 0 : validateCapabilityMutation(proposal.mutation).row;
		if (prepared?.sandbox == null || prepared.capabilityRow === void 0 || row === void 0 || prepared.capabilityBaseline === void 0) throw new Error(`evolution: capability proposal "${proposal.proposalId}" has no materialized candidate (its frozen row, its mutation and the baseline it read are all required), so there is nothing to ${direction}`);
		const sandbox = prepared.sandbox;
		const baseline = prepared.capabilityBaseline;
		const capability = direction === "apply" ? {
			name: prepared.capabilityRow.name,
			baselineSha256: baseline === null ? null : baseline.digest,
			contentSha256: prepared.capabilityRow.digest,
			source: `${sandbox}/capability/${prepared.capabilityRow.name}.json`
		} : {
			name: prepared.capabilityRow.name,
			baselineSha256: prepared.capabilityRow.digest,
			contentSha256: baseline === null ? null : baseline.digest,
			...baseline === null ? {} : { source: `${sandbox}/champion/capability/${prepared.capabilityRow.name}.json` }
		};
		const files = [];
		const content = prepared.skillContent;
		if (content !== void 0) {
			if (content.contract === void 0) throw new Error(`evolution: capability proposal "${proposal.proposalId}" records a new skill without a declaration, and a capability candidate's skill is an execution provider — the object prepare froze is not one this build writes`);
			const targets = this.commitTargets(proposal);
			files.push(direction === "apply" ? {
				target: targets[0],
				baselineSha256: null,
				contentSha256: content.sha256,
				source: `${sandbox}/skills/${content.name}/SKILL.md`
			} : {
				target: targets[0],
				baselineSha256: content.sha256,
				contentSha256: null
			});
			files.push(direction === "apply" ? {
				target: targets[1],
				baselineSha256: null,
				contentSha256: content.contract.sha256,
				source: `${sandbox}/skills/${content.name}/${SKILL_SIDECAR_FILE}`
			} : {
				target: targets[1],
				baselineSha256: content.contract.sha256,
				contentSha256: null
			});
		}
		return {
			proposalId: proposal.proposalId,
			direction,
			approvalRef,
			files,
			capability,
			actor
		};
	}
	/**
	* The production paths a commit of this proposal may write: for a skill
	* candidate the object's fixed file set under `<skillRoot>/<name>/` —
	* `SKILL.md` always, and the `SKILL.contract.json` beside it when the prepared
	* identity records an execution sidecar; for a capability candidate the new
	* skill's two files, or none for a row-only candidate. Each path is confined to
	* the skill root, in commit order.
	*/
	commitTargets(proposal) {
		const name = proposal.targetType === "capability" ? proposal.prepared?.skillContent?.name : proposal.mutation.name;
		if (name === void 0) return [];
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
	* Only a materialized skill or capability mutation has commit targets this
	* build may write: every other proposal keeps the named refusal its own entry
	* produces ({@link checkPromotion}, {@link commitRequest}). A capability
	* candidate's row is a second object of the same kind: the same row moved by
	* two proposals at once is refused here as well, before either intent exists,
	* because the second would find the first's row where its own baseline check
	* expects the state it read.
	*/
	assertTargetUncommitted(proposal) {
		if (proposal.targetType !== "skill" && proposal.targetType !== "capability" || proposal.mutation === void 0) return;
		const directories = new Set(this.commitTargets(proposal).map((target) => dirname(target)));
		const rowName = proposal.prepared?.capabilityRow?.name;
		for (const other of this.fold(this.records).values()) {
			const intent = other.openIntent;
			if (intent === void 0 || other.proposalId === proposal.proposalId) continue;
			const shared = intent.files.map((file) => dirname(resolve(file.target))).find((directory) => directories.has(directory));
			if (shared !== void 0) throw new Error(`evolution: the open commit intent "${intent.intentId}" of proposal "${other.proposalId}" (direction "${intent.direction}") commits the production skill directory "${shared}" — proposal "${proposal.proposalId}" does not commit over another proposal's unsettled intent; settle that intent first (reconcile, or a retry of the proposal that owns it): nothing was written and no commit intent was recorded`);
			if (rowName !== void 0 && intent.capability?.name === rowName) throw new Error(`evolution: the open commit intent "${intent.intentId}" of proposal "${other.proposalId}" (direction "${intent.direction}") moves the capability row "${rowName}" — proposal "${proposal.proposalId}" does not move a row another proposal's unsettled intent already owns; settle that intent first (reconcile, or a retry of the proposal that owns it): nothing was written and no commit intent was recorded`);
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
	*
	* Two more states come from A6, and both are answered about the *directory*
	* rather than the files, for the same reason: a file set whose baseline is the
	* **absence** of the object (an apply that creates a new skill) may only write
	* where production holds nothing but this object's own staging leftovers, and a
	* file set whose content is that absence (the rollback that removes it) may
	* only remove files from a directory that holds exactly those files — anything
	* else in either place is an entry this commit never created and must not touch.
	*/
	async objectWriteRefusal(intent) {
		if (intent.files.length === 0) return null;
		const skillMd = intent.files[0];
		const directory = dirname(skillMd.target);
		const own = new Set(intent.files.map((file) => basename(file.target)));
		const staging = [...own].map((name) => `.${name}.tmp-`);
		const creates = intent.files.every((file) => file.baselineSha256 === null);
		const removes = intent.files.every((file) => file.contentSha256 === null);
		if (!creates && !removes && intent.files.some((file) => file.baselineSha256 === null || file.contentSha256 === null)) return "the fixed file set of one skill object is created or removed whole, and this intent mixes a file with a production state and a file without one";
		const listDirectory = async () => {
			try {
				return await readdir(directory, { withFileTypes: true });
			} catch (error) {
				return error instanceof Error && error.code === "ENOENT" ? [] : `the production directory "${directory}" cannot be read to check what it holds (${error instanceof Error ? error.message : String(error)}) — the entries this commit would leave beside its own are unknown`;
			}
		};
		if (creates || removes) {
			const entries$1 = await listDirectory();
			if (typeof entries$1 === "string") return entries$1;
			const foreign$1 = entries$1.filter((entry) => !own.has(entry.name) && !(staging.some((prefix) => entry.name.startsWith(prefix)) && !entry.isDirectory())).map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name).sort();
			if (foreign$1.length === 0) return null;
			return creates ? `this commit creates the skill object "${directory}" where nothing was, and the directory already holds ${foreign$1.length} entr${foreign$1.length === 1 ? "y" : "ies"} (${foreign$1.map((name) => JSON.stringify(name)).join(", ")}) — a new object is written where production holds nothing, so a directory carrying anything else is not the state this intent describes` : `this commit removes the files of skill object "${directory}" (${[...own].sort().map((name) => JSON.stringify(name)).join(", ")}), and the directory holds ${foreign$1.length} entr${foreign$1.length === 1 ? "y" : "ies"} the intent does not name (${foreign$1.map((name) => JSON.stringify(name)).join(", ")}) — a removal takes back what this candidate created and leaves everything else exactly where it is, so a directory holding more is not one this intent may empty`;
		}
		if (intent.files.length === 1) {
			const loaded = await loadSkillSidecar(directory);
			if (loaded.sidecar !== void 0) return `the guidance object this intent commits is the single file "${basename(skillMd.target)}", and the directory now carries a ${SKILL_SIDECAR_FILE} the intent does not name — it is an execution object the committed file set does not describe`;
			const resources = loaded.content?.resources.map((resource) => resource.path) ?? [];
			if (resources.length > 0) return `the guidance object this intent commits is the single file "${basename(skillMd.target)}", and the directory now holds ${resources.length} file(s) at a supported resource position the intent does not name (${resources.map((path) => JSON.stringify(path)).join(", ")}) — nothing declares them and no commit of this build writes them`;
			if (loaded.defects.length > 0) return "the directory is not the loadable object its files claim — " + loaded.defects.map((item) => `${item.code}: ${item.detail}`).join("; ");
			return null;
		}
		const entries = await listDirectory();
		if (typeof entries === "string") return entries;
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
	* (what the directory must be before anything is written, what it is after,
	* and whether the capability table a row would be written into is still the
	* file prepare froze), and the probe seam. The commit path owns the order; the
	* service owns what may be read, what a line must say, and what "production is
	* the object this direction promised" means.
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
			tableWriteRefusal: (intent) => this.tableWriteRefusal(intent),
			verifyCommitted: (intent) => this.verifyCommitted(intent),
			capability: {
				read: async (name) => {
					const table = this.effectiveCapabilities();
					if (table === void 0) throw new Error("the effective capability registry cannot be read in this context, so the row a commit would move cannot be compared against the state it recorded");
					return table[name] ?? null;
				},
				apply: async (intent, entry) => {
					const runtime = optionalService(this.ctx, "taskRuntime");
					if (runtime?.applyCapabilityRow === void 0) throw new Error("this deployment offers no capability-registry entry (taskRuntime.applyCapabilityRow), so the row this commit carries cannot be installed");
					await runtime.applyCapabilityRow(intent.capability.name, entry, {
						commitTargets: intent.files.map((file) => file.target),
						commitRow: intent.capability.name
					});
				}
			},
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
		await this.verifyCommittedFiles(intent);
		await this.verifyCommittedRow(intent);
		await this.persistCapabilityRowText(intent);
	}
	/**
	* The capability table's **own text** (A6): the durable half of a capability
	* commit, written between the registry's row and the completion line — in a
	* fresh commit and in every reconciliation branch alike, because
	* {@link verifyCommitted} is the one place every path passes before it records
	* one.
	*
	* Why it lives here and not beside the registry seam: an applied row whose file
	* was not written is a row the next restart loses, and the completion line is
	* the claim that it will not be lost. Both facts are re-established by writing
	* the row (or removing it, for a rollback) and reading the file back before the
	* completion; a crash in between leaves the intent open, and the next
	* reconciliation repeats the same edit — it is idempotent, and the registry's
	* row is already the one the intent records.
	*
	* A deployment that names no file refuses by name rather than recording a
	* completion for a row that lives only in this process.
	*
	* The edit is written only into a file that reads as one of the two whole-file
	* states this direction's prepare froze (EVO-2 内容漂移, {@link
	* PreparedView.capabilityTable}) — the state it starts from, or the state its
	* own write leaves — so a third party's edit of that file, of the row itself or
	* of any other byte, refuses by name instead of being overwritten. A proposal
	* whose prepare froze no table identity (a line written before that field
	* existed) refuses too: nothing here writes a file it cannot prove it read.
	*/
	async persistCapabilityRowText(intent) {
		const capability = intent.capability;
		if (capability === void 0) return;
		if (this.capabilityConfigPath === void 0) throw new Error(`evolution: this deployment names no capability table file, so the row "${capability.name}" of the ${intent.direction} of proposal "${intent.proposalId}" cannot be persisted — a row that exists only in this process is gone after a restart, and the completion is not recorded for a row the deployment cannot keep; configure the capability table file (Config.capabilityConfig) and retry, and the intent stays open in the meantime`);
		const table = (await this.get(intent.proposalId)).prepared?.capabilityTable;
		if (table === void 0) throw new Error(`evolution: capability-table-unfrozen: proposal "${intent.proposalId}" records no composed identity for the capability table "${this.capabilityConfigPath}", so whether the file still holds the state this ${intent.direction} was prepared against cannot be established — the row "${capability.name}" was not written into it and no completion is recorded; prepare the candidate again (a prepare reads the table and freezes the three whole-file digests every commit of it is compared against)`);
		const entry = capability.contentSha256 === null ? null : await committedRow(this.commitHost(), capability);
		const written = await writeCapabilityRowToConfig({
			file: this.capabilityConfigPath,
			name: capability.name,
			entry,
			states: capabilityTableStates(intent.direction, table),
			...this.capabilityConfigProbe === void 0 ? {} : { probe: this.capabilityConfigProbe }
		});
		if (written.direction === "written" && written.rowDigest !== capabilityRowDigest(entry)) throw new Error(`evolution: the capability row "${capability.name}" written into "${written.file}" reads back as ${written.rowDigest}, not as the row this ${intent.direction} committed (sha256 ${capabilityRowDigest(entry)}); nothing is recorded as settled and the intent stays open`);
	}
	/**
	* The capability table half of the commit path's **before** picture (A6, EVO-2):
	* the named reason this commit must not write anything yet, because the table
	* file its row would be written into no longer reads as a state this proposal
	* froze — or `null` when it does, or when this commit moves no row.
	*
	* It is asked by {@link commitIntent} after the intent line and before the first
	* write, and by every reconciliation before any branch writes or settles: the
	* row is written into that file *last* of a commit's steps, so without this gate
	* a drifted table would be discovered only after the skill files and the
	* registry row had already moved, leaving a half-product a human must settle.
	* Asked here, a third party's edit stops the commit with the intent open and
	* production untouched. The file carries the deployment's credentials, so the
	* reason names the file, the row and the digests compared — never a line of it.
	*/
	async tableWriteRefusal(intent) {
		const capability = intent.capability;
		if (capability === void 0) return null;
		const file = this.capabilityConfigPath;
		if (file === void 0) return null;
		const table = (await this.get(intent.proposalId)).prepared?.capabilityTable;
		if (table === void 0) return `capability-table-unfrozen: the capability table "${file}" is not one this proposal may write — it records no composed identity for that file, so the state this ${intent.direction} was prepared against cannot be proved (prepare the candidate again, which reads the table and freezes it)`;
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			return `capability-table-unreadable: the capability table "${file}" cannot be read (${error instanceof Error ? error.message : String(error)}), so the state this ${intent.direction} would write into is unknown`;
		}
		const drift = capabilityTableDrift({
			name: capability.name,
			seen: sha256Hex(Buffer.from(text, "utf8")),
			states: capabilityTableStates(intent.direction, table)
		});
		return drift === null ? null : `capability-table-changed: the capability table "${file}" is not a state this ${intent.direction} may write — ${drift}`;
	}
	/**
	* The file half of {@link verifyCommitted}. A direction that ends with files
	* **removed** (a capability rollback, A6) is verified as that: every file the
	* intent named must be gone, and nothing is loaded — there is no object left to
	* load. Every other direction is the whole-object verification described above.
	*/
	async verifyCommittedFiles(intent) {
		if (intent.files.length === 0) return;
		if (intent.files.every((file) => file.contentSha256 === null)) {
			for (const file of intent.files) {
				const current = await readProductionSkill(this.skillRoot, relative(this.skillRoot, file.target));
				if (current !== null) throw new Error(`evolution: the production file "${file.target}" still holds sha256 ${current.sha256} after the ${intent.direction} of proposal "${intent.proposalId}" removed it — the commit intent stays open and no completion is recorded`);
			}
			return;
		}
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
	* The capability half of {@link verifyCommitted} (A6): the registry must read as
	* the row this direction installed — the row's canonical digest, or no row at
	* all when the direction removes it. This is what makes the completion a
	* statement about the registry rather than about the files: by the time the
	* line is written, the deployment's own registry view is already the new one,
	* and a completion is never recorded over a registry that still holds the
	* state before the commit.
	*/
	async verifyCommittedRow(intent) {
		if (intent.capability === void 0) return;
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error(`evolution: the effective capability registry cannot be read in this context after the ${intent.direction} of proposal "${intent.proposalId}", so whether the row "${intent.capability.name}" is in place cannot be established — the commit intent stays open and no completion is recorded`);
		const entry = table[intent.capability.name] ?? null;
		const digest = entry === null ? null : capabilityRowDigest(entry);
		if (digest !== intent.capability.contentSha256) throw new Error(`evolution: the capability registry row "${intent.capability.name}" reads ${digest === null ? "no row" : `sha256 ${digest}`} after the ${intent.direction} of proposal "${intent.proposalId}", not the ${intent.capability.contentSha256 === null ? "removed row" : `sha256 ${intent.capability.contentSha256}`} this direction recorded — the commit intent stays open and no completion is recorded`);
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
	/**
	* The **recovery coordination** entry (A6, plan §F.4): take one recorded
	* Diagnosis of a failed root task and — if everything this plane owns is in
	* order — open the task's new attempt through the runtime's own entry.
	*
	* The call chain is fixed (plan §F.4: 工具适配 → evolution 的恢复协调入口 →
	* task-runtime 的执行恢复入口) and each layer re-checks its own rules. What
	* *this* layer owns, in order, before anything is started:
	*
	* 1. **the request's closed shape** — two non-empty ids and nothing else: no
	*    authorization, no approval, no decision, no reuse list. A model cannot
	*    smuggle a permission into a recovery because there is nowhere to put one.
	* 2. **the caller's delegation** — the session must be the supervisor the
	*    ledger recorded for *this* diagnosis (the injected
	*    {@link Config.supervisorDelegation}), and the store the delegation names
	*    must be the store of the caller's own graph. An ordinary root, a worker,
	*    a reviewer, another graph's supervisor and an unknown session are all
	*    refused by name here; nothing is derived from the ids the caller passed.
	* 3. **the diagnosis and its source** — the store must hold the diagnosis, the
	*    diagnosis must name a task of that store, that task must be the store's
	*    own root, and it must be in a failing state: a `verified` source is
	*    refused outright (a successful goal is not recovered, and this build has
	*    no frozen metric or comparator that could judge "faster or cheaper" — its
	*    suggestions stay records, with no promotion, no application and no new
	*    run), and a source whose run is still live is refused rather than
	*    hot-swapped.
	* 4. **the candidate association** — the proposals this ledger holds for that
	*    diagnosis (`sourceRefs` naming `diagnosis:<id>`). **Only a capability
	*    change has to be in force**: every associated proposal that targets a
	*    capability must read `applied` (approved by a person and committed) and
	*    not rolled back, or the recovery is refused by name with nothing started
	*    — the gap it stands for is still open. A pure artifact gap carries no
	*    proposal at all and is *not* refused for that: what it needs is the
	*    source and the capability the production really uses, so this layer
	*    checks the source's required rows resolve in the deployment's current
	*    table and leaves the rest to the runtime.
	* 5. **the attempt's own identity** — a diagnosis with an attempt already in
	*    flight is refused under a *different* key (one diagnosis never runs two
	*    attempts at once); the same key is passed through, and the runtime
	*    answers it from the record it wrote (this layer keeps no attempt table of
	*    its own: the run's `recovery` field is the fact).
	* 6. **the runtime call** — the host composition layer's own entry
	*    (`TaskRuntime.recoverRootTask`), which re-checks the store's facts, the
	*    contract, the providers, the ceilings and the idempotency before it
	*    writes, and never reads this ledger.
	*
	* Nothing here writes: the decision is a read of the store, this ledger and the
	* injected delegation, and the one write that happens is the runtime's.
	*/
	async coordinateRecovery(request, caller) {
		const defects = recoveryCoordinationDefects(request);
		if (defects.length > 0) throw new Error(`evolution: the recovery request was refused:\n- ${defects.join("\n- ")}`);
		if (typeof caller?.sessionId !== "string" || caller.sessionId.trim().length === 0) throw new Error("evolution: a recovery is asked for by the session that coordinates the hand-off: pass a non-empty caller session id");
		if (this.resolveSupervisorDelegation === void 0) throw new Error("evolution: this deployment wires no supervisor-delegation source, so \"this session coordinates the hand-off\" cannot be established; a recovery needs the ledger row that delegated the hand-off, and nothing was started");
		const delegation = await this.resolveSupervisorDelegation(caller.sessionId, request.sourceDiagnosisId);
		if (delegation === void 0) throw new Error(`evolution: session "${caller.sessionId}" is not the supervisor of diagnosis "${request.sourceDiagnosisId}" — this deployment's ledger records no started hand-off for that pair, and a recovery entry is open to the coordinator that hand-off was delegated to and to no one else; nothing was started`);
		if (delegation.sessionId !== caller.sessionId || delegation.diagnosisId !== request.sourceDiagnosisId) throw new Error(`evolution: the delegation read back for session "${caller.sessionId}" names session "${delegation.sessionId}" and diagnosis "${delegation.diagnosisId}"; a delegation that does not answer the question it was asked is not an authorization, and nothing was started`);
		const storeId = await this.storeOfSession(caller.sessionId);
		if (storeId !== delegation.rootStoreId) throw new Error(`evolution: session "${caller.sessionId}" belongs to store "${storeId}", while the hand-off it claims was delegated into "${delegation.rootStoreId}" — a delegation never moves a session into another graph's store, and nothing was started`);
		const task = optionalService(this.ctx, "task");
		if (task === void 0) throw new Error("evolution: this deployment offers no task store, so the diagnosis a recovery names cannot be read; nothing was started");
		let snapshot;
		try {
			snapshot = await task.openStore(storeId);
		} catch (error) {
			throw new Error(`evolution: the store "${storeId}" of the hand-off could not be read (${error instanceof Error ? error.message : String(error)}); nothing was started`);
		}
		const diagnosis = (snapshot.diagnoses ?? []).find((item) => item.diagnosisId === request.sourceDiagnosisId);
		if (diagnosis === void 0) throw new Error(`evolution: store "${storeId}" holds no diagnosis "${request.sourceDiagnosisId}"; a recovery is asked for by a diagnosis of this store, so this hand-off names no fact here and nothing was started`);
		const source = snapshot.tasks.find((item) => item.taskId === diagnosis.taskId);
		if (source === void 0) throw new Error(`evolution: diagnosis "${diagnosis.diagnosisId}" names task "${diagnosis.taskId}", which store "${storeId}" does not hold; nothing was started`);
		if (source.parentTaskId !== void 0) throw new Error(`evolution: task "${source.taskId}" is a child of "${source.parentTaskId}"; a recovery attempt is opened for the store's own root task, and a child is re-run by a batch of its parent — nothing was started`);
		if (source.status === "verified") throw new Error(`evolution: root task "${source.taskId}" is verified, and a successful source is not recovered: the goal was met and this build has no frozen metric or comparator that could judge "faster or cheaper" against it, so the diagnosis's suggestions stay records — no promotion, no application and no new run`);
		const coordination = [`the hand-off was delegated by session "${delegation.actor}" into store "${delegation.rootStoreId}"`, `the diagnosis names root task "${source.taskId}" [${source.status}]`];
		const sourceRunId = recoverySourceRunId(diagnosis, source, snapshot);
		const answered = recoveryAttemptWithKey(snapshot, source.taskId, request.requestKey);
		if (answered !== void 0) {
			coordination.push(`request key "${request.requestKey}" already names attempt "${answered.runId}" [${answered.status}]; it is answered from that record`);
			return await this.recoverThroughRuntime(storeId, {
				sourceTaskId: source.taskId,
				sourceRunId,
				sourceDiagnosisId: request.sourceDiagnosisId,
				requestKey: request.requestKey
			}, caller, delegation, coordination);
		}
		if (source.status === "running" || source.status === "verifying") throw new Error(`evolution: root task "${source.taskId}" is ${source.status}; a recovery opens a new attempt after the old one settled and never hot-swaps a live run — nothing was started`);
		const associated = (await this.list()).filter((proposal) => proposal.sourceRefs.includes(`diagnosis:${diagnosis.diagnosisId}`));
		for (const proposal of associated.filter((item) => item.targetType === "capability")) {
			if (proposal.status === "applied" && proposal.applied !== void 0 && proposal.rolledback === void 0) continue;
			const state = proposal.status === "decided" && proposal.decision === "PROMOTE" ? "PROMOTE-decided but not applied" : proposal.status === "rolledback" ? "rolled back" : proposal.status;
			throw new Error(`evolution: the capability change this hand-off depends on (proposal "${proposal.proposalId}" → row "${proposal.targetId}") is ${state}; a recovery whose gap is that capability is opened only after a person approves it and the apply commits it into the registry — nothing was started, and no run was opened`);
		}
		if (associated.length > 0) coordination.push(`this ledger holds ${associated.length} proposal(s) for the diagnosis, ${associated.filter((item) => item.targetType === "capability").length} of them capability changes, all in force`);
		else {
			const requested = source.requestedCapabilities ?? [];
			if (requested.length === 0) coordination.push("this ledger holds no proposal for the diagnosis; the source requires no capability row of its own");
			else {
				const query = optionalService(this.ctx, "taskRuntime");
				const table = (() => {
					try {
						return query?.listCapabilities?.();
					} catch {
						return;
					}
				})();
				if (table === void 0) throw new Error(`evolution: the recovery of "${source.taskId}" carries no candidate in this ledger, so it is a pure artifact gap — and the capability table that gap's production needs cannot be read in this context; nothing was started rather than assuming the rows resolve`);
				const unresolved = requested.filter((name) => !capabilityToolQuery(table)(name).known);
				if (unresolved.length > 0) throw new Error(`evolution: the recovery of "${source.taskId}" carries no candidate in this ledger and the capability the production needs is still missing ([${unresolved.join(", ")}] resolve to no row in this deployment's table); a pure artifact gap is recoverable, a capability gap is not — nothing was started`);
				coordination.push(`this ledger holds no proposal for the diagnosis; the row(s) the source uses ([${requested.join(", ")}]) resolve in the current table`);
			}
		}
		const inFlight = inFlightRecoveryAttempt(snapshot, source.taskId, request.sourceDiagnosisId);
		if (inFlight !== void 0 && inFlight.recovery?.requestKey !== request.requestKey) throw new Error(`evolution: diagnosis "${request.sourceDiagnosisId}" already has a recovery attempt in flight (run "${inFlight.runId}", key "${inFlight.recovery?.requestKey ?? "unknown"}"); key "${request.requestKey}" starts nothing — an attempt ends when its run settles, and a new key may be asked for after that`);
		return await this.recoverThroughRuntime(storeId, {
			sourceTaskId: source.taskId,
			sourceRunId,
			sourceDiagnosisId: request.sourceDiagnosisId,
			requestKey: request.requestKey
		}, caller, delegation, coordination);
	}
	/**
	* The one runtime call this entry makes, with the answer every path carries: the
	* attempt the runtime opened or already had, and the hand-off facts this plane
	* checked. A deployment without that entry refuses by name — a recovery cannot
	* be opened by this plane, which owns no execution state.
	*/
	async recoverThroughRuntime(storeId, recovery, caller, delegation, coordination) {
		const runtime = optionalService(this.ctx, "taskRuntime");
		if (runtime?.recoverRootTask === void 0) throw new Error("evolution: this deployment offers no execution-recovery entry (taskRuntime.recoverRootTask), so the new attempt cannot be opened; nothing was started");
		return {
			...await runtime.recoverRootTask(storeId, recovery, {
				sessionId: caller.sessionId,
				...caller.signal === void 0 ? {} : { signal: caller.signal }
			}),
			handoff: {
				sessionId: delegation.sessionId,
				actor: delegation.actor,
				diagnosisId: delegation.diagnosisId
			},
			coordination
		};
	}
	/** The root task store of one live session, derived from its own graph — never from an id the caller passed. */
	async storeOfSession(sessionId) {
		const graphs = optionalService(this.ctx, "graphs");
		if (graphs === void 0) throw new Error(`evolution: this deployment offers no graph registry, so the store of session "${sessionId}" cannot be read; nothing was started`);
		try {
			const graph = await graphs.graphForSession(SessionId(sessionId));
			return rootTaskStoreId(String(graph.rootSessionId));
		} catch (error) {
			throw new Error(`evolution: session "${sessionId}" has no graph in this deployment (${error instanceof Error ? error.message : String(error)}), so the store a recovery would open cannot be established; nothing was started`);
		}
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
					...record.capability === void 0 ? {} : { capability: { ...record.capability } },
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
					if (current.targetType !== "skill" && current.targetType !== "capability") throw new Error(`evolution: candidate record for "${record.proposalId}" targets "${current.targetType}" — this build's candidate lifecycles are a SKILL.md replacement of an existing skill object and one whole capability row with an optional new execution skill, and no other target type has an evaluator here`);
					validateVersionSet(record.versionSet);
					validateMutation(current.targetType, record.mutation);
					current.mutation = structuredClone(record.mutation);
					current.versionSet = { ...record.versionSet };
					break;
				case "prepared": {
					const capabilityPrepare = current.targetType === "capability";
					const champion = capabilityPrepare ? "absent" : "captured";
					if (record.mechanical !== true || record.champion !== champion || typeof record.sandbox !== "string" || record.sandbox.length === 0) throw new Error(`evolution: prepared record for "${record.proposalId}" is not a materialized prepare of its own candidate type (mechanical=${String(record.mechanical)}, champion=${JSON.stringify(record.champion ?? null)}, sandbox=${JSON.stringify(record.sandbox ?? null)}, targetType=${JSON.stringify(current.targetType)}) — this build prepares a replacement of one existing skill object (champion "captured") or one capability row with an optional new skill object (champion "absent", A6), and nothing else`);
					if (!Array.isArray(record.files) || record.files.some((file) => typeof file !== "string")) throw new Error(`evolution: prepared record for "${record.proposalId}" has a non-string file list`);
					if (capabilityPrepare) {
						const capabilityRow = preparedRowIdentity(record.capabilityRow, "capabilityRow", record.proposalId);
						if (record.capabilityBaseline === void 0) throw new Error(`evolution: prepared record for "${record.proposalId}" records no capabilityBaseline — every capability prepare records the row the registry held, or \`null\` for the absence it read, so "this candidate adds the row" and "this candidate replaces it" can never be confused`);
						const capabilityBaseline = record.capabilityBaseline === null ? null : preparedRowIdentity(record.capabilityBaseline, "capabilityBaseline", record.proposalId);
						const skillContent$1 = record.skillContent === void 0 ? void 0 : preparedIdentity(record.skillContent, "skillContent", record.proposalId);
						if (skillContent$1 === void 0) {
							if (record.skillBaseline !== void 0) throw new Error(`evolution: prepared record for "${record.proposalId}" records a skill baseline without a candidate identity — a capability prepare that carries no new skill records neither half`);
						} else {
							if (record.skillBaseline !== null) throw new Error(`evolution: prepared record for "${record.proposalId}" records a production skill baseline for a capability candidate's new object — a capability candidate adds a skill, so its baseline is the recorded absence (\`null\`); improving an existing object is the same-name path`);
							if (skillContent$1.contract === void 0) throw new Error(`evolution: prepared record for "${record.proposalId}" records a new skill without a declaration — a capability candidate's skill is an execution provider (SKILL.md plus SKILL.contract.json)`);
						}
						const capabilityTable = preparedCapabilityTable(record.capabilityTable, "capabilityTable", record.proposalId);
						current.prepared = {
							sandbox: record.sandbox,
							mechanical: true,
							champion: "absent",
							...skillContent$1 === void 0 ? {} : { skillContent: skillContent$1 },
							...skillContent$1 === void 0 ? {} : { skillBaseline: null },
							capabilityRow,
							capabilityBaseline,
							...capabilityTable === void 0 ? {} : { capabilityTable },
							files: [...record.files]
						};
						break;
					}
					const skillContent = preparedIdentity(record.skillContent, "skillContent", record.proposalId);
					const skillBaseline = preparedIdentity(record.skillBaseline, "skillBaseline", record.proposalId);
					if (skillContent.contract === void 0 !== (skillBaseline.contract === void 0)) throw new Error(`evolution: prepared record for "${record.proposalId}" mixes object shapes — its candidate identity is ${skillContent.contract === void 0 ? "guidance (no sidecar)" : "an execution object (with a sidecar)"} while its production baseline is ${skillBaseline.contract === void 0 ? "guidance (no sidecar)" : "an execution object (with a sidecar)"} — one prepare freezes one object, so a candidate that changed roles is refused at the fold`);
					if (record.capabilityTable !== void 0) throw new Error(`evolution: prepared record for "${record.proposalId}" records a capability table identity — a prepare freezes the table file of the one row a *capability* candidate writes, and a skill prepare writes no row at all`);
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
					if (!Array.isArray(record.targets) || record.targets.some((target) => typeof target !== "string" || target.length === 0) || record.targets.length === 0 && current.openIntent?.capability === void 0) throw new Error(`evolution: ${record.kind} record for "${record.proposalId}" has a malformed target list — a completion records the file set its commit wrote, and only a row-only capability commit writes no file at all`);
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
			taskRuntime: {
				replayTask: (storeId, championTaskId, options, callerSessionId) => taskRuntime.replayTask(storeId, championTaskId, options, callerSessionId),
				capabilityProviderReport: (sessionId, capabilities) => taskRuntime.capabilityProviderReport(sessionId, capabilities),
				...typeof taskRuntime.listCapabilities === "function" ? { listCapabilities: () => taskRuntime.listCapabilities() } : {},
				precheckCapabilityTable: async (request) => {
					const verifierRefs = await registeredVerifierIds(this.ctx);
					return precheckProviders({
						capabilities: request.capabilities,
						table: request.table,
						view: { extraRoots: [...request.extraRoots] },
						...verifierRefs === void 0 ? {} : { verifierRefs },
						commitLedger: this
					});
				}
			},
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
export { APPLYABLE_TARGET_TYPES, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EXPERIMENT_ADMISSION_SOURCES, EXPERIMENT_COMPARER_VERSION, EXPERIMENT_OUTCOMES, EXPERIMENT_SAMPLE_ROLES, EXPERIMENT_SAMPLE_VERDICTS, EXPERIMENT_SIDES, EXPERIMENT_VERDICTS, EvolutionService, agentOptionsOf, applyTargets, assertAdmissionRecord, assertCapabilityCandidateAdmissible, assertCapabilityRow, assertCapabilityRowAdmissible, assertExperimentReport, assertExperimentStartRecord, assertFrozenExperiment, authorizedToolPlane, buildExperimentReport, canonicalJson, capabilityOverlay, capabilityRefusal, capabilityRowBytes, capabilityRowDigest, capabilityRowIdentity, capabilityTableWith, compareExperimentSides, compareReplaySides, evolution_default as default, digestOf, directoryDigest, discoverSkill, evidenceRefsOf, experimentIdOf, experimentLineage, experimentReportPath, experimentSampleKey, experimentSampleKeyOf, experimentSampleLabel, foldExperiments, frozenDigestOf, isExperimentRecord, modelSelectionOf, overallExperimentVerdict, preparedContentDigestOf, protectedInputsDigest, readPreparedCapability, recoveryCoordinationDefects, recoverySourceRunId, renderProviderRoles, resumeExperiment, runExperiment, validateCapabilityMutation };