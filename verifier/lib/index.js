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
/**
* Judges a composite criterion by child task status: pass iff the task has at
* least one child and every child is verified. Reading children needs the
* store id, which VerifyRequest does not carry, so the registry dispatches
* through {@link verifyIn}; the plain `verify` stays inconclusive.
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
		let status;
		let details;
		if (children.length === 0) {
			status = "inconclusive";
			details = "no child tasks";
		} else {
			const unverified = children.filter((child) => child.status !== "verified");
			if (unverified.length === 0) status = "pass";
			else {
				status = "fail";
				details = `unverified children: ${unverified.map((child) => `${child.taskId}(${child.status})`).join(", ")}`;
			}
		}
		return req.criteria.map((criterion) => ({
			criterionId: criterion.criterionId,
			status,
			verifierId: this.id,
			details
		}));
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
	constructor(ctx, config = {}) {
		super(ctx, "verifier");
		this.evidenceRoot = resolve(config.evidenceRoot ?? defaultEvidenceRoot());
		this.register(new CommandVerifier(this.evidenceRoot));
		this.register(new CompositeVerifier(ctx.task));
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