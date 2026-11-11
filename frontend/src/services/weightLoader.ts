/**
 * Loads the Mortal Safetensors weights at runtime.
 *
 * The file is ~43 MB, so it is not committed. In production CI copies the
 * GitHub Release asset into the build (served same-origin by Pages, no CORS);
 * a Hugging Face mirror is the fallback for deployments that do not do that.
 * The bytes are cached in IndexedDB so a returning visitor downloads nothing.
 *
 * See `hosting-plan.md` for the one-time setup steps and for the URLs.
 *
 * No dependencies: no Cache API, no service worker, no npm packages. Every
 * cache failure is swallowed so that it can never break weight loading.
 */
import { AI_MODEL_ID } from '../aiModel';

/** File name of the weights, shared with the report CLI (`aiModel.ts`). */
export const WEIGHTS_FILENAME = AI_MODEL_ID;

/**
 * Bump when the weights file changes. Part of the IndexedDB key, so a new
 * version invalidates old cached bytes instead of silently reusing them.
 */
export const CACHE_VERSION = 'v1';

const CACHE_KEY = `${WEIGHTS_FILENAME}@${CACHE_VERSION}`;

/**
 * Canonical location of the weights: a GitHub Release asset. This is the file
 * CI downloads and serves same-origin (see `.github/workflows/deploy.yml`).
 *
 * It is deliberately NOT in the browser source list: GitHub release assets send
 * no `access-control-allow-origin` header (verified on both `github.com` and
 * `release-assets.githubusercontent.com`), so a cross-origin `fetch()` from the
 * Pages origin is blocked by CORS. The browser gets the bytes from the
 * same-origin copy below instead.
 */
export const RELEASE_WEIGHTS_URL =
  'https://github.com/chairbender/riichiprac/releases/download/weights-v1/mortal_298k.safetensors';

/**
 * Optional external mirror: a public Hugging Face model repo. HF's `resolve/`
 * endpoint does send `access-control-allow-origin: *`, so this works in the
 * browser. Not published yet — the `chairbender/mortal-weights` repo must be
 * created and the file uploaded once (see "Manual one-time setup" in
 * `hosting-plan.md`), or point `VITE_WEIGHTS_URL` somewhere else.
 */
export const HF_WEIGHTS_URL =
  'https://huggingface.co/chairbender/mortal-weights/resolve/main/mortal_298k.safetensors';

/**
 * Same-origin copy served from `frontend/public/models/`: the primary source in
 * production (CI places the release asset there before building) and in local
 * development (the gitignored file). No CORS involved.
 */
export const LOCAL_WEIGHTS_URL = `${import.meta.env.BASE_URL}models/${WEIGHTS_FILENAME}`;

/** Build-time override: `VITE_WEIGHTS_URL=https://... npm run build`. */
const OVERRIDE_WEIGHTS_URL = import.meta.env.VITE_WEIGHTS_URL;

/** Smallest plausible Safetensors payload; anything shorter is an error page. */
const MIN_WEIGHTS_BYTES = 1024 * 1024;

const DB_NAME = 'riichiprac-weights';
const DB_VERSION = 1;
const STORE_NAME = 'models';

let lastUsedUrl: string | null = null;

/**
 * URL of the most recent successful download, or null when the bytes came from
 * the IndexedDB cache (or nothing loaded yet). Used in error/status messages.
 */
export function getWeightsSource(): string | null {
  return lastUsedUrl;
}

/** The ordered list of URLs `loadWeights` will try, for error messages. */
export function getWeightsUrlList(): string[] {
  return candidateUrls();
}

function candidateUrls(): string[] {
  const urls = [
    OVERRIDE_WEIGHTS_URL,
    // Same origin first: no CORS, and in production CI has already placed the
    // release asset there.
    LOCAL_WEIGHTS_URL,
    HF_WEIGHTS_URL,
  ].filter((url): url is string => typeof url === 'string' && url.length > 0);

  // Deduplicate while keeping order, so an override equal to the primary does
  // not cause a second request.
  return urls.filter((url, index) => urls.indexOf(url) === index);
}

/**
 * Returns the weights bytes, preferring the IndexedDB cache and otherwise
 * downloading from the first source that answers with a valid payload.
 */
export async function loadWeights(): Promise<Uint8Array> {
  const cached = await readCachedWeights();
  if (cached) {
    lastUsedUrl = null;
    return cached;
  }

  const errors: string[] = [];
  for (const url of candidateUrls()) {
    try {
      const bytes = await downloadWeights(url);
      lastUsedUrl = url;
      await writeCachedWeights(bytes);
      return bytes;
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `Could not load the Mortal weights (${WEIGHTS_FILENAME}). ` +
      `Tried:\n${errors.join('\n')}\n` +
      'See hosting-plan.md for the one-time upload steps.',
  );
}

/** Deletes the cached weights; the next `loadWeights` re-downloads them. */
export async function clearWeightCache(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(CACHE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

async function downloadWeights(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  // A GitHub Pages / CDN 404 can come back as HTML with a 200, so never trust
  // the status alone: reject HTML pages and implausibly small payloads.
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    throw new Error('served an HTML page instead of the model file');
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < MIN_WEIGHTS_BYTES) {
    throw new Error(`payload too small (${bytes.byteLength} bytes)`);
  }
  if (bytes[0] === 0x3c /* '<' */) {
    throw new Error('payload is an HTML document');
  }

  return bytes;
}

/* -------------------------------------------------------------------------- */
/* IndexedDB cache                                                            */
/* -------------------------------------------------------------------------- */

function getIndexedDb(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    // Some browsers throw on access in private mode.
    return null;
  }
}

/**
 * Opens the cache database, resolving to null when IndexedDB is unavailable or
 * refuses to open. A version upgrade creates the object store.
 */
function openDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDb();
  if (!factory) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };

    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      finish(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      } catch {
        // A concurrent open may have created it already.
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // A later version upgrade elsewhere would otherwise block this handle.
      db.onversionchange = () => db.close();
      finish(db);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

async function readCachedWeights(): Promise<Uint8Array | null> {
  const db = await openDatabase();
  if (!db) return null;

  try {
    const value = await new Promise<unknown>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(CACHE_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
        tx.onabort = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });

    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (value instanceof Uint8Array) return value;
    return null;
  } finally {
    db.close();
  }
}

async function writeCachedWeights(bytes: Uint8Array): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  try {
    // Copy into a standalone ArrayBuffer: the download's buffer may be a view
    // over a larger allocation, and some browsers refuse to store views.
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(buffer, CACHE_KEY);
        tx.oncomplete = () => resolve();
        // Quota exceeded and friends: the download still succeeded, so ignore.
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } finally {
    db.close();
  }
}
