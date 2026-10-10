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

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
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

export function apply(ctx: Context): void {
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
