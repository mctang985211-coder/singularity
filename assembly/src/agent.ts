import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ProtocolRefusal } from '../../src/protocol/refusal.ts'
export const name = 'singularity-agent'
export const inject = ['singularity', 'tools', 'systemPrompt']
const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] }
async function attempt<T>(step: () => Promise<T>) {
  try { return await step() } catch (error) {
    if (error instanceof ProtocolRefusal) return { refused: error.refusal.code, detail: error.refusal.detail }
    throw error
  }
}
export const taskGuidance = `Singularity develops reusable domain exploration methods through Task trees.
A TaskTemplate describes a domain responsibility, general step or exploration strategy, including its
applicability, optional child relationships and Skill bindings. A Task instantiates that definition
for this problem. A Run is an execution attempt with sealed results and independent acceptance evidence.
RSI uses these actual responsibilities, relationships, outcomes and costs to improve the domain method
in one Revision. This requires the exploration structure to exist while the work is being done.

After brief reconnaissance, assign substantial independently checkable work to Tasks before executing
it. Triggers include competing candidate families, a repeated experimental sweep, a separate correctness
investigation, or validation whose result determines the next exploration. When such a trigger is present,
make a concrete decomposition call before the next batch of that work; a plan to decompose later does
not establish responsibility or evidence. Select boundaries by hypothesis, uncertainty and acceptance,
even when all changes touch one file and each command runs quickly. A matrix of implementations and
several rounds of experiments are substantial exploration. A single focused check or small edit within
an already bounded responsibility can remain local. A child may perform its own bounded experiments
and select further responsibilities when evidence warrants them; do not split every command into a Task.

Children perform selected portions of the remaining work. Use their sealed artifacts, verdicts and
measured findings to continue the parent; the parent assembles and submits its final artifact for its
own independent acceptance. That acceptance does not require the parent to independently rediscover
every child solution. Avoid assigning a child the same broad search the parent is already performing.
The parent's final submission can reuse a verified child source; integration and a justified selection
are real parent responsibilities without inventing another candidate or repeating its programming.
The parent retains full file, command, programming and Skill capabilities and can pursue complementary
bounded work, resolve integration issues and verify the final result. Choose a useful definition or
declare a suitable free contract; explain its responsibility, expected deliverable and acceptance.
Share task-local observations through declared contracts and verified predecessor inputs in this tree.
The isolation rule prohibits solution or trajectory transfer between independent evaluation trials;
it permits the declared flow of sealed evidence within one Task tree.

Choose a decomposition appropriate to the evidence; no fixed shape or node count is required. The pinned
recipe is a reference method you can select, and additional custom branches can be appended in later calls.
The template and custom input forms are mutually exclusive within one call. maxRuns is an attempt limit,
not a requirement to execute every attempt. If a branch fails or is under-target, retain its actual
result and reason, then use that evidence to select replacement or complementary work. Keep further
search bounded when the goal is already met. Creating children after solving the problem, or using one
worker to hide the entire extended exploration, provides inadequate evidence of an exploration method.
The decomposition response lists newly dispatched agents; dependency-waiting children already exist.
Read task status to see the complete committed plan rather than declaring those children again. Across
batches, dependencies use previously committed task ids, not keys from an earlier batch. Before final
submission, all declared children must settle. When their work is the only remaining dependency, finish
the current turn with an honest pending status. The scheduler resumes the same parent Run on outcomes;
repeated status polls, sleep commands and duplicate experiments are not useful continuation work.

Budget decisions compare the complete work, including parent, children and reviews. Delegated work should
replace duplicated exploration. The RSI candidate cost ceiling compares the complete candidate and
baseline evaluations; it is not an extra surcharge limit imposed on an individual decomposition call.
Respect the human experiment limits on tokens, candidates and rounds. The maximum budget is a ceiling,
not a spending target. Record honest outcomes; do not manufacture failures or a winning method.`
export const reviewGuidance = `Independent review guidance:
Read the assignment and exact frozen subject before selecting work. Judge that subject's stated
requirements and submit the complete review JSON source with its raw-byte subjectDigest. A source
submission requires JSON text, not a JavaScript program that prints JSON. Preserve honest fail,
partial and unknown findings; no instruction requires approval or a winning method.
For acceptance, check the exact assigned goal and criteria as well as the verifier result. A known
counterexample to that contract remains a failure even if its tests pass; another Task's narrower
observable behavior does not weaken this Task's requirements. Cite the counterexample precisely.

Keep a bounded review checklist and its findings in the review artifact. Domain candidate-family
decomposition triggers do not apply to an audit checklist. Creating free audit contracts triggers
another independent asset-admission review before those children can run, so repeating this pattern
recursively increases cost without producing the original decision. Normally perform these checks
directly with your full file, command, programming and Skill capabilities. Delegate only when an
already admitted suitable contract, its exact input and genuinely separate work justify the cost;
do not create another admission chain merely to organize the current review.

For asset admission, inspect the exact changes against the frozen basis, protected requirements,
usable bindings and executable paths. Exploration hypotheses need not all succeed. A small
discriminating probe can resolve a concrete usability concern; a complete candidate sweep or search
for better RTL belongs to the domain solver and later independent evaluation. Do not require measured
improvement at admission. Report inherited apparatus limitations separately from defects introduced
by the change. Quantitative evaluation may use a separate frozen measurement and threshold in addition
to functional acceptance; the functional verifier alone is not the entire evaluation decision.

Use the actual protocol scope: criterionId belongs to a Task contract; evidence is also bound to its
Task, Run, verifier and artifact. Reusing a criterionId across templates does not by itself conflate
receipts. The Revision contains method assets; exact audit subjects and problem inputs are frozen
separately for each Run. A proposed child contract may describe the assigning parent's subject rather
than this admission request about its assets. Asset-admission taskId/runId identify that assigning Run.
Check the declared input binding and explicit frozen
references before claiming the subject, template or revision is missing. Distinguish prose references
from schema links and do not impose global identifier uniqueness or self-reference requirements.
Ground a rejection in a concrete violation of the exact assigned requirements and its evidence.
As an asset reviewer, inspect actual content, executable paths and declared bindings. A usable asset
is not yet proof of improvement. As a publication reviewer, connect measured effects to exact changed
assets and actual per-Run uses; distinguish a delivered Skill from behavioral use and an invoked Tool.
Verify independent acceptance and complete costs; area gain cannot compensate for broken behavior,
evidence leakage, task-answer memorization or missing evidence.`
const protocolGuidance = `
A Task has an immutable goal,
inputs, acceptance criteria and exact asset Revision. A Run owns its Bubble workspace; standard DSH
file, search, bash and Skill tools operate inside that Bubble. Model decisions, decomposition,
programming and local investigation belong to the responsible agent.
Native human domain requests and assigned nodes already own a Task/Run. singularity_retry_task
reopens a failed Run of your own immutable Task, retaining its contract, inputs and asset Revision.
Create additional work through decomposition; only the native human entry and independent evaluations create roots.
The response names the workspace, protected inputs, artifact format and available templates.
Source artifacts are judged as written; a program artifact is the stdout of a Node ES module receiving
its input path in process.argv[2]. singularity_submit_program seals the complete source and produces
independent acceptance evidence. Evidence distinguishes pass, fail, partial and unknown.
Every assigned node must call singularity_submit_program with its taskId and complete source text
before reporting completion. Writing files, locally running a verifier, present and chat messages
do not seal or settle a Run. Include reproducible programs and evidence in the submitted artifact
when the assignment requests them; mutable workspace paths alone are not sealed deliverables.
Your assigned method context carries the exact template guidance, applicability and reusable decomposition.
It also lists readable reference directories and the existing localCheck argv. Use that frozen apparatus
for local validation. When measurement is present, its module exports measure(source, signal), returning
the absolute measurement in the stated unit; preserve its conditions. Do not reconstruct the apparatus
or infer that reference materials are unavailable merely because they are outside your workspace.
To select its direct children call singularity_decompose_task with a plan string containing the JSON
{taskId,useTemplateDecomposition:true}. It does not expand descendants automatically. You may instead
declare children suitable for the present problem. Do not specify both forms. Replaying the same
batch reuses its instances; a new child key creates another instance of a reusable template.
Decomposition may append children. Each child uses either a template id or a complete free contract
in the returned template declaration format. A free contract must include a distinct template id,
goal, input, workspace and criterion; use the supplied declarations as the schema. Its criterion.verifier
must name an available verifier suitable for its input and artifact format and able to check the stated
obligation. An RTL verifier cannot accept a findings report; the infrastructure review verifier requires
its own frozen subject and report contract. If a new responsibility needs a new evidence format, first
admit a Revision with a suitable verifier Tool and discriminating samples, then reference that Revision.
Both use the same admission path. Child dependencies
reference this batch's keys or previously committed task ids. supports cites parent acceptance criteria; verified
child artifacts support the parent, whose own final artifact needs independent acceptance.
After delegated work settles, failed or evidence-insufficient branches remain in the trace and do not
veto the parent's independent acceptance. Only verified artifacts can satisfy input dependencies.
All nodes are ordinary independent DSH main agents with their own resumable session. There is no
native delegation bypass. Missing capability bindings are reported as gaps: compose available skills,
create an immutable Revision with generated templates/Skills/Tools, or ask the user.
A Revision is {rootTemplate, templates, skills, tools}. A Skill is
{name,description,capabilities,requiredTools,content}; a Tool is {name,source,verifier?}.
Write the complete Revision JSON to a file in your Bubble and submit its relative path with
singularity_create_method. Preserve the frozen assets you intend to retain, including workspace.initialContent.
Tools are Node ES modules. A verifier Tool declares
{samples:[{name,artifactContent,inputContent,expected:"pass"|"fail"}]} with literal file contents,
not paths. These contents are frozen into sample files; the Tool receives their paths in
process.argv[2]/[3]. Exit 0 means pass, 1 fail, 3 partial, 4 unknown; other exits mean execution error.
Verification programs are independently reviewed and executed before use. Root input and acceptance
cannot change with method assets. Each Run keeps its exact Revision and actual asset bindings/use.
The unified Revision includes singularity-review and singularity-improvement templates. Their subject
is a frozen Run input; their instructions and Skill bindings are reusable assets.
A template may bind skills and request capabilities. Bound Skill contents are delivered in the frozen
method context; additional Revision Skills load through the native skill tool. Context delivery and
explicit loads are recorded separately by source. Delivery proves availability, not behavioral use.
singularity_run_method executes a named Tool from the pinned Revision. Tool use is your decision and recorded.
After root acceptance an independent improvement Task receives the actual trace. It may propose candidates
within the human experiment limits and evaluate them with singularity_evolve_method. Each evaluation compares actual
independent solves. Two independent solve/acceptance chains run concurrently after the baseline caliber
is frozen. Decisions wait for all chains; publication review follows the decision. The call waits for
completion; a persisted working Run does not imply a live worker.
After interruption, call singularity_evolve_method again with the exact same round request to resume it.
It reuses recorded trials and restores unfinished Task/Run sessions; do not wait for an interrupted call.
Each evaluation measures area and all native token costs including review. This batch's proposal cost is
allocated equally across its candidates; final publication review is included. Publication happens
automatically only for a measured winner with independent review and a matching published head. Unimproved candidates,
no winner, unknown evidence and budget exhaustion must be reported truthfully. RSI changes method assets.
Asset admission reviews safety, contracts and usable bindings before evaluation; it does not assert
measured improvement. Publication review judges the subsequent independent evaluation and cost evidence.
Complete the exact assigned immutable goal and all requested artifact fields. A JSON envelope is a
submission format; it does not turn a solve assignment into a review assignment. Audit nodes judge
their exact frozen subject. Evaluation nodes solve the protected root task.
History is scoped to your Task tree, pinned assets and explicit frozen audit references. Independent
evaluation solves start fresh in separate Bubbles and cannot read other trials or proposals.
An evaluation solver completes its assigned domain artifact; the owning improvement Task handles RSI.
`
const improvementGuidance = `You are responsible for evidence-based method improvement within the declared experiment limits.
Start with the frozen structural summary: responsibilities, dependencies,
per-Run verdicts, sealed artifacts, consumed assets and session event locations. Read the corresponding
failed and successful trajectory segments before diagnosing a mechanism; do not reconstruct the entire
tree from raw logs when its structure is already recorded. Improve Task definitions and relationships
as well as Skill contents when evidence identifies a domain responsibility or ordering problem.
Separate protocol/execution failures, invalid results and valid but under-target results. For each proposed
change explain the cited evidence, checkable trigger, changed assets, predicted effects on the protected task,
success behavior it must preserve, regression risk and why the mechanism transfers within this domain.
Keep independent mechanisms attributable; the number of changes, candidates, rounds and decompositions
is your decision within the declared budget. Do not repeat a falsified proposal without new evidence.
Reusable domain principles, measurement tools, check methods and applicability conditions may become assets.
Specific winner RTL, precomputed task answers, exact winning output values and cross-trial solution injection
are memorization and cannot justify an RSI improvement. A tool's discriminating fixtures are test evidence,
not answer material to inject into a solver. Express obligations and evidence dependencies rather than
a universal sequence of tools or a predetermined task tree. Additional Skill use remains your decision.
`
export function guidanceFor(purpose: string | undefined): string {
  let role: string
  switch (purpose) {
    case undefined: return protocolGuidance
    case 'solve': case 'evaluation': role = taskGuidance; break
    case 'review': role = reviewGuidance; break
    case 'improve': role = improvementGuidance; break
    default: throw new Error('Unknown Singularity Run purpose: ' + purpose)
  }
  return role + '\n\n' + protocolGuidance
}
export function apply(ctx: Context): void {
  const disposers = [
    ctx.tools.register(defineTool({ name: 'singularity_retry_task', description: 'Start another Run of your own failed Task with the same immutable contract, protected inputs and asset Revision. Child Run budgets still apply.',
      parameters: { taskId: { type: 'string', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).retry(args))) })),
    ctx.tools.register(defineTool({ name: 'singularity_decompose_task', description: 'Declare independently checkable children of your assigned Task when its responsibilities warrant decomposition. Children return sealed evidence for parent integration. Pass plan as a JSON string: {taskId,useTemplateDecomposition:true}, or {taskId,children:[{key,template? OR contract?,method?,dependsOn,supports,maxRuns}]}. Choose one form per call; later calls can append branches. Free contracts use the template declaration format and require independent asset admission before dispatch. Exact replay is idempotent.',
      parameters: { plan: { type: 'string', description: 'Serialized Task batch JSON. maxRuns limits attempts; it does not require all attempts.', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).decompose(JSON.parse(args.plan)))) })),
    ctx.tools.register(defineTool({ name: 'singularity_submit_program', description: 'Seal the complete final source of this Task/Run and obtain independent acceptance. The program field is source text, not a file path.',
      parameters: { taskId: { type: 'string', required: true }, program: { type: 'string', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).submit(args))) })),
    ctx.tools.register(defineTool({ name: 'singularity_task_status', description: 'Read a Task contract, dependencies, sealed artifacts, evidence and final receipt.',
      parameters: { taskId: { type: 'string', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).status(args))) })),
    ctx.tools.register(defineTool({ name: 'singularity_create_method', description: 'Read and freeze a complete unified Revision JSON file {rootTemplate,templates,skills,tools} from this working Run. Returns {environmentId,revisionId,digest} after asset admission review and verifier sample execution. Admission precedes measurement and does not publish. Verifier samples contain literal artifactContent/inputContent, not paths.',
      parameters: { path: { type: 'string', description: 'Relative path to the complete Revision JSON file in this Run\'s Bubble.', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).createMethod(args))) })),
    ctx.tools.register(defineTool({ name: 'singularity_run_method', description: 'Execute a named Tool from this Run\'s pinned Revision in its Bubble; optional candidate is passed as process.argv[3].',
      parameters: { taskId: { type: 'string', required: true }, tool: { type: 'string', required: true }, candidate: { type: 'string' } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).runMethod(args))) })),
    ctx.tools.register(defineTool({ name: 'singularity_evolve_method', description: 'Evaluate admitted candidates independently and wait for completion. JSON {roundId,round,incumbent,candidates}. Repeating the exact same request is idempotent: it reuses committed trials and resumes unfinished Task/Run sessions after interruption. An independently reviewed measured winner publishes automatically.',
      parameters: { round: { type: 'string', description: 'JSON {roundId:string,round:positive integer,incumbent:{environmentId,revisionId,digest},candidates:[{environmentId,revisionId,digest}]}. Use exact references returned by create_method or method_history. Candidates are direct references, with no name, revision wrapper or inline assets.', required: true } }, output,
      execute: async (args, exec) => JSON.stringify(await attempt(() => ctx.singularity.forCall(exec).evolve(JSON.parse(args.round)))) })),
    ctx.tools.register(defineTool({ name: 'singularity_method_history', description: 'Read your Task tree and pinned Revision contents. Audit nodes can also read explicit frozen subject references. Evaluation/validation nodes cannot read other trials, proposals or global asset history.', parameters: {}, output,
      execute: async (_args, exec) => JSON.stringify(await ctx.singularity.forCall(exec).history()) })),
    ctx.systemPrompt.section({ name: 'singularity:protocol', order: 60,
      text: context => guidanceFor(context.agent === undefined ? undefined : ctx.singularity.purpose(String(context.agent.id))) }),
  ]
  ctx.effect(() => () => { for (const dispose of disposers) dispose() })
}
