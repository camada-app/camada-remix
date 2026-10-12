// @camada/remix — the root server middleware for React Router framework mode (SDK-G04):
//   export const middleware = [camada()];   // app/root.tsx
// A thin binding over @camada/core/fetch: the peer is whatever a custom server put in
// `camadaPeerContext` (React Router itself vouches for no socket), the env is process.env, and
// there is no waitUntil — the host is a long-lived Node server or an edge runtime that keeps
// its own isolate open. A camada bug, a dead ingest or a corrupt snapshot costs telemetry,
// never the app's response.
import iife from '@camada/browser/iife-string';
import { guarded, TAP_REMIX } from '@camada/core';
import { createFetchCamada, withSetCookie, withRid, type FetchCamada, type FetchCamadaOptions, type FetchRequestContext, type FetchVars } from '@camada/core/fetch';
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

/** React Router runs middleware only for a matched route, and the beacon route (`/_cam/*` in the
 *  README) is the one camada can count on: the challenge form posts into that directory by
 *  default (`/_cam/challenge`, or next to a custom `scriptPath`), where camadaRoute() matches and
 *  the root middleware answers. Core's own default, `/__camada/challenge`, would 404 in the
 *  router before camada ever ran (camada-all-zhoc). */
export const defaultChallengePath = (scriptPath = '/_cam/b.js'): string => scriptPath.replace(/[^/]*$/, 'challenge');

export function instanceFor(given: CamadaRemixOptions = {}): FetchCamada {
  const opts = { ...given, challengePath: given.challengePath ?? defaultChallengePath(given.scriptPath) };
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

/** A challenged client-side navigation: React Router's client fetches `<path>.data` (`/_.data` for a
 *  path ending in `/`) and throws any 4xx without `X-Remix-Response` into the route's error
 *  boundary, so core's 403 JSON would show the app's error page, never the challenge. Answer it
 *  in React Router's single-fetch redirect form instead: 204 + `X-Remix-Redirect` to the page
 *  itself + `X-Remix-Reload-Document`, which the client turns into a document navigation
 *  (`window.location.assign`) that meets the HTML challenge (camada-all-wjln). Any other answer,
 *  and every request that is not a `.data` fetch (an API call from app code), is left as it is. */
export function forNavigation(req: Request, res: Response): Response {
  return guarded(() => {
    if (res.status !== 403 || res.headers.get('x-camada-challenge') !== '1') return res;
    const url = new URL(req.url);
    if (!url.pathname.endsWith('.data')) return res;
    url.pathname = url.pathname.endsWith('/_.data') ? url.pathname.slice(0, -'_.data'.length)
      : url.pathname === '/_root.data' ? '/'   // Remix v2's spelling of the root
      : url.pathname.slice(0, -'.data'.length);
    url.searchParams.delete('_routes');
    void res.body?.cancel().catch(() => {});
    return new Response(null, {
      status: 204,
      headers: {
        'X-Remix-Redirect': url.pathname + url.search, 'X-Remix-Status': '302', 'X-Remix-Reload-Document': 'true',
        'cache-control': 'no-store', 'x-camada-challenge': '1',
      },
    });
  }, res);
}

export function camada(opts: CamadaRemixOptions = {}): MiddlewareFunction<Response> {
  const cam = instanceFor(opts);
  return async ({ request, context }, next) => {
    const r = await cam.before(request, requestContext(context));
    if (!r) return next();
    if (r.response) return forNavigation(request, r.response);   // block, challenge, verify, beacon: answered without the app
    guarded(() => context.set(camadaContext, r.vars), undefined);
    let res: Response;
    try {
      res = await next();
    } catch (err) {
      // A thrown Response (a redirect from a downstream middleware) is the answer, so it carries
      // the status and the cookie; anything else lands in the router's error boundary as a 500.
      if (err instanceof Response) {
        cam.after(request, r.vars, err.status);
        throw withRid(r.vars.sessionCookie ? withSetCookie(err, r.vars.sessionCookie) : err, r.vars);
      }
      cam.after(request, r.vars, 500);
      throw err;
    }
    return cam.finish(request, r.vars, r.vars.sessionCookie ? withSetCookie(res, r.vars.sessionCookie) : res);   // an SSE body ships once it has gone out; anything else now
  };
}
