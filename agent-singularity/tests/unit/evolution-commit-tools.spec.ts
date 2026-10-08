/**
 * The two commit tools against a proposal that already carries an open commit
 * intent (K2): the retry settles the recorded commit instead of starting a
 * second one, and it does so without asking a human again — the intent already
 * binds the grant and the content it was approved against.
 *
 * What is real: the `EvolutionService`, the ledger file it folds and appends to,
 * the sandbox and production `SKILL.md` files, the atomic write and its
 * read-back, and the two tools the plugin registers. The rollback cases open
 * their intent through a *real* interrupted commit (`Config.commitProbe`, the
 * typed seam that stops a commit at a durable stage with an ordinary in-process
 * throw — a window-injection seam, not a process exit: the real exit is proven
 * by the nested-child cases in `tests/integration/k2-evolution-commit.spec.ts`);
 * the
 * apply cases forge the `commit_intent` line instead, because a fresh apply on a
 * decided proposal must walk the full experiment evidence gate, and what these
 * cases are about is the tool's own decision — an open intent is settled, not
 * bypassed. The service-level crash windows and the tampered-source cases have
 * their own home in the evolution package's spec.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../../evolution/src/index.ts'
import type { Config } from '../../../evolution/src/index.ts'
import { capabilityRowIdentity } from '../../../evolution/src/capability-candidate.ts'
import { defineEvolutionApplyTool } from '../../src/tools/evolution-apply.ts'
import { defineEvolutionListTool } from '../../src/tools/evolution-list.ts'
import { defineEvolutionRollbackTool } from '../../src/tools/evolution-rollback.ts'

const PROPOSAL_ID = 's1'
const SKILL = 'verify'

/** The file each commit replaces first, and the two versions production can hold. */
const TARGET = (skillRoot: string) => join(skillRoot, SKILL, 'SKILL.md')
const CANDIDATE = skillText('# the candidate version\n')
const BASELINE = skillText('# the production version\n')
const THIRD_PARTY = skillText('# a version no commit of this proposal wrote\n')

/** A loadable `SKILL.md`: the frontmatter the validator and the skill loader both require. */
function skillText(body: string, name = SKILL): string {
  return `---\nname: ${name}\ndescription: a fixture skill for the commit tools\n---\n\n${body}`
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The seven gate answers a prepared skill proposal needs before a decision. */
function gateAnswers(refs: readonly string[]) {
  return {
    targetFailureFixed: 'the empty-input fixture now passes',
    originalAcceptanceMaintained: 'the original criteria are unchanged and green',
    existingRegressionMaintained: 'the full suite replayed green',
    noUnacceptableSideEffects: 'the diff touches one command only',
    holdoutPerformanceAcceptable: 'the held-out fixtures pass',
    resourceCostAcceptable: 'same runtime as the baseline',
    regressionEvidenceRefs: [...refs],
  }
}

const AT = (seconds: number) => `2026-09-27T00:00:${String(seconds).padStart(2, '0')}.000Z`

/** The ledger lines of the second file an execution object carries — the two shapes a K3 intent can commit. */
const SIDECAR_TARGET = '/placeholder-sidecar'
const SIDECAR_SHA256 = sha256Of('the sidecar bytes of this fixture object')
const SIDECAR_CONTRACT_DIGEST = sha256Of('the declaration this fixture object loads to')

/**
 * The lifecycle lines every fixture starts from: a skill proposal walked to decided(PROMOTE).
 * `execution` forges the two-file object (`SKILL.md` plus `SKILL.contract.json`); the
 * default is the one-file guidance object.
 */
function decidedLines(execution = false): Record<string, unknown>[] {
  const common = { formatVersion: 4, proposalId: PROPOSAL_ID, actor: 'root-1' }
  return [
    {
      ...common, kind: 'proposed', targetType: 'skill', targetId: SKILL, baseVersion: 'v1', level: 'L2',
      rationale: 'the skill never mentions the empty-input fixture', sourceRefs: ['diagnosis:d1'], at: AT(0),
    },
    { ...common, kind: 'candidate', versionSet: { skill: 'v2' }, mutation: { name: SKILL, content: CANDIDATE }, at: AT(1) },
    execution
      ? {
          ...common, kind: 'prepared', sandbox: `sandbox/${PROPOSAL_ID}`, mechanical: true, champion: 'captured',
          skillContent: {
            name: SKILL, sha256: sha256Of(CANDIDATE),
            contract: { sha256: SIDECAR_SHA256, contractDigest: SIDECAR_CONTRACT_DIGEST },
          },
          skillBaseline: {
            name: SKILL, sha256: sha256Of(BASELINE),
            contract: { sha256: SIDECAR_SHA256, contractDigest: SIDECAR_CONTRACT_DIGEST },
          },
          files: [
            `skills/${SKILL}/SKILL.md`, `skills/${SKILL}/SKILL.contract.json`,
            `champion/skills/${SKILL}/SKILL.md`, `champion/skills/${SKILL}/SKILL.contract.json`,
          ],
          at: AT(2),
        }
      : {
          ...common, kind: 'prepared', sandbox: `sandbox/${PROPOSAL_ID}`, mechanical: true, champion: 'captured',
          skillContent: { name: SKILL, sha256: sha256Of(CANDIDATE) },
          skillBaseline: { name: SKILL, sha256: sha256Of(BASELINE) },
          files: [`skills/${SKILL}/SKILL.md`, `champion/skills/${SKILL}/SKILL.md`], at: AT(2),
        },
    { ...common, kind: 'gated', gate: gateAnswers([`sandbox/${PROPOSAL_ID}/replay-report.json`]), at: AT(3) },
    { ...common, kind: 'decided', decision: 'PROMOTE', approvalRef: 'approval:decide', at: AT(4) },
  ]
}

/** One `commit_intent` line, as the commit path writes it: one file, or two for an execution object. */
function intentLine(direction: 'apply' | 'rollback', approvalRef: string, execution = false): Record<string, unknown> {
  const swap = (file: string) => (direction === 'apply'
    ? { baselineSha256: sha256Of(BASELINE), contentSha256: sha256Of(CANDIDATE), source: `sandbox/${PROPOSAL_ID}/skills/${SKILL}/${file}` }
    : { baselineSha256: sha256Of(CANDIDATE), contentSha256: sha256Of(BASELINE), source: `sandbox/${PROPOSAL_ID}/champion/skills/${SKILL}/${file}` })
  return {
    formatVersion: 4, kind: 'commit_intent', intentId: `${PROPOSAL_ID}/${direction}`, proposalId: PROPOSAL_ID, direction,
    approvalRef,
    files: [
      { target: '/placeholder', ...swap('SKILL.md') },
      ...(execution ? [{ target: SIDECAR_TARGET, ...swap('SKILL.contract.json') }] : []),
    ],
    actor: 'root-1', at: AT(5),
  }
}

/** The completion that closes {@link intentLine}. */
function completionLine(direction: 'apply' | 'rollback', approvalRef: string, execution = false): Record<string, unknown> {
  return {
    formatVersion: 4, kind: direction === 'apply' ? 'applied' : 'rolledback', proposalId: PROPOSAL_ID,
    targets: ['/placeholder', ...(execution ? [SIDECAR_TARGET] : [])], approvalRef, intentId: `${PROPOSAL_ID}/${direction}`,
    actor: 'root-1', at: AT(6),
  }
}

/** Every `target`/`targets` member of a forged line, re-pointed at the fixture's own skill root. */
function retarget(lines: readonly Record<string, unknown>[], skillRoot: string): Record<string, unknown>[] {
  const paths: Record<string, string> = {
    '/placeholder': TARGET(skillRoot),
    [SIDECAR_TARGET]: join(skillRoot, SKILL, 'SKILL.contract.json'),
  }
  return lines.map(line => {
    if ('targets' in line) {
      return { ...line, targets: (line.targets as string[]).map(target => paths[target] ?? target) }
    }
    // A `prepared` line lists the sandbox paths the prepare wrote (strings); a
    // `commit_intent` line lists one file object per production file.
    const files = line.files as unknown
    if (!Array.isArray(files) || files.some(file => typeof file !== 'object' || file === null)) return line
    return {
      ...line,
      files: (files as Record<string, unknown>[]).map(file => ({ ...file, target: paths[String(file.target)] ?? file.target })),
    }
  })
}

const workspaces: string[] = []

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

interface Fixture {
  readonly svc: EvolutionService
  readonly ctx: never
  readonly approval: { request: ReturnType<typeof vi.fn> }
  readonly root: string
  readonly skillRoot: string
}

/**
 * A real ledger of `lines` over a fresh temp workspace, the sandbox files a
 * prepare materialized (the candidate and its champion snapshot), production
 * holding `production` bytes, and a context whose `evolution` is the service.
 * `probe` opens a crash window on the service — the real process-exit seam.
 */
async function fixture(options: {
  lines: readonly Record<string, unknown>[]
  production?: string
  probe?: Config['commitProbe']
}): Promise<Fixture> {
  const workspace = await mkdtemp(join(tmpdir(), 'evolution-commit-tools-'))
  workspaces.push(workspace)
  const root = join(workspace, 'evolution')
  const skillRoot = join(workspace, 'skills')
  await mkdir(root, { recursive: true })
  await mkdir(join(skillRoot, SKILL), { recursive: true })
  await writeFile(join(skillRoot, SKILL, 'SKILL.md'), options.production ?? BASELINE)
  await mkdir(join(root, 'sandbox', PROPOSAL_ID, 'skills', SKILL), { recursive: true })
  await writeFile(join(root, 'sandbox', PROPOSAL_ID, 'skills', SKILL, 'SKILL.md'), CANDIDATE)
  await mkdir(join(root, 'sandbox', PROPOSAL_ID, 'champion', 'skills', SKILL), { recursive: true })
  await writeFile(join(root, 'sandbox', PROPOSAL_ID, 'champion', 'skills', SKILL, 'SKILL.md'), BASELINE)
  await writeFile(
    join(root, 'proposals.jsonl'),
    `${retarget(options.lines, skillRoot).map(line => JSON.stringify(line)).join('\n')}\n`,
  )
  const approval = { request: vi.fn(async () => 'allowed-once') }
  // The service is built on the context object it will be read from, exactly as
  // a plugin's own service is: `reflect.provide` is what its constructor calls.
  const holder: Record<string, unknown> = { reflect: { provide: () => {} }, effect: () => {}, approval }
  holder.evolution = new EvolutionService(holder as never, {
    root,
    skillRoot,
    ...(options.probe === undefined ? {} : { commitProbe: options.probe }),
  })
  return { svc: holder.evolution as EvolutionService, ctx: holder as never, approval, root, skillRoot }
}

/** The retry's own process: a service over the same context, ledger and roots, with no crash window. */
function reopenedAs(service: EvolutionService, roots: { root: string; skillRoot: string }): {
  ctx: Fixture['ctx']
  service: EvolutionService
  approval: { request: ReturnType<typeof vi.fn> }
} {
  const approval = { request: vi.fn(async () => 'allowed-once') }
  const holder: Record<string, unknown> = { reflect: { provide: () => {} }, effect: () => {}, approval }
  const reopened = new EvolutionService(
    (service as unknown as { ctx: never }).ctx,
    { root: roots.root, skillRoot: roots.skillRoot },
  )
  holder.evolution = reopened
  return { ctx: holder as never, service: reopened, approval }
}

/** Every ledger line's `kind`, oldest first — the file itself, never the service's memory. */
async function ledgerKinds(root: string): Promise<string[]> {
  return (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

async function lastLine(root: string): Promise<Record<string, unknown>> {
  return JSON.parse((await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n').at(-1)!)
}

function exec(sessionId = 'root-1') {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

/** The apply-side fixture: production holds the baseline, and one apply intent is open. */
function openApplyIntent(execution = false): Record<string, unknown>[] {
  return [...decidedLines(execution), intentLine('apply', 'approval:call-7', execution)]
}

describe('evolution_apply against an open commit intent', () => {
  it('settles the recorded apply without asking the human again, and reports the redo', async () => {
    const h = await fixture({ lines: openApplyIntent() })
    const result = (await defineEvolutionApplyTool(h.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string

    expect(result).toContain(`proposal ${PROPOSAL_ID} [applied] L2 skill ${SKILL} — PROMOTE in effect`)
    expect(result).toContain(`recovered commit intent ${PROPOSAL_ID}/apply (redone)`)
    expect(result).toContain('production still held the state before this commit, so the same write was carried out')
    expect(result).toContain('no second approval was asked — the intent already binds approval:call-7')
    expect(result).toContain(`  - ${TARGET(h.skillRoot)}`)
    expect(h.approval.request).not.toHaveBeenCalled()

    // Production carries the candidate, and the completion closed the intent — it
    // is the intent's own grant and target that are recorded, not this call's.
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(CANDIDATE)
    expect(await ledgerKinds(h.root)).toEqual([...decidedLines().map(line => line.kind as string), 'commit_intent', 'applied'])
    expect(await lastLine(h.root)).toMatchObject({
      kind: 'applied', intentId: `${PROPOSAL_ID}/apply`, approvalRef: 'approval:call-7', targets: [TARGET(h.skillRoot)],
    })
    const settled = await h.svc.get(PROPOSAL_ID)
    expect(settled.status).toBe('applied')
    expect(settled.openIntent).toBeUndefined()

    // Settling is idempotent at the tool level too: the second call finds no open
    // intent, so it walks the fresh path and refuses on the recorded decision.
    const again = (await defineEvolutionApplyTool(h.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string
    expect(again).toContain('evolution_apply rejected:')
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(CANDIDATE)
  })

  it('records only the completion when the interrupted write had already landed', async () => {
    const h = await fixture({ lines: openApplyIntent(), production: CANDIDATE })
    const result = (await defineEvolutionApplyTool(h.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string

    expect(result).toContain(`recovered commit intent ${PROPOSAL_ID}/apply (written)`)
    expect(result).toContain('production already held the content this commit installed')
    expect(h.approval.request).not.toHaveBeenCalled()
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(CANDIDATE)
    expect(await lastLine(h.root)).toMatchObject({ kind: 'applied', intentId: `${PROPOSAL_ID}/apply` })
    expect((await h.svc.get(PROPOSAL_ID)).status).toBe('applied')
  })

  it('relays the named refusal when a third party changed the target, leaving the intent open', async () => {
    const h = await fixture({ lines: openApplyIntent(), production: THIRD_PARTY })
    const result = (await defineEvolutionApplyTool(h.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string

    expect(result).toContain('evolution_apply rejected: evolution:')
    expect(result).toContain(TARGET(h.skillRoot))
    expect(result).toContain(sha256Of(THIRD_PARTY))
    expect(result).toContain('a third party changed it')
    expect(h.approval.request).not.toHaveBeenCalled()
    // Nothing was written, nothing was recorded: the intent is still open and
    // production is exactly what the third party left there.
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(THIRD_PARTY)
    expect((await h.svc.get(PROPOSAL_ID)).openIntent?.intentId).toBe(`${PROPOSAL_ID}/apply`)
    expect(await ledgerKinds(h.root)).toEqual([...decidedLines().map(line => line.kind as string), 'commit_intent'])
  })
})

describe('evolution_rollback against an open commit intent', () => {
  it('settles the intent a real interrupted rollback left open, and reports the redo', async () => {
    // The interrupted commit: the rollback's own commit writes its intent, then the
    // probe throws in-process at that window — production still holds the applied
    // version, and the throw has no effect on any other commit (a process exit,
    // which this is not, is proven by the nested-child integration cases).
    const crashed = await fixture({
      lines: [...decidedLines(), intentLine('apply', 'approval:decide'), completionLine('apply', 'approval:decide')],
      production: CANDIDATE,
      probe: seen => {
        if (seen === 'intent-recorded') throw new Error('in-process probe throw after intent-recorded — a throw, not a process exit')
      },
    })
    await expect(crashed.svc.rollback(PROPOSAL_ID, 'root-1', 'approval:call-3')).rejects.toThrow(/in-process probe throw after/)
    expect((await crashed.svc.get(PROPOSAL_ID)).openIntent?.intentId).toBe(`${PROPOSAL_ID}/rollback`)
    expect(await readFile(TARGET(crashed.skillRoot), 'utf8')).toBe(CANDIDATE)

    // The retry, in a process with no crash window: the tool settles the intent.
    const reopened = reopenedAs(crashed.svc, crashed)
    const result = (await defineEvolutionRollbackTool(reopened.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string
    expect(result).toContain(`proposal ${PROPOSAL_ID} [rolledback] L2 skill ${SKILL} — champion restored`)
    expect(result).toContain(`recovered commit intent ${PROPOSAL_ID}/rollback (redone)`)
    expect(result).toContain('no second approval was asked — the intent already binds approval:call-3')
    expect(reopened.approval.request).not.toHaveBeenCalled()
    expect(await readFile(TARGET(crashed.skillRoot), 'utf8')).toBe(BASELINE)
    expect(await lastLine(crashed.root)).toMatchObject({ kind: 'rolledback', intentId: `${PROPOSAL_ID}/rollback` })
    const settled = await reopened.service.get(PROPOSAL_ID)
    expect(settled.status).toBe('rolledback')
    expect(settled.openIntent).toBeUndefined()
  })

  it('records only the completion when the interrupted rollback had already written', async () => {
    const crashed = await fixture({
      lines: [...decidedLines(), intentLine('apply', 'approval:decide'), completionLine('apply', 'approval:decide')],
      production: CANDIDATE,
      probe: seen => {
        if (seen === 'write-renamed') throw new Error('in-process probe throw after write-renamed — a throw, not a process exit')
      },
    })
    await expect(crashed.svc.rollback(PROPOSAL_ID, 'root-1', 'approval:call-3')).rejects.toThrow(/in-process probe throw after/)
    // The rename landed: production already holds the champion snapshot, and only
    // the completion is missing.
    expect(await readFile(TARGET(crashed.skillRoot), 'utf8')).toBe(BASELINE)

    const ctx = reopenedAs(crashed.svc, crashed)
    const result = (await defineEvolutionRollbackTool(ctx.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string
    expect(result).toContain(`recovered commit intent ${PROPOSAL_ID}/rollback (written)`)
    expect(result).toContain('production already held the content this commit installed')
    expect(await readFile(TARGET(crashed.skillRoot), 'utf8')).toBe(BASELINE)
    expect(await lastLine(crashed.root)).toMatchObject({ kind: 'rolledback', intentId: `${PROPOSAL_ID}/rollback` })
  })

  it('relays the named refusal when the applied content is no longer what production holds', async () => {
    const crashed = await fixture({
      lines: [...decidedLines(), intentLine('apply', 'approval:decide'), completionLine('apply', 'approval:decide')],
      production: CANDIDATE,
      probe: seen => {
        if (seen === 'intent-recorded') throw new Error('in-process probe throw after intent-recorded — a throw, not a process exit')
      },
    })
    await expect(crashed.svc.rollback(PROPOSAL_ID, 'root-1', 'approval:call-3')).rejects.toThrow(/in-process probe throw after/)

    // A later writer replaces production before the retry: the intent's own
    // baseline no longer stands there, and the recovery must not overwrite it.
    await writeFile(TARGET(crashed.skillRoot), THIRD_PARTY)
    const ctx = reopenedAs(crashed.svc, crashed)
    const result = (await defineEvolutionRollbackTool(ctx.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string
    expect(result).toContain('evolution_rollback rejected: evolution:')
    expect(result).toContain(sha256Of(THIRD_PARTY))
    expect(ctx.approval.request).not.toHaveBeenCalled()
    expect(await readFile(TARGET(crashed.skillRoot), 'utf8')).toBe(THIRD_PARTY)
    expect((await ctx.service.get(PROPOSAL_ID)).openIntent?.intentId).toBe(`${PROPOSAL_ID}/rollback`)
  })
})

describe('the tools without an open commit intent', () => {
  it('keeps the human gate on the fresh path: the rollback asks, and a rejection writes nothing', async () => {
    const h = await fixture({
      lines: [...decidedLines(), intentLine('apply', 'approval:decide'), completionLine('apply', 'approval:decide')],
      production: CANDIDATE,
    })
    expect((await h.svc.get(PROPOSAL_ID)).openIntent).toBeUndefined()

    h.approval.request.mockResolvedValueOnce('rejected')
    const before = await ledgerKinds(h.root)
    const rejected = (await defineEvolutionRollbackTool(h.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string
    expect(rejected).toContain('evolution_rollback: nothing written — the human rejected it')
    expect(h.approval.request).toHaveBeenCalledOnce()
    expect((h.approval.request.mock.calls[0]![0] as { toolName: string }).toolName).toBe('evolution_rollback')
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(CANDIDATE)
    expect(await ledgerKinds(h.root)).toEqual(before)

    // The same call with a grant: the fresh commit records *this* call's
    // approval, which is what tells the two paths apart in the ledger.
    const rolledback = (await defineEvolutionRollbackTool(h.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string
    expect(rolledback).toContain('human approval: approval:call-1')
    expect(rolledback).not.toContain('recovered commit intent')
    expect(h.approval.request).toHaveBeenCalledTimes(2)
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(BASELINE)
    expect(await lastLine(h.root)).toMatchObject({ kind: 'rolledback', approvalRef: 'approval:call-1' })
    expect(await ledgerKinds(h.root)).toEqual([...before, 'commit_intent', 'rolledback'])
  })

  it('does not hijack the fresh apply path: without an open intent the evidence gate decides, and no human is asked', async () => {
    // This fixture has no experiment evidence, so the fresh path refuses before
    // any approval — the point here is that it *is* the fresh path (a promotion
    // refusal, no recovery line) rather than the intent branch the other cases
    // exercise. The passing walk with its two human approvals is
    // `evolution/tests/unit/evolution.spec.ts`'s (K2 keeps it unchanged).
    const h = await fixture({ lines: decidedLines() })
    const result = (await defineEvolutionApplyTool(h.ctx).execute({ proposalId: PROPOSAL_ID }, exec())) as string

    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('experiment')
    expect(result).not.toContain('recovered commit intent')
    expect(h.approval.request).not.toHaveBeenCalled()
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(BASELINE)
    expect(await ledgerKinds(h.root)).toEqual(decidedLines().map(line => line.kind as string))
  })
})

describe('evolution_list', () => {
  function capabilityLines(withSkill: boolean): Record<string, unknown>[] {
    const candidate = skillText('# the candidate version\n', 'research-new')
    const row = { skills: [withSkill ? 'research-new' : SKILL] }
    const capability = capabilityRowIdentity({ name: 'research', entry: row })
    const common = { formatVersion: 4, proposalId: 'c1', actor: 'root-1' }
    return [
      {
        ...common, kind: 'proposed', targetType: 'capability', targetId: 'research', baseVersion: 'v1', level: 'L2',
        rationale: 'research has no usable provider', sourceRefs: ['diagnosis:d1'], at: AT(0),
      },
      {
        ...common, kind: 'candidate', versionSet: { capabilityTable: 'v2' },
        mutation: { rows: { research: row }, ...(withSkill ? { skill: {
          name: 'research-new', content: candidate,
          sidecar: {
            contractVersion: 1, type: 'execution', capabilities: ['research'], precondition: 'input exists',
            inputs: [], outputs: [], requiredTools: [], verifier: { ref: 'command' },
            content: { skillMdSha256: sha256Of(candidate), resources: [] },
          },
        } } : {}) },
        at: AT(1),
      },
      {
        ...common, kind: 'prepared', sandbox: 'sandbox/c1', mechanical: true, champion: 'absent',
        capabilityRow: capability, capabilityBaseline: null,
        ...(withSkill ? {
          skillContent: {
            name: 'research-new', sha256: sha256Of(candidate),
            contract: { sha256: SIDECAR_SHA256, contractDigest: SIDECAR_CONTRACT_DIGEST },
          },
          skillBaseline: null,
        } : {}),
        files: withSkill
          ? ['capability/research.json', 'skills/research-new/SKILL.md', 'skills/research-new/SKILL.contract.json']
          : ['capability/research.json'],
        at: AT(2),
      },
    ]
  }

  it('renders a prepared capability row without a new skill', async () => {
    const h = await fixture({ lines: capabilityLines(false) })
    const listed = (await defineEvolutionListTool(h.ctx).execute({ targetType: 'capability' }, exec())) as string

    expect(listed).toContain('c1 [prepared] L2 capability research (base v1)')
    expect(listed).toContain('candidate row: research sha256:3520b89bb04d')
    expect(listed).toContain('production row baseline: absent')
    expect(listed).toContain('no new skill object')
  })

  it('renders a prepared capability row with its new execution skill and absent production baselines', async () => {
    const h = await fixture({ lines: capabilityLines(true) })
    const listed = (await defineEvolutionListTool(h.ctx).execute({ targetType: 'capability' }, exec())) as string

    expect(listed).toContain('c1 [prepared] L2 capability research (base v1)')
    expect(listed).toContain('candidate row: research sha256:e4cef40c66dc')
    expect(listed).toContain('production row baseline: absent')
    expect(listed).toContain(`new execution skill: research-new sha256:${sha256Of(skillText('# the candidate version\n', 'research-new')).slice(0, 12)}`)
    expect(listed).toContain('production skill baseline: absent')
  })

  it('shows the open intent and stays a pure read', async () => {
    const h = await fixture({ lines: openApplyIntent() })
    const before = await readFile(join(h.root, 'proposals.jsonl'), 'utf8')

    const listed = (await defineEvolutionListTool(h.ctx).execute({}, exec())) as string
    expect(listed).toContain(`${PROPOSAL_ID} [decided PROMOTE] L2 skill ${SKILL} (base v1)`)
    expect(listed).toContain(
      `  open commit intent: ${PROPOSAL_ID}/apply (apply) recorded ${AT(5)} — production targets [${TARGET(h.skillRoot)}]`,
    )
    expect(listed).toContain('a production write is underway and its completion has not been recorded')
    expect(listed).toContain('the skill directory stays closed to new admission')

    // A query is a query: the ledger bytes, the sandbox, production and the
    // intent are all exactly as they were.
    expect(await readFile(join(h.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(TARGET(h.skillRoot), 'utf8')).toBe(BASELINE)
    expect((await h.svc.get(PROPOSAL_ID)).openIntent?.intentId).toBe(`${PROPOSAL_ID}/apply`)
  })

  it('renders every production file of an execution object\'s open intent', async () => {
    // A K3 object carries two files and the intent that commits it names both: a
    // listing that showed one path would hide half of a production write, and the
    // prepared block has to say which object the sandbox holds.
    const h = await fixture({ lines: openApplyIntent(true) })
    const sidecar = join(h.skillRoot, SKILL, 'SKILL.contract.json')

    const listed = (await defineEvolutionListTool(h.ctx).execute({}, exec())) as string
    expect(listed).toContain(`  open commit intent: ${PROPOSAL_ID}/apply (apply) recorded ${AT(5)} — production targets [${TARGET(h.skillRoot)}, ${sidecar}]`)
    expect(listed).toContain('execution provider (SKILL.md + SKILL.contract.json)')
    expect(listed).toContain('(4 files, execution provider')
    expect((await h.svc.get(PROPOSAL_ID)).openIntent?.files.map(file => file.target)).toEqual([TARGET(h.skillRoot), sidecar])
  })

  it('says nothing about an intent once the commit is complete', async () => {
    const h = await fixture({
      lines: [...decidedLines(), intentLine('apply', 'approval:decide'), completionLine('apply', 'approval:decide')],
      production: CANDIDATE,
    })
    const listed = (await defineEvolutionListTool(h.ctx).execute({}, exec())) as string
    expect(listed).not.toContain('open commit intent')
    expect(listed).toContain(`applied: [${TARGET(h.skillRoot)}] (approval approval:decide)`)
  })
})
