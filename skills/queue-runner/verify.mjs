#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

const requiredSnippets = [
  "manual-only",
  "not an enforcement boundary by itself",
  "SQL helpers, MCP task tools, and runtime tests",
  "Stop after one task",
  "Check human-hold and blocked tasks before new work.",
  "Resume exactly one ready hold or block if possible.",
  "claim the oldest eligible `Agent Todo` task",
  "Release expired claims with `release_expired_agent_claims`",
  "`AGENT HUMAN HOLD` through `hold_agent_task`",
  "`AGENT FAILED` through `fail_agent_task`",
  "canonical 8-section OE-8 contract",
  "claim-and-hold contract",
  "it never writes `AGENT DONE`",
  "The task is high risk and does not show explicit approval.",
  "desired outcome, do steps, boundaries, or acceptance criteria are ambiguous",
  "The parent session owns:",
  "`PROJECT-TRACKER.md` updates.",
  "`SESSION-LOG.md` updates.",
  "Project closeout capture.",
  "Worker subagents may do independent read-only audits",
  "Exactly one event row exists per successful receipt.",
  "Never delete ledger rows.",
  "Never create a duplicate `agent_code`.",
];

for (const snippet of requiredSnippets) {
  assert(
    skill.includes(snippet),
    `skills/queue-runner/SKILL.md is missing required snippet: ${snippet}`,
  );
}

const heartbeatMatch = skill.match(/## Heartbeat Order\n\n([\s\S]*?)\n\n## /);
assert(heartbeatMatch, "Heartbeat Order section is missing.");
const heartbeatLines = heartbeatMatch[1]
  .split("\n")
  .filter((line) => /^\d+\./.test(line));
assert.equal(heartbeatLines.length, 12, "Heartbeat must have 12 ordered steps.");
assert.match(heartbeatLines[0], /Identify the runtime/);
assert.match(heartbeatLines[3], /Release expired claims/);
assert.match(heartbeatLines[4], /human-hold and blocked tasks before new work/);
assert.match(heartbeatLines[11], /Stop after one task/);

const receiptHeadings = [
  "Work summary:",
  "Verification:",
  "Touched files or records:",
  "Limitations:",
  "Tracker draft:",
  "Session-log draft:",
  "Brain Bank capture draft:",
  "Follow-up recommendation:",
];
const headingBlock = skill.match(/```text\n([\s\S]*?)```/);
assert(headingBlock, "Receipt heading contract block is missing.");
assert.deepEqual(
  headingBlock[1].trim().split("\n"),
  receiptHeadings,
  "Receipt heading block must list the canonical 8 OE-8 sections in order.",
);

const noGoPhrases = [
  "cron jobs",
  "scheduled runners",
  "background loops",
  "Slack sends",
  "credential changes",
  "billing changes",
  "deletes",
  "deploys",
  "client-facing messages",
  "WordPress changes",
  "autonomous execution",
];

for (const phrase of noGoPhrases) {
  assert(
    skill.includes(phrase),
    `Stop-line phrase missing from Queue Runner skill: ${phrase}`,
  );
}

console.log("queue-runner skill verification passed");
