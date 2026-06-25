import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProjectsUrl,
  normalizeProjectsIndexParams,
} from "../src/lib/projects-index-controls.js";

const TYPE_TOKENS = ["llm", "client", "ops"];
const STATUS_TOKENS = ["active", "stale", "done", "archive"];

test("projects index defaults to grid view sorted by updated", () => {
  assert.deepEqual(
    normalizeProjectsIndexParams({}, TYPE_TOKENS, STATUS_TOKENS),
    {
      selectedTypes: [],
      selectedStatuses: [],
      view: "grid",
      sort: "updated",
      offset: 0,
      includeArchived: false,
    }
  );
});

test("projects URL omits default grid and updated params", () => {
  assert.equal(
    buildProjectsUrl({
      types: [],
      statuses: [],
      view: "grid",
      sort: "updated",
    }),
    "/projects"
  );
});

test("projects URL preserves filters, log view, name sort, archived include, and offset", () => {
  assert.equal(
    buildProjectsUrl({
      types: ["llm", "client"],
      statuses: ["active"],
      view: "log",
      sort: "name",
      includeArchived: true,
      offset: 50,
    }),
    "/projects?type=llm,client&status=active&view=log&sort=name&include=archived&offset=50"
  );
});

test("closed status filters automatically include archived rows", () => {
  assert.equal(
    normalizeProjectsIndexParams(
      { status: "active,done" },
      TYPE_TOKENS,
      STATUS_TOKENS
    ).includeArchived,
    true
  );
});
