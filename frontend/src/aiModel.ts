/**
 * Name of the Mortal weights file, used in reports and the AI panel.
 *
 * The URL the file is fetched from is resolved at runtime by
 * `services/weightLoader.ts`; this module stays dependency-free so report code
 * can import the id without pulling in the loader.
 */
export const AI_MODEL_ID = 'mortal_298k.safetensors';
