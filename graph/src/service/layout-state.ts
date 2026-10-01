import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasNode, LayoutEvent, LayoutSnapshot } from '../layout-types.ts'

function copy<T>(value: T): T {
  return structuredClone(value)
}

export class LayoutState {
  private value: LayoutSnapshot

  constructor(id: string, snapshot?: LayoutSnapshot) {
    this.value = snapshot === undefined ? { version: 1, id, nodes: {} } : copy(snapshot)
  }

  clone(): LayoutState {
    return new LayoutState(this.value.id, this.value)
  }

  snapshot(): LayoutSnapshot {
    return copy(this.value)
  }

  get(sessionId: SessionId): CanvasNode {
    const node = this.value.nodes[sessionId]
    if (node === undefined) throw new Error(`layout: unknown session "${sessionId}"`)
    return copy(node)
  }

  apply(event: LayoutEvent): void {
    switch (event.kind) {
      case 'node/set': {
        this.value = {
          ...this.value,
          nodes: { ...this.value.nodes, [event.sessionId]: copy(event.node) },
        }
        return
      }
      case 'node/remove': {
        if (this.value.nodes[event.sessionId] === undefined)
          throw new Error(`layout: unknown session "${event.sessionId}"`)
        const nodes = { ...this.value.nodes }
        delete nodes[event.sessionId]
        this.value = { ...this.value, nodes }
        return
      }
      default:
        throw new Error(`layout: unknown event kind "${(event as { kind?: unknown }).kind}"`)
    }
  }
}
