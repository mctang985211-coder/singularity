import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { TOOL_LABELS, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, bubbleWorkspacePath, executionUsage, materializeBubble, optionalService, readEnvironmentDraft, readRevision, recoveryAttemptWithKey, settleBubble, workerBaseline } from "@dangosys/dsh-singularity-task-runtime";
import { DEFAULT_STRATEGY_POLICY, EvolutionService, OUTCOME_JUDGE_PROMPT, adapterFor, admit, aggregateEvaluation, assertOutcomePlan, calibrateNoise, canonicalJson, cohortDigestOf, createDraft, digestOf, discardDraft, editBudget, evaluate, evaluationOf, evaluationSourcesOf, exploration, foldHistory, foldMethods, markPublished, markRolledback, methodList, modelSelectionOf, openMethodLedger, refutationFor, renderHistory, revisionViewOf, scaleOf, screenBeforeMeasurement, sideMeasurementOf, stallFlag, strategyDecisionOf, validateEvaluation } from "@dangosys/dsh-singularity-evolution";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, canonicalize, isTerminalRunStatus, rootTaskStoreId, sha256Hex } from "@dangosys/dsh-singularity-task";
import { homedir } from "node:os";
import { CONTEXT_OUTPUT_LIMIT_BYTES, CoordinationBindingError, OutputBudget, budgetList, utf8Bytes } from "@dangosys/dsh-singularity-context";
import { SessionId } from "@deepseek-ai/dsh-session";
import { graphAccess, graphAgentOptions } from "@dangosys/dsh-singularity-graphs";
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
	const lines$1 = entries.map(([name, entry]) => {
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
		...lines$1,
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
* (`coordination/driver.ts`) registers a store when it takes the graph's loop
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
//#region src/coordination/store.ts
/** The only row format this build reads. */
const COORDINATION_FORMAT_VERSION = 1;
/** How many times one work item may be re-assigned after an infrastructure failure (`interrupted`). */
const MAX_ASSIGNMENT_ATTEMPTS = 3;
/** The directory this deployment's coordination file lives in. `SINGULARITY_COORDINATION_DIR` wins over `$DSH_HOME`. */
function coordinationDir() {
	const override = process.env.SINGULARITY_COORDINATION_DIR;
	if (override !== void 0 && override.length > 0) return resolve(override);
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "coordination");
}
/** The coordination file itself. */
function coordinationFile() {
	return join(coordinationDir(), "assignments.jsonl");
}
/** The per-store cap on coordination runs: env `SINGULARITY_COORDINATION_BUDGET` wins, then the deployment's policy. */
function coordinationBudget() {
	const raw = process.env.SINGULARITY_COORDINATION_BUDGET;
	const parsed = raw === void 0 || raw.length === 0 ? NaN : Number(raw);
	if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
	return supervisionSettings().coordinationBudget || DEFAULT_SUPERVISION.coordinationBudget;
}
/** One parsed row; an unrecognized version or kind is refused by name. */
function asRow(parsed, line) {
	const row = parsed;
	if (row.formatVersion !== COORDINATION_FORMAT_VERSION || row.kind !== "assignment" && row.kind !== "completion") throw new Error(`coordination-store: unrecognized row ${line} in ${coordinationFile()}`);
	return parsed;
}
/** Every row, or `undefined` when the file has never been written. A corrupt line throws by name. */
async function readCoordinationRows() {
	let text$1;
	try {
		text$1 = await readFile(coordinationFile(), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	const rows = [];
	text$1.split("\n").forEach((line, index) => {
		if (line.trim().length === 0) return;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`coordination-store: corrupt line ${index + 1} in ${coordinationFile()}`);
		}
		rows.push(asRow(parsed, index + 1));
	});
	return rows;
}
function isAssignment(row) {
	return row.kind === "assignment";
}
/** The completion one session recorded, if any — the first one is the only one written. */
function completionOf(rows, sessionId$1) {
	return rows.find((row) => row.kind === "completion" && row.sessionId === sessionId$1);
}
/** The rows-only projection of {@link coordinatedWork}, for callers that already hold the rows. */
function workOf(rows, graphId) {
	const mine = rows.filter((row) => row.graphId === graphId);
	const work = [];
	for (const row of mine) {
		if (!isAssignment(row)) continue;
		const completion = completionOf(mine, row.sessionId);
		work.push({
			assignment: row,
			...completion === void 0 ? {} : { completion }
		});
	}
	return work;
}
/** Every work item of one graph's key space, newest assignment last. */
function assignmentsForKey(rows, key) {
	return rows.filter(isAssignment).filter((row) => row.graphId === key.graphId && row.epoch === key.epoch && row.role === key.role && sameSubject(row.subject, key.subject));
}
/** Whether two subjects name the same work item. */
function sameSubject(left, right) {
	if (left.kind !== right.kind) return false;
	if (left.kind === "round" && right.kind === "round") return left.businessRound === right.businessRound && left.searchRound === right.searchRound && left.source.taskId === right.source.taskId && left.source.runId === right.source.runId;
	if (left.kind === "review" && right.kind === "review") return left.businessRound === right.businessRound && left.source.taskId === right.source.taskId && left.source.runId === right.source.runId && left.requestKey === right.requestKey;
	return false;
}
/** The completion one assignment settled with, from the rows alone. */
function completionFor(rows, sessionId$1) {
	return completionOf(rows, sessionId$1);
}
/** fsync one directory, so a freshly created file's name survives a crash. */
async function syncDir(dir) {
	const handle = await open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
/** The directories this process has already fsynced after creating a file in them. */
const syncedDirs = /* @__PURE__ */ new Set();
/** Append one row and flush it to the device before returning; the first write also fsyncs its directory. */
async function appendRow(row) {
	const file = coordinationFile();
	const dir = dirname(file);
	await mkdir(dir, { recursive: true });
	const firstWrite = !syncedDirs.has(dir);
	await appendFile(file, `${JSON.stringify(row)}\n`, {
		encoding: "utf8",
		flush: true
	});
	if (firstWrite) {
		await syncDir(dir);
		syncedDirs.add(dir);
	}
}
/**
* Persist one assignment. Returns only after the row is on the device, which is
* what makes "claim before spawn" a real order rather than a hoped-for one.
*/
async function appendAssignment(assignment) {
	await appendRow(assignment);
}
/** Persist one completion, then wake this process's driver. */
async function recordCompletion(completion) {
	await appendRow(completion);
	for (const listener of listeners) try {
		listener(completion);
	} catch {}
}
/** The serial regions, one promise chain per graph: decisions and writes never interleave inside one graph. */
const regions = /* @__PURE__ */ new Map();
/** Run one piece of work inside a graph's serial region, after everything already queued for it. */
async function serializeCoordination(graphId, work) {
	const result = (regions.get(graphId) ?? Promise.resolve()).then(work);
	const tail = result.then(() => void 0, () => void 0);
	regions.set(graphId, tail);
	tail.then(() => {
		if (regions.get(graphId) === tail) regions.delete(graphId);
	});
	return result;
}
/** This process's completion listeners — the driver's first wake-up source. */
const listeners = /* @__PURE__ */ new Set();
/** Every assignment of one session, as the binding read needs them. */
function assignmentsOfSession(rows, sessionId$1) {
	return rows.filter(isAssignment).filter((row) => row.sessionId === sessionId$1);
}
/**
* Read the caller's coordination identity by session id. Two assignments of one
* session that disagree about what the session is (a different graph, store,
* role or subject) is a conflict and is refused, never resolved by picking one.
*/
async function readCoordinationBinding(sessionId$1) {
	let rows;
	try {
		rows = await readCoordinationRows();
	} catch (error) {
		throw new CoordinationBindingError("unreadable", `the coordination store cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const mine = assignmentsOfSession(rows ?? [], sessionId$1);
	const first = mine[0];
	if (first === void 0) return void 0;
	if (mine.some((row) => row.graphId !== first.graphId || row.storeId !== first.storeId || row.epoch !== first.epoch || row.role !== first.role || !sameSubject(row.subject, first.subject))) throw new CoordinationBindingError("binding-conflict", `session "${sessionId$1}" is recorded under more than one coordination assignment: ` + mine.map((row) => `${row.role} of ${row.graphId} in ${row.storeId} (by ${row.actor})`).join("; "));
	const completion = completionOf(rows ?? [], sessionId$1);
	return {
		graphId: first.graphId,
		rootStoreId: first.storeId,
		epoch: first.epoch,
		role: first.role,
		subject: first.subject,
		sourceTaskId: first.subject.source.taskId,
		sourceRunId: first.subject.source.runId,
		sessionId: sessionId$1,
		actor: first.actor,
		at: first.at,
		completed: completion !== void 0
	};
}
/** The ledger row as the context package's binding wire: the wide shape narrowed to the seam it reads. */
async function coordinationBindingOf(sessionId$1) {
	const binding = await readCoordinationBinding(sessionId$1);
	if (binding === void 0) return void 0;
	return {
		role: binding.role,
		sourceTaskId: binding.sourceTaskId,
		sourceRunId: binding.sourceRunId,
		actor: binding.actor,
		rootStoreId: binding.rootStoreId,
		at: binding.at
	};
}
/** The binding source this deployment registers into the context service. */
function coordinationBindingSource() {
	return { read: coordinationBindingOf };
}

//#endregion
//#region src/coordination/rounds.ts
/** The store's own root task: the one task that never had a parent. */
function rootTaskOf(snapshot) {
	return snapshot.tasks.find((task) => task.parentTaskId === void 0);
}
/**
* Every terminal-settled run of the root task, oldest first — the store's own
* count of business rounds. A round is a settled attempt, verified or not.
*/
function terminalRootRuns(snapshot, rootTaskId) {
	return snapshot.runs.filter((run) => run.taskId === rootTaskId && isTerminalRunStatus(run.status)).sort((left, right) => left.startedAt < right.startedAt ? -1 : left.startedAt > right.startedAt ? 1 : left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0);
}
/** The run one round opened, read from the store's own attempt record by its request key. */
function roundRunOf(snapshot, rootTaskId, requestKey) {
	return recoveryAttemptWithKey(snapshot, rootTaskId, requestKey);
}
/** The platform diagnosis one round's run is recorded under: the epoch is in the id, so a restart is a new round. */
function roundDiagnosisId(graphId, epoch, businessRound) {
	return `rsi-${graphId}-e${epoch}-round-${businessRound}`;
}
/** The request key that opens one round. One key names one attempt. */
function roundRequestKey(graphId, epoch, businessRound) {
	return `rsi-${graphId}-e${epoch}-round-${businessRound}`;
}
/**
* The platform's own diagnosis for one round. `proposals: []` says the driver
* records no suggestion — the supervisor investigates; the diagnosis exists so
* the next round's recovery has a store record to name.
*/
function roundDiagnosis(input) {
	const verified = input.run.status === "verified";
	const finalRound = input.businessRound >= input.rounds;
	return {
		diagnosisId: input.diagnosisId,
		taskId: input.taskId,
		observedFailure: verified ? `Round ${input.businessRound} of graph "${input.graphName}" (${input.graphId}) verified: the root task's run "${input.run.runId}" settled verified under the store's own acceptance criteria.` : input.review?.localizedCause ?? `Round ${input.businessRound} of graph "${input.graphName}" (${input.graphId}) settled ${input.run.status}: the root task's run "${input.run.runId}" did not pass the store's own acceptance criteria.`,
		scope: `the root task ${input.taskId} of this store; graph ${input.graphId} runs a platform RSI loop of ${input.rounds} round(s)`,
		localizedCause: finalRound ? `The platform RSI loop reviews round ${input.businessRound}'s library experience before completing this graph: ${input.objective}.` : verified ? `The platform RSI loop continues this graph's verified goal with round ${input.businessRound + 1}: ${input.objective}.` : `The platform RSI loop hands round ${input.businessRound}'s ${input.run.status} attempt to its supervisor, which investigates the cause and prepares the method change round ${input.businessRound + 1} (mode "recovery") consumes: ${input.objective}.`,
		evidenceRefs: input.review?.evidenceRefs ?? [],
		reviewRefs: [`${input.taskId}#${input.run.runId}`],
		confidence: "high",
		proposals: [],
		producedBy: {
			kind: "agent",
			sessionId: input.producedBySessionId
		}
	};
}

//#endregion
//#region src/coordination/facts-reader.ts
/** The completion facts one row carries, in the wire shape the read model reduces. */
function completionFacts(row) {
	if (row.kind !== "completion" || row.result.kind !== "completed") return void 0;
	const result = row.result;
	return {
		businessAction: result.businessAction,
		searchNext: result.searchNext,
		methodDecision: result.methodDecision,
		reason: result.reason,
		evidenceRefs: result.evidenceRefs,
		...result.trialCandidateRef === null ? {} : { trialCandidateRef: result.trialCandidateRef },
		...result.approval === void 0 ? {} : { approval: {
			kind: result.approval.source,
			actor: result.approval.ref
		} },
		at: row.at
	};
}
/** One work item's state in the read model's vocabulary. */
function stateOf(work) {
	const completion = work.completion;
	if (completion === void 0) return "open";
	return completion.result.kind === "completed" || completion.result.kind === "reviewed" ? "settled" : "interrupted";
}
/**
* The round work items one store holds, as the read model reduces them. A review
* work item is not a round: it is read through `workForDiagnosis` and the review
* pack, never counted into the round a graph reports.
*/
function assignmentFactsOf(rows, storeId) {
	const graphIds = [...new Set(rows.filter((row) => row.storeId === storeId).map((row) => row.graphId))];
	const facts = [];
	for (const graphId of graphIds) for (const work of workOf(rows, graphId)) {
		const assignment = work.assignment;
		if (assignment.storeId !== storeId || assignment.role !== "supervisor") continue;
		if (assignment.subject.kind !== "round") continue;
		const completion = work.completion === void 0 ? void 0 : completionFacts(work.completion);
		facts.push({
			assignmentId: assignment.sessionId,
			role: "supervisor",
			round: assignment.subject.businessRound,
			sessionId: assignment.sessionId,
			sourceTaskId: assignment.subject.source.taskId,
			sourceRunId: assignment.subject.source.runId,
			state: stateOf(work),
			...completion === void 0 ? {} : { completion }
		});
	}
	return facts.sort((left, right) => left.round < right.round ? -1 : left.round > right.round ? 1 : 0);
}
/** The read model's one coordination fact producer, read straight from the store. */
function coordinationFactsReader() {
	return { async assignments(graphKey) {
		return assignmentFactsOf(await readCoordinationRows() ?? [], graphKey);
	} };
}
/** The diagnosis id one round assignment is supervised under, or `undefined` for a review assignment. */
function diagnosisIdOf(assignment) {
	if (assignment.subject.kind !== "round") return void 0;
	return roundDiagnosisId(assignment.graphId, assignment.epoch, assignment.subject.businessRound);
}
/** The review work items of one exact source, filtered from work a caller already read. */
function workOfSource(work, source) {
	return work.filter((item) => {
		const subject = item.assignment.subject;
		if (subject.kind !== "review") return false;
		return subject.source.taskId === source.taskId && subject.source.runId === source.runId;
	});
}

//#endregion
//#region src/coordination/assignment.ts
/** Whether two keys name the same work item. */
function sameCoordinationKey(left, right) {
	return left.graphId === right.graphId && left.epoch === right.epoch && left.role === right.role && sameSubjectOf(left, right);
}
function sameSubjectOf(left, right) {
	const a = left.subject;
	const b = right.subject;
	if (a.kind !== b.kind) return false;
	if (a.kind === "round" && b.kind === "round") return a.businessRound === b.businessRound && a.searchRound === b.searchRound && a.source.taskId === b.source.taskId && a.source.runId === b.source.runId;
	if (a.kind === "review" && b.kind === "review") return a.businessRound === b.businessRound && a.source.taskId === b.source.taskId && a.source.runId === b.source.runId && a.requestKey === b.requestKey;
	return false;
}
/** The canonical digest of one work item: graph, epoch, role and subject, and nothing else. */
function subjectDigest(key) {
	return sha256Hex(canonicalize({
		graphId: key.graphId,
		epoch: key.epoch,
		role: key.role,
		subject: key.subject
	}));
}
/** One work item's readable name, for logs, refusals and progress notes. */
function keyLabel(key) {
	const subject = key.subject;
	const described = subject.kind === "round" ? `round ${subject.businessRound}` : `review of ${subject.source.taskId}#${subject.source.runId ?? "no-run"}`;
	return `${key.role} of graph ${key.graphId} (epoch ${key.epoch}) for ${described}`;
}
/** The row one new attempt is persisted as, before anything is spawned for it. */
function assignmentOf(request, at) {
	return {
		formatVersion: 1,
		kind: "assignment",
		graphId: request.key.graphId,
		storeId: request.storeId,
		epoch: request.key.epoch,
		role: request.key.role,
		subject: request.key.subject,
		sessionId: String(request.sessionId),
		actor: request.actor,
		digest: request.digest,
		...request.model === void 0 ? {} : { model: request.model },
		at
	};
}
/** One assignment's last completion, when it has one. */
function settledWork(rows, assignment) {
	const completion = completionFor(rows, assignment.sessionId);
	return completion === void 0 ? void 0 : {
		assignment,
		completion
	};
}
/**
* Decide one key's application from the rows it already has, what DSH knows
* about its sessions and what the store has spent. The decision is the whole
* state machine of "may this key run now, wait, resume, or never again".
*/
function planAssignment(input) {
	const { request, rows, sessions, budget } = input;
	const mine = assignmentsForKey(rows, request.key);
	const last = mine.at(-1);
	if (last === void 0) {
		if (budget.used >= budget.max) return {
			kind: "refused",
			code: "budget-exhausted",
			detail: `store ${request.storeId} has spent its whole coordination allowance (${budget.used}/${budget.max})`
		};
		return { kind: "assign" };
	}
	if (last.storeId !== request.storeId || last.role !== request.key.role) return {
		kind: "refused",
		code: "role-mismatch",
		detail: `${keyLabel(request.key)} is recorded for ${last.role} of store ${last.storeId}`,
		work: { assignment: last }
	};
	if (last.digest !== request.digest) return {
		kind: "refused",
		code: "subject-conflict",
		detail: `${keyLabel(request.key)} already names a work item with another subject digest (${last.digest.slice(0, 19)}…) — a key names one work item and its contents cannot be changed`,
		work: { assignment: last }
	};
	const settled = settledWork(rows, last);
	if (settled !== void 0 && settled.completion.result.kind !== "interrupted") return {
		kind: "reuse",
		work: settled
	};
	if (settled !== void 0) {
		if (mine.length >= MAX_ASSIGNMENT_ATTEMPTS) return {
			kind: "refused",
			code: "attempts-exhausted",
			detail: `${keyLabel(request.key)} never reached model input ${MAX_ASSIGNMENT_ATTEMPTS} times (${settled.completion.result.detail}); the platform does not ask again`,
			work: settled
		};
		return { kind: "assign" };
	}
	const facts = sessions.get(last.sessionId);
	if (facts === void 0 || facts.presence === "missing") return {
		kind: "assign",
		reuseSessionId: last.sessionId
	};
	if (facts.presence === "stored" && !facts.turnClosed) return {
		kind: "resume",
		work: { assignment: last }
	};
	return {
		kind: "in-flight",
		work: { assignment: last }
	};
}

//#endregion
//#region src/coordination/completion.ts
/** A non-empty string, or nothing. */
function textOf(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
/** The refs a store can resolve: reviews by `taskId#runId`, evidence bundles by id, criteria by id. */
function knownReferences(snapshot) {
	const known = /* @__PURE__ */ new Set();
	for (const review of snapshot.reviews) known.add(reviewRef(review));
	for (const evidence of snapshot.evidence) known.add(evidence.evidenceId);
	for (const task of snapshot.tasks) for (const criterion of task.acceptanceCriteria) known.add(criterion.criterionId);
	return known;
}
/** The refs a judgement may cite: the recorded reviews, evidence, sessions and review lineage already on the store. */
function knownJudgementReferences(snapshot) {
	const known = new Set(knownReferences(snapshot));
	for (const review of snapshot.reviews) for (const ref of review.evidenceRefs) known.add(ref);
	for (const run of snapshot.runs) if (run.sessionId !== void 0) known.add(run.sessionId);
	for (const review of snapshot.reviews) if (review.sessionId !== void 0) known.add(review.sessionId);
	return known;
}
/** Validate a supervisor's completion: the payload's own shape, and the evidence it rests on. */
function validateSupervisorCompletion(input) {
	const { payload, snapshot, binding } = input;
	if (payload.businessAction !== "continue" && payload.businessAction !== "recover" && payload.businessAction !== "finish") return {
		ok: false,
		refusal: `businessAction "${String(payload.businessAction)}" is not continue | recover | finish`
	};
	const reason = textOf(payload.reason);
	if (reason === void 0) return {
		ok: false,
		refusal: "reason must be non-empty free text"
	};
	if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length === 0) return {
		ok: false,
		refusal: "evidenceRefs must name at least one recorded reference"
	};
	if (payload.trialCandidateRef !== void 0 && textOf(payload.trialCandidateRef) === void 0) return {
		ok: false,
		refusal: "trialCandidateRef must be a non-empty candidate id, or omitted"
	};
	if (binding.subject.kind !== "round") return {
		ok: false,
		refusal: "this session was not assigned a round; supervisor_complete concludes a round"
	};
	if (snapshot.runs.find((candidate) => candidate.runId === binding.subject.source.runId) === void 0) return {
		ok: false,
		refusal: `this session's assigned source run "${binding.sourceRunId ?? "(none)"}" is not in store ${binding.rootStoreId}`
	};
	const known = knownReferences(snapshot);
	const unknown = [...new Set(payload.evidenceRefs)].filter((ref) => !known.has(ref));
	if (unknown.length > 0) return {
		ok: false,
		refusal: `evidenceRefs cite ${unknown.join(", ")}, which store ${binding.rootStoreId} does not hold`
	};
	return {
		ok: true,
		payload: {
			...payload,
			reason,
			evidenceRefs: [...new Set(payload.evidenceRefs)]
		}
	};
}
/** The non-empty strings of an unknown value, or nothing at all. */
function nonEmptyStrings(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string" && item.length > 0);
}
/** Validate the judgements the reviewer chose to make. Each one has to name a judged dimension and a verdict from the fixed vocabulary, cite at least one non-empty ref and carry a rationale. */
function judgementsOf(value, known) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("the \"judgements\" field is not an array");
	return value.map((entry, index) => {
		const dimension = entry.dimension;
		if (!JUDGED_DIMENSIONS.includes(dimension)) throw new Error(`judgement ${index} names dimension "${String(dimension)}", which is not one of ${JUDGED_DIMENSIONS.join(", ")}`);
		const verdict = entry.verdict;
		if (!JUDGEMENT_VERDICTS.includes(verdict)) throw new Error(`judgement ${index} (${String(dimension)}) has verdict "${String(verdict)}", which is not adequate/inadequate/unknown`);
		const refs = nonEmptyStrings(entry.evidenceRefs);
		if (refs.length === 0) throw new Error(`judgement ${index} (${String(dimension)}) cites no evidence — a conclusion that rests on nothing is not recorded`);
		const unresolvable = refs.filter((ref) => !known.has(ref));
		if (unresolvable.length > 0) throw new Error(`judgement ${index} (${String(dimension)}) cites ${unresolvable.join(", ")}, which this store does not hold`);
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
/** Validate the reviewer's proposals: a target name, an id and a reason, each non-empty. */
function proposalsOf(value) {
	if (value === void 0) return [];
	if (!Array.isArray(value)) throw new Error("the \"proposals\" field is not an array");
	return value.map((entry, index) => {
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
/** The distinct non-empty strings of an optional ref list, or nothing. */
function optionalRefs(value, field) {
	if (value === void 0) return void 0;
	if (!Array.isArray(value) || value.some((ref) => textOf(ref) === void 0)) throw new Error(`the "${field}" field must be an array of non-empty strings`);
	return [...new Set(value)];
}
/** Validate a reviewer's completion and build the diagnosis it records. */
function validateReviewCompletion(input) {
	const { payload, snapshot, binding } = input;
	const observation = textOf(payload.observation);
	if (observation === void 0) return {
		ok: false,
		refusal: "observation must be the non-empty postmortem observation"
	};
	const conclusion = textOf(payload.conclusion);
	if (conclusion === void 0) return {
		ok: false,
		refusal: "conclusion must be non-empty free text"
	};
	if (payload.confidence !== "high" && payload.confidence !== "medium" && payload.confidence !== "low") return {
		ok: false,
		refusal: `confidence "${String(payload.confidence)}" is not high/medium/low`
	};
	if (binding.subject.kind !== "review") return {
		ok: false,
		refusal: "this session was not assigned a review; reviewer_complete concludes a review"
	};
	const source = binding.subject.source;
	if (snapshot.tasks.find((candidate) => candidate.taskId === source.taskId) === void 0) return {
		ok: false,
		refusal: `this session's assigned source task "${source.taskId}" is not in store ${binding.rootStoreId}`
	};
	const review = snapshot.reviews.find((item) => item.taskId === source.taskId && (item.runId ?? null) === source.runId);
	if (review === void 0) return {
		ok: false,
		refusal: `store ${binding.rootStoreId} holds no review of ${reviewRef(source)}`
	};
	try {
		const scope = textOf(payload.scope);
		if (payload.scope !== void 0 && scope === void 0) throw new Error("the \"scope\" field must be a non-empty string");
		const reviewRefs = optionalRefs(payload.reviewRefs, "reviewRefs");
		const evidenceRefs = optionalRefs(payload.evidenceRefs, "evidenceRefs");
		const relatedTaskIds = optionalRefs(payload.relatedTaskIds, "relatedTaskIds");
		const known = knownReferences(snapshot);
		const invalid = [
			...[reviewRef(source), ...reviewRefs ?? []].filter((ref) => !known.has(ref)).map((ref) => `reviewRef "${ref}"`),
			...(evidenceRefs ?? []).filter((ref) => !known.has(ref)).map((ref) => `evidenceRef "${ref}"`),
			...(relatedTaskIds ?? []).filter((id) => !snapshot.tasks.some((candidate) => candidate.taskId === id)).map((id) => `relatedTaskId "${id}"`)
		];
		if (invalid.length > 0) return {
			ok: false,
			refusal: `the completion cites ${invalid.join(", ")} outside store ${binding.rootStoreId}`
		};
		const judgements = judgementsOf(payload.judgements, knownJudgementReferences(snapshot));
		const proposals = proposalsOf(payload.proposals);
		return {
			ok: true,
			payload: { diagnosis: {
				diagnosisId: `review-agent-${binding.sessionId}`,
				taskId: source.taskId,
				observedFailure: observation,
				scope: scope ?? `task ${source.taskId}`,
				localizedCause: conclusion,
				evidenceRefs: evidenceRefs ?? review.evidenceRefs,
				reviewRefs: [...new Set([reviewRef(source), ...reviewRefs ?? []])],
				confidence: payload.confidence,
				proposals,
				producedBy: {
					kind: "agent",
					sessionId: binding.sessionId
				},
				...relatedTaskIds === void 0 ? {} : { relatedTaskIds },
				...judgements.length === 0 ? {} : { judgements }
			} }
		};
	} catch (error) {
		return {
			ok: false,
			refusal: `the completion's diagnosis fields are malformed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/** The base of one row for one assignment. */
function completionRow(binding, result, at) {
	return {
		formatVersion: 1,
		kind: "completion",
		graphId: binding.graphId,
		storeId: binding.rootStoreId,
		epoch: binding.epoch,
		role: binding.role,
		sessionId: binding.sessionId,
		result,
		at
	};
}
/** The completion one accepted supervisor payload becomes, with the fields the platform derived. */
function supervisorCompletion(binding, payload, derived) {
	return completionRow(binding, {
		kind: "completed",
		businessAction: payload.businessAction,
		reason: payload.reason,
		evidenceRefs: [...payload.evidenceRefs],
		trialCandidateRef: payload.trialCandidateRef ?? null,
		methodDecision: derived.methodDecision,
		searchNext: derived.searchNext,
		...derived.approval === void 0 ? {} : { approval: derived.approval }
	}, (/* @__PURE__ */ new Date()).toISOString());
}
/** The completion one accepted review becomes. */
function reviewCompletion(binding, diagnosisId, confidence) {
	return completionRow(binding, {
		kind: "reviewed",
		diagnosisId,
		confidence
	}, (/* @__PURE__ */ new Date()).toISOString());
}
/** The completion a session that ended without calling its tool leaves: recorded once, never re-asked. */
function protocolFailure(binding, detail) {
	return completionRow(binding, {
		kind: "protocol-failure",
		detail
	}, (/* @__PURE__ */ new Date()).toISOString());
}
/** The completion a failed spawn or resume leaves: the session never reached model input. */
function interrupted(binding, detail) {
	return completionRow(binding, {
		kind: "interrupted",
		detail
	}, (/* @__PURE__ */ new Date()).toISOString());
}
/** One on-disk row as the binding a completion is written against, for platform-written rows. */
function bindingOfAssignment(assignment, completed) {
	return {
		graphId: assignment.graphId,
		rootStoreId: assignment.storeId,
		epoch: assignment.epoch,
		role: assignment.role,
		subject: assignment.subject,
		sourceTaskId: assignment.subject.source.taskId,
		sourceRunId: assignment.subject.source.runId,
		sessionId: assignment.sessionId,
		actor: assignment.actor,
		at: assignment.at,
		completed
	};
}

//#endregion
//#region src/coordination/method-read.ts
function environmentPlane(ctx) {
	return optionalService(ctx, "taskRuntime");
}
/** Whether this graph's method publication is decided by the platform policy rather than a person. */
async function platformDecided(ctx, graphId) {
	const graphs = optionalService(ctx, "graphs");
	if (graphs === void 0) return false;
	try {
		return (await graphs.graphForSession(SessionId(graphId))).rsi?.humanReview === false;
	} catch {
		return false;
	}
}
/** The revision this graph is running now, or `undefined` when no environment plane can answer. */
async function activeMethodRevision(ctx, rootSessionId) {
	const plane = environmentPlane(ctx);
	try {
		const view = await plane?.activeEnvironmentView?.(rootSessionId);
		return view === void 0 ? void 0 : { revisionId: view.revisionId };
	} catch {
		return;
	}
}
/**
* The method records one business round produced, read from this graph's own v5
* ledger (`<library>/methods.jsonl`) and bounded by the round's own assignment:
* a record counts for this round when it was appended after the round's
* supervisor was assigned. A deployment that has not mounted the environment
* plane answers nothing — the completion then reports `retain`/`trial` rather
* than a promotion nobody recorded.
*/
async function roundMethodRecords(ctx, graphId, businessRound) {
	const plane = environmentPlane(ctx);
	if (plane?.libraryForSession === void 0) return [];
	const boundary = await roundBoundaryOf(graphId, businessRound);
	if (boundary === void 0) return [];
	let library;
	try {
		library = await plane.libraryForSession(graphId);
	} catch {
		return [];
	}
	let views;
	try {
		views = [...foldMethods((await openMethodLedger({
			root: library.root,
			libraryId: library.id
		})).records()).values()];
	} catch {
		return [];
	}
	const platform = await platformDecided(ctx, graphId);
	const records = [];
	for (const view of views) {
		const published = view.published;
		if (published !== void 0 && published.at >= boundary) records.push({
			action: "publish",
			revisionId: published.revisionId,
			approvalRef: published.approvalRef ?? null,
			decidedBy: platform ? "platform_policy" : "human",
			reason: `draft ${view.draft.draftId} published as revision ${published.revisionId}`
		});
		const rolledback = view.rolledback;
		if (rolledback !== void 0 && rolledback.at >= boundary) records.push({
			action: "rollback",
			revisionId: rolledback.revisionId,
			approvalRef: rolledback.approvalRef ?? null,
			decidedBy: platform ? "platform_policy" : "human",
			reason: `draft ${view.draft.draftId} rolled back to revision ${rolledback.revisionId}`
		});
		const discardedAt = lastHistoryAt(view.history, "discard");
		if (view.status === "discarded" && discardedAt !== void 0 && discardedAt >= boundary) records.push({
			action: "discard",
			revisionId: null,
			approvalRef: null,
			decidedBy: "operator",
			reason: view.discardReason ?? `draft ${view.draft.draftId} discarded`
		});
	}
	return records.sort((left, right) => left.action < right.action ? -1 : left.action > right.action ? 1 : 0);
}
/** The `at` of the last record of one kind in a draft's own history, or nothing. */
function lastHistoryAt(history, kind) {
	let at;
	for (const entry of history) if (entry.kind === kind) at = entry.at;
	return at;
}
/** When this round's supervisor was assigned: the lower bound a record must be appended after to belong to this round. */
async function roundBoundaryOf(graphId, businessRound) {
	let rows;
	try {
		rows = await readCoordinationRows() ?? [];
	} catch {
		return;
	}
	return rows.filter((row) => row.kind === "assignment").filter((row) => row.graphId === graphId && row.role === "supervisor").filter((row) => row.subject.kind === "round" && row.subject.businessRound === businessRound).map((row) => row.at).sort()[0];
}
/** The last element of a list, or nothing. */
function lastOf(items) {
	return items.length === 0 ? void 0 : items[items.length - 1];
}
/** The platform's own account of what this round decided about the method. */
function methodDecisionOf(records, trialCandidateRef) {
	const discarded = lastOf(records.filter((record) => record.action === "discard"));
	const rolledback = lastOf(records.filter((record) => record.action === "rollback"));
	const published = lastOf(records.filter((record) => record.action === "publish"));
	if (rolledback !== void 0) return {
		methodDecision: "rollback",
		...approvalOf(rolledback)
	};
	if (published !== void 0) return {
		methodDecision: "promote",
		...approvalOf(published)
	};
	if (discarded !== void 0) return {
		methodDecision: "discard",
		...approvalOf(discarded)
	};
	if (trialCandidateRef !== void 0) return {
		methodDecision: "trial",
		approval: {
			source: "platform_policy",
			ref: `trial:${trialCandidateRef}`
		}
	};
	return { methodDecision: "retain" };
}
/** The approval source one publish/rollback record carried, when it carried one. */
function approvalOf(record) {
	if (record.approvalRef === null) return {};
	return { approval: {
		source: record.decidedBy === "human" ? "human" : "platform_policy",
		ref: record.approvalRef
	} };
}
/** Whether this round's search should continue; the search step never changes the business action. */
function searchNextOf(input) {
	if (input.steering === "stop-search") return "stop";
	return input.businessRound >= input.rounds ? "stop" : "explore";
}

//#endregion
//#region src/coordination/render.ts
/** One review record's facts as the compact read-only block a supervisor's request carries. */
function renderSupervisorReviewFacts(review) {
	const criteria = review.criteria ?? [];
	const passed = criteria.filter((criterion) => criterion.verdict === "pass").length;
	const lines$1 = [`review ${review.taskId}#${review.runId ?? "no-run"} [${review.outcome}]`];
	lines$1.push(criteria.length === 0 ? "criteria: none recorded" : `criteria (${passed}/${criteria.length} passed): ${criteria.map((criterion) => `${criterion.criterionId} ${criterion.verdict}`).join("; ")}`);
	const metrics = metricsLine(review);
	if (metrics !== void 0) lines$1.push(`metrics: ${metrics}`);
	if (review.logTail !== void 0) lines$1.push(`logTail: ${review.logTail}`);
	return lines$1.join("\n");
}
/** The effort counters of one review record, one clause per counter that exists. */
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
/** The judged dimensions rendered as report lines. */
function renderJudgements(judgements) {
	return judgements.map((item) => `  ${item.dimension}: ${item.verdict} — ${item.rationale} refs [${item.evidenceRefs.join(", ")}]`);
}
/** One work item as a reader reads it: its identity, its role, how it stands and how it ended. */
function renderCoordinationWork(work) {
	const assignment = work.assignment;
	const subject = assignment.subject;
	const described = subject.kind === "round" ? `round ${subject.businessRound}` : `review of ${subject.source.taskId}#${subject.source.runId ?? "no-run"}${subject.requestKey === null ? "" : ` (key ${subject.requestKey})`}`;
	const completion = work.completion;
	const status = completion === void 0 ? "open" : completion.result.kind === "reviewed" ? `settled (diagnosis ${completion.result.diagnosisId})` : completion.result.kind === "completed" ? `settled (${completion.result.businessAction})` : completion.result.kind;
	return `${assignment.role} ${described}: session ${assignment.sessionId} [${status}]`;
}
/** One completion as a single line: what was concluded, on what, and what was closed. */
function renderCompletion(completion) {
	const result = completion.result;
	switch (result.kind) {
		case "completed": return [
			`supervisor_complete: ${result.businessAction} — ${result.reason}`,
			`${result.evidenceRefs.length} evidence ref(s) [${result.evidenceRefs.join(", ")}]`,
			`method ${result.methodDecision}; search ${result.searchNext}`,
			...result.trialCandidateRef === null ? [] : [`trial candidate ${result.trialCandidateRef}`],
			...result.approval === void 0 ? [] : [`approval ${result.approval.source}:${result.approval.ref}`],
			"writes are closed for this session; the platform opens the next execution after this session settles"
		].join("; ");
		case "reviewed": return `reviewer_complete: diagnosis ${result.diagnosisId} [${result.confidence}] recorded; writes are closed for this session`;
		case "protocol-failure": return `protocol-failure: ${result.detail}`;
		case "interrupted": return `interrupted: ${result.detail}`;
	}
}
/** The sum of several receipts' usages, or `undefined` when not one of them reported. */
function aggregateUsage(usages) {
	const reported = usages.filter((usage) => usage.status === "reported");
	if (reported.length === 0) return void 0;
	const runIds = [...new Set(reported.flatMap((usage) => usage.runIds))];
	const incompleteRuns = [...new Set(reported.flatMap((usage) => usage.incompleteRuns))];
	const withTokens = reported.filter((usage) => usage.tokens !== void 0);
	const withCalls = reported.filter((usage) => usage.toolCalls !== void 0);
	const tokens = withTokens.length === 0 ? void 0 : withTokens.reduce((sum, usage) => ({
		uncachedInputTokens: sum.uncachedInputTokens + usage.tokens.uncachedInputTokens,
		outputTokens: sum.outputTokens + usage.tokens.outputTokens,
		cacheReadTokens: sum.cacheReadTokens + usage.tokens.cacheReadTokens,
		cacheWriteTokens: sum.cacheWriteTokens + usage.tokens.cacheWriteTokens
	}), {
		uncachedInputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	});
	const toolCalls = withCalls.length === 0 ? void 0 : withCalls.reduce((sum, usage) => ({
		calls: sum.calls + usage.toolCalls.calls,
		failures: sum.failures + usage.toolCalls.failures
	}), {
		calls: 0,
		failures: 0
	});
	return {
		status: "reported",
		runIds,
		incompleteRuns,
		...tokens === void 0 ? {} : { tokens },
		...toolCalls === void 0 ? {} : { toolCalls }
	};
}
/**
* One cost line, from execution receipts alone. A reading the receipts do not
* carry stays `unknown`: nothing here walks session logs, and nothing invents a
* number a Run did not record.
*/
function renderExecutionCost(label, usage, runs) {
	if (usage === void 0) return `${label}: ${runs} run(s); tokens unknown; toolCalls unknown; monetary cost unknown (no recorded price).`;
	const tokens = usage.tokens === void 0 ? "tokens unknown" : `tokens ${Object.values(usage.tokens).reduce((sum, value) => sum + value, 0)} (input ${usage.tokens.uncachedInputTokens}, output ${usage.tokens.outputTokens}, cache read ${usage.tokens.cacheReadTokens}, cache write ${usage.tokens.cacheWriteTokens})`;
	const tools = usage.toolCalls === void 0 ? "toolCalls unknown" : `toolCalls ${usage.toolCalls.calls} (${usage.toolCalls.failures} failed)`;
	const coverage = usage.incompleteRuns.length === 0 ? "coverage complete" : `coverage incomplete for run(s) ${usage.incompleteRuns.join(", ")}`;
	return `${label}: ${usage.runIds.length} run(s); ${tokens}; ${tools}; ${coverage}; monetary cost unknown (no recorded price).`;
}

//#endregion
//#region src/coordination/prompts.ts
/** The lines describing where this round stands and what its evidence is. */
function locationLines(facts) {
	const { run, review } = facts;
	const artifacts = run.artifacts ?? [];
	return [
		`Store: the root store of graph "${facts.graphName}"; root task run: ${run.runId} (session ${run.sessionId ?? "unrecorded"}).`,
		`Round objective as recorded on the graph: ${facts.objective}`,
		`Metrics to explore and improve: ${facts.metrics.join("; ") || "derive useful measurements from the task and state the assumptions"}.`,
		"Use the current task criteria to judge this execution, and its findings to improve reusable paths and experience.",
		review === void 0 ? "The store holds no review record for this run." : `The round's review settled ${review.outcome}. ${renderSupervisorReviewFacts(review)}`,
		"Where this round's delivery and evidence live:",
		run.placement?.workspacePath === void 0 ? "- the run recorded no separate working tree; read the store's evidence bundles" : `- the run's working tree: ${run.placement.workspacePath} (read/glob/grep it directly)`,
		...artifacts.length === 0 ? ["- the run recorded no artifacts of its own"] : artifacts.map((artifact) => `- artifact ${artifact.artifactId} (${artifact.kind}) at ${artifact.uri}${artifact.digest === void 0 ? "" : ` sha256:${artifact.digest}`}`),
		review === void 0 || review.evidenceRefs.length === 0 ? "- the review recorded no evidence ids" : `- store evidence ids: ${review.evidenceRefs.join(", ")} (context_read kind:"evidence")`
	];
}
/** The lines describing the method this graph is running now. */
function methodLines(facts) {
	return [`Active method revision: ${facts.method.activeRevision ?? "unknown"}`, `Last revision published by this graph: ${facts.method.lastPublishedRevision ?? "none recorded"}`];
}
/** The lines of the search-strategy view, when this deployment has one. */
function strategyLines(facts) {
	const strategy = facts.strategy;
	if (strategy === void 0) return [];
	return [
		`Search strategy: edit budget ${strategy.editBudget}; steering ${strategy.steering}.`,
		...strategy.untestedMechanisms.length === 0 ? [] : [`Untested mechanisms worth a round: ${strategy.untestedMechanisms.join(", ")}.`],
		...strategy.lines
	];
}
/** The one supervision request one round's supervisor receives. */
function supervisionPrompt(facts) {
	const verified = facts.outcome === "verified";
	return [
		`You are the platform RSI loop's supervisor for graph "${facts.graphName}" (${facts.graphId}), epoch ${facts.epoch}, round ${facts.businessRound} of ${facts.rounds} (search round ${facts.searchRound}).`,
		...locationLines(facts),
		...facts.cost,
		...methodLines(facts),
		...strategyLines(facts),
		`Cite diagnosis:${facts.diagnosisId} when you record evidence for this round.`,
		"",
		...verified ? ["The round settled verified against the store's own acceptance criteria. Review its delivery and its reusable method, then choose one improvement or retain the current method."] : [`The round settled ${facts.run.status}. Debug that failure from its evidence, review and delivery, and choose the reusable method change that helps the next attempt. A one-off environmental or input repair is a repair, not a method change.`],
		...facts.finalRound ? ["Final round: review this execution’s paths and experience for retention or revision. Settle your findings; this graph completes after your completion, and later Tasks can test any publication."] : [],
		"Compare candidates with the method tools you have and publish within your authority.",
		"",
		"End this session by calling supervisor_complete with exactly these parameters: businessAction ('continue' when the business work should run another round, 'recover' when the next round must repair this failure, 'finish' when it should not), reason (non-empty free text), evidenceRefs (at least one recorded review/evidence/criterion reference), and trialCandidateRef (only when this round should explicitly try one candidate).",
		"The platform derives the method decision and the approval source from what your round actually recorded; they are not parameters and cannot be asserted.",
		"Calling it closes this session’s write access; reads, evidence and findings stay available. The platform opens the next execution only after this session’s log has been flushed. A session that ends its turn without calling the tool is a protocol failure, and the platform will not ask again — raising the graph’s epoch is the way to try a round once more."
	].join("\n");
}

//#endregion
//#region src/coordination/session-facts.ts
/** The tools whose call in a session's own log marks that session's work as concluded. */
const COMPLETION_TOOLS = ["supervisor_complete", "reviewer_complete"];
/** One session's log, or `undefined` when this process cannot read it. */
async function logOf$1(ctx, sessionId$1) {
	const query = optionalService(ctx, "sessionQuery");
	if (query === void 0) return void 0;
	try {
		return await query.readSession(sessionId$1);
	} catch {
		return;
	}
}
/** Whether one event is a tool call to a completion tool. */
function isCompletionCall(event) {
	if (event.type !== "tool/call") return false;
	const name = event.data?.name;
	return typeof name === "string" && COMPLETION_TOOLS.includes(name);
}
/** The turn facts one persisted log carries. */
function turnFacts(events) {
	let open$1 = false;
	let hasTurn = false;
	for (const event of events) if (event.type === "turn/start") {
		hasTurn = true;
		open$1 = true;
	} else if (event.type === "turn/end") open$1 = false;
	return {
		hasTurn,
		turnClosed: hasTurn && !open$1
	};
}
/** Whether a stored session exists, without insisting on either backend's API. */
async function stored(ctx, sessionId$1) {
	const persistence = optionalService(ctx, "sessionPersistence");
	if (persistence === void 0) return false;
	if (typeof persistence.stat === "function") try {
		return await persistence.stat(sessionId$1) !== void 0;
	} catch {
		return false;
	}
	if (typeof persistence.list === "function") try {
		return (await persistence.list()).some((item) => String(item.header.id) === sessionId$1);
	} catch {
		return false;
	}
	return false;
}
/** One session's facts: live from the registry, otherwise from the persisted log. */
async function readSessionFacts(ctx, sessionId$1) {
	const live = optionalService(ctx, "agents")?.get(sessionId$1);
	const log = await logOf$1(ctx, sessionId$1);
	const turns = turnFacts(log?.events ?? []);
	return {
		sessionId: sessionId$1,
		presence: live !== void 0 ? "live" : await stored(ctx, sessionId$1) ? "stored" : "missing",
		...live?.status === "idle" || live?.status === "running" ? { status: live.status } : {},
		hasTurn: turns.hasTurn,
		turnClosed: turns.turnClosed,
		completionCall: (log?.events ?? []).some(isCompletionCall)
	};
}
/** The facts of several sessions, read together. */
async function readSessionFactsOf(ctx, sessionIds) {
	const facts = /* @__PURE__ */ new Map();
	await Promise.all([...new Set(sessionIds)].map(async (sessionId$1) => {
		facts.set(sessionId$1, await readSessionFacts(ctx, sessionId$1));
	}));
	return facts;
}
/** DSH's own durability barrier: every session log a writer appended so far is where the next reader finds it. */
async function flushSessions(ctx) {
	const persistence = optionalService(ctx, "sessionPersistence");
	if (typeof persistence?.flush === "function") await persistence.flush();
}
/** Whether one assignment has consumed its store's budget: its session reached the store at all. */
function sessionSpent(facts) {
	return facts !== void 0 && facts.presence !== "missing";
}
/** Whether one session's turn has ended and nothing further is running in it. */
function turnSettled(facts) {
	if (facts === void 0) return false;
	if (facts.status === "running") return false;
	return facts.turnClosed;
}

//#endregion
//#region src/coordination/reducer.ts
/** The recovery mode one business action asks for, or nothing when the action and the round disagree. */
function nextRoundMode(action, outcome) {
	if (action === "continue") return outcome === "verified" ? "improve" : void 0;
	if (action === "recover") return outcome === "failed" ? "recovery" : void 0;
}
/** The round work item's key: one round, one supervisor, per epoch. */
function roundKeyOf(input) {
	return {
		graphId: input.graphId,
		epoch: input.epoch,
		role: "supervisor",
		subject: {
			kind: "round",
			businessRound: input.businessRound,
			searchRound: input.businessRound,
			source: {
				taskId: input.taskId,
				runId: input.runId
			}
		}
	};
}
/** The assignment that claimed one key, if any. */
function claimedFor(rows, key) {
	const last = assignmentsForKey(rows, key).at(-1);
	if (last === void 0) return void 0;
	const completion = completionFor(rows, last.sessionId);
	return {
		assignment: last,
		...completion === void 0 ? {} : { completion }
	};
}
/** The reduction of one round that already has a completion. */
function ofCompletion(input) {
	const { facts, key, work, run, outcome, businessRound } = input;
	const completion = work.completion;
	const config = facts.graph.config;
	const epoch = config.epoch ?? 1;
	if (completion.result.kind === "protocol-failure") return {
		kind: "suspended",
		phase: "protocol-failure",
		detail: `${keyLabel(key)} ended without a completion call (${completion.result.detail}); raise the graph's epoch to try this round again`
	};
	if (completion.result.kind !== "completed") return {
		kind: "suspended",
		phase: "failed",
		detail: `${keyLabel(key)} settled ${completion.result.kind}, which no round does`
	};
	const action = completion.result.businessAction;
	const mode = nextRoundMode(action, outcome);
	if (action === "finish") return {
		kind: "suspended",
		phase: outcome === "verified" ? "done" : "failed",
		detail: `${keyLabel(key)} finished the business work: round ${businessRound} settled ${run.status} — ${completion.result.reason}`
	};
	if (mode === void 0) return {
		kind: "suspended",
		phase: "protocol-failure",
		detail: `${keyLabel(key)} asked to "${action}" a round that settled ${run.status}; the two disagree, so no execution is opened`
	};
	if (businessRound >= config.iterationRounds) return {
		kind: "suspended",
		phase: outcome === "verified" ? "done" : "failed",
		detail: `${businessRound}/${config.iterationRounds} rounds settled; the search is over and the business outcome stays ${run.status} — ${completion.result.reason}`
	};
	const nextRound = businessRound + 1;
	const nextKey = roundRequestKey(facts.graph.id, epoch, nextRound);
	if (roundRunOf(facts.snapshot, run.taskId, nextKey) !== void 0) return {
		kind: "idle",
		detail: `round ${nextRound} is already open`
	};
	if (!facts.rootLive) return {
		kind: "idle",
		detail: `round ${nextRound} cannot be opened here: the graph's root session is not live in this process`
	};
	const trial = completion.result.trialCandidateRef;
	return {
		kind: "open-round",
		work,
		request: {
			businessRound: nextRound,
			sourceRunId: run.runId,
			sourceDiagnosisId: roundDiagnosisId(facts.graph.id, epoch, businessRound),
			requestKey: nextKey,
			mode,
			...trial === null ? {} : { trialCandidateRef: trial },
			...mode === "improve" ? { reuses: [] } : {}
		}
	};
}
/**
* One pass's decision. The graph's protocol marker and the store's own facts are
* the only inputs: a legacy graph never reaches this function at all (the driver
* refuses to build these facts for it).
*/
function reduce(facts) {
	const config = facts.graph.config;
	const epoch = config.epoch ?? 1;
	const root = rootTaskOf(facts.snapshot);
	if (root === void 0) return {
		kind: "idle",
		detail: "the store holds no root task yet"
	};
	const rounds = terminalRootRuns(facts.snapshot, root.taskId);
	if (rounds.length === 0) return {
		kind: "idle",
		detail: "the root task has no settled round yet"
	};
	const businessRound = rounds.length;
	const run = rounds.at(-1);
	if (businessRound > config.iterationRounds) return {
		kind: "suspended",
		phase: run.status === "verified" ? "done" : "failed",
		detail: `round ${businessRound} settled beyond the graph's ${config.iterationRounds} configured round(s); nothing more is opened`
	};
	const outcome = run.status === "verified" ? "verified" : "failed";
	const key = roundKeyOf({
		graphId: facts.graph.id,
		epoch,
		businessRound,
		taskId: root.taskId,
		runId: run.runId
	});
	if (!sameCoordinationKey(key, facts.candidate.key)) return {
		kind: "idle",
		detail: `this pass's work item does not describe round ${businessRound}; the driver re-derives it next time`
	};
	const claimed = claimedFor(facts.rows, key);
	const interrupted$1 = claimed?.completion?.result.kind === "interrupted";
	if (claimed?.completion !== void 0 && !interrupted$1) return ofCompletion({
		facts,
		key,
		work: claimed,
		run,
		outcome,
		businessRound
	});
	if (claimed !== void 0 && !interrupted$1) {
		const session = claimed.assignment.sessionId;
		const factsOfSession = facts.sessions.get(session);
		if ((factsOfSession?.hasTurn ?? false) && turnSettled(factsOfSession)) return {
			kind: "protocol-failure",
			work: claimed,
			detail: `${keyLabel(key)}: session ${session} ended its turn without calling supervisor_complete; the round is recorded as a protocol failure and the platform does not ask again`
		};
		return {
			kind: "idle",
			detail: `${keyLabel(key)} is taken up by session ${session}; the loop waits for it`
		};
	}
	const plan = planAssignment({
		request: facts.candidate,
		rows: facts.rows,
		sessions: facts.sessions,
		budget: facts.budget
	});
	if (plan.kind === "refused") return {
		kind: "suspended",
		phase: "failed",
		detail: `${plan.code}: ${plan.detail}`
	};
	if (plan.kind === "assign" || plan.kind === "resume") return {
		kind: "supervise",
		plan,
		request: facts.candidate
	};
	return {
		kind: "idle",
		detail: `${keyLabel(key)} is already claimed; the loop waits for it`
	};
}

//#endregion
//#region src/tools/method-shared.ts
/** The supervisor's method surface: the whole draft → evaluate → publish/discard/rollback path, plus the read. */
const METHOD_SUPERVISOR_BASELINE = [
	"method_list",
	"method_draft",
	"method_evaluate",
	"method_publish",
	"method_discard",
	"method_rollback"
];
function graphRegistry(ctx) {
	const graphs = optionalService(ctx, "graphs");
	if (graphs === void 0) throw new Error("method tools: this deployment offers no graph registry, so no method tool can resolve its graph; nothing was read or changed");
	return graphs;
}
/** The graph one caller belongs to: its identity, its library and its own method settings. */
async function methodGraphFor(ctx, caller) {
	const graph = await graphRegistry(ctx).graphForSession(SessionId(caller));
	const rootSessionId = String(graph.rootSessionId);
	return {
		id: String(graph.id),
		rootSessionId,
		libraryId: rootSessionId,
		...graph.rsi == null ? {} : { rsi: { humanReview: graph.rsi.humanReview === true } }
	};
}
/** The mode one graph's record puts method publication in. Mode is never an argument. */
async function methodModeFor(ctx, caller) {
	return (await methodGraphFor(ctx, caller)).rsi?.humanReview === false ? "auto" : "manual";
}
/** Who answers: an unmanned graph's publication is the platform policy's, not a person's. */
function deciderFor(mode) {
	return mode === "auto" ? "platform_policy" : "human";
}
/** The environment plane, resolved from the runtime alone; a deployment without one is refused by name. */
function environmentPlaneOf(ctx) {
	const runtime = optionalService(ctx, "taskRuntime");
	if (runtime === void 0) throw new Error("method tools: this deployment offers no task runtime, so no environment revision can be read or drafted; nothing was read or changed");
	const bind = (member) => {
		const value = runtime[member];
		if (typeof value !== "function") throw new Error(`method tools: this deployment's task runtime offers no ${String(member)}, so the environment plane cannot answer; nothing was changed`);
		return value.bind(runtime);
	};
	return {
		activeEnvironmentView: bind("activeEnvironmentView"),
		activeRevisionFor: bind("activeRevisionFor"),
		libraryForSession: bind("libraryForSession"),
		createDraft: bind("createDraft"),
		stageDraftEdit: bind("stageDraftEdit"),
		removeEnvironmentDraft: bind("removeEnvironmentDraft"),
		freezeDraft: bind("freezeDraft"),
		publishRevision: bind("publishRevision"),
		rollbackRevision: bind("rollbackRevision"),
		openPointerIntent: bind("openPointerIntent"),
		reconcilePointer: bind("reconcilePointer")
	};
}
/** The strategy's pure functions, as one bundle; the policy defaults to the frozen first-version one. */
function strategyPlaneOf(policy = DEFAULT_STRATEGY_POLICY) {
	return {
		policy,
		editBudget: (round, chosen) => editBudget(round, {
			rounds: chosen.rounds,
			...chosen.editBudget
		}),
		screenBeforeMeasurement,
		aggregateEvaluation,
		calibrateNoise,
		admit,
		foldHistory,
		renderHistory,
		stallFlag,
		exploration,
		refutationFor,
		criticOf: (verdict) => verdict
	};
}
/** The path one strategy decision record is written to: beside the report it recomputes from. */
function decisionPathOf(root, draftId, evaluationId) {
	return join(root, "evaluations", draftId, evaluationId, "strategy-decision.json");
}
/**
* The prospective candidate revision one draft holds, as the publish approval
* reads it for its difference. It is the draft's own directory, not a frozen
* revision: only the pointer transaction freezes it, by rename.
*/
async function candidateRevisionOf(library, draftId) {
	const draft = await readEnvironmentDraft(library, draftId);
	if (draft === void 0) return void 0;
	return {
		manifest: draft.manifest,
		root: draft.root,
		skillRoot: join(draft.root, "skills"),
		taskTemplatesRoot: join(draft.root, "task-templates")
	};
}
/**
* The method ledger plane, bound to the caller's own graph library. Every entry
* opens the library's ledger again, so a line another process appended between
* two calls is read rather than cached past.
*/
async function methodLedgerPlaneOf(ctx, caller) {
	const resolved = await environmentPlaneOf(ctx).libraryForSession(caller);
	const library = {
		id: resolved.id,
		root: resolved.root
	};
	const policy = DEFAULT_STRATEGY_POLICY;
	const open$1 = async () => {
		const ledger = await openMethodLedger({
			root: library.root,
			libraryId: library.id
		});
		return {
			ledger,
			sources: evaluationSourcesOf({
				ctx,
				caller,
				root: library.root,
				libraryId: library.id,
				ledger
			})
		};
	};
	const viewOf = async (draftId) => {
		const { ledger } = await open$1();
		const view = foldMethods(ledger.records()).get(draftId);
		if (view === void 0) throw new Error(`evolution: unknown draft "${draftId}"`);
		return view;
	};
	const reportOf = async (view) => {
		if (view.evaluation === void 0) return void 0;
		const { sources } = await open$1();
		return await evaluationOf(sources, view.draft.draftId);
	};
	return {
		libraryId: library.id,
		root: library.root,
		view: viewOf,
		async list(filter) {
			const { sources } = await open$1();
			return methodList(sources, filter);
		},
		async evaluationOf(draftId) {
			return await reportOf(await viewOf(draftId));
		},
		async prepareStructure(input) {
			return await prepareStructureFor(library, input);
		},
		async createDraft(request) {
			const { ledger } = await open$1();
			return await createDraft(ledger, request);
		},
		async evaluate(input, signal) {
			const { sources } = await open$1();
			return await evaluate(sources, {
				draftId: input.draftId,
				samples: input.samples,
				input: input.input,
				model: input.model,
				rules: input.rules,
				budget: input.budget,
				repetition: input.repetition,
				...input.evaluation === void 0 ? {} : { evaluation: input.evaluation },
				...input.judge === void 0 ? {} : { judge: input.judge },
				...signal === void 0 ? {} : { signal },
				...input.maxParallel === void 0 ? {} : { maxParallel: input.maxParallel },
				policy,
				actor: caller
			});
		},
		async decisionFor(draftId) {
			const view = await viewOf(draftId);
			if (view.evaluation === void 0) return void 0;
			return await readDecision(decisionPathOf(library.root, draftId, view.evaluation.evaluationId));
		},
		async recordDecision(report) {
			const decision = deriveDecision(report, policy);
			await writeJson(decisionPathOf(library.root, report.draftId, report.evaluationId), decision);
			return decision;
		},
		async validatePrePublish(report) {
			const { sources } = await open$1();
			const outcome = await validateEvaluation({
				report,
				sources,
				mode: "pre-publish"
			});
			return {
				guards: outcome.guards.map((guard) => ({
					id: guard.id,
					passed: guard.ok
				})),
				verdict: outcome.verdict
			};
		},
		async discardDraft(input) {
			const { ledger } = await open$1();
			return await discardDraft(ledger, input);
		},
		async markPublished(input) {
			const { sources } = await open$1();
			await markPublished(sources, input);
		},
		async markRolledback(input) {
			const { sources } = await open$1();
			await markRolledback(sources, input);
		},
		async history() {
			const { ledger, sources } = await open$1();
			return await historyFactsOf(ledger, sources, policy);
		}
	};
}
/** One library's drafts, its reports and its versions, as the strategy's history folds them. */
async function historyFactsOf(ledger, sources, policy) {
	const views = [...foldMethods(ledger.records()).values()];
	const candidates = views.map((view, index) => ({
		candidateId: view.draft.draftId,
		libraryId: view.libraryId,
		contentDigest: view.draft.candidateRevision.digest,
		round: index,
		edits: []
	}));
	const roundOf = new Map(candidates.map((candidate) => [candidate.candidateId, candidate.round]));
	const evaluations = [];
	const refutations = [];
	const versions = [];
	for (const view of views) {
		const draftId = view.draft.draftId;
		const round = roundOf.get(draftId) ?? 0;
		if (view.evaluation !== void 0) {
			const report = await evaluationOf(sources, draftId);
			evaluations.push({
				candidateId: draftId,
				scope: cohortDigestOf(report),
				measurement: sideMeasurementOf({
					report,
					side: "candidate",
					scale: scaleOf(report),
					policy
				}),
				verdict: report.verdict,
				evidenceRefs: [report.evaluationId]
			});
			const admission = (await readDecision(decisionPathOf(ledger.root, draftId, report.evaluationId)))?.admissions.find((entry) => entry.candidateId === draftId);
			if (admission !== void 0 && !admission.admissible) refutations.push({
				candidateId: draftId,
				contentDigest: view.draft.candidateRevision.digest,
				reasonCode: admission.reasonCode,
				reason: admission.reason,
				evidenceRefs: [report.evaluationId],
				round
			});
		} else if (view.status === "discarded") refutations.push({
			candidateId: draftId,
			contentDigest: view.draft.candidateRevision.digest,
			reasonCode: "not-measured",
			reason: view.discardReason ?? "discarded without an evaluation",
			evidenceRefs: [],
			round
		});
		if (view.published !== void 0) versions.push({
			round,
			libraryId: view.libraryId,
			revisionId: view.published.revisionId,
			contentDigest: view.draft.candidateRevision.digest
		});
	}
	return {
		candidates,
		evaluations,
		consumption: [],
		refutations,
		versions
	};
}
async function readDecision(path) {
	return await readJson(path);
}
async function readJson(path) {
	let text$1;
	try {
		text$1 = await readFile(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	try {
		return JSON.parse(text$1);
	} catch {
		throw new Error(`evolution: ${path} is not readable JSON`);
	}
}
async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}
/**
* The structure check one candidate runs before anything measures it: the
* adapter parses the asset the draft claims to change, against the frozen
* baseline, and a shape it cannot represent is a refusal by name rather than a
* finding nobody reads.
*/
async function prepareStructureFor(library, input) {
	const change = {
		kind: input.kind,
		identity: input.identity,
		before: null,
		after: input.candidateRevision.digest
	};
	const staged = await readEnvironmentDraft(library, input.draftId);
	const baseline = await readRevision(library, input.baseRevision.revisionId);
	if (staged === void 0 || baseline === void 0) return {
		ok: false,
		findings: ["the draft or its baseline revision is absent from the library"],
		change,
		files: []
	};
	const candidate = {
		manifest: staged.manifest,
		root: staged.root,
		skillRoot: join(staged.root, "skills"),
		taskTemplatesRoot: join(staged.root, "task-templates")
	};
	const draft = {
		draftId: input.draftId,
		kind: input.kind,
		identity: input.identity,
		baseRevision: input.baseRevision,
		candidateRevision: {
			...input.candidateRevision,
			files: []
		},
		rationale: input.rationale,
		sourceRefs: [...input.sourceRefs],
		actor: input.actor,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	try {
		const prepared = await adapterFor(input.kind).prepare({
			draft,
			revision: revisionViewOf(candidate),
			baseline: revisionViewOf(baseline)
		});
		return {
			ok: true,
			findings: [],
			change: prepared.change,
			files: prepared.files.map((file) => ({
				path: file.path,
				sha256: file.sha256
			}))
		};
	} catch (error) {
		return {
			ok: false,
			findings: [error instanceof Error ? error.message : String(error)],
			change,
			files: []
		};
	}
}
/** The one decision record a report yields, from the report's own baseline reading and the frozen policy. */
function deriveDecision(report, policy) {
	const baseline = sideMeasurementOf({
		report,
		side: "baseline",
		scale: scaleOf(report),
		policy
	});
	const incumbent = aggregateEvaluation(baseline);
	const calibration = calibrateNoise([baseline], policy);
	const history = foldHistory({
		candidates: [],
		evaluations: [],
		consumption: [],
		refutations: [],
		versions: []
	}, policy, 0);
	const guards = report.guards.filter((guard) => !guard.ok).map((guard) => guard.id);
	return strategyDecisionOf({
		report,
		policy,
		incumbent,
		bestQuality: incumbent.quality,
		calibration,
		history,
		guards,
		at: (/* @__PURE__ */ new Date()).toISOString()
	});
}

//#endregion
//#region src/coordination/roles.ts
/** The host preset both coordination roles are composed from; the runtime installs the role's own policy. */
const COORDINATION_PRESET = "singularity-coordinator";
/** The read-only investigation surface: what a coordination session may still do after writes are closed. */
const COORDINATION_READ_ONLY = [
	"task_review_pack",
	"task_read",
	"task_status",
	"context_read",
	"capability_list",
	"task_template_list",
	"method_list",
	"skill",
	"read",
	"glob",
	"grep"
];
/** The host preset a review session is composed from — the same composition, a different role. */
const REVIEWER_PRESET = COORDINATION_PRESET;
/** The reviewer's whole surface: read-only, plus its own completion tool. */
const REVIEWER_BASELINE = [
	...COORDINATION_READ_ONLY,
	"task_review_agent",
	"reviewer_complete"
];
/** The supervisor's surface: the read-only investigation tools, the method tools and its own completion tool. */
const SUPERVISOR_BASELINE = [
	...COORDINATION_READ_ONLY,
	"task_library",
	"task_review_agent",
	...METHOD_SUPERVISOR_BASELINE,
	"supervisor_complete"
];
/** The grant one review session is spawned with. */
function reviewerGrant() {
	return {
		capabilities: [],
		baseline: REVIEWER_BASELINE,
		keepPresetTools: false
	};
}
/** The grant one round's supervisor is spawned with. */
function supervisorGrant() {
	return {
		capabilities: [],
		baseline: SUPERVISOR_BASELINE,
		keepPresetTools: false
	};
}

//#endregion
//#region src/coordination/spawn-assignment.ts
/** Write the assignment, spawn the agent, and let the spawn's own door read the row back. */
async function spawnAssignment(input) {
	const { ctx, request } = input;
	const row = assignmentOf(request, (/* @__PURE__ */ new Date()).toISOString());
	await appendAssignment(row);
	const prompt = await input.prompt();
	const pinned = graphAgentOptions(await ctx.graphs.graphForSession(input.parent.id));
	let failure;
	const handle = await ctx.agentRuntime.spawn(input.parent, {
		sessionId: request.sessionId,
		name: input.name,
		prompt: [{
			type: "text",
			text: prompt
		}],
		agentPreset: input.preset,
		grant: input.grant,
		permissionPreset: "danger-full-access",
		coordinationRole: input.role,
		...pinned === void 0 ? {} : { agentOptions: pinned },
		beforePrompt: async () => {
			const binding = await readCoordinationBinding(String(request.sessionId)).catch(() => void 0);
			if (binding === void 0 || binding.graphId !== request.key.graphId || binding.rootStoreId !== request.storeId || binding.role !== request.key.role) throw new Error(`coordination: the assignment of session "${String(request.sessionId)}" could not be read back from ${request.storeId} (expected ${request.key.role} of graph ${request.key.graphId}); no model input was sent`);
		},
		...input.signal === void 0 ? {} : { signal: input.signal }
	}).catch((error) => {
		failure = error instanceof Error ? error.message : String(error);
	});
	if (handle === void 0) {
		await recordCompletion(interrupted(bindingOfAssignment(row, false), `the coordination session could not be spawned: ${failure ?? "unknown error"}`)).catch(() => void 0);
		return {
			kind: "spawn-failed",
			failure: failure ?? "unknown error"
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
//#region src/coordination/driver.ts
/** This process's coordination driver over the graph registry. */
var CoordinationDriver = class {
	ctx;
	log;
	fallbackMs;
	settleGraceMs;
	byStore = /* @__PURE__ */ new Map();
	registered = /* @__PURE__ */ new Set();
	/** Graphs holding an unsettled work item: the only ones the fallback tick reads. */
	active = /* @__PURE__ */ new Set();
	disposers = [];
	timer;
	stopped = false;
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		this.log = options.log ?? warnLine(ctx);
		this.fallbackMs = options.fallbackMs ?? 2e3;
		this.settleGraceMs = options.settleGraceMs ?? 3e4;
	}
	/** Subscribe to every wake-up source, take the registry's graphs over, and start the fallback tick. */
	install() {
		this.log(`coordination: assignments are kept in ${coordinationFile()}`);
		this.warnAboutRetiredNames();
		this.disposers.push(this.ctx.taskRuntime.registerTerminalReviewListener((fact) => {
			const graphId = this.byStore.get(fact.storeId);
			if (graphId !== void 0) this.wake(graphId).catch((error) => this.logLine(graphId, error));
		}));
		const on = this.ctx.on.bind(this.ctx);
		this.disposers.push(on("agent/status", (payload) => {
			const { agent, status } = payload;
			if (status !== "idle") return;
			this.wakeBySession(agent.id);
		}));
		this.disposers.push(on("graphs/selected", (graph) => this.observe(graph)));
		this.disposers.push(on("graphs/change", (snapshot) => this.observeAll(snapshot.graphs)));
		backgroundScan(this.log, "coordination driver", () => this.seed());
		this.timer = setInterval(() => {
			for (const graphId of this.active) this.wake(graphId).catch((error) => this.logLine(graphId, error));
		}, this.fallbackMs);
		this.timer.unref?.();
		return () => this.stop();
	}
	/** Release every subscription, cap and timer of this instance. */
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer !== void 0) clearInterval(this.timer);
		this.timer = void 0;
		for (const dispose of this.disposers.splice(0)) try {
			dispose();
		} catch (error) {
			this.log(`coordination: a subscription could not be released (${message(error)})`);
		}
		for (const storeId of this.registered) unregisterGraphImprovementCap(storeId);
		this.registered.clear();
		this.byStore.clear();
		this.active.clear();
	}
	/** Read the registry once: a graph the platform already holds gets its loop taken over here. */
	async seed() {
		if (this.stopped) return;
		const graphs = this.ctx.graphs;
		if (typeof graphs?.list !== "function") return;
		const all = await graphs.list();
		this.observeAll(all);
		await Promise.all(all.map(async (graph) => await this.wake(graph.id).catch((error) => this.logLine(graph.id, error))));
	}
	/** One graph activation: remember it when it is a current graph with RSI settings, forget it otherwise. */
	observe(graph) {
		if (this.stopped) return;
		if (graph.rsi === void 0 || graphAccess(graph).mode !== "current") {
			this.forget(graph.id);
			return;
		}
		const storeId = this.remember(graph);
		this.log(`coordination: graph ${graph.id} runs ${graph.rsi.iterationRounds} round(s) over store ${storeId}`);
		this.wake(graph.id).catch((error) => this.logLine(graph.id, error));
	}
	/** Reconcile the driven set against the registry: what gained settings joins, what lost them leaves. */
	observeAll(graphs) {
		const live = /* @__PURE__ */ new Set();
		for (const graph of graphs) {
			if (graph.rsi === void 0 || graphAccess(graph).mode !== "current") continue;
			this.remember(graph);
			live.add(graph.id);
		}
		for (const graphId of new Set(this.byStore.values())) if (!live.has(graphId)) this.forget(graphId);
	}
	/** One pass for one graph, inside its own serial region. */
	wake(graphId) {
		if (this.stopped) return Promise.resolve(void 0);
		return serializeCoordination(graphId, () => this.reconcile(graphId));
	}
	/** The graph one idle session belongs to, from the session's own coordination assignment. */
	async wakeBySession(sessionId$1) {
		const binding = await coordinationBindingSource().read(sessionId$1).catch(() => void 0);
		if (binding === void 0) return;
		const graphId = this.byStore.get(binding.rootStoreId);
		if (graphId === void 0) return;
		await this.wake(graphId).catch((error) => this.logLine(graphId, error));
	}
	/** Read facts → reduce → execute once, repeated while the facts keep moving; never awaits a session. */
	async reconcile(graphId) {
		let last;
		for (let pass = 0; pass < 8; pass += 1) {
			const step = await this.once(graphId);
			if (step === void 0) return last;
			last = step;
			if (!await this.execute(graphId, step)) return step;
		}
		return last;
	}
	/** The work items one graph holds, as the driver reads them. */
	async workOf(graphId) {
		return await workOf(await readCoordinationRows() ?? [], graphId);
	}
	/** One read-and-decide pass; `undefined` means this graph is not driven here any more. */
	async once(graphId) {
		const graph = await this.readGraph(graphId);
		if (graph === void 0) return void 0;
		const storeId = rootTaskStoreId(String(graph.rootSessionId));
		const snapshot = await this.ctx.task.snapshotIn(storeId).catch((error) => {
			this.log(`coordination: store ${storeId} could not be read (${message(error)})`);
		});
		if (snapshot === void 0) return {
			kind: "idle",
			detail: `store ${storeId} could not be read`
		};
		const rootLive = liveRootAgentOf(this.ctx, storeId);
		const facts = await this.factsFor(graph, storeId, snapshot, rootLive !== void 0);
		return facts === void 0 ? {
			kind: "idle",
			detail: "the store holds no settled round yet"
		} : reduce(facts);
	}
	/** The graph as this driver may drive it now, or `undefined` after forgetting it. */
	async readGraph(graphId) {
		if (this.stopped) return void 0;
		const graph = await this.ctx.graphs.get(graphId).catch((error) => {
			this.log(`coordination: graph ${graphId} could not be read (${message(error)})`);
		});
		if (graph === void 0 || graph.rsi === void 0 || graphAccess(graph).mode !== "current") {
			this.forget(graphId);
			return;
		}
		this.remember(graph);
		return graph;
	}
	/** The facts one decision is made from, or `undefined` when the graph has no settled round yet. */
	async factsFor(graph, storeId, snapshot, rootLive) {
		const config = graph.rsi;
		const root = rootTaskOf(snapshot);
		if (root === void 0) return void 0;
		const rounds = terminalRootRuns(snapshot, root.taskId);
		const run = rounds.at(-1);
		if (run === void 0) return void 0;
		const epoch = config.epoch ?? 1;
		const businessRound = rounds.length;
		const key = roundKeyOf({
			graphId: graph.id,
			epoch,
			businessRound,
			taskId: root.taskId,
			runId: run.runId
		});
		const rows = await readCoordinationRows() ?? [];
		const sessions = await readSessionFactsOf(this.ctx, [...rows.filter((row) => row.graphId === graph.id).map((row) => row.sessionId), String(graph.rootSessionId)]);
		const candidate = {
			key,
			storeId,
			sessionId: SessionId(randomUUID()),
			actor: String(graph.rootSessionId),
			digest: subjectDigest(key),
			focus: run.status === "verified" ? `the RSI loop's publication for round ${businessRound}` : `the RSI loop's repair of round ${businessRound}`,
			...graph.model === void 0 ? {} : { model: graph.model }
		};
		return {
			graph: {
				id: graph.id,
				name: graph.name,
				storeId,
				rootSessionId: String(graph.rootSessionId),
				config
			},
			snapshot,
			rows,
			sessions,
			budget: {
				used: spentOf(rows, storeId, sessions),
				max: coordinationBudget()
			},
			rootLive,
			candidate
		};
	}
	/** Run one reduction's action; `true` when the caller should look again immediately. */
	async execute(graphId, step) {
		await this.refreshActive(graphId).catch(() => void 0);
		switch (step.kind) {
			case "idle": return false;
			case "suspended":
				this.log(`coordination: graph ${graphId} ${step.phase} — ${step.detail}`);
				this.active.delete(graphId);
				return false;
			case "protocol-failure":
				await recordCompletion(protocolFailure(bindingOfAssignment(step.work.assignment, false), step.detail));
				this.log(`coordination: graph ${graphId} protocol failure — ${step.detail}`);
				return true;
			case "open-round":
				await this.openRound(graphId, step.request, step.work);
				return true;
			case "supervise": return await this.supervise(graphId, step);
		}
	}
	/** Keep the fallback tick pointed at the graphs that still have an unsettled work item. */
	async refreshActive(graphId) {
		if ((await workOf(await readCoordinationRows() ?? [], graphId)).some((work) => work.completion === void 0)) this.active.add(graphId);
		else this.active.delete(graphId);
	}
	/** Claim or recover the round's supervisor. */
	async supervise(graphId, step) {
		const graph = await this.readGraph(graphId);
		if (graph === void 0) return false;
		const storeId = rootTaskStoreId(String(graph.rootSessionId));
		const liveRoot = liveRootAgentOf(this.ctx, storeId);
		if (liveRoot === void 0) {
			this.log(`coordination: graph ${graphId} cannot be supervised here — the graph's root session is not live in this process`);
			this.active.add(graphId);
			return false;
		}
		if (step.plan.kind === "resume") return await this.resume(graph, step.plan.work);
		const reuse = step.plan.kind === "assign" ? step.plan.reuseSessionId : void 0;
		const request = {
			...step.request,
			...reuse === void 0 ? {} : { sessionId: SessionId(reuse) }
		};
		const snapshot = await this.ctx.task.snapshotIn(storeId);
		const rootTask = rootTaskOf(snapshot);
		const run = rootTask === void 0 ? void 0 : terminalRootRuns(snapshot, rootTask.taskId).at(-1);
		const businessRound = request.key.subject.kind === "round" ? request.key.subject.businessRound : 0;
		if (run === void 0) {
			this.log(`coordination: graph ${graphId} round ${businessRound} has no settled run to hand a supervisor`);
			this.active.delete(graphId);
			return false;
		}
		await this.settleRoundBubble(graph, businessRound);
		const prompt = await this.supervisionText(request, snapshot, graph, run.runId);
		const spawned = await spawnAssignment({
			ctx: this.ctx,
			request,
			parent: liveRoot.agent,
			name: `rsi supervisor for ${graphId} round ${businessRound}`,
			preset: COORDINATION_PRESET,
			grant: supervisorGrant(),
			role: "supervisor",
			prompt: () => prompt
		});
		this.active.add(graphId);
		this.log(`coordination: graph ${graphId} round ${businessRound} ${spawned.kind === "spawned" ? `supervisor session ${String(request.sessionId)} assigned` : `supervisor could not be spawned (${spawned.failure})`}`);
		return false;
	}
	/** Bring a stored session that never finished its turn back, under the assignment's own composition. */
	async resume(graph, work) {
		const assignment = work.assignment;
		try {
			await this.ctx.agentRuntime.resumeCoordinationSession({
				sessionId: SessionId(assignment.sessionId),
				scope: {
					graphStoreId: graph.graphStoreId,
					layoutStoreId: graph.layoutStoreId
				},
				coordinationRole: assignment.role,
				agentPreset: COORDINATION_PRESET,
				grant: assignment.role === "supervisor" ? supervisorGrant() : reviewerGrant(),
				permissionPreset: "danger-full-access"
			});
			this.active.add(graph.id);
			this.log(`coordination: graph ${graph.id} resumed ${assignment.role} session ${assignment.sessionId}`);
		} catch (error) {
			await recordCompletion(protocolFailure(bindingOfAssignment(assignment, false), `the coordination session could not be resumed: ${message(error)}`)).catch(() => void 0);
			this.log(`coordination: graph ${graph.id} could not resume session ${assignment.sessionId} (${message(error)})`);
		}
		return false;
	}
	/** Flush the concluded session, record the round's diagnosis, and open the next round. */
	async openRound(graphId, request, work) {
		const graph = await this.readGraph(graphId);
		if (graph === void 0) return;
		const storeId = rootTaskStoreId(String(graph.rootSessionId));
		const rootSessionId = String(graph.rootSessionId);
		await flushSessions(this.ctx);
		await this.awaitMaterialized(work.assignment.sessionId);
		if (await this.readGraph(graphId) === void 0) return;
		const snapshot = await this.ctx.task.snapshotIn(storeId);
		const root = rootTaskOf(snapshot);
		if (root === void 0) return;
		const config = graph.rsi;
		const epoch = config.epoch ?? 1;
		const diagnosisId = roundDiagnosisId(graphId, epoch, request.businessRound - 1);
		if (!snapshot.diagnoses.some((item) => item.diagnosisId === diagnosisId)) {
			const source = terminalRootRuns(snapshot, root.taskId).at(-1);
			if (source !== void 0) {
				const review = snapshot.reviews.find((item) => item.runId === source.runId);
				await this.ctx.task.recordDiagnosisIn(storeId, roundDiagnosis({
					diagnosisId,
					taskId: root.taskId,
					graphId,
					graphName: graph.name,
					epoch,
					businessRound: request.businessRound - 1,
					rounds: config.iterationRounds,
					objective: config.task,
					run: source,
					...review === void 0 ? {} : { review },
					producedBySessionId: rootSessionId
				}), rootSessionId).catch((error) => this.log(`coordination: graph ${graphId} could not record its round diagnosis (${message(error)})`));
			}
		}
		const envPath = await this.envPathOf(graph);
		const workspacePath = envPath === void 0 ? void 0 : await materializeBubble(envPath, bubbleHome(), rootSessionId, graphId, request.businessRound).catch((error) => {
			this.log(`coordination: graph ${graphId} round ${request.businessRound} bubble could not be materialized (${message(error)})`);
		});
		const recovery = {
			sourceTaskId: work.assignment.subject.source.taskId,
			sourceRunId: request.sourceRunId,
			sourceDiagnosisId: request.sourceDiagnosisId,
			requestKey: request.requestKey,
			mode: request.mode,
			...request.mode === "improve" ? { reuses: [] } : {},
			...workspacePath === void 0 ? {} : { workspacePath }
		};
		try {
			const outcome = await this.ctx.taskRuntime.recoverRootTask(storeId, recovery, { sessionId: rootSessionId });
			this.log(`coordination: graph ${graphId} round ${request.businessRound} ${outcome.attempt === "started" ? "opened" : "was already open"} — run ${outcome.runId} (${outcome.status})`);
		} catch (error) {
			const after = await this.ctx.task.snapshotIn(storeId).catch(() => void 0);
			const recorded = after === void 0 ? void 0 : terminalRootRuns(after, root.taskId).find((run) => run.recovery?.requestKey === request.requestKey);
			this.log(recorded === void 0 ? `coordination: graph ${graphId} round ${request.businessRound} could not be opened (${message(error)}); the same request key is retried on the next activation` : `coordination: graph ${graphId} round ${request.businessRound} was recorded ${recorded.status} despite its opening error (${message(error)}); the next activation reconciles the stored attempt`);
		}
	}
	/** Wait, bounded, for one completed session's own log to reach the persistence layer. */
	async awaitMaterialized(sessionId$1) {
		const persistence = optionalService(this.ctx, "sessionPersistence");
		if (typeof persistence?.stat !== "function") return;
		const deadline = Date.now() + this.settleGraceMs;
		while (Date.now() < deadline) {
			if (await persistence.stat(sessionId$1).catch(() => void 0) !== void 0) return;
			await new Promise((resolve$1) => setTimeout(resolve$1, 50));
		}
	}
	/** The one supervision request one round's supervisor receives. */
	async supervisionText(request, snapshot, graph, runId) {
		const storeId = rootTaskStoreId(String(graph.rootSessionId));
		const root = rootTaskOf(snapshot);
		const rounds = root === void 0 ? [] : terminalRootRuns(snapshot, root.taskId);
		const run = rounds.find((candidate) => candidate.runId === runId) ?? rounds.at(-1);
		const subject = request.key.subject;
		const businessRound = subject.kind === "round" ? subject.businessRound : rounds.length;
		const config = graph.rsi;
		const epoch = config.epoch ?? 1;
		const method = await activeMethodRevision(this.ctx, String(graph.rootSessionId));
		const review = snapshot.reviews.find((item) => item.runId === run.runId);
		return supervisionPrompt({
			graphId: graph.id,
			graphName: graph.name,
			epoch,
			businessRound,
			searchRound: subject.kind === "round" ? subject.searchRound : businessRound,
			rounds: config.iterationRounds,
			objective: config.task,
			metrics: config.metrics ?? [],
			outcome: run.status === "verified" ? "verified" : "failed",
			run,
			...review === void 0 ? {} : { review },
			diagnosisId: roundDiagnosisId(graph.id, epoch, businessRound),
			cost: await this.costLines(storeId, snapshot, run.runId),
			method: { ...method === void 0 ? {} : { activeRevision: method.revisionId } },
			finalRound: businessRound >= config.iterationRounds
		});
	}
	/** The round's and the graph's recorded effort, read from execution receipts alone. */
	async costLines(storeId, snapshot, runId) {
		const receipts = await this.ctx.taskRuntime.receiptsOfStore(storeId).catch(() => []);
		const round = receipts.find((receipt) => receipt.runId === runId);
		const roundUsage = round === void 0 ? void 0 : executionUsage(snapshot, round);
		const totalUsage = aggregateUsage(receipts.map((receipt) => executionUsage(snapshot, receipt)));
		return [
			renderExecutionCost("Current round execution tree", roundUsage, round?.subtree.length ?? 0),
			renderExecutionCost("Graph usage to date (executions and recorded coordination)", totalUsage, receipts.length),
			"Compare task effects with this recorded effort, including evaluation overhead. A reading an execution receipt does not carry remains unknown."
		];
	}
	/** The environment checkout one graph binds, when this deployment has an env builder. */
	async envPathOf(graph) {
		const envBuilder = optionalService(this.ctx, "envBuilder");
		if (typeof envBuilder?.store?.get !== "function") return void 0;
		try {
			return envBuilder.store.get(graph.envId).path;
		} catch {
			return;
		}
	}
	/** Persist one settled round's bubble, so the next round materializes from it. */
	async settleRoundBubble(graph, round) {
		const envPath = await this.envPathOf(graph);
		if (envPath === void 0 || round <= 0) return;
		await settleBubble(envPath, bubbleWorkspacePath(bubbleHome(), String(graph.rootSessionId), round), graph.id, round).catch((error) => this.log(`coordination: graph ${graph.id} round ${round} bubble could not be settled (${message(error)})`));
	}
	/** Bind one store to its graph before anything is read from it. */
	remember(graph) {
		const storeId = rootTaskStoreId(String(graph.rootSessionId));
		this.byStore.set(storeId, graph.id);
		registerGraphImprovementCap(storeId, graph.rsi?.iterationRounds ?? 0);
		this.registered.add(storeId);
		return storeId;
	}
	/** A graph this driver no longer drives: its cap goes away with it. */
	forget(graphId) {
		for (const [storeId, id] of [...this.byStore]) {
			if (id !== graphId) continue;
			this.byStore.delete(storeId);
			unregisterGraphImprovementCap(storeId);
			this.registered.delete(storeId);
		}
		this.active.delete(graphId);
	}
	/** The retired environment names, said at startup instead of being silently honoured (R20). */
	warnAboutRetiredNames() {
		const retired = ["SINGULARITY_REVIEW_LEDGER_DIR", "SINGULARITY_REVIEW_AGENT_BUDGET"].filter((name) => (process.env[name] ?? "").length > 0);
		if (retired.length === 0) return;
		this.log(`coordination: ${retired.join(" and ")} ${retired.length === 1 ? "is" : "are"} no longer read; this deployment's coordination store is ${coordinationFile()}`);
	}
	logLine(graphId, error) {
		this.log(`coordination: graph ${graphId}: ${message(error)}`);
	}
};
/** How many assignments of one store have materialized a session — the spend the allowance counts. */
function spentOf(rows, storeId, sessions) {
	return rows.filter((row) => row.kind === "assignment" && row.storeId === storeId).filter((row) => sessionSpent(sessions.get(row.sessionId))).length;
}
/** The bubble home this deployment's round workspaces live under. */
function bubbleHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}
/** Install one deployment's coordination driver and register its fact reader. */
function installCoordinationDriver(ctx, options = {}) {
	const driver = new CoordinationDriver(ctx, options);
	return {
		driver,
		dispose: driver.install()
	};
}

//#endregion
//#region src/tools/completion-tools.ts
const SUPERVISOR_PARAMETERS = [
	"businessAction",
	"reason",
	"evidenceRefs",
	"trialCandidateRef"
];
const REVIEWER_PARAMETERS = [
	"observation",
	"conclusion",
	"confidence",
	"scope",
	"reviewRefs",
	"evidenceRefs",
	"relatedTaskIds",
	"judgements",
	"proposals"
];
/** Why a completion call was refused, in the caller's own terms. */
function refuse(tool, detail) {
	return `${tool} rejected: ${detail}; nothing was recorded and this session may still work`;
}
/** The already-recorded completion one repeat of a call returns. */
function alreadySettled(tool, binding, summary) {
	return `${tool}: this session (${binding.sessionId}) already settled its work item — ${summary}; a completion is recorded once`;
}
/** The completion call's own binding: the session must hold an unsettled work item of the expected role. */
async function bindingFor(tool, caller, role) {
	const binding = await readCoordinationBinding(caller);
	if (binding === void 0) throw new Error(refuse(tool, `session "${caller}" holds no coordination work item; the platform assigns work, a session never claims it`));
	if (binding.role !== role) throw new Error(refuse(tool, `session "${caller}" is recorded as a ${binding.role}, and only a ${role} calls ${tool}`));
	return binding;
}
/** The graph's configured round count, when this deployment's registry can answer for it. */
async function readGraphRounds(ctx, graphId) {
	const graphs = ctx.graphs;
	if (typeof graphs?.get !== "function") return void 0;
	try {
		return (await graphs.get(graphId)).rsi?.iterationRounds;
	} catch {
		return;
	}
}
/** The supervisor's completion tool. */
function defineSupervisorCompleteTool(ctx) {
	return defineTool({
		name: "supervisor_complete",
		description: "Conclude this round and tell the platform what the business work does next. businessAction is your own judgement of the business step only: 'continue' when the verified round's work should run again with the improved method, 'recover' when the failed round must be repaired and tried again, 'finish' when the business work should not run another round. reason is non-empty free text. evidenceRefs must name at least one reference this store already holds (a review ref taskId#runId, an evidence bundle id, or a criterion id) — a conclusion that rests on nothing is not recorded. trialCandidateRef is optional and names one candidate this next round should explicitly try. The method decision, the approval source and whether the method search continues are derived by the platform from what this round actually recorded: they are not parameters, and passing one is an undeclared parameter. businessAction must agree with the round you were given: continue after a verified round, recover after a failed one, finish in either case. Calling this tool closes this session’s write access; reads and findings stay available, and the platform opens the next execution after this session’s log is flushed.",
		parameters: {
			businessAction: {
				type: "string",
				required: true,
				enum: [
					"continue",
					"recover",
					"finish"
				],
				description: "What the business work does next: continue | recover | finish"
			},
			reason: {
				type: "string",
				required: true,
				description: "Why this is the right next step, in your own words"
			},
			evidenceRefs: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "At least one recorded reference: a review ref taskId#runId, an evidence bundle id, or a criterion id"
			},
			trialCandidateRef: {
				type: "string",
				description: "Optional: the candidate id the next round should explicitly try without promoting it"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, SUPERVISOR_PARAMETERS, "supervisor_complete");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "supervisor_complete");
			let binding;
			try {
				binding = await bindingFor("supervisor_complete", caller, "supervisor");
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			if (binding.completed) return alreadySettled("supervisor_complete", binding, `the round already has a completion for session ${binding.sessionId}`);
			const snapshot = await ctx.task.openStore(binding.rootStoreId);
			const outcome = snapshot.runs.find((candidate) => candidate.runId === binding.sourceRunId)?.status === "verified" ? "verified" : "failed";
			const payload = {
				businessAction: args.businessAction,
				reason: args.reason,
				evidenceRefs: Array.isArray(args.evidenceRefs) ? args.evidenceRefs : [],
				...typeof args.trialCandidateRef === "string" && args.trialCandidateRef.trim().length > 0 ? { trialCandidateRef: args.trialCandidateRef } : {}
			};
			const validated = validateSupervisorCompletion({
				binding,
				snapshot,
				outcome,
				payload
			});
			if (!validated.ok) return `supervisor_complete rejected: ${validated.refusal}; nothing was recorded`;
			const action = validated.payload.businessAction;
			if (action !== "finish" && nextRoundMode(action, outcome) === void 0) return `supervisor_complete rejected: businessAction "${action}" does not agree with the round this session was given (the source run settled ${outcome}); use ${outcome === "verified" ? "'continue'" : "'recover'"} or 'finish'; nothing was recorded`;
			const graph = await readGraphRounds(ctx, binding.graphId);
			const businessRound = binding.subject.kind === "round" ? binding.subject.businessRound : 0;
			const rounds = graph ?? businessRound;
			const records = await roundMethodRecords(ctx, binding.graphId, businessRound);
			const completion = supervisorCompletion(binding, validated.payload, {
				...methodDecisionOf(records, validated.payload.trialCandidateRef),
				searchNext: searchNextOf({
					businessRound,
					rounds
				})
			});
			await recordCompletion(completion);
			ctx.agentRuntime.sealCoordinationSession(caller);
			return renderCompletion(completion);
		}
	});
}
/** The reviewer's completion tool. */
function defineReviewerCompleteTool(ctx) {
	return defineTool({
		name: "reviewer_complete",
		description: "Conclude this review and record the diagnosis it produced. observation is required: the postmortem observation (复盘观察) — what was actually observed in the source, whether it failed or succeeded. conclusion is required: the cause, citing the original outcome evidence. confidence is required: high, medium or low. scope, reviewRefs, evidenceRefs and relatedTaskIds are optional and must name records this store already holds (reviewRefs as exact taskId#runId or taskId#no-run; evidenceRefs as evidence bundle ids). judgements are optional: [{dimension, verdict, evidenceRefs, rationale}] where dimension is one of the judged dimensions, verdict is adequate|inadequate|unknown, and each judgement cites at least one recorded ref and a rationale — a judgement that cites nothing is refused rather than downgraded. proposals are optional suggestions ([{targetType, targetId, rationale}]); nothing here executes them. Calling this tool writes the Diagnosis and closes this session’s write access. A session that ends its turn without calling it is a protocol failure: no diagnosis is invented from its silence, and the platform does not ask again.",
		parameters: {
			observation: {
				type: "string",
				required: true,
				description: "The postmortem observation (复盘观察): what was actually observed"
			},
			conclusion: {
				type: "string",
				required: true,
				description: "The cause, citing the original outcome evidence"
			},
			confidence: {
				type: "string",
				required: true,
				enum: [
					"high",
					"medium",
					"low"
				],
				description: "How sure you are; coarse on purpose"
			},
			scope: {
				type: "string",
				description: "How far the cause reaches (this task, its subtree, a shared assumption, …)"
			},
			reviewRefs: {
				type: "array",
				items: { type: "string" },
				description: "Exact taskId#runId (or taskId#no-run) refs this conclusion rests on"
			},
			evidenceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Evidence bundle ids read through context_read kind:\"evidence\""
			},
			relatedTaskIds: {
				type: "array",
				items: { type: "string" },
				description: "Actual task ids in this graph the finding spans"
			},
			judgements: {
				type: "array",
				description: "Optional judgements on dimensions no parser settles; each needs refs and a rationale",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						dimension: {
							type: "string",
							required: true,
							description: "One of the judged dimensions"
						},
						verdict: {
							type: "string",
							required: true,
							enum: [
								"adequate",
								"inadequate",
								"unknown"
							],
							description: "The judgement"
						},
						evidenceRefs: {
							type: "array",
							items: { type: "string" },
							required: true,
							description: "At least one recorded ref"
						},
						rationale: {
							type: "string",
							required: true,
							description: "Why this verdict, grounded in the refs"
						}
					}
				}
			},
			proposals: {
				type: "array",
				description: "Optional structured suggestions for the supervisor; stored as data, never auto-executed",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						targetType: {
							type: "string",
							required: true,
							description: "The mutation surface the suggestion points at"
						},
						targetId: {
							type: "string",
							required: true,
							description: "The concrete target name"
						},
						rationale: {
							type: "string",
							required: true,
							description: "The mechanism, expected benefit and how it could be tested"
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
			const undeclared = undeclaredParameters(args, REVIEWER_PARAMETERS, "reviewer_complete");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "reviewer_complete");
			let binding;
			try {
				binding = await bindingFor("reviewer_complete", caller, "reviewer");
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			if (binding.completed) {
				const diagnosis$1 = (await ctx.task.openStore(binding.rootStoreId)).diagnoses.find((item) => item.diagnosisId === `review-agent-${binding.sessionId}`);
				return alreadySettled("reviewer_complete", binding, diagnosis$1 === void 0 ? "the review already has a completion" : `diagnosis ${diagnosis$1.diagnosisId} is recorded`);
			}
			const snapshot = await ctx.task.openStore(binding.rootStoreId);
			const validated = validateReviewCompletion({
				binding,
				snapshot,
				payload: args
			});
			if (!validated.ok) return `reviewer_complete rejected: ${validated.refusal}; nothing was recorded`;
			const diagnosis = validated.payload.diagnosis;
			try {
				await ctx.task.recordDiagnosisIn(binding.rootStoreId, diagnosis, binding.sessionId);
			} catch (error) {
				return `reviewer_complete rejected: the diagnosis could not be recorded (${error instanceof Error ? error.message : String(error)}); nothing was recorded`;
			}
			await recordCompletion(reviewCompletion(binding, diagnosis.diagnosisId, diagnosis.confidence));
			ctx.agentRuntime.sealCoordinationSession(caller);
			return [
				`reviewer_complete: diagnosis ${diagnosis.diagnosisId} [${diagnosis.confidence}] recorded`,
				`refs: ${diagnosis.reviewRefs.length} review, ${diagnosis.evidenceRefs.length} evidence, ${(diagnosis.relatedTaskIds ?? []).length} related task(s)`,
				`judgements: ${diagnosis.judgements?.length ?? 0}; proposals: ${diagnosis.proposals.length} (suggestions only)`,
				"writes are closed for this session; reads and findings remain available"
			].join("; ");
		}
	});
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
/**
* One graph-owned table for reusable Task contracts and methods, read through the
* one version view. Writing is not an action any role holds here: a change to the
* executable library is a method candidate (`method_draft`) that an evaluation and
* a publish switch into effect, and no model edits the library's bytes directly.
*/
function defineTaskLibraryTool(ctx) {
	return defineTool({
		name: "task_library",
		description: "Read this graph's TaskTemplate and Skill library — the table binding a Task contract to a method. Use task_template_list for complete contracts and bind method:<name> through requiredCapabilities. This tool is read-only for every role: to change a method, propose a candidate with method_draft and let it be evaluated and published.",
		parameters: { action: {
			type: "string",
			enum: ["read"],
			required: true,
			description: "Only read: the library is never edited in place"
		} },
		output: {
			schema: { type: "string" },
			render: (_args, value) => text(value)
		},
		execute: async (args, exec) => {
			try {
				const caller = sessionId(exec, "task_library");
				if (args.action !== "read") return `task_library rejected: "${String(args.action)}" is not an action this tool offers — it reads only. A method change is a candidate: propose it with method_draft, measure it with method_evaluate and publish it with method_publish.`;
				return JSON.stringify(await ctx.taskRuntime.libraryRead(caller), null, 2);
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
			const lines$1 = names.flatMap((name) => {
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
				...lines$1,
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
//#region src/tools/method-render.ts
/** A digest short enough to match two readings by eye. */
function short(digest) {
	return digest.slice(0, 12);
}
function lines(text$1) {
	return text$1.length === 0 ? [] : text$1.replace(/\n$/, "").split("\n");
}
/**
* The changed region of two line arrays, as unified-diff lines with three lines
* of context. The longest common subsequence keeps unchanged inner lines out of
* the hunk, so a reader sees what moved rather than the whole file.
*/
function unifiedLines(before, after) {
	const n = before.length;
	const m = after.length;
	const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i$1 = n - 1; i$1 >= 0; i$1 -= 1) for (let j$1 = m - 1; j$1 >= 0; j$1 -= 1) table[i$1][j$1] = before[i$1] === after[j$1] ? table[i$1 + 1][j$1 + 1] + 1 : Math.max(table[i$1 + 1][j$1], table[i$1][j$1 + 1]);
	const marks = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) if (before[i] === after[j]) {
		marks.push(` ${before[i]}`);
		i += 1;
		j += 1;
	} else if (table[i + 1][j] >= table[i][j + 1]) {
		marks.push(`-${before[i]}`);
		i += 1;
	} else {
		marks.push(`+${after[j]}`);
		j += 1;
	}
	for (; i < n; i += 1) marks.push(`-${before[i]}`);
	for (; j < m; j += 1) marks.push(`+${after[j]}`);
	const changed = marks.map((mark) => mark[0] !== " ");
	return marks.filter((_mark, index) => changed.slice(Math.max(0, index - 3), index + 4).some(Boolean));
}
/** Every file one revision directory holds, relative to it. */
async function filesOf(root, prefix = "") {
	let entries;
	try {
		entries = await readdir(join(root, prefix), { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const files = [];
	for (const entry of entries) {
		const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) files.push(...await filesOf(root, path));
		else if (entry.isFile()) files.push(path);
	}
	return files.filter((path) => path !== "manifest.json" && path !== "draft.json").sort();
}
/** The content digest of one file's bytes, as the ledger records it. */
async function digestOfFile(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}
/**
* The complete asset difference between two frozen revisions: every file either
* side holds, with a unified view and the digest of the bytes this difference
* reports.
*/
async function diffOfRevisions(from, to) {
	const before = from === null ? [] : await filesOf(from.root);
	const after = await filesOf(to.root);
	const paths = [...new Set([...before, ...after])].sort();
	const files = [];
	for (const path of paths) {
		const inBefore = before.includes(path);
		const inAfter = after.includes(path);
		const beforeText = inBefore ? await readFile(join(from.root, path), "utf8") : "";
		const afterText = inAfter ? await readFile(join(to.root, path), "utf8") : "";
		const change = !inBefore ? "added" : !inAfter ? "removed" : "updated";
		if (change === "updated" && beforeText === afterText) continue;
		files.push({
			path,
			change,
			unified: unifiedLines(lines(beforeText), lines(afterText)),
			sha256: inAfter ? await digestOfFile(join(to.root, path)) : await digestOfFile(join(from.root, path))
		});
	}
	const digest = createHash("sha256").update(files.map((file) => `${file.change} ${file.path} ${file.sha256}`).join("\n")).digest("hex");
	return {
		from: from?.manifest.revisionId ?? null,
		to: to.manifest.revisionId,
		files,
		digest
	};
}
/** One revision difference as the approval's own lines, truncated by the caller's ceiling. */
function renderDiff(diff, options = {}) {
	const maxFiles = options.maxFiles ?? 12;
	const maxLines = options.maxLinesPerFile ?? 120;
	const shown = diff.files.slice(0, maxFiles);
	const out = [`asset diff (${diff.files.length} file${diff.files.length === 1 ? "" : "s"}, diff ${diff.digest}):`];
	out.push(`  from ${diff.from ?? "(nothing)"} → ${diff.to}`);
	for (const file of shown) {
		const counted = file.unified.reduce((counts, line) => line.startsWith("-") ? {
			added: counts.added,
			removed: counts.removed + 1
		} : line.startsWith("+") ? {
			added: counts.added + 1,
			removed: counts.removed
		} : counts, {
			added: 0,
			removed: 0
		});
		out.push(`  --- ${file.path} (${file.change}, +${counted.added}/-${counted.removed}, sha256:${short(file.sha256)})`);
		for (const line of file.unified.slice(0, maxLines)) out.push(`  ${line}`);
		if (file.unified.length > maxLines) out.push(`  … ${file.unified.length - maxLines} more lines (diff ${diff.digest})`);
	}
	if (diff.files.length > maxFiles) out.push(`  … ${diff.files.length - maxFiles} more files (diff ${diff.digest})`);
	return out;
}
/** One sample's two sides and their verdict, in the words the report uses. */
function sampleLine(comparison) {
	const tokens = (trial) => trial.receipt.cost.status === "reported" ? `${trial.receipt.cost.tokens.uncachedInputTokens + trial.receipt.cost.tokens.outputTokens + trial.receipt.cost.tokens.cacheReadTokens + trial.receipt.cost.tokens.cacheWriteTokens} tokens` : `cost unknown (${trial.receipt.cost.reason})`;
	return `  ${comparison.sampleTaskId} [${comparison.role}] baseline ${comparison.baseline.outcome} (${tokens(comparison.baseline)}) → candidate ${comparison.candidate.outcome} (${tokens(comparison.candidate)}) — ${comparison.verdict}`;
}
/** The evaluation one publication rests on: the frozen identity, the samples and the score. */
function renderEvaluation(report) {
	const score = report.score;
	const cost = score.cost.status === "reported" ? `status reported, baseline ${score.cost.baselineTokens} → candidate ${score.cost.candidateTokens} tokens (relative delta ${score.cost.relativeDelta.toFixed(3)})` : `status unknown (${score.cost.reason}) — an unknown cost is inconclusive, never a zero`;
	return [
		`evaluation ${report.evaluationId} (report ${report.planDigest.slice(0, 12)}, verdict ${report.verdict}, repetition ${report.plan.repetition + 1}):`,
		`  plan ${report.planId} (plan digest ${report.planDigest.slice(0, 12)}, scope ${report.plan.strategy?.cohortDigest.slice(0, 12) ?? "(unfrozen)"})`,
		`  model ${report.plan.sides.candidate.model.label}; baseline revision ${report.plan.sides.baseline.revision.revisionId} (${short(report.plan.sides.baseline.revision.digest)}), candidate ${report.plan.sides.candidate.revision.revisionId} (${short(report.plan.sides.candidate.revision.digest)})`,
		...report.trials.map(sampleLine),
		`  quality: baseline ${score.quality.baseline.toFixed(4)} → candidate ${score.quality.candidate.toFixed(4)} (delta ${score.quality.delta >= 0 ? "+" : ""}${score.quality.delta.toFixed(4)} ${score.quality.unit})`,
		`  cost: ${cost}`,
		`  uncertainty: basis ${score.uncertainty.basis}, repeats ${score.uncertainty.repeats}, noise band ${score.uncertainty.noiseBand === null ? "none observed" : score.uncertainty.noiseBand.toFixed(4)}${score.uncertainty.reason === void 0 ? "" : ` (${score.uncertainty.reason})`}`,
		`  guards (non-compensatory): ${report.guards.length === 0 ? "none declared" : report.guards.map((guard) => `${guard.id} ${guard.ok ? "held" : "FAILED"} — ${guard.detail}`).join("; ")}`,
		`  inconclusive: ${score.inconclusive ? "yes" : "no"}`
	];
}
/** The frozen strategy's admission of one candidate, with the calibration it was read under. */
function renderAdmission(admission, calibration) {
	return [
		`admission: ${admission.reasonCode} — ${admission.reason}`,
		`  deltaQuality ${admission.deltaQuality === void 0 ? "unknown" : admission.deltaQuality.toFixed(4)}; deltaCost ${admission.deltaCost === void 0 ? "unknown" : admission.deltaCost.toFixed(4)}; novelty ${admission.novelty}; bundleLevel ${admission.bundleLevel ? "yes" : "no"}; guards [${admission.guards.join(", ")}]`,
		`  calibration: ${calibration.method}, ${calibration.evaluations} evaluation(s), quality band ${calibration.qualityBand.toFixed(4)}, relative cost band ${calibration.relativeCostBand.toFixed(3)}${calibration.degenerate ? " (degenerate — no noise observed, the declared floor stands)" : ""}`
	];
}
/** The exact pointer switch one publication would make. */
function renderVersionSwitch(input) {
	return `version switch: ${input.pointer === null ? "active (none)" : `active ${input.pointer.revisionId} g${input.pointer.generation} (${short(input.pointer.manifestDigest)})`} → candidate ${input.candidate.revisionId} (${short(input.candidate.manifestDigest)}); mode ${input.mode}`;
}
/**
* The one publication approval text: the candidate's identity, the exact version
* switch, the complete asset difference, the evaluation, the admission and what
* a rollback would restore. Every refusal above has already landed, and nothing
* has been written when this is rendered.
*/
function renderPublishReason(input) {
	return [
		`Method publish for ${input.draft.kind} ${input.draft.identity} (draft ${input.draft.draftId}, base ${input.draft.baseRevision.revisionId}, bundle ${input.admission.bundleLevel ? "yes" : "no"})`,
		renderVersionSwitch({
			pointer: input.pointer,
			candidate: input.candidate,
			mode: input.mode
		}),
		...input.diff,
		...renderEvaluation(input.report),
		...renderAdmission(input.admission, input.calibration),
		`mode: ${input.mode === "auto" ? `auto (the platform policy decides and records; the decider is ${input.decider})` : `manual (a human decides; the decider is ${input.decider})`}`,
		`rollback: method_rollback toRevision=${input.rollbackToRevisionId ?? "none (this is the library's first publication)"}`,
		...input.extra ?? [],
		"nothing has been written yet; the pointer moves only if this approval is granted and the post-approval re-check still passes"
	].join("\n");
}
/** What one settled pointer switch reports. */
function renderPublishOutcome(outcome, mode, decider) {
	return [
		`published: active revision ${outcome.pointer.revisionId} g${outcome.pointer.generation} (${short(outcome.pointer.manifestDigest)})`,
		`superseded: ${outcome.supersededRevisionId ?? "(nothing — the library held no revision)"}`,
		`completion: ${outcome.completion.intentId} (${outcome.recovered}); approval ${outcome.completion.approvalRef ?? "(none recorded)"}`,
		`mode ${mode}; decided by ${decider}`,
		"new Runs admit against this revision; Runs already bound keep the revision they were admitted against"
	];
}
/** What one discard reports; nothing was measured and nothing moved. */
function renderDiscard(view, outcome, reason) {
	return [
		`discarded ${view.draft.kind} ${view.draft.identity} (draft ${view.draft.draftId}) as ${outcome}`,
		`reason: ${reason}`,
		view.evaluation === void 0 ? "this candidate was never measured: the refusal is recorded, the denominator does not shrink and the method search keeps its slots" : `the evaluation ${view.evaluation.evaluationId} stays on the ledger as the evidence this candidate was refused on`,
		"no approval was required and the active revision is unchanged"
	];
}
/** What a resumed pointer intent reports: the switch was continued, not restarted. */
function renderRecoveredIntent(intent, settled) {
	return [
		`recovered pointer intent ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}): ${settled.result}`,
		`no second approval was requested — the intent already binds ${intent.approvalRef ?? "(no approval recorded)"}`,
		settled.result === "blocked" ? `the switch could not be settled: ${settled.detail ?? "no reason reported"}` : `the effective revision is now ${settled.revisionId}; the run the approval was for continues without being asked again`
	];
}
/** One draft line, as the list tool and the Web both render it. */
function renderDraftLine(view) {
	const handled = view.published !== void 0 ? ` → published ${view.published.revisionId}` : view.rolledback !== void 0 ? ` → rolled back to ${view.rolledback.revisionId}` : "";
	const verdict = view.evaluation === void 0 ? "" : ` verdict ${view.evaluation.verdict}`;
	return `- ${view.draft.draftId} [${view.status}] ${view.draft.kind} ${view.draft.identity} candidate ${short(view.draft.candidateRevision.digest)}${verdict}${handled}`;
}

//#endregion
//#region src/tools/method-discard.ts
const PARAMETERS$5 = [
	"draftId",
	"outcome",
	"reason",
	"evidenceRefs"
];
/** The outcomes a discard may name; only a measured one answers a question the round asked. */
const OUTCOMES = [
	"measured-rejected",
	"unmeasured-declined",
	"falsified",
	"duplicate",
	"pruned"
];
function defineMethodDiscardTool(ctx) {
	return defineTool({
		name: "method_discard",
		description: "Discard one candidate: record why it is refused and remove its working directory. No approval is requested and the active revision never moves. Name the outcome — measured-rejected for a candidate the frozen strategy refused, unmeasured-declined for one declined before measurement and therefore not counted against the measured history, falsified, duplicate or pruned. A falsified candidate must cite the evidence that falsified it.",
		parameters: {
			draftId: {
				type: "string",
				required: true,
				description: "The draft to discard"
			},
			outcome: {
				type: "string",
				required: true,
				enum: [...OUTCOMES],
				description: "Why this candidate is closed"
			},
			reason: {
				type: "string",
				required: true,
				description: "The refusal, in the words the history will show"
			},
			evidenceRefs: {
				type: "array",
				items: { type: "string" },
				description: "Required for falsified: the evidence that falsified this candidate"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, PARAMETERS$5, "method_discard");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "method_discard");
			try {
				if (typeof args.draftId !== "string" || args.draftId.length === 0) throw new Error("draftId is required");
				const outcome = args.outcome;
				if (!OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(" | ")}`);
				if (typeof args.reason !== "string" || args.reason.trim().length === 0) throw new Error("reason must be non-empty free text");
				const evidenceRefs = Array.isArray(args.evidenceRefs) ? args.evidenceRefs : [];
				if (outcome === "falsified" && evidenceRefs.length === 0) throw new Error("a falsified candidate must cite the evidenceRefs that falsified it; a refutation without evidence is not one");
				const ledger = await methodLedgerPlaneOf(ctx, caller);
				const view = await ledger.view(args.draftId);
				if (view.status === "published") return `method_discard rejected: draft "${args.draftId}" is published as revision ${view.published?.revisionId}; a published revision is restored with method_rollback, not discarded`;
				if (view.status === "discarded") return `method_discard rejected: draft "${args.draftId}" is already discarded (${view.discardReason ?? "no reason recorded"})`;
				const recorded = await ledger.discardDraft({
					draftId: args.draftId,
					reason: `${outcome}: ${args.reason}${evidenceRefs.length === 0 ? "" : ` [evidence: ${evidenceRefs.join(", ")}]`}`,
					actor: caller
				});
				const cleaned = await environmentPlaneOf(ctx).removeEnvironmentDraft(caller, args.draftId).then(() => true, (error) => {
					if (/is absent; nothing to discard/.test(message(error))) return false;
					throw error;
				});
				return [...renderDiscard(recorded, outcome, args.reason), cleaned ? "the draft working directory was removed" : "the draft working directory was already absent"].join("\n");
			} catch (error) {
				return `method_discard rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/method-draft.ts
const PARAMETERS$4 = [
	"kind",
	"identity",
	"edits",
	"editPayload",
	"rationale",
	"sourceRefs",
	"expectedBaseRevision",
	"round",
	"critic"
];
/** One declared edit, as the tool's own parameter shape reads it. */
function declaredEditsOf(raw) {
	if (!Array.isArray(raw)) throw new Error("edits must be an array of {id, mechanism, hypothesis?, targets?}");
	return raw.map((entry, index) => {
		if (typeof entry !== "object" || entry === null) throw new Error(`edits[${index}] must be an object`);
		const record = entry;
		if (typeof record.id !== "string" || record.id.length === 0) throw new Error(`edits[${index}].id must be a non-empty string`);
		if (typeof record.mechanism !== "string") throw new Error(`edits[${index}].mechanism must name a mechanism`);
		return {
			id: record.id,
			mechanism: record.mechanism,
			...typeof record.hypothesis === "string" ? { hypothesis: record.hypothesis } : {},
			targets: Array.isArray(record.targets) ? record.targets.filter((item) => typeof item === "string") : []
		};
	});
}
function criticOf(raw) {
	if (raw === void 0) return void 0;
	if (typeof raw !== "object" || raw === null) throw new Error("critic must be an object {verdict, reason, evidenceRefs}");
	const record = raw;
	if (record.verdict !== "accept" && record.verdict !== "reject") throw new Error("critic.verdict must be accept or reject");
	if (typeof record.reason !== "string" || record.reason.length === 0) throw new Error("critic.reason must be non-empty free text");
	if (!Array.isArray(record.evidenceRefs) || record.evidenceRefs.length === 0) throw new Error("critic.evidenceRefs must cite at least one reference");
	return {
		verdict: record.verdict,
		reason: record.reason,
		evidenceRefs: record.evidenceRefs.filter((item) => typeof item === "string"),
		criticId: `draft-critic:${record.verdict}`,
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
}
/** The complete asset content one candidate stages, in this asset kind's own shape. */
function editOf(kind, identity, payload, actor, currentVersion) {
	if (kind === "skill") {
		let parsed$1;
		try {
			parsed$1 = JSON.parse(payload);
		} catch {
			parsed$1 = void 0;
		}
		if (typeof parsed$1 === "string") return {
			kind: "skill",
			edit: {
				name: identity,
				skillMd: parsed$1,
				actor,
				expectedVersion: currentVersion
			}
		};
		if (typeof parsed$1 !== "object" || parsed$1 === null) return {
			kind: "skill",
			edit: {
				name: identity,
				skillMd: payload,
				actor,
				expectedVersion: currentVersion
			}
		};
		const record = parsed$1;
		if (typeof record.skillMd !== "string" || record.skillMd.trim().length === 0) throw new Error("a skill candidate's editPayload must carry skillMd (the complete SKILL.md), or be the SKILL.md text itself");
		const resources = record.resources;
		return {
			kind: "skill",
			edit: {
				name: identity,
				skillMd: record.skillMd,
				...resources === void 0 || typeof resources !== "object" || resources === null ? {} : { resources },
				expectedVersion: currentVersion,
				actor
			}
		};
	}
	if (kind === "task-template") {
		const template = parsePayload(payload).template;
		if (typeof template !== "object" || template === null) throw new Error("a task-template candidate's editPayload must carry template (the complete template)");
		if (template.id !== identity) throw new Error(`a task-template candidate's identity "${identity}" must be the template's own id`);
		return {
			kind: "task",
			edit: {
				template,
				actor
			}
		};
	}
	const parsed = parsePayload(payload);
	const entry = parsed.entry === void 0 ? { ...parsed } : parsed.entry;
	if (entry !== null && (typeof entry !== "object" || Array.isArray(entry))) throw new Error("a capability candidate's editPayload must carry entry (the complete row, or null to remove it)");
	const mcpServers = parsed.mcpServers;
	return {
		kind: "capability",
		edit: {
			name: identity,
			entry,
			...mcpServers === void 0 || typeof mcpServers !== "object" || mcpServers === null ? {} : { mcpServers },
			actor
		}
	};
}
function parsePayload(payload) {
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch (error) {
		throw new Error(`editPayload is not readable JSON (${message(error)})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("editPayload must be a JSON object");
	return parsed;
}
/** The version of one skill in the active revision, `0` when the name is new. */
function versionOf(skills, identity) {
	return skills.find((skill) => skill.name === identity)?.version ?? 0;
}
function defineMethodDraftTool(ctx) {
	return defineTool({
		name: "method_draft",
		description: "Propose one candidate method for this graph library. Name one asset kind, its stable identity, the complete new content, the experiments this evidence answers and the independent mechanism you are testing. The base revision must be the active one, and the number of independent edits must fit the round's frozen edit budget. The candidate is checked for structure and screened before any measurement: a refusal names its reason and consumes no evaluation budget. Nothing becomes effective until method_publish switches the pointer. Next: method_evaluate.",
		parameters: {
			kind: {
				type: "string",
				required: true,
				enum: [
					"skill",
					"task-template",
					"capability"
				],
				description: "Which asset class this candidate changes"
			},
			identity: {
				type: "string",
				required: true,
				description: "The asset's stable identity: a skill name, a template id, or a capability row name"
			},
			edits: {
				type: "array",
				required: true,
				description: "The independent mechanism(s) this candidate declares: [{id, mechanism, hypothesis?, targets?}]",
				items: {
					type: "object",
					additionalProperties: true,
					properties: {
						id: {
							type: "string",
							description: "This edit's own id"
						},
						mechanism: {
							type: "string",
							enum: [
								"skill",
								"capability",
								"task-template",
								"text",
								"parameter"
							],
							description: "The mechanism the change belongs to"
						},
						hypothesis: {
							type: "string",
							description: "What this edit is testing"
						},
						targets: {
							type: "array",
							items: { type: "string" },
							description: "The asset paths the edit really touches"
						}
					}
				}
			},
			editPayload: {
				type: "string",
				required: true,
				description: "The complete new content as JSON: {\"skillMd\":…,\"resources\":…} for a skill (or the SKILL.md text itself), {\"template\":…} for a task template, {\"entry\":…,\"mcpServers\":…} for a capability row"
			},
			rationale: {
				type: "string",
				required: true,
				description: "Why this candidate is worth measuring"
			},
			sourceRefs: {
				type: "array",
				required: true,
				items: { type: "string" },
				description: "The recorded evidence this candidate answers: diagnosis:<id>, task:<taskId>#<runId>, or an evidence id"
			},
			expectedBaseRevision: {
				type: "string",
				required: true,
				description: "The active revision id this candidate was written against; a pointer that moved refuses the draft"
			},
			round: {
				type: "integer",
				required: true,
				description: "The search round this candidate belongs to; the edit budget is derived from it"
			},
			critic: {
				type: "object",
				description: "The one independent pre-measurement critic verdict: {verdict: accept|reject, reason, evidenceRefs}",
				additionalProperties: true,
				properties: {
					verdict: {
						type: "string",
						enum: ["accept", "reject"]
					},
					reason: { type: "string" },
					evidenceRefs: {
						type: "array",
						items: { type: "string" }
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, PARAMETERS$4, "method_draft");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "method_draft");
			const kind = args.kind;
			try {
				if (typeof args.identity !== "string" || args.identity.length === 0) throw new Error("identity must be a non-empty string");
				if (typeof args.rationale !== "string" || args.rationale.length === 0) throw new Error("rationale must be non-empty free text");
				if (typeof args.editPayload !== "string" || args.editPayload.length === 0) throw new Error("editPayload must carry the complete new content");
				if (typeof args.expectedBaseRevision !== "string" || args.expectedBaseRevision.length === 0) throw new Error("expectedBaseRevision is required");
				if (!Array.isArray(args.sourceRefs) || args.sourceRefs.length === 0) throw new Error("sourceRefs must name at least one recorded reference");
				if (!Number.isInteger(args.round) || args.round < 0) throw new Error("round must be a non-negative integer");
				const edits = declaredEditsOf(args.edits);
				const critic = criticOf(args.critic);
				const env = environmentPlaneOf(ctx);
				const ledger = await methodLedgerPlaneOf(ctx, caller);
				const strategy = strategyPlaneOf();
				const view = await env.activeEnvironmentView(caller);
				if (view.readOnly) return [`method_draft rejected: library "${view.libraryId}" is read-only (${view.protocol}); a sealed or legacy graph takes no draft.`, "nothing was created."].join(" ");
				if (view.revisionId !== args.expectedBaseRevision) return [
					`method_draft rejected: the active revision is "${view.revisionId}", not the "${args.expectedBaseRevision}" this candidate was written against —`,
					"the pointer moved (this round, or another session); re-read the library and re-author the candidate.",
					"nothing was created."
				].join(" ");
				const budget = strategy.editBudget(args.round, strategy.policy);
				const verified = edits.filter((edit) => edit.mechanismUnverified !== true);
				if (edits.length === 0) return "method_draft rejected: a candidate declares at least one independent edit; nothing was created.";
				if (verified.length > budget) return [
					`method_draft rejected: ${verified.length} independent edits exceed the round ${String(args.round)} budget of ${budget}`,
					"(the frozen policy anneals the budget down to one edit in the last round); nothing was created and no evaluation budget was consumed,",
					"so this refusal does not enter the measured history."
				].join(" ");
				const draft = await env.createDraft(caller, {
					basedOn: view.revisionId,
					purpose: args.rationale
				});
				const refuse$1 = async (detail) => {
					await env.removeEnvironmentDraft(caller, draft.draftId);
					return `${detail} (draft ${draft.draftId} removed; nothing was recorded and no evaluation budget was consumed)`;
				};
				let staged;
				try {
					staged = await env.stageDraftEdit(caller, draft.draftId, editOf(kind, args.identity, args.editPayload, caller, versionOf(view.skills, args.identity)));
				} catch (error) {
					return await refuse$1(`method_draft rejected: the candidate content is not a ${kind} this library can hold — ${message(error)};`);
				}
				const baseRevision = {
					revisionId: view.revisionId,
					digest: view.manifestDigest,
					libraryId: view.libraryId
				};
				const structure = await ledger.prepareStructure({
					draftId: staged.draftId,
					kind,
					identity: args.identity,
					baseRevision,
					candidateRevision: {
						revisionId: staged.manifest.revisionId,
						digest: staged.manifest.contentDigest
					},
					rationale: args.rationale,
					sourceRefs: [...args.sourceRefs],
					actor: caller
				});
				const screen = strategy.screenBeforeMeasurement({
					round: args.round,
					edits,
					structure: {
						ok: structure.ok,
						findings: structure.findings
					},
					...critic === void 0 ? {} : { critic },
					policy: strategy.policy
				});
				if (!screen.ok) {
					const criticNote = screen.reasonCode === "critic-missing" ? " This round carries no independent critic verdict, and the frozen policy requires one before any measurement — the candidate is refused rather than measured silently." : "";
					return await refuse$1(`method_draft rejected: ${screen.reasonCode} — ${screen.reason}.${criticNote}`);
				}
				const facts = await ledger.history();
				const refutation = strategy.refutationFor(facts, view.libraryId, staged.manifest.contentDigest);
				if (refutation !== void 0) return await refuse$1(`method_draft rejected: this candidate's bytes (${staged.manifest.contentDigest.slice(0, 12)}…) were already refused by draft ${refutation.refutation.candidateId} (${refutation.kind}) — ${refutation.refutation.reason}. Use method_discard on this draft, or add new evidence and a new repetition.`);
				await ledger.createDraft({
					draftId: staged.draftId,
					kind,
					identity: args.identity,
					baseRevision,
					candidateRevision: {
						revisionId: staged.manifest.revisionId,
						digest: staged.manifest.contentDigest,
						files: structure.files
					},
					rationale: args.rationale,
					sourceRefs: [...args.sourceRefs],
					actor: caller
				});
				return [
					`method_draft: ${kind} "${args.identity}" recorded as draft ${staged.draftId}`,
					`  base revision ${view.revisionId} (${view.manifestDigest.slice(0, 12)}) → candidate ${staged.manifest.revisionId} (${staged.manifest.contentDigest.slice(0, 12)})`,
					`  name: ${structure.change.identity}; before ${structure.change.before === null ? "(absent)" : structure.change.before.slice(0, 12)} → after ${structure.change.after.slice(0, 12)}`,
					`  bundle level: ${screen.bundleLevel ? "yes (more than one independent edit)" : "no"}; round ${String(args.round)} edit budget ${budget}`,
					`  files: ${structure.files.map((file) => file.path).join(", ") || "(none)"}`,
					"  no production change; next: method_evaluate (frozen cohort, both sides, at least three repetitions)"
				].join("\n");
			} catch (error) {
				return `method_draft rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/method-evaluate.ts
const PARAMETERS$3 = [
	"draftId",
	"round",
	"samples",
	"quality",
	"objective",
	"evaluation",
	"budget",
	"repetition",
	"input",
	"maxParallel"
];
const SAMPLE_ROLES = [
	"observed-failure",
	"observed-success",
	"observed-regression",
	"holdout"
];
/** The model selection this deployment's runs share, read exactly as the assembly's own resolver reads it. */
function deploymentModel(ctx) {
	return modelSelectionOf(optionalService(ctx, "agentDefaultModel")?.currentSelection());
}
/** One fresh one-shot model call, using the deployment's own llm route and no executor conversation. */
function judgeCall(ctx) {
	return async (model, prompt, input, signal) => {
		const llm = optionalService(ctx, "llm");
		if (llm === void 0) throw new Error("the llm-outcome objective needs the deployment llm service");
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
				if (chunk.reason.kind !== "stop") throw new Error(`the outcome model stopped with ${JSON.stringify(chunk.reason)}`);
				finished = true;
			}
		}
		const response = assembled.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
		if (!finished || response.trim().length === 0) throw new Error("the outcome model returned no complete response");
		const usage = assembled.usage;
		return {
			response,
			...usage === void 0 ? {} : { usage: {
				uncachedInputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens ?? 0,
				cacheWriteTokens: usage.cacheWriteTokens ?? 0
			} }
		};
	};
}
/** One frozen outcome evaluation plan: the caller's plan, or one plan the judge model writes from the goal. */
async function outcomePlanOf(ctx, input, samples, model, signal) {
	const judge = {
		model,
		prompt: OUTCOME_JUDGE_PROMPT,
		digest: digestOf({
			model,
			prompt: OUTCOME_JUDGE_PROMPT
		})
	};
	let rubric = input.rubric;
	let measurements = input.measurements;
	let generatedResponse;
	let generatedUsage;
	if (rubric === void 0 || measurements === void 0) {
		const generated = await judgeCall(ctx)(model, "Create an outcome evaluation plan from the supplied goal and samples. Return JSON {\"rubric\":\"…\",\"measurements\":[{\"id\":\"safe_name\",\"command\":\"…\"}]}. Each command runs in one isolated workspace with a 300 second limit and a 1 MiB output limit per stream. Preserve any supplied rubric and measurements, and keep the original acceptance fixed.", canonicalJson({
			goal: input.goal,
			rubric,
			measurements,
			samples
		}), signal);
		if (typeof generated === "string") throw new Error("the outcome plan model returned no usage record");
		generatedResponse = generated.response;
		generatedUsage = generated.usage;
		const parsed = JSON.parse(generated.response);
		rubric ??= parsed.rubric;
		measurements ??= parsed.measurements;
	}
	const plan = {
		goal: input.goal,
		rubric: rubric ?? "",
		measurements: measurements === void 0 ? [] : [...measurements],
		judge,
		...generatedResponse === void 0 ? {} : { generatedResponse },
		...generatedUsage === void 0 ? {} : { generatedUsage }
	};
	assertOutcomePlan(plan);
	return plan;
}
function defineMethodEvaluateTool(ctx) {
	return defineTool({
		name: "method_evaluate",
		description: "Measure one draft through the one evaluation pipeline. Name the frozen cohort explicitly — both sides of every sample, its role and the original acceptance — the [0,1] quality scale, the objective and the budget; the tool derives no sample and no role. At least three independent repetitions calibrate noise: a single trial never claims a zero noise band. A missing cost inside the cohort is inconclusive rather than zero, and a missing trial does not shrink the denominator. The same frozen cohort returns the same evaluation without charging again. Next: method_publish (one approval) or method_discard.",
		parameters: {
			draftId: {
				type: "string",
				required: true,
				description: "The draft to measure"
			},
			round: {
				type: "integer",
				required: true,
				description: "The search round this evaluation belongs to"
			},
			samples: {
				type: "array",
				required: true,
				description: "The frozen cohort: [{taskId, role}] with role observed-failure | observed-success | observed-regression | holdout",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						taskId: {
							type: "string",
							description: "An existing task in this graph store"
						},
						role: {
							type: "string",
							enum: [...SAMPLE_ROLES],
							description: "How this sample entered the cohort"
						}
					}
				}
			},
			quality: {
				type: "object",
				required: true,
				additionalProperties: false,
				description: "The frozen [0,1] quality scale: the original acceptance, or a declared numeric metric",
				properties: {
					metricId: {
						type: "string",
						description: "acceptance for the original acceptance rate, or a criterion id carrying a numeric reading"
					},
					extractor: {
						type: "string",
						description: "How the number is read out of the side"
					}
				}
			},
			objective: {
				type: "string",
				enum: ["tool-call-reduction", "llm-outcome"],
				description: "Omit for failure repair against the original acceptance"
			},
			evaluation: {
				type: "object",
				additionalProperties: true,
				description: "Required for llm-outcome: {goal, rubric?, measurements?}; rubric and measurements may be generated once and are then frozen",
				properties: {
					goal: { type: "string" },
					rubric: { type: "string" },
					measurements: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								id: { type: "string" },
								command: { type: "string" }
							}
						}
					}
				}
			},
			budget: {
				type: "object",
				additionalProperties: true,
				description: "The token ceiling frozen with this evaluation: {maxTokens?, note?}"
			},
			repetition: {
				type: "integer",
				required: true,
				description: "This cohort's repetition; 0 is the first. At least 3 calibrate noise"
			},
			input: {
				type: "object",
				required: true,
				additionalProperties: false,
				description: "The frozen input both sides are built from",
				properties: {
					sourceDir: {
						type: "string",
						description: "A clean input directory both sides copy"
					},
					paths: {
						type: "array",
						items: { type: "string" },
						description: "Only the files or directories needed for the comparison"
					},
					rebaseFrom: {
						type: "string",
						description: "A workspace path the declared contracts use, relocated into each side"
					}
				}
			},
			maxParallel: {
				type: "integer",
				description: "Scheduling limit for the sides this evaluation starts"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, PARAMETERS$3, "method_evaluate");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "method_evaluate");
			try {
				if (typeof args.draftId !== "string" || args.draftId.length === 0) throw new Error("draftId is required");
				if (!Number.isInteger(args.round) || args.round < 0) throw new Error("round must be a non-negative integer");
				if (!Number.isInteger(args.repetition) || args.repetition < 0) throw new Error("repetition must be a non-negative integer");
				if (!Array.isArray(args.samples) || args.samples.length === 0) throw new Error("samples must name at least one sample; the cohort is never inferred");
				const samples = args.samples.map((sample, index) => {
					if (typeof sample.taskId !== "string" || sample.taskId.length === 0) throw new Error(`samples[${index}].taskId is required`);
					if (!SAMPLE_ROLES.includes(sample.role)) throw new Error(`samples[${index}].role must be one of ${SAMPLE_ROLES.join(" | ")}`);
					return {
						taskId: sample.taskId,
						role: sample.role
					};
				});
				const quality = args.quality;
				if (quality === void 0 || typeof quality.metricId !== "string" || quality.metricId.length === 0) throw new Error("quality.metricId is required: the frozen scale must be named before anything is measured");
				if (typeof quality.extractor !== "string" || quality.extractor.length === 0) throw new Error("quality.extractor is required");
				const input = args.input;
				if (input === void 0 || typeof input.sourceDir !== "string" || input.sourceDir.length === 0) throw new Error("input.sourceDir is required: both sides are built from one clean input directory");
				const model = deploymentModel(ctx);
				if (model === void 0) throw new Error("this deployment offers no default model, so the model both sides run under cannot be frozen; nothing was evaluated");
				const rules = {
					...args.objective === void 0 ? {} : { objective: args.objective },
					quality: {
						metricId: quality.metricId,
						direction: "higher-is-better",
						extractor: quality.extractor
					},
					guards: []
				};
				if (rules.objective !== "llm-outcome" && args.evaluation !== void 0) throw new Error("evaluation is only valid for the llm-outcome objective");
				let evaluation;
				let judge;
				if (rules.objective === "llm-outcome") {
					const declared = args.evaluation;
					if (declared === void 0 || typeof declared.goal !== "string" || declared.goal.length === 0) throw new Error("objective llm-outcome requires evaluation.goal; the judged objective is never assumed");
					judge = judgeCall(ctx);
					evaluation = await outcomePlanOf(ctx, {
						goal: declared.goal,
						...typeof declared.rubric === "string" ? { rubric: declared.rubric } : {},
						...Array.isArray(declared.measurements) ? { measurements: declared.measurements } : {}
					}, samples, model, exec.signal);
				}
				const ledger = await methodLedgerPlaneOf(ctx, caller);
				const existing = await ledger.evaluationOf(args.draftId);
				const report = await ledger.evaluate({
					draftId: args.draftId,
					samples,
					input: {
						sourceDir: input.sourceDir,
						...Array.isArray(input.paths) ? { paths: input.paths } : {},
						...typeof input.rebaseFrom === "string" ? { rebaseFrom: input.rebaseFrom } : {}
					},
					rules,
					budget: args.budget ?? {},
					repetition: args.repetition,
					model,
					...evaluation === void 0 ? {} : { evaluation },
					...judge === void 0 ? {} : { judge },
					...args.maxParallel === void 0 ? {} : { maxParallel: args.maxParallel }
				}, exec.signal);
				const decision = await ledger.decisionFor(args.draftId) ?? await ledger.recordDecision(report);
				const admission = decision.admissions.find((entry) => entry.candidateId === args.draftId);
				strategyPlaneOf();
				const lines$1 = [
					renderEvaluation(report),
					...admission === void 0 ? ["admission: the frozen strategy recorded no admission for this draft"] : renderAdmission(admission, decision.calibration),
					`scope: ${decision.scope}`
				];
				if (existing !== void 0) lines$1.push("this draft was already measured under this frozen cohort; the same report was read back and nothing was charged again");
				lines$1.push(admission?.admissible === true ? "next: method_publish (one approval; a refused or tampered candidate is refused before anyone is asked) or method_discard" : "next: method_discard — the frozen strategy did not admit this candidate, so no approval will be requested");
				return lines$1.join("\n");
			} catch (error) {
				return `method_evaluate rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/method-list.ts
const PARAMETERS$2 = [
	"kind",
	"status",
	"identity",
	"detail"
];
/** The task store this graph's Runs live in, or nothing when the deployment offers no task service. */
async function snapshotFor(ctx, caller) {
	const task = optionalService(ctx, "task");
	if (task === void 0) return void 0;
	const graph = await methodGraphFor(ctx, caller);
	return await task.openStore(rootTaskStoreId(graph.rootSessionId)).catch(() => void 0);
}
/** Every Run that explicitly binds a candidate, by the candidate it binds. */
function trialBindings(runs) {
	const bindings = /* @__PURE__ */ new Map();
	for (const run of runs) {
		if (run.trialCandidateRef === void 0) continue;
		bindings.set(run.trialCandidateRef, [...bindings.get(run.trialCandidateRef) ?? [], run.runId]);
	}
	return bindings;
}
function defineMethodListTool(ctx) {
	return defineTool({
		name: "method_list",
		description: "Read this library's method state: the effective revision and pointer, every draft with its status and last verdict, which Runs are explicitly trying which candidate, the compact history (measured rounds, and a bounded table of refusals that were never measured), what the strategy suggests next, and any pointer switch that is open. Use it before drafting a candidate and when deciding whether to publish, discard or stop searching. This tool only reads.",
		parameters: {
			kind: {
				type: "string",
				enum: [
					"skill",
					"task-template",
					"capability"
				],
				description: "Only drafts of this asset class"
			},
			status: {
				type: "string",
				enum: [
					"draft",
					"evaluated",
					"discarded",
					"published"
				],
				description: "Only drafts in this state"
			},
			identity: {
				type: "string",
				description: "Only drafts for this asset identity"
			},
			detail: {
				type: "string",
				enum: ["compact", "full"],
				description: "compact (default) renders the recent history; full renders every draft line"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, PARAMETERS$2, "method_list");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "method_list");
			try {
				const env = environmentPlaneOf(ctx);
				const ledger = await methodLedgerPlaneOf(ctx, caller);
				const strategy = strategyPlaneOf();
				const view = await env.activeEnvironmentView(caller);
				const mode = await methodModeFor(ctx, caller);
				const filter = {
					...args.kind === void 0 ? {} : { kind: args.kind },
					...args.status === void 0 ? {} : { status: args.status }
				};
				const drafts = (await ledger.list(filter)).filter((draft) => args.identity === void 0 || draft.draft.identity === args.identity);
				const intent = await env.openPointerIntent(caller);
				const bindings = trialBindings((await snapshotFor(ctx, caller))?.runs ?? []);
				const facts = await ledger.history();
				const history = strategy.foldHistory(facts, strategy.policy, facts.candidates.length);
				const detail = args.detail === "full" ? "full" : "compact";
				const rendered = strategy.renderHistory(history, detail === "full" ? drafts.length + 1 : 8);
				const measuredEntries = history.entries.filter((entry) => entry.measured);
				const stall = history.roundsWithoutQualityGain >= strategy.policy.stallRounds ? 1 : 0;
				const exploration$1 = strategy.exploration(facts.candidates.length, stall, history.triedMechanisms, strategy.policy.stall.reservedDrafts);
				return [
					`method state — library ${view.libraryId} (${view.protocol})`,
					`  active revision ${view.revisionId} g${view.generation} (${view.manifestDigest.slice(0, 12)})${view.trialCandidateRef === void 0 ? "" : `, trial candidate ${view.trialCandidateRef}`}${view.readOnly ? " [read-only]" : ""}`,
					`  mode ${mode}; policy ${strategy.policy.version} (rounds ${strategy.policy.rounds}, trials ${strategy.policy.trials}, edit budget ${strategy.policy.editBudget.max}→${strategy.policy.editBudget.min})`,
					`drafts (${drafts.length})${detail === "full" ? "" : ", most recent first"}:`,
					...drafts.length === 0 ? ["  (none)"] : (detail === "full" ? drafts : drafts.slice(-8)).map((draft) => {
						const trial = bindings.get(draft.draft.draftId);
						return `${renderDraftLine(draft)}${trial === void 0 ? "" : ` (tried by ${trial.length} run(s): ${trial.join(", ")})`}`;
					}),
					measuredEntries.length === 0 ? `history: nothing measured yet${history.entries.length === 0 ? "" : ` (${history.entries.length} candidate(s) never measured, so the denominator stays empty)`}` : `history (scope ${history.scope || "(none)"}):`,
					...measuredEntries.length === 0 ? [] : rendered.map((entry) => `  round ${entry.round} ${entry.candidateId} ${entry.measured ? entry.deltaQuality === void 0 ? "measured" : `Δquality ${entry.deltaQuality.toFixed(4)}` : "not measured"} → ${entry.outcome}${entry.reasonCode === void 0 ? "" : ` (${entry.reasonCode})`}`),
					`  best quality ${history.bestQuality === void 0 ? "(none measured)" : history.bestQuality.toFixed(4)}; rounds without a quality gain ${history.roundsWithoutQualityGain}; steering ${history.steering}`,
					`  untouched candidate slots: ${exploration$1.reservedDrafts} of this round's candidates are reserved for untried mechanisms [${exploration$1.untried.join(", ")}]`,
					...bindings.size === 0 ? ["trial: no Run is explicitly trying a candidate"] : [`trial: ${[...bindings.entries()].map(([draftId, runs]) => `${draftId} tried by ${runs.join(", ")}`).join("; ")} (a trial never moves the active revision)`],
					...history.simplificationCandidates.length === 0 ? [] : [`simplification suggestions (a deletion candidate is still measured on both sides before it publishes): ${history.simplificationCandidates.map((candidate) => `${candidate.mechanism} via ${candidate.candidateIds.join(", ")}`).join("; ")}`],
					...intent === null ? [] : [`open pointer intent: ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}, recorded ${intent.at}) — a switch is in flight; a retry of the publication that opened it continues it without a second approval`],
					"next: method_draft (one candidate, its evidence and the budget) → method_evaluate (frozen cohort, ≥3 repetitions) → method_publish or method_discard"
				].join("\n");
			} catch (error) {
				return `method_list rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/method-publish.ts
const PARAMETERS$1 = [
	"draftId",
	"expectedActiveRevision",
	"expectedGeneration",
	"reason"
];
/** The admission one draft's landed decision holds, or a refusal naming what is missing. */
function admissionOf(decision, draftId) {
	if (decision === void 0) return `no landed strategy decision covers draft "${draftId}"; a candidate is measured (method_evaluate) before it is published`;
	const admission = decision.admissions.find((entry) => entry.candidateId === draftId);
	if (admission === void 0) return `the landed strategy decision names no admission for draft "${draftId}"`;
	if (!admission.admissible) return `the frozen strategy did not admit this candidate (${admission.reasonCode}) — ${admission.reason}; a refused candidate consumes no approval, so none was requested`;
	return admission;
}
function defineMethodPublishTool(ctx) {
	return defineTool({
		name: "method_publish",
		description: "Publish one evaluated candidate as this library's effective revision. The expected active revision and generation are required: they are the compare-and-swap pair the approval shows, and a pointer anyone else moved refuses this call. A candidate the frozen strategy did not admit is refused here without asking anyone. Otherwise exactly one approval is requested, showing the complete asset difference, the evaluation and the exact version switch; after it is granted the graph, the pointer and the pre-publish check are re-read, and only then does the pointer transaction run. An open pointer intent for this same candidate is continued without a second approval.",
		parameters: {
			draftId: {
				type: "string",
				required: true,
				description: "The evaluated draft to publish"
			},
			expectedActiveRevision: {
				type: "string",
				required: true,
				description: "The active revision id the approval displays"
			},
			expectedGeneration: {
				type: "integer",
				required: true,
				description: "The pointer generation the approval displays"
			},
			reason: {
				type: "string",
				description: "Anything the approver should know beyond the rendered evidence"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, PARAMETERS$1, "method_publish");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "method_publish");
			const agent = exec.agent;
			if (agent === void 0) throw new Error("method_publish: missing agent");
			try {
				if (typeof args.draftId !== "string" || args.draftId.length === 0) throw new Error("draftId is required");
				if (typeof args.expectedActiveRevision !== "string" || args.expectedActiveRevision.length === 0) throw new Error("expectedActiveRevision is required: the approval displays the pointer this publication replaces");
				if (!Number.isInteger(args.expectedGeneration) || args.expectedGeneration < 0) throw new Error("expectedGeneration is required: the second half of the pointer compare-and-swap pair");
				const env = environmentPlaneOf(ctx);
				const ledger = await methodLedgerPlaneOf(ctx, caller);
				const view = await env.activeEnvironmentView(caller);
				if (view.readOnly) return `method_publish rejected: library "${view.libraryId}" is read-only (${view.protocol}); nothing was written`;
				if (view.revisionId !== args.expectedActiveRevision || view.generation !== args.expectedGeneration) return [
					`method_publish rejected: the active pointer is ${view.revisionId} g${view.generation}, not the approved`,
					`${args.expectedActiveRevision} g${String(args.expectedGeneration)} — a third party moved it (or the approval displayed a stale pointer).`,
					"nothing was written; re-read the library and approve the switch that is actually in front of you."
				].join(" ");
				const intent = await env.openPointerIntent(caller);
				if (intent !== null) {
					if (!(intent.direction === "publish" && intent.draftId === args.draftId && intent.expected?.revisionId === args.expectedActiveRevision)) return [`method_publish rejected: pointer intent ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}) is open,`, "so this library is mid-switch for another candidate; nothing was written. Settle it (restart, or a retry of the tool that opened it) first."].join(" ");
					const settled = (await env.reconcilePointer(caller)).find((entry) => entry.intentId === intent.intentId);
					if (settled === void 0) return `method_publish: no pointer moved — the open intent ${intent.intentId} reported no outcome; nothing was written`;
					if (settled.result !== "blocked") await ledger.markPublished({
						draftId: args.draftId,
						revisionId: intent.next.revisionId,
						supersededRevisionId: intent.expected?.revisionId ?? null,
						intentId: intent.intentId,
						...intent.approvalRef === void 0 ? {} : { approvalRef: intent.approvalRef },
						actor: caller
					});
					const recoveredMode = await methodModeFor(ctx, caller);
					return [...renderRecoveredIntent(intent, settled), `mode ${recoveredMode}; decided by ${deciderFor(recoveredMode)}`].join("\n");
				}
				const report = await ledger.evaluationOf(args.draftId);
				if (report === void 0) return `method_publish rejected: draft "${args.draftId}" carries no evaluation; only a measured candidate is published. Nothing was written.`;
				const decision = await ledger.decisionFor(args.draftId);
				const admission = admissionOf(decision, args.draftId);
				if (typeof admission === "string") return `method_publish rejected: ${admission}. Nothing was written and no approval was requested.`;
				if (decision === void 0) throw new Error("unreachable: a missing decision was refused above");
				try {
					await ledger.validatePrePublish(report);
				} catch (error) {
					return [`method_publish rejected: the pre-publish re-check of report ${report.evaluationId} refused this candidate — ${message(error)};`, "nothing was written and no approval was requested."].join(" ");
				}
				const draft = await ledger.view(args.draftId);
				const mode = await methodModeFor(ctx, caller);
				const decider = deciderFor(mode);
				const library = {
					id: ledger.libraryId,
					root: ledger.root
				};
				const baselineRevision = await env.activeRevisionFor(caller).catch(() => void 0);
				const candidateRevision = await candidateRevisionOf(library, args.draftId);
				if (candidateRevision === void 0) return `method_publish rejected: draft "${args.draftId}" has no draft directory; nothing was written.`;
				const diff = renderDiff(await diffOfRevisions(baselineRevision ?? null, candidateRevision).catch(() => ({
					from: baselineRevision?.manifest.revisionId ?? null,
					to: candidateRevision.manifest.revisionId,
					files: [],
					digest: "unavailable"
				})));
				const pointer = {
					revisionId: view.revisionId,
					generation: view.generation,
					manifestDigest: view.manifestDigest
				};
				const approvalRef = `approval:${exec.callId}`;
				{
					const reason = renderPublishReason({
						draft: draft.draft,
						report,
						admission,
						calibration: decision.calibration,
						diff,
						pointer,
						candidate: {
							revisionId: candidateRevision.manifest.revisionId,
							manifestDigest: candidateRevision.manifest.contentDigest
						},
						mode,
						rollbackToRevisionId: view.revisionId,
						decider,
						...typeof args.reason === "string" && args.reason.length > 0 ? { extra: [`note: ${args.reason}`] } : {}
					});
					const outcome = await ctx.approval.request({
						agent,
						toolName: "method_publish",
						callId: exec.callId,
						reason,
						signal: exec.signal
					});
					if (outcome !== "allowed-once") return `method_publish: no pointer moved — ${denialReason(outcome)}; draft ${args.draftId} stays evaluated and nothing was written`;
				}
				const [recheck, recheckMode] = await Promise.all([env.activeEnvironmentView(caller), methodModeFor(ctx, caller)]);
				if (recheck.revisionId !== args.expectedActiveRevision || recheck.generation !== args.expectedGeneration) return [`method_publish: no pointer moved — the pointer is now ${recheck.revisionId} g${recheck.generation}, not the approved`, `${args.expectedActiveRevision} g${String(args.expectedGeneration)}; the approval is spent and no second one is requested.`].join(" ");
				if (recheckMode !== mode) return `method_publish: no pointer moved — this graph's method mode changed from ${mode} to ${recheckMode} while the approval was open.`;
				try {
					await ledger.validatePrePublish(report);
				} catch (error) {
					return `method_publish: no pointer moved — the post-approval re-check refused this candidate — ${message(error)}`;
				}
				const published = await env.publishRevision(caller, {
					direction: "publish",
					source: {
						kind: "draft",
						draftId: args.draftId
					},
					expected: {
						revisionId: args.expectedActiveRevision,
						generation: args.expectedGeneration
					},
					approvalRef,
					actor: caller
				});
				await ledger.markPublished({
					draftId: args.draftId,
					revisionId: published.pointer.revisionId,
					supersededRevisionId: published.supersededRevisionId,
					intentId: published.completion.intentId,
					approvalRef,
					actor: caller
				});
				return [...renderPublishOutcome(published, mode, decider)].join("\n");
			} catch (error) {
				return `method_publish rejected: ${message(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/method-rollback.ts
const PARAMETERS = [
	"toRevisionId",
	"expectedActiveRevision",
	"expectedGeneration",
	"reason"
];
function defineMethodRollbackTool(ctx) {
	return defineTool({
		name: "method_rollback",
		description: "Restore one revision this library published before. The expected active revision and generation are the compare-and-swap pair the approval shows; a pointer anyone else moved refuses the call. One approval is requested, showing the reverse asset difference and the exact switch; after it is granted the graph, the pointer and the target revision are re-read before the pointer transaction runs. A revision this library never held as effective is refused by name.",
		parameters: {
			toRevisionId: {
				type: "string",
				required: true,
				description: "The revision to restore; it must have been effective in this library before"
			},
			expectedActiveRevision: {
				type: "string",
				required: true,
				description: "The active revision id the approval displays"
			},
			expectedGeneration: {
				type: "integer",
				required: true,
				description: "The pointer generation the approval displays"
			},
			reason: {
				type: "string",
				required: true,
				description: "Why this method is rolled back"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text(v)
		},
		execute: async (args, exec) => {
			const undeclared = undeclaredParameters(args, PARAMETERS, "method_rollback");
			if (undeclared !== void 0) return undeclared;
			const caller = sessionId(exec, "method_rollback");
			const agent = exec.agent;
			if (agent === void 0) throw new Error("method_rollback: missing agent");
			try {
				if (typeof args.toRevisionId !== "string" || args.toRevisionId.length === 0) throw new Error("toRevisionId is required");
				if (typeof args.expectedActiveRevision !== "string" || args.expectedActiveRevision.length === 0) throw new Error("expectedActiveRevision is required");
				if (!Number.isInteger(args.expectedGeneration) || args.expectedGeneration < 0) throw new Error("expectedGeneration is required");
				if (typeof args.reason !== "string" || args.reason.trim().length === 0) throw new Error("reason must be non-empty free text");
				const env = environmentPlaneOf(ctx);
				const ledger = await methodLedgerPlaneOf(ctx, caller);
				const view = await env.activeEnvironmentView(caller);
				if (view.readOnly) return `method_rollback rejected: library "${view.libraryId}" is read-only (${view.protocol}); nothing was written`;
				if (view.revisionId !== args.expectedActiveRevision || view.generation !== args.expectedGeneration) return [`method_rollback rejected: the active pointer is ${view.revisionId} g${view.generation}, not the approved`, `${args.expectedActiveRevision} g${String(args.expectedGeneration)}; nothing was written.`].join(" ");
				if (args.toRevisionId === view.revisionId) return `method_rollback rejected: "${args.toRevisionId}" is the revision already in effect; nothing was written`;
				const drafts = await ledger.list();
				const effective = /* @__PURE__ */ new Set();
				for (const draft of drafts) {
					effective.add(draft.draft.baseRevision.revisionId);
					if (draft.published !== void 0) effective.add(draft.published.revisionId);
				}
				if (!effective.has(args.toRevisionId)) return `method_rollback rejected: revision "${args.toRevisionId}" was never effective in library "${ledger.libraryId}" — a rollback restores a revision this library published, it does not adopt an arbitrary one; nothing was written`;
				const library = {
					id: ledger.libraryId,
					root: ledger.root
				};
				const target = await readRevision(library, args.toRevisionId);
				if (target === void 0) return `method_rollback rejected: library "${ledger.libraryId}" holds no revision "${args.toRevisionId}"; nothing was written`;
				const mode = await methodModeFor(ctx, caller);
				const decider = deciderFor(mode);
				const current$1 = await env.activeRevisionFor(caller).catch(() => void 0);
				const diff = renderDiff(await diffOfRevisions(current$1 ?? null, target).catch(() => ({
					from: current$1?.manifest.revisionId ?? null,
					to: target.manifest.revisionId,
					files: [],
					digest: "unavailable"
				})));
				const reason = [
					`Method rollback of library ${ledger.libraryId}`,
					renderVersionSwitch({
						pointer: {
							revisionId: view.revisionId,
							generation: view.generation,
							manifestDigest: view.manifestDigest
						},
						candidate: {
							revisionId: target.manifest.revisionId,
							manifestDigest: target.manifest.contentDigest
						},
						mode
					}),
					...diff,
					`mode: ${mode === "auto" ? `auto (the platform policy decides and records; the decider is ${decider})` : `manual (a human decides; the decider is ${decider})`}`,
					`reason: ${args.reason}`,
					"nothing has been written yet; the pointer moves only if this approval is granted and the post-approval re-check still passes"
				].join("\n");
				const rolledBackDraft = drafts.find((draft) => draft.published?.revisionId === view.revisionId);
				const intent = await env.openPointerIntent(caller);
				if (intent !== null) {
					if (!(intent.direction === "rollback" && intent.next.revisionId === args.toRevisionId && intent.expected?.revisionId === args.expectedActiveRevision)) return `method_rollback rejected: pointer intent ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}) is open; nothing was written`;
					const settled = (await env.reconcilePointer(caller)).find((entry) => entry.intentId === intent.intentId);
					if (settled === void 0) return `method_rollback: no pointer moved — the open intent ${intent.intentId} reported no outcome; nothing was written`;
					if (settled.result !== "blocked") await ledger.markRolledback({
						draftId: rolledBackDraft?.draft.draftId ?? null,
						revisionId: intent.next.revisionId,
						supersededRevisionId: intent.expected?.revisionId ?? null,
						intentId: intent.intentId,
						...intent.approvalRef === void 0 ? {} : { approvalRef: intent.approvalRef },
						actor: caller
					});
					return [...renderRecoveredIntent(intent, settled), `mode ${mode}; decided by ${decider}`].join("\n");
				}
				const approvalRef = `approval:${exec.callId}`;
				const outcome = await ctx.approval.request({
					agent,
					toolName: "method_rollback",
					callId: exec.callId,
					reason,
					signal: exec.signal
				});
				if (outcome !== "allowed-once") return `method_rollback: no pointer moved — ${denialReason(outcome)}; nothing was written`;
				const [recheck, recheckMode] = await Promise.all([env.activeEnvironmentView(caller), methodModeFor(ctx, caller)]);
				if (recheck.revisionId !== args.expectedActiveRevision || recheck.generation !== args.expectedGeneration) return [`method_rollback: no pointer moved — the pointer is now ${recheck.revisionId} g${recheck.generation}, not the approved`, `${args.expectedActiveRevision} g${String(args.expectedGeneration)}; the approval is spent and no second one is requested.`].join(" ");
				if (recheckMode !== mode) return `method_rollback: no pointer moved — this graph's method mode changed from ${mode} to ${recheckMode} while the approval was open.`;
				const targetAgain = await readRevision(library, args.toRevisionId);
				if (targetAgain === void 0 || targetAgain.manifest.contentDigest !== target.manifest.contentDigest) return `method_rollback: no pointer moved — revision "${args.toRevisionId}" changed or vanished while the approval was open.`;
				const rolledback = await env.rollbackRevision(caller, {
					direction: "rollback",
					source: {
						kind: "revision",
						revisionId: args.toRevisionId
					},
					expected: {
						revisionId: args.expectedActiveRevision,
						generation: args.expectedGeneration
					},
					approvalRef,
					actor: caller
				});
				await ledger.markRolledback({
					draftId: rolledBackDraft?.draft.draftId ?? null,
					revisionId: rolledback.pointer.revisionId,
					supersededRevisionId: rolledback.supersededRevisionId,
					intentId: rolledback.completion.intentId,
					approvalRef,
					actor: caller
				});
				return [...renderPublishOutcome(rolledback, mode, decider), `next Runs admit against "${rolledback.pointer.revisionId}"; the candidate this rollback left stays on the ledger as its own record`].join("\n");
			} catch (error) {
				return `method_rollback rejected: ${message(error)}`;
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
	const lines$1 = [`task_answer: answer ${answer.answerId} recorded for question ${answer.questionId}; ${deliveryText$1(outcome.delivery)}.`];
	if (!outcome.created) lines$1.push("This is the answer the same request key already recorded: nothing was written a second time and the same identity stands.");
	lines$1.push(answer.resolves ? "`resolves: true` releases exactly that question: the asking run's block is recomputed from the store, so another question of its own keeps it blocked. It changes no contract, no permission and no task state, and the framework does not vouch for what the answer says." : "`resolves: false` keeps the question open: the asking run stays blocked on it and your words are recorded as an answer that settled nothing. Answer it again with `resolves: true` once it is settled.");
	lines$1.push("Your words reach the asking run as a message in its session and in its context, under the identity recorded here.");
	return lines$1.join("\n");
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
	const lines$1 = [`task_ask_parent: question ${question.questionId} recorded for your direct parent (run ${question.parentRunId}); ${deliveryText(outcome.delivery)}.`];
	if (!outcome.created) lines$1.push("This is the question the same request key already recorded, word for word: nothing was written a second time and the same identity stands. Do not re-send it under a new key.");
	if (question.blocking) {
		lines$1.push("This run is now blocked on that answer: writes, shell commands, another decomposition and `task_submit_result` are refused until an answer with `resolves: true` is recorded — a child batch of this run ending does not lift the block, because nothing answers a question on your behalf. Stop the work that would write and end this step — an idle run waiting on this question gets no submission reminder.");
		lines$1.push("The answer arrives as a message in this session and in your context, where the question stays while it is open; read it before you continue, and keep to what it says.");
	} else lines$1.push("This run is not blocked: it may carry on working while the answer is pending, so it may pass you later in this session or in your context — do not treat the silence as an answer.");
	return lines$1.join("\n");
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
/** The coordination work items of one source: every reviewer assignment, in claim order, with how it ended. */
function renderAttempts(work, source) {
	const mine = workOfSource(work, source);
	if (mine.length === 0) return ["review work items (0): none — no review session has been assigned for this source"];
	return [`review work items (${mine.length}):`, ...mine.map((item) => `- ${renderCoordinationWork(item)}`)];
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
	const lines$1 = [];
	const outcome = dimensions.outcomeCorrectness;
	if (outcome !== void 0) lines$1.push(`  dim outcome correctness: ${outcome.outcome}, criteria ${outcome.criteriaCount}, unmet [${outcome.unmetCriterionIds.join(", ")}]`);
	const specification = dimensions.taskSpecification;
	if (specification !== void 0) lines$1.push(`  dim task specification: objective ${specification.objectivePresent ? "present" : "empty"}, criteria ${specification.criteriaCount}, with command ${specification.criteriaWithCommand}`);
	const acceptance = dimensions.acceptance;
	if (acceptance !== void 0) {
		const criteria = acceptance.criteria.map((item) => `${item.criterionId} ${item.mode}${item.hasCommand ? " +command" : ""}${item.mandatory ? "" : " optional"}`);
		lines$1.push(`  dim acceptance: ${criteria.join("; ")}`);
	}
	const decomposition = dimensions.decomposition;
	if (decomposition !== void 0) lines$1.push(`  dim decomposition: depth ${decomposition.depth}, ${decomposition.decompositionStatus}, children ${decomposition.childCount}, edges in/out ${decomposition.incomingEdges}/${decomposition.outgoingEdges}`);
	const coverage = dimensions.capabilityCoverage;
	if (coverage !== void 0) lines$1.push(`  dim capability coverage: ${coverage.closure}, granted [${coverage.granted.join(", ")}], missing [${coverage.missing.join(", ")}]`);
	const skill = dimensions.skillFit;
	if (skill !== void 0) {
		const loaded = (skill.loaded === void 0 ? "" : `, loaded [${skill.loaded.join(", ")}]`) + (skill.loadedOutsideGrant === void 0 ? "" : `, outside grant [${skill.loadedOutsideGrant.join(", ")}]`);
		lines$1.push(`  dim skill fit: granted [${skill.granted.join(", ")}]${loaded}`);
	}
	const tools = dimensions.toolFit;
	if (tools !== void 0) {
		const called = (tools.called === void 0 ? "" : `, called [${tools.called.map((item) => `${item.name} x${item.count}`).join(", ")}]`) + (tools.calledOutsideGrant === void 0 ? "" : `, outside grant [${tools.calledOutsideGrant.join(", ")}]`);
		lines$1.push(`  dim tool fit: granted [${tools.granted.join(", ")}]${called}`);
	}
	const context = dimensions.contextEfficiency;
	if (context !== void 0) {
		const tokens = context.tokens === void 0 ? "" : ` tokens in/out ${context.tokens.uncachedInputTokens}/${context.tokens.outputTokens}`;
		const compactions = context.compactions === void 0 ? "" : ` compactions ${context.compactions}`;
		const cache = context.tokens === void 0 ? "" : ` cache read/write ${context.tokens.cacheReadTokens}/${context.tokens.cacheWriteTokens}`;
		lines$1.push(`  dim context efficiency:${tokens}${compactions}${cache}`);
	}
	return lines$1;
}
/** One review line, with the session id a reader drills into. Printing it here is what lets a diagnosis point `session_trace` at the session the review came from without a second lookup (§2.7.5). */
function renderReview(review) {
	const duration = review.durationMs === void 0 ? "" : ` duration ${review.durationMs}ms`;
	const session = review.sessionId === void 0 ? "" : ` session ${review.sessionId}`;
	const lines$1 = [`- review ${reviewRef(review)} [${review.outcome}]${duration} evidence: [${review.evidenceRefs.join(", ")}]${session}`];
	if (review.relatedTaskIds !== void 0) lines$1.push(`  relatedTaskIds: [${review.relatedTaskIds.join(", ")}]`);
	if (review.localizedCause !== void 0) lines$1.push(`  cause: ${review.localizedCause}`);
	for (const anomaly of review.anomalies) lines$1.push(`  anomaly: ${anomaly}`);
	for (const criterion of review.criteria ?? []) {
		const judge = criterion.verifierId === void 0 ? "" : criterion.verifierVersion === void 0 ? ` [${criterion.verifierId}]` : ` [${criterion.verifierId}@${criterion.verifierVersion}]`;
		const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
		const exit = criterion.exitCode === void 0 ? "" : ` exit ${criterion.exitCode}`;
		const log = criterion.logRef === void 0 ? "" : ` log ${criterion.logRef}`;
		const unknown = criterion.unknownKind === void 0 ? "" : ` unknownKind ${criterion.unknownKind}`;
		lines$1.push(`  criterion ${criterion.criterionId}: ${criterion.verdict}${judge}${exit}${command}${log}${unknown}`);
	}
	for (const blocker of review.blockedBy ?? []) lines$1.push(`  blockedBy ${blocker.taskId} [${blocker.outcome}]`);
	if (review.metrics !== void 0) {
		const metrics = renderMetrics(review.metrics);
		if (metrics.length > 0) lines$1.push(`  metrics: ${metrics}`);
	}
	if (review.dimensions !== void 0) lines$1.push(...renderDimensions(review.dimensions));
	if (review.logTail !== void 0) lines$1.push("  logTail:", ...review.logTail.split("\n").map((line) => `    ${line}`));
	return lines$1;
}
/** How far one diagnosis's supervision has gone: the work items the coordination store holds for its round. */
function supervisionMark(diagnosis, work) {
	const mine = work.filter((item) => diagnosisIdOf(item.assignment) === diagnosis.diagnosisId);
	if (mine.length === 0) return "no supervisor work item — a graph without RSI settings runs no platform supervisor for its diagnoses";
	return mine.map((item) => renderCoordinationWork(item)).join("; ");
}
function renderDiagnosis(diagnosis, work) {
	const producer = diagnosis.producedBy === void 0 ? "" : diagnosis.producedBy.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? ` [agent ${diagnosis.producedBy.sessionId}]` : ` [${diagnosis.producedBy.kind}]`;
	const lines$1 = [`- ${diagnosis.diagnosisId} [${diagnosis.confidence}] ${diagnosis.localizedCause}${producer}`];
	lines$1.push(`  observation: ${diagnosis.observedFailure}`, `  scope: ${diagnosis.scope}; task ${diagnosis.taskId}`, `  reviewRefs: [${diagnosis.reviewRefs.join(", ")}]; evidenceRefs: [${diagnosis.evidenceRefs.join(", ")}]; relatedTaskIds: [${(diagnosis.relatedTaskIds ?? []).join(", ")}]`);
	if (diagnosis.judgements !== void 0 && diagnosis.judgements.length > 0) {
		const header = diagnosis.producedBy?.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? `judgements (agent ${diagnosis.producedBy.sessionId})` : "judgements";
		lines$1.push(`  ${header}:`);
		for (const judgement of diagnosis.judgements) lines$1.push(`    ${judgement.dimension}: ${judgement.verdict} — ${judgement.rationale} refs [${judgement.evidenceRefs.join(", ")}]`);
	}
	for (const proposal of diagnosis.proposals) lines$1.push(`  proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`);
	lines$1.push(`  supervision: ${supervisionMark(diagnosis, work)}`);
	return lines$1;
}
/** What the exact source run was bound to and loaded (S1-C item 4). */
function renderBindings(snapshot, source) {
	const lines$1 = [];
	for (const run of snapshot.runs.filter((item) => item.taskId === source.taskId && item.runId === source.runId)) {
		const binding = run.providerBinding;
		if (binding === void 0) continue;
		const skills = binding.skills.length === 0 ? "no provider skill" : binding.skills.map((skill) => `${skill.name} [${skill.role}] content ${skill.contentDigest.slice(0, 12)}${skill.contractDigest === null ? "" : ` contract ${skill.contractDigest.slice(0, 12)}`}`).join("; ");
		const servers = binding.mcpServers.length === 0 ? "" : `; mcp ${binding.mcpServers.map((server) => server.serverName).join(", ")}`;
		const snapshotRoot = binding.snapshotRoot === void 0 ? "" : `; snapshot ${binding.snapshotRoot}`;
		lines$1.push(`- run ${run.runId} [${run.status}] bound registry ${binding.registryRevision.slice(0, 12)}: ${skills}${servers}${snapshotRoot}`);
	}
	return lines$1;
}
/** One exact source in full, with bounded same-graph evidence navigation through the existing read tools. */
function buildReviewPack(input) {
	const { snapshot, source, work } = input;
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
	const lines$1 = [
		`review pack for task ${task.taskId} [${task.status}] depth ${task.depth}`,
		`source: review ${reviewRef(source)}${review === void 0 ? " (not on the record)" : ` [${review.outcome}]`}`,
		`source run: ${sourceRun === void 0 ? "none" : `${sourceRun.runId} [${sourceRun.status}] session ${sourceRun.sessionId ?? review?.sessionId ?? "unknown"}; ${sourceRun.runId === latestRunId ? "latest run" : "historical run"}; preset ${sourceRun.agentPreset ?? "unknown"}`}; latest run of task: ${latestRunId ?? "none"}`,
		`objective: ${task.objective}`,
		`dependencies: must verify first [${incoming.join(", ")}]; blocks [${outgoing.join(", ")}]`,
		...renderAttempts(work, source),
		renderJudgementDimensions(),
		`reviews (${reviews.length}): exact source in full; other versions in graph navigation`,
		...review === void 0 ? [] : renderReview(review),
		...renderBindings(snapshot, source)
	];
	const navigation = ["Navigation: task_status scope:\"graph\" pages tasks; context_read kind:\"task\"/\"run\"/\"evidence\"/\"diagnosis\" ref:<id> reads exact records; kind:\"review\" ref:{taskId,runId} reads one exact review; kind:\"session\" ref:<sessionId> reads session events in pages.", "Counters are recorded observations, sometimes session-cumulative; missing fields are unobserved. Complete cost: unknown — worker counters alone do not account for reviewer, supervisor and replay spend. No graph total is inferred."];
	const budget = new OutputBudget(CONTEXT_OUTPUT_LIMIT_BYTES);
	const footerReserve = 512;
	const navigationBytes = navigation.reduce((total, line) => total + utf8Bytes(line) + 1, 0);
	if (utf8Bytes(lines$1.join("\n")) + navigationBytes + footerReserve > budget.maxBytes) return `task_review_pack: exact source ${reviewRef(source)} exceeds the ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte output bound; its full record was not shortened. Read it in pages with context_read kind:"review" ref:${JSON.stringify({
		taskId,
		runId: source.runId
	})}${source.runId === null ? "" : `, and kind:"run" ref:${JSON.stringify(source.runId)}`}; task_status scope:"graph" navigates this graph.`;
	budget.addAll(lines$1);
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
			const lines$2 = [`- task ${entry.taskId} [${entry.status}] parent ${entry.parentTaskId ?? "none"}; dependencies [${incoming$1.join(", ")}]; blocks [${outgoing$1.join(", ")}]; definition ${definition}; template ${template}; diagnoses [${diagnosisRefs.join(", ")}]`];
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
				lines$2.push(`  run ${run.runId} [${run.status}; ${version}] session ${run.sessionId ?? review$1?.sessionId ?? "unknown"}; review ${review$1 === void 0 ? "none" : `${reviewRef(review$1)} [${review$1.outcome}]`}${frozen}; observed counters ${metrics || "unknown"}`);
			}
			for (const review$1 of snapshot.reviews.filter((item) => item.taskId === entry.taskId && item.runId === void 0)) lines$2.push(`  review ${reviewRef(review$1)} [${review$1.outcome}; no-run source]`);
			return lines$2;
		},
		tail: (count) => [`navigation shown: ${count}/${tasks.length} tasks. Continue task_status scope:"graph" offset:${count}, then context_read for exact task, run, review and diagnosis refs; pages are separate observations.`]
	}) === void 0) budget.add("Graph navigation did not fit; use task_status scope:\"graph\" offset:0 and context_read for exact records.");
	if (budgetList(budget, {
		header: [`diagnoses (${diagnoses.length}):`],
		units: diagnoses,
		lines: (diagnosis) => renderDiagnosis(diagnosis, work),
		tail: (count) => [`diagnoses shown: ${count}/${diagnoses.length}; exact records through context_read kind:"diagnosis" ref:<diagnosisId>, discovered through task_status scope:"graph".`]
	}) === void 0) budget.add("Diagnoses did not fit; discover diagnosisRefs through task_status scope:\"graph\", then context_read kind:\"diagnosis\".");
	return budget.text();
}
function defineTaskReviewPackTool(ctx) {
	return defineTool({
		name: "task_review_pack",
		description: "Read-only. Assemble the diagnosis input pack for ONE exact review source — a task and the run under review, or runId null for a review that carries no run (a task blocked before it started). The pack names the task itself, the exact source review in full (criteria, log tail, blockers, session), historical review references, the review work items the coordination store holds for this source and how each ended, the dimensions whose conclusion the fact table does not carry, the dependency edges touching it, and its diagnoses with any agent judgements — every diagnosis marked with the supervisor work items the coordination store holds for its round (which session ran it and how it ended), which only a graph that runs an RSI loop has. It reports the facts only: whether a review agent runs is decided elsewhere (an explicit call names its source; a graph's RSI loop spawns its supervisor itself). It adds bounded same-graph DAG navigation with exact run/session ids, template and frozen provider digests, and observed counters. Continue with task_status scope:\"graph\" and context_read; no ancestry or sibling log replay. Feed this to task_diagnose, or to task_review_agent when a judgement is needed.",
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
			const graph = await ctx.graphs.graphForSession(sessionId(exec, "task_review_pack"));
			const storeId = rootTaskStoreId(graph.rootSessionId);
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
				work: workOf(await readCoordinationRows() ?? [], graph.id)
			});
		}
	});
}

//#endregion
//#region src/coordination/review-run.ts
/** The source one attempt reviews, as a ref a reader reads back (`t1#r1`, `t2#no-run`). */
function sourceRef(source) {
	return reviewRef(source);
}
/** The diagnosis one attempt recorded, as the store holds it (the id is the attempt's session). */
function recordedDiagnosis(snapshot, sessionId$1) {
	return snapshot.diagnoses.find((diagnosis) => diagnosis.diagnosisId === `review-agent-${sessionId$1}`);
}
/** How long the completion record may lag behind the turn it concluded before the call stops waiting for it. */
const COMPLETION_GRACE_MS = 2e3;
/** How often that grace re-reads the store. */
const COMPLETION_POLL_MS = 50;
/** Run one review attempt for one source: plan, claim, spawn, then read the record back. */
async function runReviewAgentAttempt(input) {
	const { ctx, storeId, source, review, parent, actor } = input;
	const sessionId$1 = SessionId(randomUUID());
	const graph = await ctx.graphs.graphForSession(parent.id);
	const snapshot = await ctx.task.snapshotIn(storeId);
	const root = rootTaskOf(snapshot);
	const businessRound = root === void 0 ? null : terminalRootRuns(snapshot, root.taskId).length;
	const key = {
		graphId: graph.id,
		epoch: graph.rsi?.epoch ?? 1,
		role: "reviewer",
		subject: {
			kind: "review",
			businessRound,
			source,
			requestKey: input.requestKey
		}
	};
	const request = {
		key,
		storeId,
		sessionId: sessionId$1,
		actor,
		digest: subjectDigest(key),
		focus: input.reason
	};
	const rows = await readCoordinationRows() ?? [];
	const plan = planAssignment({
		request,
		rows,
		sessions: await readSessionFactsOf(ctx, rows.filter((row) => row.graphId === graph.id).map((row) => row.sessionId)),
		budget: {
			used: rows.filter((row) => row.kind === "assignment" && row.storeId === storeId).length,
			max: Number.MAX_SAFE_INTEGER
		}
	});
	if (plan.kind === "refused") return {
		kind: "refused",
		code: plan.code,
		detail: plan.detail,
		budget: void 0,
		work: plan.work
	};
	if (plan.kind === "reuse") return {
		kind: "reuse",
		work: plan.work
	};
	if (plan.kind === "in-flight" || plan.kind === "resume") return {
		kind: "in-flight",
		work: plan.work
	};
	const spawned = await spawnAssignment({
		ctx,
		request,
		parent,
		name: `review ${source.taskId}`,
		preset: REVIEWER_PRESET,
		grant: reviewerGrant(),
		role: "reviewer",
		signal: input.signal,
		prompt: () => reviewerPrompt(input, snapshot)
	});
	if (spawned.kind === "spawn-failed") return {
		kind: "spawn-failed",
		failure: spawned.failure,
		sessionId: String(sessionId$1)
	};
	const completion = await waitForCompletion(input, String(sessionId$1), spawned.handle);
	const diagnosis = recordedDiagnosis(await ctx.task.snapshotIn(storeId), String(sessionId$1));
	if (completion?.result.kind !== "reviewed" || diagnosis === void 0) return {
		kind: "no-completion",
		failure: completion === void 0 ? "the reviewer session ended its turn without calling reviewer_complete" : `the reviewer reported ${completion.result.kind} rather than a completed review`,
		sessionId: String(sessionId$1)
	};
	return {
		kind: "recorded",
		sessionId: String(sessionId$1),
		diagnosisId: diagnosis.diagnosisId,
		confidence: diagnosis.confidence,
		observation: diagnosis.observedFailure,
		conclusion: diagnosis.localizedCause,
		scope: diagnosis.scope,
		reviewRefs: diagnosis.reviewRefs,
		evidenceRefs: diagnosis.evidenceRefs,
		relatedTaskIds: diagnosis.relatedTaskIds ?? [],
		judgements: diagnosis.judgements ?? [],
		proposals: diagnosis.proposals
	};
}
/**
* Wait for the reviewer's own turn to end, then read the completion it wrote.
* The wait is on the agent this call spawned — not on a session somewhere else —
* so a reviewer that never calls its tool is a protocol failure rather than a
* call that hangs, and an interrupted turn stays DSH's to repair.
*/
async function waitForCompletion(input, sessionId$1, handle) {
	const idle = handle.agent.whenIdle().catch(() => void 0);
	await (input.signal === void 0 ? idle : Promise.race([idle, new Promise((resolve$1) => input.signal.addEventListener("abort", () => resolve$1(), { once: true }))]));
	const deadline = Date.now() + COMPLETION_GRACE_MS;
	let found;
	for (;;) {
		found = (await readCoordinationRows().catch(() => []) ?? []).find((row) => row.kind === "completion" && row.sessionId === sessionId$1);
		if (found !== void 0 || Date.now() >= deadline) break;
		await new Promise((resolve$1) => setTimeout(resolve$1, COMPLETION_POLL_MS));
	}
	if (found === void 0 && input.signal?.aborted !== true) await abandon(sessionId$1).catch(() => void 0);
	return found;
}
/** Record a work item whose reviewer ended without a completion as a protocol failure. */
async function abandon(sessionId$1) {
	const binding = await readCoordinationBinding(sessionId$1);
	if (binding === void 0 || binding.completed) return;
	await recordCompletion(protocolFailure(binding, "the reviewer session ended without calling reviewer_complete"));
}
/** The one request a reviewer reads: the facts of the source, and how to end. */
function reviewerPrompt(input, snapshot) {
	const { source, review } = input;
	const pack = buildReviewPack({
		snapshot,
		source,
		work: []
	});
	return [
		"You are a Singularity review agent. Explain the review source below: what happened, why, and what — if anything — should change.",
		"Read what you are authorized to read: the pack below, and beyond it whatever settles the question — task_read, task_status and context_read reach the sibling tasks, their sessions and their evidence; task_template_list reads the delegated task's template catalog and exact templateRef contracts. Cite what you rest on.",
		"Provide read-only analysis grounded in the recorded evidence.",
		"Start with this exact source, then inspect the business DAG and read original evidence where it distinguishes plausible causes. Explain how exploration decisions, result boundaries, upstream contracts, dependencies, shared providers or decomposition could produce the observed result. Establish a shared cause with evidence linking the implicated results.",
		...review.outcome === "verified" ? ["The run passed its review; inspect the delivered result, acceptance coverage and exploration choices as well as avoidable tool calls, repeated reads, retries and decomposition costs. Compare candidates under the original acceptance with real two-sided replay. Mark fresh transfer unknown when it has not been measured."] : [],
		"End this session by calling reviewer_complete with observation (required: what was actually observed), conclusion (required: the cause, citing the original outcome evidence), confidence (required: high | medium | low), and only when you made them scope, reviewRefs, evidenceRefs, relatedTaskIds, judgements and proposals.",
		"- reviewRefs must be exact taskId#runId (or taskId#no-run) refs from this store; top-level evidenceRefs must be evidence bundle ids read through context_read kind:\"evidence\"; relatedTaskIds must be actual task ids in this graph.",
		"- judgements (optional): [{dimension, verdict, evidenceRefs, rationale}] where dimension is one of the judged dimensions and each judgement cites at least one recorded ref and a rationale.",
		"- proposals (optional): [{targetType, targetId, rationale}] — suggestions for the supervisor; nothing here executes them.",
		"Calling reviewer_complete closes this session’s write access; reads and findings stay available. A session that ends its turn without calling it is a protocol failure and no diagnosis is invented from its silence.",
		"",
		"--- source under review ---",
		`review ${sourceRef(source)} [${review.outcome}]${input.reason === null ? "" : ` — focus: ${input.reason}`}`,
		"",
		"--- review pack ---",
		pack
	].join("\n");
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
/** How one work item is named in a result, in the words the source's caller uses. */
function workLabel(work) {
	const requestKey = work.assignment.subject.kind === "review" ? work.assignment.subject.requestKey : null;
	return requestKey === null ? "default work item" : `requestKey "${requestKey}"`;
}
/** What one work item the caller asked for already is: its identity, how it ended, and the diagnosis it recorded. */
function renderExistingWork(work, snapshot) {
	const assignment = work.assignment;
	const diagnosis = recordedDiagnosis(snapshot, assignment.sessionId);
	const status = work.completion?.result.kind ?? (diagnosis === void 0 ? "open" : "recorded");
	const head = `task_review_agent: source ${sourceRef(assignment.subject.source)} already has this work item (${workLabel(work)}, session ${assignment.sessionId}, ${status}) — returning it; no review session started`;
	if (diagnosis === void 0) return status === "interrupted" || status === "protocol-failure" ? `${head}; a new review for this source needs an explicit requestKey` : `${head}; its diagnosis is not in the store`;
	const lines$1 = [
		head,
		`observation: ${diagnosis.observedFailure}`,
		`conclusion: ${diagnosis.localizedCause}`,
		`scope: ${diagnosis.scope}; related tasks: ${diagnosis.relatedTaskIds?.join(", ") || "none"}`,
		`review refs: ${diagnosis.reviewRefs.join(", ")}; evidence refs: ${diagnosis.evidenceRefs.join(", ") || "none"}`
	];
	if (diagnosis.judgements !== void 0 && diagnosis.judgements.length > 0) lines$1.push(`judgements (agent ${assignment.sessionId}):`, ...renderJudgements(diagnosis.judgements));
	lines$1.push(`diagnosis ${diagnosis.diagnosisId} recorded [${diagnosis.confidence}]`);
	if (diagnosis.proposals.length === 0) lines$1.push("proposals: none — the conclusion carries no suggestion");
	else for (const proposal of diagnosis.proposals) lines$1.push(`proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`);
	return lines$1.join("\n");
}
/** What one refusal says, by name, before any assignment or spawn exists. */
function renderRefusal(outcome, source, storeId) {
	if (outcome.code === "subject-conflict") return `task_review_agent: ${outcome.detail} for source ${sourceRef(source)}; refusing — a key names one review focus and cannot be changed. No review session started`;
	if (outcome.code === "attempts-exhausted") return `task_review_agent: ${outcome.detail}; a new review for this source needs an explicit requestKey — no review session started`;
	return `task_review_agent: ${outcome.detail}; no review session started for store ${storeId}`;
}
/** The answer one attempt ended with, rendered for its caller. */
function renderOutcome(outcome, source, storeId, snapshot, review) {
	switch (outcome.kind) {
		case "refused": return renderRefusal(outcome, source, storeId);
		case "reuse": return renderExistingWork(outcome.work, snapshot);
		case "in-flight": return `task_review_agent: source ${sourceRef(source)} already has a work item in flight (${workLabel(outcome.work)}, session ${outcome.work.assignment.sessionId}) — the new request was not accepted; one source never runs two review sessions at once; no review session started`;
		case "spawn-failed": return `task_review_agent: spawn failed: ${outcome.failure} (source ${sourceRef(source)}, work item ${outcome.sessionId} recorded interrupted); no review session started`;
		case "no-completion": return `task_review_agent: review session ${outcome.sessionId} ended without a diagnosis — ${outcome.failure} (source ${sourceRef(source)}, work item ${outcome.sessionId} recorded as a protocol failure); no diagnosis was recorded and nothing was invented from its silence`;
		case "recorded": return [
			`task_review_agent: review session ${outcome.sessionId} judged task ${source.taskId} (source ${sourceRef(source)}; the review it read settled ${review.outcome})`,
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
		description: "Spawn ONE read-only review session for one exact review source — a task and the run under review, or runId null for a review that carries no run (a task blocked before it started) — and take the diagnosis it records. The reviewer reads the review pack and, beyond it, whatever settles the question through its own context reads. It ends by calling reviewer_complete with an observation (required: what really happened, for a successful source as much as a failed one), a conclusion in its own words (\"no improvement needed\" and \"the evidence does not settle this\" are conclusions), a confidence, and — only when it made them — scope, refs, judgements and proposals. A judgement names one of the dimensions no parser settles (task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency) with verdict adequate|inadequate|unknown, the refs it rests on and a rationale; a judgement that cites nothing is refused rather than downgraded. A proposal is a suggestion only: it names a target type the diagnosis does not freeze, and nothing here executes it. reason names what the review should focus on. A session whose turn ends without calling reviewer_complete is a protocol failure: no Diagnosis is invented from its silence, and the platform does not ask again. One source has one default work item: a repeat of the same call returns that work item and its result instead of starting another. Reviewing the same source again after that work item settled is an explicit act: pass a new non-empty requestKey, which is persisted with the source and the focus; the same key with a different source is refused. While a work item of the source is in flight the call returns its identity and starts nothing. The reviewer has no write, shell, spawn, or evolution tool and is capped per root store.",
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
				description: "Optional non-empty key for an explicit further review of the same source; omit for the source's default work item"
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
			if (snapshot.tasks.find((item) => item.taskId === args.taskId) === void 0) return `task_review_agent: unknown task "${args.taskId}" in store ${storeId} (the caller's graph root); no review session started`;
			if (args.runId !== null && !snapshot.runs.some((run) => run.runId === args.runId && run.taskId === args.taskId)) return `task_review_agent: run "${args.runId}" is not a run of task "${args.taskId}"; no review session started`;
			const review = reviewForSource(snapshot, source);
			if (review === void 0) return `task_review_agent: no review record for source ${sourceRef(source)} in store ${storeId}; no review session started`;
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
/** The shipped switch position: `on` — the method tools are the one way a method changes. */
const DEFAULT_METHOD_TOOLS = "on";
const Supervision = z.object({ coordinationBudget: z.number().default(DEFAULT_SUPERVISION.coordinationBudget) });
const ConfigSchema = z.object({
	methodTools: z.union([z.const("off"), z.const("on")]).default(DEFAULT_METHOD_TOOLS),
	supervision: Supervision.default({ ...DEFAULT_SUPERVISION })
});
/** The method-tool exposure this composition resolved, provided on the agent's own fiber as `ctx.singularityMethods`. */
var MethodToolsExposure = class extends Service {
	/** `true` when `Config.methodTools` is `on`, i.e. the six `method_*` tools are registered. */
	enabled;
	constructor(ctx, enabled) {
		super(ctx, "singularityMethods");
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
	* it — see `coordination/driver.ts`), `undefined` otherwise, so the
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
		const methodTools = config?.methodTools ?? DEFAULT_METHOD_TOOLS;
		ctx.plugin(HitlService);
		this.evolution = new EvolutionService(ctx, {
			repoRoot: REPO_ROOT,
			modelSelection: () => deploymentModelSelection(ctx),
			capabilityConfig: join(REPO_ROOT, "config.yml")
		});
		new EscalationService(ctx);
		new ProposalReviewService(ctx);
		new MethodToolsExposure(ctx, methodTools === "on");
		new SupervisionExposure(ctx, supervision);
		ctx.effect(() => ctx.singularityContext.registerCoordinationBindingSource(coordinationBindingSource()), "singularityAgent: coordination binding source");
		ctx.effect(() => installCoordinationDriver(ctx).dispose, "singularityAgent: coordination driver");
		ctx.effect(() => {
			const view = ctx.get("singularityGraphView");
			if (view === void 0) {
				this.warn("singularity-agent: no singularityGraphView service is mounted, so this deployment reads no derived coordination progress; the driver still assigns and completes work");
				return () => void 0;
			}
			return view.registerCoordinationFacts(coordinationFactsReader());
		}, "singularityAgent: coordination facts");
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
		ctx.tools.register(defineSupervisorCompleteTool(ctx));
		ctx.tools.register(defineReviewerCompleteTool(ctx));
		ctx.tools.register(defineTaskBudgetExtendTool(ctx));
		ctx.tools.register(defineTaskDiagnoseTool(ctx));
		if (methodTools === "on") {
			ctx.tools.register(defineMethodListTool(ctx));
			ctx.tools.register(defineMethodDraftTool(ctx));
			ctx.tools.register(defineMethodEvaluateTool(ctx));
			ctx.tools.register(defineMethodPublishTool(ctx));
			ctx.tools.register(defineMethodDiscardTool(ctx));
			ctx.tools.register(defineMethodRollbackTool(ctx));
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
		const known = new Set(["methodTools", "supervision"]);
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
export { DEFAULT_METHOD_TOOLS, DEFAULT_SUPERVISION, EscalationService, HitlService, ProposalReviewService, SingularityAgent, src_default as default, deploymentModelSelection };