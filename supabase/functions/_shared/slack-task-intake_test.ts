import { assertEquals, assertMatch } from "jsr:@std/assert";
import {
  buildSlackTaskIntakeRecord,
  parseSlackTaskIntake,
} from "./slack-task-intake.ts";

Deno.test("parseSlackTaskIntake detects lowercase prefix", () => {
  const parsed = parseSlackTaskIntake("task: chase the directory layer");
  assertEquals(parsed.isIntake, true);
  assertEquals(parsed.body, "chase the directory layer");
});

Deno.test("parseSlackTaskIntake detects capitalized and uppercase prefixes", () => {
  assertEquals(parseSlackTaskIntake("Task: do the thing").isIntake, true);
  assertEquals(parseSlackTaskIntake("TASK:   spaced   body").body, "spaced   body");
});

Deno.test("parseSlackTaskIntake ignores non-prefixed messages", () => {
  const parsed = parseSlackTaskIntake("finished the koi sleeve today");
  assertEquals(parsed.isIntake, false);
  assertEquals(parsed.body, "finished the koi sleeve today");
});

Deno.test("parseSlackTaskIntake ignores mid-message and near-miss prefixes", () => {
  assertEquals(parseSlackTaskIntake("the task: was hard").isIntake, false);
  assertEquals(parseSlackTaskIntake("tasks: one two three").isIntake, false);
});

Deno.test("parseSlackTaskIntake treats bare prefix as ordinary capture", () => {
  const parsed = parseSlackTaskIntake("task:   ");
  assertEquals(parsed.isIntake, false);
  assertEquals(parsed.body, "task:   ");
});

Deno.test("buildSlackTaskIntakeRecord builds a conservative Standing draft", () => {
  const record = buildSlackTaskIntakeRecord({
    body: "chase the aggregator directory layer",
    thoughtId: "11111111-2222-3333-4444-555555555555",
    projectSlug: "dave-website",
  });
  assertEquals(record.status, "Standing");
  assertEquals(record.explicit_approval, false);
  assertEquals(record.intake_source, "slack-intake");
  assertEquals(record.risk, "low");
  assertEquals(record.priority, "medium");
  assertEquals(record.agent_code, null);
  assertEquals(record.project_slug, "dave-website");
  assertEquals(
    record.source_thought_id,
    "11111111-2222-3333-4444-555555555555",
  );
  assertEquals(record.linked_action_item_id, null);
  assertEquals(record.requested_by, "operator (Slack)");
  assertMatch(record.title, /^\[agent instructions\]\[unassigned\]\[slack\] /);
  assertMatch(record.context, /thoughts\.id 11111111-2222-3333-4444-555555555555/);
});

Deno.test("buildSlackTaskIntakeRecord bounds long titles and null project", () => {
  const record = buildSlackTaskIntakeRecord({
    body: "x".repeat(300),
    thoughtId: "11111111-2222-3333-4444-555555555555",
  });
  assertEquals(record.project_slug, null);
  assertEquals(record.title.length <= "[agent instructions][unassigned][slack] ".length + 96, true);
  assertMatch(record.title, /\.\.\.$/);
});
