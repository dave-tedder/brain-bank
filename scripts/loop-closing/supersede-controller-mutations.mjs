#!/usr/bin/env node
// Task 3.4 and its PR 19 amendments: mutation proof for the --supersede controller
// path and the wrapper guard. Each mutant replaces one exact string in a TEMP COPY
// of the file under test, then runs its test suite there. The working tree is never
// edited.
//
//   node scripts/loop-closing/supersede-controller-mutations.mjs
//
// Outcomes, never two:
//   CAUGHT: at least one test failed, the suite still ran as many tests as the control
//     did (so an import or syntax failure cannot count), and, when the mutant names a
//     test that must fail, that test is among the failures.
//   WRONG-FAILURE: the suite failed but not in the named test (exit 1).
//   SURVIVED: every test passed (exit 1).
//   NEVER-RAN: the target is not there exactly once, or the suite did not run the same
//     tests as the control (exit 2).
//   CONTROL FAILED: the unmutated copy must pass first (exit 2).
// A mutant with no named test proves only that some test noticed. Wording and file-name
// mutants are contract checks; they say nothing about recovery safety.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTROLLER = "scripts/open-engine/closeout-controller.mjs";
const GUARD = "supabase/functions/open-brain-mcp/_agent_tasks.ts";

const CONTROLLER_MUTANTS = [
  // Task 3.4: journal, verb and capture ordering.
  ["journal-not-written-before-verb", `  if (!existing) {\n    writeFileSync(journalPath,`, `  if (false) {\n    writeFileSync(journalPath,`],
  ["verb-on-every-attempt", `    if (!evaluation.already_done) {\n      await mcpCall(config, "supersede_agent_task"`, `    if (true) {\n      await mcpCall(config, "supersede_agent_task"`, /a failed append followed by a retry/],
  ["capture-twice", `if (parseJson(journalPath).capture_result) {`, `if (false) {`],
  ["complete-stamp-dropped", `      state: "complete",\n      completed_at: new Date().toISOString(),\n    });\n    if (cardChanged)`, `      state: "captures-written",\n    });\n    if (cardChanged)`],
  ["swallow-read-failure", `    if (/Cannot coerce the result to a single JSON object/.test(String(err?.message))) return null;\n    throw err;`, `    return null;`],
  // PR 19 fourth amendment: inventory reconciliation.
  ["audit-ignores-gaps", `    const { packets, gaps } = reconcileSupersedeInventory(listed.events, fetched);`, `    const { packets } = reconcileSupersedeInventory(listed.events, fetched);\n    const gaps = [];`, /never a clean audit/],
  ["reconcile-trusts-any-packet", `    const sameCard = packet?.task?.id === taskId;`, `    const sameCard = Boolean(packet);`, /never a clean audit/],
  ["reconcile-no-id-counts-as-found", `listed.filter((event) => !event?.id || !fetchedIds.has(event.id))`, `listed.filter((event) => event?.id && !fetchedIds.has(event.id))`, /no id cannot match/],
  ["reconcile-counts-every-card", `    const listed = listedEvents.filter((event) => event.task_id === taskId);`, `    const listed = listedEvents;`, /no id cannot match/],
  ["coverage-claims-complete-with-gaps", `      coverage_complete: !truncated && gaps.length === 0,`, `      coverage_complete: !truncated,`, /never a clean audit/],
  ["coverage-claims-complete-when-truncated", `      coverage_complete: !truncated && gaps.length === 0,`, `      coverage_complete: gaps.length === 0,`, /failed or cut-short supersede scan/],
  ["gap-not-in-scan-truncated", `      ...(supersede.gaps.length > 0\n        ? `, `      ...(false\n        ? `, /never a clean audit/],
  ["total-ignored", `    const truncated = listed.events.length >= SUPERSEDE_EVENT_SCAN_LIMIT ||\n      total !== listed.events.length;`, `    const truncated = listed.events.length >= SUPERSEDE_EVENT_SCAN_LIMIT;`, /failed or cut-short supersede scan/],
  ["ceiling-trusts-total", `    const truncated = listed.events.length >= SUPERSEDE_EVENT_SCAN_LIMIT ||\n      total !== listed.events.length;`, `    const truncated = total !== listed.events.length;`, /failed or cut-short supersede scan/],
  // PR 19 fourth amendment: ownership.
  // The first form of these two only dropped the lease argument: the claim was still
  // taken, so they measured the fence and not ownership. These skip the claim outright.
  ["ordinary-takes-no-claim", `  return await withSupersedeLease(\n    cli,\n    cli.supersedeTaskId,\n    "supersede",\n    (lease) => supersedeUnderLease(cli, registry, lease),\n  );`, `  return await supersedeUnderLease(cli, registry, null);`, /overlap on one generation/],
  ["repair-takes-no-claim", `  return await withSupersedeLease(\n    cli,\n    cli.repairSupersedeTaskId,\n    "supersede-repair",\n    (lease) => repairUnderLease(cli, registry, lease),\n  );`, `  return await repairUnderLease(cli, registry, null);`, /overlap on one generation/],
  ["fence-gets-no-lease", `    (lease) => supersedeUnderLease(cli, registry, lease),`, `    () => supersedeUnderLease(cli, registry, null),`, /removed mid-run/],
  ["busy-claim-ignored", `  if (holders.length > 0) {\n    rmSync(path, { force: true });`, `  if (false) {\n    rmSync(path, { force: true });`, /overlap on one generation/],
  ["refusal-keeps-own-claim", `  if (holders.length > 0) {\n    rmSync(path, { force: true });`, `  if (holders.length > 0) {`, /overlap on one generation/],
  ["claim-not-released", `  } finally {\n    releaseSupersedeLease(lease);\n  }`, `  } finally {\n  }`, /overlap on one generation/],
  ["other-cards-claim-blocks", `    if (other === path || !pattern.test(name)) continue;`, `    if (other === path || !name.includes(".lease.")) continue;`, /another card does not block/],
  ["any-host-can-be-proved-gone", `  if (claim?.host !== hostname() || !Number.isInteger(claim?.pid)) return false;`, `  if (!Number.isInteger(claim?.pid)) return false;`, /claim recovery/],
  ["dead-owner-not-recovered", `    if (claim && supersedeLeaseHolderIsGone(claim)) {`, `    if (false) {`, /claim recovery/],
  ["live-owner-reads-as-gone", `    return err?.code === "ESRCH";\n  }\n  const started`, `    return err?.code === "ESRCH";\n  }\n  return true;\n  const started`, /claim recovery/],
  ["recycled-pid-reads-as-alive", `  return Boolean(started && claim.process_started && started !== claim.process_started);`, `  return false;`, /claim recovery/],
  ["unknown-start-reads-as-gone", `  return Boolean(started && claim.process_started && started !== claim.process_started);`, `  return started !== claim.process_started;`, /claim recovery/],
  ["unreadable-claim-ignored", `    holders.push({\n      path: other,`, `    if (claim) holders.push({\n      path: other,`, /claim recovery/],
  ["recovery-not-reported", `    ...(lease?.recovered.length ? { recovered_leases: lease.recovered } : {}),\n`, ``, /claim recovery/],
  ["fence-removed", `    assertSupersedeLeaseHeld(lease);\n    result.closeout_writes`, `    result.closeout_writes`, /removed mid-run/],
  ["live-check-takes-a-claim", `  if (cli.liveCheck) return await work(null);\n`, ``, /--live-check takes no claim/],
  ["hold-leaves-created-directory", `  if (lease.createdDir) {\n    try {\n      rmdirSync(lease.journalDir);`, `  if (false) {\n    try {\n      rmdirSync(lease.journalDir);`, /holds on anything it cannot write/],
  // PR 19 fourth amendment: the capture is the event's.
  ["start-time-tz-not-pinned", `env: { ...process.env, LC_ALL: "C", TZ: "UTC" },`, `env: { ...process.env, LC_ALL: "C" },`, /another time zone or locale: time zone/],
  ["start-time-locale-not-pinned", `env: { ...process.env, LC_ALL: "C", TZ: "UTC" },`, `env: { ...process.env, TZ: "UTC" },`, /another time zone or locale: locale/],
  ["capture-not-pinned", `const captureContent = journaled.capture_content ??\n        asCloseoutCapture(\`\${eventBody} Event \${event.id}.\`);`, `const captureContent = asCloseoutCapture(\`\${eventBody} Event \${event.id}.\`);`, /resends the pinned bytes/],
  ["pin-written-after-send", `      if (!journaled.capture_content) {\n        updateApplyJournal(journalPath, { capture_content: captureContent, capture_tags: captureTags });\n      }\n`, ``, /resends the pinned bytes/],
  ["capture-is-the-file-body", `asCloseoutCapture(\`\${eventBody} Event \${event.id}.\`);`, `asCloseoutCapture(\`\${body} Event \${event.id}.\`);`, /the capture belongs to the event/],
  ["capture-without-event-id", `asCloseoutCapture(\`\${eventBody} Event \${event.id}.\`);`, `asCloseoutCapture(eventBody);`, /the capture belongs to the event/],
  ["pinned-event-not-checked", `      if (!String(captureContent).includes(event.id)) {`, `      if (false) {`, /pinned capture naming another event/],
  ["pinned-tags-not-reused", `      const captureTags = journaled.capture_tags ?? [route.capture_tag, "open_engine", "superseded"];`, `      const captureTags = [route.capture_tag + "x".repeat(Number(Boolean(journaled.capture_content))), "open_engine", "superseded"];`, /resends the pinned bytes/],
  // Task 3.4: each gate.
  ["no-slug-gate", `    reasons.push("MISSING_PROJECT_SLUG");\n    return null;`, `    return null;`],
  ["no-route-gate", `    reasons.push("UNKNOWN_PROJECT_ROUTE");\n    return null;`, `    return null;`],
  ["no-missing-target-gate", `      reasons.push("APPEND_TARGET_MISSING");`, ``],
  ["no-archived-gate", `  if (task.archived_at) reasons.push("TASK_ARCHIVED");`, ``],
  ["no-status-gate", `  } else if (!SUPERSEDE_LEGAL_STATUSES.has(task.status)) {\n    reasons.push("SUPERSEDE_STATUS_NOT_LEGAL");`, `  } else if (false) {\n    reasons.push("SUPERSEDE_STATUS_NOT_LEGAL");`],
  ["no-self-gate", `if (args.by === task.id) reasons.push("REPLACEMENT_IS_SELF");\n    else if`, `if`],
  ["no-replacement-found-gate", `else if (!replacement) reasons.push("REPLACEMENT_NOT_FOUND");`, ``],
  ["no-replacement-archived-gate", `else if (replacement.archived_at) reasons.push("REPLACEMENT_ARCHIVED");`, ``],
  ["no-premise-gate", `      reasons.push("PREMISE_NOTE_MISMATCH");`, ``],
  ["no-differently-gate", `    reasons.push("ALREADY_SUPERSEDED_DIFFERENTLY");`, ``],
  ["same-args-ignores-reason", `  return String(a?.reason ?? "") === String(b?.reason ?? "") &&\n    (a?.by ?? null) === (b?.by ?? null);`, `  return (a?.by ?? null) === (b?.by ?? null);`, /supersedeAlreadyDone needs/],
  ["same-args-ignores-replacement", `  return String(a?.reason ?? "") === String(b?.reason ?? "") &&\n    (a?.by ?? null) === (b?.by ?? null);`, `  return String(a?.reason ?? "") === String(b?.reason ?? "");`, /supersedeAlreadyDone needs/],
  ["already-done-ignores-args", `  return Boolean(event) && sameSupersedeArgs(\n    eventSupersedeArgs(event),\n    { reason: String(args.reason || "").trim(), by: args.by || null },\n  );`, `  return Boolean(event);`, /supersedeAlreadyDone needs/],
  ["already-done-ignores-event", `  return Boolean(event) && sameSupersedeArgs(`, `  return sameSupersedeArgs(`, /supersedeAlreadyDone needs/],
  // Finding 1: a retry resumes the journaled generation and never the verb.
  ["resume-ignored", `    resume = entry;\n    break;`, `    continue;`],
  ["card-change-not-reported", `  const cardChanged = Boolean(resume) &&\n    !(closedBySupersede(task) && task.superseded_closed_generation === generation);`, `  const cardChanged = false;`, /a partial retry repairs generation 1/],
  ["card-changed-ignores-later-generation", `!(closedBySupersede(task) && task.superseded_closed_generation === generation);`, `!closedBySupersede(task);`, /repairing generation 1 after a bare close/],
  ["lost-response-not-adopted", `  if (!event) return "event-missing";\n`, `  if (!event) return "event-missing";\n  if (journal.state === "intent-written") return "lost-to-another";\n`, /a lost verb response is adopted/],
  ["expected-generation-not-sent", `        expected_generation: generation,\n`, ``],
  ["history-date-from-columns", `    const closedAt = String(event.created_at);`, `    const closedAt = String(task.superseded_at || event.created_at);`, /repairing generation 1 after a bare close/],
  ["journal-event-id-dropped", `      superseded_at: closedAt,\n      event_id: event.id,\n`, `      superseded_at: closedAt,\n`, /a partial retry repairs generation 1/],
  // Finding 2: generations in the journal, the marker, the capture and the read.
  ["completed-journal-short-circuits-before-read", `  // the card is now.\n  const packet = await mcpCall(config, "get_agent_task", { task_id: taskId });`, `  // the card is now.\n  if (readSupersedeJournals(cli.journalDir, taskId).some((e) => e.journal.state === "complete")) {\n    printResult({ status: "ALREADY_COMPLETE" });\n    return;\n  }\n  const packet = await mcpCall(config, "get_agent_task", { task_id: taskId });`],
  ["marker-task-only", "`<!-- open-engine supersede task: ${taskId} generation: ${generation} -->`", "`<!-- open-engine supersede task: ${taskId} -->`"],
  ["journal-not-per-generation", "`${taskId}.supersede.g${generation}.json`", "`${taskId}.supersede.g1.json`"],
  ["capture-without-generation", `const generationText = generation > 1 ? \` (supersede generation \${generation})\` : "";`, `const generationText = "";`],
  ["reopened-needs-no-generation", `  } else if (prior > 0 && args.generation == null) {\n    reasons.push("REOPENED_CARD_NEEDS_GENERATION");\n`, ``],
  ["generation-not-compared-live", `  } else if (args.generation != null && args.generation !== prior + 1) {\n    reasons.push("GENERATION_MISMATCH");\n`, ``],
  ["generation-not-compared-closed", `    if (args.generation != null && args.generation !== prior) {\n      reasons.push("GENERATION_MISMATCH");\n    }\n`, ``],
  ["already-complete-ignores-mismatch", `    evaluation.already_done && existing?.journal.state === "complete" &&\n    !evaluation.reasons.includes("GENERATION_MISMATCH")`, `    evaluation.already_done && existing?.journal.state === "complete"`],
  ["ordinary-done-reads-as-superseded", `    Number.isInteger(task.superseded_closed_generation);`, `    Boolean(task.superseded_at);`, /finished normally is not treated as superseded/],
  ["replaced-intent-not-retired", `      if (!cli.liveCheck) renameSync(entry.path, \`\${entry.path}.\${verdict}-\${Date.now()}\`);`, ``],
  ["live-check-retires-intent", `      if (!cli.liveCheck) renameSync(`, `      renameSync(`],
  ["remix-allowed", `    if (verdict === "different-args") {`, `    if (false) {`],
  ["journal-without-event-trusted", `    if (verdict === "event-missing" || verdict === "event-mismatch") {`, `    if (false) {`],
  ["complete-without-event-trusted", `      if (verdict !== "resume") {`, `      if (false) {`, /a journal the board does not back/],
  // Finding 3: GAP C reads the real checkout.
  ["worktree-check-removed", `    } else if (isInLinkedWorktree(path)) {\n      reasons.push("APPEND_TARGET_IN_WORKTREE");\n`, ``],
  ["worktree-check-no-realpath", `    real = realpathSync(path);`, `    real = resolve(String(path));`],
  ["worktree-check-no-commondir", `  if (pathEntryExists(join(metadata, "commondir"))) return false;\n`, ``, /in every form/],
  ["worktree-check-any-git-file", `    return !metadataIsOwnRepository(dir, isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir));`, `    return true;`, /reads the real checkout/],
  ["worktree-pruned-passes", `    !existsSync(join(metadata, "HEAD")) ||\n    !hasDir(join(metadata, "objects")) || !hasDir(join(metadata, "refs"))\n  ) {\n    return false;`, `    !existsSync(join(metadata, "HEAD")) ||\n    !hasDir(join(metadata, "objects")) || !hasDir(join(metadata, "refs"))\n  ) {\n    return true;`, /reads the real checkout/],
  ["worktree-garbled-passes", `if (!gitdir) return true;`, `if (!gitdir) return false;`, /reads the real checkout/],
  ["worktree-name-check-only", `  for (let dir = dirname(real); ; dir = dirname(dir)) {\n    const dotGit = join(dir, ".git");`, `  for (let dir = dirname(real); ; dir = dirname(dir)) {\n    if (dir) return false;\n    const dotGit = join(dir, ".git");`],
  // Second re-review, finding 1: generation identity is the number the event names.
  ["identity-from-array-position", `    const generation = event?.payload?.generation;\n    if (!Number.isInteger(generation) || generation < 1) {`, `    const generation = byGeneration.size + 1;\n    if (!Number.isInteger(generation) || generation < 1) {`, /events read back 1, 3, 2 with different reasons/],
  ["identity-from-array-position-same-reasons", `    const generation = event?.payload?.generation;\n    if (!Number.isInteger(generation) || generation < 1) {`, `    const generation = byGeneration.size + 1;\n    if (!Number.isInteger(generation) || generation < 1) {`, /events read back 1, 3, 2 with identical reasons/],
  ["identity-from-array-position-tied", `    const generation = event?.payload?.generation;\n    if (!Number.isInteger(generation) || generation < 1) {`, `    const generation = byGeneration.size + 1;\n    if (!Number.isInteger(generation) || generation < 1) {`, /tied timestamps with identical reasons/],
  ["generation-not-validated", `    if (!Number.isInteger(generation) || generation < 1) {`, `    if (false) {`, /every malformed history/],
  ["generation-string-accepted", `    if (!Number.isInteger(generation) || generation < 1) {`, `    if (!Number.isInteger(Number(generation)) || Number(generation) < 1) {`, /every malformed history/],
  ["generation-floor-dropped", `    if (!Number.isInteger(generation) || generation < 1) {`, `    if (!Number.isInteger(generation)) {`, /every malformed history/],
  ["duplicate-generation-overwrites", `    } else if (byGeneration.has(generation)) {`, `    } else if (false) {`, /every malformed history/],
  ["gap-allowed", `  if (latest !== byGeneration.size) {`, `  if (false) {`, /every malformed history/],
  ["history-not-checked-before-journals", `  if (identityProblems.length > 0) {`, `  if (false) {`, /malformed generation history holds every path/],
  ["history-not-checked-in-gate", `  if (problems.length > 0) {\n    reasons.push("SUPERSEDE_HISTORY_INVALID");`, `  if (false) {\n    reasons.push("SUPERSEDE_HISTORY_INVALID");`, /malformed generation history holds every path/],
  ["closed-generation-not-tied-to-events", `  if (closed !== index.latest) {`, `  if (false) {`, /must agree on which generation closed it/],
  ["closed-ignores-status", `  return task.status === "Agent Done" &&\n    Number.isInteger(task.superseded_closed_generation);`, `  return Number.isInteger(task.superseded_closed_generation);`, /supersedeAlreadyDone needs/],
  ["columns-not-tied-to-event", `  } else if (!sameSupersedeArgs(\n    { reason: task.superseded_reason, by: task.superseded_by ?? null },`, `  } else if (false && !sameSupersedeArgs(\n    { reason: task.superseded_reason, by: task.superseded_by ?? null },`, /must agree on which generation closed it/],
  ["journal-event-id-not-compared", `  if (journal.state !== "intent-written" && journal.event_id !== event.id) {`, `  if (false) {`, /must name the very event it saw/],
  ["completed-journal-trusts-any-event", `      const verdict = classifySupersedeJournal(entry, index, entry.journal.args);\n      if (verdict !== "resume") {`, `      const verdict = index.byGeneration.has(entry.generation) ? "resume" : "event-missing";\n      if (verdict !== "resume") {`, /must name the very event it saw/],
  ["journal-task-id-not-checked", `      entry.journal.task_id !== taskId ||\n`, ``, /body disagrees with its file name/],
  ["journal-generation-not-checked", `      entry.journal.generation !== entry.generation ||\n`, ``, /body disagrees with its file name/],
  ["journal-zero-generation-allowed", `      entry.generation < 1\n`, `      false\n`, /body disagrees with its file name/],
  ["read-back-args-not-compared", `        afterIndex.problems.length > 0 || !event ||\n        !sameSupersedeArgs(eventSupersedeArgs(event), args)`, `        afterIndex.problems.length > 0 || !event`, /without its event, or with another writer's/],
  ["read-back-problems-ignored", `        afterIndex.problems.length > 0 || !event ||\n`, `        !event ||\n`, /without its event, or with another writer's/],
  ["read-back-missing-event-ignored", `        afterIndex.problems.length > 0 || !event ||\n        !sameSupersedeArgs(eventSupersedeArgs(event), args)`, `        afterIndex.problems.length > 0 ||\n        (event && !sameSupersedeArgs(eventSupersedeArgs(event), args))`, /without its event, or with another writer's/],
  ["history-before-read-back", `      const after = await mcpCall(config, "get_agent_task", { task_id: taskId });\n      const afterIndex = indexSupersedeGenerations(after?.events);`, `      let after;\n      try { after = await mcpCall(config, "get_agent_task", { task_id: taskId }); } catch { after = { events: [...events, { id: "guess", event_type: "TASK SUPERSEDED", created_at: new Date().toISOString(), payload: { generation, reason: args.reason, superseded_by: args.by } }] }; }\n      const afterIndex = indexSupersedeGenerations(after?.events);`, /a read-back lost after the verb/],
  // Second re-review, finding 2: GAP C walks every containing checkout.
  ["worktree-stops-at-first-checkout", `    if (dotGitIsLinkedWorktree(dir, dotGit)) return true;`, `    if (pathEntryExists(dotGit)) return dotGitIsLinkedWorktree(dir, dotGit);`, /walks every containing checkout/],
  ["worktree-stops-at-nested-repository", `    if (dotGitIsLinkedWorktree(dir, dotGit)) return true;`, `    if (existsSync(dotGit) && statSync(dotGit).isDirectory()) return false;\n    if (dotGitIsLinkedWorktree(dir, dotGit)) return true;`, /walks every containing checkout/],
  ["worktree-stops-at-submodule", `    if (dotGitIsLinkedWorktree(dir, dotGit)) return true;`, `    if (existsSync(dotGit) && statSync(dotGit).isFile()) return dotGitIsLinkedWorktree(dir, dotGit);\n    if (dotGitIsLinkedWorktree(dir, dotGit)) return true;`, /walks every containing checkout/],
  // Third amendment: .git in every form. The FIFO arm has no mutant: reading a FIFO
  // blocks forever, so its mutant would hang the sweep rather than fail a test.
  ["worktree-directory-form-skipped", `    if (stat.isDirectory()) return !metadataIsOwnRepository(dir, dotGit);`, `    if (stat.isDirectory()) return false;`, /in every form/],
  ["worktree-dangling-skipped", `  if (!pathEntryExists(dotGit)) return false;`, `  if (!existsSync(dotGit)) return false;`, /in every form/],
  ["worktree-unreadable-passes", `  } catch {\n    return true;\n  }\n}\n\n// GAP C: is this`, `  } catch {\n    return false;\n  }\n}\n\n// GAP C: is this`, /in every form/],
  ["worktree-head-not-required", `    !existsSync(join(metadata, "HEAD")) ||\n`, ``, /in every form/],
  ["worktree-objects-not-required", `!hasDir(join(metadata, "objects")) || !hasDir(join(metadata, "refs"))`, `!hasDir(join(metadata, "refs"))`, /in every form/],
  ["worktree-refs-not-required", `!hasDir(join(metadata, "objects")) || !hasDir(join(metadata, "refs"))`, `!hasDir(join(metadata, "objects"))`, /in every form/],
  ["worktree-other-checkouts-dotgit-accepted", `  return basename(real) !== ".git" || real === join(dir, ".git");`, `  return true;`, /in every form/],
  ["worktree-own-dotgit-refused", `  return basename(real) !== ".git" || real === join(dir, ".git");`, `  return basename(real) !== ".git";`, /reads the real checkout/],
  ["worktree-relocated-gitdir-refused", `  return basename(real) !== ".git" || real === join(dir, ".git");`, `  return real === join(dir, ".git");`, /in every form/],
  ["worktree-gitfile-any-line", `/^gitdir: *(.+?)\\s*$/.exec(`, `/^gitdir: *(.+?)\\s*$/m.exec(`, /in every form/],
  ["worktree-gitfile-relative-to-cwd", `isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir)`, `resolve(gitdir)`, /in every form/],
  // Third amendment: the audit compares every event to its history marker.
  ["audit-tracker-not-required", `        ...(coverage.tracker ? [] : ["tracker"]),\n`, ``, /each generation is compared/],
  ["audit-log-not-required", `        ...(coverage.sessionLog ? [] : ["session_log"]),\n`, ``, /each generation is compared/],
  ["audit-card-id-counts-as-marker", `supersedeMarkerCoverage(route, supersedeMarker(task.id, generation), options)`, `supersedeMarkerCoverage(route, task.id, options)`, /each generation is compared/],
  ["audit-first-generation-marker-only", `supersedeMarkerCoverage(route, supersedeMarker(task.id, generation), options)`, `supersedeMarkerCoverage(route, supersedeMarker(task.id, 1), options)`, /each generation is compared/],
  ["audit-latest-generation-only", `const generations = [...index.byGeneration.keys()].sort((a, b) => a - b);`, `const generations = index.latest ? [index.latest] : [];`, /each generation is compared/],
  ["audit-archive-not-searched", `  const foundIn = listHistoryFiles(route).all\n`, `  const foundIn = listHistoryFiles(route).routed\n`, /each generation is compared/],
  ["audit-no-route-dropped", `      if (!route) {\n        unrecorded.push({`, `      if (!route) {\n        continue;\n        unrecorded.push({`, /no route and a broken history/],
  ["audit-invalid-history-dropped", `      unrecorded.push({ ...base, severity: "SUPERSEDE_HISTORY_INVALID", problems });\n`, ``, /no route and a broken history/],
  ["audit-identity-not-checked", `    const problems = supersedeIdentityProblems(task, index);\n    if (problems.length > 0) {\n      unrecorded.push({`, `    const problems = index.problems;\n    if (problems.length > 0) {\n      unrecorded.push({`, /no route and a broken history/],
  ["audit-not-merged", `    unrecorded: [...evaluated.unrecorded, ...supersede.unrecorded],`, `    unrecorded: evaluated.unrecorded,`, /finds a bare close that was reopened/],
  ["audit-count-not-merged", `    unrecorded_count: evaluated.unrecorded.length + supersede.unrecorded.length,`, `    unrecorded_count: evaluated.unrecorded.length,`, /finds a bare close that was reopened/],
  ["audit-scan-failure-swallowed", "        ? [`TASK SUPERSEDED events (scan failed: ${supersede.error})`]", `        ? []`, /failed or cut-short supersede scan/],
  ["audit-truncation-hidden", `        ? ["TASK SUPERSEDED events"]`, `        ? []`, /failed or cut-short supersede scan/],
  ["audit-truncation-off-by-one", `    const truncated = listed.events.length >= SUPERSEDE_EVENT_SCAN_LIMIT ||`, `    const truncated = listed.events.length > SUPERSEDE_EVENT_SCAN_LIMIT ||`, /failed or cut-short supersede scan/],
  ["audit-scan-failure-crashes", `  } catch (err) {\n    return {\n      unrecorded: [],`, `  } catch (err) {\n    throw err;\n    return {\n      unrecorded: [],`, /failed or cut-short supersede scan/],
  ["audit-event-shape-not-checked", `    if (!Array.isArray(listed?.events)) {`, `    if (false) {`, /failed or cut-short supersede scan/],
  // Third amendment: the repair writes one generation from its own event.
  ["repair-uses-latest-event", `  const event = index.byGeneration.get(generation);\n  if (!event) hold(`, `  const event = index.byGeneration.get(index.latest);\n  if (!event) hold(`, /writes one generation from its own event/],
  ["repair-args-from-card-columns", `  const eventArgs = eventSupersedeArgs(event);\n  if (!String(`, `  const eventArgs = { reason: task.superseded_reason, by: task.superseded_by ?? null };\n  if (!String(`, /writes one generation from its own event/],
  ["repair-note-dropped", "${repairGeneration !== null ? ` History written later by --repair-supersede on ${new Date().toISOString().slice(0, 10)}, from the event.` : \"\"}", ``, /writes one generation from its own event/],
  ["repair-already-recorded-rewrites", `  if (covered && (!entry || entry.journal.state === "complete")) {`, `  if (false) {`, /writes one generation from its own event/],
  ["repair-status-always-superseded", `result.status = repairGeneration !== null ? "HISTORY_REPAIRED" : "SUPERSEDED";`, `result.status = "SUPERSEDED";`, /still closed by that generation/],
  ["repair-live-check-writes", `  if (cli.liveCheck) {\n    printResult({\n      status: "REPAIR_READY",`, `  if (false) {\n    printResult({\n      status: "REPAIR_READY",`, /--live-check says what it would do/],
  ["repair-history-not-checked", `  if (problems.length > 0) hold(["SUPERSEDE_HISTORY_INVALID"], { problems });\n`, ``, /holds on anything it cannot write/],
  ["repair-generation-not-checked", `  if (!event) hold(["REPAIR_GENERATION_NOT_FOUND"], { latest_generation: index.latest });\n`, ``, /holds on anything it cannot write/],
  ["repair-reason-not-checked", `  if (!String(eventArgs.reason ?? "").trim()) {`, `  if (false) {`, /holds on anything it cannot write/],
  ["repair-no-route-gate", `  if (routeReasons.length > 0) hold([...new Set(routeReasons)]);\n`, ``, /holds on anything it cannot write/],
  ["repair-coverage-any-file", `  const covered = coverage.tracker && coverage.sessionLog;`, `  const covered = coverage.tracker || coverage.sessionLog;`, /finishes partial history/],
  ["repair-journal-body-not-checked", `    if (entry.journal.task_id !== taskId || entry.journal.generation !== generation) {`, `    if (false) {`, /resumes an honest one/],
  ["repair-journal-mismatch-trusted", "    } else if (verdict !== \"resume\") {\n      throw new Error(`Journal ${entry.path} disagrees", "    } else if (false) {\n      throw new Error(`Journal ${entry.path} disagrees", /resumes an honest one/],
  ["repair-lost-intent-not-kept", "  if (retired) renameSync(retired.path, `${retired.path}.lost-to-another-${Date.now()}`);\n", ``, /resumes an honest one/],
  ["repair-lost-intent-trusted", `    if (verdict === "lost-to-another") {\n      // An intent that never landed`, `    if (false) {\n      // An intent that never landed`, /resumes an honest one/],
  ["repair-complete-journal-not-rearmed", `    if (entry.journal.state === "complete") updateApplyJournal(journalPath, stamp);\n`, ``, /rewrites history a complete journal claims/],
  ["repair-capture-resent", `    if (parseJson(journalPath).capture_result) {`, `    if (false) {`, /rewrites history a complete journal claims/],
  ["repair-touches-other-generations", `    if (repairGeneration !== null && entry.generation !== repairGeneration) continue;\n`, ``, /finishes only the generation it names/],
  ["repair-calls-the-verb", `    if (!evaluation.already_done) {\n      await mcpCall(config, "supersede_agent_task"`, `    if (!evaluation.already_done || repairGeneration !== null) {\n      await mcpCall(config, "supersede_agent_task"`, /writes one generation from its own event/],
  ["repair-parse-takes-reason", `      args.supersedeTaskId || args.supersedeBy || args.supersedeReason ||\n      args.supersedePremise\n`, `      args.supersedeTaskId\n`, /repair-supersede parseArgs/],
  ["repair-parse-generation-optional", `      !/^\\d+$/.test(String(args.supersedeGeneration ?? "")) ||\n      Number(args.supersedeGeneration) < 1\n    ) {\n      throw new Error("--repair-supersede requires`, `      false\n    ) {\n      throw new Error("--repair-supersede requires`, /repair-supersede parseArgs/],
  // Clarification: the wording claims only what a fragment match proves.
  ["premise-hold-overclaims", `The quoted text is gone, so read the card again before closing it.`, `The card changed since it was read; read it again before closing it.`],
  ["premise-parse-overclaims", `It is refused when the quoted text is gone; a match does not prove the rest of the card is unchanged.`, `so a card that changed since you read it is refused.`],
];

const GUARD_MUTANTS = [
  ["guard-no-reason", `if (!args.reason?.trim()) {`, `if (false) {`],
  ["guard-no-actor", `if (!args.actor?.trim()) {`, `if (false) {`],
  ["guard-no-self", `if (args.superseded_by && args.superseded_by === args.task_id) {`, `if (false) {`],
  ["guard-no-generation-integer", `(!Number.isInteger(args.expected_generation) ||\n      args.expected_generation < 1)`, `args.expected_generation < 1`],
  ["guard-no-generation-floor", `(!Number.isInteger(args.expected_generation) ||\n      args.expected_generation < 1)`, `!Number.isInteger(args.expected_generation)`],
];

// A source-text contract, so these prove only that the wrapper's text is pinned.
const WRAPPER = "supabase/functions/open-brain-mcp/index.ts";
const WRAPPER_MUTANTS = [
  ["wrapper-no-exact-count", `.select("id, task_id, created_at", { count: "exact" })`, `.select("id, task_id, created_at")`, /asks PostgREST for an exact count/],
  ["wrapper-total-is-the-page", `        total: count ?? null,\n`, `        total: data?.length ?? 0,\n`, /asks PostgREST for an exact count/],
];

function makeCopy() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "oe-supersede-mut-"));
  cpSync(join(ROOT, "scripts/open-engine"), join(dir, "scripts/open-engine"), { recursive: true, verbatimSymlinks: true });
  // The controller suite also reads the capture handlers' prefix lists.
  cpSync(join(ROOT, "supabase/functions"), join(dir, "supabase/functions"), { recursive: true });
  return dir;
}

// A suite cut off here has no test total, so outcome() reports NEVER-RAN, never a catch.
const SUITE_TIMEOUT_MS = 600000;
const runController = (dir) => spawnSync("node", ["--test", "scripts/open-engine/closeout-controller.test.mjs"], { cwd: dir, encoding: "utf8", timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL" });
const runGuard = (dir) => spawnSync("deno", ["test", "--no-check", "--allow-all", "--no-lock", "--node-modules-dir=none", `${GUARD.replace("_agent_tasks.ts", "_agent_tasks_test.ts")}`], { cwd: dir, encoding: "utf8" });

function outcome(run) {
  const text = `${run.stdout}\n${run.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
  // node --test prints "ℹ tests N"; deno test prints "ok | N passed | M failed".
  const node = text.match(/^ℹ tests (\d+)$/m);
  const deno = text.match(/(?:ok|FAILED) \| (\d+) passed(?: \([^)]*\))? \| (\d+) failed/);
  const total = node ? Number(node[1]) : deno ? Number(deno[1]) + Number(deno[2]) : null;
  const failures = [...new Set(
    [...text.matchAll(/^(?:✖ (.+?)(?: \(\d[^)]*\))?|(.+?) \.\.\. FAILED.*)$/gm)].map((m) => m[1] || m[2]),
  )].filter((name) => name !== "failing tests:");
  return { total, failures };
}

function sweep(file, mutants, runSuite) {
  let failed = false;
  const dir = makeCopy();
  try {
    const path = join(dir, file);
    const original = readFileSync(path, "utf8");
    const control = runSuite(dir);
    const controlOutcome = outcome(control);
    if (control.status !== 0 || !controlOutcome.total) {
      console.log(`CONTROL FAILED ${file}: ${controlOutcome.failures[0] || "no tests counted"}`);
      process.exitCode = 2;
      return true;
    }
    console.log(`CONTROL ok ${file} (${controlOutcome.total} tests)`);
    for (const [name, from, to, expected] of mutants) {
      const count = original.split(from).length - 1;
      if (count !== 1) {
        console.log(`NEVER-RAN ${name}: target appears ${count} times, expected exactly 1`);
        process.exitCode = 2;
        failed = true;
        continue;
      }
      writeFileSync(path, original.replace(from, () => to), "utf8");
      const run = runSuite(dir);
      writeFileSync(path, original, "utf8");
      const result = outcome(run);
      if (run.status === 0) {
        console.log(`SURVIVED ${name}`);
        process.exitCode = process.exitCode || 1;
        failed = true;
      } else if (result.total !== controlOutcome.total || result.failures.length === 0) {
        console.log(`NEVER-RAN ${name}: the suite did not run its ${controlOutcome.total} tests (got ${result.total}), so this failure is not the defect`);
        process.exitCode = 2;
        failed = true;
      } else if (expected && !result.failures.some((f) => expected.test(f))) {
        console.log(`WRONG-FAILURE ${name}: wanted ${expected}, got ${result.failures[0]}`);
        process.exitCode = process.exitCode || 1;
        failed = true;
      } else {
        const named = expected ? result.failures.find((f) => expected.test(f)) : result.failures[0];
        console.log(`CAUGHT ${name} [${result.failures.length} failed]: ${named.slice(0, 100)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

const a = sweep(CONTROLLER, CONTROLLER_MUTANTS, runController);
const b = sweep(GUARD, GUARD_MUTANTS, runGuard);
const c = sweep(WRAPPER, WRAPPER_MUTANTS, runController);
if (!a && !b && !c) console.log(`ALL MUTATIONS CAUGHT (${CONTROLLER_MUTANTS.length + GUARD_MUTANTS.length + WRAPPER_MUTANTS.length})`);
