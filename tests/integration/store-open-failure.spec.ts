import { describe, expect, it } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { GraphService } from '../../graph/src/index.ts'
import { LayoutService } from '../../layout/src/index.ts'

/**
 * Both services open their configured default store while constructing, long
 * before any caller can await it. An open failure there used to reach the
 * process-level unhandled-rejection handler, which the harness treats as a
 * fatal load failure, so one unmigratable predecessor generation could decide
 * whether the whole process boots.
 */
const services = {
  graph: { storeId: 'graph-idle', create: (ctx: Context) => new GraphService(ctx) },
  layout: { storeId: 'layout-idle', create: (ctx: Context) => new LayoutService(ctx) },
} as const

describe.each(['graph', 'layout'] as const)('%s default store open failure', name => {
  it('stays caller-visible instead of surfacing as an unhandled rejection', async () => {
    const { storeId, create } = services[name]
    const error = new Error('format v2 to v3 cannot safely transform unclassified event')
    const ctx = new Context()
    ctx.provide('sessionPersistence', {
      list: async () => [],
      create: async () => {
        throw error
      },
      open: async () => {
        throw error
      },
    } as never)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const service = create(ctx)
      await new Promise<void>(resolve => {
        setImmediate(resolve)
      })
      expect(unhandled).toEqual([])
      await expect(service.snapshotIn(storeId)).rejects.toBe(error)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
