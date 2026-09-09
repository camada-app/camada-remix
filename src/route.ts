// The resource route for the beacon endpoints (routes.ts: route('/_cam/*', 'routes/cam.tsx')).
// React Router runs middleware only for a matched route, so without a route under /_cam/* the
// root middleware never sees the script or the relay and the router 404s them — the same reason
// @camada/next has camadaRoute(). before() re-runs the verdict, so a blocked client gets its
// 403 here too, and with the root middleware mounted it answers first and this never runs.
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { instanceFor, requestContext, type CamadaRemixOptions } from './camada.js';

type Handler<A> = (args: A) => Promise<Response>;

export function camadaRoute(opts: CamadaRemixOptions = {}): { loader: Handler<LoaderFunctionArgs>; action: Handler<ActionFunctionArgs> } {
  const cam = instanceFor(opts);
  const answer: Handler<LoaderFunctionArgs | ActionFunctionArgs> = async ({ request, context }) => {
    const r = await cam.before(request, requestContext(context));
    return r?.response ?? new Response(null, { status: 404 });   // not a beacon path, or camada inert: nothing to serve
  };
  return { loader: answer, action: answer };
}
