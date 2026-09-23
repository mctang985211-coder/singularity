import { Context, Service } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";
import { DEFAULT_ROOT } from "@dangosys/dsh-singularity-layout";
import { RUN_CODE_NAME } from "@deepseek-ai/dsh-tools";
import * as McpClient from "@deepseek-ai/dsh-mcp-client";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
//#region src/contract-reinjection.ts
/** Section name. Registered into the worker's own scope, so no other agent inherits it. */
const WORKER_CONTRACT_SECTION = "singularity:worker-contract";
/**
* Placement: after the root's own `singularity:root` section (order 70) and
* well before the tool guidance the composition contributes at order 500+.
*/
const WORKER_CONTRACT_ORDER = 80;
/**
* Whether a spawn carries text to project. An absent or blank rendering
* registers nothing: a worker spawned outside the task runtime, and every root
* agent, keeps exactly the prompt its composition gives it.
*/
function carriesContract(contract) {
	return contract !== void 0 && contract.trim().length > 0;
}
/**
* The section a worker's contract rides on. `interpolate: false` because the
* text is literal contract data: an objective or a criterion that happens to
* contain `{{…}}` must reach the model as written, not be looked up as a prompt
* variable (and `renderPrompt` throws on an unknown reference).
*/
function contractSection(text) {
	return {
		name: WORKER_CONTRACT_SECTION,
		order: WORKER_CONTRACT_ORDER,
		text,
		interpolate: false
	};
}
/**
* Register the contract into one agent's prompt scope, during that agent's
* setup. Returns whether a section was registered.
*
* The registration lives on `agentCtx`, the agent's own scope: it is disposed
* with the agent and cannot leak into sibling workers or into the root, which
* is why this is not a global section.
*/
function installWorkerContract(agentCtx, contract) {
	if (!carriesContract(contract)) return false;
	agentCtx.systemPrompt.section(contractSection(contract));
	return true;
}

//#endregion
//#region src/prompts/root.prompts.ts
/**
* The evolution protocol paragraph: written into the root prompt only when the
* deployment registered the nine `evolution_*` tools. A prompt that names a
* protocol its tool surface cannot carry out asks for a call that will never
* happen (prompt contracts §1: a tool that is not mounted must not appear in
* the prompt).
*/
const EVOLUTION_PROTOCOL = `To carry a diagnosed fix into the evolution track, register it with evolution_propose, then evolution_candidate; when the candidate carries a structured mutation, evolution_prepare materializes it into the proposal sandbox (never production), then evolution_replay runs the candidate against this graph's historical terminal tasks and records a candidate-vs-champion report before evolution_gate, and close it with evolution_decide — every decision asks a human first. A recorded PROMOTE takes effect only through evolution_apply (skill / agent_preset / capability at L1–L3 only, asking the human a second time and naming every production path it writes); evolution_rollback restores the champion snapshot, again with human approval. L4 and bookkeeping-only types stay manual. evolution_list reads the ledger.`;
/**
* The root coordinator's system prompt for one composition, from the same fact
* the root's tool allow-list is read from (R0): `evolutionEnabled` false — a
* deployment that did not turn the chain on — leaves out the protocol paragraph
* entirely, so nothing in the text points at a tool that composition does not
* carry. The escalation path and every other role rule are unchanged either way.
*
* The intake paragraph is not conditional: accepting the user's own goal is the
* root's core path (A0), not a deployment option. It is written in the
* deployment style the prompt contracts fix — stable role rules, the current
* fact, and the explanation the next call needs — and it says what the runtime
* enforces: nothing here can approve a contract, and the review decides.
*
* Domain guidance is deliberately absent: a deployment's domain reference map
* (the `bb-pipeline` skill, say) reaches the model through the `skill` tool from
* that deployment's own configuration, not as part of the general root role.
*/
function rootPromptText(evolutionEnabled$1) {
	return `You are the root router of a Singularity graph. Your job is to connect workers, not to implement tasks.

Environment setup is delegated, never decomposed: call graph_spawn with a focused worker name and a complete task for each planned repository. Wait for worker results, decide whether more workers are needed, and synthesize the final answer. Do not inspect repositories, edit files, run commands, or use generic subagent tools yourself. Use hitl_ask or hitl_approve only when a human decision is required. Use graph_mark_ready after all environment setup workers succeed.

Your graph's goal is the user's own objective — never this graph's name, and never the setup work. When the user tells you what they want, write it as a root contract and accept it with task_intake: an objective, acceptance criteria of which at least one is mandatory and aimed at the delivered artifact rather than at the conjunction of its children, the assumptions you are making (marked as yours), the constraints in force, and any capabilities the work needs. Accept it before you do anything else with it — until a contract is accepted there is no root task, so task_read answers that the session is not activated and task_decompose has nothing to work on. Do not guess your way past that: an ambiguity that would change the objective, the scope or the acceptance goes back to the user through the channels you have, while a request you can normalize faithfully you normalize yourself with your assumptions stated. Where this deployment reviews contracts, task_intake may answer with a proposal id and nothing activated, exactly as task_decompose can: read the record with task_proposal_read, do not re-submit the same content while it waits (the same request is answered with the same proposal), and if the review refuses the contract, revise it against the reason on the record and call task_intake again — a revision is a new proposal, never a re-run of the refused one. Nothing you can call approves a contract: the decision is recorded by the review channel and the runtime activates the contract itself. Once it is active it is the goal you are held to, so do not act as if a contract were accepted before it is; and a root run that reached a terminal state leaves this session closed, where a late intake is refused rather than revived.

Task delegation runs through the task runtime. Once the contract is accepted, call task_read to see your root task contract, then call task_decompose with a delegation reason and a list of children. That call is for the user objective only: setup and environment work is never decomposed, and the root task allows a single decomposition — spending it on setup fails the root task outright. Each child needs a self-contained objective and acceptance criteria a verifier can check; give deterministic criteria an exact command. Order work with dependsOn when one child needs another's verified result. task_decompose returns at admission with a batch id and does not wait: the runtime runs the children one at a time in dependency order. Where this deployment reviews generated tasks, that call may instead come back waiting for a human review, with a proposal id and nothing admitted: then no child exists, no worker is spawned and your task is not decomposed until the review decides, so read the batch with task_proposal_read, do not re-submit the same content while it waits (the same request is answered with the same proposal), and if the review refuses the batch, revise it against the reason on the record and decompose again — a revision is a new proposal, never a re-run of the refused one. While that batch runs you are in phase waiting_children — you may read, query and diagnose (task_read, task_status, task_review_pack, task_diagnose), but writes, shell commands and another decomposition are refused, and you must not work on shared artifacts while a child worker is writing them. You are notified when the batch settles, and the runtime then submits your task for verification; you never claim completion yourself — only the verifier marks a task verified, from evidence. If the batch cannot finish, task_cancel ends it and settles the children. Use task_status to track the tree between decompose calls and task_read to review your contract and child states. task_verify is a worker self-check and does not change task status. When a settled task needs a postmortem, call task_review_pack for its evidence pack, then record your explanation with task_diagnose — a diagnosis is data for humans and later review, and its proposals never execute by themselves. When that pack reports escalation: required, the record's facts alone cannot settle the six dimensions the reviewer judges (task_specification, acceptance, decomposition, skill_fit, tool_fit, context_efficiency), so call task_review_agent for the same task and let the review node conclude them — it writes that judgement as its own Diagnosis, and the budget it prints is the per-store review-agent allowance, so a spent budget means the pack says not required even though a signal held.${evolutionEnabled$1 ? ` ${EVOLUTION_PROTOCOL}` : ""} When a capability gap, an exhausted budget, or an UNKNOWN(verifier) verdict leaves work you cannot settle yourself, report it to a human with escalate: name what is missing, what you already tried, and what you suggest — an incomplete card is refused, and nothing is recorded until the human approves.`;
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
	"skill",
	"task_intake",
	"task_decompose",
	"task_submit_result",
	"task_cancel",
	"task_proposal_read",
	"task_proposal_continue",
	"task_proposal_cancel",
	"task_status",
	"task_verify",
	"task_review_pack",
	"task_review_agent",
	"task_diagnose"
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
		"sessionPersistence"
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
						cwd: parentHeader.cwd,
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
					setup: async (agentCtx, agent) => {
						await this.ctx.agentPresets.mount(agentCtx, agentPreset);
						this.ctx.permissionPresets.set(agent.session, request.permissionPreset ?? "danger-full-access");
						installWorkerContract(agentCtx, request.contract);
						if (request.grant !== void 0) await applyWorkerGrant(agentCtx, agent, request.grant);
					}
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
				handle.agent.followup(createUserMessage({
					content: [...request.prompt],
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
export { AgentRuntime, applyWorkerGrant, src_default as default, findSkillFileIn, parseSkillFile, resolveGrant, skillRootsFor };