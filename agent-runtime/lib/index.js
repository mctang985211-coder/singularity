import { Context, Service } from "@deepseek-ai/cordis";
import { MessageId, createUserMessage, freezeMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { DEFAULT_ROOT } from "@dangosys/dsh-singularity-layout";
import { RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SessionAlreadyOwnedError } from "@deepseek-ai/dsh-session-persistence";

//#region src/skill-file.ts
/** How far up from a worker's cwd project skill roots are looked for. */
const PROJECT_LOOKUP_DEPTH = 8;
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
/**
* Split `SKILL.md` text into its frontmatter fields and body. The frontmatter
* grammar accepted here is the flat `key: value` one every skill in this
* deployment uses; a nested structure fails loudly rather than being guessed at.
*/
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
async function skillRoots(cwd) {
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
	roots.push(join(homedir(), ".agents", "skills"));
	return roots;
}
/**
* Locate the `SKILL.md` a granted skill name refers to under an explicit root
* list, in the order given. The one search loop every discovery path shares:
* {@link findSkillFile} runs it over a worker's own roots, and the task
* runtime's provider pre-check runs it over the same roots with the replay
* overlay's extra roots in front, so admission asks the question the spawn
* will answer instead of restating the search.
* @param roots - skill roots, searched in order.
* @param name - the skill name a capability declares.
* @returns the absolute path, or undefined when no root holds that skill.
*/
async function findSkillFileIn(roots, name) {
	for (const root of roots) {
		const file = await skillFileIn(root, name);
		if (file !== void 0) return file;
	}
}
/**
* Locate the `SKILL.md` a granted skill name refers to.
* @param name - the skill name a capability declares.
* @param cwd - the worker's working directory; project roots are searched upward from it.
* @returns the absolute path, or undefined when no root holds that skill.
*/
async function findSkillFile(name, cwd) {
	return findSkillFileIn(await skillRoots(cwd), name);
}
/**
* Every root {@link findSkillFile} searches, for an error message that tells the
* operator where a granted skill should have been.
*/
async function skillRootsFor(cwd) {
	return skillRoots(cwd);
}
/**
* Every `<root>/<name>/SKILL.md` under one extra skill root (the replay
* overlay), in directory order. Only the directory-bundle form is scanned —
* the sandbox materializes skills that way — and a root that cannot be read
* throws, so a broken overlay path fails the spawn loudly with the cause
* named instead of silently degrading to production skills.
*/
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
/**
* Read one granted skill's `SKILL.md` into a runtime registration. A file whose
* frontmatter names a different skill than the grant asked for is rejected: the
* registry would otherwise publish a body under the wrong name.
* @param file - absolute path from {@link findSkillFile}.
* @param name - the granted skill name, which the file must declare.
* @returns the registration to hand to `ctx.skills.register`.
*/
async function readSkillFile(file, name) {
	const parsed = parseSkillFile(await readFile(file, "utf8"), file);
	if (parsed.name !== name) throw new Error(`skill file ${file} declares name "${parsed.name}" but the capability grants "${name}"`);
	return {
		name: parsed.name,
		description: parsed.description,
		...parsed.whenToUse === void 0 ? {} : { whenToUse: parsed.whenToUse },
		invocation: parsed.invocation,
		source: "runtime",
		path: parsed.path,
		resourceBase: {
			kind: "directory",
			path: dirname(parsed.path)
		},
		content: parsed.content
	};
}

//#endregion
//#region src/grants.ts
function message(error) {
	return error instanceof Error ? error.message : String(error);
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
/**
* Compute the allow-list one worker's grant resolves to against the surface its
* composition offers.
* @param agentCtx - the unpublished worker's scoped context (the only context `restrict()` accepts).
* @param agent - the worker the scoped context belongs to.
* @param grant - the resolved capability grant.
* @throws when a capability-declared tool is not visible to this worker.
*/
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
/** One granted skill, pinned into the worker's own skill layer. */
function pinnedSkill(skill) {
	return {
		name: skill.name,
		description: skill.description,
		...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
		...skill.invocation === void 0 ? {} : { invocation: skill.invocation },
		source: "runtime",
		...skill.path === void 0 ? {} : { path: skill.path },
		...skill.resourceBase === void 0 ? {} : { resourceBase: skill.resourceBase },
		...skill.metadata === void 0 ? {} : { metadata: skill.metadata },
		content: skill.content
	};
}
/**
* Register every skill one grant's extra roots carry into the worker's own
* layer (the replay overlay). Registered BEFORE the granted-skill resolution,
* so a same-name granted skill keeps the overlay body — the registry is
* first-wins within a layer, and skipping the name in {@link grantSkills} is
* what keeps that rule silent instead of warn-logged. Returns the overlaid
* names. A root that cannot be read throws: a broken overlay path must fail
* the spawn loudly, never degrade to the production skill unnoticed.
*/
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
			throw new Error(`agent-runtime: skill overlay root "${root}" is not readable: ${message(error)}`);
		}
		for (const { name, file } of files) {
			if (overlaid.has(name)) continue;
			skills.register(await readSkillFile(file, name));
			overlaid.add(name);
		}
	}
	return overlaid;
}
/**
* Grant one worker's capability skills.
*
* Each granted name is resolved through the deployment's own discovery first —
* the discovered definition already carries the parsed body, invocation policy,
* and resource base — and falls back to reading the `SKILL.md` directly when the
* worker's composition mounts no discovery. Either way the definition is
* registered into the WORKER's layer, which is what makes the grant hold and
* what shadows a same-name skill for that worker alone. Names an overlay root
* already registered are skipped: the overlay body wins.
*/
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
			skills.register(pinnedSkill(discovered));
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
/**
* Mount every MCP server one grant declares, one mcp-client instance per spec
* on the worker's own scope. Awaiting `ctx.plugin` settles when the instance's
* initial connect + tool sync finishes; with `failOnStartupError: true` a
* server that cannot start rejects the mount — and with it the spawn — naming
* the server, so a dead MCP path can never degrade into a quietly tool-less
* worker. Disposal rides the worker's own fiber: the instance (and its child
* process) dies with the agent.
*/
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
		throw new Error(`agent-runtime: MCP server "${spec.serverName}" (command: ${spec.command}) failed to start for agent "${agent.id}": ${message(error)}`);
	}
}
/**
* Apply one worker's capability grant to its unpublished scoped world.
* @param agentCtx - the worker's scoped context, minted by the agent factory.
* @param agent - the worker, identified for error messages.
* @param grant - the resolved grant from the task runtime.
* @throws when a capability-declared tool is not visible to the worker, a
*   declared skill resolves nowhere, an MCP server fails to start, or the
*   tools registry rejects the filter.
*/
async function applyWorkerGrant(agentCtx, agent, grant) {
	const { allow } = resolveGrant(agentCtx, agent, grant);
	try {
		agentCtx.tools.restrict({ allow });
	} catch (error) {
		const capabilities = grant.capabilities.map((capability) => capability.capability);
		throw new Error(`agent-runtime: could not restrict agent "${agent.id}" to [${allow.join(", ")}] for capabilit${capabilities.length === 1 ? "y" : "ies"} [${capabilities.join(", ")}]: ${message(error)}`);
	}
	await grantSkills(agentCtx, agent, grant, await applySkillRoots(agentCtx, grant));
	await mountMcpServers(agentCtx, agent, grant);
}

//#endregion
//#region src/messages.ts
/** One refused source read or delivery, with the stable name of what went wrong. */
var MessageDeliveryRefusal = class extends Error {
	code;
	constructor(code, message$1, options) {
		super(message$1, options);
		this.name = "MessageDeliveryRefusal";
		this.code = code;
	}
};
/** The message body a question carries into its parent's Session: the stable question identity, then what was asked. */
function questionMessageText(questionId, question) {
	return `[task-question ${questionId}] ${question}`;
}
/**
* The message body an answer carries into the asking Session: both identities,
* so the receiving model can tell which answer resolves which question without
* a second lookup, then what the parent answered.
*/
function answerMessageText(answerId, questionId, answer) {
	return `[task-answer ${answerId} for ${questionId}] ${answer}`;
}
/**
* Build the identified, frozen relay message one intent delivers. Pure and
* exported so a caller can inspect the exact representation it is about to
* write; nothing here reaches the Task store or the Session.
*/
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
/**
* Whether a Session's own event suffix already holds one message identity, in
* history or still pending in the inbox. `events` must be the Session's own
* suffix (its fork-inherited prefix belongs to the Session it descends from and
* is not a delivery to this one).
*
* This is the *retry* rule: an identity a claim already removed and history
* never took is not accepted, because the model never saw it and the recovery
* path must deliver it again (§F.1: "claim 在 pre-step 前可能已移除").
*/
function messageAccepted(events, messageId) {
	return events.some((event) => event.type === "user/message" && event.data.id === messageId) || pendingInboxMessages(events).some((message$1) => message$1.id === messageId);
}
/**
* Whether the log durably records that this identity entered the Session's
* inbox — the *receipt* rule, which is wider than {@link messageAccepted} by one
* case: a claim (or a cancel's clear) removes a pending entry through a splice
* that carries no identity, so between "claimed" and "in history" the identity
* is in neither list while the insertion event stays in the log. That window is
* not a delivery failure — the message was durably recorded and the target's own
* driver was the one consuming it — and treating it as one would invite a
* duplicate re-delivery of a message the Session already took.
*/
function messageRecorded(events, messageId) {
	return events.some((event) => event.type === "agent/inbox/spliced" && event.data.inserted.some((message$1) => message$1.id === messageId));
}
/**
* Read back the body of a cited `tool/call`: the evidence behind a question or an
* answer, straight from the Session that sent it.
*
* A live Session is flushed first — the cited event must be durable before the
* Task store commits an intent that cites it, because recovery reads the body
* from the log and a body that only ever existed in a write buffer is not a
* source. Refusals are named: an absent Session, an absent seq, an unreadable
* Session, a Session with no durability barrier, and an event that is not the
* `tool/call` it is cited as are five different things, and a caller that
* cannot tell them apart would record the wrong fact.
*/
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
/**
* The citation of one `tool/call` inside a Session's *own* event suffix, found
* by the call id the tool layer holds (A4 §F.1).
*
* Why the caller needs this at all: the body of a question or an answer is the
* sender's own tool call, and the durable citation into it is a `(session, seq)`
* pair, while what a tool call has in hand is its registration id
* ({@link ToolCallRef} is what {@link readToolCallBody} takes). This is that
* translation, as a pure read of a Session log the caller already has, so the
* lookup rule — own suffix only, the *last* event for an id — lives beside the
* citation type instead of in each caller.
*
* The suffix rule is the delivery fold's ({@link ownSuffix}): a fork-inherited
* prefix belongs to the Session this one descends from, and a call made there is
* not a call this Session made. The last event wins because a log is append-only
* and an id — were it ever re-dispatched — would be answered by its latest
* durable record.
*/
function toolCallRefIn(log, callId) {
	const own = log.events.slice(log.inheritedEventCount);
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
/**
* Put one already-decided message into the target Session's inbox, at most once.
*
* Order: reconcile, then relay, then flush, then confirm. Reconcile-first is
* what makes a retry harmless — a message already pending or already in history
* is reported `already-present` without touching the inbox. The relay is
* `agent.steer`, not `followup`: an answer must reach the target's next model
* request, including one that is mid-turn (a followup would queue it behind the
* current turn), and an idle target still opens a turn, which is what a question
* addressed to a settled parent needs to be answered at all.
*
* The confirmation after the flush is deliberately wider than the retry fold
* ({@link messageRecorded}): a target whose turn is already consuming the
* message claims it out of the inbox before history takes it, and that window
* must not be reported as a failed delivery. What `delivered` claims is exactly
* what the log shows — the Session durably recorded this identity — never that
* the model read it.
*
* A target with no live agent is `unavailable` before anything else happens: no
* offline write, no resume, no substitute parent — the intent survives in the
* Task store, and the recovery path is what brings the target back and calls
* this again.
*/
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
	const own = await ownSuffix(deps, targetSessionId);
	if (!messageAccepted(own, intent.messageId) && !messageRecorded(own, intent.messageId)) throw new MessageDeliveryRefusal("delivery-unconfirmed", `agent-runtime: message "${intent.messageId}" was relayed to session "${String(targetSessionId)}" but is not in its log after the flush`);
	return {
		messageId: intent.messageId,
		status: "delivered"
	};
}
/**
* Reconcile a set of committed intents against the Sessions that hold them,
* delivering exactly the ones that are missing (§F.1: "恢复只补缺失投递").
*
* This is the entry point A4's recovery path calls with the records the Task
* store holds: it owns no ledger of its own (the delivered fact *is* the
* target's fold, and a second record could disagree with it), it never rewrites
* an intent, and it reports each record separately so one unreachable parent
* cannot hide the others. Intents are delivered in the order given, so the
* target's inbox keeps the order the caller recorded.
*/
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
			reason: messageOf$1(error)
		});
	}
	return reports;
}
/**
* The durability barrier, as the two callers state it: `session/flush` reaching
* no listener means nothing stores this Session, so neither a cited body nor a
* delivery can be witnessed. A refusal here is not a delivery failure — the
* caller keeps the intent and can retry.
*/
async function witnessBarrier(deps, session, sessionId, code = "source-not-durable") {
	let durable;
	try {
		durable = await deps.sessions.flush(session);
	} catch (error) {
		throw new MessageDeliveryRefusal(code, `agent-runtime: session "${String(sessionId)}" could not be flushed: ${messageOf$1(error)}`, { cause: error });
	}
	if (!durable) throw new MessageDeliveryRefusal(code, `agent-runtime: session "${String(sessionId)}" has no durability barrier (no session/flush participant)`);
}
/** Whether the target Session's own suffix already holds the identity. */
async function acceptedAlready(deps, sessionId, messageId) {
	return messageAccepted(await ownSuffix(deps, sessionId), messageId);
}
/**
* Read one Session's own event suffix (without the fork-inherited prefix). A
* failed read is a refusal, never an assumed "nothing there": a delivery decided
* from an unreadable log could duplicate a message the Session already holds.
*/
async function ownSuffix(deps, sessionId) {
	let snapshot;
	try {
		snapshot = await deps.sessionQuery.readSession(sessionId);
	} catch (error) {
		throw new MessageDeliveryRefusal("target-unreadable", `agent-runtime: target session "${String(sessionId)}" could not be read, so whether a message was accepted cannot be decided: ${messageOf$1(error)}`, { cause: error });
	}
	return snapshot.events.slice(snapshot.inheritedEventCount);
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
/** Whether one thrown error is DSH's duplicate-pending-inbox refusal for this id. */
function isAlreadyPending(error, messageId) {
	return error instanceof Error && error.message === `message "${messageId}" is already pending`;
}
/** Name one refused source read from the error the session read path raised. */
function sourceReadRefusal(sessionId, seq, error) {
	const code = error?.code;
	if (code === "SESSION_QUERY_EVENT_NOT_FOUND") return new MessageDeliveryRefusal("source-event-missing", `agent-runtime: session "${sessionId}" has no event at seq ${seq}`, { cause: error });
	if (code === "SESSION_QUERY_SESSION_NOT_FOUND") return new MessageDeliveryRefusal("source-session-missing", `agent-runtime: session "${sessionId}" does not exist`, { cause: error });
	return new MessageDeliveryRefusal("source-unreadable", `agent-runtime: session "${sessionId}" could not be read: ${messageOf$1(error)}`, { cause: error });
}
/** One line of an unknown failure, for refusals that carry a cause. */
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
//#region src/prompts/root.prompts.ts
/** The evolution guidance is present only when the deployment mounts its tools. */
const EVOLUTION_PROTOCOL = `Use evolution_propose and evolution_candidate to prepare a diagnosed skill or capability improvement, then evolution_prepare, evolution_replay and evolution_gate to collect the experiment evidence before evolution_decide. Candidates replace a same-name skill's complete SKILL.md or one whole capability row with an optional new execution skill; an existing execution contract is derived at prepare. Keep the existing role, verifier and capabilities of a skill, and use only authorized tools without changing permissions or presets. A new execution provider needs the capability row that grants it. The replay compares new baseline and candidate runs on frozen inputs, judges, model and budget; cite its report at the gate. Decisions require human approval; promotion writes production only through evolution_apply with a second approval. evolution_rollback also requires approval. Read the ledger with evolution_list. Follow each tool's schema and result for candidate restrictions and the next operation.`;
/** Stable root coordination policy; domain guidance is loaded through the skill tool. */
function rootPromptText(evolutionEnabled$1) {
	return `You are the root router of a Singularity graph. You coordinate the user's complete objective through task workers and accept their combined evidence. Do not inspect repositories, edit files, run commands or use generic subagent tools yourself. Read graph records through task_read, task_status and context_read, and load relevant domain guidance with skill.

Environment setup uses graph_spawn with a complete task for each planned repository; call graph_mark_ready after setup workers succeed. This setup path is separate from the user's task tree. Once the root contract is active, delegate objective work, including any engineering investigation, through task_decompose.

Keep the full user objective in the root contract. Do not narrow it to an easier slice because of its size, the available tools or an initial plan. Normalize clear requests yourself, state your assumptions and call task_intake with the objective, constraints, required capabilities and artifact acceptance criteria. At least one mandatory criterion must judge the root's delivered result beyond the conjunction of its children. An assumption is not an answer: it must never settle a condition you could not confirm. When missing information changes the objective, scope or acceptance, put the question to the user before accepting the contract; the environment cannot answer for the user. Include only requirements supported by the user's words and answers. Give deterministic criteria exact commands, and do not make a mandatory criterion depend on a review that may never happen. Before intake activates the contract there is no root task; task_read reports not activated. Nothing you can call approves a contract. Follow task_intake or task_decompose results for a pending proposal, read it with task_proposal_read and revise a refused proposal against its recorded reason. Do not resubmit identical content while review is pending.

Delegate the independent results at your own level, with self-contained objectives and acceptance criteria for every child. Give a subsystem containing several independently checkable results or distinct responsibilities to a child that can coordinate and decompose it; describe its result boundaries and mark it decomposable. That child decides its descendants from its contract and evidence. Owning the complete engineering objective does not mean dispatching every engineering step from the root. Use dependsOn only where a child needs a sibling's verified result. Reuse an authoritative checker where it covers the result, keep only criteria for distinct requirements, and use known artifact paths. Do not prescribe tree depth, fixed stages or descendants just to make a larger graph.

Decomposition returns at admission and does not wait for the children. One unfinished batch at a time: while waiting_children, read, query, diagnose and answer children; do not implement shared work, decompose again or submit. Answer pending questions promptly with task_answer, giving the decision and its evidence: resolves:true releases that child's block, resolves:false leaves it open. The batch end reports each child's terminal state and evidence and returns your coordination turn. Read the results, assess how they combine against your own contract, then delegate any remaining result or submit with task_submit_result. Nothing is submitted on your behalf. Only the verifier marks a task verified; task_verify is a self-check and does not change status. task_cancel cancels your own run together with its in-flight child batch; use it only when abandoning that run, never to obtain another coordination turn after a child failure.

Use task_review_pack for settled-task evidence and task_diagnose to record an explanation; diagnoses never execute repairs themselves. Read existing review attempts before calling task_review_agent for a source whose evidence needs independent judgment. A stopped tree is still reviewable on the reviewer's own allowance. Continuing exhausted work needs a human budget decision: call task_budget_extend for a higher whole-total ceiling. It re-opens no task, starts nothing by itself, and the runs already counted go on counting.${evolutionEnabled$1 ? ` ${EVOLUTION_PROTOCOL}` : ""} Escalate a capability gap, exhausted budget or UNKNOWN(verifier) verdict to a human with escalate, naming what is missing, what you tried and what you suggest.`;
}

//#endregion
//#region src/prompts/worker.prompts.ts
/**
* The worker role's stable policy (A2): the rules every task worker runs under,
* whatever its task, its handoff, or this deployment's decomposition switch.
*
* What belongs here and nowhere else: unconditional behaviour. The contract,
* the root briefing and the handoff are the context package's assembly
* projection (`singularity:worker-contract`, order 80 — this section sits just
* ahead of it), and the rules that depend on the task or the deployment (the
* decomposable hint, the runtime-split rule, the review wait) are the same
* projection's conditional part — one rule lives in exactly one of the two.
*
* Migrated from the old spawn prompt (`task-runtime`'s retired
* `renderWorkerPrompt`), minus the session-tool guidance: history is read with
* `context_read` now, and the raw cross-session readers that prompt pointed at
* are sealed (`./raw-session-guard.ts`). As a system-prompt section this text is
* what the loop reprojects into surface node 0, so the rules survive the folds
* the old spawn prompt did not.
*/
/**
* The worker policy, registered as the `singularity:worker` section (order 75)
* of every spawn that declares `taskWorker`. Unconditional on purpose: anything
* that could change with the task or the deployment is not written here.
*/
const WORKER_POLICY_TEXT = [
	"You are a Singularity task worker. The task you were delegated, its acceptance criteria and the current state of the project ride in your system context; the task store is the authority for all of it.",
	"",
	"## Rules",
	"",
	"- Own your delegated result, including how any child results combine to satisfy your contract. Before implementation, assess whether it contains multiple independently checkable results or distinct responsibilities another node can own. When decomposition is available, delegate those results first and coordinate their acceptance; complete a genuinely local result directly. Your parent does not have to plan your descendants.",
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
/**
* The first user message a task worker receives when its spawn carried no
* prompt of its own. The kickoff points at the context, it does not replace it:
* the contract and state are the store's, and this only says where to look.
*/
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
/**
* Deny the four readers on one agent's own scope, for the agent's whole life.
* Registered through the agent's scoped context, so it travels with the agent
* and touches no sibling; a scope chain re-evaluation cannot lift it, because
* a guard has no allow answer.
*/
function sealRawSessionReads(agentCtx) {
	agentCtx.tools.guard((execution) => RAW_SESSION_READ_TOOLS.includes(execution.name) ? RAW_SESSION_READ_DENIAL : void 0);
}

//#endregion
//#region src/worker-resume.ts
/**
* The permission posture a worker runs under when nobody decided one for it —
* the spawn's own default (`index.ts`, the shared worker setup), named here
* because the resume must state the same posture it is checking against.
*/
const WORKER_DEFAULT_PERMISSION_PRESET = "danger-full-access";
/** One refused resume, with the stable name of what could not be established. */
var WorkerResumeRefusal = class extends Error {
	code;
	constructor(code, message$1, options) {
		super(message$1, options);
		this.name = "WorkerResumeRefusal";
		this.code = code;
	}
};
/** The one marker `TaskRun.capabilitySnapshot` uses for a granted MCP server's plane (`task-runtime/src/capability.ts`). */
const MCP_PLANE_MARKER = "mcp:";
/**
* Bring one spawned worker's persisted Session back live, or refuse by name.
*
* Order: ownership, then the Session's own durable record, then the declared
* Run facts against it, then the graph's membership and delegation facts, then
* the resume. Every check before `deps.agents.resume` is a read: a refusal
* leaves the store, the Session log, the graph and the handle map exactly as
* they were, and no Session is ever created to stand in for the one that could
* not be taken over.
* @param deps - the live registry, the session read path, the graph store and the composition.
* @param request - the identity, its graph scope, the Run facts and the authorization claimed.
* @returns the live handle of the same Session, idle and reachable, owning no new identity.
* @throws WorkerResumeRefusal with the stable code of what could not be established.
* @throws Error (unnamed) when the graph store cannot take the node's status
*   repair: nothing was resumed, and that write is not a source decision a
*   refusal code could name.
*/
async function resumeWorkerAgent(deps, request) {
	const sessionId = SessionId(request.sessionId);
	if (deps.agents.get(sessionId) !== void 0) throw new WorkerResumeRefusal("ownership-conflict", `agent-runtime: session "${String(sessionId)}" is already live; a resume must wait until its owner settles`);
	const persisted = await readPersistedSession(deps, sessionId);
	const header = persisted.session;
	const agentPreset = assertRunBinding(request, header, persisted.events.slice(persisted.inheritedEventCount));
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
/**
* Refuse a declared Run, grant or permission the Session's own durable record
* contradicts (A4 §F.1: "声明的 Run/绑定与 Session 持久事实不一致").
*
* What is checkable and why each one matters:
* - the Run's `sessionId` — the store's binding is to one Session, and a resume
*   under a Run that names another one would put a run's work on the wrong log;
* - the Run's `agentPreset` against the header's — the header is what the
*   resumed composition is built from, so a store that recorded a different
*   preset means the two records disagree about what this Session is;
* - the declared grant against the Run's recorded capability snapshot — the
*   tool face is authorization, and the snapshot is the store's record of what
*   the Run was admitted with;
* - a `permission/preset` the log recorded against the declared permission —
*   the log is the permission the Session actually ran under, and re-applying a
*   different one would silently widen or narrow a session mid-task.
* @returns the agent preset the Session's own header names — verified present,
*   and the one the resumed composition is built from.
*/
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
/**
* Refuse a Session the graph does not publish, or one whose delegation facts a
* worker resume needs and cannot find (A4 §F.1: a resume must not invent the
* member or its edge). Membership alone is not enough: the worker's lineage is
* the parent the spawn published, and the Session's own header must agree with
* the graph's edge — the two durable records are checked against each other.
*/
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
/** The granted plane one grant declares: every capability's tools and skills, plus each MCP server's plane marker. */
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
/** One line of an unknown failure, for refusals that carry a cause. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

//#endregion
//#region src/index.ts
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
/** The tools every root may call whatever the deployment's evolution switch says. */
const ROOT_CORE_TOOLS = [
	"graph_spawn",
	"graph_mark_ready",
	"hitl_ask",
	"hitl_approve",
	"task_read",
	"capability_list",
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
/**
* Whether this composition registered the nine `evolution_*` tools. Soft read:
* a context that mounts no singularity agent plugin provides no such service,
* and that absence is the closed state — never "assume the chain is there". The
* answer decides both the root's allow-list and its prompt, because a prompt
* that names a tool the surface does not carry asks for a call that cannot
* happen (prompt contracts §1/§7).
*/
function evolutionEnabled(ctx) {
	return ctx.get("singularityEvolution")?.enabled ?? false;
}
/**
* The root's tool allow-list for one composition, single point: `createRoot` and
* `resumeRoot` both restrict with this, so a root cannot be assembled on one
* fact and prompted on another. Off, the nine names are absent — `restrict` is a
* mask over what exists, and with the chain off nothing registered them. On, the
* list is exactly the deployment's previous one, name for name.
*/
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
/**
* `hitl_approve` asks through `ctx.approval`, whose 'never' policy (bundled into
* danger-full-access) auto-rejects before any answerer sees the request. Root
* agents expose no policy-gated tools, so pinning their session to 'ask'
* re-enables only the explicit human decision.
*/
function pinRootApprovalPolicy(session) {
	setApprovalPolicy(session, "ask");
}
/** One message source of this runtime's own, as {@link RuntimePromptSource} declares it. */
function runtimePrompt(channel) {
	return {
		kind: "runtime-prompt",
		channel
	};
}
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
		ctx.provide("sessionVisibility", { isVisible: (sessionId) => !this.owned.has(sessionId) || this.roots.has(sessionId) });
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
				setup: async (agentCtx, agent) => {
					await this.ctx.agentPresets.mount(agentCtx, agentPreset);
					this.ctx.permissionPresets.set(agent.session, "danger-full-access");
					pinRootApprovalPolicy(agent.session);
					const evolution = evolutionEnabled(this.ctx);
					agentCtx.systemPrompt.section({
						name: "singularity:root",
						order: 70,
						text: rootPromptText(evolution)
					});
					agentCtx.tools.restrict({ allow: rootToolsFor(evolution) });
					sealRawSessionReads(agentCtx);
					sealRootTools(agentCtx, evolution);
				}
			});
			this.handles.set(sessionId, handle);
			return handle;
		} catch (error) {
			this.owned.delete(sessionId);
			this.roots.delete(sessionId);
			this.scopes.delete(sessionId);
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
					setup: async (agentCtx, agent) => {
						await this.ctx.agentPresets.mount(agentCtx, agentPreset);
						this.ctx.permissionPresets.set(agent.session, "danger-full-access");
						pinRootApprovalPolicy(agent.session);
						const evolution = evolutionEnabled(this.ctx);
						agentCtx.systemPrompt.section({
							name: "singularity:root",
							order: 70,
							text: rootPromptText(evolution)
						});
						agentCtx.tools.restrict({ allow: rootToolsFor(evolution) });
						sealRawSessionReads(agentCtx);
						sealRootTools(agentCtx, evolution);
					}
				});
			} catch (error) {
				this.owned.delete(request.sessionId);
				this.scopes.delete(request.sessionId);
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
				this.owned.delete(request.sessionId);
				this.owned.delete(handle.agent.id);
				this.roots.delete(handle.agent.id);
				this.scopes.delete(request.sessionId);
				this.scopes.delete(handle.agent.id);
				await handle.dispose();
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
					setup: this.workerSetup({
						agentPreset,
						permissionPreset: request.permissionPreset ?? WORKER_DEFAULT_PERMISSION_PRESET,
						taskWorker: request.taskWorker === true,
						...request.grant === void 0 ? {} : { grant: request.grant }
					})
				});
			} catch (error) {
				this.owned.delete(request.sessionId);
				this.scopes.delete(request.sessionId);
				throw error;
			}
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
				this.handles.delete(handle.agent.id);
				this.owned.delete(request.sessionId);
				this.owned.delete(handle.agent.id);
				this.scopes.delete(request.sessionId);
				this.scopes.delete(handle.agent.id);
				await handle.dispose();
				if (published) await this.ctx.graph.setStatusIn(scope.graphStoreId, handle.agent.id, "failed");
				throw error;
			}
		});
	}
	/**
	* Bring one spawned worker's persisted Session back live (A4 §F.1), through
	* the recovery entry `./worker-resume.ts` documents: the same Session, the
	* same composition (the shared `workerSetup` below, which `spawn` also hands
	* the agent factory), the same grant, seal and permission — and **idle**.
	* Nothing is sent to the model here; the caller wakes the Session when it has
	* something to deliver (§F.1: "恢复后由调用方决定何时 steer").
	*
	* The handle lands in the same `handles` map a spawn's product does, so
	* `stopAgents`/`stopGraph` and the session-visibility rule treat a resumed
	* worker exactly as they treat a spawned one. There is no second roster, no
	* second mailbox and no second handle table: this entry owns nothing the
	* spawn path does not already own.
	* @param request - the Session, its graph scope, the Run facts the caller read
	*   from its store, and the authorization the Run was admitted with.
	* @returns the live handle of the same Session, idle.
	* @throws WorkerResumeRefusal with the stable code of what could not be established.
	*/
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
				this.owned.delete(sessionId);
				this.scopes.delete(sessionId);
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
			this.handles.delete(id);
			this.owned.delete(id);
			this.roots.delete(id);
			this.scopes.delete(id);
			await handle.dispose();
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
	/**
	* Read back the body of a `tool/call` one question or answer cites (A4 §F.1),
	* flushing the sending Session first so the citation names a durable event.
	* Thin adapter over {@link readToolCallBody}: this class owns the handle and the
	* context, the delivery rules own themselves (`./messages.ts`).
	* @param ref - the sending Session and the seq of its `tool/call`.
	* @returns the tool name and the raw arguments text the model produced.
	* @throws MessageDeliveryRefusal with the named reason the citation is unusable.
	*/
	async readToolCallBody(ref) {
		if (this.closing) throw new Error("agent-runtime: closing");
		return await readToolCallBody(this.deliveryDeps(), ref);
	}
	/**
	* Deliver one already-committed message identity into its target Session's
	* inbox, at most once, and report what that Session's log can witness. Called
	* by the question protocol after the Task store committed the intent (A4's
	* third sub-goal); re-calling it after a crash delivers only what is missing.
	* @param intent - the recorded identity, the two Sessions, and the body.
	* @returns the settled status: `delivered`, `already-present`, or `unavailable`.
	* @throws MessageDeliveryRefusal when the attempt cannot be decided or confirmed.
	*/
	async ensureAgentMessageDelivered(intent) {
		if (this.closing) throw new Error("agent-runtime: closing");
		return await ensureAgentMessageDelivered(this.deliveryDeps(), intent);
	}
	/**
	* Reconcile a set of committed intents against their target Sessions, one at a
	* time, and report each record's outcome — the recovery path's entry point
	* (§F.1). No ledger of its own: the delivered fact is each target's own fold.
	* @param intents - the records the Task store holds, in delivery order.
	* @returns one report per record; a refused record names why.
	*/
	async reconcileAgentMessageDeliveries(intents) {
		if (this.closing) throw new Error("agent-runtime: closing");
		return await reconcileAgentMessageDeliveries(this.deliveryDeps(), intents);
	}
	/**
	* The services one delivery reaches, resolved to the three capabilities
	* `./messages.ts` declares and no more: this class's own fields stay private,
	* and a service the module never calls is never handed to it.
	*/
	deliveryDeps() {
		return {
			agents: this.ctx.agents,
			sessions: this.ctx.sessions,
			sessionQuery: this.ctx.sessionQuery
		};
	}
	/**
	* The one composition a worker's scoped world is built from. `spawn` and
	* {@link resumeWorkerAgent} both hand this to the agent factory, so a resumed
	* worker is composed exactly as its spawn composed it (A4 §F.1: same preset,
	* same permission posture, same policy prompt, same grant, same seal) — and
	* this package holds one worker composition, not a spawn flavor and a
	* recovery flavor that could drift apart.
	*/
	workerSetup(role) {
		return async (agentCtx, agent) => {
			await this.ctx.agentPresets.mount(agentCtx, role.agentPreset);
			this.ctx.permissionPresets.set(agent.session, role.permissionPreset);
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
	/**
	* What one worker resume reaches: the live registry, the deployment's own
	* session read path, the graph store, this runtime's worker composition, and
	* the model selection a spawn would run under.
	*/
	workerResumeDeps(request) {
		return {
			agents: this.ctx.agents,
			sessionQuery: this.ctx.sessionQuery,
			graph: this.ctx.graph,
			setup: (role) => this.workerSetup(role),
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
	live(agent) {
		if (this.ctx.agents.get(agent.id) !== agent) throw new Error(`agent-runtime: agent "${agent.id}" is not live`);
	}
	scope(sessionId) {
		const scope = this.scopes.get(sessionId);
		if (scope === void 0) throw new Error("agent-runtime: agent has no graph scope");
		return scope;
	}
};
var src_default = AgentRuntime;

//#endregion
export { AgentRuntime, MessageDeliveryRefusal, RAW_SESSION_READ_DENIAL, RAW_SESSION_READ_TOOLS, WORKER_DEFAULT_PERMISSION_PRESET, WORKER_KICKOFF_TEXT, WORKER_POLICY_TEXT, WorkerResumeRefusal, answerMessageText, applyWorkerGrant, src_default as default, ensureAgentMessageDelivered, findSkillFileIn, messageAccepted, parseSkillFile, questionMessageText, readToolCallBody, reconcileAgentMessageDeliveries, relayMessage, resolveGrant, resumeWorkerAgent, sealRawSessionReads, skillRootsFor, toolCallRefIn };