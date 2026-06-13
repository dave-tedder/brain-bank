import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyEdits, parseEditsXml } from "./_section_merge.ts";
import { selectContradictionLintPages } from "../_shared/wiki-lint-scope.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Deno Edge Runtime exposes EdgeRuntime as a global; declare it for the type
// checker so the workspace deno check stays clean for the audit-row write.
declare const EdgeRuntime: {
  waitUntil: (p: PromiseLike<unknown>) => void;
};

// Minimum thought mentions before auto-creating a topic/project page
const AUTO_CREATE_THRESHOLD = 5;

// Pages with NULL or stale last_compiled watermarks can have deep backlog.
// Even in edit mode, integrating that volume can blow past
// LLM_CALL_TIMEOUT_MS. Cap intake to a small bounded window during catch-up;
// the watermark advances to the newest processed thought's created_at so the
// next cron run picks up the next slice. Convergence: pageN_backlog /
// CATCHUP_THOUGHT_LIMIT cron runs to fully catch up, each well under 60s.
const CATCHUP_THOUGHT_LIMIT = 8;
const STEADY_THOUGHT_LIMIT = 50;
const CATCHUP_RECENCY_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

function shouldUseCatchupLimit(lastCompiled: string | null): boolean {
  if (!lastCompiled) return true;
  const compiledAt = new Date(lastCompiled).getTime();
  if (Number.isNaN(compiledAt)) return true;
  return Date.now() - compiledAt > CATCHUP_RECENCY_WINDOW_MS;
}

// Comma-separated topic/project tags to suppress from auto-page creation.
// Use for high-volume mechanical-capture sources (fitness sync, calendar sync)
// whose tags would otherwise spam the wiki without producing useful pages.
// Existing pages with these slugs are not deleted; this only blocks NEW spawns.
const PAGE_AUTO_CREATE_EXCLUDE_TAGS = new Set(
  (Deno.env.get("PAGE_AUTO_CREATE_EXCLUDE_TAGS") || "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
);

type IndexCompileMode = "auto" | "force" | "skip";

function parseIndexCompileMode(
  raw: string | null,
  mode: string,
): IndexCompileMode {
  if (mode === "index") return "force";
  if (!raw) return "auto";

  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "force", "only"].includes(normalized)) {
    return "force";
  }
  if (["0", "false", "no", "skip"].includes(normalized)) return "skip";
  return "auto";
}

// --- LLM Call ---

// Per-call ceiling. claude-sonnet-4.6 with a full page context can take
// 60-70s on slow days, which compounds across concurrent waves and risks
// the 150s Edge Runtime wall. Abort any single call that runs longer so the
// batch keeps moving — the page rolls into next cron's queue.
const LLM_CALL_TIMEOUT_MS = 75_000;
const DEFAULT_COMPILE_MODEL = "anthropic/claude-sonnet-4.6";
const ALLOWED_COMPILE_MODELS = new Set([
  DEFAULT_COMPILE_MODEL,
  "openai/gpt-4.1-mini",
]);

async function llmCall(
  systemPrompt: string,
  userContent: string,
  options?: { maxTokens?: number; model?: string },
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: options?.model || DEFAULT_COMPILE_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    };
    if (options?.maxTokens) body.max_tokens = options.maxTokens;
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const d = await r.json();
    return d.choices[0].message.content.trim();
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- Concurrency Helpers ---

// Bounded-parallel runner. Workers pull from a shared queue; preserves input
// order in the result array. Worker callbacks are responsible for their own
// error handling — uncaught throws will reject the whole batch.
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function pump(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  return results;
}

// Cheap pre-filter probe: does this page have ANY thoughts since its last
// compile? Uses head:true count so Postgres returns just a row count. The
// metadata filters here mirror compilePage()'s SELECT filter exactly, so a
// positive probe implies compilePage() will also see new thoughts. On error,
// returns true to fail open — better to compile a page unnecessarily than
// miss a real update.
async function pageHasNewThoughts(
  page: {
    slug: string;
    page_type: string;
    title: string;
    source_entity_id: string | null;
    last_compiled: string | null;
  },
  clientNamesById: Map<string, string>,
): Promise<boolean> {
  const since = page.last_compiled || "2020-01-01T00:00:00Z";

  if (page.page_type === "project") {
    const { data, error } = await supabase.rpc("get_project_page_thoughts", {
      p_slug: pageSlugToProjectSlug(page.slug),
      p_since: since,
      p_limit: 1,
      p_ascending: true,
    });
    if (error) return true;
    return (data?.length ?? 0) > 0;
  }

  let q = supabase
    .from("thoughts")
    .select("*", { count: "exact", head: true })
    .gt("created_at", since);

  if (page.page_type === "client" && page.source_entity_id) {
    const name = clientNamesById.get(page.source_entity_id);
    if (!name) return false; // client row gone — skip silently
    q = q.contains("metadata", { people: [name] });
  } else if (page.page_type === "topic") {
    q = q.contains("metadata", { topics: [page.title.toLowerCase()] });
  } else {
    return false;
  }

  const { count, error } = await q;
  if (error) return true; // fail open
  return (count ?? 0) > 0;
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

function pageSlugToProjectSlug(pageSlug: string): string {
  return pageSlug.replace(/^project\//, "");
}

// --- Compile the Self-Index Page ---
// Builds a curated table-of-contents page summarizing every other compiled
// page by type. Slug 'index/wiki', page_type 'index'. Regenerated daily on
// the same pg_cron schedule as the rest of the wiki so the TOC stays current.
async function compileIndexPage(
  allPages: Array<{
    slug: string;
    title: string;
    page_type: string;
    content: string;
    last_compiled: string | null;
  }>,
): Promise<{ updated: boolean; error?: string }> {
  try {
    // Filter to non-index pages (don't include the index in itself)
    const tocSources = allPages.filter((p) => p.page_type !== "index");
    if (tocSources.length === 0) {
      return { updated: false, error: "No pages to index yet" };
    }

    // Split into compiled vs never-compiled. The LLM gets the compiled pages
    // with previews; never-compiled pages are summarized as a count per type
    // so they don't waste prompt budget on rows the model can't say anything
    // about. Audit Finding 2c.
    const compiledSources = tocSources.filter((p) => p.last_compiled && p.content);
    const notYetCompiled = tocSources.filter((p) => !p.last_compiled || !p.content);

    const grouped: Record<string, typeof compiledSources> = {};
    for (const p of compiledSources) {
      if (!grouped[p.page_type]) grouped[p.page_type] = [];
      grouped[p.page_type].push(p);
    }

    const notYetByType: Record<string, number> = {};
    for (const p of notYetCompiled) {
      notYetByType[p.page_type] = (notYetByType[p.page_type] || 0) + 1;
    }

    const tocText = [
      ...Object.entries(grouped).map(([type, pages]) => {
        const lines = [`### ${type.toUpperCase()} (${pages.length} pages)`];
        for (const p of pages) {
          const compiled = new Date(p.last_compiled!).toLocaleDateString();
          const preview = p.content
            .substring(0, 200)
            .replace(/\n+/g, " ")
            .trim();
          lines.push(
            `- **${p.title}** (\`${p.slug}\`, compiled ${compiled})\n  ${preview}`,
          );
        }
        return lines.join("\n");
      }),
      ...(Object.keys(notYetByType).length > 0
        ? [
          `### Not yet compiled\n${
            Object.entries(notYetByType)
              .map(([type, count]) => `- ${type}: ${count} pages`)
              .join("\n")
          }`,
        ]
        : []),
    ].join("\n\n");

    const systemPrompt =
      `You are writing the table-of-contents page for a wiki-style knowledge base. Given a list of all pages grouped by type (client, topic, project), write a single coherent index page that:
- Briefly introduces what the wiki tracks (one short paragraph).
- For each section (Clients, Topics, Projects), names the pages and gives a one-sentence sense of what each one covers (drawn from its preview).
- Stays under 800 words total.
- Is meant to be read by a future agent or the operator looking for orientation, not as a sales pitch.

Use markdown sections. Group pages alphabetically within each section. Don't editorialize beyond what the previews show. Don't invent page slugs that aren't in the input.

Do not use the words: delve, tapestry, robust, synergy, holistic, leverage, realm, landscape (metaphorical), inked, inking. No em dashes. No emojis.`;

    const userContent = `Pages currently in the wiki:\n\n${tocText}`;

    const result = await llmCall(systemPrompt, userContent, { maxTokens: 1200 });

    // No backlinks for the index — it's the root, not a member of the graph.
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from("compiled_pages")
      .update({
        content: result,
        backlinks: [],
        last_compiled: now,
      })
      .eq("slug", "index/wiki");

    if (updateErr) return { updated: false, error: updateErr.message };
    return { updated: true };
  } catch (err) {
    return { updated: false, error: (err as Error).message };
  }
}

// Recommended H2 sections per page_type. The edit-mode prompt nudges the LLM
// to use these names when creating new sections; existing sections keep their
// current names. Empty array for unrecognized types so the prompt simply
// omits the hint.
function recommendedSectionsFor(pageType: string): string[] {
  switch (pageType) {
    case "client":
      return ["Style Preferences", "Tattoo History", "Sessions", "Notes"];
    case "topic":
      return ["Definition", "Examples", "Recent Activity", "Open Questions"];
    case "project":
      return ["Status", "Architecture", "Decisions", "Recent Activity"];
    default:
      return [];
  }
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
    source_thought_ids?: string[];
  },
  allPageSlugs: string[],
  compileModel: string = DEFAULT_COMPILE_MODEL,
  targetedIntakeLimit?: number,
): Promise<{ updated: boolean; error?: string }> {
  try {
    // Find new thoughts since last compilation. Missing or stale watermarks
    // are catch-up runs; bound intake to CATCHUP_THOUGHT_LIMIT so backlog
    // slices finish under LLM_CALL_TIMEOUT_MS. The successful-path update
    // below advances last_compiled to the newest fetched thought's created_at
    // (not now()), so each run chips off another slice until the watermark
    // catches up to the present.
    const isCatchup = shouldUseCatchupLimit(page.last_compiled);
    const intakeLimit = targetedIntakeLimit ?? (isCatchup
      ? CATCHUP_THOUGHT_LIMIT
      : STEADY_THOUGHT_LIMIT);
    const since = page.last_compiled || "2020-01-01T00:00:00Z";
    let newThoughts: Array<{
      id: string;
      content: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }> | null = null;
    let qErr: { message: string } | null = null;

    // Filter by page type
    if (page.page_type === "project") {
      const result = await supabase.rpc("get_project_page_thoughts", {
        p_slug: pageSlugToProjectSlug(page.slug),
        p_since: since,
        p_limit: intakeLimit,
        p_ascending: true,
      });
      newThoughts = result.data;
      qErr = result.error;
    } else {
      let thoughtQuery = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .gt("created_at", since)
        .order("created_at", { ascending: true });

      if (page.page_type === "client" && page.source_entity_id) {
      // Get client name for metadata matching
        const { data: client } = await supabase
          .from("clients")
          .select("name")
          .eq("id", page.source_entity_id)
          .single();
        if (!client) return { updated: false, error: "Client not found" };
        thoughtQuery = thoughtQuery.contains("metadata", {
          people: [client.name],
        });
      } else if (page.page_type === "topic") {
        thoughtQuery = thoughtQuery.contains("metadata", {
          topics: [page.title.toLowerCase()],
        });
      }

      const result = await thoughtQuery.limit(intakeLimit);
      newThoughts = result.data;
      qErr = result.error;
    }

    if (qErr) return { updated: false, error: qErr.message };
    if (!newThoughts || newThoughts.length === 0) return { updated: false };

    // For client pages, also pull session history and events
    let supplementalContext = "";
    if (page.page_type === "client" && page.source_entity_id) {
      const { data: sessions } = await supabase
        .from("client_sessions")
        .select(
          "session_date, status, piece_description, placement, style, duration_hours, notes",
        )
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
        .select(
          "name, email, phone, instagram, preferred_styles, notes, first_contact, last_contact",
        )
        .eq("id", page.source_entity_id)
        .single();
      if (client) {
        const lines = [`Name: ${client.name}`];
        if (client.email) lines.push(`Email: ${client.email}`);
        if (client.phone) lines.push(`Phone: ${client.phone}`);
        if (client.instagram) lines.push(`Instagram: ${client.instagram}`);
        if (client.preferred_styles?.length) {
          lines.push(`Styles: ${client.preferred_styles.join(", ")}`);
        }
        if (client.notes) lines.push(`Notes: ${client.notes}`);
        if (client.first_contact) {
          lines.push(`First contact: ${client.first_contact}`);
        }
        if (client.last_contact) {
          lines.push(`Last contact: ${client.last_contact}`);
        }
        supplementalContext = "\n\nClient profile:\n" + lines.join("\n") +
          supplementalContext;
      }
    }

    // Build the new thoughts text. Embed the thought UUID so the LLM can echo
    // it back in SOURCE_THOUGHTS: at the end. The (id: <uuid>) prefix is
    // adjacent to the index marker so the LLM doesn't drop or truncate it.
    const newThoughtsText = newThoughts.map((t, i) => {
      const date = new Date(t.created_at).toLocaleDateString();
      const m = t.metadata || {};
      const type = (m.type as string) || "";
      return `[${i + 1}] (id: ${t.id}, ${date}, ${type}) ${t.content}`;
    }).join("\n\n");

    // Available pages for backlink detection
    const otherSlugs = allPageSlugs.filter((s) => s !== page.slug);
    const backlinkList = otherSlugs.length > 0
      ? `\n\nExisting pages that could be cross-referenced (use these slugs for backlinks):\n${
        otherSlugs.join("\n")
      }`
      : "";

    const isNewPage = !page.content || page.content.trim() === "";
    // Edit mode: existing page already split into H2 sections. The LLM
    // emits a small <edits> XML block describing which sections to update,
    // which the parser applies locally. Output cost becomes O(change_size).
    // Pre-refactor pages without H2 markers fall through to full-rewrite,
    // which acts as a one-time lazy migration into edit-mode shape.
    const hasH2 = /^## .+$/m.test(page.content || "");
    const useEditMode = !isNewPage && hasH2;

    const recommended = recommendedSectionsFor(page.page_type);
    const recommendedHint = recommended.length > 0
      ? `\nFor "${page.page_type}" pages, prefer these recommended H2 section names when creating new sections (existing sections keep their current names): ${
        recommended.map((s) => `## ${s}`).join(", ")
      }.`
      : "";

    let systemPrompt: string;
    if (isNewPage) {
      systemPrompt =
        `You are maintaining a wiki-style reference page for a tattoo artist's knowledge base. Create a new reference page for "${page.title}" (type: ${page.page_type}).

Write a well-organized markdown document that synthesizes all the information into a coherent reference. Structure it with H2 (##) section headers so subsequent compiles can apply targeted edits. Include all factual details from the source material. Write in third person for client pages, neutral reference style for topics/projects.${recommendedHint}

At the end, on a new line, output BACKLINKS: followed by a comma-separated list of page slugs from the available pages list that this page should cross-reference. If none are relevant, output BACKLINKS: none.

On a new line after BACKLINKS, output SOURCE_THOUGHTS: followed by a comma-separated list of the thought UUIDs (the (id: <uuid>) values from the source material) whose content contributed to the new or updated portions of this page. Include every thought you drew on. If you did not draw on any (e.g. minor cleanup pass), output SOURCE_THOUGHTS: none.

Do not use the words: delve, tapestry, robust, synergy, holistic, leverage, realm, landscape (metaphorical), inked, inking. No em dashes. No emojis.`;
    } else if (useEditMode) {
      systemPrompt =
        `You are maintaining a wiki-style reference page for a tattoo artist's knowledge base. Update the existing page for "${page.title}" (type: ${page.page_type}) by integrating new information.

The page is already organized into H2-headed sections. Output ONLY the sections that need to change, using the structured-edit XML format below. Do NOT regenerate the whole page.

Format:

<edits>
<section name="Section Name" action="update"><![CDATA[
new full content for this section
]]></section>
<section name="Another Section" action="append"><![CDATA[
- new entry to append
]]></section>
</edits>

Available actions:
- "update": replace the entire body of an existing section with new content
- "append": add new content to the end of an existing section
- "prepend": add new content to the start of an existing section
- "create": add a brand-new section with this name and content

Rules:
- Match existing section names verbatim (case + whitespace) when targeting them. Look at the H2 headers in the current page below.
- Wrap section content in <![CDATA[ ... ]]> to keep markdown characters safe.
- Use "append" for chronological entries (sessions, dated activity). Use "update" when the content is canonical state that should be replaced. Use "create" when no existing section fits.
- Do not emit an edit that rewrites a section identically to its current content.
- Do not include the page's top-level title (# heading) in any edit; only H2 (##) sections are addressable.
- If absolutely nothing in the new thoughts changes the page, still emit at least one edit (e.g. "Recent Activity" append) so the compile records progress.${recommendedHint}

After the closing </edits> tag, output BACKLINKS: followed by a comma-separated list of page slugs from the available pages list that this page should cross-reference. If none are relevant, output BACKLINKS: none.

On a new line after BACKLINKS, output SOURCE_THOUGHTS: followed by a comma-separated list of the thought UUIDs (the (id: <uuid>) values from the source material) whose content contributed to your edits. Include every thought you drew on. If you did not draw on any, output SOURCE_THOUGHTS: none.

Do not use the words: delve, tapestry, robust, synergy, holistic, leverage, realm, landscape (metaphorical), inked, inking. No em dashes. No emojis.`;
    } else {
      systemPrompt =
        `You are maintaining a wiki-style reference page for a tattoo artist's knowledge base. Update the existing page for "${page.title}" (type: ${page.page_type}) by integrating new information.

Rules:
- Preserve all existing information that is still accurate
- Add new facts, events, and context from the new thoughts
- If new information contradicts existing content, update to the latest version and note the change
- Keep the document well-organized with H2 (##) section headers so subsequent compiles can apply targeted edits
- Write in third person for client pages, neutral reference style for topics/projects
- Do not simply append. Integrate new information into the appropriate sections.${recommendedHint}

At the end, on a new line, output BACKLINKS: followed by a comma-separated list of page slugs from the available pages list that this page should cross-reference. If none are relevant, output BACKLINKS: none.

On a new line after BACKLINKS, output SOURCE_THOUGHTS: followed by a comma-separated list of the thought UUIDs (the (id: <uuid>) values from the source material) whose content contributed to the new or updated portions of this page. Include every thought you drew on. If you did not draw on any (e.g. minor cleanup pass), output SOURCE_THOUGHTS: none.

Do not use the words: delve, tapestry, robust, synergy, holistic, leverage, realm, landscape (metaphorical), inked, inking. No em dashes. No emojis.`;
    }

    const userContent = isNewPage
      ? `Source material (${newThoughts.length} thoughts):\n\n${newThoughtsText}${supplementalContext}${backlinkList}`
      : `Current page content:\n\n${page.content}\n\n---\n\nNew thoughts to integrate (${newThoughts.length}):\n\n${newThoughtsText}${supplementalContext}${backlinkList}`;

    const result = await llmCall(systemPrompt, userContent, {
      model: compileModel,
    });

    // Parse backlinks and source_thought_ids from the result. Both lines are
    // line-anchored at the end of the LLM response. Order: cleanContent,
    // BACKLINKS:, SOURCE_THOUGHTS:.
    const backlinkMatch = result.match(/^BACKLINKS:\s*(.+)$/m);
    const sourceMatch = result.match(/^SOURCE_THOUGHTS:\s*(.+)$/m);

    let backlinks: string[] = [];
    let newSourceIds: string[] = [];
    let cleanContent = result;

    // Strip the BACKLINKS line and everything after from displayed content.
    if (backlinkMatch && typeof backlinkMatch.index === "number") {
      cleanContent = result.substring(0, backlinkMatch.index).trim();
    }

    // Edit-mode override: the LLM's body was an <edits> XML block, not the
    // full page. Parse and apply to the existing content. On parse failure
    // (zero valid section edits), bail with an error so the page rolls into
    // the next compile run instead of being silently rewritten as the bare
    // XML block.
    if (useEditMode) {
      const edits = parseEditsXml(cleanContent);
      if (edits.length === 0) {
        return {
          updated: false,
          error:
            "edit-mode response contained no valid <section> edits; will retry next run",
        };
      }
      cleanContent = applyEdits(page.content, edits);
    }

    if (backlinkMatch) {
      const backlinkStr = backlinkMatch[1].trim();
      if (backlinkStr !== "none") {
        backlinks = backlinkStr
          .split(",")
          .map((s) => s.trim())
          .filter((s) => otherSlugs.includes(s));
      }
    }

    if (sourceMatch) {
      const sourceStr = sourceMatch[1].trim();
      if (sourceStr !== "none") {
        const uuidPattern =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const validIdsFromInput = new Set(newThoughts.map((t) => t.id));
        newSourceIds = sourceStr
          .split(",")
          .map((s) => s.trim())
          .filter((s) => uuidPattern.test(s))
          .filter((s) => validIdsFromInput.has(s)); // only accept IDs the LLM was actually shown
      }
    }

    // Merge with existing source_thought_ids (cumulative). Read current array
    // from the page row we already loaded; older rows pre-12.D have an empty
    // default and accumulate organically.
    const existingIds =
      (page as { source_thought_ids?: string[] }).source_thought_ids ?? [];
    const mergedIds = Array.from(new Set([...existingIds, ...newSourceIds]));

    // Update the page. Watermark last_compiled to the newest processed
    // thought's created_at, not now(). For steady-state runs the newest
    // thought is from today so watermark ≈ now; for catch-up runs the
    // watermark stays in the past until the page is fully caught up,
    // letting subsequent cron passes keep advancing through the backlog
    // in CATCHUP_THOUGHT_LIMIT-sized slices. Real run time is recorded
    // separately in compile_pages_runs.
    const newest = newThoughts[newThoughts.length - 1];
    const watermark = newest.created_at;
    const { error: updateErr } = await supabase
      .from("compiled_pages")
      .update({
        content: cleanContent,
        backlinks,
        source_thought_ids: mergedIds,
        last_compiled: watermark,
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

  // Seed every auto-created page with one recommended H2 header so the very
  // first compile run qualifies for edit-mode (useEditMode requires non-empty
  // content + an H2 marker). Skips the full-rewrite branch and its
  // O(page_size) output cost on the first compile.
  const seedContent = (pageType: string): string => {
    const first = recommendedSectionsFor(pageType)[0];
    return first ? `## ${first}\n` : "";
  };

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
        content: seedContent("client"),
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
      // Email captures do not count toward wiki auto-create thresholds. This
      // prevents repeated marketing messages from creating topic pages while
      // still counting captures with null or absent sources.
      if (m.source === "gmail") continue;
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
      if (PAGE_AUTO_CREATE_EXCLUDE_TAGS.has(topic.toLowerCase())) continue;
      const slug = makeSlug("topic", topic);
      if (existingSlugs.has(slug)) continue;

      const { error } = await supabase.from("compiled_pages").insert({
        slug,
        title: topic,
        page_type: "topic",
        content: seedContent("topic"),
      });
      if (!error) {
        existingSlugs.add(slug);
        created++;
      }
    }

    // Create pages for projects that meet threshold
    for (const [project, count] of Object.entries(projectCounts)) {
      if (count < AUTO_CREATE_THRESHOLD) continue;
      if (PAGE_AUTO_CREATE_EXCLUDE_TAGS.has(project.toLowerCase())) continue;
      const slug = makeSlug("project", project);
      if (existingSlugs.has(slug)) continue;

      const { error } = await supabase.from("compiled_pages").insert({
        slug,
        title: project,
        page_type: "project",
        content: seedContent("project"),
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
  diagnostics: string[];
}

async function runLint(
  pages: Array<
    {
      slug: string;
      title: string;
      page_type: string;
      content: string;
      last_compiled: string | null;
    }
  >,
  curatedProjectSlugs: Set<string>,
): Promise<LintResult> {
  const result: LintResult = {
    stale_pages: [],
    gap_entities: [],
    contradiction_warnings: [],
    diagnostics: [],
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
      result.stale_pages.push(
        `${page.slug} (${dayCount} days since last update)`,
      );
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
            entityCounts[key] = entityCounts[key] ||
              { type: "topic", count: 0 };
            entityCounts[key].count++;
          }
        }
      }
      if (m.project && typeof m.project === "string") {
        const slug = makeSlug("project", m.project);
        if (!existingSlugs.has(slug)) {
          const key = `project:${m.project}`;
          entityCounts[key] = entityCounts[key] ||
            { type: "project", count: 0 };
          entityCounts[key].count++;
        }
      }
    }

    for (const [key, info] of Object.entries(entityCounts)) {
      if (info.count >= 3) {
        result.gap_entities.push(
          `${key} (${info.count} mentions this week, no compiled page)`,
        );
      }
    }
  }

  // Broad topic/index pages create low-signal comparisons. Keep contradiction
  // checks to client pages and projects explicitly curated in `projects`.
  const contradictionPages = selectContradictionLintPages(
    pages,
    curatedProjectSlugs,
  );

  // Contradiction detection: check eligible pages that reference each other.
  // Group pages by shared backlinks
  const backlinkGroups: Record<string, string[]> = {};
  for (const page of contradictionPages) {
    if (!page.content || page.content.length < 100) continue;
    // Find pages that reference each other
    for (const other of contradictionPages) {
      if (page.slug === other.slug) continue;
      if (!other.content || other.content.length < 100) continue;
      // Check if they share any backlink targets or reference each other
      const key = [page.slug, other.slug].sort().join("|");
      if (backlinkGroups[key]) continue;

      // Simple heuristic: check if page titles appear in each other's content
      const pageRefersOther = page.content.toLowerCase().includes(
        other.title.toLowerCase(),
      );
      const otherRefersPage = other.content.toLowerCase().includes(
        page.title.toLowerCase(),
      );
      if (pageRefersOther || otherRefersPage) {
        backlinkGroups[key] = [page.slug, other.slug];
      }
    }
  }

  // For cross-referencing pages, ask LLM to check for contradictions in
  // parallel. Limit to 5 pairs so a busy lint pass doesn't burn the entire
  // wall budget on this section.
  const crossRefPairs = Object.values(backlinkGroups).slice(0, 5);
  const checks = await runWithConcurrency(
    crossRefPairs,
    5,
    async ([slugA, slugB]) => {
      const pageA = contradictionPages.find((p) => p.slug === slugA);
      const pageB = contradictionPages.find((p) => p.slug === slugB);
      if (!pageA || !pageB) return null;

      try {
        const checkResult = await llmCall(
          `You are checking two wiki pages for contradictions. If you find any factual contradictions between the pages (conflicting dates, conflicting descriptions of the same event, conflicting claims), list each one briefly. If no contradictions, respond with exactly: NONE`,
          `Page A (${pageA.title}):\n${
            pageA.content.substring(0, 2000)
          }\n\n---\n\nPage B (${pageB.title}):\n${
            pageB.content.substring(0, 2000)
          }`,
        );

        if (checkResult.trim() !== "NONE") {
          return `${slugA} vs ${slugB}: ${checkResult.substring(0, 300)}`;
        }
        return null;
      } catch (err) {
        result.diagnostics.push(
          `contradiction check failed for ${slugA} vs ${slugB}: ${(err as Error).message}`,
        );
        return null;
      }
    },
  );
  for (const c of checks) {
    if (c) result.contradiction_warnings.push(c);
  }

  return result;
}

// --- Main Handler ---

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url);
    const provided = req.headers.get("x-brain-key") ||
      url.searchParams.get("key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const mode = url.searchParams.get("mode") || "compile"; // "compile", "lint", or "index"
    const targetSlug = url.searchParams.get("slug");
    const invoker = url.searchParams.get("invoker") || "pg_cron";
    const indexMode = parseIndexCompileMode(
      url.searchParams.get("index"),
      mode,
    );

    // Get all existing pages
    const { data: pages, error: pagesErr } = await supabase
      .from("compiled_pages")
      .select(
        "id, slug, title, page_type, content, source_entity_id, last_compiled, backlinks, source_thought_ids",
      )
      .order("slug", { ascending: true });

    if (pagesErr) {
      return new Response(JSON.stringify({ error: pagesErr.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const existingSlugs = new Set((pages || []).map((p) => p.slug));

    // Bootstrap the self-index page row if it doesn't exist yet. This row
    // anchors the daily-compiled wiki TOC at slug 'index/wiki'. Idempotent:
    // does nothing if the row already exists.
    if (!existingSlugs.has("index/wiki")) {
      const { error: bootErr } = await supabase.from("compiled_pages").insert({
        slug: "index/wiki",
        title: "Wiki Index",
        page_type: "index",
      });
      if (!bootErr) existingSlugs.add("index/wiki");
      // If insert failed (e.g., unique constraint race), continue silently —
      // the next iteration will pick it up.
    }

    // Auto-create pages for new entities
    const autoCreated = targetSlug ? 0 : await autoCreatePages(existingSlugs);

    // Re-fetch if new pages were created
    let allPages = pages || [];
    if (autoCreated > 0) {
      const { data: refreshed } = await supabase
        .from("compiled_pages")
        .select(
          "id, slug, title, page_type, content, source_entity_id, last_compiled, backlinks, source_thought_ids",
        )
        .order("slug", { ascending: true });
      allPages = refreshed || [];
    }

    const allSlugs = allPages.map((p) => p.slug);

    // Compile stale pages: parallel pre-filter + bounded-concurrency compile
    // + wall-clock guard so we don't blow past the 150s Edge Runtime ceiling.
    // Prioritize: never-compiled first, then oldest last_compiled.
    const maxCompilePerRun = parseInt(url.searchParams.get("batch") || "15");
    const requestedModel = url.searchParams.get("model");
    const requestedIntake = parseInt(url.searchParams.get("intake") || "0");
    const maintenanceModel = targetSlug ? requestedModel : null;
    const compileModel = maintenanceModel &&
        ALLOWED_COMPILE_MODELS.has(maintenanceModel)
      ? maintenanceModel
      : DEFAULT_COMPILE_MODEL;
    const targetedIntakeLimit = targetSlug && requestedIntake > 0
      ? Math.min(requestedIntake, STEADY_THOUGHT_LIMIT)
      : undefined;
    const sortedPages = [...allPages].sort((a, b) => {
      if (!a.last_compiled && !b.last_compiled) return 0;
      if (!a.last_compiled) return -1;
      if (!b.last_compiled) return 1;
      return new Date(a.last_compiled).getTime() -
        new Date(b.last_compiled).getTime();
    });

    // Wall-clock budget. Edge Runtime kills at 150s. Together with the
    // per-call LLM timeout (LLM_CALL_TIMEOUT_MS = 75s), this guarantees a
    // worker dispatched at t<=70s finishes by t<=145s — under the wall with
    // headroom for the index compile and response serialization.
    const RUN_BUDGET_MS = 70_000;
    const PROBE_CONCURRENCY = 20;
    const COMPILE_CONCURRENCY = 5;
    const startTime = Date.now();

    let compiled = 0;
    let skipped = 0;
    let errors = 0;
    const errored: { slug: string; error: string }[] = [];
    let budgetExhausted = false;
    const compiledSlugs: string[] = [];

    if (mode !== "index") {
      // Pre-fetch client names so the parallel probe doesn't N+1 the clients
      // table. compilePage() re-reads the full client row anyway for the
      // supplemental-context section, so we only need names here.
      const clientPages = sortedPages.filter(
        (p) => p.page_type === "client" && p.source_entity_id,
      );
      const clientNamesById = new Map<string, string>();
      if (clientPages.length > 0) {
        const ids = Array.from(
          new Set(clientPages.map((p) => p.source_entity_id!)),
        );
        const { data: clients } = await supabase
          .from("clients")
          .select("id, name")
          .in("id", ids);
        for (const c of clients || []) clientNamesById.set(c.id, c.name);
      }

      // Parallel pre-filter: cheap COUNT-only probes drop ~190 serial SELECTs
      // (~50ms each, ~9.5s total) to a single parallel pass (~1-2s). Pages
      // with no new thoughts since last_compiled never enter the LLM loop.
      const candidatePool = sortedPages.filter(
        (page) =>
          page.page_type !== "index" &&
          (!targetSlug || page.slug === targetSlug),
      );
      const probeResults = await runWithConcurrency(
        candidatePool,
        PROBE_CONCURRENCY,
        (page) => pageHasNewThoughts(page, clientNamesById),
      );
      const candidatePages = candidatePool.filter((_, i) => probeResults[i]);

      // Apply per-run cap. Anything past the cap counts as "skipped" — same
      // semantic as the original loop's batch limit.
      const candidatesToCompile = candidatePages.slice(0, maxCompilePerRun);
      skipped = candidatePages.length - candidatesToCompile.length;

      // Bounded-parallel compile. With LLM calls ~30s each at concurrency 5,
      // a 15-page batch finishes in ~3 waves (~90s) instead of 15 × 30 = 450s
      // serial. Each worker checks the wall budget before its LLM call so a
      // straggler can't push us into the 150s wall.
      await runWithConcurrency(
        candidatesToCompile,
        COMPILE_CONCURRENCY,
        async (page) => {
          if (Date.now() - startTime > RUN_BUDGET_MS) {
            budgetExhausted = true;
            return;
          }
          const result = await compilePage(
            page,
            allSlugs,
            compileModel,
            targetedIntakeLimit,
          );
          if (result.updated) {
            compiled++;
            compiledSlugs.push(page.slug);
          } else if (result.error) {
            console.error(`Compile error for ${page.slug}: ${result.error}`);
            errors++;
            errored.push({ slug: page.slug, error: result.error });
          }
          // If not updated and no error, page had no new thoughts (rare
          // after the pre-filter, but possible if a thought is deleted
          // between probe and compile).
        },
      );

      if (budgetExhausted) {
        // Workers that bailed before their LLM call get rolled into skipped.
        // Next cron run picks them up via the same NULLS-FIRST sort.
        const processed = compiled + errors;
        skipped += candidatesToCompile.length - processed;
        console.log(
          `compile-pages: wall budget reached after ${
            Date.now() - startTime
          }ms; deferring remainder to next run`,
        );
      }
    }

    // Compile the self-index page LAST so it reflects every other page's
    // current state. Best-effort: errors are logged but don't fail the run.
    // In auto mode, only run it when this invocation did no entity-page LLM
    // work. This keeps the daily cron from stacking index synthesis on top of
    // a heavy entity compile batch.
    let indexCompiled = false;
    let indexSkippedReason: string | undefined;
    const shouldCompileIndex = indexMode === "force" ||
      (indexMode === "auto" && compiled === 0 && errors === 0);
    const indexBudgetOk = Date.now() - startTime <= RUN_BUDGET_MS;

    if (shouldCompileIndex && indexBudgetOk) {
      try {
        // Re-fetch to capture any content updates from this run
        const { data: freshAllPages } = await supabase
          .from("compiled_pages")
          .select("slug, title, page_type, content, last_compiled")
          .order("slug", { ascending: true });
        const indexResult = await compileIndexPage(freshAllPages || []);
        if (indexResult.updated) {
          indexCompiled = true;
        } else if (indexResult.error) {
          console.error(`Index compile error: ${indexResult.error}`);
          indexSkippedReason = `index compile failed: ${indexResult.error}`;
        }
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`Index compile threw: ${msg}`);
        indexSkippedReason = `index compile threw: ${msg}`;
      }
    } else if (indexMode === "skip") {
      indexSkippedReason = "disabled by index=skip";
    } else if (shouldCompileIndex && !indexBudgetOk) {
      indexSkippedReason = "wall budget exhausted before index compile";
    } else {
      indexSkippedReason = "deferred after entity-page work";
    }

    // Lint pass (only when requested, typically weekly)
    let lint: LintResult | undefined;
    if (mode === "lint") {
      // Re-fetch pages with updated content for lint
      const [{ data: freshPages }, { data: curatedProjects, error: projectsError }] =
        await Promise.all([
          supabase
            .from("compiled_pages")
            .select("slug, title, page_type, content, last_compiled")
            .order("slug", { ascending: true }),
          supabase.from("projects").select("slug"),
        ]);
      if (projectsError) {
        console.error(
          `[compile-pages] curated project lookup failed: ${projectsError.message}`,
        );
      }
      const curatedProjectSlugs = new Set(
        (curatedProjects || []).map((project) => project.slug),
      );
      lint = await runLint(freshPages || [], curatedProjectSlugs);
    }

    const response: Record<string, unknown> = {
      status: "complete",
      pages_total: allPages.length,
      auto_created: autoCreated,
      compiled,
      skipped,
      errors,
      compiled_slugs: compiledSlugs,
      errored,
      index_compiled: indexCompiled,
      index_mode: indexMode,
    };
    if (indexSkippedReason) response.index_skipped_reason = indexSkippedReason;
    if (lint) response.lint = lint;

    console.log(
      `Compilation complete: ${compiled} updated, ${autoCreated} created, ${errors} errors, index ${
        indexCompiled ? "updated" : indexSkippedReason || "unchanged"
      }`,
    );

    const durationMs = Date.now() - startTime;
    const auditWrite = supabase
      .from("compile_pages_runs")
      .insert({
        mode,
        index_mode: indexMode,
        batch: maxCompilePerRun,
        pages_total: allPages.length,
        auto_created: autoCreated,
        compiled,
        skipped,
        errors,
        index_compiled: indexCompiled,
        index_skipped_reason: indexSkippedReason ?? null,
        compiled_slugs: compiledSlugs,
        errored,
        status: "complete",
        error_message: null,
        duration_ms: durationMs,
        invoker,
      })
      .then((r: { error?: { message?: string } | null }) => {
        if (r.error) {
          console.error(
            `[compile-pages-runs] insert failed: ${r.error.message}`,
          );
        }
      });
    EdgeRuntime.waitUntil(auditWrite);

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("Compile-pages error:", err);
    try {
      const auditWrite = supabase
        .from("compile_pages_runs")
        .insert({
          mode: "unknown",
          index_mode: "unknown",
          status: "errored",
          error_message: msg,
        })
        .then((r: { error?: { message?: string } | null }) => {
          if (r.error) {
            console.error(
              `[compile-pages-runs] error-path insert failed: ${r.error.message}`,
            );
          }
        });
      EdgeRuntime.waitUntil(auditWrite);
    } catch (_writeErr) {
      // best-effort: don't let audit failure mask the original error
    }
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
