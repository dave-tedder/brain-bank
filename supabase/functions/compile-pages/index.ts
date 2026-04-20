import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Minimum thought mentions before auto-creating a topic/project page
const AUTO_CREATE_THRESHOLD = 5;

// --- LLM Call ---

async function llmCall(systemPrompt: string, userContent: string): Promise<string> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-sonnet-4.6",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });
  const d = await r.json();
  return d.choices[0].message.content.trim();
}

// --- Slug Helpers ---

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function makeSlug(pageType: string, name: string): string {
  return `${pageType}/${slugify(name)}`;
}

// --- Compile a Single Page ---

async function compilePage(
  page: {
    id: string;
    slug: string;
    title: string;
    page_type: string;
    content: string;
    source_entity_id: string | null;
    last_compiled: string | null;
  },
  allPageSlugs: string[]
): Promise<{ updated: boolean; error?: string }> {
  try {
    // Find new thoughts since last compilation
    const since = page.last_compiled || "2020-01-01T00:00:00Z";
    let thoughtQuery = supabase
      .from("thoughts")
      .select("content, metadata, created_at")
      .gt("created_at", since)
      .order("created_at", { ascending: true });

    // Filter by page type
    if (page.page_type === "client" && page.source_entity_id) {
      // Get client name for metadata matching
      const { data: client } = await supabase
        .from("clients")
        .select("name")
        .eq("id", page.source_entity_id)
        .single();
      if (!client) return { updated: false, error: "Client not found" };
      thoughtQuery = thoughtQuery.contains("metadata", { people: [client.name] });
    } else if (page.page_type === "topic") {
      thoughtQuery = thoughtQuery.contains("metadata", { topics: [page.title.toLowerCase()] });
    } else if (page.page_type === "project") {
      thoughtQuery = thoughtQuery.contains("metadata", { project: page.title });
    }

    const { data: newThoughts, error: qErr } = await thoughtQuery.limit(50);
    if (qErr) return { updated: false, error: qErr.message };
    if (!newThoughts || newThoughts.length === 0) return { updated: false };

    // For client pages, also pull session history and events
    let supplementalContext = "";
    if (page.page_type === "client" && page.source_entity_id) {
      const { data: sessions } = await supabase
        .from("client_sessions")
        .select("session_date, status, piece_description, placement, style, duration_hours, notes")
        .eq("client_id", page.source_entity_id)
        .order("session_date", { ascending: false })
        .limit(20);
      if (sessions?.length) {
        supplementalContext += "\n\nSession history:\n" + sessions.map((s) => {
          const parts = [`${s.session_date} (${s.status})`];
          if (s.piece_description) parts.push(s.piece_description);
          if (s.placement) parts.push(`on ${s.placement}`);
          if (s.style) parts.push(`[${s.style}]`);
          if (s.duration_hours) parts.push(`${s.duration_hours}h`);
          if (s.notes) parts.push(`Notes: ${s.notes}`);
          return "- " + parts.join(" | ");
        }).join("\n");
      }

      // Client profile data
      const { data: client } = await supabase
        .from("clients")
        .select("name, email, phone, instagram, preferred_styles, notes, first_contact, last_contact")
        .eq("id", page.source_entity_id)
        .single();
      if (client) {
        const lines = [`Name: ${client.name}`];
        if (client.email) lines.push(`Email: ${client.email}`);
        if (client.phone) lines.push(`Phone: ${client.phone}`);
        if (client.instagram) lines.push(`Instagram: ${client.instagram}`);
        if (client.preferred_styles?.length) lines.push(`Styles: ${client.preferred_styles.join(", ")}`);
        if (client.notes) lines.push(`Notes: ${client.notes}`);
        if (client.first_contact) lines.push(`First contact: ${client.first_contact}`);
        if (client.last_contact) lines.push(`Last contact: ${client.last_contact}`);
        supplementalContext = "\n\nClient profile:\n" + lines.join("\n") + supplementalContext;
      }
    }

    // Build the new thoughts text
    const newThoughtsText = newThoughts.map((t, i) => {
      const date = new Date(t.created_at).toLocaleDateString();
      const m = t.metadata || {};
      const type = (m.type as string) || "";
      return `[${i + 1}] (${date}, ${type}) ${t.content}`;
    }).join("\n\n");

    // Available pages for backlink detection
    const otherSlugs = allPageSlugs.filter((s) => s !== page.slug);
    const backlinkList = otherSlugs.length > 0
      ? `\n\nExisting pages that could be cross-referenced (use these slugs for backlinks):\n${otherSlugs.join("\n")}`
      : "";

    const isNewPage = !page.content || page.content.trim() === "";

    const systemPrompt = isNewPage
      ? `You are maintaining a wiki-style reference page for a tattoo artist's knowledge base. Create a new reference page for "${page.title}" (type: ${page.page_type}).

Write a well-organized markdown document that synthesizes all the information into a coherent reference. Structure it with clear sections. Include all factual details from the source material. Write in third person for client pages, neutral reference style for topics/projects.

At the end, on a new line, output BACKLINKS: followed by a comma-separated list of page slugs from the available pages list that this page should cross-reference. If none are relevant, output BACKLINKS: none.

Do not use the words: delve, tapestry, robust, synergy, holistic, leverage, realm, landscape (metaphorical), inked, inking. No em dashes. No emojis.`
      : `You are maintaining a wiki-style reference page for a tattoo artist's knowledge base. Update the existing page for "${page.title}" (type: ${page.page_type}) by integrating new information.

Rules:
- Preserve all existing information that is still accurate
- Add new facts, events, and context from the new thoughts
- If new information contradicts existing content, update to the latest version and note the change
- Keep the document well-organized with clear sections
- Write in third person for client pages, neutral reference style for topics/projects
- Do not simply append. Integrate new information into the appropriate sections.

At the end, on a new line, output BACKLINKS: followed by a comma-separated list of page slugs from the available pages list that this page should cross-reference. If none are relevant, output BACKLINKS: none.

Do not use the words: delve, tapestry, robust, synergy, holistic, leverage, realm, landscape (metaphorical), inked, inking. No em dashes. No emojis.`;

    const userContent = isNewPage
      ? `Source material (${newThoughts.length} thoughts):\n\n${newThoughtsText}${supplementalContext}${backlinkList}`
      : `Current page content:\n\n${page.content}\n\n---\n\nNew thoughts to integrate (${newThoughts.length}):\n\n${newThoughtsText}${supplementalContext}${backlinkList}`;

    const result = await llmCall(systemPrompt, userContent);

    // Parse backlinks from the result
    const backlinkMatch = result.match(/BACKLINKS:\s*(.+)$/m);
    let backlinks: string[] = [];
    let cleanContent = result;
    if (backlinkMatch) {
      cleanContent = result.substring(0, backlinkMatch.index).trim();
      const backlinkStr = backlinkMatch[1].trim();
      if (backlinkStr !== "none") {
        backlinks = backlinkStr
          .split(",")
          .map((s) => s.trim())
          .filter((s) => otherSlugs.includes(s));
      }
    }

    // Update the page
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("compiled_pages")
      .update({
        content: cleanContent,
        backlinks,
        last_compiled: now,
      })
      .eq("id", page.id);

    if (updateErr) return { updated: false, error: updateErr.message };
    return { updated: true };
  } catch (err) {
    return { updated: false, error: (err as Error).message };
  }
}

// --- Auto-Create Pages for High-Mention Entities ---

async function autoCreatePages(existingSlugs: Set<string>): Promise<number> {
  let created = 0;

  // Auto-create client pages for clients without one
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name");

  if (clients) {
    for (const client of clients) {
      const slug = makeSlug("client", client.name);
      if (existingSlugs.has(slug)) continue;

      const { error } = await supabase.from("compiled_pages").insert({
        slug,
        title: client.name,
        page_type: "client",
        source_entity_id: client.id,
      });
      if (!error) {
        existingSlugs.add(slug);
        created++;
      }
    }
  }

  // Auto-create topic/project pages for high-frequency entities
  // Check recent thoughts (last 30 days) for topic and project counts
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: recentThoughts } = await supabase
    .from("thoughts")
    .select("metadata")
    .gte("created_at", thirtyDaysAgo.toISOString());

  if (recentThoughts) {
    const topicCounts: Record<string, number> = {};
    const projectCounts: Record<string, number> = {};

    for (const t of recentThoughts) {
      const m = t.metadata || {};
      if (Array.isArray(m.topics)) {
        for (const tp of m.topics as string[]) {
          topicCounts[tp] = (topicCounts[tp] || 0) + 1;
        }
      }
      if (m.project && typeof m.project === "string") {
        projectCounts[m.project] = (projectCounts[m.project] || 0) + 1;
      }
    }

    // Create pages for topics that meet threshold
    for (const [topic, count] of Object.entries(topicCounts)) {
      if (count < AUTO_CREATE_THRESHOLD) continue;
      const slug = makeSlug("topic", topic);
      if (existingSlugs.has(slug)) continue;

      const { error } = await supabase.from("compiled_pages").insert({
        slug,
        title: topic,
        page_type: "topic",
      });
      if (!error) {
        existingSlugs.add(slug);
        created++;
      }
    }

    // Create pages for projects that meet threshold
    for (const [project, count] of Object.entries(projectCounts)) {
      if (count < AUTO_CREATE_THRESHOLD) continue;
      const slug = makeSlug("project", project);
      if (existingSlugs.has(slug)) continue;

      const { error } = await supabase.from("compiled_pages").insert({
        slug,
        title: project,
        page_type: "project",
      });
      if (!error) {
        existingSlugs.add(slug);
        created++;
      }
    }
  }

  return created;
}

// --- Weekly Lint Pass ---

interface LintResult {
  stale_pages: string[];
  gap_entities: string[];
  contradiction_warnings: string[];
}

async function runLint(
  pages: Array<{ slug: string; title: string; page_type: string; content: string; last_compiled: string | null }>
): Promise<LintResult> {
  const result: LintResult = {
    stale_pages: [],
    gap_entities: [],
    contradiction_warnings: [],
  };

  const now = Date.now();
  const thirtyDays = 30 * 86400000;

  // Staleness check: pages not compiled in 30+ days
  for (const page of pages) {
    if (!page.last_compiled) {
      result.stale_pages.push(`${page.slug} (never compiled)`);
      continue;
    }
    const age = now - new Date(page.last_compiled).getTime();
    if (age > thirtyDays) {
      const dayCount = Math.floor(age / 86400000);
      result.stale_pages.push(`${page.slug} (${dayCount} days since last update)`);
    }
  }

  // Gap analysis: high-mention entities with no compiled page
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const { data: weekThoughts } = await supabase
    .from("thoughts")
    .select("metadata")
    .gte("created_at", sevenDaysAgo.toISOString());

  if (weekThoughts) {
    const existingSlugs = new Set(pages.map((p) => p.slug));
    const entityCounts: Record<string, { type: string; count: number }> = {};

    for (const t of weekThoughts) {
      const m = t.metadata || {};
      if (Array.isArray(m.topics)) {
        for (const tp of m.topics as string[]) {
          const slug = makeSlug("topic", tp as string);
          if (!existingSlugs.has(slug)) {
            const key = `topic:${tp}`;
            entityCounts[key] = entityCounts[key] || { type: "topic", count: 0 };
            entityCounts[key].count++;
          }
        }
      }
      if (m.project && typeof m.project === "string") {
        const slug = makeSlug("project", m.project);
        if (!existingSlugs.has(slug)) {
          const key = `project:${m.project}`;
          entityCounts[key] = entityCounts[key] || { type: "project", count: 0 };
          entityCounts[key].count++;
        }
      }
    }

    for (const [key, info] of Object.entries(entityCounts)) {
      if (info.count >= 3) {
        result.gap_entities.push(`${key} (${info.count} mentions this week, no compiled page)`);
      }
    }
  }

  // Contradiction detection: check pages that share backlinks
  // Group pages by shared backlinks
  const backlinkGroups: Record<string, string[]> = {};
  for (const page of pages) {
    if (!page.content || page.content.length < 100) continue;
    // Find pages that reference each other
    for (const other of pages) {
      if (page.slug === other.slug) continue;
      if (!other.content || other.content.length < 100) continue;
      // Check if they share any backlink targets or reference each other
      const key = [page.slug, other.slug].sort().join("|");
      if (backlinkGroups[key]) continue;

      // Simple heuristic: check if page titles appear in each other's content
      const pageRefersOther = page.content.toLowerCase().includes(other.title.toLowerCase());
      const otherRefersPage = other.content.toLowerCase().includes(page.title.toLowerCase());
      if (pageRefersOther || otherRefersPage) {
        backlinkGroups[key] = [page.slug, other.slug];
      }
    }
  }

  // For cross-referencing pages, ask LLM to check for contradictions
  const crossRefPairs = Object.values(backlinkGroups).slice(0, 5); // Limit to 5 pairs
  for (const [slugA, slugB] of crossRefPairs) {
    const pageA = pages.find((p) => p.slug === slugA);
    const pageB = pages.find((p) => p.slug === slugB);
    if (!pageA || !pageB) continue;

    const checkResult = await llmCall(
      `You are checking two wiki pages for contradictions. If you find any factual contradictions between the pages (conflicting dates, conflicting descriptions of the same event, conflicting claims), list each one briefly. If no contradictions, respond with exactly: NONE`,
      `Page A (${pageA.title}):\n${pageA.content.substring(0, 2000)}\n\n---\n\nPage B (${pageB.title}):\n${pageB.content.substring(0, 2000)}`
    );

    if (checkResult.trim() !== "NONE") {
      result.contradiction_warnings.push(`${slugA} vs ${slugB}: ${checkResult.substring(0, 300)}`);
    }
  }

  return result;
}

// --- Main Handler ---

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url);
    const provided = req.headers.get("x-brain-key") || url.searchParams.get("key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const mode = url.searchParams.get("mode") || "compile"; // "compile" or "lint"

    // Get all existing pages
    const { data: pages, error: pagesErr } = await supabase
      .from("compiled_pages")
      .select("id, slug, title, page_type, content, source_entity_id, last_compiled, backlinks")
      .order("slug", { ascending: true });

    if (pagesErr) {
      return new Response(JSON.stringify({ error: pagesErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const existingSlugs = new Set((pages || []).map((p) => p.slug));

    // Auto-create pages for new entities
    const autoCreated = await autoCreatePages(existingSlugs);

    // Re-fetch if new pages were created
    let allPages = pages || [];
    if (autoCreated > 0) {
      const { data: refreshed } = await supabase
        .from("compiled_pages")
        .select("id, slug, title, page_type, content, source_entity_id, last_compiled, backlinks")
        .order("slug", { ascending: true });
      allPages = refreshed || [];
    }

    const allSlugs = allPages.map((p) => p.slug);

    // Compile stale pages (batch limit to avoid Edge Function timeout)
    // Prioritize: never-compiled first, then oldest last_compiled
    const maxCompilePerRun = parseInt(url.searchParams.get("batch") || "15");
    const sortedPages = [...allPages].sort((a, b) => {
      if (!a.last_compiled && !b.last_compiled) return 0;
      if (!a.last_compiled) return -1;
      if (!b.last_compiled) return 1;
      return new Date(a.last_compiled).getTime() - new Date(b.last_compiled).getTime();
    });

    let compiled = 0;
    let skipped = 0;
    let errors = 0;
    const compiledSlugs: string[] = [];

    for (const page of sortedPages) {
      if (compiled + errors >= maxCompilePerRun) {
        skipped++;
        continue;
      }
      const result = await compilePage(page, allSlugs);
      if (result.updated) {
        compiled++;
        compiledSlugs.push(page.slug);
      } else if (result.error) {
        console.error(`Compile error for ${page.slug}: ${result.error}`);
        errors++;
      }
      // If not updated and no error, page had no new thoughts (not counted)
    }

    // Lint pass (only when requested, typically weekly)
    let lint: LintResult | undefined;
    if (mode === "lint") {
      // Re-fetch pages with updated content for lint
      const { data: freshPages } = await supabase
        .from("compiled_pages")
        .select("slug, title, page_type, content, last_compiled")
        .order("slug", { ascending: true });
      lint = await runLint(freshPages || []);
    }

    const response: Record<string, unknown> = {
      status: "complete",
      pages_total: allPages.length,
      auto_created: autoCreated,
      compiled,
      skipped,
      errors,
      compiled_slugs: compiledSlugs,
    };
    if (lint) response.lint = lint;

    console.log(`Compilation complete: ${compiled} updated, ${autoCreated} created, ${errors} errors`);

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Compile-pages error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
