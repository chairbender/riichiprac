interface PositionDescriptionCardProps {
  /** Free-text context carried by the imported position file. */
  description: string;
  onDismiss: () => void;
}

/**
 * Context attached to an imported position, e.g. why the file was shared or
 * what looks wrong with it. Rendered as plain text: React escapes it, so a
 * description can never inject markup.
 */
export function PositionDescriptionCard({
  description,
  onDismiss,
}: PositionDescriptionCardProps) {
  return (
    <section
      className="position-description"
      aria-label="Imported position description"
    >
      <div className="position-description-header">
        <span className="position-description-title">Position description</span>
        <button
          className="position-description-dismiss"
          type="button"
          onClick={onDismiss}
          title="Hide this description"
        >
          Dismiss
        </button>
      </div>
      <p className="position-description-body">{description}</p>
    </section>
  );
}
