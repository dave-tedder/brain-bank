#!/usr/bin/env node
// OE board-hygiene Track B: the reconciliation probe runner.
//
// Spec: docs/superpowers/specs/2026-07-22-board-hygiene-reconciliation-design.md
// Plan: docs/superpowers/plans/2026-07-22-board-hygiene-reconciliation.md (Task B1)
//
// Invoked ONLY through reconcile-run.sh, which sources credentials so the calling
// lane emits one flat, statically-analyzable command.
//
// ===========================================================================
// THE ASYMMETRY RULE (spec §3.3), which carries most of the safety
// ===========================================================================
// A probe may only ever AUTO-CLOSE. It may never auto-reopen, auto-escalate,
// auto-flag, or change a card in any other way. This process therefore has NO
// write path of any kind: it reads the card, reads the world, and prints one
// JSON line. The lane is the only thing that writes, and the only verb it has is
// complete_operator_action.
//
// FAIL CLOSED TOWARD NO-OP. Any error, timeout, ambiguity, non-match, missing
// credential, or unexpected shape prints match:false. There is no code path in
// this file that produces match:true from a failure. A false negative costs a
// card staying on the desk one more day, which is exactly what happens today; a
// false positive silently drops a step the operator still owes.
//
// ===========================================================================
// GATING LIVES HERE, NOT IN SKILL PROSE
// ===========================================================================
// A deliberate divergence from the plan, which had the lane doing the skipping.
// Every eligibility rule is enforced in this file so it is auditable, unit
// testable, and cannot be edited away by a reworded SKILL:
//   1. status must be Needs Operator            (spec §3.7)
//   2. close_check must be present              (spec §3.4 guard 1, opt-in)
//   3. no plan-doc: source                      (fork R2 (a))
// A card failing any gate prints match:false with the gate named in `skipped`.
//
// THE AUTO-PROMOTE GATE WAS REMOVED 2026-07-27. See checkEligibility below.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

// Matches the prefix reconcile-run.sh reads credentials under.
const KEYCHAIN_SERVICE_PREFIX = process.env.OE_WP_KEYCHAIN_PREFIX || "brainbank-wp-";

const FETCH_TIMEOUT_MS = 15000;
const GH_TIMEOUT_MS = 20000;

// Truthful user agent. Spec §3.4 guard 4: measure ground truth, not the
// instrument. A spoofed UA measures the probe, not the world, and a probe that
// lies about who it is cannot be audited later.
const USER_AGENT = process.env.OE_RECONCILER_USER_AGENT ||
  "brain-bank-reconciler/1.0 (board-hygiene probe)";

// Site handle -> public base URL, supplied as a JSON object in the environment
// so no site of yours is hardcoded in this repo. Example:
//
//   OE_WP_SITE_BASE_URLS='{"example-wp":"https://example.com"}'
//
// The handles here MUST match profile.json's wordpress_sites, which is what the
// close_check validator accepts at authorship. Unset means the map is empty and
// every wp_post_status probe reports an unknown-site no-match, which is the
// correct fail-closed behavior for an unconfigured install: the card simply
// stays on the desk.
// Read on each call rather than once at module load, so a caller (and a test)
// can set it after import. It is consulted once per wp_post_status probe, so
// the parse cost is irrelevant.
function wpSiteBaseUrls() {
  const raw = process.env.OE_WP_SITE_BASE_URLS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    // Fail closed, and never on stdout: this module's contract is exactly one
    // JSON line, so a config warning goes to stderr.
    process.stderr.write(
      "OE_WP_SITE_BASE_URLS is not valid JSON; treating it as empty. wp_post_status probes will report unknown-site.\n",
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// Result shape. Exactly one JSON line on stdout, always.
// ---------------------------------------------------------------------------

function emit(result) {
  process.stdout.write(JSON.stringify(result) + "\n");
}

function noMatch(probe, fields = {}) {
  return { match: false, probe: probe ?? null, ...fields };
}

// ---------------------------------------------------------------------------
// MCP read path (mirrors closeout-controller.mjs mcpCall / parseMcpBody)
// ---------------------------------------------------------------------------

let mcpRequestId = 0;

function parseMcpBody(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(dataLines[i]);
    } catch {
      // keep scanning
    }
  }
  throw new Error(`Unparseable MCP response: ${trimmed.slice(0, 200)}`);
}

async function mcpCall(url, key, name, toolArgs) {
  mcpRequestId += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-brain-key": key,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: mcpRequestId,
        method: "tools/call",
        params: { name, arguments: toolArgs },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`MCP ${name} timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`MCP ${name} HTTP ${res.status}`);
  }
  const rpc = parseMcpBody(body);
  if (rpc.error) throw new Error(`MCP ${name} error: ${rpc.error.message}`);
  const textItem = (rpc.result?.content || []).find((c) => c.type === "text");
  const text = textItem?.text ?? "";
  if (rpc.result?.isError) {
    throw new Error(`MCP ${name} tool error: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Eligibility gates
// ---------------------------------------------------------------------------

export function findDeskEntryTimestamp(events) {
  // The card's most recent ENTRY onto the Needs Operator desk. Keyed on the
  // event PAYLOAD status rather than event_type alone, because more than one
  // event type can land a card on the desk (AGENT NEEDS OPERATOR from the
  // closeout controller, and the C3 ops-amend desk move).
  //
  // A TRANSITION, NOT A STATE. from_status must differ from 'Needs Operator',
  // or an amend that never moved the card counts as a fresh arrival.
  //
  // Found live 2026-07-26 while authoring the first real close_check. Every
  // admin_amend_agent_task call writes an AGENT STATUS event carrying
  // payload.status = <the row's CURRENT status>, so amending a card that is
  // already on the desk emits {from_status: 'Needs Operator', status: 'Needs
  // Operator'}. The old predicate read that as a new desk entry and slid
  // d3a23233's window from 2026-07-10 to 2026-07-26, 16 days forward, just by
  // authoring its probe.
  //
  // Only git_path_exists consumes this, and the error direction is "safe"
  // (a later window matches less), but the practical result is a PERMANENT
  // FALSE NEGATIVE: the operator drops the file, then a close_check is authored on the
  // card, the window jumps past the drop, and the card can never close while
  // looking like an ordinary no-match. Fails closed, stays broken, says nothing.
  let latest = null;
  for (const event of events ?? []) {
    const payload = event?.payload ?? {};
    const landsOnDesk = payload.status === "Needs Operator" ||
      event?.event_type === "AGENT NEEDS OPERATOR";
    if (!landsOnDesk) continue;
    // from_status is absent on some historical events; only an explicit
    // 'Needs Operator' disqualifies, so unknown provenance still counts.
    if (payload.from_status === "Needs Operator") continue;
    const at = Date.parse(event?.created_at ?? "");
    if (Number.isNaN(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

export function hasPlanDocSource(sources) {
  // Fork R2 (a): a plan-doc-sourced card closes through the closeout controller,
  // which flips the [OE:<shortid>] doc tag. This lane never writes a plan doc, so
  // closing one here would strand the tag and re-card the line later.
  return (sources ?? []).some((source) =>
    typeof source === "string" && source.startsWith("plan-doc:")
  );
}

export function checkEligibility(task, events) {
  if (task?.status !== "Needs Operator") {
    return `status is ${task?.status ?? "unknown"}, not Needs Operator`;
  }
  if (!task?.close_check) {
    return "no close_check on the packet (not reconciliation-eligible)";
  }
  if (hasPlanDocSource(task?.sources)) {
    return "card carries a plan-doc: source (fork R2 (a): the closeout controller owns plan docs)";
  }
  // NO AUTO-PROMOTE GATE. Deliberately absent, and the reasoning is
  // worth keeping because the original guard sounded right.
  //
  // The risk this whole design guards against is a BADLY WRITTEN ASSERTION: a
  // done-when note that is trivially true, or that becomes true for an unrelated
  // reason, silently retiring a step the operator still owes. So the question that
  // matters is "did a human read and agree to this note?", NOT "did a human move
  // this card?".
  //
  // The intake validator (assertCloseCheckAuthorAllowed) already answers the
  // question that matters: triage cannot author a close_check at all, and
  // intake_source='triage-agent' is exactly and only what auto-promote requires.
  // The ONLY remaining way a close_check reaches any card is
  // admin_amend_agent_task, which is service-role, human/ops-only, and
  // deliberately absent from every executor allowlist and SKILL contract.
  // Therefore a close_check on an auto-promoted card PROVES a human authored it.
  //
  // The old gate skipped exactly that case, which is backwards: it blocked the
  // cards where the operator HAD made the call. Measured cost on the live desk
  // 2026-07-27: it disqualified 6 of 7 machine-checkable candidates, because
  // Phase 4 auto-promotes most website work. A guard meant to let us build a
  // track record safely was suppressing nearly all the evidence we would build
  // it from.
  //
  // Note for anyone tempted to restore it: the critic lane is NOT a backstop
  // here. The critic reviews the agent's deliverable BEFORE the operator step
  // exists, so it never sees whether the real-world step happened, and its
  // verdict is advisory and moves no status. The real backstops are that a
  // human authored the assertion, every close is reported in the digest and in
  // the briefing's "Closed without you" section for 7 days, and one
  // admin_amend call puts a wrongly-closed card back on the desk.
  return null;
}

// ---------------------------------------------------------------------------
// Probe 1: http_contains
// ---------------------------------------------------------------------------

async function probeHttpContains(spec) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(spec.url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
      signal: controller.signal,
    });
    if (!res.ok) {
      return noMatch("http_contains", {
        measured: `HTTP ${res.status}`,
        measured_by: "plain-get",
        error: `non-200 response (${res.status})`,
      });
    }
    const body = await res.text();
    const found = body.includes(spec.assert);
    return {
      match: found,
      probe: "http_contains",
      measured: found
        ? `assertion present in ${body.length} bytes at ${res.url}`
        : `assertion absent from ${body.length} bytes at ${res.url}`,
      measured_by: "plain-get",
      error: null,
    };
  } catch (err) {
    return noMatch("http_contains", {
      measured: null,
      measured_by: "plain-get",
      error: err?.name === "AbortError"
        ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : String(err?.message ?? err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Probe 2: wp_post_status
// ---------------------------------------------------------------------------
// A bash/node wrapper cannot call the WordPress MCP (that is a Claude-side tool),
// so this goes through the WordPress REST API with an application password.
//
// THE WAF-403 GOTCHA (standing lesson): on these sites a 403 is a WAF block, NOT
// an authentication failure. Reporting it as auth failure has previously led to
// a needless token rotation. 401 means the credential was rejected; 403 means
// the request never reached the auth layer. Both are match:false, but they are
// reported differently so the diagnosis does not restart from zero.

async function probeWpPostStatus(spec, credentials) {
  const base = wpSiteBaseUrls()[spec.site];
  if (!base) {
    return noMatch("wp_post_status", {
      measured: null,
      measured_by: "wp-rest-api",
      error: `unknown site handle '${spec.site}'`,
    });
  }
  const credential = credentials[spec.site];
  if (!credential) {
    return noMatch("wp_post_status", {
      measured: null,
      measured_by: "wp-rest-api",
      error:
        `no application password available for ${spec.site} (expected macOS Keychain service '${KEYCHAIN_SERVICE_PREFIX}${spec.site}'); probe skipped, card stays on the desk`,
    });
  }
  // context=edit is required to read a non-published status, and requires auth.
  const url =
    `${base}/wp-json/wp/v2/posts/${spec.post_id}?context=edit&_fields=id,status`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
        authorization: `Basic ${
          Buffer.from(credential, "utf8").toString("base64")
        }`,
      },
      signal: controller.signal,
    });
    if (res.status === 403) {
      return noMatch("wp_post_status", {
        measured: "HTTP 403",
        measured_by: "wp-rest-api",
        error:
          "HTTP 403 from the WordPress REST API. A 403 here is typically a WAF or firewall block rather than an auth failure: the request never reached the auth layer. Do not rotate the application password on this signal; diagnose the WAF rule first.",
      });
    }
    if (res.status === 401) {
      return noMatch("wp_post_status", {
        measured: "HTTP 401",
        measured_by: "wp-rest-api",
        error:
          "HTTP 401: the application password was rejected. This one IS an auth failure.",
      });
    }
    if (!res.ok) {
      return noMatch("wp_post_status", {
        measured: `HTTP ${res.status}`,
        measured_by: "wp-rest-api",
        error: `non-200 response (${res.status})`,
      });
    }
    const json = await res.json();
    const status = json?.status;
    if (typeof status !== "string") {
      return noMatch("wp_post_status", {
        measured: null,
        measured_by: "wp-rest-api",
        error: "response carried no status field",
      });
    }
    return {
      match: status === spec.assert,
      probe: "wp_post_status",
      measured: `post ${spec.post_id} on ${spec.site} is '${status}'`,
      measured_by: "wp-rest-api",
      error: null,
    };
  } catch (err) {
    return noMatch("wp_post_status", {
      measured: null,
      measured_by: "wp-rest-api",
      error: err?.name === "AbortError"
        ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : String(err?.message ?? err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// GitHub read path, via the gh CLI
// ---------------------------------------------------------------------------
// gh is already authenticated against the keyring with repo scope, so the private
// repos are reachable without this build storing a token anywhere. No token in a
// file, no token in the environment, nothing new to rotate.

async function ghApi(pathAndQuery) {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", "-H", "Accept: application/vnd.github+json", pathAndQuery],
    { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

// ---------------------------------------------------------------------------
// Probe 3: git_path_exists (the since-desk clause)
// ---------------------------------------------------------------------------
// THE HIGHEST-VALUE GUARD IN THE SUITE (spec §3.4 guard 3).
//
// A bare existence check is a defect, not a simplification. Several live desk
// cards point operator_target at a deliverables/ file the EXECUTOR wrote, which
// existed before the card ever reached the desk, so bare existence would falsely
// close every one of them. This probe therefore asserts something strictly
// narrower: a commit landing AFTER the card entered the desk ADDED a file under
// this path.
//
// "added", not "modified": a lane touching an existing file must not satisfy an
// operator drop-box assertion. The intake validator separately refuses any path
// under deliverables/, so a lane's own push cannot be the thing that matches.

async function probeGitPathExists(spec, deskEnteredAt) {
  if (!deskEnteredAt) {
    return noMatch("git_path_exists", {
      measured: null,
      measured_by: "github-api",
      error:
        "could not determine when the card entered the desk; the since-desk clause is unevaluable, so this fails closed",
    });
  }
  try {
    const commits = await ghApi(
      `repos/${spec.repo}/commits?path=${
        encodeURIComponent(spec.path)
      }&since=${encodeURIComponent(deskEnteredAt)}&per_page=100`,
    );
    if (!Array.isArray(commits) || commits.length === 0) {
      return noMatch("git_path_exists", {
        measured: `no commits touching ${spec.path} since ${deskEnteredAt}`,
        measured_by: "github-api",
        error: null,
      });
    }
    for (const commit of commits) {
      const detail = await ghApi(`repos/${spec.repo}/commits/${commit.sha}`);
      const added = (detail?.files ?? []).filter((file) =>
        file?.status === "added" && typeof file?.filename === "string" &&
        file.filename.startsWith(spec.path)
      );
      if (added.length > 0) {
        return {
          match: true,
          probe: "git_path_exists",
          measured: `${added.length} new file(s) added under ${spec.path} at ${
            commit.sha.slice(0, 8)
          } (${commit?.commit?.author?.date}), after the card entered the desk at ${deskEnteredAt}: ${
            added.map((f) => f.filename).join(", ")
          }`,
          measured_by: "github-api",
          error: null,
        };
      }
    }
    return noMatch("git_path_exists", {
      measured:
        `${commits.length} commit(s) touched ${spec.path} since ${deskEnteredAt}, but none ADDED a file there (modifications do not satisfy a drop-box assertion)`,
      measured_by: "github-api",
      error: null,
    });
  } catch (err) {
    return noMatch("git_path_exists", {
      measured: null,
      measured_by: "github-api",
      error: String(err?.message ?? err).slice(0, 300),
    });
  }
}

// ---------------------------------------------------------------------------
// Probe 4: git_commit_contains
// ---------------------------------------------------------------------------

async function probeGitCommitContains(spec) {
  const assertedPath = spec.assert.slice("path:".length);
  try {
    await ghApi(
      `repos/${spec.repo}/contents/${
        assertedPath.split("/").map(encodeURIComponent).join("/")
      }?ref=${encodeURIComponent(spec.ref)}`,
    );
    return {
      match: true,
      probe: "git_commit_contains",
      measured: `${assertedPath} present in ${spec.repo} at ref ${spec.ref}`,
      measured_by: "github-api",
      error: null,
    };
  } catch (err) {
    const message = String(err?.message ?? err);
    // gh exits non-zero on 404, which is the honest "not there yet" answer, not
    // an infrastructure failure. Either way it is match:false.
    const notFound = message.includes("404") || message.includes("Not Found");
    return noMatch("git_commit_contains", {
      measured: notFound
        ? `${assertedPath} absent from ${spec.repo} at ref ${spec.ref}`
        : null,
      measured_by: "github-api",
      error: notFound ? null : message.slice(0, 300),
    });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runProbe(spec, context) {
  switch (spec.probe) {
    case "http_contains":
      return await probeHttpContains(spec);
    case "wp_post_status":
      return await probeWpPostStatus(spec, context.wpCredentials ?? {});
    case "git_path_exists":
      return await probeGitPathExists(spec, context.deskEnteredAt);
    case "git_commit_contains":
      return await probeGitCommitContains(spec);
    default:
      return noMatch(spec?.probe ?? null, {
        measured: null,
        measured_by: null,
        error: `unknown probe verb '${spec?.probe}'`,
      });
  }
}

function parseArgs(argv) {
  const args = { taskId: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--task-id" && i + 1 < argv.length) {
      args.taskId = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function collectWpCredentials(env) {
  const credentials = {};
  for (const site of Object.keys(WP_SITE_BASE_URLS)) {
    const key = `WP_APP_CREDENTIAL_${site.replace(/-/g, "_").toUpperCase()}`;
    if (env[key]) credentials[site] = env[key];
  }
  return credentials;
}

async function main() {
  const { taskId } = parseArgs(process.argv.slice(2));
  if (!taskId || !/^[0-9a-f-]{36}$/i.test(taskId)) {
    emit(noMatch(null, {
      measured: null,
      measured_by: null,
      error: "usage: reconcile-run.sh --task-id <uuid>",
    }));
    process.exit(0);
  }

  const url = process.env.OPEN_BRAIN_MCP_URL;
  const key = process.env.OPEN_BRAIN_MCP_KEY;
  if (!url || !key) {
    emit(noMatch(null, {
      task_id: taskId,
      error: "no Open Brain MCP credentials in the environment",
    }));
    process.exit(0);
  }

  let payload;
  try {
    payload = await mcpCall(url, key, "get_agent_task", { task_id: taskId });
  } catch (err) {
    emit(noMatch(null, {
      task_id: taskId,
      error: `could not read the card: ${String(err?.message ?? err).slice(0, 200)}`,
    }));
    process.exit(0);
  }

  const task = payload?.task;
  const events = payload?.events ?? [];

  const skipped = checkEligibility(task, events);
  if (skipped) {
    emit(noMatch(task?.close_check?.probe ?? null, {
      task_id: taskId,
      skipped,
      measured: null,
      measured_by: null,
      error: null,
    }));
    process.exit(0);
  }

  const result = await runProbe(task.close_check, {
    deskEnteredAt: findDeskEntryTimestamp(events),
    wpCredentials: collectWpCredentials(process.env),
  });

  emit({
    task_id: taskId,
    assert: task.close_check.assert ?? null,
    desk_entered_at: findDeskEntryTimestamp(events),
    ...result,
  });
  process.exit(0);
}

// Only run main when invoked directly, so the pure helpers above are importable
// by the test file without firing a network call.
//
// pathToFileURL, NOT `file://${process.argv[1]}`. This repo lives under
// "Mobile Documents/com~apple~CloudDocs/Projects/Apps/Open Brain", so the path
// contains spaces: import.meta.url percent-encodes them (%20) while argv[1] does
// not, the naive comparison is always false, and main() silently never runs. The
// failure mode is the worst possible one for this script -- empty stdout, exit 0,
// which a caller could read as "no result" rather than "never ran". Caught by the
// first live smoke on 2026-07-25.
// The argv[1] guard is not paranoia: pathToFileURL(undefined) THROWS, so without
// it any import from a context with no script path (node -e, a REPL, some test
// harnesses) crashes on load instead of importing cleanly. Hit 2026-07-27 while
// running a positive control against this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Last-resort fail-closed. Nothing reaches here that is not already a bug,
    // but a crash must still print a no-op line rather than an empty stdout the
    // lane might misread.
    emit(noMatch(null, {
      error: `unhandled: ${String(err?.message ?? err).slice(0, 200)}`,
    }));
    process.exit(0);
  });
}
