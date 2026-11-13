/**
 * The isometric (Tenhou-style) table view.
 *
 * Part 0 of the isometric chain only stands this in for the real table: the
 * persisted `view` setting can already be switched to `isometric`, and this
 * component is what mounts until the projection, seats, rivers, and compass are
 * built. Keeping the mount point named for the finished view means the later
 * parts replace the body here without touching `App`.
 */
export function IsometricTable() {
  return (
    <section
      className="isometric-placeholder"
      aria-label="Isometric table view, experimental"
    >
      <h2 className="isometric-placeholder-title">
        <span>Isometric table</span>
        <span className="isometric-placeholder-badge">Experimental</span>
      </h2>
      <p className="isometric-placeholder-text">
        The Tenhou-style isometric table is still being built. Your view choice
        is saved across reloads; this panel stands in for the table until it
        lands. Switch View back to Stacked or Top-down to see the current
        table.
      </p>
    </section>
  );
}
