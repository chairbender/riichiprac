interface KanIconProps {
  className?: string;
}

/**
 * Added-Kan marker: three upright tiles from the existing Pon with the fourth
 * tile laid across them.
 */
export function KanIcon({ className }: KanIconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 36"
      role="img"
      aria-label="Added Kan"
      focusable="false"
    >
      <rect
        x="2"
        y="2"
        width="20"
        height="32"
        rx="3"
        fill="#f8f9fa"
        stroke="#c7cdd6"
        strokeWidth="1"
      />
      <rect
        x="24"
        y="2"
        width="20"
        height="32"
        rx="3"
        fill="#f8f9fa"
        stroke="#c7cdd6"
        strokeWidth="1"
      />
      <rect
        x="46"
        y="2"
        width="20"
        height="32"
        rx="3"
        fill="#f8f9fa"
        stroke="#c7cdd6"
        strokeWidth="1"
      />
      <rect
        x="66"
        y="10"
        width="32"
        height="16"
        rx="3"
        fill="#f59f00"
        stroke="#e67700"
        strokeWidth="1"
      />
    </svg>
  );
}
