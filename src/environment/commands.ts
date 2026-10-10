/**
 * The environment revision command: the deployment's one way to mint a revision.
 *
 * A revision is content-addressed, and the digest is the reducer's: the payload declares no digest
 * member, so a caller offers content and the log computes what that content *is*. The command adds
 * nothing to that rule — it is the surface, not a second decision — but it is what keeps the shape
 * of the fact in one place: a deployment that emitted it by hand would restate the closed member set
 * and the subject every revision is keyed by.
 *
 * `manifest` is deliberately `unknown`: what a deployment records about an environment is the
 * deployment's, and the only rule the protocol has about it is that JSON must round-trip it exactly,
 * which the reducer enforces before any digest is taken.
 *
 * @module singularity-core/environment/commands
 */

import type { ControlSessionStore } from '../control/session-store.ts'
import type { Envelope } from '../protocol/envelope.ts'
import type { ProtocolRegistry } from '../protocol/registry.ts'
import { ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION } from './protocol.ts'

/** What creating a revision needs: the store that records it, and the deployment's declared protocols. */
interface EnvironmentCommandOptions {
  readonly store: ControlSessionStore
  readonly registry: ProtocolRegistry
}

/**
 * The trusted surface, as a deployment drives it.
 *
 * Every command carries its own `commandId`: a retry is answered from the fact it already committed.
 * A *different* command repeating the same revision id with the same content is accepted by the
 * reducer and leaves the fold unchanged; repeating it with different content is `revision-conflict`.
 */
export interface EnvironmentCommands {
  /** Record one revision of one environment, keyed by the environment id as its subject. */
  createRevision(input: {
    readonly commandId: string
    readonly environmentId: string
    readonly revisionId: string
    readonly manifest: unknown
  }): Promise<Envelope>
}

export function createEnvironmentCommands(options: EnvironmentCommandOptions): EnvironmentCommands {
  return {
    createRevision: input =>
      options.store.emit({
        commandId: input.commandId,
        protocol: ENVIRONMENT_PROTOCOL,
        version: ENVIRONMENT_VERSION,
        kind: ENVIRONMENT_KINDS.revisionCreated,
        subject: input.environmentId,
        payload: { revisionId: input.revisionId, manifest: input.manifest },
      }) as Promise<Envelope>,
  }
}
