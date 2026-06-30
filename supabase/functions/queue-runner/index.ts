import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  runQueueRunnerHeartbeat,
  type SlackClient,
  type ToolClient,
} from "./_runner.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN") || "";
const SLACK_QUEUE_RUNNER_CHANNEL = Deno.env.get("SLACK_QUEUE_RUNNER_CHANNEL") ||
  Deno.env.get("SLACK_DIGEST_CHANNEL") ||
  Deno.env.get("SLACK_CAPTURE_CHANNEL") ||
  "";
const MCP_URL = Deno.env.get("BRAIN_BANK_MCP_URL") ||
  Deno.env.get("OPEN_BRAIN_MCP_URL") ||
  `${SUPABASE_URL}/functions/v1/open-brain-mcp`;

interface JsonRpcPayload {
  error?: unknown;
  result?: {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
}

class HttpMcpClient implements ToolClient {
  private requestId = 0;

  async callTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-brain-key": MCP_ACCESS_KEY,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `queue-runner-${Date.now()}-${++this.requestId}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    const payload = text ? parseMcpResponse(text) : null;
    if (!response.ok) {
      throw new Error(`MCP ${name} HTTP ${response.status}: ${text}`);
    }
    if (payload?.error) {
      throw new Error(`MCP ${name} error: ${JSON.stringify(payload.error)}`);
    }
    if (payload?.result?.isError) {
      throw new Error(`MCP ${name} tool error: ${parseToolText(payload)}`);
    }
    return JSON.parse(parseToolText(payload)) as T;
  }
}

class SlackPostClient implements SlackClient {
  async post(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!SLACK_BOT_TOKEN || !SLACK_QUEUE_RUNNER_CHANNEL) {
      return { ok: false, error: "Slack token or channel is not configured" };
    }
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: SLACK_QUEUE_RUNNER_CHANNEL,
        text,
        unfurl_links: false,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        error: data?.error || `Slack HTTP ${response.status}`,
      };
    }
    return { ok: true };
  }
}

function parseMcpResponse(text: string): JsonRpcPayload {
  const trimmed = text.trim();
  if (trimmed.startsWith("event:")) {
    const dataLine = trimmed.split(/\r?\n/).find((line) =>
      line.startsWith("data:")
    );
    if (!dataLine) throw new Error(`No MCP data line in response: ${trimmed}`);
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(trimmed);
}

function parseToolText(payload: JsonRpcPayload | null): string {
  const text = payload?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(
      `MCP tool result had no text content: ${JSON.stringify(payload)}`,
    );
  }
  return text;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const provided = req.headers.get("x-brain-key");
    if (!provided || provided !== MCP_ACCESS_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(req.url);
    const sendSlack = url.searchParams.get("send_slack") !== "false";
    const agentCode = url.searchParams.get("agent_code") || "local-codex";
    const result = await runQueueRunnerHeartbeat({
      agentCode,
      maxRisk: "low",
      mcp: new HttpMcpClient(),
      slack: new SlackPostClient(),
      sendSlack,
    });

    const status = result.status.startsWith("failed") ? 500 : 200;
    return jsonResponse(result, status);
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});
