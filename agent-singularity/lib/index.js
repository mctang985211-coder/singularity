import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { TOOL_LABELS, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, bubbleWorkspacePath, materializeBubble, optionalService, recoveryAttemptWithKey, settleBubble, workerBaseline } from "@dangosys/dsh-singularity-task-runtime";
import { APPLYABLE_TARGET_TYPES, EVOLUTION_DECISIONS, EvolutionService, OUTCOME_JUDGE_PROMPT, applyTargets, assertDecisionTransition, assertOutcomePlan, canonicalJson, digestOf, modelSelectionOf, normalizeSnapshot, renderProviderRoles } from "@dangosys/dsh-singularity-evolution";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, canonicalize, isTerminalRunStatus, rootTaskStoreId, sha256Hex } from "@dangosys/dsh-singularity-task";
import { CONTEXT_OUTPUT_LIMIT_BYTES, CoordinationBindingError, OutputBudget, budgetList, utf8Bytes } from "@dangosys/dsh-singularity-context";
import { homedir } from "node:os";
import { SessionId, SessionLogOffset } from "@deepseek-ai/dsh-session";
import { graphAgentOptions } from "@dangosys/dsh-singularity-graphs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";

//#region src/log.ts
/** The soft logger a deployment may mount: absent logger, no crash — the line is simply not written. */
function logOf(ctx, name) {
	const logger = ctx.logger;
	return logger?.(name);
}
/** A `(line) => void` warn sink over the soft logger, for triggers that report their work off the caller's path. */
function warnLine(ctx, name = "singularity-agent") {
	return (line) => logOf(ctx, name)?.warn(line);
}

//#endregion
//#region src/services/hitl.ts
/** The one answer an unmanned graph's ask gets: nobody is online, so the agent keeps its goal and records the assumptions it made. */
const UNMANNED_ASK_ANSWER = "（无人迭代模式）无人工在线审核：请按你的最佳判断继续，保持目标不缩小，并在结果中记录你做出的假设。";
/** The canvas answerer on the native interaction seams: root tools ask through `ctx.userQuestions` / `ctx.approval` (audit events and fail-closed semantics live there), and this service is the answerer. */
var HitlService = class extends Service {
	static inject = ["userQuestions", "approval"];
	waiters = /* @__PURE__ */ new Map();
	lifetime = new AbortController();
	constructor(ctx) {
		super(ctx, "hitl");
		ctx.effect(() => () => this.lifetime.abort(/* @__PURE__ */ new Error("hitl: service disposed")), "hitl: waiters");
		ctx.on("user-questions/request", async (request, next) => {
			if (request.questions.length !== 1) return next();
			const question = request.questions[0];
			const text$1 = await this.enqueue(request.agent?.id ?? "unknown", "ask", question.question, request.signal);
			if (text$1.kind !== "ask") throw new Error("hitl: expected ask answer");
			return { answers: [{
				id: question.id,
				selected: [],
				custom: text$1.text
			}] };
		}, { prepend: true });
		ctx.on("approval/request", async (request) => {
			const prompt = request.reason ?? `Approve ${request.toolName}?`;
			const answer = await this.enqueue(request.agent.id, "approve", prompt, request.signal);
			if (answer.kind !== "approve") throw new Error("hitl: expected approve answer");
			return answer.decision === "approve" ? "allowed-once" : "rejected";
		}, { prepend: true });
	}
	list() {
		return [...this.waiters.values()].map((w) => w.pending);
	}
	answer(id, answer) {
		const waiter = this.waiters.get(id);
		if (waiter === void 0) throw new Error(`hitl: unknown request "${id}"`);
		if (waiter.pending.kind !== answer.kind) throw new Error(`hitl: kind mismatch for "${id}"`);
		if (answer.kind === "ask" && answer.text.trim().length === 0) throw new Error("hitl: empty ask answer");
		if (answer.kind === "approve" && answer.decision !== "approve" && answer.decision !== "reject") throw new Error("hitl: invalid approval decision");
		waiter.dispose();
		this.waiters.delete(id);
		waiter.resolve(answer);
		this.ctx.emit("hitl/change", this.list());
	}
	enqueue(sessionId$1, kind, prompt, callerSignal) {
		const signal = callerSignal === void 0 ? this.lifetime.signal : AbortSignal.any([callerSignal, this.lifetime.signal]);
		signal.throwIfAborted();
		if (typeof sessionId$1 !== "string" || sessionId$1.length === 0) throw new Error("hitl: missing session id");
		const graphs = this.ctx.get("graphs");
		if (typeof graphs?.graphForSession !== "function") return this.queue(sessionId$1, kind, prompt, signal);
		return this.enqueueForGraph(sessionId$1, kind, prompt, signal, graphs.graphForSession.bind(graphs));
	}
	/**
	* Ask only when the graph runs with a human: `rsi.humanReview === false` resolves the card on the spot
	* (approve → approved, ask → {@link UNMANNED_ASK_ANSWER}) and never queues one, so the pending list cannot grow.
	*/
	async enqueueForGraph(sessionId$1, kind, prompt, signal, resolveGraph) {
		let graph;
		try {
			graph = await resolveGraph(sessionId$1);
		} catch {
			graph = void 0;
		}
		signal.throwIfAborted();
		if (graph?.rsi?.humanReview !== false) return this.queue(sessionId$1, kind, prompt, signal);
		logOf(this.ctx, "hitl")?.info(`hitl: ${kind} card auto-resolved for graph ${graph.id} (unmanned mode): ${prompt}`);
		this.ctx.emit("hitl/change", this.list());
		return kind === "approve" ? {
			kind: "approve",
			decision: "approve"
		} : {
			kind: "ask",
			text: UNMANNED_ASK_ANSWER
		};
	}
	queue(sessionId$1, kind, prompt, signal) {
		const id = randomUUID();
		const pending = {
			id,
			kind,
			prompt,
			sessionId: sessionId$1,
			createdAt: Date.now()
		};
		const abort = () => {
			this.waiters.get(id).reject(signal.reason);
			this.waiters.delete(id);
			this.ctx.emit("hitl/change", this.list());
		};
		const promise = new Promise((resolve$1, reject) => {
			this.waiters.set(id, {
				pending,
				resolve: resolve$1,
				reject,
				dispose: () => signal.removeEventListener("abort", abort)
			});
			signal.addEventListener("abort", abort, { once: true });
		});
		this.ctx.emit("hitl/change", this.list());
		return promise.finally(() => signal.removeEventListener("abort", abort));
	}
};

//#endregion
//#region src/jsonl-ledger.ts
/** Every non-empty line of one JSONL file, parsed in order, or `undefined` when the file has never been written. A line the caller's parser refuses throws under the caller's own name. */
async function readJsonlFile(file, parse) {
	let text$1;
	try {
		text$1 = await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	const rows = [];
	text$1.split("\n").forEach((line, index) => {
		if (line.trim().length === 0) return;
		rows.push(parse(line, index + 1));
	});
	return rows;
}
/** Append one row to a JSONL file, creating its directory. */
async function appendJsonlRow(file, row) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
}

//#endregion
//#region src/services/escalation.ts
const ESCALATION_TRIGGERS = [
	"capability-gap",
	"budget-exhausted",
	"unknown-convergence",
	"human"
];
function nonEmpty(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`escalation: ${field} must be a non-empty string`);
	return value;
}
/** Payload validation shared by the write path (`raise`) and the fold, so a hand-forged ledger line fails load exactly as it would fail append: */
function assertRaised(record) {
	if (record.kind !== "raised") throw new Error(`escalation: unknown ledger kind "${String(record.kind)}"`);
	nonEmpty(record.escalationId, "escalationId");
	nonEmpty(record.what, "what");
	nonEmpty(record.tried, "tried");
	nonEmpty(record.suggested, "suggested");
	if (!ESCALATION_TRIGGERS.includes(record.trigger)) throw new Error(`escalation: unknown trigger "${String(record.trigger)}"`);
	if (!Array.isArray(record.sourceRefs) || record.sourceRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) throw new Error("escalation: sourceRefs must be an array of non-empty strings");
	if (record.sourceTaskId !== void 0) nonEmpty(record.sourceTaskId, "sourceTaskId");
	nonEmpty(record.approvalRef, "approvalRef");
	nonEmpty(record.actor, "actor");
	nonEmpty(record.at, "at");
}
/** The escalation ledger (plane separation: this store is independent of the task store and refers to it by id only). */
var EscalationService = class extends Service {
	/** Absolute ledger directory resolved at construction. */
	root;
	/** Repo root that relative paths resolve against. */
	repoRoot;
	records = [];
	loaded;
	writes = Promise.resolve();
	constructor(ctx, config = {}) {
		super(ctx, "escalation");
		this.repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
		const dshHome = process.env.DSH_HOME ?? join(this.repoRoot, ".dsh");
		this.root = resolve(config.root ?? dshHome);
		this.loaded = this.load();
		ctx.effect(() => async () => {
			await this.writes;
		}, "escalation: drain writes");
	}
	/** Ledger file path (`<root>/escalations.jsonl`). */
	get file() {
		return join(this.root, "escalations.jsonl");
	}
	/** Record one card. The caller (the `escalate` tool) must hold a human grant from `ctx.approval.request` first and pass its call id as `approvalRef` (`approval:<callId>`, the evolution_decide shape): a rejected, cancelled, */
	async raise(input, actor, approvalRef) {
		const record = {
			formatVersion: 1,
			kind: "raised",
			escalationId: nonEmpty(input.escalationId ?? `esc-${randomUUID()}`, "escalationId"),
			what: nonEmpty(input.what, "what"),
			tried: nonEmpty(input.tried, "tried"),
			suggested: nonEmpty(input.suggested, "suggested"),
			trigger: input.trigger,
			...input.sourceTaskId === void 0 ? {} : { sourceTaskId: nonEmpty(input.sourceTaskId, "sourceTaskId") },
			sourceRefs: (input.sourceRefs ?? []).map((ref, index) => nonEmpty(ref, `sourceRefs[${index}]`)),
			approvalRef: nonEmpty(approvalRef, "approvalRef"),
			actor,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		if (!ESCALATION_TRIGGERS.includes(record.trigger)) throw new Error(`escalation: unknown trigger "${String(input.trigger)}"`);
		await this.append(record);
		return this.get(record.escalationId);
	}
	/** Folded view of one card, or throws on an unknown id. */
	async get(escalationId) {
		await this.loaded;
		const escalation = this.fold(this.records).get(escalationId);
		if (escalation === void 0) throw new Error(`escalation: unknown escalation "${escalationId}"`);
		return escalation;
	}
	/** Folded views, newest card first. */
	async list() {
		await this.loaded;
		return [...this.fold(this.records).values()].reverse();
	}
	/** Fold records into cards, enforcing the payload rules on every step: a `raised` line starts a new id, a repeated id is refused, and every field is re-validated, so an illegal line fails load exactly as it would fail */
	fold(records) {
		const escalations = /* @__PURE__ */ new Map();
		for (const record of records) {
			assertRaised(record);
			if (escalations.has(record.escalationId)) throw new Error(`escalation: escalation "${record.escalationId}" already exists`);
			escalations.set(record.escalationId, {
				escalationId: record.escalationId,
				what: record.what,
				tried: record.tried,
				suggested: record.suggested,
				trigger: record.trigger,
				status: "open",
				...record.sourceTaskId === void 0 ? {} : { sourceTaskId: record.sourceTaskId },
				sourceRefs: [...record.sourceRefs],
				approvalRef: record.approvalRef,
				actor: record.actor,
				at: record.at,
				history: [{
					status: "open",
					actor: record.actor,
					at: record.at
				}]
			});
		}
		return escalations;
	}
	async load() {
		const records = await readJsonlFile(this.file, (line, lineNumber) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`escalation: corrupt ledger line ${lineNumber} in ${this.file}`);
			}
		}) ?? [];
		for (const record of records) if (record.formatVersion !== 1) throw new Error(`escalation: unsupported ledger formatVersion "${String(record.formatVersion)}"`);
		this.records = records;
		this.fold(this.records);
	}
	/** Validate the staged fold first; memory commits only after the line is on disk. */
	async append(record) {
		await this.loaded;
		const run = this.writes.then(async () => {
			this.fold([...this.records, record]);
			await appendJsonlRow(this.file, record);
			this.records = [...this.records, record];
		});
		this.writes = run.then(() => void 0, () => void 0);
		await run;
	}
};

//#endregion
//#region src/coordination/identity.ts
const STORE_PREFIX = "sg-t-";
/** The owner session of a root task store, or `undefined` for an id this deployment did not build. The parse is re-checked */
function ownerSessionOfStore(storeId) {
	if (!storeId.startsWith(STORE_PREFIX)) return void 0;
	const sessionId$1 = storeId.slice(5);
	return sessionId$1.length > 0 && rootTaskStoreId(sessionId$1) === storeId ? sessionId$1 : void 0;
}
/** The live root agent of one root task store: the owner session the store id derives, resolved against this process's agent registry — `undefined` when the parse fails or the session is not live here. */
function liveRootAgentOf(ctx, storeId) {
	const sessionId$1 = ownerSessionOfStore(storeId);
	if (sessionId$1 === void 0) return void 0;
	const agent = optionalService(ctx, "agents")?.get(sessionId$1);
	return agent === void 0 ? void 0 : {
		sessionId: sessionId$1,
		agent
	};
}
/** The ref a reader uses for one review source (`<taskId>#<runId>`, or `<taskId>#no-run`). */
function reviewRef(source) {
	return `${source.taskId}#${source.runId ?? "no-run"}`;
}
/** Whether two review sources are the same source. */
function sameSource(left, right) {
	return left.taskId === right.taskId && left.runId === right.runId;
}

//#endregion
//#region src/shared.ts
const text = (value) => [{
	type: "text",
	text: value
}];
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The caller's own session id: the read domain and every write attribution come from it, never from an argument. */
function sessionId(exec, tool) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error(`${tool}: missing agent id`);
	return id;
}
/** Refuse a call that carries a key the tool does not declare, naming the keys rather than ignoring them. */
function undeclaredParameters(args, declared, toolName, detail = "and has no argument that approves, decides, or stands in for a review", closing = "nothing was read and nothing was changed.") {
	const undeclared = Object.keys(args).filter((key) => !declared.includes(key));
	if (undeclared.length === 0) return void 0;
	return [
		`${toolName} rejected: undeclared parameter${undeclared.length === 1 ? "" : "s"} ${undeclared.map((key) => `"${key}"`).join(", ")} —`,
		`this tool accepts ${declared.join(", ")} ${detail};`,
		closing
	].join(" ");
}
/** Why an approval outcome did not grant: the one wording every human-gate tool reports. */
function denialReason(outcome, wording = {}) {
	if (outcome === "rejected") return "the human rejected it";
	if (outcome === "cancelled") return wording.cancelled ?? "the request was cancelled before the human decided";
	return wording.unavailable ?? "no approval answerer available";
}
/** The `hitl_approve` answer: only `allowed-once` grants, every other outcome fails closed to a rejection. */
function approvalAnswer(outcome) {
	switch (outcome) {
		case "allowed-once": return "approve";
		case "rejected": return "reject";
		case "cancelled": return "reject (cancelled before the human decided)";
		case "unavailable": return "reject (no approval answerer available)";
	}
}
/** One context read as one tool answer: the text when it answered, the named refusal with its detail when it refused. */
function adaptRead(tool, result) {
	if (result.ok) return result.text;
	return `${tool} ${result.refusal}:\n${result.detail}`;
}
/** The store one proposal call belongs to, from the caller's own trusted binding — never from an argument. */
async function proposalStoreFor(ctx, session) {
	const resolution = await ctx.singularityContext.resolveCaller(session);
	if (resolution.kind === "worker" || resolution.kind === "root") return resolution.storeId;
	throw new Error(`task-runtime: no task run is bound to session "${session}"`);
}
/** The identity a question call runs under; a call with no live agent or no registration id has no body to cite. */
function questionCall(exec, tool) {
	const caller = sessionId(exec, tool);
	const callId = exec.callId;
	if (typeof callId !== "string" || callId.length === 0) throw new Error(`${tool}: this call carries no registration id, so the body it would record cannot be cited; a question or an answer is only ever recorded from the message the caller itself wrote`);
	return {
		caller,
		callId
	};
}
/** The lines a commit tool reports for an intent it settled instead of starting a second commit. */
function renderOpenIntentRecovery(intent, recovered) {
	return [`recovered commit intent ${intent.intentId} (${recovered ?? "unreported"}): ${recoveryNote(recovered)}`, `no second approval was asked — the intent already binds ${intent.approvalRef}`];
}
function recoveryNote(recovered) {
	switch (recovered) {
		case "redone": return "production still held the state before this commit, so the same write was carried out and its completion recorded";
		case "written": return "production already held the content this commit installed, so only its completion was recorded and production was not written again";
		default: return "the service reported no recovery result for a proposal that had an open commit intent — production was left exactly as the intent found it";
	}
}

//#endregion
//#region src/services/proposal-render.ts
/** How a container field is listed, or that it held nothing — never an omitted line a reader has to notice. */
function listField(title, items, empty) {
	if (items.length === 0) return [`  ${title}: ${empty}`];
	return [`  ${title}:`, ...items.map((item) => `  - ${item}`)];
}
/** The protected acceptance inputs a criterion declares, with the identity fixed at submission: */
function protectedInputsPart(criterion) {
	const declared = criterion.protectedInputs ?? [];
	if (declared.length === 0) return "";
	return ` [protected inputs: ${declared.map((ref) => `${ref.path} sha256:${ref.sha256}`).join(", ")}]`;
}
/** The evidence and artifact requirements a criterion declares, as one suffix — omitted entirely when it declares none. */
function requirementParts(criterion) {
	const parts = [];
	if (criterion.requiredEvidence.length > 0) parts.push(`required evidence: ${criterion.requiredEvidence.join(", ")}`);
	if ((criterion.requiresArtifact ?? []).length > 0) parts.push(`requires verified artifact: ${criterion.requiresArtifact.join(", ")}`);
	if ((criterion.acceptsArtifact ?? []).length > 0) parts.push(`accepts artifact: ${criterion.acceptsArtifact.join(", ")}`);
	if (criterion.childEvidence !== void 0 && criterion.childEvidence.length > 0) parts.push(`child evidence: ${criterion.childEvidence.map((item) => `run member ${item.childIndex}${item.criterionId === void 0 ? "" : `:${item.criterionId}`}${item.evidenceRef === void 0 ? "" : `#${item.evidenceRef}`}`).join(", ")}`);
	return parts;
}
/** How a criterion reads to a reviewer: its id, its mode, whether it is mandatory, whether it is a heuristic judgement (which never counts as a deterministic pass — §5 requires the marking, not a. */
function criterionLine(criterion, indent = "    ") {
	const qualifiers = [
		criterion.verificationMode,
		...criterion.mandatory ? ["mandatory"] : ["optional"],
		...criterion.heuristic === true ? ["heuristic — judged by a model, never a deterministic pass"] : []
	];
	const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
	const verifier = criterion.verifierRef === void 0 ? "" : ` [verifier: ${criterion.verifierRef}]`;
	const requirements = requirementParts(criterion);
	const requirementText = requirements.length === 0 ? "" : ` [${requirements.join("; ")}]`;
	return `${indent}- ${criterion.criterionId} [${qualifiers.join(", ")}] ${criterion.description}${command}${verifier}${protectedInputsPart(criterion)}${requirementText}`;
}
/** How one declared capability resolved when this batch was proposed: the manifest the runtime built for *this* child, with the skills and tools a worker would be granted — and the capability gap named when a requirement is */
function resolutionLines(manifest) {
	if (manifest === void 0) return [];
	const entries = Object.entries(manifest.capabilities);
	if (entries.length === 0 && manifest.missing.length === 0) return [];
	const lines = entries.map(([name, entry]) => {
		const parts = [
			...entry.skills.length === 0 ? [] : [`skills: ${entry.skills.join(", ")}`],
			...entry.tools.length === 0 ? [] : [`tools: ${entry.tools.join(", ")}`],
			...entry.preset === void 0 ? [] : [`preset: ${entry.preset}`],
			...entry.permission === void 0 ? [] : [`permission: ${entry.permission}`],
			...entry.mcpServers === void 0 || entry.mcpServers.length === 0 ? [] : [`mcp servers: ${entry.mcpServers.join(", ")}`]
		];
		return `  - ${name} → ${parts.length === 0 ? "granted no skill or tool" : parts.join("; ")}`;
	});
	const missing = manifest.missing.map((name) => `  - ${name} → NOT GRANTED (capability gap: the registry has no such row, and this batch's admission recorded it)`);
	return [
		"  resolution (the manifests this batch resolved to):",
		...lines,
		...missing
	];
}
/** One child of the batch as a reviewer reads it (§5): its goal, its criteria, what it inherits as assumptions and constraints, what it waits for, what it requires, and how those requirements currently resolve. */
function renderProposalChild(child, options) {
	const contract = child.contract;
	const verifierRefs = [...new Set(contract.acceptanceCriteria.flatMap((criterion) => criterion.verifierRef ?? []))];
	const dependencies = child.dependsOn.map((index) => {
		const sibling = options.siblings[index];
		return `child ${index}${sibling === void 0 ? "" : ` (${sibling.contract.objective})`}`;
	});
	return [
		`- child ${options.index}: ${contract.objective}`,
		...options.contractDigest === void 0 ? [] : [`  contract digest (sha256): ${options.contractDigest}`],
		`  contract version: ${contract.contractVersion}`,
		"  acceptance criteria:",
		...contract.acceptanceCriteria.map((criterion) => criterionLine(criterion)),
		...verifierRefs.length === 0 ? [] : [`  pinned verifiers: ${verifierRefs.join(", ")}`],
		...listField("assumptions", contract.assumptions, "(none declared — the contract rests on nothing stated)"),
		...listField("constraints", contract.constraints, "(none declared)"),
		...listField("required capabilities", contract.requiredCapabilities, "(none)"),
		...resolutionLines(options.manifest),
		...listField("depends on", dependencies, "(nothing — this child may start first)"),
		`  decomposable: ${child.decomposable ? "yes" : "no"}; requires independent acceptance: ${child.requiresIndependentAcceptance ? "yes" : "no"}`
	];
}
/** The complete batch content of a stored proposal, one block per child in batch order — the whole set, never a prefix. */
function renderProposalChildren(proposal, manifests) {
	return proposal.batch.flatMap((child, index) => [...renderProposalChild(child, {
		index,
		siblings: proposal.batch,
		...proposal.identity.children[index]?.contractDigest === void 0 ? {} : { contractDigest: proposal.identity.children[index].contractDigest },
		...manifests?.[index] === void 0 ? {} : { manifest: manifests[index] }
	}), ""]);
}
/** One root contract as a reviewer reads it (§5's display list for the subject that has no parent): the contract version, the objective, every criterion with the markings {@link criterionLine} prints, the assumptions and */
function renderRootContract(contract, manifests) {
	return [
		`- contract version: ${contract.contractVersion}`,
		`- objective: ${contract.objective}`,
		"- acceptance criteria:",
		...contract.acceptanceCriteria.map((criterion) => criterionLine(criterion, "  ")),
		...listField("assumptions", contract.assumptions, "(none declared — the contract rests on nothing stated)"),
		...listField("constraints", contract.constraints, "(none declared)"),
		...listField("required capabilities", contract.requiredCapabilities, "(none)"),
		...resolutionLines(manifests?.[0])
	];
}
/** The limits one proposal was admitted under, as the record holds them, with the enforced and the audited values kept apart. */
function limitLines(proposal) {
	const context = proposal.admissionContext;
	const audited = [
		...context.auditOnly.maxToolCalls === void 0 ? [] : [`maxToolCalls ${context.auditOnly.maxToolCalls}`],
		...context.auditOnly.tokens === void 0 ? [] : [`tokens ${context.auditOnly.tokens}`],
		...context.auditOnly.attempts === void 0 ? [] : [`attempts ${context.auditOnly.attempts}`]
	];
	return [`- enforced at admission: maxDepth ${context.maxDepth}, maxChildren ${context.maxChildren}`, `- audited after the run (never enforced in flight): ${audited.length === 0 ? "none configured" : audited.join(", ")}`];
}
/** The identity a decision binds, as both subjects print it: the three digests, the resolution, the key and the submission time. `subject` only names what the pinned verifiers belong to. */
function identityLines(proposal, subject, registeredVerifiers) {
	return [
		`- proposal digest (sha256): ${proposal.proposalDigest}`,
		`- admission context digest (the limits above): ${proposal.admissionContextDigest}`,
		`- review context digest (the resolution above): ${proposal.reviewContextDigest}`,
		`- capability manifest digest: ${proposal.reviewContext.capabilityManifestDigest}`,
		`- judging verifiers (the ids this ${subject}'s criteria pin): ${proposal.reviewContext.verifiers.length === 0 ? "(none pinned — criteria dispatch by mode)" : proposal.reviewContext.verifiers.map((verifier) => verifier.verifierId).join(", ")}`,
		...registeredVerifiers === void 0 ? ["- the deployment could not list its verifier registry when this review was requested"] : [`- registered verifiers now: ${registeredVerifiers.join(", ")}`],
		`- request key: ${proposal.requestKey}`,
		...proposal.supersedes === void 0 ? [] : [`- supersedes: ${proposal.supersedes}`],
		`- submitted at: ${proposal.createdAt}`
	];
}
/** The obligations a review lists, as the request carried them. An empty list is printed as one line rather than omitted: */
function reviewObligationLines(obligations) {
	return obligations.length === 0 ? ["(none recorded when this review was requested)"] : obligations.map((obligation) => `- ${obligation.obligationId}: ${obligation.goal} — judged by: ${obligation.criterion}`);
}
/** The review of a decomposition batch (T2/T3 §5): the parent's own goal, every child, the limits and the obligations on the parent. */
function renderBatchReview(request) {
	const proposal = request.proposal;
	if (proposal.kind === "root") throw new Error(`proposal-review: proposal "${proposal.proposalId}" is a root contract, which a batch review cannot carry`);
	const parent = request.parentTask;
	return [
		`Batch review — proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}, trigger: ${request.trigger})`,
		`store: ${request.storeId}`,
		"",
		"A decision answers one question: should this batch run as it is written here? Approving it does not mean the work is",
		"accepted (the verifiers still judge every criterion), does not grant a capability, and does not close a gap. The",
		"decision binds the batch digest and both context fingerprints printed below: a revision, a re-resolution or a",
		"changed limit is a different proposal.",
		"",
		"## Parent task",
		`- ${parent.taskId} [${parent.status}/${parent.decompositionStatus}] depth ${parent.depth}`,
		`- objective: ${parent.objective}`,
		"- acceptance criteria:",
		...parent.acceptanceCriteria.map((criterion) => `  - ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ", mandatory" : ""}] ${criterion.description}`),
		`- run: ${proposal.identity.parentRunId} (proposing session ${proposal.identity.callerSessionId})`,
		`- reason recorded for this batch: ${proposal.identity.reason}`,
		"",
		`## Children (${request.batch.children.length})`,
		...renderProposalChildren(proposal, request.manifests),
		"## Limits this batch is admitted under",
		...limitLines(proposal),
		"",
		`## Unmet obligations on the parent (${request.obligations.length})`,
		...reviewObligationLines(request.obligations),
		"",
		"## Identity — what an approval would bind",
		...identityLines(proposal, "batch", request.registeredVerifiers),
		"",
		"## What this review cannot promise",
		"- the manifests above name skills, tools, presets and MCP servers — names, not the bytes behind them. What a worker",
		"  actually loads is pinned per run at spawn, which happens after this decision.",
		"- a verifier is named by the registered id its criteria pin. This deployment cannot name the version or the",
		"  configuration that registration currently stands for.",
		"- a criterion marked heuristic is judged by a model; nothing in this batch turns it into a deterministic pass."
	].join("\n");
}
/** The review of a root contract (A0 §3): the goal a root session would be admitted as, and no parent section — there is no parent task, and the root task this contract becomes does not exist while it waits. */
function renderRootReview(request) {
	const proposal = request.proposal;
	return [
		`Root contract review — proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}, trigger: ${request.trigger})`,
		`store: ${request.storeId}`,
		"",
		"A decision answers one question: should this root contract be accepted as the goal this graph works toward? Approving",
		"it does not mean the work is accepted (the verifiers still judge every criterion), does not grant a capability and does",
		"not close a gap. Nothing exists while it waits — no root task, no run and no worker: the root task is what this contract",
		"becomes once the runtime re-checks and activates it. The decision binds the contract digest and both context",
		"fingerprints printed below: a revision, a re-resolution or a changed limit is a different proposal.",
		"",
		"## Root contract (the goal this session would be admitted as)",
		`- root session: ${request.rootSessionId}`,
		...renderRootContract(request.contract, request.manifests),
		"",
		"## Limits this contract is admitted under",
		...limitLines(proposal),
		"",
		`## Unmet obligations on this root contract (${request.obligations.length})`,
		...reviewObligationLines(request.obligations),
		"",
		"## Identity — what an approval would bind",
		...identityLines(proposal, "contract", request.registeredVerifiers),
		"",
		"## What this review cannot promise",
		"- the manifests above name skills, tools, presets and MCP servers — names, not the bytes behind them. What the root run",
		"  actually loads is pinned when it is activated, which happens after this decision.",
		"- a verifier is named by the registered id its criteria pin. This deployment cannot name the version or the",
		"  configuration that registration currently stands for.",
		"- a criterion marked heuristic is judged by a model; nothing in this contract turns it into a deterministic pass.",
		"- the objective above is the root agent's reading of the user's request. This card carries the contract, not the request",
		"  it was built from, and machine admission does not prove that reading correct (A0 §1.10)."
	].join("\n");
}
/** The review material one person is shown (§5), rendered from the saved facts: */
function renderProposalReview(request) {
	return request.kind === "root" ? renderRootReview(request) : renderBatchReview(request);
}

//#endregion
//#region src/services/proposal-review.ts
/** The tool name a batch review's question is about: the decomposition the batch would become (audit and presentation). */
const BATCH_REVIEW_TOOL_NAME = "task_decompose";
/** The tool name a root contract review's question is about: the intake that submitted the contract. */
const ROOT_REVIEW_TOOL_NAME = "task_intake";
/** The decider identity the channel records: the approval surface of the owner session the review was shown in. */
function reviewDecider(ownerSessionId) {
	return `approval:${ownerSessionId}`;
}
/** The review channel this deployment mounts (T2/T3 §5–§6). It renders, asks, and records; */
var ProposalReviewService = class extends Service {
	lifetime = new AbortController();
	constructor(ctx) {
		super(ctx, "proposalReviewChannel");
		ctx.effect(() => () => this.lifetime.abort(/* @__PURE__ */ new Error("proposal-review: service disposed")), "proposal-review: pending asks");
	}
	async requestReview(request) {
		const ownerSessionId = ownerSessionOfStore(request.storeId);
		if (ownerSessionId === void 0) return {
			requested: false,
			detail: `store "${request.storeId}" does not name the root session a review has to be shown in, so nobody was asked; the proposal stays pending_review`
		};
		const agent = this.liveAgent(ownerSessionId);
		if (agent === void 0) return {
			requested: false,
			detail: `the owner session "${ownerSessionId}" has no live agent, so nobody was asked; the proposal stays pending_review until a decision is recorded (opening the graph again asks on the next request)`
		};
		if (!this.asksAPerson(agent)) return {
			requested: false,
			detail: `the owner session "${ownerSessionId}" runs with approval policy "never": an ask here is auto-rejected before any answerer sees it, which would record a refusal nobody made. Nobody was asked; the proposal stays pending_review`
		};
		const ask = this.ctx.approval.request({
			agent,
			toolName: request.kind === "root" ? ROOT_REVIEW_TOOL_NAME : BATCH_REVIEW_TOOL_NAME,
			reason: renderProposalReview(request),
			signal: this.lifetime.signal
		});
		let reached;
		try {
			reached = await Promise.race([ask, Promise.resolve("pending")]);
		} catch (error) {
			return {
				requested: false,
				detail: `the approval channel could not ask the owner session "${ownerSessionId}" (${message(error)}), so nobody was asked; the proposal stays pending_review`
			};
		}
		if (reached === "pending") {
			ask.then((outcome) => this.record(request, ownerSessionId, outcome)).catch((error) => this.warn(`proposal ${request.proposal.proposalId}: the review request to session "${ownerSessionId}" ended without a usable answer (${message(error)}); the proposal keeps the status the store holds`));
			return {
				requested: true,
				detail: `the review was put to the owner session "${ownerSessionId}" through the approval channel; the proposal stays pending_review until the decision is recorded, and the runtime continues the batch when it is`
			};
		}
		if (reached === "allowed-once" || reached === "rejected") {
			this.record(request, ownerSessionId, reached).catch((error) => this.warn(`proposal ${request.proposal.proposalId}: the answer of session "${ownerSessionId}" could not be recorded (${message(error)}); the proposal keeps the status the store holds`));
			return {
				requested: true,
				detail: `the owner session "${ownerSessionId}" answered the review with ${reached === "allowed-once" ? "approval" : "a refusal"}; the decision is being recorded on the proposal`
			};
		}
		return {
			requested: false,
			detail: reached === "cancelled" ? "the review request was withdrawn before a person decided, so no decision was recorded; the proposal stays pending_review" : "no approval answerer was available, so nobody was asked; the proposal stays pending_review"
		};
	}
	/** One human answer, turned into the only thing that can move a waiting proposal: a decision on the record. An approval is recorded as `approved` (the runtime then re-checks the batch and admits it); an explicit refusal as */
	async record(request, ownerSessionId, outcome) {
		const proposalId = request.proposal.proposalId;
		const decidedBy = reviewDecider(ownerSessionId);
		if (outcome === "allowed-once") {
			const result = await this.runtime().decideProposal(request.storeId, proposalId, { outcome: "approved" }, decidedBy);
			this.info(`proposal ${proposalId}: the owner session "${ownerSessionId}" approved the batch — ${result.detail}`);
			return;
		}
		if (outcome === "rejected") {
			const result = await this.runtime().decideProposal(request.storeId, proposalId, {
				outcome: "rejected",
				reason: `the owner refused this batch through the approval channel (session "${ownerSessionId}")`
			}, decidedBy);
			this.info(`proposal ${proposalId}: the owner session "${ownerSessionId}" refused the batch — ${result.detail}`);
		}
	}
	/** The live agent behind one session, or `undefined` — an absent registry or a departed session is a state, not a throw. */
	liveAgent(sessionId$1) {
		return this.ctx.get("agents")?.get?.(sessionId$1);
	}
	/** Whether one session's approval policy asks a person at all. The policy is the approval service's own (a session override, else the configured default): under `never` the service answers `rejected` without dispatching */
	asksAPerson(agent) {
		const service = this.ctx.approval;
		return (service?.overrideOf?.(agent.session) ?? service?.config?.policy ?? "ask") === "ask";
	}
	/** The runtime that owns the store; resolved lazily, because the store is opened after this service is mounted. */
	runtime() {
		return this.ctx.taskRuntime;
	}
	/** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
	warn(message$1) {
		logOf(this.ctx, "proposal-review")?.warn(message$1);
	}
	/** The same seam at info level, for the trace of a decision that landed. */
	info(message$1) {
		logOf(this.ctx, "proposal-review")?.info(message$1);
	}
};

//#endregion
//#region src/coordination/supervision.ts
/** Eight coordination runs per store. */
const DEFAULT_SUPERVISION = { coordinationBudget: 8 };
let current = DEFAULT_SUPERVISION;
/** One numeric member: a finite value at or above the floor, floored to a whole count; anything else reads as the default. */
function whole(value, fallback, floor) {
	return typeof value === "number" && Number.isFinite(value) && value >= floor ? Math.floor(value) : fallback;
}
/** Resolve and install the deployment's settings; absent members read as the shipped defaults. */
function configureSupervision(config) {
	current = { coordinationBudget: whole(config?.coordinationBudget, DEFAULT_SUPERVISION.coordinationBudget, 1) };
	return current;
}
/** The settings in force: the deployment's own, or the shipped defaults while none was configured. */
function supervisionSettings() {
	return current;
}
/**
* The round cap one graph's RSI settings declare for its root task store (F):
* `rsi.iterationRounds` is how many rounds that graph's platform loop runs, and
* the runtime's per-source cap has to admit exactly those. The platform driver
* (`coordination/rsi-loop.ts`) registers a store when it takes the graph's loop
* over and forgets it when the loop ends or the config is cleared; a store no
* graph registers is not running a loop, and the runtime's own constant stands
* for it unchanged. This process never reads the cap itself — it answers the
* runtime's `singularitySupervision.maxImprovementRoundsFor` question.
*/
const graphRoundsCaps = /* @__PURE__ */ new Map();
/** Declare one store's round cap; the graph's own RSI round count is the only caller. */
function registerGraphImprovementCap(storeId, rounds) {
	if (!Number.isFinite(rounds) || rounds < 0) return;
	graphRoundsCaps.set(storeId, Math.floor(rounds));
}
/** Forget one store's declared cap: its graph runs no RSI loop any more, so the runtime's constant stands again. */
function unregisterGraphImprovementCap(storeId) {
	graphRoundsCaps.delete(storeId);
}
/** The round cap a store's graph declares, or `undefined` when no graph runs an RSI loop over it. */
function graphImprovementCap(storeId) {
	return graphRoundsCaps.get(storeId);
}

//#endregion
//#region src/coordination/ledger.ts
/** How many review agents this store has started, as this region's read of the ledger holds them — the shipped default of `supervision.coordinationBudget`. */
const REVIEW_AGENT_BUDGET_DEFAULT = DEFAULT_SUPERVISION.coordinationBudget;
/** Repo root, derived at this file's depth — the same root the agent assembly hands the evolution ledger. */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
/** Directory holding the ledger; `$DSH_HOME/review-agents` unless overridden. */
function reviewAgentLedgerDir() {
	const override = process.env.SINGULARITY_REVIEW_LEDGER_DIR;
	if (override !== void 0 && override.length > 0) return resolve(override);
	return join(process.env.DSH_HOME ?? join(repoRoot, ".dsh"), "review-agents");
}
/** The ledger file (`<dir>/agents.jsonl`). */
function reviewAgentLedgerFile() {
	return join(reviewAgentLedgerDir(), "agents.jsonl");
}
/** The per-root-store cap: env `SINGULARITY_REVIEW_AGENT_BUDGET` wins, then the deployment's `supervision.coordinationBudget`, then {@link REVIEW_AGENT_BUDGET_DEFAULT}. */
function reviewAgentBudget() {
	const raw = process.env.SINGULARITY_REVIEW_AGENT_BUDGET;
	const parsed = raw === void 0 || raw.length === 0 ? NaN : Number(raw);
	if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
	return supervisionSettings().coordinationBudget;
}
/** One parsed row. An unrecognized row throws by name rather than being read as something it is not. */
function asLedgerRow(parsed, line) {
	const row = parsed;
	if (row.formatVersion === 2 && (row.kind === "claim" || row.kind === "started" || row.kind === "settled")) return row;
	throw new Error(`review-agent-ledger: unrecognized row ${line} in ${reviewAgentLedgerFile()}`);
}
/** Every ledger row, or `undefined` when the ledger has never been written (zero rows is a state, not a failure). A corrupt line throws by name rather than undercounting. */
async function readLedgerRows() {
	return await readJsonlFile(reviewAgentLedgerFile(), (line, lineNumber) => {
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`review-agent-ledger: corrupt line ${lineNumber} in ${reviewAgentLedgerFile()}`);
		}
		return asLedgerRow(parsed, lineNumber);
	});
}
/** A started fact: the spend and the delegation. */
function isStartedRow(row) {
	return row.formatVersion === 2 && row.kind === "started";
}
/** One store's rows of a kind the caller needs. */
function storeRows(rows, rootStoreId, match) {
	return rows.filter((row) => row.rootStoreId === rootStoreId).filter(match);
}
/** The store's started rows — the durable count, and the delegation rows. */
function startedRowsOf(rows, rootStoreId) {
	return storeRows(rows, rootStoreId, isStartedRow);
}
/** The attempts one store's rows hold, in the order they were claimed: each claim row is an attempt, its identity is the session it names, and the started/settled rows that name the same session are its facts. A settled */
function attemptsOf(rows, rootStoreId) {
	const startedSessions = new Set(startedRowsOf(rows, rootStoreId).map((row) => row.sessionId));
	const settled = /* @__PURE__ */ new Map();
	for (const row of storeRows(rows, rootStoreId, (candidate) => candidate.formatVersion === 2 && candidate.kind === "settled")) if (!settled.has(row.sessionId)) settled.set(row.sessionId, {
		status: row.status,
		...row.note === void 0 ? {} : { note: row.note },
		at: row.at
	});
	return storeRows(rows, rootStoreId, (candidate) => candidate.formatVersion === 2 && candidate.kind === "claim").map((row) => ({
		role: roleOf$1(row.role),
		source: {
			taskId: row.taskId,
			runId: row.runId
		},
		requestKey: row.requestKey,
		reason: row.reason,
		...row.diagnosisId === void 0 ? {} : { diagnosisId: row.diagnosisId },
		...row.handoffDigest === void 0 ? {} : { handoffDigest: row.handoffDigest },
		sessionId: row.sessionId,
		actor: row.actor,
		at: row.at,
		started: startedSessions.has(row.sessionId),
		settlement: settled.get(row.sessionId)
	}));
}
/** The role a row or a request belongs to: an older row carries none and is a reviewer's. */
function roleOf$1(role) {
	return role === "supervisor" ? "supervisor" : "reviewer";
}
/** The attempts of one role among a store's attempts — the two roles never dedupe against each other. */
function attemptsOfRole(attempts, role) {
	return attempts.filter((attempt) => attempt.role === role);
}
/** Decide one review request against one store's attempts. Pure, so every branch is testable and the admission's order is the order written here: */
function planReviewAttempt(input) {
	const { request, budget } = input;
	const mine = attemptsOfRole(input.attempts, "reviewer").filter((attempt) => sameSource(attempt.source, request.source));
	const same = mine.find((attempt) => attempt.requestKey === request.requestKey);
	if (same !== void 0) {
		if (same.reason !== request.reason) return {
			kind: "refused",
			code: "request-key-conflict",
			attempt: same,
			attempts: mine,
			budget
		};
		return {
			kind: "reuse",
			attempt: same
		};
	}
	const open = mine.find((attempt) => attempt.settlement === void 0);
	if (open !== void 0) return {
		kind: "in-flight",
		attempt: open
	};
	if (mine.length > 0 && request.requestKey === null) return {
		kind: "refused",
		code: "request-key-required",
		attempt: mine.at(-1),
		attempts: mine,
		budget
	};
	if (budget.used >= budget.max) return {
		kind: "refused",
		code: "budget-exhausted",
		attempt: void 0,
		attempts: mine,
		budget
	};
	return {
		kind: "start",
		budget
	};
}
/** Decide one round's supervisor request against one store's attempts: a concluded supervision is answered with the supervisor it already had; an interrupted one is a failure and does not block a fresh attempt. */
function planSupervisorAttempt(input) {
	const { request, budget } = input;
	const mine = attemptsOfRole(input.attempts, "supervisor").filter((attempt) => attempt.diagnosisId === request.diagnosisId);
	const conflicting = mine.find((attempt) => attempt.handoffDigest !== request.handoffDigest);
	if (conflicting !== void 0) return {
		kind: "refused",
		code: "request-key-conflict",
		attempt: conflicting,
		attempts: mine,
		budget
	};
	const takenUp = mine.filter((attempt) => attempt.started && attempt.settlement === void 0).at(-1);
	if (takenUp !== void 0) return {
		kind: "reuse",
		attempt: takenUp
	};
	const open = mine.find((attempt) => attempt.settlement === void 0);
	if (open !== void 0) return {
		kind: "in-flight",
		attempt: open
	};
	const concluded = mine.filter((attempt) => attempt.settlement?.status === "closed" && input.retryClosed !== true || attempt.settlement?.status === "recorded" && !input.resumeRecorded).at(-1);
	if (concluded !== void 0) return {
		kind: "reuse",
		attempt: concluded
	};
	if (budget.used >= budget.max) return {
		kind: "refused",
		code: "budget-exhausted",
		attempt: void 0,
		attempts: mine,
		budget
	};
	return {
		kind: "start",
		budget
	};
}
/** Every attempt this root store's ledger holds, for a reader that renders the state rather than deciding on it (`task_review_pack`). A display query: the decision is always made inside the admission's serial region. */
async function readReviewAgentAttempts(rootStoreId) {
	return attemptsOf(await readLedgerRows() ?? [], rootStoreId);
}
/** The budget one admission belongs to: a ledger file and a root store. */
function budgetKey(rootStoreId) {
	return `${reviewAgentLedgerFile()}\u0000${rootStoreId}`;
}
/** The serial regions, one promise chain per budget key. A region is the only place an attempt is decided on and claimed, so the attempts an admission sees and the claim it writes cannot have another. */
const regions = /* @__PURE__ */ new Map();
/** Append one row, creating the ledger directory if needed. Only the doors below write. */
async function appendRow(row) {
	await appendJsonlRow(reviewAgentLedgerFile(), row);
}
/** The claim row one request becomes. */
function claimRow(rootStoreId, request) {
	const role = roleOf$1(request.role);
	return {
		formatVersion: 2,
		kind: "claim",
		...role === "reviewer" ? {} : { role },
		rootStoreId,
		taskId: request.source.taskId,
		runId: request.source.runId,
		requestKey: request.requestKey,
		reason: request.reason,
		...request.diagnosisId === void 0 ? {} : { diagnosisId: request.diagnosisId },
		...request.handoffDigest === void 0 ? {} : { handoffDigest: request.handoffDigest },
		sessionId: request.sessionId,
		actor: request.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/** Record one attempt's terminal fact. Append-only and outside the serial region on purpose: the caller writes it after it observed the outcome, which is always after the region that started the attempt has ended (A5: */
async function settleReviewAgentAttempt(settlement) {
	try {
		await appendRow({
			formatVersion: 2,
			kind: "settled",
			rootStoreId: settlement.rootStoreId,
			taskId: settlement.taskId,
			sessionId: settlement.sessionId,
			status: settlement.status,
			...settlement.note === void 0 ? {} : { note: settlement.note },
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
	} finally {
		liveAttempts.delete(settlement.sessionId);
	}
}
/** What a claim without a started row says about how the attempt ended. */
const CLAIM_NEVER_STARTED = "the attempt was claimed but its process never reached model input";
/** What a started attempt no process is running any more says about how it ended. */
const STARTED_OWNER_GONE = "the process that started this attempt is gone and no result was recorded";
/** What an attempt whose diagnosis the store already holds says about how it ended. */
const DIAGNOSIS_ALREADY_RECORDED = "the diagnosis was already recorded; the ledger is read back from the store";
/** The attempts this process started and has not settled, by the reviewer session each was claimed under. */
const liveAttempts = /* @__PURE__ */ new Set();
/** Run one review-agent admission inside the ledger's serial region for a store. */
async function admitReviewAgent(rootStoreId, work) {
	const key = budgetKey(rootStoreId);
	const result = (regions.get(key) ?? Promise.resolve()).then(async () => {
		const rows = await readLedgerRows() ?? [];
		const started = startedRowsOf(rows, rootStoreId).length;
		let used = started;
		const attempts = attemptsOf(rows, rootStoreId);
		/** The attempt identities this store has already spent a run on, as this region read them. */
		const startedSessions = new Set(startedRowsOf(rows, rootStoreId).map((row) => row.sessionId));
		/** The attempts this very region claimed: its own work in progress, never a dead one. */
		const claimedHere = /* @__PURE__ */ new Set();
		return work({
			started,
			plan: async (request, hooks) => {
				const requestRole = roleOf$1(request.role);
				const recovered = [];
				for (const attempt of attempts) {
					if (attempt.role !== requestRole) continue;
					if (requestRole === "reviewer") {
						if (!sameSource(attempt.source, request.source)) continue;
					} else if (attempt.diagnosisId !== request.diagnosisId) continue;
					if (attempt.settlement !== void 0) continue;
					if (liveAttempts.has(attempt.sessionId) || claimedHere.has(attempt.sessionId)) continue;
					const latest = (await readReviewAgentAttempts(rootStoreId)).find((item) => item.sessionId === attempt.sessionId);
					if (latest?.settlement !== void 0) {
						Object.assign(attempt, { settlement: latest.settlement });
						continue;
					}
					const recorded = await hooks?.recorded?.(attempt) === true;
					const status = recorded ? "recorded" : "interrupted";
					const note = recorded ? requestRole === "reviewer" ? DIAGNOSIS_ALREADY_RECORDED : "the proposal or recovery outcome is durable; resume from its recorded facts" : attempt.started ? STARTED_OWNER_GONE : CLAIM_NEVER_STARTED;
					await settleReviewAgentAttempt({
						rootStoreId,
						taskId: attempt.source.taskId,
						sessionId: attempt.sessionId,
						status,
						note
					});
					const settlement = {
						status,
						note,
						at: (/* @__PURE__ */ new Date()).toISOString()
					};
					Object.assign(attempt, { settlement });
					recovered.push(attempt);
				}
				return {
					plan: requestRole === "supervisor" ? planSupervisorAttempt({
						attempts,
						request,
						budget: {
							used,
							max: reviewAgentBudget()
						},
						resumeRecorded: hooks?.resumeRecorded,
						retryClosed: hooks?.retryClosed
					}) : planReviewAttempt({
						attempts,
						request,
						budget: {
							used,
							max: reviewAgentBudget()
						}
					}),
					recovered
				};
			},
			claim: async (request) => {
				await appendRow(claimRow(rootStoreId, request));
				claimedHere.add(request.sessionId);
				const role = roleOf$1(request.role);
				attempts.push({
					role,
					source: request.source,
					requestKey: request.requestKey,
					reason: request.reason,
					...request.diagnosisId === void 0 ? {} : { diagnosisId: request.diagnosisId },
					...request.handoffDigest === void 0 ? {} : { handoffDigest: request.handoffDigest },
					sessionId: request.sessionId,
					actor: request.actor,
					at: (/* @__PURE__ */ new Date()).toISOString(),
					started: false,
					settlement: void 0
				});
			},
			start: async (record) => {
				if (startedSessions.has(record.sessionId)) return;
				await appendRow({
					formatVersion: 2,
					kind: "started",
					rootStoreId,
					taskId: record.taskId,
					sessionId: record.sessionId,
					actor: record.actor,
					at: (/* @__PURE__ */ new Date()).toISOString()
				});
				startedSessions.add(record.sessionId);
				used += 1;
				liveAttempts.add(record.sessionId);
				for (const attempt of attempts) if (attempt.sessionId === record.sessionId) Object.assign(attempt, { started: true });
			}
		});
	});
	const tail = result.then(() => void 0, () => void 0);
	regions.set(key, tail);
	tail.then(() => {
		if (regions.get(key) === tail) regions.delete(key);
	});
	return result;
}
/** The one delegation a session is recorded under, as the context package's binding source reads it (A2 §D): */
async function readReviewerDelegation(sessionId$1) {
	let rows;
	try {
		rows = await readLedgerRows();
	} catch (error) {
		throw new CoordinationBindingError("unreadable", `the reviewer ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const matches = (rows ?? []).filter(isStartedRow).filter((row) => row.sessionId === sessionId$1);
	if (matches.length === 0) return void 0;
	const first = matches[0];
	const claims = (rows ?? []).filter((row) => row.kind === "claim" && row.sessionId === sessionId$1);
	const claim = claims[0];
	const record = {
		rootStoreId: first.rootStoreId,
		taskId: first.taskId,
		actor: first.actor,
		at: first.at,
		...claim === void 0 ? {} : {
			role: claim.role ?? "reviewer",
			sourceRunId: claim.runId
		}
	};
	const conflicting = matches.some((row) => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId || row.actor !== record.actor);
	const claimConflict = claims.some((row) => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId || row.actor !== record.actor || (row.role ?? "reviewer") !== record.role || row.runId !== record.sourceRunId);
	if (conflicting || claimConflict) throw new CoordinationBindingError("binding-conflict", `session "${sessionId$1}" is recorded under more than one reviewer delegation: ` + matches.map((row) => `${row.taskId} in ${row.rootStoreId} (by ${row.actor})`).join("; "));
	return record;
}
/**
* The ledger row as the context binding: the shape is projected, and a row
* whose claim names no role is refused rather than read as a reviewer's.
*/
async function coordinationBindingOf(sessionId$1) {
	const row = await readReviewerDelegation(sessionId$1);
	if (row === void 0) return void 0;
	if (row.role === void 0) throw new CoordinationBindingError("role-missing", `session "${sessionId$1}" is recorded as a review delegation whose claim names no role; a role is never assumed`);
	return {
		role: row.role,
		sourceTaskId: row.taskId,
		sourceRunId: row.sourceRunId ?? null,
		actor: row.actor,
		rootStoreId: row.rootStoreId,
		at: row.at
	};
}
/** The binding source the plugin registers into the context service: this deployment's ledger, as the narrow read door above. */
function reviewerBindingSource() {
	return { read: coordinationBindingOf };
}

//#endregion
//#region src/coordination/handoff-rules.ts
/** Shared host preset; runtime installs the actual coordination role. */
const COORDINATION_PRESET = "singularity-coordinator";
/**
* A supervisor explicitly concludes that no shared method change is justified,
* closes the loop, or names an obstruction. The driver checks a no_change
* answer against the evolution ledger before accepting it as a completed round.
*/
function supervisorOutcomeOf(reply) {
	if (reply === void 0) return void 0;
	const blocks = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
	for (const block of blocks.reverse()) try {
		const parsed = JSON.parse(block);
		if (parsed === null || typeof parsed !== "object") continue;
		const outcome = parsed.outcome;
		if (outcome !== "closed" && outcome !== "blocked" && outcome !== "no_change") continue;
		const reason = parsed.reason;
		if (typeof reason !== "string" || reason.trim().length === 0) continue;
		return {
			outcome,
			reason: reason.trim()
		};
	} catch {
		continue;
	}
}
/** The text of one session's last assistant message — the reply a coordination agent's outcome is read from. */
function lastAssistantText(events) {
	const event = [...events].reverse().find((item) => item.type === "assistant/message");
	if (event === void 0) return void 0;
	const content = ((event.data?.message)?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
	return content.length === 0 ? void 0 : content;
}
/** One review record's facts as the compact read-only block a supervisor's first request carries — criteria verdicts, the derived passed/total, and the effort counters. */
function renderSupervisorReviewFacts(review) {
	const criteria = review.criteria ?? [];
	const passed = criteria.filter((criterion) => criterion.verdict === "pass").length;
	const lines = [`review ${review.taskId}#${review.runId ?? "no-run"} [${review.outcome}]`];
	lines.push(criteria.length === 0 ? "criteria: none recorded" : `criteria (${passed}/${criteria.length} passed): ${criteria.map((criterion) => `${criterion.criterionId} ${criterion.verdict}`).join("; ")}`);
	const metrics = metricsLine(review);
	if (metrics !== void 0) lines.push(`metrics: ${metrics}`);
	if (review.logTail !== void 0) lines.push(`logTail: ${review.logTail}`);
	return lines.join("\n");
}
/** Executed descendants belong to an exact Run, including failed attempts, rather than a task's latest tree. */
function runSubtree(snapshot, rootRunId) {
	const selected = new Set([rootRunId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const run of snapshot.runs) if (run.parentRunId !== void 0 && selected.has(run.parentRunId) && !selected.has(run.runId)) {
			selected.add(run.runId);
			changed = true;
		}
	}
	return snapshot.runs.filter((run) => selected.has(run.runId));
}
/** Sum readable session counters once; coverage keeps a missing reading distinct from zero effort. */
function renderRecordedCostFacts(label, sessionIds, observations, unit = "sessions") {
	const sessions = [...new Set(sessionIds)];
	const tokens = {
		uncachedInputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
	const buckets = Object.keys(tokens);
	let tokenSessions = 0;
	let toolSessions = 0;
	let calls = 0;
	let failures = 0;
	for (const sessionId$1 of sessions) {
		const metrics = observations.get(sessionId$1);
		if (metrics?.tokens !== void 0 && buckets.every((key) => Number.isFinite(metrics.tokens[key]) && metrics.tokens[key] >= 0)) {
			tokenSessions += 1;
			for (const key of buckets) tokens[key] += metrics.tokens[key];
		}
		if (metrics?.toolCalls !== void 0 && [metrics.toolCalls.calls, metrics.toolCalls.failures].every((value) => Number.isFinite(value) && value >= 0)) {
			toolSessions += 1;
			calls += metrics.toolCalls.calls;
			failures += metrics.toolCalls.failures;
		}
	}
	const usage = tokenSessions === 0 ? "tokens unknown" : `tokens ${Object.values(tokens).reduce((sum, value) => sum + value, 0)} (input ${tokens.uncachedInputTokens}, output ${tokens.outputTokens}, cache read ${tokens.cacheReadTokens}, cache write ${tokens.cacheWriteTokens})`;
	const tools = toolSessions === 0 ? "toolCalls unknown" : `toolCalls ${calls} (${failures} failed)`;
	return `${label}: ${sessions.length} ${unit}; ${usage}; ${tools}; coverage tokens ${tokenSessions}/${sessions.length}, tools ${toolSessions}/${sessions.length}; monetary cost unknown (no recorded price).`;
}
/** The effort counters of one review record, one clause per counter that exists — an absent field means "not observed". */
function metricsLine(review) {
	const metrics = review.metrics;
	if (metrics === void 0) return void 0;
	const parts = [];
	if (metrics.tokens !== void 0) parts.push(`tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens}`);
	if (metrics.toolCalls !== void 0) parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`);
	if (metrics.humanInterventions !== void 0) parts.push(`humanInterventions ${metrics.humanInterventions}`);
	if (metrics.retries !== void 0) parts.push(`retries ${metrics.retries}`);
	if (metrics.evidenceLogs !== void 0) parts.push(`evidenceLogs ${metrics.evidenceLogs}`);
	return parts.length === 0 ? void 0 : parts.join(" — ");
}
/**
* The supervisor attempts one diagnosis left, as the review pack renders them:
* the session each attempt ran under and how it ended, or a named absence. Only
* a graph that runs an RSI loop has such attempts — every other store's
* diagnoses are dropped by the graph's root supervisor.
*/
function supervisorAttemptsLine(diagnosisId, attempts) {
	const mine = attempts.filter((attempt) => attempt.role === "supervisor" && attempt.diagnosisId === diagnosisId);
	if (mine.length === 0) return "no supervisor attempt — a graph without RSI settings runs no platform supervisor for its diagnoses";
	return mine.map((attempt) => {
		const status = attempt.settlement?.status ?? "in-flight";
		const note = attempt.settlement?.note === void 0 ? "" : ` — ${attempt.settlement.note}`;
		return `supervisor attempt ${attempt.sessionId} [${status}]${note}`;
	}).join("; ");
}

//#endregion
//#region src/coordination/spawn-under-claim.ts
/** Claim the attempt and spawn its agent, or record the attempt interrupted when the spawn never reached model input. */
async function spawnUnderClaim(input) {
	await input.admission.claim(input.request);
	const prompt = await input.prompt();
	const pinned = graphAgentOptions(await input.ctx.graphs.graphForSession(input.parent.id));
	let spawnFailure;
	const handle = await input.ctx.agentRuntime.spawn(input.parent, {
		sessionId: input.sessionId,
		name: input.name,
		prompt: [{
			type: "text",
			text: prompt
		}],
		agentPreset: input.preset,
		grant: input.grant,
		permissionPreset: "danger-full-access",
		coordinationRole: input.request.role === "supervisor" ? "supervisor" : "reviewer",
		...pinned === void 0 ? {} : { agentOptions: pinned },
		beforePrompt: async () => {
			await input.admission.start({
				taskId: input.taskId,
				sessionId: input.sessionId,
				actor: input.actor
			});
			const back = await readReviewerDelegation(input.sessionId);
			if (back === void 0 || back.rootStoreId !== input.storeId || back.taskId !== input.taskId) throw new Error(`${input.errorLabel} "${input.sessionId}" could not be read back from the ledger (expected task ${input.taskId} in ${input.storeId}); no model input was sent`);
		},
		...input.signal === void 0 ? {} : { signal: input.signal }
	}).catch((error) => {
		spawnFailure = error instanceof Error ? error.message : String(error);
	});
	if (handle === void 0) {
		await settleReviewAgentAttempt({
			rootStoreId: input.storeId,
			taskId: input.taskId,
			sessionId: input.sessionId,
			status: "interrupted",
			note: `${input.failureLabel}: ${spawnFailure ?? "unknown error"}`
		}).catch(() => void 0);
		return {
			kind: "spawn-failed",
			failure: spawnFailure ?? "unknown error"
		};
	}
	return {
		kind: "spawned",
		handle
	};
}

//#endregion
//#region src/coordination/trigger.ts
/** Run one scan off the caller's path; a rejection is a line under `label`, never a throw nobody awaits. */
function backgroundScan(log, label, work) {
	work().catch((error) => {
		log(`${label}: the scan could not run (${message(error)})`);
	});
}

//#endregion
//#region src/coordination/rsi-loop.ts
/**
* How many times a stalled supervisor is re-prompted before its unfinished
* supervision is recorded as blocked. Exhausting reminders never completes a
* publication and never opens the next round.
*/
const MAX_SUPERVISOR_REPROMPTS = 3;
/**
* The supervisor's tool surface: the read-only investigation tools, the store's
* own records, and the nine-step evolution chain. `task_recover` is deliberately
* absent — round scheduling belongs to the driver, so the agent that publishes a
* round is never the one that opens the next.
*/
const SUPERVISOR_BASELINE = [
	"task_review_pack",
	"task_review_agent",
	"task_read",
	"task_status",
	"context_read",
	"capability_list",
	"task_library",
	"task_template_list",
	"evolution_propose",
	"evolution_candidate",
	"evolution_prepare",
	"evolution_replay",
	"evolution_gate",
	"evolution_decide",
	"evolution_apply",
	"evolution_list",
	"read",
	"glob",
	"grep",
	"skill"
];
/** The grant one round's supervisor is spawned with. */
function supervisorGrant() {
	return {
		capabilities: [],
		baseline: SUPERVISOR_BASELINE,
		keepPresetTools: false
	};
}
/** The id of the platform diagnosis one round's run is recorded under: the supervisor cites it and the next round's recovery names it. */
function roundDiagnosisId(graphId, round) {
	return `rsi-${graphId}-round-${round}`;
}
/** The request key that opens one round (A7 §3): one key names one attempt, so re-asking returns the attempt that key already names. */
function roundRequestKey(graphId, round) {
	return `rsi-${graphId}-round-${round}`;
}
/** The request key of one round's supervision attempt: one round is one supervisor hand-off, however many attempts it takes. */
function supervisorRequestKey(graphId, round) {
	return `rsi-supervise-${graphId}-round-${round}`;
}
/** The `$DSH_HOME` this deployment's graph libraries and bubbles live under, by the same fallback the library uses. */
function bubbleHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}
/** The store's own root task: the one task that never had a parent (§1.6: one root per store, ever). */
function rootTaskOf(snapshot) {
	return snapshot.tasks.find((task) => task.parentTaskId === void 0);
}
/** The store's own first attempt of the root task: the run that is not a recovery of anything. */
function firstRootRun(snapshot, rootTaskId) {
	return snapshot.runs.find((run) => run.taskId === rootTaskId && run.recovery === void 0);
}
/**
* Every terminal-settled run of the root task, oldest first — the store's own
* count of rounds. A round is a settled attempt, verified or not: the driver
* schedules on outcomes, and a failed non-final round still has its supervisor
* and its next recovery round. The configured count includes the original run.
*/
function terminalRootRuns(snapshot, rootTaskId) {
	return snapshot.runs.filter((run) => run.taskId === rootTaskId && isTerminalRunStatus(run.status)).sort((left, right) => left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0);
}
/** The run one round opened, read from the store's own attempt record by its request key. */
function roundRunOf(snapshot, rootTaskId, requestKey) {
	return recoveryAttemptWithKey(snapshot, rootTaskId, requestKey);
}
/** The review record of one run, as the store holds it. */
function reviewOfRun(snapshot, runId) {
	return snapshot.reviews.find((review) => review.runId === runId);
}
/** One proposal's state as a reader says it: the id, its status, and the decision when it has one. */
function proposalLine(proposals) {
	return proposals.length === 0 ? "no proposal is recorded for this round" : proposals.map((proposal) => `${proposal.proposalId} [${proposal.status}]${proposal.decision === void 0 ? "" : ` ${proposal.decision}`}`).join("; ");
}
/** A publication is complete only when every apply-supported proposal of this round is settled. Research-only target types do not block it. */
function publicationOf(proposals) {
	const executable = proposals.filter((proposal) => APPLYABLE_TARGET_TYPES.includes(proposal.targetType));
	const applied = executable.filter((proposal) => proposal.status === "applied" && proposal.rolledback === void 0).map((proposal) => proposal.proposalId);
	const unresolved = executable.filter((proposal) => proposal.status !== "applied" && proposal.status !== "rolledback" && !(proposal.status === "decided" && (proposal.decision === "REJECT" || proposal.decision === "KEEP_FOR_FURTHER_RESEARCH"))).map((proposal) => proposal.proposalId);
	return {
		done: executable.length > 0 && unresolved.length === 0,
		applied,
		unresolved,
		note: proposalLine(proposals)
	};
}
/** Driver and agents read the same graph-scoped ledger. Legacy compositions retain their global reader. */
async function evolutionOf(ctx, sessionId$1) {
	const plane = ctx.evolution;
	const evolution = typeof plane?.forSession === "function" ? await plane.forSession(sessionId$1) : plane;
	const list = evolution?.list;
	return typeof list !== "function" ? void 0 : {
		list: () => list.call(evolution),
		...evolution?.experiments === void 0 ? {} : { experiments: (proposalId) => evolution.experiments(proposalId) }
	};
}
/**
* The RSI loop driver of one deployment. One instance is installed per process
* (see {@link installRsiLoopDriver}); every graph with `rsi` settings gets one
* {@link LoopState}, and graphs without them are never touched.
*/
var RsiLoopDriver = class {
	ctx;
	log;
	onProgress;
	loops = /* @__PURE__ */ new Map();
	byStore = /* @__PURE__ */ new Map();
	registered = /* @__PURE__ */ new Set();
	/** One promise chain per graph: a terminal fact, an activation and the boot seed never interleave inside one loop. */
	queues = /* @__PURE__ */ new Map();
	disposers = [];
	stopped = false;
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.log = options.log ?? warnLine(ctx);
		this.onProgress = options.onProgress;
	}
	/** Subscribe to the two facts that move a loop — one terminal review, one graph activation — and seed from the persisted registry. */
	install() {
		this.disposers.push(this.ctx.taskRuntime.registerTerminalReviewListener((fact) => this.handleFact(fact)));
		this.disposers.push(this.ctx.on("graphs/selected", (graph) => {
			this.observeGraph(graph);
		}));
		this.disposers.push(this.ctx.on("graphs/change", (snapshot) => this.observeGraphs(snapshot.graphs)));
		backgroundScan(this.log, "rsi loop", () => this.seed());
		return () => this.stop();
	}
	/** Forget every loop, every declared cap and every subscription of this instance. */
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		for (const dispose of this.disposers.splice(0)) try {
			dispose();
		} catch (error) {
			this.log(`rsi loop: a subscription could not be released (${message(error)})`);
		}
		for (const storeId of this.registered) unregisterGraphImprovementCap(storeId);
		this.registered.clear();
		this.loops.clear();
		this.byStore.clear();
	}
	/** One graph became the active one: declare its cap and take its loop over. */
	observeGraph(graph) {
		if (graph.rsi === void 0) {
			this.forget(graph.id);
			return;
		}
		const storeId = this.remember(graph);
		registerGraphImprovementCap(storeId, graph.rsi.iterationRounds);
		this.registered.add(storeId);
		this.log(`rsi loop: graph ${graph.id} runs ${graph.rsi.iterationRounds} round(s) over store ${storeId}`);
		this.ensure(graph.id).catch((error) => this.log(`rsi loop ${graph.id}: ${message(error)}`));
	}
	/** Reconcile the declared caps against the registry: a graph that gained a config is registered, one that lost it is forgotten. */
	observeGraphs(graphs) {
		const live = /* @__PURE__ */ new Set();
		for (const graph of graphs) {
			if (graph.rsi === void 0) continue;
			const storeId = this.remember(graph);
			registerGraphImprovementCap(storeId, graph.rsi.iterationRounds);
			this.registered.add(storeId);
			live.add(storeId);
			this.ensure(graph.id).catch((error) => this.log(`rsi loop ${graph.id}: ${message(error)}`));
		}
		for (const storeId of [...this.registered]) {
			if (live.has(storeId)) continue;
			unregisterGraphImprovementCap(storeId);
			this.registered.delete(storeId);
			const graphId = this.byStore.get(storeId);
			if (graphId !== void 0) this.forget(graphId);
		}
	}
	/** One graph activation (or the boot seed): read what the graph holds now and take its loop's next step. */
	ensure(graphId) {
		return this.serialize(graphId, () => this.advance(graphId));
	}
	/**
	* Bind one store to its graph before anything is read from it: a store's
	* terminal facts arrive by store id alone, so the routing has to exist from
	* the moment the graph is declared — a root task that does not exist yet
	* still has its first attempt ahead of it.
	*/
	remember(graph) {
		const state = this.loops.get(graph.id);
		if (state !== void 0 && !this.matchesGraph(state, graph)) this.forget(graph.id);
		const storeId = rootTaskStoreId(String(graph.rootSessionId));
		this.byStore.set(storeId, graph.id);
		return storeId;
	}
	/** One terminal review became durable: the graph's own store moves its loop, every other store is not this driver's business. */
	handleFact(fact) {
		if (this.stopped) return;
		const graphId = this.byStore.get(fact.storeId);
		if (graphId === void 0) return;
		const state = this.loops.get(graphId);
		if (state?.rootTaskId !== void 0 && fact.taskId !== state.rootTaskId) return;
		this.ensure(graphId).catch((error) => this.log(`rsi loop ${graphId}: ${message(error)}`));
	}
	/** Read the persisted registry once: a graph selected before this process booted still gets its loop taken over. */
	async seed() {
		if (this.stopped) return;
		const graphs = this.ctx.graphs;
		if (typeof graphs?.list !== "function") return;
		const all = await graphs.list();
		this.observeGraphs(all);
		for (const graph of all) {
			if (graph.rsi === void 0) continue;
			await this.ensure(graph.id);
		}
	}
	/** Serialize one moment of one graph's loop: the loop's state machine is single-threaded per graph. */
	serialize(graphId, work) {
		const settled = (this.queues.get(graphId) ?? Promise.resolve()).then(work).then(() => void 0, (error) => {
			this.log(`rsi loop ${graphId}: ${message(error)}`);
		});
		this.queues.set(graphId, settled);
		settled.then(() => {
			if (this.queues.get(graphId) === settled) this.queues.delete(graphId);
		});
		return settled;
	}
	/**
	* The one step a loop takes, from the store's own facts: how many rounds have
	* settled, whether the next round is already open, and whether the round that
	* just settled still needs its supervision. Every entry (a terminal fact, an
	* activation, the boot seed) is this same read — memory is never the record.
	*/
	async advance(graphId) {
		if (this.stopped) return;
		let graph;
		try {
			graph = await this.ctx.graphs.get(graphId);
		} catch (error) {
			this.log(`rsi loop: graph ${graphId} could not be read (${message(error)})`);
			return;
		}
		const config = graph.rsi;
		if (config === void 0) {
			this.forget(graphId);
			return;
		}
		const storeId = this.remember(graph);
		registerGraphImprovementCap(storeId, config.iterationRounds);
		this.registered.add(storeId);
		const state = this.loopFor(graph, storeId);
		if (state.stopped) return;
		state.config = config;
		let snapshot;
		try {
			snapshot = await this.ctx.task.snapshotIn(storeId);
		} catch (error) {
			this.log(`rsi loop ${graphId}: store ${storeId} could not be read (${message(error)})`);
			return;
		}
		const root = rootTaskOf(snapshot);
		if (root === void 0) return;
		state.rootTaskId = root.taskId;
		this.byStore.set(storeId, graphId);
		const rounds = terminalRootRuns(snapshot, root.taskId);
		if (rounds.length >= config.iterationRounds) {
			await this.superviseRound(state, graph, snapshot, rounds.length, rounds.at(-1));
			return;
		}
		const next = rounds.length + 1;
		const openRun = roundRunOf(snapshot, root.taskId, roundRequestKey(graphId, next));
		if (openRun !== void 0) {
			if (openRun.status === "running") await this.mark(state, {
				round: next,
				phase: "running",
				note: `round ${next} is running`
			});
			return;
		}
		const latest = rounds.at(-1);
		if (latest === void 0) {
			const first = firstRootRun(snapshot, root.taskId);
			if (first !== void 0 && first.status === "running") await this.mark(state, {
				round: 1,
				phase: "running",
				note: "round 1 is running"
			});
			return;
		}
		await this.superviseRound(state, graph, snapshot, rounds.length, latest);
	}
	/**
	* The round that just settled: record its diagnosis, take up its supervision,
	* then open the next one. A supervisor that explicitly stopped the loop ends
	* it here; a supervision that could not be taken up opens nothing and a later
	* activation retries it.
	*/
	async superviseRound(state, graph, snapshot, round, run) {
		if (await this.currentGraph(state) === void 0) return;
		const operatorResume = state.progress === void 0;
		await this.settleRoundBubble(state, graph, round);
		const verified = run.status === "verified";
		const review = reviewOfRun(snapshot, run.runId);
		const diagnosisId = roundDiagnosisId(state.graphId, round);
		await this.recordDiagnosis(state, graph, round, run, review, verified);
		await this.mark(state, verified ? {
			round,
			phase: "publishing",
			note: `round ${round} verified; supervising its method change`
		} : {
			round,
			phase: "debugging",
			note: `round ${round} settled ${run.status}; supervising its repair`
		});
		const supervision = await this.takeUpSupervision(state, graph, round, run, review, diagnosisId, verified, operatorResume);
		if (await this.currentGraph(state) === void 0) return;
		switch (supervision.kind) {
			case "stop":
				state.stopped = true;
				await this.mark(state, {
					round,
					phase: "failed",
					note: `round ${round}'s supervisor reported ${supervision.outcome}: ${supervision.reason}; the loop stops`
				});
				return;
			case "deferred":
				await this.mark(state, {
					round,
					phase: "failed",
					note: supervision.note
				});
				return;
			case "proceed":
				if (round >= state.config.iterationRounds) {
					state.stopped = true;
					const cause = verified ? void 0 : review?.localizedCause;
					await this.mark(state, {
						round,
						phase: verified ? "done" : "failed",
						note: `${round}/${state.config.iterationRounds} rounds settled; final round ${run.status}${cause === void 0 ? "" : `: ${cause}`}; final library review settled; the loop is finished`
					});
					return;
				}
				await this.openRound(state, graph, round + 1, run.runId, diagnosisId, supervision.applied, verified ? "improve" : "recovery");
		}
	}
	/**
	* The platform's own diagnosis for one round: the observation names what the
	* store recorded (the run's own review cause for a failed round), and
	* `proposals: []` says the driver records no suggestion — the supervisor
	* investigates. The diagnosis exists so the next round's `recoverRootTask`
	* has a store record to name.
	*/
	async recordDiagnosis(state, graph, round, run, review, verified) {
		const diagnosisId = roundDiagnosisId(state.graphId, round);
		if ((await this.ctx.task.snapshotIn(state.storeId)).diagnoses.some((item) => item.diagnosisId === diagnosisId)) return;
		const consumed = run.recovery?.proposalIds ?? [];
		const diagnosis = {
			diagnosisId,
			taskId: state.rootTaskId,
			observedFailure: verified ? `Round ${round} of graph "${graph.name}" (${state.graphId}) verified: the root task's run "${run.runId}" settled verified under the store's own acceptance criteria.` : review?.localizedCause ?? `Round ${round} of graph "${graph.name}" (${state.graphId}) settled ${run.status}: the root task's run "${run.runId}" did not pass the store's own acceptance criteria.`,
			scope: `the root task ${state.rootTaskId} of this store; graph ${state.graphId} runs a platform RSI loop of ${state.config.iterationRounds} round(s)`,
			localizedCause: round >= state.config.iterationRounds ? `The platform RSI loop reviews round ${round}'s library experience before completing this graph: ${state.config.task}.` : verified ? `The platform RSI loop continues this graph's verified goal with round ${round + 1}: ${state.config.task}.` + (consumed.length === 0 ? " No published change was consumed by this round." : ` This round consumed the applied proposal(s) ${consumed.join(", ")}.`) : `The platform RSI loop hands round ${round}'s ${run.status} attempt to its supervisor, which investigates the cause and prepares the method change round ${round + 1} (mode "recovery") consumes: ${state.config.task}.`,
			evidenceRefs: review?.evidenceRefs ?? [],
			reviewRefs: [`${state.rootTaskId}#${run.runId}`],
			confidence: "high",
			proposals: [],
			producedBy: {
				kind: "agent",
				sessionId: state.rootSessionId
			}
		};
		try {
			if (await this.currentGraph(state) === void 0) return;
			await this.ctx.task.recordDiagnosisIn(state.storeId, diagnosis, state.rootSessionId);
			this.log(`rsi loop ${state.graphId}: round ${round} diagnosis ${diagnosisId} recorded`);
		} catch (error) {
			if ((await this.ctx.task.snapshotIn(state.storeId).catch(() => void 0))?.diagnoses.some((item) => item.diagnosisId === diagnosisId) === true) return;
			throw error;
		}
	}
	/**
	* Take up one round's supervision: hand the round to a supervisor agent and
	* watch it settle, or read what a previous attempt already settled. A settled
	* attempt is the round's answer however this process came to read it, so a
	* restart neither spawns a second supervisor for a round that already had one
	* nor forgets the outcome that stopped the loop.
	*/
	async takeUpSupervision(state, graph, round, run, review, diagnosisId, verified, operatorResume) {
		const already = publicationOf(await this.proposalsFor(state, diagnosisId));
		const settled = supervisorAttemptOf(await readReviewAgentAttempts(state.storeId).catch(() => []), diagnosisId);
		if (settled?.settlement?.status === "closed") {
			const note = settled.settlement.note ?? "the round was closed";
			const blocked = note.startsWith("blocked:");
			if (!(blocked && operatorResume)) return {
				kind: "stop",
				outcome: blocked ? "blocked" : "closed",
				reason: note
			};
		}
		if (settled?.settlement?.status === "recorded" && settled.settlement.note?.startsWith("no_change:") === true) {
			if (already.applied.length === 0 && already.unresolved.length === 0) return {
				kind: "proceed",
				applied: []
			};
		} else if (already.done && (round < state.config.iterationRounds || settled?.settlement?.status === "recorded")) return {
			kind: "proceed",
			applied: already.applied
		};
		const delegator = liveRootAgentOf(this.ctx, state.storeId);
		if (delegator === void 0) return {
			kind: "deferred",
			note: `round ${round} was not supervised: the graph's root session is not live in this process; the next activation retries`
		};
		const sessionId$1 = SessionId(randomUUID());
		const request = {
			role: "supervisor",
			source: {
				taskId: state.rootTaskId,
				runId: run.runId
			},
			requestKey: supervisorRequestKey(state.graphId, round),
			reason: verified ? `the RSI loop's publication for round ${round}` : `the RSI loop's repair of round ${round}`,
			diagnosisId,
			handoffDigest: roundHandoffDigest({
				graphId: state.graphId,
				round,
				storeId: state.storeId,
				taskId: state.rootTaskId,
				runId: run.runId
			}),
			actor: delegator.sessionId,
			sessionId: sessionId$1
		};
		const spawned = await admitReviewAgent(state.storeId, async (admission) => {
			if (await this.currentGraph(state) === void 0) return {
				kind: "refused",
				reason: "the RSI config was cleared or replaced"
			};
			const { plan } = await admission.plan(request, {
				recorded: () => already.done,
				resumeRecorded: true,
				retryClosed: operatorResume
			});
			if (plan.kind === "refused") return {
				kind: "refused",
				reason: `${plan.code}: ${plan.reason ?? "no reason given"}`
			};
			if (plan.kind === "in-flight") return {
				kind: "running",
				sessionId: plan.attempt.sessionId
			};
			if (plan.kind === "reuse") return {
				kind: "reuse",
				sessionId: plan.attempt.sessionId
			};
			const outcome = await spawnUnderClaim({
				ctx: this.ctx,
				admission,
				storeId: state.storeId,
				request,
				sessionId: sessionId$1,
				taskId: state.rootTaskId,
				actor: delegator.sessionId,
				parent: delegator.agent,
				name: `rsi supervisor for ${state.graphId} round ${round}`,
				preset: COORDINATION_PRESET,
				grant: supervisorGrant(),
				errorLabel: "rsi loop: the delegation of supervisor session",
				failureLabel: "the supervisor could not be spawned",
				prompt: () => verified ? this.verifiedPrompt(state, graph, round, run, review, diagnosisId) : this.failedPrompt(state, graph, round, run, review, diagnosisId)
			});
			if (outcome.kind === "spawn-failed") return {
				kind: "spawn-failed",
				reason: outcome.failure
			};
			return {
				kind: "spawned",
				agent: outcome.handle.agent
			};
		});
		if (spawned.kind === "refused") return {
			kind: "deferred",
			note: `round ${round} was not supervised (${spawned.reason}); the next activation retries`
		};
		if (spawned.kind === "spawn-failed") return {
			kind: "deferred",
			note: `round ${round} was not supervised (${spawned.reason}); the next activation retries`
		};
		if (spawned.kind === "running" || spawned.kind === "reuse") return {
			kind: "deferred",
			note: `round ${round}'s supervision is taken up already; the loop waits for it`
		};
		return await this.watchSupervisor(state, round, diagnosisId, sessionId$1, spawned.agent);
	}
	/**
	* Watch one supervisor to its settlement: every executable proposal concluded,
	* an explicit no_change, the blocked re-prompt bound, or its own stop. The attempt's durable
	* outcome is settled on the coordination ledger either way, so a later
	* activation reads the same answer instead of spawning a second supervisor.
	*/
	async watchSupervisor(state, round, diagnosisId, sessionId$1, agent) {
		let reprompts = 0;
		try {
			for (;;) {
				await agent.whenIdle();
				if (await this.currentGraph(state) === void 0) {
					await this.settleSupervisor(state, sessionId$1, "interrupted", "the RSI config changed or the driver was unloaded");
					return {
						kind: "deferred",
						note: "the RSI config changed or the driver was unloaded while the supervisor ran"
					};
				}
				const outcome = supervisorOutcomeOf(lastAssistantText(agent.session.snapshotEvents()));
				if (outcome !== void 0 && outcome.outcome !== "no_change") {
					await this.settleSupervisor(state, sessionId$1, "closed", `${outcome.outcome}: ${outcome.reason}`);
					return {
						kind: "stop",
						outcome: outcome.outcome,
						reason: outcome.reason
					};
				}
				const publication = publicationOf(await this.proposalsFor(state, diagnosisId));
				if (await this.currentGraph(state) === void 0) {
					await this.settleSupervisor(state, sessionId$1, "interrupted", "the RSI config changed or the driver was unloaded");
					return {
						kind: "deferred",
						note: "the RSI config changed while reading the publication ledger"
					};
				}
				const invalidNoChange = outcome?.outcome === "no_change" && (publication.applied.length > 0 || publication.unresolved.length > 0);
				if (outcome?.outcome === "no_change" && !invalidNoChange) {
					await this.settleSupervisor(state, sessionId$1, "recorded", `no_change: ${outcome.reason}`);
					return {
						kind: "proceed",
						applied: []
					};
				}
				if (publication.done && !invalidNoChange) {
					await this.settleSupervisor(state, sessionId$1, "recorded", publication.note);
					this.log(`rsi loop ${state.graphId}: round ${round} supervised — ${publication.note}`);
					return {
						kind: "proceed",
						applied: publication.applied
					};
				}
				if (reprompts >= MAX_SUPERVISOR_REPROMPTS) {
					const reason = `supervision unfinished after ${MAX_SUPERVISOR_REPROMPTS} re-prompts: ${invalidNoChange ? "no_change contradicts the publication ledger; " : ""}${publication.note}`;
					await this.settleSupervisor(state, sessionId$1, "closed", `blocked: ${reason}`);
					return {
						kind: "stop",
						outcome: "blocked",
						reason
					};
				}
				reprompts += 1;
				await this.ctx.agentRuntime.prompt(agent, [{
					type: "text",
					text: `Round ${round} of graph ${state.graphId} remains yours. Durable proposal state: ${publication.note}. Continue the existing proposal through its next candidate/prepare/replay/gate/decide/apply step, or settle it with REJECT / KEEP_FOR_FURTHER_RESEARCH and a reason. Unfinished executable proposals: ${publication.unresolved.join(", ") || "none"}. ` + (invalidNoChange ? "Your no_change outcome contradicts the ledger: resolve the executable proposals or correct your final answer. " : "") + "The platform driver opens the next round after you settle. To retain the current method with an empty or negatively settled executable ledger, finish with {\"outcome\":\"no_change\",\"reason\":\"...\"} in a fenced json block. Keep research suggestions as findings. Otherwise finish the chain or end with {\"outcome\":\"blocked\",\"reason\":\"...\"} for a concrete obstruction, or {\"outcome\":\"closed\",\"reason\":\"...\"} to end the loop, in a fenced json block."
				}]);
			}
		} catch (error) {
			await this.settleSupervisor(state, sessionId$1, "interrupted", message(error));
			throw error;
		}
	}
	/** The proposal facts one round's publication left, read from the ledger the agents write. */
	async proposalsFor(state, diagnosisId) {
		const evolution = await evolutionOf(this.ctx, state.rootSessionId);
		if (evolution === void 0) return [];
		return (await evolution.list()).filter((proposal) => proposal.sourceRefs.includes(`diagnosis:${diagnosisId}`));
	}
	/** Every proposal this loop's rounds produced, oldest last, for the supervisor's "what is published now" line. */
	async loopProposals(state) {
		const evolution = await evolutionOf(this.ctx, state.rootSessionId);
		if (evolution === void 0) return [];
		const marker = `diagnosis:rsi-${state.graphId}-round-`;
		return (await evolution.list()).filter((proposal) => proposal.sourceRefs.some((ref) => ref.startsWith(marker)));
	}
	/** Settle the ledger row of one supervisor attempt; the round's own outcome is already durable, so a refusal here is only logged. */
	async settleSupervisor(state, sessionId$1, status, note) {
		await settleReviewAgentAttempt({
			rootStoreId: state.storeId,
			taskId: state.rootTaskId,
			sessionId: sessionId$1,
			status,
			note
		}).catch((error) => this.log(`rsi loop ${state.graphId}: the supervisor attempt could not be settled (${message(error)})`));
	}
	/** The environment checkout one graph binds, when this deployment has an env-builder; `undefined` in test contexts and deployments without one. */
	async envPathOf(graph) {
		const envBuilder = optionalService(this.ctx, "envBuilder");
		if (typeof envBuilder?.store?.get !== "function") return void 0;
		try {
			return envBuilder.store.get(graph.envId).path;
		} catch {
			return;
		}
	}
	/** Persist one settled round's bubble to `rsi/<graph>/round-<N>`, so the next round materializes from it. */
	async settleRoundBubble(state, graph, round) {
		const envPath = await this.envPathOf(graph);
		if (envPath === void 0) return;
		await settleBubble(envPath, bubbleWorkspacePath(bubbleHome(), state.rootSessionId, round), state.graphId, round);
	}
	/**
	* Open the next round through the runtime's own recovery entry: one attempt of
	* the round's run under the round's request key — `improve` after a verified
	* round, `recovery` after a failed one — consuming the proposals it published.
	* A key that already names an attempt is answered from the store instead of
	* opening a second (§F.4).
	*/
	async openRound(state, graph, round, sourceRunId, diagnosisId, applied, mode) {
		const requestKey = roundRequestKey(state.graphId, round);
		if (await this.currentGraph(state) === void 0) return;
		if (roundRunOf(await this.ctx.task.snapshotIn(state.storeId), state.rootTaskId, requestKey) === void 0) {
			const delegator = liveRootAgentOf(this.ctx, state.storeId);
			if (delegator === void 0) {
				await this.mark(state, {
					round,
					phase: "failed",
					note: `round ${round} could not be opened: the graph's root session is not live in this process; the next activation retries`
				});
				return;
			}
			const envPath = await this.envPathOf(graph);
			const workspacePath = envPath === void 0 ? void 0 : await materializeBubble(envPath, bubbleHome(), state.rootSessionId, state.graphId, round);
			const request = {
				sourceTaskId: state.rootTaskId,
				sourceRunId,
				sourceDiagnosisId: diagnosisId,
				requestKey,
				mode,
				...mode === "improve" ? { reuses: [] } : {},
				...applied.length === 0 ? {} : { proposalIds: [...applied] },
				...workspacePath === void 0 ? {} : { workspacePath }
			};
			try {
				if (await this.currentGraph(state) === void 0) return;
				const outcome = await this.ctx.taskRuntime.recoverRootTask(state.storeId, request, { sessionId: delegator.sessionId });
				this.log(`rsi loop ${graph.id}: round ${round} ${outcome.attempt === "started" ? "opened" : "was already open"} — run ${outcome.runId} (${outcome.status})`);
			} catch (error) {
				const after = await this.ctx.task.snapshotIn(state.storeId).catch(() => void 0);
				const recorded = after === void 0 ? void 0 : roundRunOf(after, state.rootTaskId, requestKey);
				if (recorded !== void 0) {
					await this.mark(state, {
						round,
						phase: recorded.status === "running" ? "running" : recorded.status === "verified" ? "publishing" : "debugging",
						note: `round ${round} was recorded ${recorded.status} despite its opening error: ${message(error)}; the next activation reconciles the stored attempt`
					});
					return;
				}
				if (after === void 0) {
					await this.mark(state, {
						round,
						phase: "failed",
						note: `round ${round}'s opening could not be reconciled: ${message(error)}; the store could not be read, so the next activation retries the same request key`
					});
					return;
				}
				await this.mark(state, {
					round,
					phase: "failed",
					note: `round ${round} could not be opened: ${message(error)}`
				});
				state.stopped = true;
				return;
			}
		}
		await this.mark(state, {
			round,
			phase: "running",
			note: `round ${round} is running`
		});
	}
	/** The lines both supervisor prompts share: where the round is, and what its evidence is. */
	roundHeader(state, graph, round, run, review) {
		const artifacts = run.artifacts ?? [];
		return [
			`Store: ${state.storeId}; root task: ${state.rootTaskId}; this round's run: ${run.runId} (session ${run.sessionId ?? "unrecorded"}).`,
			`Round objective as recorded on the graph: ${state.config.task}`,
			`Metrics to explore and improve: ${state.config.metrics?.join("; ") || "derive useful measurements from the task and state the assumptions"}.`,
			"Use the current task criteria to judge this execution, and its findings to improve reusable paths and experience.",
			review === void 0 ? "The store holds no review record for this run." : `The round's review settled ${review.outcome}. ${renderSupervisorReviewFacts(review)}`,
			"Where this round's delivery and evidence live:",
			run.placement?.workspacePath === void 0 ? "- the run recorded no separate working tree; read the store's evidence bundles" : `- the run's working tree: ${run.placement.workspacePath} (read/glob/grep it directly)`,
			...artifacts.length === 0 ? ["- the run recorded no artifacts of its own"] : artifacts.map((artifact) => `- artifact ${artifact.artifactId} (${artifact.kind}) at ${artifact.uri}${artifact.digest === void 0 ? "" : ` sha256:${artifact.digest}`}`),
			review === void 0 || review.evidenceRefs.length === 0 ? "- the review recorded no evidence ids" : `- store evidence ids: ${review.evidenceRefs.join(", ")} (context_read kind:"evidence")`
		];
	}
	/** Existing review/session counters cover execution, replay and past coordination without a second cost ledger. */
	async costFeedback(state, run) {
		const snapshot = await this.ctx.task.snapshotIn(state.storeId);
		const attempts = await readReviewAgentAttempts(state.storeId);
		const sessions = [...new Set([...snapshot.runs.map((item) => item.sessionId), ...attempts.filter((attempt) => attempt.started).map((attempt) => attempt.sessionId)])];
		const observations = /* @__PURE__ */ new Map();
		for (const item of snapshot.reviews) {
			const sessionId$1 = item.sessionId ?? snapshot.runs.find((candidate) => candidate.runId === item.runId)?.sessionId;
			if (sessionId$1 !== void 0 && item.metrics !== void 0) observations.set(sessionId$1, item.metrics);
		}
		const query = optionalService(this.ctx, "sessionQuery");
		const live = optionalService(this.ctx, "sessions");
		const projections = optionalService(this.ctx, "sessionProjections");
		const graphObservations = /* @__PURE__ */ new Map();
		const validTokens = (value) => value !== void 0 && value !== null && typeof value === "object" && [
			"uncachedInputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens"
		].every((key) => {
			const count = value[key];
			return typeof count === "number" && Number.isFinite(count) && count >= 0;
		});
		await Promise.all(sessions.map(async (sessionId$1) => {
			const observed = {};
			if (live !== void 0 && projections !== void 0) try {
				const session = live.get(SessionId(sessionId$1));
				if (session !== void 0) {
					const value = projections.snapshot(session, ["tokenUsage"]).values.tokenUsage;
					if (validTokens(value)) observed.tokens = value;
				}
			} catch {}
			if (query !== void 0) try {
				const log = await query.readSession(SessionId(sessionId$1));
				const { events } = log;
				observed.toolCalls = {
					calls: events.filter((event) => event.type === "tool/call").length,
					failures: events.filter((event) => event.type === "tool/result" && (event.data?.error !== void 0 || event.data?.message?.isError === true)).length
				};
				if (observed.tokens === void 0 && projections?.restore !== void 0 && log.session !== void 0 && log.inheritedEventCount !== void 0) {
					const value = projections.restore({}, events, SessionLogOffset(0), log.session, log.inheritedEventCount).snapshot.values.tokenUsage;
					if (validTokens(value)) observed.tokens = value;
				}
			} catch {}
			graphObservations.set(sessionId$1, observed);
			observations.set(sessionId$1, {
				...observed,
				...observations.get(sessionId$1)
			});
		}));
		const auxiliary = /* @__PURE__ */ new Map();
		const evolution = await evolutionOf(this.ctx, state.rootSessionId);
		let auxiliaryUnavailable = evolution?.experiments === void 0;
		if (evolution?.experiments !== void 0) for (const proposal of await evolution.list()) {
			const experiments = await evolution.experiments(proposal.proposalId).catch(() => {
				auxiliaryUnavailable = true;
				return [];
			});
			for (const experiment of experiments) {
				const plan = experiment.frozen.evaluation;
				if (plan?.generatedResponse !== void 0) auxiliary.set(`plan:${experiment.experimentId}`, {
					...plan.generatedUsage === void 0 ? {} : { tokens: plan.generatedUsage },
					toolCalls: {
						calls: 0,
						failures: 0
					}
				});
				if (experiment.judged !== void 0) auxiliary.set(`judge:${experiment.experimentId}`, {
					...experiment.judged.evaluation.judgeUsage === void 0 ? {} : { tokens: experiment.judged.evaluation.judgeUsage },
					toolCalls: {
						calls: 0,
						failures: 0
					}
				});
			}
		}
		return [
			renderRecordedCostFacts("Current round execution tree", runSubtree(snapshot, run.runId).map((item) => item.sessionId), observations),
			renderRecordedCostFacts("Graph usage to date (executions, replay experiments and recorded coordination)", sessions, graphObservations),
			auxiliaryUnavailable ? "Auxiliary evaluation plan/judge usage: unknown; some experiment cost reports were unavailable." : auxiliary.size === 0 ? "Auxiliary evaluation plan/judge usage: no recorded model calls." : renderRecordedCostFacts("Auxiliary evaluation plan/judge usage", [...auxiliary.keys()], auxiliary, "model calls"),
			"Compare task effects with this recorded effort, including evaluation overhead. Coverage shows available counters; an unavailable reading remains unknown."
		];
	}
	/** A short method prompt: library, evidence, comparison, publication and a clear ending. */
	supervisorMethod = [
		"Read task_library and matching task_template_list entries, then the exact Skill or template bytes and this run's contracts, batches and evidence. Review temporary exploratory goals and experience; record retention or retirement with task_library review and write useful revisions in this graph's library.",
		"Choose the responsible skill, capability or task_definition. TaskTemplates record reusable goals and decomposition; Skills record paths, methods and conditions. Cite the evidence that supports your choice and weigh task effects with model usage and cost.",
		"Compare a useful candidate through evolution_propose → evolution_candidate → evolution_prepare → evolution_replay → evolution_gate → evolution_decide → evolution_apply. For llm-outcome, evaluation.goal is enough for an LLM-generated frozen plan; reuse real tools and artifacts. Preserve each task's original checks, use comparable budgets and fresh starting inputs, and identify seen cases as regression evidence.",
		"Conclude every executable proposal, keeping useful negative results and research findings. After publication inspect exact later template and Skill bindings and outcomes. The platform driver opens the next round after your supervision settles.",
		"When retaining the current methods, finish with fenced json {\"outcome\":\"no_change\",\"reason\":\"...\"} and a settled proposal ledger. REJECT, KEEP_FOR_FURTHER_RESEARCH and rollback finish candidates as negative results. For a concrete obstruction use {\"outcome\":\"blocked\",\"reason\":\"...\"}; for a reason to end the loop use {\"outcome\":\"closed\",\"reason\":\"...\"}."
	];
	/** The first prompt one round's supervisor receives after a **verified** round: publish the method change the round's evidence shows. */
	async verifiedPrompt(state, graph, round, run, review, diagnosisId) {
		const publishedSkill = (await this.loopProposals(state)).filter((proposal) => proposal.status === "applied" && proposal.targetType === "skill").at(-1);
		const publishedTemplate = (await this.loopProposals(state)).filter((proposal) => proposal.status === "applied" && proposal.targetType === "task_definition").at(-1);
		return [
			`You are the platform RSI loop's supervisor for graph "${graph.name}" (${state.graphId}), round ${round} of ${state.config.iterationRounds}.`,
			...this.roundHeader(state, graph, round, run, review),
			...await this.costFeedback(state, run),
			`Current published skill of this loop: ${publishedSkill === void 0 ? "none yet — the ledger holds no applied skill for this loop" : `${publishedSkill.targetId} (proposal ${publishedSkill.proposalId}, applied)`}`,
			publishedTemplate === void 0 ? "Current published task template of this loop: none yet" : `Current published task template of this loop: ${publishedTemplate.targetId} (proposal ${publishedTemplate.proposalId}, applied)`,
			`Cite diagnosis:${diagnosisId} in evolution_propose.sourceRefs.`,
			"",
			"The round settled verified against the store's own acceptance criteria. Review its delivery and library experience; choose a useful improvement or retain the current method with no_change.",
			...round < state.config.iterationRounds ? [] : ["Final library review: review this execution's paths and experience for retention or revision. Settle your findings; this graph completes after review, and subsequent Tasks can test any final publication."],
			...this.supervisorMethod
		].join("\n");
	}
	/** The first prompt one round's supervisor receives after a **failed** round: debug the failure and prepare the method change the recovery round consumes. */
	async failedPrompt(state, graph, round, run, review, diagnosisId) {
		const publishedSkill = (await this.loopProposals(state)).filter((proposal) => proposal.status === "applied" && proposal.targetType === "skill").at(-1);
		const publishedTemplate = (await this.loopProposals(state)).filter((proposal) => proposal.status === "applied" && proposal.targetType === "task_definition").at(-1);
		return [
			`You are the platform RSI loop's supervisor for graph "${graph.name}" (${state.graphId}), round ${round} of ${state.config.iterationRounds}.`,
			...this.roundHeader(state, graph, round, run, review),
			...await this.costFeedback(state, run),
			`Current published skill of this loop: ${publishedSkill === void 0 ? "none yet — the ledger holds no applied skill for this loop" : `${publishedSkill.targetId} (proposal ${publishedSkill.proposalId}, applied)`}`,
			publishedTemplate === void 0 ? "Current published task template of this loop: none yet" : `Current published task template of this loop: ${publishedTemplate.targetId} (proposal ${publishedTemplate.proposalId}, applied)`,
			`Cite diagnosis:${diagnosisId} in evolution_propose.sourceRefs.`,
			"",
			`The round settled ${run.status}. Debug that failure using its evidence, review and delivery, and choose the reusable method change that helps the next attempt. For a one-off environmental or input repair, retain the current methods with no_change and explain the next useful recovery.`,
			...round < state.config.iterationRounds ? [] : ["Final library review: retain useful failure conditions and experience, and revise methods when justified. Settle your findings; this graph completes with the recorded task outcome after review, and subsequent Tasks can test any final publication."],
			...this.supervisorMethod
		].join("\n");
	}
	/** Record one loop position in memory, skipping a rewrite of the position this loop already holds. */
	async mark(state, progress) {
		if (await this.currentGraph(state) === void 0) return;
		const current$1 = state.progress;
		if (current$1 !== void 0 && current$1.round === progress.round && current$1.phase === progress.phase && current$1.note === progress.note) return;
		state.progress = progress;
		this.onProgress?.(state.graphId, progress);
	}
	/** The loop state of one graph, created on first sight and aligned with the graph record every time it is read. */
	loopFor(graph, storeId) {
		const existing = this.loops.get(graph.id);
		if (existing !== void 0) {
			if (this.matchesGraph(existing, graph)) return existing;
			this.forget(graph.id);
		}
		const state = {
			graphId: graph.id,
			storeId,
			rootSessionId: String(graph.rootSessionId),
			config: graph.rsi,
			stopped: false
		};
		this.loops.set(graph.id, state);
		this.byStore.set(storeId, graph.id);
		return state;
	}
	/** A graph this driver no longer schedules: its loop state goes away with its config. */
	forget(graphId) {
		const state = this.loops.get(graphId);
		if (state !== void 0) state.stopped = true;
		this.loops.delete(graphId);
		const stores = new Set([...this.byStore].filter(([, id]) => id === graphId).map(([id]) => id));
		if (state !== void 0) stores.add(state.storeId);
		for (const storeId of stores) {
			this.byStore.delete(storeId);
			unregisterGraphImprovementCap(storeId);
			this.registered.delete(storeId);
		}
	}
	/** A config carrying a different epoch or different settings replaces the loop; an identical re-set does not. */
	matchesGraph(state, graph) {
		return graph.rsi !== void 0 && String(graph.rootSessionId) === state.rootSessionId && sameRsiConfig(state.config, graph.rsi);
	}
	/** Re-read authority after an await and immediately before graph/recovery side effects. */
	async currentGraph(state) {
		if (this.stopped || this.loops.get(state.graphId) !== state) return void 0;
		const graph = await this.ctx.graphs.get(state.graphId).catch(() => void 0);
		if (this.stopped || this.loops.get(state.graphId) !== state || graph === void 0) return void 0;
		if (!this.matchesGraph(state, graph)) {
			this.forget(state.graphId);
			return;
		}
		return graph;
	}
};
/** The newest attempt that supervises one round's diagnosis, whether it settled or not. */
function supervisorAttemptOf(attempts, diagnosisId) {
	return attempts.filter((attempt) => attempt.role === "supervisor" && attempt.diagnosisId === diagnosisId).at(-1);
}
/** Whether two readings agree; replacement revokes a watcher while the same frozen root's facts remain authoritative. */
function sameRsiConfig(left, right) {
	return left.task === right.task && left.iterationRounds === right.iterationRounds && left.humanReview === right.humanReview && (left.epoch ?? 1) === (right.epoch ?? 1) && canonicalize(left.metrics ?? []) === canonicalize(right.metrics ?? []);
}
/**
* One round's supervision identity: the hand-off content this driver promises
* for it. It is derived from the round alone, so every attempt of one round —
* the first, the retry after a crash — carries the same promise, and the
* ledger's own conflict check never reads two attempts of one round as two
* different hand-offs.
*/
function roundHandoffDigest(input) {
	return sha256Hex(canonicalize({ ...input }));
}
/** Install one deployment's RSI loop driver: every graph that carries `rsi` settings gets its platform-scheduled loop. */
function installRsiLoopDriver(ctx, options = {}) {
	return new RsiLoopDriver(ctx, options).install();
}

//#endregion
//#region src/tools/approve.ts
function defineApproveTool(ctx) {
	return defineTool({
		name: "hitl_approve",
		description: "Request human approve/reject and wait. Use before irreversible or sensitive actions.",
		parameters: { prompt: {
			type: "string",
			required: true,
			description: "Approval request shown to the human"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			if (args.prompt.trim().length === 0) throw new Error("hitl_approve: prompt is empty");
			const agent = exec.agent;
			if (agent === void 0) throw new Error("hitl_approve: missing agent");
			return approvalAnswer(await ctx.approval.request({
				agent,
				toolName: "hitl_approve",
				callId: exec.callId,
				reason: args.prompt,
				signal: exec.signal
			}));
		}
	});
}

//#endregion
//#region src/tools/ask.ts
const QUESTION_ID = "hitl-ask";
function defineAskTool(ctx) {
	return defineTool({
		name: "hitl_ask",
		description: "Ask the human a text question and wait for the answer. Use for environment setup or decisions that need human input.",
		parameters: { prompt: {
			type: "string",
			required: true,
			description: "Question shown to the human"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			if (args.prompt.trim().length === 0) throw new Error("hitl_ask: prompt is empty");
			const item = (await ctx.userQuestions.ask({
				questions: [{
					id: QUESTION_ID,
					question: args.prompt
				}],
				...exec.agent !== void 0 ? { agent: exec.agent } : {},
				signal: exec.signal
			})).answers.find((entry) => entry.id === QUESTION_ID);
			return item?.custom ?? item?.selected.join(", ") ?? "";
		}
	});
}

//#endregion
//#region src/tools/budget-extend.ts
/** The whole argument surface: the request key and the approved run total. */
const DECLARED_PARAMETERS$1 = ["requestKey", "maxRuns"];
/** The run ceiling in force, or the words that say there is none. An absent ceiling is not zero and not infinity: this deployment sets no limit there, and a card that printed a number would be inventing one. */
function inForce(value) {
	return value === void 0 ? "none" : String(value);
}
/** The run-count raise this request names, as a recorded answer prints it. */
function raiseLines(proposal) {
	const raise = proposal.maxRuns;
	return raise === void 0 ? [] : [`- maxRuns: ${raise.previous} → ${raise.next}`];
}
/** The card a person decides from (K4): the store and the tree the raise belongs to, the request's own key and identity, the runs the store already holds, the run ceiling in force beside the deployment's. */
function renderAsk(ask) {
	const proposal = ask.proposal;
	return [
		`Budget extension of the tree in store "${ask.storeId}" — root task ${ask.rootTaskId}, asked by its root coordination session ${ask.rootSessionId}.`,
		`request key "${proposal.requestKey}" (identity ${proposal.requestDigest})`,
		`runs the store already holds: ${ask.runsUsed} — an approved total replaces the ceiling, never this count`,
		"run ceiling now (the approved total in force first, the ceiling this deployment configures in parentheses):",
		`- maxRuns: ${inForce(ask.effective.maxRuns)} in force (deployment configures ${inForce(ask.configured.maxRuns)}) → approves a total of ${proposal.maxRuns.next}`,
		"approving records ONE budget-extension event on this store: the tree keeps its runs, its tasks and its history, no run starts or resumes, nothing is re-opened, and the approved total becomes the ceiling every later admission reads.",
		"rejecting or cancelling records nothing and changes no ceiling."
	].join("\n");
}
/** The record as both the approved and the already-recorded answer print it: the raises, and the audit reference they were recorded under. */
function renderRecord(record) {
	return [...raiseLines(record), `approval on the record: ${record.approvalRef} — asked by ${record.requestedBy} at ${record.recordedAt}`];
}
function defineTaskBudgetExtendTool(ctx) {
	return defineTool({
		name: "task_budget_extend",
		description: "Ask a human to raise the run ceiling bounding this tree's execution, and record the raise they approve. State the total you want in force, never a difference: maxRuns is the WHOLE approved run count (a positive whole number, not \"add five\"), maxRuns is required; a run ceiling this deployment leaves unlimited is refused, as is any total that is not above the ceiling in force. The request is shown to a human with the store, the run ceiling and the runs already used, and only their explicit approval records anything — a rejection, a cancellation or an unavailable answerer writes nothing. A request key already recorded with the same totals is answered from the record without asking again; the same key at different totals is refused. A raise starts no run, resumes none, re-opens nothing and does not clear the runs already counted — it moves ceilings only. There is no argument here that approves anything or stands in for somebody's approval, and the store is derived from your session: only a graph's root coordination session can call this, and it may do so after its tree stopped.",
		parameters: {
			requestKey: {
				type: "string",
				required: true,
				description: "Stable key this request is answered under; a retry after a crash carries the same key and is answered from the recorded raise"
			},
			maxRuns: {
				type: "number",
				required: true,
				description: "The whole approved run count once the human approves — a positive whole number above the ceiling in force, never an increment"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, DECLARED_PARAMETERS$1, "task_budget_extend");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "task_budget_extend");
			let result;
			try {
				result = await ctx.taskRuntime.extendRootBudget(caller, {
					callId: exec.callId,
					execution: exec
				}, {
					requestKey: args.requestKey,
					maxRuns: args.maxRuns
				});
			} catch (error) {
				return `task_budget_extend rejected: ${message(error)}`;
			}
			if (result.answeredFromRecord) return [`task_budget_extend: request key "${result.record.requestKey}" is already recorded on store "${result.storeId}" (root task ${result.rootTaskId}) — answered from the record; no human was asked and nothing was appended.`, ...renderRecord(result.record)].join("\n");
			return [
				`task_budget_extend: approved and recorded on store "${result.storeId}" (root task ${result.rootTaskId})`,
				`request key "${result.record.requestKey}" (identity ${result.record.requestDigest})`,
				...renderRecord(result.record),
				"no run started, none resumed, no task changed and no terminal run re-opened; the runs already counted still count against the approved total."
			].join("\n");
		}
	});
}
/** The one approval a budget extension is granted through: the callback the assembly installs on the runtime once, and the only place a person's answer to `task_budget_extend` exists. */
function defineRootBudgetApproval(ctx) {
	return async (ask) => {
		const execution = ask.host.execution;
		const host = typeof execution === "object" && execution !== null ? execution : void 0;
		const agent = host?.agent;
		if (agent === void 0) return {
			kind: "refused",
			reason: "the host execution names no agent, so there is nobody to put the question to"
		};
		const callId = ask.host.callId;
		const outcome = await ctx.approval.request({
			agent,
			toolName: "task_budget_extend",
			callId,
			reason: renderAsk(ask),
			signal: host?.signal
		});
		if (outcome === "allowed-once") return {
			kind: "allowed",
			reference: `approval:${String(callId)}`
		};
		return {
			kind: "refused",
			reason: denialReason(outcome, {
				cancelled: "the question was cancelled before the human answered it",
				unavailable: "no approval answerer was available to put the question to a person"
			})
		};
	};
}

//#endregion
//#region src/tools/task-library.ts
/** One graph-owned table for reusable Task contracts and methods, including temporary discoveries. */
function defineTaskLibraryTool(ctx) {
	return defineTool({
		name: "task_library",
		description: "Manage this graph's TaskTemplate and Skill library. Read its task table and bound Skill table; use task_template_list for complete contracts and bind method:<name> through requiredCapabilities. Write useful exploration/decomposition goals as TaskTemplates and experience as concise Skills. New and changed entries are temporary and available to later tasks. The supervisor reviews execution evidence and model cost during iteration, retains useful experience, revises it by writing a new version, or retires an entry. Each Task keeps its own acceptance and frozen method binding.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"read",
					"write_task",
					"write_skill",
					"review"
				],
				required: true
			},
			template: {
				type: "object",
				additionalProperties: true,
				description: "Existing TaskTemplate format: id, version, catalogPath, appliesTo, parametersSchema, contract, optional direct-child decomposition."
			},
			name: {
				type: "string",
				description: "Skill name or TaskTemplate id."
			},
			skillMd: {
				type: "string",
				description: "Complete SKILL.md with name/description YAML frontmatter and concise method advice."
			},
			expectedVersion: {
				type: "integer",
				description: "For write_skill: 0 creates a new Skill; a change names its current version from read."
			},
			kind: {
				type: "string",
				enum: ["task", "skill"],
				description: "For review: the table containing the entry."
			},
			version: {
				type: "integer",
				description: "For review: the exact version from the table."
			},
			status: {
				type: "string",
				enum: ["retained", "retired"],
				description: "For review: retain or retire this reusable experience."
			},
			reason: {
				type: "string",
				description: "Review finding grounded in task results, cost and experience."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => text(value)
		},
		execute: async (args, exec) => {
			try {
				const caller = sessionId(exec, "task_library");
				if (args.action === "read") return JSON.stringify(await ctx.taskRuntime.libraryRead(caller), null, 2);
				if (args.action === "write_task") {
					if (args.template === void 0) throw new Error("write_task requires template");
					return JSON.stringify(await ctx.taskRuntime.libraryWrite(caller, {
						kind: "task",
						template: args.template
					}), null, 2);
				}
				if (args.action === "write_skill") {
					if (args.name === void 0 || args.skillMd === void 0 || args.expectedVersion === void 0) throw new Error("write_skill requires name, skillMd and expectedVersion");
					return JSON.stringify(await ctx.taskRuntime.libraryWrite(caller, {
						kind: "skill",
						name: args.name,
						skillMd: args.skillMd,
						expectedVersion: args.expectedVersion
					}), null, 2);
				}
				if (args.kind === void 0 || args.name === void 0 || args.version === void 0 || args.status === void 0 || args.reason === void 0) throw new Error("review requires kind, name, version, status and reason");
				return JSON.stringify(await ctx.taskRuntime.libraryReview(caller, {
					kind: args.kind,
					name: args.name,
					version: args.version,
					status: args.status,
					reason: args.reason
				}), null, 2);
			} catch (error) {
				return `task_library failed: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/capability-list.ts
/** `filesystem → read, write, edit, read_image` — the label kept, the real DSH names it resolves to shown, so a reader can see what a worker is actually granted. A label outside the vocabulary is shown as such and is what */
function renderTools(entry) {
	const labels = entry.tools ?? [];
	if (labels.length === 0) return "tools: []";
	return `tools: [${labels.map((label) => TOOL_LABELS[label] === void 0 ? `${label} → (unknown label)` : `${label} → ${TOOL_LABELS[label].join(", ")}`).join("; ")}]`;
}
function renderPermission(entry) {
	return entry.permission === void 0 ? "permission: (none — the worker keeps workspace-isolated)" : `permission: ${entry.permission}`;
}
function renderMcpServers(entry) {
	const servers = entry.mcpServers ?? [];
	if (servers.length === 0) return "";
	return `mcpServers: [${servers.join(", ")}] (mounted per worker at spawn, bound to the run's env checkout; tools appear as mcp__<server>__<tool>)`;
}
/** The first 12 hex of a content digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest) {
	return digest.slice(0, 12);
}
/** One skill's provider verdict, in the words the pre-check uses: */
function renderProvider(verdict) {
	if (!verdict.valid) return `${verdict.name} → invalid (${verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ")})`;
	if (verdict.role === "execution-provider") {
		const tools = verdict.requiredTools.length === 0 ? "none declared" : verdict.requiredTools.join(", ");
		return `${verdict.name} → execution-provider (verifier: ${verdict.verifierRef}; requires: ${tools}; content: ${shortDigest(verdict.contentDigest)})`;
	}
	if (verdict.role === "knowledge") return `${verdict.name} → knowledge (no execution verifier by design; content: ${shortDigest(verdict.contentDigest)})`;
	return `${verdict.name} → guidance (no sidecar; loadable guidance, not an execution provider; content: ${shortDigest(verdict.contentDigest)})`;
}
/** The provider line under one capability row: every skill's verdict, or the fact that the row grants none. `rows` is the pre-check's own output, so an error message or a missing skill cannot be papered over here. */
function renderProviders(row) {
	if (row === void 0) return "providers: (not checked)";
	const refusals = row.refusals ?? [];
	if (refusals.length > 0) return `providers: (refused — ${refusals.map((item) => `${item.code}: ${item.detail}`).join("; ")})`;
	if (row.skills.length === 0) return "providers: (none — the capability grants no skill)";
	return `providers: ${row.skills.map(renderProvider).join(" · ")}`;
}
function defineCapabilityListTool(ctx) {
	return defineTool({
		name: "capability_list",
		description: "List the capability names the task runtime can grant, with the tools/skills/agent preset each one carries and the provider verdict for every skill it declares. Call this before task_decompose to pick requiredCapabilities: a name outside this list is a capability gap, and the gap rejects the whole decomposition batch unless that child is declared decomposable.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (_args, exec) => {
			const caller = exec.agent?.id;
			const capabilities = typeof caller === "string" && caller.length > 0 ? await ctx.taskRuntime.capabilitiesForSession(caller) : ctx.taskRuntime.listCapabilities();
			const names = Object.keys(capabilities);
			const servers = Object.entries(ctx.taskRuntime.listMcpServers());
			if (names.length === 0 && servers.length === 0) return "no capabilities or MCP servers configured";
			const report = typeof caller === "string" && caller.length > 0 ? await ctx.taskRuntime.capabilityProviderReport(caller) : void 0;
			const verdicts = new Map((report?.capabilities ?? []).map((row) => [row.capability, row]));
			const lines = names.flatMap((name) => {
				const entry = capabilities[name];
				const mcp = renderMcpServers(entry);
				return [`- ${name} — ${[
					renderTools(entry),
					`skills: [${(entry.skills ?? []).join(", ")}]`,
					...entry.preset !== void 0 ? [`preset: ${entry.preset}`] : [],
					...mcp === "" ? [] : [mcp],
					renderPermission(entry)
				].join(" ")}`, `    ${report === void 0 ? "providers: (not checked — the tool was called without a calling session)" : renderProviders(verdicts.get(name))}`];
			});
			return [
				`capabilities (${names.length}):`,
				...lines,
				"",
				`registered MCP servers (${servers.length}):`,
				...servers.map(([name, server]) => `- ${name}: ${server.description} (namespace mcp__${server.serverName}__*)`),
				"A capability may grant registered servers through an approved Evolution candidate. New server definitions are registered in deployment configuration.",
				"",
				`worker baseline (every capability worker keeps these on top of its grants): ${workerBaseline().join(", ")}`,
				`baseline labels: ${WORKER_BASELINE_LABELS.join(", ")}; task machinery: ${WORKER_BASELINE_TOOLS.join(", ")}`,
				"",
				"tool labels: a capability declares labels (filesystem, bash, …); each expands to the DSH tool names shown after \"→\".",
				"tool grants are fail-closed: a worker sees its capabilities' tools plus the baseline plus (when a capability names its own preset) that preset's whole tool plane — nothing else from the global layer.",
				"skill grants are not exclusive: DSH has no per-agent skill hiding, so a granted skill is registered for that worker alone and guaranteed loadable, but the worker's skill catalog still lists every skill its composition can discover.",
				"provider verdicts are the same pre-check admission runs, from this session's own skill roots: execution-provider means the skill carries an execution sidecar whose verifier is registered and whose required tools its capabilities grant; knowledge and guidance are loadable but never count as an execution provider; invalid means admission refuses a batch that requires this capability, with the defects shown.",
				...report === void 0 ? [] : [`skill roots searched for this session: ${report.roots.join(", ")}`],
				"mcpServers grant whole MCP servers (never single tools): each mounts as one mcp-client instance on the worker at spawn, bound to that run's environment checkout; a server that cannot start fails the spawn loudly.",
				"permissions: a capability that declares none leaves the worker on the deployment default (workspace-isolated)."
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/context-read.ts
/** Every parameter this tool declares; anything else is refused by name before any read happens. */
const DECLARED$2 = [
	"kind",
	"ref",
	"offset",
	"limit"
];
function defineContextReadTool(ctx) {
	return defineTool({
		name: "context_read",
		description: `Read one record of the caller's own graph domain by its reference. Kinds and their references: Workers and delegated reviewers can read their task branch, ancestor context and dependency neighbours; roots and supervisors retain their domain view. \`task\` (a task id), \`run\` (a run id), \`evidence\` (an evidence id), \`diagnosis\` (a diagnosis id), \`review\` (\`{taskId, runId}\` — a review has no id of its own; use runId null for a task that blocked before any run), and \`session\`, which has two forms. \`session\` with a session id pages that session's log by DSH event seq: \`offset\` is an event seq and \`limit\` an event count (default 20, at most 100). An event too large for a listing page is never cut: the listing stops at that event's seq and names the exact \`{sessionId, seq}\` reference to read it with. \`session\` with \`{sessionId, seq}\` reads that one event's visible text (the same text the listing renders), paged in UTF-8 BYTES: \`offset\` is a byte offset into that text (default 0) and \`limit\` the page size in bytes (default the bound, clamped into 4..${CONTEXT_OUTPUT_LIMIT_BYTES}). A successful single-event page is a JSON object carrying sessionId, seq, offset, nextOffset, hasMore and body (this page's fragment, so concatenating the pages' body values by nextOffset restores the whole text); its last page says how to return to the listing. Task-class records are read whole and paged in UTF-8 BYTES: \`offset\` is a byte offset into the record text and \`limit\` is the page size in bytes (the whole answer never exceeds ${CONTEXT_OUTPUT_LIMIT_BYTES} bytes); an oversized record answers the first page with the next byte offset to continue from. The reference never widens the domain: an id this graph's store does not hold, a stale reference, an unreadable record and a session of another graph each come back as a named refusal (not-found, stale-reference, unreadable, cross-graph, context-too-large).`,
		parameters: {
			kind: {
				type: "string",
				required: true,
				enum: [
					"task",
					"run",
					"evidence",
					"review",
					"diagnosis",
					"session"
				],
				description: "Which record plane the reference names"
			},
			ref: {
				oneOf: [
					{ type: "string" },
					{
						type: "object",
						additionalProperties: false,
						properties: {
							taskId: { type: "string" },
							runId: { oneOf: [{ type: "string" }, { type: "null" }] }
						}
					},
					{
						type: "object",
						additionalProperties: false,
						properties: {
							sessionId: { type: "string" },
							seq: { type: "integer" }
						}
					}
				],
				required: true,
				description: "The record's own identity: an id string for task/run/evidence/diagnosis/session, `{taskId, runId}` for review (both keys required there; runId null when the task blocked before any run), `{sessionId, seq}` for one session event. Ids from another graph are refused; there is no graphId/storeId/callerId here."
			},
			offset: {
				type: "number",
				description: "Where the page starts. Task-class kinds and `{sessionId, seq}`: UTF-8 byte offset into the record or event text (default 0). A session id: a DSH event seq (default 0)"
			},
			limit: {
				type: "number",
				description: "How much one page carries. Task-class kinds and `{sessionId, seq}`: UTF-8 bytes (the event default is the whole bound, clamped into 4.." + String(CONTEXT_OUTPUT_LIMIT_BYTES) + "). A session id: events per page (default 20, at most 100)"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const refused = undeclaredParameters(args, DECLARED$2, "context_read", "and has no argument that names a graph, a store or a caller: the read domain is the calling session's own graph, and nothing here can widen it", "Nothing was read.");
			if (refused !== void 0) return refused;
			const caller = sessionId(exec, "context_read");
			return adaptRead("context_read", await ctx.singularityContext.contextRead(caller, {
				kind: args.kind,
				ref: args.ref,
				...args.offset === void 0 ? {} : { offset: args.offset },
				...args.limit === void 0 ? {} : { limit: args.limit }
			}, exec.signal));
		}
	});
}

//#endregion
//#region src/tools/escalate.ts
/** The three KISS §7 elements, named the way the refusal and the record name them. */
const ELEMENTS = [
	"what",
	"tried",
	"suggested"
];
/** One card as the approval reason shows it to the human. */
function cardLines(card) {
	return [
		`trigger: ${card.trigger}`,
		`what: ${card.what}`,
		`tried: ${card.tried}`,
		`suggested: ${card.suggested}`,
		...card.sourceTaskId === void 0 ? [] : [`source task: ${card.sourceTaskId}`],
		...card.sourceRefs === void 0 || card.sourceRefs.length === 0 ? [] : [`sourceRefs: [${card.sourceRefs.join(", ")}]`]
	];
}
function renderEscalation(escalation) {
	return [
		`- ${escalation.escalationId} [${escalation.status}] ${escalation.trigger} — what: ${escalation.what}`,
		`  tried: ${escalation.tried}`,
		`  suggested: ${escalation.suggested}`,
		`  source task: ${escalation.sourceTaskId ?? "(none)"} sourceRefs: [${escalation.sourceRefs.join(", ")}]`,
		`  approval: ${escalation.approvalRef} by ${escalation.actor} at ${escalation.at}`
	].join("\n");
}
function defineEscalateTool(ctx) {
	return defineTool({
		name: "escalate",
		description: "Report work you cannot settle yourself to a human (KISS §7 L4): a capability gap, an exhausted budget, or an UNKNOWN(verifier) verdict. The card names what is missing, what was already tried, and what is suggested — an incomplete card is refused, because a human must be able to decide from it in ten minutes. The card is shown to the human through the native approval seam first and is recorded in the append-only escalation ledger (`.dsh/escalations.jsonl`) only after an explicit approve; a reject, cancel, or unavailable answerer records nothing. Set list to read the recorded cards back without asking a human.",
		parameters: {
			what: {
				type: "string",
				description: "What is missing — the gap, the exhausted budget, or the verdict that cannot be judged"
			},
			tried: {
				type: "string",
				description: "What was already tried before escalating"
			},
			suggested: {
				type: "string",
				description: "What you suggest the human do"
			},
			trigger: {
				type: "string",
				enum: ESCALATION_TRIGGERS,
				description: "What raised the card"
			},
			escalationId: {
				type: "string",
				description: "Stable id for the card; omitted derives one. A repeated id is refused, so a retry after a failed raise stays idempotent"
			},
			sourceTaskId: {
				type: "string",
				description: "The task the card is about, when it has one"
			},
			sourceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Evidence / task / diagnosis refs behind the card"
			},
			list: {
				type: "boolean",
				description: "Read-only: list the recorded escalations instead of raising one"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			if (args.list === true) {
				const escalations = await ctx.escalation.list();
				if (escalations.length === 0) return "escalations: none recorded";
				return [`escalations (${escalations.length}):`, ...escalations.map(renderEscalation)].join("\n");
			}
			const caller = sessionId(exec, "escalate");
			const agent = exec.agent;
			if (agent === void 0) throw new Error("escalate: missing agent");
			const missing = ELEMENTS.filter((element) => {
				const value = args[element];
				return typeof value !== "string" || value.trim().length === 0;
			});
			if (missing.length > 0) return [
				`escalate rejected: incomplete L4 card — ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing`,
				"a human must be able to decide in ten minutes from what is missing, what was tried, and what is suggested",
				"nothing was recorded and no human was asked"
			].join("; ");
			if (args.trigger === void 0 || !ESCALATION_TRIGGERS.includes(args.trigger)) return `escalate rejected: trigger must be one of ${ESCALATION_TRIGGERS.join(" / ")}; nothing was recorded and no human was asked`;
			const card = {
				trigger: args.trigger,
				what: args.what,
				tried: args.tried,
				suggested: args.suggested,
				...args.escalationId === void 0 ? {} : { escalationId: args.escalationId },
				...args.sourceTaskId === void 0 ? {} : { sourceTaskId: args.sourceTaskId },
				...args.sourceRefs === void 0 ? {} : { sourceRefs: args.sourceRefs }
			};
			const reason = [
				"L4 escalation — a human decision is required",
				...cardLines(card),
				"approving records the card in the escalation ledger; rejecting records nothing"
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "escalate",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `escalate: no escalation recorded — ${denialReason(outcome)}; the work stays where it was`;
			try {
				const escalation = await ctx.escalation.raise(card, caller, `approval:${exec.callId}`);
				return [
					`escalation ${escalation.escalationId} recorded [${escalation.status}] trigger: ${escalation.trigger}`,
					...cardLines(escalation),
					"acceptance: all three elements present (what / tried / suggested) — a human can decide from this card in ten minutes",
					`recorded after human approval ${escalation.approvalRef}; ledger: ${ctx.escalation.file}`
				].join("\n");
			} catch (error) {
				return `escalate rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-scope.ts
/** Resolve the Evolution ledger for the caller's graph.  The compatibility
* fallback is intentionally only for embedders without a graph library (unit
* fixtures and the legacy direct API); a live TaskRuntime always supplies the
* graph library and therefore cannot silently use another graph's ledger. */
async function evolutionForSession(ctx, caller) {
	const service = ctx.evolution;
	if (typeof service.forSession !== "function") return service;
	return service.forSession(caller);
}

//#endregion
//#region src/tools/evolution-apply.ts
/** Why a decided PROMOTE proposal still cannot be applied: L4 harness evolution and target types this build has no executor for. */
function manualGuidance(proposal) {
	if (proposal.level === "L4") return "L4 harness evolution has no executor in evolution_apply: supervisor implementation and validation must precede human review through the harness change workflow";
	if (!APPLYABLE_TARGET_TYPES.includes(proposal.targetType)) return `this build writes a Task template, an existing Skill or one capability row with optional MCP definitions and Skill, so a decided "${proposal.targetType}" proposal has no executor here — its ledger record stays readable and nothing writes it`;
	return null;
}
/** How the approved production write takes effect. */
function effectNote(proposal) {
	if (proposal.targetType === "task_definition") return "effective for new task instances — the library serves the published template; existing task contracts and Run bindings stay fixed";
	if (proposal.targetType === "capability") return "effective for new admissions — the committed capability row, MCP definitions and optional new execution Skill are available to the runtime; a run already bound to the previous capability snapshot keeps that snapshot";
	return "effective immediately — the skill filesystem watches the skill root, so the write is live; the skill directory is admitted again now that its commit intent is closed, and a run already bound to the previous version keeps loading the snapshot it was bound to";
}
function defineEvolutionApplyTool(ctx) {
	return defineTool({
		name: "evolution_apply",
		description: "Apply a PROMOTE-decided Task template, Skill or capability candidate at L1–L3. Recheck the frozen candidate, experiment and production baseline. One exact-write approval is always requested through the native seam — a graph whose RSI settings run without a human resolves it on the spot. Review shows the exact mutation, definitions and targets. One existing durable commit writes production; retry settles its open intent without asking again. New admissions consume the published version; existing Task contracts and Run bindings stay fixed. evolution_rollback restores the baseline.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Decided (PROMOTE) proposal to apply to production"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_apply");
			const evolution = await evolutionForSession(ctx, caller);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_apply: missing agent");
			let proposal;
			try {
				proposal = await evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_apply rejected: ${message(error)}`;
			}
			if (proposal.openIntent !== void 0) try {
				const recovered = await evolution.apply(args.proposalId, caller, proposal.openIntent.approvalRef);
				return [
					`proposal ${recovered.proposal.proposalId} [applied] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — PROMOTE in effect`,
					...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
					"wrote production targets:",
					...recovered.proposal.targetType === "capability" ? [`  - capability row ${recovered.proposal.targetId} in the production table`] : [],
					...recovered.targets.map((target) => `  - ${target}`),
					effectNote(recovered.proposal)
				].join("\n");
			} catch (error) {
				return `evolution_apply rejected: ${message(error)}`;
			}
			if (proposal.status !== "decided") return `evolution_apply rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a decided proposal can be applied`;
			if (proposal.decision !== "PROMOTE") return `evolution_apply rejected: proposal ${proposal.proposalId} was decided ${proposal.decision}; only a PROMOTE decision can be applied`;
			const manual = manualGuidance(proposal);
			if (manual !== null) return `evolution_apply rejected: ${manual}`;
			let promotion;
			try {
				promotion = await evolution.checkPromotion(proposal.proposalId);
				await evolution.checkProductionBaseline(proposal.proposalId);
			} catch (error) {
				return `evolution_apply rejected: ${message(error)}`;
			}
			const targets = applyTargets(proposal, evolution);
			const reason = [
				`Evolution apply for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				"recorded decision: PROMOTE",
				`version set: ${JSON.stringify(proposal.versionSet)}`,
				`evaluated mutation: ${JSON.stringify(proposal.mutation)}`,
				`evaluation gate: ${JSON.stringify(proposal.gate)}`,
				`experiment/regression evidence: ${proposal.gate.regressionEvidenceRefs.join(", ")}`,
				...proposal.prepared?.mcpServers === void 0 ? [] : [`MCP definitions sha256:${proposal.prepared.mcpServers.digest}`],
				...proposal.prepared?.capabilityTable === void 0 ? [] : [`deployment config baseline sha256:${proposal.prepared.capabilityTable.baselineSha256}; apply sha256:${proposal.prepared.capabilityTable.applySha256}; rollback sha256:${proposal.prepared.capabilityTable.rollbackSha256}`],
				"this writes production targets:",
				...proposal.targetType === "capability" ? [`  - capability row ${proposal.targetId} in the production table`] : [],
				...targets.map((target) => `  - ${target}`),
				...renderProviderRoles(promotion.providers),
				effectNote(proposal),
				proposal.targetType === "capability" ? "rollback: evolution_rollback restores the row baseline and removes new MCP definitions and any new Skill" : proposal.targetType === "task_definition" ? "rollback: append the previous template content as a new version, or remove a first publication; existing contracts stay fixed" : "rollback: evolution_rollback restores the champion snapshot from the sandbox"
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_apply",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_apply: nothing written — ${denialReason(outcome)}; proposal ${proposal.proposalId} stays decided`;
			const approvalRef = `approval:${exec.callId}`;
			try {
				const applied = await evolution.apply(args.proposalId, caller, approvalRef);
				return [
					`proposal ${applied.proposal.proposalId} [applied] ${applied.proposal.level} ${applied.proposal.targetType} ${applied.proposal.targetId} — PROMOTE in effect`,
					"wrote production targets:",
					...applied.proposal.targetType === "capability" ? [`  - capability row ${applied.proposal.targetId} in the production table`] : [],
					...applied.targets.map((target) => `  - ${target}`),
					...renderProviderRoles(applied.providers ?? []),
					effectNote(applied.proposal),
					`human approval: ${approvalRef} — rollback with evolution_rollback`
				].join("\n");
			} catch (error) {
				return `evolution_apply rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-candidate.ts
function defineEvolutionCandidateTool(ctx) {
	return defineTool({
		name: "evolution_candidate",
		description: "Record one candidate as mutationJson (a JSON string). task_definition: {template:<complete canonical TaskTemplate>,criterionRepair?:{positive:{taskId,sourceDir,parameters},negative:{taskId,sourceDir,parameters}}}; changed child criteria need both fixed examples under the original independent parent oracle. Skill: {name,content:<whole SKILL.md>,resources?:{<relative path>:<whole UTF-8 text>}}. SKILL.md must have valid YAML frontmatter with the same name. Resources support resources/<file>, scripts/<file> and references/<file>, including executable Tool source; supply the complete resource collection to replace it, or omit resources to preserve production resources. Capability: {rows:{<name>:<whole row>},mcpServers?:{<id>:{serverName,description,command,args?,env?,cwd?,toolCallTimeoutMs?}},skill?:{name,content,sidecar:{precondition,inputs,outputs,requiredTools,verifier:{ref}}}}. A row may grant skills, native tool labels or MCP ids and need not contain a Skill. New definitions must be granted by that row; use their serverName in mcp__<serverName>__<tool> names. Native tools must already be authorized; existing permission and preset stay fixed. New Skill sidecar contractVersion, type, capabilities, content hashes and resources are derived by this tool. No production changes. Next: evolution_prepare, evolution_replay, evolution_gate.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Proposal to move into candidate"
			},
			versionSet: {
				type: "object",
				additionalProperties: true,
				required: true,
				description: "Complete version set the candidate aligns to: name → version string, at least one entry"
			},
			mutationJson: {
				type: "string",
				required: true,
				description: "JSON text of one complete Task template, Skill or capability mutation as described above. If skill is present, its sidecar is an object, not quoted JSON; supply only precondition, inputs, outputs, requiredTools and verifier:{ref}."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_candidate");
			const evolution = await evolutionForSession(ctx, caller);
			const versions = args.versionSet;
			try {
				const mutation = JSON.parse(args.mutationJson);
				if (mutation === null || typeof mutation !== "object" || Array.isArray(mutation)) throw new Error("mutationJson must contain a JSON object");
				const candidate = mutation;
				if (candidate.skill !== void 0) {
					const skill = candidate.skill;
					if (skill === null || typeof skill !== "object" || Array.isArray(skill) || typeof skill.content !== "string") throw new Error("mutationJson.skill must carry the whole SKILL.md content");
					const sidecar = skill.sidecar;
					if (sidecar === null || typeof sidecar !== "object" || Array.isArray(sidecar)) throw new Error("mutationJson.skill.sidecar must be an object");
					for (const key of Object.keys(sidecar)) if (![
						"precondition",
						"inputs",
						"outputs",
						"requiredTools",
						"verifier"
					].includes(key)) throw new Error(`mutationJson.skill.sidecar.${key} is not an authorable field`);
					const rows = candidate.rows;
					if (rows === null || typeof rows !== "object" || Array.isArray(rows) || Object.keys(rows).length !== 1) throw new Error("mutationJson.rows must hold exactly one capability row");
					skill.sidecar = {
						contractVersion: 1,
						type: "execution",
						capabilities: Object.keys(rows),
						...sidecar,
						content: {
							skillMdSha256: createHash("sha256").update(skill.content).digest("hex"),
							resources: []
						}
					};
				}
				const proposal = await evolution.candidate(args.proposalId, versions, caller, candidate);
				const versionsText = Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(", ");
				return [`proposal ${proposal.proposalId} [candidate] version set: ${versionsText}`, "ledger entry only — no branch created, nothing executed; mutation recorded — next: evolution_prepare (sandbox materialization), then evolution_replay (the two-sided experiment), then evolution_gate"].join("\n");
			} catch (error) {
				return `evolution_candidate rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-decide.ts
/** The six verbatim gate questions with their answers, the regression evidence on the third — what the human approves. */
function gateAnswerLines(gate) {
	if (gate === void 0) return ["gate answers: none recorded"];
	const evidence = gate.regressionEvidenceRefs.length === 0 ? "" : ` [evidence: ${gate.regressionEvidenceRefs.join(", ")}]`;
	return [
		"gate answers:",
		`1. Target failure fixed? ${gate.targetFailureFixed}`,
		`2. Original acceptance maintained? ${gate.originalAcceptanceMaintained}`,
		`3. Existing regression maintained? ${gate.existingRegressionMaintained}${evidence}`,
		`4. No unacceptable side effects? ${gate.noUnacceptableSideEffects}`,
		`5. Holdout performance acceptable? ${gate.holdoutPerformanceAcceptable}`,
		`6. Resource cost acceptable? ${gate.resourceCostAcceptable}`
	];
}
function defineEvolutionDecideTool(ctx) {
	return defineTool({
		name: "evolution_decide",
		description: "Settle a proposal with PROMOTE, REJECT or KEEP_FOR_FURTHER_RESEARCH. REJECT and KEEP_FOR_FURTHER_RESEARCH can conclude an open proposal before gate with a reason in note. PROMOTE requires a gated proposal and rechecks the frozen Task template, Skill or capability candidate and completed experiment. The decision is recorded only after one approval is requested through the native seam — a graph whose RSI settings run without a human resolves it on the spot; evolution_apply handles the production write afterwards.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Open or gated proposal to decide"
			},
			decision: {
				type: "string",
				required: true,
				enum: EVOLUTION_DECISIONS,
				description: "Model decision to record"
			},
			note: {
				type: "string",
				description: "Rationale attached to the decision; required to conclude an ungated proposal"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_decide");
			const evolution = await evolutionForSession(ctx, caller);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_decide: missing agent");
			let proposal;
			try {
				proposal = await evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_decide rejected: ${message(error)}`;
			}
			try {
				assertDecisionTransition(proposal, args.decision, args.note);
			} catch (error) {
				return `evolution_decide rejected: ${message(error)}`;
			}
			if (args.decision === "PROMOTE") try {
				await evolution.checkPromotion(proposal.proposalId);
			} catch (error) {
				return `evolution_decide rejected: ${message(error)}`;
			}
			const reason = [
				`Evolution decision for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				...gateAnswerLines(proposal.gate),
				`proposed decision: ${args.decision}${args.note === void 0 ? "" : ` — ${args.note}`}`,
				`proposal rationale: ${proposal.rationale}`,
				"this records the decision only — nothing is promoted, written or rolled back."
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_decide",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_decide: no decision recorded — ${denialReason(outcome)}; proposal ${proposal.proposalId} stays ${proposal.status}`;
			try {
				const decided = await evolution.decide(args.proposalId, args.decision, caller, `approval:${exec.callId}`, args.note);
				return [`proposal ${decided.proposalId} [decided] ${decided.decision}${decided.decisionNote === void 0 ? "" : ` — ${decided.decisionNote}`}`, decided.decision === "PROMOTE" ? "nothing applied yet; evolution_apply (second human gate) takes it to production" : "no decision becomes production — nothing was applied"].join("\n");
			} catch (error) {
				return `evolution_decide rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-gate.ts
function defineEvolutionGateTool(ctx) {
	return defineTool({
		name: "evolution_gate",
		description: "Answer the minimal Validation Gate for a candidate (status: gated). The six questions (细化想法4 §32): 1. Target failure fixed (or frozen success objective improved)? 2. Original acceptance maintained? 3. Existing regression maintained? 4. No unacceptable side effects? 5. Holdout performance acceptable? 6. Resource cost acceptable? All six answers are required, and the regression side must cite evidence ids (from this graph's task store) or file paths whose existence is checked — cited evidence is never executed. A Task template, Skill or capability candidate must pass evolution_prepare (sandbox materialization) and then evolution_replay (the two-sided experiment: a new baseline run and a new candidate run per frozen sample, the production object and the prepared object each loaded whole), and its report path must be one of the regressionEvidenceRefs — the gate refuses either candidate whose experiment is not complete. A capability sample without a provider records the runtime's real not-admitted baseline. Other target types cannot become candidates and have no gate to answer. Records the ledger entry only; nothing is promoted or changed, and evolution_decide re-checks the candidate's whole content identity and its provider verdict before a PROMOTE can be recorded. Next step is evolution_decide, which requests one approval — auto-resolved when the graph runs without a human.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Candidate to gate"
			},
			targetFailureFixed: {
				type: "string",
				required: true,
				description: "Target failure fixed, or verified source improved under frozen tool-call-reduction or llm-outcome; cite the saved report verdict. LLM judgement input and response identities are mechanically rechecked without resampling."
			},
			originalAcceptanceMaintained: {
				type: "string",
				required: true,
				description: "Answer to \"2. Original acceptance maintained?\""
			},
			existingRegressionMaintained: {
				type: "string",
				required: true,
				description: "Answer to \"3. Existing regression maintained?\""
			},
			noUnacceptableSideEffects: {
				type: "string",
				required: true,
				description: "Answer to \"4. No unacceptable side effects?\""
			},
			holdoutPerformanceAcceptable: {
				type: "string",
				required: true,
				description: "Answer to \"5. Holdout performance acceptable?\""
			},
			resourceCostAcceptable: {
				type: "string",
				required: true,
				description: "Answer to \"6. Resource cost acceptable?\""
			},
			regressionEvidenceRefs: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Evidence behind the regression answers: the experiment report path plus evidence ids or paths (existence-checked, never executed), at least one"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_gate");
			const evolution = await evolutionForSession(ctx, caller);
			let evidenceIds = /* @__PURE__ */ new Set();
			try {
				const graph = await ctx.graphs.graphForSession(caller);
				const snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId));
				evidenceIds = new Set(snapshot.evidence.map((item) => item.evidenceId));
			} catch {
				evidenceIds = /* @__PURE__ */ new Set();
			}
			try {
				const proposal = await evolution.gate(args.proposalId, {
					targetFailureFixed: args.targetFailureFixed,
					originalAcceptanceMaintained: args.originalAcceptanceMaintained,
					existingRegressionMaintained: args.existingRegressionMaintained,
					noUnacceptableSideEffects: args.noUnacceptableSideEffects,
					holdoutPerformanceAcceptable: args.holdoutPerformanceAcceptable,
					resourceCostAcceptable: args.resourceCostAcceptable,
					regressionEvidenceRefs: args.regressionEvidenceRefs
				}, caller, async (ref) => evidenceIds.has(ref));
				return [`proposal ${proposal.proposalId} [gated] gate answered 6/6, regression evidence: [${proposal.gate.regressionEvidenceRefs.join(", ")}]`, "ledger entry only — nothing executed or promoted; next: evolution_decide (one approval)"].join("\n");
			} catch (error) {
				return `evolution_gate rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-list.ts
const TARGET_TYPES = [
	"skill",
	"tool",
	"capability",
	"task_definition",
	"decomposition_policy",
	"agent_preset",
	"workflow_policy",
	"verifier",
	"runtime_policy"
];
function defineEvolutionListTool(ctx) {
	return defineTool({
		name: "evolution_list",
		description: "Read the existing proposal ledger, optionally filtering status or target. Shows Task template, Skill and capability candidates, frozen identities, experiment evidence, decisions, production writes and open commit intents. Follow the recorded status; reuse an existing proposal and settle its open intent before starting another write.",
		parameters: {
			status: {
				type: "string",
				enum: [
					"proposed",
					"candidate",
					"prepared",
					"gated",
					"decided",
					"applied",
					"rolledback"
				],
				description: "Only proposals in this status"
			},
			targetType: {
				type: "string",
				enum: TARGET_TYPES,
				description: "Only proposals pointing at this mutation surface"
			},
			targetId: {
				type: "string",
				description: "Only proposals pointing at this target"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const evolution = await evolutionForSession(ctx, sessionId(exec, "evolution_list"));
			const proposals = await evolution.list({
				...args.status === void 0 ? {} : { status: args.status },
				...args.targetType === void 0 ? {} : { targetType: args.targetType },
				...args.targetId === void 0 ? {} : { targetId: args.targetId }
			});
			if (proposals.length === 0) return "evolution ledger: no proposals match";
			const lines = [`evolution ledger (${proposals.length}):`];
			for (const proposal of proposals) {
				const decision = proposal.decision === void 0 ? "" : ` ${proposal.decision}`;
				lines.push(`- ${proposal.proposalId} [${proposal.status}${decision}] ${proposal.level} ${proposal.targetType} ${proposal.targetId} (base ${proposal.baseVersion})`);
				lines.push(`  rationale: ${proposal.rationale}`);
				lines.push(`  sourceRefs: [${proposal.sourceRefs.join(", ")}]`);
				if (proposal.versionSet !== void 0) lines.push(`  version set: ${Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(", ")}`);
				if (proposal.mutation !== void 0) lines.push(`  mutation: ${proposal.targetType} mutation recorded`);
				if (proposal.prepared !== void 0) {
					const view = proposal.prepared;
					if (proposal.targetType === "task_definition") {
						lines.push(`  sandbox: ${evolution.root}/${view.sandbox} (${view.files.length} files, frozen template libraries)`);
						lines.push(`  candidate template: ${view.templateCandidate.template.id}@${view.templateCandidate.template.version} sha256:${view.templateCandidate.digest}`);
						lines.push(view.templateBaseline == null ? "  template baseline: absent" : `  template baseline: ${view.templateBaseline.template.id}@${view.templateBaseline.template.version} sha256:${view.templateBaseline.digest}`);
					} else if (proposal.targetType === "capability") {
						const row = view.capabilityRow;
						const baseline = view.capabilityBaseline;
						lines.push(`  sandbox: ${evolution.root}/${view.sandbox} (${view.files.length} files, capability row${view.skillContent === void 0 ? "" : " + new execution skill"})`);
						lines.push(`  candidate row: ${row.name} sha256:${row.digest.slice(0, 12)}…`);
						lines.push(`  production row baseline: ${baseline === null ? "absent" : `${baseline.name} sha256:${baseline.digest.slice(0, 12)}…`}`);
						lines.push(view.skillContent === void 0 ? "  no new skill object" : `  new execution skill: ${view.skillContent.name} sha256:${view.skillContent.sha256.slice(0, 12)}… (SKILL.md + SKILL.contract.json)`);
						if (view.skillContent !== void 0) lines.push("  production skill baseline: absent");
						if (view.mcpServers !== void 0) lines.push(`  candidate MCP definitions sha256:${view.mcpServers.digest}: ${JSON.stringify(view.mcpServers.definitions)}`);
					} else {
						const shape = view.skillContent.contract === void 0 ? "guidance (SKILL.md)" : "execution provider (SKILL.md + SKILL.contract.json)";
						lines.push(`  sandbox: ${evolution.root}/${view.sandbox} (${view.files.length} files, ${shape}, champion snapshot ${view.champion}, candidate content ${view.skillContent.name} sha256:${view.skillContent.sha256.slice(0, 12)}…, ` + (view.skillBaseline == null ? "production baseline absent)" : `production baseline ${view.skillBaseline.name} sha256:${view.skillBaseline.sha256.slice(0, 12)}…)`));
					}
				}
				if (proposal.gate !== void 0) lines.push(`  gate regression evidence: [${proposal.gate.regressionEvidenceRefs.join(", ")}]`);
				if (proposal.openIntent !== void 0) {
					const intent = proposal.openIntent;
					lines.push(`  open commit intent: ${intent.intentId} (${intent.direction}) recorded ${intent.at} — production targets [${intent.files.map((file) => file.target).join(", ")}]`, `  a production write is underway and its completion has not been recorded: ${proposal.targetType === "capability" ? "the capability table and optional new skill directory stay" : "the skill directory stays"} closed to new admission until a reconciliation (a restart, or a retry of the apply/rollback) settles it`);
				}
				if (proposal.applied !== void 0) lines.push(`  applied: [${proposal.applied.targets.join(", ")}] (approval ${proposal.applied.approvalRef})`);
				if (proposal.rolledback !== void 0) lines.push(`  rolled back: [${proposal.rolledback.targets.join(", ")}] (approval ${proposal.rolledback.approvalRef})`);
				lines.push(`  history: ${proposal.history.map((entry) => `${entry.status} by ${entry.actor} at ${entry.at}`).join(" → ")}`);
			}
			return lines.join("\n");
		}
	});
}

//#endregion
//#region src/tools/evolution-prepare.ts
function defineEvolutionPrepareTool(ctx) {
	return defineTool({
		name: "evolution_prepare",
		description: "Freeze the candidate and its production baseline in the proposal sandbox. A Task candidate freezes both template libraries; a Skill freezes SKILL.md, its complete text resource collection and existing execution declaration; a capability freezes its whole row, optional MCP launch definitions and optional new execution Skill. No production changes. Next: evolution_replay, then evolution_gate.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Task template, Skill or capability candidate to freeze"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_prepare");
			const evolution = await evolutionForSession(ctx, caller);
			try {
				const prepared = await evolution.prepare(args.proposalId, caller);
				const view = prepared.prepared;
				if (view.templateCandidate !== void 0) return [
					`proposal ${prepared.proposalId} [prepared] sandbox: ${evolution.root}/${view.sandbox}`,
					...view.files.map((file) => `  wrote ${file}`),
					`candidate template: ${view.templateCandidate.template.id}@${view.templateCandidate.template.version} sha256:${view.templateCandidate.digest}`,
					view.templateBaseline == null ? "template baseline: absent" : `template baseline: ${view.templateBaseline.template.id}@${view.templateBaseline.template.version} sha256:${view.templateBaseline.digest}`,
					"sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate"
				].join("\n");
				if (view.capabilityRow !== void 0) {
					const rowBaseline = view.capabilityBaseline ?? null;
					return [
						`proposal ${prepared.proposalId} [prepared] sandbox: ${evolution.root}/${view.sandbox}`,
						...view.files.map((file) => `  wrote ${file}`),
						`candidate row: ${view.capabilityRow.name} sha256:${view.capabilityRow.digest.slice(0, 12)}…`,
						rowBaseline === null ? "registry baseline: the table held no such row, so this candidate adds it" : `registry baseline: row sha256:${rowBaseline.digest.slice(0, 12)}… (an apply refuses if the registry row changed since this read)`,
						...view.mcpServers === void 0 ? [] : [`candidate MCP definitions sha256:${view.mcpServers.digest}: ${JSON.stringify(view.mcpServers.definitions)}`],
						view.skillContent === void 0 ? "candidate object: the row alone — no new skill object is materialized" : "candidate object: a new execution provider (SKILL.md + SKILL.contract.json) the row grants, judged by a registered verifier with resources: []",
						"sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate"
					].join("\n");
				}
				const baseline = view.skillBaseline;
				return [
					`proposal ${prepared.proposalId} [prepared] sandbox: ${evolution.root}/${view.sandbox}`,
					...view.files.map((file) => `  wrote ${file}`),
					view.skillContent.contract === void 0 ? "candidate object: guidance (SKILL.md and its frozen text resources)" : "candidate object: execution provider (SKILL.md + SKILL.contract.json) — the sidecar is derived from production with the candidate content identity, so this candidate cannot move a capability, a required tool or a verifier",
					`frozen resources: ${(view.skillContent.resources ?? []).map((resource) => `${resource.path} sha256:${resource.sha256}`).join(", ") || "none"}`,
					baseline == null ? "champion snapshot: absent; both experiment sides execute the original Task" : "champion snapshot: captured under champion/",
					baseline == null ? "production baseline: absent; candidate introduces this Skill" : `production baseline: ${baseline.name} sha256:${baseline.sha256.slice(0, 12)}… (an apply refuses if the production object changed since this read)`,
					"sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate"
				].join("\n");
			} catch (error) {
				return `evolution_prepare rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-propose.ts
/** The mutation surfaces this build records for Evolution — its own vocabulary, not the diagnosis's (A5): */
const PROPOSAL_TARGET_TYPES = [
	"skill",
	"tool",
	"capability",
	"task_definition",
	"decomposition_policy",
	"agent_preset",
	"workflow_policy",
	"verifier",
	"runtime_policy"
];
const TARGET_TYPE_SET = new Set(PROPOSAL_TARGET_TYPES);
function isProposalTargetType(value) {
	return typeof value === "string" && TARGET_TYPE_SET.has(value);
}
function defineEvolutionProposeTool(ctx) {
	return defineTool({
		name: "evolution_propose",
		description: "Record an evidenced shared change as a proposal. Executable targetType names are task_definition (a TaskTemplate), skill (a new or existing Skill in this graph library), and capability (one whole row with optional new MCP definitions and an optional new execution Skill). Use evolution_candidate, evolution_prepare, evolution_replay and evolution_gate before recording the model decision through evolution_decide. evolution_apply publishes under the deployment publication approval policy. Other target types remain suggestions. Existing Task contracts and Run bindings stay fixed.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Unique id for this proposal; a duplicate id is rejected"
			},
			level: {
				type: "string",
				required: true,
				enum: [
					"L1",
					"L2",
					"L3",
					"L4"
				],
				description: "Evolution level (L1 execution adaptation / L2 capability / L3 workflow / L4 harness); publication follows the deployment approval policy"
			},
			baseVersion: {
				type: "string",
				required: true,
				description: "Current target version; a first Task template or new Skill uses absent (first template version 1)"
			},
			targetType: {
				type: "string",
				enum: PROPOSAL_TARGET_TYPES,
				description: "Executable: task_definition for a TaskTemplate, skill or capability. Other types remain suggestions. Required unless fromDiagnosis."
			},
			targetId: {
				type: "string",
				description: "Name of the concrete target (required unless fromDiagnosis)"
			},
			rationale: {
				type: "string",
				description: "Why this change would address the diagnosed cause (required unless fromDiagnosis)"
			},
			sourceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Sources this proposal rests on: diagnosis:<diagnosisId>, exact taskId#runId review refs, or evidence ids. Known bare diagnosis ids are stored as diagnosis:<id>."
			},
			fromDiagnosis: {
				type: "object",
				additionalProperties: false,
				description: "Transcribe targetType/targetId/rationale from one proposal of a recorded diagnosis",
				properties: {
					diagnosisId: {
						type: "string",
						required: true,
						description: "Recorded diagnosis id"
					},
					proposalIndex: {
						type: "number",
						required: true,
						description: "Index into the diagnosis proposals array (0-based)"
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_propose");
			const evolution = await evolutionForSession(ctx, caller);
			let targetType = args.targetType;
			let targetId = args.targetId;
			let rationale = args.rationale;
			const sourceRefs = [...args.sourceRefs ?? []];
			if (args.fromDiagnosis !== void 0) {
				if (targetType !== void 0 || targetId !== void 0 || rationale !== void 0) throw new Error("evolution_propose: fromDiagnosis already supplies targetType/targetId/rationale — do not pass both");
				const graph = await ctx.graphs.graphForSession(caller);
				const diagnosis = (await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))).diagnoses.find((item) => item.diagnosisId === args.fromDiagnosis.diagnosisId);
				if (diagnosis === void 0) throw new Error(`evolution_propose: unknown diagnosis "${args.fromDiagnosis.diagnosisId}"`);
				const proposal = diagnosis.proposals[args.fromDiagnosis.proposalIndex];
				if (proposal === void 0) throw new Error(`evolution_propose: diagnosis "${diagnosis.diagnosisId}" has no proposal #${args.fromDiagnosis.proposalIndex}`);
				targetType = proposal.targetType;
				targetId = proposal.targetId;
				rationale = proposal.rationale;
				if (!isProposalTargetType(targetType)) throw new Error(`evolution_propose: diagnosis "${diagnosis.diagnosisId}" proposal #${args.fromDiagnosis.proposalIndex} names targetType "${String(targetType)}", which this build cannot execute; it stays a recorded suggestion (recorded target types: ${PROPOSAL_TARGET_TYPES.join(" / ")})`);
				sourceRefs.unshift(`diagnosis:${diagnosis.diagnosisId}`);
			} else if (targetType === void 0 || targetId === void 0 || rationale === void 0) throw new Error("evolution_propose: targetType, targetId and rationale are required without fromDiagnosis");
			if (!isProposalTargetType(targetType)) throw new Error(`evolution_propose: targetType must be one of ${PROPOSAL_TARGET_TYPES.join(" / ")}, got "${String(targetType)}"`);
			try {
				const proposal = await evolution.propose({
					proposalId: args.proposalId,
					targetType,
					targetId,
					baseVersion: args.baseVersion,
					level: args.level,
					rationale,
					sourceRefs
				}, caller);
				const skillReplacement = "ledger entry only — nothing was executed or changed; next: evolution_candidate with mutationJson as JSON text carrying the full replacement text of the Skill's SKILL.md (use baseVersion absent for its first version). An execution skill's SKILL.contract.json is derived from production at evolution_prepare (only its content.skillMdSha256 is recomputed, so a content update cannot move a capability, a required tool or a verifier)";
				const capabilityReplacement = "ledger entry only — nothing was executed or changed; next: evolution_candidate with mutationJson as JSON text carrying exactly one whole capability row { rows }, optional new MCP launch definitions { mcpServers }, and optionally a NEW execution skill { name, content, sidecar semantic fields }; the definitions and granted capability are evaluated together; permission and preset stay fixed";
				const taskReplacement = "ledger entry only — next: evolution_candidate with mutationJson {template,criterionRepair?}; submit one complete canonical TaskTemplate. Changing child criteria requires fixed positive and negative examples under the original independent parent oracle.";
				const recordedSuggestion = `ledger entry only — nothing was executed or changed; this build promotes a Task template, an existing Skill or one capability row with an optional new execution skill, so a "${proposal.targetType}" proposal stays a recorded suggestion: it cannot become a candidate, is never evaluated, and is never promoted`;
				return [
					`proposal ${proposal.proposalId} registered [proposed] ${proposal.level} ${proposal.targetType} ${proposal.targetId} (base ${proposal.baseVersion})`,
					`rationale: ${proposal.rationale}`,
					`sourceRefs: [${proposal.sourceRefs.join(", ")}]`,
					proposal.targetType === "skill" ? skillReplacement : proposal.targetType === "capability" ? capabilityReplacement : proposal.targetType === "task_definition" ? taskReplacement : recordedSuggestion
				].join("\n");
			} catch (error) {
				return `evolution_propose rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-replay.ts
/** The model selection this experiment freezes — read from the evolution plane's injected resolver, never from the caller (§F.2: the model is frozen before the runs, and a model-filled string could not be one). */
/** The workspace the caller's own session runs in — the frozen input snapshot both experiment sides are built from. */
async function callerWorkspace(ctx, caller) {
	const runtime = optionalService(ctx, "taskRuntime");
	let path;
	try {
		path = await runtime?.workspacePathFor?.(caller);
	} catch (error) {
		throw new Error(`cannot resolve the caller session's workspace: ${message(error)}`);
	}
	if (typeof path !== "string" || path.length === 0) throw new Error(`this deployment cannot name the workspace of session "${caller}", which the experiment would freeze as its input snapshot — name the caller's env workspace before evaluating a Task template, Skill or capability candidate`);
	return path;
}
/** The task's latest review record — the record a sample's role is read from. */
function latestReview(snapshot, task) {
	const runId = task.runIds[task.runIds.length - 1];
	return snapshot.reviews.find((item) => item.runId === runId);
}
/** The role one named task has, from the store's own history: its latest review decides whether the case is a failure the candidate is meant to fix or a passing case it must not break. The caller names tasks; */
function roleOf(snapshot, taskId, objective) {
	const task = snapshot.tasks.find((item) => item.taskId === taskId);
	if (task === void 0) throw new Error(`unknown task "${taskId}" in this graph's task store`);
	if (task.status !== "verified" && task.status !== "failed") throw new Error(`task "${taskId}" is ${task.status}; only a terminal (verified or failed) task carries the history a role is read from`);
	const review = latestReview(snapshot, task);
	if (review === void 0) throw new Error(`task "${taskId}" has no review record on its latest run; there is no case to reproduce`);
	if (review.outcome === "failed") return "observed-failure";
	if (review.outcome === "verified") return objective !== void 0 ? "observed-success" : "observed-regression";
	throw new Error(`task "${taskId}" is ${task.status} but its latest review record is "${review.outcome}"; a sample must be the case its role names, and only a failed or verified record names one`);
}
/** Derive sample roles from real Task history. Shared publication also needs independent holdout Tasks. */
function deriveExperimentSamples(snapshot, taskIds, holdoutTaskIds, objective, libraryId) {
	const named = [...taskIds, ...holdoutTaskIds];
	if (new Set(named).size !== named.length) throw new Error("taskIds and holdoutTaskIds must not overlap or repeat");
	if (taskIds.length === 0) throw new Error("taskIds must name the observed samples the candidate is evaluated against");
	if (holdoutTaskIds.length === 0 && libraryId === void 0) throw new Error("holdoutTaskIds must name at least one task that did not select this candidate — the two-sided experiment evaluates the observed cases and the held-out ones together, and an empty holdout proves nothing about what the candidate may break");
	const samples = [...taskIds.map((taskId) => ({
		taskId,
		role: roleOf(snapshot, taskId, objective)
	})), ...holdoutTaskIds.map((taskId) => ({
		taskId,
		role: "holdout"
	}))];
	const requiredRole = objective !== void 0 ? "observed-success" : "observed-failure";
	if (!samples.some((sample) => sample.role === requiredRole)) throw new Error(`taskIds must include at least one ${requiredRole} for the experiment objective`);
	return samples;
}
/** The experiment's criterion diff: the baseline run's verdict → the candidate run's, per criterion that moved. */
function renderExperimentCriterionDiff(baseline, candidate) {
	const byId = new Map(candidate.map((item) => [item.criterionId, item]));
	const diff = [];
	for (const item of baseline) {
		const other = byId.get(item.criterionId);
		byId.delete(item.criterionId);
		if (other?.verdict !== item.verdict) diff.push(`${item.criterionId} ${item.verdict}→${other?.verdict ?? "—"}`);
	}
	for (const item of byId.values()) diff.push(`${item.criterionId} —→${item.verdict}`);
	return diff.length === 0 ? "no criterion diff" : diff.join(", ");
}
/** What one experiment produced, as its caller reads it. The baseline is said to be a new run of *this* experiment in the first line that describes the sides: */
function renderExperiment(result, targetId) {
	const { report } = result;
	const ceiling = report.frozen.budget.maxTokens;
	const budget = ceiling === void 0 ? "no maxTokens ceiling declared" : `maxTokens ${ceiling}`;
	const baseline = report.frozen.productionBaseline;
	const candidate = report.frozen.candidate;
	const capability = report.frozen.capability;
	const definition = report.frozen.taskDefinition;
	const tokens = (usage) => usage === void 0 ? "unknown" : Object.values(usage).reduce((sum, value) => sum + value, 0);
	const skillIdentity = candidate === void 0 ? void 0 : `${candidate.contract === void 0 ? "guidance" : "execution"} sha256 ${candidate.sha256}${candidate.contract === void 0 ? "" : ` sidecar sha256 ${candidate.contract.sha256}`}`;
	const candidateIdentity = definition !== void 0 ? `TaskTemplate ${definition.candidate.template.id}@${definition.candidate.template.version} sha256:${definition.candidate.digest}` : capability !== void 0 ? `capability row "${capability.row.name}" sha256 ${capability.row.digest} (the table held ${capability.baseline === null ? "no such row" : `row sha256 ${capability.baseline.digest}`})${skillIdentity === void 0 ? "" : ` and a new skill, ${skillIdentity}`}` : skillIdentity;
	if (candidateIdentity === void 0) throw new Error(`experiment ${result.experimentId} carries neither a skill object identity nor a capability row — a report without a candidate identity is not one this build evaluated, and its record is read back through evolution_list`);
	const baselineIdentity = definition !== void 0 ? `template baseline ${definition.baseline === null ? "absent" : `${definition.baseline.template.id}@${definition.baseline.template.version} sha256:${definition.baseline.digest}`}; fixed original parent oracle; only new children use the side library` : capability === void 0 ? `production baseline ${baseline?.sha256 ?? "absent (first Skill)"}${baseline?.contract === void 0 ? "" : ` sidecar sha256 ${baseline.contract.sha256}`}` : `row this candidate moves: ${capability.baseline === null ? "none (a new row)" : `sha256 ${capability.baseline.digest}`}`;
	return [
		`proposal ${report.proposalId} [experiment] ${definition !== void 0 ? "task_definition" : capability === void 0 ? "skill" : "capability"} ${targetId} — verdict: ${report.verdict}`,
		`samples (${report.samples.length}):`,
		...report.frozen.libraryId === void 0 ? [] : [`graph library: ${report.frozen.libraryId}; ${report.samples.some((sample) => sample.role === "holdout") ? "independent holdout included" : "graph-local observed evidence; transfer to unseen Tasks: unknown"}`],
		...report.samples.map((sample) => `  ${sample.taskId} [${sample.role}] baseline ${sample.baseline.outcome} → candidate ${sample.candidate.outcome} (${renderExperimentCriterionDiff(sample.baseline.criteria, sample.candidate.criteria)}) — ${sample.verdict}; subtree tokens ${tokens(sample.baseline.cost.status === "reported" ? sample.baseline.cost.metrics.tokens : void 0)} → ${tokens(sample.candidate.cost.status === "reported" ? sample.candidate.cost.metrics.tokens : void 0)}; toolCalls ${sample.baseline.cost.status === "reported" ? sample.baseline.cost.metrics.toolCalls?.calls ?? "unknown" : "unknown"} → ${sample.candidate.cost.status === "reported" ? sample.candidate.cost.metrics.toolCalls?.calls ?? "unknown" : "unknown"}`),
		"every side above is a new run this experiment started — the baseline under the production configuration (the production object, or the production table for a capability sample, whose frozen identity is read again at every promotion gate), the candidate on the prepared object's bytes (the prepared `SKILL.md`, the sidecar derived from production for an execution skill, and, for a capability candidate, the frozen row the candidate overlay mounts); the sample's historical record only locates the case",
		`report: ${result.reportPath}`,
		...report.evaluation === void 0 ? [] : [
			`independent judge: ${report.frozen.evaluation.judge.model.label}; input ${report.evaluation.inputDigest}; response ${report.evaluation.responseDigest}`,
			`auxiliary model tokens: plan ${report.frozen.evaluation.generatedResponse === void 0 ? "0 (provided plan)" : tokens(report.frozen.evaluation.generatedUsage)}; judge ${tokens(report.evaluation.judgeUsage)}; monetary cost unknown (no price source)`,
			...report.evaluation.judgement.samples.map((sample) => `${sample.taskId} judge ${sample.verdict}: ${sample.findings.map((finding) => `${finding.claim} [${finding.evidenceRefs.join(", ")}]`).join("; ")}; uncertainty: ${sample.uncertainties.join("; ") || "none reported"}`)
		],
		`experiment ${result.experimentId} (repetition ${report.frozen.repetition}, frozen ${report.frozenDigest}); candidate ${candidateIdentity}; ` + baselineIdentity + `; model ${report.frozen.model.label}; budget ${budget}; snapshot ${report.frozen.snapshot.digest}; comparer ${report.frozen.comparerVersion}`,
		"next: evolution_gate (cite the report path in regressionEvidenceRefs)"
	].join("\n");
}
/** Fresh one-shot context, using the same deployed llm/stream route, without executor conversation or tools. */
async function outcomeModel(ctx, model, prompt, input, signal) {
	const llm = optionalService(ctx, "llm");
	if (llm === void 0) throw new Error("llm-outcome requires the deployment llm service");
	const assembled = new BlockAssembler();
	let finished = false;
	for await (const chunk of llm.stream({
		provider: model.provider,
		model: model.model,
		...model.reasoningEffort === void 0 ? {} : { reasoningEffort: model.reasoningEffort },
		...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
		system: prompt,
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: input
			}]
		}],
		signal
	})) {
		assembled.push(chunk);
		if (chunk.type === "finish") {
			if (chunk.reason.kind !== "stop") throw new Error(`outcome model stopped with ${JSON.stringify(chunk.reason)}`);
			finished = true;
		}
	}
	const response = assembled.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
	if (!finished || !response.trim()) throw new Error("outcome model returned no complete response");
	const usage = assembled.usage;
	const tokens = usage === void 0 ? void 0 : {
		uncachedInputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
	return {
		response,
		...tokens === void 0 ? {} : { usage: tokens }
	};
}
async function evaluationPlan(ctx, input, samples, snapshot, signal, model) {
	let rubric = input.rubric;
	let measurements = input.measurements;
	let generatedResponse;
	let generatedUsage;
	if (rubric === void 0 || measurements === void 0) {
		const generatedCall = await outcomeModel(ctx, model, "Create an outcome evaluation plan from the supplied goal, original tasks and available artifacts. Return JSON {\"rubric\":\"...\",\"measurements\":[{\"id\":\"safe_name\",\"command\":\"...\"}]}. Use concise commands that inspect real outputs in each isolated workspace. Preserve supplied rubric and measurements. Each command runs with a 300 second limit and a 1 MiB output limit per stream. Keep the original acceptance fixed and explain benefit, uncertainty and model cost through the measurements.", canonicalJson({
			goal: input.goal,
			rubric,
			measurements,
			tasks: samples.map((sample) => snapshot.tasks.find((task) => task.taskId === sample.taskId))
		}), signal);
		generatedResponse = generatedCall.response;
		generatedUsage = generatedCall.usage;
		const generated = JSON.parse(generatedResponse);
		rubric ??= generated.rubric;
		measurements ??= generated.measurements;
	}
	const judge = {
		model,
		prompt: OUTCOME_JUDGE_PROMPT,
		digest: digestOf({
			model,
			prompt: OUTCOME_JUDGE_PROMPT
		})
	};
	const plan = {
		goal: input.goal,
		rubric,
		measurements,
		judge,
		...generatedResponse === void 0 ? {} : { generatedResponse },
		...generatedUsage === void 0 ? {} : { generatedUsage }
	};
	assertOutcomePlan(plan);
	return plan;
}
/** The experiment one call runs: the derived samples, the caller's frozen input, and the model selection it runs under. */
async function runExperimentFor(ctx, args, caller, signal) {
	const evolution = await evolutionForSession(ctx, caller);
	const model = evolution.modelSelection();
	let snapshot;
	try {
		const graph = await ctx.graphs.graphForSession(caller);
		snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId));
	} catch (error) {
		throw new Error(`cannot open this graph's task store: ${message(error)}`);
	}
	const proposal = await evolution.get(args.proposalId);
	const samples = deriveExperimentSamples(snapshot, args.taskIds, args.holdoutTaskIds, args.objective, proposal.targetType === "capability" ? void 0 : evolution.libraryId);
	if (args.snapshot !== void 0 && !args.snapshot.sourceDir.trim()) throw new Error("snapshot.sourceDir must name a clean input directory");
	const sourceDir = args.snapshot === void 0 ? await callerWorkspace(ctx, caller) : isAbsolute(args.snapshot.sourceDir) ? args.snapshot.sourceDir : resolve(await callerWorkspace(ctx, caller), args.snapshot.sourceDir);
	const inputSnapshot = normalizeSnapshot({
		...args.snapshot,
		sourceDir
	});
	let evaluation;
	if (args.objective === "llm-outcome") {
		if (args.evaluation === void 0) throw new Error("objective llm-outcome requires evaluation.goal");
		const previous = (await evolution.experiments(args.proposalId)).find((item) => item.frozen.objective === "llm-outcome" && item.frozen.repetition === (args.repetition ?? 0));
		if (previous !== void 0) {
			evaluation = previous.frozen.evaluation;
			if (evaluation.goal !== args.evaluation.goal || args.evaluation.rubric !== void 0 && evaluation.rubric !== args.evaluation.rubric || args.evaluation.measurements !== void 0 && canonicalJson(evaluation.measurements) !== canonicalJson(args.evaluation.measurements) || canonicalJson(evaluation.judge.model) !== canonicalJson(model)) throw new Error("evaluation plan or resolved judge changed; use a new repetition for a new experiment");
		} else evaluation = await evaluationPlan(ctx, args.evaluation, samples, snapshot, signal, model);
	} else if (args.evaluation !== void 0) throw new Error("evaluation is only valid for objective llm-outcome");
	return evolution.runExperiment({
		proposalId: args.proposalId,
		samples,
		...evaluation === void 0 ? {} : { evaluation },
		...args.objective === void 0 ? {} : { objective: args.objective },
		snapshot: inputSnapshot,
		model,
		budget: { ...args.budget ?? {} },
		repetition: args.repetition ?? 0
	}, caller, caller, {
		signal,
		...args.maxParallel === void 0 ? {} : { maxParallel: args.maxParallel },
		judge: (model$1, prompt, input, abort) => outcomeModel(ctx, model$1, prompt, input, abort)
	});
}
function defineEvolutionReplayTool(ctx) {
	return defineTool({
		name: "evolution_replay",
		description: "Compare a prepared Task template, Skill or capability candidate with its frozen baseline. Both sides execute through the same runtime and original acceptance in parallel, separate copies of snapshot.sourceDir (or the caller workspace when omitted). Supply clean original inputs; snapshot.paths selects only the files or directories needed for comparison. Use cwd-relative contracts, or snapshot.rebaseFrom to relocate declared absolute workspace paths into each side while retaining the original checks. Task replay freezes the complete template library for each side; new children must use the candidate template while the parent oracle stays fixed. Capability replay mounts the candidate row, MCP definitions and optional Skill; a baseline admission refusal is recorded as that refusal. Samples, inputs, model, budget and comparer are frozen. Omit objective for observed failure repair. For a verified source use llm-outcome with evaluation.goal for generic domain benefit, or tool-call-reduction for fewer calls. llm-outcome freezes the supplied or LLM-generated rubric and measurement commands before replay; commands execute in each side workspace, then one independent LLM request judges actual outputs. The deployed resolved model and judge prompt are fixed, and gate/apply recheck saved evidence without resampling. The candidate may already be prepared before plan freeze. For tool-call-reduction both sides pass, every observed sample uses fewer tool calls over its complete executed Run subtree, and holdouts pass without cost growth. Missing counters are inconclusive. Graph-local experience can use the observed Task; add independent holdoutTaskIds when available to measure transfer. Shared publication and capability changes require a holdout. Cite the sandbox report in evolution_gate.regressionEvidenceRefs. The same call reuses settled Runs; a higher repetition freezes a new experiment.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Prepared Task template, Skill or capability candidate"
			},
			snapshot: {
				type: "object",
				additionalProperties: false,
				properties: {
					sourceDir: {
						type: "string",
						required: true,
						description: "Clean input directory copied separately to every side; absolute or relative to caller workspace. Omit snapshot to use the caller workspace."
					},
					paths: {
						type: "array",
						items: { type: "string" },
						description: "Relative files or directories needed for comparison, such as fixture, checks and a small workload. Omit to freeze all content. The selection and its digest are frozen."
					},
					rebaseFrom: {
						type: "string",
						description: "Original absolute workspace root in the Task contract. Its declared paths are mapped into each independent side. Input file contents stay fixed; scripts and binaries use their own relative paths."
					}
				}
			},
			maxParallel: {
				type: "integer",
				description: "Concurrent experiment sides. Defaults to deployment maxActiveWorkers (normally at least 2); runtime worker limits still apply."
			},
			objective: {
				type: "string",
				enum: ["tool-call-reduction", "llm-outcome"],
				description: "Verified-source optimization: measured domain benefit with an independent judge, or fewer subtree tool calls. Original acceptance remains mandatory. Omit for failure repair."
			},
			evaluation: {
				type: "object",
				additionalProperties: false,
				properties: {
					goal: {
						type: "string",
						required: true,
						description: "Original user outcome to improve; domain measurements must come from real tools."
					},
					rubric: {
						type: "string",
						description: "Frozen comparison rules; omit to generate with the deployed LLM."
					},
					measurements: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: {
									type: "string",
									required: true
								},
								command: {
									type: "string",
									required: true
								}
							}
						},
						description: "Same shell commands in each side workspace, 300s/1 MiB per stream; omit to generate. Excess output errors explicitly."
					}
				},
				description: "Required for llm-outcome. Plan and judge are frozen before replay, then real command outputs are judged once."
			},
			taskIds: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Observed task ids: a failed target plus verified regressions for failure repair; verified sources for either success objective"
			},
			holdoutTaskIds: {
				type: "array",
				items: { type: "string" },
				description: "Independent verified Tasks for transfer evidence. Optional for graph-local Skill/Task experience; shared publication and capability changes require at least one."
			},
			repetition: {
				type: "integer",
				description: "Repeat index of the frozen experiment (default 0). Only a new experiment at a higher index may run a sample again and charge budget again."
			},
			budget: {
				type: "object",
				additionalProperties: false,
				properties: {
					maxTokens: {
						type: "integer",
						description: "Token ceiling for the whole experiment. No further side is started once the sides already settled have reported this many tokens (the ledger is the count, so a restart does not reset it)"
					},
					note: {
						type: "string",
						description: "What the budget was derived from and why it is judged enough"
					}
				},
				description: "The total token budget frozen with the experiment, including business Run subtrees and llm-outcome plan/judge calls. maxTokens is optional; omit it when this deployment does not report token counts for business Runs. If you declare it, promotion requires a measured token total for every executed side; tool-call counts and model guesses cannot satisfy that check. A declared total also stops further sides once reported usage reaches it. Runs retain the deployment's own runtime limits."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_replay");
			const taskIds = args.taskIds.map((id) => String(id));
			const holdoutTaskIds = (args.holdoutTaskIds ?? []).map((id) => String(id));
			try {
				const proposal = await (await evolutionForSession(ctx, caller)).get(args.proposalId);
				if (proposal.targetType !== "skill" && proposal.targetType !== "capability" && proposal.targetType !== "task_definition") throw new Error(`proposal ${proposal.proposalId} targets "${proposal.targetType}" — this tool evaluates a prepared Task template, Skill or capability candidate; this target has no evaluator, so its proposal stays a record`);
				return renderExperiment(await runExperimentFor(ctx, {
					proposalId: args.proposalId,
					taskIds,
					holdoutTaskIds,
					...args.objective === void 0 ? {} : { objective: args.objective },
					...args.evaluation === void 0 ? {} : { evaluation: args.evaluation },
					...args.repetition === void 0 ? {} : { repetition: args.repetition },
					...args.budget === void 0 ? {} : { budget: args.budget },
					...args.snapshot === void 0 ? {} : { snapshot: args.snapshot },
					...args.maxParallel === void 0 ? {} : { maxParallel: args.maxParallel }
				}, caller, exec.signal), proposal.targetId);
			} catch (error) {
				return `evolution_replay rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-rollback.ts
/** What a restored object means for production, stated honestly in the output: */
function restoreNote(targetType) {
	if (targetType === "task_definition") return "new task instances use the restored library state; existing Task contracts and Run bindings stay fixed";
	if (targetType === "capability") return "the capability row and MCP definitions were restored or removed to their prepared baseline, and any new Skill was removed; new admissions read that state while runs already bound to the applied snapshot keep their snapshot";
	return "the restored object is what the skill filesystem now serves and what the next admission loads, and the skill directory is admitted again now that its commit intent is closed; a run already bound to the applied version keeps loading the snapshot it was bound to";
}
function defineEvolutionRollbackTool(ctx) {
	return defineTool({
		name: "evolution_rollback",
		description: "Roll back an applied Task template, Skill or capability proposal after human approval. Restore its frozen baseline through the existing durable commit. Template updates append the old content at the next version; a first publication is removed. Capability rollback restores the row and removes new MCP definitions and any new Skill. Existing Task contracts and Run bindings stay fixed. Retry settles an open intent without asking again.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Applied proposal to roll back"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "evolution_rollback");
			const evolution = await evolutionForSession(ctx, caller);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_rollback: missing agent");
			let proposal;
			try {
				proposal = await evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_rollback rejected: ${message(error)}`;
			}
			if (proposal.openIntent !== void 0) try {
				const recovered = await evolution.rollback(args.proposalId, caller, proposal.openIntent.approvalRef);
				return [
					`proposal ${recovered.proposal.proposalId} [rolledback] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — ${recovered.proposal.targetType === "capability" ? "production baseline restored" : "champion restored"}`,
					...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
					"wrote production targets:",
					...recovered.proposal.targetType === "capability" ? [`  - capability row ${recovered.proposal.targetId} restored in the production table`] : [],
					...recovered.targets.map((target) => `  - ${target}`),
					restoreNote(recovered.proposal.targetType)
				].join("\n");
			} catch (error) {
				return `evolution_rollback rejected: ${message(error)}`;
			}
			if (proposal.status !== "applied") return `evolution_rollback rejected: proposal ${proposal.proposalId} is ${proposal.status}; only an applied proposal can be rolled back`;
			const targets = applyTargets(proposal, evolution, "rollback");
			if (targets.length === 0 && proposal.targetType !== "capability") return `evolution_rollback rejected: proposal ${proposal.proposalId} targets "${proposal.targetType}" — this build restores a Task template, Skill or capability candidate, so there is no executor for this target type`;
			const reason = [
				`Evolution rollback for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				`applied mutation: ${JSON.stringify(proposal.mutation)}`,
				...proposal.prepared?.capabilityTable === void 0 ? [] : [`deployment config baseline sha256:${proposal.prepared.capabilityTable.baselineSha256}; apply sha256:${proposal.prepared.capabilityTable.applySha256}; rollback sha256:${proposal.prepared.capabilityTable.rollbackSha256}`],
				`applied at: ${[...proposal.targetType === "capability" ? [`capability row ${proposal.targetId}`] : [], ...proposal.applied.targets].join(", ")} (approval ${proposal.applied.approvalRef})`,
				proposal.targetType === "capability" ? "this restores the capability row baseline and removes new MCP definitions and any new Skill from production targets:" : proposal.targetType === "task_definition" ? "this restores the template library state; prior contracts stay fixed:" : "this restores the champion snapshot over production targets:",
				...proposal.targetType === "capability" ? [`  - capability row ${proposal.targetId} in the production table`] : [],
				...targets.map((target) => `  - ${target}`)
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_rollback",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_rollback: nothing written — ${denialReason(outcome)}; proposal ${proposal.proposalId} stays applied`;
			try {
				const rolledback = await evolution.rollback(args.proposalId, caller, `approval:${exec.callId}`);
				return [
					`proposal ${rolledback.proposal.proposalId} [rolledback] ${rolledback.proposal.level} ${rolledback.proposal.targetType} ${rolledback.proposal.targetId} — ${rolledback.proposal.targetType === "capability" ? "production baseline restored" : "champion restored"}`,
					"wrote production targets:",
					...rolledback.proposal.targetType === "capability" ? [`  - capability row ${rolledback.proposal.targetId} restored in the production table`] : [],
					...rolledback.targets.map((target) => `  - ${target}`),
					restoreNote(rolledback.proposal.targetType),
					`human approval: approval:${exec.callId}`
				].join("\n");
			} catch (error) {
				return `evolution_rollback rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/mark-ready.ts
function defineMarkReadyTool(ctx) {
	return defineTool({
		name: "graph_mark_ready",
		description: "Mark the current Singularity graph ready after environment setup is complete. Required before free-form human chat.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (_args, exec) => {
			const caller = sessionId(exec, "graph_mark_ready");
			const graph = await ctx.graphs.graphForSession(caller);
			if (String(graph.rootSessionId) !== String(caller)) throw new Error(`graph_mark_ready: only graph ${graph.id}'s root may finish setup`);
			await ctx.graphs.markReady(graph.id);
			return `graph ${graph.id} ready`;
		}
	});
}

//#endregion
//#region src/tools/spawn.ts
/** Setup is a root-owned environment operation, with no business delegation or publication tools. */
const SETUP_TOOLS = [
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"bash",
	"job_output",
	"job_list",
	"job_kill",
	"skill",
	"env_list",
	"env_ensure_component",
	"env_register_component",
	"env_set_component_status",
	"env_mark_clean"
];
function defineSpawnTool(ctx) {
	return defineTool({
		name: "graph_spawn",
		description: "Delegate environment setup only, before the graph is ready, to a new Singularity worker and wait for its final response. Use task_decompose for objective work after setup.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Short worker name shown on the graph"
			},
			task: {
				type: "string",
				required: true,
				description: "Complete task for the worker"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => text(value)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "graph_spawn");
			const graph = await ctx.graphs.graphForSession(caller);
			if (String(graph.rootSessionId) !== String(caller)) throw new Error(`graph_spawn: only graph ${graph.id}'s root may delegate setup`);
			if (graph.ready) throw new Error(`graph_spawn: graph ${graph.id} is ready; delegate objective work with task_decompose`);
			const pinned = graphAgentOptions(graph);
			const handle = await ctx.agentRuntime.spawn(exec.agent, {
				sessionId: SessionId(randomUUID()),
				name: args.name,
				prompt: [{
					type: "text",
					text: "Prepare the environment only. Do not delegate agents, accept business tasks, or publish methods. " + args.task
				}],
				grant: {
					capabilities: [],
					baseline: SETUP_TOOLS,
					keepPresetTools: false
				},
				permissionPreset: "danger-full-access",
				signal: exec.signal,
				...pinned === void 0 ? {} : { agentOptions: pinned }
			});
			const cancel = () => handle.agent.cancel({ kind: "parent" });
			exec.signal.addEventListener("abort", cancel, { once: true });
			try {
				await handle.agent.whenIdle();
				exec.signal.throwIfAborted();
			} finally {
				exec.signal.removeEventListener("abort", cancel);
			}
			const event = [...handle.agent.session.snapshotEvents()].reverse().find((item) => item.type === "assistant/message");
			if (event === void 0) throw new Error(`graph_spawn: worker ${handle.agent.id} produced no response`);
			const result = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			if (result.length === 0) throw new Error(`graph_spawn: worker ${handle.agent.id} produced no text response`);
			return `Worker ${handle.agent.id} completed:\n${result}`;
		}
	});
}

//#endregion
//#region src/tools/task-answer.ts
/** Every parameter this tool declares; anything else is refused by name, before the store is touched. */
const DECLARED$1 = [
	"questionId",
	"requestKey",
	"answer",
	"resolves"
];
/** How one delivery settled, in the answering model's words — `unavailable` is a retry, never a re-send under a new key. */
function deliveryText$1(delivery) {
	switch (delivery.status) {
		case "delivered": return `message ${delivery.messageId} is in the asking run's session`;
		case "already-present": return `message ${delivery.messageId} was already in the asking run's session, so nothing was sent twice`;
		case "unavailable": return `message ${delivery.messageId} is not delivered yet: the asking run's session is not live in this process. Your answer is on the record and recovery delivers that same identity — do not answer the same question again under a new request key`;
		case "refused": return `message ${delivery.messageId} could not be delivered (${delivery.reason ?? "the attempt could not be settled"}). Your answer is on the record; delivery is retried from there`;
	}
}
/** One answer as its reply: what was recorded, how it was delivered, and what it did to the asking run. */
function answeredText(outcome) {
	const answer = outcome.answer;
	const lines = [`task_answer: answer ${answer.answerId} recorded for question ${answer.questionId}; ${deliveryText$1(outcome.delivery)}.`];
	if (!outcome.created) lines.push("This is the answer the same request key already recorded: nothing was written a second time and the same identity stands.");
	lines.push(answer.resolves ? "`resolves: true` releases exactly that question: the asking run's block is recomputed from the store, so another question of its own keeps it blocked. It changes no contract, no permission and no task state, and the framework does not vouch for what the answer says." : "`resolves: false` keeps the question open: the asking run stays blocked on it and your words are recorded as an answer that settled nothing. Answer it again with `resolves: true` once it is settled.");
	lines.push("Your words reach the asking run as a message in its session and in its context, under the identity recorded here.");
	return lines.join("\n");
}
function defineTaskAnswerTool(ctx) {
	return defineTool({
		name: "task_answer",
		description: "Answer one question a child run asked you. `questionId` is the identity on the question you were told about (in your context under the pending questions, or in the message that reached you) — you cannot address an answer anywhere else, and an answer to a question that was not asked of your run is refused. `resolves: true` declares the question settled and releases exactly that block on the asking run; `resolves: false` keeps it open and records words that settle nothing. Neither changes the asking run's contract, permissions or task state, and neither is a judgement of the answer's correctness — say what you decided and what it rests on, because the child acts on your words. `requestKey` is your own stable key for this answer: answer a question you have already answered by repeating the same key instead of inventing one, and it comes back as the answer already recorded.",
		parameters: {
			questionId: {
				type: "string",
				required: true,
				description: "The question being answered, exactly as the question or the record names it (`q-…`); it must be the question this call's own arguments name, and it must be a question addressed to your run"
			},
			requestKey: {
				type: "string",
				required: true,
				description: "Your own stable key for this answer, e.g. \"contract-holds\". The recorded answer id derives from it; several keys may answer one open question, and a repeat of the same key is the answer already on the record"
			},
			answer: {
				type: "string",
				required: true,
				description: "What you are telling the child, in your own words. This text is the body the store cites, read back from this call itself — the child reads exactly these words"
			},
			resolves: {
				type: "boolean",
				required: true,
				description: "Your declaration: `true` settles this question and releases the asking run's block on it; `false` keeps it open. Required — there is no default, because silence about whether the question is settled is not an answer"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const refused = undeclaredParameters(args, DECLARED$1, "task_answer", "and has no argument that names a recipient, an authorization or a category: the answer goes to the run that asked the question you name", "Nothing was answered and nothing was sent.");
			if (refused !== void 0) return refused;
			const { caller, callId } = questionCall(exec, "task_answer");
			let outcome;
			try {
				outcome = await ctx.taskRuntime.answerParentQuestion(caller, {
					callId,
					questionId: args.questionId,
					requestKey: args.requestKey,
					resolves: args.resolves
				});
			} catch (error) {
				return `task_answer rejected: ${message(error)}`;
			}
			return answeredText(outcome);
		}
	});
}

//#endregion
//#region src/tools/task-ask-parent.ts
/** Every parameter this tool declares; anything else is refused by name, before the store is touched. */
const DECLARED = [
	"requestKey",
	"question",
	"blocking"
];
/** How one delivery settled, in the caller's words. `unavailable` is not a failure and is not reported as one: */
function deliveryText(delivery) {
	switch (delivery.status) {
		case "delivered": return `message ${delivery.messageId} is in your parent's session`;
		case "already-present": return `message ${delivery.messageId} was already in your parent's session, so nothing was sent twice`;
		case "unavailable": return `message ${delivery.messageId} is not delivered yet: your parent's session is not live in this process. The question is on the record and recovery delivers that same identity when the parent is back — do not ask the same question again under a new request key`;
		case "refused": return `message ${delivery.messageId} could not be delivered (${delivery.reason ?? "the attempt could not be settled"}). The question is on the record; delivery is retried from there, and a new request key would only add a second question`;
	}
}
/** One ask as its answer: what was recorded, how it was delivered, and what the asking run may do now. */
function askedText(outcome) {
	const question = outcome.question;
	const lines = [`task_ask_parent: question ${question.questionId} recorded for your direct parent (run ${question.parentRunId}); ${deliveryText(outcome.delivery)}.`];
	if (!outcome.created) lines.push("This is the question the same request key already recorded, word for word: nothing was written a second time and the same identity stands. Do not re-send it under a new key.");
	if (question.blocking) {
		lines.push("This run is now blocked on that answer: writes, shell commands, another decomposition and `task_submit_result` are refused until an answer with `resolves: true` is recorded — a child batch of this run ending does not lift the block, because nothing answers a question on your behalf. Stop the work that would write and end this step — an idle run waiting on this question gets no submission reminder.");
		lines.push("The answer arrives as a message in this session and in your context, where the question stays while it is open; read it before you continue, and keep to what it says.");
	} else lines.push("This run is not blocked: it may carry on working while the answer is pending, so it may pass you later in this session or in your context — do not treat the silence as an answer.");
	return lines.join("\n");
}
function defineTaskAskParentTool(ctx) {
	return defineTool({
		name: "task_ask_parent",
		description: "Ask your direct parent one question and stop guessing. The addressee is fixed by your own run — its task's direct parent — and you cannot name one: there is no recipient parameter, and a call carrying an undeclared one is refused. By default the question blocks this run (`blocking` defaults to `true`): writes, shell commands, another decomposition and `task_submit_result` are refused until the parent answers with `resolves: true` — a batch of yours ending does not lift that block, because nothing answers a question on your behalf — and the answer then reaches you as a message and in your context. Pass `blocking: false` for a question you can work without. Ask when the contract, the scope or the acceptance is genuinely undecidable from what you were given — not for facts `task_read`/`task_status`/`context_read` already answer, and not to hand back work you could decide yourself. `requestKey` is your stable key for this question: resend the identical question under the same key after a failure instead of inventing a new one, and it comes back as the question already recorded.",
		parameters: {
			requestKey: {
				type: "string",
				required: true,
				description: "Your own stable key for this question, e.g. \"which-contract-holds\". The recorded question id derives from it, and a resend under the same key with the same words is answered as the question already on the record"
			},
			question: {
				type: "string",
				required: true,
				description: "The question, in your own words. This text is the body the store cites and the parent reads — it is read back from this call itself, so what you write here is what is recorded"
			},
			blocking: {
				type: "boolean",
				description: "Whether this run waits for the answer: true (the default) closes writes, shell commands, another decomposition and submission until an answer resolves it, and a batch of yours ending does not resolve it; false leaves this run deciding its own work while the answer is pending"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const refused = undeclaredParameters(args, DECLARED, "task_ask_parent", "and has no argument that names a recipient, a parent or an authorization: the question goes to your own task's direct parent, resolved from your run", "Nothing was asked and nothing was sent.");
			if (refused !== void 0) return refused;
			const { caller, callId } = questionCall(exec, "task_ask_parent");
			let outcome;
			try {
				outcome = await ctx.taskRuntime.askParentQuestion(caller, {
					callId,
					requestKey: args.requestKey,
					...args.blocking === void 0 ? {} : { blocking: args.blocking }
				});
			} catch (error) {
				return `task_ask_parent rejected: ${message(error)}`;
			}
			return askedText(outcome);
		}
	});
}

//#endregion
//#region src/tools/task-cancel.ts
function renderOutcome$1(outcome) {
	const run = outcome.runId === void 0 ? "" : ` run ${outcome.runId}`;
	const evidence = outcome.evidenceId === void 0 ? "" : ` evidence ${outcome.evidenceId}`;
	return `- ${outcome.taskId}: ${outcome.status}${run}${evidence}`;
}
function defineTaskCancelTool(ctx) {
	return defineTool({
		name: "task_cancel",
		description: "Cancel your current run together with its in-flight child batch. The children still in flight are cancelled, the ones that never started are blocked before start, and this run is cancelled with them — a batch that cannot finish is ended here, never left hanging. Only the run whose own batch it is may cancel it, and only while the batch is in flight: a run that already got its execution back holds no batch to cancel, and a run with no batch open is told so and nothing changes. To end work that is not a batch of yours, remove the graph instead.",
		parameters: { reason: {
			type: "string",
			description: "Why the batch is being cancelled; the settlement answer echoes it back to you"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "task_cancel");
			const { storeId, run } = await ctx.taskRuntime.runForSession(caller);
			if (run.executionPhase !== "waiting_children" || run.batchId === void 0) return `task_cancel: no batch is in flight for run "${run.runId}" (${run.status}${run.executionPhase === void 0 ? ", no coordination phase recorded" : `, phase ${run.executionPhase}`}); nothing was changed`;
			const batchId = run.batchId;
			let outcomes;
			try {
				outcomes = await ctx.taskRuntime.cancelBatch(storeId, batchId, caller);
			} catch (error) {
				return `task_cancel rejected: ${message(error)}`;
			}
			return [`cancelled batch ${batchId}${args.reason === void 0 ? "" : ` (${args.reason})`}:`, ...outcomes.map(renderOutcome$1)].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-template-list.ts
/** The same creation input is accepted by root intake and each direct child. */
const templateBindingParameters = {
	templateScope: {
		type: "array",
		items: {
			type: "array",
			items: { type: "string" }
		},
		description: "Catalog prefixes for this task. The root selects relevant branches from the user goal; a child may inherit by omitting this field or narrow its parent scope. [] permits only explicit general templates. This grants no tools or capabilities."
	},
	templateRef: {
		type: "object",
		additionalProperties: false,
		description: "Exact reference from task_template_list. Use with templateParameters instead of objective/acceptanceCriteria or other contract fields; the runtime binds the full immutable template contract.",
		properties: {
			id: {
				type: "string",
				required: true
			},
			version: {
				type: "integer",
				required: true
			},
			digest: {
				type: "string",
				required: true
			}
		}
	},
	templateParameters: {
		type: "object",
		additionalProperties: true,
		description: "Named primitive parameter values satisfying the selected template parametersSchema. {{name}} binds contract strings verbatim; inspect the resulting command and use values appropriate to its syntax."
	}
};
function defineTaskTemplateListTool(ctx) {
	return defineTool({
		name: "task_template_list",
		description: "Browse the caller-visible reusable TaskTemplate catalog and finite summary pages before authoring a Task. A TaskTemplate defines a parameterized goal, inputs, result acceptance, capabilities and optional direct-child recipe; a Skill teaches the execution method. Select catalogPath from the user goal before root intake; worker queries stay within their task branches plus general. Delegated reviewers and supervisors use their associated task scope without needing a business Run. Read an exact templateRef for the complete contract and parameter schema, and check appliesTo before binding. If none fits, write a complete one-off contract and proceed; no template publication is required or performed by discovery or admission. After execution, reusable findings can support a supervisor-evaluated task_definition candidate.",
		parameters: {
			query: {
				type: "string",
				description: "Optional discovery keywords within the visible scope; appliesTo decides applicability."
			},
			catalogPath: {
				type: "array",
				items: { type: "string" },
				description: "Catalog branch to browse; cannot widen the caller-visible scope."
			},
			templateRef: templateBindingParameters.templateRef,
			offset: {
				type: "integer",
				description: "Page offset; use nextOffset from the previous response."
			},
			limit: {
				type: "integer",
				description: "Page size from 1 to 20; default 10."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => text(value)
		},
		execute: async (args, exec) => {
			try {
				return JSON.stringify(await ctx.taskRuntime.listTaskTemplates(args, sessionId(exec, "task_template_list")), null, 2);
			} catch (error) {
				return `task_template_list failed: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/criteria-schema.ts
/** One closed criterion object; the two members both tools word identically live here. */
function criterionSchema(wording) {
	const head = {
		description: {
			type: "string",
			required: true,
			description: wording.description
		},
		criterionId: {
			type: "string",
			description: wording.criterionId
		},
		command: {
			type: "string",
			description: wording.command
		},
		mode: {
			type: "string",
			enum: [
				"deterministic",
				"simulation",
				"formal",
				"measurement",
				"review"
			],
			description: wording.mode
		},
		mandatory: {
			type: "boolean",
			description: "Whether the criterion must pass; default true"
		},
		requiredEvidence: {
			type: "array",
			items: { type: "string" },
			description: "Evidence kinds the verifier must attach"
		},
		requiresArtifact: {
			type: "array",
			items: { type: "string" },
			description: wording.requiresArtifact
		},
		acceptsArtifact: {
			type: "array",
			items: { type: "string" },
			description: wording.acceptsArtifact
		},
		verifierRef: {
			type: "string",
			description: wording.verifierRef + " Executable modes default to the command verifier."
		}
	};
	const tail = {
		heuristic: {
			type: "boolean",
			description: wording.heuristic
		},
		protectedInputs: {
			type: "array",
			items: { type: "string" },
			description: wording.protectedInputs
		}
	};
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			...head,
			...tail
		}
	};
}

//#endregion
//#region src/tools/proposal-shared.ts
/** The three parameters both proposing tools declare, worded for the tool handing them in. */
function proposalSubmissionParameters(wording) {
	return {
		contractVersion: {
			type: "integer",
			description: `Contract version this ${wording.versionSubject} is written under. The runtime stores version 1 and refuses a declared version it does not know, so callers normally omit this field and let the runtime write the current version`
		},
		requestKey: {
			type: "string",
			description: `The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime derives one from ${wording.derivation} when this is omitted). One key names at most one proposal: repeating a request with the same key is answered with the proposal already stored, while the same key with different content is refused. A revision is different content, so it needs a new key`
		},
		supersedes: {
			type: "string",
			description: `The proposal id this ${wording.revisionSubject} revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the new request key this submission needs`
		}
	};
}
/** The answer a proposing tool gives while its subject waits for review: the policy read back off the record, and the caller's next move. */
async function pendingReviewText(input) {
	let policy = "unknown — the proposal record could not be read back";
	try {
		policy = `${(await input.ctx.taskRuntime.proposalIn(input.storeId, input.proposalId)).policy}`;
	} catch {}
	return [
		`${input.tool} is waiting for a review: proposal ${input.proposalId} (policy ${policy}) holds ${input.holding}.`,
		`- ${input.detail}`,
		...input.lines
	].join("\n");
}

//#endregion
//#region src/tools/task-decompose.ts
function defineTaskDecomposeTool(ctx) {
	return defineTool({
		name: "task_decompose",
		description: "Delegate the caller's current task's independently checkable results or distinct responsibilities to child tasks. Consult capability_list and task_template_list first; inspect applicability and the full contract, then use a suitable pinned template and parameters, or write a complete one-off contract when none applies. No shared template needs to be created or published for admission. A template carrying decomposition can supply this batch: pass its exact templateRef and templateParameters at the top level, omitting reason and children. The runtime expands its direct children and dependsOn through the same admission path. Each caller owns its full result and may coordinate children that decompose again; define only this level and let each child decide its descendants. The batch is admitted atomically and the runtime then runs them concurrently up to the configured worker limit, respecting real dependsOn edges; this call returns at admission and does not wait. Each child is verified against its own delivered result; this does not require a new checker or duplicate criteria. Only verified children count as done. Where this deployment reviews generated tasks, the batch may instead come back waiting for a human review — nothing is admitted or spawned then, and the answer names the proposal that holds it. Draft review does not replace result verification. Preserve reusable findings from executed contracts and batches in the result for supervisor comparison and later task_definition publication when justified.",
		parameters: {
			templateRef: templateBindingParameters.templateRef,
			templateParameters: templateBindingParameters.templateParameters,
			reason: {
				type: "string",
				description: "Required for a free batch; omit when binding a decomposition template. Why this delegation is needed; recorded in each child handoff"
			},
			...proposalSubmissionParameters({
				versionSubject: "batch",
				revisionSubject: "batch",
				derivation: "the calling context and the batch content"
			}),
			children: {
				type: "array",
				description: "Required for a free batch; omit when binding a decomposition template. Child tasks to admit and run",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						...templateBindingParameters,
						objective: {
							type: "string",
							description: "Complete, self-contained goal of the child task"
						},
						acceptanceCriteria: {
							type: "array",
							description: "Required for a free contract; omit when using templateRef. Prefer a few commands that check this Task's actual result through its explicit case directory or delivery manifest.",
							items: criterionSchema({
								description: "What must hold true",
								criterionId: "Stable id for this criterion, unique inside the child. Omitted, the runtime generates one.",
								command: "Shell command, executed from this Run's workspace root. Exit code 0 proves the criterion. Use explicit paths to this Task's case or delivery manifest and an existing authoritative checker. Do not glob sibling outputs or print success after a failed checker.",
								mode: "Verifier kind; defaults to deterministic with a command. Mandatory review/formal criteria require an explicit registered verifier that can settle them; the built-in review placeholder is refused.",
								requiresArtifact: "Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product (a verified run carrying a passing verdict) for this criterion to be judgeable; a missing one blocks the child before spawn and registers an obligation",
								acceptsArtifact: "Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state. Missing blocks the child before spawn and registers an obligation",
								verifierRef: "Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole batch at admission and the error lists the registered ids. Omit to dispatch by mode.",
								heuristic: "Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass.",
								protectedInputs: "Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. Declare them as paths relative to the task's checkout (an absolute path stays absolute). Admission resolves each one against the session's checkout and fixes the SHA-256 of its bytes before the contract is written — a path that cannot be read refuses the whole batch, and no protected input is ever stored as a bare path. The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed. Only declared paths are protected: a criterion that lists none is not protected and nothing is checked or claimed for it."
							})
						},
						requiredCapabilities: {
							type: "array",
							items: { type: "string" },
							description: "Capability names the child needs; call capability_list first to see the names the runtime can grant — an unlisted name is a capability gap that rejects the whole batch unless the child is declared decomposable"
						},
						dependsOn: {
							type: "array",
							items: { type: "integer" },
							description: "Indices of sibling children that must verify before this one starts"
						},
						assumptions: {
							type: "array",
							items: { type: "string" },
							description: "External conditions this child's contract rests on; merged with dependency-evidence references into the worker handoff"
						},
						constraints: {
							type: "array",
							items: { type: "string" },
							description: "Execution scope and limits this child runs under; persisted in the child's contract and handed to its worker"
						},
						decomposable: {
							type: "boolean",
							description: "Mark true when the child owns multiple independently checkable results or distinct responsibilities. Its worker coordinates those results and decides its own decomposition before implementation; do not prewrite descendants or reduce its full acceptance. A genuinely local result can be completed directly. A capability gap also uses this marker for admission, but it grants no missing capability."
						}
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "task_decompose");
			const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller);
			const { requestKey, supersedes,...spec } = args;
			const callId = typeof exec.callId === "string" && exec.callId.length > 0 ? String(exec.callId) : void 0;
			let submission;
			let continued;
			try {
				submission = await ctx.taskRuntime.submitDecompositionProposal(storeId, task.taskId, run.runId, caller, spec, {
					...requestKey === void 0 ? {} : { requestKey: String(requestKey) },
					...supersedes === void 0 ? {} : { supersedes: String(supersedes) },
					exec: {
						signal: exec.signal,
						...callId === void 0 ? {} : { callId }
					}
				});
				continued = await ctx.taskRuntime.continueProposal(storeId, submission.proposalId, caller, { ...callId === void 0 ? {} : { exec: { callId } } });
			} catch (error) {
				return `task_decompose rejected: ${message(error)}`;
			}
			if (continued.status === "admitted") return admittedText(task.taskId, continued.batchId, continued.childTaskIds);
			if (continued.status === "pending_review") return await pendingReviewText({
				ctx,
				storeId,
				proposalId: continued.proposalId,
				detail: continued.detail,
				tool: "task_decompose",
				holding: `this batch, and ${task.taskId} has not been decomposed`,
				lines: [
					"- No child task exists, no worker was spawned, and this task is not decomposed: the batch is admitted only after the review",
					"  decides and the runtime re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.",
					`- Read the batch as it was recorded with \`task_proposal_read\` (${continued.proposalId}).`,
					"- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime continues the batch",
					"  immediately, so you are notified when it settles.",
					"- A refusal is a fact on the record: revise the batch against its reason (fix the cause, never weaken a criterion or drop a",
					"  mandatory one) and call `task_decompose` again — a revision is new content, hence a new proposal, and you may name the",
					"  refused one with `supersedes`.",
					"- Do not re-submit the same content while it waits: the same request key is answered with this same proposal."
				]
			});
			if (continued.status === "activated") return [
				`task_decompose: proposal ${continued.proposalId} activated root task ${continued.taskId} with run ${continued.runId} instead of admitting a batch.`,
				`- ${continued.detail}`,
				"- This is a root contract, not a decomposition: no child task exists and this task is not decomposed. Read the root",
				"  contract with `task_read` and decompose it with `task_decompose` once it is the root task you are working on."
			].join("\n");
			return [
				`task_decompose rejected: decomposition of "${task.taskId}" is ${continued.status} (proposal ${continued.proposalId}): ${continued.detail}${continued.reason === void 0 ? "" : ` — ${continued.reason}`}`,
				"A rejected, cancelled, stale or expired batch never runs: revise it (a revision is new content, a new request key and a",
				"new proposal) or do the work in this task instead. Nothing was admitted and nothing was spawned."
			].join("\n");
		}
	});
}
/** The batch is admitted, not finished (A3 §3.1): the call returns as soon as the atomic commit landed, and the runtime drives the children from there. */
function admittedText(taskId, batchId, childTaskIds) {
	return [
		`decomposed ${taskId} into ${childTaskIds.length} children (batch ${batchId}):`,
		...childTaskIds.map((childTaskId, index) => `- child ${index + 1}: ${childTaskId}`),
		"",
		`The runtime owns batch ${batchId} now: it starts the children one at a time in dependency order and drives the batch to its end. This call returns at admission and does not wait for the batch.`,
		"You are in phase waiting_children: read and query with `task_read`/`task_status` (and diagnose or inspect), or end the run together with its batch with `task_cancel` if abandoning this run. Writes, shell commands, another decomposition and a submission of your own are refused while the children run — do not start work that would collide with theirs in the shared checkout.",
		"After handling any pending child question, end this turn and let the batch-end message resume you; repeated polling does not advance child execution.\nThe batch end reaches you as a message naming each child's terminal state and evidence, and it hands your execution back: nothing is submitted on your behalf. Back in phase active you continue your own work, admit another batch with `task_decompose`, or hand this task in yourself with `task_submit_result` — only that submission starts its acceptance."
	].join("\n");
}

//#endregion
//#region src/tools/task-diagnose.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** A non-empty name: what a target type has to be, with no vocabulary to be in. */
function isTargetTypeName(value) {
	return typeof value === "string" && value.trim().length > 0;
}
/** Validate the model-supplied proposals into the recorded shape. The target type is an **open, non-empty name** (A5): the diagnosis does not own a vocabulary, so a suggestion that names a surface no executor exists for is */
function toProposals(value) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("task_diagnose: proposals must be an array");
	return value.map((item, index) => {
		if (!isRecord(item)) throw new Error(`task_diagnose: proposals[${index}] must be an object`);
		if (!isTargetTypeName(item.targetType)) throw new Error(`task_diagnose: proposals[${index}].targetType must be a non-empty string, got "${String(item.targetType)}"`);
		if (typeof item.targetId !== "string") throw new Error(`task_diagnose: proposals[${index}].targetId must be a string`);
		if (typeof item.rationale !== "string") throw new Error(`task_diagnose: proposals[${index}].rationale must be a string`);
		return {
			targetType: item.targetType,
			targetId: item.targetId,
			rationale: item.rationale
		};
	});
}
function defineTaskDiagnoseTool(ctx) {
	return defineTool({
		name: "task_diagnose",
		description: "Record a diagnosis for a task: an explanation of what its reviews show (the postmortem observation, scope, localized cause, confidence), not a score. A diagnosis may conclude that something should improve, that nothing should, or that the evidence does not settle it — the conclusion is recorded as written. Call task_review_pack first and ground every diagnosis in its output — evidenceRefs and reviewRefs must name real evidence ids and the review refs the pack prints; at least one ref is required. proposals are structured suggestions only: they are stored as data and never execute automatically, and their targetType is an open name — nothing here executes a suggestion, and the entry that converts one refuses what it cannot run. Use task_definition for a justified reusable TaskTemplate contract or direct-child recipe, and skill for execution-method advice. Ground candidate suggestions in executed contracts, batches and their outcomes, including relatedTaskIds when the finding spans several tasks. A one-off contract does not require publication; supervisor consolidation and real comparison decide what is reusable. Draft review does not replace independent Task acceptance. Written once per diagnosisId and immutable afterwards.",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "Task the diagnosis explains"
			},
			diagnosisId: {
				type: "string",
				required: true,
				description: "Unique id for this diagnosis; a duplicate id is rejected"
			},
			observedFailure: {
				type: "string",
				required: true,
				description: "The postmortem observation (复盘观察): what was actually observed, whether the review failed or succeeded"
			},
			scope: {
				type: "string",
				required: true,
				description: "How far the cause reaches (this task, its subtree, a shared assumption, …)"
			},
			localizedCause: {
				type: "string",
				required: true,
				description: "The most specific explanation the evidence supports"
			},
			evidenceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Evidence ids the diagnosis rests on"
			},
			reviewRefs: {
				type: "array",
				items: { type: "string" },
				description: "Review refs from task_review_pack (<taskId>#<runId> or <taskId>#no-run)"
			},
			confidence: {
				type: "string",
				required: true,
				enum: [
					"high",
					"medium",
					"low"
				],
				description: "How sure the diagnoser is; coarse on purpose"
			},
			proposals: {
				type: "array",
				description: "Structured suggestions for supervisor consolidation and later Evolution steps; task_definition names a reusable TaskTemplate, skill names method advice. Stored as data, never auto-executed; ordinary one-off contracts need none.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						targetType: {
							type: "string",
							required: true,
							description: "The mutation surface the proposal points at, as a name; only the entry that would execute it judges that name"
						},
						targetId: {
							type: "string",
							required: true,
							description: "Name of the concrete target"
						},
						rationale: {
							type: "string",
							required: true,
							description: "Why this change would address the localized cause"
						}
					}
				}
			},
			relatedTaskIds: {
				type: "array",
				items: { type: "string" },
				description: "Other tasks this diagnosis implicates (cross-task lineage)"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "task_diagnose");
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(caller)).rootSessionId);
			const diagnosis = {
				diagnosisId: args.diagnosisId,
				taskId: args.taskId,
				observedFailure: args.observedFailure,
				scope: args.scope,
				localizedCause: args.localizedCause,
				evidenceRefs: args.evidenceRefs ?? [],
				reviewRefs: args.reviewRefs ?? [],
				confidence: args.confidence,
				proposals: toProposals(args.proposals),
				...args.relatedTaskIds === void 0 ? {} : { relatedTaskIds: args.relatedTaskIds }
			};
			try {
				await ctx.task.recordDiagnosisIn(storeId, diagnosis, caller);
			} catch (error) {
				return `task_diagnose rejected: ${message(error)}`;
			}
			const proposals = diagnosis.proposals.map((item) => `- ${item.targetType} ${item.targetId}: ${item.rationale}`);
			return [
				`diagnosis ${diagnosis.diagnosisId} recorded for task ${diagnosis.taskId} [${diagnosis.confidence}]`,
				`cause: ${diagnosis.localizedCause}`,
				...proposals.length === 0 ? ["proposals: none"] : [`proposals (${proposals.length}, suggestions only — none auto-executes):`, ...proposals]
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-intake.ts
/** The root contract intake (A0 §3 stage C): the one tool that turns a user's objective into the graph's root task, and the root session's own action — a worker has a task already and cannot intake one (`task_intake` is in */
function defineTaskIntakeTool(ctx) {
	return defineTool({
		name: "task_intake",
		description: "Call task_template_list first; bind a suitable pinned template, or write a full standard contract when none applies. Accept this root session's contract: the objective the graph works toward, the acceptance criteria a verifier will judge it by, the assumptions and constraints it rests on and the capabilities the work needs. Only the root session of a graph may call this — the contract becomes that session's root task, and a worker's task was admitted by its parent already. The runtime also checks where the contract came from: only a message DSH attests as human input counts, so a session whose own log holds none of the user's is refused — the prompts this deployment writes (the graph setup text, a spawn's delegated task) and the notices it sends are attributed to their producers, not to a person. A delegated child session is refused too, and a contract is never intaken for another session's store. The runtime normalizes and judges the contract first, and one rule is the root's own: at least one mandatory criterion must be judged by something other than the composite conjunction, so \"all children verified\" cannot be the only thing standing behind the goal. Where this deployment reviews contracts, the call then answers with a proposal id and nothing activated; the decision is recorded by the review channel and the runtime activates the contract itself — no parameter of this call approves anything, and a contract waiting for a review has no root task, no run and no worker.",
		parameters: {
			...templateBindingParameters,
			objective: {
				type: "string",
				description: "The goal of this graph, in the user's terms: what has to exist when the work is done. It stays fixed once the contract is accepted, and it is what every later decomposition is judged against. The objective is the user's request, not this graph's name and not the environment setup work"
			},
			acceptanceCriteria: {
				type: "array",
				description: "How the goal is judged, at least one criterion mandatory and aimed at the delivered artifact: a root whose only mandatory criterion is the conjunction of its children has no independent check of the goal it was given",
				items: criterionSchema({
					description: "What must hold true of the delivered artifact",
					criterionId: "Stable id for this criterion; omitted, the runtime generates one from its position (`ac-1`, `ac-2`, …). Declared ids must be unique inside the contract",
					command: "Shell command, executed from this Run's workspace root; exit code 0 proves the criterion. Prefer an existing authoritative checker with explicit artifact or manifest paths. Propagate its failure; do not end with an unconditional success command.",
					mode: "Verifier kind; defaults to deterministic with a command. Mandatory review/formal requires an explicit registered settling verifier.",
					requiresArtifact: "Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product for this criterion to be judgeable; a missing one blocks the run and registers an obligation",
					acceptsArtifact: "Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state",
					verifierRef: "Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole contract at intake and the error lists the registered ids. Omit to dispatch by mode.",
					heuristic: "Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass",
					protectedInputs: "Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. Declare them as paths relative to the graph's checkout (an absolute path stays absolute). Intake resolves each one against that checkout and fixes the SHA-256 of its bytes before the contract is written — a path that cannot be read refuses the whole contract, and no protected input is ever stored as a bare path. The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed."
				})
			},
			assumptions: {
				type: "array",
				items: { type: "string" },
				description: "External conditions this contract rests on, in your words, each marked as an assumption rather than as something the user asked for. They are persisted with the contract and shown to whoever reviews it. An assumption is not a confirmation: it may never settle a value the user did not give when that value would change the objective, the scope or the acceptance — ask the user for it before accepting the contract, or, if the user cannot be asked, keep it explicitly unknown and out of what the delivery must decide. The contract carries only what the user's own words and answers support — an answer that narrows or replaces the work bounds the objective and the criteria to it — and every criterion must be one the deployment's verifiers can settle: give a deterministic criterion its exact command."
			},
			constraints: {
				type: "array",
				items: { type: "string" },
				description: "Execution scope and limits the work runs under, in your words; persisted in the contract and handed to the workers that run under it"
			},
			requiredCapabilities: {
				type: "array",
				items: { type: "string" },
				description: "Capability names the goal needs; call capability_list to inspect available grants. Missing root capabilities remain in the original contract and become persistent obligations owned by this root session. Plan available work or propose the required capability change before executing work that needs it."
			},
			...proposalSubmissionParameters({
				versionSubject: "intake",
				revisionSubject: "contract",
				derivation: "the store, this root session and the contract content"
			})
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "task_intake");
			const resolution = await ctx.singularityContext.resolveCaller(caller);
			if (resolution.kind === "unbound") return [`task_intake rejected: ${resolution.detail}`, "Nothing was read and nothing was written."].join("\n");
			if (resolution.kind !== "root") return [
				`task_intake rejected: session "${caller}" is not the root session of graph "${resolution.graph.id}" (its root session is "${resolution.graph.rootSessionId}") —`,
				"a root contract is the goal of one root session, and a worker's task was admitted by its parent's decomposition.",
				"Nothing was read and nothing was written."
			].join("\n");
			const storeId = resolution.storeId;
			const { requestKey, supersedes,...spec } = args;
			let result;
			try {
				result = await ctx.taskRuntime.intakeRootContract(storeId, caller, spec, {
					...requestKey === void 0 ? {} : { requestKey: String(requestKey) },
					...supersedes === void 0 ? {} : { supersedes: String(supersedes) },
					exec: { signal: exec.signal }
				});
			} catch (error) {
				return `task_intake rejected: ${message(error)}`;
			}
			if (result.status === "activated") return activatedText(caller, result);
			return await pendingReviewText({
				ctx,
				storeId,
				proposalId: result.proposalId,
				detail: result.detail,
				tool: "task_intake",
				holding: "this root contract, and no root task exists",
				lines: [
					"- Nothing was activated and no worker was spawned: the contract is admitted only after the review decides, and the runtime",
					"  then re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.",
					`- Read the contract as it was recorded with \`task_proposal_read\` (${result.proposalId}).`,
					"- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime activates the root",
					"  contract immediately, so `task_read` shows the root task once it is live.",
					"- A refusal is a fact on the record: revise the contract against its reason (fix the cause, never weaken a criterion or drop",
					"  the mandatory independent one) and call `task_intake` again — a revision is new content, hence a new request key and a new",
					"  proposal, and you may name the refused one with `supersedes`.",
					"- Do not re-submit the same content while it waits: the same request key is answered with this same proposal.",
					"- Do not call `task_decompose` before the contract is activated: there is no root task yet, and `task_read` says so."
				]
			});
		}
	});
}
/** The contract is live: the ids the activation commit minted, and what the session does with them. */
function activatedText(rootSessionId, result) {
	return [
		`task_intake activated the root contract of session "${rootSessionId}": root task ${result.taskId}, root run ${result.runId} (proposal ${result.proposalId}).`,
		`- ${result.detail}`,
		"- The root task carries exactly this contract: `task_read` shows its objective, criteria, assumptions and constraints, and the",
		"  graph's tree grows from it.",
		"- `task_decompose` works on the root task from here on: that call was refused before this intake because no root task existed.",
		"- Nothing here claims the goal is met: the runtime submits nothing on your behalf. Delegate as many batches as the work needs,",
		"  and when the goal is delivered hand the root task in yourself with `task_submit_result` — only that submission starts its acceptance."
	].join("\n");
}

//#endregion
//#region src/tools/task-proposal-cancel.ts
function defineTaskProposalCancelTool(ctx) {
	return defineTool({
		name: "task_proposal_cancel",
		description: "Withdraw a decomposition proposal this session submitted, before its batch is admitted: the proposal is recorded as cancelled and its record is kept. Only the session that proposed the batch may withdraw it — a withdrawal by anybody else is a decision, and is recorded as one by the review channel, not by this call. Cancelling admits nothing and spawns nothing; a batch that is already admitted is not affected (end it with task_cancel instead).",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "The proposal id a previous task_decompose (or task_proposal_read) reported; an unknown id is refused"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, ["proposalId"], "task_proposal_cancel");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "task_proposal_cancel");
			const { storeId } = await ctx.taskRuntime.runForSession(caller);
			try {
				return [`${(await ctx.taskRuntime.cancelProposal(storeId, args.proposalId, caller)).detail}`, "The record is kept: a cancelled proposal is a fact, and a revision is a new proposal with its own request key."].join("\n");
			} catch (error) {
				return `task_proposal_cancel rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/task-proposal-continue.ts
/** What one continuation settled, in the terms the caller acts on. A waiting proposal is **not** an error and this text says so: */
function renderContinuation(continuation) {
	if (continuation.status === "admitted") return [
		`proposal ${continuation.proposalId} was admitted as batch ${continuation.batchId}:`,
		...continuation.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`),
		"",
		"The runtime owns the batch now: it starts the children one at a time in dependency order and drives the batch to its end.",
		"The batch end hands this task's execution back — nothing is submitted on its behalf — and this call returns at admission,",
		"so it does not wait for the batch."
	].join("\n");
	if (continuation.status === "activated") return [
		`proposal ${continuation.proposalId} was activated as root task ${continuation.taskId} with run ${continuation.runId}:`,
		`- ${continuation.detail}`,
		"",
		"This is a root contract: the runtime created the root task and its root run and bound this session to them, so no batch",
		"was admitted and no child exists yet. `task_read` shows the contract now, and `task_decompose` works on the root task from",
		"here on."
	].join("\n");
	const reason = continuation.reason === void 0 ? "" : ` — ${continuation.reason}`;
	return [
		`proposal ${continuation.proposalId} is ${continuation.status}: ${continuation.detail}${reason}`,
		"",
		...continuation.status === "pending_review" ? [
			"Nothing was admitted and nothing is spawned while it waits: the review is the gate. Read the batch with",
			"`task_proposal_read` (or wait for the notification) — a decision on the record continues the batch automatically,",
			"and re-submitting the same content answers with this same proposal rather than building another one."
		] : ["A terminal proposal is never re-run: revise the batch and propose it again — a revision is new content, a new request", "key and a new proposal that names this one in `supersedes`."]
	].join("\n");
}
function defineTaskProposalContinueTool(ctx) {
	return defineTool({
		name: "task_proposal_continue",
		description: "Continue a proposal this session submitted: re-check it against everything that was true when it was proposed (what it belongs to, the limits, the capability resolution, the judging verifiers) and act on it if it still passes and carries an approval — a decomposition batch is admitted, a root contract is activated as this session's root task and run. A proposal still waiting for its review is reported as waiting — that is not an error and nothing changes; a rejected, cancelled, stale or expired one is reported with the reason it will never run. Only the session that proposed it can continue it, and this call cannot approve anything: the approval is a decision the review channel records. A root session continues the contract it recorded before its root exists — with no run bound to it, the continuation falls back to the store the session owns, and a ready or approved contract is activated from there.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "The proposal id a previous task_decompose or task_intake (or task_proposal_read) reported; an unknown id is refused"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, ["proposalId"], "task_proposal_continue");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "task_proposal_continue");
			let continuation;
			try {
				const storeId = await proposalStoreFor(ctx, caller);
				continuation = await ctx.taskRuntime.continueProposal(storeId, args.proposalId, caller, { ...typeof exec.callId === "string" && exec.callId.length > 0 ? { exec: { callId: String(exec.callId) } } : {} });
			} catch (error) {
				return `task_proposal_continue rejected: ${message(error)}`;
			}
			return renderContinuation(continuation);
		}
	});
}

//#endregion
//#region src/tools/task-proposal-read.ts
/** The decision on record, as a reader has to see it: what was decided, by whom, when, and why when a reason was given. */
function decisionLines(proposal) {
	const decision = proposal.decision;
	if (decision === void 0) return [proposal.status === "pending_review" ? "decision: none yet — the batch waits for one, and only a recorded decision moves it" : "decision: none recorded"];
	return [
		`decision: ${decision.outcome} by ${decision.decidedBy} at ${decision.decidedAt}`,
		...decision.reason === void 0 ? [] : [`decision reason: ${decision.reason}`],
		`decision bound digest ${decision.proposalDigest} and admission context ${decision.admissionContextDigest}`
	];
}
/** What the batch or the root contract became, once it became one — the ids a retry must not mint again (§6). */
function consumptionLines(proposal) {
	const consumption = proposal.consumption;
	if (consumption === void 0) return [];
	if (consumption.kind === "root") return [`consumed as root task ${consumption.rootTaskId} with run ${consumption.rootRunId} at ${consumption.admittedAt}:`, ...consumption.reason === void 0 ? [] : [`- ${consumption.reason}`]];
	return [`consumed as batch ${consumption.batchId} at ${consumption.admittedAt}:`, ...consumption.childTaskIds.map((taskId, index) => `- child ${index + 1}: ${taskId}`)];
}
/** The payload digest and the two context fingerprints, as every reader of a record needs them. */
function digestLines(proposal, subject) {
	return [
		`${subject} digest (sha256): ${proposal.proposalDigest}`,
		`admission context digest: ${proposal.admissionContextDigest} (maxDepth ${proposal.admissionContext.maxDepth}, maxChildren ${proposal.admissionContext.maxChildren})`,
		`review context digest: ${proposal.reviewContextDigest} (capability manifest digest ${proposal.reviewContext.capabilityManifestDigest}; judging verifiers ${proposal.reviewContext.verifiers.map((verifier) => verifier.verifierId).join(", ") || "none pinned"})`
	];
}
/** The immutable-record footer every proposal is read under, whichever kind it is. */
const RECORD_NOTE = ["The record is immutable: a revision is a new proposal with a new id and a new request key, and only a decision on this", "record (written by the approval channel, never by a caller) can move it."].join("\n");
/** One saved decomposition proposal: its parent, its whole batch, the decision and what it became. */
function renderBatchProposal(proposal) {
	return [
		`proposal ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy}`,
		`submitted ${proposal.createdAt}${proposal.updatedAt === void 0 ? "" : `, last moved ${proposal.updatedAt}`}`,
		`parent task ${proposal.identity.parentTaskId} run ${proposal.identity.parentRunId} (session ${proposal.identity.callerSessionId})`,
		`reason: ${proposal.identity.reason}`,
		`request key: ${proposal.requestKey}${proposal.supersedes === void 0 ? "" : `; supersedes ${proposal.supersedes}`}`,
		"",
		...digestLines(proposal, "batch"),
		"",
		...decisionLines(proposal),
		...consumptionLines(proposal),
		"",
		`children (${proposal.batch.length}):`,
		...renderProposalChildren(proposal),
		RECORD_NOTE
	].join("\n");
}
/** One saved root contract proposal: the session it is the goal of, the contract itself rather than a child batch — there is no parent task and no batch to print — the decision and the root task it became. */
function renderRootProposal(proposal) {
	return [
		`proposal ${proposal.proposalId} [${proposal.status}] policy ${proposal.policy}`,
		`submitted ${proposal.createdAt}${proposal.updatedAt === void 0 ? "" : `, last moved ${proposal.updatedAt}`}`,
		`root session ${proposal.identity.rootSessionId} (store ${proposal.identity.storeId})`,
		`request key: ${proposal.requestKey}${proposal.supersedes === void 0 ? "" : `; supersedes ${proposal.supersedes}`}`,
		"",
		...digestLines(proposal, "contract"),
		"",
		...decisionLines(proposal),
		...consumptionLines(proposal),
		"",
		"root contract:",
		...renderRootContract(proposal.contract),
		RECORD_NOTE
	].join("\n");
}
/** One saved proposal, as the record holds it — the whole batch, or the whole root contract, not a summary, and nothing that is not on the record. There is no argument for a status: the answer is the store's. */
function renderProposal(proposal) {
	return proposal.kind === "root" ? renderRootProposal(proposal) : renderBatchProposal(proposal);
}
function defineTaskProposalReadTool(ctx) {
	return defineTool({
		name: "task_proposal_read",
		description: "Read one proposal by id: where it stands, the policy it was born under, and the subject it carries — every child of a decomposition batch (objective, criteria, assumptions, constraints, dependencies and capability requirements), or the single root contract a root session asked to be admitted as — plus the digest, both context fingerprints, the decision on record and what the proposal became, if it became something. Read-only, and the answer is always the stored record: there is no argument here that can claim a status or an approval. A root session reads the proposal holding its contract before its root exists — with no run bound to it, the reader falls back to the store the session owns.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "The proposal id a previous task_decompose or task_intake (or task_proposal_read) reported; an unknown id is refused"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, ["proposalId"], "task_proposal_read");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "task_proposal_read");
			try {
				const storeId = await proposalStoreFor(ctx, caller);
				return renderProposal(await ctx.taskRuntime.proposalIn(storeId, args.proposalId));
			} catch (error) {
				return `task_proposal_read rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/task-read.ts
function defineTaskReadTool(ctx) {
	return defineTool({
		name: "task_read",
		description: "Read the caller's task contract. The root session sees the root task, its acceptance criteria, and child task statuses — or, before any root contract has been accepted, the named not-activated state together with whatever proposal is still open (the graph's name is never shown as an objective). A worker sees its own task and run. A reviewer sees the task it was delegated to review, marked review-only. A run line carries the coordination phase this run is in — and the id of the batch it is still waiting on, its submission and any no-progress marking when it has them; a run that returned to active waits on no batch, though its record keeps every batch it ended. A run with no phase is an old record and is shown as needs-recovery. This is the same read the worker's assembled context is projected from, so the two cannot disagree.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (_args, exec) => {
			const caller = sessionId(exec, "task_read");
			return adaptRead("task_read", await ctx.singularityContext.taskRead(caller, exec.signal));
		}
	});
}

//#endregion
//#region src/tools/task-review-pack.ts
/** The judgement line: the six dimensions whose conclusion the fact table does not carry, named so a reader cannot mistake the facts for a verdict. */
function renderJudgementDimensions() {
	return `needs judgement (agent): ${JUDGED_DIMENSIONS.join(", ")} (not mechanically observable from the fact table; a review agent may conclude them)`;
}
/** The review record of one exact source, or nothing when the store holds none. */
function reviewForSource(snapshot, source) {
	return snapshot.reviews.find((review) => review.taskId === source.taskId && (review.runId ?? null) === source.runId);
}
/** The ledger state of one source: every **review** attempt the store holds for it, in the order they were claimed — the default attempt (`null` key) and each explicit one — with how each ended. */
function renderAttempts(attempts, source) {
	const mine = attempts.filter((attempt) => attempt.role === "reviewer" && attempt.source.taskId === source.taskId && attempt.source.runId === source.runId);
	if (mine.length === 0) return ["review attempts (0): none — no review agent has been started for this source"];
	return [`review attempts (${mine.length}):`, ...mine.map((attempt) => {
		const label = attempt.requestKey === null ? "default attempt" : `requestKey "${attempt.requestKey}"`;
		const status = attempt.settlement?.status ?? "in-flight";
		const note = attempt.settlement?.note === void 0 ? "" : ` — ${attempt.settlement.note}`;
		const reason = attempt.reason === null ? "" : ` reason ${JSON.stringify(attempt.reason)}`;
		return `- ${label} ${attempt.sessionId} [${status}]${reason}${note}`;
	})];
}
/** The effort line: one clause per counter that exists, and nothing for the ones that do not — an absent field means "not observed" (see `ReviewMetrics`), so printing 0 for it would invent a measurement. */
function renderMetrics(metrics) {
	const parts = [];
	if (metrics.tokens !== void 0) parts.push(`tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens} (session-cumulative)`);
	if (metrics.toolCalls !== void 0) parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`);
	if (metrics.humanInterventions !== void 0) parts.push(`humanInterventions ${metrics.humanInterventions} (session-scoped)`);
	if (metrics.retries !== void 0) parts.push(`retries ${metrics.retries} (runs beyond the first; a recovery attempt is one)`);
	if (metrics.evidenceLogs !== void 0) parts.push(`evidenceLogs ${metrics.evidenceLogs}`);
	return parts.join(" — ");
}
/** One line per dimension that the record actually carries: the observed facts, copied out, never rated and never narrated. */
function renderDimensions(dimensions) {
	const lines = [];
	const outcome = dimensions.outcomeCorrectness;
	if (outcome !== void 0) lines.push(`  dim outcome correctness: ${outcome.outcome}, criteria ${outcome.criteriaCount}, unmet [${outcome.unmetCriterionIds.join(", ")}]`);
	const specification = dimensions.taskSpecification;
	if (specification !== void 0) lines.push(`  dim task specification: objective ${specification.objectivePresent ? "present" : "empty"}, criteria ${specification.criteriaCount}, with command ${specification.criteriaWithCommand}`);
	const acceptance = dimensions.acceptance;
	if (acceptance !== void 0) {
		const criteria = acceptance.criteria.map((item) => `${item.criterionId} ${item.mode}${item.hasCommand ? " +command" : ""}${item.mandatory ? "" : " optional"}`);
		lines.push(`  dim acceptance: ${criteria.join("; ")}`);
	}
	const decomposition = dimensions.decomposition;
	if (decomposition !== void 0) lines.push(`  dim decomposition: depth ${decomposition.depth}, ${decomposition.decompositionStatus}, children ${decomposition.childCount}, edges in/out ${decomposition.incomingEdges}/${decomposition.outgoingEdges}`);
	const coverage = dimensions.capabilityCoverage;
	if (coverage !== void 0) lines.push(`  dim capability coverage: ${coverage.closure}, granted [${coverage.granted.join(", ")}], missing [${coverage.missing.join(", ")}]`);
	const skill = dimensions.skillFit;
	if (skill !== void 0) {
		const loaded = (skill.loaded === void 0 ? "" : `, loaded [${skill.loaded.join(", ")}]`) + (skill.loadedOutsideGrant === void 0 ? "" : `, outside grant [${skill.loadedOutsideGrant.join(", ")}]`);
		lines.push(`  dim skill fit: granted [${skill.granted.join(", ")}]${loaded}`);
	}
	const tools = dimensions.toolFit;
	if (tools !== void 0) {
		const called = (tools.called === void 0 ? "" : `, called [${tools.called.map((item) => `${item.name} x${item.count}`).join(", ")}]`) + (tools.calledOutsideGrant === void 0 ? "" : `, outside grant [${tools.calledOutsideGrant.join(", ")}]`);
		lines.push(`  dim tool fit: granted [${tools.granted.join(", ")}]${called}`);
	}
	const context = dimensions.contextEfficiency;
	if (context !== void 0) {
		const tokens = context.tokens === void 0 ? "" : ` tokens in/out ${context.tokens.uncachedInputTokens}/${context.tokens.outputTokens}`;
		const compactions = context.compactions === void 0 ? "" : ` compactions ${context.compactions}`;
		const cache = context.tokens === void 0 ? "" : ` cache read/write ${context.tokens.cacheReadTokens}/${context.tokens.cacheWriteTokens}`;
		lines.push(`  dim context efficiency:${tokens}${compactions}${cache}`);
	}
	return lines;
}
/** One review line, with the session id a reader drills into. Printing it here is what lets a diagnosis point `session_trace` at the session the review came from without a second lookup (§2.7.5). */
function renderReview(review) {
	const duration = review.durationMs === void 0 ? "" : ` duration ${review.durationMs}ms`;
	const session = review.sessionId === void 0 ? "" : ` session ${review.sessionId}`;
	const lines = [`- review ${reviewRef(review)} [${review.outcome}]${duration} evidence: [${review.evidenceRefs.join(", ")}]${session}`];
	if (review.relatedTaskIds !== void 0) lines.push(`  relatedTaskIds: [${review.relatedTaskIds.join(", ")}]`);
	if (review.localizedCause !== void 0) lines.push(`  cause: ${review.localizedCause}`);
	for (const anomaly of review.anomalies) lines.push(`  anomaly: ${anomaly}`);
	for (const criterion of review.criteria ?? []) {
		const judge = criterion.verifierId === void 0 ? "" : criterion.verifierVersion === void 0 ? ` [${criterion.verifierId}]` : ` [${criterion.verifierId}@${criterion.verifierVersion}]`;
		const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
		const exit = criterion.exitCode === void 0 ? "" : ` exit ${criterion.exitCode}`;
		const log = criterion.logRef === void 0 ? "" : ` log ${criterion.logRef}`;
		const unknown = criterion.unknownKind === void 0 ? "" : ` unknownKind ${criterion.unknownKind}`;
		lines.push(`  criterion ${criterion.criterionId}: ${criterion.verdict}${judge}${exit}${command}${log}${unknown}`);
	}
	for (const blocker of review.blockedBy ?? []) lines.push(`  blockedBy ${blocker.taskId} [${blocker.outcome}]`);
	if (review.metrics !== void 0) {
		const metrics = renderMetrics(review.metrics);
		if (metrics.length > 0) lines.push(`  metrics: ${metrics}`);
	}
	if (review.dimensions !== void 0) lines.push(...renderDimensions(review.dimensions));
	if (review.logTail !== void 0) lines.push("  logTail:", ...review.logTail.split("\n").map((line) => `    ${line}`));
	return lines;
}
/** How far one diagnosis's supervision has gone: the supervisor attempts the LEDGER holds for it. */
function supervisionMark(diagnosis, attempts) {
	return supervisorAttemptsLine(diagnosis.diagnosisId, attempts);
}
function renderDiagnosis(diagnosis, attempts) {
	const producer = diagnosis.producedBy === void 0 ? "" : diagnosis.producedBy.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? ` [agent ${diagnosis.producedBy.sessionId}]` : ` [${diagnosis.producedBy.kind}]`;
	const lines = [`- ${diagnosis.diagnosisId} [${diagnosis.confidence}] ${diagnosis.localizedCause}${producer}`];
	lines.push(`  observation: ${diagnosis.observedFailure}`, `  scope: ${diagnosis.scope}; task ${diagnosis.taskId}`, `  reviewRefs: [${diagnosis.reviewRefs.join(", ")}]; evidenceRefs: [${diagnosis.evidenceRefs.join(", ")}]; relatedTaskIds: [${(diagnosis.relatedTaskIds ?? []).join(", ")}]`);
	if (diagnosis.judgements !== void 0 && diagnosis.judgements.length > 0) {
		const header = diagnosis.producedBy?.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? `judgements (agent ${diagnosis.producedBy.sessionId})` : "judgements";
		lines.push(`  ${header}:`);
		for (const judgement of diagnosis.judgements) lines.push(`    ${judgement.dimension}: ${judgement.verdict} — ${judgement.rationale} refs [${judgement.evidenceRefs.join(", ")}]`);
	}
	for (const proposal of diagnosis.proposals) lines.push(`  proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`);
	lines.push(`  supervision: ${supervisionMark(diagnosis, attempts)}`);
	return lines;
}
/** What the exact source run was bound to and loaded (S1-C item 4). */
function renderBindings(snapshot, source) {
	const lines = [];
	for (const run of snapshot.runs.filter((item) => item.taskId === source.taskId && item.runId === source.runId)) {
		const binding = run.providerBinding;
		if (binding === void 0) continue;
		const skills = binding.skills.length === 0 ? "no provider skill" : binding.skills.map((skill) => `${skill.name} [${skill.role}] content ${skill.contentDigest.slice(0, 12)}${skill.contractDigest === null ? "" : ` contract ${skill.contractDigest.slice(0, 12)}`}`).join("; ");
		const servers = binding.mcpServers.length === 0 ? "" : `; mcp ${binding.mcpServers.map((server) => server.serverName).join(", ")}`;
		const snapshotRoot = binding.snapshotRoot === void 0 ? "" : `; snapshot ${binding.snapshotRoot}`;
		lines.push(`- run ${run.runId} [${run.status}] bound registry ${binding.registryRevision.slice(0, 12)}: ${skills}${servers}${snapshotRoot}`);
	}
	return lines;
}
/** One exact source in full, with bounded same-graph evidence navigation through the existing read tools. */
function buildReviewPack(input) {
	const { snapshot, source, attempts } = input;
	const { taskId } = source;
	const task = snapshot.tasks.find((item) => item.taskId === taskId);
	if (task === void 0) throw new Error(`task_review_pack: unknown task "${taskId}"`);
	const review = reviewForSource(snapshot, source);
	const reviews = snapshot.reviews.filter((item) => item.taskId === task.taskId);
	const incoming = snapshot.edges.filter((edge) => edge.to === task.taskId).map((edge) => edge.from);
	const outgoing = snapshot.edges.filter((edge) => edge.from === task.taskId).map((edge) => edge.to);
	const diagnoses = snapshot.diagnoses.filter((item) => item.taskId === task.taskId || item.reviewRefs.includes(reviewRef(source)) || item.relatedTaskIds?.includes(task.taskId));
	const sourceRun = source.runId === null ? void 0 : snapshot.runs.find((run) => run.runId === source.runId && run.taskId === taskId);
	const latestRunId = task.runIds.at(-1);
	const lines = [
		`review pack for task ${task.taskId} [${task.status}] depth ${task.depth}`,
		`source: review ${reviewRef(source)}${review === void 0 ? " (not on the record)" : ` [${review.outcome}]`}`,
		`source run: ${sourceRun === void 0 ? "none" : `${sourceRun.runId} [${sourceRun.status}] session ${sourceRun.sessionId ?? review?.sessionId ?? "unknown"}; ${sourceRun.runId === latestRunId ? "latest run" : "historical run"}; preset ${sourceRun.agentPreset ?? "unknown"}`}; latest run of task: ${latestRunId ?? "none"}`,
		`objective: ${task.objective}`,
		`dependencies: must verify first [${incoming.join(", ")}]; blocks [${outgoing.join(", ")}]`,
		...renderAttempts(attempts, source),
		renderJudgementDimensions(),
		`reviews (${reviews.length}): exact source in full; other versions in graph navigation`,
		...review === void 0 ? [] : renderReview(review),
		...renderBindings(snapshot, source)
	];
	const navigation = ["Navigation: task_status scope:\"graph\" pages tasks; context_read kind:\"task\"/\"run\"/\"evidence\"/\"diagnosis\" ref:<id> reads exact records; kind:\"review\" ref:{taskId,runId} reads one exact review; kind:\"session\" ref:<sessionId> reads session events in pages.", "Counters are recorded observations, sometimes session-cumulative; missing fields are unobserved. Complete cost: unknown — worker counters alone do not account for reviewer, supervisor and replay spend. No graph total is inferred."];
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const footerReserve = 512;
	const navigationBytes = navigation.reduce((total, line) => total + utf8Bytes(line) + 1, 0);
	if (utf8Bytes(lines.join("\n")) + navigationBytes + footerReserve > budget.maxBytes) return `task_review_pack: exact source ${reviewRef(source)} exceeds the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound; its full record was not shortened. Read it in pages with context_read kind:"review" ref:${JSON.stringify({
		taskId,
		runId: source.runId
	})}${source.runId === null ? "" : `, and kind:"run" ref:${JSON.stringify(source.runId)}`}; task_status scope:"graph" navigates this graph.`;
	budget.addAll(lines);
	budget.addAll(navigation);
	const tasks = [...snapshot.tasks].sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);
	if (budgetList(budget, {
		header: [`graph DAG navigation (${tasks.length} tasks; current task state, exact run history; short digests, full identities through context_read):`],
		units: tasks.slice(0, 20),
		reserve: footerReserve,
		lines: (entry) => {
			const incoming$1 = snapshot.edges.filter((edge) => edge.to === entry.taskId).map((edge) => edge.from);
			const outgoing$1 = snapshot.edges.filter((edge) => edge.from === entry.taskId).map((edge) => edge.to);
			const template = entry.templateRef === void 0 ? "unknown" : `${entry.templateRef.id}@${entry.templateRef.version} digest ${entry.templateRef.digest.slice(0, 12)}`;
			const definition = entry.definitionRef === void 0 ? "unknown" : `${entry.definitionRef.taskType}@${entry.definitionRef.version}`;
			const diagnosisRefs = snapshot.diagnoses.filter((item) => item.taskId === entry.taskId || item.relatedTaskIds?.includes(entry.taskId)).map((item) => item.diagnosisId);
			const lines$1 = [`- task ${entry.taskId} [${entry.status}] parent ${entry.parentTaskId ?? "none"}; dependencies [${incoming$1.join(", ")}]; blocks [${outgoing$1.join(", ")}]; definition ${definition}; template ${template}; diagnoses [${diagnosisRefs.join(", ")}]`];
			for (const run of snapshot.runs.filter((item) => item.taskId === entry.taskId)) {
				const review$1 = reviewForSource(snapshot, {
					taskId: entry.taskId,
					runId: run.runId
				});
				const exact = run.taskId === source.taskId && run.runId === source.runId;
				const latest = run.runId === entry.runIds.at(-1);
				const version = `${exact ? "exact source, " : ""}${latest ? "latest run" : "historical run"}`;
				const binding = run.providerBinding;
				const skills = binding === void 0 ? "unknown" : binding.skills.map((skill) => `${skill.name}[${skill.role}] content ${skill.contentDigest.slice(0, 12)} contract ${skill.contractDigest?.slice(0, 12) ?? "unknown"}`).join("; ") || "none";
				const frozen = latest || exact ? `; preset ${run.agentPreset ?? "unknown"}; registry ${binding?.registryRevision.slice(0, 12) ?? "unknown"}; frozen skills [${skills}]` : "";
				const metrics = review$1?.metrics === void 0 ? "" : renderMetrics(review$1.metrics);
				lines$1.push(`  run ${run.runId} [${run.status}; ${version}] session ${run.sessionId ?? review$1?.sessionId ?? "unknown"}; review ${review$1 === void 0 ? "none" : `${reviewRef(review$1)} [${review$1.outcome}]`}${frozen}; observed counters ${metrics || "unknown"}`);
			}
			for (const review$1 of snapshot.reviews.filter((item) => item.taskId === entry.taskId && item.runId === void 0)) lines$1.push(`  review ${reviewRef(review$1)} [${review$1.outcome}; no-run source]`);
			return lines$1;
		},
		tail: (count) => [`navigation shown: ${count}/${tasks.length} tasks. Continue task_status scope:"graph" offset:${count}, then context_read for exact task, run, review and diagnosis refs; pages are separate observations.`]
	}) === void 0) budget.add("Graph navigation did not fit; use task_status scope:\"graph\" offset:0 and context_read for exact records.");
	if (budgetList(budget, {
		header: [`diagnoses (${diagnoses.length}):`],
		units: diagnoses,
		lines: (diagnosis) => renderDiagnosis(diagnosis, attempts),
		tail: (count) => [`diagnoses shown: ${count}/${diagnoses.length}; exact records through context_read kind:"diagnosis" ref:<diagnosisId>, discovered through task_status scope:"graph".`]
	}) === void 0) budget.add("Diagnoses did not fit; discover diagnosisRefs through task_status scope:\"graph\", then context_read kind:\"diagnosis\".");
	return budget.text();
}
function defineTaskReviewPackTool(ctx) {
	return defineTool({
		name: "task_review_pack",
		description: "Read-only. Assemble the diagnosis input pack for ONE exact review source — a task and the run under review, or runId null for a review that carries no run (a task blocked before it started). The pack names the task itself, the exact source review in full (criteria, log tail, blockers, session), historical review references, the review attempts the ledger holds for this source and how each ended, the dimensions whose conclusion the fact table does not carry, the dependency edges touching it, and its diagnoses with any agent judgements — every diagnosis marked with the supervisor attempts the coordination ledger holds for it (which session ran it and how it ended), which only a graph that runs an RSI loop has. It reports the facts only: whether a review agent runs is decided elsewhere (an explicit call names its source; a graph's RSI loop spawns its supervisor itself). It adds bounded same-graph DAG navigation with exact run/session ids, template and frozen provider digests, and observed counters. Continue with task_status scope:\"graph\" and context_read; no ancestry or sibling log replay. Feed this to task_diagnose, or to task_review_agent when a judgement is needed.",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "Task to assemble the pack for"
			},
			runId: {
				oneOf: [{ type: "string" }, { type: "null" }],
				required: true,
				description: "The Run whose review the pack is for, exactly as its review record names it; null for a review with no run"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(sessionId(exec, "task_review_pack"))).rootSessionId);
			const source = {
				taskId: args.taskId,
				runId: args.runId
			};
			const snapshot = await ctx.task.openStore(storeId);
			if (!snapshot.tasks.some((task) => task.taskId === args.taskId)) throw new Error(`task_review_pack: unknown task "${args.taskId}" in store ${storeId}`);
			if (args.runId !== null && !snapshot.runs.some((run) => run.runId === args.runId && run.taskId === args.taskId)) return `task_review_pack: run "${args.runId}" is not a run of task "${args.taskId}"; nothing to pack`;
			if (reviewForSource(snapshot, source) === void 0) return `task_review_pack: no review record for source ${reviewRef(source)} in store ${storeId}; nothing to pack`;
			return buildReviewPack({
				snapshot,
				source,
				attempts: await readReviewAgentAttempts(storeId)
			});
		}
	});
}

//#endregion
//#region src/coordination/review-run.ts
/** Shared coordinator composition; runtime installs the reviewer policy. */
const REVIEWER_PRESET = "singularity-coordinator";
/** The review agent's whole tool surface. Read-only by construction: */
const REVIEWER_BASELINE = [
	"task_review_pack",
	"task_read",
	"task_status",
	"context_read",
	"capability_list",
	"task_template_list",
	"read",
	"glob",
	"grep",
	"skill"
];
/** The capability grant one review agent is spawned with. */
function reviewerGrant() {
	return {
		capabilities: [],
		baseline: REVIEWER_BASELINE,
		keepPresetTools: false
	};
}
/** The source one attempt reviews, as a ref a reader reads back (`t1#r1`, `t2#no-run`). */
function sourceRef(source) {
	return reviewRef({
		taskId: source.taskId,
		runId: source.runId
	});
}
/** The last fenced JSON object is the reviewer's answer. */
function parseReviewerObject(reply) {
	if (reply === void 0) return void 0;
	const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
	const candidate = fenced[fenced.length - 1];
	if (candidate === void 0) return void 0;
	try {
		const parsed = JSON.parse(candidate);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
/** A non-empty string out of the reply, or nothing. */
function textOf(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
/** Optional lineage is explicit: malformed ids are refused, and repeated ids add no evidence. */
function refsOf(value, field) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value) || value.some((ref) => textOf(ref) === void 0)) throw new Error(`the "${field}" field must be an array of non-empty strings`);
	return [...new Set(value)];
}
/** Validate the judgements the reviewer chose to make. Each one has to name a judged dimension and a verdict from the fixed vocabulary, cite at least one non-empty ref and carry a rationale — this is the. */
function judgementsOf(value) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("the \"judgements\" field is not an array");
	return value.map((item, index) => {
		const entry = item ?? {};
		const dimension = entry.dimension;
		if (!JUDGED_DIMENSIONS.includes(dimension)) throw new Error(`judgement ${index} names dimension "${String(dimension)}", which is not one of ${JUDGED_DIMENSIONS.join(", ")}`);
		const verdict = entry.verdict;
		if (!JUDGEMENT_VERDICTS.includes(verdict)) throw new Error(`judgement ${index} (${String(dimension)}) has verdict "${String(verdict)}", which is not adequate/inadequate/unknown`);
		const refs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs.filter((ref) => typeof ref === "string" && ref.length > 0) : [];
		if (refs.length === 0) throw new Error(`judgement ${index} (${String(dimension)}) cites no evidence — a conclusion that rests on nothing is not recorded`);
		const rationale = textOf(entry.rationale);
		if (rationale === void 0) throw new Error(`judgement ${index} (${String(dimension)}) carries no rationale`);
		return {
			dimension,
			verdict,
			evidenceRefs: refs,
			rationale
		};
	});
}
/** Validate the proposals the reviewer chose to make: a target name, an id and a reason, each grounded in what it wrote. */
function proposalsOf(value) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("the \"proposals\" field is not an array");
	return value.map((item, index) => {
		const entry = item ?? {};
		const targetType = textOf(entry.targetType);
		const targetId = textOf(entry.targetId);
		const rationale = textOf(entry.rationale);
		if (targetType === void 0 || targetId === void 0 || rationale === void 0) throw new Error(`proposal ${index} needs a non-empty targetType, targetId and rationale`);
		return {
			targetType,
			targetId,
			rationale
		};
	});
}
/** The diagnosis the reviewer's reply carries, or a named reason it carries none. What is required is what a Diagnosis is: the **observation** (the persisted `observedFailure` slot, read as the postmortem observation — a */
function parseReviewerDiagnosis(reply) {
	if (reply === void 0) return {
		ok: false,
		refusal: "the reviewer returned no output"
	};
	const parsed = parseReviewerObject(reply);
	if (parsed === void 0) return {
		ok: false,
		refusal: "the reviewer returned no parseable json object"
	};
	const observation = textOf(parsed.observation);
	if (observation === void 0) return {
		ok: false,
		refusal: "the reply carries no observation (the postmortem observation is required)"
	};
	const conclusion = textOf(parsed.conclusion);
	if (conclusion === void 0) return {
		ok: false,
		refusal: "the reply carries no conclusion"
	};
	const confidence = parsed.confidence;
	if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return {
		ok: false,
		refusal: `the reply's confidence "${String(confidence)}" is not high/medium/low`
	};
	try {
		const scope = textOf(parsed.scope);
		if (parsed.scope !== void 0 && scope === void 0) throw new Error("the \"scope\" field must be a non-empty string");
		const reviewRefs = refsOf(parsed.reviewRefs, "reviewRefs");
		const evidenceRefs = refsOf(parsed.evidenceRefs, "evidenceRefs");
		const relatedTaskIds = refsOf(parsed.relatedTaskIds, "relatedTaskIds");
		return {
			ok: true,
			diagnosis: {
				observation,
				conclusion,
				confidence,
				...scope === void 0 ? {} : { scope },
				...reviewRefs === void 0 ? {} : { reviewRefs },
				...evidenceRefs === void 0 ? {} : { evidenceRefs },
				...relatedTaskIds === void 0 ? {} : { relatedTaskIds },
				judgements: judgementsOf(parsed.judgements),
				proposals: proposalsOf(parsed.proposals)
			}
		};
	} catch (error) {
		return {
			ok: false,
			refusal: `the reply's diagnosis fields are malformed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/** The judged dimensions rendered as report lines (agent judgements, kept apart from the fact lines). */
function renderJudgements(judgements) {
	return judgements.map((item) => `  ${item.dimension}: ${item.verdict} — ${item.rationale} refs [${item.evidenceRefs.join(", ")}]`);
}
/** The diagnosis one attempt recorded, as the store holds it (the id is the attempt's session). */
function recordedDiagnosis(snapshot, sessionId$1) {
	return snapshot.diagnoses.find((diagnosis) => diagnosis.diagnosisId === `review-agent-${sessionId$1}`);
}
/** Run one review attempt for one source: the admission's serial region (plan, claim, spawn) and then, outside it, the reviewer's reply, the diagnosis it carries and the one terminal fact. */
async function runReviewAgentAttempt(input) {
	const { ctx, storeId, source, review, parent, actor } = input;
	const reviewerSessionId = SessionId(randomUUID());
	const request = {
		source,
		requestKey: input.requestKey,
		reason: input.reason,
		actor,
		sessionId: reviewerSessionId
	};
	const outcome = await admitReviewAgent(storeId, async (admission) => {
		const current$1 = await ctx.task.snapshotIn(storeId);
		const { plan, recovered } = await admission.plan(request, { recorded: (attempt) => recordedDiagnosis(current$1, attempt.sessionId) !== void 0 });
		if (plan.kind === "refused") return {
			kind: "refused",
			plan,
			recovered
		};
		if (plan.kind === "reuse") return {
			kind: "reuse",
			attempt: plan.attempt,
			recovered
		};
		if (plan.kind === "in-flight") return {
			kind: "in-flight",
			attempt: plan.attempt,
			recovered
		};
		const spawned = await spawnUnderClaim({
			ctx,
			admission,
			storeId,
			request,
			sessionId: reviewerSessionId,
			taskId: source.taskId,
			actor,
			parent,
			name: `review ${source.taskId}`,
			preset: REVIEWER_PRESET,
			grant: reviewerGrant(),
			signal: input.signal,
			errorLabel: "task_review_agent: the delegation of reviewer session",
			failureLabel: "spawn failed",
			prompt: async () => {
				const pack = buildReviewPack({
					snapshot: current$1,
					source,
					attempts: await readReviewAgentAttempts(storeId)
				});
				return [
					"You are a Singularity review agent. Explain the review source below: what happened, why, and what — if anything — should change.",
					"Read what you are authorized to read: the pack below, and beyond it whatever settles the question — task_read, task_status and context_read reach the sibling tasks, their sessions and their evidence; task_template_list reads the delegated task's template catalog and exact templateRef contracts. Cite what you rest on.",
					"Provide read-only analysis grounded in the recorded evidence.",
					"Start with this exact source, then inspect the business DAG and read original evidence where it distinguishes plausible causes. Explain how exploration decisions, result boundaries, upstream contracts, dependencies, shared providers or decomposition could produce the observed result. Establish a shared cause with evidence linking the implicated results.",
					...review.outcome === "verified" ? ["The run passed its review; inspect the delivered result, acceptance coverage and exploration choices as well as avoidable tool calls, repeated reads, retries and decomposition costs. Compare candidates under the original acceptance with real two-sided replay. Graph-local observed cases support experience for this graph; independent holdouts provide transfer evidence and are required for shared publication. Mark fresh transfer unknown when it has not been measured. Domain outcome claims use llm-outcome with real measurements under a frozen evaluation plan; execution overhead claims use tool-call-reduction over the complete Run subtree. Treat an observed opportunity as a testable hypothesis until measured."] : [],
					"Return EXACTLY one fenced json block, no prose around it:",
					"```json",
					JSON.stringify({
						observation: "...",
						conclusion: "...",
						confidence: "low",
						reviewRefs: [sourceRef(source)]
					}),
					"```",
					"- observation (required): the postmortem observation (复盘观察) — what was actually observed in the source, whether it failed or succeeded.",
					"- Keep observation and conclusion concise; cite the failure command, log or session ref rather than restating the whole pack.",
					"- conclusion (required): explain the cause and cite the original outcome evidence. For a failed source, name one concrete next action for its business coordinator, such as a smaller independently verifiable child result after the batch settles. Check its task/run state first: task_decompose needs an active run; a terminal run returns its next-action recommendation to the supervisor. Investigate accessible facts before concluding that the cause is unknown; if it remains unsettled, identify the specific missing fact.",
					"- confidence (required): high, medium or low.",
					"- A successful source may conclude \"no improvement needed\" with its supporting evidence.",
					"- scope, reviewRefs, evidenceRefs, relatedTaskIds (optional): name the causal scope and include only records you read that support the explanation. reviewRefs must be exact taskId#runId (or taskId#no-run) refs from task_review_pack or context_read kind:\"review\". Top-level evidenceRefs must be evidence bundle ids read through context_read kind:\"evidence\"; use reviewRefs for a review and cite commands, log paths, criterion ids or template ids in prose, not in these arrays. relatedTaskIds must be actual task ids in this graph. The triggering review is retained automatically. Include the additional lineage that supports the finding.",
					"- For a shared cause, cite the original evidence from each implicated task and the common contract, provider version or dependency that connects them; inspect a passing contrast when available. State uncertainty and conflicting evidence. A causally supported candidate may describe an anticipated benefit as a testable hypothesis and say what would refute it; describe untested benefit as a hypothesis to measure. If the cause is unresolved, identify the missing evidence and use low confidence.",
					`- judgements (optional): [{dimension, verdict, evidenceRefs, rationale}], only when useful and supported. Dimensions: ${JUDGED_DIMENSIONS.join(", ")}; verdict: adequate|inadequate|unknown. Each evidenceRefs array must cite at least one exact review ref, evidence ref printed by a review, evidence bundle id, or Run/review session id from this graph. Use these recorded identities as judgement refs; include the dimensions the evidence supports.`,
					"- proposals (optional): [{targetType, targetId, rationale}]. A business retry or re-decomposition belongs in the conclusion. For an evidenced reusable gap, executable targetType names are task_definition (a TaskTemplate; targetId is its template id), skill or capability. Include the causal mechanism, expected benefit and how it could be tested in rationale. Other targetType names remain recorded suggestions. Connect a shared-change recommendation to evidence of a reusable cause; proposals record recommendations for the supervisor.",
					"- The platform RSI loop schedules the next round. Return useful exploration or decomposition goals and method experience for TaskTemplate or Skill review; the authorized supervisor evaluates and applies reusable changes.",
					"Include observation, conclusion and confidence so the finding can be recorded as a diagnosis.",
					"",
					`--- source under review ---`,
					`review ${sourceRef(source)} [${review.outcome}]${request.reason === null ? "" : ` — focus: ${request.reason}`}`,
					"",
					"--- review pack ---",
					pack
				].join("\n");
			}
		});
		if (spawned.kind === "spawn-failed") return {
			kind: "spawn-failed",
			failure: spawned.failure,
			sessionId: reviewerSessionId
		};
		return {
			kind: "spawned",
			handle: spawned.handle
		};
	});
	if (outcome.kind === "refused" || outcome.kind === "reuse" || outcome.kind === "in-flight" || outcome.kind === "spawn-failed") return outcome;
	const { handle } = outcome;
	/** The one exit an attempt has: every path that ends this execution records its terminal fact, so no failure of this entry leaves the source looking in flight forever. A ledger that cannot take the fact is best-effort */
	const settleAttempt = async (status, note) => {
		await settleReviewAgentAttempt({
			rootStoreId: storeId,
			taskId: source.taskId,
			sessionId: reviewerSessionId,
			status,
			...note === void 0 ? {} : { note }
		}).catch(() => void 0);
	};
	const cancel = () => handle.agent.cancel({ kind: "parent" });
	input.signal?.addEventListener("abort", cancel, { once: true });
	let waiting = true;
	let unloaded = false;
	let resolveCompleted;
	const completed = new Promise((resolve$1) => {
		resolveCompleted = resolve$1;
	});
	let disposeWait;
	try {
		disposeWait = ctx.effect(() => async () => {
			if (!waiting) return;
			unloaded = true;
			cancel();
			await completed;
		}, "singularityAgent: review agent wait");
		if (input.signal?.aborted === true) cancel();
		await handle.agent.whenIdle();
		const parsed = input.signal?.aborted === true || unloaded ? {
			ok: false,
			refusal: unloaded ? "the plugin was unloaded before the reviewer produced a diagnosis" : "the attempt was cancelled before the reviewer produced a diagnosis"
		} : parseReviewerDiagnosis(lastAssistantText(handle.agent.session.snapshotEvents()));
		if (!parsed.ok) {
			await settleAttempt("interrupted", parsed.refusal);
			return {
				kind: "no-diagnosis",
				sessionId: reviewerSessionId,
				failure: parsed.refusal
			};
		}
		const { observation, conclusion, confidence, judgements, proposals } = parsed.diagnosis;
		const current$1 = await ctx.task.snapshotIn(storeId);
		const knownReviews = new Set(current$1.reviews.map(reviewRef));
		const knownEvidence = new Set(current$1.evidence.map((item) => item.evidenceId));
		const knownTasks = new Set(current$1.tasks.map((item) => item.taskId));
		const knownJudgementRefs = new Set([
			...knownReviews,
			...knownEvidence,
			...current$1.reviews.flatMap((item) => item.evidenceRefs),
			...current$1.runs.map((run) => run.sessionId),
			...current$1.reviews.map((item) => item.sessionId)
		]);
		const invalid = [
			...[sourceRef(source), ...parsed.diagnosis.reviewRefs ?? []].filter((ref) => !knownReviews.has(ref)).map((ref) => `reviewRef "${ref}"`),
			...(parsed.diagnosis.evidenceRefs ?? []).filter((ref) => !knownEvidence.has(ref)).map((ref) => `evidenceRef "${ref}"`),
			...(parsed.diagnosis.relatedTaskIds ?? []).filter((id) => !knownTasks.has(id)).map((id) => `relatedTaskId "${id}"`),
			...judgements.flatMap((item) => item.evidenceRefs).filter((ref) => !knownJudgementRefs.has(ref)).map((ref) => `judgement ref "${ref}"`)
		];
		if (invalid.length > 0) {
			const failure = `the diagnosis cites ${invalid.join(", ")} outside store ${storeId}`;
			await settleAttempt("interrupted", failure);
			return {
				kind: "no-diagnosis",
				sessionId: reviewerSessionId,
				failure
			};
		}
		const diagnosis = {
			diagnosisId: `review-agent-${reviewerSessionId}`,
			taskId: source.taskId,
			observedFailure: observation,
			scope: parsed.diagnosis.scope ?? `task ${source.taskId}`,
			localizedCause: conclusion,
			evidenceRefs: parsed.diagnosis.evidenceRefs ?? review.evidenceRefs,
			reviewRefs: [...new Set([sourceRef(source), ...parsed.diagnosis.reviewRefs ?? []])],
			confidence,
			proposals,
			producedBy: {
				kind: "agent",
				sessionId: reviewerSessionId
			},
			...parsed.diagnosis.relatedTaskIds === void 0 ? {} : { relatedTaskIds: parsed.diagnosis.relatedTaskIds },
			...judgements.length === 0 ? {} : { judgements }
		};
		try {
			await ctx.task.recordDiagnosisIn(storeId, diagnosis, actor);
		} catch (error) {
			await settleAttempt("interrupted", `the diagnosis could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
			return {
				kind: "unrecorded",
				sessionId: reviewerSessionId,
				failure: error instanceof Error ? error.message : String(error)
			};
		}
		await settleAttempt("recorded");
		return {
			kind: "recorded",
			sessionId: reviewerSessionId,
			diagnosisId: diagnosis.diagnosisId,
			confidence,
			observation,
			conclusion,
			scope: diagnosis.scope,
			reviewRefs: diagnosis.reviewRefs,
			evidenceRefs: diagnosis.evidenceRefs,
			relatedTaskIds: diagnosis.relatedTaskIds ?? [],
			judgements,
			proposals
		};
	} catch (error) {
		cancel();
		await settleAttempt("interrupted", `the review attempt failed: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	} finally {
		waiting = false;
		resolveCompleted();
		input.signal?.removeEventListener("abort", cancel);
		if (!unloaded) await disposeWait?.();
	}
}

//#endregion
//#region src/tools/review-agent.ts
const DECLARED_PARAMETERS = [
	"taskId",
	"runId",
	"reason",
	"requestKey"
];
/** A free-text argument, or `null` when the caller gave none: empty and whitespace-only read as none. */
function optionalText(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}
/** How one attempt is named in a result, in the words the source's caller uses. */
function attemptLabel(attempt) {
	return attempt.requestKey === null ? "default attempt" : `requestKey "${attempt.requestKey}"`;
}
/** What one attempt the caller asked for already is: its identity, how it ended, and — when it recorded a judgement — the same lines the attempt's own call returned. A repeat is answered from the ledger and the store; */
function renderExistingAttempt(attempt, snapshot) {
	const diagnosis = recordedDiagnosis(snapshot, attempt.sessionId);
	const status = attempt.settlement?.status ?? (diagnosis === void 0 ? "started" : "recorded");
	const head = `task_review_agent: source ${sourceRef(attempt.source)} already has this attempt (${attemptLabel(attempt)}, session ${attempt.sessionId}, ${status}${attempt.settlement?.note === void 0 ? "" : `: ${attempt.settlement.note}`}) — returning it; no review agent started`;
	if (diagnosis === void 0) return status === "interrupted" ? `${head}; a new review for this source needs an explicit requestKey` : `${head}; its diagnosis is not in the store`;
	const lines = [
		head,
		`observation: ${diagnosis.observedFailure}`,
		`conclusion: ${diagnosis.localizedCause}`,
		`scope: ${diagnosis.scope}; related tasks: ${diagnosis.relatedTaskIds?.join(", ") || "none"}`,
		`review refs: ${diagnosis.reviewRefs.join(", ")}; evidence refs: ${diagnosis.evidenceRefs.join(", ") || "none"}`
	];
	if (diagnosis.judgements !== void 0 && diagnosis.judgements.length > 0) lines.push(`judgements (agent ${attempt.sessionId}):`, ...renderJudgements(diagnosis.judgements));
	lines.push(`diagnosis ${diagnosis.diagnosisId} recorded [${diagnosis.confidence}]`);
	if (diagnosis.proposals.length === 0) lines.push("proposals: none — the conclusion carries no suggestion");
	else for (const proposal of diagnosis.proposals) lines.push(`proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`);
	return lines.join("\n");
}
/** What one refusal says, by name, before any claim or spawn exists. */
function renderRefusal(plan, source, storeId) {
	const label = plan.attempt === void 0 ? "" : attemptLabel(plan.attempt);
	if (plan.code === "request-key-conflict") return `task_review_agent: ${plan.attempt.requestKey === null ? `source ${sourceRef(source)} already has a ${label}` : `${label} already names an attempt for source ${sourceRef(source)}`} with a different reason (${JSON.stringify(plan.attempt?.reason ?? null)}); refusing — a key names one review focus and cannot be changed (session ${plan.attempt?.sessionId}); no review agent started`;
	if (plan.code === "request-key-required") {
		const held = plan.attempts.map((attempt) => `${attemptLabel(attempt)} ${attempt.sessionId}`).join(", ");
		return `task_review_agent: source ${sourceRef(source)} was already reviewed (${held}) and this request names no key; a new review for a reviewed source needs an explicit requestKey — no review agent started`;
	}
	return `task_review_agent: budget exhausted (${plan.budget.used}/${plan.budget.max}) for store ${storeId} — no review agent started`;
}
/** What one request that arrived while an attempt was open is answered with. */
function renderOpenAttempt(attempt) {
	return `task_review_agent: source ${sourceRef(attempt.source)} already has an attempt in flight (${attemptLabel(attempt)}, session ${attempt.sessionId}, run by this process right now) — the new request was not accepted; attempts of one source never run in parallel; no review agent started`;
}
/** The answer one attempt ended with, rendered for its caller. */
function renderOutcome(outcome, source, storeId, snapshot, review) {
	switch (outcome.kind) {
		case "refused": return renderRefusal(outcome.plan, source, storeId);
		case "reuse": return renderExistingAttempt(outcome.attempt, snapshot);
		case "in-flight": return renderOpenAttempt(outcome.attempt);
		case "spawn-failed": return `task_review_agent: spawn failed: ${outcome.failure} (source ${sourceRef(source)}, attempt ${outcome.sessionId} recorded interrupted); no review agent started`;
		case "unrecorded": return `task_review_agent: diagnosis produced but not recorded: ${outcome.failure}`;
		case "no-diagnosis": return `task_review_agent: review agent ${outcome.sessionId} ended without a diagnosis — ${outcome.failure} (source ${sourceRef(source)}, attempt ${outcome.sessionId} recorded interrupted); no diagnosis was recorded and nothing was invented from its silence`;
		case "recorded": return [
			`task_review_agent: review agent ${outcome.sessionId} judged task ${source.taskId} (source ${sourceRef(source)}; the review it read settled ${review.outcome})`,
			`observation: ${outcome.observation}`,
			`conclusion: ${outcome.conclusion}`,
			`scope: ${outcome.scope}; related tasks: ${outcome.relatedTaskIds.join(", ") || "none"}`,
			`review refs: ${outcome.reviewRefs.join(", ")}; evidence refs: ${outcome.evidenceRefs.join(", ") || "none"}`,
			...outcome.judgements.length === 0 ? [] : [`judgements (agent ${outcome.sessionId}):`, ...renderJudgements(outcome.judgements)],
			`diagnosis ${outcome.diagnosisId} recorded [${outcome.confidence}]`,
			...outcome.proposals.length === 0 ? ["proposals: none — the conclusion carries no suggestion"] : [`proposals (${outcome.proposals.length}, suggestions only — none auto-executes):`, ...outcome.proposals.map((item) => `- ${item.targetType} ${item.targetId}: ${item.rationale}`)]
		].join("\n");
	}
}
function defineTaskReviewAgentTool(ctx) {
	return defineTool({
		name: "task_review_agent",
		description: "Spawn ONE read-only review agent for one exact review source — a task and the run under review, or runId null for a review that carries no run (a task blocked before it started) — take the diagnosis it produces, and persist it as a Diagnosis. The reviewer reads the review pack and, beyond it, whatever settles the question through its own context reads. What it returns is an observation (the postmortem observation — what really happened, for a successful source as much as a failed one), a conclusion in its own words (\"no improvement needed\" and \"the evidence does not settle this\" are conclusions), a confidence, and — only when it made them — judgements and proposals. A judgement names one of the dimensions no parser settles (task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency) with verdict adequate|inadequate|unknown, the refs it rests on and a rationale; judgements are optional and never padded, and a judgement that cites nothing is refused rather than downgraded. A proposal is a suggestion only: it names a target type the diagnosis does not freeze, and nothing here executes it. reason names what the review should focus on. A reviewer that is cancelled or answers without a diagnosis leaves an interrupted attempt with the reason named and records no Diagnosis. One source has one default attempt: a repeat of the same call returns that attempt and its result instead of starting another, and never spends the budget again. Reviewing the same source again after that attempt ended is an explicit act: pass a new non-empty requestKey, which is persisted with the source and the focus; the same key with a different reason is refused. While an attempt of the source is in flight the call returns its identity and starts nothing. The reviewer has no write, shell, spawn, or evolution tool and is capped per root store (default 8).",
		parameters: {
			taskId: {
				type: "string",
				required: true,
				description: "Task whose review needs judgement"
			},
			runId: {
				oneOf: [{ type: "string" }, { type: "null" }],
				required: true,
				description: "The Run under review, exactly as its review record names it; null selects a review with no run"
			},
			reason: {
				type: "string",
				description: "Optional non-empty free text: what this review should focus on"
			},
			requestKey: {
				type: "string",
				description: "Optional non-empty key for an explicit further review of the same source; omit for the source's default attempt"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, DECLARED_PARAMETERS, "task_review_agent");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "task_review_agent");
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(caller)).rootSessionId);
			const source = {
				taskId: args.taskId,
				runId: args.runId
			};
			const snapshot = await ctx.task.openStore(storeId);
			if (snapshot.tasks.find((item) => item.taskId === args.taskId) === void 0) return `task_review_agent: unknown task "${args.taskId}" in store ${storeId} (the caller's graph root); no review agent started`;
			if (args.runId !== null && !snapshot.runs.some((run) => run.runId === args.runId && run.taskId === args.taskId)) return `task_review_agent: run "${args.runId}" is not a run of task "${args.taskId}"; no review agent started`;
			const review = reviewForSource(snapshot, source);
			if (review === void 0) return `task_review_agent: no review record for source ${sourceRef(source)} in store ${storeId}; no review agent started`;
			return renderOutcome(await runReviewAgentAttempt({
				ctx,
				storeId,
				source,
				review,
				parent: exec.agent,
				actor: caller,
				requestKey: optionalText(args.requestKey),
				reason: optionalText(args.reason),
				signal: exec.signal
			}), source, storeId, snapshot, review);
		}
	});
}

//#endregion
//#region src/tools/task-status.ts
function defineTaskStatusTool(ctx) {
	return defineTool({
		name: "task_status",
		description: "The caller's project status, paged. Scope `related` (the default) covers the caller's own task, its direct children and the tasks directly adjacent to it through a dependency edge; scope `graph` lists the caller's readable domain, sorted by task id. Workers remain within their task branch, ancestor context and dependency neighbours; valid delegated reviewers and supervisors can investigate their whole graph read-only. Each line carries the task status, its latest run with its coordination phase (a phase-less non-terminal run reads needs-recovery), evidence ids, the terminal review outcome and the diagnosis count. Entries are sorted by task id and paged with `offset` (from 0) and `limit` (default 20, at most 100); the answer states whether more entries follow and the offset to continue with. Pages are observations, not a consistent snapshot across calls. Before any root contract has been accepted the answer is the named not-activated state (with whatever proposal is still open).",
		parameters: {
			scope: {
				type: "string",
				enum: ["related", "graph"],
				description: "related (default): own task, direct children and dependency neighbours; graph: readable branch for workers, whole graph for roots and valid delegated coordination agents"
			},
			offset: {
				type: "number",
				description: "Entry offset to start the page at, from 0; default 0"
			},
			limit: {
				type: "number",
				description: "Entries per page; default 20, clamped into 1–100 (a clamp is stated in the answer)"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "task_status");
			return adaptRead("task_status", await ctx.singularityContext.taskStatus(caller, {
				...args.scope === void 0 ? {} : { scope: args.scope },
				...args.offset === void 0 ? {} : { offset: args.offset },
				...args.limit === void 0 ? {} : { limit: args.limit }
			}, exec.signal));
		}
	});
}

//#endregion
//#region src/tools/task-submit-result.ts
function defineTaskSubmitResultTool(ctx) {
	return defineTool({
		name: "task_submit_result",
		description: "Hand in this run's result for acceptance. This is the explicit submission the coordination protocol is built on: it records what was delivered (summary, plus the evidence/artifact references you produced), closes admission for this run — no further write, command or decomposition is admitted — drains the calls still in flight, and hands the run to the verifier. The call returns the verdict. An idle session is not a completion: a worker that goes idle without submitting gets one reminder. A run waiting on its own child batch cannot submit; the batch end hands the run back to `active` with nothing submitted for it, and that submission is then yours to make.",
		parameters: {
			summary: {
				type: "string",
				required: true,
				description: "What was delivered, in your own words; a blank summary is refused"
			},
			evidenceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Evidence ids, artifact refs or review refs you name as proof of the summary"
			},
			notes: {
				type: "string",
				description: "Anything further a reader of the submission should know"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId(exec, "task_submit_result");
			let result;
			try {
				result = await ctx.taskRuntime.submitResult(caller, args, { ...typeof exec.callId === "string" && exec.callId.length > 0 ? { callId: String(exec.callId) } : {} });
			} catch (error) {
				return `task_submit_result rejected: ${message(error)}`;
			}
			return `task_submit_result ${result.status}: ${result.detail}`;
		}
	});
}

//#endregion
//#region src/tools/task-verify.ts
function defineTaskVerifyTool(ctx) {
	return defineTool({
		name: "task_verify",
		description: "Self-check: re-run the verifier against the caller's current task run, record the resulting evidence bundle in the task store, and report per-criterion results. Records evidence but no task status; only valid while the run is running — calling it on a finished run returns an error.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (_args, exec) => {
			const caller = sessionId(exec, "task_verify");
			const verifier = ctx.get("verifier");
			if (verifier === void 0 || typeof verifier.verifyRun !== "function") throw new Error("task_verify: verifier service is not loaded");
			const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller);
			if (run.status !== "running") return `task_verify: run ${run.runId} of task ${task.taskId} is ${run.status}; evidence can only be recorded while the run is running`;
			const cwd = await ctx.taskRuntime.envPathForSession(caller);
			const timeoutMs = ctx.taskRuntime.verifyTimeoutMs;
			if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`task_verify: task runtime exposes no positive verifyTimeoutMs (got ${String(timeoutMs)}); refusing to run the verifier without a deadline`);
			const bundle = await verifier.verifyRun(storeId, run.runId, {
				...cwd === void 0 ? {} : { cwd },
				timeoutMs
			});
			return [`run ${run.runId} of task ${task.taskId}: evidence ${bundle.evidenceId} (self-check, status unchanged)`, ...bundle.verifierResults.map((result) => {
				const command = result.command === void 0 ? "" : ` — $ ${result.command}`;
				const exit = result.exitCode === void 0 ? "" : ` exit ${result.exitCode}`;
				const details = result.details === void 0 ? "" : ` (${result.details})`;
				return `- ${result.criterionId}: ${result.status} by ${result.verifierId}${command}${exit}${details}`;
			})].join("\n");
		}
	});
}

//#endregion
//#region src/index.ts
/** The shipped switch position: `off`. */
const DEFAULT_EVOLUTION = "off";
const Supervision = z.object({ coordinationBudget: z.number().default(DEFAULT_SUPERVISION.coordinationBudget) });
const ConfigSchema = z.object({
	evolution: z.union([z.const("off"), z.const("on")]).default(DEFAULT_EVOLUTION),
	supervision: Supervision.default({ ...DEFAULT_SUPERVISION })
});
/** The evolution exposure this composition resolved, provided on the agent's own fiber as `ctx.singularityEvolution`. */
var EvolutionExposure = class extends Service {
	/** `true` when `Config.evolution` is `on`, i.e. the nine `evolution_*` tools are registered. */
	enabled;
	constructor(ctx, enabled) {
		super(ctx, "singularityEvolution");
		this.enabled = enabled;
	}
};
/** The supervision policy this composition resolved, provided on the agent's own fiber as `ctx.singularitySupervision` — the coordination allowance the ledger reads, and the per-store round cap the task runtime's recovery entry reads. */
var SupervisionExposure = class extends Service {
	coordinationBudget;
	constructor(ctx, policy) {
		super(ctx, "singularitySupervision");
		this.coordinationBudget = policy.coordinationBudget;
	}
	/**
	* The round cap in force for one store: the round count its graph's RSI
	* settings declare when that graph runs a platform loop (the driver registers
	* it — see `coordination/rsi-loop.ts`), `undefined` otherwise, so the
	* runtime's own constant stands for every store without one. The runtime's
	* `iteration-cap` check reads this per store, so a graph-scheduled loop may
	* open exactly the rounds its graph names — and since the driver is the only
	* caller that opens a round any more, the same answer governs its recoveries.
	*/
	maxImprovementRoundsFor(storeId) {
		return graphImprovementCap(storeId);
	}
	/** The recovery-round cap in force for one store: the graph's own round count for a driver-scheduled store, `undefined` otherwise (the runtime's constant then stands). */
	maxRecoveryRoundsFor(storeId) {
		return graphImprovementCap(storeId);
	}
};
/** The harness repo root this composition passes to the evolution ledger: the base of its `$DSH_HOME` fallback (`<repoRoot>/.dsh`), of the production `config.yml` default, and of relative evidence refs. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** The model selection the evolution plane freezes with an experiment and re-reads before a promotion (see `Config.modelSelection` of the evolution service). */
function deploymentModelSelection(ctx) {
	return modelSelectionOf(optionalService(ctx, "agentDefaultModel")?.currentSelection());
}
var SingularityAgent = class extends Service {
	static inject = [
		"tools",
		"graphs",
		"agentRuntime",
		"task",
		"taskRuntime",
		"singularityContext",
		"userQuestions",
		"approval"
	];
	static Config = ConfigSchema;
	/** The evolution ledger this assembly owns — kept as a field because the startup reconciliation (`[Service.init]`, below) settles its open commit intents before this plugin becomes ready, whether or not. */
	evolution;
	constructor(ctx, config) {
		super(ctx, "singularityAgent");
		this.assertClosedConfig(config);
		const supervision = configureSupervision(config?.supervision);
		const evolution = config?.evolution ?? DEFAULT_EVOLUTION;
		ctx.plugin(HitlService);
		this.evolution = new EvolutionService(ctx, {
			repoRoot: REPO_ROOT,
			modelSelection: () => deploymentModelSelection(ctx),
			capabilityConfig: join(REPO_ROOT, "config.yml")
		});
		new EscalationService(ctx);
		new ProposalReviewService(ctx);
		new EvolutionExposure(ctx, evolution === "on");
		new SupervisionExposure(ctx, supervision);
		ctx.effect(() => ctx.singularityContext.registerCoordinationBindingSource(reviewerBindingSource()), "singularityAgent: coordination binding source");
		ctx.effect(() => installRsiLoopDriver(ctx), "singularityAgent: rsi loop driver");
		ctx.effect(() => ctx.taskRuntime.registerRootBudgetApproval(defineRootBudgetApproval(ctx)), "singularityAgent: root budget approval");
		ctx.tools.register(defineMarkReadyTool(ctx));
		ctx.tools.register(defineSpawnTool(ctx));
		ctx.tools.register(defineAskTool(ctx));
		ctx.tools.register(defineApproveTool(ctx));
		ctx.tools.register(defineTaskReadTool(ctx));
		ctx.tools.register(defineCapabilityListTool(ctx));
		ctx.tools.register(defineTaskLibraryTool(ctx));
		ctx.tools.register(defineTaskTemplateListTool(ctx));
		ctx.tools.register(defineContextReadTool(ctx));
		ctx.tools.register(defineTaskIntakeTool(ctx));
		ctx.tools.register(defineTaskDecomposeTool(ctx));
		ctx.tools.register(defineTaskProposalReadTool(ctx));
		ctx.tools.register(defineTaskProposalContinueTool(ctx));
		ctx.tools.register(defineTaskProposalCancelTool(ctx));
		ctx.tools.register(defineTaskStatusTool(ctx));
		ctx.tools.register(defineTaskSubmitResultTool(ctx));
		ctx.tools.register(defineTaskAskParentTool(ctx));
		ctx.tools.register(defineTaskAnswerTool(ctx));
		ctx.tools.register(defineTaskCancelTool(ctx));
		ctx.tools.register(defineTaskVerifyTool(ctx));
		ctx.tools.register(defineTaskReviewPackTool(ctx));
		ctx.tools.register(defineTaskReviewAgentTool(ctx));
		ctx.tools.register(defineTaskBudgetExtendTool(ctx));
		ctx.tools.register(defineTaskDiagnoseTool(ctx));
		if (evolution === "on") {
			ctx.tools.register(defineEvolutionProposeTool(ctx));
			ctx.tools.register(defineEvolutionCandidateTool(ctx));
			ctx.tools.register(defineEvolutionPrepareTool(ctx));
			ctx.tools.register(defineEvolutionReplayTool(ctx));
			ctx.tools.register(defineEvolutionGateTool(ctx));
			ctx.tools.register(defineEvolutionDecideTool(ctx));
			ctx.tools.register(defineEvolutionApplyTool(ctx));
			ctx.tools.register(defineEvolutionRollbackTool(ctx));
			ctx.tools.register(defineEvolutionListTool(ctx));
		}
		ctx.tools.register(defineEscalateTool(ctx));
	}
	/** The startup reconciliation (K2): before this plugin is ready — and whatever the tool switch says — every commit intent the ledger left open is settled against what production actually holds. */
	async [Service.init]() {
		let outcomes;
		try {
			outcomes = await this.evolution.reconcile();
		} catch (error) {
			throw new Error(`singularity-agent: the evolution ledger could not be reconciled at startup (${error instanceof Error ? error.message : String(error)}); refusing to become ready with an unreconciled production commit rather than serving a deployment whose production may not match its ledger`);
		}
		for (const outcome of outcomes) {
			if (outcome.result !== "blocked") continue;
			this.warn(`evolution: the commit intent "${outcome.intentId}" (${outcome.direction} of proposal "${outcome.proposalId}") targeting ${outcome.targets.join(", ")} could not be settled — ${outcome.detail ?? "no reason reported"}`);
		}
	}
	/** Refuse a configuration member this plugin does not read. The schema keeps unknown keys on the object it validates, so this is where a caller's typo is caught: */
	assertClosedConfig(config) {
		if (config === void 0) return;
		const known = new Set(["evolution", "supervision"]);
		const unknown = Object.keys(config).filter((key) => !known.has(key));
		if (unknown.length > 0) throw new Error(`singularity-agent: the configuration names [${unknown.join(", ")}], which this plugin does not read; a member nobody reads refuses to start rather than being silently ignored`);
		const supervision = config.supervision;
		if (supervision === void 0) return;
		const knownSupervision = new Set(["coordinationBudget"]);
		const unknownSupervision = Object.keys(supervision).filter((key) => !knownSupervision.has(key));
		if (unknownSupervision.length === 0) return;
		throw new Error(`singularity-agent: the supervision configuration names [${unknownSupervision.join(", ")}], which this plugin does not read; a member nobody reads refuses to start rather than being silently ignored`);
	}
	/** Report a fact nobody should read as a startup failure — the same soft logger the task runtime uses, so a deployment that mounts no logger still gets the line rather than an exception about it. */
	warn(message$1) {
		logOf(this.ctx, "singularity-agent")?.warn(message$1);
	}
};
var src_default = SingularityAgent;

//#endregion
export { DEFAULT_EVOLUTION, DEFAULT_SUPERVISION, EscalationService, HitlService, ProposalReviewService, SingularityAgent, src_default as default, deploymentModelSelection };