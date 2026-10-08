/**
 * The public surface of the environment-revision core: immutable revisions
 * (`revision.ts`), their on-disk layout and verification (`store.ts`), the one
 * pointer transaction (`pointer.ts`), and drafts (`draft.ts`).
 * @module dsh-singularity-task-runtime/environment
 */

export {
  ENVIRONMENT_DRAFT_ID,
  ENVIRONMENT_REVISION_ID,
  applyCapabilityRowEdit,
  applyReviewEdit,
  applySkillEdit,
  applyTemplateEdit,
  assertDraftEditAllowed,
  candidateRevisionId,
  emptyRevisionManifest,
  manifestDigest,
  parseRevisionManifest,
  revisionCapabilityRows,
  revisionRefOf,
  revisionSkillOf,
  revisionTemplateOf,
} from './revision.ts'
export type {
  CapabilityRowEdit,
  EnvironmentCapabilityEntry,
  EnvironmentEdit,
  EnvironmentReview,
  EnvironmentRevision,
  EnvironmentRevisionManifest,
  EnvironmentRevisionRef,
  EnvironmentSkillEntry,
  EnvironmentTaskTemplateEntry,
  SkillEdit,
  TemplateEdit,
} from './revision.ts'
export {
  appendLineDurable,
  copyRevisionDirectory,
  draftsRoot,
  ensureEnvironmentLayout,
  ensureProtocolMarker,
  environmentProtocolMarker,
  freezeDraftDirectory,
  hasLegacyLayout,
  libraryRoots,
  listRevisions,
  readRevision,
  readRevisionManifest,
  readRevisionSkillFile,
  revisionRoot,
  revisionsRoot,
  serialEnvironment,
  syncDirectory,
  verifyRevisionDirectory,
  writeFileAtomic,
  writeRevisionManifest,
} from './store.ts'
export type { LibraryRoots, RevisionDefects } from './store.ts'
export {
  ensureInitialRevision,
  listPointerCompletions,
  openPointerIntent,
  publishEnvironmentRevision,
  readActiveRevision,
  readPointer,
  reconcileEnvironmentPointer,
  rollbackEnvironmentRevision,
} from './pointer.ts'
export type {
  EnvironmentCommitHost,
  EnvironmentCommitStage,
  EnvironmentPointer,
  EnvironmentPointerCompletion,
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentPublishSource,
  InitialSeed,
  PublishOutcome,
  PublishRequest,
} from './pointer.ts'
export {
  createEnvironmentDraft,
  discardEnvironmentDraft,
  freezeEnvironmentDraft,
  latestDraftFor,
  listEnvironmentDrafts,
  readEnvironmentDraft,
  stageEnvironmentEdit,
} from './draft.ts'
export type { EnvironmentDraft, EnvironmentDraftRef } from './draft.ts'
