import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { TOOL_LABELS, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS, optionalService, workerBaseline } from "@dangosys/dsh-singularity-task-runtime";
import { APPLYABLE_TARGET_TYPES, EVOLUTION_DECISIONS, EvolutionService, applyTargets, modelSelectionOf, renderProviderRoles } from "@dangosys/dsh-singularity-evolution";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { JUDGED_DIMENSIONS, JUDGEMENT_VERDICTS, canonicalize, rootTaskStoreId, sha256Hex } from "@dangosys/dsh-singularity-task";
import { CONTEXT_OUTPUT_LIMIT_BYTES, ReviewerBindingError, openRootProposals } from "@dangosys/dsh-singularity-context";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/hitl.ts
/**
* The canvas answerer on the native interaction seams: root tools ask through
* `ctx.userQuestions` / `ctx.approval` (audit events and fail-closed semantics
* live there), and this service is the answerer that bridges those waterfalls
* onto the pending-card store the canvas UI polls over `GET/POST
* /singularity/hitl` and the `hitl/change` SSE. A card the canvas cannot
* present faithfully (a multi-question batch) is delegated to `next()`, so the
* native NO_PROVIDER / 'unavailable' fail-closed path stays intact.
*
* Both listeners are registered with `prepend`, ahead of every listener
* already on the event. The gateway's mux forwarder (api-remotes) claims
* `approval/request` by position and parks the request until a browser mux
* client answers or delegates; with zero clients attached it never calls
* `next()`, so a later listener never sees the request at all (guide §4.2
* #17). Claiming first makes this service the decision surface either way;
* the native answerer chain below it is untouched.
*/
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
			const text$32 = await this.enqueue(request.agent?.id ?? "unknown", "ask", question.question, request.signal);
			if (text$32.kind !== "ask") throw new Error("hitl: expected ask answer");
			return { answers: [{
				id: question.id,
				selected: [],
				custom: text$32.text
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
	enqueue(sessionId$22, kind, prompt, callerSignal) {
		const signal = callerSignal === void 0 ? this.lifetime.signal : AbortSignal.any([callerSignal, this.lifetime.signal]);
		signal.throwIfAborted();
		if (typeof sessionId$22 !== "string" || sessionId$22.length === 0) throw new Error("hitl: missing session id");
		const id = randomUUID();
		const pending = {
			id,
			kind,
			prompt,
			sessionId: sessionId$22,
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
//#region src/escalation.ts
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
/**
* Payload validation shared by the write path (`raise`) and the fold, so a
* hand-forged ledger line fails load exactly as it would fail append: the kind
* must be known, the id non-empty, the three KISS §7 elements present, the
* trigger one of the four, and the human-approval evidence real.
*/
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
/**
* The escalation ledger (plane separation: this store is independent of the
* task store and refers to it by id only). Append and replay share one fold,
* so a corrupt or duplicated line fails loudly instead of silently drifting.
* Writes are serialized; the file is opened per append, so closing the service
* is just draining the write queue.
*/
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
		this.repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
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
	/**
	* Record one card. The caller (the `escalate` tool) must hold a human grant
	* from `ctx.approval.request` first and pass its call id as `approvalRef`
	* (`approval:<callId>`, the evolution_decide shape): a rejected, cancelled,
	* or unavailable ask must never reach this method. Payload validation runs
	* before anything touches disk.
	*/
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
	/**
	* Fold records into cards, enforcing the payload rules on every step: a
	* `raised` line starts a new id, a repeated id is refused, and every field
	* is re-validated, so an illegal line fails load exactly as it would fail
	* append.
	*/
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
		let text$32;
		try {
			text$32 = await readFile(this.file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		const records = text$32.split("\n").filter((line) => line.trim().length > 0).map((line, index) => {
			try {
				return JSON.parse(line);
			} catch {
				throw new Error(`escalation: corrupt ledger line ${index + 1} in ${this.file}`);
			}
		});
		for (const record of records) if (record.formatVersion !== 1) throw new Error(`escalation: unsupported ledger formatVersion "${String(record.formatVersion)}"`);
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

//#endregion
//#region src/proposal-review.ts
/** The prefix `rootTaskStoreId` writes; see {@link ownerSessionOfStore} for why it is re-checked rather than trusted. */
const STORE_PREFIX$1 = "sg-t-";
/** The tool name a batch review's question is about: the decomposition the batch would become (audit and presentation). */
const BATCH_REVIEW_TOOL_NAME = "task_decompose";
/**
* The tool name a root contract review's question is about: the intake that
* submitted the contract. A root contract is nobody's decomposition, so a card
* labelled `task_decompose` would ask a person about a call that was never made.
*/
const ROOT_REVIEW_TOOL_NAME = "task_intake";
/**
* The owner session of a task store — whose approval surface a review of that
* store's batches belongs on — or `undefined` for an id this deployment did not
* build.
*
* The parse is re-checked through {@link rootTaskStoreId} rather than trusted:
* the mapping from a root session to its store belongs to the task package, and
* a string that merely looks like one must not name a session that never owned
* a store (which would route a review into a stranger's conversation).
*/
function ownerSessionOfStore(storeId) {
	if (!storeId.startsWith(STORE_PREFIX$1)) return void 0;
	const sessionId$22 = storeId.slice(5);
	return sessionId$22.length > 0 && rootTaskStoreId(sessionId$22) === storeId ? sessionId$22 : void 0;
}
/**
* The decider identity the channel records: the approval surface of the owner
* session the review was shown in. Deliberately a channel-shaped value — the
* same `approval:` family the native grants use (`escalate`, `evolution_decide`)
* — because a reader of the record must be able to tell a human grant apart
* from a session id and from anything a model could have written.
*/
function reviewDecider(ownerSessionId) {
	return `approval:${ownerSessionId}`;
}
/** How a container field is listed, or that it held nothing — never an omitted line a reader has to notice. */
function listField(title, items, empty) {
	if (items.length === 0) return [`  ${title}: ${empty}`];
	return [`  ${title}:`, ...items.map((item) => `  - ${item}`)];
}
/**
* The protected acceptance inputs a criterion declares, with the identity fixed
* at submission: a reviewer has to see that they are protected *and* which bytes
* were fixed, because the verifier re-reads exactly these before judging.
*/
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
/**
* How a criterion reads to a reviewer: its id, its mode, whether it is mandatory,
* whether it is a heuristic judgement (which never counts as a deterministic
* pass — §5 requires the marking, not a footnote), what it says, and what it
* pins (command, named verifier, protected inputs, artifact requirements).
*
* `indent` is the caller's, because the same criterion line is read under a
* child of a batch and under a root contract: the marking is the subject, the
* depth is the caller's business.
*/
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
/**
* How one declared capability resolved when this batch was proposed: the
* manifest the runtime built for *this* child, with the skills and tools a
* worker would be granted — and the capability gap named when a requirement is
* not in the registry, rather than silently absent (§5's 声明能力及当前解析).
*
* `undefined` is the honest answer for a request that carried no manifest for
* this child: the resolution is then not shown at all, and nothing is claimed
* about it.
*/
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
/**
* One child of the batch as a reviewer reads it (§5): its goal, its criteria,
* what it inherits as assumptions and constraints, what it waits for, what it
* requires, and how those requirements currently resolve.
*
* `dependsOn` names the sibling objective as well as the index: a batch whose
* ordering matters must not require a reviewer to count positions.
*/
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
/**
* The complete batch content of a stored proposal, one block per child in batch
* order — the whole set, never a prefix. `manifests`, when a caller has them,
* are the resolution recorded with the request and are aligned with the
* children positionally.
*
* The parameter is the decomposition arm of {@link TaskProposal} on purpose: a
* root contract has no batch, and a renderer that could still be handed one
* would be rendering a payload that does not exist as if it did.
*/
function renderProposalChildren(proposal, manifests) {
	return proposal.batch.flatMap((child, index) => [...renderProposalChild(child, {
		index,
		siblings: proposal.batch,
		...proposal.identity.children[index]?.contractDigest === void 0 ? {} : { contractDigest: proposal.identity.children[index].contractDigest },
		...manifests?.[index] === void 0 ? {} : { manifest: manifests[index] }
	}), ""]);
}
/**
* One root contract as a reviewer reads it (§5's display list for the subject
* that has no parent): the contract version, the objective, every criterion
* with the markings {@link criterionLine} prints, the assumptions and
* constraints it rests on, the capabilities it declares, and — when the caller
* has them — the resolution this intake recorded, whose single manifest covers
* the contract's declared capabilities.
*
* A pure rendering of the contract it is given: it shows what the record holds
* and nothing about a parent, a batch or a task, because none of those exist
* while a root contract waits.
*/
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
	return [
		`- enforced at admission: maxDepth ${context.maxDepth}, maxChildren ${context.maxChildren}`,
		`- enforced in flight: ${context.wallTimeMs === void 0 ? "no wall-clock ceiling was configured" : `wallTimeMs ${context.wallTimeMs}`}`,
		`- audited after the run (never enforced in flight): ${audited.length === 0 ? "none configured" : audited.join(", ")}`
	];
}
/**
* The review material one person is shown (§5), rendered from the saved facts:
* for a batch, the parent, every child, the limits, the obligations, the
* identity a decision binds and what this record honestly cannot promise; for a
* root contract, the contract itself and no parent at all — the task it becomes
* does not exist while it waits.
*
* The subject is discriminated by kind, and the two arms share every part that
* means the same thing in both (the limits, the identity, the boundary
* statements): a reviewer deciding a root intake is answering a different
* question, not reading a one-child batch of nobody.
*
* A pure function of the request, so what a deployment shows and what a test
* asserts are the same rendering.
*/
function renderProposalReview(request) {
	return request.kind === "root" ? renderRootReview(request) : renderBatchReview(request);
}
/**
* The identity a decision binds, as both subjects print it: the three digests,
* the resolution, the key and the submission time. `subject` only names what
* the pinned verifiers belong to.
*/
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
/**
* The obligations a review lists, as the request carried them. An empty list is
* printed as one line rather than omitted: "nothing is on record" is what a
* reviewer has to be able to read, and a root contract has no task to raise one
* on, so its list is empty by construction rather than by omission.
*/
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
/**
* The review of a root contract (A0 §3): the goal a root session would be
* admitted as, and no parent section — there is no parent task, and the root
* task this contract becomes does not exist while it waits.
*
* What a decision here binds is the contract: its objective and criteria are
* the goal the whole graph is later judged against, so the rendering walks
* every criterion with the markings §5 requires (mode, mandatory, heuristic,
* protected inputs, the command or verifier it pins) and prints the declared
* capabilities with the resolution this intake recorded.
*/
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
/**
* The review channel this deployment mounts (T2/T3 §5–§6). It renders, asks, and
* records; it never admits anything itself — a recorded decision is what moves a
* proposal, and the runtime performs the post-approval re-check and the
* admission on its own.
*/
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
				detail: `the approval channel could not ask the owner session "${ownerSessionId}" (${message$1(error)}), so nobody was asked; the proposal stays pending_review`
			};
		}
		if (reached === "pending") {
			ask.then((outcome) => this.record(request, ownerSessionId, outcome)).catch((error) => this.warn(`proposal ${request.proposal.proposalId}: the review request to session "${ownerSessionId}" ended without a usable answer (${message$1(error)}); the proposal keeps the status the store holds`));
			return {
				requested: true,
				detail: `the review was put to the owner session "${ownerSessionId}" through the approval channel; the proposal stays pending_review until the decision is recorded, and the runtime continues the batch when it is`
			};
		}
		if (reached === "allowed-once" || reached === "rejected") {
			this.record(request, ownerSessionId, reached).catch((error) => this.warn(`proposal ${request.proposal.proposalId}: the answer of session "${ownerSessionId}" could not be recorded (${message$1(error)}); the proposal keeps the status the store holds`));
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
	/**
	* One human answer, turned into the only thing that can move a waiting
	* proposal: a decision on the record. An approval is recorded as `approved`
	* (the runtime then re-checks the batch and admits it); an explicit refusal as
	* `rejected`, naming who refused. Nothing else is written: `unavailable` and
	* `cancelled` are states of the ask, and §6 allows exactly one decision per
	* proposal — so a store that refuses this write because the proposal moved on
	* meanwhile is warned about, never retried into a second decision.
	*/
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
	liveAgent(sessionId$22) {
		const holder = this.ctx;
		const registry = (typeof holder.get === "function" ? holder.get("agents") : void 0) ?? holder.agents;
		try {
			return registry?.get?.(sessionId$22);
		} catch {
			return;
		}
	}
	/**
	* Whether one session's approval policy asks a person at all. The policy is
	* the approval service's own (a session override, else the configured
	* default): under `never` the service answers `rejected` without dispatching
	* anything, so a request routed there would look like a human refusal.
	* Reading it before asking is what keeps that outcome from being invented.
	*/
	asksAPerson(agent) {
		const service = this.ctx.approval;
		return (service?.overrideOf?.(agent.session) ?? service?.config?.policy ?? "ask") === "ask";
	}
	/** The runtime that owns the store; resolved lazily, because the store is opened after this service is mounted. */
	runtime() {
		return this.ctx.taskRuntime;
	}
	/** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
	warn(message$2) {
		const logger = this.ctx.logger;
		logger?.("proposal-review").warn(message$2);
	}
	/** The same seam at info level, for the trace of a decision that landed. */
	info(message$2) {
		const logger = this.ctx.logger;
		logger?.("proposal-review").info(message$2);
	}
};
function message$1(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
//#region src/tools/review-escalation.ts
/** How many review agents one root store may start before the guardrail holds. */
const REVIEW_AGENT_BUDGET_DEFAULT = 1;
/**
* The judgement line: the six dimensions whose conclusion the fact table does
* not carry, named so a reader cannot mistake the facts for a verdict. It names
* what needs judgement, never whether one will run — that is the triggers' and
* the store's allowance decision.
*/
function renderJudgementDimensions() {
	return `needs judgement (agent): ${JUDGED_DIMENSIONS.join(", ")} (not mechanically observable from the fact table; a review agent may conclude them)`;
}

//#endregion
//#region src/review-agent-ledger.ts
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
/** The per-root-store cap; `SINGULARITY_REVIEW_AGENT_BUDGET` when it parses to a positive integer. */
function reviewAgentBudget() {
	const raw = process.env.SINGULARITY_REVIEW_AGENT_BUDGET;
	const parsed = raw === void 0 || raw.length === 0 ? NaN : Number(raw);
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : REVIEW_AGENT_BUDGET_DEFAULT;
}
/** One parsed row. An unrecognized row throws by name rather than being read as something it is not. */
function asLedgerRow(parsed, line) {
	const row = parsed;
	if (row.formatVersion === 1) return row;
	if (row.formatVersion === 2 && (row.kind === "claim" || row.kind === "started" || row.kind === "settled")) return row;
	throw new Error(`review-agent-ledger: unrecognized row ${line} in ${reviewAgentLedgerFile()}`);
}
/** The rows one ledger file holds, as its non-empty lines. A corrupt line throws by name rather than undercounting. */
function parseLedgerRows(text$32) {
	const rows = [];
	text$32.split("\n").forEach((line, index) => {
		if (line.trim().length === 0) return;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new Error(`review-agent-ledger: corrupt line ${index + 1} in ${reviewAgentLedgerFile()}`);
		}
		rows.push(asLedgerRow(parsed, index + 1));
	});
	return rows;
}
/** Every ledger row, or `undefined` when the ledger has never been written (zero rows is a state, not a failure). */
async function readLedgerRows() {
	let text$32;
	try {
		text$32 = await readFile(reviewAgentLedgerFile(), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		throw error;
	}
	return parseLedgerRows(text$32);
}
/** A started fact, whatever version wrote it: the spend and the delegation. */
function isStartedRow(row) {
	return row.formatVersion === 1 || row.kind === "started";
}
/** One store's rows of a kind the caller needs. */
function storeRows(rows, rootStoreId, match) {
	return rows.filter((row) => row.rootStoreId === rootStoreId).filter(match);
}
/** The store's started rows — the durable count, and the delegation rows. */
function startedRowsOf(rows, rootStoreId) {
	return storeRows(rows, rootStoreId, isStartedRow);
}
/**
* The attempts one store's rows hold, in the order they were claimed: each
* claim row is an attempt, its identity is the session it names, and the
* started/settled rows that name the same session are its facts. A settled
* row that lands twice is the same fact written twice, so the first one holds.
* A row without a role is a reviewer's — the only kind this file held before
* the supervisor role was added.
*/
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
/** Whether two sources are the same source. */
function sameSource$1(left, right) {
	return left.taskId === right.taskId && left.runId === right.runId;
}
/** The role a row or a request belongs to: an older row carries none and is a reviewer's. */
function roleOf$1(role) {
	return role === "supervisor" ? "supervisor" : "reviewer";
}
/** The attempts of one role among a store's attempts — the two roles never dedupe against each other. */
function attemptsOfRole(attempts, role) {
	return attempts.filter((attempt) => attempt.role === role);
}
/**
* Decide one review request against one store's attempts. Pure, so every branch
* is testable and the admission's order is the order written here:
*
* 1. the request's own attempt (same source, same key) — a repeat returns the
*    same identity and never re-charges the budget, and a repeat with a
*    different focus is a conflict, not a silent re-focus;
* 2. any other attempt of the source that is not settled — the request is not
*    accepted, because one source never runs two attempts at once;
* 3. a request with no key for a source that was already reviewed: the default
*    attempt is a source's first attempt, so a later one names its key;
* 4. the budget, read only here: an exhausted store refuses a *new* attempt and
*    still answers (1) and (2).
*
* Only reviewer attempts take part: a supervisor row names a hand-off, not a
* review source, and one role's attempt never dedupes against the other's.
*/
function planReviewAttempt(input) {
	const { request, budget } = input;
	const mine = attemptsOfRole(input.attempts, "reviewer").filter((attempt) => sameSource$1(attempt.source, request.source));
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
/**
* Decide one hand-off's supervisor request (A6) against one store's attempts.
*
* A hand-off is deduped by its **diagnosis**, not by a source and not by a
* caller's key: one diagnosis has at most one supervisor, and a repeat of the
* request is answered with that supervisor's identity however long ago it was
* started (plan §F.4: 重复消费/重启只返回同一 supervisor 身份). The order:
*
* 1. a claim of the same diagnosis under another hand-off digest is a conflict
*    by name, before anything is answered from it: the digest is what the
*    diagnosis promises about content, and an id carrying different suggestions
*    is not the hand-off this ledger took up;
* 2. an attempt that reached model input and is not settled **is** the hand-off's
*    supervisor: the request is that attempt, in this process and after a restart
*    alike — a coordination session is not a bounded job, and re-answering a
*    repeat with a *new* session would be a second coordinator for one hand-off;
* 3. an attempt that never reached model input — a claim the region settles
*    `interrupted` when no process here is running it — is not an identity, and
*    neither is a started attempt whose own terminal fact is `interrupted` (a
*    spawn that failed after its started row was written): the hand-off is free
*    for a fresh attempt, and the spend that did happen stays on the record;
* 4. the allowance, read only here: an exhausted store refuses a *new*
*    coordinator and still answers (2).
*/
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
/**
* How many review agents this root store has already started, as the file reads
* right now. A missing file reads as zero; a corrupt line throws rather than
* silently undercounting.
*
* A display query only: it caches nothing, so it can never be the count an
* admission decides on — that one is read inside the store's serial region
* ({@link admitReviewAgent}) together with the claim it writes.
*/
async function countReviewAgentRuns(rootStoreId) {
	return startedRowsOf(await readLedgerRows() ?? [], rootStoreId).length;
}
/**
* Every attempt this root store's ledger holds, for a reader that renders the
* state rather than deciding on it (`task_review_pack`). A display query: the
* decision is always made inside the admission's serial region.
*
* Both roles are in the answer — the rows are one file — and a reader that
* means one of them filters by {@link ReviewAgentAttempt.role}.
*/
async function readReviewAgentAttempts(rootStoreId) {
	return attemptsOf(await readLedgerRows() ?? [], rootStoreId);
}
/** The budget one admission belongs to: a ledger file and a root store. */
function budgetKey(rootStoreId) {
	return `${reviewAgentLedgerFile()}\u0000${rootStoreId}`;
}
/**
* The serial regions, one promise chain per budget key. A region is the only
* place an attempt is decided on and claimed, so the attempts an admission sees
* and the claim it writes cannot have another admission in between them (K4-1).
* The chain's tail is settled either way, so a failed region cannot wedge the
* key's next admission.
*/
const regions = /* @__PURE__ */ new Map();
/** Append one row, creating the ledger directory if needed. Only the doors below write. */
async function appendRow(row) {
	const file = reviewAgentLedgerFile();
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
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
/**
* Record one attempt's terminal fact. Append-only and outside the serial region
* on purpose: the caller writes it after it observed the outcome, which is
* always after the region that started the attempt has ended (A5: waiting for
* the reviewer's output never runs inside the region). Two writers of the same
* fact produce the same fact twice, which reads as one.
*
* Writing this fact — and only writing it — ends *this process's* ownership of
* the attempt (see {@link liveAttempts}): until the row is durably on the file,
* the attempt counts as one this process is still running, so no admission
* meeting it in that window may read it as a dead process's attempt and record a
* second terminal fact for it. The marker is dropped once the append has landed,
* and also when the append throws — the attempt is over here either way, and a
* marker that outlived its attempt would pin the source in flight. A terminal
* fact nobody could write is recovered from the store's own record on the next
* decision.
*/
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
/**
* The attempts this process started and has not settled, by the reviewer session
* each was claimed under.
*
* The file cannot hold this fact: a started row says a run was spent, not that
* anybody is still working on it. This set is the one thing that tells a *live*
* attempt from one a dead process left behind — a row that is open and not in
* here belongs to no running process, so it can be recorded as interrupted. It
* is not a count, not a cache and not a reservation: the count stays the started
* rows, the attempts stay the claim rows, and no decision reads this for
* anything but "is that attempt still being run here?".
*
* A deployment that runs two processes over one ledger home would have each of
* them see the other's live attempts as dead; the ledger is a single writer's by
* design (`admitReviewAgent`'s serial region).
*/
const liveAttempts = /* @__PURE__ */ new Set();
/**
* Run one review-agent admission inside the ledger's serial region for a store.
*
* One region per (ledger file, root store): inside it the whole ledger file is
* read, this store's attempts and its started count are derived, and `work` runs
* with the decision door (`plan`), the claim door and the started door. The
* region ends when `work` returns or throws. Nothing else is serialized: waiting
* for the reviewer's output, its watchdog, and recording its Diagnosis happen
* after `work` returned, outside the region, in the caller.
*
* The consequence to rely on: two admissions for one store cannot interleave
* their read-and-claim, so the second one reads what the first left behind
* instead of a file that has not caught up yet — one attempt per source, and
* one started row per allowance. A claim that fails writes no row and spends
* nothing, and the failed region does not wedge the key.
*
* The one recovery {@link ReviewAgentAdmission.plan} performs: an open attempt
* that no process is running — one that never reached model input, or one that
* was started but is not in this process's {@link liveAttempts} — is recorded
* with the terminal fact it never got: `interrupted`, or `recorded` when the
* caller's own read finds its diagnosis on the store. The same identity, no
* second claim, no second started row, no re-charge — and after it the request
* is decided as if the attempt were settled, which is what lets a source whose
* reviewer died be reviewed again. An attempt this process is really running is
* left untouched and answered as in flight.
*
* A **started supervisor** attempt is never recovered: its started row is the
* hand-off's terminal fact (the coordination session owns the hand-off from
* there, and a coordinator is not a bounded job whose result a later read could
* recover), so the recovery loop leaves it exactly as it is — after a restart
* included. Only a supervisor *claim* that never reached model input is settled
* `interrupted`, which is what frees a hand-off whose coordinator never started.
*
* `work` must not await another admission for the same store (that region waits
* for this one) and must await every `claim`/`start` it calls before returning.
*
* @param rootStoreId - the root task store the budget belongs to.
* @param work - the admission decision and the spawn, given the store's count and its write doors.
* @returns whatever `work` returned, once the region has ended.
*/
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
						if (!sameSource$1(attempt.source, request.source)) continue;
					} else {
						if (attempt.diagnosisId !== request.diagnosisId) continue;
						if (attempt.started) continue;
					}
					if (attempt.settlement !== void 0) continue;
					if (liveAttempts.has(attempt.sessionId) || claimedHere.has(attempt.sessionId)) continue;
					const recorded = await hooks?.recorded?.(attempt) === true;
					const status = recorded ? "recorded" : "interrupted";
					const note = recorded ? DIAGNOSIS_ALREADY_RECORDED : attempt.started ? STARTED_OWNER_GONE : CLAIM_NEVER_STARTED;
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
					plan: (requestRole === "supervisor" ? planSupervisorAttempt : planReviewAttempt)({
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
/**
* The one delegation a session is recorded under, as the context package's
* reviewer binding source reads it (A2 §D): the started row's `sessionId` is the
* coordination agent's own session, so the started rows naming it are its
* delegation. A claim alone is not a delegation — the claim is an intent, and a
* session that never reached model input was never delegated a read domain — so
* only rows that record a start are read here.
*
* Both roles answer this read, and that is the point: a supervisor is delegated
* into the same domain a reviewer is (the root store and the source task the
* hand-off's Diagnosis is about), so the same row shape carries either
* delegation. What tells them apart is the row's own field, not this reader.
* One row is the record; several rows that disagree are a conflict the reader
* may not pick between (a read domain chosen by file order is not an
* authorization), and a ledger this process cannot read is `unreadable` — both
* raised as the context package's {@link ReviewerBindingError}, never softened
* into "no delegation". Identical duplicate rows are one delegation written
* twice, not a conflict.
*/
async function readReviewerDelegation(sessionId$22) {
	let rows;
	try {
		rows = await readLedgerRows();
	} catch (error) {
		throw new ReviewerBindingError("unreadable", `the reviewer ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const matches = (rows ?? []).filter(isStartedRow).filter((row) => row.sessionId === sessionId$22);
	if (matches.length === 0) return void 0;
	const first = matches[0];
	const record = {
		rootStoreId: first.rootStoreId,
		taskId: first.taskId,
		actor: first.actor,
		at: first.at
	};
	if (matches.some((row) => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId || row.actor !== record.actor)) throw new ReviewerBindingError("binding-conflict", `session "${sessionId$22}" is recorded under more than one reviewer delegation: ` + matches.map((row) => `${row.taskId} in ${row.rootStoreId} (by ${row.actor})`).join("; "));
	return record;
}
/**
* The supervisor delegation of one (session, diagnosis) pair, as the ledger holds
* it, or `undefined` when no started row names both.
*
* The same discipline as {@link readReviewerDelegation}: only a started row is a
* delegation (a claim alone is an intent), several rows that disagree are a
* conflict the reader may not pick between, and a ledger this process cannot read
* is `unreadable` — a session is never told it is not a supervisor because the
* file holding the answer broke.
*/
async function readSupervisorDelegation(sessionId$22, diagnosisId) {
	let rows;
	try {
		rows = await readLedgerRows();
	} catch (error) {
		throw new ReviewerBindingError("unreadable", `the supervisor ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const startedSessions = new Set((rows ?? []).filter(isStartedRow).map((row) => row.sessionId));
	const matches = (rows ?? []).filter((row) => row.formatVersion === 2 && row.kind === "claim").filter((row) => row.role === "supervisor" && row.diagnosisId === diagnosisId && row.sessionId === sessionId$22).filter((row) => startedSessions.has(row.sessionId));
	const first = matches[0];
	if (first === void 0) return void 0;
	const record = {
		rootStoreId: first.rootStoreId,
		taskId: first.taskId,
		actor: first.actor,
		at: first.at,
		sessionId: first.sessionId,
		diagnosisId
	};
	if (matches.some((row) => row.rootStoreId !== record.rootStoreId || row.taskId !== record.taskId || row.actor !== record.actor)) throw new ReviewerBindingError("binding-conflict", `session "${sessionId$22}" is recorded under more than one supervisor delegation for diagnosis "${diagnosisId}": ` + matches.map((row) => `${row.taskId} in ${row.rootStoreId} (by ${row.actor})`).join("; "));
	return record;
}
/** The delegation source the assembly injects into the evolution plane (A6): this deployment's ledger, as the narrow read door above. */
function supervisorDelegationSource() {
	return { read: readSupervisorDelegation };
}
/** The binding source the plugin registers into the context service: this deployment's ledger, as the narrow read door above. */
function reviewerBindingSource() {
	return { read: readReviewerDelegation };
}

//#endregion
//#region src/handoff-rules.ts
/**
* The preset both coordination roles mount (A5's reviewer and A6's supervisor):
* one persona for "a coordination node of this graph", whose whole tool surface
* is the grant passed at spawn (`keepPresetTools: false`), never the preset.
*/
const COORDINATION_PRESET = "singularity-reviewer";
/**
* The supervisor's whole tool surface. Read-only plus the two entries the
* hand-off is for: the evolution candidate chain (`propose` → `candidate` →
* `prepare` → `replay` → `gate` → `list`) and `task_recover`. Absent by
* construction, however the deployment is composed: `bash`, `write`, `edit`,
* `jobs`, `subagent`, `graph_spawn`, `hitl_*` and — deliberately —
* `evolution_decide`, `evolution_apply` and `evolution_rollback`: a promotion
* stays a person's decision and a person's apply (§F.4: supervisor 不能自批).
*/
const SUPERVISOR_BASELINE = [
	"task_recover",
	"task_review_pack",
	"task_read",
	"task_status",
	"context_read",
	"capability_list",
	"evolution_propose",
	"evolution_candidate",
	"evolution_prepare",
	"evolution_replay",
	"evolution_gate",
	"evolution_list",
	"read",
	"glob",
	"grep",
	"skill"
];
/** The capability grant one supervisor is spawned with — the same shape a reviewer's has. */
function supervisorGrant() {
	return {
		capabilities: [],
		baseline: SUPERVISOR_BASELINE,
		keepPresetTools: false
	};
}
/** The target types whose suggestion this build can take up: a same-name skill update, or one whole capability row. */
const SUPPORTED_HANDOFF_TARGETS = ["skill", "capability"];
/**
* Whether this deployment registered the evolution chain — the switch the whole
* consumption turns into one question (agent-singularity's own
* `ctx.singularityEvolution`). Read softly and read as **off** when the service is
* absent: a composition that never turned the chain on must not be assembled as
* if it had.
*/
function evolutionEnabled(ctx) {
	try {
		return ctx.get("singularityEvolution")?.enabled === true;
	} catch {
		return false;
	}
}
/** The recorded mutation surfaces this build's Evolution ledger accepts, as `evolution_propose` validates them. */
const PROPOSAL_TARGET_TYPES$1 = [
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
/**
* The target-type rule one diagnosis's suggestions have to pass before a
* coordinator is started, in the deployment's own words, or nothing when they do.
*
* Two refusals, both named and both leaving the hand-off pending: a name outside
* the recorded vocabulary (`unsupported-target`), and a recorded name this build
* cannot execute (`requires-new-authority`). A diagnosis may name several
* suggestions: the *first* one this build cannot take up decides, because a
* coordinator started for a hand-off it cannot act on would be a spawn that buys
* nothing.
*/
function handoffTargetRefusal(diagnosis) {
	for (const proposal of diagnosis.proposals) {
		const targetType = proposal.targetType;
		if (SUPPORTED_HANDOFF_TARGETS.includes(targetType)) continue;
		if (!PROPOSAL_TARGET_TYPES$1.includes(targetType)) return {
			code: "unsupported-target",
			reason: `the suggestion's target type ${JSON.stringify(targetType)} is not an execution target this build records (recorded: ${PROPOSAL_TARGET_TYPES$1.join(", ")}), so no coordinator was started for it and the Diagnosis keeps its suggestion — an unknown target is refused by name, never guessed into a candidate`
		};
		return {
			code: "requires-new-authority",
			reason: `the suggestion targets "${targetType}", and this build executes exactly two candidate surfaces — a same-name update of an existing skill object and one whole capability row with an optional new execution skill; a new tool, a verifier implementation, a permission, a preset or a runtime policy would need an authorization this harness refuses by name, so no coordinator was started and the Diagnosis keeps its suggestion`
		};
	}
}
/**
* The refusals decided before anything else is read — no suggestions at all, the
* chain being off, and a suggestion this build cannot execute — as the one
* `undefined | {code, reason}` both {@link handoffDecision} and the consumption
* entry start from.
*/
function handoffPreflight(input) {
	if (input.diagnosis.proposals.length === 0) return {
		code: "no-suggestions",
		reason: "the conclusion carries no suggestion, so there is no hand-off to take up"
	};
	if (!input.enabled) return {
		code: "evolution-off",
		reason: "the evolution chain is off in this deployment, so no coordinator exists to open a candidate for it — the Diagnosis stays a recorded hand-off, readable here and in the review pack, and turning the chain on is what takes it up"
	};
	return handoffTargetRefusal(input.diagnosis);
}
/**
* What the deployment would do with one diagnosis's hand-off right now, from the
* switch, the diagnosis, the ledger's attempts and the store's allowance. Pure.
*
* A started supervisor answers first — it is the hand-off's fact, whatever the
* allowance reads afterwards and however long ago it started; a started attempt
* whose own terminal fact is `interrupted` is not one (a spawn that failed after
* its started row was written leaves the hand-off pending, with the spend on the
* record). Then the refusals that need nothing else (no suggestions, an
* unsupported target, the chain being off), then a claim another call is starting
* right now, then the allowance.
*/
function handoffDecision(input) {
	const attempts = input.attempts.filter((attempt) => attempt.role === "supervisor" && attempt.diagnosisId === input.diagnosis.diagnosisId);
	const started = attempts.filter((attempt) => attempt.started && attempt.settlement === void 0).at(-1);
	if (started !== void 0) return {
		kind: "started",
		sessionId: started.sessionId,
		at: started.at
	};
	const preflight = handoffPreflight(input);
	if (preflight !== void 0) return {
		kind: "stopped",
		code: preflight.code,
		reason: preflight.reason
	};
	const open = attempts.find((attempt) => attempt.settlement === void 0);
	if (open !== void 0) return {
		kind: "in-flight",
		sessionId: open.sessionId
	};
	if (input.budget.used >= input.budget.max) return {
		kind: "stopped",
		code: "budget-exhausted",
		reason: `the store's coordination allowance is spent (${input.budget.used}/${input.budget.max}), and a supervisor is a run of that same allowance — nothing was started and the hand-off stays pending; a deployment raises the allowance, no count is reset`
	};
	return { kind: "start" };
}
/**
* The hand-off state as it is reported to a reader of the review pack, or nothing
* when the diagnosis carries no suggestions (a normal completion stays a
* conclusion and gets no mark). A5's build wrote this line as a hard-coded
* `pending`; here it reports what the deployment really did with the hand-off.
*/
function handoffStateLine(input) {
	if (input.diagnosis.proposals.length === 0) return void 0;
	const decision = handoffDecision(input);
	switch (decision.kind) {
		case "started": return `taken up — this hand-off is delegated to supervisor session ${decision.sessionId} (started ${decision.at}); that coordinator owns the candidate it may open, and a person still decides the promotion`;
		case "in-flight": return `being taken up right now by supervisor session ${decision.sessionId} — nothing new is started for it`;
		case "stopped": return `pending — ${decision.reason}`;
		case "start": return "pending — no supervisor is delegated to this hand-off yet; the deployment takes it up when it consumes it";
	}
}
/**
* One hand-off's content identity: what the claim promises about the diagnosis it
* was started for. A store's diagnoses are immutable per id, so a disagreement
* here means the id is being reused for something else — and that is refused by
* name rather than silently answered with the first supervisor.
*/
function supervisorHandoffDigest(storeId, diagnosis) {
	return sha256Hex(canonicalize({
		storeId,
		diagnosisId: diagnosis.diagnosisId,
		taskId: diagnosis.taskId,
		proposals: diagnosis.proposals.map((proposal) => ({
			targetType: proposal.targetType,
			targetId: proposal.targetId,
			rationale: proposal.rationale
		}))
	}));
}
/**
* The run one diagnosis is about, as its own `reviewRefs` name it
* (`<taskId>#<runId>`, or `<taskId>#no-run` for the failure that had none). A
* diagnosis that names no review of its own task leaves the run `null`: which run
* a failure is, is the store's fact, and every entry that acts on it re-checks it
* (`task-runtime/src/recovery.ts`), so nothing is guessed here.
*/
function diagnosisRunRef(diagnosis) {
	for (const ref of diagnosis.reviewRefs) {
		const separator = ref.lastIndexOf("#");
		if (separator < 0) continue;
		if (ref.slice(0, separator) !== diagnosis.taskId) continue;
		const runId = ref.slice(separator + 1);
		return runId === "no-run" ? null : runId;
	}
	return null;
}
/** The hand-off's source: the task and run the Diagnosis is about — the delegation's own fields. */
function handoffSourceOf(diagnosis) {
	return {
		taskId: diagnosis.taskId,
		runId: diagnosisRunRef(diagnosis)
	};
}
/** The ref a reader uses for one source (`<taskId>#<runId>`, or `<taskId>#no-run`). */
function handoffSourceRef(source) {
	return `${source.taskId}#${source.runId ?? "no-run"}`;
}
/**
* The supervisor's first request: which hand-off it is taking up, what the source
* really is, and what it is expected to do with it.
*
* Everything in it is a fact read from the store or the diagnosis, never a
* permission: the coordinator's authority is its grant and its ledger row, and
* this text only tells it what it was delegated.
*/
function supervisorPrompt(input) {
	const { diagnosis } = input;
	return [
		"You are the Singularity supervisor: the coordination agent a recorded Diagnosis was handed to. You do not run the goal, and you do not decide promotions — a person does.",
		`The hand-off is diagnosis ${diagnosis.diagnosisId} about task ${diagnosis.taskId} (source ${input.sourceRef}, whose review settled ${input.sourceOutcome}).`,
		`Its recorded observation: ${diagnosis.observedFailure}`,
		`Its recorded conclusion: ${diagnosis.localizedCause}`,
		"Its recorded suggestions:",
		...diagnosis.proposals.map((proposal) => `- ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`),
		"",
		"Your job, in this order:",
		"1. Read the facts yourself: task_review_pack for the exact source, task_read/task_status for the task and its siblings, context_read for the sessions and evidence the pack cites.",
		"2. Decide what kind of gap this is. A capability or skill gap is closed by a candidate: evolution_propose (when no proposal names it yet), then evolution_candidate — ONE whole capability row plus an optional new execution skill, or a same-name update of an existing skill — evolution_prepare, evolution_replay for the two-sided experiment, and evolution_gate. A person decides and applies; you never call evolution_decide, evolution_apply or evolution_rollback, for yourself or for anyone.",
		`3. A pure artifact gap — a product that was never produced — needs no proposal and no approval: it needs a new attempt at the failed goal. Once the capability a recovery depends on is in the applied table, call task_recover with { sourceDiagnosisId: "${diagnosis.diagnosisId}", requestKey: "<a key of yours>" } and the runtime opens one new root run, judged by the original acceptance criteria. One key names one attempt, and a repeat of the same key returns that attempt instead of starting another.`,
		"4. Not every suggestion is executable: a successful source is not recoverable, and a target type this build has no candidate for stays a recorded suggestion. Say what stopped you in your own words — nothing you write changes production, and no candidate executes anything by itself.",
		"",
		"You have no shell, no file write and no spawn, and no tool outside the list you were granted."
	].join("\n");
}

//#endregion
//#region src/evolution-handoff.ts
/**
* The graph's root session and its live agent for one root store, or `undefined`
* when this process does not hold the root live. The store is **placed** through
* the registry (`graphs.list()` and each graph's own root session), never derived
* from the id's text: a store no graph owns is one this deployment must not spawn
* a coordinator for.
*/
async function handoffDelegatorOf(ctx, storeId) {
	const graphs = optionalService(ctx, "graphs");
	const registry = optionalService(ctx, "agents");
	let rootSessionId;
	try {
		for (const graph of await graphs?.list() ?? []) {
			const candidate = String(graph.rootSessionId);
			if (rootTaskStoreId(candidate) === storeId) {
				rootSessionId = candidate;
				break;
			}
		}
	} catch {
		return;
	}
	if (rootSessionId === void 0) return void 0;
	const agent = registry?.get(rootSessionId);
	return agent === void 0 ? void 0 : {
		sessionId: rootSessionId,
		agent
	};
}
/**
* Consume one hand-off: decide (switch, suggestions, allowance), and — when
* nothing stands in the way — spawn its supervisor, under the same admission
* region and the same ledger a review attempt uses.
*
* The order inside the region is A5's own: decide, claim (durable before any
* handle exists), spawn with the started row written by `beforePrompt` — so the
* delegation is durable *and read back* before the coordinator's first model
* input, and a store's second consumption cannot slip a claim in between the read
* and the write. Nothing here waits for the coordinator: its started row is the
* hand-off's terminal fact, so the call answers as soon as the session exists.
*/
async function startSupervisorHandoff(ctx, input) {
	const { storeId, diagnosis, delegator } = input;
	const preflight = handoffPreflight({
		enabled: evolutionEnabled(ctx),
		diagnosis
	});
	if (preflight !== void 0) return {
		diagnosisId: diagnosis.diagnosisId,
		result: "stopped",
		code: preflight.code,
		reason: preflight.reason
	};
	const source = handoffSourceOf(diagnosis);
	const supervisorSessionId = SessionId(randomUUID());
	const request = {
		role: "supervisor",
		source,
		requestKey: null,
		reason: null,
		diagnosisId: diagnosis.diagnosisId,
		handoffDigest: supervisorHandoffDigest(storeId, diagnosis),
		actor: delegator.sessionId,
		sessionId: supervisorSessionId
	};
	return await admitReviewAgent(storeId, async (admission) => {
		const { plan } = await admission.plan(request);
		if (plan.kind === "refused") {
			const reason = plan.code === "budget-exhausted" ? `the store's coordination allowance is spent (${plan.budget.used}/${plan.budget.max}) — nothing was started and the hand-off stays pending` : `diagnosis ${diagnosis.diagnosisId} already has a supervisor claim with another hand-off content (session ${plan.attempt?.sessionId ?? "unknown"}); one diagnosis is not two hand-offs, so nothing was started`;
			const code = plan.code === "budget-exhausted" ? "budget-exhausted" : "handoff-conflict";
			return {
				diagnosisId: diagnosis.diagnosisId,
				result: "stopped",
				code,
				reason
			};
		}
		if (plan.kind === "reuse") return {
			diagnosisId: diagnosis.diagnosisId,
			result: "existing",
			sessionId: plan.attempt.sessionId
		};
		if (plan.kind === "in-flight") return {
			diagnosisId: diagnosis.diagnosisId,
			result: "in-flight",
			sessionId: plan.attempt.sessionId
		};
		await admission.claim(request);
		const prompt = supervisorPrompt({
			diagnosis,
			sourceOutcome: input.sourceOutcome,
			sourceRef: input.sourceRef
		});
		let spawnFailure;
		if (await ctx.agentRuntime.spawn(delegator.agent, {
			sessionId: supervisorSessionId,
			name: `supervisor for ${diagnosis.diagnosisId}`,
			prompt: [{
				type: "text",
				text: prompt
			}],
			agentPreset: input.agentPreset ?? COORDINATION_PRESET,
			grant: supervisorGrant(),
			beforePrompt: async () => {
				await admission.start({
					taskId: source.taskId,
					sessionId: supervisorSessionId,
					actor: delegator.sessionId
				});
				const back = await readReviewerDelegation(supervisorSessionId);
				if (back === void 0 || back.rootStoreId !== storeId || back.taskId !== source.taskId) throw new Error(`evolution hand-off: the delegation of supervisor session "${supervisorSessionId}" could not be read back from the ledger (expected task ${source.taskId} in ${storeId}); no model input was sent`);
			},
			...input.signal === void 0 ? {} : { signal: input.signal }
		}).catch((error) => {
			spawnFailure = error instanceof Error ? error.message : String(error);
		}) === void 0) {
			await settleReviewAgentAttempt({
				rootStoreId: storeId,
				taskId: source.taskId,
				sessionId: supervisorSessionId,
				status: "interrupted",
				note: `the supervisor could not be spawned: ${spawnFailure ?? "unknown error"}`
			}).catch(() => void 0);
			return {
				diagnosisId: diagnosis.diagnosisId,
				result: "failed",
				reason: spawnFailure ?? "unknown error"
			};
		}
		return {
			diagnosisId: diagnosis.diagnosisId,
			result: "started",
			sessionId: supervisorSessionId
		};
	});
}
/**
* Every pending hand-off of one store, consumed in the order the diagnoses were
* written. A diagnosis that carries suggestions is a hand-off; a conclusion
* without suggestions is not touched.
*
* Never throws for the work it does: a store it cannot read, a hand-off it cannot
* start and a spawn that failed all come back as entries (and as log lines when a
* `log` is given), because every caller of this scan is a trigger — a recorded
* diagnosis, an activation — that must not take a store down with a coordinator.
*/
async function consumePendingHandoffs(ctx, storeId, options = {}) {
	const { log } = options;
	let snapshot;
	try {
		snapshot = await ctx.task.snapshotIn(storeId);
	} catch (error) {
		const skipped = `the store could not be read (${error instanceof Error ? error.message : String(error)}); no hand-off was consumed`;
		log?.(`evolution hand-off: store ${storeId} — ${skipped}`);
		return {
			storeId,
			consumptions: [],
			skipped
		};
	}
	const pending = snapshot.diagnoses.filter((diagnosis) => diagnosis.proposals.length > 0);
	if (pending.length === 0) return {
		storeId,
		consumptions: []
	};
	const delegator = await handoffDelegatorOf(ctx, storeId);
	if (delegator === void 0) {
		const skipped = "the graph's root session for this store is not live, so no supervisor could be started";
		for (const diagnosis of pending) log?.(`evolution hand-off: ${diagnosis.diagnosisId} pending — ${skipped}`);
		return {
			storeId,
			skipped,
			consumptions: pending.map((diagnosis) => ({
				diagnosisId: diagnosis.diagnosisId,
				result: "stopped",
				code: "evolution-off",
				reason: skipped
			}))
		};
	}
	const consumptions = [];
	for (const diagnosis of pending) {
		const source = handoffSourceOf(diagnosis);
		const review = snapshot.reviews.find((item) => item.taskId === source.taskId && (item.runId ?? null) === source.runId);
		let consumption;
		try {
			consumption = await startSupervisorHandoff(ctx, {
				storeId,
				diagnosis,
				delegator,
				sourceRef: handoffSourceRef(source),
				sourceOutcome: review?.outcome ?? "no review record"
			});
		} catch (error) {
			consumption = {
				diagnosisId: diagnosis.diagnosisId,
				result: "failed",
				reason: error instanceof Error ? error.message : String(error)
			};
		}
		consumptions.push(consumption);
		log?.(`evolution hand-off: ${renderConsumption(consumption)}`);
	}
	return {
		storeId,
		consumptions
	};
}
/**
* Consume one store's hand-off for one diagnosis, if it is pending — the moment
* the reviewer that recorded it is the caller (the record just became durable,
* and no event exists for a store's diagnosis). The store is read here rather
* than trusted from the caller: a diagnosis the store does not hold is reported
* by name and nothing is started.
*/
async function consumeHandoffDiagnosis(ctx, storeId, diagnosisId, options = {}) {
	let snapshot;
	try {
		snapshot = await ctx.task.snapshotIn(storeId);
	} catch (error) {
		options.log?.(`evolution hand-off: store ${storeId} could not be read (${error instanceof Error ? error.message : String(error)})`);
		return;
	}
	const diagnosis = snapshot.diagnoses.find((item) => item.diagnosisId === diagnosisId);
	if (diagnosis === void 0) {
		options.log?.(`evolution hand-off: store ${storeId} holds no diagnosis "${diagnosisId}"; nothing was started`);
		return;
	}
	const delegator = await handoffDelegatorOf(ctx, storeId);
	if (delegator === void 0) {
		options.log?.(`evolution hand-off: ${diagnosisId} pending — the graph's root session is not live, so no supervisor was started`);
		return;
	}
	const source = handoffSourceOf(diagnosis);
	const review = snapshot.reviews.find((item) => item.taskId === source.taskId && (item.runId ?? null) === source.runId);
	const consumption = await startSupervisorHandoff(ctx, {
		storeId,
		diagnosis,
		delegator,
		sourceRef: handoffSourceRef(source),
		sourceOutcome: review?.outcome ?? "no review record"
	});
	options.log?.(`evolution hand-off: ${renderConsumption(consumption)}`);
	return consumption;
}
/** One consumption as a scan line, naming the session or the reason — never a credential and never a path. */
function renderConsumption(consumption) {
	switch (consumption.result) {
		case "started": return `diagnosis ${consumption.diagnosisId} — supervisor session ${consumption.sessionId} started`;
		case "existing": return `diagnosis ${consumption.diagnosisId} — already delegated to supervisor session ${consumption.sessionId}; nothing started`;
		case "in-flight": return `diagnosis ${consumption.diagnosisId} — supervisor session ${consumption.sessionId} is being started right now; nothing started`;
		case "stopped": return `diagnosis ${consumption.diagnosisId} pending (${consumption.code}) — ${consumption.reason}`;
		case "failed": return `diagnosis ${consumption.diagnosisId} — the supervisor could not be started: ${consumption.reason}`;
	}
}
/** The warning channel the plugin has, when the deployment mounted a logger. */
function softWarn$1(ctx) {
	const logger = ctx.logger;
	return (line) => logger?.("singularity-agent").warn(line);
}
/**
* Install the hand-off trigger of this deployment: a graph that is explicitly
* activated scans its store for pending hand-offs — what a process that booted
* over a store with a pending hand-off does, and what a repeat consumption after
* a restart answers from the ledger. The other moment — a diagnosis with
* suggestions becoming durable — is reported by the attempt that recorded it
* (`review-agent-run.ts`): no event exists for a store's diagnosis record, and the
* run that wrote it is the only place that knows.
*
* The listener does its work off the caller's path: it starts the scan and
* returns immediately, and a scan that fails is reported on the log rather than
* thrown into the activation that woke it.
* @returns a disposer that removes the listener.
*/
function installSupervisorHandoffTrigger(ctx, options = {}) {
	const log = options.log ?? softWarn$1(ctx);
	const background = (work) => {
		work().catch((error) => {
			log(`evolution hand-off: the scan could not run (${error instanceof Error ? error.message : String(error)})`);
		});
	};
	const dispose = ctx.on("graphs/selected", (graph) => {
		background(async () => await consumePendingHandoffs(ctx, rootTaskStoreId(graph.rootSessionId), { log }));
	});
	return () => dispose();
}

//#endregion
//#region src/tools/task-review-pack.ts
const text$31 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$21(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_review_pack: missing agent id");
	return id;
}
/** The ref a diagnosis uses in `reviewRefs` to name one review record, and a pack uses to name its source. */
function reviewRef(review) {
	return `${review.taskId}#${review.runId ?? "no-run"}`;
}
/**
* The review record of one exact source, or nothing when the store holds none.
* The source is named, never inferred: a review is of the run it recorded, and
* a task with several runs has several reviews.
*/
function reviewForSource(snapshot, source) {
	return snapshot.reviews.find((review) => review.taskId === source.taskId && (review.runId ?? null) === source.runId);
}
/** The task's most recent review, or nothing when it never settled one (a summary of a neighbour, never a source). */
function latestReview$1(snapshot, taskId) {
	return [...snapshot.reviews].reverse().find((item) => item.taskId === taskId);
}
/**
* The ledger state of one source: every **review** attempt the store holds for
* it, in the order they were claimed — the default attempt (`null` key) and each
* explicit one — with how each ended. This is what a reader checks before asking
* for a review: an attempt that is still open is the one a new call would return
* instead of starting another, and a new review of an already-reviewed source
* needs an explicit `requestKey`.
*
* Supervisor rows carry a source too (the hand-off's), so they are filtered out
* here: they are not review attempts of this source, and what a reader of a pack
* learns about a hand-off comes from the diagnosis line below.
*/
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
function reviewSummary(snapshot, taskId) {
	const review = latestReview$1(snapshot, taskId);
	if (review === void 0) return "no review";
	const detail = review.localizedCause ?? review.anomalies[0];
	return `review ${reviewRef(review)}: ${review.outcome}${detail === void 0 ? "" : ` — ${detail}`}`;
}
/**
* The effort line: one clause per counter that exists, and nothing for the ones
* that do not — an absent field means "not observed" (see `ReviewMetrics`), so
* printing 0 for it would invent a measurement. The two counters whose scope is
* easy to misread (`tokens`, `humanInterventions`) and the one that is
* structurally constant (`retries`) carry their caveat inline.
*/
function renderMetrics(metrics) {
	const parts = [];
	if (metrics.tokens !== void 0) parts.push(`tokens in ${metrics.tokens.uncachedInputTokens}/out ${metrics.tokens.outputTokens}/cache ${metrics.tokens.cacheReadTokens}+${metrics.tokens.cacheWriteTokens} (session-cumulative)`);
	if (metrics.toolCalls !== void 0) parts.push(`toolCalls ${metrics.toolCalls.calls} (${metrics.toolCalls.failures} failed)`);
	if (metrics.humanInterventions !== void 0) parts.push(`humanInterventions ${metrics.humanInterventions} (session-scoped)`);
	if (metrics.retries !== void 0) parts.push(`retries ${metrics.retries} (no retry branch exists yet; always 0)`);
	if (metrics.evidenceLogs !== void 0) parts.push(`evidenceLogs ${metrics.evidenceLogs}`);
	return parts.join(" — ");
}
/**
* One line per dimension that the record actually carries: the observed facts,
* copied out, never rated and never narrated. Anything a dimension omits is
* omitted here too, so the pack stays a fact sheet — the explanation lives in
* the diagnoses below it.
*/
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
		const loaded = skill.loaded === void 0 || skill.loadedOutsideGrant === void 0 ? "" : `, loaded [${skill.loaded.join(", ")}], outside grant [${skill.loadedOutsideGrant.join(", ")}]`;
		lines.push(`  dim skill fit: granted [${skill.granted.join(", ")}]${loaded}`);
	}
	const tools = dimensions.toolFit;
	if (tools !== void 0) {
		const called = tools.called === void 0 || tools.calledOutsideGrant === void 0 ? "" : `, called [${tools.called.map((item) => `${item.name} x${item.count}`).join(", ")}], outside grant [${tools.calledOutsideGrant.join(", ")}]`;
		lines.push(`  dim tool fit: granted [${tools.granted.join(", ")}]${called}`);
	}
	const context = dimensions.contextEfficiency;
	if (context !== void 0) {
		const tokens = context.tokens === void 0 ? "" : ` tokens in/out ${context.tokens.uncachedInputTokens}/${context.tokens.outputTokens}`;
		const compactions = context.compactions === void 0 ? "" : ` compactions ${context.compactions}`;
		lines.push(`  dim context efficiency:${tokens}${compactions}`);
	}
	return lines;
}
/**
* One review line, with the session id a reader drills into. Printing it here
* is what lets a diagnosis point `session_trace` at the session the review came
* from without a second lookup (§2.7.5).
*/
function renderReview(review) {
	const duration = review.durationMs === void 0 ? "" : ` duration ${review.durationMs}ms`;
	const session = review.sessionId === void 0 ? "" : ` session ${review.sessionId}`;
	const lines = [`- review ${reviewRef(review)} [${review.outcome}]${duration} evidence: [${review.evidenceRefs.join(", ")}]${session}`];
	if (review.localizedCause !== void 0) lines.push(`  cause: ${review.localizedCause}`);
	for (const anomaly of review.anomalies) lines.push(`  anomaly: ${anomaly}`);
	for (const criterion of review.criteria ?? []) {
		const judge = criterion.verifierId === void 0 ? "" : criterion.verifierVersion === void 0 ? ` [${criterion.verifierId}]` : ` [${criterion.verifierId}@${criterion.verifierVersion}]`;
		const command = criterion.command === void 0 ? "" : ` — $ ${criterion.command}`;
		const exit = criterion.exitCode === void 0 ? "" : ` exit ${criterion.exitCode}`;
		const log = criterion.logRef === void 0 ? "" : ` log ${criterion.logRef}`;
		lines.push(`  criterion ${criterion.criterionId}: ${criterion.verdict}${judge}${exit}${command}${log}`);
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
/**
* How far one diagnosis's suggestions have been taken up (A5 §3, plan F.4): a
* diagnosis that carries **proposals** is the A6 hand-off, and this line reports
* what the deployment really did with it — the supervisor it was delegated to,
* the coordinator being started right now, or the named reason nothing was opened
* (the evolution chain off, a suggestion this build has no executor for, the
* store's allowance spent, or nothing having asked yet).
*
* The answer is `handoffStateLine` (over `handoffDecision`) — the very function
* the consumption entry acts on — so the pack cannot drift from what a consumer
* would do. A conclusion
* *without* proposals is not a hand-off and gets no mark (a normal completion
* stays a conclusion), and an interrupted attempt has no diagnosis at all, so it
* can never reach this line.
*/
function handoffMark(diagnosis, handoff) {
	return handoffStateLine({
		enabled: handoff.enabled,
		diagnosis,
		attempts: handoff.attempts,
		budget: handoff.budget
	});
}
function renderDiagnosis(diagnosis, handoff) {
	const producer = diagnosis.producedBy === void 0 ? "" : diagnosis.producedBy.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? ` [agent ${diagnosis.producedBy.sessionId}]` : ` [${diagnosis.producedBy.kind}]`;
	const lines = [`- ${diagnosis.diagnosisId} [${diagnosis.confidence}] ${diagnosis.localizedCause}${producer}`];
	if (diagnosis.judgements !== void 0 && diagnosis.judgements.length > 0) {
		const header = diagnosis.producedBy?.kind === "agent" && diagnosis.producedBy.sessionId !== void 0 ? `judgements (agent ${diagnosis.producedBy.sessionId})` : "judgements";
		lines.push(`  ${header}:`);
		for (const judgement of diagnosis.judgements) lines.push(`    ${judgement.dimension}: ${judgement.verdict} — ${judgement.rationale} refs [${judgement.evidenceRefs.join(", ")}]`);
	}
	for (const proposal of diagnosis.proposals) lines.push(`  proposal ${proposal.targetType} ${proposal.targetId}: ${proposal.rationale}`);
	const handoffText = handoffMark(diagnosis, handoff);
	if (handoffText !== void 0) lines.push(`  handoff: ${handoffText}`);
	return lines;
}
/**
* What each of the task's runs was bound to and loaded (S1-C item 4): one line
* per run that recorded a binding, naming the registry revision, the providers
* (skill, role, short content digest) and the granted MCP servers. This is what
* makes "which version did this execution run against?" answerable from the
* pack, next to the run ids the reviews above already cite.
*
* The pack reports the record; it does not re-read the snapshots. It is the
* facts sheet a reviewer starts from, and the bytes are re-checked by the
* entries that act on them (`task_read`, a run re-entry) — a line here says what
* the run was bound to, never that the content is still on disk. A run that
* carries no binding (one written before the field existed, or one whose caller
* assembled its plan without a pre-check) contributes no line, and nothing is
* invented for it.
*/
function renderBindings(snapshot, taskId) {
	const lines = [];
	for (const run of snapshot.runs.filter((item) => item.taskId === taskId)) {
		const binding = run.providerBinding;
		if (binding === void 0) continue;
		const skills = binding.skills.length === 0 ? "no provider skill" : binding.skills.map((skill) => `${skill.name} [${skill.role}] content ${skill.contentDigest.slice(0, 12)}${skill.contractDigest === null ? "" : ` contract ${skill.contractDigest.slice(0, 12)}`}`).join("; ");
		const servers = binding.mcpServers.length === 0 ? "" : `; mcp ${binding.mcpServers.map((server) => server.serverName).join(", ")}`;
		const snapshotRoot = binding.snapshotRoot === void 0 ? "" : `; snapshot ${binding.snapshotRoot}`;
		lines.push(`- run ${run.runId} [${run.status}] bound registry ${binding.registryRevision.slice(0, 12)}: ${skills}${servers}${snapshotRoot}`);
	}
	return lines;
}
/**
* The pack for one source of one task: the source itself first, then the facts
* (reviews, dependency edges, parent/child summaries), the ledger state of that
* source, the judgement dimensions the facts cannot settle, and the diagnoses
* that explain them.
*
* No trigger decision is printed (A5): whether a review agent runs is decided by
* the two triggers — a **failed** review, or an explicit call — under the
* store's own allowance, and the fact table a pack carries says nothing about
* either beyond the observations it already prints (the outcome, the criteria,
* the log tail, the capability coverage). A reader that needs the allowance
* gets it from the attempt list and from `task_review_agent`'s own refusal.
* @throws when the source's task is not in the snapshot.
*/
function buildReviewPack(input) {
	const { snapshot, source, attempts, handoff } = input;
	const { taskId } = source;
	const task = snapshot.tasks.find((item) => item.taskId === taskId);
	if (task === void 0) throw new Error(`task_review_pack: unknown task "${taskId}"`);
	const review = reviewForSource(snapshot, source);
	const reviews = snapshot.reviews.filter((item) => item.taskId === task.taskId);
	const parent = task.parentTaskId === void 0 ? void 0 : snapshot.tasks.find((item) => item.taskId === task.parentTaskId);
	const incoming = snapshot.edges.filter((edge) => edge.to === task.taskId).map((edge) => edge.from);
	const outgoing = snapshot.edges.filter((edge) => edge.from === task.taskId).map((edge) => edge.to);
	const diagnoses = snapshot.diagnoses.filter((item) => item.taskId === task.taskId);
	const lines = [
		`review pack for task ${task.taskId} [${task.status}] depth ${task.depth}`,
		`source: review ${reviewRef(source)}${review === void 0 ? " (not on the record)" : ` [${review.outcome}]`}`,
		`objective: ${task.objective}`,
		`dependencies: must verify first [${incoming.join(", ")}]; blocks [${outgoing.join(", ")}]`,
		...renderAttempts(attempts, source),
		renderJudgementDimensions(),
		`reviews (${reviews.length}):`,
		...reviews.flatMap(renderReview),
		...renderBindings(snapshot, task.taskId)
	];
	if (parent !== void 0) lines.push(`parent ${parent.taskId} [${parent.status}]: ${reviewSummary(snapshot, parent.taskId)}`);
	lines.push(`children (${task.childTaskIds.length}):`);
	for (const childId of task.childTaskIds) {
		const child = snapshot.tasks.find((item) => item.taskId === childId);
		if (child === void 0) continue;
		lines.push(`- ${child.taskId} [${child.status}]: ${reviewSummary(snapshot, child.taskId)}`);
	}
	lines.push(`diagnoses (${diagnoses.length}):`);
	for (const diagnosis of diagnoses) lines.push(...renderDiagnosis(diagnosis, handoff));
	return lines.join("\n");
}
function defineTaskReviewPackTool(ctx) {
	return defineTool({
		name: "task_review_pack",
		description: "Read-only. Assemble the diagnosis input pack for ONE exact review source — a task and the run under review, or runId null for a review that carries no run (a task blocked before it started). The pack names the task itself, all its review records in full (criteria, log tail, blockers, the session each review came from), the review attempts the ledger holds for this source and how each ended, the dimensions whose conclusion the fact table does not carry, one-line review summaries of its children and parent, the dependency edges touching it, and its diagnoses with any agent judgements — each diagnosis that carries suggestions marked with its hand-off state (the supervisor it was delegated to, the coordinator being started, or the named reason nothing was opened: the chain off, an unsupported target, or the allowance spent). It reports the facts only: whether a review agent runs is decided elsewhere (a failed review is accepted on its own; an explicit call names its source). Local evidence plus parent/children summaries — no ancestry replay (guide §2.7.5). Feed this to task_diagnose, or to task_review_agent when a judgement is needed.",
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
			render: (_a, v) => text$31(v)
		},
		execute: async (args, exec) => {
			const storeId = rootTaskStoreId((await ctx.graphs.graphForSession(sessionId$21(exec))).rootSessionId);
			const source = {
				taskId: args.taskId,
				runId: args.runId
			};
			const snapshot = await ctx.task.openStore(storeId);
			if (!snapshot.tasks.some((task) => task.taskId === args.taskId)) throw new Error(`task_review_pack: unknown task "${args.taskId}" in store ${storeId}`);
			if (args.runId !== null && !snapshot.runs.some((run) => run.runId === args.runId && run.taskId === args.taskId)) return `task_review_pack: run "${args.runId}" is not a run of task "${args.taskId}"; nothing to pack`;
			if (reviewForSource(snapshot, source) === void 0) return `task_review_pack: no review record for source ${reviewRef(source)} in store ${storeId}; nothing to pack`;
			const attempts = await readReviewAgentAttempts(storeId);
			return buildReviewPack({
				snapshot,
				source,
				attempts,
				handoff: {
					enabled: evolutionEnabled(ctx),
					attempts,
					budget: {
						used: await countReviewAgentRuns(storeId),
						max: reviewAgentBudget()
					}
				}
			});
		}
	});
}

//#endregion
//#region src/review-agent-run.ts
/** The preset the review agent mounts (`$DSH_HOME/.agent-presets/singularity-reviewer/`). */
const REVIEWER_PRESET = "singularity-reviewer";
/**
* The review agent's whole tool surface. Read-only by construction: the grant
* allow-list is this list intersected with what the composition offers, so
* `bash`, `write`, `edit`, `jobs`, `subagent`, `graph_spawn`, `hitl_*` and
* `evolution_*` are absent however the deployment is composed. Session history
* is read with `context_read` — the one reference reader, authorized by the
* reviewer's delegated graph domain; the raw cross-session tools it replaced
* are sealed on every runtime-owned agent (`agent-runtime`'s execution guard).
*/
const REVIEWER_BASELINE = [
	"task_review_pack",
	"task_read",
	"task_status",
	"context_read",
	"capability_list",
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
/** Default watchdog deadline for one review agent (10 minutes). */
const REVIEW_AGENT_TIMEOUT_MS = 6e5;
/** The source one attempt reviews, as a ref a reader reads back (`t1#r1`, `t2#no-run`). */
function sourceRef(source) {
	return reviewRef({
		taskId: source.taskId,
		runId: source.runId
	});
}
/** The last top-level brace-balanced object in the text, if any (fallback when no fence parses). */
function lastBalancedObject(source) {
	let depth = 0;
	let start = -1;
	let last;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") {
			if (depth === 0) start = index;
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0 && start >= 0) last = source.slice(start, index + 1);
		}
	}
	return last;
}
/**
* The parsed reply object out of the reviewer's answer: the last fenced block
* wins, then the last balanced object. A reply with neither parses as nothing.
*/
function parseReviewerObject(reply) {
	if (reply === void 0) return void 0;
	const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]);
	const candidates = [fenced[fenced.length - 1], lastBalancedObject(reply)].filter((value) => value !== void 0);
	for (const candidate of candidates) try {
		const parsed = JSON.parse(candidate);
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {}
}
/** A non-empty string out of the reply, or nothing. */
function textOf(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
/**
* Validate the judgements the reviewer chose to make. Each one has to name a
* judged dimension and a verdict from the fixed vocabulary, cite at least one
* non-empty ref and carry a rationale — this is the store's own rule, checked
* here so the attempt fails by name instead of being refused later. A verdict
* outside the vocabulary is **not** softened into `unknown`: a conclusion the
* reviewer never made is not one this module may write down.
*/
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
/**
* The diagnosis the reviewer's reply carries, or a named reason it carries
* none. What is required is what a Diagnosis is: the **observation** (the
* persisted `observedFailure` slot, read as the postmortem observation — a
* successful postmortem fills in what really happened, never an invented
* failure), the **conclusion** in the reviewer's own words, and a confidence.
* What is optional is what a conclusion need not carry: judgements (only the
* dimensions the reviewer can settle) and proposals (an empty list is the
* normal answer for "no improvement needed").
*/
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
		return {
			ok: true,
			diagnosis: {
				observation,
				conclusion,
				confidence,
				judgements: judgementsOf(parsed.judgements),
				proposals: proposalsOf(parsed.proposals)
			}
		};
	} catch (error) {
		return {
			ok: false,
			refusal: `the reply's judgements or proposals are malformed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
/** The judged dimensions rendered as report lines (agent judgements, kept apart from the fact lines). */
function renderJudgements(judgements) {
	return judgements.map((item) => `  ${item.dimension}: ${item.verdict} — ${item.rationale} refs [${item.evidenceRefs.join(", ")}]`);
}
function lastAssistantText(events) {
	const event = [...events].reverse().find((item) => item.type === "assistant/message");
	if (event === void 0) return void 0;
	const content = ((event.data?.message)?.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
	return content.length === 0 ? void 0 : content;
}
/** The diagnosis one attempt recorded, as the store holds it (the id is the attempt's session). */
function recordedDiagnosis(snapshot, sessionId$22) {
	return snapshot.diagnoses.find((diagnosis) => diagnosis.diagnosisId === `review-agent-${sessionId$22}`);
}
/**
* Run one review attempt for one source: the admission's serial region (plan,
* claim, spawn) and then, outside it, the reviewer's own time — its watchdog,
* its reply, the diagnosis it carries and the one terminal fact.
*
* Waiting for the reviewer never runs inside the region: only the decision, the
* claim and the spawn do, so the claim is durable before any handle exists and a
* second admission for the same store cannot slip a claim in between the read
* and the write. The caller's caller (a tool call, a scan) is free to do
* anything else while the reviewer works.
*/
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
	const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : REVIEW_AGENT_TIMEOUT_MS;
	const outcome = await admitReviewAgent(storeId, async (admission) => {
		const current = await ctx.task.snapshotIn(storeId);
		const { plan, recovered } = await admission.plan(request, { recorded: (attempt) => recordedDiagnosis(current, attempt.sessionId) !== void 0 });
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
		await admission.claim(request);
		const attempts = await readReviewAgentAttempts(storeId);
		const pack = buildReviewPack({
			snapshot: current,
			source,
			attempts,
			handoff: {
				enabled: evolutionEnabled(ctx),
				attempts,
				budget: {
					used: await countReviewAgentRuns(storeId),
					max: reviewAgentBudget()
				}
			}
		});
		const prompt = [
			"You are a Singularity review agent. Explain the review source below: what happened, why, and what — if anything — should change.",
			"Read what you are authorized to read: the pack below, and beyond it whatever settles the question — task_read, task_status and context_read reach the sibling tasks, their sessions and their evidence. Cite what you rest on.",
			"Do not score, and do not modify anything.",
			"Return EXACTLY one fenced json block, no prose around it:",
			"```json",
			"{\"observation\":\"...\",\"conclusion\":\"...\",\"confidence\":\"high|medium|low\",\"judgements\":[{\"dimension\":\"...\",\"verdict\":\"adequate|inadequate|unknown\",\"evidenceRefs\":[\"...\"],\"rationale\":\"...\"}],\"proposals\":[{\"targetType\":\"...\",\"targetId\":\"...\",\"rationale\":\"...\"}]}",
			"```",
			"- observation (required): the postmortem observation (复盘观察) — what was actually observed in the source, whether it failed or succeeded.",
			"- conclusion (required): the explanation in your own words. \"no improvement needed\" and \"the evidence does not settle this\" are legitimate conclusions.",
			"- confidence (required): high, medium or low.",
			"- judgements (optional): only the dimensions you can settle from the evidence, each citing the refs it rests on. Omit the ones you cannot settle; never pad them with \"unknown\".",
			`  The dimensions no parser settles: ${JUDGED_DIMENSIONS.join(", ")}.`,
			"- proposals (optional): suggestions only, each grounded in the evidence. An empty list is a normal answer, and nothing here executes by itself.",
			"A reply without an observation, a conclusion or a confidence is not a diagnosis: the attempt is recorded interrupted and nothing is stored.",
			"",
			`--- source under review ---`,
			`review ${sourceRef(source)} [${review.outcome}]${request.reason === null ? "" : ` — focus: ${request.reason}`}`,
			"",
			"--- review pack ---",
			pack
		].join("\n");
		let spawnFailure;
		const handle$1 = await ctx.agentRuntime.spawn(parent, {
			sessionId: reviewerSessionId,
			name: `review ${source.taskId}`,
			prompt: [{
				type: "text",
				text: prompt
			}],
			agentPreset: REVIEWER_PRESET,
			grant: reviewerGrant(),
			beforePrompt: async () => {
				await admission.start({
					taskId: source.taskId,
					sessionId: reviewerSessionId,
					actor
				});
				const back = await readReviewerDelegation(reviewerSessionId);
				if (back === void 0 || back.rootStoreId !== storeId || back.taskId !== source.taskId) throw new Error(`task_review_agent: the delegation of reviewer session "${reviewerSessionId}" could not be read back from the ledger (expected task ${source.taskId} in ${storeId}); no model input was sent`);
			},
			signal: input.signal
		}).catch((error) => {
			spawnFailure = error instanceof Error ? error.message : String(error);
		});
		if (handle$1 === void 0) {
			await settleReviewAgentAttempt({
				rootStoreId: storeId,
				taskId: source.taskId,
				sessionId: reviewerSessionId,
				status: "interrupted",
				note: `spawn failed: ${spawnFailure ?? "unknown error"}`
			}).catch(() => void 0);
			return {
				kind: "spawn-failed",
				failure: spawnFailure ?? "unknown error",
				sessionId: reviewerSessionId
			};
		}
		return {
			kind: "spawned",
			handle: handle$1
		};
	});
	if (outcome.kind === "refused" || outcome.kind === "reuse" || outcome.kind === "in-flight" || outcome.kind === "spawn-failed") return outcome;
	const { handle } = outcome;
	/**
	* The one exit an attempt has: every path that ends this execution records
	* its terminal fact, so no failure of this entry leaves the source looking
	* in flight forever. A ledger that cannot take the fact is best-effort
	* here — an attempt that recorded its diagnosis is found again by the
	* store's own record of it.
	*/
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
	let timer;
	try {
		let timedOut = false;
		const deadline = new Promise((resolve$1) => {
			timer = setTimeout(() => {
				timedOut = true;
				resolve$1("timeout");
			}, timeoutMs);
		});
		const idle = handle.agent.whenIdle().then(() => "idle").catch(() => "failed");
		const reviewOutcome = await Promise.race([idle, deadline]);
		if (timer !== void 0) clearTimeout(timer);
		input.signal?.removeEventListener("abort", cancel);
		if (reviewOutcome === "timeout") handle.agent.cancel({ kind: "parent" });
		const cancelled = input.signal?.aborted === true;
		const reply = timedOut ? void 0 : lastAssistantText(handle.agent.session.snapshotEvents());
		const parsed = timedOut || cancelled ? {
			ok: false,
			refusal: timedOut ? `the reviewer timed out after ${timeoutMs}ms with no diagnosis` : "the attempt was cancelled before the reviewer produced a diagnosis"
		} : parseReviewerDiagnosis(reply);
		if (!parsed.ok) {
			await settleAttempt("interrupted", parsed.refusal);
			return {
				kind: "no-diagnosis",
				sessionId: reviewerSessionId,
				failure: parsed.refusal
			};
		}
		const { observation, conclusion, confidence, judgements, proposals } = parsed.diagnosis;
		const diagnosis = {
			diagnosisId: `review-agent-${reviewerSessionId}`,
			taskId: source.taskId,
			observedFailure: observation,
			scope: `task ${source.taskId}`,
			localizedCause: conclusion,
			evidenceRefs: review.evidenceRefs,
			reviewRefs: [sourceRef(source)],
			confidence,
			proposals,
			producedBy: {
				kind: "agent",
				sessionId: reviewerSessionId
			},
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
		if (diagnosis.proposals.length > 0) consumeHandoffDiagnosis(ctx, storeId, diagnosis.diagnosisId).catch((error) => {
			const logger = ctx.logger;
			logger?.("singularity-agent").warn(`evolution hand-off: ${diagnosis.diagnosisId} could not be consumed (${error instanceof Error ? error.message : String(error)})`);
		});
		return {
			kind: "recorded",
			sessionId: reviewerSessionId,
			diagnosisId: diagnosis.diagnosisId,
			confidence,
			observation,
			conclusion,
			judgements,
			proposals
		};
	} catch (error) {
		if (timer !== void 0) clearTimeout(timer);
		input.signal?.removeEventListener("abort", cancel);
		await settleAttempt("interrupted", `the review attempt failed: ${error instanceof Error ? error.message : String(error)}`);
		throw error;
	}
}

//#endregion
//#region src/review-agent-scan.ts
/** The prefix `rootTaskStoreId` writes; see {@link rootSessionOfStore}. */
const STORE_PREFIX = "sg-t-";
/**
* The graph root session one root task store belongs to, read back from the
* store id `rootTaskStoreId` derives it from — or nothing when the id was not
* derived that way. It is re-checked rather than trusted: an id this scan cannot
* read back is a store it must not spawn a reviewer for.
*/
function rootSessionOfStore(storeId) {
	if (!storeId.startsWith(STORE_PREFIX)) return void 0;
	const rootSessionId = storeId.slice(5);
	return rootSessionId.length === 0 ? void 0 : rootSessionId;
}
/** Whether two sources are the same source. */
function sameSource(left, right) {
	return left.taskId === right.taskId && left.runId === right.runId;
}
/**
* Every source of the store whose review settled `failed`, in the order the
* records were written — the exact source a review agent exists for, derived
* from the record's own run (`null` for a review that carries none) and never
* from "the latest review".
*/
function failedSourcesOf(snapshot) {
	return snapshot.reviews.filter((review) => review.outcome === "failed").map((review) => ({
		taskId: review.taskId,
		runId: review.runId ?? null
	}));
}
/** The relay of the store's root session, when this process holds it live. */
function rootAgentOf(ctx, storeId) {
	const sessionId$22 = rootSessionOfStore(storeId);
	if (sessionId$22 === void 0) return void 0;
	const agent = optionalService(ctx, "agents")?.get(sessionId$22);
	return agent === void 0 ? void 0 : {
		sessionId: sessionId$22,
		agent
	};
}
/**
* Scan one root task store for failed review sources and accept each under the
* store's allowance (see the module header for the order).
*
* Never throws for the work it does: a store it cannot read, a source it cannot
* accept and a reviewer that failed all come back as entries (and as log lines
* when a `log` is given), because every caller of this scan is a trigger — a
* settlement or an activation — that must not take a store down with a review.
*/
async function scanFailedReviewSources(ctx, storeId, options = {}) {
	const { log } = options;
	const entries = [];
	const report = () => ({
		storeId,
		entries
	});
	let snapshot;
	try {
		snapshot = await ctx.task.snapshotIn(storeId);
	} catch (error) {
		log?.(`review agent: store ${storeId} could not be read (${error instanceof Error ? error.message : String(error)}); nothing was scanned`);
		return report();
	}
	const failed = failedSourcesOf(snapshot);
	const targets = options.source === void 0 ? failed : failed.filter((source) => sameSource(source, options.source));
	if (targets.length === 0) return report();
	const root = rootAgentOf(ctx, storeId);
	const attempts = await readReviewAgentAttempts(storeId);
	for (const source of targets) {
		const mine = attempts.filter((attempt) => sameSource(attempt.source, source));
		const open = mine.filter((attempt) => attempt.settlement === void 0).at(-1);
		const existing = open ?? mine.at(-1);
		if (existing !== void 0 && open === void 0) {
			entries.push({
				source,
				result: "existing",
				sessionId: existing.sessionId
			});
			log?.(`review agent: source ${sourceRef(source)} already has an attempt (session ${existing.sessionId}, ${existing.settlement.status}) — read, nothing started`);
			continue;
		}
		if (root === void 0) {
			const reason = `the graph's root session for store ${storeId} is not live, so no reviewer could be started`;
			entries.push({
				source,
				result: "skipped",
				reason
			});
			log?.(`review agent: source ${sourceRef(source)} skipped — ${reason}; no claim, no reviewer`);
			continue;
		}
		const review = reviewForSource(snapshot, source);
		if (review === void 0) {
			const reason = "the review record could not be read back";
			entries.push({
				source,
				result: "skipped",
				reason
			});
			log?.(`review agent: source ${sourceRef(source)} skipped — ${reason}; no claim, no reviewer`);
			continue;
		}
		let outcome;
		try {
			outcome = await runReviewAgentAttempt({
				ctx,
				storeId,
				source,
				review,
				parent: root.agent,
				actor: root.sessionId,
				requestKey: existing === void 0 ? null : existing.requestKey,
				reason: existing === void 0 ? null : existing.reason
			});
		} catch (error) {
			const reason = `the review attempt failed: ${error instanceof Error ? error.message : String(error)}`;
			entries.push({
				source,
				result: "failed",
				reason
			});
			log?.(`review agent: source ${sourceRef(source)} failed — ${reason}`);
			continue;
		}
		switch (outcome.kind) {
			case "recorded":
				entries.push({
					source,
					result: "started",
					sessionId: outcome.sessionId
				});
				log?.(`review agent: source ${sourceRef(source)} accepted — reviewer session ${outcome.sessionId} started`);
				break;
			case "reuse":
			case "in-flight": {
				const reason = recoveryReason(outcome.recovered);
				entries.push({
					source,
					result: "existing",
					sessionId: outcome.attempt.sessionId,
					...reason === void 0 ? {} : { reason }
				});
				log?.(reason === void 0 ? `review agent: source ${sourceRef(source)} is claimed already (session ${outcome.attempt.sessionId}) — read, nothing started` : `review agent: source ${sourceRef(source)} — ${reason} (session ${outcome.attempt.sessionId}); nothing started`);
				break;
			}
			case "refused": {
				const reason = refusalReason(outcome.plan.code, outcome.plan.budget);
				const recovered = recoveryReason(outcome.recovered);
				entries.push({
					source,
					result: "skipped",
					reason: recovered === void 0 ? reason : `${reason} — ${recovered}`
				});
				log?.(`review agent: source ${sourceRef(source)} skipped — ${reason}; no claim, no reviewer${recovered === void 0 ? "" : ` (${recovered})`}`);
				break;
			}
			case "spawn-failed":
			case "unrecorded":
			case "no-diagnosis":
				entries.push({
					source,
					result: "failed",
					sessionId: outcome.sessionId,
					reason: outcome.failure
				});
				log?.(`review agent: source ${sourceRef(source)} accepted, but the reviewer did not finish — ${outcome.failure} (session ${outcome.sessionId})`);
				break;
		}
	}
	return report();
}
/** How one refusal reads in the scan's line, named the way the ledger refused. */
function refusalReason(code, budget) {
	if (code === "budget-exhausted") return `budget exhausted: the store's review allowance is spent (${budget.used}/${budget.max})`;
	if (code === "request-key-required") return "the source was already reviewed and this scan names no key";
	return "the source already has an attempt with a different focus";
}
/**
* How the recovery one decision performed reads in the scan's own words — the
* dead attempt the ledger settled on this call — or nothing when this decision
* recovered none. A recovery is a fact an operator reading the scan has to see:
* without it, a source whose reviewer died looks like one that was reviewed.
*/
function recoveryReason(recovered) {
	const attempt = recovered[0];
	if (attempt === void 0) return void 0;
	const status = attempt.settlement?.status ?? "interrupted";
	const note = attempt.settlement?.note === void 0 ? "" : `: ${attempt.settlement.note}`;
	return `the attempt found open with no process running it (session ${attempt.sessionId}) was recorded ${status}${note}`;
}
/** The warning channel the plugin has, when the deployment mounted a logger. */
function softWarn(ctx) {
	const logger = ctx.logger;
	return (line) => logger?.("singularity-agent").warn(line);
}
/**
* Install the two triggers of the automatic scan on this deployment's context:
* the runtime's terminal-review door (a review that settled `failed`) and the
* graph registry's activation event (a store scanned on explicit activation).
*
* The listeners do their work off the caller's path: both start the scan and
* return immediately, and a scan that fails is reported on the log rather than
* thrown into the settlement or the activation that woke it.
* @param ctx - the deployment's context, with the runtime and the graph registry.
* @param options - where the scan's lines go; the plugin's own logger by default.
* @returns a disposer that removes both listeners.
*/
function installReviewAgentAutoTrigger(ctx, options = {}) {
	const log = options.log ?? softWarn(ctx);
	const background = (work) => {
		work().catch((error) => {
			log(`review agent: the scan could not run (${error instanceof Error ? error.message : String(error)})`);
		});
	};
	const disposers = [ctx.taskRuntime.registerTerminalReviewListener((fact) => {
		if (fact.outcome !== "failed") return;
		background(() => scanFailedReviewSources(ctx, fact.storeId, {
			source: {
				taskId: fact.taskId,
				runId: fact.runId
			},
			log
		}));
	}), ctx.on("graphs/selected", (graph) => {
		background(() => scanFailedReviewSources(ctx, rootTaskStoreId(graph.rootSessionId), { log }));
	})];
	return () => {
		for (const dispose of disposers) dispose();
	};
}

//#endregion
//#region src/tools/approve.ts
const text$30 = (value) => [{
	type: "text",
	text: value
}];
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
			render: (_a, v) => text$30(v)
		},
		execute: async (args, exec) => {
			if (args.prompt.trim().length === 0) throw new Error("hitl_approve: prompt is empty");
			const agent = exec.agent;
			if (agent === void 0) throw new Error("hitl_approve: missing agent");
			switch (await ctx.approval.request({
				agent,
				toolName: "hitl_approve",
				callId: exec.callId,
				reason: args.prompt,
				signal: exec.signal
			})) {
				case "allowed-once": return "approve";
				case "rejected": return "reject";
				case "cancelled": return "reject (cancelled before the human decided)";
				case "unavailable": return "reject (no approval answerer available)";
			}
		}
	});
}

//#endregion
//#region src/tools/ask.ts
const text$29 = (value) => [{
	type: "text",
	text: value
}];
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
			render: (_a, v) => text$29(v)
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
//#region src/tools/proposal-parameters.ts
/**
* The proposal tools' argument closure (T2/T3 stage C).
*
* A DSH tool's parameter map is an implicitly **open** object root
* (`tools/schema.ts`: "The map itself is an implicit open object root"), so the
* schema cannot refuse a key a tool does not declare — which is deliberate for
* `task_decompose`, whose whole batch is handed to the runtime to refuse field
* by field. The three proposal tools have the opposite need: their entire
* contract is "a proposal id and nothing else", and in particular there is no
* argument anywhere that could mean "approved". A caller that tries one — a
* model inventing `approved: true`, or any other approval credential — must be
* told *by name* that this tool has no such parameter, instead of having the
* value silently ignored while the call runs as if it had been accepted.
*
* The check is the tool's own and runs before any service call, so a refused
* call has no side effect at all (§6: 服务入口执行所有检查；工具层只是显示与发起请求).
* @module dsh-singularity-agent/tools/proposal-parameters
*/
/**
* Refuse a call that carries a key the tool does not declare.
* @param args - the parsed arguments, as the model sent them.
* @param declared - every parameter the tool declares.
* @param toolName - the tool's own name, for the refusal text.
* @returns the refusal text, or `undefined` when the call carries nothing undeclared.
*/
function undeclaredParameters(args, declared, toolName) {
	const undeclared$3 = Object.keys(args).filter((key) => !declared.includes(key));
	if (undeclared$3.length === 0) return void 0;
	return [
		`${toolName} rejected: undeclared parameter${undeclared$3.length === 1 ? "" : "s"} ${undeclared$3.map((key) => `"${key}"`).join(", ")} —`,
		`this tool accepts ${declared.join(", ")} and has no argument that approves, decides, or stands in for a review;`,
		"nothing was read and nothing was changed."
	].join(" ");
}

//#endregion
//#region src/tools/budget-extend.ts
const text$28 = (value) => [{
	type: "text",
	text: value
}];
/** The whole argument surface: the request key and the two totals. There is deliberately no third member. */
const DECLARED_PARAMETERS = [
	"requestKey",
	"maxRuns",
	"deadlineAt"
];
const DIMENSIONS = ["maxRuns", "deadlineAt"];
function sessionId$20(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_budget_extend: missing agent id");
	return id;
}
/**
* The value one dimension is under, or the words that say there is none. An
* absent ceiling is not zero and not infinity: this deployment sets no limit
* there, and a card that printed a number would be inventing one.
*/
function inForce(value) {
	return value === void 0 ? "none" : String(value);
}
/** The raise this request asks of one dimension, when it names that dimension at all. */
function raiseOf(proposal, dimension) {
	return dimension === "maxRuns" ? proposal.maxRuns : proposal.deadlineAt;
}
/** One dimension's raise as a line, in the order the dimensions are printed. */
function raiseLines(proposal) {
	return DIMENSIONS.flatMap((dimension) => {
		const raise = raiseOf(proposal, dimension);
		return raise === void 0 ? [] : [`- ${dimension}: ${String(raise.previous)} → ${String(raise.next)}`];
	});
}
/**
* The card a person decides from (K4): the store and the tree the raise belongs
* to, the request's own key and identity, the runs the store already holds, each
* of the two ceilings as it stands now — the approved total in force first, the
* ceiling this deployment configures beside it in parentheses — and, for the
* dimensions this request names, the total approving would put in place.
*
* The usage is on the card because the ceiling is what is being moved and the
* count is what it is measured against: a raise from 10 to 20 when 18 runs exist
* is two runs of headroom, and a person who is not told that is deciding blind.
* There is no binding on it and no token standing in for one: the decision is not
* read back out of anything a caller could quote — the callback that renders this
* card is the one the runtime asks, and what it is told is what gets recorded.
*/
function renderAsk(ask) {
	const proposal = ask.proposal;
	return [
		`Budget extension of the tree in store "${ask.storeId}" — root task ${ask.rootTaskId}, asked by its root coordination session ${ask.rootSessionId}.`,
		`request key "${proposal.requestKey}" (identity ${proposal.requestDigest})`,
		`runs the store already holds: ${ask.runsUsed} — an approved total replaces the ceiling, never this count`,
		"ceilings now (the approved total in force first, the ceiling this deployment configures in parentheses):",
		...DIMENSIONS.map((dimension) => {
			const raise = raiseOf(proposal, dimension);
			const now = `${dimension}: ${inForce(ask.effective[dimension])} in force (deployment configures ${inForce(ask.configured[dimension])})`;
			return raise === void 0 ? `- ${now} — this request does not name it` : `- ${now} → approves a total of ${String(raise.next)}`;
		}),
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
		description: "Ask a human to raise the ceiling(s) bounding this tree's execution, and record the raise they approve. State the total you want in force, never a difference: maxRuns is the WHOLE approved run count (a positive whole number, not \"add five\"), deadlineAt is the absolute instant the tree must stop by (for example 2026-09-28T09:00:00.000Z, never \"two more hours\"). At least one of the two is required; a dimension this deployment leaves unlimited is refused, as is any total that is not above the ceiling in force. The request is shown to a human with the store, both ceilings and the runs already used, and only their explicit approval records anything — a rejection, a cancellation or an unavailable answerer writes nothing. A request key already recorded with the same totals is answered from the record without asking again; the same key at different totals is refused. A raise starts no run, resumes none, re-opens nothing and does not clear the runs already counted — it moves ceilings only. There is no argument here that approves anything or stands in for somebody's approval, and the store is derived from your session: only a graph's root coordination session can call this, and it may do so after its tree stopped.",
		parameters: {
			requestKey: {
				type: "string",
				required: true,
				description: "Stable key this request is answered under; a retry after a crash carries the same key and is answered from the recorded raise"
			},
			maxRuns: {
				type: "number",
				description: "The whole approved run count once the human approves — a positive whole number above the ceiling in force, never an increment"
			},
			deadlineAt: {
				type: "string",
				description: "The approved deadline as an absolute instant in UTC (e.g. 2026-09-28T09:00:00.000Z), later than the one in force — never a duration"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$28(v)
		},
		execute: async (args, exec) => {
			const undeclared$3 = undeclaredParameters(args, DECLARED_PARAMETERS, "task_budget_extend");
			if (undeclared$3 !== void 0) return undeclared$3;
			const caller = sessionId$20(exec);
			let result;
			try {
				result = await ctx.taskRuntime.extendRootBudget(caller, {
					callId: exec.callId,
					execution: exec
				}, {
					requestKey: args.requestKey,
					...args.maxRuns === void 0 ? {} : { maxRuns: args.maxRuns },
					...args.deadlineAt === void 0 ? {} : { deadlineAt: args.deadlineAt }
				});
			} catch (error) {
				return `task_budget_extend rejected: ${error instanceof Error ? error.message : String(error)}`;
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
/**
* The one approval a budget extension is granted through: the callback the
* assembly installs on the runtime once, and the only place a person's answer to
* `task_budget_extend` exists.
*
* The question goes through the native DSH approval seam the deployment already
* runs for every other human decision, under the host's own call id: the card is
* the ask's reason, the host execution's agent is who is asked — and whose
* session log the channel's `approval/asked` + `approval/decided` pair is
* written to — and the host execution's own signal is what withdraws the
* question. Only the channel's `'allowed-once'` allows a raise, and the reference
* it answers with is `approval:<callId>`: the host's identity for the call the
* question was asked under, an audit reference and never a credential.
*
* A person who says no, a question withdrawn before they could answer it, and a
* deployment with nobody to ask are one shape here — `refused` — because they
* mean the same thing to the tree: the ceiling stays where it is. A channel that
* throws is deliberately left to propagate (the runtime's caller reports it as a
* rejection) so a failure of the channel can never read as an approval.
*/
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
			reason: outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the question was cancelled before the human answered it" : "no approval answerer was available to put the question to a person"
		};
	};
}

//#endregion
//#region src/tools/capability-list.ts
const text$27 = (value) => [{
	type: "text",
	text: value
}];
/**
* `filesystem → read, write, edit, read_image` — the label kept, the real DSH
* names it resolves to shown, so a reader can see what a worker is actually
* granted. A label outside the vocabulary is shown as such and is what
* admission rejects when the capability is next resolved.
*/
function renderTools(entry) {
	const labels = entry.tools ?? [];
	if (labels.length === 0) return "tools: []";
	return `tools: [${labels.map((label) => TOOL_LABELS[label] === void 0 ? `${label} → (unknown label)` : `${label} → ${TOOL_LABELS[label].join(", ")}`).join("; ")}]`;
}
function renderPermission(entry) {
	return entry.permission === void 0 ? "permission: (none — the worker keeps danger-full-access)" : `permission: ${entry.permission}`;
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
/**
* One skill's provider verdict, in the words the pre-check uses: the role it
* was accepted as — an execution provider, loadable knowledge, plain guidance —
* or `invalid` with every named defect, so a model reading this before it
* dispatches sees the same conclusion admission will reach.
*/
function renderProvider(verdict) {
	if (!verdict.valid) return `${verdict.name} → invalid (${verdict.defects.map((item) => `${item.code}: ${item.detail}`).join("; ")})`;
	if (verdict.role === "execution-provider") {
		const tools = verdict.requiredTools.length === 0 ? "none declared" : verdict.requiredTools.join(", ");
		return `${verdict.name} → execution-provider (verifier: ${verdict.verifierRef}; requires: ${tools}; content: ${shortDigest(verdict.contentDigest)})`;
	}
	if (verdict.role === "knowledge") return `${verdict.name} → knowledge (no execution verifier by design; content: ${shortDigest(verdict.contentDigest)})`;
	return `${verdict.name} → guidance (no sidecar; loadable guidance, not an execution provider; content: ${shortDigest(verdict.contentDigest)})`;
}
/**
* The provider line under one capability row: every skill's verdict, or the
* fact that the row grants none. `rows` is the pre-check's own output, so an
* error message or a missing skill cannot be papered over here.
*
* A row the pre-check refused *as a row* — the capability an open evolution
* commit intent moves (A6) — has no verdicts to show: it was not resolved, and
* that refusal is what the model has to see before it picks this name for a
* batch admission will reject.
*/
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
			render: (_a, v) => text$27(v)
		},
		execute: async (_args, exec) => {
			const capabilities = ctx.taskRuntime.listCapabilities();
			const names = Object.keys(capabilities);
			if (names.length === 0) return "no capabilities configured";
			const caller = exec.agent?.id;
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
				`worker baseline (every capability worker keeps these on top of its grants): ${workerBaseline().join(", ")}`,
				`baseline labels: ${WORKER_BASELINE_LABELS.join(", ")}; task machinery: ${WORKER_BASELINE_TOOLS.join(", ")}`,
				"",
				"tool labels: a capability declares labels (filesystem, bash, …); each expands to the DSH tool names shown after \"→\".",
				"tool grants are fail-closed: a worker sees its capabilities' tools plus the baseline plus (when a capability names its own preset) that preset's whole tool plane — nothing else from the global layer.",
				"skill grants are not exclusive: DSH has no per-agent skill hiding, so a granted skill is registered for that worker alone and guaranteed loadable, but the worker's skill catalog still lists every skill its composition can discover.",
				"provider verdicts are the same pre-check admission runs, from this session's own skill roots: execution-provider means the skill carries an execution sidecar whose verifier is registered and whose required tools its capabilities grant; knowledge and guidance are loadable but never count as an execution provider; invalid means admission refuses a batch that requires this capability, with the defects shown.",
				...report === void 0 ? [] : [`skill roots searched for this session: ${report.roots.join(", ")}`],
				"mcpServers grant whole MCP servers (never single tools): each mounts as one mcp-client instance on the worker at spawn, bound to that run's environment checkout; a server that cannot start fails the spawn loudly.",
				"permissions: a capability that declares none leaves the worker on the deployment default (danger-full-access); flipping the default is blocked until worker approvals reliably reach the canvas (#17 in the working guide)."
			].join("\n");
		}
	});
}

//#endregion
//#region src/tools/projected-read.ts
/**
* The caller's own session id — the only identity a context read ever gets,
* because the read domain comes from the live caller, never from an argument.
*/
function callerSessionId(exec, tool) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error(`${tool}: missing agent id`);
	return id;
}
/**
* One read as one tool answer: the text when the read answered, and the named
* refusal with its detail when it refused. A refusal is a result, not a throw —
* `not-activated`, `unbound`, `cross-graph` and the rest are answers the model
* has to be told, in the same text style the tool's other rejections use.
*/
function adaptRead(tool, result) {
	if (result.ok) return result.text;
	return `${tool} ${result.refusal}:\n${result.detail}`;
}

//#endregion
//#region src/tools/context-read.ts
const text$26 = (value) => [{
	type: "text",
	text: value
}];
/** Every parameter this tool declares; anything else is refused by name before any read happens. */
const DECLARED$2 = [
	"kind",
	"ref",
	"offset",
	"limit"
];
/**
* Refuse a call carrying a key this tool does not declare — a `graphId`,
* `storeId` or `callerId` above all: the reference never authorizes, and an
* undeclared key is named rather than silently ignored.
*/
function undeclared$2(args) {
	const extra = Object.keys(args).filter((key) => !DECLARED$2.includes(key));
	if (extra.length === 0) return void 0;
	return [
		`context_read rejected: undeclared parameter${extra.length === 1 ? "" : "s"} ${extra.map((key) => `"${key}"`).join(", ")} —`,
		`this tool accepts ${DECLARED$2.join(", ")} and has no argument that names a graph, a store or a caller:`,
		"the read domain is the calling session's own graph, and nothing here can widen it. Nothing was read."
	].join(" ");
}
function defineContextReadTool(ctx) {
	return defineTool({
		name: "context_read",
		description: `Read one record of the caller's own graph domain by its reference. Kinds and their references: \`task\` (a task id), \`run\` (a run id), \`evidence\` (an evidence id), \`diagnosis\` (a diagnosis id), \`review\` (\`{taskId, runId}\` — a review has no id of its own; use runId null for a task that blocked before any run), and \`session\`, which has two forms. \`session\` with a session id pages that session's log by DSH event seq: \`offset\` is an event seq and \`limit\` an event count (default 20, at most 100). An event too large for a listing page is never cut: the listing stops at that event's seq and names the exact \`{sessionId, seq}\` reference to read it with. \`session\` with \`{sessionId, seq}\` reads that one event's visible text (the same text the listing renders), paged in UTF-8 BYTES: \`offset\` is a byte offset into that text (default 0) and \`limit\` the page size in bytes (default the bound, clamped into 4..${CONTEXT_OUTPUT_LIMIT_BYTES}). A successful single-event page is a JSON object carrying sessionId, seq, offset, nextOffset, hasMore and body (this page's fragment, so concatenating the pages' body values by nextOffset restores the whole text); its last page says how to return to the listing. Task-class records are read whole and paged in UTF-8 BYTES: \`offset\` is a byte offset into the record text and \`limit\` is the page size in bytes (the whole answer never exceeds ${CONTEXT_OUTPUT_LIMIT_BYTES} bytes); an oversized record answers the first page with the next byte offset to continue from. The reference never widens the domain: an id this graph's store does not hold, a stale reference, an unreadable record and a session of another graph each come back as a named refusal (not-found, stale-reference, unreadable, cross-graph, context-too-large).`,
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
			render: (_a, v) => text$26(v)
		},
		execute: async (args, exec) => {
			const refused = undeclared$2(args);
			if (refused !== void 0) return refused;
			const caller = callerSessionId(exec, "context_read");
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
const text$25 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$19(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("escalate: missing agent id");
	return id;
}
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
			render: (_a, v) => text$25(v)
		},
		execute: async (args, exec) => {
			if (args.list === true) {
				const escalations = await ctx.escalation.list();
				if (escalations.length === 0) return "escalations: none recorded";
				return [`escalations (${escalations.length}):`, ...escalations.map(renderEscalation)].join("\n");
			}
			const caller = sessionId$19(exec);
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
			if (outcome !== "allowed-once") return `escalate: no escalation recorded — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; the work stays where it was`;
			try {
				const escalation = await ctx.escalation.raise(card, caller, `approval:${exec.callId}`);
				return [
					`escalation ${escalation.escalationId} recorded [${escalation.status}] trigger: ${escalation.trigger}`,
					...cardLines(escalation),
					"acceptance: all three elements present (what / tried / suggested) — a human can decide from this card in ten minutes",
					`recorded after human approval ${escalation.approvalRef}; ledger: ${ctx.escalation.file}`
				].join("\n");
			} catch (error) {
				return `escalate rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-commit.ts
/**
* The lines a commit tool reports for an intent it settled instead of starting a
* second commit: the intent's own id, what the reconciliation found against
* production, and the grant the intent already binds.
* @param intent - the open intent the call found on the proposal.
* @param recovered - what the service reported for it: `redone` (production still
* held the state before the commit, so the write was carried out), `written`
* (production already held the committed content, so only the completion was
* recorded), or absent — which a service that settled an open intent does not
* answer, and which is reported rather than guessed.
*/
function renderOpenIntentRecovery(intent, recovered) {
	return [`recovered commit intent ${intent.intentId} (${recovered ?? "unreported"}): ${recoveryNote(recovered)}`, `no second approval was asked — the intent already binds ${intent.approvalRef}`];
}
/** What the recovery result means for production, in the words of the commit that performed it. */
function recoveryNote(recovered) {
	switch (recovered) {
		case "redone": return "production still held the state before this commit, so the same write was carried out and its completion recorded";
		case "written": return "production already held the content this commit installed, so only its completion was recorded and production was not written again";
		default: return "the service reported no recovery result for a proposal that had an open commit intent — production was left exactly as the intent found it";
	}
}

//#endregion
//#region src/tools/evolution-apply.ts
const text$24 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$18(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_apply: missing agent id");
	return id;
}
/**
* Why a decided PROMOTE proposal still cannot be applied: L4 harness evolution
* and target types this build has no executor for.
*/
function manualGuidance(proposal) {
	if (proposal.level === "L4") return "L4 harness evolution has no executor in evolution_apply: supervisor implementation and validation must precede human review through the harness change workflow";
	if (!APPLYABLE_TARGET_TYPES.includes(proposal.targetType)) return `this build writes an existing skill object or one capability row with an optional new execution skill, so a decided "${proposal.targetType}" proposal has no executor here — its ledger record stays readable and nothing writes it`;
	return null;
}
/** How the approved production write takes effect. */
function effectNote(proposal) {
	if (proposal.targetType === "capability") return "effective for new admissions — the committed capability row and optional new execution skill are available to the runtime; a run already bound to the previous capability snapshot keeps that snapshot";
	return "effective immediately — the skill filesystem watches the skill root, so the write is live; the skill directory is admitted again now that its commit intent is closed, and a run already bound to the previous version keeps loading the snapshot it was bound to";
}
function defineEvolutionApplyTool(ctx) {
	return defineTool({
		name: "evolution_apply",
		description: "Apply a PROMOTE-decided EvolutionProposal to production (status: applied). At L1–L3 it commits either a same-name improvement of an existing skill object (the `SKILL.md` and, for an execution skill, the `SKILL.contract.json` beside it) or one whole capability row with an optional new execution skill (both skill files). Other target types and L4 lack executors and are refused with instructions. Always asks a human through the native approval seam first — a second gate after evolution_decide — naming the capability row and each skill file path it will write; a reject, cancel, or unavailable answerer writes nothing and leaves the proposal decided. A skill apply additionally re-verifies before the human is asked, and again after the grant, the candidate's whole content identity and the production baseline recorded at prepare (the production file set must still be those exact bytes — a sidecar that appeared where the baseline had none, changed or disappeared refuses — so a stale candidate never overwrites a production skill that changed). The candidate sidecar is never the model's text: it must equal the production declaration with only content.skillMdSha256 rewritten, so a skill promotion cannot escalate requiredTools, swap a verifier, move capabilities or change the object's role; a candidate directory carrying any other entry (a resource, a stray file) is refused by name rather than reported as a provider production never received. A capability apply checks the frozen row and whole table identity before writing the row. The write is one commit: a durable commit intent — proposal, direction, this approval, every production file with the content identity each must hold before and after the write, and the bytes to write again — is recorded before production changes, then each file is replaced atomically (a temp file in the same directory, fsynced and renamed over the target; never truncated, never half-written), and only after every rename has been read back and the committed row and optional skill verified is the completion recorded. A failure at any stage leaves exactly one open intent rather than a half-committed object (a directory holding the new `SKILL.md` beside the old sidecar included), and the skill directory stays closed to new admission until that intent is settled; calling this tool again while an intent is open settles it instead of starting a second write: no approval is asked again (the intent already binds the grant it was authorised by, and the promotion gate is not re-run because the recorded intent already names the approved content), and the answer reports the intent id and whether the commit was redone (production still held the pre-commit state) or only completed (production already held the committed content). A source that is gone or changed, a target a third party rewrote, or a directory holding an entry the committed object does not name, refuses by name with the intent left open. evolution_rollback restores the champion snapshot.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Decided (PROMOTE) proposal to apply to production"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$24(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$18(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_apply: missing agent");
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.openIntent !== void 0) try {
				const recovered = await ctx.evolution.apply(args.proposalId, caller, proposal.openIntent.approvalRef);
				return [
					`proposal ${recovered.proposal.proposalId} [applied] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — PROMOTE in effect`,
					...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
					"wrote production targets:",
					...recovered.proposal.targetType === "capability" ? [`  - capability row ${recovered.proposal.targetId} in the production table`] : [],
					...recovered.targets.map((target) => `  - ${target}`),
					effectNote(recovered.proposal)
				].join("\n");
			} catch (error) {
				return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "decided") return `evolution_apply rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a decided proposal can be applied`;
			if (proposal.decision !== "PROMOTE") return `evolution_apply rejected: proposal ${proposal.proposalId} was decided ${proposal.decision}; only a PROMOTE decision can be applied`;
			const manual = manualGuidance(proposal);
			if (manual !== null) return `evolution_apply rejected: ${manual}`;
			let promotion;
			try {
				promotion = await ctx.evolution.checkPromotion(proposal.proposalId);
				await ctx.evolution.checkProductionBaseline(proposal.proposalId);
			} catch (error) {
				return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			const targets = applyTargets(proposal, ctx.evolution);
			const reason = [
				`Evolution apply for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				"recorded decision: PROMOTE",
				"this writes production targets:",
				...proposal.targetType === "capability" ? [`  - capability row ${proposal.targetId} in the production table`] : [],
				...targets.map((target) => `  - ${target}`),
				...renderProviderRoles(promotion.providers),
				effectNote(proposal),
				proposal.targetType === "capability" ? "rollback: evolution_rollback restores the prepared row baseline and removes any new skill" : "rollback: evolution_rollback restores the champion snapshot from the sandbox"
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_apply",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_apply: nothing written — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; proposal ${proposal.proposalId} stays decided`;
			try {
				const applied = await ctx.evolution.apply(args.proposalId, caller, `approval:${exec.callId}`);
				return [
					`proposal ${applied.proposal.proposalId} [applied] ${applied.proposal.level} ${applied.proposal.targetType} ${applied.proposal.targetId} — PROMOTE in effect`,
					"wrote production targets:",
					...applied.proposal.targetType === "capability" ? [`  - capability row ${applied.proposal.targetId} in the production table`] : [],
					...applied.targets.map((target) => `  - ${target}`),
					...renderProviderRoles(applied.providers ?? []),
					effectNote(applied.proposal),
					`human approval: approval:${exec.callId} — rollback with evolution_rollback`
				].join("\n");
			} catch (error) {
				return `evolution_apply rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-candidate.ts
const text$23 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$17(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_candidate: missing agent id");
	return id;
}
function defineEvolutionCandidateTool(ctx) {
	return defineTool({
		name: "evolution_candidate",
		description: "Record a proposed change as a candidate. mutationJson is ONE JSON string, not a nested tool argument: for an existing skill use {\"name\":\"existing-name\",\"content\":\"the whole SKILL.md\"}; for a capability use {\"rows\":{\"row-name\":{\"skills\":[\"skill-name\"],\"tools\":[]}},\"skill\":optionalNewSkill}. A new skill is {name,content,sidecar}; sidecar becomes SKILL.contract.json and supplies only semantic fields: {\"precondition\":\"task is present\",\"inputs\":[],\"outputs\":[],\"requiredTools\":[\"read\",\"write\"],\"verifier\":{\"ref\":\"command\"}}. The tool derives contractVersion:1, type:\"execution\", capabilities:[the sole row name], content.skillMdSha256 from the exact SKILL.md text, and resources:[]. Do not submit those derived fields. The row may grant only existing authorized tools; a new skill must use a registered verifier. No production write occurs here. Next: evolution_prepare, evolution_replay, evolution_gate.",
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
				description: "JSON text of exactly one complete mutation: {name,content} or {rows,skill?}. If skill is present, its sidecar is an object, not quoted JSON; supply only precondition, inputs, outputs, requiredTools and verifier:{ref}."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$23(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$17(exec);
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
				const proposal = await ctx.evolution.candidate(args.proposalId, versions, caller, candidate);
				const versionsText = Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(", ");
				return [`proposal ${proposal.proposalId} [candidate] version set: ${versionsText}`, "ledger entry only — no branch created, nothing executed; mutation recorded — next: evolution_prepare (sandbox materialization), then evolution_replay (the two-sided experiment), then evolution_gate"].join("\n");
			} catch (error) {
				return `evolution_candidate rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-decide.ts
const text$22 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$16(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_decide: missing agent id");
	return id;
}
function defineEvolutionDecideTool(ctx) {
	return defineTool({
		name: "evolution_decide",
		description: "Close a gated EvolutionProposal with a human decision (status: decided). Always asks a human through the native approval seam first — every level L1–L4, no exemption — and records the decision (PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH) only after an explicit approve. A reject, cancel, or unavailable answerer records nothing and leaves the proposal gated. A PROMOTE is checked before the human is asked: the candidate's whole content identity (the `SKILL.md` bytes, plus the derived sidecar and its declaration digest when the object declares an execution provider), its provider verdict (role, registered verifier, granted tools) and the completed two-sided experiment must still hold. An existing skill may not change role, weaken its verifier or grow a capability through a content update; a capability promotion moves exactly one whole row, optionally with a new execution skill, and cannot add unauthorized tools or change permission or preset. A recorded PROMOTE still applies nothing by itself: the change takes effect only through evolution_apply, which asks the human a second time, names every production file it writes, and leaves a run already bound to the previous version on its own snapshot.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Gated proposal to decide"
			},
			decision: {
				type: "string",
				required: true,
				enum: EVOLUTION_DECISIONS,
				description: "Decision to record after human approval"
			},
			note: {
				type: "string",
				description: "Optional rationale attached to the decision record"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$22(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$16(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_decide: missing agent");
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "gated") return `evolution_decide rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a gated proposal can be decided`;
			let promotion;
			if (args.decision === "PROMOTE") try {
				promotion = await ctx.evolution.checkPromotion(proposal.proposalId);
			} catch (error) {
				return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			const gate = proposal.gate;
			const reason = [
				`Evolution decision for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				`version set: ${Object.entries(proposal.versionSet).map(([key, value]) => `${key}=${value}`).join(", ")}`,
				`gate: 1. Target failure fixed? ${gate.targetFailureFixed}`,
				`gate: 2. Original acceptance maintained? ${gate.originalAcceptanceMaintained}`,
				`gate: 3. Existing regression maintained? ${gate.existingRegressionMaintained} [evidence: ${gate.regressionEvidenceRefs.join(", ")}]`,
				`gate: 4. No unacceptable side effects? ${gate.noUnacceptableSideEffects}`,
				`gate: 5. Holdout performance acceptable? ${gate.holdoutPerformanceAcceptable}`,
				`gate: 6. Resource cost acceptable? ${gate.resourceCostAcceptable}`,
				`proposed decision: ${args.decision}${args.note === void 0 ? "" : ` — ${args.note}`}`,
				`this promotion would put in place: ${promotion === void 0 || promotion.providers.length === 0 ? "no provider skill" : renderProviderRoles(promotion.providers).join("; ")}`
			].join("\n");
			const outcome = await ctx.approval.request({
				agent,
				toolName: "evolution_decide",
				callId: exec.callId,
				reason,
				signal: exec.signal
			});
			if (outcome !== "allowed-once") return `evolution_decide: no decision recorded — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; proposal ${proposal.proposalId} stays gated`;
			try {
				const decided = await ctx.evolution.decide(args.proposalId, args.decision, caller, `approval:${exec.callId}`, args.note);
				return [`proposal ${decided.proposalId} [decided] ${decided.decision}${decided.decisionNote === void 0 ? "" : ` — ${decided.decisionNote}`}`, decided.decision === "PROMOTE" ? "recorded after human approval — nothing applied yet; evolution_apply (second human gate) takes it to production" : "recorded after human approval — the ledger notes the decision only; nothing was applied"].join("\n");
			} catch (error) {
				return `evolution_decide rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-gate.ts
const text$21 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$15(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_gate: missing agent id");
	return id;
}
function defineEvolutionGateTool(ctx) {
	return defineTool({
		name: "evolution_gate",
		description: "Answer the minimal Validation Gate for a candidate (status: gated). The six questions (细化想法4 §32): 1. Target failure fixed? 2. Original acceptance maintained? 3. Existing regression maintained? 4. No unacceptable side effects? 5. Holdout performance acceptable? 6. Resource cost acceptable? All six answers are required, and the regression side must cite evidence ids (from this graph's task store) or file paths whose existence is checked — cited evidence is never executed. A skill or capability candidate must pass evolution_prepare (sandbox materialization) and then evolution_replay (the two-sided experiment: a new baseline run and a new candidate run per frozen sample, the production object and the prepared object each loaded whole), and its report path must be one of the regressionEvidenceRefs — the gate refuses either candidate whose experiment is not complete. A capability sample without a provider records the runtime's real not-admitted baseline. Other target types cannot become candidates and have no gate to answer. Records the ledger entry only; nothing is promoted or changed, and evolution_decide re-checks the candidate's whole content identity and its provider verdict before a PROMOTE can be recorded. Next step is evolution_decide, which always asks a human.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Candidate to gate"
			},
			targetFailureFixed: {
				type: "string",
				required: true,
				description: "Answer to \"1. Target failure fixed?\""
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
			render: (_a, v) => text$21(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$15(exec);
			let evidenceIds = /* @__PURE__ */ new Set();
			try {
				const graph = await ctx.graphs.graphForSession(caller);
				const snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId));
				evidenceIds = new Set(snapshot.evidence.map((item) => item.evidenceId));
			} catch {
				evidenceIds = /* @__PURE__ */ new Set();
			}
			try {
				const proposal = await ctx.evolution.gate(args.proposalId, {
					targetFailureFixed: args.targetFailureFixed,
					originalAcceptanceMaintained: args.originalAcceptanceMaintained,
					existingRegressionMaintained: args.existingRegressionMaintained,
					noUnacceptableSideEffects: args.noUnacceptableSideEffects,
					holdoutPerformanceAcceptable: args.holdoutPerformanceAcceptable,
					resourceCostAcceptable: args.resourceCostAcceptable,
					regressionEvidenceRefs: args.regressionEvidenceRefs
				}, caller, async (ref) => evidenceIds.has(ref));
				return [`proposal ${proposal.proposalId} [gated] gate answered 6/6, regression evidence: [${proposal.gate.regressionEvidenceRefs.join(", ")}]`, "ledger entry only — nothing executed or promoted; next: evolution_decide (human approval required)"].join("\n");
			} catch (error) {
				return `evolution_gate rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-list.ts
const text$20 = (value) => [{
	type: "text",
	text: value
}];
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
		description: "Read-only. List EvolutionProposals in the evolution ledger, optionally filtered by status / targetType / targetId, each with its derived history (proposed → candidate → prepared → gated → decided → applied → rolledback for an applied skill object or capability row, optionally with a new execution skill; other target types stay proposed). A skill object has `SKILL.md` plus `SKILL.contract.json` when it is an execution provider. The ledger records proposals, sandbox materializations, human decisions, human-approved applies/rollbacks, and the commit intent behind each production write: a proposal whose commit was interrupted reports that intent — its id, direction, every production file it commits and when it was recorded — and stays in the status its lifecycle had reached, until a reconciliation or a retry of the apply/rollback settles it.",
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
			render: (_a, v) => text$20(v)
		},
		execute: async (args) => {
			const proposals = await ctx.evolution.list({
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
					if (proposal.targetType === "capability") {
						const row = view.capabilityRow;
						const baseline = view.capabilityBaseline;
						lines.push(`  sandbox: ${ctx.evolution.root}/${view.sandbox} (${view.files.length} files, capability row${view.skillContent === void 0 ? "" : " + new execution skill"})`);
						lines.push(`  candidate row: ${row.name} sha256:${row.digest.slice(0, 12)}…`);
						lines.push(`  production row baseline: ${baseline === null ? "absent" : `${baseline.name} sha256:${baseline.digest.slice(0, 12)}…`}`);
						lines.push(view.skillContent === void 0 ? "  no new skill object" : `  new execution skill: ${view.skillContent.name} sha256:${view.skillContent.sha256.slice(0, 12)}… (SKILL.md + SKILL.contract.json)`);
						if (view.skillContent !== void 0) lines.push("  production skill baseline: absent");
					} else {
						const shape = view.skillContent.contract === void 0 ? "guidance (SKILL.md)" : "execution provider (SKILL.md + SKILL.contract.json)";
						lines.push(`  sandbox: ${ctx.evolution.root}/${view.sandbox} (${view.files.length} files, ${shape}, champion snapshot captured, candidate content ${view.skillContent.name} sha256:${view.skillContent.sha256.slice(0, 12)}…, production baseline ${view.skillBaseline.name} sha256:${view.skillBaseline.sha256.slice(0, 12)}…)`);
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
const text$19 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$14(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_prepare: missing agent id");
	return id;
}
function defineEvolutionPrepareTool(ctx) {
	return defineTool({
		name: "evolution_prepare",
		description: "Materialize a candidate's structured mutation into the proposal sandbox (status: prepared). A skill candidate is prepared as the complete object it improves: a guidance skill is its `SKILL.md` alone, and an execution skill is `SKILL.md` plus the `SKILL.contract.json` beside it, derived from the production declaration with only content.skillMdSha256 recomputed — the model never submits a sidecar. A capability candidate (A6) is prepared as its whole row, plus the new execution skill that row grants when it carries one; the baseline a later apply compares against is then the row the registry held, or its recorded absence. For an existing skill, one verified read of the production target comes first — it yields both the champion/ snapshot and the baseline identity a later apply compares against — and a target that is not there, or is not the loadable object its files claim (a defective declaration, an undeclared file), is refused by name before any sandbox or ledger write, never prepared against nothing. A knowledge sidecar, an object declaring resources and a proposal of any other kind are refused by name too; for an existing skill, production fixes the shape: this path cannot add a `SKILL.contract.json` to a skill that has none, and it never changes the object's role. Writes go only to the proposal sandbox (<ledger root>/sandbox/<proposalId>/: `skills/<name>/SKILL.md` — plus `skills/<name>/SKILL.contract.json` for an execution object — and the same paths under `champion/` for the production bytes the snapshot captures). Nothing here touches production; the next step is evolution_replay, the two-sided experiment.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Skill or capability candidate carrying a mutation, to materialize into its sandbox"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$19(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$14(exec);
			try {
				const prepared = await ctx.evolution.prepare(args.proposalId, caller);
				const view = prepared.prepared;
				if (view.capabilityRow !== void 0) {
					const rowBaseline = view.capabilityBaseline ?? null;
					return [
						`proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
						...view.files.map((file) => `  wrote ${file}`),
						`candidate row: ${view.capabilityRow.name} sha256:${view.capabilityRow.digest.slice(0, 12)}…`,
						rowBaseline === null ? "registry baseline: the table held no such row, so this candidate adds it" : `registry baseline: row sha256:${rowBaseline.digest.slice(0, 12)}… (an apply refuses if the registry row changed since this read)`,
						view.skillContent === void 0 ? "candidate object: the row alone — no new skill object is materialized" : "candidate object: a new execution provider (SKILL.md + SKILL.contract.json) the row grants, judged by a registered verifier with resources: []",
						"sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate"
					].join("\n");
				}
				const baseline = view.skillBaseline;
				return [
					`proposal ${prepared.proposalId} [prepared] sandbox: ${ctx.evolution.root}/${view.sandbox}`,
					...view.files.map((file) => `  wrote ${file}`),
					view.skillContent.contract === void 0 ? "candidate object: guidance (one file, SKILL.md)" : "candidate object: execution provider (SKILL.md + SKILL.contract.json) — the sidecar is derived from production with only content.skillMdSha256 rewritten, so this candidate cannot move a capability, a required tool or a verifier",
					"champion snapshot: captured under champion/",
					`production baseline: ${baseline.name} sha256:${baseline.sha256.slice(0, 12)}… (an apply refuses if the production object changed since this read)`,
					"sandbox only — production was not touched; next: evolution_replay (the two-sided experiment), then evolution_gate"
				].join("\n");
			} catch (error) {
				return `evolution_prepare rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-propose.ts
const text$18 = (value) => [{
	type: "text",
	text: value
}];
/**
* The mutation surfaces this build records for Evolution — its own vocabulary,
* not the diagnosis's (A5): a `DiagnosisProposal.targetType` is an open name,
* and this is where a suggestion is checked before it is transcribed into a
* proposal. What can actually be *executed* is narrower still
* (`APPLYABLE_TARGET_TYPES` in the evolution package, and the hand-off
* consumption in `evolution-handoff.ts`).
*/
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
function sessionId$13(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_propose: missing agent id");
	return id;
}
function defineEvolutionProposeTool(ctx) {
	return defineTool({
		name: "evolution_propose",
		description: "Register an EvolutionProposal in the evolution ledger (status: proposed). Pure bookkeeping: nothing here executes or changes production. This build admits an existing skill under its own name (the whole loadable object) or one whole capability row with an optional NEW execution skill. Both go through evolution_candidate, evolution_prepare, evolution_replay (the two-sided experiment), evolution_gate, and a human-approved evolution_decide plus evolution_apply. Other target types stay recorded suggestions and are never opened as candidates, so they are never evaluated and never promoted. Fill targetType/targetId/rationale manually, or pass fromDiagnosis to transcribe one proposal out of a recorded diagnosis (task_diagnose). baseVersion, level, and at least one sourceRef (diagnosisId / reviewRef / evidenceId) are required.",
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
				description: "Evolution level (L1 execution adaptation / L2 capability / L3 workflow / L4 harness); every level goes through human review, with no exemption"
			},
			baseVersion: {
				type: "string",
				required: true,
				description: "Version of the target this proposal starts from"
			},
			targetType: {
				type: "string",
				enum: PROPOSAL_TARGET_TYPES,
				description: "The mutation surface the proposal points at (required unless fromDiagnosis)"
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
				description: "Sources this proposal rests on (diagnosisId / reviewRef / evidenceId)"
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
			render: (_a, v) => text$18(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$13(exec);
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
				const proposal = await ctx.evolution.propose({
					proposalId: args.proposalId,
					targetType,
					targetId,
					baseVersion: args.baseVersion,
					level: args.level,
					rationale,
					sourceRefs
				}, caller);
				const skillReplacement = "ledger entry only — nothing was executed or changed; next: evolution_candidate with mutationJson as JSON text carrying the full replacement text of the existing skill's SKILL.md — the only input a candidate submits, because an execution skill's SKILL.contract.json is derived from production at evolution_prepare (only its content.skillMdSha256 is recomputed, so a content update cannot move a capability, a required tool or a verifier)";
				const capabilityReplacement = "ledger entry only — nothing was executed or changed; next: evolution_candidate with mutationJson as JSON text carrying exactly one whole capability row { rows } and optionally a NEW execution skill { name, content, sidecar semantic fields }; the row may use only already authorized tools and may not change permission or preset";
				const recordedSuggestion = `ledger entry only — nothing was executed or changed; this build promotes an existing skill or one capability row with an optional new execution skill, so a "${proposal.targetType}" proposal stays a recorded suggestion: it cannot become a candidate, is never evaluated, and is never promoted`;
				return [
					`proposal ${proposal.proposalId} registered [proposed] ${proposal.level} ${proposal.targetType} ${proposal.targetId} (base ${proposal.baseVersion})`,
					`rationale: ${proposal.rationale}`,
					`sourceRefs: [${proposal.sourceRefs.join(", ")}]`,
					proposal.targetType === "skill" ? skillReplacement : proposal.targetType === "capability" ? capabilityReplacement : recordedSuggestion
				].join("\n");
			} catch (error) {
				return `evolution_propose rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-replay.ts
const text$17 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$12(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_replay: missing agent id");
	return id;
}
/**
* The model selection this experiment freezes — read from the evolution plane's
* injected resolver, never from the caller (§F.2: the model is frozen before the
* runs, and a model-filled string could not be one). The injection is the whole
* point: the runtime places every replayed spawn under exactly this selection,
* and the promotion gate re-reads the runs' own requests against it.
* A deployment that cannot name a structured selection gets the service's own
* refusal here — before any run, before any ledger line.
*/
function modelSelection(ctx) {
	return ctx.evolution.modelSelection();
}
/** The workspace the caller's own session runs in — the frozen input snapshot both experiment sides are built from. */
async function callerWorkspace(ctx, caller) {
	const runtime = optionalService(ctx, "taskRuntime");
	let path;
	try {
		path = await runtime?.workspacePathFor?.(caller);
	} catch (error) {
		throw new Error(`cannot resolve the caller session's workspace: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof path !== "string" || path.length === 0) throw new Error(`this deployment cannot name the workspace of session "${caller}", which the experiment would freeze as its input snapshot — name the caller's env workspace (S4-E item 2) before evaluating a skill or capability candidate`);
	return path;
}
/** The task's latest review record — the record a sample's role is read from. */
function latestReview(snapshot, task) {
	const runId = task.runIds[task.runIds.length - 1];
	return snapshot.reviews.find((item) => item.runId === runId);
}
/**
* The role one named task has, from the store's own history: its latest review
* decides whether the case is a failure the candidate is meant to fix or a
* passing case it must not break. The caller names tasks; it does not get to
* label them (§F.2).
*/
function roleOf(snapshot, taskId) {
	const task = snapshot.tasks.find((item) => item.taskId === taskId);
	if (task === void 0) throw new Error(`unknown task "${taskId}" in this graph's task store`);
	if (task.status !== "verified" && task.status !== "failed") throw new Error(`task "${taskId}" is ${task.status}; only a terminal (verified or failed) task carries the history a role is read from`);
	const review = latestReview(snapshot, task);
	if (review === void 0) throw new Error(`task "${taskId}" has no review record on its latest run; there is no case to reproduce`);
	if (review.outcome === "failed") return "observed-failure";
	if (review.outcome === "verified") return "observed-regression";
	throw new Error(`task "${taskId}" is ${task.status} but its latest review record is "${review.outcome}"; a sample must be the case its role names, and only a failed or verified record names one`);
}
/**
* The samples one skill experiment runs, derived from the call's task lists and
* the store's history. Observed and holdout are both required and both
* non-empty (§F.2): without a failure there is nothing the candidate fixes, and
* without a holdout there is nothing it must not break — a comparison missing
* either is not the evidence the promotion gate is asked for.
*/
function deriveExperimentSamples(snapshot, taskIds, holdoutTaskIds) {
	const named = [...taskIds, ...holdoutTaskIds];
	if (new Set(named).size !== named.length) throw new Error("taskIds and holdoutTaskIds must not overlap or repeat");
	if (taskIds.length === 0) throw new Error("taskIds must name the samples the candidate is evaluated against: at least one task whose latest review is failed (the observed failure it is meant to fix) and any verified tasks it must not break");
	if (holdoutTaskIds.length === 0) throw new Error("holdoutTaskIds must name at least one task that did not select this candidate — the two-sided experiment evaluates the observed cases and the held-out ones together, and an empty holdout proves nothing about what the candidate may break");
	const samples = [...taskIds.map((taskId) => ({
		taskId,
		role: roleOf(snapshot, taskId)
	})), ...holdoutTaskIds.map((taskId) => ({
		taskId,
		role: "holdout"
	}))];
	if (!samples.some((sample) => sample.role === "observed-failure")) throw new Error("none of taskIds has a failed latest review, so there is no observed failure for this candidate to fix — name the task whose recorded failure this candidate addresses (a candidate with no reproduced failure cannot be evaluated as a fix)");
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
/**
* What one experiment produced, as its caller reads it. The baseline is said to
* be a new run of *this* experiment in the first line that describes the sides:
* §F.2's whole point is that the historical record locates a case and is never
* the comparison's baseline, so the report is rendered without that vocabulary
* at all. The candidate side is named by what the proposal *is*: a skill object's
* identity, or the capability row (and, when it carries one, the new skill) a
* capability candidate installs.
*/
function renderExperiment(result, targetId) {
	const { report } = result;
	const ceiling = report.frozen.budget.maxTokens;
	const budget = ceiling === void 0 ? "no maxTokens ceiling declared" : `maxTokens ${ceiling}`;
	const baseline = report.frozen.productionBaseline;
	const candidate = report.frozen.candidate;
	const capability = report.frozen.capability;
	const skillIdentity = candidate === void 0 ? void 0 : `${candidate.contract === void 0 ? "guidance" : "execution"} sha256 ${candidate.sha256}${candidate.contract === void 0 ? "" : ` sidecar sha256 ${candidate.contract.sha256}`}`;
	const candidateIdentity = capability !== void 0 ? `capability row "${capability.row.name}" sha256 ${capability.row.digest} (the table held ${capability.baseline === null ? "no such row" : `row sha256 ${capability.baseline.digest}`})${skillIdentity === void 0 ? "" : ` and a new skill, ${skillIdentity}`}` : skillIdentity;
	if (candidateIdentity === void 0) throw new Error(`experiment ${result.experimentId} carries neither a skill object identity nor a capability row — a report without a candidate identity is not one this build evaluated, and its record is read back through evolution_list`);
	const baselineIdentity = capability === void 0 ? `production baseline ${baseline?.sha256 ?? "not recorded"}${baseline?.contract === void 0 ? "" : ` sidecar sha256 ${baseline.contract.sha256}`}` : `row this candidate moves: ${capability.baseline === null ? "none (a new row)" : `sha256 ${capability.baseline.digest}`}`;
	return [
		`proposal ${report.proposalId} [experiment] ${capability === void 0 ? "skill" : "capability"} ${targetId} — verdict: ${report.verdict}`,
		`samples (${report.samples.length}):`,
		...report.samples.map((sample) => `  ${sample.taskId} [${sample.role}] baseline ${sample.baseline.outcome} → candidate ${sample.candidate.outcome} (${renderExperimentCriterionDiff(sample.baseline.criteria, sample.candidate.criteria)}) — ${sample.verdict}`),
		"every side above is a new run this experiment started — the baseline under the production configuration (the production object, or the production table for a capability sample, whose frozen identity is read again at every promotion gate), the candidate on the prepared object's bytes (the prepared `SKILL.md`, the sidecar derived from production for an execution skill, and, for a capability candidate, the frozen row the candidate overlay mounts); the sample's historical record only locates the case",
		`report: ${result.reportPath}`,
		`experiment ${result.experimentId} (repetition ${report.frozen.repetition}, frozen ${report.frozenDigest}); candidate ${candidateIdentity}; ` + baselineIdentity + `; model ${report.frozen.model.label}; budget ${budget}; snapshot ${report.frozen.snapshot.digest}; comparer ${report.frozen.comparerVersion}`,
		"next: evolution_gate (cite the report path in regressionEvidenceRefs)"
	].join("\n");
}
/** The experiment one call runs: the derived samples, the caller's frozen input, and the model selection it runs under. */
async function runExperimentFor(ctx, args, caller, signal) {
	let snapshot;
	try {
		const graph = await ctx.graphs.graphForSession(caller);
		snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId));
	} catch (error) {
		throw new Error(`cannot open this graph's task store: ${error instanceof Error ? error.message : String(error)}`);
	}
	return ctx.evolution.runExperiment({
		proposalId: args.proposalId,
		samples: deriveExperimentSamples(snapshot, args.taskIds, args.holdoutTaskIds),
		snapshot: { sourceDir: await callerWorkspace(ctx, caller) },
		model: modelSelection(ctx),
		budget: { ...args.budget ?? {} },
		repetition: args.repetition ?? 0
	}, caller, caller, { signal });
}
function defineEvolutionReplayTool(ctx) {
	return defineTool({
		name: "evolution_replay",
		description: "Evaluate a prepared candidate — a **skill** candidate (an existing skill's whole object: `SKILL.md` and, for an execution skill, the `SKILL.contract.json` beside it) or a **capability** candidate (one whole capability row plus the new execution skill it grants, when it carries one) — with the two-sided experiment. Every named task is run twice — a new baseline run under the production configuration (the production object; for a capability sample, the production table offered the same case through the runtime's ordinary admission, so a sample the table cannot admit is recorded as that real refusal, with no invented run) and a new candidate run on the prepared bytes (the prepared `SKILL.md`, and for a capability candidate the frozen row its overlay mounts) — each in its own workspace built from the caller session's env workspace (the frozen input snapshot), all under one frozen identity (samples, snapshot digest, candidate content, model, budget, comparer). Sample roles are derived from the store's history: a task whose latest review is failed is the observed failure, a verified one is an observed regression, and holdoutTaskIds are the held-out cases; a call with no failed sample, or with an empty holdout, is refused — the experiment requires both. The historical record locates each case and is never a baseline. This is the only evaluation this build has: a proposal targeting anything but a skill replacement or a capability candidate is refused by name. Writes the report under sandbox/<proposalId>/ and records the ledger entries; cite the report path in evolution_gate's regressionEvidenceRefs. Repeating the same call reuses the settled runs — it never re-runs or overwrites one; a higher `repetition` freezes a new experiment.",
		parameters: {
			proposalId: {
				type: "string",
				required: true,
				description: "Prepared candidate to evaluate: a skill or capability candidate"
			},
			taskIds: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Sample task ids from this graph's task store: at least one whose latest review is failed (the observed failure the candidate is meant to fix) plus any verified regressions it must not break"
			},
			holdoutTaskIds: {
				type: "array",
				items: { type: "string" },
				description: "Verified task ids the candidate was not selected on; the experiment requires at least one"
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
				description: "The budget frozen with the experiment. maxTokens is optional; omit it when this deployment does not report token counts for business Runs. If you declare it, promotion requires a measured token total for every executed side; tool-call counts and model guesses cannot satisfy that check. A declared total also stops further sides once reported usage reaches it. Runs retain the deployment's own runtime limits."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$17(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$12(exec);
			const taskIds = args.taskIds.map((id) => String(id));
			const holdoutTaskIds = (args.holdoutTaskIds ?? []).map((id) => String(id));
			try {
				const proposal = await ctx.evolution.get(args.proposalId);
				if (proposal.targetType !== "skill" && proposal.targetType !== "capability") throw new Error(`proposal ${proposal.proposalId} targets "${proposal.targetType}" — this tool evaluates a prepared **skill** candidate (a new baseline run on the production object and a new candidate run on the prepared object, each loaded whole: the SKILL.md, and the SKILL.contract.json beside it when the skill declares an execution provider) or a prepared **capability** candidate (the same two-sided run, the candidate side mounting the frozen capability row and its new skill; a baseline the production table cannot admit is recorded as the runtime's own refusal, never as an invented run). No other target type has an evaluator in this build, so its proposal stays a record`);
				return renderExperiment(await runExperimentFor(ctx, {
					proposalId: args.proposalId,
					taskIds,
					holdoutTaskIds,
					...args.repetition === void 0 ? {} : { repetition: args.repetition },
					...args.budget === void 0 ? {} : { budget: args.budget }
				}, caller, exec.signal), proposal.targetId);
			} catch (error) {
				return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/evolution-rollback.ts
const text$16 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$11(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("evolution_rollback: missing agent id");
	return id;
}
/**
* What a restored object means for production, stated honestly in the output:
* the skill root is watched, so the restored bytes are what the next admission
* loads, the directory is admitted again once its commit intent is closed, and a
* run already bound to the applied version keeps its own snapshot.
*/
function restoreNote(targetType) {
	if (targetType === "capability") return "the production capability row was restored or removed to its prepared baseline, and any new skill was removed; new admissions read that state while runs already bound to the applied snapshot keep their snapshot";
	return "the restored object is what the skill filesystem now serves and what the next admission loads, and the skill directory is admitted again now that its commit intent is closed; a run already bound to the applied version keeps loading the snapshot it was bound to";
}
function defineEvolutionRollbackTool(ctx) {
	return defineTool({
		name: "evolution_rollback",
		description: "Roll back an applied EvolutionProposal (status: rolledback). Restores the production baseline fixed at prepare — the production file set of the applied skill object (the `SKILL.md`, plus the `SKILL.contract.json` when it declares an execution provider), put back byte for byte, or restores a committed capability row and removes its optional new execution skill. An applied record of any other target type has no executor here and is refused. Always asks a human through the native approval seam first — reject / cancel / unavailable writes nothing and the proposal stays applied. Only an applied proposal can be rolled back; a rolled-back proposal keeps its full ledger history. The restore is one commit, in the same order as apply: a durable commit intent (proposal, direction, this approval, every production file with the content identity each must hold before and after the restore, and the champion snapshot as the recoverable bytes for each file) is recorded before production changes, each file is then replaced atomically, and only after every target has been read back and the committed row and optional skill verified is the completion recorded — so a failure at any stage leaves one open intent and affected production closed to new admission rather than a half-commit. A rollback restores this proposal's own baseline and refuses by name, with nothing written, a target that a later proposal (or any other writer) has changed since this version was applied (both files must still hold what this proposal applied, and the directory must hold that object's own files with no entry the object does not name), and a champion snapshot that no longer hashes to the baseline recorded at prepare. Calling this tool again while an intent is open settles it instead of asking for a second approval: the answer reports the intent id and whether the write was redone or only its completion recorded.",
		parameters: { proposalId: {
			type: "string",
			required: true,
			description: "Applied proposal to roll back"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$16(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$11(exec);
			const agent = exec.agent;
			if (agent === void 0) throw new Error("evolution_rollback: missing agent");
			let proposal;
			try {
				proposal = await ctx.evolution.get(args.proposalId);
			} catch (error) {
				return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.openIntent !== void 0) try {
				const recovered = await ctx.evolution.rollback(args.proposalId, caller, proposal.openIntent.approvalRef);
				return [
					`proposal ${recovered.proposal.proposalId} [rolledback] ${recovered.proposal.level} ${recovered.proposal.targetType} ${recovered.proposal.targetId} — ${recovered.proposal.targetType === "capability" ? "production baseline restored" : "champion restored"}`,
					...renderOpenIntentRecovery(proposal.openIntent, recovered.recovered),
					"wrote production targets:",
					...recovered.proposal.targetType === "capability" ? [`  - capability row ${recovered.proposal.targetId} restored in the production table`] : [],
					...recovered.targets.map((target) => `  - ${target}`),
					restoreNote(recovered.proposal.targetType)
				].join("\n");
			} catch (error) {
				return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (proposal.status !== "applied") return `evolution_rollback rejected: proposal ${proposal.proposalId} is ${proposal.status}; only an applied proposal can be rolled back`;
			const targets = applyTargets(proposal, ctx.evolution);
			if (targets.length === 0 && proposal.targetType !== "capability") return `evolution_rollback rejected: proposal ${proposal.proposalId} targets "${proposal.targetType}" — this build restores an existing skill object or a capability row with an optional new execution skill, so there is no executor for this target type`;
			const reason = [
				`Evolution rollback for proposal ${proposal.proposalId} (${proposal.level} ${proposal.targetType} ${proposal.targetId}, base ${proposal.baseVersion})`,
				`rationale: ${proposal.rationale}`,
				`applied at: ${[...proposal.targetType === "capability" ? [`capability row ${proposal.targetId}`] : [], ...proposal.applied.targets].join(", ")} (approval ${proposal.applied.approvalRef})`,
				proposal.targetType === "capability" ? "this restores the prepared capability row baseline and removes any new skill from production targets:" : "this restores the champion snapshot over production targets:",
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
			if (outcome !== "allowed-once") return `evolution_rollback: nothing written — ${outcome === "rejected" ? "the human rejected it" : outcome === "cancelled" ? "the request was cancelled before the human decided" : "no approval answerer available"}; proposal ${proposal.proposalId} stays applied`;
			try {
				const rolledback = await ctx.evolution.rollback(args.proposalId, caller, `approval:${exec.callId}`);
				return [
					`proposal ${rolledback.proposal.proposalId} [rolledback] ${rolledback.proposal.level} ${rolledback.proposal.targetType} ${rolledback.proposal.targetId} — ${rolledback.proposal.targetType === "capability" ? "production baseline restored" : "champion restored"}`,
					"wrote production targets:",
					...rolledback.proposal.targetType === "capability" ? [`  - capability row ${rolledback.proposal.targetId} restored in the production table`] : [],
					...rolledback.targets.map((target) => `  - ${target}`),
					restoreNote(rolledback.proposal.targetType),
					`human approval: approval:${exec.callId}`
				].join("\n");
			} catch (error) {
				return `evolution_rollback rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/mark-ready.ts
const text$15 = (value) => [{
	type: "text",
	text: value
}];
function defineMarkReadyTool(ctx) {
	return defineTool({
		name: "graph_mark_ready",
		description: "Mark the current Singularity graph ready after environment setup is complete. Required before free-form human chat.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$15(v)
		},
		execute: async (_args, exec) => {
			const sessionId$22 = exec.agent?.id;
			if (sessionId$22 === void 0) throw new Error("graph_mark_ready: missing agent id");
			const graph = await ctx.graphs.graphForSession(sessionId$22);
			await ctx.graphs.markReady(graph.id);
			return `graph ${graph.id} ready`;
		}
	});
}

//#endregion
//#region src/tools/spawn.ts
function defineSpawnTool(ctx) {
	return defineTool({
		name: "graph_spawn",
		description: "Delegate one task to a new Singularity worker node and wait for its final response.",
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
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args, exec) => {
			const handle = await ctx.agentRuntime.spawn(exec.agent, {
				sessionId: SessionId(randomUUID()),
				name: args.name,
				prompt: [{
					type: "text",
					text: args.task
				}],
				signal: exec.signal
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
			if (event === void 0 || event.type !== "assistant/message") throw new Error(`graph_spawn: worker ${handle.agent.id} produced no response`);
			const result = event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			if (result.length === 0) throw new Error(`graph_spawn: worker ${handle.agent.id} produced no text response`);
			return `Worker ${handle.agent.id} completed:\n${result}`;
		}
	});
}

//#endregion
//#region src/tools/question-call.ts
/** The caller's own session. A call with no live agent has no identity to ask or answer with. */
function questionCaller(exec, tool) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error(`${tool}: missing agent id`);
	return id;
}
/**
* The identity a question call runs under. The registration id is required, not
* defaulted: the whole protocol rests on the body being read back from the
* caller's own message, so a call that cannot name its own `tool/call` is
* refused by name before anything is written or sent.
*/
function questionCall(exec, tool) {
	const caller = questionCaller(exec, tool);
	const callId = exec.callId;
	if (typeof callId !== "string" || callId.length === 0) throw new Error(`${tool}: this call carries no registration id, so the body it would record cannot be cited; a question or an answer is only ever recorded from the message the caller itself wrote`);
	return {
		caller,
		callId
	};
}

//#endregion
//#region src/tools/task-answer.ts
const text$14 = (value) => [{
	type: "text",
	text: value
}];
/** Every parameter this tool declares; anything else is refused by name, before the store is touched. */
const DECLARED$1 = [
	"questionId",
	"requestKey",
	"answer",
	"resolves"
];
/**
* Refuse a call carrying a key this tool does not declare: the asking run is the
* question's own child run, and there is no argument here that could address a
* message, grant a permission or classify the answer.
*/
function undeclared$1(args) {
	const extra = Object.keys(args).filter((key) => !DECLARED$1.includes(key));
	if (extra.length === 0) return void 0;
	return [
		`task_answer rejected: undeclared parameter${extra.length === 1 ? "" : "s"} ${extra.map((key) => `"${key}"`).join(", ")} —`,
		`this tool accepts ${DECLARED$1.join(", ")} and has no argument that names a recipient, an authorization or a category:`,
		"the answer goes to the run that asked the question you name. Nothing was answered and nothing was sent."
	].join(" ");
}
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
			render: (_a, v) => text$14(v)
		},
		execute: async (args, exec) => {
			const refused = undeclared$1(args);
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
				return `task_answer rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return answeredText(outcome);
		}
	});
}

//#endregion
//#region src/tools/task-ask-parent.ts
const text$13 = (value) => [{
	type: "text",
	text: value
}];
/** Every parameter this tool declares; anything else is refused by name, before the store is touched. */
const DECLARED = [
	"requestKey",
	"question",
	"blocking"
];
/**
* Refuse a call carrying a key this tool does not declare — a recipient, a
* parent session, a run id or an authorization above all: the addressee is the
* store's own derivation, and an undeclared key is named rather than ignored.
*/
function undeclared(args) {
	const extra = Object.keys(args).filter((key) => !DECLARED.includes(key));
	if (extra.length === 0) return void 0;
	return [
		`task_ask_parent rejected: undeclared parameter${extra.length === 1 ? "" : "s"} ${extra.map((key) => `"${key}"`).join(", ")} —`,
		`this tool accepts ${DECLARED.join(", ")} and has no argument that names a recipient, a parent or an authorization:`,
		"the question goes to your own task's direct parent, resolved from your run. Nothing was asked and nothing was sent."
	].join(" ");
}
/**
* How one delivery settled, in the caller's words. `unavailable` is not a
* failure and is not reported as one: the intent is durable from the moment the
* store recorded it, so a parent that is not live right now means the message
* arrives when recovery delivers the same identity — never "ask again".
*/
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
		lines.push("This run is now blocked on that answer: writes, shell commands, another decomposition and `task_submit_result` are refused until an answer with `resolves: true` is recorded — a child batch of this run ending does not lift the block, because nothing answers a question on your behalf. Stop the work that would write and end this step — an idle run waiting on this question is not counted as no progress, while the run's own deadline still applies.");
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
			render: (_a, v) => text$13(v)
		},
		execute: async (args, exec) => {
			const refused = undeclared(args);
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
				return `task_ask_parent rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return askedText(outcome);
		}
	});
}

//#endregion
//#region src/tools/task-cancel.ts
const text$12 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$10(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_cancel: missing agent id");
	return id;
}
function renderOutcome$2(outcome) {
	const run = outcome.runId === void 0 ? "" : ` run ${outcome.runId}`;
	const evidence = outcome.evidenceId === void 0 ? "" : ` evidence ${outcome.evidenceId}`;
	return `- ${outcome.taskId}: ${outcome.status}${run}${evidence}`;
}
function defineTaskCancelTool(ctx) {
	return defineTool({
		name: "task_cancel",
		description: "Cancel the batch of child tasks this run is waiting on. The children still in flight are cancelled, the ones that never started are blocked before start, and this run is cancelled with them — a batch that cannot finish is ended here, never left hanging. Only the run whose own batch it is may cancel it, and only while the batch is in flight: a run that already got its execution back holds no batch to cancel, and a run with no batch open is told so and nothing changes. To end work that is not a batch of yours, remove the graph instead.",
		parameters: { reason: {
			type: "string",
			description: "Why the batch is being cancelled; the settlement answer echoes it back to you"
		} },
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$12(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$10(exec);
			const { storeId, run } = await ctx.taskRuntime.runForSession(caller);
			if (run.executionPhase !== "waiting_children" || run.batchId === void 0) return `task_cancel: no batch is in flight for run "${run.runId}" (${run.status}${run.executionPhase === void 0 ? ", no coordination phase recorded" : `, phase ${run.executionPhase}`}); nothing was changed`;
			const batchId = run.batchId;
			let outcomes;
			try {
				outcomes = await ctx.taskRuntime.cancelBatch(storeId, batchId, caller);
			} catch (error) {
				return `task_cancel rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return [`cancelled batch ${batchId}${args.reason === void 0 ? "" : ` (${args.reason})`}:`, ...outcomes.map(renderOutcome$2)].join("\n");
		}
	});
}

//#endregion
//#region src/tools/task-decompose.ts
const text$11 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$9(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_decompose: missing agent id");
	return id;
}
function defineTaskDecomposeTool(ctx) {
	return defineTool({
		name: "task_decompose",
		description: "Decompose the caller's current task into child tasks. The batch is admitted atomically and the runtime then runs them one at a time in dependency order; this call returns at admission and does not wait. Each child is verified independently; only verified children count as done. Where this deployment reviews generated tasks, the batch may instead come back waiting for a human review — nothing is admitted or spawned then, and the answer names the proposal that holds it.",
		parameters: {
			reason: {
				type: "string",
				required: true,
				description: "Why this delegation is needed; recorded in each child handoff"
			},
			contractVersion: {
				type: "integer",
				description: "Contract version this batch is written under. The runtime stores version 1 and refuses a declared version it does not know, so callers normally omit this field and let the runtime write the current version"
			},
			requestKey: {
				type: "string",
				description: "The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime derives one from the calling context and the batch content when this is omitted). One key names at most one proposal: repeating a request with the same key is answered with the proposal already stored, while the same key with different content is refused. A revision is different content, so it needs a new key"
			},
			supersedes: {
				type: "string",
				description: "The proposal id this batch revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the new request key this submission needs"
			},
			children: {
				type: "array",
				required: true,
				description: "Child tasks to admit and run",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						objective: {
							type: "string",
							required: true,
							description: "Complete, self-contained goal of the child task"
						},
						acceptanceCriteria: {
							type: "array",
							required: true,
							description: "How a verifier decides the child is done",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									description: {
										type: "string",
										required: true,
										description: "What must hold true"
									},
									criterionId: {
										type: "string",
										description: "Stable id for this criterion: fixed at admission, and the only id a parent-level childEvidence.criterionId can rely on. Omitted, the runtime generates one from the batch position; declared ids must be unique inside a child. A parent-level childEvidence.criterionId must name an id the child it points to actually declared, which only holds when that child declares the id explicitly here"
									},
									command: {
										type: "string",
										description: "Shell command; exit code 0 proves the criterion (deterministic modes)"
									},
									mode: {
										type: "string",
										enum: [
											"deterministic",
											"simulation",
											"formal",
											"measurement",
											"review",
											"composite"
										],
										description: "Verifier kind; defaults to deterministic when a command is given, review otherwise"
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
										description: "Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product (a verified run carrying a passing verdict) for this criterion to be judgeable; a missing one blocks the child before spawn and registers an obligation"
									},
									acceptsArtifact: {
										type: "array",
										items: { type: "string" },
										description: "Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state. Missing blocks the child before spawn and registers an obligation"
									},
									verifierRef: {
										type: "string",
										description: "Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole batch at admission and the error lists the registered ids. Omit to dispatch by mode."
									},
									childEvidence: {
										type: "array",
										description: "Parent-level evidence map (composite mode only): which member of this run — by 0-based position in the run's accumulated members, every batch it admits in admission order — this criterion rests on, optionally narrowed to a child criterion and an evidence reference. Judged at parent-acceptance time; an incomplete mapping fails the parent naming the missing items",
										items: {
											type: "object",
											additionalProperties: false,
											properties: {
												childIndex: {
													type: "integer",
													required: true,
													description: "0-based position of the member in the run's accumulated members: the batches this run admits, concatenated in admission order, so a later batch appends and never moves an earlier member"
												},
												criterionId: {
													type: "string",
													description: "The child criterion whose passing verdict is required"
												},
												evidenceRef: {
													type: "string",
													description: "The evidence id, artifact kind, or artifact id that must exist in the child's verified run evidence"
												}
											}
										}
									},
									heuristic: {
										type: "boolean",
										description: "Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass. Mutually exclusive with childEvidence"
									},
									protectedInputs: {
										type: "array",
										items: { type: "string" },
										description: "Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. Declare them as paths relative to the task's checkout (an absolute path stays absolute). Admission resolves each one against the session's checkout and fixes the SHA-256 of its bytes before the contract is written — a path that cannot be read refuses the whole batch, and no protected input is ever stored as a bare path. The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed. Only declared paths are protected: a criterion that lists none is not protected and nothing is checked or claimed for it."
									}
								}
							}
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
							description: "Declare that this child should split further instead of doing the work: its worker is told to call task_decompose. Together with a capability gap this decides whether the child is admitted as decomposable."
						},
						requiresIndependentAcceptance: {
							type: "boolean",
							description: "Contract-level marker: this child demands independent parent acceptance — at least one of its acceptance criteria must carry a childEvidence map, or admission refuses the batch. Deleting the map never silently degrades acceptance back to the all-children-verified conjunction"
						}
					}
				}
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$11(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$9(exec);
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
				return `task_decompose rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (continued.status === "admitted") return admittedText(task.taskId, continued.batchId, continued.childTaskIds);
			if (continued.status === "pending_review") return await pendingText$1(ctx, storeId, task.taskId, continued.proposalId, continued.detail);
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
/**
* The batch is admitted, not finished (A3 §3.1): the call returns as soon as the
* atomic commit landed, and the runtime drives the children from there. What the
* caller may do next is not a matter of taste — the phase it is in decides it —
* so the tool states the contract it is now under rather than leaving the model
* to infer it from a status line.
*/
function admittedText(taskId, batchId, childTaskIds) {
	return [
		`decomposed ${taskId} into ${childTaskIds.length} children (batch ${batchId}):`,
		...childTaskIds.map((childTaskId, index) => `- child ${index + 1}: ${childTaskId}`),
		"",
		`The runtime owns batch ${batchId} now: it starts the children one at a time in dependency order and drives the batch to its end. This call returns at admission and does not wait for the batch.`,
		"You are in phase waiting_children: read and query with `task_read`/`task_status` (and diagnose or inspect), or end the batch with `task_cancel`. Writes, shell commands, another decomposition and a submission of your own are refused while the children run — do not start work that would collide with theirs in the shared checkout.",
		"The batch end reaches you as a message naming each child's terminal state and evidence, and it hands your execution back: nothing is submitted on your behalf. Back in phase active you continue your own work, admit another batch with `task_decompose`, or hand this task in yourself with `task_submit_result` — only that submission starts its acceptance."
	].join("\n");
}
/**
* A batch waiting for a human review (T2/T3 §5–§6): the proposal holds the
* whole batch, nothing was admitted, and the caller's next move is not another
* submission — the same request answers with this same proposal. The policy is
* read back from the proposal rather than assumed, because a proposal born under
* `off` and sent to review by a tightened deployment keeps its birth policy on
* the record; when the record cannot be read the text says so instead of
* inventing one.
*/
async function pendingText$1(ctx, storeId, taskId, proposalId, detail) {
	let policy = "unknown — the proposal record could not be read back";
	try {
		policy = `${(await ctx.taskRuntime.proposalIn(storeId, proposalId)).policy}`;
	} catch {}
	return [
		`task_decompose is waiting for a review: proposal ${proposalId} (policy ${policy}) holds this batch, and ${taskId} has not been decomposed.`,
		`- ${detail}`,
		"- No child task exists, no worker was spawned, and this task is not decomposed: the batch is admitted only after the review",
		"  decides and the runtime re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.",
		`- Read the batch as it was recorded with \`task_proposal_read\` (${proposalId}).`,
		"- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime continues the batch",
		"  immediately, so you are notified when it settles.",
		"- A refusal is a fact on the record: revise the batch against its reason (fix the cause, never weaken a criterion or drop a",
		"  mandatory one) and call `task_decompose` again — a revision is new content, hence a new proposal, and you may name the",
		"  refused one with `supersedes`.",
		"- Do not re-submit the same content while it waits: the same request key is answered with this same proposal."
	].join("\n");
}

//#endregion
//#region src/tools/task-diagnose.ts
const text$10 = (value) => [{
	type: "text",
	text: value
}];
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** A non-empty name: what a target type has to be, with no vocabulary to be in. */
function isTargetTypeName(value) {
	return typeof value === "string" && value.trim().length > 0;
}
/**
* Validate the model-supplied proposals into the recorded shape. The target
* type is an **open, non-empty name** (A5): the diagnosis does not own a
* vocabulary, so a suggestion that names a surface no executor exists for is
* recorded like any other — the entry that would convert it into an
* executable proposal is where that name is checked
* (`evolution_propose`'s fromDiagnosis, which refuses what it cannot execute
* with zero ledger writes).
*/
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
function sessionId$8(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_diagnose: missing agent id");
	return id;
}
function defineTaskDiagnoseTool(ctx) {
	return defineTool({
		name: "task_diagnose",
		description: "Record a diagnosis for a task: an explanation of what its reviews show (the postmortem observation, scope, localized cause, confidence), not a score. A diagnosis may conclude that something should improve, that nothing should, or that the evidence does not settle it — the conclusion is recorded as written. Call task_review_pack first and ground every diagnosis in its output — evidenceRefs and reviewRefs must name real evidence ids and the review refs the pack prints; at least one ref is required. proposals are structured suggestions only: they are stored as data and never execute automatically, and their targetType is an open name — nothing here executes a suggestion, and the entry that converts one refuses what it cannot run. Written once per diagnosisId and immutable afterwards.",
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
				description: "Structured suggestions for later Evolution steps; stored as data, never auto-executed",
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
			render: (_a, v) => text$10(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$8(exec);
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
				return `task_diagnose rejected: ${error instanceof Error ? error.message : String(error)}`;
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
const text$9 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$7(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_intake: missing agent id");
	return id;
}
function message(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* The root store's snapshot, or `undefined` when no such store exists yet — the
* pre-intake state §1.1 allows, answered as a state rather than thrown at a
* reader. The store's own word for it is "does not exist"; every other failure
* (a log this process cannot read, a store it cannot open) is the reader's to
* surface and is re-raised unchanged. Read-only: `ctx.task.openStore` is the
* store's own read open.
*/
async function rootSnapshotOrUndefined(ctx, storeId) {
	try {
		return await ctx.task.openStore(storeId);
	} catch (error) {
		if (error instanceof Error && /does not exist/.test(error.message)) return void 0;
		throw error;
	}
}
/**
* Why a root contract is refused, when the store holds no record of it
* (A0 §1.2–§1.6): the three things a caller does not learn from a single
* message, because the message is about one rule and the caller is about to
* decide what to do next. Nothing here restates a rule — the reason is the
* runtime's, printed verbatim — and nothing here claims a record was written.
*/
const NOTHING_WRITTEN_NOTES = [
	"- Nothing was written: no proposal, no root task, no run and no worker. A contract that fails a rule is refused before a record",
	"  exists, so the reason above is the whole diagnosis.",
	"- A store that already holds a root task is never re-intaken, and a root run that reached a terminal state is not revived: an",
	"  existing root is history, and a new goal is a new graph.",
	"- The rule a root contract has that a child contract does not: at least one mandatory criterion judged by something other than the",
	"  composite conjunction. \"All children verified\" restates the decomposition and cannot be the root's only mandatory criterion."
];
/**
* Which of the three this refusal was, from the store's own facts. The record is
* matched exactly: by the caller's request key when it gave one (one key names
* one proposal, and a key bound to other content is refused rather than stored),
* else by the objective *and* the acceptance-criteria descriptions this call
* sent — both stored verbatim. Comparing the whole contract would mean
* normalizing it here, which is the runtime's work and not this tool's.
*/
async function probeRefusedRecord(ctx, storeId, call, requestKey) {
	let snapshot;
	try {
		snapshot = await rootSnapshotOrUndefined(ctx, storeId);
	} catch (error) {
		return {
			kind: "unreadable",
			reason: message(error)
		};
	}
	if (snapshot === void 0) return { kind: "none" };
	const open = openRootProposals(snapshot);
	const criteria = Array.isArray(call.acceptanceCriteria) ? call.acceptanceCriteria : [];
	const matches = (proposal$1) => requestKey !== void 0 ? proposal$1.requestKey === requestKey : proposal$1.contract.objective === call.objective && proposal$1.contract.acceptanceCriteria.length === criteria.length && proposal$1.contract.acceptanceCriteria.every((criterion, index) => criterion.description === criteria[index]?.description);
	const proposal = [...open].reverse().find(matches);
	return proposal === void 0 ? { kind: "none" } : {
		kind: "recorded",
		proposal
	};
}
/**
* The notes one refusal is rendered with, by the path it took. The recorded path
* says what is on the record and how the retry is addressed — the same contract
* is answered by that same proposal, and the continuation that activates a
* recorded root contract is `task_proposal_continue`; the unreadable path claims
* neither, because this call could not tell which of the two it was.
*/
function refusalNotes(record, storeId) {
	if (record.kind === "recorded") {
		const proposal = record.proposal;
		return [
			`- The contract itself was recorded: proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}) is on the record, so the`,
			"  contract was accepted — a proposal is written only after every contract rule has passed — and what failed is the activation:",
			"  the intake records the proposal first and activates it second, and the activation claims the checkout before it commits.",
			"- The record is where a retry continues from: asking again with the same content is answered by that same proposal rather than",
			`  by a second one, and \`task_proposal_continue\` (${proposal.proposalId}) re-checks it and activates the root when the cause is gone.`,
			`- Read the contract as it was recorded with \`task_proposal_read\` (${proposal.proposalId}).`
		];
	}
	if (record.kind === "unreadable") return [
		`- Whether this contract was recorded could not be read back from store ${storeId} (${record.reason}), so this call cannot say which of`,
		"  the two it was: the reason above is what the runtime refused with, and a retry with the same content is answered by the same",
		"  proposal if one is on the record."
	];
	return NOTHING_WRITTEN_NOTES;
}
/**
* The root contract intake (A0 §3 stage C): the one tool that turns a user's
* objective into the graph's root task, and the root session's own action — a
* worker has a task already and cannot intake one (`task_intake` is in
* ROOT_TOOLS only).
*
* The tool normalizes nothing, judges nothing and activates nothing: the whole
* contract is handed to `intakeRootContract`, which is the entry a direct
* service call uses too, and every rule — the closed field set, the
* independent-criterion rule, the capability resolution, the review policy, the
* atomic activation — stays in the runtime. What this file owes the model is
* therefore a *surface*: a schema whose criterion objects are closed, and three
* answers rendered as they are.
*
* What the schema must not do is suggest that a review can be shortcut: the
* deployment's policy decides whether a contract waits, the channel is the only
* writer of a decision, and no parameter here — or anywhere in this tool's
* description — may read as a way to approve one (§7's reverse discipline; the
* same rule `proposal-parameters.ts` enforces for the proposal tools).
*
* The criterion face is the one `task_decompose.ts` declares, with one
* exception: **no `childEvidence`**. A map names positions in a batch, and a
* root contract is submitted before any batch exists — the root's own
* decomposition happens later, so a position declared here could not name
* anything the runtime would ever judge. The schema refuses the key rather than
* letting a model declare a map nothing can check.
*/
function defineTaskIntakeTool(ctx) {
	return defineTool({
		name: "task_intake",
		description: "Accept this root session's contract: the objective the graph works toward, the acceptance criteria a verifier will judge it by, the assumptions and constraints it rests on and the capabilities the work needs. Only the root session of a graph may call this — the contract becomes that session's root task, and a worker's task was admitted by its parent already. The runtime also checks where the contract came from: only a message DSH attests as human input counts, so a session whose own log holds none of the user's is refused — the prompts this deployment writes (the graph setup text, a spawn's delegated task) and the notices it sends are attributed to their producers, not to a person. A delegated child session is refused too, and a contract is never intaken for another session's store. The runtime normalizes and judges the contract first, and one rule is the root's own: at least one mandatory criterion must be judged by something other than the composite conjunction, so \"all children verified\" cannot be the only thing standing behind the goal. Where this deployment reviews contracts, the call then answers with a proposal id and nothing activated; the decision is recorded by the review channel and the runtime activates the contract itself — no parameter of this call approves anything, and a contract waiting for a review has no root task, no run and no worker.",
		parameters: {
			objective: {
				type: "string",
				required: true,
				description: "The goal of this graph, in the user's terms: what has to exist when the work is done. It stays fixed once the contract is accepted, and it is what every later decomposition is judged against. The objective is the user's request, not this graph's name and not the environment setup work"
			},
			acceptanceCriteria: {
				type: "array",
				required: true,
				description: "How the goal is judged, at least one criterion mandatory and aimed at the delivered artifact: a root whose only mandatory criterion is the conjunction of its children has no independent check of the goal it was given",
				items: {
					type: "object",
					additionalProperties: false,
					properties: {
						description: {
							type: "string",
							required: true,
							description: "What must hold true of the delivered artifact"
						},
						criterionId: {
							type: "string",
							description: "Stable id for this criterion; omitted, the runtime generates one from its position (`ac-1`, `ac-2`, …). Declared ids must be unique inside the contract"
						},
						command: {
							type: "string",
							description: "Shell command the verifier runs; exit code 0 proves the criterion (deterministic modes)"
						},
						mode: {
							type: "string",
							enum: [
								"deterministic",
								"simulation",
								"formal",
								"measurement",
								"review",
								"composite"
							],
							description: "Verifier kind; defaults to deterministic when a command is given, review otherwise. `composite` is the conjunction of the children this goal later decomposes into: it may be one of the mandatory criteria, never the only one"
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
							description: "Artifact/evidence kinds or ids that must already exist in the task store as a verified reference product for this criterion to be judgeable; a missing one blocks the run and registers an obligation"
						},
						acceptsArtifact: {
							type: "array",
							items: { type: "string" },
							description: "Artifact/evidence kinds or ids this criterion consumes as a raw input: existence in the task store is the whole requirement, any run state"
						},
						verifierRef: {
							type: "string",
							description: "Registered verifier id that judges this criterion; must exist in the verifier registry — an unknown id rejects the whole contract at intake and the error lists the registered ids. Omit to dispatch by mode."
						},
						heuristic: {
							type: "boolean",
							description: "Label this criterion a heuristic judgement: the verdict is marked as such and never counted as a deterministic pass"
						},
						protectedInputs: {
							type: "array",
							items: { type: "string" },
							description: "Paths of acceptance inputs this criterion depends on that must not be modified by the executing side: acceptance scripts, threshold files, fixtures. Declare them as paths relative to the graph's checkout (an absolute path stays absolute). Intake resolves each one against that checkout and fixes the SHA-256 of its bytes before the contract is written — a path that cannot be read refuses the whole contract, and no protected input is ever stored as a bare path. The verifier then re-reads every declared input before judging and fails the criterion, naming the path, if it is missing or its bytes changed."
						}
					}
				}
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
				description: "Capability names the goal needs; call capability_list first to see the names this deployment can grant. A root contract has nobody above it to delegate a gap to, so a name the registry cannot grant refuses the contract by name rather than being recorded as an obligation"
			},
			contractVersion: {
				type: "integer",
				description: "Contract version this intake is written under. The runtime stores version 1 and refuses a declared version it does not know, so callers normally omit this field and let the runtime write the current version"
			},
			requestKey: {
				type: "string",
				description: "The stable key this request is addressed by, when the caller has an identifier of its own (a message id, a plan row; the runtime derives one from the store, this root session and the contract content when this is omitted). One key names at most one proposal: repeating a request with the same key is answered with the proposal already stored, while the same key with different content is refused. A revision is different content, so it needs a new key"
			},
			supersedes: {
				type: "string",
				description: "The proposal id this contract revises — a rejected or stale one, whose record is kept. Naming it is what lets a reader follow the history; it does not transfer anything from that proposal (an approval never travels to new content) and it does not replace the new request key this submission needs"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$9(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$7(exec);
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
				const recorded = await probeRefusedRecord(ctx, storeId, {
					objective: args.objective,
					acceptanceCriteria: args.acceptanceCriteria
				}, requestKey === void 0 ? void 0 : String(requestKey));
				return [`task_intake rejected: ${message(error)}`, ...refusalNotes(recorded, storeId)].join("\n");
			}
			if (result.status === "activated") return activatedText(caller, result);
			return await pendingText(ctx, storeId, result.proposalId, result.detail);
		}
	});
}
/**
* The contract is live: the ids the activation commit minted, and what the
* session does with them. The last line is the one fact a root can misread —
* having a root task is not having a finished graph — so it is stated rather
* than left to the verifier's later verdict.
*/
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
/**
* The contract waits for a review (A0 §1.3): the proposal holds it, nothing was
* activated, and the caller's next move is not another submission — the same
* request answers with this same proposal. The policy is read back from the
* record rather than assumed, because a proposal born under `off` and sent to
* review by a tightened deployment keeps its birth policy; when the record
* cannot be read the text says so instead of inventing one.
*/
async function pendingText(ctx, storeId, proposalId, detail) {
	let policy = "unknown — the proposal record could not be read back";
	try {
		policy = `${(await ctx.taskRuntime.proposalIn(storeId, proposalId)).policy}`;
	} catch {}
	return [
		`task_intake is waiting for a review: proposal ${proposalId} (policy ${policy}) holds this root contract, and no root task exists.`,
		`- ${detail}`,
		"- Nothing was activated and no worker was spawned: the contract is admitted only after the review decides, and the runtime",
		"  then re-checks it against the limits, the capability resolution and the judging verifiers that were reviewed.",
		`- Read the contract as it was recorded with \`task_proposal_read\` (${proposalId}).`,
		"- An approval needs nothing further from you: the decision is recorded on the proposal and the runtime activates the root",
		"  contract immediately, so `task_read` shows the root task once it is live.",
		"- A refusal is a fact on the record: revise the contract against its reason (fix the cause, never weaken a criterion or drop",
		"  the mandatory independent one) and call `task_intake` again — a revision is new content, hence a new request key and a new",
		"  proposal, and you may name the refused one with `supersedes`.",
		"- Do not re-submit the same content while it waits: the same request key is answered with this same proposal.",
		"- Do not call `task_decompose` before the contract is activated: there is no root task yet, and `task_read` says so."
	].join("\n");
}

//#endregion
//#region src/tools/task-proposal-cancel.ts
const text$8 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$6(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_proposal_cancel: missing agent id");
	return id;
}
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
			render: (_a, v) => text$8(v)
		},
		execute: async (args, exec) => {
			const undeclared$3 = undeclaredParameters(args, ["proposalId"], "task_proposal_cancel");
			if (undeclared$3 !== void 0) return undeclared$3;
			const caller = sessionId$6(exec);
			const { storeId } = await ctx.taskRuntime.runForSession(caller);
			try {
				return [`${(await ctx.taskRuntime.cancelProposal(storeId, args.proposalId, caller)).detail}`, "The record is kept: a cancelled proposal is a fact, and a revision is a new proposal with its own request key."].join("\n");
			} catch (error) {
				return `task_proposal_cancel rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/proposal-store.ts
/** The store one proposal call belongs to; see the module doc. */
async function proposalStoreFor(ctx, sessionId$22) {
	const resolution = await ctx.singularityContext.resolveCaller(sessionId$22);
	if (resolution.kind === "worker" || resolution.kind === "root") return resolution.storeId;
	throw new Error(`task-runtime: no task run is bound to session "${sessionId$22}"`);
}

//#endregion
//#region src/tools/task-proposal-continue.ts
const text$7 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$5(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_proposal_continue: missing agent id");
	return id;
}
/**
* What one continuation settled, in the terms the caller acts on. A waiting
* proposal is **not** an error and this text says so: the batch stays exactly
* where it is, no child was created and nothing was spawned, and the caller
* keeps working (or ends its turn) rather than asking again — a repeat of the
* same request is answered by the same proposal.
*
* A root contract continued here is reported as what it is (A0 §2): the runtime
* created the root task and its run, so the ids are named rather than folded
* into the batch vocabulary. Nothing about a batch was admitted, and saying so
* is the point — a reader that took this arm for an admission would go looking
* for children that do not exist.
*/
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
			render: (_a, v) => text$7(v)
		},
		execute: async (args, exec) => {
			const undeclared$3 = undeclaredParameters(args, ["proposalId"], "task_proposal_continue");
			if (undeclared$3 !== void 0) return undeclared$3;
			const caller = sessionId$5(exec);
			let continuation;
			try {
				const storeId = await proposalStoreFor(ctx, caller);
				continuation = await ctx.taskRuntime.continueProposal(storeId, args.proposalId, caller, { ...typeof exec.callId === "string" && exec.callId.length > 0 ? { exec: { callId: String(exec.callId) } } : {} });
			} catch (error) {
				return `task_proposal_continue rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return renderContinuation(continuation);
		}
	});
}

//#endregion
//#region src/tools/task-proposal-read.ts
const text$6 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$4(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_proposal_read: missing agent id");
	return id;
}
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
/**
* The payload digest and the two context fingerprints, as every reader of a
* record needs them. `subject` names what the digest is of — a batch and a root
* contract are both read through this tool, and calling a contract's digest a
* batch digest would mislabel the number a decision binds.
*/
function digestLines(proposal, subject) {
	return [
		`${subject} digest (sha256): ${proposal.proposalDigest}`,
		`admission context digest: ${proposal.admissionContextDigest} (maxDepth ${proposal.admissionContext.maxDepth}, maxChildren ${proposal.admissionContext.maxChildren}${proposal.admissionContext.wallTimeMs === void 0 ? "" : `, wallTimeMs ${proposal.admissionContext.wallTimeMs}`})`,
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
/**
* One saved root contract proposal: the session it is the goal of, the contract
* itself rather than a child batch — there is no parent task and no batch to
* print — the decision and the root task it became.
*/
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
/**
* One saved proposal, as the record holds it — the whole batch, or the whole
* root contract, not a summary, and nothing that is not on the record. There is
* no argument for a status: the answer is the store's.
*/
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
			render: (_a, v) => text$6(v)
		},
		execute: async (args, exec) => {
			const undeclared$3 = undeclaredParameters(args, ["proposalId"], "task_proposal_read");
			if (undeclared$3 !== void 0) return undeclared$3;
			const caller = sessionId$4(exec);
			try {
				const storeId = await proposalStoreFor(ctx, caller);
				return renderProposal(await ctx.taskRuntime.proposalIn(storeId, args.proposalId));
			} catch (error) {
				return `task_proposal_read rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/task-read.ts
const text$5 = (value) => [{
	type: "text",
	text: value
}];
function defineTaskReadTool(ctx) {
	return defineTool({
		name: "task_read",
		description: "Read the caller's task contract. The root session sees the root task, its acceptance criteria, and child task statuses — or, before any root contract has been accepted, the named not-activated state together with whatever proposal is still open (the graph's name is never shown as an objective). A worker sees its own task and run. A reviewer sees the task it was delegated to review, marked review-only. A run line carries the coordination phase this run is in — and the id of the batch it is still waiting on, its submission and any no-progress marking when it has them; a run that returned to active waits on no batch, though its record keeps every batch it ended. A run with no phase is an old record and is shown as needs-recovery. This is the same read the worker's assembled context is projected from, so the two cannot disagree.",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$5(v)
		},
		execute: async (_args, exec) => {
			const caller = callerSessionId(exec, "task_read");
			return adaptRead("task_read", await ctx.singularityContext.taskRead(caller, exec.signal));
		}
	});
}

//#endregion
//#region src/tools/task-recover.ts
const text$4 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$3(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_recover: missing agent id");
	return id;
}
/** What one answer says: the attempt, the run it opened or already had, and what the coordination checked. */
function renderOutcome$1(outcome) {
	return [
		`task_recover: ${outcome.attempt === "started" ? "a new attempt was opened" : "this key already named an attempt"} for diagnosis ${outcome.sourceDiagnosisId} — run ${outcome.runId} (session ${outcome.sessionId}) is ${outcome.status}`,
		`hand-off: delegated by session ${outcome.handoff.actor} to supervisor ${outcome.handoff.sessionId}`,
		...outcome.coordination.map((line) => `- ${line}`),
		outcome.reusedMembers.length === 0 ? "the attempt re-runs the work; no already-verified sibling was cited" : `the attempt reads ${outcome.reusedMembers.length} already-verified sibling member(s) at position(s) ${outcome.reusedMembers.map((member) => member.childIndex).join(", ")}`,
		...outcome.unboundMembers.length === 0 ? [] : [`${outcome.unboundMembers.length} position(s) whose passed sibling could not be bound are done again, with the reasons on the attempt's own record: ` + outcome.unboundMembers.map((entry) => `#${entry.childIndex} (${entry.reasons.join("; ")})`).join(", ")],
		"the original acceptance criteria judge the new attempt, the old failure stays readable, and the store total it spends is the same one"
	].join("\n");
}
function defineTaskRecoverTool(ctx) {
	return defineTool({
		name: "task_recover",
		description: "Open a new attempt at a failed root goal (a new root Run/Session in the same store), for ONE recorded Diagnosis of that same store. Available to the trusted supervisor coordination session a hand-off was delegated to and to no one else: the caller is read from the live session and checked against the delegation the deployment recorded, so a root, a worker, a reviewer or another graph's supervisor cannot use it, and no authorization is ever passed as an argument. Every rule is re-checked below this tool: the evolution plane verifies that a capability change this diagnosis stands on is approved and applied (an unapproved, undecided or rolled-back capability means nothing is opened), and the task runtime re-reads the store's own facts — the failed source, the original contract and criteria, the providers the attempt needs now, the ceilings in force and the attempt's own idempotency — before it writes. A successful source is never recovered (a \"faster or cheaper\" suggestion has no frozen comparator in this build), an in-flight run is never hot-swapped, and a second key while an attempt of the same diagnosis is in flight is refused by name. Repeating the same call returns the attempt that key already names instead of starting another; a pure artifact gap needs no proposal and no approval.",
		parameters: {
			sourceDiagnosisId: {
				type: "string",
				required: true,
				description: "The recorded Diagnosis this attempt is for"
			},
			requestKey: {
				type: "string",
				required: true,
				description: "Non-empty key of this attempt: one key names one attempt, and a repeat of it returns that attempt"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$4(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$3(exec);
			try {
				return renderOutcome$1(await ctx.evolution.coordinateRecovery({
					sourceDiagnosisId: args.sourceDiagnosisId,
					requestKey: args.requestKey
				}, {
					sessionId: caller,
					signal: exec.signal
				}));
			} catch (error) {
				return `task_recover rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
	});
}

//#endregion
//#region src/tools/review-agent.ts
const text$3 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$2(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_review_agent: missing agent id");
	return SessionId(id);
}
/** A free-text argument, or `null` when the caller gave none: empty and whitespace-only read as none. */
function optionalText(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}
/** How one attempt is named in a result, in the words the source's caller uses. */
function attemptLabel(attempt) {
	return attempt.requestKey === null ? "default attempt" : `requestKey "${attempt.requestKey}"`;
}
/**
* What one attempt the caller asked for already is: its identity, how it ended,
* and — when it recorded a judgement — the same lines the attempt's own call
* returned. A repeat is answered from the ledger and the store; nothing is
* spawned and nothing is written (beyond the recovery note the admission may
* have just appended for an attempt that never reached model input).
*/
function renderExistingAttempt(attempt, snapshot) {
	const diagnosis = recordedDiagnosis(snapshot, attempt.sessionId);
	const status = attempt.settlement?.status ?? (diagnosis === void 0 ? "started" : "recorded");
	const head = `task_review_agent: source ${sourceRef(attempt.source)} already has this attempt (${attemptLabel(attempt)}, session ${attempt.sessionId}, ${status}${attempt.settlement?.note === void 0 ? "" : `: ${attempt.settlement.note}`}) — returning it; no review agent started`;
	if (diagnosis === void 0) return status === "interrupted" ? `${head}; a new review for this source needs an explicit requestKey` : `${head}; its diagnosis is not in the store`;
	const lines = [
		head,
		`observation: ${diagnosis.observedFailure}`,
		`conclusion: ${diagnosis.localizedCause}`
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
/**
* What one request that arrived while an attempt was open is answered with.
*
* Only one state reaches this text: an attempt this process is really running
* right now. An attempt a dead process left is recovered inside the admission's
* region before the request is decided, so it can never be reported here as
* something in flight — and never written off for being slow, either.
*/
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
			...outcome.judgements.length === 0 ? [] : [`judgements (agent ${outcome.sessionId}):`, ...renderJudgements(outcome.judgements)],
			`diagnosis ${outcome.diagnosisId} recorded [${outcome.confidence}]`,
			...outcome.proposals.length === 0 ? ["proposals: none — the conclusion carries no suggestion"] : [`proposals (${outcome.proposals.length}, suggestions only — none auto-executes):`, ...outcome.proposals.map((item) => `- ${item.targetType} ${item.targetId}: ${item.rationale}`)]
		].join("\n");
	}
}
function defineTaskReviewAgentTool(ctx) {
	return defineTool({
		name: "task_review_agent",
		description: "Spawn ONE read-only review agent for one exact review source — a task and the run under review, or runId null for a review that carries no run (a task blocked before it started) — take the diagnosis it produces, and persist it as a Diagnosis. The reviewer reads the review pack and, beyond it, whatever settles the question through its own context reads. What it returns is an observation (the postmortem observation — what really happened, for a successful source as much as a failed one), a conclusion in its own words (\"no improvement needed\" and \"the evidence does not settle this\" are conclusions), a confidence, and — only when it made them — judgements and proposals. A judgement names one of the dimensions no parser settles (task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency) with verdict adequate|inadequate|unknown, the refs it rests on and a rationale; judgements are optional and never padded, and a judgement that cites nothing is refused rather than downgraded. A proposal is a suggestion only: it names a target type the diagnosis does not freeze, and nothing here executes it. reason names what the review should focus on. A reviewer that times out, is cancelled, or answers without a diagnosis leaves an interrupted attempt with the reason named and records no Diagnosis. One source has one default attempt: a repeat of the same call (an automatic scan and an explicit call share it) returns that attempt and its result instead of starting another, and never spends the budget again. Reviewing the same source again after that attempt ended is an explicit act: pass a new non-empty requestKey, which is persisted with the source and the focus; the same key with a different reason is refused. While an attempt of the source is in flight the call returns its identity and starts nothing. The reviewer has no write, shell, spawn, or evolution tool, is capped per root store (default 1), and is cancelled by a watchdog if it overruns.",
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
			},
			timeoutMs: {
				type: "number",
				description: `Watchdog deadline in milliseconds; defaults to ${REVIEW_AGENT_TIMEOUT_MS}`
			}
		},
		output: {
			schema: { type: "string" },
			render: (_a, v) => text$3(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$2(exec);
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
				...args.timeoutMs === void 0 ? {} : { timeoutMs: args.timeoutMs },
				signal: exec.signal
			}), source, storeId, snapshot, review);
		}
	});
}

//#endregion
//#region src/tools/task-status.ts
const text$2 = (value) => [{
	type: "text",
	text: value
}];
function defineTaskStatusTool(ctx) {
	return defineTool({
		name: "task_status",
		description: "The caller's project status, paged. Scope `related` (the default) covers the caller's own task, its direct children and the tasks directly adjacent to it through a dependency edge; scope `graph` is the whole domain overview, sorted by task id. Each line carries the task status, its latest run with its coordination phase (a phase-less non-terminal run reads needs-recovery), evidence ids, the terminal review outcome and the diagnosis count. Entries are sorted by task id and paged with `offset` (from 0) and `limit` (default 20, at most 100); the answer states whether more entries follow and the offset to continue with. Pages are observations, not a consistent snapshot across calls. Before any root contract has been accepted the answer is the named not-activated state (with whatever proposal is still open).",
		parameters: {
			scope: {
				type: "string",
				enum: ["related", "graph"],
				description: "related (default): the caller's own task, its direct children and its direct dependency neighbours; graph: every task in the domain"
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
			render: (_a, v) => text$2(v)
		},
		execute: async (args, exec) => {
			const caller = callerSessionId(exec, "task_status");
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
const text$1 = (value) => [{
	type: "text",
	text: value
}];
function sessionId$1(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_submit_result: missing agent id");
	return id;
}
function defineTaskSubmitResultTool(ctx) {
	return defineTool({
		name: "task_submit_result",
		description: "Hand in this run's result for acceptance. This is the explicit submission the coordination protocol is built on: it records what was delivered (summary, plus the evidence/artifact references you produced), closes admission for this run — no further write, command or decomposition is admitted — drains the calls still in flight, and hands the run to the verifier. The call returns the verdict. An idle session is not a completion: a worker that goes idle without submitting gets one reminder and is stopped by the no-progress budget if it still has not submitted. A run waiting on its own child batch cannot submit; the batch end hands the run back to `active` with nothing submitted for it, and that submission is then yours to make.",
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
			render: (_a, v) => text$1(v)
		},
		execute: async (args, exec) => {
			const caller = sessionId$1(exec);
			let result;
			try {
				result = await ctx.taskRuntime.submitResult(caller, args, { ...typeof exec.callId === "string" && exec.callId.length > 0 ? { callId: String(exec.callId) } : {} });
			} catch (error) {
				return `task_submit_result rejected: ${error instanceof Error ? error.message : String(error)}`;
			}
			return `task_submit_result ${result.status}: ${result.detail}`;
		}
	});
}

//#endregion
//#region src/tools/task-verify.ts
const text = (value) => [{
	type: "text",
	text: value
}];
function sessionId(exec) {
	const id = exec.agent?.id;
	if (typeof id !== "string" || id.length === 0) throw new Error("task_verify: missing agent id");
	return id;
}
function softService(ctx, name) {
	return ctx.get?.(name) ?? ctx[name];
}
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
			const caller = sessionId(exec);
			const verifier = softService(ctx, "verifier");
			if (verifier === void 0 || typeof verifier.verifyRun !== "function") throw new Error("task_verify: verifier service is not loaded");
			const { storeId, task, run } = await ctx.taskRuntime.runForSession(caller);
			if (run.status !== "running") return `task_verify: run ${run.runId} of task ${task.taskId} is ${run.status}; evidence can only be recorded while the run is running`;
			let cwd;
			try {
				const graph = await ctx.graphs.graphForSession(caller);
				cwd = softService(ctx, "envBuilder")?.store.get(graph.envId).path;
			} catch {
				cwd = void 0;
			}
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
/**
* The shipped switch position: `off`.
*
* The default run is the one nobody configured, and R0 asks that this run not
* carry the evolution chain (guide §1.3: "默认运行只提供当前角色需要的能力").
* `on` is therefore an explicit act by a deployment, and what it resolved to is
* readable back from the context ({@link EvolutionExposure}) — a switch whose
* position cannot be read is one nobody can tell from an unwired exposure.
*/
const DEFAULT_EVOLUTION = "off";
const ConfigSchema = z.object({ evolution: z.union([z.const("off"), z.const("on")]).default(DEFAULT_EVOLUTION) });
/**
* The evolution exposure this composition resolved, provided on the agent's own
* fiber as `ctx.singularityEvolution`.
*
* The registration gate in {@link SingularityAgent} is the enforcement; this
* service is the fact a sibling assembly reads to keep its own surface in step
* — the root agent's tool allow-list names these nine names and has to leave
* them out when they were never registered. Read it softly:
*
* ```ts
* const evolution = ctx.get('singularityEvolution')?.enabled ?? false
* ```
*
* A composition that does not mount this plugin provides no such service, and
* that absence reads as the closed state: a deployment that never turned the
* chain on must not be assembled as if it had.
*/
var EvolutionExposure = class extends Service {
	/** `true` when `Config.evolution` is `on`, i.e. the nine `evolution_*` tools are registered. */
	enabled;
	constructor(ctx, enabled) {
		super(ctx, "singularityEvolution");
		this.enabled = enabled;
	}
};
/**
* The harness repo root this composition passes to the evolution ledger: the
* base of its `$DSH_HOME` fallback (`<repoRoot>/.dsh`), of the production
* `config.yml` default, and of relative evidence refs.
*
* It is computed here because the ledger used to sit at this same source depth
* and derive it (`new URL('../../../../', import.meta.url)` from
* `agent-singularity/src`); the evolution package does not, so passing the
* value in keeps every default root byte-for-byte where it was.
*/
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/**
* The model selection the evolution plane freezes with an experiment and
* re-reads before a promotion (see `Config.modelSelection` of the evolution
* service).
*
* One source for both ends: the deployment's own default selection
* (`agentDefaultModel.currentSelection()`), which is the configuration a session
* without an explicit selection runs under — and the selection every replay the
* runtime spawns for an experiment is now placed under verbatim. The experiment
* tool freezes exactly this value, so the selection a report is frozen under is
* the one the gate later re-checks against the runs' own session logs; a
* deployment that mounts no such service answers `undefined`, and the ledger
* then refuses to evaluate or promote rather than skipping the check.
*/
function deploymentModelSelection(ctx) {
	const defaults = optionalService(ctx, "agentDefaultModel");
	try {
		return modelSelectionOf(defaults?.currentSelection());
	} catch {
		return;
	}
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
	/**
	* The evolution ledger this assembly owns — kept as a field because the startup
	* reconciliation (`[Service.init]`, below) settles its open commit intents
	* before this plugin becomes ready, whether or not the deployment registered the
	* nine tools.
	*/
	evolution;
	constructor(ctx, config) {
		super(ctx, "singularityAgent");
		this.assertClosedConfig(config);
		const evolution = this.resolveEvolution(config);
		ctx.plugin(HitlService);
		this.evolution = new EvolutionService(ctx, {
			repoRoot: REPO_ROOT,
			modelSelection: () => deploymentModelSelection(ctx),
			supervisorDelegation: supervisorDelegationSource().read,
			capabilityConfig: join(REPO_ROOT, "config.yml")
		});
		new EscalationService(ctx);
		new ProposalReviewService(ctx);
		new EvolutionExposure(ctx, evolution === "on");
		ctx.effect(() => ctx.singularityContext.registerReviewerBindingSource(reviewerBindingSource()), "singularityAgent: reviewer binding source");
		ctx.effect(() => installReviewAgentAutoTrigger(ctx), "singularityAgent: review agent auto trigger");
		ctx.effect(() => installSupervisorHandoffTrigger(ctx), "singularityAgent: supervisor hand-off trigger");
		ctx.effect(() => ctx.taskRuntime.registerRootBudgetApproval(defineRootBudgetApproval(ctx)), "singularityAgent: root budget approval");
		ctx.tools.register(defineMarkReadyTool(ctx));
		ctx.tools.register(defineSpawnTool(ctx));
		ctx.tools.register(defineAskTool(ctx));
		ctx.tools.register(defineApproveTool(ctx));
		ctx.tools.register(defineTaskReadTool(ctx));
		ctx.tools.register(defineCapabilityListTool(ctx));
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
		ctx.tools.register(defineTaskRecoverTool(ctx));
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
	/**
	* The startup reconciliation (K2): before this plugin is ready — and whatever
	* the tool switch says — every commit intent the ledger left open is settled
	* against what production actually holds. The switch is a statement about the
	* model surface, not about recovery: an `off` deployment registers none of the
	* nine tools, and still keeps production consistent with its own ledger.
	*
	* A `blocked` intent is reported by name and does not fail the load: the intent
	* stays open, the admission gate keeps refusing the provider whose directory it
	* names, and settling it (a retry of the apply/rollback, the next startup)
	* remains the way forward. A failure of the reconciliation itself is not
	* `blocked` and does fail the load, naming the cause: a deployment that cannot
	* read its ledger cannot promise anything about the production behind it.
	*/
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
	/**
	* Refuse a configuration member this plugin does not read. The schema keeps
	* unknown keys on the object it validates, so this is where a caller's typo
	* is caught: a misspelled member would otherwise read as a configuration that
	* took effect while the switch stayed at its default.
	*/
	assertClosedConfig(config) {
		if (config === void 0) return;
		const known = new Set(["evolution"]);
		const unknown = Object.keys(config).filter((key) => !known.has(key));
		if (unknown.length === 0) return;
		throw new Error(`singularity-agent: the configuration names [${unknown.join(", ")}], which this plugin does not read; a member nobody reads refuses to start rather than being silently ignored`);
	}
	/**
	* The switch position this assembly acts on. The schema types the member, but
	* a deployment that constructs this plugin directly (a test, an embedding
	* process) bypasses the schema, and a near miss must not be read as "not on,
	* therefore off": a caller who asked for something this build does not
	* implement would get the closed composition while believing otherwise.
	*/
	resolveEvolution(config) {
		const value = config?.evolution;
		if (value === void 0) return DEFAULT_EVOLUTION;
		if (value === "off" || value === "on") return value;
		throw new Error(`singularity-agent: evolution is ${JSON.stringify(value)}; it is "off" or "on" (a switch this build cannot execute refuses to start rather than assembling an exposure nobody chose)`);
	}
	/**
	* Report a fact nobody should read as a startup failure — the same soft logger
	* the task runtime uses, so a deployment that mounts no logger still gets the
	* line rather than an exception about it.
	*/
	warn(message$2) {
		const logger = this.ctx.logger;
		logger?.("singularity-agent").warn(message$2);
	}
};
var src_default = SingularityAgent;

//#endregion
export { DEFAULT_EVOLUTION, ESCALATION_TRIGGERS, EscalationService, EvolutionExposure, HitlService, ProposalReviewService, SingularityAgent, src_default as default, deploymentModelSelection, ownerSessionOfStore, renderProposalReview, reviewDecider };