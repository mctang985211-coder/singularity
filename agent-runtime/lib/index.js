import { Context, Service } from "@deepseek-ai/cordis";
import { MessageId, createUserMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { snapshotSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { DEFAULT_ROOT } from "@dangosys/dsh-singularity-graph";
import { RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SessionAlreadyOwnedError } from "@deepseek-ai/dsh-session-persistence";

//#region src/messages.ts
/** One refused source read or delivery, with the stable name of what went wrong. */
var MessageDeliveryRefusal = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.name = "MessageDeliveryRefusal";
		this.code = code;
	}
};
/** The message body a question carries into its parent's Session: the stable question identity, then what was asked. */
function questionMessageText(questionId, question) {
	return `[task-question ${questionId}] ${question}`;
}
/** The message body an answer carries into the asking Session: both identities, then what the parent answered. */
function answerMessageText(answerId, questionId, answer) {
	return `[task-answer ${answerId} for ${questionId}] ${answer}`;
}
/** Build the identified, frozen relay message one intent delivers (pure, so a caller can inspect it). */
function relayMessage(intent) {
	return freezeMessage({
		id: MessageId(intent.messageId),
		role: "user",
		content: [{
			type: "text",
			text: intent.text
		}],
		source: {
			kind: "agent-message",
			form: "relay",
			senderSessionId: intent.senderSessionId
		}
	});
}
/** Whether one Session's own event suffix already holds the identity, in history or still pending. */
function messageAccepted(events, messageId) {
	return events.some((event) => event.type === "user/message" && event.data.id === messageId) || pendingInboxMessages(events).some((message) => message.id === messageId);
}
/** Whether the log durably records that this identity entered the Session's inbox (wider than `messageAccepted`). */
function messageRecorded(events, messageId) {
	return events.some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message) => message.id === messageId));
}
/** Read back the body of a cited `tool/call`, flushing the sending Session first; refusals are named. */
async function readToolCallBody(deps, ref) {
	const sessionId = SessionId(ref.sessionId);
	const live = deps.sessions.get(sessionId);
	if (live !== void 0) await witnessBarrier(deps, live, sessionId);
	let window;
	try {
		window = await deps.sessionQuery.readEvent({
			sessionId,
			seq: SessionSeq(ref.seq)
		});
	} catch (error) {
		throw sourceReadRefusal(String(sessionId), ref.seq, error);
	}
	const event = window.target;
	if (event.type !== "tool/call" || typeof event.data.name !== "string" || event.data.name === "") throw new MessageDeliveryRefusal("source-not-tool-call", `agent-runtime: session "${String(sessionId)}" seq ${ref.seq} is not a tool call (event type "${event.type}")`);
	return {
		name: event.data.name,
		arguments: event.data.arguments
	};
}
/** One Session's own event suffix, without the fork-inherited prefix. */
function ownSuffix(log) {
	return log.events.slice(log.inheritedEventCount);
}
/** The citation of one `tool/call` inside a Session's own suffix, found by the call id (last event wins). */
function toolCallRefIn(log, callId) {
	const own = ownSuffix(log);
	for (let index = own.length - 1; index >= 0; index -= 1) {
		const event = own[index];
		if (event.type !== "tool/call") continue;
		if (String(event.data.callId) !== callId) continue;
		return {
			sessionId: log.session.id,
			seq: event.seq
		};
	}
}
/** Put one committed identity into the target inbox at most once (reconcile → relay → flush → confirm). */
async function ensureAgentMessageDelivered(deps, intent) {
	const targetSessionId = SessionId(intent.targetSessionId);
	const agent = deps.agents.get(targetSessionId);
	if (agent === void 0) return {
		messageId: intent.messageId,
		status: "unavailable"
	};
	if (await acceptedAlready(deps, targetSessionId, intent.messageId)) return {
		messageId: intent.messageId,
		status: "already-present"
	};
	try {
		agent.steer(relayMessage(intent));
	} catch (error) {
		if (isAlreadyPending(error, intent.messageId)) return {
			messageId: intent.messageId,
			status: "already-present"
		};
		throw error;
	}
	await witnessBarrier(deps, agent.session, targetSessionId, "target-not-durable");
	const own = await ownSuffixOf(deps, targetSessionId);
	if (!messageAccepted(own, intent.messageId) && !messageRecorded(own, intent.messageId)) throw new MessageDeliveryRefusal("delivery-unconfirmed", `agent-runtime: message "${intent.messageId}" was relayed to session "${String(targetSessionId)}" but is not in its log after the flush`);
	return {
		messageId: intent.messageId,
		status: "delivered"
	};
}
/** Deliver exactly the committed intents that are missing, in order, reporting each record separately. */
async function reconcileAgentMessageDeliveries(deps, intents) {
	const reports = [];
	for (const intent of intents) try {
		const delivery = await ensureAgentMessageDelivered(deps, intent);
		reports.push({
			messageId: delivery.messageId,
			status: delivery.status
		});
	} catch (error) {
		reports.push({
			messageId: intent.messageId,
			status: "refused",
			reason: messageOf(error)
		});
	}
	return reports;
}
/** The durability barrier: `session/flush` reaching no listener means the body cannot be witnessed. */
async function witnessBarrier(deps, session, sessionId, code = "source-not-durable") {
	let durable;
	try {
		durable = await deps.sessions.flush(session);
	} catch (error) {
		throw new MessageDeliveryRefusal(code, `agent-runtime: session "${String(sessionId)}" could not be flushed: ${messageOf(error)}`, { cause: error });
	}
	if (!durable) throw new MessageDeliveryRefusal(code, `agent-runtime: session "${String(sessionId)}" has no durability barrier (no session/flush participant)`);
}
/** Whether the target Session's own suffix already holds the identity. */
async function acceptedAlready(deps, sessionId, messageId) {
	return messageAccepted(await ownSuffixOf(deps, sessionId), messageId);
}
/** Read one Session's own event suffix; a failed read is a refusal, never an assumed "nothing there". */
async function ownSuffixOf(deps, sessionId) {
	let snapshot;
	try {
		snapshot = await deps.sessionQuery.readSession(sessionId);
	} catch (error) {
		throw new MessageDeliveryRefusal("target-unreadable", `agent-runtime: target session "${String(sessionId)}" could not be read, so whether a message was accepted cannot be decided: ${messageOf(error)}`, { cause: error });
	}
	return ownSuffix(snapshot);
}
/** The pending inbox one durable suffix describes, folded the way DSH replays it. */
function pendingInboxMessages(events) {
	const inbox = {
		"next-turn": [],
		"next-step": []
	};
	for (const event of events) {
		if (event.type !== "agent/inbox/spliced") continue;
		inbox[event.data.target].splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted);
	}
	return [...inbox["next-turn"], ...inbox["next-step"]];
}
/** One line of an unknown failure, for refusals that carry a cause. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Whether one thrown error is DSH's duplicate-pending-inbox refusal for this id. */
function isAlreadyPending(error, messageId) {
	return error instanceof Error && error.message === `message "${messageId}" is already pending`;
}
/** Name one refused source read from the error the session read path raised. */
function sourceReadRefusal(sessionId, seq, error) {
	const code = error?.code;
	if (code === "SESSION_QUERY_EVENT_NOT_FOUND") return new MessageDeliveryRefusal("source-event-missing", `agent-runtime: session "${sessionId}" has no event at seq ${seq}`, { cause: error });
	if (code === "SESSION_QUERY_SESSION_NOT_FOUND") return new MessageDeliveryRefusal("source-session-missing", `agent-runtime: session "${sessionId}" does not exist`, { cause: error });
	return new MessageDeliveryRefusal("source-unreadable", `agent-runtime: session "${sessionId}" could not be read: ${messageOf(error)}`, { cause: error });
}

//#endregion
//#region src/skill-file.ts
/** How far up from a worker's cwd project skill roots are looked for. */
const PROJECT_LOOKUP_DEPTH = 8;
/** The one runtime registration both skill paths build: a parsed SKILL.md or a discovered skill to pin. */
function toRuntimeSkill(parsed) {
	return {
		name: parsed.name,
		description: parsed.description,
		...parsed.whenToUse === void 0 ? {} : { whenToUse: parsed.whenToUse },
		...parsed.invocation === void 0 ? {} : { invocation: parsed.invocation },
		source: "runtime",
		...parsed.path === void 0 ? {} : { path: parsed.path },
		...parsed.resourceBase === void 0 ? {} : { resourceBase: parsed.resourceBase },
		...parsed.metadata === void 0 ? {} : { metadata: parsed.metadata },
		content: parsed.content
	};
}
function stripQuotes(value) {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}
function parseBoolean(value, field, path) {
	if (value === void 0) return void 0;
	const normalized = stripQuotes(value).toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	throw new Error(`skill file ${path} has a non-boolean "${field}": ${value}`);
}
/** Split `SKILL.md` text into its flat `key: value` frontmatter fields and body; nested lines fail loudly. */
function parseSkillFile(text, path) {
	const lines = text.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") throw new Error(`skill file ${path} has no YAML frontmatter (expected a leading "---" line)`);
	const closing = lines.indexOf("---", 1);
	if (closing === -1) throw new Error(`skill file ${path} has an unterminated frontmatter block`);
	const fields = /* @__PURE__ */ new Map();
	for (const line of lines.slice(1, closing)) {
		if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
		if (/^\s/.test(line)) throw new Error(`skill file ${path} has a nested frontmatter line this reader does not support: ${line}`);
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error(`skill file ${path} has a frontmatter line without a key: ${line}`);
		fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	const name = fields.get("name");
	const description = fields.get("description");
	if (name === void 0 || stripQuotes(name).length === 0) throw new Error(`skill file ${path} frontmatter requires "name"`);
	if (description === void 0 || stripQuotes(description).length === 0) throw new Error(`skill file ${path} frontmatter requires "description"`);
	const whenToUse = fields.get("when-to-use") ?? fields.get("whenToUse");
	const modelInvocable = parseBoolean(fields.get("disable-model-invocation"), "disable-model-invocation", path);
	const userInvocable = parseBoolean(fields.get("user-invocable"), "user-invocable", path);
	return {
		path,
		name: stripQuotes(name),
		description: stripQuotes(description),
		...whenToUse === void 0 || whenToUse.length === 0 ? {} : { whenToUse: stripQuotes(whenToUse) },
		invocation: {
			modelInvocable: modelInvocable !== true,
			userInvocable: userInvocable !== false
		},
		content: lines.slice(closing + 1).join("\n").replace(/^\n+/, "")
	};
}
/** The `SKILL.md` for one skill name under one skill root, when both exist. */
async function skillFileIn(root, name) {
	const file = join(root, name, "SKILL.md");
	return (await stat(file).catch(() => void 0))?.isFile() === true ? file : void 0;
}
/** Skill roots for a worker working in `cwd`: its own project first, then the deployment's user roots. */
async function skillRootsFor(cwd) {
	const roots = [];
	if (cwd !== void 0) {
		let dir = cwd;
		for (let level = 0; level <= PROJECT_LOOKUP_DEPTH; level += 1) {
			roots.push(join(dir, ".agents", "skills"), join(dir, ".dsh", "skills"));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	const dshHome = process.env.DSH_HOME;
	if (dshHome !== void 0 && dshHome.length > 0) roots.push(join(dshHome, "skills"));
	roots.push(join(homedir(), ".agents", "skills"), fileURLToPath(new URL("../skills/", import.meta.url)));
	return roots;
}
/** Locate the `SKILL.md` a granted skill name refers to under an explicit root list, in the given order. */
async function findSkillFileIn(roots, name) {
	for (const root of roots) {
		const file = await skillFileIn(root, name);
		if (file !== void 0) return file;
	}
}
/** Locate the `SKILL.md` a granted skill name refers to; project roots are searched upward from `cwd`. */
async function findSkillFile(name, cwd) {
	return findSkillFileIn(await skillRootsFor(cwd), name);
}
/** Every `<root>/<name>/SKILL.md` under one extra skill root, in directory order; an unreadable root throws. */
async function listSkillFiles(root) {
	const entries = await readdir(root, { withFileTypes: true });
	const found = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const file = await skillFileIn(root, entry.name);
		if (file !== void 0) found.push({
			name: entry.name,
			file
		});
	}
	return found;
}
/** Read one granted skill's `SKILL.md` into a runtime registration, rejecting a mismatched declared name. */
async function readSkillFile(file, name) {
	const parsed = parseSkillFile(await readFile(file, "utf8"), file);
	if (parsed.name !== name) throw new Error(`skill file ${file} declares name "${parsed.name}" but the capability grants "${name}"`);
	return toRuntimeSkill({
		...parsed,
		resourceBase: {
			kind: "directory",
			path: dirname(parsed.path)
		}
	});
}

//#endregion
//#region src/grants.ts
function skillRegistry(agentCtx) {
	return agentCtx.get("skills");
}
/** Names one tools view offers, minus the reserved PTC transport the filter may never name. */
function visibleToolNames(agentCtx, scope) {
	return new Set(agentCtx.tools.schemas(scope).map((schema) => schema.name).filter((name) => name !== RUN_CODE_NAME));
}
/** Refuse a grant whose capability-declared tools the worker's composition does not offer. */
function assertCapabilityTools(grant, visible) {
	const missing = grant.capabilities.map((capability) => ({
		capability: capability.capability,
		tools: capability.tools.filter((tool) => !visible.has(tool))
	})).filter((entry) => entry.tools.length > 0);
	if (missing.length === 0) return;
	const known = [...visible].sort().join(", ") || "(none)";
	const detail = missing.map((entry) => `"${entry.capability}" grants unavailable tool${entry.tools.length > 1 ? "s" : ""} ${entry.tools.map((tool) => `"${tool}"`).join(", ")}`).join("; ");
	throw new Error(`agent-runtime: capabilit${missing.length > 1 ? "ies" : "y"} ${detail}; this worker's visible tools: ${known}`);
}
/** Compute the allow-list one grant resolves to; throws when a capability tool is not visible. */
function resolveGrant(agentCtx, agent, grant) {
	const visible = visibleToolNames(agentCtx, agent);
	assertCapabilityTools(grant, visible);
	const allow = /* @__PURE__ */ new Set();
	for (const capability of grant.capabilities) for (const tool of capability.tools) allow.add(tool);
	for (const tool of grant.baseline) if (visible.has(tool)) allow.add(tool);
	if (grant.keepPresetTools) {
		const global = visibleToolNames(agentCtx);
		for (const tool of visible) if (!global.has(tool)) allow.add(tool);
	}
	return {
		allow: [...allow].sort(),
		baselineUnavailable: [...new Set(grant.baseline.filter((tool) => !visible.has(tool)))].sort()
	};
}
/** Register every skill one grant's extra roots carry into the worker's own layer (the replay overlay), first. */
async function applySkillRoots(agentCtx, grant) {
	const roots = grant.skillRoots ?? [];
	const overlaid = /* @__PURE__ */ new Set();
	if (roots.length === 0) return overlaid;
	const skills = skillRegistry(agentCtx);
	if (skills === void 0) throw new Error(`agent-runtime: skill overlay roots [${roots.join(", ")}] were requested but the deployment provides no skill registry (ctx.skills)`);
	for (const root of roots) {
		let files;
		try {
			files = await listSkillFiles(root);
		} catch (error) {
			throw new Error(`agent-runtime: skill overlay root "${root}" is not readable: ${messageOf(error)}`);
		}
		for (const { name, file } of files) {
			if (overlaid.has(name)) continue;
			skills.register(await readSkillFile(file, name));
			overlaid.add(name);
		}
	}
	return overlaid;
}
/** Grant one worker's capability skills; overlay-registered names are skipped so the overlay body wins. */
async function grantSkills(agentCtx, agent, grant, overlaid) {
	const granted = /* @__PURE__ */ new Map();
	for (const capability of grant.capabilities) for (const skill of capability.skills) if (!granted.has(skill) && !overlaid.has(skill)) granted.set(skill, capability.capability);
	if (granted.size === 0) return;
	const skills = skillRegistry(agentCtx);
	if (skills === void 0) throw new Error(`agent-runtime: capabilities [${[...new Set(granted.values())].join(", ")}] grant skills [${[...granted.keys()].join(", ")}] but the deployment provides no skill registry (ctx.skills)`);
	const cwd = agent.session.header.cwd;
	for (const [name, capability] of granted) {
		const discovered = await skills.get(name, {
			scope: agent,
			cwd
		});
		if (discovered !== void 0) {
			skills.register(toRuntimeSkill(discovered));
			continue;
		}
		const file = await findSkillFile(name, cwd);
		if (file === void 0) {
			const roots = await skillRootsFor(cwd);
			throw new Error(`agent-runtime: capability "${capability}" grants skill "${name}" but no SKILL.md for it is reachable; searched ${roots.join(", ")}`);
		}
		skills.register(await readSkillFile(file, name));
	}
}
/** Mount every MCP server one grant declares, one mcp-client instance per spec, fail-closed on startup. */
async function mountMcpServers(agentCtx, agent, grant) {
	for (const spec of grant.mcpServers ?? []) try {
		await agentCtx.plugin(McpClient, {
			transport: "stdio",
			serverName: spec.serverName,
			command: spec.command,
			args: [...spec.args],
			env: { ...spec.env },
			cwd: spec.cwd,
			...spec.toolCallTimeoutMs === void 0 ? {} : { toolCallTimeoutMs: spec.toolCallTimeoutMs },
			failOnStartupError: true
		});
	} catch (error) {
		throw new Error(`agent-runtime: MCP server "${spec.serverName}" (command: ${spec.command}) failed to start for agent "${agent.id}": ${messageOf(error)}`);
	}
}
/** Apply one worker's grant: restrict tools, register skills, mount MCP servers — all fail-closed. */
async function applyWorkerGrant(agentCtx, agent, grant) {
	const { allow } = resolveGrant(agentCtx, agent, grant);
	try {
		agentCtx.tools.restrict({ allow });
	} catch (error) {
		const capabilities = grant.capabilities.map((capability) => capability.capability);
		throw new Error(`agent-runtime: could not restrict agent "${agent.id}" to [${allow.join(", ")}] for capabilit${capabilities.length === 1 ? "y" : "ies"} [${capabilities.join(", ")}]: ${messageOf(error)}`);
	}
	await grantSkills(agentCtx, agent, grant, await applySkillRoots(agentCtx, grant));
	await mountMcpServers(agentCtx, agent, grant);
}

//#endregion
//#region src/prompts/root.prompts.ts
/** The root’s authority and bootstrap. Its method is authored once in task-coordination/SKILL.md. */
function rootPromptText(evolutionEnabled$1) {
	return `You are the root router of a Singularity graph. You coordinate the user's complete objective through task workers and accept their combined evidence. Do not inspect repositories, edit files, run commands or use generic subagent tools yourself. Read graph records through task_read, task_status and context_read.

Before intake, load task-coordination with skill and follow its method. This bundled bootstrap guides intake. Every business Task, including your root contract, must select at least one relevant guidance Skill through requiredCapabilities. Check capability_list for the capability that grants the guidance; declare capability names, never substitute Skill names. After activation, your contract context automatically loads this Run's frozen instructions; those instructions govern the Run even when a later Skill load returns another version.

The available tool schemas define your operations and admission rules. ${evolutionEnabled$1 ? "Evolution tools are available for evidenced Task and Skill improvements, with capability/MCP changes when execution means are missing; follow their schemas and recorded human decisions." : "Delegate unavailable execution means to the appropriate Task or request the needed capability."}`;
}

//#endregion
//#region src/prompts/coordination.prompts.ts
/** Stable policies for the two coordination roles; source facts belong in their first request. */
const REVIEWER_POLICY_TEXT = `You are a Singularity reviewer. Read the recorded contract, verdict and original evidence. Explain what happened and cite what supports your conclusion. You do not change files, task state or production, and you do not spawn agents. Return the requested fenced JSON. Judge only useful, supported dimensions; missing evidence means unknown. Ordinary child repairs belong to their real parent. Propose shared changes only for an established Task, Skill or capability gap.`;
const SUPERVISOR_POLICY_TEXT = `You are a Singularity supervisor. Preserve the user's objective and original acceptance. Read the recorded outcome, Task recipe and frozen Skill bindings before proposing a minimal shared change. Improve Task definitions, direct-child DAG recipes and relevant Skill methods first; change Tool or MCP providers when recorded evidence shows that those providers cause the gap. Every business Task, including a coordinating parent and an atomic leaf, must select readable, relevant, nonempty guidance through requiredCapabilities and capability.skills. A generic coordination Skill does not replace a leaf's own method. Reuse an existing proposal for the diagnosis; its ledger status determines the next operation. Materialize and compare a candidate before requesting human approval through evolution_decide and evolution_apply. A Task recipe candidate must be consumed by an actual parent decomposition: use its exact templateRef and parameters, execute its direct children and dependencies, and judge the complete result under the original parent's acceptance. Editing a template or replaying an unrelated leaf proves no recipe improvement. For a verified source, evolution_replay must freeze objective tool-call-reduction, observed successful taskIds and independent holdoutTaskIds. Both sides retain acceptance; complete executed Run subtree tool-call counts must improve on observed cases and not grow on holdouts. Unknown cost proves no improvement. An approval refusal leaves the proposal at its recorded status; report its id and stop until a person continues. Apply necessary changes before recovery. A child is replanned by its responsible parent; task_recover opens a new root attempt only. Published changes affect new attempts or new child batches; admitted Tasks and frozen Runs retain their recorded definitions and Skill bytes. Never invent evidence or capabilities. When no justified action remains, close with the requested reason. Use only granted tools.`;

//#endregion
//#region src/prompts/worker.prompts.ts
/** The worker role's stable policy (A2), registered as the `singularity:worker` section (order 75). */
const WORKER_POLICY_TEXT = [
	"You are a Singularity task worker. The task you were delegated, its acceptance criteria and the current state of the project ride in your system context; the task store is the authority for all of it.",
	"",
	"## Rules",
	"",
	"- Your contract context loads the complete instructions from your Run’s frozen Skills. Follow them for the delegated work. Own your result and its acceptance; capabilities determine permissions, and reading a Skill never widens them.",
	"- Never declare completion yourself — an external verifier checks every mandatory criterion.",
	"- If you check an acceptance command before submission, use `task_verify`: it runs the contracted criteria under the verifier deadline. Do not copy an acceptance command into bash or a background job. On timeout or a faulty criterion, stop waiting and ask your parent or fail with the reason.",
	"- A criterion's declared protected inputs must not be modified: the verifier re-checks their identity before judging, and a changed or missing input fails the criterion, naming the path.",
	"- Keep changes scoped to this task. Need a human decision? Ask with `ask_user_question`.",
	"- Cannot continue? Fail with a clear reason — the orchestrator blocks dependent tasks and reports to the parent task.",
	"- This context is where you start, not the whole truth: re-read your own contract and run with `task_read`, the project state with `task_status`, and any record they name with `context_read` whenever you need them.",
	"- When the work is done, hand it in with `task_submit_result`: a summary of what you delivered plus the evidence references you produced. The call closes this run to further writes, drains the calls still in flight, and lets the runtime put the run in front of the verifier; the verdict comes back as its answer.",
	"- When the contract, the scope or the acceptance is genuinely undecidable from what you were given — the store does not answer it, the checkout does not settle it, and guessing would make a decision that is not yours — ask your direct parent with `task_ask_parent` {requestKey, question}: the addressee is fixed by your own run, and one question at a time is enough. Do not ask what `task_read`/`task_status`/`context_read` already answer, and do not hand back work you can decide yourself; say what you already know and what exactly you need from the answer. A question asked this way blocks this run by default: writes, commands, another decomposition and `task_submit_result` are refused until the parent answers with `resolves: true`, which is why an idle session waiting on one is not held against you. The answer arrives as a message and in your context; read it, then continue. Pass `blocking: false` only for a question you can work without.",
	"- If a child of your own asks you a question (it appears in your context under the pending questions, and in a message that reaches you), answer it with `task_answer` {questionId, requestKey, answer, resolves}: `resolves: true` declares the question settled and releases exactly that block on the child, `resolves: false` keeps it open and settles nothing. Answering changes no contract, no permission and no task state — say what you decided and what it rests on, and never answer a question that was not asked of you.",
	"- Going idle is not a submission. Submit when the work is done, or say what is missing with a clear failure.",
	"- `task_verify` is only a self-check: it re-runs the verifier and records the evidence it produces, never changes task status, and does not stand in for a submission."
].join("\n");
/** The first user message a task worker receives when its spawn carried no prompt of its own. */
const WORKER_KICKOFF_TEXT = "Begin your delegated task. Your contract, the root objective and the current task state are in your system context; re-read them with `task_read` whenever you need them, and hand the work in with `task_submit_result` when it is done.";

//#endregion
//#region src/raw-session-guard.ts
/** The four raw cross-session readers no Singularity role may execute. */
const RAW_SESSION_READ_TOOLS = [
	"session_event_read",
	"session_event_trace",
	"session_trace",
	"session_search"
];
/** The one denial reason every sealed call reports, by name. */
const RAW_SESSION_READ_DENIAL = "singularity: raw cross-session reads are sealed; use context_read";
/** Deny the four readers on one agent's own scope, for the agent's whole life. */
function sealRawSessionReads(agentCtx) {
	agentCtx.tools.guard((execution) => RAW_SESSION_READ_TOOLS.includes(execution.name) ? RAW_SESSION_READ_DENIAL : void 0);
}

//#endregion
//#region src/worker-resume.ts
/** The permission posture a worker runs under when nobody decided one for it — the spawn's own default. */
const WORKER_DEFAULT_PERMISSION_PRESET = "danger-full-access";
/** One refused resume, with the stable name of what could not be established. */
var WorkerResumeRefusal = class extends Error {
	code;
	constructor(code, message, options) {
		super(message, options);
		this.name = "WorkerResumeRefusal";
		this.code = code;
	}
};
/** The one marker `TaskRun.capabilitySnapshot` uses for a granted MCP server's plane (`task-runtime/src/capability.ts`). */
const MCP_PLANE_MARKER = "mcp:";
/** Bring the persisted Session back live and idle, or refuse by name; every check before the resume is a read. */
async function resumeWorkerAgent(deps, request) {
	const sessionId = SessionId(request.sessionId);
	if (deps.agents.get(sessionId) !== void 0) throw new WorkerResumeRefusal("ownership-conflict", `agent-runtime: session "${String(sessionId)}" is already live; a resume must wait until its owner settles`);
	const persisted = await readPersistedSession(deps, sessionId);
	const header = persisted.session;
	const agentPreset = assertRunBinding(request, header, ownSuffix(persisted));
	const member = await assertGraphMember(deps, request, header, sessionId);
	const role = workerRole(request, agentPreset);
	if (member.status === "running") await deps.graph.setStatusIn(request.scope.graphStoreId, sessionId, "idle");
	return await resume(deps, request, sessionId, role);
}
/** One Session's persisted header and events, read through the deployment's own query path. */
async function readPersistedSession(deps, sessionId) {
	try {
		return await deps.sessionQuery.readSession(sessionId);
	} catch (error) {
		if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") throw new WorkerResumeRefusal("session-missing", `agent-runtime: session "${String(sessionId)}" does not exist; a worker recovery resumes a Session, it never creates one`, { cause: error });
		throw new WorkerResumeRefusal("session-unreadable", `agent-runtime: session "${String(sessionId)}" could not be read, so it cannot be taken over safely: ${messageOf(error)}`, { cause: error });
	}
}
/** Refuse a declared Run, grant or permission the Session's own durable record contradicts. */
function assertRunBinding(request, header, own) {
	const run = request.run;
	if (run.storeId === "" || run.taskId === "" || run.runId === "") throw new WorkerResumeRefusal("binding-mismatch", `agent-runtime: the declared run identity is empty (store "${run.storeId}", task "${run.taskId}", run "${run.runId}")`);
	if (String(run.sessionId) !== String(header.id)) throw new WorkerResumeRefusal("binding-mismatch", `agent-runtime: run "${run.runId}" binds session "${String(run.sessionId)}", not the session "${String(header.id)}" being resumed`);
	if (header.agentPreset === void 0) throw new WorkerResumeRefusal("binding-mismatch", `agent-runtime: session "${String(header.id)}" names no agent preset, so the composition run "${run.runId}" was spawned in cannot be rebuilt`);
	if (run.agentPreset !== void 0 && run.agentPreset !== header.agentPreset) throw new WorkerResumeRefusal("binding-mismatch", `agent-runtime: run "${run.runId}" recorded agent preset "${run.agentPreset}" but session "${String(header.id)}" ran under "${header.agentPreset}"`);
	const recorded = [...new Set(run.capabilitySnapshot)].sort();
	const declared = declaredPlane(request.grant);
	if (recorded.join("\n") !== declared.join("\n")) throw new WorkerResumeRefusal("binding-mismatch", `agent-runtime: run "${run.runId}" was admitted with capability plane [${recorded.join(", ")}] but the resume declares [${declared.join(", ")}]`);
	const applied = request.permissionPreset ?? WORKER_DEFAULT_PERMISSION_PRESET;
	const recordedPermission = lastPermissionPreset(own);
	if (recordedPermission !== void 0 && recordedPermission !== applied) throw new WorkerResumeRefusal("binding-mismatch", `agent-runtime: session "${String(header.id)}" recorded permission preset "${recordedPermission}" but the resume would apply "${applied}"`);
	return header.agentPreset;
}
/** Refuse a Session the graph does not publish, or one whose delegation facts cannot be verified. */
async function assertGraphMember(deps, request, header, sessionId) {
	let snapshot;
	try {
		snapshot = await deps.graph.snapshotIn(request.scope.graphStoreId);
	} catch (error) {
		throw new WorkerResumeRefusal("member-facts-missing", `agent-runtime: graph store "${request.scope.graphStoreId}" could not be read, so session "${String(sessionId)}" cannot be shown to be a member: ${messageOf(error)}`, { cause: error });
	}
	const node = snapshot.agents.find((agent) => String(agent.id) === String(sessionId));
	if (node === void 0) throw new WorkerResumeRefusal("not-in-graph", `agent-runtime: session "${String(sessionId)}" is not published by graph store "${request.scope.graphStoreId}"; a worker recovery resumes a member, it never adds one`);
	const delegation = snapshot.edges.find((edge) => edge.kind === "spawn" && String(edge.to) === String(sessionId));
	if (delegation === void 0) throw new WorkerResumeRefusal("member-facts-missing", snapshot.roots.some((candidate) => String(candidate) === String(sessionId)) ? `agent-runtime: session "${String(sessionId)}" is a root of graph store "${request.scope.graphStoreId}"; a root's recovery entry is ensureRoot, not a worker resume` : `agent-runtime: graph store "${request.scope.graphStoreId}" records no spawn edge into session "${String(sessionId)}", so its delegation cannot be verified`);
	if (header.parentSession === void 0) throw new WorkerResumeRefusal("member-facts-missing", `agent-runtime: session "${String(sessionId)}" records no parent session, but graph store "${request.scope.graphStoreId}" holds a spawn edge from "${String(delegation.from)}"`);
	if (String(header.parentSession) !== String(delegation.from)) throw new WorkerResumeRefusal("binding-mismatch", `agent-runtime: session "${String(sessionId)}" records parent "${String(header.parentSession)}" but graph store "${request.scope.graphStoreId}" holds its spawn edge from "${String(delegation.from)}"`);
	return { status: node.status };
}
/** The composition a resume rebuilds: the request states it, the binding check verified the preset. */
function workerRole(request, agentPreset) {
	return {
		agentPreset,
		permissionPreset: request.permissionPreset ?? WORKER_DEFAULT_PERMISSION_PRESET,
		taskWorker: request.taskWorker,
		...request.grant === void 0 ? {} : { grant: request.grant }
	};
}
/** Take the Session over through DSH's own resume, naming every refusal it raises. */
async function resume(deps, request, sessionId, role) {
	try {
		return await deps.agents.resume({
			resumeSessionId: sessionId,
			...deps.agentOptions === void 0 ? {} : { agentOptions: deps.agentOptions },
			setup: deps.setup(role)
		});
	} catch (error) {
		if (error instanceof SessionAlreadyOwnedError) throw new WorkerResumeRefusal("ownership-conflict", `agent-runtime: session "${String(sessionId)}" is already owned by a write handle; retry the resume once that owner settles`, { cause: error });
		throw new WorkerResumeRefusal("takeover-refused", `agent-runtime: session "${String(sessionId)}" could not be taken over safely: ${messageOf(error)}`, { cause: error });
	}
}
/** The granted plane one grant declares: every capability's tools and skills, plus each MCP server's marker. */
function declaredPlane(grant) {
	const plane = /* @__PURE__ */ new Set();
	for (const capability of grant?.capabilities ?? []) {
		for (const tool of capability.tools) plane.add(tool);
		for (const skill of capability.skills) plane.add(skill);
	}
	for (const server of grant?.mcpServers ?? []) plane.add(`${MCP_PLANE_MARKER}${server.serverName}`);
	return [...plane].sort();
}
/** The permission preset the Session's own log last recorded, or `undefined` when it recorded none. */
function lastPermissionPreset(own) {
	for (let index = own.length - 1; index >= 0; index -= 1) {
		const event = own[index];
		if (event.type === "permission/preset") return event.data.preset;
	}
}

//#endregion
//#region src/index.ts
/** Descriptor provider name for workers: this runtime establishes them, not a registered `ctx.subagents` provider. */
const WORKER_DESCRIPTOR_PROVIDER = "singularity-runtime";
var AgentRuntime = class extends Service {
	static inject = [
		"agentDefaultModel",
		"agentPresets",
		"agents",
		"graph",
		"layout",
		"permissionPresets",
		"sessions",
		"sessionPersistence",
		"sessionQuery"
	];
	owned = /* @__PURE__ */ new Set();
	roots = /* @__PURE__ */ new Set();
	handles = /* @__PURE__ */ new Map();
	scopes = /* @__PURE__ */ new Map();
	operations = /* @__PURE__ */ new Map();
	stopping = /* @__PURE__ */ new Set();
	closing = false;
	resuming = /* @__PURE__ */ new Map();
	constructor(ctx) {
		super(ctx, "agentRuntime");
		ctx.on("agent/status", ({ agent, status }) => {
			const scope = this.scopes.get(agent.id);
			if (scope !== void 0) ctx.graph.setStatusIn(scope.graphStoreId, agent.id, status);
		});
		ctx.effect(() => async () => {
			this.closing = true;
			await Promise.all(this.operations.values());
			await this.stopAgents([...this.handles.keys()]);
			this.operations.clear();
			this.handles.clear();
			this.owned.clear();
			this.roots.clear();
			this.scopes.clear();
		}, "agentRuntime: dispose");
	}
	async ensureRoot(sessionId, scope) {
		if (this.closing) throw new Error("agent-runtime: closing");
		const pending = this.resuming.get(sessionId);
		if (pending !== void 0) {
			if (pending.scope.graphStoreId !== scope.graphStoreId || pending.scope.layoutStoreId !== scope.layoutStoreId) throw new Error("agent-runtime: concurrent root scope mismatch");
			return pending.handle;
		}
		const handle = this.inGraph(scope, () => this.resumeRoot(sessionId, scope)).finally(() => this.resuming.delete(sessionId));
		this.resuming.set(sessionId, {
			scope,
			handle
		});
		return handle;
	}
	async resumeRoot(sessionId, scope) {
		const existing = this.handles.get(sessionId);
		if (existing !== void 0) {
			const known = this.scope(sessionId);
			if (known.graphStoreId !== scope.graphStoreId || known.layoutStoreId !== scope.layoutStoreId) throw new Error("agent-runtime: root scope changed while live");
			return existing;
		}
		const snapshot = await this.ctx.graph.snapshotIn(scope.graphStoreId);
		const persisted = snapshot.agents.find((agent) => agent.id === sessionId);
		if (persisted === void 0) throw new Error(`agent-runtime: root "${sessionId}" is not in graph`);
		if (!snapshot.roots.includes(sessionId)) throw new Error(`agent-runtime: "${sessionId}" is not a root`);
		const agentPreset = new Map((await this.ctx.sessionPersistence.list()).map((item) => [item.header.id, item.header])).get(sessionId)?.agentPreset;
		if (agentPreset === void 0) throw new Error(`agent-runtime: root session "${sessionId}" has no agent preset`);
		if (this.ctx.agents.get(sessionId) !== void 0) throw new Error(`agent-runtime: root "${sessionId}" is owned by another runtime`);
		if (persisted.status === "running") await this.ctx.graph.setStatusIn(scope.graphStoreId, sessionId, "idle");
		this.owned.add(sessionId);
		this.roots.add(sessionId);
		this.scopes.set(sessionId, scope);
		try {
			const handle = await this.ctx.agents.resume({
				resumeSessionId: sessionId,
				agentOptions: this.ctx.agentDefaultModel.currentSelection(),
				setup: rootSetup(this.ctx, agentPreset)
			});
			this.handles.set(sessionId, handle);
			return handle;
		} catch (error) {
			await this.releaseSession(sessionId);
			throw error;
		}
	}
	async createRoot(request) {
		return this.inGraph(request.scope, async () => {
			this.owned.add(request.sessionId);
			this.scopes.set(request.sessionId, request.scope);
			const agentPreset = request.agentPreset ?? this.ctx.agentPresets.defaultId;
			let handle;
			try {
				handle = await this.ctx.agents.create({
					sessionId: request.sessionId,
					meta: {
						cwd: request.cwd,
						agentPreset
					},
					agentOptions: {
						...this.ctx.agentDefaultModel.currentSelection(),
						...request.agentOptions
					},
					setup: rootSetup(this.ctx, agentPreset)
				});
			} catch (error) {
				await this.releaseSession(request.sessionId);
				throw error;
			}
			try {
				await this.ctx.layout.setIn(request.scope.layoutStoreId, handle.agent.id, DEFAULT_ROOT);
				await this.ctx.graph.addAgentIn(request.scope.graphStoreId, {
					id: handle.agent.id,
					name: "Singularity",
					status: "idle"
				}, true);
				this.roots.add(handle.agent.id);
				this.handles.set(handle.agent.id, handle);
				return handle;
			} catch (error) {
				await this.releaseSession(handle.agent.id, handle);
				throw error;
			}
		});
	}
	async spawn(parent, request) {
		if (this.closing) throw new Error("agent-runtime: closing");
		if (request.prompt === void 0 && request.taskWorker !== true) throw new Error("agent-runtime: a spawn request needs a prompt (a taskWorker spawn gets the default kickoff)");
		this.live(parent);
		const scope = this.scope(parent.id);
		return this.inGraph(scope, async () => {
			this.live(parent);
			this.owned.add(request.sessionId);
			this.scopes.set(request.sessionId, scope);
			let handle;
			try {
				const agentPreset = request.agentPreset ?? parent.session.header.agentPreset;
				const parentHeader = parent.session.header;
				handle = await this.ctx.agents.create({
					sessionId: request.sessionId,
					meta: {
						cwd: request.cwd ?? parentHeader.cwd,
						agentPreset,
						parentSession: parentHeader.id,
						isSeeded: false,
						origin: "subagent",
						delegationDepth: (parentHeader.delegationDepth ?? 0) + 1
					},
					agentOptions: {
						...this.ctx.agentDefaultModel.currentSelection(),
						...request.agentOptions
					},
					signal: request.signal,
					setup: workerSetup(this.ctx, {
						agentPreset,
						permissionPreset: request.permissionPreset ?? WORKER_DEFAULT_PERMISSION_PRESET,
						taskWorker: request.taskWorker === true,
						...request.coordinationRole === void 0 ? {} : { coordinationRole: request.coordinationRole },
						...request.grant === void 0 ? {} : { grant: request.grant }
					})
				});
			} catch (error) {
				await this.releaseSession(request.sessionId);
				throw error;
			}
			handle.agent.session.append("subagent/descriptor", snapshotSubagentDescriptor({
				mode: "one-shot",
				provider: WORKER_DESCRIPTOR_PROVIDER,
				label: request.name
			}));
			let published = false;
			try {
				const events = [{
					kind: "agent/add",
					agent: {
						id: handle.agent.id,
						name: request.name,
						status: "idle"
					}
				}, {
					kind: "edge/add",
					edge: {
						id: `${parent.id}->${handle.agent.id}`,
						kind: "spawn",
						from: parent.id,
						to: handle.agent.id
					}
				}];
				const snapshot = await this.ctx.graph.snapshotIn(scope.graphStoreId);
				await this.ctx.layout.setIn(scope.layoutStoreId, handle.agent.id, {
					...DEFAULT_ROOT,
					x: DEFAULT_ROOT.x + 240,
					y: DEFAULT_ROOT.y + snapshot.agents.length * 116
				});
				await this.ctx.graph.commitIn(scope.graphStoreId, events);
				published = true;
				this.owned.add(handle.agent.id);
				this.scopes.set(handle.agent.id, scope);
				this.handles.set(handle.agent.id, handle);
				await this.ctx.parallel("agentRuntime/spawned", {
					parentId: parent.id,
					sessionId: handle.agent.id
				});
				await request.beforePrompt?.();
				const kickoff = request.prompt ?? [{
					type: "text",
					text: WORKER_KICKOFF_TEXT
				}];
				handle.agent.followup(createUserMessage({
					content: [...kickoff],
					source: runtimePrompt("spawn")
				}));
				return handle;
			} catch (error) {
				await this.releaseSession(handle.agent.id, handle);
				if (published) await this.ctx.graph.setStatusIn(scope.graphStoreId, handle.agent.id, "failed");
				throw error;
			}
		});
	}
	/** Bring one spawned worker's persisted Session back live and idle; refusals are named (A4 §F.1). */
	async resumeWorkerAgent(request) {
		if (this.closing) throw new Error("agent-runtime: closing");
		const sessionId = SessionId(request.sessionId);
		return await this.inGraph(request.scope, async () => {
			this.owned.add(sessionId);
			this.scopes.set(sessionId, request.scope);
			try {
				const handle = await resumeWorkerAgent(this.workerResumeDeps(request), request);
				this.handles.set(sessionId, handle);
				return handle;
			} catch (error) {
				await this.releaseSession(sessionId);
				throw error;
			}
		});
	}
	async stopGraph(scope) {
		if (this.closing) throw new Error("agent-runtime: closing");
		if (this.stopping.has(scope.graphStoreId)) throw new Error("agent-runtime: graph already stopping");
		this.stopping.add(scope.graphStoreId);
		const run = (this.operations.get(scope.graphStoreId) ?? Promise.resolve()).then(async () => {
			const graph = await this.ctx.graph.snapshotIn(scope.graphStoreId);
			await this.stopAgents(graph.agents.map((agent) => agent.id));
		}).finally(() => {
			this.stopping.delete(scope.graphStoreId);
		});
		this.operations.set(scope.graphStoreId, run.then(() => void 0, () => void 0));
		return run;
	}
	async stopAgents(sessionIds) {
		for (const id of sessionIds) {
			const pending = this.resuming.get(id);
			if (pending !== void 0) await pending.handle;
			const handle = this.handles.get(id);
			if (handle === void 0) {
				if (this.ctx.agents.get(id) !== void 0) throw new Error(`agent-runtime: cannot stop unowned agent "${id}"`);
				this.owned.delete(id);
				this.roots.delete(id);
				this.scopes.delete(id);
				continue;
			}
			await this.releaseSession(id, handle);
		}
	}
	async prompt(agent, prompt) {
		if (this.closing) throw new Error("agent-runtime: closing");
		this.live(agent);
		const scope = this.scope(agent.id);
		if (this.stopping.has(scope.graphStoreId)) throw new Error("agent-runtime: graph stopping");
		if ((await this.ctx.graph.snapshotIn(scope.graphStoreId)).agents.every((item) => item.id !== agent.id)) throw new Error(`agent-runtime: agent "${agent.id}" is not in graph`);
		this.live(agent);
		agent.followup(createUserMessage({
			content: [...prompt],
			source: runtimePrompt("prompt")
		}));
	}
	/** Read back the body of a `tool/call` a question or answer cites, flushing the sender first (A4 §F.1). */
	async readToolCallBody(ref) {
		if (this.closing) throw new Error("agent-runtime: closing");
		return await readToolCallBody(this.deliveryDeps(), ref);
	}
	/** Deliver one already-committed message identity at most once and report what the target log witnesses. */
	async ensureAgentMessageDelivered(intent) {
		if (this.closing) throw new Error("agent-runtime: closing");
		return await ensureAgentMessageDelivered(this.deliveryDeps(), intent);
	}
	/** Reconcile a set of committed intents against their target Sessions, one at a time (A4 §F.1). */
	async reconcileAgentMessageDeliveries(intents) {
		if (this.closing) throw new Error("agent-runtime: closing");
		return await reconcileAgentMessageDeliveries(this.deliveryDeps(), intents);
	}
	deliveryDeps() {
		return {
			agents: this.ctx.agents,
			sessions: this.ctx.sessions,
			sessionQuery: this.ctx.sessionQuery
		};
	}
	/** What one worker resume reaches: the live registry, the session read path, the graph store, composition and options. */
	workerResumeDeps(request) {
		return {
			agents: this.ctx.agents,
			sessionQuery: this.ctx.sessionQuery,
			graph: this.ctx.graph,
			setup: (role) => workerSetup(this.ctx, role),
			agentOptions: {
				...this.ctx.agentDefaultModel.currentSelection(),
				...request.agentOptions
			}
		};
	}
	inGraph(scope, work) {
		if (this.closing) throw new Error("agent-runtime: closing");
		if (this.stopping.has(scope.graphStoreId)) throw new Error("agent-runtime: graph stopping");
		const run = (this.operations.get(scope.graphStoreId) ?? Promise.resolve()).then(work);
		this.operations.set(scope.graphStoreId, run.then(() => void 0, () => void 0));
		return run;
	}
	/** Forget one session this runtime was composing; only a handle this attempt owns is unregistered and disposed. */
	async releaseSession(sessionId, handle) {
		this.owned.delete(sessionId);
		this.roots.delete(sessionId);
		this.scopes.delete(sessionId);
		if (handle !== void 0) {
			this.handles.delete(sessionId);
			await handle.dispose();
		}
	}
	live(agent) {
		if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`agent-runtime: agent "${agent.id}" is not live`);
	}
	scope(sessionId) {
		const scope = this.scopes.get(sessionId);
		if (scope === void 0) throw new Error("agent-runtime: agent has no graph scope");
		return scope;
	}
};
/** One message source of this runtime's own, as {@link RuntimePromptSource} declares it. */
function runtimePrompt(channel) {
	return {
		kind: "runtime-prompt",
		channel
	};
}
/** The nine tools the evolution chain is reached through; a deployment's switch is what registers them. */
const EVOLUTION_TOOLS = [
	"evolution_propose",
	"evolution_candidate",
	"evolution_prepare",
	"evolution_replay",
	"evolution_gate",
	"evolution_decide",
	"evolution_apply",
	"evolution_rollback",
	"evolution_list"
];
/** The tools every root may call whatever the deployment's evolution switch says (README Design notes). */
const ROOT_CORE_TOOLS = [
	"graph_spawn",
	"graph_mark_ready",
	"hitl_ask",
	"hitl_approve",
	"task_read",
	"capability_list",
	"task_template_list",
	"context_read",
	"skill",
	"task_intake",
	"task_decompose",
	"task_submit_result",
	"task_answer",
	"task_cancel",
	"task_proposal_read",
	"task_proposal_continue",
	"task_proposal_cancel",
	"task_status",
	"task_verify",
	"task_review_pack",
	"task_review_agent",
	"task_diagnose",
	"task_budget_extend"
];
/** Whether this composition registered the nine `evolution_*` tools; a context without the service reads as off. */
function evolutionEnabled(ctx) {
	return ctx.get("singularityEvolution")?.enabled ?? false;
}
/** The root's tool allow-list for one composition: the core tools plus `escalate`, plus the chain when it is on. */
function rootToolsFor(enabled) {
	return enabled ? [
		...ROOT_CORE_TOOLS,
		...EVOLUTION_TOOLS,
		"escalate"
	] : [...ROOT_CORE_TOOLS, "escalate"];
}
/** Root-local registrations also obey the coordination allow-list. */
function sealRootTools(agentCtx, enabled) {
	agentCtx.tools.presentAs("native");
	const allowed = new Set(rootToolsFor(enabled));
	agentCtx.tools.guard((execution) => allowed.has(execution.name) ? void 0 : "singularity: the root coordinates through task tools; delegate engineering work with task_decompose");
}
/** Compose one root's scoped world; `createRoot` and `resumeRoot` both hand this to the agent factory. */
function rootSetup(ctx, agentPreset) {
	return async (agentCtx, agent) => {
		await ctx.agentPresets.mount(agentCtx, agentPreset);
		ctx.permissionPresets.set(agent.session, "danger-full-access");
		setApprovalPolicy(agent.session, "ask");
		const evolution = evolutionEnabled(ctx);
		agentCtx.systemPrompt.section({
			name: "singularity:root",
			order: 70,
			text: rootPromptText(evolution)
		});
		agentCtx.tools.restrict({ allow: rootToolsFor(evolution) });
		await applySkillRoots(agentCtx, {
			capabilities: [],
			baseline: [],
			keepPresetTools: false,
			skillRoots: [fileURLToPath(new URL("../skills/", import.meta.url))]
		});
		sealRawSessionReads(agentCtx);
		sealRootTools(agentCtx, evolution);
	};
}
/** The one composition a worker's scoped world is built from; `spawn` and a resume both hand this to the factory. */
function workerSetup(ctx, role) {
	return async (agentCtx, agent) => {
		await ctx.agentPresets.mount(agentCtx, role.agentPreset);
		ctx.permissionPresets.set(agent.session, role.permissionPreset);
		if (role.coordinationRole !== void 0) {
			if (role.coordinationRole === "supervisor") setApprovalPolicy(agent.session, "ask");
			agentCtx.systemPrompt.section({
				name: `singularity:${role.coordinationRole}`,
				order: 75,
				text: role.coordinationRole === "reviewer" ? REVIEWER_POLICY_TEXT : SUPERVISOR_POLICY_TEXT,
				interpolate: false
			});
		}
		if (role.taskWorker) agentCtx.systemPrompt.section({
			name: "singularity:worker",
			order: 75,
			text: WORKER_POLICY_TEXT,
			interpolate: false
		});
		if (role.grant !== void 0) await applyWorkerGrant(agentCtx, agent, role.grant);
		sealRawSessionReads(agentCtx);
	};
}
var src_default = AgentRuntime;

//#endregion
export { AgentRuntime, RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS, WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT, WorkerResumeRefusal, answerMessageText, applyWorkerGrant, src_default as default, findSkillFileIn, parseSkillFile, questionMessageText, skillRootsFor, toolCallRefIn };