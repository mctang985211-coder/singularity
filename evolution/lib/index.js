import { appendFile, cp, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { capabilityToolQuery, loadSkillSidecar, optionalService, readVerifiedFile, registeredVerifierIds, registeredVerifierVocabulary, unlistableVerifierRefusal, validateSkillProvider, walkVerified } from "@dangosys/dsh-singularity-task-runtime";
import { rootTaskStoreId } from "@dangosys/dsh-singularity-task";

//#region src/config-edit.ts
/** A plain YAML scalar needs no quoting; anything else renders JSON-quoted (valid YAML 1.2 flow). */
function flowScalar(value) {
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : JSON.stringify(value);
}
/**
* The row's flow value, keys in the mutation schema's fixed order:
* `{ skills: [verify], preset: bb-verify, mcpServers: [bbdev] }`. Every key of
* `CapabilityConfig` renders, `mcpServers` included — a row that dropped it
* would leave the runtime override granting a server plane the restarted
* process no longer mounts.
*/
function flowEntry(entry) {
	const parts = [];
	if (entry.skills !== void 0) parts.push(`skills: [${entry.skills.map(flowScalar).join(", ")}]`);
	if (entry.tools !== void 0) parts.push(`tools: [${entry.tools.map(flowScalar).join(", ")}]`);
	if (entry.preset !== void 0) parts.push(`preset: ${flowScalar(entry.preset)}`);
	if (entry.permission !== void 0) parts.push(`permission: ${flowScalar(entry.permission)}`);
	if (entry.mcpServers !== void 0) parts.push(`mcpServers: [${entry.mcpServers.map(flowScalar).join(", ")}]`);
	return `{ ${parts.join(", ")} }`;
}
/** The row key as written: a plain scalar when safe, else its JSON-quoted form. */
function keySpelling(name) {
	return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) ? name : JSON.stringify(name);
}
/** Does this line open the capabilities row for `name` (`name: {…}` or block-form `name:`)? */
function rowKeyMatch(trimmed, name) {
	for (const spelling of [name, JSON.stringify(name)]) if (trimmed === `${spelling}:` || trimmed.startsWith(`${spelling}: `) || trimmed.startsWith(`${spelling}:\t`)) return true;
	return false;
}
function indentOf(line) {
	return line.length - line.trimStart().length;
}
function isCommentOrBlank(line) {
	const trimmed = line.trim();
	return trimmed === "" || trimmed.startsWith("#");
}
/** The capabilities mapping header: `capabilities:`, `capabilities: {}`, and an optional trailing comment. */
const CAPABILITIES_HEADER = /^\s+capabilities:\s*(\{\s*\})?\s*(#.*)?$/;
/** The trailing `# …` comment of a header line, whitespace-normalized, or `''`. */
function commentSuffix(line) {
	const comment = /\s(#.*)$/.exec(line)?.[1];
	return comment === void 0 ? "" : ` ${comment}`;
}
/**
* Exclusive end of the entry starting at `head`: its own line, the deeper lines
* of a block-form body, and the comment or blank lines that ride with it. A
* comment or blank line indented at or above the mapping-header indent ends the
* entry — it belongs to the header (or to the next sibling), not to this row —
* unless the next content line is still part of this entry's deeper body, which
* keeps a blank line *inside* a block body with the entry.
*/
function entryEnd(lines, head, regionEnd, headerIndent) {
	const indent = indentOf(lines[head]);
	let end = head + 1;
	for (let index = head + 1; index < regionEnd; index += 1) {
		const line = lines[index];
		if (isCommentOrBlank(line)) {
			let after = index + 1;
			while (after < regionEnd && isCommentOrBlank(lines[after])) after += 1;
			if (!(after < regionEnd && indentOf(lines[after]) > indent) && indentOf(line) <= headerIndent) break;
			end = index + 1;
			continue;
		}
		if (indentOf(line) <= indent) break;
		end = index + 1;
	}
	return end;
}
/**
* Locate the capabilities row for `name`, scanning exactly the region
* `editCapabilityRow` edits. Throws — locating nothing — when document 1 has no
* task-runtime entry, more than one (the error names every matching line —
* refusing to guess which one governs), or no capabilities mapping.
*/
function locateCapabilityRow(text, name) {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(eol);
	const docEnd = lines.findIndex((line) => line.trim() === "---");
	const doc1End = docEnd === -1 ? lines.length : docEnd;
	const itemIndices = [];
	for (let index = 0; index < doc1End; index += 1) if (/^\s*-\s+id:\s*task-runtime\s*$/.test(lines[index])) itemIndices.push(index);
	if (itemIndices.length === 0) throw new Error("config.yml: document 1 has no \"- id: task-runtime\" entry");
	if (itemIndices.length > 1) throw new Error(`config.yml: document 1 has ${itemIndices.length} "- id: task-runtime" entries (lines ${itemIndices.map((index) => index + 1).join(", ")}); refusing to guess — keep exactly one`);
	const itemIndex = itemIndices[0];
	const itemIndent = indentOf(lines[itemIndex]);
	let blockEnd = doc1End;
	for (let index = itemIndex + 1; index < doc1End; index += 1) {
		const line = lines[index];
		if (!isCommentOrBlank(line) && indentOf(line) <= itemIndent) {
			blockEnd = index;
			break;
		}
	}
	let capIndex = -1;
	for (let index = itemIndex + 1; index < blockEnd; index += 1) if (CAPABILITIES_HEADER.test(lines[index])) {
		capIndex = index;
		break;
	}
	if (capIndex === -1) throw new Error("config.yml: the task-runtime entry has no \"capabilities:\" mapping");
	const capIndent = indentOf(lines[capIndex]);
	const capCollapsed = /^\s+capabilities:\s*\{\s*\}/.test(lines[capIndex]);
	let regionEnd = blockEnd;
	for (let index = capIndex + 1; index < blockEnd; index += 1) {
		const line = lines[index];
		if (!isCommentOrBlank(line) && indentOf(line) <= capIndent) {
			regionEnd = index;
			break;
		}
	}
	let rowStart = -1;
	let rowSpan = 0;
	let lastEntryEnd = -1;
	let entryIndent = capIndent + 2;
	for (let index = capIndex + 1; index < regionEnd; index += 1) {
		const line = lines[index];
		if (isCommentOrBlank(line) || index < lastEntryEnd) continue;
		lastEntryEnd = entryEnd(lines, index, regionEnd, capIndent);
		entryIndent = indentOf(line);
		if (rowStart === -1 && rowKeyMatch(line.trimStart(), name)) {
			rowStart = index;
			rowSpan = lastEntryEnd - index;
		}
	}
	let insertAt = lastEntryEnd;
	if (insertAt === -1) {
		insertAt = capIndex + 1;
		while (insertAt < regionEnd && isCommentOrBlank(lines[insertAt])) insertAt += 1;
	}
	return {
		lines,
		eol,
		capIndex,
		capIndent,
		capCollapsed,
		regionEnd,
		rowStart,
		rowSpan,
		insertAt,
		entryIndent
	};
}
/**
* The row's verbatim source lines (`\n`-joined, block-form body and riding
* comments included), or null when no row for `name` exists. The rollback
* anchor of a capability prepare (W19, guide §4.2 #18): restoring these lines
* beats re-rendering the registry entry, whose schema fills default arrays the
* source text never spelled out.
*/
function readCapabilityRowSource(text, name) {
	const located = locateCapabilityRow(text, name);
	if (located.rowStart === -1) return null;
	return located.lines.slice(located.rowStart, located.rowStart + located.rowSpan).join("\n");
}
/**
* Splice `source` (the `\n`-joined lines `readCapabilityRowSource` captured at
* prepare time) back over the current row for `name`, byte-for-byte; when the
* row is gone, insert the lines where a new row would go. Every other byte of
* the file is preserved, exactly as with `editCapabilityRow`.
*/
function restoreCapabilityRowSource(text, name, source) {
	const { lines, eol, capIndex, capIndent, capCollapsed, rowStart, rowSpan, insertAt } = locateCapabilityRow(text, name);
	const sourceLines = source.replace(/\r?\n$/, "").split("\n");
	if (rowStart !== -1) {
		lines.splice(rowStart, rowSpan, ...sourceLines);
		return {
			text: lines.join(eol),
			action: "replaced"
		};
	}
	if (capCollapsed) lines[capIndex] = `${" ".repeat(capIndent)}capabilities:${commentSuffix(lines[capIndex])}`;
	lines.splice(insertAt, 0, ...sourceLines);
	return {
		text: lines.join(eol),
		action: "added"
	};
}
/**
* Replace (`entry` given, row exists), add (`entry` given, row absent), or
* remove (`entry` null) the capabilities row for `name`. The row is one line in
* flow form (`name: { … }`) or a block-form span (`name:` plus deeper-indented
* lines and the comment lines that ride with it); a replacement always lands as
* one flow line at the row's indent, an addition after the last existing row's
* whole span. Removing the final row collapses the mapping header to
* `capabilities: {}` so the document still parses as a mapping, and adding to a
* collapsed header reopens it — `capabilities: {}` cannot take block rows below
* it. Throws — editing nothing — when document 1 has no task-runtime entry, more
* than one (the error names every matching line — refusing to guess which one
* governs), no capabilities mapping, or a removal names no existing row.
*/
function editCapabilityRow(text, name, entry) {
	const { lines, eol, capIndex, capIndent, capCollapsed, regionEnd, rowStart, rowSpan, insertAt, entryIndent } = locateCapabilityRow(text, name);
	const rowLine = `${" ".repeat(rowStart === -1 ? entryIndent : indentOf(lines[rowStart]))}${keySpelling(name)}: ${flowEntry(entry ?? {})}`;
	if (entry !== null && rowStart !== -1) {
		lines.splice(rowStart, rowSpan, rowLine);
		return {
			text: lines.join(eol),
			action: "replaced"
		};
	}
	if (entry !== null) {
		if (capCollapsed) lines[capIndex] = `${" ".repeat(capIndent)}capabilities:${commentSuffix(lines[capIndex])}`;
		lines.splice(insertAt, 0, rowLine);
		return {
			text: lines.join(eol),
			action: "added"
		};
	}
	if (rowStart === -1) throw new Error(`config.yml: no capabilities row for "${name}" to remove`);
	lines.splice(rowStart, rowSpan);
	if (!lines.slice(capIndex + 1, regionEnd - rowSpan).some((line) => !isCommentOrBlank(line))) lines[capIndex] = `${" ".repeat(capIndent)}capabilities: {}`;
	return {
		text: lines.join(eol),
		action: "removed"
	};
}

//#endregion
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
* inconclusive — it says nothing about the candidate's quality.
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
/** The overall verdict over one group of comparisons: any regression wins; absent that, any inconclusive holds it back. */
function overallReplayVerdict(comparisons) {
	if (comparisons.some((item) => item.relation === "worse")) return "worse";
	if (comparisons.length === 0 || comparisons.some((item) => item.relation === "inconclusive")) return "inconclusive";
	if (comparisons.every((item) => item.relation === "manual")) return "manual";
	if (comparisons.some((item) => item.relation === "manual")) return "inconclusive";
	return "not-worse";
}
function isRecord$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertSide(value, field) {
	if (!isRecord$2(value) || typeof value.taskId !== "string" || value.taskId.length === 0 || ![
		"verified",
		"failed",
		"cancelled"
	].includes(value.outcome) || !Array.isArray(value.criteria)) throw new Error(`evolution: replay report ${field} must carry a taskId, a valid outcome and criteria`);
	const ids = /* @__PURE__ */ new Set();
	for (const criterion of value.criteria) {
		if (!isRecord$2(criterion) || typeof criterion.criterionId !== "string" || criterion.criterionId.length === 0 || ids.has(criterion.criterionId) || ![
			"pass",
			"fail",
			"inconclusive"
		].includes(criterion.verdict) || criterion.command !== void 0 && typeof criterion.command !== "string") throw new Error(`evolution: replay report ${field} has an invalid or duplicate criterion`);
		ids.add(criterion.criterionId);
	}
	if (value.outcome === "verified" && ids.size === 0) throw new Error(`evolution: replay report ${field} verified outcome needs criterion evidence`);
}
function assertComparison(value, field, mode) {
	if (!isRecord$2(value)) throw new Error(`evolution: replay report ${field} must be an object`);
	if (typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: replay report ${field}.taskId must be a non-empty string`);
	if (!isRecord$2(value.champion) || typeof value.champion.outcome !== "string") throw new Error(`evolution: replay report ${field}.champion must carry an outcome`);
	if (typeof value.relation !== "string" || !REPLAY_RELATIONS.includes(value.relation)) throw new Error(`evolution: replay report ${field}.relation must be one of ${REPLAY_RELATIONS.join(" / ")}`);
	assertSide(value.champion, `${field}.champion`);
	if (value.taskId !== value.champion.taskId) throw new Error(`evolution: replay report ${field} champion identity mismatch`);
	if (mode === "manual") {
		if (value.relation !== "manual" || value.candidate !== void 0) throw new Error(`evolution: replay report ${field} manual comparison cannot claim an executed candidate`);
		return;
	}
	assertSide(value.candidate, `${field}.candidate`);
	if (value.candidateTaskId !== value.candidate.taskId || value.candidate.taskId === value.taskId) throw new Error(`evolution: replay report ${field} candidate identity mismatch`);
	const computed = compareReplaySides(value.champion, value.candidate);
	if (value.relation !== computed.relation || value.verdictMatch !== computed.verdictMatch || JSON.stringify(value.criteriaDiff) !== JSON.stringify(computed.criteriaDiff)) throw new Error(`evolution: replay report ${field} comparison does not match its evidence`);
}
/**
* Validate a report against the proposal it claims to serve. The v1 manual
* boundary is enforced here: only an agent_preset replay may record
* `mode: 'manual'` (the preset roster scans constructor-fixed roots and cannot
* mount a sandbox-materialized preset), and only a manual report may carry the
* `manual` verdict — every other targetType must produce executed evidence.
* A skill report must additionally carry the candidate content identity
* (`candidateContent`) the replay ran against; equality with the prepared
* record is the service's check, not this schema's.
*/
function assertReplayReport(proposal, report) {
	if (!isRecord$2(report)) throw new Error("evolution: replay report must be an object");
	if (report.formatVersion !== 1) throw new Error("evolution: replay report formatVersion must be 1");
	if (report.proposalId !== proposal.proposalId) throw new Error(`evolution: replay report proposalId "${String(report.proposalId)}" does not match "${proposal.proposalId}"`);
	if (report.targetType !== proposal.targetType) throw new Error(`evolution: replay report targetType "${String(report.targetType)}" does not match "${proposal.targetType}"`);
	if (typeof report.at !== "string" || report.at.length === 0) throw new Error("evolution: replay report.at must be a non-empty string");
	if (report.mode !== "executed" && report.mode !== "manual") throw new Error("evolution: replay report mode must be \"executed\" or \"manual\"");
	if (report.mode === "manual") {
		if (proposal.targetType !== "agent_preset") throw new Error(`evolution: a manual replay report is only valid for agent_preset proposals, not "${proposal.targetType}"`);
		if (typeof report.manualReason !== "string" || report.manualReason.length === 0) throw new Error("evolution: a manual replay report requires a manualReason");
	}
	if (typeof report.verdict !== "string" || !REPLAY_VERDICTS.includes(report.verdict)) throw new Error(`evolution: replay report verdict must be one of ${REPLAY_VERDICTS.join(" / ")}`);
	if (report.mode === "manual" && report.verdict !== "manual") throw new Error("evolution: a manual replay report must carry verdict \"manual\"");
	if (report.mode === "executed" && report.verdict === "manual") throw new Error("evolution: an executed replay report cannot carry verdict \"manual\"");
	if (!Array.isArray(report.observed)) throw new Error("evolution: replay report.observed must be an array");
	report.observed.forEach((item, index) => assertComparison(item, `observed[${index}]`, report.mode));
	if (!isRecord$2(report.holdout) || typeof report.holdout.executed !== "boolean" || !Array.isArray(report.holdout.tasks)) throw new Error("evolution: replay report.holdout must be { executed: boolean, tasks: [] }");
	report.holdout.tasks.forEach((item, index) => assertComparison(item, `holdout.tasks[${index}]`, report.mode));
	if (report.holdout.executed !== report.holdout.tasks.length > 0) throw new Error("evolution: replay report.holdout.executed must agree with its task list (empty = not run)");
	if (report.mode === "executed" && report.observed.length === 0) throw new Error("evolution: an executed replay report needs at least one observed task comparison");
	const comparisons = [...report.observed, ...report.holdout.tasks];
	const taskIds = comparisons.map((item) => item.taskId);
	const candidateIds = comparisons.flatMap((item) => item.candidate === void 0 ? [] : [item.candidate.taskId]);
	if (new Set(taskIds).size !== taskIds.length || new Set(candidateIds).size !== candidateIds.length || candidateIds.some((id) => taskIds.includes(id))) throw new Error("evolution: replay report observed and holdout must use distinct champion and candidate tasks");
	if (report.mode === "executed" && report.verdict !== overallReplayVerdict(comparisons)) throw new Error("evolution: replay report verdict does not match its comparisons");
	if (proposal.targetType === "skill") {
		const identity = report.candidateContent;
		if (!isRecord$2(identity) || typeof identity.name !== "string" || identity.name.length === 0 || typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(identity.sha256)) throw new Error("evolution: a skill replay report must carry candidateContent { name, sha256 } bound at prepare — evidence without the candidate content identity predates content binding; propose a new candidate and re-evaluate it");
	}
}
/** A human approval cannot substitute for two independent, non-regressing replay groups. */
function assertReplayPromotable(report) {
	if (report.mode !== "executed") throw new Error("evolution: promotion requires executed replay evidence, not a manual report");
	for (const [name, tasks] of [["observed", report.observed], ["holdout", report.holdout.tasks]]) if (overallReplayVerdict(tasks) !== "not-worse") throw new Error(`evolution: promotion requires non-empty ${name} replay with no regressions or inconclusive results`);
}
/**
* The comparer a v2 report names, and the only one this build can re-check:
* the verdict rules of {@link compareExperimentSides} and
* {@link overallExperimentVerdict}. A report naming anything else is refused
* by {@link assertExperimentReport} instead of being re-derived with rules this
* build does not have.
*/
const EXPERIMENT_COMPARER_VERSION = "experiment-comparer@1";
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
* fixed; a regression or holdout sample asks only whether the candidate is
* worse, and its answer is `regressed` or `maintained`.
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
function isHex64$1(value) {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function assertIdentity(value, field) {
	if (!isRecord$2(value) || typeof value.name !== "string" || value.name.length === 0 || !isHex64$1(value.sha256)) throw new Error(`evolution: experiment report ${field} must be a content identity { name, sha256 }`);
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
	assertIdentity(value.candidate, "frozen.candidate");
	if (value.productionBaseline !== void 0) assertIdentity(value.productionBaseline, "frozen.productionBaseline");
	if (typeof value.model !== "string" || value.model.length === 0) throw new Error("evolution: experiment report frozen.model must be a non-empty string (the model identity the caller froze)");
	assertExperimentBudget(value.budget, "frozen.budget");
	if (!isRecord$2(value.snapshot) || typeof value.snapshot.sourceDir !== "string" || value.snapshot.sourceDir.length === 0 || !isHex64$1(value.snapshot.digest)) throw new Error("evolution: experiment report frozen.snapshot must be { sourceDir, digest } with a SHA-256 content digest");
	if (value.comparerVersion !== EXPERIMENT_COMPARER_VERSION) throw new Error(`evolution: experiment report frozen.comparerVersion must be "${EXPERIMENT_COMPARER_VERSION}" — got ${JSON.stringify(value.comparerVersion)}; a report this build cannot re-derive is refused, not trusted`);
	if (!isRecord$2(value.overlay) || typeof value.overlay.baseline !== "string" || value.overlay.baseline.length === 0 || typeof value.overlay.candidate !== "string" || value.overlay.candidate.length === 0) throw new Error("evolution: experiment report frozen.overlay must name what each side ran under");
	if (!Array.isArray(value.samples) || value.samples.length === 0) throw new Error("evolution: experiment report frozen.samples must be a non-empty array");
	const taskIds = /* @__PURE__ */ new Set();
	value.samples.forEach((sample, index) => assertFrozenSample(sample, `frozen.samples[${index}]`, taskIds));
	const roles = value.samples.map((sample) => sample.role);
	if (!roles.includes("observed-failure")) throw new Error("evolution: an experiment frozen block needs at least one observed-failure sample (§F.2: the target failure must be reproduced)");
	if (!roles.includes("holdout")) throw new Error("evolution: an experiment frozen block needs at least one holdout sample (§F.2: the candidate must not be selected on every case)");
}
function assertExperimentBudget(value, field) {
	if (!isRecord$2(value)) throw new Error(`evolution: ${field} must be an object (a run-level budget, recorded only)`);
	for (const key of Object.keys(value)) if (key !== "wallTimeMs" && key !== "maxTokens" && key !== "note") throw new Error(`evolution: ${field} has unknown key "${key}"`);
	for (const key of ["wallTimeMs", "maxTokens"]) {
		const member = value[key];
		if (member !== void 0 && (typeof member !== "number" || !Number.isFinite(member) || member < 0)) throw new Error(`evolution: ${field}.${key} must be a non-negative number`);
	}
	if (value.note !== void 0 && (typeof value.note !== "string" || value.note.length === 0)) throw new Error(`evolution: ${field}.note must be a non-empty string`);
}
function assertFrozenSample(value, field, seen) {
	if (!isRecord$2(value) || typeof value.taskId !== "string" || value.taskId.length === 0) throw new Error(`evolution: experiment report ${field} must carry a taskId`);
	if (seen.has(value.taskId)) throw new Error(`evolution: experiment report ${field} repeats task "${value.taskId}"`);
	seen.add(value.taskId);
	if (!EXPERIMENT_SAMPLE_ROLES.includes(value.role)) throw new Error(`evolution: experiment report ${field}.role must be one of ${EXPERIMENT_SAMPLE_ROLES.join(" / ")}`);
	if (!isHex64$1(value.contractDigest)) throw new Error(`evolution: experiment report ${field}.contractDigest must be a SHA-256 hex`);
	if (!Array.isArray(value.criteria) || value.criteria.length === 0) throw new Error(`evolution: experiment report ${field}.criteria must be a non-empty array (the acceptance the replay mirrors)`);
	const criterionIds = /* @__PURE__ */ new Set();
	for (const criterion of value.criteria) {
		if (!isRecord$2(criterion) || typeof criterion.criterionId !== "string" || criterion.criterionId.length === 0 || criterionIds.has(criterion.criterionId) || typeof criterion.verificationMode !== "string" || criterion.verificationMode.length === 0 || criterion.command !== void 0 && typeof criterion.command !== "string" || !isHex64$1(criterion.protectedInputsDigest)) throw new Error(`evolution: experiment report ${field} has an invalid or duplicate frozen criterion`);
		criterionIds.add(criterion.criterionId);
	}
	if (!isRecord$2(value.observed) || value.observed.outcome !== "verified" && value.observed.outcome !== "failed" || value.observed.runId !== void 0 && (typeof value.observed.runId !== "string" || value.observed.runId.length === 0)) throw new Error(`evolution: experiment report ${field}.observed must record the historical outcome (and run, when known) the sample was chosen for`);
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
function assertSideDetail(value, field, sampleTaskId, observedRunId) {
	if (!isRecord$2(value)) throw new Error(`evolution: experiment report ${field} must be an object`);
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
* Validate a v2 report against itself, the way `assertReplayReport` validates a
* v1 one — and further: every verdict the report carries must equal the one its
* own details recompute (`compareExperimentSides` per sample,
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
		if (!isRecord$2(entry)) throw new Error(`evolution: experiment report ${field} must be an object`);
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
* hashed together. A symbolic link is digested by its target text rather than
* followed, because a copy keeps it a link (`cp`'s default): following it would
* describe bytes the workspace never holds.
*/
async function directoryDigest(directory) {
	const base = resolve(directory);
	const lines = [];
	const walk = async (current, prefix) => {
		let found;
		try {
			found = await readdir(current, { withFileTypes: true });
		} catch (error) {
			throw new Error(`experiment: the input snapshot "${current}" cannot be read: ${error instanceof Error ? error.message : String(error)}`);
		}
		for (const entry of [...found].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			const abs = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(abs, rel);
				continue;
			}
			if (entry.isSymbolicLink()) {
				lines.push(`${rel}\0link:${await readlink(abs)}`);
				continue;
			}
			if (!entry.isFile()) throw new Error(`experiment: the input snapshot holds "${abs}", which is neither a file nor a directory — only regular files and symbolic links can be frozen as input`);
			lines.push(`${rel}\0${sha256Hex$2(await readFile(abs))}`);
		}
	};
	await walk(base, "");
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
	nonEmpty$1(spec.model, "model");
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
/** The frozen acceptance identity of one criterion, taken from the sample's own stored contract. */
function frozenCriterionOf(criterion) {
	const inputs = criterion.protectedInputs ?? [];
	for (const input of inputs) if (typeof input?.path !== "string" || input.path.length === 0 || !isHex64(input?.sha256)) throw new Error(`the sample's criterion "${criterion.criterionId}" carries a protected input that was never fixed to { path, sha256 } — an acceptance input nobody fixed is not a frozen input`);
	return {
		criterionId: criterion.criterionId,
		verificationMode: criterion.verificationMode,
		...criterion.command === void 0 ? {} : { command: criterion.command },
		protectedInputsDigest: protectedInputsDigest(inputs)
	};
}
/** Freeze one sample from its store record: what the case is, and the acceptance the replay mirrors into both sides. */
function frozenSampleOf$1(sample, task, review) {
	if (task.acceptanceCriteria.length === 0) throw new Error(`sample "${sample.taskId}" carries no acceptance criteria; there is nothing for the two sides to be judged by`);
	return {
		taskId: sample.taskId,
		role: sample.role,
		contractDigest: digestOf({
			objective: task.objective,
			acceptanceCriteria: task.acceptanceCriteria,
			requiredCapabilities: task.requestedCapabilities
		}),
		criteria: task.acceptanceCriteria.map(frozenCriterionOf),
		observed: {
			outcome: review.outcome === "failed" ? "failed" : "verified",
			...review.runId === void 0 ? {} : { runId: review.runId }
		}
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
		model: input.spec.model,
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
/** Build one side's workspace from the frozen snapshot, then prove it holds exactly the frozen bytes. */
async function buildWorkspace(sourceDir, target, snapshotDigest) {
	await rm(target, {
		recursive: true,
		force: true
	});
	await mkdir(target, { recursive: true });
	await cp(resolve(sourceDir), target, { recursive: true });
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
* Run — or continue — the frozen two-sided experiment, and return the report the
* ledger records. Idempotent per sample key: a recorded side is reused, an
* in-flight side is settled from the store and never re-run, and only a side
* that never ran is started. Every refusal throws with its reason, and the runs
* that did settle stay in the task store and in the ledger.
*/
async function runExperiment(sources, request) {
	const { spec, caller, actor } = request;
	validateSpec(spec);
	const { sandbox, candidate, proposal } = await experimentCandidate(sources, spec.proposalId);
	const { storeId, snapshot } = await experimentStore(sources, caller);
	const samples = spec.samples.map((sample) => {
		const task = snapshot.tasks.find((item) => item.taskId === sample.taskId);
		if (task === void 0) throw new Error(`unknown sample task "${sample.taskId}" in this graph's task store`);
		if (task.status !== "verified" && task.status !== "failed") throw new Error(`sample "${sample.taskId}" is ${task.status}; only a terminal (verified or failed) sample can be evaluated`);
		const review = latestReview(snapshot, task);
		if (review === void 0) throw new Error(`sample "${sample.taskId}" has no review record on its latest run; there is no case to reproduce`);
		assertSampleRole(sample, task, review);
		return frozenSampleOf$1(sample, task, review);
	});
	const frozen = freezeExperiment({
		proposalId: spec.proposalId,
		spec,
		candidate,
		...proposal.prepared?.skillBaseline === void 0 ? {} : { productionBaseline: proposal.prepared.skillBaseline },
		sandbox,
		snapshotDigest: await directoryDigest(spec.snapshot.sourceDir),
		samples
	});
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
				continue;
			}
			const real = await buildWorkspace(spec.snapshot.sourceDir, workspace, view.frozen.snapshot.digest);
			const outcome = await sources.taskRuntime.replayTask(storeId, sample.taskId, {
				lineage,
				workspace: { path: real },
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
			started += 1;
			if (facts.outcome === "cancelled") break sampleLoop;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (started === 0) throw error instanceof Error ? error : new Error(message);
		throw new Error(`${message} (the experiment stopped; ${started} sample run(s) it started settled and stay in the ledger and the task store as evidence — resume experiment ${experimentId} to continue it)`);
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
* have no evidence this gate could read, so a historical report cannot be
* reused to promote them (§F.2: "没有支持的评估器就拒绝新晋升"). Their records
* stay readable and an already-applied one still rolls back.
*/
function noEvaluatorRefusal(proposal) {
	const history = proposal.replayed === void 0 ? "" : ` Its recorded v1 replay report (${proposal.replayed.report}) is not this build's evidence either: a historical report is never upgraded into a new promotion.`;
	return /* @__PURE__ */ new Error(`evolution: proposal "${proposal.proposalId}" targets "${proposal.targetType}", which has no evaluator in this build — the two-sided experiment (§F.2) evaluates a replacement of an existing single-file SKILL.md only, and a promotion without supported evaluation evidence is refused rather than granted from a historical report.` + history);
}
/** The refusal of a skill candidate whose evaluation is still the v1 candidate-vs-champion replay. */
function historicalReportRefusal(proposal) {
	const replay = proposal.replayed;
	const where = replay === void 0 ? "" : ` (${replay.report}, verdict ${replay.verdict})`;
	return /* @__PURE__ */ new Error(`evolution: skill proposal "${proposal.proposalId}" holds a v1 candidate-vs-champion replay report${where} and no two-sided experiment — a historical report is not upgraded into this build's evidence (§F.2); run the two-sided experiment (evolution_replay) so the candidate is compared against a new baseline run of the same frozen samples`);
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
	if (detail.outcome === "interrupted") return;
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
* Whether every criterion verdict a report side carries still names a registered
* judge, at the version it judged with. Fail-closed: a deployment that cannot
* list its verifier vocabulary refuses rather than assuming the judge is there.
*/
function assertJudgeUnchanged(detail, where, vocabulary) {
	for (const criterion of detail.criteria) {
		if (criterion.verifierId === void 0) throw new Error(`evolution: the experiment report's ${where} reports criterion "${criterion.criterionId}" without the verifier that decided it — a verdict nobody can be recalled against is not evidence a promotion may read`);
		if (!vocabulary.ids.includes(criterion.verifierId)) throw new Error(`evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}", which is no longer registered (registered: ${vocabulary.ids.length === 0 ? "none" : vocabulary.ids.join(", ")}) — the judge moved, so the verdicts on record cannot be reproduced`);
		const current = vocabulary.versions[criterion.verifierId];
		if (criterion.verifierVersion !== current) throw new Error(`evolution: the experiment report's ${where} was decided by verifier "${criterion.verifierId}" at version ${criterion.verifierVersion === void 0 ? "(none declared)" : criterion.verifierVersion}, but the registered instance declares ${current === void 0 ? "(none)" : current} now — a verdict belongs to the instance that judged, so a re-registered version invalidates the evidence`);
	}
}
/** Whether a side's cost is known enough for a frozen budget that declares a ceiling. */
function assertCostWithinDeclaredBudget(report, where, detail) {
	const budget = report.frozen.budget;
	if ((budget.maxTokens ?? budget.wallTimeMs) === void 0) return;
	if (detail.cost.status === "unknown") throw new Error(`evolution: the frozen budget declares a cost ceiling (${budget.maxTokens === void 0 ? `wallTimeMs ${budget.wallTimeMs}` : `maxTokens ${budget.maxTokens}`}) and the ${where} reports no cost (${detail.cost.reason}) — an unknown cost cannot be shown to fit a ceiling the frozen budget set, so the promotion is refused rather than inferred`);
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
	if (experiment === void 0) throw proposal.replayed === void 0 ? noExperimentRefusal(proposal) : historicalReportRefusal(proposal);
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
		for (const side of ["baseline", "candidate"]) {
			const detail = side === "baseline" ? sample.baseline : sample.candidate;
			const label = `sample "${sample.taskId}" ${side} side`;
			assertSideEvidence({
				sample: frozenSample,
				detail,
				experimentId: experiment.experimentId,
				snapshot,
				where: label
			});
			assertJudgeUnchanged(detail, label, vocabulary);
			assertCostWithinDeclaredBudget(report, label, detail);
			if (detail.outcome === "interrupted") continue;
			if (detail.initialDigest !== frozen.snapshot.digest) throw new Error(`evolution: the experiment report's ${label} ran from workspace digest ${detail.initialDigest}, not the frozen snapshot ${frozen.snapshot.digest} — both sides of a sample start from the same frozen input`);
		}
		await assertSampleInputsIntact({
			sample: frozenSample,
			snapshot,
			productionWorkspace: frozen.snapshot.sourceDir
		});
	}
	const currentModel = sources.modelIdentity();
	if (currentModel !== frozen.model) throw new Error(`evolution: the experiment froze model "${frozen.model}" but this deployment resolves "${currentModel}" now — the runs on record were not run under the model this promotion would be judged against`);
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
* The four target types whose mutations this version materializes mechanically
* into the sandbox. Mutations on the other five target types (tool /
* decomposition_policy / workflow_policy / verifier / runtime_policy) are
* free-form structured descriptions, recorded with `mechanical: false` —
* bookkeeping only, never materialized.
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
* The three target types `evolution_apply` promotes mechanically (W16): the
* sandbox copy lands on a real production root. task_definition stays manual
* (the task store keeps no definitions registry — W14's fidelity cap), and the
* five bookkeeping-only types never materialized anything to apply.
*/
const APPLYABLE_TARGET_TYPES = [
	"skill",
	"agent_preset",
	"capability"
];
/**
* Whether a decided proposal may record `applied`: the decision is PROMOTE,
* the level is not L4 (L4 harness evolution is human-run by rule, §2.7.7 /
* §2.9.2), the target type is one of the three applyable mechanical ones, and
* a sandbox was actually materialized (a mutation-less manual candidate has
* nothing to copy).
*/
function applyable(proposal) {
	return proposal.decision === "PROMOTE" && proposal.level !== "L4" && APPLYABLE_TARGET_TYPES.includes(proposal.targetType) && proposal.prepared?.sandbox != null;
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
/**
* The model identity one selection names: `provider/model` when the route is
* known, the model id alone otherwise. `undefined` for a selection that names no
* model — a deployment configured without one is a case to refuse, not to paper
* over with a placeholder.
*/
function modelIdentityOf(selection) {
	const model = typeof selection?.model === "string" && selection.model.length > 0 ? selection.model : void 0;
	if (model === void 0) return void 0;
	const provider = typeof selection?.provider === "string" && selection.provider.length > 0 ? selection.provider : void 0;
	return provider === void 0 ? model : `${provider}/${model}`;
}
function nonEmpty(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`evolution: ${field} must be a non-empty string`);
	return value;
}
function isRecord$1(value) {
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
	if (!isRecord$1(mutation)) throw new Error("evolution: mutation must be an object");
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
				if (!isRecord$1(file)) throw new Error(`evolution: mutation.files[${index}] must be an object`);
				assertOnlyKeys(file, ["path", "content"], `mutation.files[${index}]`);
				assertSandboxPath(file.path, `mutation.files[${index}].path`);
				nonEmpty(file.content, `mutation.files[${index}].content`);
			});
			return;
		case "capability":
			assertOnlyKeys(mutation, ["name", "entry"], "capability mutation");
			nonEmpty(mutation.name, "mutation.name");
			if (!isRecord$1(mutation.entry)) throw new Error("evolution: mutation.entry must be an object");
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
			if (!isRecord$1(mutation.definition) || Object.keys(mutation.definition).length === 0) throw new Error("evolution: mutation.definition must be a non-empty object (the new version's definition fields)");
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
	if (!isRecord$1(versionSet)) throw new Error("evolution: versionSet must be an object");
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
	if (!isRecord$1(answers)) throw new Error("evolution: gate answers must be an object");
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
* ledgers replay against. A prepared MECHANICAL mutation must then be replayed
* (the v1 candidate-vs-champion comparison) before it can gate; a
* bookkeeping-only (non-mechanical) one has nothing to replay and gates from
* prepared.
*
* A prepared **skill** candidate gates straight from prepared: its evaluation is
* the two-sided experiment (§F.2), which is recorded in the ledger's experiment
* family and is deliberately *not* a lifecycle transition — the proposal stays
* `prepared` while its samples run — so {@link EvolutionService.gate} requires
* the completed experiment instead of a `replayed` record. `replayed` stays
* reachable for a skill proposal only so a ledger written by the pre-S4-E build
* folds and replays; nothing current writes it, and the promotion gate refuses
* to promote from one. After the human decision, only a PROMOTE on an applyable,
* materialized, sub-L4 mutation can be applied (W16), and only an applied
* proposal can be rolled back.
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
	const hint = current.status === "candidate" && current.mutation !== void 0 && kind === "gated" ? " — this candidate carries a mutation; record \"prepared\" first (evolution_prepare)" : current.status === "prepared" && mutationMechanical(current.targetType) && current.targetType !== "skill" && kind === "gated" ? " — this mutation was materialized; record \"replayed\" first (evolution_replay)" : current.status === "decided" && kind === "applied" ? current.decision !== "PROMOTE" ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied` : " — only a materialized skill / agent_preset / capability mutation at L1–L3 applies; anything else stays a manual human edit" : "";
	throw new Error(`evolution: proposal "${current.proposalId}" is ${current.status}; cannot record "${kind}"${hint}`);
}
/**
* The capability patch file: a YAML header recording the whole-row replacement
* semantics, then the entry as one JSON object line (JSON is valid YAML 1.2, so
* the artifact stays parseable without a YAML dependency).
*/
function capabilityPatchYaml(proposalId, name, entry) {
	return [
		`# Evolution capability patch — proposal ${proposalId}, capability "${name}"`,
		"# Apply semantics: whole-row replacement — this entry replaces the row for this name",
		"# under `capabilities:` in config.yml doc 1's task-runtime line verbatim (no deep merge).",
		"# Sandbox artifact only: nothing applies it automatically; a human edit of production",
		"# is the only way it takes effect.",
		JSON.stringify({ [name]: entry }),
		""
	].join("\n");
}
/**
* Champion twin of the patch file: the entry currently in effect, same whole-row
* semantics. Comparison anchor and runtime-override payload; the rollback text
* anchor is the source-text snapshot (`capability-table.source.txt`) when the
* row lives in config.yml (W19).
*/
function championEntryYaml(name, entry) {
	return [
		`# Champion snapshot — capability "${name}" as in effect at prepare time`,
		"# (task-runtime capability registry). Anchor for candidate-vs-champion diff and",
		"# rollback; whole-row replacement semantics, same as the patch file.",
		JSON.stringify({ [name]: entry }),
		""
	].join("\n");
}
/** Read back the champion capability snapshot: the single JSON line under the `#` header, keyed by the capability name. */
function parseChampionEntry(text, name) {
	const line = text.split("\n").map((item) => item.trim()).filter((item) => item.length > 0 && !item.startsWith("#")).at(-1);
	if (line === void 0) throw new Error("evolution: the champion capability snapshot carries no entry line");
	const parsed = JSON.parse(line);
	if (!isRecord$1(parsed) || !(name in parsed) || !isRecord$1(parsed[name])) throw new Error(`evolution: the champion capability snapshot does not hold an entry for "${name}"`);
	return parsed[name];
}
/**
* The production write targets of an apply (and its matching rollback), for
* the approval reason and the audit record — the human sees exactly what a
* grant will touch.
*/
function applyTargets(proposal, roots) {
	const mutation = proposal.mutation;
	switch (proposal.targetType) {
		case "skill": return [join(roots.skillRoot, mutation.name, "SKILL.md")];
		case "agent_preset": return [join(roots.presetRoot, mutation.presetId)];
		case "capability": return [`${roots.configFile} — document 1 task-runtime capabilities row "${mutation.name}"`];
		default: return [];
	}
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
/** All files under `dir` as `/`-joined relative paths, sorted for a deterministic ledger record. */
async function listFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) if (entry.isDirectory()) for (const nested of await listFiles(join(dir, entry.name))) files.push(`${entry.name}/${nested}`);
	else files.push(entry.name);
	return files;
}
/**
* The Evolution plane ledger (plane separation: this store is independent of
* the task store and refers to it by id only). Replay and append share one
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
	/** Production agent-preset root — champion snapshots read from here; apply/rollback write here. */
	presetRoot;
	/** Production config.yml a capability apply/rollback edits. */
	configFile;
	/** Repo root that relative evidence paths resolve against (see {@link Config.repoRoot}). */
	repoRoot;
	/** The injected model-identity resolver, if the assembly wired one (see {@link Config.modelIdentity}). */
	resolveModelIdentity;
	records = [];
	loaded;
	writes = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "evolution");
		this.repoRoot = config.repoRoot ?? process.cwd();
		this.resolveModelIdentity = config.modelIdentity;
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
	* The model identity this deployment's runs share — the one the experiment
	* freezes before anything runs and the promotion gate re-reads ({@link Config.modelIdentity}).
	*
	* Fail-closed: no resolver, a resolver that throws, or one that names nothing
	* is a named refusal. The experiment tool freezes this value, so a deployment
	* that cannot name its model can neither evaluate nor promote a candidate —
	* and neither case silently skips the check.
	*/
	modelIdentity() {
		let resolved;
		try {
			resolved = this.resolveModelIdentity?.();
		} catch (error) {
			throw new Error(`evolution: the model identity cannot be resolved (${error instanceof Error ? error.message : String(error)}) — the experiment freezes the model its runs share and a promotion re-reads it, so a deployment that cannot name one neither evaluates nor promotes a candidate`);
		}
		if (typeof resolved !== "string" || resolved.trim().length === 0) throw new Error("evolution: this deployment cannot name the model its runs share — no model-identity resolver was injected (or it named none); the two-sided experiment freezes the model identity before anything runs and the promotion gate re-reads it, so a deployment that cannot name it can neither evaluate nor promote a candidate");
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
	*/
	async candidate(proposalId, versionSet, actor, mutation) {
		const current = await this.assertNext(proposalId, "candidate");
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
	* Move candidate → prepared: materialize a mechanical mutation into
	* `<root>/sandbox/<proposalId>/` and snapshot the champion (the current
	* production target) under `champion/` — the anchor for candidate-vs-champion
	* comparison and rollback. A production target that does not exist yet
	* records `champion: 'missing'` (champion: null). Non-mechanical mutations
	* materialize nothing and record `mechanical: false`. Materialization runs
	* before the ledger append; every write is confined to the sandbox dir.
	*
	* A skill candidate additionally records `skillContent` (P2): the name plus
	* the SHA-256 of the exact bytes of the file that was actually materialized
	* (read back from disk, never re-rendered from the mutation string), so
	* replay, the gates, and apply can verify this exact content later. The same
	* single read of the production file also yields `skillBaseline` (P3), the
	* digest the later apply compares the production target against.
	*/
	async prepare(proposalId, actor, champion = {}) {
		const current = await this.assertNext(proposalId, "prepared");
		const mutation = current.mutation;
		if (mutation === void 0) throw new Error(`evolution: proposal "${proposalId}" carries no mutation; nothing to prepare`);
		validateMutation(current.targetType, mutation, current.baseVersion);
		const mechanical = mutationMechanical(current.targetType);
		let sandbox = null;
		let championState = "none";
		let championSource;
		let skillContent;
		let skillBaseline;
		let files = [];
		if (mechanical) {
			if (current.targetType === "capability" && !("capabilityEntry" in champion)) throw new Error("evolution: preparing a capability mutation requires champion.capabilityEntry (pass null when the capability is new)");
			if (current.targetType === "task_definition" && !("taskDefinition" in champion)) throw new Error("evolution: preparing a task_definition mutation requires champion.taskDefinition (pass null when the base definition is unresolvable)");
			assertSegment(proposalId, "proposalId");
			const dir = join(this.root, "sandbox", proposalId);
			const written = await this.materialize(dir, current, mutation, champion);
			sandbox = `sandbox/${proposalId}`;
			championState = written.champion;
			championSource = written.championSource;
			skillBaseline = written.skillBaseline;
			files = written.files;
			if (current.targetType === "skill") {
				const { name } = mutation;
				skillContent = {
					name,
					sha256: sha256Hex(await readVerifiedFile(this.root, `${sandbox}/skills/${name}/SKILL.md`))
				};
			}
		}
		await this.append({
			formatVersion: 1,
			kind: "prepared",
			proposalId,
			sandbox,
			mechanical,
			champion: championState,
			...championSource === void 0 ? {} : { championSource },
			...skillContent === void 0 ? {} : { skillContent },
			...skillBaseline === void 0 ? {} : { skillBaseline },
			files,
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move prepared → replayed: record the outcome of the candidate-vs-champion
	* replay (the `evolution_replay` tool ran it) and write the comparison report
	* to `<sandbox>/replay-report.json`. Only a prepared mechanical mutation can
	* be replayed; the report is validated against the proposal (manual mode is
	* the agent_preset v1 boundary — the preset roster cannot mount
	* sandbox-materialized presets — and every other targetType must carry
	* executed evidence). The report write is confined to the sandbox; the ledger
	* record cites it by root-relative path, and the gate later requires that
	* path in its regression evidence.
	*
	* A **skill** candidate has no path here: its evaluation is the two-sided
	* experiment (§F.2), so a live call that hands this entry a skill report is
	* refused by name. The transition itself stays admissible so a ledger written
	* by the pre-S4-E build still folds and replays; nothing current produces one,
	* and the promotion gate refuses to promote from one.
	*/
	async replay(proposalId, actor, report) {
		const current = await this.assertNext(proposalId, "replayed");
		if (current.targetType === "skill") throw new Error(`evolution: proposal "${proposalId}" targets skill — a skill candidate is evaluated by the two-sided experiment (a new baseline run and a new candidate run per frozen sample, evolution_replay), not by the candidate-vs-champion replay this entry records`);
		assertReplayReport(current, report);
		const sandbox = current.prepared?.sandbox;
		if (sandbox === void 0 || sandbox === null) throw new Error(`evolution: proposal "${proposalId}" names no sandbox; cannot place the replay report`);
		const rel = `${sandbox}/replay-report.json`;
		const abs = resolveWithin(this.root, rel);
		await mkdir(dirname(abs), { recursive: true });
		const content = `${JSON.stringify(report, null, 2)}\n`;
		await writeFile(abs, content, "utf8");
		await this.append({
			formatVersion: 1,
			kind: "replayed",
			proposalId,
			reportDigest: createHash("sha256").update(content).digest("hex"),
			report: rel,
			verdict: report.verdict,
			tasks: [...report.observed.map((item) => ({
				taskId: item.taskId,
				relation: item.relation,
				holdout: false
			})), ...report.holdout.tasks.map((item) => ({
				taskId: item.taskId,
				relation: item.relation,
				holdout: true
			}))],
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
		return this.get(proposalId);
	}
	/**
	* Move candidate → gated (manual candidates), prepared → gated
	* (bookkeeping-only mutations and skill candidates), or replayed → gated
	* (mechanical mutations): all six Gate answers plus regression evidence refs.
	* Every ref must exist — a path on disk (relative to the repo root or
	* absolute) or an id the caller-side resolver knows (task-store evidence).
	* Existence only; nothing here executes anything. A replayed proposal must
	* cite its replay report path, and its contents must match the recorded digest
	* and schema. A **skill** proposal has no `replayed` record — its evaluation is
	* the two-sided experiment — so it must have a completed experiment and cite
	* that experiment's report instead (§F.2).
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
		if (current.replayed !== void 0) {
			const report = current.replayed.report;
			if (!answers.regressionEvidenceRefs.includes(report)) throw new Error(`evolution: a replayed candidate's regression evidence must cite the replay report "${report}"`);
			if (!existsSync(resolveWithin(this.root, report))) throw new Error(`evolution: the replay report "${report}" no longer exists under the ledger root`);
			await this.readRecordedReplay(current);
		}
		if (experimentReport !== void 0) {
			if (!answers.regressionEvidenceRefs.includes(experimentReport)) throw new Error(`evolution: a skill candidate's regression evidence must cite its experiment report "${experimentReport}" — the six answers are answered over that experiment, and the gate records the evidence they rest on`);
			if (!existsSync(resolveWithin(this.root, experimentReport))) throw new Error(`evolution: the experiment report "${experimentReport}" no longer exists under the ledger root`);
		}
		for (const ref of answers.regressionEvidenceRefs) {
			if (current.replayed !== void 0 && ref === current.replayed.report) continue;
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
	* (W16). Reachable only for a PROMOTE decision on a materialized skill /
	* agent_preset / capability mutation at L1–L3 (the state machine itself
	* refuses anything else); the caller (the evolution_apply tool) must hold a
	* human grant from `ctx.approval.request` first, exactly as for decide.
	* Production writes run BEFORE the ledger append, so a failed write leaves
	* the proposal decided and retryable. skill: the sandbox SKILL.md replaces
	* the production one (the champion snapshot covers that file only, so the
	* write is file-level, never a directory delete). agent_preset: whole-dir
	* replacement (the champion snapshot is the full directory). capability:
	* text-level surgery on the one capabilities row in config.yml document 1 —
	* the runtime registry is NOT hot-reloaded by that edit; the tool mirrors
	* the row into the running TaskRuntime afterwards.
	*
	* A skill apply re-verifies the production baseline (P3) after the human
	* grant and immediately before the write: the production target must still be
	* the one prepare recorded. A direct service call therefore cannot bypass the
	* check the tool already ran before asking for approval.
	*
	* The promotion check (S1-C item 3) runs here too, immediately before the
	* write and after the grant: a candidate whose provider role changed while the
	* human was deciding (a sidecar that appeared in the sandbox, a capability row
	* whose skill stopped being reachable, a verifier that was unregistered) is
	* refused here, so no entry can write something a later admission would have
	* refused.
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
	* promotion, and a historical replay report is never upgraded into new
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
	* verifier vocabulary and this deployment's model identity. Resolved softly
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
			modelIdentity: () => this.modelIdentity()
		};
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
	* every stage shares: the replay tool's pre-execution check, the `replayed`
	* record's post-execution recheck, every promotion gate, and the apply write.
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
	async readRecordedReplay(proposal) {
		const replay = proposal.replayed;
		if (replay?.reportDigest === void 0) throw new Error("evolution: replay has no report digest; run a new candidate replay before promotion");
		const content = await readFile(resolveWithin(this.root, replay.report), "utf8");
		if (createHash("sha256").update(content).digest("hex") !== replay.reportDigest) throw new Error("evolution: replay report changed after recording; candidate must be evaluated again");
		const report = JSON.parse(content);
		assertReplayReport(proposal, report);
		return report;
	}
	/**
	* Move applied → rolledback: undo the apply. Champion captured → restore the
	* snapshot (skill SKILL.md written back, preset directory replaced,
	* capability row restored — verbatim from `champion/capability-table.source.txt`
	* for a `config-text` champion (W19), row removed for a `code-default`
	* champion so the code default governs again, registry-form restore from
	* `champion/capability-table.entry.yml` for pre-W19 records);
	* champion missing → delete what the apply created (production skill/preset
	* dir removed, capability row dropped). Same approval discipline as apply:
	* the tool asks a human first, the service only executes and records.
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
	* The production write behind apply/rollback. The write side is picked by
	* `direction`; every path goes through `resolveWithin`, so a write can never
	* leave the production root it targets.
	*/
	async writeProduction(proposal, direction) {
		const sandbox = proposal.prepared?.sandbox;
		const champion = proposal.prepared?.champion;
		if (sandbox == null || champion === void 0 || proposal.mutation === void 0) throw new Error(`evolution: proposal "${proposal.proposalId}" has no materialized sandbox; nothing to ${direction}`);
		switch (proposal.targetType) {
			case "skill": {
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
			case "agent_preset": {
				const { presetId } = proposal.mutation;
				const dst = resolveWithin(this.presetRoot, presetId);
				if (direction === "rollback" && champion === "missing") {
					await rm(dst, {
						recursive: true,
						force: true
					});
					return { targets: [`${dst} (deleted — the apply had created it)`] };
				}
				const src = resolveWithin(this.root, direction === "apply" ? `${sandbox}/.agent-presets/${presetId}` : `${sandbox}/champion/.agent-presets/${presetId}`);
				await rm(dst, {
					recursive: true,
					force: true
				});
				await mkdir(dirname(dst), { recursive: true });
				await cp(src, dst, { recursive: true });
				return { targets: [dst] };
			}
			case "capability": {
				const { name, entry } = proposal.mutation;
				const text = await readFile(this.configFile, "utf8");
				let row;
				let edited;
				if (direction === "apply") {
					row = entry;
					edited = editCapabilityRow(text, name, row);
				} else if (champion === "missing") {
					row = null;
					edited = editCapabilityRow(text, name, null);
				} else if (proposal.prepared?.championSource === "config-text") {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = restoreCapabilityRowSource(text, name, await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.source.txt`), "utf8"));
				} else if (proposal.prepared?.championSource === "code-default") {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = editCapabilityRow(text, name, null);
				} else {
					row = parseChampionEntry(await readFile(resolveWithin(this.root, `${sandbox}/champion/capability-table.entry.yml`), "utf8"), name);
					edited = editCapabilityRow(text, name, row);
				}
				await writeFile(this.configFile, edited.text, "utf8");
				return {
					targets: [`${this.configFile} — document 1 task-runtime capabilities row "${name}" (${edited.action})`],
					capability: {
						name,
						entry: row === null ? null : structuredClone(row)
					}
				};
			}
			default: throw new Error(`evolution: targetType "${proposal.targetType}" never applies mechanically`);
		}
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
	* The verbatim source lines of the capability's row in the production
	* config.yml (W19), or null when the file or the row is absent — the latter
	* meaning the capability comes from the code default table. A config.yml
	* without a task-runtime capabilities mapping fails loudly, exactly as an
	* apply would.
	*/
	async capabilityRowSource(name) {
		let text;
		try {
			text = await readFile(this.configFile, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
		return readCapabilityRowSource(text, name);
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
	* Write one mechanical mutation into the sandbox dir `dir`, then the champion
	* snapshot. Every path goes through `resolveWithin`, so a write can never
	* land outside the sandbox; production roots are read-only here. Capability
	* champions carry a `championSource` (W19): the rollback anchor is the
	* config.yml row's verbatim source text when the row exists there. A skill
	* champion is read exactly once (P3): those bytes become both the snapshot
	* and the recorded `skillBaseline` digest, so the two can never describe two
	* different reads of the production file.
	*/
	async materialize(dir, proposal, mutation, champion) {
		const files = [];
		const write = async (rel, content) => {
			const abs = resolveWithin(dir, rel);
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, content, "utf8");
			files.push(rel);
		};
		switch (proposal.targetType) {
			case "skill": {
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
			case "agent_preset": {
				const { presetId, files: presetFiles } = mutation;
				for (const file of presetFiles) await write(`.agent-presets/${presetId}/${file.path}`, file.content);
				const championDir = join(this.presetRoot, presetId);
				if (!existsSync(championDir)) return {
					files,
					champion: "missing"
				};
				const target = resolveWithin(dir, `champion/.agent-presets/${presetId}`);
				await mkdir(dirname(target), { recursive: true });
				await cp(championDir, target, { recursive: true });
				for (const rel of await listFiles(target)) files.push(`champion/.agent-presets/${presetId}/${rel}`);
				return {
					files,
					champion: "captured"
				};
			}
			case "capability": {
				const { name, entry } = mutation;
				await write("capability-table.patch.yml", capabilityPatchYaml(proposal.proposalId, name, entry));
				if (champion.capabilityEntry == null) return {
					files,
					champion: "missing",
					championSource: "missing"
				};
				await write("champion/capability-table.entry.yml", championEntryYaml(name, champion.capabilityEntry));
				const source = await this.capabilityRowSource(name);
				if (source === null) return {
					files,
					champion: "captured",
					championSource: "code-default"
				};
				await write("champion/capability-table.source.txt", `${source}\n`);
				return {
					files,
					champion: "captured",
					championSource: "config-text"
				};
			}
			case "task_definition":
				await write("task-definition.json", `${JSON.stringify(mutation.definition, null, 2)}\n`);
				if (champion.taskDefinition == null) return {
					files,
					champion: "missing"
				};
				await write("champion/task-definition.json", `${JSON.stringify(champion.taskDefinition, null, 2)}\n`);
				return {
					files,
					champion: "captured"
				};
			default: throw new Error(`evolution: targetType "${proposal.targetType}" has no mechanical materialization`);
		}
	}
	/**
	* Fold records into proposals, enforcing the state machine on every step:
	* proposed starts a new id; each later kind must be exactly an allowed next
	* state, and payload-bearing kinds re-run the write path's payload
	* validation (candidate versionSet/mutation, gate answers, the
	* prepared/replayed/applied/rolledback shapes), so a hand-forged line fails
	* load exactly as it would fail append. The same rules guard replay and live
	* appends, so an illegal migration is rejected identically in both paths.
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
						if (!isRecord$1(record.skillContent) || typeof record.skillContent.name !== "string" || record.skillContent.name.length === 0 || typeof record.skillContent.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.skillContent.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillContent identity`);
					}
					if (record.skillBaseline !== void 0) {
						if (current.targetType !== "skill") throw new Error(`evolution: prepared record for "${record.proposalId}" carries skillBaseline but targetType "${current.targetType}" is not skill`);
						if (!isRecord$1(record.skillBaseline) || typeof record.skillBaseline.name !== "string" || record.skillBaseline.name.length === 0 || typeof record.skillBaseline.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.skillBaseline.sha256)) throw new Error(`evolution: prepared record for "${record.proposalId}" has a malformed skillBaseline identity`);
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
					if (!Array.isArray(record.tasks) || record.tasks.some((item) => !isRecord$1(item) || typeof item.taskId !== "string" || !REPLAY_RELATIONS.includes(item.relation) || typeof item.holdout !== "boolean")) throw new Error(`evolution: replayed record for "${record.proposalId}" has a malformed task summary`);
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
			taskRuntime
		};
	}
};
var evolution_default = EvolutionService;

//#endregion
//#region src/prepare-champion.ts
/**
* Champion anchor for a task_definition target. The task store keeps no
* definitions registry — definition fields live denormalized on each task
* instance — so the snapshot is the first instance matching
* { taskType: targetId, version: baseVersion } ('v3' and '3' both read as 3),
* reduced to the fields instances actually hold (decompositionPolicy and
* budgetPolicy are not retained per instance). No match, or no store, means the
* champion is unresolvable: null.
*/
async function definitionChampion(sources, caller, targetId, baseVersion) {
	const version = Number(baseVersion.replace(/^v/, ""));
	if (!Number.isInteger(version)) return null;
	try {
		const graph = await sources.graphs.graphForSession(caller);
		const task = (await sources.task.openStore(rootTaskStoreId(graph.rootSessionId))).tasks.find((item) => item.definitionRef.taskType === targetId && item.definitionRef.version === version);
		if (task === void 0) return null;
		return {
			taskType: task.definitionRef.taskType,
			version: task.definitionRef.version,
			objective: task.objective,
			acceptanceCriteria: task.acceptanceCriteria,
			requiredCapabilities: task.requestedCapabilities
		};
	} catch {
		return null;
	}
}
/**
* Resolve the caller-supplied half of a prepare: the capability champion from
* the effective registry, the task_definition champion from the task store;
* skill / preset champions the ledger reads from the production roots itself.
* A capability prepare whose row is absent records `null` — the capability is
* new — while a task_definition whose base definition is unresolvable also
* records `null`.
*/
async function resolvePrepareChampion(sources, proposal, caller) {
	const champion = {};
	if (proposal.targetType === "capability" && proposal.mutation !== void 0) {
		const name = proposal.mutation.name;
		champion.capabilityEntry = sources.taskRuntime.listCapabilities()[name] ?? null;
	}
	if (proposal.targetType === "task_definition") champion.taskDefinition = await definitionChampion(sources, caller, proposal.targetId, proposal.baseVersion);
	return champion;
}

//#endregion
//#region src/replay-experiment.ts
/** The lineage tag every replay artifact (objective, review anomalies) carries. */
function replayLineage(proposalId) {
	return `evolution-replay:${proposalId}`;
}
/** Why agent_preset replay is manual in v1 — recorded verbatim in the report. */
const PRESET_REPLAY_MANUAL_REASON = "agent_preset replay is manual in v1: the agent-presets roster (AgentPresets.resolve/mount) scans constructor-fixed roots only and cannot mount a sandbox-materialized preset without reconfiguring the production service; review the sandbox composition under .agent-presets/ by hand and answer the gate accordingly";
const VERIFICATION_MODES = [
	"deterministic",
	"simulation",
	"formal",
	"measurement",
	"review",
	"composite"
];
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** The terminal review record of a champion task's latest run — the comparison anchor. */
function championRecord(snapshot, task) {
	const runId = task.runIds[task.runIds.length - 1];
	return snapshot.reviews.find((item) => item.runId === runId);
}
function sideFromRecord(task, record) {
	return {
		taskId: task.taskId,
		...record.runId === void 0 ? {} : { runId: record.runId },
		outcome: record.outcome,
		...record.durationMs === void 0 ? {} : { durationMs: record.durationMs },
		criteria: (record.criteria ?? []).map((item) => ({
			criterionId: item.criterionId,
			verdict: item.verdict,
			...item.command === void 0 ? {} : { command: item.command },
			...item.exitCode === void 0 ? {} : { exitCode: item.exitCode }
		}))
	};
}
function sideFromOutcome(outcome) {
	return {
		taskId: outcome.taskId,
		runId: outcome.runId,
		outcome: outcome.status,
		...outcome.durationMs === void 0 ? {} : { durationMs: outcome.durationMs },
		criteria: (outcome.criteria ?? []).map((item) => ({
			criterionId: item.criterionId,
			verdict: item.verdict,
			...item.command === void 0 ? {} : { command: item.command },
			...item.exitCode === void 0 ? {} : { exitCode: item.exitCode }
		}))
	};
}
/**
* Normalize the candidate definition's contract for a deterministic criteria
* replay. The definition is the free-form object the mutation carried; the
* replay needs real criteria, so a missing/empty `acceptanceCriteria` or a
* criterion without a `criterionId` fails loudly. Fields the definition omits
* (objective / requiredCapabilities) fall back to the champion task's.
*/
function candidateContract(definition, champion) {
	if (!isRecord(definition)) throw new Error("evolution_replay: the sandbox task-definition.json must hold an object");
	const rawCriteria = definition.acceptanceCriteria;
	if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) throw new Error("evolution_replay: the candidate definition must carry a non-empty acceptanceCriteria array");
	const acceptanceCriteria = rawCriteria.map((raw, index) => {
		if (!isRecord(raw)) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}] must be an object`);
		if (typeof raw.criterionId !== "string" || raw.criterionId.length === 0) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].criterionId must be a non-empty string`);
		const command = raw.command === void 0 ? void 0 : raw.command;
		if (command !== void 0 && typeof command !== "string") throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].command must be a string`);
		const mode = raw.verificationMode ?? (command === void 0 ? "review" : "deterministic");
		if (typeof mode !== "string" || !VERIFICATION_MODES.includes(mode)) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].verificationMode must be one of ${VERIFICATION_MODES.join(" / ")}`);
		return {
			criterionId: raw.criterionId,
			description: typeof raw.description === "string" ? raw.description : "",
			verificationMode: mode,
			requiredEvidence: Array.isArray(raw.requiredEvidence) ? raw.requiredEvidence.filter((item) => typeof item === "string") : [],
			mandatory: typeof raw.mandatory === "boolean" ? raw.mandatory : true,
			...command === void 0 ? {} : { command }
		};
	});
	return {
		objective: typeof definition.objective === "string" && definition.objective.length > 0 ? definition.objective : champion.objective,
		acceptanceCriteria,
		requiredCapabilities: Array.isArray(definition.requiredCapabilities) ? definition.requiredCapabilities.filter((item) => typeof item === "string") : [...champion.requestedCapabilities]
	};
}
/**
* Run one replay experiment and record it. Every refusal throws with the text
* the model-facing adapter reports after its own `evolution_replay rejected:`
* prefix; nothing is recorded on any refusal, and the runs that did settle stay
* in the task store as evidence (said in the mid-flight failure message).
*/
async function runReplayExperiment(sources, request) {
	const { proposalId, caller } = request;
	const proposal = await sources.evolution.get(proposalId);
	if (proposal.status !== "prepared") throw new Error(`proposal ${proposal.proposalId} is ${proposal.status}; only a prepared proposal can be replayed`);
	const prepared = proposal.prepared;
	if (!prepared.mechanical) throw new Error(`proposal ${proposal.proposalId} is bookkeeping-only (mechanical: false); nothing to replay — gate it directly with evolution_gate`);
	if (proposal.targetType === "skill") throw new Error(`proposal ${proposal.proposalId} targets "skill": a skill candidate is evaluated by the two-sided experiment (a new baseline run and a new candidate run per frozen sample), not by this candidate-vs-champion replay`);
	const lineage = replayLineage(proposal.proposalId);
	if (proposal.targetType === "agent_preset") {
		const report$1 = {
			formatVersion: 1,
			proposalId: proposal.proposalId,
			targetType: proposal.targetType,
			at: (/* @__PURE__ */ new Date()).toISOString(),
			mode: "manual",
			manualReason: PRESET_REPLAY_MANUAL_REASON,
			observed: [],
			holdout: {
				executed: false,
				tasks: []
			},
			verdict: "manual"
		};
		const replayed$1 = await sources.evolution.replay(proposal.proposalId, caller, report$1);
		return {
			proposalId: replayed$1.proposalId,
			targetType: proposal.targetType,
			targetId: proposal.targetId,
			report: report$1,
			reportPath: replayed$1.replayed.report,
			observed: [],
			holdout: [],
			manual: true
		};
	}
	const taskIds = [...request.taskIds];
	const holdoutIds = [...request.holdoutTaskIds];
	if (taskIds.length === 0) throw new Error("taskIds must name at least one champion task");
	if (new Set([...taskIds, ...holdoutIds]).size !== taskIds.length + holdoutIds.length) throw new Error("taskIds and holdoutTaskIds must not overlap or repeat");
	let snapshot;
	let storeId;
	try {
		storeId = rootTaskStoreId((await sources.graphs.graphForSession(caller)).rootSessionId);
		snapshot = await sources.task.openStore(storeId);
	} catch (error) {
		throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`);
	}
	const champions = /* @__PURE__ */ new Map();
	for (const taskId of [...taskIds, ...holdoutIds]) {
		const task = snapshot.tasks.find((item) => item.taskId === taskId);
		if (task === void 0) throw new Error(`unknown task "${taskId}" in this graph's task store`);
		if (task.status !== "verified" && task.status !== "failed") throw new Error(`task "${taskId}" is ${task.status}; only a terminal (verified or failed) task can be a replay champion`);
		const record = championRecord(snapshot, task);
		if (record === void 0) throw new Error(`task "${taskId}" has no review record on its latest run; nothing to compare the candidate against`);
		champions.set(taskId, {
			task,
			record
		});
	}
	const sandboxAbs = join(sources.evolution.root, prepared.sandbox);
	const mutation = proposal.mutation;
	const comparisons = [];
	try {
		for (const [taskId, holdout$1] of [...taskIds.map((id) => [id, false]), ...holdoutIds.map((id) => [id, true])]) {
			const { task: champion, record } = champions.get(taskId);
			let options;
			if (proposal.targetType === "capability") {
				const capability = mutation;
				options = { overlay: { capabilityOverrides: { [capability.name]: capability.entry } } };
			} else if (proposal.targetType === "task_definition") options = {
				contract: candidateContract(JSON.parse(await readFile(join(sandboxAbs, "task-definition.json"), "utf8")), champion),
				spawn: false
			};
			else throw new Error(`evolution_replay: targetType "${proposal.targetType}" has no replay path`);
			const outcome = await sources.taskRuntime.replayTask(storeId, taskId, {
				lineage,
				...options,
				signal: request.signal
			}, caller);
			const championSide = sideFromRecord(champion, record);
			const candidateSide = sideFromOutcome(outcome);
			comparisons.push({
				taskId,
				holdout: holdout$1,
				comparison: {
					taskId,
					candidateTaskId: outcome.taskId,
					champion: championSide,
					candidate: candidateSide,
					...compareReplaySides(championSide, candidateSide)
				}
			});
		}
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)} (no replay was recorded; ${comparisons.length} run(s) already settled stay in the task store as evidence)`);
	}
	const observed = comparisons.filter((item) => !item.holdout).map((item) => item.comparison);
	const holdout = comparisons.filter((item) => item.holdout).map((item) => item.comparison);
	const report = {
		formatVersion: 1,
		proposalId: proposal.proposalId,
		targetType: proposal.targetType,
		at: (/* @__PURE__ */ new Date()).toISOString(),
		mode: "executed",
		observed,
		holdout: {
			executed: holdout.length > 0,
			tasks: holdout
		},
		verdict: overallReplayVerdict([...observed, ...holdout])
	};
	const replayed = await sources.evolution.replay(proposal.proposalId, caller, report);
	return {
		proposalId: replayed.proposalId,
		targetType: proposal.targetType,
		targetId: proposal.targetId,
		report,
		reportPath: replayed.replayed.report,
		observed,
		holdout,
		manual: false
	};
}

//#endregion
export { APPLYABLE_TARGET_TYPES, CHAMPION_SOURCES, CHAMPION_STATES, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EXPERIMENT_COMPARER_VERSION, EXPERIMENT_OUTCOMES, EXPERIMENT_SAMPLE_ROLES, EXPERIMENT_SAMPLE_VERDICTS, EXPERIMENT_SIDES, EXPERIMENT_VERDICTS, EvolutionService, MECHANICAL_TARGET_TYPES, PRESET_REPLAY_MANUAL_REASON, REPLAY_RELATIONS, REPLAY_VERDICTS, applyTargets, assertExperimentReport, assertExperimentStartRecord, assertFrozenExperiment, assertReplayPromotable, assertReplayReport, buildExperimentReport, canonicalJson, compareExperimentSides, compareReplaySides, evolution_default as default, digestOf, directoryDigest, editCapabilityRow, evidenceRefsOf, experimentIdOf, experimentLineage, experimentReportPath, experimentSampleKey, experimentSampleKeyOf, experimentSampleLabel, foldExperiments, frozenDigestOf, isExperimentRecord, modelIdentityOf, mutationMechanical, overallExperimentVerdict, overallReplayVerdict, protectedInputsDigest, readCapabilityRowSource, renderProviderRoles, replayLineage, resolvePrepareChampion, restoreCapabilityRowSource, resumeExperiment, runExperiment, runReplayExperiment };