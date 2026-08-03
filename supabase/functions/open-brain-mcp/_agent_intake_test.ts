import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  AGENT_TASK_INTAKE_SOURCES,
  type AgentTaskIntakeSource,
  assertFollowUpParentAllowed,
  assertNoActiveActionItemDraft,
  assertNoActiveThoughtDraft,
  assertNoDuplicateOpenFollowUp,
  assertPromotablePacketShape,
  buildActionItemPromotionIntakeRecord,
  buildAgentTaskIntakeRecord,
  buildFollowUpTaskRecord,
  buildThoughtIntakeRecord,
  FOLLOW_UP_TEMPLATE_BOUNDARIES,
  FOLLOW_UP_TEMPLATE_DO_STEPS,
  assertCloseCheckAuthorAllowed,
  validateCheckSpec,
  validateCloseCheck,
} from "./_agent_intake.ts";

const baseInput = {
  desired_outcome: "Create a draft intake task for OE-6 smoke verification.",
  context: "Harmless test context.",
  sources: [{ kind: "test", path: "_agent_intake_test.ts" }],
  do_steps: "Create a draft-safe task packet only.",
  acceptance_criteria: "Record is Standing and not claimable.",
  output_handoff: "Review the draft manually before promotion.",
  boundaries: "No automation, deploys, deletes, sends, or private data.",
  intake_source: "handoff-doc" as const,
};

Deno.test("intake creates Standing draft records with safe defaults", () => {
  const record = buildAgentTaskIntakeRecord(baseInput);

  assertEquals(record.status, "Standing");
  assertEquals(record.label, "agent-instructions");
  assertEquals(record.priority, "medium");
  assertEquals(record.risk, "medium");
  assertEquals(record.explicit_approval, false);
  assertEquals(record.requested_by, null);
  assertEquals(
    record.title.startsWith("[agent instructions][unassigned][task]"),
    true,
  );
});

Deno.test("intake preserves full task packet fields and optional linkage", () => {
  const record = buildAgentTaskIntakeRecord({
    ...baseInput,
    agent_code: "local-codex",
    project_slug: "brain-bank",
    priority: "high",
    risk: "low",
    requested_by: "oe6-test",
    source_thought_id: "11111111-1111-4111-8111-111111111111",
    linked_action_item_id: "22222222-2222-4222-8222-222222222222",
  });

  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.priority, "high");
  assertEquals(record.risk, "low");
  assertEquals(
    record.source_thought_id,
    "11111111-1111-4111-8111-111111111111",
  );
  assertEquals(
    record.linked_action_item_id,
    "22222222-2222-4222-8222-222222222222",
  );
  assertEquals(record.desired_outcome, baseInput.desired_outcome);
  assertEquals(record.context, baseInput.context);
  assertEquals(record.do_steps, baseInput.do_steps);
  assertEquals(record.acceptance_criteria, baseInput.acceptance_criteria);
  assertEquals(record.output_handoff, baseInput.output_handoff);
  assertEquals(record.boundaries, baseInput.boundaries);
});

Deno.test("intake never grants explicit approval even for high-risk drafts", () => {
  const record = buildAgentTaskIntakeRecord({
    ...baseInput,
    risk: "high",
  });

  assertEquals(record.status, "Standing");
  assertEquals(record.risk, "high");
  assertEquals(record.explicit_approval, false);
});

Deno.test("intake requires packet fields and array sources", () => {
  assertThrows(
    () => buildAgentTaskIntakeRecord({ ...baseInput, desired_outcome: " " }),
    Error,
    "desired_outcome is required",
  );
  assertThrows(
    () =>
      buildAgentTaskIntakeRecord({
        ...baseInput,
        sources: "not-array" as unknown as unknown[],
      }),
    Error,
    "sources must be an array",
  );
  assertThrows(
    () =>
      buildAgentTaskIntakeRecord({
        ...baseInput,
        desired_outcome: "x".repeat(4001),
      }),
    Error,
    "desired_outcome must be 4000 characters or fewer",
  );
  assertThrows(
    () =>
      buildAgentTaskIntakeRecord({
        ...baseInput,
        title: "x".repeat(241),
      }),
    Error,
    "title must be 240 characters or fewer",
  );
});

Deno.test("action-item promotion creates a conservative Standing draft packet", () => {
  const record = buildActionItemPromotionIntakeRecord({
    action_item: {
      id: "33333333-3333-4333-8333-333333333333",
      description: "Review the OE-6 manual action-item promotion path.",
      status: "open",
      source_thought_id: "44444444-4444-4444-8444-444444444444",
    },
    agent_code: "local-codex",
    project_slug: "brain-bank",
    requested_by: "oe6-test",
  });

  assertEquals(record.status, "Standing");
  assertEquals(record.intake_source, "action-item-promotion");
  assertEquals(
    record.linked_action_item_id,
    "33333333-3333-4333-8333-333333333333",
  );
  assertEquals(
    record.source_thought_id,
    "44444444-4444-4444-8444-444444444444",
  );
  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.risk, "low");
  assertEquals(record.priority, "medium");
  assertEquals(record.explicit_approval, false);
  assertEquals(Object.hasOwn(record, "claimed_by"), false);
  assertEquals(Object.hasOwn(record, "claim_expires_at"), false);
  assertEquals(
    record.desired_outcome,
    "Review the OE-6 manual action-item promotion path.",
  );
  assertEquals(record.sources, [
    {
      kind: "action_item",
      id: "33333333-3333-4333-8333-333333333333",
      source_thought_id: "44444444-4444-4444-8444-444444444444",
    },
  ]);
  assertEquals(
    record.boundaries.includes("Do not promote, claim, run, deploy, send"),
    true,
  );
});

Deno.test("action-item promotion rejects unsafe or invalid input", () => {
  assertThrows(
    () =>
      buildActionItemPromotionIntakeRecord({
        action_item: {
          id: "33333333-3333-4333-8333-333333333333",
          description: "Already handled.",
          status: "resolved",
        },
      }),
    Error,
    "Only open action_items",
  );

  assertThrows(
    () =>
      buildActionItemPromotionIntakeRecord({
        action_item: {
          id: "33333333-3333-4333-8333-333333333333",
          description: " ",
          status: "open",
        },
      }),
    Error,
    "description is required",
  );
});

Deno.test("action-item promotion rejects duplicate active linked drafts", () => {
  for (
    const status of [
      "Standing",
      "Agent Todo",
      "Agent Working",
      "Agent Needs Input",
      "Agent Review",
      "Needs Operator",
    ]
  ) {
    assertThrows(
      () =>
        assertNoActiveActionItemDraft(
          [{ id: "55555555-5555-4555-8555-555555555555", status }],
          "33333333-3333-4333-8333-333333333333",
        ),
      Error,
      "already has an active agent task draft",
    );
  }

  assertNoActiveActionItemDraft(
    [{ id: "66666666-6666-4666-8666-666666666666", status: "Agent Done" }],
    "33333333-3333-4333-8333-333333333333",
  );
});

Deno.test("thought intake creates a conservative Standing draft packet", () => {
  const record = buildThoughtIntakeRecord({
    thought: {
      id: "77777777-7777-4777-8777-777777777777",
      content:
        "Session closeout: Continue OE-6 by drafting a manual thought intake surface.",
      metadata: {
        source: "session-log",
        project: "brain-bank",
        topics: ["open-engine", "oe-6"],
      },
      created_at: "2026-06-29T16:20:00Z",
    },
    agent_code: "local-codex",
    project_slug: "brain-bank",
    requested_by: "session-233",
  });

  assertEquals(record.status, "Standing");
  assertEquals(record.intake_source, "session-log-closeout");
  assertEquals(
    record.source_thought_id,
    "77777777-7777-4777-8777-777777777777",
  );
  assertEquals(record.linked_action_item_id, null);
  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.risk, "low");
  assertEquals(record.priority, "medium");
  assertEquals(record.explicit_approval, false);
  assertEquals(Object.hasOwn(record, "claimed_by"), false);
  assertEquals(Object.hasOwn(record, "claim_expires_at"), false);
  assertEquals(
    record.desired_outcome,
    "Review source thought 77777777-7777-4777-8777-777777777777 and draft a manual agent task if it is still worth doing.",
  );
  assertEquals(record.sources, [
    {
      kind: "thought",
      id: "77777777-7777-4777-8777-777777777777",
      source: "session-log",
      created_at: "2026-06-29T16:20:00Z",
    },
  ]);
  assertEquals(
    record.context.includes("Source thought excerpt:"),
    true,
  );
  assertEquals(record.context.includes("Continue OE-6"), true);
  assertEquals(
    record.boundaries.includes("Do not promote, claim, run, deploy, send"),
    true,
  );
});

Deno.test("thought intake maps non-session captures to brain-bank-capture", () => {
  const record = buildThoughtIntakeRecord({
    thought: {
      id: "77777777-7777-4777-8777-777777777777",
      content: "Captured idea for a future Brain Bank task.",
      metadata: { source: "rest-api" },
    },
  });

  assertEquals(record.intake_source, "brain-bank-capture");
  assertEquals(record.sources, [
    {
      kind: "thought",
      id: "77777777-7777-4777-8777-777777777777",
      source: "rest-api",
      created_at: null,
    },
  ]);
});

Deno.test("thought intake bounds source excerpts", () => {
  const longContent = `${"Review ".repeat(400)}final note`;
  const record = buildThoughtIntakeRecord({
    thought: {
      id: "77777777-7777-4777-8777-777777777777",
      content: longContent,
    },
  });

  assertEquals(record.context.length < longContent.length, true);
  assertEquals(record.context.endsWith("..."), true);
});

Deno.test("thought intake rejects missing or invalid thought input", () => {
  assertThrows(
    () =>
      buildThoughtIntakeRecord({
        thought: {
          id: " ",
          content: "Session closeout text.",
        },
      }),
    Error,
    "thought.id is required",
  );

  assertThrows(
    () =>
      buildThoughtIntakeRecord({
        thought: {
          id: "77777777-7777-4777-8777-777777777777",
          content: " ",
        },
      }),
    Error,
    "thought.content is required",
  );
});

Deno.test("thought intake rejects duplicate active source-thought drafts", () => {
  for (
    const status of [
      "Standing",
      "Agent Todo",
      "Agent Working",
      "Agent Needs Input",
      "Agent Review",
      "Needs Operator",
    ]
  ) {
    assertThrows(
      () =>
        assertNoActiveThoughtDraft(
          [{ id: "88888888-8888-4888-8888-888888888888", status }],
          "77777777-7777-4777-8777-777777777777",
        ),
      Error,
      "already has an active agent task draft",
    );
  }

  assertNoActiveThoughtDraft(
    [{ id: "99999999-9999-4999-8999-999999999999", status: "Agent Done" }],
    "77777777-7777-4777-8777-777777777777",
  );
});

Deno.test("follow-up intake creates child Standing drafts with safe defaults", () => {
  const record = buildFollowUpTaskRecord({
    parent_task_id: "11111111-1111-4111-8111-111111111111",
    agent_code: "local-codex",
    project_slug: "brain-bank",
    requested_by: "oe7-test",
    desired_outcome:
      "Browser-check live AI answer surfaces for four GEO terms.",
    context:
      "Parent task completed web-index checks but lacked live AI answer UI access.",
  });

  assertEquals(record.status, "Standing");
  assertEquals(
    record.parent_task_id,
    "11111111-1111-4111-8111-111111111111",
  );
  assertEquals(record.intake_source, "agent-follow-up");
  assertEquals(record.explicit_approval, false);
  assertEquals(record.agent_code, "local-codex");
  assertEquals(record.project_slug, "brain-bank");
  assertEquals(record.risk, "low");
  assertEquals(record.priority, "medium");
  assertEquals(record.linked_action_item_id, null);
  assertEquals(record.source_thought_id, null);
  assertEquals(Object.hasOwn(record, "claimed_by"), false);
  assertEquals(Object.hasOwn(record, "claim_expires_at"), false);
  assertEquals(record.sources, [
    {
      kind: "agent_task",
      id: "11111111-1111-4111-8111-111111111111",
      relationship: "parent",
    },
  ]);
});

Deno.test("follow-up intake rejects missing parent task or packet fields", () => {
  assertThrows(
    () =>
      buildFollowUpTaskRecord({
        parent_task_id: " ",
        desired_outcome: "Do the child work.",
        context: "Parent found follow-up work.",
      }),
    Error,
    "parent_task_id is required",
  );

  assertThrows(
    () =>
      buildFollowUpTaskRecord({
        parent_task_id: "11111111-1111-4111-8111-111111111111",
        desired_outcome: " ",
        context: "Parent found follow-up work.",
      }),
    Error,
    "desired_outcome is required",
  );
});

Deno.test("follow-up intake rejects archived parents and duplicate active children", () => {
  assertFollowUpParentAllowed({
    id: "11111111-1111-4111-8111-111111111111",
    archived_at: null,
  });
  assertThrows(
    () =>
      assertFollowUpParentAllowed({
        id: "11111111-1111-4111-8111-111111111111",
        archived_at: "2026-07-09T12:00:00Z",
      }),
    Error,
    "archived and cannot receive follow-up drafts",
  );

  assertThrows(
    () =>
      assertNoDuplicateOpenFollowUp(
        [{
          id: "22222222-2222-4222-8222-222222222222",
          status: "Needs Operator",
          desired_outcome:
            "Browser-check live AI answer surfaces for four GEO terms.",
        }],
        "11111111-1111-4111-8111-111111111111",
        "Browser-check live AI answer surfaces for four GEO terms.",
      ),
    Error,
    "already has an active follow-up draft",
  );

  assertNoDuplicateOpenFollowUp(
    [{
      id: "33333333-3333-4333-8333-333333333333",
      status: "Agent Done",
      desired_outcome:
        "Browser-check live AI answer surfaces for four GEO terms.",
    }],
    "11111111-1111-4111-8111-111111111111",
    "Browser-check live AI answer surfaces for four GEO terms.",
  );
});

Deno.test("intake source list remains Brain Bank neutral", () => {
  assert(
    AGENT_TASK_INTAKE_SOURCES.includes(
      "brain-bank-capture" as AgentTaskIntakeSource,
    ),
  );
  assertEquals(
    AGENT_TASK_INTAKE_SOURCES.includes(
      "open-brain-capture" as AgentTaskIntakeSource,
    ),
    false,
  );
});

Deno.test("intake sources include triage-agent for OE-12", () => {
  assert(
    AGENT_TASK_INTAKE_SOURCES.includes("triage-agent" as AgentTaskIntakeSource),
    "triage-agent missing from AGENT_TASK_INTAKE_SOURCES",
  );
});

Deno.test("buildAgentTaskIntakeRecord accepts triage-agent source", () => {
  const record = buildAgentTaskIntakeRecord({
    desired_outcome: "Research X and produce a report",
    context: "From open action item",
    sources: [],
    do_steps: "1. read 2. report",
    acceptance_criteria: "Report lists findings with links",
    output_handoff: "Receipt only",
    boundaries: "Read-only; no sends",
    intake_source: "triage-agent",
    requested_by: "triage",
    linked_action_item_id: "00000000-0000-0000-0000-000000000001",
  });
  assertEquals(record.intake_source, "triage-agent");
  assertEquals(record.status, "Standing");
  assertEquals(record.explicit_approval, false);
});

Deno.test("intake preserves preferred_agent as a soft-affinity hint", () => {
  const record = buildAgentTaskIntakeRecord({
    ...baseInput,
    preferred_agent: "  local-codex  ",
  });
  assertEquals(record.preferred_agent, "local-codex");
});

Deno.test("intake defaults preferred_agent to null and never hard-assigns from it", () => {
  const record = buildAgentTaskIntakeRecord(baseInput);
  assertEquals(record.preferred_agent, null);
  assertEquals(record.agent_code, null);
});

Deno.test("action-item, thought, and follow-up intake pass preferred_agent through", () => {
  const fromActionItem = buildActionItemPromotionIntakeRecord({
    action_item: {
      id: "33333333-3333-4333-8333-333333333333",
      description: "Draft the follow-up email.",
      status: "open",
    },
    preferred_agent: "local-claude-code",
  });
  assertEquals(fromActionItem.preferred_agent, "local-claude-code");
  assertEquals(fromActionItem.agent_code, null);

  const fromThought = buildThoughtIntakeRecord({
    thought: {
      id: "44444444-4444-4444-8444-444444444444",
      content: "Session closeout capture.",
    },
    preferred_agent: "local-codex",
  });
  assertEquals(fromThought.preferred_agent, "local-codex");

  const followUp = buildFollowUpTaskRecord({
    parent_task_id: "55555555-5555-4555-8555-555555555555",
    desired_outcome: "Verify the deployed fix.",
    context: "Child follow-up test.",
    preferred_agent: "local-codex",
  });
  assertEquals(followUp.preferred_agent, "local-codex");
});

Deno.test("intake defaults requires_local false and honors the explicit flag", () => {
  // Default: no explicit flag, empty known-local list -> shared pool.
  assertEquals(buildAgentTaskIntakeRecord(baseInput).requires_local, false);
  // Explicit true wins.
  assertEquals(
    buildAgentTaskIntakeRecord({ ...baseInput, requires_local: true })
      .requires_local,
    true,
  );
  // An unlisted project still defaults to the shared pool.
  assertEquals(
    buildAgentTaskIntakeRecord({ ...baseInput, project_slug: "some-project" })
      .requires_local,
    false,
  );
  // Explicit true wins even with a project set.
  assertEquals(
    buildAgentTaskIntakeRecord({
      ...baseInput,
      project_slug: "some-project",
      requires_local: true,
    }).requires_local,
    true,
  );
});

Deno.test("action-item/thought/follow-up intake carry the requires_local default", () => {
  const fromActionItem = buildActionItemPromotionIntakeRecord({
    action_item: {
      id: "66666666-6666-4666-8666-666666666666",
      description: "Some project maintenance.",
      status: "open",
    },
    project_slug: "some-project",
  });
  assertEquals(fromActionItem.requires_local, false);

  const fromThought = buildThoughtIntakeRecord({
    thought: {
      id: "77777777-7777-4777-8777-777777777777",
      content: "A capture, no project.",
    },
  });
  assertEquals(fromThought.requires_local, false);
});

// --------------------------------------------------------------------------
// GAP B — executable follow-up packet params + template promote guard
// (spec 2026-07-19 §5.2 + §5.3, decision D3 = REFUSE with override).
// --------------------------------------------------------------------------

const followUpBase = {
  parent_task_id: "3f2f2f2f-0000-4000-8000-000000000001",
  desired_outcome: "Fix the flagged em dashes in the staged claim kit.",
  context: "Parent produced the kit; critic flagged voice issues.",
};

Deno.test("follow-up without overrides still gets the Standing template", () => {
  const record = buildFollowUpTaskRecord(followUpBase);
  assertEquals(record.do_steps, FOLLOW_UP_TEMPLATE_DO_STEPS);
  assertEquals(record.boundaries, FOLLOW_UP_TEMPLATE_BOUNDARIES);
  assertEquals(record.intake_source, "agent-follow-up");
});

Deno.test("follow-up with full execution overrides is born executable", () => {
  const record = buildFollowUpTaskRecord({
    ...followUpBase,
    do_steps: "Remove every em dash; fix the credential over-claims listed.",
    acceptance_criteria:
      "Both critic flags cleared in a revised deliverable; address unchanged.",
    boundaries:
      "Write-safe: stage a revised copy under deliverables/ only; never send.",
  });
  assertEquals(
    record.do_steps,
    "Remove every em dash; fix the credential over-claims listed.",
  );
  assert(!record.boundaries.startsWith("Manual follow-up draft only."));
  // output_handoff falls back to the template when omitted
  assert(record.output_handoff.length > 0);
});

Deno.test("follow-up with partial execution overrides throws (all-or-none)", () => {
  assertThrows(
    () =>
      buildFollowUpTaskRecord({
        ...followUpBase,
        do_steps: "Remove every em dash.",
        // acceptance_criteria and boundaries missing -> incoherent packet
      }),
    Error,
    "together",
  );
});

Deno.test("promote guard refuses a template-bodied follow-up", () => {
  assertThrows(
    () =>
      assertPromotablePacketShape(
        {
          intake_source: "agent-follow-up",
          do_steps: FOLLOW_UP_TEMPLATE_DO_STEPS,
        },
        false,
      ),
    Error,
    "PROMOTION_REFUSED_TEMPLATE_BODY",
  );
});

Deno.test("promote guard honors allow_template_body override", () => {
  assertPromotablePacketShape(
    { intake_source: "agent-follow-up", do_steps: FOLLOW_UP_TEMPLATE_DO_STEPS },
    true,
  ); // must not throw
});

Deno.test("promote guard passes an execution-shaped follow-up", () => {
  assertPromotablePacketShape(
    { intake_source: "agent-follow-up", do_steps: "Remove every em dash." },
    false,
  ); // must not throw
});

Deno.test("promote guard leaves action-item stubs alone (warn-only stays)", () => {
  assertPromotablePacketShape(
    {
      intake_source: "action-item-promotion",
      do_steps:
        "Review the linked action item, expand this draft into a complete task packet if it is still worth doing, then use the normal human promotion path when ready.",
    },
    false,
  ); // must not throw — D3 refuses only the follow-up template
});

// --------------------------------------------------------------------------
// OE-13 Sub-phase B — check_spec intake validator (server mirror of the
// controller's parseCheckSpec: same runners, same bounds, same arg pattern).
// --------------------------------------------------------------------------

Deno.test("validateCheckSpec: null/undefined pass through as null", () => {
  assertEquals(validateCheckSpec(null), null);
  assertEquals(validateCheckSpec(undefined), null);
});

Deno.test("validateCheckSpec: accepts allowlisted runner with bounded args", () => {
  assertEquals(
    validateCheckSpec({ runner: "deno-check", args: ["index.ts"] }),
    { runner: "deno-check", args: ["index.ts"] },
  );
});

Deno.test("validateCheckSpec: rejects unknown runner", () => {
  assertThrows(
    () => validateCheckSpec({ runner: "bash", args: ["-c", "true"] }),
    Error,
    "check_spec.runner",
  );
});

Deno.test("validateCheckSpec: rejects shell metacharacters and whitespace", () => {
  assertThrows(() =>
    validateCheckSpec({ runner: "node-test", args: ["a; rm -rf /"] })
  );
  assertThrows(() =>
    validateCheckSpec({ runner: "node-test", args: ["$(id)"] })
  );
  assertThrows(() => validateCheckSpec({ runner: "node-test", args: ["a b"] }));
});

Deno.test("validateCheckSpec: rejects unknown keys and arg-count violations", () => {
  assertThrows(() =>
    validateCheckSpec({ runner: "node-test", args: [], cwd: "/" })
  );
  assertThrows(() => validateCheckSpec({ runner: "npm-run", args: [] }));
  assertThrows(() => validateCheckSpec({ runner: "npm-test", args: ["x"] }));
});

Deno.test("buildAgentTaskIntakeRecord: carries a validated check_spec; defaults to null", () => {
  const base = {
    desired_outcome: "ship parseThing",
    context: "ctx",
    sources: [],
    do_steps: "do",
    acceptance_criteria: "ok",
    output_handoff: "handoff",
    boundaries: "none",
    intake_source: "handoff-doc" as const,
  };
  const withCheck = buildAgentTaskIntakeRecord({
    ...base,
    check_spec: { runner: "node-test", args: ["parse-thing.test.mjs"] },
  });
  assertEquals(withCheck.check_spec, {
    runner: "node-test",
    args: ["parse-thing.test.mjs"],
  });
  const without = buildAgentTaskIntakeRecord(base);
  assertEquals(without.check_spec, null);
});

// --------------------------------------------------------------------------
// Board-hygiene reconciliation — the close_check intake validator and the
// operator-authored-only author gate.
// --------------------------------------------------------------------------

// Site handles a wp_post_status probe may name. In production these come from
// profile.json's wordpress_sites; injected here so the validator stays a pure
// function and these tests need no profile file.
const WP_SITES = ["example-wp", "second-example-wp"];

Deno.test("validateCloseCheck: null/undefined pass through as null (not eligible)", () => {
  assertEquals(validateCloseCheck(null), null);
  assertEquals(validateCloseCheck(undefined), null);
});

Deno.test("validateCloseCheck: accepts each of the four probe shapes", () => {
  assertEquals(
    validateCloseCheck({
      probe: "http_contains",
      url: "https://example.com/some-page",
      assert: "Some Page Heading",
      measured_by: "plain-get",
    }),
    {
      probe: "http_contains",
      url: "https://example.com/some-page",
      assert: "Some Page Heading",
      measured_by: "plain-get",
    },
  );
  assertEquals(
    validateCloseCheck({
      probe: "wp_post_status",
      site: "example-wp",
      post_id: 1234,
      assert: "publish",
    }, WP_SITES),
    {
      probe: "wp_post_status",
      site: "example-wp",
      post_id: 1234,
      assert: "publish",
    },
  );
  assertEquals(
    validateCloseCheck({
      probe: "git_path_exists",
      repo: "example-owner/example-repo",
      path: "operator-dropbox/aftercare/",
      assert: "new_file_since_card_entered_desk",
    }),
    {
      probe: "git_path_exists",
      repo: "example-owner/example-repo",
      path: "operator-dropbox/aftercare/",
      assert: "new_file_since_card_entered_desk",
    },
  );
  assertEquals(
    validateCloseCheck({
      probe: "git_commit_contains",
      repo: "example-owner/example-repo",
      ref: "main",
      assert: "path:src/tracker/spec7.ts",
    }),
    {
      probe: "git_commit_contains",
      repo: "example-owner/example-repo",
      ref: "main",
      assert: "path:src/tracker/spec7.ts",
    },
  );
});

// FAIL-CLOSED DEFAULT. A fork that has wired no WordPress credentials must not
// be able to author a probe against a site it cannot reach. Unconfigured refuses
// at authorship rather than failing later at probe time.
Deno.test("validateCloseCheck: wp_post_status is refused when no sites are configured", () => {
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "wp_post_status",
        site: "example-wp",
        post_id: 1,
        assert: "publish",
      }),
    Error,
    "requires at least one configured WordPress site",
  );
  // The other three probes need no WordPress config and stay authorable.
  assertEquals(
    validateCloseCheck({
      probe: "http_contains",
      url: "https://example.com",
      assert: "ok",
    })?.probe,
    "http_contains",
  );
});

Deno.test("validateCloseCheck: rejects a fifth probe verb", () => {
  assertThrows(
    () => validateCloseCheck({ probe: "shell_exec", cmd: "true" }),
    Error,
    "close_check.probe must be one of",
  );
});

// STRUCTURAL fields stay strict: they flow into fetch URLs, map keys, and `gh`
// argv. Only http_contains.assert is content, and it is covered separately below.
Deno.test("validateCloseCheck: rejects shell strings in STRUCTURAL fields", () => {
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "http_contains",
        url: "https://example.com/$(id)",
        assert: "ok",
      }),
    Error,
    "shell metacharacters",
  );
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "git_commit_contains",
        repo: "example-owner/example-repo",
        ref: "main;id",
        assert: "path:a.ts",
      }),
    Error,
  );
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "http_contains",
        url: "https://example.com",
        assert: "ok",
        measured_by: "plain-get`id`",
      }),
    Error,
    "shell metacharacters",
  );
});

// A blanket ban across every field makes the feature unable to express its own
// primary use case: it rejects a quoted JSON-LD token and it rejects a literal
// `<title>` assertion. Asserting against HTML means asserting against quotes,
// angle brackets, ampersands and braces.
Deno.test("validateCloseCheck: http_contains.assert accepts real HTML and JSON-LD content", () => {
  for (
    const assertion of [
      '"Monday"', // JSON-LD token, not the bare word in prose
      "<title>Some Page", // a literal title assertion
      '"@type": "OpeningHoursSpecification"',
      "Bold color, traditional & character work.",
      "Why is the whole project planned before the first session?",
      "{\"closes\": \"19:00\"}",
    ]
  ) {
    const out = validateCloseCheck({
      probe: "http_contains",
      url: "https://example.com",
      assert: assertion,
    });
    assertEquals(out?.assert, assertion);
  }
});

Deno.test("validateCloseCheck: http_contains.assert still refuses control characters", () => {
  for (const bad of ["two\nlines", "tab\tsep", "nul\x00byte", "cr\rreturn"]) {
    assertThrows(
      () =>
        validateCloseCheck({
          probe: "http_contains",
          url: "https://example.com",
          assert: bad,
        }),
      Error,
      "control characters",
    );
  }
});

// The looser rule is scoped to http_contains ONLY. Every other probe's assert
// names a status or a path, not page content, and stays strict.
Deno.test("validateCloseCheck: the content relaxation does NOT leak to other probes", () => {
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "git_commit_contains",
        repo: "example-owner/example-repo",
        ref: "main",
        assert: 'path:"quoted".ts',
      }),
    Error,
    "shell metacharacters",
  );
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "wp_post_status",
        site: "example-wp",
        post_id: 1,
        assert: '"publish"',
      }, WP_SITES),
    Error,
  );
});

Deno.test("validateCloseCheck: rejects unknown keys and a non-https url", () => {
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "http_contains",
        url: "https://example.com",
        assert: "ok",
        extra: "nope",
      }),
    Error,
    "unknown keys",
  );
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "http_contains",
        url: "http://example.com",
        assert: "ok",
      }),
    Error,
    "must be an https:// URL",
  );
});

// The highest-value single guard in the suite: a bare existence assertion would
// falsely close every install-shape card, because the executor itself wrote the
// file before the card ever reached the desk.
Deno.test("validateCloseCheck: git_path_exists refuses any assert but the since-desk clause", () => {
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "git_path_exists",
        repo: "example-owner/example-repo",
        path: "operator-dropbox/aftercare/",
        assert: "exists",
      }),
    Error,
    "new_file_since_card_entered_desk",
  );
});

Deno.test("validateCloseCheck: git_path_exists refuses a lane-written folder", () => {
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "git_path_exists",
        repo: "example-owner/example-repo",
        path: "deliverables/example-project/aftercare/",
        assert: "new_file_since_card_entered_desk",
      }),
    Error,
    "exclusively an operator drop-box",
  );
});

Deno.test("validateCloseCheck: rejects path traversal and an unlisted wp site", () => {
  assertThrows(() =>
    validateCloseCheck({
      probe: "git_path_exists",
      repo: "example-owner/example-repo",
      path: "../../etc/passwd",
      assert: "new_file_since_card_entered_desk",
    })
  );
  assertThrows(
    () =>
      validateCloseCheck({
        probe: "wp_post_status",
        site: "some-other-wp",
        post_id: 1,
        assert: "publish",
      }, WP_SITES),
    Error,
    "close_check.site must be one of",
  );
});

Deno.test("assertCloseCheckAuthorAllowed: refuses a triage-agent intake carrying a close_check", () => {
  const probe = {
    probe: "http_contains",
    url: "https://example.com",
    assert: "ok",
  };
  assertThrows(
    () => assertCloseCheckAuthorAllowed("triage-agent", probe),
    Error,
    "operator-authored only",
  );
  // A triage-agent draft with no close_check is untouched by the gate.
  assertCloseCheckAuthorAllowed("triage-agent", null);
  assertCloseCheckAuthorAllowed("triage-agent", undefined);
  // Every other provenance may author one.
  assertCloseCheckAuthorAllowed("handoff-doc", probe);
  assertCloseCheckAuthorAllowed("dashboard-button", probe);
});

Deno.test("buildAgentTaskIntakeRecord: carries a validated close_check; defaults to null; refuses triage-agent", () => {
  const base = {
    desired_outcome: "ship the thing",
    context: "ctx",
    sources: [],
    do_steps: "do",
    acceptance_criteria: "ok",
    output_handoff: "handoff",
    boundaries: "none",
    intake_source: "handoff-doc" as const,
  };
  const withCheck = buildAgentTaskIntakeRecord({
    ...base,
    close_check: {
      probe: "wp_post_status",
      site: "example-wp",
      post_id: 42,
      assert: "publish",
    },
    wordpress_sites: WP_SITES,
  });
  assertEquals(withCheck.close_check, {
    probe: "wp_post_status",
    site: "example-wp",
    post_id: 42,
    assert: "publish",
  });
  assertEquals(buildAgentTaskIntakeRecord(base).close_check, null);
  assertThrows(
    () =>
      buildAgentTaskIntakeRecord({
        ...base,
        intake_source: "triage-agent" as const,
        close_check: {
          probe: "wp_post_status",
          site: "example-wp",
          post_id: 42,
          assert: "publish",
        },
        wordpress_sites: WP_SITES,
      }),
    Error,
    "operator-authored only",
  );
});
