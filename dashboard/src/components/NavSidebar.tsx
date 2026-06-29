"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { APP } from "@/config/app";

const NAV_ITEMS = [
  { href: "/", label: "DASHBOARD" },
  { href: "/graph", label: "GRAPH" },
  { href: "/wiki", label: "WIKI" },
  { href: "/projects", label: "PROJECTS" },
  { href: "/tasks", label: "TASKS" },
  { href: "/thoughts", label: "THOUGHTS" },
  { href: "/search", label: "SEARCH" },
  { href: "/clients", label: "CLIENTS" },
  { href: "/audit", label: "AUDIT" },
];

export default function NavSidebar() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  return (
    <nav
      className="hidden md:flex"
      style={{
        width: 220,
        height: "100vh",
        position: "fixed",
        top: 0,
        left: 0,
        background: "var(--bg-surface)",
        borderRight: "1px solid var(--border)",
        flexDirection: "column",
        zIndex: 40,
      }}
    >
      {/* Logo area */}
      <div style={{ padding: "24px 20px", borderBottom: "1px solid var(--border)" }}>
        <div
          className="font-terminal"
          style={{ fontSize: "1.5rem", color: "var(--text-primary)", lineHeight: 1 }}
        >
          {APP.name.toUpperCase()}
        </div>
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.2em",
            color: "var(--text-muted)",
            marginTop: 4,
          }}
        >
          {APP.sidebarSubtitle}
        </div>
      </div>

      {/* Nav items */}
      <div style={{ flex: 1, paddingTop: 8, paddingBottom: 8, overflowY: "auto" }}>
        {NAV_ITEMS.map(({ href, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              style={{
                display: "block",
                padding: "8px 20px",
                fontSize: "0.875rem",
                color: active ? "var(--text-primary)" : "var(--text-muted)",
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                textDecoration: "none",
                transition: "color 0.15s",
                fontFamily: "'VT323', monospace",
                letterSpacing: "0.05em",
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
              <span style={{ color: "var(--text-muted)" }}>{">"} </span>
              {label}
              {active && (
                <span
                  style={{
                    display: "inline-block",
                    marginLeft: 2,
                    animation: "terminalBlink steps(1) 1s infinite",
                  }}
                >
                  _
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Logout */}
      <form
        action="/logout"
        method="POST"
        style={{
          borderTop: "1px solid var(--border)",
          padding: "4px 0",
        }}
      >
        <button
          type="submit"
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "8px 20px",
            fontSize: "0.875rem",
            color: "var(--text-muted)",
            background: "transparent",
            border: "none",
            borderLeft: "2px solid transparent",
            cursor: "pointer",
            fontFamily: "'VT323', monospace",
            letterSpacing: "0.05em",
            transition: "color 0.15s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-secondary)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>{">"} </span>
          LOGOUT
        </button>
      </form>

      {/* Footer */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          padding: "16px 20px",
        }}
      >
        <span
          style={{
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.15em",
            color: "var(--text-muted)",
          }}
        >
          v3.0
        </span>
      </div>
    </nav>
  );
}
