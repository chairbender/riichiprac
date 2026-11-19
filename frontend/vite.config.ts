import { execSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// Use the freshly built WASM package rather than a stale copy in node_modules.
const pkgDir = fileURLToPath(new URL('../pkg', import.meta.url));

/**
 * Serve the content-addressed `.json.gz` pack bodies as raw bytes.
 *
 * The pack loader verifies the body's byte count and SHA-256 against the
 * manifest *before* it gunzips it. Vite's static middleware infers
 * `Content-Encoding: gzip` from the `.gz` extension, so the browser silently
 * decompresses the response and the loader sees a 2 MB JSON document where the
 * manifest promised a 143 KB gzip body. GitHub Pages serves the same file as
 * `application/gzip` with no content-encoding, which is the contract.
 *
 * This middleware runs before Vite's static handler in dev and preview and
 * sends exactly the bytes on disk. A mirror must do the same; see
 * `hosting-plan.md` §7.
 */
function rawScenarioPackBodies(): Plugin {
  const middleware = (dir: string): Connect.NextHandleFunction => (request, response, next) => {
    const path = decodeURIComponent((request.url ?? '').split('?')[0]);
    const prefix = '/scenarios/';
    if (!path.startsWith(prefix) || !path.endsWith('.json.gz')) {
      next();
      return;
    }
    const name = path.slice(prefix.length);
    if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
      next();
      return;
    }
    const file = join(dir, name);
    if (!existsSync(file)) {
      next();
      return;
    }
    response.setHeader('Content-Type', 'application/gzip');
    response.setHeader('Content-Length', String(statSync(file).size));
    response.setHeader('Cache-Control', 'no-cache');
    createReadStream(file).pipe(response);
  };
  return {
    name: 'raw-scenario-pack-bodies',
    enforce: 'pre',
    configureServer(server) {
      // Dev serves `public/` directly.
      server.middlewares.use(
        middleware(join(server.config.root, 'public', 'scenarios')),
      );
    },
    configurePreviewServer(server) {
      // Preview serves the built artifact, not `public/`.
      server.middlewares.use(
        middleware(
          resolve(server.config.root, server.config.build.outDir, 'scenarios'),
        ),
      );
    },
  };
}

function buildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

/**
 * Asset base path. Precedence:
 *   1. `VITE_BASE_PATH` (explicit override, e.g. for a different Pages path)
 *   2. `/riichiprac/` when building inside GitHub Actions (project Pages URL
 *      https://chairbender.github.io/riichiprac/)
 *   3. `/` for local dev/preview, so `npm run dev` needs no env vars.
 */
function basePath(): string {
  const explicit = process.env.VITE_BASE_PATH;
  const base = explicit || (process.env.GITHUB_ACTIONS ? '/riichiprac/' : '/');
  return base.endsWith('/') ? base : `${base}/`;
}

/**
 * Extra `Host` headers the dev server accepts.
 *
 * Vite 5.4.12+ rejects any request whose `Host` is not `localhost`, an IP
 * literal or a value listed in `server.allowedHosts` — a DNS-rebinding
 * guard. Reaching the dev server from another device (a phone on the LAN, a
 * Tailscale peer that uses this machine's name rather than its IP) therefore
 * fails with "Blocked request" until that name is allowed. Keep the list out of
 * the repo: set it for one run.
 *
 *   VITE_DEV_ALLOWED_HOSTS=cachyos-x8664,box.tail1234.ts.net npm run dev -- --host 100.x.y.z
 *
 * Unset means Vite's default (localhost and IP literals only).
 */
function devAllowedHosts(): string[] | undefined {
  const raw = process.env.VITE_DEV_ALLOWED_HOSTS;
  if (!raw) return undefined;
  const hosts = raw
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '');
  return hosts.length > 0 ? hosts : undefined;
}

// https://vite.dev/config/
export default defineConfig({
  // Consumers of `import.meta.env.BASE_URL` (the same-origin weights fallback in
  // services/weightLoader.ts) automatically follow this value.
  base: basePath(),
  // WASM MIME story: vite-plugin-wasm emits `riichiprac_bg.wasm` as a standalone
  // hashed file under `assets/` (far above Vite's 4 kB inline limit, so it is
  // never base64-inlined). GitHub Pages serves `.wasm` as `application/wasm`
  // from its built-in MIME table and does not allow custom response headers, so
  // a `_headers` file would be inert - none is added. `src/wasm.ts` passes the
  // emitted URL to wasm-bindgen's `init`, which falls back to
  // `WebAssembly.instantiate(await response.arrayBuffer())` if streaming
  // instantiation is rejected, so a wrong MIME only costs speed.
  plugins: [rawScenarioPackBodies(), react(), wasm(), topLevelAwait()],
  build: {
    /*
     * Spelled out even though it is Vite's default: the top-level-await plugin
     * reads `build.minify` in its own `config` hook, before Vite applies that
     * default, and a swallowed `undefined` leaves every chunk it rewrites
     * unminified. A chunk that contains a dynamic import is always rewritten
     * (the 3D lazy chunk, from unit 3D-02), so the entry would otherwise grow
     * by the minifier's whole share. Do not remove without re-measuring the
     * entry chunk.
     */
    minify: 'esbuild',
  },
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      riichiprac: pkgDir,
    },
  },
  server: {
    fs: {
      allow: ['..'],
    },
    allowedHosts: devAllowedHosts(),
  },
  optimizeDeps: {
    exclude: ['riichiprac'],
  },
});
