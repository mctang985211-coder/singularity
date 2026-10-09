/**
 * The environment-revision service face: one library view per graph, drafts as
 * the only mutable region, and the pointer transaction as the only switch.
 */

import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readdir, readFile } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId, sha256Hex, taskTemplateDigest } from '@dangosys/dsh-singularity-task'
import type { TaskRun, TaskTemplate } from '@dangosys/dsh-singularity-task'
import { parseSkillFile } from '@dangosys/dsh-singularity-agent-runtime'
import type { TaskRuntime } from './runtime.ts'
import type { CapabilityConfig } from '../capability.ts'
import { parseTaskTemplate } from '../task-template.ts'
import { providerRefusals } from '../provider-precheck.ts'
import {
  createEnvironmentDraft,
  discardEnvironmentDraft,
  ensureInitialRevision,
  freezeEnvironmentDraft,
  hasLegacyLayout,
  latestDraftFor,
  libraryRoots,
  listRevisions,
  openPointerIntent,
  publishEnvironmentRevision,
  readEnvironmentDraft,
  readPointer,
  readRevision,
  reconcileEnvironmentPointer,
  revisionCapabilityRows,
  revisionRoot,
  rollbackEnvironmentRevision,
  stageEnvironmentEdit,
} from '../environment/index.ts'
import type {
  EnvironmentCommitHost,
  EnvironmentDraft,
  EnvironmentEdit,
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentRevision,
  EnvironmentRevisionRef,
  EnvironmentSkillEntry,
  EnvironmentTaskTemplateEntry,
  LibraryRoots,
  PublishOutcome,
  PublishRequest,
} from '../environment/index.ts'
import type { CapabilityRowEdit } from '../environment/revision.ts'

/** The revision id a library's first revision always carries. */
export const INITIAL_REVISION_ID = 'r0001'

/** Which protocol one library root is served under; `uninitialized` means neither layout exists yet. */
type EnvironmentProtocol = 'environment-revision' | 'legacy' | 'uninitialized'

/** One library resolved to the immutable roots a reader works in; no reader ever binds a mutable directory. */
export interface EnvironmentLibrary {
  readonly id: string
  readonly root: string
  readonly protocol: EnvironmentProtocol
  readonly taskTemplatesRoot: string
  readonly skillRoot: string
  readonly revision?: EnvironmentRevision
}

/** What one reader sees of a library: the effective revision's identity plus its entries, never a mutable index. */
export interface EnvironmentView {
  readonly libraryId: string
  readonly revisionId: string
  readonly generation: number
  readonly manifestDigest: string
  readonly trialCandidateRef?: string
  readonly readOnly: boolean
  readonly protocol: EnvironmentProtocol
  readonly skills: readonly EnvironmentSkillEntry[]
  readonly taskTemplates: readonly EnvironmentTaskTemplateEntry[]
}

export type {
  EnvironmentCommitHost,
  EnvironmentDraft,
  EnvironmentEdit,
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentRevision,
  EnvironmentRevisionRef,
  EnvironmentSkillEntry,
  EnvironmentTaskTemplateEntry,
  LibraryRoots,
  PublishOutcome,
  PublishRequest,
} from '../environment/index.ts'
import * as svcEnv from './env.ts'

/** What one staged library edit answers: a draft holds the change, and nothing is in effect until a publish switches the pointer. */export interface LibraryEditResult {
  readonly libraryId: string
  readonly draftId: string
  /** The candidate revision this draft freezes into. */
  readonly revisionId: string
  readonly applied: 'draft'
  readonly message: string
}

/** One library write a caller asks for: a task template, or the complete new bytes of a Skill. */
export type LibraryWrite =
  | { kind: 'task'; template: TaskTemplate }
  | { kind: 'skill'; name: string; skillMd: string; expectedVersion?: number }

/** One retention review a caller asks for: the status is a field of the revision the draft freezes into. */
export interface LibraryReview {
  kind: 'task' | 'skill'
  name: string
  version: number
  status: 'retained' | 'retired'
  reason: string
}

/** The DSH home holding `singularity/environments/<libraryId>`; the same segment `runBindingRoot` sits under. */
function environmentHome(self: TaskRuntime): string {
  const configured = self.config.environmentRevisionRoot
  if (configured !== undefined) return configured
  const bindings = self.config.runBindingRoot
  // A deployment's own `runBindingRoot` sits under `<home>/singularity`; a
  // caller-assembled root anywhere else says nothing about where libraries live.
  if (bindings !== undefined && basename(dirname(resolve(bindings))) === 'singularity') return dirname(dirname(resolve(bindings)))
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

function libraryRootsForRoot(self: TaskRuntime, rootSessionId: string): LibraryRoots {
  return libraryRoots(rootSessionId, environmentHome(self))
}

export async function libraryRootsForSession(self: TaskRuntime, sessionId: string): Promise<LibraryRoots> {
  const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
  return libraryRootsForRoot(self, graph.rootSessionId)
}

/**
 * Resolve one library root to the roots a reader works in: the active revision's
 * directory, the legacy mutable layout (read-only), or the directory the initial
 * revision will occupy. Reading never creates anything.
 */
export async function environmentLibraryForRoot(self: TaskRuntime, rootSessionId: string): Promise<EnvironmentLibrary> {
  const library = libraryRootsForRoot(self, rootSessionId)
  const pointer = await readPointer(library)
  if (pointer !== null) {
    const revision = await readRevision(library, pointer.revisionId)
    if (revision === undefined) {
      throw new Error(
        `task-runtime: the pointer of library "${library.id}" names revision "${pointer.revisionId}", which does not exist on disk`,
      )
    }
    return {
      id: library.id,
      root: revision.root,
      protocol: 'environment-revision',
      taskTemplatesRoot: revision.taskTemplatesRoot,
      skillRoot: revision.skillRoot,
      revision,
    }
  }
  if (await hasLegacyLayout(library)) {
    return {
      id: library.id,
      root: library.root,
      protocol: 'legacy',
      taskTemplatesRoot: join(library.root, 'task-templates'),
      skillRoot: join(library.root, 'skills'),
    }
  }
  const prospective = revisionRoot(library, INITIAL_REVISION_ID)
  return {
    id: library.id,
    root: prospective,
    protocol: 'uninitialized',
    taskTemplatesRoot: join(prospective, 'task-templates'),
    skillRoot: join(prospective, 'skills'),
  }
}

export async function environmentLibraryForSession(self: TaskRuntime, sessionId: string): Promise<EnvironmentLibrary> {
  const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
  return await environmentLibraryForRoot(self, graph.rootSessionId)
}

/** The commit host of one library: the library root the transaction runs against. */
function environmentCommitHost(self: TaskRuntime, library: LibraryRoots): EnvironmentCommitHost {
  return { library }
}

/**
 * Fix one new graph's initial revision before anything binds to it. A library
 * that already holds the legacy mutable layout keeps it: it enters the read-only
 * view instead, and no pointer is ever created for it.
 */
export async function ensureInitialEnvironment(self: TaskRuntime, rootSessionId: string, actor: string): Promise<EnvironmentLibrary> {
  const library = libraryRootsForRoot(self, rootSessionId)
  if (!(await hasLegacyLayout(library))) await ensureInitialRevision(library, { actor })
  return await environmentLibraryForRoot(self, rootSessionId)
}

/** The active revision of one library, or `undefined` when the library holds none (legacy or uninitialized). */
export async function activeRevisionOrUndefined(self: TaskRuntime, sessionId: string): Promise<EnvironmentRevision | undefined> {
  const library = await environmentLibraryForSession(self, sessionId)
  return library.revision
}

/** The active revision of one library; a library without one (legacy or uninitialized) is refused by name. */
export async function activeRevisionFor(self: TaskRuntime, sessionId: string): Promise<EnvironmentRevision> {
  return await activeRevisionForLibrary(self, await activeEnvironmentLibrary(self, sessionId))
}

async function activeRevisionForLibrary(self: TaskRuntime, library: EnvironmentLibrary): Promise<EnvironmentRevision> {
  if (library.revision === undefined) {
    throw new Error(
      `task-runtime: library "${library.id}" is ${library.protocol} and holds no active environment revision; ` +
        'a new graph fixes its initial revision when its root contract is admitted',
    )
  }
  return library.revision
}

/** One frozen revision of one library root, by id. */
export async function revisionForManifest(self: TaskRuntime, libraryId: string, revisionId: string): Promise<EnvironmentRevision> {
  const revision = await readRevision(libraryRootsForRoot(self, libraryId), revisionId)
  if (revision === undefined) {
    throw new Error(`task-runtime: library "${libraryId}" holds no revision "${revisionId}"; a bound revision is a frozen directory`)
  }
  return revision
}

/** The revision one run is bound to: its trial candidate when it trials one, else the revision it was admitted against. */
export async function revisionForRun(self: TaskRuntime, run: TaskRun): Promise<EnvironmentRevision | undefined> {
  if (run.environmentRevisionId === undefined) return undefined
  return await revisionForManifest(self, await rootSessionIdFor(self, run.sessionId), run.trialCandidateRef ?? run.environmentRevisionId)
}

/** The library a *writer* addresses: legacy roots are refused by name, an uninitialized one is fixed first. */
async function activeEnvironmentLibrary(self: TaskRuntime, sessionId: string): Promise<EnvironmentLibrary> {
  const library = await environmentLibraryForSession(self, sessionId)
  if (library.protocol === 'legacy') {
    throw new Error(
      `task-runtime: library "${library.id}" holds the legacy mutable layout (index.json / flat skills); it is read-only and takes no environment edit`,
    )
  }
  if (library.protocol === 'uninitialized') {
    await ensureInitialEnvironment(self, library.id, sessionId)
    return await environmentLibraryForSession(self, sessionId)
  }
  return library
}

/** The capability rows in force for one library: the revision's derived rows plus its declared rows, or the legacy read. */
export async function capabilityRowsForLibrary(_self: TaskRuntime, library: EnvironmentLibrary): Promise<Record<string, CapabilityConfig>> {
  if (library.revision !== undefined) return revisionCapabilityRows(library.revision.manifest)
  return await legacyCapabilityRows(library)
}

/** Task templates retired by one library, as `id@version` keys for the binding gate. */
export async function retiredTemplatesFor(self: TaskRuntime, sessionId: string): Promise<ReadonlySet<string>> {
  return retiredTemplatesOf(await environmentLibraryForSession(self, sessionId))
}

function retiredTemplatesOf(library: EnvironmentLibrary): ReadonlySet<string> {
  return new Set(
    (library.revision?.manifest.taskTemplates ?? [])
      .filter(entry => entry.status === 'retired')
      .map(entry => `${entry.templateRef.id}@${entry.templateRef.version}`),
  )
}

/** The effective view one run consumes, including the trial candidate it explicitly bound. */
export async function environmentViewForRun(self: TaskRuntime, run: TaskRun): Promise<EnvironmentView> {
  const library = await environmentLibraryForSession(self, run.sessionId)
  const revision = await revisionForRun(self, run)
  if (revision === undefined) return await legacyViewOfLibrary(library, run.trialCandidateRef)
  const pointer = await readPointer(libraryRootsForRoot(self, library.id))
  return {
    libraryId: library.id,
    revisionId: revision.manifest.revisionId,
    generation: pointer?.generation ?? 0,
    manifestDigest: revision.manifest.contentDigest,
    ...(run.trialCandidateRef === undefined ? {} : { trialCandidateRef: run.trialCandidateRef }),
    readOnly: true,
    protocol: library.protocol,
    skills: revision.manifest.skills,
    taskTemplates: revision.manifest.taskTemplates,
  }
}

/** The active revision view of one graph library, as the library tools and the Web read it — a pure read. */
export async function activeEnvironmentView(
  self: TaskRuntime,
  sessionId: string,
  options: { trialCandidateRef?: string } = {},
): Promise<EnvironmentView> {
  const library = await environmentLibraryForSession(self, sessionId)
  const trial = options.trialCandidateRef
  if (library.revision === undefined) return await legacyViewOfLibrary(library, trial)
  const revision = trial === undefined ? library.revision : await revisionForManifest(self, library.id, trial)
  const pointer = await readPointer(libraryRootsForRoot(self, library.id))
  return {
    libraryId: library.id,
    revisionId: revision.manifest.revisionId,
    generation: pointer?.generation ?? 0,
    manifestDigest: revision.manifest.contentDigest,
    ...(trial === undefined ? {} : { trialCandidateRef: trial }),
    readOnly: trial !== undefined,
    protocol: library.protocol,
    skills: revision.manifest.skills,
    taskTemplates: revision.manifest.taskTemplates,
  }
}

async function legacyViewOfLibrary(library: EnvironmentLibrary, trialCandidateRef?: string): Promise<EnvironmentView> {
  const skills = await legacySkillsOf(library)
  const taskTemplates = await legacyTemplatesOf(library)
  return {
    libraryId: library.id,
    revisionId: 'legacy',
    generation: 0,
    manifestDigest: 'legacy',
    ...(trialCandidateRef === undefined ? {} : { trialCandidateRef }),
    readOnly: true,
    protocol: library.protocol,
    skills,
    taskTemplates,
  }
}

/** The legacy flat skills, read as the old index would have listed them — and never written back. */
async function legacySkillsOf(library: EnvironmentLibrary): Promise<readonly EnvironmentSkillEntry[]> {
  const directory = join(library.root, 'skills')
  let names: string[]
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const retired = await legacyRetiredSkills(library)
  const skills: EnvironmentSkillEntry[] = []
  for (const name of names) {
    let text: string
    try {
      text = await readFile(join(directory, name, 'SKILL.md'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const parsed = parseSkillFile(text, join(directory, name, 'SKILL.md'))
    if (parsed.name !== name) throw new Error(`task-runtime: legacy skill ${name} declares ${parsed.name}`)
    skills.push({
      name,
      version: 1,
      digest: sha256Hex(text),
      contentDigest: sha256Hex(text),
      contractDigest: null,
      status: retired.has(name) ? 'retired' : 'temporary',
    })
  }
  return skills
}

async function legacyTemplatesOf(library: EnvironmentLibrary): Promise<readonly EnvironmentTaskTemplateEntry[]> {
  let files: string[]
  try {
    files = (await readdir(library.taskTemplatesRoot)).filter(file => file.endsWith('.json')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const retired = await legacyRetiredTemplates(library)
  const entries: EnvironmentTaskTemplateEntry[] = []
  for (const file of files) {
    const template = parseTaskTemplate(JSON.parse(await readFile(join(library.taskTemplatesRoot, file), 'utf8')))
    const ref = { id: template.id, version: template.version, digest: taskTemplateDigest(template) }
    entries.push({
      templateRef: ref,
      status: retired.has(`${ref.id}@${ref.version}`) ? 'retired' : 'temporary',
      skills: [],
    })
  }
  return entries
}

async function legacyRetiredSkills(library: EnvironmentLibrary): Promise<ReadonlySet<string>> {
  const names = new Set<string>()
  for (const item of await legacyIndex(library, 'skills')) {
    if (item.status === 'retired' && typeof item.name === 'string') names.add(item.name)
  }
  return names
}

async function legacyRetiredTemplates(library: EnvironmentLibrary): Promise<ReadonlySet<string>> {
  const keys = new Set<string>()
  for (const item of await legacyIndex(library, 'tasks')) {
    if (item.status !== 'retired') continue
    const ref = item.templateRef as { id?: unknown; version?: unknown } | undefined
    if (typeof ref?.id === 'string' && typeof ref.version === 'number') keys.add(`${ref.id}@${ref.version}`)
  }
  return keys
}

async function legacyIndex(library: EnvironmentLibrary, key: 'skills' | 'tasks'): Promise<readonly Record<string, unknown>[]> {
  try {
    const index = JSON.parse(await readFile(join(library.root, 'index.json'), 'utf8')) as Record<string, unknown>
    const entries = index[key]
    return Array.isArray(entries) ? (entries as Record<string, unknown>[]) : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** The legacy capability rows, derived by reading the flat layout — the same rule the old index applied, with no write. */
async function legacyCapabilityRows(library: EnvironmentLibrary): Promise<Record<string, CapabilityConfig>> {
  const retired = await legacyRetiredSkills(library)
  const skills = await legacySkillsOf(library)
  return {
    'execute-task': { skills: ['task-coordination'], tools: ['filesystem', 'search', 'bash', 'jobs', 'skill'] },
    ...Object.fromEntries(
      skills.filter(skill => !retired.has(skill.name)).map(skill => [`method:${skill.name}`, { skills: [skill.name], tools: ['skill'] }]),
    ),
  }
}

/** Whether one run is a comparison view: an explicit trial, or a run frozen on a revision the pointer moved past. */
export async function comparisonRunFor(self: TaskRuntime, sessionId: string): Promise<TaskRun | undefined> {
  const binding = self.sessions.get(sessionId)
  const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
  const snapshot = await self.context.task.openStore(binding?.storeId ?? rootTaskStoreId(graph.rootSessionId)).catch(error => {
    if (error instanceof Error && /does not exist/.test(error.message)) return undefined
    throw error
  })
  const run = binding === undefined
    ? snapshot?.runs.filter(item => item.sessionId === sessionId).at(-1)
    : snapshot?.runs.find(item => item.runId === binding.runId)
  if (run === undefined || run.environmentRevisionId === undefined) return undefined
  if (run.trialCandidateRef !== undefined) return run
  const library = await environmentLibraryForRoot(self, graph.rootSessionId)
  return library.revision?.manifest.revisionId === run.environmentRevisionId ? undefined : run
}

/** The graph's root session id, or the caller's own when the session belongs to no graph. */
export async function rootSessionIdFor(self: TaskRuntime, sessionId: string): Promise<string> {
  const graph = await self.context.graphs.graphForSession(SessionId(sessionId))
  return graph.rootSessionId
}

/** One caller's authority to edit a library: the graph root itself, or a delegated supervisor. */
export async function isDelegatedSupervisor(self: TaskRuntime, sessionId: string): Promise<boolean> {
  const core = self.softService<{ resolveCaller(id: string): Promise<{ kind: string; role?: string }> }>(
    'singularityContext',
  )
  const caller = await core?.resolveCaller(sessionId)
  return caller?.kind === 'coordinator' && caller.role === 'supervisor'
}

/** Open a draft on the active revision of one graph library, reusing this caller's newest one when it exists. */
export async function createDraft(
  self: TaskRuntime,
  sessionId: string,
  request: { basedOn?: string; purpose?: string; reuse?: boolean } = {},
): Promise<EnvironmentDraft> {
  const library = await activeEnvironmentLibrary(self, sessionId)
  const roots = libraryRootsForRoot(self, library.id)
  if (request.reuse !== false && request.basedOn === undefined) {
    const existing = await latestDraftFor(roots, sessionId)
    if (existing !== undefined) return existing
  }
  return await createEnvironmentDraft(roots, {
    ...(request.basedOn === undefined ? {} : { basedOn: request.basedOn }),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    actor: sessionId,
  })
}

/** Stage one edit into one draft of one graph library. */
export async function stageDraftEdit(
  self: TaskRuntime,
  sessionId: string,
  draftId: string,
  edit: EnvironmentEdit,
): Promise<EnvironmentDraft> {
  const library = await activeEnvironmentLibrary(self, sessionId)
  const roots = libraryRootsForRoot(self, library.id)
  if (edit.kind === 'capability') await assertCandidateRowUsable(self, sessionId, library, draftId, edit.edit)
  return await stageEnvironmentEdit(roots, draftId, edit)
}

/**
 * The one check a capability-row edit must pass before it lands: the row's
 * declared providers must be usable against the table the draft will freeze into,
 * read from the candidate's own skill roots. This is the same guarantee the old
 * online row replacement gave, moved to the candidate revision — the row becomes
 * effective through a publish, never through a process-local table write.
 */
async function assertCandidateRowUsable(
  self: TaskRuntime,
  sessionId: string,
  library: EnvironmentLibrary,
  draftId: string,
  edit: CapabilityRowEdit,
): Promise<void> {
  const draft = await readEnvironmentDraft(libraryRootsForRoot(self, library.id), draftId)
  if (draft === undefined) throw new Error(`environment: draft "${draftId}" is absent; a discarded or frozen draft takes no edits`)
  if (edit.entry === null) return
  const table: Record<string, CapabilityConfig> = { ...revisionCapabilityRows(draft.manifest), [edit.name]: edit.entry }
  const mcpRegistry = { ...self.config.mcpServers, ...draft.manifest.capabilities.mcpServers }
  for (const [name, template] of Object.entries(edit.mcpServers ?? {})) {
    if (template === null) delete mcpRegistry[name]
    else mcpRegistry[name] = template
  }
  const cwd = await self.envPathForSession(sessionId)
  const precheck = await svcEnv.providerPrecheck(self, 
    [edit.name],
    { ...(cwd === undefined ? {} : { cwd }), extraRoots: [join(draft.root, 'skills'), library.skillRoot] },
    table,
    mcpRegistry,
    sessionId,
  )
  const refusals = providerRefusals(precheck, [edit.name])
  if (refusals.length === 0) return
  throw new Error(
    `task-runtime: capability "${edit.name}" was not staged — the row grants providers that are not usable:\n` +
      refusals.map(line => `- ${line}`).join('\n'),
  )
}

/** Remove one draft of one graph library; the namesake of the evolution ledger's `discardDraft`. */
export async function removeEnvironmentDraft(self: TaskRuntime, sessionId: string, draftId: string): Promise<void> {
  const library = await activeEnvironmentLibrary(self, sessionId)
  await discardEnvironmentDraft(libraryRootsForRoot(self, library.id), draftId)
}

/** Freeze one draft into a candidate revision without moving the pointer: the entry an explicit trial binds. */
export async function freezeDraft(self: TaskRuntime, sessionId: string, draftId: string): Promise<EnvironmentRevision> {
  const library = await activeEnvironmentLibrary(self, sessionId)
  return await freezeEnvironmentDraft(libraryRootsForRoot(self, library.id), draftId)
}

/** Switch the effective pointer to one draft or frozen revision. */
export async function publishRevision(self: TaskRuntime, sessionId: string, request: PublishRequest): Promise<PublishOutcome> {
  const library = await activeEnvironmentLibrary(self, sessionId)
  return await publishEnvironmentRevision(environmentCommitHost(self, libraryRootsForRoot(self, library.id)), request)
}

/** Switch the effective pointer back to a frozen revision. */
export async function rollbackRevision(self: TaskRuntime, sessionId: string, request: PublishRequest): Promise<PublishOutcome> {
  const library = await activeEnvironmentLibrary(self, sessionId)
  return await rollbackEnvironmentRevision(environmentCommitHost(self, libraryRootsForRoot(self, library.id)), request)
}

/** Settle any pointer intent a killed process left open. */
export async function reconcilePointer(self: TaskRuntime, sessionId: string): Promise<EnvironmentPointerReconcile[]> {
  return await reconcileEnvironmentPointer(environmentCommitHost(self, await libraryRootsForSession(self, sessionId)))
}

/** The in-flight pointer switch of one library, or `null`; the single concurrency exclusion point. */
export async function openPointerIntentFor(self: TaskRuntime, sessionId: string): Promise<EnvironmentPointerIntent | null> {
  return await openPointerIntent(await libraryRootsForSession(self, sessionId))
}

export async function listRevisionsImpl(self: TaskRuntime, sessionId: string): Promise<EnvironmentRevisionRef[]> {
  return await listRevisions(await libraryRootsForSession(self, sessionId))
}

/**
 * Stage one library write into the caller's draft. The change is recorded against
 * the draft's prospective candidate revision; nothing is in effect until a publish
 * switches the pointer, and the answer says exactly that.
 */
export async function writeLibraryDraft(self: TaskRuntime, sessionId: string, input: LibraryWrite): Promise<LibraryEditResult> {
  const draft = await createDraft(self, sessionId, {})
  const edit: EnvironmentEdit =
    input.kind === 'task'
      ? { kind: 'task', edit: { template: input.template, actor: sessionId } }
      : {
          kind: 'skill',
          edit: {
            name: input.name,
            skillMd: input.skillMd,
            ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
            actor: sessionId,
          },
        }
  const staged = await stageDraftEdit(self, sessionId, draft.draftId, edit)
  const what = input.kind === 'task' ? `task template ${input.template.id}@${input.template.version}` : `Skill ${input.name}`
  return {
    libraryId: staged.libraryId,
    draftId: staged.draftId,
    revisionId: staged.manifest.revisionId,
    applied: 'draft',
    message:
      `${what} is staged in draft ${staged.draftId} as the prospective revision ${staged.manifest.revisionId}; ` +
      'the active revision is unchanged until it is published',
  }
}

/** Stage one retention review into the caller's draft, with the same draft semantics as a library write. */
export async function reviewLibraryDraft(self: TaskRuntime, sessionId: string, review: LibraryReview): Promise<LibraryEditResult> {
  const draft = await createDraft(self, sessionId, {})
  const staged = await stageDraftEdit(self, sessionId, draft.draftId, {
    kind: 'review',
    review: { ...review, actor: sessionId },
  })
  return {
    libraryId: staged.libraryId,
    draftId: staged.draftId,
    revisionId: staged.manifest.revisionId,
    applied: 'draft',
    message:
      `${review.kind} ${review.name}@${review.version} → ${review.status} is staged in draft ${staged.draftId} as the prospective revision ${staged.manifest.revisionId}; ` +
      'the active revision is unchanged until it is published',
  }
}
