import Link from "next/link";
import type { DigestRow } from "@/lib/digest";

interface Props {
  digest: DigestRow;
}

function Rule() {
  return (
    <div
      className="my-4"
      style={{
        color: "var(--text-muted)",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: "12px",
        letterSpacing: "0.02em",
      }}
      aria-hidden="true"
    >
      ──────────
    </div>
  );
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
  return (
    <h3
      className="font-terminal text-sm uppercase tracking-wider mb-2"
      style={{ color: "var(--text-secondary)" }}
    >
      <span style={{ color: "var(--text-muted)" }}>&gt; </span>
      {label}
      {typeof count === "number" && (
        <span style={{ color: "var(--text-muted)" }}> [{count}]</span>
      )}
    </h3>
  );
}

export default function DigestMetadataRail({ digest }: Props) {
  const md = digest.metadata;
  const clientIds = md.referenced_client_ids ?? [];
  const clientNames = md.referenced_client_names ?? [];
  const briefingCount = md.briefing_count ?? 0;
  const openActions = md.open_actions_count ?? 0;
  const resolvedActions = md.resolved_actions_count ?? 0;
  const sourceCount = md.source_thought_count ?? 0;

  const hasClients = clientIds.length > 0 && clientNames.length > 0;
  const hasActions = openActions > 0 || resolvedActions > 0;
  const hasSources = sourceCount > 0;
  const hasBriefings = briefingCount > 0;

  const anything = hasClients || hasActions || hasSources || hasBriefings;

  return (
    <aside
      className="space-y-0 sticky top-6"
      style={{ fontFamily: "'IBM Plex Mono', monospace" }}
    >
      {!anything && (
        <p
          className="text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          &gt; NO METADATA
        </p>
      )}

      {hasClients && (
        <div>
          <SectionHeader label="REFERENCED CLIENTS" count={clientIds.length} />
          <ul className="space-y-1 text-sm">
            {clientIds.map((id, i) => {
              const name = clientNames[i] ?? id;
              return (
                <li key={id} className="flex gap-2">
                  <span
                    style={{ color: "var(--text-muted)" }}
                    aria-hidden="true"
                  >
                    ├─
                  </span>
                  <Link
                    href={`/clients/${id}`}
                    className="underline underline-offset-2 decoration-1 hover:text-[var(--text-primary)] transition-colors"
                    style={{
                      color: "var(--text-secondary)",
                      textDecorationColor: "var(--text-muted)",
                    }}
                  >
                    {name}
                  </Link>
                </li>
              );
            })}
          </ul>
          {(hasBriefings || hasActions || hasSources) && <Rule />}
        </div>
      )}

      {hasBriefings && (
        <div>
          <SectionHeader label="PRE-APPT BRIEFINGS" count={briefingCount} />
          <p
            className="text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            &gt; CLIENT CONTEXT INJECTED INTO TODAY'S NARRATIVE
          </p>
          {(hasActions || hasSources) && <Rule />}
        </div>
      )}

      {hasActions && (
        <div>
          <SectionHeader label="ACTIONS" />
          <ul className="space-y-1 text-sm">
            <li className="flex items-center gap-2">
              <span
                style={{ color: "var(--warning)" }}
                className="text-xs"
                aria-hidden="true"
              >
                [ ]
              </span>
              <Link
                href="/actions"
                className="underline underline-offset-2 decoration-1 hover:text-[var(--text-primary)] transition-colors"
                style={{
                  color: "var(--text-body)",
                  textDecorationColor: "var(--text-muted)",
                }}
              >
                {openActions} open
              </Link>
            </li>
            <li className="flex items-center gap-2">
              <span
                style={{ color: "var(--success)" }}
                className="text-xs"
                aria-hidden="true"
              >
                [x]
              </span>
              <Link
                href="/actions?status=resolved"
                className="underline underline-offset-2 decoration-1 hover:text-[var(--text-primary)] transition-colors"
                style={{
                  color: "var(--text-body)",
                  textDecorationColor: "var(--text-muted)",
                }}
              >
                {resolvedActions} resolved
              </Link>
            </li>
          </ul>
          {hasSources && <Rule />}
        </div>
      )}

      {hasSources && (
        <div>
          <SectionHeader label="SOURCE THOUGHTS" count={sourceCount} />
          <Link
            href={`/thoughts?date=${digest.digest_date}`}
            className="text-sm underline underline-offset-2 decoration-1 hover:text-[var(--text-primary)] transition-colors"
            style={{
              color: "var(--text-body)",
              textDecorationColor: "var(--text-muted)",
            }}
          >
            browse {digest.digest_date}
          </Link>
        </div>
      )}

      {md.synthesizer_model && (
        <>
          <Rule />
          <div>
            <p
              className="text-[10px] uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              synthesizer
            </p>
            <p
              className="text-xs mt-1"
              style={{ color: "var(--text-muted)" }}
            >
              {md.synthesizer_model}
            </p>
          </div>
        </>
      )}
    </aside>
  );
}
