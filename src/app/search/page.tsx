import { supabase } from "@/lib/supabase";
import ThoughtCard from "@/components/ThoughtCard";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ q?: string }>;
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  const d = await r.json();
  return d.data[0].embedding;
}

export default async function SearchPage({ searchParams }: Props) {
  const params = await searchParams;
  const query = params.q || "";

  let results: {
    id: string;
    content: string;
    similarity: number;
    metadata: Record<string, unknown>;
    created_at: string;
  }[] = [];

  if (query) {
    const embedding = await getEmbedding(query);
    const { data } = await supabase().rpc("match_thoughts", {
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: 20,
      filter: {},
    });
    results = data || [];
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="animate-in">
        <h1 className="font-terminal text-3xl text-[var(--text-primary)] text-glow">
          SEMANTIC SEARCH
        </h1>
        <p className="text-xs font-mono text-[var(--text-muted)] mt-1 uppercase tracking-wider">
          Vector similarity search across all thoughts
        </p>
      </div>

      {/* Search form */}
      <form className="animate-in stagger-1 flex gap-3">
        <div className="flex-1 relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 font-terminal text-[var(--text-primary)]">
            {">"}
          </span>
          <input
            name="q"
            type="text"
            defaultValue={query}
            placeholder="query..."
            autoFocus
            className="w-full pl-8 pr-4 py-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)] text-sm font-mono text-[var(--text-secondary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] focus:shadow-[0_0_16px_rgba(0,255,65,0.1)] transition-all duration-300"
          />
        </div>
        <button
          type="submit"
          className="font-terminal text-sm px-5 py-3 rounded-lg border border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-glow active:scale-[0.98] transition-all duration-200"
        >
          SEARCH
        </button>
      </form>

      {/* Results count */}
      {query && (
        <p className="text-xs font-mono text-[var(--text-muted)] animate-in stagger-2 uppercase tracking-wider">
          {results.length} result{results.length !== 1 ? "s" : ""} for &ldquo;{query}&rdquo;
        </p>
      )}

      {/* Results */}
      <div className="space-y-3">
        {results.map((r, i) => (
          <div
            key={r.id || i}
            className={`animate-in stagger-${Math.min(i + 2, 8)}`}
          >
            <ThoughtCard
              id={r.id || String(i)}
              content={r.content}
              metadata={r.metadata}
              created_at={r.created_at}
              similarity={r.similarity}
            />
          </div>
        ))}
      </div>

      {/* Empty state */}
      {query && results.length === 0 && (
        <div className="text-center py-16 animate-in">
          <div className="font-terminal text-2xl text-[var(--text-muted)] mb-3">
            NO MATCHES
          </div>
          <p className="text-xs font-mono text-[var(--text-muted)]">
            Try different phrasing or broader terms.
          </p>
        </div>
      )}

      {/* No query state */}
      {!query && (
        <div className="text-center py-16 animate-in stagger-2">
          <div
            className="font-terminal text-3xl text-[var(--text-primary)] text-glow mb-4"
            style={{ animation: "terminalBlink steps(1) 1.2s infinite" }}
          >
            {">_"}
          </div>
          <p className="text-sm font-mono text-[var(--text-muted)]">
            Search by meaning, not keywords.
          </p>
        </div>
      )}
    </div>
  );
}
