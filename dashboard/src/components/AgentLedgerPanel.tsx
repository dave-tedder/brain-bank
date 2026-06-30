import { formatTaskAge, type AgentLedgerRow } from "@/lib/agent-tasks";

export default function AgentLedgerPanel({ ledger }: { ledger: AgentLedgerRow[] }) {
  if (ledger.length === 0) return null;

  return (
    <section className="card animate-in stagger-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-terminal text-xl text-[var(--text-primary)]">
            RUNTIME LEDGER
          </h2>
          <p className="mt-1 text-xs font-mono uppercase tracking-wider text-[var(--text-muted)]">
            {ledger.length} registered runtime{ledger.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
        {ledger.map((row) => (
          <article
            key={row.agent_code}
            className="border border-[var(--border)] bg-[rgba(15,23,42,0.35)] p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-terminal text-lg text-[var(--text-primary)]">
                  {row.agent_code}
                </h3>
                <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                  {row.runtime ?? "runtime unknown"} · {row.automation_state}
                </p>
              </div>
              <div className="text-right text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
                <div>heartbeat {formatTaskAge(row.last_heartbeat)}</div>
                <div>updated {formatTaskAge(row.updated_at)}</div>
              </div>
            </div>

            {row.last_queue_result && (
              <p className="mt-3 text-xs font-mono text-[var(--text-body)] whitespace-pre-wrap">
                {row.last_queue_result}
              </p>
            )}
            {row.local_context && (
              <p className="mt-2 text-xs font-mono text-[var(--text-muted)] whitespace-pre-wrap line-clamp-3">
                {row.local_context}
              </p>
            )}
            {Array.isArray(row.optional_skills) && row.optional_skills.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {row.optional_skills.map((skill) => (
                  <span
                    key={skill}
                    className="border border-[var(--border)] px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[var(--text-muted)]"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
