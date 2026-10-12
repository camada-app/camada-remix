// The README's custom Express server with helmet mounted in front of React Router's handler.
// @react-router/express copies the Response's headers with `res.append`, so a policy helmet already
// set and the challenge page's own one would both go out, and the stricter one blocks the solver.
// Passing `res` through `camadaResponseContext` lets camada clear what its answer replaces (R7-2).
import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import express from 'express';
import helmet from 'helmet';
import { createRequestHandler } from '@react-router/express';
import { RouterContextProvider } from 'react-router';
import { camadaPeerContext, camadaResponseContext, resetCamada } from '../src/index.js';
import { readmeBuild, CHALLENGED_PATH, HTML } from './rr-harness.js';

const PORT = 8835;
let server: Server | null = null;
afterEach(async () => { await new Promise((r) => (server ? server.close(r) : r(null))); server = null; resetCamada(); });

async function start(passRes: boolean): Promise<void> {
  const app = express();
  app.use(helmet());
  app.use(createRequestHandler({
    build: readmeBuild(),
    getLoadContext(req, res) {
      const context = new RouterContextProvider();
      context.set(camadaPeerContext, req.socket.remoteAddress ?? null);
      if (passRes) context.set(camadaResponseContext, res);
      return context;
    },
  }));
  await new Promise<void>((r) => { server = app.listen(PORT, '127.0.0.1', () => r()); });
}

/** Raw header lines, so two CSP headers are not folded into one as fetch's Headers would. */
const get = (path: string, headers: Record<string, string> = {}): Promise<{ status: number; raw: string[]; body: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d) => (body += d)).on('end', () => resolve({ status: res.statusCode!, raw: res.rawHeaders, body }));
    });
    req.on('error', reject).end();
  });
const all = (raw: string[], name: string) => raw.filter((_, i) => i % 2 === 0 && raw[i]!.toLowerCase() === name).map((_, i, a) => a[i]!);
const values = (raw: string[], name: string) => raw.flatMap((v, i) => (i % 2 === 1 && raw[i - 1]!.toLowerCase() === name ? [v] : []));

async function warm(): Promise<void> {
  await get('/');   // cold: loads the snapshot
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('Express + helmet in front of @react-router/express (R7-2)', () => {
  it('with camadaResponseContext, a challenged GET carries exactly one CSP header: the page one', async () => {
    await start(true);
    await warm();
    const page = await get(CHALLENGED_PATH, HTML);
    expect(page.status).toBe(403);
    expect(page.body).toContain('<script>');
    const csp = values(page.raw, 'content-security-policy');
    expect(csp).toHaveLength(1);
    expect(csp[0]).toMatch(/^default-src 'none'; script-src 'sha256-/);
    expect(values(page.raw, 'content-security-policy-report-only')).toHaveLength(0);
    expect(values(page.raw, 'cache-control')).toEqual(['no-store']);
    expect(all(page.raw, 'x-frame-options')).toHaveLength(1);   // helmet's other headers stay
    const ok = await get('/', HTML);
    expect(ok.status).toBe(200);
    expect(values(ok.raw, 'content-security-policy')[0]).toContain("default-src 'self'");   // the app's own pages keep helmet's policy
  });

  it('without it, both policies go out (what the README warns about)', async () => {
    await start(false);
    await warm();
    const page = await get(CHALLENGED_PATH, HTML);
    expect(page.status).toBe(403);
    expect(values(page.raw, 'content-security-policy')).toHaveLength(2);
  });
});
