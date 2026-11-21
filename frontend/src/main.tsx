import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { MeldPreview } from './renderers/MeldPreview.tsx'
import { parseRendererQuery } from './renderers/capabilities.ts'

/*
 * `?preview=melds` swaps the whole app for the deterministic meld-layout board
 * (task 261120-2225). It is checked here rather than in `App` so the preview
 * does not boot the game, the WASM package or the pack manifest: it is a pure
 * composition review page. `?preview=sticks` stays an `App`-level modifier of a
 * real hand, which is why only `melds` is handled at the entry point.
 */
const preview = parseRendererQuery(window.location.search).preview

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {preview === 'melds' ? <MeldPreview /> : <App />}
  </StrictMode>,
)
