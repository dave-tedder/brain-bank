"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "HOME", char: "~" },
  { href: "/graph", label: "GRAPH", char: "G" },
  { href: "/wiki", label: "WIKI", char: "W" },
  { href: "/projects", label: "PROJ", char: "P" },
  { href: "/thoughts", label: "LOG", char: "T" },
  { href: "/search", label: "FIND", char: "?" },
  { href: "/chat", label: "CHAT", char: ">" },
];

export default function NavBottom() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <nav
      className="md:hidden"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 50,
        background: "rgba(13, 17, 23, 0.9)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderTop: "1px solid var(--border)",
        paddingBottom: "env(safe-area-inset-bottom)",
        display: "flex",
        flexDirection: "row",
      }}
    >
      {TABS.map(({ href, label, char }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 44,
              paddingTop: 8,
              paddingBottom: 8,
              color: active ? "var(--text-primary)" : "var(--text-muted)",
              textDecoration: "none",
              position: "relative",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!active) {
                (e.currentTarget as HTMLAnchorElement).style.color = "var(--text-secondary)";
              }
            }}
            onMouseLeave={(e) => {
              if (!active) {
                (e.currentTarget as HTMLAnchorElement).style.color = "var(--text-muted)";
              }
            }}
          >
            {/* Active indicator dot */}
            {active && (
              <span
                style={{
                  display: "block",
                  width: 4,
                  height: 4,
                  borderRadius: "50%",
                  background: "var(--text-primary)",
                  marginBottom: 4,
                  flexShrink: 0,
                }}
              />
            )}
            {!active && (
              <span style={{ display: "block", width: 4, height: 4, marginBottom: 4, flexShrink: 0 }} />
            )}

            {/* Character */}
            <span
              style={{
                fontFamily: "'VT323', monospace",
                fontSize: "1.25rem",
                lineHeight: 1,
                color: active ? "var(--text-primary)" : "inherit",
              }}
            >
              {char}
            </span>

            {/* Label */}
            <span
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: "9px",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginTop: 2,
                color: active ? "var(--text-primary)" : "inherit",
              }}
            >
              {label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
