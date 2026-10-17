import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, resolve, sep } from 'node:path'
import { ProtocolRefusal } from '../../src/protocol/refusal.ts'

import type { Context } from '@deepseek-ai/cordis'
// Register the host's service types without adding a runtime dependency.
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'singularity-web'

export const inject = ['singularity', 'webServer']

export const TASKS_PATH = '/singularity/tasks'
export const RESTART_PATH = '/singularity/restart'
export const RSI_MEMORY_PATH = '/singularity/rsi-memory'

export const PANEL_PATH = '/singularity/panel'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

// Resolve bundled assets through the installed package's export map.
const require = createRequire(import.meta.url)
const PACKAGE_ROOT = dirname(require.resolve('@dangosys/dsh-singularity-next/package.json'))

function assetPath(root: string, rel: string): string {
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`panel static: path escape "${rel}"`)
  return abs
}

interface AuthFence {
  requestRejection(request: IncomingMessage): number | undefined
}

function fenceOf(ctx: Context): AuthFence | undefined {
  return ctx.get('connection') as AuthFence | undefined
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

// Static assets are public; the data route uses the host connection fence.
function servePanel(ctx: Context): () => void {
  const root = PACKAGE_ROOT
  const stopRedirect = ctx.webServer.register({
    kind: 'exact',
    path: PANEL_PATH,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 302
      res.setHeader('location', `${PANEL_PATH}/`)
      res.end()
    },
  })
  const stopAssets = ctx.webServer.register({
    kind: 'prefix',
    path: PANEL_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://panel.local')
      let rel = url.pathname.slice(PANEL_PATH.length).replace(/^\/+/, '') || 'panel.html'
      if (rel.endsWith('/')) rel += 'panel.html'
      const abs = assetPath(root, rel)
      const type = MIME[extname(abs).toLowerCase()]
      if (type === undefined) {
        res.statusCode = 415
        res.end(`panel static: no content type for ${rel}`)
        return
      }
      let body
      try {
        body = await readFile(abs)
      } catch {
        res.statusCode = 404
        res.end(`panel static: ${rel} is not in this package`)
        return
      }
      res.setHeader('content-type', type)
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    },
  })
  return () => {
    stopRedirect()
    stopAssets()
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => servePanel(ctx))
  for (const path of [TASKS_PATH, RESTART_PATH, RSI_MEMORY_PATH]) ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const fence = fenceOf(ctx)
        if (fence === undefined) {
          sendJson(res, 403, {
            code: 'unfenced-route',
            message: 'this composition provides no connection service, so no request can be shown to be authenticated; the task-read route is not served without a fence',
          })
          return
        }
        const rejection = fence.requestRejection(req)
        if (rejection !== undefined) {
          res.statusCode = rejection
          res.end()
          return
        }
        const method = path === TASKS_PATH ? 'GET' : 'POST'
        if (req.method !== method) {
          res.statusCode = 405
          res.setHeader('allow', method)
          res.end()
          return
        }
        if (path === RESTART_PATH) {
          if (!(await ctx.singularity.read()).providerStopped) {
            sendJson(res, 409, { message: 'Only a graph stopped by an unstable provider can be restarted' })
            return
          }
          await ctx.singularity.restart()
        }
        if (path === RSI_MEMORY_PATH) {
          try {
            const chunks: Buffer[] = []
            for await (const chunk of req) chunks.push(Buffer.from(chunk))
            await ctx.singularity.inheritRsi(JSON.parse(Buffer.concat(chunks).toString('utf8')))
            sendJson(res, 200, { status: 'linked' })
          } catch (error) {
            if (!(error instanceof SyntaxError || error instanceof ProtocolRefusal)) throw error
            sendJson(res, 400, { message: String(error) })
          }
          return
        }
        sendJson(res, 200, await ctx.singularity.read())
      },
    }),
  )
}
