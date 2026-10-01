import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { sha256Hex } from "@dangosys/dsh-singularity-task";

//#region src/types.ts
/** The criterion a selftest sample hands a verifier: the shared skeleton, with the sample's own fields layered on. */
function sampleCriterion(overrides = {}) {
	return {
		criterionId: "selftest-sample",
		description: "a selftest sample",
		verificationMode: "deterministic",
		requiredEvidence: [],
		mandatory: true,
		...overrides
	};
}
/** Caps for the log-tail excerpt a review record carries: enough to read the failure, small enough to keep a record lean. */
const LOG_TAIL_MAX_LINES = 40;
const LOG_TAIL_MAX_CHARS = 2048;

//#endregion
//#region src/command-verifier.ts
const EXECUTABLE_MODES = [
	"deterministic",
	"simulation",
	"measurement"
];
/** Kill the command and everything it started: `shell: true` forks compound commands, and the negative-pid kill reaches the tree. */
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
/** Runs each criterion's `command` through a shell and judges by exit code; output goes to the criterion log. */
var CommandVerifier = class {
	id = "command";
	version = "1";
	/** Known samples: an exit-zero command must come back `pass`, an exit-non-zero one must come back `fail`. */
	selftest = { samples: [{
		role: "positive",
		name: "a command that exits zero",
		criterion: sampleCriterion({
			criterionId: "selftest-exit-zero",
			command: "true"
		}),
		expect: "pass"
	}, {
		role: "negative",
		name: "a command that exits non-zero",
		criterion: sampleCriterion({
			criterionId: "selftest-exit-non-zero",
			command: "false"
		}),
		expect: "fail"
	}] };
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
/** The registered id of the composite judge: the class and the pure judgement must sign their verdicts with one id. */
const COMPOSITE_VERIFIER_ID = "composite";
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
/** The defect one map entry carries against the store, or `undefined` when the entry is satisfied. */
function entryDefect(entry, children, snapshot) {
	const child = children[entry.childIndex];
	if (child === void 0) return `child #${entry.childIndex} does not exist (the run's member sequence holds ${children.filter((item) => item !== void 0).length} filled position(s))`;
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
/** Judged by child-status conjunction, plus the child-evidence map when the criterion declares one. */
async function judgeCompositeCriterion(criterion, members, snapshot) {
	const map = criterion.childEvidence ?? [];
	const base = {
		criterionId: criterion.criterionId,
		verifierId: COMPOSITE_VERIFIER_ID
	};
	if (members.length === 0) {
		if (map.length === 0) return {
			...base,
			status: "inconclusive",
			details: "no child tasks"
		};
		return {
			...base,
			status: "fail",
			details: `incomplete childEvidence map: the run has admitted no members to satisfy ${map.map(describeEntry).join("; ")}`
		};
	}
	const unverified = members.flatMap((child, index) => child?.status === "verified" ? [] : [child === void 0 ? `#${index} (unfilled)` : `${child.taskId}(${child.status})`]);
	if (unverified.length > 0) return {
		...base,
		status: "fail",
		details: `unverified children: ${unverified.join(", ")}`
	};
	if (map.length === 0) return {
		...base,
		status: "pass",
		...criterion.heuristic === true ? { details: "heuristic conjunction: every child verified — explicitly labeled heuristic (KISS §5.1); a conjunction is a coverage signal, not a deterministic proof of the parent goal, and is not counted as one" } : {}
	};
	const store = await snapshot();
	const defects = map.map((entry) => entryDefect(entry, members, store)).filter((defect) => defect !== void 0);
	if (defects.length > 0) return {
		...base,
		status: "fail",
		details: `incomplete childEvidence map: ${defects.join("; ")}`
	};
	return {
		...base,
		status: "pass",
		details: `childEvidence satisfied: ${map.map((entry) => describeSatisfied(entry, members[entry.childIndex])).join("; ")}`
	};
}
/** The criterion a composite selftest sample hands the judge. */
function compositeSample(childEvidence) {
	return sampleCriterion({
		criterionId: "selftest-child-evidence",
		description: "the parent goal rests on the child evidence the map names",
		verificationMode: "composite",
		childEvidence
	});
}
/** The verified child the samples judge over, carrying the criterion a sample names. */
function selftestChild(criterionId) {
	return {
		taskId: "selftest-child",
		definitionRef: {
			taskType: "selftest",
			version: 1
		},
		parentTaskId: "selftest-parent",
		objective: "the child work the parent rests on",
		depth: 1,
		acceptanceCriteria: [{
			criterionId,
			description: "the child criterion the map names",
			verificationMode: "deterministic",
			requiredEvidence: [],
			mandatory: true,
			command: "true"
		}],
		requestedCapabilities: [],
		decompositionStatus: "leaf",
		status: "verified",
		runIds: ["selftest-run"],
		childTaskIds: []
	};
}
/** The verified run the samples' child carries. */
function selftestRun() {
	return {
		runId: "selftest-run",
		taskId: "selftest-child",
		sessionId: "selftest-session",
		capabilitySnapshot: [],
		artifacts: [],
		verifierResults: [],
		status: "verified",
		startedAt: "2026-09-21T00:00:00.000Z",
		finishedAt: "2026-09-21T00:01:00.000Z"
	};
}
/** The bundle that verified run left behind, carrying the verdicts given. */
function selftestBundle(verdicts) {
	return {
		evidenceId: "selftest-evidence",
		taskRunId: "selftest-run",
		taskId: "selftest-child",
		artifacts: [],
		verifierResults: verdicts,
		claims: verdicts.map((verdict) => ({
			claimId: `selftest-evidence#${verdict.criterionId}`,
			criterionId: verdict.criterionId,
			status: verdict.status,
			verifierId: verdict.verifierId,
			artifactRefs: []
		})),
		generatedAt: "2026-09-21T00:01:00.000Z"
	};
}
var CompositeVerifier = class {
	id = COMPOSITE_VERIFIER_ID;
	version = "1";
	/** Known samples: one map the fixture store satisfies, one whose named criterion has no passing verdict. */
	selftest = { samples: [{
		role: "positive",
		name: "a childEvidence map the verified child evidence satisfies",
		criterion: compositeSample([{
			childIndex: 0,
			criterionId: "selftest-child-criterion"
		}]),
		expect: "pass",
		store: {
			children: [selftestChild("selftest-child-criterion")],
			runs: [selftestRun()],
			evidence: [selftestBundle([{
				criterionId: "selftest-child-criterion",
				status: "pass",
				verifierId: "command"
			}])]
		}
	}, {
		role: "negative",
		name: "a childEvidence map whose named criterion has no passing verdict",
		criterion: compositeSample([{
			childIndex: 0,
			criterionId: "selftest-child-criterion"
		}]),
		expect: "fail",
		store: {
			children: [selftestChild("selftest-child-criterion")],
			runs: [selftestRun()],
			evidence: [selftestBundle([{
				criterionId: "selftest-child-criterion",
				status: "inconclusive",
				verifierId: "review"
			}])]
		}
	}] };
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
		const members = await this.task.runMemberSlotsIn(storeId, req.runId);
		const results = [];
		for (const criterion of req.criteria) results.push(await judgeCompositeCriterion(criterion, members, () => this.task.snapshotIn(storeId)));
		return results;
	}
};

//#endregion
//#region src/protected-inputs.ts
/** Every defect among `inputs` read against `cwd`: a declared path that is missing, unreadable, or changed. */
async function protectedInputDefects(cwd, inputs) {
	const defects = [];
	for (const input of inputs) {
		const path = input.path;
		const admitted = input.sha256;
		let bytes;
		try {
			bytes = await readFile(resolve(cwd, path));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			defects.push(`protected input "${path}" is missing or unreadable: ${reason}`);
			continue;
		}
		const digest = sha256Hex(bytes);
		if (digest !== admitted) defects.push(`protected input "${path}" changed since admission (admitted sha256 ${admitted}, now ${digest})`);
	}
	return defects;
}

//#endregion
//#region src/review-verifier.ts
const REVIEW_MODES = ["review", "formal"];
/** Placeholder for human judgment: never auto-passes, and its samples prove exactly that on both sides (KISS §4.3). */
var ReviewVerifier = class {
	id = "review";
	version = "1";
	selftest = { samples: [{
		role: "positive",
		name: "a known-good review criterion is never auto-passed",
		criterion: sampleCriterion({
			criterionId: "selftest-review-known-good",
			verificationMode: "review"
		}),
		expect: "not-pass"
	}, {
		role: "negative",
		name: "a known-bad formal criterion is not judged pass",
		criterion: sampleCriterion({
			criterionId: "selftest-formal-known-bad",
			verificationMode: "formal"
		}),
		expect: "not-pass"
	}] };
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
/** Read window for large logs: the tail of a failure lives at the end of the file. */
const LOG_TAIL_READ_BYTES = 64 * 1024;
function defaultEvidenceRoot() {
	const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
	return join(process.env.DSH_HOME ?? join(repoRoot, ".dsh"), "task-evidence");
}
/** The thrown error's message, or the value itself when it is not an error. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The one result check production dispatch and the selftest gate share: one result, this criterion, this verifier. */
function validatedResult(verifier, criterion, results) {
	const result = Array.isArray(results) && results.length === 1 ? results[0] : void 0;
	if (result === void 0 || result === null || typeof result !== "object" || result.criterionId !== criterion.criterionId || result.verifierId !== verifier.id) throw new Error(`verifier "${verifier.id}" must return exactly one valid result for criterion "${criterion.criterionId}" with its own verifierId`);
	return result;
}
/** Whether a sample's verdict matches what it declared: `not-pass` accepts any status but `pass`. */
function sampleMissed(sample, status) {
	if (sample.expect === "pass") return status !== "pass";
	if (sample.expect === "fail") return status !== "fail";
	return status === "pass";
}
/** The store view a sample declares, as the snapshot a store-reading judgement sees; the sample proves the judgement, not the store. */
function sampleSnapshot(store) {
	return {
		version: 1,
		id: "verifier-selftest",
		tasks: store.children,
		runs: store.runs ?? [],
		edges: [],
		evidence: store.evidence ?? [],
		handoffs: [],
		reviews: [],
		diagnoses: [],
		obligations: [],
		capabilities: {}
	};
}
var VerifierRegistry = class extends Service {
	static inject = ["task"];
	static Config = z.object({ evidenceRoot: z.string() });
	/** Absolute evidence root resolved at construction. */
	evidenceRoot;
	verifiers = /* @__PURE__ */ new Map();
	composite;
	readyPromise;
	constructor(ctx, config = {}) {
		super(ctx, "verifier");
		this.evidenceRoot = resolve(config.evidenceRoot ?? defaultEvidenceRoot());
		this.composite = new CompositeVerifier(ctx.task);
	}
	/** Register the three built-ins through the executable selftest gate; idempotent, and fail-closed until it resolves. */
	async ready() {
		this.readyPromise ??= this.registerBuiltins();
		return this.readyPromise;
	}
	async registerBuiltins() {
		await this.register(new CommandVerifier(this.evidenceRoot));
		await this.register(this.composite);
		await this.register(new ReviewVerifier());
	}
	/** Add a verifier (later registrations win mode dispatch) and return its disposer; the selftest gate runs first. */
	async register(verifier, options = {}) {
		if (this.verifiers.has(verifier.id)) throw new Error(`verifier: duplicate verifier "${verifier.id}"`);
		if (options.testDouble === true) this.warn(`verifier "${verifier.id}" registered as a test double: the executable selftest gate is skipped by the caller's explicit declaration`);
		else await this.selftestGate(verifier);
		this.verifiers.set(verifier.id, verifier);
		return () => {
			this.verifiers.delete(verifier.id);
		};
	}
	/** The executable selftest gate: an unexecutable declaration is refused by name, a missed sample fails registration. */
	async selftestGate(verifier) {
		const declared = verifier.selftest;
		if (declared === void 0) throw new Error(`verifier "${verifier.id}" cannot be registered: no executable selftest samples (KISS §4.3)`);
		const samples = declared.samples;
		const defects = [];
		for (const sample of samples) if (sample.store !== void 0 && verifier !== this.composite) defects.push(`sample "${sample.name}" declares a store view, which only the registry's composite judge can execute`);
		if (!samples.some((sample) => sample.role === "positive")) defects.push("no sample declares role \"positive\"");
		if (!samples.some((sample) => sample.role === "negative")) defects.push("no sample declares role \"negative\"");
		if (defects.length > 0) throw new Error(`verifier "${verifier.id}" cannot be registered: ${defects.join("; ")}`);
		const misses = await this.executeSamples(verifier, samples);
		if (misses.length > 0) throw new Error(`verifier "${verifier.id}" selftest failed: ${misses.join("; ")}`);
	}
	/** Execute the declared samples in order and collect every miss, judged the way production judges them. */
	async executeSamples(verifier, samples) {
		const cwd = join(this.evidenceRoot, "selftest", "cwd");
		await mkdir(cwd, { recursive: true });
		const misses = [];
		for (const [index, sample] of samples.entries()) {
			const where = `sample "${sample.name}" (role ${sample.role})`;
			const store = sample.store;
			const logDir = join(this.evidenceRoot, "selftest", verifier.id, String(index));
			let judged;
			try {
				judged = store === void 0 ? await verifier.verify({
					taskId: "verifier-selftest",
					runId: "verifier-selftest",
					criteria: [sample.criterion],
					cwd,
					logDir
				}) : [await judgeCompositeCriterion(sample.criterion, store.children, async () => sampleSnapshot(store))];
			} catch (error) {
				misses.push(`${where} threw: ${messageOf(error)}`);
				continue;
			}
			let result;
			try {
				result = validatedResult(verifier, sample.criterion, judged);
			} catch (error) {
				misses.push(`${where} produced no valid result: ${messageOf(error)}`);
				continue;
			}
			if (sampleMissed(sample, result.status)) {
				const details = result.details === void 0 ? "" : ` (details: ${result.details})`;
				misses.push(`${where} expected "${sample.expect}" but the judge returned "${result.status}"${details}`);
			}
		}
		return misses;
	}
	/** The registered verifier ids, sorted — the vocabulary a criterion's `verifierRef` may name. */
	verifierIds() {
		return [...this.verifiers.keys()].sort();
	}
	/** The version each registered verifier declares, by id; an instance declaring none is absent from the map. */
	verifierVersions() {
		const versions = {};
		for (const [id, verifier] of this.verifiers) if (verifier.version !== void 0) versions[id] = verifier.version;
		return versions;
	}
	/** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
	warn(message) {
		const logger = this.ctx.logger;
		logger?.("verifier").warn(message);
	}
	/** Cordis runs this after construction: the built-ins are gated before the service is usable. */
	async [Service.init]() {
		await this.ready();
	}
	/** Verify one run: dispatch each criterion, assemble an EvidenceBundle, record it, and return it. */
	async verifyRun(storeId, runId, options = {}) {
		await this.ready();
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
		const protectedInputs = criterion.protectedInputs;
		if ((protectedInputs?.length ?? 0) > 0) {
			const defects = await protectedInputDefects(request.cwd, protectedInputs);
			if (defects.length > 0) return [this.stampVersion(verifier, {
				criterionId: criterion.criterionId,
				status: "fail",
				verifierId: verifier.id,
				details: defects.join("; ")
			})];
		}
		let results;
		try {
			if ((criterion.childEvidence?.length ?? 0) > 0 && verifier !== this.composite) {
				const mapped = await this.composite.verifyIn(storeId, {
					...request,
					criteria: [criterion]
				});
				if (mapped[0].status !== "pass") return mapped.map((result) => this.stampVersion(this.composite, result));
			}
			results = verifier instanceof CompositeVerifier ? await verifier.verifyIn(storeId, {
				...request,
				criteria: [criterion]
			}) : await verifier.verify({
				...request,
				criteria: [criterion]
			});
			validatedResult(verifier, criterion, results);
		} catch (error) {
			return [{
				criterionId: criterion.criterionId,
				status: "inconclusive",
				verifierId: verifier.id,
				details: error instanceof Error ? error.message : String(error),
				unknownKind: "verifier"
			}];
		}
		return results.map((result) => this.normalizeLogRef(this.stampVersion(verifier, result)));
	}
	/** Stamp the registered instance's version onto one verdict (KISS §8.2); a plugin-supplied version is discarded. */
	stampVersion(verifier, result) {
		const stamped = { ...result };
		delete stamped.verifierVersion;
		if (verifier.version !== void 0) stamped.verifierVersion = verifier.version;
		return stamped;
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
	/** Tail excerpt of one criterion log, capped by the two LOG_TAIL limits; `undefined` when the log is missing. */
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
			...result.verifierVersion === void 0 ? {} : { verifierVersion: result.verifierVersion },
			artifactRefs: [],
			details: result.details,
			...result.unknownKind === void 0 ? {} : { unknownKind: result.unknownKind }
		};
	}
};
var src_default = VerifierRegistry;

//#endregion
export { CommandVerifier, CompositeVerifier, ReviewVerifier, VerifierRegistry, src_default as default, judgeCompositeCriterion, protectedInputDefects };