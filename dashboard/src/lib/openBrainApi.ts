const BASE_URL = process.env.OPEN_BRAIN_URL || "";
const API_KEY = process.env.OPEN_BRAIN_API_KEY || "";

async function brainFetch(path: string): Promise<unknown> {
  if (!BASE_URL || !API_KEY) {
    console.error(
      "openBrainApi: OPEN_BRAIN_URL and OPEN_BRAIN_API_KEY env vars are required"
    );
    return null;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-brain-key": API_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function searchThoughts(
  query: string,
  limit = 8
): Promise<{ content: string; similarity: number; metadata: Record<string, unknown> }[]> {
  const data = (await brainFetch(
    `/search?query=${encodeURIComponent(query)}&limit=${limit}&threshold=0.3`
  )) as { results?: { content: string; similarity: number; metadata: Record<string, unknown> }[] } | null;
  return data?.results ?? [];
}

export async function searchPages(
  query: string
): Promise<{ slug: string; title: string; page_type: string; content: string }[]> {
  const data = (await brainFetch(
    `/pages?query=${encodeURIComponent(query)}`
  )) as { pages?: { slug: string; title: string; page_type: string; content: string }[] } | null;
  return data?.pages ?? [];
}

export async function getStats(): Promise<Record<string, unknown> | null> {
  return (await brainFetch("/stats")) as Record<string, unknown> | null;
}
