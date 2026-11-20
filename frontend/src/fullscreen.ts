/**
 * Leaving full screen (3D-14).
 *
 * The full-screen toggle (`components/FullscreenButton.tsx`) is the only thing
 * that *enters* full screen, and it stays unmounted until the 3D HUD shell
 * lands (3D-H2). This helper is the other half: leaving. App calls it when the
 * user switches away from the 3D stage, so a full-screen 3D table can never
 * strand them in a full-screen 2D layout, and the toggle uses the same path.
 *
 * Kept out of the component file so that module exports only components (the
 * repo's react-refresh rule) and so the behaviour is testable in Node.
 */

/**
 * Leave full screen if the document is in it.
 *
 * A refusal is not an error the table should report, and a document without the
 * API (jsdom, an older browser) is simply not full screen. `doc` is injectable
 * for tests.
 */
export function exitFullscreenIfActive(
  doc: Document | null = typeof document === 'undefined' ? null : document,
): void {
  if (!doc?.fullscreenElement) return;
  try {
    const request = doc.exitFullscreen?.();
    if (request && typeof request.catch === 'function') {
      void request.catch(() => undefined);
    }
  } catch {
    // A document that refuses to leave full screen still switches views.
  }
}
