#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "your-project-ref";
const SUPABASE_URL = process.env.SUPABASE_URL ||
  `https://${PROJECT_REF}.supabase.co`;
const MCP_URL = process.env.BB_MCP_URL ||
  `${SUPABASE_URL}/functions/v1/brain-bank-mcp`;
const AGENT_CODE = process.env.OE_SMOKE_AGENT_CODE || "codex";
const RUN_ID = process.env.OE_SMOKE_RUN_ID ||
  new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const FETCH_TIMEOUT_MS = 60_000;

const REQUIRED_TASK_TOOLS = [
  "list_agent_tasks",
  "get_agent_task",
  "claim_next_agent_task",
  "claim_specific_agent_task",
  "update_agent_task",
  "complete_agent_task",
  "block_agent_task",
  "request_agent_review",
  "resume_agent_task",
  "unblock_agent_task",
  "answer_agent_task",
  "read_agent_ledger",
  "write_agent_ledger",
];

const PROTECTED_SMOKE_TASK_IDS = (process.env.OE_PROTECTED_SMOKE_TASK_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const createdTaskIds = [];

function log(message) {
  console.log(`[oe-mcp-smoke] ${message}`);
}

function readEnvFile(name) {
  if (!existsSync(name)) return {};
  const entries = {};
  for (const line of readFileSync(name, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    entries[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return entries;
}

function loadMcpKeyFromCodexConfig() {
  const configPath = join(process.env.HOME || "", ".codex", "config.toml");
  if (!existsSync(configPath)) return null;
  const text = readFileSync(configPath, "utf8");
  const section = text.match(/\[mcp_servers\.brain-bank\]([\s\S]*?)(?:\n\[|$)/);
  const haystack = section ? section[1] : text;
  const headerMatch = haystack.match(/x-brain-key:([^"',\]\s]+)/);
  const headerValue = headerMatch?.[1] || null;
  const envMatch = haystack.match(/BB_MCP_KEY\s*=\s*"([^"]+)"/);
  const envValue = envMatch?.[1] || null;
  if (headerValue?.startsWith("${") && envValue) return envValue;
  return headerValue || envValue;
}

function loadMcpKey() {
  if (process.env.BB_MCP_KEY) return process.env.BB_MCP_KEY;
  if (process.env.BRAIN_KEY) return process.env.BRAIN_KEY;
  return loadMcpKeyFromCodexConfig();
}

function loadServiceRoleFromCli() {
  try {
    const raw = execFileSync(
      "supabase",
      ["projects", "api-keys", "--project-ref", PROJECT_REF, "-o", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const keys = JSON.parse(raw);
    const service = keys.find((entry) =>
      entry.type === "service_role" ||
      entry.name === "service_role" ||
      /service/i.test(entry.name || "")
    );
    return service?.api_key || null;
  } catch {
    return null;
  }
}

function loadServiceRoleKey() {
  const envFile = readEnvFile(".env.local");
  return process.env.SUPABASE_SERVICE_ROLE_KEY ||
    envFile.SUPABASE_SERVICE_ROLE_KEY ||
    loadServiceRoleFromCli();
}

function requireSecrets() {
  const mcpKey = loadMcpKey();
  const serviceRoleKey = loadServiceRoleKey();
  if (!mcpKey) {
    throw new Error(
      "Missing Brain Bank MCP key. Set BB_MCP_KEY or BRAIN_KEY, or keep x-brain-key in ~/.codex/config.toml.",
    );
  }
  if (!serviceRoleKey) {
    throw new Error(
      "Missing Supabase service-role key. Set SUPABASE_SERVICE_ROLE_KEY or authenticate Supabase CLI so `supabase projects api-keys` can read it.",
    );
  }
  return { mcpKey, serviceRoleKey };
}

async function postgrest(path, { method = "GET", body, serviceRoleKey, prefer } = {}) {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!response.ok) {
    throw new Error(
      `PostgREST ${method} ${path} failed (${response.status}): ${
        typeof json === "string" ? json : JSON.stringify(json)
      }`,
    );
  }
  return json;
}

async function rpc(method, params, mcpKey, expectError = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "x-brain-key": mcpKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${RUN_ID}-${method}-${Math.random().toString(16).slice(2)}`,
        method,
        params,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`MCP ${method} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let payload = null;
  if (text) {
    payload = parseMcpTextResponse(text);
  }
  if (!response.ok) {
    if (expectError) return { httpError: true, status: response.status, payload };
    throw new Error(`MCP ${method} failed HTTP ${response.status}: ${text}`);
  }
  if (payload?.error) {
    if (expectError) return payload;
    throw new Error(`MCP ${method} JSON-RPC error: ${JSON.stringify(payload.error)}`);
  }
  return payload;
}

function parseMcpTextResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("event:")) {
    const dataLine = trimmed.split(/\r?\n/).find((line) =>
      line.startsWith("data:")
    );
    if (!dataLine) throw new Error(`No data line in SSE MCP response: ${trimmed}`);
    return JSON.parse(dataLine.slice("data:".length).trim());
  }
  return JSON.parse(trimmed);
}

function parseToolResult(payload) {
  const content = payload?.result?.content;
  const first = Array.isArray(content) ? content[0] : null;
  const text = first?.text;
  if (typeof text !== "string") {
    throw new Error(`Tool result had no text content: ${JSON.stringify(payload)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function callTool(name, args, mcpKey, { expectToolError = false } = {}) {
  const payload = await rpc("tools/call", { name, arguments: args }, mcpKey);
  if (payload?.result?.isError && !expectToolError) {
    throw new Error(`${name} returned tool error: ${parseToolResult(payload).text}`);
  }
  if (!payload?.result?.isError && expectToolError) {
    throw new Error(`${name} was expected to fail but succeeded.`);
  }
  return { payload, data: parseToolResult(payload) };
}

async function createTask(serviceRoleKey, patch) {
  const base = {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID}`,
    label: "agent-instructions",
    agent_code: AGENT_CODE,
    project_slug: "brain-bank",
    status: "Agent Todo",
    priority: "high",
    risk: "low",
    requested_by: "codex",
    intake_source: "oe-mcp-smoke",
    desired_outcome: `Harmless OE MCP smoke row ${RUN_ID}`,
    context: "Created by scripts/open-engine/mcp-task-smoke.mjs. Preserve as durable audit evidence.",
    sources: [{ kind: "script", path: "scripts/open-engine/mcp-task-smoke.mjs" }],
    do_steps: "Exercise one guarded MCP task-tool transition.",
    acceptance_criteria: "MCP receipt and DB event verification match exactly.",
    output_handoff: "No cleanup required. Smoke rows are durable audit evidence.",
    boundaries: "Do not touch client/business data, sends, deletes, deploys, billing, credentials, cron, or WordPress.",
    explicit_approval: false,
  };
  const rows = await postgrest("agent_tasks?select=id,status,title", {
    method: "POST",
    body: [{ ...base, ...patch }],
    serviceRoleKey,
    prefer: "return=representation",
  });
  const id = rows?.[0]?.id;
  if (!id) throw new Error(`Task insert did not return an id: ${JSON.stringify(rows)}`);
  createdTaskIds.push(id);
  return id;
}

async function readTask(serviceRoleKey, taskId) {
  const rows = await postgrest(
    `agent_tasks?select=*&id=eq.${encodeURIComponent(taskId)}`,
    { serviceRoleKey },
  );
  assert.equal(rows.length, 1, `Expected one task row for ${taskId}`);
  return rows[0];
}

async function readEvents(serviceRoleKey, taskId) {
  return await postgrest(
    `agent_task_events?select=*&task_id=eq.${encodeURIComponent(taskId)}&order=created_at.asc`,
    { serviceRoleKey },
  );
}

async function readProtectedSnapshot(serviceRoleKey) {
  const snapshot = {};
  for (const taskId of PROTECTED_SMOKE_TASK_IDS) {
    const rows = await postgrest(
      `agent_tasks?select=id,status,updated_at&id=eq.${encodeURIComponent(taskId)}`,
      { serviceRoleKey },
    );
    if (rows.length === 0) {
      snapshot[taskId] = { missing: true };
      continue;
    }
    const events = await readEvents(serviceRoleKey, taskId);
    snapshot[taskId] = {
      status: rows[0].status,
      event_types: events.map((event) => event.event_type),
    };
  }
  return snapshot;
}

async function countLedger(serviceRoleKey, agentCode = AGENT_CODE) {
  const rows = await postgrest(
    `agent_task_ledger?select=agent_code&agent_code=eq.${encodeURIComponent(agentCode)}`,
    { serviceRoleKey },
  );
  return rows.length;
}

async function assertTask(serviceRoleKey, taskId, expectedStatus, expectedEvents) {
  const task = await readTask(serviceRoleKey, taskId);
  const events = await readEvents(serviceRoleKey, taskId);
  assert.equal(task.status, expectedStatus, `${taskId} status`);
  assert.deepEqual(
    events.map((event) => event.event_type),
    expectedEvents,
    `${taskId} events`,
  );
  return { task, events };
}

async function assertNoEventAdded(serviceRoleKey, taskId, beforeCount) {
  const events = await readEvents(serviceRoleKey, taskId);
  assert.equal(events.length, beforeCount, `${taskId} should not gain events`);
}

async function main() {
  const { mcpKey, serviceRoleKey } = requireSecrets();
  log(`starting run ${RUN_ID} against ${PROJECT_REF}`);
  log("secrets loaded without printing values");

  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "open-engine-mcp-smoke", version: "1.0.0" },
  }, mcpKey);

  const toolsPayload = await rpc("tools/list", {}, mcpKey);
  const toolNames = (toolsPayload?.result?.tools || []).map((tool) => tool.name);
  for (const tool of REQUIRED_TASK_TOOLS) {
    assert(toolNames.includes(tool), `tools/list missing ${tool}`);
  }
  log(`tools/list exposed ${REQUIRED_TASK_TOOLS.length} required task tools`);

  const baselineLedgerCount = await countLedger(serviceRoleKey);
  assert.equal(baselineLedgerCount, 1, `${AGENT_CODE} ledger baseline count`);
  const protectedBefore = await readProtectedSnapshot(serviceRoleKey);

  const ledgerRead = await callTool("read_agent_ledger", { agent_code: AGENT_CODE }, mcpKey);
  assert.equal(ledgerRead.data.count, 1, "read_agent_ledger count");

  const claimTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} claim heartbeat complete`,
  });
  const statusOnlyTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} invalid heartbeat guard`,
    status: "Agent Needs Input",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
    blocked_reason: "OE smoke invalid heartbeat guard",
  });
  const completeTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} complete`,
    status: "Agent Working",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
    claim_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const blockTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} block`,
    status: "Agent Working",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
    claim_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const reviewTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} request review`,
    status: "Agent Working",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
    claim_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  const resumeTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} resume`,
    status: "Agent Review",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
  });
  const unblockTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} unblock`,
    status: "Agent Needs Input",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
    blocked_reason: "OE smoke blocker",
  });
  const answerTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} human answer`,
    status: "Agent Needs Input",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
    blocked_reason: "OE smoke human hold",
  });
  const invalidResumeTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} invalid unblock guard`,
    status: "Agent Review",
    claimed_by: AGENT_CODE,
    claimed_at: new Date().toISOString(),
  });
  const highRiskTask = await createTask(serviceRoleKey, {
    title: `[agent instructions][${AGENT_CODE}][task] OE MCP smoke ${RUN_ID} high-risk refusal`,
    priority: "low",
    risk: "high",
    explicit_approval: false,
  });

  log(`created ${createdTaskIds.length} harmless smoke tasks`);

  const listed = await callTool("list_agent_tasks", {
    agent_code: AGENT_CODE,
    include_done: true,
    limit: 50,
  }, mcpKey);
  assert(
    listed.data.tasks.some((task) => task.id === claimTask),
    "list_agent_tasks should include the claim smoke task",
  );

  const claimed = await callTool("claim_specific_agent_task", {
    task_id: claimTask,
    agent_code: AGENT_CODE,
  }, mcpKey);
  assert.equal(claimed.data.receipt, "AGENT CLAIMED", "claim receipt");
  assert.equal(
    claimed.data.task?.id,
    claimTask,
    `claim_specific_agent_task claimed ${claimed.data.task?.id}, expected new smoke task ${claimTask}`,
  );
  await assertTask(serviceRoleKey, claimTask, "Agent Working", ["AGENT CLAIMED"]);

  await callTool("get_agent_task", { task_id: claimTask }, mcpKey);

  await callTool("update_agent_task", {
    task_id: claimTask,
    agent_code: AGENT_CODE,
    status_note: `OE MCP smoke ${RUN_ID} heartbeat`,
  }, mcpKey);
  await assertTask(serviceRoleKey, claimTask, "Agent Working", [
    "AGENT CLAIMED",
    "AGENT STATUS",
  ]);

  const invalidHeartbeatEvents = await readEvents(serviceRoleKey, statusOnlyTask);
  await callTool("update_agent_task", {
    task_id: statusOnlyTask,
    agent_code: AGENT_CODE,
    status_note: "This should be rejected because task is not Agent Working.",
  }, mcpKey, { expectToolError: true });
  await assertNoEventAdded(serviceRoleKey, statusOnlyTask, invalidHeartbeatEvents.length);

  await callTool("complete_agent_task", {
    task_id: completeTask,
    agent_code: AGENT_CODE,
    result: `OE MCP smoke ${RUN_ID} complete receipt`,
  }, mcpKey);
  await assertTask(serviceRoleKey, completeTask, "Agent Review", ["AGENT DONE"]);

  await callTool("block_agent_task", {
    task_id: blockTask,
    agent_code: AGENT_CODE,
    blocker: `OE MCP smoke ${RUN_ID} blocker`,
  }, mcpKey);
  await assertTask(serviceRoleKey, blockTask, "Agent Needs Input", ["AGENT BLOCKED"]);

  await callTool("request_agent_review", {
    task_id: reviewTask,
    agent_code: AGENT_CODE,
    review_note: `OE MCP smoke ${RUN_ID} review request`,
  }, mcpKey);
  await assertTask(serviceRoleKey, reviewTask, "Agent Review", ["AGENT DONE"]);

  await callTool("resume_agent_task", {
    task_id: resumeTask,
    agent_code: AGENT_CODE,
    resume_note: `OE MCP smoke ${RUN_ID} resume from review`,
  }, mcpKey);
  await assertTask(serviceRoleKey, resumeTask, "Agent Working", ["AGENT RESUMED"]);

  await callTool("unblock_agent_task", {
    task_id: unblockTask,
    agent_code: AGENT_CODE,
    unblock_note: `OE MCP smoke ${RUN_ID} blocker cleared`,
  }, mcpKey);
  await assertTask(serviceRoleKey, unblockTask, "Agent Working", ["AGENT UNBLOCKED"]);

  await callTool("answer_agent_task", {
    task_id: answerTask,
    agent_code: AGENT_CODE,
    answer_note: `OE MCP smoke ${RUN_ID} human answer supplied`,
  }, mcpKey);
  await assertTask(serviceRoleKey, answerTask, "Agent Working", [
    "AGENT HUMAN ANSWERED",
  ]);

  const invalidResumeEvents = await readEvents(serviceRoleKey, invalidResumeTask);
  await callTool("unblock_agent_task", {
    task_id: invalidResumeTask,
    agent_code: AGENT_CODE,
    unblock_note: "This should be rejected because task is Agent Review.",
  }, mcpKey, { expectToolError: true });
  await assertNoEventAdded(serviceRoleKey, invalidResumeTask, invalidResumeEvents.length);

  const highRisk = await readTask(serviceRoleKey, highRiskTask);
  assert.equal(highRisk.status, "Agent Todo", "high-risk task remains Todo");
  assert.deepEqual(await readEvents(serviceRoleKey, highRiskTask), []);

  assert.equal(await countLedger(serviceRoleKey), 1, `${AGENT_CODE} ledger final count`);
  assert.deepEqual(
    await readProtectedSnapshot(serviceRoleKey),
    protectedBefore,
    "prior Session 219/220/221 smoke rows must not change",
  );

  const finalSummary = [];
  for (const taskId of createdTaskIds) {
    const task = await readTask(serviceRoleKey, taskId);
    const events = await readEvents(serviceRoleKey, taskId);
    finalSummary.push({
      task_id: taskId,
      status: task.status,
      events: events.map((event) => event.event_type),
    });
  }

  log("passed");
  console.log(JSON.stringify({
    run_id: RUN_ID,
    project_ref: PROJECT_REF,
    agent_code: AGENT_CODE,
    created_task_ids: createdTaskIds,
    final_summary: finalSummary,
    ledger_count: await countLedger(serviceRoleKey),
  }, null, 2));
}

main().catch((error) => {
  console.error(`[oe-mcp-smoke] FAILED: ${error.message}`);
  if (createdTaskIds.length > 0) {
    console.error(
      `[oe-mcp-smoke] Created smoke task ids, preserved for audit: ${createdTaskIds.join(", ")}`,
    );
  }
  process.exitCode = 1;
});
