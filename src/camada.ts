// @camada/remix — the root server middleware for React Router framework mode (SDK-G04):
//   export const middleware = [camada()];   // app/root.tsx
// A thin binding over @camada/core/fetch: the peer is whatever a custom server put in
// `camadaPeerContext` (React Router itself vouches for no socket), the env is process.env, and
// there is no waitUntil — the host is a long-lived Node server or an edge runtime that keeps
// its own isolate open. A camada bug, a dead ingest or a corrupt snapshot costs telemetry,
// never the app's response.
import iife from '@camada/browser/iife-string';
import { guarded, safeReturnTo, TAP_REMIX } from '@camada/core';
import { createFetchCamada, withSetCookie, withRid, type FetchCamada, type FetchCamadaOptions, type FetchRequestContext, type FetchVars } from '@camada/core/fetch';
import type { MiddlewareFunction } from 'react-router';
import { camadaContext, camadaPeerContext, camadaResponseContext, type RouterContext } from './context.js';
import { SDK_ID } from './version.js';

export interface CamadaRemixOptions extends FetchCamadaOptions {
  /** The app's React Router `basename` (react-router.config.ts), when it has one. The client puts
   *  it back in front of a redirect, so a challenged data request's `X-Remix-Redirect` goes out
   *  without it. */
  basename?: string;
}
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

/** The directory of the beacon script, `/_cam/` by default: a path in it with `name` last. */
export const inScriptDir = (scriptPath: string | undefined, name: string): string => (scriptPath ?? '/_cam/b.js').replace(/[^/]*$/, name);

export function instanceFor(given: CamadaRemixOptions = {}): FetchCamada {
  // React Router runs middleware only for a matched route, and the beacon route (`/_cam/*` in the
  // README) is the one camada can count on: the challenge form posts into that directory by
  // default (`/_cam/challenge`, or next to a custom `scriptPath`), where camadaRoute() matches and
  // the root middleware answers. Core's own default, `/__camada/challenge`, would 404 in the
  // router before camada ever ran (camada-all-zhoc).
  const { basename, ...core } = given;   // the adapter's own option: not core's, and part of the engine's identity only through the paths it moves
  // Under a `basename` the router strips it before matching, so the endpoints' URLs (what the
  // browser requests and core compares) carry it: the defaults live under it (camada-all-xms0).
  const base = (basename ?? '').replace(/\/+$/, '');
  const scriptPath = core.scriptPath ?? (base ? `${base}/_cam/b.js` : undefined);
  const fpPath = core.fpPath ?? inScriptDir(scriptPath, 'fp');   // the script posts next to itself (auto.ts derives it): `/_cam/fp` by default
  const opts = {
    ...core,
    ...(scriptPath ? { scriptPath } : {}),
    fpPath,
    challengePath: core.challengePath ?? inScriptDir(scriptPath, 'challenge'),
  };
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

/** `path` without the router's basename, or null when it lies outside it. */
function underBasename(path: string, basename: string | undefined): string | null {
  const base = (basename ?? '').replace(/\/+$/, '');
  if (!base) return path;
  if (path === base) return '/';
  return path.startsWith(base + '/') ? path.slice(base.length) : null;
}

/** Whether `pathname` is React Router's client fetching `<path>.data` (any method). */
const isDataPath = (pathname: string): boolean => pathname.endsWith('.data');
const isDataRequest = (req: Request): boolean => isDataPath(new URL(req.url).pathname);

/** A challenged client-side navigation: React Router's client fetches `<path>.data` (`/_.data` for a
 *  path ending in `/`) and throws any 4xx without `X-Remix-Response` into the route's error
 *  boundary, so core's 403 JSON would show the app's error page, never the challenge. Answer it
 *  in React Router's single-fetch redirect form instead: 204 + `X-Remix-Redirect` +
 *  `X-Remix-Reload-Document`, which the client turns into a document navigation
 *  (`window.location.assign`) that meets the HTML challenge (camada-all-wjln). A GET reloads the
 *  page itself. A non-GET (`fetcher.submit`, `fetcher.load` of a resource route, `<Form
 *  action=/other>`) targets a route that may have no page, so it reloads the same-origin page it
 *  came from (the Referer), else the data path. The location goes out without the router's
 *  basename, which the client adds back. Any other answer, and every request that is not a
 *  `.data` fetch, is left as it is. */
export function forNavigation(req: Request, res: Response, basename?: string): Response {
  return guarded(() => {
    if (res.status !== 403 || res.headers.get('x-camada-challenge') !== '1') return res;
    const url = new URL(req.url);
    if (!isDataPath(url.pathname)) return res;
    url.pathname = url.pathname.endsWith('/_.data') ? url.pathname.slice(0, -'_.data'.length)
      : url.pathname.endsWith('/_root.data') ? url.pathname.slice(0, -'_root.data'.length)   // Remix v2's spelling of the root
      : url.pathname.slice(0, -'.data'.length);
    url.searchParams.delete('_routes');
    let to = underBasename(url.pathname, basename) ?? '/';
    to = safeReturnTo(to + url.search);
    if (req.method !== 'GET' && req.method !== 'HEAD') to = fromReferer(req, url.origin, basename) ?? to;
    void res.body?.cancel().catch(() => {});
    return new Response(null, {
      status: 204,
      headers: {
        'X-Remix-Redirect': to, 'X-Remix-Status': '302', 'X-Remix-Reload-Document': 'true',
        'cache-control': 'no-store', 'x-camada-challenge': '1',
      },
    });
  }, res);
}

/** camada's own answer (block, challenge, verify, beacon), in the form the router sends. Where a custom
 *  server passed its Node response in `camadaResponseContext`, the headers that answer sets are
 *  removed from it first: the Express adapter appends, so an upstream policy or cache header
 *  would otherwise go out next to the answer's own (R7-2). Set-Cookie is the app's and stays. */
export function answered(req: Request, context: RouterContext, res: Response, basename?: string): Response {
  const out = forNavigation(req, res, basename);
  guarded(() => {
    const node = context.get(camadaResponseContext);
    if (!node || typeof node.removeHeader !== 'function') return;
    for (const k of out.headers.keys()) if (k !== 'set-cookie') node.removeHeader(k);
    if (out.headers.has('content-security-policy')) node.removeHeader('content-security-policy-report-only');
  }, undefined);
  return out;
}

/** The same-origin Referer's path and query (without the basename), when it is a safe return target. */
function fromReferer(req: Request, origin: string, basename: string | undefined): string | null {
  const raw = req.headers.get('referer');
  if (!raw) return null;
  let ref: URL;
  try { ref = new URL(raw); } catch { return null; }
  if (ref.origin !== origin) return null;
  const path = underBasename(ref.pathname, basename);
  if (path === null) return null;
  const to = path + ref.search;
  return safeReturnTo(to) === to ? to : null;
}

export function camada(opts: CamadaRemixOptions = {}): MiddlewareFunction<Response> {
  const cam = instanceFor(opts);
  return async ({ request, context }, next) => {
    const r = await cam.before(request, { ...requestContext(context), navigation: isDataRequest(request) });
    if (!r) return next();
    if (r.response) return answered(request, context, r.response, opts.basename);   // block, challenge, verify, beacon: answered without the app
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
