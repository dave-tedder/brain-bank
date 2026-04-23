import Link from "next/link";
import { listDigests, type DigestType } from "@/lib/digest";
import DigestRow from "@/components/DigestRow";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ type?: string; offset?: string }>;
}

const PAGE_SIZE = 30;

function parseType(raw: string | undefined): DigestType {
  return raw === "weekly" ? "weekly" : "daily";
}

function parseOffset(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export default async function DigestArchivePage({ searchParams }: Props) {
  const params = await searchParams;
  const type = parseType(params.type);
  const offset = parseOffset(params.offset);

  let digests: Awaited<ReturnType<typeof listDigests>> = [];
  let loadError = false;
  try {
    digests = await listDigests({ type, limit: PAGE_SIZE, offset });
  } catch (err) {
    console.error("digest archive load failed:", err);
    loadError = true;
  }
  const hasMore = digests.length === PAGE_SIZE;
  const nextOffset = offset + PAGE_SIZE;

  const tabHref = (t: DigestType) =>
    t === "daily" ? "/digest" : "/digest?type=weekly";

  return (
    <div className="space-y-6">
      <div className="animate-in">
        <h1
          className="font-terminal text-3xl text-glow"
          style={{ color: "var(--text-primary)" }}
        >
          <span style={{ color: "var(--text-muted)" }}>&gt; </span>
          LOG :: DIGEST ARCHIVE
        </h1>
        <p
          className="text-sm mt-1"
          style={{
            color: "var(--text-muted)",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          {loadError
            ? "load error"
            : digests.length === 0
              ? "no entries"
              : `${digests.length} ${type} entr${digests.length === 1 ? "y" : "ies"}${offset > 0 ? ` (offset ${offset})` : ""}`}
        </p>
      </div>

      <div className="animate-in stagger-1 flex gap-2 items-center">
        {(["daily", "weekly"] as const).map((t) => {
          const active = type === t;
          return (
            <Link
              key={t}
              href={tabHref(t)}
              className={`px-3 py-1 rounded text-xs font-terminal uppercase tracking-wider transition-all duration-200 ${
                active
                  ? "border border-[var(--accent)] border-glow"
                  : "border border-transparent hover:border-[var(--border)]"
              }`}
              style={{
                background: active ? "var(--accent-dim)" : "transparent",
                color: active ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              [{t.toUpperCase()}]
            </Link>
          );
        })}
      </div>

      {loadError ? (
        <div
          className="card text-center py-12 animate-in stagger-2"
          style={{ borderLeftColor: "rgba(239, 68, 68, 0.4)" }}
        >
          <p
            className="text-sm"
            style={{
              color: "var(--danger)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            &gt; DIGEST ARCHIVE FETCH FAILED :: CHECK SUPABASE LOGS
          </p>
        </div>
      ) : digests.length === 0 ? (
        <div className="card text-center py-12 animate-in stagger-2">
          <p
            className="text-sm"
            style={{
              color: "var(--text-muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            &gt; NO {type.toUpperCase()} DIGEST ENTRIES :: CHECK CRON STATUS
          </p>
        </div>
      ) : (
        <div
          className="animate-in stagger-2"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {digests.map((d, i) => (
            <DigestRow key={d.id} digest={d} stagger={i + 2} />
          ))}
        </div>
      )}

      {hasMore && (
        <div className="animate-in">
          <Link
            href={`/digest?type=${type}&offset=${nextOffset}`}
            className="font-terminal text-xs inline-block py-2 uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
          >
            &gt; LOAD EARLIER ENTRIES_
          </Link>
        </div>
      )}

      {offset > 0 && (
        <div>
          <Link
            href={`/digest?type=${type}`}
            className="text-xs"
            style={{
              color: "var(--text-muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            &larr; back to latest
          </Link>
        </div>
      )}
    </div>
  );
}
