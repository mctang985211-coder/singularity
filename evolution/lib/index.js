import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { capabilityToolQuery, loadSkillSidecar, optionalService, precheckReplacedCapabilityRow, readVerifiedFile, registeredVerifierIds, unlistableVerifierRefusal, validateSkillProvider, walkVerified } from "@dangosys/dsh-singularity-task-runtime";
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
* (candidate vs champion over this graph's historical terminal tasks) before it
* can gate; a bookkeeping-only (non-mechanical) one has nothing to replay and
* gates from prepared. After the human decision, only a PROMOTE on an
* applyable, materialized, sub-L4 mutation can be applied (W16), and only an
* applied proposal can be rolled back.
*/
function nextStates(proposal) {
	switch (proposal.status) {
		case "proposed": return ["candidate"];
		case "candidate": return proposal.mutation === void 0 ? ["gated"] : ["prepared"];
		case "prepared": return mutationMechanical(proposal.targetType) ? ["replayed"] : ["gated"];
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
	const hint = current.status === "candidate" && current.mutation !== void 0 && kind === "gated" ? " — this candidate carries a mutation; record \"prepared\" first (evolution_prepare)" : current.status === "prepared" && mutationMechanical(current.targetType) && kind === "gated" ? " — this mutation was materialized; record \"replayed\" first (evolution_replay)" : current.status === "decided" && kind === "applied" ? current.decision !== "PROMOTE" ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied` : " — only a materialized skill / agent_preset / capability mutation at L1–L3 applies; anything else stays a manual human edit" : "";
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
	records = [];
	loaded;
	writes = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "evolution");
		this.repoRoot = config.repoRoot ?? process.cwd();
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
	* For a skill candidate the service additionally binds the content identity
	* (P2): the report must carry the same `candidateContent` prepare recorded,
	* and the candidate file on disk must still hash to it. The tool re-checks
	* before it runs anything; this check runs after the runs and before the
	* record is written, so a modification that happened and persisted during
	* the replay is refused instead of recorded.
	*/
	async replay(proposalId, actor, report) {
		const current = await this.assertNext(proposalId, "replayed");
		assertReplayReport(current, report);
		const sandbox = current.prepared?.sandbox;
		if (sandbox === void 0 || sandbox === null) throw new Error(`evolution: proposal "${proposalId}" names no sandbox; cannot place the replay report`);
		if (current.targetType === "skill") await this.assertSkillContentBound(current, report);
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
	* The skill replay's content binding (P2), enforced on the service entry that
	* writes the `replayed` record: the report's identity must equal the one
	* prepare recorded, and the candidate file must still be those exact bytes.
	* A candidate prepared before content binding, or one that changed and stayed
	* changed, is refused with the same guidance — fix the candidate through a
	* new proposal and evaluation; the append-only ledger never re-digests an old
	* record.
	*/
	async assertSkillContentBound(proposal, report) {
		const identity = proposal.prepared?.skillContent;
		if (identity === void 0) throw new Error(`evolution: skill proposal "${proposal.proposalId}" was prepared before candidate content binding — propose a new candidate and re-evaluate it; recorded identities are never re-digested`);
		if (report.candidateContent === void 0) throw new Error("evolution: a skill replay report must carry candidateContent { name, sha256 }");
		if (report.candidateContent.name !== identity.name || report.candidateContent.sha256 !== identity.sha256) throw new Error(`evolution: replay report candidate content identity { name: "${report.candidateContent.name}", sha256: ${report.candidateContent.sha256} } does not match the identity prepared for proposal "${proposal.proposalId}" { name: "${identity.name}", sha256: ${identity.sha256} }`);
		await this.readVerifiedSkillCandidate(proposal);
	}
	/**
	* Move candidate → gated (manual candidates), prepared → gated
	* (bookkeeping-only mutations), or replayed → gated (mechanical mutations):
	* all six Gate answers plus regression evidence refs. Every ref must exist —
	* a path on disk (relative to the repo root or absolute) or an id the
	* caller-side resolver knows (task-store evidence). Existence only; nothing
	* here executes anything. A replayed proposal must additionally cite its
	* replay report path; its contents must match the recorded digest and schema.
	*/
	async gate(proposalId, answers, actor, refKnown) {
		const current = await this.assertNext(proposalId, "gated");
		validateGateAnswers(answers);
		if (current.replayed !== void 0) {
			const report = current.replayed.report;
			if (!answers.regressionEvidenceRefs.includes(report)) throw new Error(`evolution: a replayed candidate's regression evidence must cite the replay report "${report}"`);
			if (!existsSync(resolveWithin(this.root, report))) throw new Error(`evolution: the replay report "${report}" no longer exists under the ledger root`);
			await this.readRecordedReplay(current);
		}
		for (const ref of answers.regressionEvidenceRefs) {
			if (current.replayed !== void 0 && ref === current.replayed.report) continue;
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
	* role it may be counted as (an empty list for a target type that carries
	* none), so the callers that already gate on this check can report them.
	*
	* Three checks run here, in this order, all of them shared with the service
	* entry the tools ultimately call:
	*
	* 1. P2: the candidate bytes must still be the ones prepare recorded.
	* 2. The replay gate (`assertReplayPromotable`).
	* 3. S1-C item 3: the provider check. A skill candidate's sandbox directory and
	*    a capability candidate's new row are judged by the same
	*    {@link validateSkillProvider} admission, config load and capability
	*    replacement use, so `evolution_apply` is not the only entry that knows
	*    what a usable provider is — and a candidate carrying an execution
	*    sidecar with an unregistered verifier or ungranted tools is refused here,
	*    before a human is asked, before `decided` is recorded, and before
	*    anything is written.
	*/
	async checkPromotion(proposalId) {
		const proposal = await this.get(proposalId);
		if (proposal.prepared?.mechanical !== true) return { providers: [] };
		if (proposal.targetType === "skill") await this.readVerifiedSkillCandidate(proposal);
		assertReplayPromotable(await this.readRecordedReplay(proposal));
		return { providers: await this.assertProvidersPromotable(proposal) };
	}
	/**
	* The promotion-time provider check (S1-C item 3): what the promotion would
	* put in place, judged as a provider before it becomes production state.
	*
	* - `skill`: the materialized candidate directory
	*   (`sandbox/<id>/skills/<name>/`) is read as a skill directory and judged
	*   against the deployment's own sources — the effective capability table and
	*   the registered verifier vocabulary. Nothing is discovered from a root: the
	*   candidate is exactly the directory this promotion would write.
	* - `capability`: the row as it will read after the replacement is checked by
	*   the admission pre-check itself, over the table the replacement produces
	*   and the harness process's own discovery roots (the row's own tool labels
	*   expand through the same `resolveCapabilities` admission uses, which is what
	*   makes them the covering set for a skill that declares this row). Whichever
	*   skill the row grants must be reachable and usable from that viewpoint, or
	*   the row is refused rather than written and refused later at admission.
	* - every other target type carries no provider: nothing to judge.
	*
	* What the verdict means, in the vocabulary the whole system uses
	* (`sidecar.ts`): only an execution sidecar whose verifier is registered and
	* whose required tools its declared capabilities grant may be counted as an
	* execution provider; knowledge and guidance are loadable and are recorded as
	* such; anything else is a refusal naming every defect. None of it writes,
	* and nothing is recorded before the caller's own transition.
	*/
	async assertProvidersPromotable(proposal) {
		if (proposal.targetType === "skill") return [await this.assertSkillCandidateProvider(proposal)];
		if (proposal.targetType === "capability") return this.assertCapabilityRowProviders(proposal);
		return [];
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
	/**
	* The row a capability promotion would write, checked as the pre-check checks
	* a row: the replacement is folded into the effective table, and every skill
	* the new row grants is discovered from the harness process's own roots and
	* judged by {@link validateSkillProvider} — `verifierRefs` from the live
	* registry, the row's own tool labels expanding through `resolveCapabilities`
	* as the covering set. A refusal names the capability, the skill and every
	* defect, and nothing is written.
	*/
	async assertCapabilityRowProviders(proposal) {
		const { name, entry } = proposal.mutation;
		const table = this.effectiveCapabilities();
		if (table === void 0) throw new Error(`evolution: capability "${name}" cannot be promoted: the effective capability registry cannot be read in this context (no task-runtime service), so the providers the new row would grant cannot be judged`);
		const verifierRefs = await registeredVerifierIds(this.ctx);
		const { precheck, refusals } = await precheckReplacedCapabilityRow({
			name,
			entry,
			table,
			view: { cwd: process.cwd() },
			...verifierRefs === void 0 ? {} : { verifierRefs }
		});
		if (refusals.length > 0) throw new Error(`evolution: capability "${name}" cannot be promoted — the row it would write grants providers that are not usable:\n` + refusals.map((line) => `- ${line}`).join("\n"));
		return precheck.capabilities.flatMap((row) => row.skills).filter((verdict) => verdict.valid).map((verdict) => promotionProviderOf(verdict));
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
	*/
	fold(records) {
		const proposals = /* @__PURE__ */ new Map();
		for (const record of records) {
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
		this.fold(this.records);
	}
	/** Validate the staged fold first; memory commits only after the line is on disk. */
	async append(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
			this.fold([...this.records, record]);
			await mkdir(this.root, { recursive: true });
			await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
			this.records = [...this.records, record];
		});
		this.writes = run.then(() => void 0, () => void 0);
		await run;
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
	if (proposal.targetType === "skill") await sources.evolution.readSkillCandidate(proposal.proposalId);
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
			} else if (proposal.targetType === "skill") options = { overlay: { extraSkillRoots: [join(sandboxAbs, "skills")] } };
			else if (proposal.targetType === "task_definition") options = {
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
		...proposal.targetType === "skill" ? { candidateContent: prepared.skillContent } : {},
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
export { APPLYABLE_TARGET_TYPES, CHAMPION_SOURCES, CHAMPION_STATES, EVOLUTION_DECISIONS, EVOLUTION_LEVELS, EvolutionService, MECHANICAL_TARGET_TYPES, PRESET_REPLAY_MANUAL_REASON, REPLAY_RELATIONS, REPLAY_VERDICTS, applyTargets, assertReplayPromotable, assertReplayReport, compareReplaySides, evolution_default as default, editCapabilityRow, mutationMechanical, overallReplayVerdict, readCapabilityRowSource, renderProviderRoles, replayLineage, resolvePrepareChampion, restoreCapabilityRowSource, runReplayExperiment };