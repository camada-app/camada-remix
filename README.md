# @camada/remix

camada for [React Router](https://reactrouter.com) framework mode (the Remix lineage): enforces
the tenant snapshot in a root server middleware (your ordered custom rules, then block, allow,
challenge), serves a first-party proof-of-work challenge page and beacon, and records the
outcomes your actions know (`track()`). Fails open by design — a camada outage or bug never
5xxes your app.

Not yet on npm — consumed via a `file:` dependency from a sibling checkout.

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
  route('/_cam/*', 'routes/cam.tsx'),   // the beacon endpoints only run where a route exists
] satisfies RouteConfig;
```

```ts
// app/routes/cam.tsx
import { camadaRoute } from '@camada/remix';

export const { loader, action } = camadaRoute();
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
   {"error":"challenge_required"}` for anything else; `POST /__camada/challenge` verifies the
   work, sets `_cch` and 302s back.
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
import { camadaPeerContext } from '@camada/remix';

app.all('*', createRequestHandler({
  build,
  getLoadContext(req) {
    const context = new RouterContextProvider();
    context.set(camadaPeerContext, req.socket.remoteAddress ?? null);   // the address Node vouches for, never a header
    return context;
  },
}));
```

Behind a load balancer, set `CAMADA_TRUSTED_PROXY=hops:1` (or `cidrs:…`) — or the
`trustedProxy` option — and `X-Forwarded-For` is read one hop behind that peer. Never put a
header value in `camadaPeerContext`: that is the one address camada takes on faith.

## Options

| option | default | meaning |
|---|---|---|
| `key` | `env.CAMADA_KEY` | `<ingest_token>.<snap_token>`; without it the middleware is inert |
| `ingestUrl` | `env.CAMADA_INGEST_URL` | ingest base; batches go to `<ingestUrl>/e` |
| `snapshotUrl` | `<ingestUrl>/snapshot` | snapshot endpoint |
| `trustedProxy` | server config | `none` / `vercel` / `hops:N` / `cidrs:a,b`, or the parsed object |
| `challenge` | `true` | serve the proof-of-work page for `challenge` verdicts |
| `challengePath` | `/__camada/challenge` | where that page posts its solution |
| `snapshotVersion` | `5` | `4` drops the custom rules, `3` the allow/challenge sides too |
| `scriptPath` | `/_cam/b.js` | where the first-party beacon script is served |
| `fpPath` | `/_cam/fp` | where that script posts the beacon; keep it in `scriptPath`'s directory |
| `mode` | `'lazy'` | `'timer'` for a long-lived Node server; `CAMADA_SERVERLESS=1` forces lazy |
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

React Router runs middleware only for matched routes, so `/_cam/*` needs a route to exist:
that is what `route('/_cam/*', 'routes/cam.tsx')` and `camadaRoute()` are for. With the root
middleware mounted it answers first and the route's loader and action are the fallback (a
middleware mounted lower, or none at all); they re-run the verdict, so a blocked client is
403'd there as well. A custom `scriptPath` / `fpPath` must share a directory (the script derives
the post path from its own `src`) and the route must cover it.

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
config (`X-Forwarded-For`). ASN, country and `tlsx` rules do not fire at this tap; the analyst
knows that from the tap's capability mask (`sdk-remix`) and never scores their absence as
evidence. Header order is normalised by the `Headers` API before camada sees it, so the
raw-wire-order signal is not available here either.

## Fail open

Every entry point runs inside camada's guard. A dead ingest, a corrupt snapshot, a bug in this
package, a context that is not a `RouterContextProvider`: telemetry is lost, the request is not.
