/// <reference types="vite/client" />

/** Short git SHA injected by `vite.config.ts` at build time. */
declare const __BUILD_COMMIT__: string;

/** ISO timestamp injected by `vite.config.ts` at build time. */
declare const __BUILD_TIME__: string;

interface ImportMetaEnv {
  /**
   * Optional build-time override for the Mortal weights URL. Takes precedence
   * over the Hugging Face / GitHub Release / same-origin sources in
   * `services/weightLoader.ts`.
   */
  readonly VITE_WEIGHTS_URL?: string;
  /**
   * Optional build-time override for the scenario-pack manifest URL
   * (`services/packLoader.ts`). Defaults to the same-origin
   * `scenarios/manifest.json`.
   */
  readonly VITE_PACK_MANIFEST_URL?: string;
  /**
   * Optional mirror for content-addressed pack bodies, for example
   * `https://mirror.example/scenarios/`. The manifest stays same-origin and the
   * mirror is only tried after the same-origin body fails.
   */
  readonly VITE_PACK_MIRROR_URL?: string;
}
