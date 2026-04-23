import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { searchThoughts, searchPages } from "@/lib/openBrainApi";
import { APP } from "@/config/app";

export const maxDuration = 30;

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const SYSTEM_PROMPT = `You are the ${APP.name} neural interface. You have access to a semantic memory system containing thoughts, wiki pages, client records, and business context.

Answer questions using the provided context. Be direct, specific, and reference the source material when relevant. If the context doesn't contain the answer, say so honestly.

Use a slightly technical, terminal-friendly tone. Keep responses concise but thorough. Format with markdown when it helps readability.`;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const lastUserMessage = [...(messages ?? [])]
    .reverse()
    .find((m: { role: string }) => m.role === "user");
  const query = lastUserMessage?.content ?? "";

  const [thoughts, pages] = await Promise.all([
    searchThoughts(query, 8),
    searchPages(query),
  ]);

  const contextParts: string[] = [];

  if (thoughts.length > 0) {
    contextParts.push("## Relevant Thoughts\n");
    for (const t of thoughts) {
      const sim = (t.similarity * 100).toFixed(0);
      const meta = t.metadata ?? {};
      const tags = [
        meta.type && `type:${meta.type}`,
        meta.project && `project:${meta.project}`,
        Array.isArray(meta.topics) && meta.topics.length > 0 && `topics:${(meta.topics as string[]).join(",")}`,
      ]
        .filter(Boolean)
        .join(" | ");
      contextParts.push(`[${sim}% match${tags ? " | " + tags : ""}]\n${t.content}\n`);
    }
  }

  if (pages.length > 0) {
    contextParts.push("## Relevant Wiki Pages\n");
    for (const p of pages.slice(0, 3)) {
      const content =
        p.content && p.content.length > 1500
          ? p.content.slice(0, 1500) + "\n...[truncated]"
          : (p.content ?? "");
      contextParts.push(`### ${p.title} (${p.page_type})\n${content}\n`);
    }
  }

  const contextBlock =
    contextParts.length > 0
      ? `\n\n<context>\n${contextParts.join("\n")}</context>`
      : `\n\n<context>No relevant context found in ${APP.name}.</context>`;

  const result = streamText({
    model: openrouter.chat("anthropic/claude-sonnet-4.6"),
    system: SYSTEM_PROMPT + contextBlock,
    messages,
  });

  return result.toTextStreamResponse();
}
