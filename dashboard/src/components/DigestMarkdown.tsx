"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ClientLink {
  name: string;
  id: string;
}

interface Props {
  markdown: string;
  clientLinks?: ClientLink[];
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function linkifyClients(md: string, links: ClientLink[]): string {
  if (!links.length) return md;

  const sorted = [...links].sort((a, b) => b.name.length - a.name.length);
  let out = md;

  for (const link of sorted) {
    const name = link.name.trim();
    if (!name) continue;
    const pattern = new RegExp(
      `(?<![\\w\\[])${escapeRegex(name)}(?![\\w\\]])`,
      "gi"
    );
    out = out.replace(pattern, (match) => `[${match}](/clients/${link.id})`);
  }

  return out;
}

export default function DigestMarkdown({ markdown, clientLinks = [] }: Props) {
  const processed = linkifyClients(markdown, clientLinks);

  return (
    <div className="digest-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h2
              className="font-terminal text-2xl uppercase mt-6 mb-3 first:mt-0 text-glow"
              style={{ color: "var(--text-primary)" }}
            >
              <span style={{ color: "var(--text-muted)" }}># </span>
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3
              className="font-terminal text-xl uppercase mt-5 mb-2"
              style={{ color: "var(--text-primary)" }}
            >
              <span style={{ color: "var(--text-muted)" }}># </span>
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4
              className="font-terminal text-lg uppercase mt-4 mb-2"
              style={{ color: "var(--text-secondary)" }}
            >
              <span style={{ color: "var(--text-muted)" }}># </span>
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p
              className="mb-3 leading-relaxed text-sm"
              style={{
                color: "var(--text-body)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul
              className="mb-3 ml-1 space-y-1 text-sm list-none"
              style={{
                color: "var(--text-body)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className="mb-3 ml-4 space-y-1 text-sm list-decimal"
              style={{
                color: "var(--text-body)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed flex gap-2">
              <span
                style={{ color: "var(--text-muted)" }}
                aria-hidden="true"
              >
                ├─
              </span>
              <span className="flex-1">{children}</span>
            </li>
          ),
          strong: ({ children }) => (
            <strong
              style={{ color: "var(--text-primary)", fontWeight: 600 }}
            >
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
              {children}
            </em>
          ),
          a: ({ href, children }) => {
            const isClientRef =
              typeof href === "string" && href.startsWith("/clients/");
            if (isClientRef) {
              const label =
                typeof children === "string"
                  ? children
                  : Array.isArray(children)
                    ? children.join("")
                    : children;
              return (
                <a
                  href={href}
                  className="inline-block px-1.5 py-0.5 mx-0.5 rounded text-[11px] transition-colors"
                  style={{
                    background: "var(--accent-dim)",
                    border: "1px solid var(--border)",
                    color: "var(--text-primary)",
                    fontFamily: "'IBM Plex Mono', monospace",
                  }}
                >
                  <span style={{ color: "var(--text-muted)" }}>[REF :: </span>
                  {label}
                  <span style={{ color: "var(--text-muted)" }}>]</span>
                </a>
              );
            }
            return (
              <a
                href={href}
                className="underline underline-offset-2 decoration-1"
                style={{
                  color: "var(--text-primary)",
                  textDecorationColor: "var(--text-muted)",
                }}
              >
                {children}
              </a>
            );
          },
          hr: () => (
            <hr className="my-4" style={{ borderColor: "var(--border)" }} />
          ),
          blockquote: ({ children }) => (
            <blockquote
              className="pl-3 my-3 text-sm italic"
              style={{
                borderLeft: "2px solid var(--text-muted)",
                color: "var(--text-muted)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return (
                <code
                  className="block p-3 rounded text-xs overflow-x-auto mb-3"
                  style={{
                    background: "var(--bg-input)",
                    border: "1px solid var(--border)",
                    color: "var(--text-secondary)",
                    fontFamily: "'IBM Plex Mono', monospace",
                  }}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                className="px-1.5 py-0.5 rounded text-xs"
                style={{
                  background: "var(--accent-dim)",
                  color: "var(--text-primary)",
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
