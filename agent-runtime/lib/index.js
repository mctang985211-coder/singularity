import { Context, Service } from "@deepseek-ai/cordis";
import { MessageId, createUserMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { snapshotSubagentDescriptor } from "@deepseek-ai/dsh-subagent";
import { DEFAULT_ROOT } from "@dangosys/dsh-singularity-graph";
import { RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import SkillRegistry, { renderSkillContent } from "@deepseek-ai/dsh-skill";
import { FileSystemSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import * as ToolSkill from "@deepseek-ai/dsh-tool-skill";
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
//#region src/delegation-guard.ts
const TASK_DELEGATION_DENIAL = "singularity: delegate through task_decompose; native subagent/workflow delegation has no Task contract or Run";
/** The native delegation tools in the supported DSH presets, including optional external providers. */
function isNativeDelegationTool(name) {
	return name === "subagent" || name.startsWith("subagent_") || name === "workflow" || name === "ralph";
}
/** Local tools can escape schema restriction; enforce the same rule at execution on create and resume. */
function sealNativeDelegation(agentCtx) {
	agentCtx.tools.guard((execution) => isNativeDelegationTool(execution.name) ? TASK_DELEGATION_DENIAL : void 0);
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
/** Deliver the Run's explicitly bound methods before its first model action. */
function installBoundSkillInstructions(local, definitions) {
	const methods = definitions.filter((skill) => skill.invocation?.modelInvocable !== false);
	if (methods.length === 0) return;
	local.on("agent/pre-step", async ({ agent, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || decision.messages.some((message) => message.source.kind === "task-skills")) return decision;
		if (agent.session.surface.nodes.some((seq) => {
			const event = agent.session.eventAt(seq);
			return event?.type === "user/message" && event.data.source.kind === "task-skills" && event.data.source.names.length === methods.length && methods.every((skill) => event.data.source.kind === "task-skills" && event.data.source.names.includes(skill.name));
		})) return decision;
		signal.throwIfAborted();
		return {
			...decision,
			messages: [...decision.messages, createUserMessage({
				source: {
					kind: "task-skills",
					form: "instructions",
					names: methods.map((skill) => skill.name)
				},
				content: [{
					type: "text",
					text: methods.map((skill) => renderSkillContent({
						...skill,
						provider: "runtime"
					})).join("\n\n")
				}]
			})]
		};
	});
}
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
	for (const capability of grant.capabilities) {
		const bypasses = capability.tools.filter(isNativeDelegationTool);
		if (bypasses.length > 0) throw new Error(`agent-runtime: capability "${capability.capability}" declares native delegation tools [${bypasses.join(", ")}]; ${TASK_DELEGATION_DENIAL}`);
	}
	assertCapabilityTools(grant, visible);
	const allow = /* @__PURE__ */ new Set();
	for (const capability of grant.capabilities) for (const tool of capability.tools) allow.add(tool);
	for (const tool of grant.baseline) if (visible.has(tool) && !isNativeDelegationTool(tool)) allow.add(tool);
	if (grant.keepPresetTools) {
		const global = visibleToolNames(agentCtx);
		for (const tool of visible) if (!global.has(tool) && !isNativeDelegationTool(tool)) allow.add(tool);
	}
	return {
		allow: [...allow].sort(),
		baselineUnavailable: [...new Set(grant.baseline.filter((tool) => !visible.has(tool)))].sort()
	};
}
/** A separate registry prevents host providers from merging into the agent's catalog. */
async function isolatedSkills(agentCtx) {
	const local = agentCtx.isolate("skills");
	await local.plugin(SkillRegistry, {});
	return local;
}
/** Keep native catalog middleware outside the host's same-name catalog cleanup. */
const ScopedSkillTool = {
	name: "singularity-scoped-skill",
	inject: ToolSkill.inject,
	apply(ctx) {
		const native = ctx.extend({ on(name, listener, options) {
			return ctx.on(name, listener, {
				...typeof options === "boolean" ? { prepend: options } : options,
				...name === "agent/pre-step" ? { prepend: true } : {}
			});
		} });
		ToolSkill.apply(native);
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			const decision = await next();
			if (decision.kind === "reject") return decision;
			const allowed = new Set((await ctx.skills.list({
				scope: agent,
				cwd: agent.session.header.cwd,
				signal
			})).filter((skill) => skill.invocation.userInvocable).map((skill) => skill.name));
			const seen = /* @__PURE__ */ new Set();
			const messages = decision.messages.slice().reverse().filter((message) => {
				if (message.source.kind !== "skill-invocation") return true;
				const name = message.source.name;
				if (!allowed.has(name) || seen.has(name)) return false;
				seen.add(name);
				return true;
			}).reverse();
			return {
				...decision,
				messages
			};
		}, { prepend: true });
	}
};
/** Use the native loader/catalog with only this graph's active method roots. */
async function installGraphSkillCatalog(agentCtx, options, exposeTool = true) {
	const local = await isolatedSkills(agentCtx);
	let invalidate;
	let files;
	local.get("skills").registerProvider((control) => {
		invalidate = control.invalidate;
		files = new FileSystemSkillProvider(local, control, {
			providerName: "singularity-graph",
			includeDefaultRoots: false,
			customSkillDirs: [...options.skillRoots],
			watch: false
		});
		return {
			name: files.name,
			async list(lookup) {
				const observation = await files.list(lookup);
				const candidates = Array.isArray(observation) ? observation : observation.candidates;
				const latest = options.readLibrary === void 0 ? void 0 : new Map((await options.readLibrary()).skills.map((row) => [row.name, row.status]));
				const visible = candidates.filter((candidate) => latest === void 0 || latest.get(candidate.name) !== "retired");
				return Array.isArray(observation) ? visible : {
					...observation,
					candidates: visible
				};
			},
			get: (candidate, lookup) => files.get(candidate, lookup)
		};
	});
	local.on("agent/pre-step", (_event, next) => {
		invalidate();
		return next();
	});
	if (exposeTool) await local.plugin(ScopedSkillTool);
	return local;
}
/** Resolve only explicitly granted names before detaching the host registry. */
async function frozenGrantSkills(agentCtx, agent, grant) {
	const granted = /* @__PURE__ */ new Map();
	for (const capability of grant.capabilities) for (const name of capability.skills) if (!granted.has(name)) granted.set(name, capability.capability);
	const roots = grant.skillRoots ?? [];
	const host = skillRegistry(agentCtx);
	if (host === void 0 && (granted.size > 0 || roots.length > 0)) {
		const requested = roots.length > 0 ? `skill overlay roots [${roots.join(", ")}] were requested` : `capabilities [${[...new Set(granted.values())].join(", ")}] grant skills [${[...granted.keys()].join(", ")}]`;
		throw new Error(`agent-runtime: ${requested} but the deployment provides no skill registry (ctx.skills)`);
	}
	const definitions = /* @__PURE__ */ new Map();
	for (const root of roots) {
		let files;
		try {
			files = await listSkillFiles(root);
		} catch (error) {
			throw new Error(`agent-runtime: skill overlay root "${root}" is not readable: ${messageOf(error)}`);
		}
		for (const { name, file } of files) if (granted.has(name) && !definitions.has(name)) definitions.set(name, await readSkillFile(file, name));
	}
	const cwd = agent.session.header.cwd;
	for (const [name, capability] of granted) {
		if (definitions.has(name)) continue;
		const discovered = await host.get(name, {
			scope: agent,
			cwd
		});
		if (discovered !== void 0) {
			definitions.set(name, toRuntimeSkill(discovered));
			continue;
		}
		const file = await findSkillFile(name, cwd);
		if (file === void 0) throw new Error(`agent-runtime: capability "${capability}" grants skill "${name}" but no SKILL.md for it is reachable; searched ${(await skillRootsFor(cwd)).join(", ")}`);
		definitions.set(name, await readSkillFile(file, name));
	}
	return [...definitions.values()];
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
async function applyWorkerGrant(agentCtx, agent, grant, graphCatalog) {
	const { allow } = resolveGrant(agentCtx, agent, grant);
	try {
		agentCtx.tools.restrict({ allow });
	} catch (error) {
		const capabilities = grant.capabilities.map((capability) => capability.capability);
		throw new Error(`agent-runtime: could not restrict agent "${agent.id}" to [${allow.join(", ")}] for capabilit${capabilities.length === 1 ? "y" : "ies"} [${capabilities.join(", ")}]: ${messageOf(error)}`);
	}
	if (graphCatalog !== void 0) await installGraphSkillCatalog(agentCtx, graphCatalog, allow.includes("skill"));
	else {
		const definitions = await frozenGrantSkills(agentCtx, agent, grant);
		const local = await isolatedSkills(agentCtx);
		const skills = local.get("skills");
		for (const definition of definitions) skills.register(definition);
		if (allow.includes("skill")) await local.plugin(ScopedSkillTool);
		installBoundSkillInstructions(local, definitions);
	}
	await mountMcpServers(agentCtx, agent, grant);
}

//#endregion
//#region src/prompts/root.prompts.ts
/** The graph root turns a user's objective and metrics into an executable contract. */
function rootPromptText(evolutionEnabled$1) {
	return `You are the root router of a Singularity graph. You coordinate the user's complete objective through task workers and own the combined result. Start from the user's task and metrics: investigate the available environment, state useful assumptions, and define the result and checks for this execution. Use your tools for local investigation, measurement and implementation, and delegate useful independent results to Tasks. Resolve ordinary engineering choices from evidence; ask the user for consequential decisions about their objective or authority. An exploratory Task can supply facts needed for a later implementation.

Before intake, load task-coordination with skill and read task_library, capability_list and relevant task_template_list entries. The graph's library holds reusable TaskTemplates and their guidance Skills. Bind a fitting template and its exact parameters, or author the contract the current task needs. Declare each Task's execution capabilities and relevant guidance through requiredCapabilities, using actual catalog names. Define useful direct children with owned results, inputs and checks; they choose their descendants. Integrate their evidence and deliver the complete objective.

A Task owns this execution's goal and acceptance. A TaskTemplate records reusable goals and decomposition; a Skill records methods, conditions and experience. You may record useful exploratory goals or methods in the graph library as temporary templates or Skills. ${evolutionEnabled$1 ? "Evolution tools are available for Task and Skill improvements and capability/MCP changes when execution means are missing. The RSI supervisor reviews the library and actual results, chooses what to retain or modify, compares candidates, publishes, and inspects later consumption. Weigh task quality and performance together with recorded model tokens, cache traffic, tool work and cost. Work within budget and recorded human decisions." : "Return useful goals, methods and capability gaps with Task/Run and evidence references. Delegate execution to Tasks through requiredCapabilities."}`;
}

//#endregion
//#region src/prompts/coordination.prompts.ts
/** Stable role guidance; exact source facts are supplied in the first request. */
const REVIEWER_POLICY_TEXT = `You are a Singularity reviewer. Investigate the requested Task/Run through its original evidence, task tree, graph library and frozen Skills. Explain causes, useful next actions, applicability conditions and uncertainties. Weigh task quality and performance alongside recorded model usage and tool work. Use your granted reads and return the requested JSON with evidence references. Return ordinary repairs to the responsible parent and reusable method findings to the supervisor.`;
const SUPERVISOR_POLICY_TEXT = `You are a Singularity supervisor. Read task_library, the actual task tree, results and costs. Review exploratory goals, decomposition templates and Skill experience; record retention or retirement with task_library review, and write useful revisions. A Task's acceptance belongs to that execution. TaskTemplates teach reusable goals and decomposition; Skills teach paths, methods and conditions. Preserve the user's objective and the original checks of each compared task.

Choose the responsible TaskTemplate, Skill or capability provider, compare a useful candidate, and publish within authority. Use evolution_replay objective llm-outcome with evaluation.goal for task quality or performance, or tool-call-reduction for overhead. The LLM can supply a measurement plan that is frozen before real comparison. Reuse available tools and artifacts, clean starting inputs and comparable model budgets. Report seen cases as regression evidence and test transfer on fresh tasks when available. Weigh domain results together with model tokens, cache traffic, tool work and reported cost; mark unavailable readings unknown.

Reuse enough evidence to decide. A useful negative result or reasoned no_change can complete supervision. Use evolution_decide with REJECT or KEEP_FOR_FURTHER_RESEARCH and a reason to conclude an open proposal when comparison is unnecessary or unavailable. PROMOTE follows completed comparison and gate. Inspect later exact template or Skill bindings and outcomes to establish consumption and benefit. Finish each executable candidate through evolution_decide and evolution_apply as appropriate, then return your outcome; the platform driver opens the next round. Budget and recorded decisions bound your work.`;

//#endregion
//#region src/prompts/worker.prompts.ts
/** Stable worker policy; each Task supplies its own result and acceptance. */
const WORKER_POLICY_TEXT = `You are a Singularity task worker. Own the complete result and acceptance of this execution. Your Task's bound Skills are loaded as frozen instructions before work begins; apply useful methods and record their outcomes. Read task_read, task_status and context_read for the contract and state. Use task_library and task_template_list to find this graph's matching methods and next TaskTemplates; capability_list names the available execution means.

Investigate useful unknowns and choose local work or task_decompose. Give direct children clear ownership, inputs, checks and capabilities; let them choose descendants. Run independent work concurrently with real dependsOn edges, read batch outcomes and integrate accepted artifacts. Bind a fitting template or author the current task's contract. Choose a few checks that observe your result, using existing tools or a small task-specific check when useful. Commands run from this Run's workspace with its explicit inputs. Preserve authoritative checks, protected inputs, resource limits and failure evidence.

Use task_verify for a useful self-check under the verifier deadline; submission performs acceptance. Reuse unchanged evidence. Decide facts and engineering choices from evidence, use task_ask_parent for decisions outside your authority, and answer children promptly with task_answer.

If you identify a useful goal to explore or decompose, record it as a temporary TaskTemplate in the graph library. Record reusable paths, methods, conditions and experience as Skills, linking relevant Task/Run and evidence. The supervisor reviews them during iteration and chooses retention or revision alongside task results and model cost. Finish with task_submit_result, referencing artifacts and evidence once; the external verifier judges this task's criteria.`;
/** The first request a task worker receives when the spawn carries no request. */
const WORKER_KICKOFF_TEXT = "Begin your delegated task. Read task_read and the graph library as needed, investigate useful unknowns, implement or delegate results, and submit their evidence with task_submit_result.";

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
	/** Recover a persisted root; `agentOptions` overrides the deployment default selection for its resumed turns. */
	async ensureRoot(sessionId, scope, agentOptions) {
		if (this.closing) throw new Error("agent-runtime: closing");
		const pending = this.resuming.get(sessionId);
		if (pending !== void 0) {
			if (pending.scope.graphStoreId !== scope.graphStoreId || pending.scope.layoutStoreId !== scope.layoutStoreId) throw new Error("agent-runtime: concurrent root scope mismatch");
			return pending.handle;
		}
		const handle = this.inGraph(scope, () => this.resumeRoot(sessionId, scope, agentOptions)).finally(() => this.resuming.delete(sessionId));
		this.resuming.set(sessionId, {
			scope,
			handle
		});
		return handle;
	}
	async resumeRoot(sessionId, scope, agentOptions) {
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
				agentOptions: agentOptions === void 0 ? this.ctx.agentDefaultModel.currentSelection() : {
					...this.ctx.agentDefaultModel.currentSelection(),
					...agentOptions
				},
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
		await this.deliverPrompt(agent, prompt, false);
	}
	/** Deliver a goal submitted through the host's graph creation API as user input. */
	async promptUser(agent, prompt, context) {
		await this.deliverPrompt(agent, prompt, true, context);
	}
	async deliverPrompt(agent, prompt, user, context) {
		if (this.closing) throw new Error("agent-runtime: closing");
		this.live(agent);
		const scope = this.scope(agent.id);
		if (this.stopping.has(scope.graphStoreId)) throw new Error("agent-runtime: graph stopping");
		if ((await this.ctx.graph.snapshotIn(scope.graphStoreId)).agents.every((item) => item.id !== agent.id)) throw new Error(`agent-runtime: agent "${agent.id}" is not in graph`);
		this.live(agent);
		if (context !== void 0) agent.inject(createUserMessage({
			content: [...context],
			source: runtimePrompt("prompt")
		}));
		agent.followup(createUserMessage({
			content: [...prompt],
			source: user ? { kind: "user" } : runtimePrompt("prompt")
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
	"read",
	"glob",
	"grep",
	"write",
	"edit",
	"bash",
	"job_list",
	"job_output",
	"job_kill",
	"task_library",
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
	agentCtx.tools.guard((execution) => allowed.has(execution.name) ? void 0 : "singularity: use the root execution tools and task_decompose for delegated task work");
}
async function graphCatalogFor(ctx, agent, root) {
	const libraries = ctx.get("taskRuntime");
	const ownerSessionId = root ? agent.id : agent.session.header?.parentSession ?? agent.id;
	const library = libraries === void 0 ? void 0 : root ? await libraries.libraryForRoot(agent.id) : await libraries.libraryForSession?.(ownerSessionId);
	return {
		skillRoots: [library?.skillRoot ?? fileURLToPath(new URL("../skills/", import.meta.url))],
		...libraries?.libraryRead === void 0 || library === void 0 ? {} : { readLibrary: () => libraries.libraryRead(agent.id) }
	};
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
		await installGraphSkillCatalog(agentCtx, await graphCatalogFor(ctx, agent, true));
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
		if (role.grant !== void 0) await applyWorkerGrant(agentCtx, agent, role.grant, role.coordinationRole === "supervisor" ? await graphCatalogFor(ctx, agent, false) : void 0);
		else if (role.coordinationRole === "supervisor") await installGraphSkillCatalog(agentCtx, await graphCatalogFor(ctx, agent, false));
		sealRawSessionReads(agentCtx);
		sealNativeDelegation(agentCtx);
	};
}
var src_default = AgentRuntime;

//#endregion
export { AgentRuntime, RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS, WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT, WorkerResumeRefusal, answerMessageText, applyWorkerGrant, src_default as default, findSkillFileIn, parseSkillFile, questionMessageText, skillRootsFor, toolCallRefIn };