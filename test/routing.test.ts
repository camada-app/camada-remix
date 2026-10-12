// camada-all-zhoc: with the README's route table, React Router runs middleware only for matched
// routes, so the challenge form must post somewhere a route matches. The default challengePath
// sits under the beacon route's directory (`/_cam/challenge`), which camadaRoute() answers.
// Driven through React Router's real createRequestHandler, not the middleware directly.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resetCamada } from '../src/index.js';
import { readmeApp, CHALLENGED_PATH, HTML } from './rr-harness.js';

afterEach(() => { resetCamada(); vi.restoreAllMocks(); });

const nonceOf = (page: string) => /name="nonce" value="([0-9a-f]{32})"/.exec(page)![1];
const actionOf = (page: string) => /<form[^>]*action="([^"]+)"/.exec(page)![1];
const solve = (nonce: string): string => {
  for (let n = 0; ; n++) if (createHash('sha256').update(`${nonce}.${n}`).digest('hex').startsWith('0000')) return String(n);
};
const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://app.test' };
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});   // React Router logs "No route matches" for a 404

describe('challenge verify through React Router routing (camada-all-zhoc)', () => {
  it('the page posts to /_cam/challenge, under the README beacon route', async () => {
    const h = await readmeApp();
    const page = await h(new Request(`http://app.test${CHALLENGED_PATH}`, { headers: HTML }));
    expect(page.status).toBe(403);
    expect(actionOf(await page.text())).toBe('/_cam/challenge');
  });

  it('a wrong solution reaches camada: 403 page re-issued, not the app 404', async () => {
    const h = await readmeApp();
    const res = await h(new Request('http://app.test/_cam/challenge', { method: 'POST', headers: FORM, body: 'nonce=x&solution=y&to=%2F' }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('name="nonce"');
  });

  it('a solved challenge 302s with _cch and the next request passes', async () => {
    const h = await readmeApp();
    const page = await (await h(new Request(`http://app.test${CHALLENGED_PATH}`, { headers: HTML }))).text();
    const nonce = nonceOf(page);
    const body = `nonce=${nonce}&solution=${solve(nonce)}&to=${encodeURIComponent(CHALLENGED_PATH)}`;
    const ok = await h(new Request(`http://app.test${actionOf(page)}`, { method: 'POST', headers: FORM, body }));
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe(CHALLENGED_PATH);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toMatch(/^_cch=/);
    const after = await h(new Request(`http://app.test${CHALLENGED_PATH}`, { headers: { ...HTML, cookie } }));
    expect(after.status).toBe(200);
  });

  it('the old default /__camada/challenge has no route: React Router 404s it before camada runs', async () => {
    quiet();
    const h = await readmeApp();
    const res = await h(new Request('http://app.test/__camada/challenge', { method: 'POST', headers: FORM, body: 'nonce=x&solution=y&to=%2F' }));
    expect(res.status).toBe(404);
  });

  it('a custom scriptPath moves the default challenge path into its directory', async () => {
    const h = await readmeApp({ scriptPath: '/api/cam/b.js', fpPath: '/api/cam/fp' });
    const page = await (await h(new Request(`http://app.test${CHALLENGED_PATH}`, { headers: HTML }))).text();
    expect(actionOf(page)).toBe('/api/cam/challenge');
    const res = await h(new Request('http://app.test/api/cam/challenge', { method: 'POST', headers: FORM, body: 'nonce=x&solution=y&to=%2F' }));
    expect(res.status).toBe(403);
  });

  it('an explicit challengePath is kept', async () => {
    const h = await readmeApp({ challengePath: '/_cam/verify' });
    const page = await (await h(new Request(`http://app.test${CHALLENGED_PATH}`, { headers: HTML }))).text();
    expect(actionOf(page)).toBe('/_cam/verify');
  });
});

describe('basename moves the default endpoints under it (camada-all-xms0)', () => {
  const base = '/app';
  const FULL = `${base}/`;
  const IP = '192.0.2.20';   // golden v4: challenge side for every path

  it('the challenge form posts under the basename and a solve passes', async () => {
    const h = await readmeApp({ basename: base });
    const page = await h(new Request(`http://app.test${FULL}`, { headers: HTML }), IP);
    expect(page.status).toBe(403);
    const html = await page.text();
    expect(actionOf(html)).toBe('/app/_cam/challenge');
    const nonce = nonceOf(html);
    const body = `nonce=${nonce}&solution=${solve(nonce)}&to=${encodeURIComponent(FULL)}`;
    const ok = await h(new Request(`http://app.test${actionOf(html)}`, { method: 'POST', headers: FORM, body }), IP);
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe(FULL);
    const cookie = ok.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toMatch(/^_cch=/);
    expect((await h(new Request(`http://app.test${FULL}`, { headers: { ...HTML, cookie } }), IP)).status).toBe(200);
  });

  it('serves the beacon script and relay under the basename, and not outside it', async () => {
    quiet();
    const h = await readmeApp({ basename: base });
    expect((await h(new Request('http://app.test/app/_cam/b.js'))).status).toBe(200);
    expect((await h(new Request('http://app.test/_cam/b.js'))).status).toBe(404);
  });

  it('a .data navigation still gets the 204 redirect, basename not doubled', async () => {
    const h = await readmeApp({ basename: base });
    const res = await h(new Request(`http://app.test${base}/_.data`, { headers: { accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' } }), IP);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-remix-redirect')).toBe('/');
  });

  it('explicit paths win over the basename defaults', async () => {
    const h = await readmeApp({ basename: base, scriptPath: '/app/x/b.js' });
    const page = await (await h(new Request(`http://app.test${FULL}`, { headers: HTML }), IP)).text();
    expect(actionOf(page)).toBe('/app/x/challenge');
    const g = await readmeApp({ basename: base, challengePath: '/app/_cam/verify' });
    expect(actionOf(await (await g(new Request(`http://app.test${FULL}`, { headers: HTML }), IP)).text())).toBe('/app/_cam/verify');
  });

  it('basename + an explicit scriptPath, no fpPath: the relay sits next to the script, where the browser posts (RF-3)', async () => {
    const h = await readmeApp({ basename: base, scriptPath: '/app/x/b.js' }, 'x/*');   // route /x/* under basename /app
    expect((await h(new Request('http://app.test/app/x/b.js'))).status).toBe(200);
    const res = await h(new Request('http://app.test/app/x/fp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rid: 'r1' }) }));
    expect(res.status).toBe(204);
  });
});
