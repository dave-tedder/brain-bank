import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadProfile } from "../_shared/profile.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const SLACK_DIGEST_CHANNEL =
  Deno.env.get("SLACK_DIGEST_CHANNEL") || Deno.env.get("SLACK_CAPTURE_CHANNEL")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;
const NOTION_API_TOKEN = Deno.env.get("NOTION_API_TOKEN") || "";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Daily-mode pre-brief filter: which event_types count as "client-facing"
// for cross-referencing with the clients table. Sourced from profile so
// non-tattoo operators can configure their own event semantics.
const clientEventTypes = loadProfile().client_event_types;

// --- Slack ---

async function postToSlack(channel: string, text: string): Promise<void> {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const d = await r.json();
  if (!d.ok) console.error("Slack post error:", d.error);
}

// --- Synthesis ---

interface WeeklyEnhancements {
  previousWeek: WeekSnapshot;
  staleActions: Array<{ description: string; created_at: string }>;
  deadlines: Array<{ content: string; dates: string[] }>;
  momentum: TopicMomentum[];
}

async function synthesizeDigest(
  thoughts: Array<{
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }>,
  mode: string,
  extensionContext?: string,
  weeklyEnhancements?: WeeklyEnhancements
): Promise<string> {
  const context = thoughts
    .map((t, i) => {
      const date = new Date(t.created_at).toLocaleDateString();
      const m = t.metadata || {};
      const topics = Array.isArray(m.topics)
        ? (m.topics as string[]).join(", ")
        : "";
      const type = (m.type as string) || "";
      return `[${i + 1}] (${date}, ${type}${topics ? " - " + topics : ""}) ${t.content}`;
    })
    .join("\n\n");

  // Collect people and topics for structured sections
  const peopleCounts: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};

  for (const t of thoughts) {
    const m = t.metadata || {};
    if (Array.isArray(m.people)) {
      for (const p of m.people as string[])
        peopleCounts[p] = (peopleCounts[p] || 0) + 1;
    }
    if (Array.isArray(m.topics)) {
      for (const tp of m.topics as string[])
        topicCounts[tp] = (topicCounts[tp] || 0) + 1;
    }
  }

  // Pull open action items from the action_items table (source of truth)
  const { data: openActions } = await supabase
    .from("action_items")
    .select("description, created_at")
    .eq("status", "open")
    .order("created_at", { ascending: true });

  const actionItemsText = openActions && openActions.length > 0
    ? openActions.map((a) => a.description).join("; ")
    : "none";

  const structuredLines = [
    `Open action items (verified, not yet resolved): ${actionItemsText}`,
    `Top topics: ${Object.entries(topicCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, c]) => `${t} (${c})`).join(", ") || "none"}`,
    `People mentioned: ${Object.entries(peopleCounts).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p} (${c})`).join(", ") || "none"}`,
  ];

  // Weekly enhancements: week-over-week, stale items, deadlines
  if (weeklyEnhancements) {
    const { previousWeek, staleActions, deadlines } = weeklyEnhancements;

    // Week-over-week topic shifts
    const prevTopics = previousWeek.topicCounts;
    const newTopics = Object.keys(topicCounts).filter((t) => !prevTopics[t]);
    const droppedTopics = Object.keys(prevTopics).filter((t) => !topicCounts[t]);
    const risingTopics = Object.entries(topicCounts)
      .filter(([t, c]) => prevTopics[t] && c > prevTopics[t])
      .map(([t, c]) => `${t} (${prevTopics[t]} -> ${c})`);

    structuredLines.push(
      `Week-over-week: ${thoughts.length} thoughts this week vs ${previousWeek.thoughtCount} last week`
    );
    if (newTopics.length > 0)
      structuredLines.push(`New topics this week: ${newTopics.join(", ")}`);
    if (droppedTopics.length > 0)
      structuredLines.push(`Topics from last week now quiet: ${droppedTopics.join(", ")}`);
    if (risingTopics.length > 0)
      structuredLines.push(`Rising topics: ${risingTopics.join(", ")}`);

    // Stale action items
    if (staleActions.length > 0) {
      const staleText = staleActions
        .map((a) => {
          const age = Math.floor(
            (Date.now() - new Date(a.created_at).getTime()) / 86400000
          );
          return `${a.description} (${age} days old)`;
        })
        .join("; ");
      structuredLines.push(`Stale action items (open 7+ days): ${staleText}`);
    }

    // Approaching deadlines
    if (deadlines.length > 0) {
      const deadlineText = deadlines
        .map((d) => `"${d.content.substring(0, 80)}..." (dates: ${d.dates.join(", ")})`)
        .join("; ");
      structuredLines.push(`Approaching deadlines (next 14 days): ${deadlineText}`);
    }

    // Topic momentum (4-week trend, 50%+ increase)
    const { momentum } = weeklyEnhancements;
    if (momentum.length > 0) {
      const momentumText = momentum
        .map((m) => `${m.topic} (+${m.changePercent}%, ${m.fourWeekAvg}/wk avg -> ${m.thisWeek} this week)`)
        .join("; ");
      structuredLines.push(`Trending topics (4-week momentum, 50%+ increase): ${momentumText}`);
    }
  }

  const structuredContext = structuredLines.join("\n");

  const timeframe = mode === "weekly" ? "past week" : "past 24 hours";
  const todayDate = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });

  const systemPrompt =
    mode === "weekly"
      ? `You are a personal knowledge assistant generating a weekly brain digest for ${loadProfile().persona.digest}. Today is ${todayDate}. Review all thoughts captured in the past week, plus any business context and week-over-week comparison data provided, and provide:

1. A narrative summary of the key themes and what's been on his mind (2-4 sentences, conversational tone)
2. Week-over-week shifts: what's new this week vs last week, what dropped off, what's gaining momentum. Use the comparison data provided. If volume changed significantly, note it.
3. Connections between thoughts that might not be obvious at first glance
4. Any emerging threads worth paying attention to
5. If there are approaching deadlines (from the structured data), call them out clearly with dates
6. If there are stale action items (open 7+ days), flag them with how old they are. These need attention or should be closed.
7. If there are upcoming events or sessions, mention what's coming up and anything he should prepare for
8. All open action items that still need attention (as a checklist). These are pre-verified as genuinely open, so list them all.

Be direct and conversational. No corporate language. No words like "delve", "tapestry", "robust", "synergy", "holistic", or "leverage". No em dashes. Write like a knowledgeable friend giving a weekly recap.`
      : `You are a personal knowledge assistant generating a daily morning briefing for ${loadProfile().persona.digest}. Today is ${todayDate}. This digest is delivered first thing in the morning. The thoughts below are from YESTERDAY (the previous 24 hours), not today. Frame everything in past tense referring to yesterday, not "today."

Review all thoughts captured yesterday, plus any business context provided (upcoming events, recent sessions, content pipeline status, client context), and provide:

1. A brief narrative summary (2-3 sentences) of what was on his mind yesterday
2. Any connections between yesterday's thoughts that might not be obvious
3. Pre-appointment briefing: if there are appointments labeled "TODAY" in the business context, lead with them. For each, include the client name, what the session is (piece, placement, style), and any relevant context from the brain (previous conversations, preferences, notes). This is the most actionable part of the digest. If no events are labeled "TODAY", say so clearly (e.g., "No appointments on the books today.").
4. IMPORTANT: Do NOT present events from future dates as today's appointments. Events labeled "LATER THIS WEEK" are NOT today. Only events explicitly labeled "TODAY" are today's appointments.
5. List ALL upcoming ${loadProfile().domain.plural_noun} and consultations later this week individually, with client name, date, and what the session is. Do NOT collapse individual appointments into broader events (e.g., a multi-day event does not replace listing individual ${loadProfile().domain.plural_noun} happening during that span)
6. If there are related Notion intake submissions for today's clients, mention any relevant details
7. Open action items that still need attention (as a short checklist, only if any exist). These are pre-verified as genuinely open, so list them all.

Be direct and conversational. No corporate language. No words like "delve", "tapestry", "robust", "synergy", "holistic", or "leverage". No em dashes. Keep it under 300 words.`;

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
        {
          role: "user",
          content: `Here are the ${thoughts.length} thoughts from the ${timeframe}:\n\n${context}\n\n---\nStructured metadata:\n${structuredContext}${extensionContext ? "\n\n---\nBusiness context (from extensions):\n" + extensionContext : ""}`,
        },
      ],
    }),
  });

  const d = await r.json();
  return d.choices[0].message.content.trim();
}

// --- Previous Week Context (week-over-week comparison) ---

interface WeekSnapshot {
  topicCounts: Record<string, number>;
  peopleCounts: Record<string, number>;
  thoughtCount: number;
}

async function gatherPreviousWeekContext(): Promise<WeekSnapshot> {
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const fourteenDaysAgo = new Date(now);
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const { data } = await supabase
    .from("thoughts")
    .select("metadata")
    .gte("created_at", fourteenDaysAgo.toISOString())
    .lt("created_at", sevenDaysAgo.toISOString());

  const topicCounts: Record<string, number> = {};
  const peopleCounts: Record<string, number> = {};

  for (const t of data || []) {
    const m = t.metadata || {};
    if (Array.isArray(m.topics)) {
      for (const tp of m.topics as string[])
        topicCounts[tp] = (topicCounts[tp] || 0) + 1;
    }
    if (Array.isArray(m.people)) {
      for (const p of m.people as string[])
        peopleCounts[p] = (peopleCounts[p] || 0) + 1;
    }
  }

  return { topicCounts, peopleCounts, thoughtCount: data?.length || 0 };
}

// --- Stale Action Items ---

async function getStaleActionItems(): Promise<
  Array<{ description: string; created_at: string }>
> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const { data } = await supabase
    .from("action_items")
    .select("description, created_at")
    .eq("status", "open")
    .lt("created_at", sevenDaysAgo.toISOString())
    .order("created_at", { ascending: true });

  return data || [];
}

// --- Deadline Detection ---

async function getApproachingDeadlines(): Promise<
  Array<{ content: string; dates: string[] }>
> {
  const now = new Date();
  const twoWeeksOut = new Date(now);
  twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
  const todayStr = now.toISOString().split("T")[0];
  const cutoffStr = twoWeeksOut.toISOString().split("T")[0];

  // Query thoughts that have dates_mentioned in metadata
  const { data } = await supabase
    .from("thoughts")
    .select("content, metadata")
    .not("metadata->dates_mentioned", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);

  const results: Array<{ content: string; dates: string[] }> = [];

  for (const t of data || []) {
    const m = t.metadata || {};
    const dates = m.dates_mentioned as string[] | undefined;
    if (!Array.isArray(dates) || dates.length === 0) continue;

    const upcoming = dates.filter((d) => {
      // Accept YYYY-MM-DD format dates within the window
      if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return false;
      const dateStr = d.substring(0, 10);
      return dateStr >= todayStr && dateStr <= cutoffStr;
    });

    if (upcoming.length > 0) {
      results.push({
        content: t.content.substring(0, 200),
        dates: upcoming,
      });
    }
  }

  return results;
}

// --- Topic Momentum (4-week trend) ---

interface TopicMomentum {
  topic: string;
  thisWeek: number;
  fourWeekAvg: number;
  changePercent: number;
}

async function getTopicMomentum(): Promise<TopicMomentum[]> {
  const now = new Date();
  const fourWeeksAgo = new Date(now);
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const oneWeekAgo = new Date(now);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const { data } = await supabase
    .from("thoughts")
    .select("metadata, created_at")
    .gte("created_at", fourWeeksAgo.toISOString())
    .order("created_at", { ascending: true });

  if (!data || data.length === 0) return [];

  // Bucket topics by week (weeks 1-3 = historical, week 4 = current)
  const historicalCounts: Record<string, number> = {};
  const currentCounts: Record<string, number> = {};

  for (const t of data) {
    const m = t.metadata || {};
    if (!Array.isArray(m.topics)) continue;
    const created = new Date(t.created_at);
    const isCurrent = created >= oneWeekAgo;

    for (const tp of m.topics as string[]) {
      if (isCurrent) {
        currentCounts[tp] = (currentCounts[tp] || 0) + 1;
      } else {
        historicalCounts[tp] = (historicalCounts[tp] || 0) + 1;
      }
    }
  }

  // Compute momentum: this week vs 3-week average
  const results: TopicMomentum[] = [];
  for (const [topic, thisWeek] of Object.entries(currentCounts)) {
    const historicalTotal = historicalCounts[topic] || 0;
    const threeWeekAvg = historicalTotal / 3;
    if (threeWeekAvg === 0) continue; // New topic, already covered by week-over-week
    const changePercent = ((thisWeek - threeWeekAvg) / threeWeekAvg) * 100;
    if (changePercent >= 50) {
      results.push({
        topic,
        thisWeek,
        fourWeekAvg: Math.round(threeWeekAvg * 10) / 10,
        changePercent: Math.round(changePercent),
      });
    }
  }

  return results.sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
}

// --- Extension Context ---

async function gatherExtensionContext(
  mode: string
): Promise<{ text: string; clientMatches: Array<{ id: string; name: string }> }> {
  const sections: string[] = [];
  const allClientMatches: Array<{ id: string; name: string }> = [];
  const lookAhead = mode === "weekly" ? 14 : 7;
  const lookBack = mode === "weekly" ? 7 : 1;

  try {
    // Upcoming events (next 7-14 days)
    // Use Eastern Time for "today" to match the user's local date
    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const today = nowET.getFullYear() + "-" +
      String(nowET.getMonth() + 1).padStart(2, "0") + "-" +
      String(nowET.getDate()).padStart(2, "0");
    const until = new Date();
    until.setDate(until.getDate() + lookAhead);
    const { data: events } = await supabase
      .from("business_events")
      .select("event_type, title, date_start, date_end, location, metadata")
      .gte("date_start", today)
      .lte("date_start", until.toISOString().split("T")[0])
      .order("date_start", { ascending: true })
      .limit(20);

    if (events?.length) {
      // Separate today's events from future events
      const todayEventsAll = events.filter((e) => e.date_start === today);
      const futureEvents = events.filter((e) => e.date_start !== today);

      if (todayEventsAll.length > 0) {
        sections.push(`TODAY's events (${today}):`);
        for (const e of todayEventsAll) {
          const meta = (e as unknown as { metadata?: { start_time?: string } }).metadata;
          const time = meta?.start_time ? ` at ${meta.start_time}` : "";
          sections.push(`  [${e.event_type}] ${e.title}${time}${e.location ? " at " + e.location : ""}`);
        }
      } else {
        sections.push(`No events scheduled for TODAY (${today}).`);
      }

      if (futureEvents.length > 0) {
        sections.push("LATER THIS WEEK:");
        for (const e of futureEvents.slice(0, 10)) {
          const dayName = new Date(e.date_start + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
          sections.push(`  ${dayName}, ${e.date_start}${e.date_end && e.date_end !== e.date_start ? " to " + e.date_end : ""} [${e.event_type}] ${e.title}${e.location ? " at " + e.location : ""}`);
        }
      }
    } else {
      sections.push(`No events scheduled for TODAY (${today}) or the coming week.`);
    }

    // Recent sessions (last 1-7 days)
    const sessionSince = new Date();
    sessionSince.setDate(sessionSince.getDate() - lookBack);
    const { data: sessions } = await supabase
      .from("client_sessions")
      .select("session_date, status, piece_description, placement, style")
      .gte("session_date", sessionSince.toISOString().split("T")[0])
      .order("session_date", { ascending: false })
      .limit(10);

    if (sessions?.length) {
      sections.push(`Recent ${loadProfile().domain.plural_noun}:`);
      for (const s of sessions) {
        const parts = [`  ${s.session_date} (${s.status})`];
        if (s.piece_description) parts.push(s.piece_description);
        if (s.placement) parts.push(`on ${s.placement}`);
        if (s.style) parts.push(`[${s.style}]`);
        sections.push(parts.join(" - "));
      }
    }

    // Daily mode: pre-appointment briefings with client context
    if (mode === "daily") {
      const todayEvents = events?.filter((e) => e.date_start === today) || [];
      const clientEvents = todayEvents.filter((e) => clientEventTypes.includes(e.event_type));
      if (clientEvents.length > 0) {
        // Extract attendee names from business events only
        const attendeeNames: string[] = [];
        const ownerEmails: string[] = loadProfile().operator.emails.map((e) => e.toLowerCase());
        for (const e of clientEvents) {
          const meta = (e as unknown as { metadata?: { attendees?: string[] } }).metadata;
          if (meta?.attendees) {
            for (const a of meta.attendees) {
              if (!ownerEmails.includes(a.toLowerCase())) attendeeNames.push(a);
            }
          }
        }

        // Match attendees against clients table
        if (attendeeNames.length > 0) {
          const clientMatches: Array<{ name: string; id: string }> = [];
          const unmatchedAttendees: string[] = [];
          for (const attendee of attendeeNames) {
            const isEmail = attendee.includes("@");
            let matched: Array<{ id: string; name: string; preferred_styles?: string[]; notes?: string }> | null = null;
            if (isEmail) {
              // Try email match first
              const { data } = await supabase
                .from("clients")
                .select("id, name, preferred_styles, notes")
                .ilike("email", `%${attendee}%`)
                .limit(1);
              matched = data;
              // Fallback: extract name from email (e.g. alex.rivera@example.com -> alex rivera)
              if ((!matched || matched.length === 0) && attendee.includes("@")) {
                const localPart = attendee.split("@")[0].replace(/[._+]/g, " ").trim();
                if (localPart.length > 2) {
                  const { data: nameMatched } = await supabase
                    .from("clients")
                    .select("id, name, preferred_styles, notes")
                    .ilike("name", `%${localPart}%`)
                    .limit(1);
                  matched = nameMatched;
                }
              }
            } else {
              // Try full name match first
              const { data } = await supabase
                .from("clients")
                .select("id, name, preferred_styles, notes")
                .ilike("name", `%${attendee}%`)
                .limit(1);
              matched = data;
              // Fallback: try first two words only (handles "Alex Rivera Consultation 2pm" -> "Alex Rivera")
              if ((!matched || matched.length === 0) && attendee.includes(" ")) {
                const words = attendee.split(/\s+/);
                if (words.length > 2) {
                  const shortName = words.slice(0, 2).join(" ");
                  const { data: shortMatched } = await supabase
                    .from("clients")
                    .select("id, name, preferred_styles, notes")
                    .ilike("name", `%${shortName}%`)
                    .limit(1);
                  matched = shortMatched;
                }
              }
            }
            if (matched && matched.length > 0) {
              clientMatches.push(matched[0]);
              if (!allClientMatches.some((c) => c.id === matched[0].id)) {
                allClientMatches.push({ id: matched[0].id, name: matched[0].name });
              }
            } else if (attendee.trim()) {
              unmatchedAttendees.push(attendee);
            }
          }

          // Client integrity warning: flag attendees with no client record
          if (unmatchedAttendees.length > 0) {
            sections.push(
              `CLIENT RECORD MISSING: The following attendees on today's appointments have no matching client record in the system: ${unmatchedAttendees.join(", ")}. Consider creating client stubs before the appointment.`
            );
          }

          // For each matched client, read compiled page (falls back to raw thoughts if no page exists)
          if (clientMatches.length > 0) {
            sections.push("Pre-appointment client context:");
            for (const client of clientMatches) {
              // Try compiled page first
              const clientSlug = `client/${client.name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-")}`;
              const { data: compiledPage } = await supabase
                .from("compiled_pages")
                .select("content, last_compiled")
                .eq("slug", clientSlug)
                .single();

              if (compiledPage?.content) {
                // Use compiled page (generous truncation for pre-appointment briefings,
                // which are the most actionable part of the digest)
                const pagePreview = compiledPage.content.substring(0, 2500);
                sections.push(`  ${client.name} (compiled page, updated ${new Date(compiledPage.last_compiled).toLocaleDateString()}):\n${pagePreview}`);
              } else {
                // Fallback: raw thought search (same as before)
                const { data: relatedThoughts } = await supabase
                  .from("thoughts")
                  .select("content, created_at")
                  .contains("metadata", { people: [client.name] })
                  .order("created_at", { ascending: false })
                  .limit(3);

                const lines = [`  ${client.name}:`];
                if (client.notes) lines.push(`    Notes: ${client.notes}`);
                if (client.preferred_styles?.length) lines.push(`    Styles: ${client.preferred_styles.join(", ")}`);
                if (relatedThoughts?.length) {
                  for (const t of relatedThoughts) {
                    const d = new Date(t.created_at).toLocaleDateString();
                    lines.push(`    [${d}] ${t.content.substring(0, 150)}`);
                  }
                }
                sections.push(lines.join("\n"));
              }
            }
          }
        }

        // Cross-reference with Notion intake submissions
        const eventNames = todayEvents.map((e) => e.title.toLowerCase());
        const { data: notionThoughts } = await supabase
          .from("thoughts")
          .select("content, created_at")
          .like("content", "%[Notion Sync]%")
          .order("created_at", { ascending: false })
          .limit(50);

        if (notionThoughts?.length) {
          const matchedIntake: string[] = [];
          for (const t of notionThoughts) {
            const lower = t.content.toLowerCase();
            for (const name of eventNames) {
              // Check if any attendee or event title keywords appear in Notion intake
              const words = name.split(/[\s\-:]+/).filter((w) => w.length > 3);
              if (words.some((w) => lower.includes(w))) {
                matchedIntake.push(`  [${new Date(t.created_at).toLocaleDateString()}] ${t.content.substring(0, 200)}`);
                break;
              }
            }
          }
          if (matchedIntake.length > 0) {
            sections.push("Related Notion intake for today's appointments:");
            sections.push(...matchedIntake.slice(0, 5));
          }
        }
      }
    }

    // Upcoming client sessions (next 7 days, weekly mode)
    if (mode === "weekly") {
      const upcomingUntil = new Date();
      upcomingUntil.setDate(upcomingUntil.getDate() + 7);
      const { data: upcomingSessions } = await supabase
        .from("client_sessions")
        .select("session_date, piece_description, placement, style, client_id")
        .gte("session_date", today)
        .lte("session_date", upcomingUntil.toISOString().split("T")[0])
        .order("session_date", { ascending: true })
        .limit(10);

      if (upcomingSessions?.length) {
        // Fetch client names for matched sessions
        const clientIds = [...new Set(upcomingSessions.map((s) => s.client_id).filter(Boolean))];
        let clientNames: Record<string, string> = {};
        if (clientIds.length > 0) {
          const { data: clients } = await supabase
            .from("clients")
            .select("id, name")
            .in("id", clientIds);
          if (clients) {
            clientNames = Object.fromEntries(clients.map((c) => [c.id, c.name]));
          }
        }

        sections.push("Upcoming sessions (next 7 days):");
        for (const s of upcomingSessions) {
          const name = s.client_id ? clientNames[s.client_id] || "unknown client" : "no client linked";
          const parts = [`  ${s.session_date} - ${name}`];
          if (s.piece_description) parts.push(s.piece_description);
          if (s.placement) parts.push(`on ${s.placement}`);
          if (s.style) parts.push(`[${s.style}]`);
          sections.push(parts.join(" - "));
        }
      }
    }

    // Content pipeline summary
    const { data: content } = await supabase
      .from("content_items")
      .select("stage");
    if (content?.length) {
      const stages: Record<string, number> = {};
      for (const c of content) stages[c.stage] = (stages[c.stage] || 0) + 1;
      const summary = Object.entries(stages).map(([s, n]) => `${s}: ${n}`).join(", ");
      sections.push(`Content pipeline: ${summary}`);
    }

    // Active client count
    const { count: activeClients } = await supabase
      .from("clients")
      .select("*", { count: "exact", head: true })
      .gte("last_contact", sessionSince.toISOString());
    if (activeClients && activeClients > 0) {
      sections.push(`Active clients (last ${lookBack} day${lookBack > 1 ? "s" : ""}): ${activeClients}`);
    }
  } catch (err) {
    console.error("Extension context error (non-fatal):", err);
  }

  return { text: sections.join("\n"), clientMatches: allClientMatches };
}

// --- Notion Insight Push ---

interface InsightTarget {
  entityName: string;
  notionPageId: string;
  mappingId: string;
}

async function pushInsightsToNotion(
  digest: string,
  thoughts: Array<{ content: string; metadata: Record<string, unknown>; created_at: string }>
): Promise<{ pushed: number; errors: number }> {
  if (!NOTION_API_TOKEN) {
    console.log("Notion push skipped: NOTION_API_TOKEN not set");
    return { pushed: 0, errors: 0 };
  }

  // Get all notion mappings
  const { data: mappings } = await supabase
    .from("notion_mappings")
    .select("id, entity_type, entity_name, notion_page_id, last_synced");

  if (!mappings || mappings.length === 0) {
    console.log("Notion push skipped: no mappings configured");
    return { pushed: 0, errors: 0 };
  }

  // Count mentions per entity to find which ones deserve an insight push
  const entityMentions: Record<string, number> = {};
  for (const t of thoughts) {
    const m = t.metadata || {};
    // Check people mentions
    if (Array.isArray(m.people)) {
      for (const p of m.people as string[]) {
        entityMentions[p.toLowerCase()] = (entityMentions[p.toLowerCase()] || 0) + 1;
      }
    }
    // Check project field
    if (m.project && typeof m.project === "string") {
      entityMentions[m.project.toLowerCase()] = (entityMentions[m.project.toLowerCase()] || 0) + 1;
    }
    // Check topics
    if (Array.isArray(m.topics)) {
      for (const tp of m.topics as string[]) {
        entityMentions[tp.toLowerCase()] = (entityMentions[tp.toLowerCase()] || 0) + 1;
      }
    }
  }

  // Find eligible targets: entities mentioned 3+ times this week
  const targets: InsightTarget[] = [];
  for (const mapping of mappings) {
    const name = mapping.entity_name.toLowerCase();
    const count = entityMentions[name] || 0;

    // Threshold: 3+ mentions for clients/topics, always push to project pages
    if (count >= 3 || mapping.entity_type === "project") {
      // Dedup: skip if already synced within the past 6 days
      if (mapping.last_synced) {
        const daysSinceSync = (Date.now() - new Date(mapping.last_synced).getTime()) / 86400000;
        if (daysSinceSync < 6) {
          console.log(`Notion push skipped for ${mapping.entity_name}: synced ${Math.round(daysSinceSync)} days ago`);
          continue;
        }
      }
      targets.push({
        entityName: mapping.entity_name,
        notionPageId: mapping.notion_page_id,
        mappingId: mapping.id,
      });
    }
  }

  if (targets.length === 0) {
    console.log("Notion push: no entities met the threshold or all recently synced");
    return { pushed: 0, errors: 0 };
  }

  let pushed = 0;
  let errors = 0;
  const now = new Date().toISOString();
  const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  for (const target of targets) {
    // Rate limit: 300ms between Notion API calls (< 3 req/sec)
    if (pushed > 0 || errors > 0) {
      await new Promise((r) => setTimeout(r, 300));
    }

    // Build insight text for this entity
    const entityThoughts = thoughts.filter((t) => {
      const m = t.metadata || {};
      const people = (Array.isArray(m.people) ? m.people as string[] : []).map((p) => p.toLowerCase());
      const topics = (Array.isArray(m.topics) ? m.topics as string[] : []).map((tp) => tp.toLowerCase());
      const project = typeof m.project === "string" ? m.project.toLowerCase() : "";
      const targetLower = target.entityName.toLowerCase();
      return people.includes(targetLower) || topics.includes(targetLower) || project === targetLower;
    });

    const insightSummary = entityThoughts.length > 0
      ? entityThoughts.slice(0, 5).map((t) => t.content.substring(0, 150)).join("\n")
      : "General activity this week (see weekly digest for details).";

    try {
      const resp = await fetch(`https://api.notion.com/v1/blocks/${target.notionPageId}/children`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${NOTION_API_TOKEN}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify({
          children: [
            {
              object: "block",
              type: "callout",
              callout: {
                icon: { type: "emoji", emoji: "🧠" },
                rich_text: [
                  {
                    type: "text",
                    text: {
                      content: `Brain Insights (${dateStr}): ${entityThoughts.length} mention${entityThoughts.length !== 1 ? "s" : ""} this week\n\n${insightSummary.substring(0, 1800)}`,
                    },
                  },
                ],
                color: "blue_background",
              },
            },
          ],
        }),
      });

      if (resp.ok) {
        pushed++;
        // Update last_synced
        await supabase
          .from("notion_mappings")
          .update({ last_synced: now })
          .eq("id", target.mappingId);
        console.log(`Notion push: appended insight to ${target.entityName}`);
      } else {
        const errBody = await resp.text();
        console.error(`Notion push error for ${target.entityName}: ${resp.status} ${errBody}`);
        errors++;
      }
    } catch (err) {
      console.error(`Notion push exception for ${target.entityName}:`, err);
      errors++;
    }
  }

  return { pushed, errors };
}

// --- Main Handler ---

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    const url = new URL(req.url);
    const provided =
      req.headers.get("x-brain-key") || url.searchParams.get("key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const mode = url.searchParams.get("mode") || "daily";
    const pushToNotion = url.searchParams.get("push_to_notion") === "true";
    const days = mode === "weekly" ? 7 : 1;

    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await supabase
      .from("thoughts")
      .select("content, metadata, created_at")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Query error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!data || data.length < 2) {
      const reason = `Only ${data?.length || 0} thought(s) in the ${mode} window. Need at least 2.`;
      console.log(`Digest skipped: ${reason}`);
      return new Response(
        JSON.stringify({ status: "skipped", mode, reason }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Page compilation runs on its own pg_cron (compile-pages-daily at 09:45 UTC,
    // 15 minutes before this digest). Digest reads fresh results from compiled_pages
    // directly; no inline compile call needed. See gatherExtensionContext().

    // Gather extension context for richer digest
    const { text: extensionContext, clientMatches: referencedClients } =
      await gatherExtensionContext(mode);

    // Weekly enhancements: previous week comparison, stale items, deadlines
    let weeklyEnhancements: WeeklyEnhancements | undefined;
    if (mode === "weekly") {
      const [previousWeek, staleActions, deadlines, momentum] = await Promise.all([
        gatherPreviousWeekContext(),
        getStaleActionItems(),
        getApproachingDeadlines(),
        getTopicMomentum(),
      ]);
      weeklyEnhancements = { previousWeek, staleActions, deadlines, momentum };
    }

    const digest = await synthesizeDigest(data, mode, extensionContext, weeklyEnhancements);

    // Persist digest to digests table for dashboard consumption. Must NOT
    // block the Slack post. Log failure and continue. Upsert (not insert)
    // so a same-day re-fire overwrites the row.
    try {
      const nowET = new Date(
        new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
      );
      const todayET =
        nowET.getFullYear() +
        "-" +
        String(nowET.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(nowET.getDate()).padStart(2, "0");

      const [{ count: openActionsCount }, { count: resolvedActionsCount }] =
        await Promise.all([
          supabase
            .from("action_items")
            .select("*", { count: "exact", head: true })
            .eq("status", "open"),
          supabase
            .from("action_items")
            .select("*", { count: "exact", head: true })
            .eq("status", "resolved")
            .gte("resolved_at", since.toISOString()),
        ]);

      const digestMetadata = {
        briefing_count: referencedClients.length,
        open_actions_count: openActionsCount ?? 0,
        resolved_actions_count: resolvedActionsCount ?? 0,
        source_thought_count: data.length,
        referenced_client_ids: referencedClients.map((c) => c.id),
        referenced_client_names: referencedClients.map((c) => c.name),
        synthesizer_model: "anthropic/claude-sonnet-4.6",
      };

      const { error: digestError } = await supabase
        .from("digests")
        .upsert(
          {
            digest_date: todayET,
            digest_type: mode,
            markdown: digest,
            metadata: digestMetadata,
          },
          { onConflict: "digest_date,digest_type" }
        );

      if (digestError) {
        console.error("digest upsert failed (non-fatal):", digestError);
      }
    } catch (err) {
      console.error("digest persistence error (non-fatal):", err);
    }

    const header =
      mode === "weekly"
        ? ":brain: *Weekly Brain Digest*"
        : ":brain: *Daily Brain Digest*";
    let slackMessage = `${header} (${data.length} thoughts, ${mode === "weekly" ? "last 7 days" : "last 24 hours"})\n\n${digest}`;

    // Append wiki lint results to weekly digest
    if (mode === "weekly") {
      try {
        // compile-pages-weekly-lint cron (Mondays 09:30 UTC) handles the heavy work.
        // batch=0 makes this a cheap read-only lint results fetch.
        const lintUrl = `${SUPABASE_URL}/functions/v1/compile-pages?key=${MCP_ACCESS_KEY}&mode=lint&batch=0`;
        const lintRes = await fetch(lintUrl);
        if (lintRes.ok) {
          const lintData = await lintRes.json();
          const lint = lintData.lint;
          if (lint) {
            const lintLines: string[] = [];
            if (lint.stale_pages?.length > 0) {
              lintLines.push(`:warning: *Stale wiki pages:* ${lint.stale_pages.slice(0, 5).join(", ")}`);
            }
            if (lint.gap_entities?.length > 0) {
              lintLines.push(`:mag: *Missing wiki pages:* ${lint.gap_entities.slice(0, 5).join(", ")}`);
            }
            if (lint.contradiction_warnings?.length > 0) {
              lintLines.push(`:exclamation: *Contradictions detected:*\n${lint.contradiction_warnings.slice(0, 3).join("\n")}`);
            }
            if (lintLines.length > 0) {
              slackMessage += `\n\n---\n:books: *Wiki Health*\n${lintLines.join("\n")}`;
            }
          }
        }
      } catch (err) {
        console.error("Lint results fetch failed (non-fatal):", err);
      }
    }

    await postToSlack(SLACK_DIGEST_CHANNEL, slackMessage);

    // Self-capture: save weekly review as a thought for future reference
    if (mode === "weekly") {
      try {
        const captureUrl = `${SUPABASE_URL}/functions/v1/open-brain-mcp/capture`;
        const captureRes = await fetch(captureUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-brain-key": MCP_ACCESS_KEY,
          },
          body: JSON.stringify({
            content: `[Weekly Review] ${digest}`,
          }),
        });
        if (!captureRes.ok) {
          console.error("Self-capture failed:", captureRes.status, await captureRes.text());
        }
      } catch (err) {
        console.error("Self-capture error (non-fatal):", err);
      }
    }

    // Notion insight push (weekly mode only, opt-in via push_to_notion=true)
    let notionResult: { pushed: number; errors: number } | undefined;
    if (mode === "weekly" && pushToNotion) {
      try {
        notionResult = await pushInsightsToNotion(digest, data);
      } catch (err) {
        console.error("Notion push error (non-fatal):", err);
      }
    }

    return new Response(
      JSON.stringify({
        status: "delivered",
        mode,
        thoughts_count: data.length,
        channel: SLACK_DIGEST_CHANNEL,
        ...(notionResult ? { notion_push: notionResult } : {}),
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Digest error:", err);
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
