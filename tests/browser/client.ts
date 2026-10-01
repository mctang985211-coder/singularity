import { Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import shell from '../../canvas-view/src/frontend/client.js?raw'

const ctx = new Context()
// canvas-view's bundle reads the shell's services; this fixture boots it with fakes instead of a shell.
const shellServices = ctx as unknown as { provide(name: string, value: unknown): void }
const slots: { name: string; id?: string; key?: string }[] = []
const locales: string[] = []
shellServices.provide('locale', {
  bind: () => (key: string) => key,
  register: (namespace: string) => {
    locales.push(namespace)
    return () => {}
  },
})
shellServices.provide('slots', {
  inject: (_name: string, callback: () => () => void) => callback(),
  register: (options: { name: string; id?: string; key?: string }) => {
    slots.push(options)
    return () => {}
  },
})
// Session Controller face: retain owns a reference, binding only borrows a retained one, and
// pending input lives in the durable inbox projection instead of the removed snapshot queue.
const inbox = {
  getSnapshot: () => ({ 'next-turn': [], 'next-step': [] }),
  subscribe: () => () => {},
}
const session = {
  getSnapshot: () => ({ openState: 'open', openError: null, pendingSubmissions: [] }),
  subscribe: () => () => {},
  projections: {
    faceOf: (key: string) => {
      if (key !== 'inbox') throw new Error(`fixture: unsupported projection "${key}"`)
      return inbox
    },
  },
  beginSubmission: () => ({ requestId: 'fixture-request', abandon: () => {} }),
  prompt: async () => ({ ok: true, value: { accepted: true } }),
}
const eventSource = { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} }
const retained = new Map<string, { sessionId: string; session: typeof session; eventSource: typeof eventSource; ctx: Context }>()
const retain = (sessionId: string) => {
  const binding = { sessionId, session, eventSource, ctx }
  retained.set(sessionId, binding)
  return {
    sessionId,
    binding,
    ready: Promise.resolve(binding),
    release: () => { retained.delete(sessionId) },
  }
}
const retainInfo = {
  getSnapshot: () => ({ referenceCount: 0, retainedBy: {} }),
  subscribe: () => () => {},
}
shellServices.provide('sessions', {
  list: retainInfo,
  searchResultLimit: 20,
  refresh: async () => {},
  refreshProjections: async () => {},
  retain,
  using: (target: string, _options: unknown, operation: (reference: ReturnType<typeof retain>) => unknown) => {
    const reference = retain(target)
    return Promise.resolve(operation(reference)).finally(() => { reference.release() })
  },
  // Borrow-only: a binding exists while the bridge holds a retained reference.
  binding: (sessionId: string) => retained.get(sessionId),
  retainInfo: () => retainInfo,
})
// Shell navigation stays faked for parity even though this bundle retains directly instead.
shellServices.provide('uiWorkspace', { openSession: () => {} })

let plugin: { apply: (ctx: Context) => void }
Object.assign(window, {
  __ModuleLoader__: {
    load: ({ factory }: { factory: (require: (id: string) => unknown) => typeof plugin }) => {
      // The bundle requires react through the module table; every other request is unsupported here.
      plugin = factory(id => {
        if (id === 'react') return React
        throw new Error(`fixture: the client bundle asked for "${id}", which this fixture does not provide`)
      })
    },
  },
  fixture: { ctx, slots, locales },
})
Function(shell)()
plugin!.apply(ctx)
