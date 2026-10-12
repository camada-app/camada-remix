#!/usr/bin/env bash
# Builds a minimal React Router app whose route module is the one in README.md (extracted from the
# `// app/routes/cam.tsx` block, so the two cannot drift) with `react-router build` (camada-all-xms0:
# `export const { loader, action } = camadaRoute()` fails that build). Needs network (npm install)
# and `npm run build` done first. Usage: scripts/readme-build-check.sh [workdir]
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK/app/routes" && cd "$WORK"
[ -f "$PKG/dist/index.js" ] || { echo "build @camada/remix first (npm run build)" >&2; exit 2; }

# The route module, verbatim from the README.
node -e '
const fs=require("fs");const md=fs.readFileSync(process.argv[1],"utf8");
const m=/```ts\n\/\/ app\/routes\/cam\.tsx\n([\s\S]*?)```/.exec(md);
if(!m){console.error("README has no app/routes/cam.tsx block");process.exit(3)}
fs.writeFileSync("app/routes/cam.tsx",m[1]);' "$PKG/README.md"
echo "--- app/routes/cam.tsx (from README) ---"; cat app/routes/cam.tsx

cat > package.json <<JSON
{ "name": "readme-build-check", "private": true, "type": "module",
  "dependencies": { "@camada/remix": "file:$PKG", "@react-router/node": "^8.3.1", "isbot": "^5.1.0",
    "react": "^19.1.0", "react-dom": "^19.1.0", "react-router": "^8.3.1" },
  "devDependencies": { "@react-router/dev": "^8.3.1", "vite": "^7.0.0" } }
JSON
cat > react-router.config.ts <<'TS'
export default { ssr: true, basename: '/app' };
TS
cat > vite.config.ts <<'TS'
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [reactRouter()], ssr: { external: ['@camada/remix'] }, resolve: { dedupe: ['react', 'react-dom', 'react-router'] } });
TS
cat > app/routes.ts <<'TS'
import { type RouteConfig, index, route } from '@react-router/dev/routes';
export default [index('routes/home.tsx'), route('/_cam/*', 'routes/cam.tsx')] satisfies RouteConfig;
TS
cat > app/root.tsx <<'TSX'
import { Outlet } from 'react-router';
import { camada } from '@camada/remix';
export const middleware = [camada({ basename: '/app' })];
export default function App() { return <Outlet />; }
TSX
cat > app/routes/home.tsx <<'TSX'
export default function Home() { return <h1>home</h1>; }
TSX

npm install --no-audit --no-fund --loglevel=error
npx react-router build
test -f build/server/index.js && echo "OK: react-router build produced build/server/index.js"
