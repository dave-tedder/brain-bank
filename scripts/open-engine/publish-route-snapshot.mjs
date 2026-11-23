#!/usr/bin/env node
// Loop-closing Task 5.4: publish the closeout route capability snapshot.
//
// Reads the machine-local closeout registry (the same file the controller
// routes by), works out for each route key the four capabilities the controller
// checks before an apply (workspace, tracker and session-log paths exist on this
// machine; a capture tag is set), and upserts ONLY those four booleans and the
// key into public.closeout_routes through the publish_closeout_routes RPC.
// complete_agent_task reads the table to refuse a completion whose route is known
// to be broken. No path ever leaves this machine: the payload is built field by
// field from the booleans, and the RPC refuses any element with another key.
//
//   node scripts/open-engine/publish-route-snapshot.mjs --dry-run
//   node scripts/open-engine/publish-route-snapshot.mjs [--registry <path>]
//
// Credentials (never printed, never on the command line):
//   PostgREST JWT with role closeout_route_publisher, from the file named by
//     BRAIN_BANK_ROUTE_PUBLISHER_JWT_FILE (default ~/.config/brain-bank/route-publisher-jwt),
//     minted by scripts/open-engine/mint-route-publisher-jwt.py
//   the project's anon key (gateway apikey), from BRAIN_BANK_ROUTE_PUBLISHER_APIKEY_FILE
//     (default ~/.config/brain-bank/route-publisher-apikey)
//   the project URL from BRAIN_BANK_SUPABASE_URL, or the origin of BB_MCP_URL
//
// Prints one JSON object. Three outcomes:
//   exit 0  PUBLISHED (every valid key upserted) or DRY_RUN
//   exit 1  a completed run that did not publish everything: PARTIAL (some
//           registry keys were not route-key shaped and were skipped; the rest
//           published) or REFUSED (the RPC answered 4xx other than 401/403)
//   exit 2  NEVER-RAN: no registry, no valid route, missing credentials, a
//           network error, 401/403, a 5xx or an unreadable answer
//
// Wiring into the 2:30 AM deliverables sweep is an operator rollout step (see
// docs/reviews/2026-11-20-task-5-4-receipt-validation.md); this script edits no
// scheduled task.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectInvocation } from "./entrypoint-guard.mjs";
import { routeCapabilities } from "../../supabase/functions/_shared/receipt-shape.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = join(HERE, "project-closeout-registry.json");
export const ROUTE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RPC_PATH = "/rest/v1/rpc/publish_closeout_routes";
const FETCH_TIMEOUT_MS = 30_000;

export function parseArgs(argv) {
  const args = { registry: DEFAULT_REGISTRY_PATH, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--registry") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) throw new Error("--registry needs a path");
      args.registry = v;
      i += 1;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// The snapshot rows, built field by field so nothing but the key and four
// booleans can reach the payload. Keys that are not route-key shaped (and
// entries that are not objects) are skipped and reported, never published.
export function buildRouteSnapshot(registry, pathExists = existsSync) {
  const routes = [];
  const skipped = [];
  for (const key of Object.keys(registry).sort()) {
    const entry = registry[key];
    if (!ROUTE_KEY_PATTERN.test(key)) {
      skipped.push({ key: key.slice(0, 80), reason: "KEY_NOT_ROUTE_SHAPED" });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      skipped.push({ key, reason: "ENTRY_NOT_OBJECT" });
      continue;
    }
    const caps = routeCapabilities(entry, pathExists);
    routes.push({
      slug: key,
      has_workspace: caps.has_workspace === true,
      has_tracker: caps.has_tracker === true,
      has_session_log: caps.has_session_log === true,
      has_capture_tag: caps.has_capture_tag === true,
    });
  }
  return { routes, skipped };
}

function readSecretFile(path) {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function resolveConfig(env = process.env) {
  const home = env.HOME || homedir();
  const jwtFile = env.BRAIN_BANK_ROUTE_PUBLISHER_JWT_FILE ||
    join(home, ".config", "brain-bank", "route-publisher-jwt");
  const apikeyFile = env.BRAIN_BANK_ROUTE_PUBLISHER_APIKEY_FILE ||
    join(home, ".config", "brain-bank", "route-publisher-apikey");
  let baseUrl = env.BRAIN_BANK_SUPABASE_URL || null;
  if (!baseUrl && env.BB_MCP_URL) {
    try {
      baseUrl = new URL(env.BB_MCP_URL).origin;
    } catch {
      baseUrl = null;
    }
  }
  const missing = [];
  const jwt = readSecretFile(jwtFile);
  const apikey = readSecretFile(apikeyFile);
  if (!baseUrl) missing.push("BRAIN_BANK_SUPABASE_URL (or BB_MCP_URL)");
  if (!jwt) missing.push(`publisher JWT file (${jwtFile})`);
  if (!apikey) missing.push(`anon apikey file (${apikeyFile})`);
  return { baseUrl: baseUrl ? baseUrl.replace(/\/+$/, "") : null, jwt, apikey, missing };
}

export async function publishRouteSnapshot({
  registryPath = DEFAULT_REGISTRY_PATH,
  dryRun = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  pathExists = existsSync,
} = {}) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (err) {
    return { code: 2, result: { status: "NEVER-RAN", error: `registry unreadable: ${err?.code || err?.message}` } };
  }
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { code: 2, result: { status: "NEVER-RAN", error: "registry is not a JSON object" } };
  }
  const { routes, skipped } = buildRouteSnapshot(registry, pathExists);
  if (routes.length === 0) {
    return { code: 2, result: { status: "NEVER-RAN", error: "no route-key-shaped entries to publish", skipped } };
  }
  if (dryRun) {
    return { code: 0, result: { status: "DRY_RUN", published: 0, routes, skipped } };
  }
  const config = resolveConfig(env);
  if (config.missing.length > 0) {
    return { code: 2, result: { status: "NEVER-RAN", error: `missing: ${config.missing.join("; ")}`, routes, skipped } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await fetchImpl(`${config.baseUrl}${RPC_PATH}`, {
      method: "POST",
      headers: {
        apikey: config.apikey,
        Authorization: `Bearer ${config.jwt}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ p_routes: routes }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (err) {
    return { code: 2, result: { status: "NEVER-RAN", error: `request failed: ${err?.name || "Error"}: ${String(err?.message || err).slice(0, 200)}`, routes, skipped } };
  } finally {
    clearTimeout(timer);
  }
  const snippet = String(text || "").slice(0, 300);
  if (response.status === 401 || response.status === 403 || response.status >= 500) {
    return { code: 2, result: { status: "NEVER-RAN", http_status: response.status, error: snippet, routes, skipped } };
  }
  if (!response.ok) {
    return { code: 1, result: { status: "REFUSED", http_status: response.status, error: snippet, routes, skipped } };
  }
  let count;
  try {
    count = JSON.parse(text);
  } catch {
    count = null;
  }
  if (!Number.isInteger(count)) {
    return { code: 2, result: { status: "NEVER-RAN", http_status: response.status, error: `unreadable answer: ${snippet}`, routes, skipped } };
  }
  if (count !== routes.length) {
    return { code: 1, result: { status: "REFUSED", http_status: response.status, error: `the RPC upserted ${count} of ${routes.length} routes`, routes, skipped } };
  }
  return {
    code: skipped.length > 0 ? 1 : 0,
    result: { status: skipped.length > 0 ? "PARTIAL" : "PUBLISHED", published: count, routes, skipped },
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.log(JSON.stringify({ status: "NEVER-RAN", error: err.message }));
    process.exit(2);
  }
  const { code, result } = await publishRouteSnapshot({ registryPath: args.registry, dryRun: args.dryRun });
  console.log(JSON.stringify(result));
  process.exit(code);
}

if (isDirectInvocation(import.meta.url)) main();
