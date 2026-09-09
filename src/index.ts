// @camada/remix — the install for a React Router framework-mode (Remix) app:
//   export const middleware = [camada()];              // app/root.tsx; env: CAMADA_KEY (+ CAMADA_INGEST_URL in dev)
//   route('/_cam/*', 'routes/cam.tsx')                 // routes.ts; the file re-exports camadaRoute()
//   scriptTag(context)                                 // in a loader: the first-party beacon tag
//   track(context, 'login_failed', { user })           // in an action: an outcome the wire cannot show
export { camada, resetCamada, type CamadaRemixOptions, type CamadaRemixVars } from './camada.js';
export { camadaRoute } from './route.js';
export { track, scriptTag, camadaPeerContext } from './context.js';
