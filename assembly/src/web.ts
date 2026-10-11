/**
 * The read route: one committed cut, served as JSON.
 *
 * It serves exactly the projection the tools answer from (`snapshotOf`), so "the tools and the UI agree
 * on one cut" is not a property anyone maintains — they are one function's output, read by the same
 * cutoff. Nothing here writes, which is what lets a browser poll it.
 *
 * `connection` is looked up rather than injected. An `inject` name a profile does not provide makes the
 * whole bundle skip silently, and naming the fence would cost the property that a profile with no browser
 * login can still mount this row — the route and the panel are one entry. `ctx.get` reaches a service the
 * profile provides and answers `undefined` when none does; `ctx.connection` and `Reflect.get(ctx, ...)` are
 * not alternatives, because both throw `cannot get property "connection" without inject` on a fiber that
 * does not declare it, turning the refusal below into a 500 (measured, cordis 4.0.4). A profile with no
 * fence is refused rather than served: an unguarded read of the task log is worse than a panel that says
 * why it is closed.
 *
 * @module @dangosys/dsh-singularity-next/web
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, resolve, sep } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
// A type-only import, and the type is the side effect: `ctx.webServer` is declared by that package's
// ambient module, so a service this plugin names in `inject` is one the compiler can check.
//
// **Not a value import.** A linked root resolves `@deepseek-ai/*` through the `peerDependencies` of the
// linked package: DSH's resolver only routes a name that root's own manifest declares a peer, so a bare
// `import '@deepseek-ai/dsh-host-webserver'` compiles to a runtime import this package cannot resolve and
// the row fails with `ERR_MODULE_NOT_FOUND` from a path that names neither this file nor the missing
// package. The declaration is all this module needs, and a type-only import leaves nothing in `lib/web.js`.
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'singularity-web'

/**
 * Two seams: the projection to serve, and the server to serve it on. A profile with no Web server simply
 * does not mount this row — which is the point of a separate entry, rather than a bundle that activates
 * and then cannot find the seam it declares.
 */
export const inject = ['singularity', 'webServer']

/** The one path this plugin owns. Exact, so nothing else can be answered here by accident. */
export const TASKS_PATH = '/singularity/tasks'

/** The panel's own page, served by this plugin at its own prefix — the page does not live in the shell. */
export const PANEL_PATH = '/singularity/panel'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/**
 * This package's own directory, found through the module system rather than through `import.meta.url`.
 *
 * **`import.meta.url` cannot be used here.** The build inlines this module into one bundle, and Vite
 * rewrites a module's own `import.meta.url` to a `data:` URL holding that module's source text — so
 * `fileURLToPath` throws `The URL must be of scheme file` at import time and the whole row fails to
 * activate. `createRequire` resolves against a real path and `require.resolve` finds this package's
 * manifest by its own name, which is the same route the previous singularity's static-asset route took.
 */
const require = createRequire(import.meta.url)
const PACKAGE_ROOT = dirname(require.resolve('@dangosys/dsh-singularity-next/package.json'))

function assetPath(root: string, rel: string): string {
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`panel static: path escape "${rel}"`)
  return abs
}

/**
 * The composition's auth fence, typed locally: `connection` is a service of the Web composition and
 * declaring a dependency on its package here would make this entry browser-shaped for no gain.
 */
interface AuthFence {
  requestRejection(request: IncomingMessage): number | undefined
}

/** The fence, or `undefined` when this composition mounts none. Never throws: see the module header. */
function fenceOf(ctx: Context): AuthFence | undefined {
  return ctx.get('connection') as AuthFence | undefined
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  // Availability is a live fact: a cached cut would let a panel show a state the log has left.
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Serve the panel's own assets from this plugin's directory.
 *
 * The structure is the previous singularity's `map-static`: a directory path redirects to itself with a
 * slash so a relative link inside the page resolves against the prefix, and a prefix route serves the
 * files. Both are `<script>`/`<link>` targets from an iframe, so they are served with no fence: a page
 * that had to authenticate before it could load its own stylesheet would render as unstyled HTML, which
 * reads as a broken panel rather than as a missing cookie. The data the page displays is fenced, and it
 * is the data that matters — the assets are the same bytes for every reader.
 */
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
        // A named miss rather than a 404 body: an unknown extension means the page asked for something
        // this route has no business serving, and that is a different fact from "no such file".
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
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: TASKS_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const fence = fenceOf(ctx)
        if (fence === undefined) {
          // Fail closed. A read route with no authentication is a way to read a deployment's whole task
          // history from any page that can reach the port, and "the panel will not work here" is the
          // smaller surprise of the two.
          sendJson(res, 403, {
            code: 'unfenced-route',
            message: 'this composition provides no connection service, so no request can be shown to be authenticated; the task-read route is not served without a fence',
          })
          return
        }
        const rejection = fence.requestRejection(req)
        if (rejection !== undefined) {
          // The fence's own status, unchanged: it decides what it is refusing and with what code.
          res.statusCode = rejection
          res.end()
          return
        }
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.setHeader('allow', 'GET')
          res.end()
          return
        }
        sendJson(res, 200, await ctx.singularity.read())
      },
    }),
  )
}
