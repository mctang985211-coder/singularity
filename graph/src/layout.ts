/** Canvas-geometry service for the per-graph plane; the `./layout` plugin entry. @module dsh-singularity-graph/layout */

import type { LayoutEvent, LayoutSnapshot } from './layout-types.ts'
import { LayoutService } from './service/layout.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One canvas-geometry mutation in a per-graph layout store; the LayoutEvent union that LayoutState replays on load. */
    'layout/event': LayoutEvent
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    layout: LayoutService
  }
  interface Events {
    'layout/change'(snapshot: LayoutSnapshot): void
  }
}

export * from './layout-types.ts'
export { LayoutState } from './service/layout-state.ts'
export { LayoutService } from './service/layout.ts'

export default LayoutService
