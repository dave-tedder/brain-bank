import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getAdjacentDigests,
  getDigestByDate,
  resolveClientLinks,
  type DigestType,
} from "@/lib/digest";
import DigestMarkdown from "@/components/DigestMarkdown";
import DigestMetadataRail from "@/components/DigestMetadataRail";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ type?: string }>;
}

function parseType(raw: string | undefined): DigestType {
  return raw === "weekly" ? "weekly" : "daily";
}

function dayOfWeek(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "America/New_York",
  });
}

export default async function DigestDetailPage({
  params,
  searchParams,
}: Props) {
  const { date } = await params;
  const sp = await searchParams;
  const type = parseType(sp.type);

  const digest = await getDigestByDate(date, type);
  if (!digest) notFound();

  const [{ prev, next }, clientLinks] = await Promise.all([
    getAdjacentDigests(date, type),
    resolveClientLinks(digest.metadata),
  ]);

  return (
    <div className="space-y-6 max-w-6xl">
      {/* Breadcrumb */}
      <div
        className="animate-in"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        <div
          className="flex items-center gap-2 text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          <Link
            href="/digest"
            style={{ color: "var(--text-muted)" }}
            className="hover:underline"
          >
            DIGEST
          </Link>
          <span>/</span>
          <span style={{ color: "var(--text-secondary)" }}>
            {type.toUpperCase()}
          </span>
          <span>/</span>
          <span style={{ color: "var(--text-primary)" }}>{date}</span>
        </div>
      </div>

      {/* Header */}
      <div className="animate-in stagger-1">
        <div className="flex items-center gap-3 mb-2">
          <span
            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded"
            style={{
              background: "var(--accent-dim)",
              color: "var(--text-secondary)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            {type}
          </span>
          <span
            className="text-[10px] uppercase"
            style={{
              color: "var(--text-muted)",
              fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            {dayOfWeek(date)}
          </span>
        </div>
        <h1
          className="font-terminal text-3xl text-glow"
          style={{ color: "var(--text-primary)" }}
        >
          DIGEST :: {date}
        </h1>
      </div>

      {/* Prev/next terminal nav */}
      <div
        className="animate-in stagger-2 flex items-center justify-between text-xs"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        <div>
          {prev ? (
            <Link
              href={`/digest/${prev.digest_date}?type=${type}`}
              className="hover:text-[var(--text-primary)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              &lt;&lt; {prev.digest_date}
            </Link>
          ) : (
            <span style={{ color: "var(--text-muted)", opacity: 0.4 }}>
              &lt;&lt; ——
            </span>
          )}
        </div>
        <div>
          {next ? (
            <Link
              href={`/digest/${next.digest_date}?type=${type}`}
              className="hover:text-[var(--text-primary)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              {next.digest_date} &gt;&gt;
            </Link>
          ) : (
            <span style={{ color: "var(--text-muted)", opacity: 0.4 }}>
              —— &gt;&gt;
            </span>
          )}
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6 animate-in stagger-3">
        <div className="card">
          <DigestMarkdown markdown={digest.markdown} clientLinks={clientLinks} />
        </div>
        <div>
          <DigestMetadataRail digest={digest} />
        </div>
      </div>
    </div>
  );
}
