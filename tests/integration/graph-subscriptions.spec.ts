import { expect, it, vi } from 'vitest'
import { GraphBroadcast } from '../../graph-web/src/web/libs/broadcast.ts'
import type { GraphRecord } from '../../graphs/src/types.ts'
import type { ServerResponse } from 'node:http'

it('keeps two graph subscriptions isolated and sends fresh full views on reconnect', async () => {
  // A client is its graph id: the frame is read at push time from the registry and
  // the read model, so nothing keeps a graph record of its own any more.
  const view = vi.fn(async (id: string) => ({
    meta: { id },
    access: { mode: 'current' },
    graph: { id: `g-${id}` },
    layout: { id: `l-${id}` },
  }))
  const meta = (id: string) => ({ id, graphStoreId: `g-${id}`, layoutStoreId: `l-${id}` }) as GraphRecord
  const records = new Map([
    ['a', meta('a')],
    ['b', meta('b')],
  ])
  const broadcast = new GraphBroadcast({
    graphs: {
      view,
      get: async (id: string) => {
        const record = records.get(id)
        if (record === undefined) throw new Error(`graphs: unknown graph "${id}"`)
        return record
      },
    },
    get: () => undefined,
  } as never)
  const a = { write: vi.fn(), destroy: vi.fn(), end: vi.fn(), destroyed: false } as unknown as ServerResponse
  const b = { write: vi.fn(), destroy: vi.fn(), end: vi.fn(), destroyed: false } as unknown as ServerResponse
  broadcast.subscribe(a, 'a')
  broadcast.subscribe(b, 'b')
  await Promise.all([...broadcast.clients.values()].map(client => client.writes))
  vi.mocked(a.write).mockClear()
  vi.mocked(b.write).mockClear()
  broadcast.publish({ id: 'g-a' } as never)
  broadcast.publishLayout({ id: 'l-a' } as never)
  // The frame is scheduled after the registry says whose graph store moved, so
  // the client's write queue is one turn behind the publish call.
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.all([...broadcast.clients.values()].map(client => client.writes))
  expect(a.write).toHaveBeenCalledTimes(2)
  expect(b.write).not.toHaveBeenCalled()
  expect(vi.mocked(a.write).mock.calls[0][0]).toContain('event: snapshot')
  // The frame carries the graph's own access mode, so a client needs no record of its own to know it.
  expect(vi.mocked(a.write).mock.calls[0][0]).toContain('"access":{"mode":"current"}')
  broadcast.clients.delete(a)
  broadcast.subscribe(a, 'a')
  await broadcast.clients.get(a)!.writes
  expect(view).toHaveBeenLastCalledWith('a')
  expect(a.destroy).not.toHaveBeenCalled()
  broadcast.close()
  expect(a.end).toHaveBeenCalledOnce()
  expect(b.end).toHaveBeenCalledOnce()
})
