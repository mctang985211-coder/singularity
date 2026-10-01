import type {
  AcceptanceCriterion,
  CapabilityManifest,
  Obligation,
  TaskContract,
  TaskInstance,
  TaskProposal,
  TaskProposalChild,
  TaskProposalDecomposition,
} from '@dangosys/dsh-singularity-task'
import type { DecompositionReviewRequest, ProposalReviewRequest, RootContractReviewRequest } from '@dangosys/dsh-singularity-task-runtime'

/** How a container field is listed, or that it held nothing — never an omitted line a reader has to notice. */
function listField(title: string, items: readonly string[], empty: string): string[] {
  if (items.length === 0) return [`  ${title}: ${empty}`]
  return [`  ${title}:`, ...items.map(item => `  - ${item}`)]
}

/** The protected acceptance inputs a criterion declares, with the identity fixed at submission: */
function protectedInputsPart(criterion: AcceptanceCriterion): string {
  const declared = criterion.protectedInputs ?? []
  if (declared.length === 0) return ''
  return ` [protected inputs: ${declared.map(ref => `${ref.path} sha256:${ref.sha256}`).join(', ')}]`
}

/** The evidence and artifact requirements a criterion declares, as one suffix — omitted entirely when it declares none. */
function requirementParts(criterion: AcceptanceCriterion): string[] {
  const parts: string[] = []
  if (criterion.requiredEvidence.length > 0) parts.push(`required evidence: ${criterion.requiredEvidence.join(', ')}`)
  if ((criterion.requiresArtifact ?? []).length > 0) parts.push(`requires verified artifact: ${criterion.requiresArtifact!.join(', ')}`)
  if ((criterion.acceptsArtifact ?? []).length > 0) parts.push(`accepts artifact: ${criterion.acceptsArtifact!.join(', ')}`)
  if (criterion.childEvidence !== undefined && criterion.childEvidence.length > 0) {
    parts.push(`child evidence: ${criterion.childEvidence.map(item =>
      `run member ${item.childIndex}${item.criterionId === undefined ? '' : `:${item.criterionId}`}${item.evidenceRef === undefined ? '' : `#${item.evidenceRef}`}`).join(', ')}`)
  }
  return parts
}

/** How a criterion reads to a reviewer: its id, its mode, whether it is mandatory, whether it is a heuristic judgement (which never counts as a deterministic pass — §5 requires the marking, not a. */
function criterionLine(criterion: AcceptanceCriterion, indent = '    '): string {
  const qualifiers = [
    criterion.verificationMode,
    ...(criterion.mandatory ? ['mandatory'] : ['optional']),
    ...(criterion.heuristic === true ? ['heuristic — judged by a model, never a deterministic pass'] : []),
  ]
  const command = criterion.command === undefined ? '' : ` — $ ${criterion.command}`
  const verifier = criterion.verifierRef === undefined ? '' : ` [verifier: ${criterion.verifierRef}]`
  const requirements = requirementParts(criterion)
  const requirementText = requirements.length === 0 ? '' : ` [${requirements.join('; ')}]`
  return `${indent}- ${criterion.criterionId} [${qualifiers.join(', ')}] ${criterion.description}${command}${verifier}${protectedInputsPart(criterion)}${requirementText}`
}

/** How one declared capability resolved when this batch was proposed: the manifest the runtime built for *this* child, with the skills and tools a worker would be granted — and the capability gap named when a requirement is */
function resolutionLines(manifest: CapabilityManifest | undefined): string[] {
  if (manifest === undefined) return []
  const entries = Object.entries(manifest.capabilities)
  if (entries.length === 0 && manifest.missing.length === 0) return []
  const lines = entries.map(([name, entry]) => {
    const parts = [
      ...(entry.skills.length === 0 ? [] : [`skills: ${entry.skills.join(', ')}`]),
      ...(entry.tools.length === 0 ? [] : [`tools: ${entry.tools.join(', ')}`]),
      ...(entry.preset === undefined ? [] : [`preset: ${entry.preset}`]),
      ...(entry.permission === undefined ? [] : [`permission: ${entry.permission}`]),
      ...(entry.mcpServers === undefined || entry.mcpServers.length === 0 ? [] : [`mcp servers: ${entry.mcpServers.join(', ')}`]),
    ]
    return `  - ${name} → ${parts.length === 0 ? 'granted no skill or tool' : parts.join('; ')}`
  })
  const missing = manifest.missing.map(name => `  - ${name} → NOT GRANTED (capability gap: the registry has no such row, and this batch's admission recorded it)`)
  return ['  resolution (the manifests this batch resolved to):', ...lines, ...missing]
}

/** One child of the batch as a reviewer reads it (§5): its goal, its criteria, what it inherits as assumptions and constraints, what it waits for, what it requires, and how those requirements currently resolve. */
export function renderProposalChild(
  child: TaskProposalChild,
  options: {
    index: number
    siblings: readonly TaskProposalChild[]
    contractDigest?: string
    manifest?: CapabilityManifest
  },
): string[] {
  const contract = child.contract
  const verifierRefs = [...new Set(contract.acceptanceCriteria.flatMap(criterion => criterion.verifierRef ?? []))]
  const dependencies = child.dependsOn.map(index => {
    const sibling = options.siblings[index]
    return `child ${index}${sibling === undefined ? '' : ` (${sibling.contract.objective})`}`
  })
  return [
    `- child ${options.index}: ${contract.objective}`,
    ...(options.contractDigest === undefined ? [] : [`  contract digest (sha256): ${options.contractDigest}`]),
    `  contract version: ${contract.contractVersion}`,
    '  acceptance criteria:',
    ...contract.acceptanceCriteria.map(criterion => criterionLine(criterion)),
    ...(verifierRefs.length === 0 ? [] : [`  pinned verifiers: ${verifierRefs.join(', ')}`]),
    ...listField('assumptions', contract.assumptions, '(none declared — the contract rests on nothing stated)'),
    ...listField('constraints', contract.constraints, '(none declared)'),
    ...listField('required capabilities', contract.requiredCapabilities, '(none)'),
    ...resolutionLines(options.manifest),
    ...listField('depends on', dependencies, '(nothing — this child may start first)'),
    `  decomposable: ${child.decomposable ? 'yes' : 'no'}; requires independent acceptance: ${child.requiresIndependentAcceptance ? 'yes' : 'no'}`,
  ]
}

/** The complete batch content of a stored proposal, one block per child in batch order — the whole set, never a prefix. */
export function renderProposalChildren(proposal: TaskProposalDecomposition, manifests?: readonly CapabilityManifest[]): string[] {
  return proposal.batch.flatMap((child, index) => [
    ...renderProposalChild(child, {
      index,
      siblings: proposal.batch,
      ...(proposal.identity.children[index]?.contractDigest === undefined ? {} : { contractDigest: proposal.identity.children[index]!.contractDigest }),
      ...(manifests?.[index] === undefined ? {} : { manifest: manifests[index]! }),
    }),
    '',
  ])
}

/** One root contract as a reviewer reads it (§5's display list for the subject that has no parent): the contract version, the objective, every criterion with the markings {@link criterionLine} prints, the assumptions and */
export function renderRootContract(contract: TaskContract, manifests?: readonly CapabilityManifest[]): string[] {
  return [
    `- contract version: ${contract.contractVersion}`,
    `- objective: ${contract.objective}`,
    '- acceptance criteria:',
    ...contract.acceptanceCriteria.map(criterion => criterionLine(criterion, '  ')),
    ...listField('assumptions', contract.assumptions, '(none declared — the contract rests on nothing stated)'),
    ...listField('constraints', contract.constraints, '(none declared)'),
    ...listField('required capabilities', contract.requiredCapabilities, '(none)'),
    ...resolutionLines(manifests?.[0]),
  ]
}

/** The limits one proposal was admitted under, as the record holds them, with the enforced and the audited values kept apart. */
function limitLines(proposal: TaskProposal): string[] {
  const context = proposal.admissionContext
  const audited = [
    ...(context.auditOnly.maxToolCalls === undefined ? [] : [`maxToolCalls ${context.auditOnly.maxToolCalls}`]),
    ...(context.auditOnly.tokens === undefined ? [] : [`tokens ${context.auditOnly.tokens}`]),
    ...(context.auditOnly.attempts === undefined ? [] : [`attempts ${context.auditOnly.attempts}`]),
  ]
  return [
    `- enforced at admission: maxDepth ${context.maxDepth}, maxChildren ${context.maxChildren}`,
    `- audited after the run (never enforced in flight): ${audited.length === 0 ? 'none configured' : audited.join(', ')}`,
  ]
}

/** The identity a decision binds, as both subjects print it: the three digests, the resolution, the key and the submission time. `subject` only names what the pinned verifiers belong to. */
function identityLines(
  proposal: TaskProposal,
  subject: 'batch' | 'contract',
  registeredVerifiers: readonly string[] | undefined,
): string[] {
  return [
    `- proposal digest (sha256): ${proposal.proposalDigest}`,
    `- admission context digest (the limits above): ${proposal.admissionContextDigest}`,
    `- review context digest (the resolution above): ${proposal.reviewContextDigest}`,
    `- capability manifest digest: ${proposal.reviewContext.capabilityManifestDigest}`,
    `- judging verifiers (the ids this ${subject}'s criteria pin): ${proposal.reviewContext.verifiers.length === 0 ? '(none pinned — criteria dispatch by mode)' : proposal.reviewContext.verifiers.map(verifier => verifier.verifierId).join(', ')}`,
    ...(registeredVerifiers === undefined
      ? ['- the deployment could not list its verifier registry when this review was requested']
      : [`- registered verifiers now: ${registeredVerifiers.join(', ')}`]),
    `- request key: ${proposal.requestKey}`,
    ...(proposal.supersedes === undefined ? [] : [`- supersedes: ${proposal.supersedes}`]),
    `- submitted at: ${proposal.createdAt}`,
  ]
}

/** The obligations a review lists, as the request carried them. An empty list is printed as one line rather than omitted: */
function reviewObligationLines(obligations: readonly Obligation[]): string[] {
  return obligations.length === 0
    ? ['(none recorded when this review was requested)']
    : obligations.map(obligation => `- ${obligation.obligationId}: ${obligation.goal} — judged by: ${obligation.criterion}`)
}

/** The review of a decomposition batch (T2/T3 §5): the parent's own goal, every child, the limits and the obligations on the parent. */
function renderBatchReview(request: DecompositionReviewRequest): string {
  const proposal = request.proposal
  if (proposal.kind === 'root') {
    throw new Error(
      `proposal-review: proposal "${proposal.proposalId}" is a root contract, which a batch review cannot carry`,
    )
  }
  const parent: TaskInstance = request.parentTask
  return [
    `Batch review — proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}, trigger: ${request.trigger})`,
    `store: ${request.storeId}`,
    '',
    'A decision answers one question: should this batch run as it is written here? Approving it does not mean the work is',
    'accepted (the verifiers still judge every criterion), does not grant a capability, and does not close a gap. The',
    'decision binds the batch digest and both context fingerprints printed below: a revision, a re-resolution or a',
    'changed limit is a different proposal.',
    '',
    '## Parent task',
    `- ${parent.taskId} [${parent.status}/${parent.decompositionStatus}] depth ${parent.depth}`,
    `- objective: ${parent.objective}`,
    '- acceptance criteria:',
    ...parent.acceptanceCriteria.map(criterion =>
      `  - ${criterion.criterionId} [${criterion.verificationMode}${criterion.mandatory ? ', mandatory' : ''}] ${criterion.description}`),
    `- run: ${proposal.identity.parentRunId} (proposing session ${proposal.identity.callerSessionId})`,
    `- reason recorded for this batch: ${proposal.identity.reason}`,
    '',
    `## Children (${request.batch.children.length})`,
    ...renderProposalChildren(proposal, request.manifests),
    '## Limits this batch is admitted under',
    ...limitLines(proposal),
    '',
    `## Unmet obligations on the parent (${request.obligations.length})`,
    ...reviewObligationLines(request.obligations),
    '',
    '## Identity — what an approval would bind',
    ...identityLines(proposal, 'batch', request.registeredVerifiers),
    '',
    '## What this review cannot promise',
    '- the manifests above name skills, tools, presets and MCP servers — names, not the bytes behind them. What a worker',
    '  actually loads is pinned per run at spawn, which happens after this decision.',
    '- a verifier is named by the registered id its criteria pin. This deployment cannot name the version or the',
    '  configuration that registration currently stands for.',
    '- a criterion marked heuristic is judged by a model; nothing in this batch turns it into a deterministic pass.',
  ].join('\n')
}

/** The review of a root contract (A0 §3): the goal a root session would be admitted as, and no parent section — there is no parent task, and the root task this contract becomes does not exist while it waits. */
function renderRootReview(request: RootContractReviewRequest): string {
  const proposal = request.proposal
  return [
    `Root contract review — proposal ${proposal.proposalId} [${proposal.status}] (policy ${proposal.policy}, trigger: ${request.trigger})`,
    `store: ${request.storeId}`,
    '',
    'A decision answers one question: should this root contract be accepted as the goal this graph works toward? Approving',
    'it does not mean the work is accepted (the verifiers still judge every criterion), does not grant a capability and does',
    'not close a gap. Nothing exists while it waits — no root task, no run and no worker: the root task is what this contract',
    'becomes once the runtime re-checks and activates it. The decision binds the contract digest and both context',
    'fingerprints printed below: a revision, a re-resolution or a changed limit is a different proposal.',
    '',
    '## Root contract (the goal this session would be admitted as)',
    `- root session: ${request.rootSessionId}`,
    ...renderRootContract(request.contract, request.manifests),
    '',
    '## Limits this contract is admitted under',
    ...limitLines(proposal),
    '',
    `## Unmet obligations on this root contract (${request.obligations.length})`,
    ...reviewObligationLines(request.obligations),
    '',
    '## Identity — what an approval would bind',
    ...identityLines(proposal, 'contract', request.registeredVerifiers),
    '',
    '## What this review cannot promise',
    '- the manifests above name skills, tools, presets and MCP servers — names, not the bytes behind them. What the root run',
    '  actually loads is pinned when it is activated, which happens after this decision.',
    '- a verifier is named by the registered id its criteria pin. This deployment cannot name the version or the',
    '  configuration that registration currently stands for.',
    '- a criterion marked heuristic is judged by a model; nothing in this contract turns it into a deterministic pass.',
    '- the objective above is the root agent\'s reading of the user\'s request. This card carries the contract, not the request',
    '  it was built from, and machine admission does not prove that reading correct (A0 §1.10).',
  ].join('\n')
}

/** The review material one person is shown (§5), rendered from the saved facts: */
export function renderProposalReview(request: ProposalReviewRequest): string {
  return request.kind === 'root' ? renderRootReview(request) : renderBatchReview(request)
}
