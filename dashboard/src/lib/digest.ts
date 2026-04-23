import { supabase } from "@/lib/supabase";

export type DigestType = "daily" | "weekly";

export interface DigestMetadata {
  briefing_count?: number;
  open_actions_count?: number;
  resolved_actions_count?: number;
  source_thought_count?: number;
  referenced_client_ids?: string[];
  referenced_client_names?: string[];
  slack_message_ts?: string;
  synthesizer_model?: string;
}

export interface DigestRow {
  id: string;
  digest_date: string;
  digest_type: DigestType;
  markdown: string;
  metadata: DigestMetadata;
  created_at: string;
}

const SELECT_COLS = "id, digest_date, digest_type, markdown, metadata, created_at";

export async function getDigestByDate(
  date: string,
  type: DigestType = "daily"
): Promise<DigestRow | null> {
  const { data } = await supabase()
    .from("digests")
    .select(SELECT_COLS)
    .eq("digest_date", date)
    .eq("digest_type", type)
    .maybeSingle();

  return (data as DigestRow | null) ?? null;
}

export async function listDigests(opts: {
  type?: DigestType;
  limit?: number;
  offset?: number;
} = {}): Promise<DigestRow[]> {
  const type = opts.type ?? "daily";
  const limit = opts.limit ?? 30;
  const offset = opts.offset ?? 0;

  const { data, error } = await supabase()
    .from("digests")
    .select(SELECT_COLS)
    .eq("digest_type", type)
    .order("digest_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return (data as DigestRow[] | null) ?? [];
}

export async function getLatestDigest(
  type: DigestType = "daily"
): Promise<DigestRow | null> {
  const { data } = await supabase()
    .from("digests")
    .select(SELECT_COLS)
    .eq("digest_type", type)
    .order("digest_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as DigestRow | null) ?? null;
}

export async function resolveClientLinks(
  metadata: DigestMetadata
): Promise<{ id: string; name: string }[]> {
  const names = metadata.referenced_client_names ?? [];
  if (!names.length) return [];

  const { data } = await supabase()
    .from("clients")
    .select("id, name")
    .in("name", names);

  const rows = (data as { id: string; name: string }[] | null) ?? [];
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  return names
    .map((name) => {
      const id = byName.get(name);
      return id ? { id, name } : null;
    })
    .filter((x): x is { id: string; name: string } => x !== null);
}

export async function getAdjacentDigests(
  date: string,
  type: DigestType = "daily"
): Promise<{ prev: DigestRow | null; next: DigestRow | null }> {
  const [{ data: prevData }, { data: nextData }] = await Promise.all([
    supabase()
      .from("digests")
      .select(SELECT_COLS)
      .eq("digest_type", type)
      .lt("digest_date", date)
      .order("digest_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase()
      .from("digests")
      .select(SELECT_COLS)
      .eq("digest_type", type)
      .gt("digest_date", date)
      .order("digest_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    prev: (prevData as DigestRow | null) ?? null,
    next: (nextData as DigestRow | null) ?? null,
  };
}
