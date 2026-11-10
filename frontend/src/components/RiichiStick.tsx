interface RiichiStickProps {
  className?: string;
}

/**
 * Flat 1000-point Riichi stick marker (white bar with a red center disc).
 */
export function RiichiStick({ className }: RiichiStickProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 24"
      role="img"
      aria-label="Riichi stick"
      focusable="false"
    >
      <rect
        x="1"
        y="4"
        width="98"
        height="16"
        rx="8"
        fill="#f8f9fa"
        stroke="#c7cdd6"
        strokeWidth="1"
      />
      <rect x="8" y="7" width="7" height="10" rx="2" fill="#adb5bd" />
      <rect x="85" y="7" width="7" height="10" rx="2" fill="#adb5bd" />
      <circle cx="50" cy="12" r="5" fill="#e03131" />
    </svg>
  );
}
