import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { sha256Hex } from "@dangosys/dsh-singularity-task";

//#region src/command-verifier.ts
const EXECUTABLE_MODES = [
	"deterministic",
	"simulation",
	"measurement"
];
/** The criterion a selftest sample hands this verifier: the fields it reads, with the command the sample's verdict rests on. */
function sampleCriterion$2(criterionId, command) {
	return {
		criterionId,
		description: "a selftest sample",
		verificationMode: "deterministic",
		requiredEvidence: [],
		mandatory: true,
		command
	};
}
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
	/**
	* Known samples the registry executes before it will register this judge
	* (KISS §4.3, V2-1): a command that exits zero must come back `pass`, one
	* that exits non-zero must come back `fail`. Both go through the same shell
	* path production uses, so the proof is this verifier's own exit-code
	* reading, executed — not a description of it.
	*/
	selftest = { samples: [{
		role: "positive",
		name: "a command that exits zero",
		criterion: sampleCriterion$2("selftest-exit-zero", "true"),
		expect: "pass"
	}, {
		role: "negative",
		name: "a command that exits non-zero",
		criterion: sampleCriterion$2("selftest-exit-non-zero", "false"),
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
* Pure by construction — the criterion, the batch's children, and a snapshot
* getter are the whole input. The getter is called only when a map needs it,
* so a map-less criterion never reads a snapshot; that also lets the registry
* judge a selftest sample's declared store view without a store behind it.
* Reading children needs the store id, which VerifyRequest does not carry, so
* production dispatches through {@link CompositeVerifier.verifyIn}; the plain
* `verify` stays inconclusive.
*/
async function judgeCompositeCriterion(criterion, children, snapshot) {
	const map = criterion.childEvidence ?? [];
	const base = {
		criterionId: criterion.criterionId,
		verifierId: COMPOSITE_VERIFIER_ID
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
	const store = await snapshot();
	const defects = map.map((entry) => entryDefect(entry, children, store)).filter((defect) => defect !== void 0);
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
/** The criterion a selftest sample hands the judge; only the fields the judge reads carry meaning. */
function sampleCriterion$1(overrides = {}) {
	return {
		criterionId: "selftest-child-evidence",
		description: "the parent goal rests on the child evidence the map names",
		verificationMode: "composite",
		requiredEvidence: [],
		mandatory: true,
		...overrides
	};
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
	owner = "singularity";
	/**
	* Known samples the registry executes before it will register this judge
	* (KISS §4.3, V2-1): one map the fixture store satisfies, one whose named
	* criterion has no passing verdict in that evidence. Same child, same run,
	* same bundle shape — the two samples differ only in a verdict, so a judge
	* that returns one status for both is caught. Neither the samples nor the
	* fixtures are read from a real store; the store *view* each sample declares
	* is the whole input (`VerifierSelftestSample.store`).
	*/
	selftest = { samples: [{
		role: "positive",
		name: "a childEvidence map the verified child evidence satisfies",
		criterion: sampleCriterion$1({ childEvidence: [{
			childIndex: 0,
			criterionId: "selftest-child-criterion"
		}] }),
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
		criterion: sampleCriterion$1({ childEvidence: [{
			childIndex: 0,
			criterionId: "selftest-child-criterion"
		}] }),
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
		const children = await this.task.childrenIn(storeId, req.taskId);
		const results = [];
		for (const criterion of req.criteria) results.push(await judgeCompositeCriterion(criterion, children, () => this.task.snapshotIn(storeId)));
		return results;
	}
};

//#endregion
//#region src/protected-inputs.ts
/**
* Every defect among `inputs`, read against `cwd`: the entry position and what
* is wrong with it — malformed, missing, unreadable, or changed since
* admission. Empty when every declared input is well formed, present, and
* unchanged. Each message names the declared path (or the entry position, when
* there is no path to name), so the caller never has to guess which input is at
* fault.
*
* Entries are guarded before use. A criterion's `protectedInputs` reaches the
* registry from the store, and admission is not the only writer: a direct store
* write can hand over an entry admission would have refused, and the registry
* still has to answer that criterion with a verdict. A malformed entry is a
* defect of the verdict's inputs like any other — named in the refusal, never
* thrown out of the judgement that was supposed to report it. The parameter
* type stays the declared one; the runtime is what is not guaranteed.
*/
async function protectedInputDefects(cwd, inputs) {
	const defects = [];
	for (const [index, entry] of inputs.entries()) {
		const input = entry;
		if (input === null || typeof input !== "object") {
			defects.push(`protected input entry ${index} is malformed: expected an object with a path and a sha256`);
			continue;
		}
		const path = input.path;
		if (typeof path !== "string" || path.trim().length === 0) {
			defects.push(`protected input entry ${index} is malformed: path must be a non-empty string`);
			continue;
		}
		const admitted = input.sha256;
		if (typeof admitted !== "string" || admitted.trim().length === 0) {
			defects.push(`protected input entry ${index} is malformed: sha256 must be a non-empty string`);
			continue;
		}
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
/** The criterion a selftest sample hands this verifier: a review criterion carries no command, so only its identity and mode matter. */
function sampleCriterion(criterionId, verificationMode) {
	return {
		criterionId,
		description: "a selftest sample",
		verificationMode,
		requiredEvidence: [],
		mandatory: true
	};
}
/**
* Placeholder for human judgment: never auto-passes.
*
* Its selftest takes the equivalent form KISS §4.3 allows a judge that judges
* nothing: a known-good sample must be demonstrably *not* auto-passed, and a
* known-bad sample must not be judged `pass` either. Both are executed by the
* registry before it will register this verifier.
*
* What that proves: the judge returns a not-pass verdict instead of silently
* accepting, on both a criterion that ought to be verifiable by a human and one
* that ought not to pass. What it does not prove: anything about products —
* this verifier does not judge products at all, and no sample can make its
* verdict meaningful. What closes a review criterion is the human review it
* defers to, outside this verifier.
*/
var ReviewVerifier = class {
	id = "review";
	version = "1";
	owner = "singularity";
	selftest = { samples: [{
		role: "positive",
		name: "a known-good review criterion is never auto-passed",
		criterion: sampleCriterion("selftest-review-known-good", "review"),
		expect: "not-pass"
	}, {
		role: "negative",
		name: "a known-bad formal criterion is not judged pass",
		criterion: sampleCriterion("selftest-formal-known-bad", "formal"),
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
/** Caps for the log-tail excerpt a review record carries: enough to read the failure, small enough to keep a record lean. */
const LOG_TAIL_MAX_LINES = 40;
const LOG_TAIL_MAX_CHARS = 2048;
/** Read window for large logs: the tail of a failure lives at the end of the file. */
const LOG_TAIL_READ_BYTES = 64 * 1024;
function defaultEvidenceRoot() {
	const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
	return join(process.env.DSH_HOME ?? join(repoRoot, ".dsh"), "task-evidence");
}
/** How a value reads back in a refusal when the declaration is malformed. */
function described(value) {
	if (value === void 0) return "undefined";
	if (Array.isArray(value) && value.length === 0) return "an empty array";
	const json = JSON.stringify(value);
	return json === void 0 ? String(value) : json;
}
/** How a sample is named in a refusal: by its name when it has one, by position otherwise. */
function sampleWho(sample, index) {
	return typeof sample.name === "string" && sample.name.trim().length > 0 ? `sample "${sample.name}"` : `sample #${index}`;
}
/** The thrown error's message, or the value itself when it is not an error. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* The shape defects of one sample, as readable reasons: the fields the gate
* needs to execute the sample and to know what a healthy judge returns for it.
* Collected rather than thrown, so one refusal names every malformed sample.
* A shape defect refuses registration *before* execution — a sample the gate
* cannot read is never run as a guess.
*/
function sampleShapeDefects(sample, index) {
	const named = typeof sample.name === "string" && sample.name.trim().length > 0;
	const who = sampleWho(sample, index);
	const defects = [];
	if (!named) defects.push(`sample #${index} has no name`);
	if (sample.role !== "positive" && sample.role !== "negative") defects.push(`${who} has no valid role (got ${described(sample.role)})`);
	else if (sample.role === "positive" && sample.expect !== "pass" && sample.expect !== "not-pass") defects.push(`${who} (role positive) must expect "pass" or "not-pass" (got ${described(sample.expect)})`);
	else if (sample.role === "negative" && sample.expect !== "fail" && sample.expect !== "not-pass") defects.push(`${who} (role negative) must expect "fail" or "not-pass" (got ${described(sample.expect)})`);
	const criterion = sample.criterion;
	if (criterion === null || typeof criterion !== "object" || typeof criterion.criterionId !== "string" || criterion.criterionId.trim().length === 0) defects.push(`${who} has no criterion carrying a criterionId`);
	const store = sample.store;
	if (store !== void 0 && (store === null || typeof store !== "object" || !Array.isArray(store.children))) defects.push(`${who} declares a store view without children`);
	return defects;
}
/**
* The one result validation production dispatch and the selftest gate share,
* so the rules cannot drift: exactly one result, for this criterion, signed by
* this verifier, in a known status, with no `unknownKind` on a status that
* cannot carry one. Plugins cross a runtime boundary — their TypeScript return
* type is not validation. Throws the refusal text both callers report.
*/
function validatedResult(verifier, criterion, results) {
	const result = Array.isArray(results) && results.length === 1 ? results[0] : void 0;
	if (result === void 0 || result === null || typeof result !== "object" || result.criterionId !== criterion.criterionId || result.verifierId !== verifier.id || ![
		"pass",
		"fail",
		"inconclusive"
	].includes(result.status) || result.unknownKind !== void 0 && (result.status !== "inconclusive" || !["task", "verifier"].includes(result.unknownKind))) throw new Error(`verifier "${verifier.id}" must return exactly one valid result for criterion "${criterion.criterionId}" with its own verifierId`);
	return result;
}
/** Whether a sample's verdict matches what it declared: `not-pass` accepts any status but `pass`. */
function sampleMissed(sample, status) {
	if (sample.expect === "pass") return status !== "pass";
	if (sample.expect === "fail") return status !== "fail";
	return status === "pass";
}
/**
* The store view a selftest sample declares, as the snapshot a store-reading
* judgement sees: the sample's children, runs, and evidence, with every other
* part of a snapshot empty. A sample proves the judgement, not the store.
*/
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
	/**
	* Register the three built-ins through the same executable selftest gate
	* every other judge passes. Cordis calls this after construction
	* (`Service.init`); {@link verifyRun} awaits it too, so a caller that never
	* awaited it still gets a readied registry.
	*
	* Idempotent — the first call does the work, every later call awaits the same
	* promise (a rejection stays a rejection: a built-in that fails its own
	* selftest must not become registrable on a retry). Fail closed until it
	* resolves: the registry holds no verifiers yet, so a dispatch that somehow
	* got ahead of it would find no judge and refuse rather than judge with a
	* half-built vocabulary.
	*/
	async ready() {
		this.readyPromise ??= this.registerBuiltins();
		return this.readyPromise;
	}
	async registerBuiltins() {
		await this.register(new CommandVerifier(this.evidenceRoot));
		await this.register(this.composite);
		await this.register(new ReviewVerifier());
	}
	/**
	* Add a verifier; later registrations win mode dispatch. Returns the
	* disposer. Every registration goes through the executable selftest gate
	* (KISS §4.3, V2-1): the verifier must declare positive and negative samples
	* and then prove, by returning the declared verdict for each, that it can
	* tell the sides apart. A registration that misses a sample — or declares a
	* set the gate cannot execute — is refused with a readable reason naming the
	* verifier and every missed or malformed sample, and is not added. The
	* conclusion is the gate's, taken from executing the samples; a verifier's
	* own description of itself is never consulted.
	*
	* The one exception is the caller's explicit `{ testDouble: true }` — the
	* only skip-the-gate channel, for tests and fixtures that stand in for a
	* judge without being one. It is declared, never inferred, and logged as one
	* warning so the skip is visible in the run that took it.
	*/
	async register(verifier, options = {}) {
		if (this.verifiers.has(verifier.id)) throw new Error(`verifier: duplicate verifier "${verifier.id}"`);
		if (options.testDouble === true) this.warn(`verifier "${verifier.id}" registered as a test double: the executable selftest gate is skipped by the caller's explicit declaration`);
		else await this.selftestGate(verifier);
		this.verifiers.set(verifier.id, verifier);
		return () => {
			this.verifiers.delete(verifier.id);
		};
	}
	/**
	* The executable selftest gate. Two refusals reach the caller, both naming
	* the verifier: `cannot be registered` for a declaration the gate could not
	* execute (missing, empty, one-sided, or malformed samples, or a store view
	* only the registry's own composite judge can be run against), and
	* `selftest failed` for samples that executed and were missed.
	*/
	async selftestGate(verifier) {
		const declared = verifier.selftest;
		if (declared === void 0) throw new Error(`verifier "${verifier.id}" cannot be registered: no executable selftest samples (KISS §4.3)`);
		const samples = declared.samples;
		if (!Array.isArray(samples) || samples.length === 0) throw new Error(`verifier "${verifier.id}" cannot be registered: selftest.samples must be a non-empty array (got ${described(samples)})`);
		const defects = [];
		for (const [index, raw] of samples.entries()) {
			const sample = raw;
			if (sample === null || typeof sample !== "object") {
				defects.push(`sample #${index} is not an object`);
				continue;
			}
			defects.push(...sampleShapeDefects(sample, index));
			if (sample.store !== void 0 && verifier !== this.composite) defects.push(`${sampleWho(sample, index)} declares a store view, which only the registry's composite judge can execute`);
		}
		if (!samples.some((sample) => sample?.role === "positive")) defects.push("no sample declares role \"positive\"");
		if (!samples.some((sample) => sample?.role === "negative")) defects.push("no sample declares role \"negative\"");
		if (defects.length > 0) throw new Error(`verifier "${verifier.id}" cannot be registered: ${defects.join("; ")}`);
		const misses = await this.executeSamples(verifier, samples);
		if (misses.length > 0) throw new Error(`verifier "${verifier.id}" selftest failed: ${misses.join("; ")}`);
	}
	/**
	* Execute the declared samples in order and collect every miss. Each sample
	* is judged the way production judges it — through `verify` for a
	* criterion-only judge, through the shared composite judgement over the
	* sample's declared store view for the registry's own composite instance —
	* and validated by the same rules production applies. Samples run against a
	* scratch cwd and log dir under the evidence root, so a command sample
	* really spawns and everything it writes stays inside evidenceRoot.
	*/
	async executeSamples(verifier, samples) {
		const cwd = join(this.evidenceRoot, "selftest", "cwd");
		await mkdir(cwd, { recursive: true });
		const misses = [];
		for (const [index, sample] of samples.entries()) {
			const where = `${sampleWho(sample, index)} (role ${sample.role})`;
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
	/** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
	warn(message) {
		const logger = this.ctx.logger;
		logger?.("verifier").warn(message);
	}
	/** Cordis runs this after construction: the built-ins are gated before the service is usable. */
	async [Service.init]() {
		await this.ready();
	}
	/**
	* Verify one run: dispatch each acceptance criterion of the run's task to a
	* verifier supporting its mode, assemble an EvidenceBundle (one claim per
	* result), record it through the task service, and return it. Marking the
	* run verified or failed is the caller's job and must come after this call.
	*/
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
	/**
	* Stamp the registered instance's version onto one verdict (KISS §8.2): a
	* verdict can only be recalled against the instance that actually judged, so
	* the version recorded is this instance's — a plugin-supplied
	* `verifierVersion` is always discarded, and an instance that declares none
	* acquires none.
	*/
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
			...result.verifierVersion === void 0 ? {} : { verifierVersion: result.verifierVersion },
			artifactRefs: [],
			details: result.details,
			...result.unknownKind === void 0 ? {} : { unknownKind: result.unknownKind }
		};
	}
};
var src_default = VerifierRegistry;

//#endregion
export { CommandVerifier, CompositeVerifier, LOG_TAIL_MAX_CHARS, LOG_TAIL_MAX_LINES, ReviewVerifier, VerifierRegistry, src_default as default, judgeCompositeCriterion, protectedInputDefects };