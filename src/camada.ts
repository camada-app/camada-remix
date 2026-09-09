// @camada/remix — the root server middleware for React Router framework mode (SDK-G04):
//   export const middleware = [camada()];   // app/root.tsx
// A thin binding over @camada/core/fetch: the peer is whatever a custom server put in
// `camadaPeerContext` (React Router itself vouches for no socket), the env is process.env, and
// there is no waitUntil — the host is a long-lived Node server or an edge runtime that keeps
// its own isolate open. A camada bug, a dead ingest or a corrupt snapshot costs telemetry,
// never the app's response.
import iife from '@camada/browser/iife-string';
import { guarded, TAP_REMIX } from '@camada/core';
import { createFetchCamada, withSetCookie, type FetchCamada, type FetchCamadaOptions, type FetchRequestContext } from '@camada/core/fetch';
import type { MiddlewareFunction } from 'react-router';
import { camadaContext, camadaInstanceContext, camadaPeerContext, type RouterContext } from './context.js';
import { SDK_ID } from './version.js';

export type CamadaRemixOptions = FetchCamadaOptions;

// camada() and camadaRoute() must see one engine for the same options, or the route would poll
// and enforce a second copy of the tenant's snapshot. The same object is found by reference;
// an equal object (two modules each spelling `{ mode: 'timer' }`) by its serialisable options.
// fetchImpl cannot be stringified, so it keys a map of its own by identity.
const instances = new Set<FetchCamada>();
let byRef = new WeakMap<object, FetchCamada>();
const byKey = new Map<typeof fetch | undefined, Map<string, FetchCamada>>();

export function instanceFor(opts: CamadaRemixOptions = {}): FetchCamada {
  const hit = byRef.get(opts);
  if (hit) return hit;
  const { fetchImpl, ...serialisable } = opts;
  const key = JSON.stringify(serialisable);
  let bucket = byKey.get(fetchImpl);
  if (!bucket) byKey.set(fetchImpl, (bucket = new Map()));
  let cam = bucket.get(key);
  if (!cam) {
    cam = createFetchCamada({ tap: TAP_REMIX, sdk: SDK_ID, iife }, opts);
    bucket.set(key, cam);
    instances.add(cam);
  }
  byRef.set(opts, cam);
  return cam;
}

/** Test/reset hook: stops and drops every engine this module created. */
export function resetCamada(): void {
  for (const cam of instances) cam.reset();
  instances.clear();
  byKey.clear();
  byRef = new WeakMap();
}

/** What the host can vouch for: the peer a custom server set, and the process env. Both guarded —
 *  a 7.9 app without the middleware flag hands a plain object, and an edge runtime has no process. */
export function requestContext(context: RouterContext): FetchRequestContext {
  return {
    peer: guarded(() => context.get(camadaPeerContext), null),
    env: guarded(() => globalThis.process?.env, undefined),
  };
}

export function camada(opts: CamadaRemixOptions = {}): MiddlewareFunction<Response> {
  const cam = instanceFor(opts);
  return async ({ request, context }, next) => {
    const r = await cam.before(request, requestContext(context));
    if (!r) return next();
    if (r.response) return r.response;   // block, challenge, verify, beacon: answered without the app
    guarded(() => { context.set(camadaContext, r.vars); context.set(camadaInstanceContext, cam); }, undefined);
    const res = await next();
    cam.after(request, r.vars, res.status);
    return r.vars.sessionCookie ? withSetCookie(res, r.vars.sessionCookie) : res;
  };
}
