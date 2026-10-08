/** The one `system-prompt/assemble` listener this package owns (A2 §D/§9). */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, AssembledSection, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { SingularityContextService } from './index.ts'
import type { ProjectedReadRefused } from './refusals.ts'
import { refused } from './refusals.ts'

/** Section name of the assembled contract: the one slot the immutable half has ever had. */
export const WORKER_CONTRACT_SECTION = 'singularity:worker-contract'

/** Placement: after the root's `singularity:root` (70) and the worker policy's `singularity:worker` (75). */
export const WORKER_CONTRACT_ORDER = 80

/** The dynamic half's context name on the runtime-context plane. */
export const STATE_CONTEXT_NAME = 'singularity:state'

/** Placement among the runtime contexts, after the centrally allocated ones (`CONTEXT_ORDERS` ends at 120). */
export const STATE_CONTEXT_ORDER = 130

/** The question plane's context name (A4 §F.1): a separate name, so planes deduplicate separately. */
export const QUESTIONS_CONTEXT_NAME = 'singularity:questions'

/** Placement among the runtime contexts: right behind the state plane. */
export const QUESTIONS_CONTEXT_ORDER = 140

/** The sections that sort at or ahead of {@link WORKER_CONTRACT_ORDER}, by name. */
const PRE_CONTRACT_SECTIONS: ReadonlySet<string> = new Set([
  'harness:identity',
  'deployment:persona-prefix',
  'singularity:root',
  'singularity:worker',
])

/** The error a refused assembly throws: the refusal is its name, the detail its message. */
export class AssemblyRefusalError extends Error {
  constructor(
    readonly refusal: ProjectedReadRefused['refusal'],
    detail: string,
  ) {
    super(detail)
    this.name = 'AssemblyRefusalError'
  }
}

/** Throw the projection's refusal as the named rejection of this model request. */
function throwRefusal(read: ProjectedReadRefused): never {
  throw new AssemblyRefusalError(read.refusal, `system-prompt assembly refused (${read.refusal}): ${read.detail}`)
}

/** The section the immutable half becomes: literal text, never variable-interpolated. */
function contractSection(text: string): AssembledSection {
  return { name: WORKER_CONTRACT_SECTION, text, interpolate: false }
}

/** Replace the contract section by name, or insert it at its order. */
function withContractSection(assembly: PromptAssembly, text: string): void {
  const existing = assembly.sections.find(section => section.name === WORKER_CONTRACT_SECTION)
  if (existing !== undefined) {
    existing.text = text
    existing.interpolate = false
    return
  }
  let index = 0
  while (index < assembly.sections.length && PRE_CONTRACT_SECTIONS.has(assembly.sections[index]!.name)) index += 1
  assembly.sections.splice(index, 0, contractSection(text))
}

/** Append one plane to the runtime-context plane; an unchanged name is replaced, never duplicated. */
function withRuntimeContext(assembly: PromptAssembly, name: string, text: string): void {
  // Harness runtime contexts are always interpolated. Task facts instead use literal sections.
  assembly.contexts = assembly.contexts.filter(context => context.name !== name)
  const existing = assembly.sections.find(section => section.name === name)
  if (existing !== undefined) {
    existing.text = text
    existing.interpolate = false
  } else assembly.sections.push({ name, text, interpolate: false })
}

/** The question plane, when it has anything to say: an empty projection adds no context at all. */
function withQuestionContext(assembly: PromptAssembly, text: string): void {
  if (text.length > 0) withRuntimeContext(assembly, QUESTIONS_CONTEXT_NAME, text)
}

/** The one assembly step: one caller resolution, then the planes that role is owed (README: who gets what). */
export async function assembleSingularityContext(
  service: SingularityContextService,
  assembly: PromptAssembly,
  context: AssembleContext,
  next: () => Promise<PromptAssembly>,
): Promise<PromptAssembly> {
  // A diagnostic assembly names no agent: nothing about a project is injected
  // into a request nobody is making.
  const agent: Agent | undefined = context.agent
  if (agent === undefined) return next()
  const sessionId = String(agent.id)
  const caller = await service.load(sessionId, context.signal)

  switch (caller.resolution.kind) {
    case 'worker': {
      if (caller.resolution.run.executionPhase === 'active') {
        try { withRuntimeContext(assembly, 'singularity:task-templates', await service.templatesFor(caller)) }
        catch (error) { throw new AssemblyRefusalError('unreadable', `task-template-catalog-unreadable: ${error instanceof Error ? error.message : String(error)}`) }
      }
      const contract = await service.contractFor(caller)
      if (!contract.ok) throwRefusal(contract)
      const dynamic = await service.dynamicFor(caller)
      if (!dynamic.ok) throwRefusal(dynamic)
      const questions = await service.questionsFor(caller)
      if (!questions.ok) throwRefusal(questions)
      withContractSection(assembly, contract.text)
      withRuntimeContext(assembly, STATE_CONTEXT_NAME, dynamic.text)
      withQuestionContext(assembly, questions.text)
      return next()
    }
    case 'root': {
      if (caller.resolution.run === undefined || caller.resolution.run.executionPhase === 'active') {
        try { withRuntimeContext(assembly, 'singularity:task-templates', await service.templatesFor(caller)) }
        catch (error) { throw new AssemblyRefusalError('unreadable', `task-template-catalog-unreadable: ${error instanceof Error ? error.message : String(error)}`) }
      }
      // Not activated yet: the root prompt and the intake tools are this
      // session's whole context, exactly as before this package existed.
      if (caller.resolution.task === undefined) return next()
      const contract = await service.contractFor(caller)
      if (!contract.ok) throwRefusal(contract)
      // A root is a legal addressee: the questions its children asked it are
      // read here, and it has no parent of its own to have asked.
      const questions = await service.questionsFor(caller)
      if (!questions.ok) throwRefusal(questions)
      const dynamic = await service.dynamicFor(caller)
      if (!dynamic.ok) throwRefusal(dynamic)
      withContractSection(assembly, contract.text)
      withRuntimeContext(assembly, STATE_CONTEXT_NAME, dynamic.text)
      withQuestionContext(assembly, questions.text)
      return next()
    }
    case 'coordinator': {
      const contract = await service.contractFor(caller)
      if (!contract.ok) throwRefusal(contract)
      withContractSection(assembly, contract.text)
      return next()
    }
    // A plain member assembles what its composition gives it: it has no contract
    // of its own to inject, and it is a published session of a graph that reads.
    case 'member':
      return next()
    // `outside` is not this package's caller; a bound session whose facts could
    // not be read (`failed`) is refused by name, never sent an empty request.
    case 'unbound':
      if (caller.resolution.placement === 'outside') return next()
      throwRefusal(refused(caller.resolution.refusal, caller.resolution.detail))
  }
}
