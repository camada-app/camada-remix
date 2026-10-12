// camada-all-wjln: a client-side navigation in React Router fetches `<path>.data` (or `/_.data` for
// a path ending in `/`). A 403 there is thrown into the route's error boundary
// (react-router 8.3.1 dom/ssr/single-fetch.js:242), so the visitor never meets the challenge. A
// challenged data request is answered in React Router's own single-fetch redirect form instead:
// 204 + X-Remix-Redirect + X-Remix-Reload-Document: true, which the client decodes into a
// document navigation (single-fetch.js:243-250 → router.js startRedirectNavigation:
// window.location.assign). The document request then gets the HTML challenge page.
import { describe, it, expect, afterEach } from 'vitest';
import { resetCamada } from '../src/index.js';
import { readmeApp, CHALLENGED_PATH, DATA, HTML } from './rr-harness.js';

afterEach(() => resetCamada());

const CHALLENGED_IP = '192.0.2.20';   // golden v4: challenge side for every path

describe('challenged navigation data requests (camada-all-wjln)', () => {
  it('answers /<path>.data with a reload-document redirect to the same page', async () => {
    const h = await readmeApp();
    const res = await h(new Request(`http://app.test${CHALLENGED_PATH}.data`, { headers: DATA }));
    expect(res.status).toBe(204);
    expect(res.headers.get('x-remix-redirect')).toBe(CHALLENGED_PATH);
    expect(res.headers.get('x-remix-reload-document')).toBe('true');
    expect(res.headers.get('x-remix-status')).toBe('302');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });

  it('keeps the query, drops _routes', async () => {
    const h = await readmeApp();
    const res = await h(new Request(`http://app.test${CHALLENGED_PATH}.data?_routes=root,routes/admin&page=2`, { headers: DATA }));
    expect(res.headers.get('x-remix-redirect')).toBe(`${CHALLENGED_PATH}?page=2`);
  });

  it('maps /_.data back to the path ending in /', async () => {
    const h = await readmeApp();
    const res = await h(new Request('http://app.test/_.data', { headers: DATA }), CHALLENGED_IP);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-remix-redirect')).toBe('/');
  });

  it('the document request it reloads into gets the HTML challenge page', async () => {
    const h = await readmeApp();
    const res = await h(new Request(`http://app.test${CHALLENGED_PATH}`, { headers: HTML }));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('an API/fetch request from app code still gets the 403 JSON', async () => {
    const h = await readmeApp();
    const res = await h(new Request('http://app.test/api/thing', { headers: { accept: 'application/json' } }), CHALLENGED_IP);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.text()).toBe('{"error":"challenge_required"}');
  });

  it('an unchallenged data request is the app\'s own single-fetch answer', async () => {
    const h = await readmeApp();
    const res = await h(new Request('http://app.test/_.data', { headers: DATA }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-remix-redirect')).toBeNull();
  });

  it('with a basename, strips it before X-Remix-Redirect: the client puts it back (R4-3)', async () => {
    const h = await readmeApp({ basename: '/app' });
    const res = await h(new Request(`http://app.test/app${CHALLENGED_PATH}.data`, { headers: DATA }), CHALLENGED_IP);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-remix-redirect')).toBe(CHALLENGED_PATH);
    const root = await h(new Request('http://app.test/app/_.data', { headers: DATA }), CHALLENGED_IP);
    expect(root.headers.get('x-remix-redirect')).toBe('/');
  });

  it('a challenged non-GET .data (fetcher.submit, <Form action>) reloads the page it came from, not the data URL (R4-4)', async () => {
    const h = await readmeApp();
    const post = (headers: Record<string, string>) => h(new Request('http://app.test/api/thing.data', {
      method: 'POST', headers: { ...DATA, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'a=1',
    }), CHALLENGED_IP);
    const res = await post({ referer: `http://app.test${CHALLENGED_PATH}?tab=2` });
    expect(res.status).toBe(204);
    expect(res.headers.get('x-remix-redirect')).toBe(`${CHALLENGED_PATH}?tab=2`);
    // No Referer, or one from another origin: the data path is all there is.
    expect((await post({})).headers.get('x-remix-redirect')).toBe('/api/thing');
    expect((await post({ referer: 'https://evil.test/phish' })).headers.get('x-remix-redirect')).toBe('/api/thing');
  });

  it('a non-GET under a basename takes the Referer path without the basename', async () => {
    const h = await readmeApp({ basename: '/app' });
    const res = await h(new Request('http://app.test/app/api/thing.data', {
      method: 'POST', headers: { ...DATA, referer: `http://app.test/app${CHALLENGED_PATH}` }, body: 'a=1',
    }), CHALLENGED_IP);
    expect(res.headers.get('x-remix-redirect')).toBe(CHALLENGED_PATH);
  });
});
