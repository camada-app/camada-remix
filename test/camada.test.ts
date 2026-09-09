// @camada/remix against core's golden v4 snapshot, driven the way React Router drives it: the
// middleware and the resource route are called directly with `{ request, context }` and a
// `next()` returning fixed Responses. What core/fetch already proves (rules, challenge
// internals, redaction) stays in core; this suite covers the binding — the context slot, the
// vouched peer, the process env, the shared engine, and the cookie on an immutable response.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RouterContextProvider } from 'react-router';
import iife from '@camada/browser/iife-string';
import { camada, camadaRoute, camadaPeerContext, track, scriptTag, resetCamada, type CamadaRemixOptions } from '../src/index.js';

const FIX = fileURLToPath(new URL('../node_modules/@camada/core/test/fixtures/blk3/', import.meta.url));
const V4 = {
  bin: readFileSync(FIX + 'v4-basic.bin'),
  meta: JSON.stringify(JSON.parse(readFileSync(FIX + 'v4-basic.meta.json', 'utf8'))),
};

const BLOCKED_IP = '203.0.113.66';     // block side
const CHALLENGED_IP = '192.0.2.20';    // challenge side only
const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document' };
const CONFIG = { tenant: 'acme', beacon: true, sample: 1, exclude: [], trusted_proxy: { mode: 'none' }, poll_seconds: 30 };
const ENV = { CAMADA_KEY: 'tok-acme.snap-acme', CAMADA_INGEST_URL: 'http://analyst.test', CAMADA_SNAPSHOT_URL: 'http://analyst.test/snapshot' };

function frame(): ArrayBuffer {
  const m = new TextEncoder().encode(V4.meta);
  const f = new Uint8Array(4 + m.length + V4.bin.length);
  new DataView(f.buffer).setUint32(0, m.length, true);
  f.set(m, 4); f.set(new Uint8Array(V4.bin), 4 + m.length);
  return f.buffer;
}

let events: Array<Record<string, unknown>>;
let sdkHeaders: string[];

const fetchImpl: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith('/snapshot')) {
    return new Response(frame(), { status: 200, headers: { etag: `"${JSON.parse(V4.meta).version}"`, 'x-camada-config': JSON.stringify(CONFIG) } });
  }
  sdkHeaders.push(new Headers(init?.headers).get('x-camada-sdk') ?? '');
  events.push(...(JSON.parse(String(init?.body)) as Array<Record<string, unknown>>));
  return new Response(null, { status: 202 });
}) as typeof fetch;

/** No waitUntil on this host: the flush and the snapshot load settle on their own within a few ticks. */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };

/** The app behind `next()`: fixed responses, including the immutable-headers redirect. */
const html = (s: string) => new Response(s, { headers: { 'content-type': 'text/html' } });
function app(request: Request, context: RouterContextProvider): () => Promise<Response> {
  return async () => {
    const { pathname } = new URL(request.url);
    if (pathname === '/') return new Response('home');
    if (pathname === '/cart') return html('<p>cart</p>');
    if (pathname === '/admin/users') return html('<p>admin</p>');
    if (pathname === '/page') return html(`<html><head>${scriptTag(context)}</head><body>page</body></html>`);
    if (pathname === '/redirect') return Response.redirect('http://app.test/', 302);
    if (pathname === '/login' && request.method === 'POST') { await track(context, 'login_failed', { user: 'alice@example.com' }); return new Response('no', { status: 401 }); }
    if (pathname === '/boom') throw new Error('boom');   // a downstream middleware threw: the router's error boundary answers 500
    if (pathname === '/away') throw Response.redirect('http://app.test/', 302);   // a downstream middleware threw a redirect
    return new Response('not found', { status: 404 });
  };
}

/** Drives one request through the middleware the way React Router calls it. */
async function call(mw: ReturnType<typeof camada>, path: string, init: RequestInit = {}, peer: string | null = '8.8.8.8'): Promise<Response> {
  const request = new Request(`http://app.test${path}`, init);
  const context = new RouterContextProvider();
  if (peer) context.set(camadaPeerContext, peer);
  const res = (await mw({ request, url: new URL(request.url), pattern: '/', params: {}, context }, app(request, context))) as Response;
  await settle();
  return res;
}

const opts = (extra: CamadaRemixOptions = {}): CamadaRemixOptions => ({ env: ENV, fetchImpl, ...extra });

/** The first request is cold (fail open) and loads the snapshot; the second sees it. */
async function primed(extra: CamadaRemixOptions = {}): Promise<ReturnType<typeof camada>> {
  const mw = camada(opts(extra));
  await call(mw, '/'); await call(mw, '/');
  events.length = 0;
  return mw;
}

const nonceOf = (page: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(page)![1];
const solve = (nonce: string): string => {
  for (let n = 0; ; n++) if (createHash('sha256').update(`${nonce}.${n}`).digest('hex').startsWith('0000')) return String(n);
};
const postBeacon = (mw: ReturnType<typeof camada>, body: string, peer = '9.9.9.9') =>
  call(mw, '/_cam/fp', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, peer);

beforeEach(() => { events = []; sdkHeaders = []; });
afterEach(() => { resetCamada(); vi.unstubAllEnvs(); });

describe('capture', () => {
  it('ships the event with the real status, the remix tap and the sdk header', async () => {
    const mw = await primed();
    expect((await call(mw, '/')).status).toBe(200);
    expect((await call(mw, '/nope')).status).toBe(404);
    expect(events.find((e) => e.p === '/')).toMatchObject({ tap: 'sdk-remix', st: 200, ip: '8.8.8.8' });
    expect(events.find((e) => e.p === '/nope')).toMatchObject({ st: 404 });
    expect(sdkHeaders.length).toBeGreaterThan(0);
    expect(sdkHeaders.every((h) => h === '@camada/remix/0.1.0')).toBe(true);
  });

  it('ships st 500 and rethrows when next() rejects with an error — the router\'s error boundary answers 500', async () => {
    const mw = await primed();
    await expect(call(mw, '/boom', { headers: { cookie: '_sfp=known-sid' } })).rejects.toThrow('boom');
    await settle();
    expect(events).toEqual([expect.objectContaining({ p: '/boom', st: 500, sid: 'known-sid', tap: 'sdk-remix' })]);
  });

  it('ships a thrown Response\'s own status and rethrows it with the session cookie', async () => {
    const mw = await primed();
    const thrown = await call(mw, '/away').then(() => null, (e: unknown) => e as Response);
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown!.status).toBe(302);
    expect(thrown!.headers.get('location')).toBe('http://app.test/');
    expect(thrown!.headers.get('set-cookie')).toContain('_sfp=');
    await settle();
    expect(events).toEqual([expect.objectContaining({ p: '/away', st: 302, ns: 1 })]);
  });

  it('blocks a listed peer with 403 and the block headers before next() runs', async () => {
    const mw = await primed();
    const next = vi.fn(async () => new Response('home'));
    const context = new RouterContextProvider();
    context.set(camadaPeerContext, BLOCKED_IP);
    const request = new Request('http://app.test/');
    const res = (await mw({ request, url: new URL(request.url), pattern: '/', params: {}, context }, next)) as Response;
    await settle();
    expect(res.status).toBe(403);
    expect(res.headers.get('x-block-reason')).toBe('ip4');
    expect(res.headers.get('x-block-version')).toBeTruthy();
    expect(next).not.toHaveBeenCalled();
    expect(events.some((e) => e.st === 403 && e.blk === 'ip4')).toBe(true);
  });
});

describe('challenge', () => {
  it('serves the page for an HTML navigation from the challenged peer', async () => {
    const mw = await primed();
    const page = await call(mw, '/cart', { headers: HTML }, CHALLENGED_IP);
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('name="nonce"');
    expect(events.some((e) => e.st === 403 && e.blk === 'challenge')).toBe(true);
  });

  it('verifies the solution, sets _cch and lets the cookie holder through', async () => {
    const mw = await primed();
    const nonce = nonceOf(await (await call(mw, '/cart', { headers: HTML }, CHALLENGED_IP)).text());
    const ok = await call(mw, '/__camada/challenge', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `nonce=${nonce}&solution=${solve(nonce)}&to=%2Fcart`,
    }, CHALLENGED_IP);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/cart');
    expect(ok.headers.get('set-cookie')).toContain('_cch=');
    expect(events.some((e) => e.st === 200 && e.ch === 1)).toBe(true);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect((await call(mw, '/cart', { headers: { cookie, ...HTML } }, CHALLENGED_IP)).status).toBe(200);
  });
});

describe('first-party beacon', () => {
  it('serves the IIFE at GET /_cam/b.js from the middleware', async () => {
    const mw = await primed();
    const res = await call(mw, '/_cam/b.js?r=abc');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe(iife);
    expect(events).toEqual([]);
  });

  it('relays POST /_cam/fp as a sig:1 row with the server-resolved ip and tap', async () => {
    const mw = await primed();
    const res = await postBeacon(mw, JSON.stringify({ rid: 'abc', tz: 'UTC', ip: '1.1.1.1', tap: 'proxy' }));
    expect(res.status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sig: 1, rid: 'abc', tz: 'UTC', ip: '9.9.9.9', tap: 'sdk-remix' });
  });

  it('camadaRoute() serves the script and the relay where no middleware ran, and 404s the rest', async () => {
    const o = opts();
    await primed(o);   // the route shares this engine: it sees the loaded snapshot at once
    const { loader, action } = camadaRoute(o);
    const args = (request: Request, peer = '9.9.9.9') => {
      const context = new RouterContextProvider();
      context.set(camadaPeerContext, peer);
      return { request, url: new URL(request.url), pattern: '/_cam/*', params: {}, context };
    };
    const script = await loader(args(new Request('http://app.test/_cam/b.js?r=abc')));
    expect(script.status).toBe(200);
    expect(await script.text()).toBe(iife);
    const relay = await action(args(new Request('http://app.test/_cam/fp', { method: 'POST', body: JSON.stringify({ rid: 'abc' }) })));
    expect(relay.status).toBe(204);
    await settle();
    expect(events).toEqual([expect.objectContaining({ sig: 1, rid: 'abc', ip: '9.9.9.9', tap: 'sdk-remix' })]);
    expect((await loader(args(new Request('http://app.test/_cam/other')))).status).toBe(404);
    const blocked = await loader(args(new Request('http://app.test/_cam/b.js'), BLOCKED_IP));
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('x-block-reason')).toBe('ip4');
  });

  it('shares one engine between camada() and camadaRoute() for equal options, whatever their key order', async () => {
    await primed({ scriptPath: '/api/cam/b.js', fpPath: '/api/cam/fp' });
    const { loader } = camadaRoute({ fpPath: '/api/cam/fp', scriptPath: '/api/cam/b.js', fetchImpl, env: { ...ENV } });
    const context = new RouterContextProvider();
    context.set(camadaPeerContext, BLOCKED_IP);
    const request = new Request('http://app.test/api/cam/b.js');
    // A fresh engine would be cold here and fail open; the shared one already holds the snapshot.
    expect((await loader({ request, url: new URL(request.url), pattern: '/api/cam/*', params: {}, context })).status).toBe(403);
  });
});

describe('session', () => {
  it('sets _sfp on a first visit, Secure on https, and never overwrites one', async () => {
    const mw = await primed();
    const first = await call(mw, '/');
    expect(first.headers.get('set-cookie')).toContain('_sfp=');
    expect(first.headers.get('set-cookie')).toContain('HttpOnly');
    expect(first.headers.get('set-cookie')).not.toContain('Secure');
    expect(events.at(-1)).toMatchObject({ ns: 1 });
    const request = new Request('https://app.test/');
    const context = new RouterContextProvider();
    context.set(camadaPeerContext, '8.8.8.8');
    const secure = (await mw({ request, url: new URL(request.url), pattern: '/', params: {}, context }, app(request, context))) as Response;
    expect(secure.headers.get('set-cookie')).toContain('; Secure');
    const known = await call(mw, '/', { headers: { cookie: '_sfp=known-sid' } });
    expect(known.headers.get('set-cookie')).toBeNull();
    expect(events.at(-1)).toMatchObject({ sid: 'known-sid', ns: 0 });
  });

  it('keeps the cookie on a Response.redirect() whose headers are immutable', async () => {
    const mw = await primed();
    const res = await call(mw, '/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://app.test/');
    expect(res.headers.get('set-cookie')).toContain('_sfp=');
  });
});

describe('scriptTag and track', () => {
  it('scriptTag(context) carries the rid of this request\'s event, and is empty without the middleware', async () => {
    const mw = await primed();
    const page = await (await call(mw, '/page')).text();
    const rid = /\?r=([0-9a-f-]{36})"/.exec(page)![1];
    expect(page).toContain('<script src="/_cam/b.js?r=');
    expect(events.find((e) => e.p === '/page')).toMatchObject({ rid, tap: 'sdk-remix' });
    expect(scriptTag(new RouterContextProvider())).toBe('');
  });

  it('track(context) ships an et row joined on rid and sid with the user hashed, and is a no-op without the middleware', async () => {
    const mw = await primed();
    expect((await call(mw, '/login', { method: 'POST', headers: { cookie: '_sfp=known-sid' } })).status).toBe(401);
    const row = events.find((e) => e.et === 'login_failed')!;
    expect(row).toMatchObject({ tap: 'sdk-remix', sid: 'known-sid', ip: '8.8.8.8' });
    expect(row.uid).toMatch(/^[0-9a-f]{32}$/);
    expect(row.rid).toBe(events.find((e) => e.p === '/login')!.rid);
    expect(JSON.stringify(events)).not.toContain('alice');
    events.length = 0;
    await expect(track(new RouterContextProvider(), 'login_failed', { user: 'x' })).resolves.toBeUndefined();
    await settle();
    expect(events).toEqual([]);
  });
});

describe('the host', () => {
  it('takes the peer from camadaPeerContext and resolves to null when nothing is vouched for', async () => {
    const mw = await primed();
    expect((await call(mw, '/', {}, BLOCKED_IP)).status).toBe(403);
    const res = await call(mw, '/admin/users', { headers: HTML }, null);   // a challenge path: no ip, no challenge
    expect(res.status).toBe(200);
    expect(events.at(-1)).toMatchObject({ p: '/admin/users', ip: null });
  });

  it('never takes a client header as the address', async () => {
    const mw = await primed();
    for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'x-real-ip']) {
      expect((await call(mw, '/', { headers: { [h]: BLOCKED_IP } }, null)).status).toBe(200);
      expect((await call(mw, '/', { headers: { [h]: BLOCKED_IP } }, '8.8.8.8')).status).toBe(200);
    }
    expect(events.every((e) => e.ip === null || e.ip === '8.8.8.8')).toBe(true);
  });

  it('honours X-Forwarded-For behind the vouched peer under a trusted-proxy config', async () => {
    const mw = await primed({ env: { ...ENV, CAMADA_TRUSTED_PROXY: 'hops:1' } });
    expect((await call(mw, '/', { headers: { 'x-forwarded-for': BLOCKED_IP } }, '10.1.1.1')).status).toBe(403);
  });

  it('reads its config from process.env when the options carry none', async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    const mw = camada({ fetchImpl });
    await call(mw, '/'); await call(mw, '/');
    expect((await call(mw, '/', {}, BLOCKED_IP)).status).toBe(403);
  });

  it('is inert without a key and with CAMADA_DISABLED=1: next() runs, nothing ships, no slot', async () => {
    for (const o of [{ env: {} }, { env: { ...ENV, CAMADA_DISABLED: '1' } }]) {
      const mw = camada({ fetchImpl, ...o });
      const context = new RouterContextProvider();
      context.set(camadaPeerContext, BLOCKED_IP);
      const request = new Request('http://app.test/');
      const res = (await mw({ request, url: new URL(request.url), pattern: '/', params: {}, context }, app(request, context))) as Response;
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(scriptTag(context)).toBe('');
    }
    await settle();
    expect(events).toEqual([]);
  });

  it('resetCamada() drops every engine this module created', async () => {
    const a = await primed();
    const b = await primed({ challengePath: '/verify-me' });
    resetCamada();
    // Both are cold again: a blocked peer fails open on the first request after the reset.
    expect((await call(a, '/', {}, BLOCKED_IP)).status).toBe(200);
    expect((await call(b, '/', {}, BLOCKED_IP)).status).toBe(200);
    expect((await call(a, '/', {}, BLOCKED_IP)).status).toBe(403);
  });
});
