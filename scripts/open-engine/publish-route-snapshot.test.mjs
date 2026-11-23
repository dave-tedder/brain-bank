// Loop-closing Task 5.4: publish-route-snapshot.mjs, against a fixture registry.
//   node --test scripts/open-engine/publish-route-snapshot.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildRouteSnapshot,
  parseArgs,
  publishRouteSnapshot,
  RPC_PATH,
} from "./publish-route-snapshot.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "publish-route-snapshot.mjs");
const TOKEN = "header.payload-route-publisher.signature";
const APIKEY = "anon-key-fixture";

// A registry under a directory whose name has spaces, like the iCloud root.
function withFixture(fn) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe route snapshot "));
  const ws = join(base, "Mobile Documents", "Project One");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "PROJECT-TRACKER.md"), "# t\n");
  writeFileSync(join(ws, "SESSION-LOG.md"), "# l\n");
  const registry = {
    "brain-bank": {
      workspace_path: ws,
      tracker_path: join(ws, "PROJECT-TRACKER.md"),
      session_log_path: join(ws, "SESSION-LOG.md"),
      capture_tag: "open_brain",
    },
    "no-tracker": {
      workspace_path: ws,
      tracker_path: join(ws, "MISSING-TRACKER.md"),
      session_log_path: join(ws, "SESSION-LOG.md"),
      capture_tag: "no_tracker",
    },
    "no-tag": {
      workspace_path: ws,
      tracker_path: join(ws, "PROJECT-TRACKER.md"),
      session_log_path: join(ws, "SESSION-LOG.md"),
      capture_tag: "",
    },
    "no-workspace": {
      workspace_path: join(base, "gone"),
      tracker_path: join(ws, "PROJECT-TRACKER.md"),
      session_log_path: "",
      capture_tag: "x",
    },
  };
  const registryPath = join(base, "project-closeout-registry.json");
  writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  const secrets = join(base, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "jwt"), `${TOKEN}\n`);
  writeFileSync(join(secrets, "apikey"), `${APIKEY}\n`);
  const env = {
    HOME: base,
    BRAIN_BANK_SUPABASE_URL: "https://project.example.supabase.co/",
    BRAIN_BANK_ROUTE_PUBLISHER_JWT_FILE: join(secrets, "jwt"),
    BRAIN_BANK_ROUTE_PUBLISHER_APIKEY_FILE: join(secrets, "apikey"),
  };
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  let out;
  try {
    out = fn({ base, ws, registry, registryPath, env });
  } catch (err) {
    cleanup();
    throw err;
  }
  // An async body keeps the fixture until its promise settles.
  if (out && typeof out.then === "function") return out.finally(cleanup);
  cleanup();
  return out;
}

const EXPECTED_ROUTES = [
  { slug: "brain-bank", has_workspace: true, has_tracker: true, has_session_log: true, has_capture_tag: true },
  { slug: "no-tag", has_workspace: true, has_tracker: true, has_session_log: true, has_capture_tag: false },
  { slug: "no-tracker", has_workspace: true, has_tracker: false, has_session_log: true, has_capture_tag: true },
  { slug: "no-workspace", has_workspace: false, has_tracker: true, has_session_log: false, has_capture_tag: true },
];

function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { calls, impl };
}

test("snapshot: four booleans per key, from real path checks, sorted by key", () => {
  withFixture(({ registry }) => {
    const { routes, skipped } = buildRouteSnapshot(registry);
    assert.deepEqual(routes, EXPECTED_ROUTES);
    assert.deepEqual(skipped, []);
  });
});

test("snapshot: keys that are not route-key shaped, and non-object entries, are skipped and reported", () => {
  const { routes, skipped } = buildRouteSnapshot({
    "Bad Key": {},
    "../etc": {},
    "a/b": {},
    "ok-key": { capture_tag: "x" },
    "null-entry": null,
    "array-entry": [],
  }, () => true);
  assert.deepEqual(routes.map((r) => r.slug), ["ok-key"]);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), [
    "ENTRY_NOT_OBJECT",
    "ENTRY_NOT_OBJECT",
    "KEY_NOT_ROUTE_SHAPED",
    "KEY_NOT_ROUTE_SHAPED",
    "KEY_NOT_ROUTE_SHAPED",
  ]);
});

test("publish: one RPC call with the five fields only, the bearer token and apikey; no path in the body", async () => {
  await withFixture(async ({ base, registryPath, env }) => {
    const f = fakeFetch(200, 4);
    const { code, result } = await publishRouteSnapshot({ registryPath, env, fetchImpl: f.impl });
    assert.equal(code, 0, JSON.stringify(result));
    assert.equal(result.status, "PUBLISHED");
    assert.equal(result.published, 4);
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, `https://project.example.supabase.co${RPC_PATH}`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.headers.apikey, APIKEY);
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body), ["p_routes"]);
    assert.deepEqual(body.p_routes, EXPECTED_ROUTES);
    for (const row of body.p_routes) {
      assert.deepEqual(Object.keys(row), ["slug", "has_workspace", "has_tracker", "has_session_log", "has_capture_tag"]);
    }
    assert.ok(!init.body.includes(base), "the body names no registry path");
    assert.ok(!init.body.includes("/"), "the body carries no slash at all");
    assert.ok(!JSON.stringify(result).includes(TOKEN), "the output never carries the token");
    assert.ok(!JSON.stringify(result).includes(APIKEY), "the output never carries the apikey");
  });
});

test("publish: the project URL falls back to the origin of BB_MCP_URL", async () => {
  await withFixture(async ({ registryPath, env }) => {
    const f = fakeFetch(200, 4);
    const e = { ...env, BRAIN_BANK_SUPABASE_URL: "", BB_MCP_URL: "https://ref.supabase.co/functions/v1/open-brain-mcp" };
    const { code } = await publishRouteSnapshot({ registryPath, env: e, fetchImpl: f.impl });
    assert.equal(code, 0);
    assert.equal(f.calls[0].url, `https://ref.supabase.co${RPC_PATH}`);
  });
});

test("dry run: no network, exit 0, the rows it would publish", async () => {
  await withFixture(async ({ registryPath, env }) => {
    const f = fakeFetch(200, 4);
    const { code, result } = await publishRouteSnapshot({ registryPath, env, dryRun: true, fetchImpl: f.impl });
    assert.equal(code, 0);
    assert.equal(result.status, "DRY_RUN");
    assert.deepEqual(result.routes, EXPECTED_ROUTES);
    assert.equal(f.calls.length, 0);
  });
});

test("outcomes: PARTIAL when a key was skipped, REFUSED on a 4xx or a short count, NEVER-RAN otherwise", async () => {
  await withFixture(async ({ base, registry, registryPath, env }) => {
    // Skipped key plus a successful publish of the rest: exit 1, PARTIAL.
    const withBad = join(base, "with-bad.json");
    writeFileSync(withBad, JSON.stringify({ ...registry, "Bad Key": registry["brain-bank"] }));
    let r = await publishRouteSnapshot({ registryPath: withBad, env, fetchImpl: fakeFetch(200, 4).impl });
    assert.deepEqual([r.code, r.result.status, r.result.skipped.length], [1, "PARTIAL", 1]);

    r = await publishRouteSnapshot({ registryPath, env, fetchImpl: fakeFetch(400, { code: "22023", message: "bad" }).impl });
    assert.deepEqual([r.code, r.result.status, r.result.http_status], [1, "REFUSED", 400]);
    r = await publishRouteSnapshot({ registryPath, env, fetchImpl: fakeFetch(200, 3).impl });
    assert.deepEqual([r.code, r.result.status], [1, "REFUSED"]);

    for (const status of [401, 403, 500, 503]) {
      r = await publishRouteSnapshot({ registryPath, env, fetchImpl: fakeFetch(status, "no").impl });
      assert.deepEqual([r.code, r.result.status], [2, "NEVER-RAN"], `HTTP ${status}`);
    }
    r = await publishRouteSnapshot({ registryPath, env, fetchImpl: fakeFetch(200, "not json").impl });
    assert.deepEqual([r.code, r.result.status], [2, "NEVER-RAN"]);
    r = await publishRouteSnapshot({ registryPath, env, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    assert.deepEqual([r.code, r.result.status], [2, "NEVER-RAN"]);
  });
});

test("never-ran: missing credentials, a missing registry, or no valid key make no request", async () => {
  await withFixture(async ({ base, registryPath, env }) => {
    const f = fakeFetch(200, 4);
    let r = await publishRouteSnapshot({
      registryPath,
      env: { ...env, BRAIN_BANK_ROUTE_PUBLISHER_JWT_FILE: join(base, "absent") },
      fetchImpl: f.impl,
    });
    assert.deepEqual([r.code, r.result.status], [2, "NEVER-RAN"]);
    assert.match(r.result.error, /publisher JWT file/);
    r = await publishRouteSnapshot({ registryPath, env: { ...env, BRAIN_BANK_SUPABASE_URL: "" }, fetchImpl: f.impl });
    assert.deepEqual([r.code, r.result.status], [2, "NEVER-RAN"]);
    r = await publishRouteSnapshot({ registryPath: join(base, "nope.json"), env, fetchImpl: f.impl });
    assert.deepEqual([r.code, r.result.status], [2, "NEVER-RAN"]);
    const onlyBad = join(base, "only-bad.json");
    writeFileSync(onlyBad, JSON.stringify({ "Bad Key": {} }));
    r = await publishRouteSnapshot({ registryPath: onlyBad, env, fetchImpl: f.impl });
    assert.deepEqual([r.code, r.result.status], [2, "NEVER-RAN"]);
    assert.equal(f.calls.length, 0);
  });
});

test("args: --registry takes a path, unknown flags are refused", () => {
  assert.equal(parseArgs(["--registry", "/x y/z.json", "--dry-run"]).registry, "/x y/z.json");
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.throws(() => parseArgs(["--registry"]));
  assert.throws(() => parseArgs(["--write"]));
});

test("CLI: runs by its real path and through a symlinked directory whose path has spaces", () => {
  withFixture(({ base, registryPath }) => {
    const real = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--registry", registryPath], { encoding: "utf8", timeout: 30000 });
    assert.equal(real.status, 0, real.stderr);
    const parsed = JSON.parse(real.stdout);
    assert.equal(parsed.status, "DRY_RUN");
    assert.deepEqual(parsed.routes, EXPECTED_ROUTES);
    assert.ok(!real.stdout.includes(base), "dry-run output names no path");

    const link = join(base, "Mobile Documents", "linked open-engine");
    symlinkSync(HERE, link, "dir");
    const viaLink = spawnSync(process.execPath, [join(link, "publish-route-snapshot.mjs"), "--dry-run", "--registry", registryPath], { encoding: "utf8", timeout: 30000 });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.equal(viaLink.stdout, real.stdout, "the guard ran the CLI through the spaced symlink path");
  });
});

test("CLI: importing the module runs nothing", () => {
  const r = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`,
  ], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});
