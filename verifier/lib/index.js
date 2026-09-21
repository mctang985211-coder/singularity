import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

//#region src/command-verifier.ts
const EXECUTABLE_MODES = [
	"deterministic",
	"simulation",
	"measurement"
];
/**
* Kill the command and everything it started. `shell: true` spawns a shell that
* forks compound commands (`a && b`): killing the shell alone leaves those
* grandchildren alive and holding the stdio pipes open, so `close` — and with
* it the timeout verdict — would still wait for them to finish on their own.
* `detached: true` makes the shell a process-group leader, so the negative-pid
* kill reaches the whole tree. Platforms without process groups fall back to
* killing the shell.
*/
function killTree(child) {
	if (child.pid === void 0) return;
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}
function runCommand(command, cwd, timeoutMs, logPath) {
	return new Promise((resolveOutcome) => {
		const child = spawn(command, {
			cwd,
			shell: true,
			detached: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		const log = createWriteStream(logPath);
		child.stdout.pipe(log, { end: false });
		child.stderr.pipe(log, { end: false });
		let timedOut = false;
		let settled = false;
		const timer = timeoutMs === void 0 ? void 0 : setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, timeoutMs);
		const finish = (outcome) => {
			if (settled) return;
			settled = true;
			if (timer !== void 0) clearTimeout(timer);
			log.end(() => resolveOutcome(outcome));
		};
		child.on("error", (error) => finish({ error }));
		child.on("close", (code) => finish(code === null ? { timedOut } : {
			exitCode: code,
			timedOut
		}));
	});
}
function logFileName(criterionId) {
	return `${criterionId.replace(/[^A-Za-z0-9._-]/g, "_")}.log`;
}
/**
* Runs each criterion's `command` through a shell in the request cwd and
* judges by exit code. Combined stdout+stderr goes to
* `<logDir>/<criterionId>.log`; results reference it relative to evidenceRoot.
*/
var CommandVerifier = class {
	id = "command";
	version = "1";
	owner = "singularity";
	/** Known samples the package tests execute for real: `true` must pass, `false` must fail (KISS §12 step 2). */
	selftest = {
		positiveCases: ["true"],
		negativeCases: ["false"]
	};
	constructor(evidenceRoot) {
		this.evidenceRoot = evidenceRoot;
	}
	supports(mode) {
		return EXECUTABLE_MODES.includes(mode);
	}
	async verify(req) {
		return Promise.all(req.criteria.map((criterion) => this.runCriterion(req, criterion)));
	}
	async runCriterion(req, criterion) {
		const base = {
			criterionId: criterion.criterionId,
			verifierId: this.id,
			command: criterion.command
		};
		if (criterion.command === void 0 || criterion.command.trim() === "") return {
			...base,
			status: "inconclusive",
			details: "criterion has no command",
			unknownKind: "task"
		};
		await mkdir(req.logDir, { recursive: true });
		const logPath = join(req.logDir, logFileName(criterion.criterionId));
		const logRef = relative(this.evidenceRoot, logPath);
		const outcome = await runCommand(criterion.command, req.cwd, req.timeoutMs, logPath);
		if (outcome.error !== void 0) return {
			...base,
			status: "inconclusive",
			logRef,
			details: outcome.error.message,
			unknownKind: "task"
		};
		if (outcome.timedOut === true) return {
			...base,
			status: "inconclusive",
			logRef,
			details: `timeout after ${req.timeoutMs}ms`,
			unknownKind: "task"
		};
		return {
			...base,
			status: outcome.exitCode === 0 ? "pass" : "fail",
			exitCode: outcome.exitCode,
			logRef
		};
	}
};

//#endregion
//#region src/composite-verifier.ts
/** How one map entry reads when it is satisfied. */
function describeSatisfied(entry, child) {
	const who = `child #${entry.childIndex} (${child.taskId})`;
	if (entry.criterionId !== void 0) return `${who} criterion "${entry.criterionId}" passed`;
	if (entry.evidenceRef !== void 0) return `${who} evidence "${entry.evidenceRef}" present`;
	return `${who} verified`;
}
/** How one map entry reads when it is missing — the reason names the item verbatim. */
function describeEntry(entry) {
	const parts = [`child #${entry.childIndex}`];
	if (entry.criterionId !== void 0) parts.push(`criterion "${entry.criterionId}"`);
	if (entry.evidenceRef !== void 0) parts.push(`evidence "${entry.evidenceRef}"`);
	return parts.join(" ");
}
/**
* The defect one map entry carries against the store, or `undefined` when the
* entry is satisfied. Every branch is a store fact: the child exists in the
* batch, sits in the verified terminal state, and — for the narrowed spellings
* — the child's *verified run* evidence carries the passing verdict and the
* named reference. Evidence an earlier failed run produced is an expired
* reference and never satisfies an entry.
*/
function entryDefect(entry, children, snapshot) {
	const child = children[entry.childIndex];
	if (child === void 0) return `child #${entry.childIndex} does not exist (the decomposition batch has ${children.length} children)`;
	if (child.status !== "verified") return `child #${entry.childIndex} (${child.taskId}) is ${child.status}, not verified`;
	const verifiedRun = snapshot.runs.find((run) => run.taskId === child.taskId && run.status === "verified");
	const bundles = snapshot.evidence.filter((item) => item.taskRunId === verifiedRun?.runId);
	if (entry.criterionId !== void 0) {
		const criterion = child.acceptanceCriteria.find((item) => item.criterionId === entry.criterionId);
		if (criterion === void 0) return `child #${entry.childIndex} (${child.taskId}) has no criterion "${entry.criterionId}"`;
		if (criterion.heuristic === true) return `child #${entry.childIndex} (${child.taskId}) criterion "${entry.criterionId}" is heuristic, not deterministic evidence`;
		const verdict = bundles.flatMap((item) => item.verifierResults).find((item) => item.criterionId === entry.criterionId);
		if (verdict?.status !== "pass") return `child #${entry.childIndex} (${child.taskId}) criterion "${entry.criterionId}" has no passing verdict in its verified run's evidence` + (verdict === void 0 ? "" : ` (verdict ${verdict.status})`);
	}
	if (entry.evidenceRef !== void 0) {
		if (!new Set(bundles.flatMap((item) => [item.evidenceId, ...item.artifacts.flatMap((artifact) => [artifact.kind, artifact.artifactId])])).has(entry.evidenceRef)) return `child #${entry.childIndex} (${child.taskId}) evidence does not contain "${entry.evidenceRef}" (evidence id, artifact kind, or artifact id)`;
	}
}
/**
* Judges a composite criterion. The default is the child-status conjunction
* (pass iff the task has at least one child and every child is verified),
* unchanged for criteria that declare nothing.
*
* A criterion carrying a {@link AcceptanceCriterion.childEvidence} map is
* judged by the map as well: every entry must resolve against the store, and an
* incomplete mapping fails the criterion with the missing items named — the
* conjunction alone can never pass a parent whose root goal rests on evidence
* the children did not produce (KISS §6 C2). A criterion labeled
* {@link AcceptanceCriterion.heuristic} keeps the conjunction verdict but
* carries the explicit heuristic label in its details, so a natural-language
* coverage signal is never mistaken for a mechanical proof (KISS §5.1).
*
* Reading children and evidence needs the store id, which VerifyRequest does
* not carry, so the registry dispatches through {@link verifyIn}; the plain
* `verify` stays inconclusive.
*/
var CompositeVerifier = class {
	id = "composite";
	version = "1";
	owner = "singularity";
	/**
	* The distinguishing samples need a task store (the verdict reads child
	* status), so they live in this package's tests:
	* `tests/unit/composite-verifier.spec.ts` runs both.
	*/
	selftest = {
		positiveCases: ["a task whose children are all verified (composite-verifier.spec.ts)"],
		negativeCases: ["a task with an unverified child (composite-verifier.spec.ts)"]
	};
	constructor(task) {
		this.task = task;
	}
	supports(mode) {
		return mode === "composite";
	}
	async verify(req) {
		return req.criteria.map((criterion) => ({
			criterionId: criterion.criterionId,
			status: "inconclusive",
			verifierId: this.id,
			details: "composite verification requires store context"
		}));
	}
	async verifyIn(storeId, req) {
		const children = await this.task.childrenIn(storeId, req.taskId);
		const results = [];
		for (const criterion of req.criteria) results.push(await this.judge(storeId, criterion, children));
		return results;
	}
	async judge(storeId, criterion, children) {
		const map = criterion.childEvidence ?? [];
		const base = {
			criterionId: criterion.criterionId,
			verifierId: this.id
		};
		if (children.length === 0) {
			if (map.length === 0) return {
				...base,
				status: "inconclusive",
				details: "no child tasks"
			};
			return {
				...base,
				status: "fail",
				details: `incomplete childEvidence map: the task has no child tasks to satisfy ${map.map(describeEntry).join("; ")}`
			};
		}
		const unverified = children.filter((child) => child.status !== "verified");
		if (unverified.length > 0) return {
			...base,
			status: "fail",
			details: `unverified children: ${unverified.map((child) => `${child.taskId}(${child.status})`).join(", ")}`
		};
		if (map.length === 0) return {
			...base,
			status: "pass",
			...criterion.heuristic === true ? { details: "heuristic conjunction: every child verified — explicitly labeled heuristic (KISS §5.1); a conjunction is a coverage signal, not a deterministic proof of the parent goal, and is not counted as one" } : {}
		};
		const snapshot = await this.task.snapshotIn(storeId);
		const defects = map.map((entry) => entryDefect(entry, children, snapshot)).filter((defect) => defect !== void 0);
		if (defects.length > 0) return {
			...base,
			status: "fail",
			details: `incomplete childEvidence map: ${defects.join("; ")}`
		};
		return {
			...base,
			status: "pass",
			details: `childEvidence satisfied: ${map.map((entry) => describeSatisfied(entry, children[entry.childIndex])).join("; ")}`
		};
	}
};

//#endregion
//#region src/review-verifier.ts
const REVIEW_MODES = ["review", "formal"];
/** Placeholder for human judgment: never auto-passes. */
var ReviewVerifier = class {
	id = "review";
	version = "1";
	owner = "singularity";
	/**
	* This verifier judges nothing by design — a human does — so the one
	* distinction its selftest can prove is the negative one: a known-good
	* sample still comes back inconclusive, never an auto-pass. The package
	* tests execute exactly that sample.
	*/
	selftest = {
		positiveCases: ["a known-good review criterion still returns inconclusive (never auto-pass)"],
		negativeCases: []
	};
	supports(mode) {
		return REVIEW_MODES.includes(mode);
	}
	async verify(req) {
		return req.criteria.map((criterion) => ({
			criterionId: criterion.criterionId,
			status: "inconclusive",
			verifierId: this.id,
			details: "manual review required"
		}));
	}
};

//#endregion
//#region src/index.ts
/** Caps for the log-tail excerpt a review record carries: enough to read the failure, small enough to keep a record lean. */
const LOG_TAIL_MAX_LINES = 40;
const LOG_TAIL_MAX_CHARS = 2048;
/** Read window for large logs: the tail of a failure lives at the end of the file. */
const LOG_TAIL_READ_BYTES = 64 * 1024;
function defaultEvidenceRoot() {
	const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
	return join(process.env.DSH_HOME ?? join(repoRoot, ".dsh"), "task-evidence");
}
var VerifierRegistry = class extends Service {
	static inject = ["task"];
	static Config = z.object({ evidenceRoot: z.string() });
	/** Absolute evidence root resolved at construction. */
	evidenceRoot;
	verifiers = /* @__PURE__ */ new Map();
	composite;
	constructor(ctx, config = {}) {
		super(ctx, "verifier");
		this.evidenceRoot = resolve(config.evidenceRoot ?? defaultEvidenceRoot());
		this.register(new CommandVerifier(this.evidenceRoot));
		this.composite = new CompositeVerifier(ctx.task);
		this.register(this.composite);
		this.register(new ReviewVerifier());
	}
	/**
	* Add a verifier; later registrations win mode dispatch. Returns the
	* disposer. A registration without a `selftest` (KISS §4.3) is logged as a
	* warning, not refused — soft until every built-in verifier carries one,
	* so existing test doubles keep registering; flipping to a hard refusal is
	* a deliberate later step.
	*/
	register(verifier) {
		if (this.verifiers.has(verifier.id)) throw new Error(`verifier: duplicate verifier "${verifier.id}"`);
		if (verifier.selftest === void 0) this.warn(`verifier "${verifier.id}" registered without a selftest (no declared positive/negative known samples)`);
		this.verifiers.set(verifier.id, verifier);
		return () => {
			this.verifiers.delete(verifier.id);
		};
	}
	/** The registered verifier ids, sorted — the vocabulary a criterion's `verifierRef` may name. */
	verifierIds() {
		return [...this.verifiers.keys()].sort();
	}
	/** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
	warn(message) {
		const logger = this.ctx.logger;
		logger?.("verifier").warn(message);
	}
	/**
	* Verify one run: dispatch each acceptance criterion of the run's task to a
	* verifier supporting its mode, assemble an EvidenceBundle (one claim per
	* result), record it through the task service, and return it. Marking the
	* run verified or failed is the caller's job and must come after this call.
	*/
	async verifyRun(storeId, runId, options = {}) {
		const run = await this.ctx.task.runIn(storeId, runId);
		const task = await this.ctx.task.taskIn(storeId, run.taskId);
		const request = {
			taskId: task.taskId,
			runId,
			criteria: [],
			cwd: options.cwd ?? process.cwd(),
			logDir: join(this.evidenceRoot, storeId, runId),
			timeoutMs: options.timeoutMs
		};
		const results = [];
		for (const criterion of task.acceptanceCriteria) results.push(...await this.verifyCriterion(storeId, request, criterion));
		const evidenceId = `evidence-${runId}-${randomUUID()}`;
		const bundle = {
			evidenceId,
			taskRunId: runId,
			taskId: task.taskId,
			artifacts: [...run.artifacts],
			verifierResults: results,
			claims: results.map((result) => this.claim(evidenceId, result)),
			generatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await this.ctx.task.recordEvidenceIn(storeId, bundle, "verifier");
		return bundle;
	}
	async verifyCriterion(storeId, request, criterion) {
		const verifier = criterion.verifierRef === void 0 ? this.findVerifier(criterion.verificationMode) : this.verifiers.get(criterion.verifierRef);
		if (verifier === void 0) return [{
			criterionId: criterion.criterionId,
			status: "inconclusive",
			verifierId: criterion.verifierRef ?? "verifier",
			details: criterion.verifierRef === void 0 ? `no verifier supports mode "${criterion.verificationMode}"` : `no verifier registered with id "${criterion.verifierRef}"`,
			unknownKind: "verifier"
		}];
		if (!verifier.supports(criterion.verificationMode)) return [{
			criterionId: criterion.criterionId,
			status: "inconclusive",
			verifierId: verifier.id,
			details: `verifier "${verifier.id}" does not support mode "${criterion.verificationMode}"`,
			unknownKind: "verifier"
		}];
		let results;
		try {
			if ((criterion.childEvidence?.length ?? 0) > 0 && verifier !== this.composite) {
				const mapped = await this.composite.verifyIn(storeId, {
					...request,
					criteria: [criterion]
				});
				if (mapped[0].status !== "pass") return mapped;
			}
			results = verifier instanceof CompositeVerifier ? await verifier.verifyIn(storeId, {
				...request,
				criteria: [criterion]
			}) : await verifier.verify({
				...request,
				criteria: [criterion]
			});
			const result = Array.isArray(results) && results.length === 1 ? results[0] : void 0;
			if (result === void 0 || result === null || typeof result !== "object" || result.criterionId !== criterion.criterionId || result.verifierId !== verifier.id || ![
				"pass",
				"fail",
				"inconclusive"
			].includes(result.status) || result.unknownKind !== void 0 && (result.status !== "inconclusive" || !["task", "verifier"].includes(result.unknownKind))) throw new Error(`verifier "${verifier.id}" must return exactly one valid result for criterion "${criterion.criterionId}" with its own verifierId`);
		} catch (error) {
			return [{
				criterionId: criterion.criterionId,
				status: "inconclusive",
				verifierId: verifier.id,
				details: error instanceof Error ? error.message : String(error),
				unknownKind: "verifier"
			}];
		}
		return results.map((result) => this.normalizeLogRef(result));
	}
	findVerifier(mode) {
		const registered = [...this.verifiers.values()];
		for (let index = registered.length - 1; index >= 0; index -= 1) if (registered[index].supports(mode)) return registered[index];
	}
	normalizeLogRef(result) {
		if (result.logRef === void 0 || !isAbsolute(result.logRef)) return result;
		const rel = relative(this.evidenceRoot, result.logRef);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`verifier: logRef "${result.logRef}" escapes evidenceRoot`);
		return {
			...result,
			logRef: rel
		};
	}
	/**
	* Tail excerpt of one criterion log (logRef relative to evidenceRoot),
	* bounded by LOG_TAIL_MAX_LINES and LOG_TAIL_MAX_CHARS, for a failed review
	* record to carry. `undefined` when the log is missing or unreadable — a
	* record must never fail to write because a log is gone.
	*/
	async logTail(logRef) {
		const path = resolve(this.evidenceRoot, logRef);
		if (path !== this.evidenceRoot && !path.startsWith(this.evidenceRoot + sep)) throw new Error(`verifier: logRef "${logRef}" escapes evidenceRoot`);
		let handle;
		try {
			handle = await open(path, "r");
		} catch {
			return;
		}
		try {
			const { size } = await handle.stat();
			const length = Math.min(size, LOG_TAIL_READ_BYTES);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, size - length);
			let excerpt = buffer.toString("utf8").split("\n").slice(-LOG_TAIL_MAX_LINES).join("\n").trimEnd();
			if (excerpt.length > LOG_TAIL_MAX_CHARS) excerpt = excerpt.slice(-LOG_TAIL_MAX_CHARS);
			return excerpt.length === 0 ? void 0 : excerpt;
		} finally {
			await handle.close();
		}
	}
	claim(evidenceId, result) {
		return {
			claimId: `${evidenceId}#${result.criterionId}`,
			criterionId: result.criterionId,
			status: result.status,
			verifierId: result.verifierId,
			artifactRefs: [],
			details: result.details,
			...result.unknownKind === void 0 ? {} : { unknownKind: result.unknownKind }
		};
	}
};
var src_default = VerifierRegistry;

//#endregion
export { CommandVerifier, CompositeVerifier, LOG_TAIL_MAX_CHARS, LOG_TAIL_MAX_LINES, ReviewVerifier, VerifierRegistry, src_default as default };