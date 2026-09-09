// Per-request state the middleware leaves on React Router's context for the two helpers an app
// calls from its own loaders and actions: `scriptTag(context)` (the beacon tag) and
// `track(context, event, data)` (an app-context outcome). When the middleware did not run for
// this request (no key, CAMADA_DISABLED, or a request it answered itself) the slot is empty and
// both helpers stand down.
import { createContext, type RouterContextProvider } from 'react-router';
import { guarded } from '@camada/core';
import { track as coreTrack, scriptTag as coreScriptTag, type FetchVars } from '@camada/core/fetch';

// Defaults are null, not undefined: React Router's `get()` throws on a context that has neither
// a value nor a default, and the helpers must stand down silently where the middleware did not run.
/** The vars the middleware kept for this request; null where it did not run. Private to the package: track() and scriptTag() are the API. */
export const camadaContext = createContext<FetchVars | null>(null);

/** The socket address a custom server vouches for (set from `getLoadContext`); null = nothing vouched. */
export const camadaPeerContext = createContext<string | null>(null);

/** Loaders, actions and middleware all receive the same read-only provider. */
export type RouterContext = Readonly<RouterContextProvider>;

const readSlot = (context: RouterContext): FetchVars | undefined => guarded(() => context.get(camadaContext) ?? undefined, undefined);

/**
 * Records an outcome the app knows and the wire cannot show: `login_failed`, `login_succeeded`,
 * `signup`, `password_reset`, `mfa_failed`, `payment_failed`, `payment_succeeded`, `coupon_failed`
 * (free-form; that vocabulary is what the analyst's rules read). Joined to this request's event
 * through its rid and session; the user identifier is HMAC-hashed in-process. Never throws,
 * never rejects, and is a no-op where the middleware did not run.
 */
export const track = (context: RouterContext, event: string, data?: { user?: string }): Promise<void> => coreTrack(readSlot(context), event, data);

/** The `<script>` tag for an HTML response — `''` when camada is off for this request or the tenant turned the beacon off. */
export const scriptTag = (context: RouterContext): string => coreScriptTag(readSlot(context));
