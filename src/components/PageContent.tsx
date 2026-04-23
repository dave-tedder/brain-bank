"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PageContentProps {
  content: string;
}

export default function PageContent({ content }: PageContentProps) {
  return (
    <div className="wiki-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className="font-terminal text-2xl mb-3 mt-6 first:mt-0"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className="font-terminal text-xl mb-2 mt-5"
              style={{ color: "var(--text-primary)" }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className="font-terminal text-lg mb-2 mt-4"
              style={{ color: "var(--text-secondary)" }}
            >
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-3 leading-relaxed text-sm" style={{ color: "var(--text-body)" }}>
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="mb-3 ml-4 space-y-1 text-sm list-none" style={{ color: "var(--text-body)" }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 ml-4 space-y-1 text-sm list-decimal" style={{ color: "var(--text-body)" }}>
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">
              <span style={{ color: "var(--text-muted)", marginRight: 6 }}>-</span>
              {children}
            </li>
          ),
          strong: ({ children }) => (
            <strong style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
              {children}
            </em>
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
                }}
              >
                {children}
              </code>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              className="underline underline-offset-2 decoration-1"
              style={{ color: "var(--text-primary)", textDecorationColor: "var(--text-muted)" }}
            >
              {children}
            </a>
          ),
          hr: () => (
            <hr className="my-4" style={{ borderColor: "var(--border)" }} />
          ),
          blockquote: ({ children }) => (
            <blockquote
              className="pl-3 my-3 text-sm"
              style={{
                borderLeft: "2px solid var(--text-muted)",
                color: "var(--text-muted)",
              }}
            >
              {children}
            </blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
