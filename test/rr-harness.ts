// A ServerBuild with the README's route table (root middleware = [camada()], an index route, the
// /admin/users page, `/_cam/*` → camadaRoute(), and an /api/thing resource route), driven through
// React Router's real createRequestHandler — so routing, not just the middleware, is exercised.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router';
import { camada, camadaRoute, camadaPeerContext, type CamadaRemixOptions } from '../src/index.js';
import { inScriptDir } from '../src/camada.js';

const FIX = fileURLToPath(new URL('../node_modules/@camada/core/test/fixtures/blk3/', import.meta.url));
const meta = readFileSync(FIX + 'v4-basic.meta.json');
const bin = readFileSync(FIX + 'v4-basic.bin');
const CONFIG = { tenant: 'acme', beacon: true, sample: 1, exclude: [], trusted_proxy: { mode: 'none' }, poll_seconds: 30 };

export const CHALLENGED_PATH = '/admin/users';   // golden v4: /admin/ is on the challenge side for every ip
export const HTML = { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
export const DATA = { accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' };   // what the client router's fetch sends

const fetchImpl = (async (url: string | URL | Request) => {
  if (!String(url).endsWith('/snapshot')) return new Response(null, { status: 202 });
  const f = new Uint8Array(4 + meta.length + bin.length);
  new DataView(f.buffer).setUint32(0, meta.length, true);
  f.set(meta, 4); f.set(bin, 4 + meta.length);
  return new Response(f, { status: 200, headers: { etag: '"v4"', 'x-camada-config': JSON.stringify(CONFIG) } });
}) as typeof fetch;

export type Handler = (req: Request, peer?: string) => Promise<Response>;

/** The README's app, with `extra` camada options on both the middleware and the route. */
export async function readmeApp(extra: CamadaRemixOptions = {}): Promise<Handler> {
  const handler = createRequestHandler(readmeBuild(extra), 'production');
  const h: Handler = async (req, peer = '8.8.8.8') => {
    const c = new RouterContextProvider();
    c.set(camadaPeerContext, peer);
    return handler(req, c);
  };
  await h(new Request(`http://app.test${extra.basename ?? ''}/`));   // cold: loads the snapshot
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  return h;
}

/** The README's ServerBuild, for a host that brings its own request handler (an Express server). */
export function readmeBuild(extra: CamadaRemixOptions = {}): ServerBuild {
  const opts: CamadaRemixOptions = { env: { CAMADA_KEY: 'tok-acme.snap-acme', CAMADA_INGEST_URL: 'http://analyst.test', CAMADA_SNAPSHOT_URL: 'http://analyst.test/snapshot' }, fetchImpl, ...extra };
  const cam = camadaRoute(opts);
  const camDir = inScriptDir(extra.scriptPath, '*');
  const build = {
    entry: { module: { default: (_req: Request, status: number, headers: Headers) => new Response(`app document, status ${status}`, { status, headers }) } },
    routes: {
      root: { id: 'root', path: '', module: { middleware: [camada(opts)], default: () => null } },
      'routes/home': { id: 'routes/home', parentId: 'root', index: true, module: { default: () => null, loader: () => ({ home: true }) } },
      'routes/admin': { id: 'routes/admin', parentId: 'root', path: 'admin/users', module: { default: () => null, loader: () => ({ users: [] }) } },
      'routes/api': { id: 'routes/api', parentId: 'root', path: 'api/thing', module: { loader: () => Response.json({ ok: true }) } },
      'routes/cam': { id: 'routes/cam', parentId: 'root', path: camDir, module: { loader: cam.loader, action: cam.action } },
    },
    assets: { routes: {}, entry: { module: '/e.js', imports: [] }, url: '/m.js', version: '1' },
    publicPath: '/', assetsBuildDirectory: '/tmp', future: {}, ssr: true, isSpaMode: false, prerender: [],
    ...(extra.basename ? { basename: extra.basename } : {}),   // react-router.config.ts `basename`, as the build carries it
    routeDiscovery: { mode: 'lazy', manifestPath: '/__manifest' },
  } as unknown as ServerBuild;
  return build;
}
