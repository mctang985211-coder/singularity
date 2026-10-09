/**
 * The public surface of the environment-revision core: immutable revisions
 * (`revision.ts`), their on-disk layout and verification (`store.ts`), the one
 * pointer transaction (`pointer.ts`), and drafts (`draft.ts`).
 * @module dsh-singularity-task-runtime/environment
 */

export { emptyRevisionManifest, revisionCapabilityRows } from './revision.ts'
export type {
  EnvironmentEdit,
  EnvironmentRevision,
  EnvironmentRevisionManifest,
  EnvironmentRevisionRef,
  EnvironmentSkillEntry,
  EnvironmentTaskTemplateEntry,
} from './revision.ts'
export {
  hasLegacyLayout,
  libraryRoots,
  listRevisions,
  readRevision,
  revisionRoot,
  verifyRevisionDirectory,
} from './store.ts'
export type { LibraryRoots } from './store.ts'
export {
  ensureInitialRevision,
  listPointerCompletions,
  openPointerIntent,
  publishEnvironmentRevision,
  readPointer,
  reconcileEnvironmentPointer,
  rollbackEnvironmentRevision,
} from './pointer.ts'
export type {
  EnvironmentCommitHost,
  EnvironmentPointer,
  EnvironmentPointerCompletion,
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentPublishSource,
  PublishOutcome,
  PublishRequest,
} from './pointer.ts'
export {
  createEnvironmentDraft,
  discardEnvironmentDraft,
  freezeEnvironmentDraft,
  latestDraftFor,
  readEnvironmentDraft,
  stageEnvironmentEdit,
} from './draft.ts'
export type { EnvironmentDraft } from './draft.ts'
