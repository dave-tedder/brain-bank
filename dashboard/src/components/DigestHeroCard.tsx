import Link from "next/link";
import { getLatestDigest, type DigestRow } from "@/lib/digest";
import DigestMarkdown from "./DigestMarkdown";

function todayET(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

function formatTimeET(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type State =
  | { kind: "today"; digest: DigestRow }
  | { kind: "pending"; fallback: DigestRow }
  | { kind: "empty" }
  | { kind: "error" };

async function loadState(): Promise<State> {
  try {
    const latest = await getLatestDigest("daily");
    if (!latest) return { kind: "empty" };
    if (latest.digest_date === todayET()) {
      return { kind: "today", digest: latest };
    }
    return { kind: "pending", fallback: latest };
  } catch {
    return { kind: "error" };
  }
}

export default async function DigestHeroCard() {
  const state = await loadState();

  if (state.kind === "empty") {
    return <EmptyFrame />;
  }
  if (state.kind === "error") {
    return <ErrorFrame />;
  }
  if (state.kind === "pending") {
    return <PendingFrame fallback={state.fallback} />;
  }
  return <TodayFrame digest={state.digest} />;
}

/* ------------------------------------------------------------------ */
/*  State renderers                                                    */
/* ------------------------------------------------------------------ */

function TodayFrame({ digest }: { digest: DigestRow }) {
  const timeLabel = formatTimeET(digest.created_at);
  const headerText = `╭─ DIGEST :: ${digest.digest_date} :: ${timeLabel} ET`;
  const tagText = `[${digest.digest_type.toUpperCase()}] ─╮`;
  const href = `/digest/${digest.digest_date}?type=${digest.digest_type}`;

  return (
    <div
      className="ascii-frame card scanline-hover animate-in relative"
      style={{ padding: "1.25rem", borderLeftColor: "rgba(0, 255, 65, 0.3)" }}
    >
      {/* Overlay link for clickable surface (server-component safe, no JS). */}
      <Link
        href={href}
        aria-label={`Read digest for ${digest.digest_date}`}
        className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="sr-only">Read full digest</span>
      </Link>

      <div className="relative z-20 pointer-events-none [&_a]:pointer-events-auto">
        <FrameTop headerText={headerText} tagText={tagText} />

        <div className="ascii-frame__body">
          <div className="ascii-frame__body-truncate">
            <div className="animate-in stagger-1">
              <DigestMarkdown
                markdown={digest.markdown}
                clientLinks={(digest.metadata.referenced_client_ids ?? []).map(
                  (id, idx) => ({
                    id,
                    name:
                      digest.metadata.referenced_client_names?.[idx] ?? "",
                  })
                ).filter((l) => l.name)}
              />
            </div>
          </div>
        </div>

        <FrameBottomLink label="READ FULL DIGEST >" />
      </div>
    </div>
  );
}

function PendingFrame({ fallback }: { fallback: DigestRow }) {
  const headerText = `╭─ DIGEST :: ${todayET()}`;
  const tagText = `[PENDING] ─╮`;
  const href = `/digest/${fallback.digest_date}?type=${fallback.digest_type}`;

  return (
    <div
      className="ascii-frame card scanline-hover animate-in relative"
      style={{ padding: "1.25rem", borderLeftColor: "rgba(251, 191, 36, 0.35)" }}
    >
      <Link
        href={href}
        aria-label={`Read most recent digest (${fallback.digest_date})`}
        className="absolute inset-0 z-10 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      >
        <span className="sr-only">Read most recent digest</span>
      </Link>

      <div className="relative z-20 pointer-events-none [&_a]:pointer-events-auto">
        <FrameTop headerText={headerText} tagText={tagText} />

        <div className="ascii-frame__body">
          <p
            className="text-xs mb-3"
            style={{
              color: "var(--warning)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            <span style={{ color: "var(--text-muted)" }}>&gt; </span>
            DIGEST PENDING :: GENERATES AT 06:00 ET
          </p>
          <p
            className="text-xs mb-3"
            style={{
              color: "var(--text-muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            showing most recent ({fallback.digest_date}):
          </p>
          <div className="ascii-frame__body-truncate">
            <div className="animate-in stagger-1">
              <DigestMarkdown
                markdown={fallback.markdown}
                clientLinks={(fallback.metadata.referenced_client_ids ?? []).map(
                  (id, idx) => ({
                    id,
                    name:
                      fallback.metadata.referenced_client_names?.[idx] ?? "",
                  })
                ).filter((l) => l.name)}
              />
            </div>
          </div>
        </div>

        <FrameBottomLink label="READ MOST RECENT >" />
      </div>
    </div>
  );
}

function EmptyFrame() {
  const headerText = `╭─ DIGEST :: ${todayET()}`;
  const tagText = `[EMPTY] ─╮`;

  return (
    <div
      className="ascii-frame card animate-in"
      style={{ padding: "1.25rem" }}
    >
      <FrameTop headerText={headerText} tagText={tagText} />

      <div className="ascii-frame__body">
        <p
          className="text-xs text-center py-6"
          style={{
            color: "var(--text-muted)",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          NO RECENT DIGEST ENTRIES
        </p>
      </div>

      <FrameBottom />
    </div>
  );
}

function ErrorFrame() {
  const headerText = `╭─ DIGEST`;
  const tagText = `[ERROR] ─╮`;

  return (
    <div
      className="ascii-frame card animate-in"
      style={{
        padding: "1.25rem",
        borderLeftColor: "rgba(239, 68, 68, 0.4)",
      }}
    >
      <FrameTop headerText={headerText} tagText={tagText} />

      <div className="ascii-frame__body">
        <p
          className="text-xs text-center py-6"
          style={{
            color: "var(--danger)",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          DIGEST FETCH FAILED
        </p>
      </div>

      <FrameBottom />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Frame primitives                                                   */
/* ------------------------------------------------------------------ */

function FrameTop({
  headerText,
  tagText,
}: {
  headerText: string;
  tagText: string;
}) {
  return (
    <div className="ascii-frame__top" aria-hidden="true">
      <span className="ascii-frame__top-label">{headerText}</span>
      <span className="ascii-frame__dashes" />
      <span className="ascii-frame__top-tag">{tagText}</span>
    </div>
  );
}

function FrameBottom() {
  return (
    <div className="ascii-frame__bottom" aria-hidden="true">
      <span>╰─</span>
      <span className="ascii-frame__dashes" />
      <span>─╯</span>
    </div>
  );
}

function FrameBottomLink({ label }: { label: string }) {
  return (
    <div className="ascii-frame__bottom" aria-hidden="true">
      <span>╰─</span>
      <span className="ascii-frame__dashes" />
      <span className="ascii-frame__bottom-link">{label}</span>
      <span className="digest-cursor">_</span>
      <span>─╯</span>
    </div>
  );
}
