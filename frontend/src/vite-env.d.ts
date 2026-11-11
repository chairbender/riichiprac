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
}
