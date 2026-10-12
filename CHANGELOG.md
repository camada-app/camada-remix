# Changelog

## Unreleased

Needs the `@camada/core` that exports `readBodyCapped` (the streamed body cap on `/_cam/fp` and
the challenge verify, camada-all-4u4i).

### Fixed

- The challenge form posts to `/_cam/challenge` by default (next to a custom `scriptPath`),
  under the README's `/_cam/*` route. The old default `/__camada/challenge` had no route, so
  React Router 404'd the POST before camada ran and a challenged visitor could never pass
  (camada-all-zhoc). An explicit `challengePath` is kept as given.
- A client-side navigation to a challenged route (`<path>.data`) gets React Router's
  reload-document redirect to the same page instead of a `403` JSON that the route's error
  boundary rendered. The document request then shows the challenge. API and `fetch()` calls
  still get the `403` JSON (camada-all-wjln). A challenged non-GET `.data` (`fetcher.submit`,
  `<Form action=/other>`) reloads the same-origin page it came from (its `Referer`) rather than
  a resource route's URL.

### Added

- `basename` option: the app's React Router `basename`. The challenged-navigation redirect goes
  out without it, since the client adds it back (without the option a `/app` app lands on
  `/app/app/page`).

### Docs

- README: the routes camada needs and why, what an unmatched URL means for capture, and the
  no-peer `X-Forwarded-For` walk (trusts the host's edge).

## 0.1.3 (2026-10-09; follows 0.1.2)

Needs `@camada/core` 0.5.1.

### Fixed

- The snapshot client no longer re-polls back to back when `/snapshot` fails. It keeps its blocks and
  waits max(`retry-after`, 5 s), capped at the refresh interval (through `@camada/core` 0.5.1,
  camada-all-pbv9).

## 0.1.2 (2026-10-04; follows 0.1.1)

Needs `@camada/core` 0.5.0.

### Added

- `x-rid` response header: the rid of the request's event row, on every response the app answers,
  via core's `finish()` (a faithful copy when the headers are immutable). Not on camada's own
  answers or a 101.

### Changed

- `ts` is the request start, so `[ts, ts + dur]` is when the request ran.
- `dur` for a `text/event-stream` response runs to its last byte, or until the client leaves.
  Any other response goes out untouched and ships at once, with `dur` = time to first byte.

### Fixed

- Path rules match the canonical path (through `@camada/core` 0.5.0). A percent-encoded,
  upper-cased or trailing-slash spelling of a blocked path used to slip past the block.
