import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTasksUrl,
  normalizeTasksIndexParams,
} from "../src/lib/tasks-index-controls.js";

const STATUS_TOKENS = ["todo", "working", "input", "review", "done"];
const AGENT_TOKENS = ["local-codex", "local-claude-code"];

test("tasks index defaults to active board sorted by updated", () => {
  assert.deepEqual(
    normalizeTasksIndexParams({}, STATUS_TOKENS, AGENT_TOKENS),
    {
      selectedStatuses: [],
      selectedAgents: [],
      risk: "all",
      sort: "updated",
      offset: 0,
    }
  );
});

test("tasks URL omits default risk and updated params", () => {
  assert.equal(
    buildTasksUrl({
      statuses: [],
      agents: [],
      risk: "all",
      sort: "updated",
    }),
    "/tasks"
  );
});

test("tasks URL preserves filters, oldest sort, and offset", () => {
  assert.equal(
    buildTasksUrl({
      statuses: ["todo", "review"],
      agents: ["local-codex"],
      risk: "high",
      sort: "oldest",
      offset: 50,
    }),
    "/tasks?status=todo,review&agent=local-codex&risk=high&sort=oldest&offset=50"
  );
});

test("tasks params drop invalid tokens", () => {
  assert.deepEqual(
    normalizeTasksIndexParams(
      { status: "todo,bogus,done", agent: "nobody,local-codex", risk: "wild" },
      STATUS_TOKENS,
      AGENT_TOKENS
    ),
    {
      selectedStatuses: ["todo", "done"],
      selectedAgents: ["local-codex"],
      risk: "all",
      sort: "updated",
      offset: 0,
    }
  );
});
