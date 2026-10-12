# @camada/remix

camada for [React Router](https://reactrouter.com) framework mode (the Remix lineage): enforces
the tenant snapshot in a root server middleware (your ordered custom rules, then block, allow,
challenge), serves a first-party proof-of-work challenge page and beacon, and records the
outcomes your actions know (`track()`). Fails open by design — a camada outage or bug never
5xxes your app.

```sh
npm install @camada/remix
```

## Quickstart

```ts
// app/root.tsx
import { camada } from '@camada/remix';

export const middleware = [camada()];   // reads CAMADA_KEY / CAMADA_INGEST_URL / CAMADA_SNAPSHOT_URL from process.env
```

```ts
// app/routes.ts
import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('/_cam/*', 'routes/cam.tsx'),   // camada's own endpoints (beacon + challenge) only run where a route exists
] satisfies RouteConfig;
```

```ts
// app/routes/cam.tsx
import { camadaRoute } from '@camada/remix';

const r = camadaRoute();
export const loader = r.loader;   // plain consts: `export const { loader, action } = ...` fails
export const action = r.action;   // `react-router build` ("Cannot remove destructured export")
```

Env (printed by camada onboarding / `npm run seed` in dev):

```
CAMADA_KEY=<ingest_token>.<snap_token>
CAMADA_INGEST_URL=http://localhost:8787        # dev only; defaults to production ingest
```

An app that reads its own config can pass the values instead:

```ts
export const middleware = [camada({ key: MY_KEY, ingestUrl: MY_INGEST })];
```

Server middleware is stable in React Router 8. On 7.9+ it is behind a future flag:

```ts
// react-router.config.ts
export default { future: { v8_middleware: true } };
```

Without `CAMADA_KEY` the middleware is inert (one log line, no requests, no enforcement), so an
unprovisioned environment behaves exactly as if camada were not installed.

`camada()` and `camadaRoute()` share one engine per configuration — the same options object,
or two that spell the same options — so the middleware and the route poll one snapshot and
fill one event queue. Two mounts with different keys or URLs each get their own.

## What it does per request

1. Refreshes the snapshot off-path (lazy mode by default: a refresh is kicked when stale and
   the request does not wait for it; `mode: 'timer'` polls on an unref'd interval and drains
   the queue on exit for a long-lived Node server). Every poll and event batch carries
   `x-camada-sdk: @camada/remix/<version>`, and polls ask for snapshot v5
   (`x-camada-snapshot: 5`) — the container that carries your ordered custom rules.
2. Resolves the client from the peer your server vouched for (see below), falling back to
   `X-Forwarded-For` only under your tenant's trusted-proxy config. A bare header is never
   trusted: without a vouched peer and a trusted-proxy config the ip is `null`, ip rules do not
   fire, and the request is still captured.
3. Runs your ordered custom rules, then the allow, block and challenge lists.
4. **Block** → `403` with `x-block-reason` (and `x-block-rule` when a custom rule decided)
   before `next()`; the event still ships, with `st: 403` and `blk: <reason>` so the analyst
   counts SDK blocks apart from your own 403s.
5. **Skip** → a skip rule or the allow list wins over a wider block.
6. **Challenge** → a `403` proof-of-work page for HTML navigations, `403
   {"error":"challenge_required"}` for API and `fetch()` calls; `POST /_cam/challenge` verifies
   the work, sets `_cch` and 302s back. A client-side navigation (React Router fetching
   `<path>.data` for a `<Link>`) is answered in React Router's own redirect form instead
   (`204` + `X-Remix-Redirect` to the same page + `X-Remix-Reload-Document`), so the browser
   reloads the page as a document and meets the challenge, rather than your error boundary
   rendering a 403. A challenged submission (`fetcher.submit`, `<Form action>`, any non-GET
   `.data`) reloads the same-origin page it came from (its `Referer`), else the data path.
7. Otherwise `next()` runs your loaders and actions, and the settled response ships one
   batched, redacted event with its real status (Authorization and Cookie values never leave
   the process; credential-looking query values are scrubbed — see `@camada/core`). A first
   visit gets the `_sfp` session cookie, appended even to a `redirect()` whose headers are
   immutable.

## The peer

React Router hands the middleware a `Request` and nothing about the socket, so out of the box
this tap vouches for no address. A custom server knows the socket and can say so through
`getLoadContext`:

```ts
// server.ts (Express)
import { createRequestHandler } from '@react-router/express';
import { RouterContextProvider } from 'react-router';
import { camadaPeerContext, camadaResponseContext } from '@camada/remix';

app.all('*', createRequestHandler({
  build,
  getLoadContext(req, res) {
    const context = new RouterContextProvider();
    context.set(camadaPeerContext, req.socket.remoteAddress ?? null);   // the address Node vouches for, never a header
    context.set(camadaResponseContext, res);   // lets camada's answers replace headers set before the handler (below)
    return context;
  },
}));
```

`@react-router/express` copies a Response's headers onto `res` with `res.append`, so a header an
Express middleware set before the handler goes out next to camada's own. With
[helmet](https://helmetjs.github.io/) in front, the challenge page would carry two
`Content-Security-Policy` headers: browsers enforce both, and helmet's blocks the page's inline
solver, so a challenged visitor can never pass. Handing camada `res` through
`camadaResponseContext` (as above) fixes that: before it answers a request itself (block,
challenge, verify, beacon script), camada removes from `res` every header its answer sets, plus a
report-only policy under the challenge page's own. Set-Cookie headers are left alone. Without it,
mount helmet after the React Router handler, or set your policy from React Router's
`entry.server` / route `headers` instead of Express.

Behind a load balancer, set `CAMADA_TRUSTED_PROXY=hops:1` (or `cidrs:…`) — or the
`trustedProxy` option — and `X-Forwarded-For` is read one hop behind that peer. Never put a
header value in `camadaPeerContext`: that is the one address camada takes on faith.

Without a vouched peer (no `camadaPeerContext`, e.g. on a serverless host), this adapter keeps
the plain `X-Forwarded-For` walk under your trusted-proxy config. With a peer, a `cidrs`
config is walked only when the peer itself is a trusted proxy or loopback. Without one there is
nothing to check, so the walk trusts that every request came through your edge (the platform,
load balancer or CDN in front of the app). That holds when the edge is the only way in. If the
origin is reachable directly, a client can send its own `X-Forwarded-For`, so lock the origin to
the edge.

## Options

| option | default | meaning |
|---|---|---|
| `key` | `env.CAMADA_KEY` | `<ingest_token>.<snap_token>`; without it the middleware is inert |
| `ingestUrl` | `env.CAMADA_INGEST_URL` | ingest base; batches go to `<ingestUrl>/e` |
| `snapshotUrl` | `<ingestUrl>/snapshot` | snapshot endpoint |
| `trustedProxy` | server config | `none` / `vercel` / `hops:N` / `cidrs:a,b`, or the parsed object |
| `challenge` | `true` | serve the proof-of-work page for `challenge` verdicts |
| `challengePath` | `/_cam/challenge` (next to `scriptPath`; under `basename` if set) | where that page posts its solution; keep it under the route that calls `camadaRoute()` |
| `snapshotVersion` | `5` | `4` drops the custom rules, `3` the allow/challenge sides too |
| `scriptPath` | `/_cam/b.js` (`<basename>/_cam/b.js` if `basename` is set) | where the first-party beacon script is served |
| `fpPath` | `fp` in `scriptPath`'s directory: `/_cam/fp`, `<basename>/_cam/fp` if `basename` is set, `/app/x/fp` for `scriptPath: '/app/x/b.js'` | where that script posts the beacon; the script derives it from its own `src`, so keep it in `scriptPath`'s directory |
| `mode` | `lazy` (or `timer`) | `timer` polls the snapshot on an unref'd interval (long-lived process); `lazy` refreshes it per request off-path. `CAMADA_SERVERLESS=1` forces `lazy` |
| `basename` | none | your React Router `basename` (react-router.config.ts). Set it when the app has one (on `camada()` and `camadaRoute()` alike): the default `scriptPath`, `fpPath` and `challengePath` then live under it (`/app/_cam/b.js`, `/app/_cam/fp`, `/app/_cam/challenge`), and the client's redirect for a challenged navigation no longer lands on `/app/app/page`. An explicit path is used as given |
| `env` | `process.env` | overrides the process env (tests, and apps that read config themselves) |

`CAMADA_CHALLENGE=0` in the env switches the challenge off without a code change.

`CAMADA_DISABLED=1` in the env switches everything off, checked per request.

## The first-party beacon

Bots that never run JavaScript are the cheapest to catch. Put the tag in the pages you render
and the middleware does the rest. The helper returns markup, so render it through a wrapper
at the end of `<body>` — it is part of the server-rendered document, and the browser runs it
on parse (an element cannot be dangerously-set inside `<head>` next to `<Meta />`):

```tsx
// app/root.tsx
import { Meta, Links, Scripts, useRouteLoaderData } from 'react-router';
import { camada, scriptTag } from '@camada/remix';
import type { Route } from './+types/root';

export const middleware = [camada()];
export const loader = ({ context }: Route.LoaderArgs) => ({ beacon: scriptTag(context) });

export function Layout({ children }: { children: React.ReactNode }) {
  const { beacon } = useRouteLoaderData<typeof loader>('root') ?? { beacon: '' };
  return (
    <html>
      <head><Meta /><Links /></head>
      <body>
        {children}
        <Scripts />
        <div hidden dangerouslySetInnerHTML={{ __html: beacon }} />
      </body>
    </html>
  );
}
```

`scriptTag(context)` returns `<script src="/_cam/b.js?r=<rid>" async></script>` — the `rid` is
this request's event id, so the analyst joins the beacon to the page view. The middleware
serves the script at `GET /_cam/b.js` (cacheable, 1 h) and relays `POST /_cam/fp` (≤ 32 KB,
answers 204) onto the event batch as a `sig: 1` row stamped with the client ip camada resolved —
never the one the body claims. Both endpoints sit behind the verdict: a blocked client gets 403
there too. The tag is `''` when camada is off for the request or the project turned the beacon
off in its settings, and the endpoints stand down with it.

## The routes camada needs

React Router runs middleware only for a URL some route matches. An unmatched URL gets the
router's 404 before any middleware runs, so camada never sees it. Its own endpoints therefore
need a route, and `route('/_cam/*', 'routes/cam.tsx')` with `camadaRoute()` is that route. It
covers three endpoints:

| endpoint | what it is |
|---|---|
| `GET /_cam/b.js` | the beacon script |
| `POST /_cam/fp` | the beacon relay |
| `POST /_cam/challenge` | the challenge page's form: verifies the work and sets `_cch` |

With a React Router `basename` (say `/app`) the URLs carry it: `/app/_cam/b.js`, `/app/_cam/fp`,
`/app/_cam/challenge`. Pass `basename: '/app'` to both `camada()` and `camadaRoute()` and those
are the defaults; the route itself stays `route('/_cam/*', ...)` in `routes.ts`, because the
router matches routes after stripping the basename. Without the option the defaults sit outside
the basename, the router 404s the challenge form, and no challenged visitor can pass.

With the root middleware mounted it answers first, and the route's loader and action are the
fallback (a middleware mounted lower, or none at all). They re-run the verdict, so a blocked
client gets a 403 there as well. A custom `scriptPath` / `fpPath` must share a directory (the
script derives the post path from its own `src`), `fpPath` and the challenge path default to that same
directory (`/api/cam/b.js` → `/api/cam/fp`, `/api/cam/challenge`), and the route must cover it. An explicit
`challengePath` outside that route 404s in the router, and no challenged visitor can pass.

What is **not** captured: requests to URLs no route matches (scanner probes such as
`/wp-admin/setup.php` or `/.env`). They never reach the middleware, so they ship no event and a
path block on them is not counted. Your app's 404 still answers them. To capture them as well,
add a splat route (`route('*', 'routes/not-found.tsx')`) whose loader throws your 404: the
middleware then runs for every URL.

## App-context events

The wire shows a `POST /login`; only your action knows whether it failed. Tell camada:

```ts
// app/routes/login.tsx
import { track } from '@camada/remix';
import type { Route } from './+types/login';

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const user = String(form.get('email'));
  const ok = await signIn(user, String(form.get('password')));
  if (!ok) track(context, 'login_failed', { user });   // await optional
  return ok ? redirect('/') : data({ error: 'Invalid credentials' }, { status: 401 });
}
```

`track(context, event, { user? })` ships `{ et, uid, rid, sid, ip, ts }` joined to this
request's event. The user identifier is HMAC-hashed in-process with the ingest token — the raw
value never leaves the process. It never throws and is a no-op where the middleware did not
run. The event name is free-form; the analyst's rules read this vocabulary:

| event | when |
|---|---|
| `login_failed` / `login_succeeded` | a credential check settled |
| `signup` | an account was created |
| `password_reset` | a reset was requested |
| `mfa_failed` | a second factor was rejected |
| `payment_failed` / `payment_succeeded` | a charge settled |
| `coupon_failed` | a promo code was rejected |

## What this tap can see

The in-app position: the beacon, the client hints and headers the request carries, the real
response status, the `_sfp` session, and the outcomes your actions report through `track()`.
What it cannot see is the connection. React Router vouches for nothing below the `Request` —
no socket address, no ASN, country, TLS fingerprint or client protocol — so those come only
from what your server puts in `camadaPeerContext` (the address) and from a trusted-proxy
config (`X-Forwarded-For`). ASN, country and `tlsx` rules do not fire at this tap. Header order is normalised by the `Headers` API before camada sees it, so the
raw-wire-order signal is not available here either.

## Fail open

Every entry point runs inside camada's guard. A dead ingest, a corrupt snapshot, a bug in this
package, a context that is not a `RouterContextProvider`: telemetry is lost, the request is not.
