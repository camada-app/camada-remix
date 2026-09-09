// @camada/remix — the root server middleware for React Router framework mode (SDK-G04):
//   export const middleware = [camada()];   // app/root.tsx
// A thin binding over @camada/core/fetch: the peer is whatever a custom server put in
// `camadaPeerContext` (React Router itself vouches for no socket), the env is process.env, and
// there is no waitUntil — the host is a long-lived Node server or an edge runtime that keeps
// its own isolate open. A camada bug, a dead ingest or a corrupt snapshot costs telemetry,
// never the app's response.
import iife from '@camada/browser/iife-string';
import { guarded, TAP_REMIX } from '@camada/core';
import { createFetchCamada, withSetCookie, type FetchCamada, type FetchCamadaOptions, type FetchRequestContext, type FetchVars } from '@camada/core/fetch';
import type { MiddlewareFunction } from 'react-router';
import { camadaContext, camadaPeerContext, type RouterContext } from './context.js';
import { SDK_ID } from './version.js';

export type CamadaRemixOptions = FetchCamadaOptions;
export type CamadaRemixVars = FetchVars;

// camada() and camadaRoute() must see one engine for the same options, or the route would poll
// and enforce a second copy of the tenant's snapshot: an instance is found by its serialisable
// options (keys sorted, so two modules spelling them in a different order agree); fetchImpl
// cannot be stringified, so it keys a bucket by identity.
const instances = new Set<FetchCamada>();
const byKey = new Map<typeof fetch | undefined, Map<string, FetchCamada>>();

// Sorts the keys of every object on the way in, so key order never splits one configuration in two.
const sortedJson = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

export function instanceFor(opts: CamadaRemixOptions = {}): FetchCamada {
  const { fetchImpl, ...serialisable } = opts;
  const key = sortedJson(serialisable);
  let bucket = byKey.get(fetchImpl);
  if (!bucket) byKey.set(fetchImpl, (bucket = new Map()));
  let cam = bucket.get(key);
  if (!cam) {
    cam = createFetchCamada({ tap: TAP_REMIX, sdk: SDK_ID, iife }, opts);
    bucket.set(key, cam);
    instances.add(cam);
  }
  return cam;
}

/** Test/reset hook: stops and drops every engine this module created; the instances stay wired and rebuild lazily. */
export function resetCamada(): void {
  for (const cam of instances) cam.reset();
}

/** What the host can vouch for: the peer a custom server set, and the process env. The peer read
 *  is guarded — a 7.9 app without the middleware flag hands a plain object; an edge runtime has no process. */
export function requestContext(context: RouterContext): FetchRequestContext {
  return {
    peer: guarded(() => context.get(camadaPeerContext), null),
    env: globalThis.process?.env,
  };
}

export function camada(opts: CamadaRemixOptions = {}): MiddlewareFunction<Response> {
  const cam = instanceFor(opts);
  return async ({ request, context }, next) => {
    const r = await cam.before(request, requestContext(context));
    if (!r) return next();
    if (r.response) return r.response;   // block, challenge, verify, beacon: answered without the app
    guarded(() => context.set(camadaContext, r.vars), undefined);
    let res: Response;
    try {
      res = await next();
    } catch (err) {
      // A thrown Response (a redirect from a downstream middleware) is the answer, so it carries
      // the status and the cookie; anything else lands in the router's error boundary as a 500.
      if (err instanceof Response) {
        cam.after(request, r.vars, err.status);
        throw r.vars.sessionCookie ? withSetCookie(err, r.vars.sessionCookie) : err;
      }
      cam.after(request, r.vars, 500);
      throw err;
    }
    cam.after(request, r.vars, res.status);
    return r.vars.sessionCookie ? withSetCookie(res, r.vars.sessionCookie) : res;
  };
}
