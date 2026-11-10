/** Name of the Mortal weights file, used in reports and the AI panel. */
export const AI_MODEL_ID = 'mortal_298k.safetensors';

/** URL served by Vite from `frontend/public/models/`. */
export const WEIGHTS_URL = `${import.meta.env.BASE_URL}models/${AI_MODEL_ID}`;
