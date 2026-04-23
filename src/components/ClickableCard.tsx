import Link from "next/link";
import { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  href: string;
  stagger?: number;
  children: ReactNode;
}

/**
 * Card with a full-bleed clickable background that still allows nested
 * <Link>s in the children to navigate to their own targets.
 *
 * Pattern: the background <Link> is absolutely positioned to cover the card.
 * The content layer sits above it via z-index and is `pointer-events: none`,
 * so clicks on empty space fall through to the background link. Descendant
 * <a> elements have `pointer-events: auto` re-enabled, so they handle their
 * own clicks.
 *
 * No JS, no event handlers — works as a server component.
 */
export default function ClickableCard({
  title,
  subtitle,
  href,
  stagger = 0,
  children,
}: Props) {
  return (
    <div
      className={`card scanline-hover border-l-2 animate-in stagger-${Math.min(stagger, 8)} relative transition-all duration-200 hover:border-[var(--accent)]`}
      style={{ borderLeftColor: "rgba(0, 255, 65, 0.3)" }}
    >
      {/* Background clickable overlay */}
      <Link
        href={href}
        aria-label={title}
        className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="sr-only">{title}</span>
      </Link>

      {/* Content layer — clicks fall through to the overlay unless they hit
          a descendant <a>, which re-enables pointer events. */}
      <div className="relative z-20 pointer-events-none [&_a]:pointer-events-auto">
        <div className="flex items-baseline justify-between mb-4">
          <h2
            className="font-terminal text-sm uppercase tracking-wider"
            style={{ color: "var(--text-secondary)" }}
          >
            <span style={{ color: "var(--text-muted)" }}>&gt; </span>
            {title}
          </h2>
          {subtitle && (
            <span
              className="text-xs"
              style={{
                color: "var(--text-muted)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {subtitle}
            </span>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
