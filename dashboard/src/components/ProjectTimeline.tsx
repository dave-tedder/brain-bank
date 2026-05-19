import Link from "next/link";
import type { ProjectCapture } from "@/lib/projects";

interface Props {
  captures: ProjectCapture[];
  total: number;
  slug: string;
  expanded: boolean;
}

type CaptureKind = "BLOCKER" | "DONE" | "NEXT STEP" | "PROGRESS";

function captureKind(content: string): CaptureKind {
  const head = content.trimStart();
  if (/^(BLOCKER RESOLVED|DONE):/i.test(head)) return "DONE";
  if (/^BLOCKER:/i.test(head)) return "BLOCKER";
  if (/^NEXT STEP:/i.test(head)) return "NEXT STEP";
  return "PROGRESS";
}

function kindColor(kind: CaptureKind): string {
  switch (kind) {
    case "BLOCKER":
      return "#ff8c42";
    case "DONE":
      return "var(--text-primary)";
    case "NEXT STEP":
      return "var(--warning)";
    default:
      return "var(--border)";
  }
}

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

/**
 * Detail-page main column: a most-recent-first capture timeline. Each entry
 * is typed from its content prefix and gets a matching left border color.
 * "SHOW EARLIER" expands the list via the ?history=all URL param — no JS.
 */
export default function ProjectTimeline({
  captures,
  total,
  slug,
  expanded,
}: Props) {
  const hiddenCount = total - captures.length;

  if (captures.length === 0) {
    return (
      <p
        className="text-sm"
        style={{
          color: "var(--text-muted)",
          fontFamily: "'IBM Plex Mono', monospace",
        }}
      >
        &gt; NO CAPTURES
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {captures.map((c, i) => {
        const kind = captureKind(c.content);
        const color = kindColor(kind);
        const source =
          (c.metadata?.source as string | undefined) ?? "unknown";

        return (
          <div
            key={c.id}
            className={`border-l-2 pl-3 py-1 animate-in stagger-${Math.min(i, 8)}`}
            style={{ borderLeftColor: color }}
          >
            <div
              className="flex items-center gap-2 flex-wrap text-[10px] uppercase tracking-wider mb-1"
              style={{ fontFamily: "'IBM Plex Mono', monospace" }}
            >
              <span style={{ color }}>[{kind}]</span>
              <span style={{ color: "var(--text-muted)" }}>{source}</span>
              <span style={{ color: "var(--text-muted)" }}>·</span>
              <span
                className="tabular-nums"
                style={{ color: "var(--text-muted)" }}
              >
                {formatStamp(c.created_at)}
              </span>
            </div>
            <p
              className="text-sm whitespace-pre-wrap"
              style={{
                color: "var(--text-body)",
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              {c.content}
            </p>
          </div>
        );
      })}

      {!expanded && hiddenCount > 0 && (
        <Link
          href={`/projects/${slug}?history=all`}
          className="font-terminal text-xs inline-block py-2 uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          &gt; SHOW EARLIER ({hiddenCount})_
        </Link>
      )}

      {expanded && total > 0 && (
        <Link
          href={`/projects/${slug}`}
          className="font-terminal text-xs inline-block py-2 uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          &lt; COLLAPSE
        </Link>
      )}
    </div>
  );
}
