#!/usr/bin/env python3
"""Loop-closing Tasks 5.1 and 5.2: TypeScript-side mutants of the fragment gate
and of dedup at insert (batch-local exact dedup; semantic dedup proposals).

    python3 scripts/loop-closing/fragment-gate-ts-mutants.py            # every mutant
    python3 scripts/loop-closing/fragment-gate-ts-mutants.py NAME ...   # some

Each mutant is applied to a fresh copy of the working tree (never the tree
itself): one or more literal replacements, each of which must match exactly
once. Then the ONE check written for it runs, and the verdict follows the rule
of external-crm-route-ts-mutants.sh and the SQL harnesses:

  CAUGHT     the check ran to completion and the ASSERTION claimed for the
             mutant executed and failed. The claim is bound at RUN TIME (Codex
             re-review 2, N1), not by a string in the source: the claimed
             assertion is a call to claim() / claimVerdict()
             (scripts/loop-closing/claim.ts), which appends its own "enter"
             record and, when ITS comparison fails, a "fail" record with a fresh
             uuid to the log this sweep names in OBFG_CLAIM_LOG, and puts
             "[claim:<id> <uuid>]" on its failure. CAUGHT needs all of:
               deno test checks: the named test is among the FAILED lines, its
               block in Deno's ERRORS section opens with
               "error: AssertionError", that first line carries the tag of the
               mutant's claim (CLAIMS below), the block carries no
               infrastructure signal (INFRA_SIGNALS), and the claim log holds
               that claim's "enter" immediately followed by its "fail" with the
               SAME uuid;
               probe harnesses: exactly one FAILED line, starting with the label
               configured for the mutant and carrying the claim's tag, no
               PASSED line, no infrastructure signal, and the same log record.
             A helper or prerequisite assertion, a fake error, a forged tag or a
             direct fail() never enters the claim, so it has no record and
             cannot know the uuid.
  SURVIVED   the check exited 0.
  NEVER-RAN  anything else: a timeout, a crash, a type or module error, a
             permission or missing-file error inside the named test, a failure
             that is not the claimed assertion, no claim log, a replacement that
             did not match exactly once. Never counted as a catch.

Before any mutant, in this order, each stage stopping the sweep (exit 2) if it
does not hold:
  1. POSITIVE CONTROLS: every check passes on the unmutated copy, and its claim
     log shows every claim configured for that check entered and passed (no
     claim is dead code).
  2. CLAIM AUDIT (scripts/loop-closing/claim-audit.ts, on the TypeScript
     parser): claim entry points are only ever called, never aliased or
     wrapped; every id is a literal; each mutant's claim id has exactly one call
     site, inside the Deno.test named for it; no test or harness file builds a
     tag, names the claim log or writes a file. Then four AUDIT CONTROLS: the
     audit reads erased TypeScript syntax with the comparison's own policy (a
     type-asserted claim call is accepted, a type-asserted Deno file write is
     refused; an entry point named only inside an erased statement or an
     `implements` clause is accepted, one named in a class's `extends` is
     refused).
  3. ALLOWED controls: each applies a change the AGENTS.md mirror rule permits
     (comment wording, layout, deno fmt, a type annotation, an erased type
     wrapper, grouping no runtime observes) to one copy, and the
     check must still exit 0, else the suite has a false FAIL.
  4. NEGATIVE CONTROLS: each applies a real mutant the sweep catches, plus a
     fault that stops the claimed assertion from executing or failing on its
     own (no --allow-read, a missing or unreadable source, a module that cannot
     load, a function the parser cannot find, another assertion failing first,
     a helper assertion sharing the claim's message, a fake AssertionError, a
     forged tag, a direct fail() with the probe's label, an unwritable claim
     log). Every one must end NEVER-RAN.
Exit 0 only when every mutant is CAUGHT; 1 when any SURVIVED; 2 when any
NEVER-RAN.

Deno tests run with --no-check so a mutant is judged by behavior, not by an
unused-import type error.
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TIMEOUT = int(os.environ.get("OBFG_TS_MUTANT_TIMEOUT", "300"))

MV = "supabase/functions/_shared/metadata-validation.ts"
FG = "supabase/functions/_shared/fragment-gate.ts"
CP = "supabase/functions/_shared/capture-pipeline.ts"
IT = "supabase/functions/ingest-thought/index.ts"
BD = "supabase/functions/brain-digest/index.ts"
DD = "supabase/functions/_shared/dedup.ts"
DDP = "supabase/functions/brain-digest/dedup-proposals.ts"

CHECKS = {
    "mv": ["deno", "test", "--no-lock", "--no-check", "--allow-read", "--allow-env", "supabase/functions/_shared/metadata-validation.test.ts"],
    "fg": ["deno", "test", "--no-lock", "--no-check", "--allow-read", "--allow-env", "supabase/functions/_shared/fragment-gate.test.ts"],
    "dg": ["deno", "test", "--no-lock", "--no-check", "--allow-read", "--allow-env", "supabase/functions/brain-digest/fragment-proposals.test.ts"],
    "dd": ["deno", "test", "--no-lock", "--no-check", "--allow-read", "--allow-env", "supabase/functions/_shared/dedup.test.ts"],
    "dgd": ["deno", "test", "--no-lock", "--no-check", "--allow-read", "--allow-env", "supabase/functions/brain-digest/dedup-proposals.test.ts"],
    "ingest": ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "scripts/loop-closing/ingest-probe-harness.ts"],
    "mcp": ["deno", "run", "--config", "scripts/loop-closing/closeout-capture-probe.deno.json", "--no-lock", "--allow-net", "--allow-env", "--allow-read", "scripts/loop-closing/closeout-capture-probe-harness.ts"],
}
PASSED_LINE = {"ingest": "INGEST PROBE PASSED", "mcp": "CLOSEOUT CAPTURE PROBE PASSED"}

T_PLAN_E2E = "fragment gate 5.1, shared capture path: the plan's eight items store four, drop four with their reasons, and record one suspect"
T_MIRROR_BODY = "mirror 5.1: the two extractAndStoreActionItems bodies are the same code apart from the listed names"
T_MIRROR_PROMPT = "mirror 5.1: the extraction prompt carries the stand-alone rule once, and the ingest copy is the shared constant"
T_LINEBREAK = "mirror 5.1: Codex's ingest-only line-break mutants fail the body comparison"
T_REFORMAT = "mirror 5.1: allowed reformatting and comment wording of the ingest body still compare equal"
T_DIGEST = "fragment section: the digest reads fragment_pending_proposals and joins the section after the recheck section"
T_AST_UNIT = "mirror 5.1: the tree comparison keeps literal values and every line break that changes the parse, and drops layout, comments and types"
T_AST_V8 = "mirror 5.1: a line break at any token gap leaves the tree unchanged only where V8 runs the code the same"
T_PAREN_TABLE = "mirror 5.1: parentheses the language can observe stay distinct, and parentheses that only group an erased type compare equal"
T_PAREN_ORACLE = "mirror 5.1: wrapping any node in parentheses or an erased type assertion leaves the tree unchanged only where the code runs the same"
T_TYPE_ERASURE = "mirror 5.1: erased TypeScript syntax in the ingest body compares equal, and every tree locator still finds its site"
# Task 5.2.
T_MIRROR_52 = "mirror 5.2: both copies run the batch-local dedup after the open-item dedup, read candidates before the insert, and write dedup rows after it"
T_DD_AL = "dedup 5.2: Sam vs Riley is maybe at 0.833 with empty constraint sets (must not suppress)"
T_DD_LIVE = "dedup 5.2: live vs demo is maybe and the proposal says constraints differ: live vs demo"
T_DD_SHORTER = "dedup 5.2: containment is of the SHORTER item's content tokens in the longer item's"
T_DD_THRESHOLD = "dedup 5.2: the threshold is inclusive at 0.8"
T_DD_MIN = "dedup 5.2: the shorter item needs at least two content tokens"
T_DD_EXACT = "dedup 5.2, shared capture path: two identical Casey strings in ONE batch insert once with an exact_batch row"
T_DD_GATE_FIRST = "dedup 5.2, shared capture path: the fragment gate runs before the batch dedup, so a fragment's copies are both fragment drops"
T_DD_CASEY = "dedup 5.2, shared capture path: the three Casey rows (one capture each, same project) all insert, the second and third propose the first"
T_DD_AL_E2E = "dedup 5.2, shared capture path: Sam and Riley BOTH insert, the second carries a proposal (must not suppress)"
T_DD_NULL = "dedup 5.2, shared capture path: a null-project pair at 0.9 containment is maybe and both insert"
T_DD_PROJECT = "dedup 5.2, shared capture path: a different project proposes nothing and both insert"
T_DD_MNS = "dedup 5.2, shared capture path: the audit-shaped wrongly-matched pairs all insert (stand-ins; the audit lists no ids)"
T_DD_SAME_THOUGHT = "dedup 5.2: planSemanticProposals excludes the batch's own rows and its own source thought, and picks the oldest candidate"
T_DD_RETRY = "dedup 5.2: record_decisions is retried on 40P01 and a refusal is logged, never thrown"
T_DGD_LINES = "dedup section: header, one line per item with both ids, both descriptions and the constraint wording"
T_DGD_JOIN = "dedup section: the digest reads dedup_pending_proposals and joins the section after the fragment section"
# Codex review 1 of PR 33, R4: the per-file helpers the extraction bodies reach.
# Correction 3 of PR 33: those helpers have ONE copy now, in CH; the copy
# parity (T_MIRROR_HELPERS, claim mirror-helpers) is gone, and the inventory
# allows no reached per-file binding at all.
T_MIRROR_HELPERS_INV = "mirror 5.2: neither extraction body reaches a module-level binding of its own file, and open-brain-mcp's wrapper passes the imported mechanical test"
T_SINGLE_SOURCE = "mirror 5.2: the per-file capture helpers have one copy, in _shared/capture-helpers.ts, which every capture file imports and none declares"
CH = "supabase/functions/_shared/capture-helpers.ts"
MCPF = "supabase/functions/open-brain-mcp/index.ts"
NORMALIZER = 'return s.toLowerCase().replace(/[^a-z0-9\\s]/g, "").replace(/\\s+/g, " ")'
NORMALIZER_NO_DIGITS = 'return s.toLowerCase().replace(/[^a-z\\s]/g, "").replace(/\\s+/g, " ")'
# A helper both bodies call, defined in each file: the body comparison sees the
# same call; only the inventory sees an unlisted helper (here the ingest one
# strips digits, the shared one does not).
def UNLISTED_HELPER(strip_digits_in_ingest: bool):
    edits = []
    for rel in (IT, CP):
        body = 'normalizeActionText(s).replace(/[0-9]/g, "")' if (rel == IT and strip_digits_in_ingest) else "normalizeActionText(s)"
        edits.append((rel, "// --- Action Item Tracking ---\n", f"// --- Action Item Tracking ---\n\nfunction normalizeBatchText(s: string): string {{\n  return {body};\n}}\n"))
        edits.append((rel, "  const batch = createBatchDedup(normalizeActionText);", "  const batch = createBatchDedup(normalizeBatchText);"))
    return edits

# Codex re-review 1 of PR 33, F2, retargeted in correction 3 (the normalizers
# it edited are now one copy in CH): each capture file gets its own normalizer
# that reads its regular expression from a module-level enum (or namespace) of
# its own file, and its batch dedup calls it; the two normalizer bodies are the
# same text, and only the ingest copy's value differs (a-y: z is stripped, so
# "send Zoe design" and "send Oe design" collide). The inventory, which allows
# no reached per-file binding, must see it.
POLICY_NORMALIZER = 'function normalizePolicyText(s: string): string {\n  return s.toLowerCase().replace(new RegExp(NormalizationPolicy.Strip, "g"), "").replace(/\\s+/g, " ").trim();\n}\n'
def POLICY_DECL(kind: str, cls: str) -> str:
    if kind == "enum":
        return f'enum NormalizationPolicy {{ Strip = "[^{cls}0-9\\\\s]" }}\n'
    return f'namespace NormalizationPolicy {{\n  export const Strip = "[^{cls}0-9\\\\s]";\n}}\n'
def POLICY_HELPER(kind: str, ingest_cls: str):
    edits = []
    for rel, cls in ((IT, ingest_cls), (CP, "a-z")):
        edits.append((rel, "// --- Action Item Tracking ---\n", f"// --- Action Item Tracking ---\n\n{POLICY_DECL(kind, cls)}{POLICY_NORMALIZER}"))
        edits.append((rel, "  const batch = createBatchDedup(normalizeActionText);", "  const batch = createBatchDedup(normalizePolicyText);"))
    return edits
# Codex re-review 2 of PR 33, F2, as written but on per-file normalizers (its
# own target is now one copy): both files declare the namespace with a-z, and a
# module-level statement in the ingest file sets a-y after the declaration.
NAMESPACE_RULES = 'namespace NormalizationPolicy {\n  export const rules = { strip: "[^a-z0-9\\\\s]" };\n}\n'
RULES_NORMALIZER = POLICY_NORMALIZER.replace("NormalizationPolicy.Strip", "NormalizationPolicy.rules.strip")
def NAMESPACE_WRITE():
    edits = []
    for rel in (IT, CP):
        write = 'NormalizationPolicy.rules.strip = "[^a-y0-9\\\\s]";\n' if rel == IT else ""
        edits.append((rel, "// --- Action Item Tracking ---\n", f"// --- Action Item Tracking ---\n\n{NAMESPACE_RULES}{write}{RULES_NORMALIZER}"))
        edits.append((rel, "  const batch = createBatchDedup(normalizeActionText);", "  const batch = createBatchDedup(normalizePolicyText);"))
    return edits
# Correction 3: a capture file declares its own copy again (and drops that
# name from its import), or reads the module some other way, or the module
# itself grows something a capture file could reach and change.
IT_IMPORT = 'import {\n  isMechanicalCapture,\n  LOG_TRUNC,\n  normalizeActionText,\n} from "../_shared/capture-helpers.ts";\n'
CP_IMPORT = 'import { LOG_TRUNC, normalizeActionText } from "./capture-helpers.ts";\n'
LOCAL_NORMALIZER_NO_DIGITS = 'function normalizeActionText(s: string): string {\n  return s.toLowerCase().replace(/[^a-z\\s]/g, "").replace(/\\s+/g, " ").trim();\n}\n'
LOCAL_MECHANICAL = 'const MECHANICAL_CAPTURE_PREFIXES = ["[Calendar Sync]"];\nfunction isMechanicalCapture(content: string): boolean {\n  return MECHANICAL_CAPTURE_PREFIXES.some((p) => content.trimStart().startsWith(p));\n}\n'

GATE_SHARED = "  const rows = (await applyFragmentGate(db, thoughtId, guarded))\n"
GATE_INGEST = "  const rows = (await applyFragmentGate(supabase, thoughtId, guarded))\n"
DEDUP_FILTER = '    .select("description")\n    .eq("status", "open");'
DEDUP_FILTER_SPACE = '    .select("description")\n    .eq("status", "op en");'
RETURN_TAIL = "      return true;\n    });\n  // Fragment gate"
RETURN_NEWLINE = "      return\n      true;\n    });\n  // Fragment gate"
RETURN_COMMENT_NEWLINE = "      return /* reviewer line break\n      */ true;\n    });\n  // Fragment gate"
FGT_PATH = "supabase/functions/_shared/fragment-gate.test.ts"
MA = "scripts/loop-closing/mirror-ast.ts"
# Codex re-review 2's synthetic fixtures, inserted in BOTH copies before this
# line; the mutant then moves a line break in the ingest copy only.
ITEMS_GUARD = "  if (items.length === 0) return;"


def fixture_mutant(fixture: str, old: str, new: str):
    """Edits: the fixture into both copies, then old -> new in the ingest copy."""
    return [(IT, ITEMS_GUARD, fixture + ITEMS_GUARD), (CP, ITEMS_GUARD, fixture + ITEMS_GUARD), (IT, old, new)]


NONNULL_FIXTURE = "  let count = 0; let step = 0; count!\n  ++step; if (step === 0) return;\n"
UNICODE_FIXTURE = "  let \u6570 = 0; let \u5024 = 0; \u6570\n  ++\u5024; if (\u5024 === 0) return;\n"
REGEX_FIXTURE = '  let hit = false; if (true) /^a +$/.test("a ") && (hit = true); if (!hit) return;\n'
PROPERTY_FIXTURE = "  const probe = { return: true }; if (!probe.return) return;\n"
TEMPLATE_FIXTURE = '  const regexText = `captured ${ /}/.test("}") }`;\n'
# Codex re-review 4, R5-1.
ASSIGN_ITEMS = "    items = extractOperatorLines(content);"
LATE_STRING_FIXTURE = '  "reviewer note";\n'
# Codex re-review 5, R6-1 (87, 88): a helper whose body opens with a grouped
# string (and, in the second, an ordinary directive first), in BOTH copies; the
# allowed edit adds an erased declaration in the ingest copy only.
PROLOGUE_GROUPED_FIXTURE = '  function reviewerDirective() { ("reviewer marker"); return 7; } if (reviewerDirective() !== 7) return;\n'
PROLOGUE_BETWEEN_FIXTURE = '  function reviewerDirective() { "reviewer ordinary"; ("reviewer marker"); return 7; } if (reviewerDirective() !== 7) return;\n'
PROLOGUE_ORDINARY_FIXTURE = '  function reviewerDirective() { "reviewer ordinary"; return 7; } if (reviewerDirective() !== 7) return;\n'
RULE_LINE = "    * Each item must stand alone: name the person and the thing. Never use her, him, it, that, or this as the object.\n"

# Task 5.2 sites.
SEMANTIC_RETURN = '  return overlapContainment(a, b) >= SEMANTIC_OVERLAP_THRESHOLD ? "maybe" : "no";'
PROJECT_RULE = "      return mine === null || theirs === null || mine === theirs;"
BATCH_FILTER = "    )\n    .filter((row) => batch.keep(row.description));\n"
CANDIDATES_READ_SHARED = "  const recent = await loadSemanticCandidates(db);\n"


def SUPPRESS_EDITS(rel: str, client: str):
    """The round-2 design restored in one copy: semanticOverlap imported, and
    every row with a `maybe` against a recent open item dropped before the
    insert."""
    imp = ("  createBatchDedup,\n  loadSemanticCandidates,", "  createBatchDedup,\n  semanticOverlap,\n  loadSemanticCandidates,")
    return [(rel, imp[0], imp[1]),
            (rel, f"  const recent = await loadSemanticCandidates({client});\n",
             f"  const recent = await loadSemanticCandidates({client});\n"
             "  rows.splice(0, rows.length, ...rows.filter((r) => !recent.some((c) => c.source_thought_id !== thoughtId && semanticOverlap(r.description, c.description) === \"maybe\")));\n")]


# name: (file, old, new, check, expected failure: a test name, or a probe label)
MUTANTS = {
    # The plan's required mutant: rule (b) deleted.
    "rule_b_deleted": (MV,
        "  if (last !== undefined && DANGLING_FINAL_TOKENS.has(last)) {\n    return { normalized, drop: \"dangling_clause\", pronounObject: false };\n  }\n",
        "", "mv", "fragment gate 5.1: finalize what we're drops with reason dangling_clause and NOT one_token"),
    "rule_a_off_by_one": (MV, "if (new Set(descriptionContentTokens(normalized)).size <= 1) {",
        "if (new Set(descriptionContentTokens(normalized)).size < 1) {", "mv",
        "fragment gate 5.1: deploy, switch on and then deploy drop with reason one_token"),
    "rule_a_no_stoplist": (MV, "if (new Set(descriptionContentTokens(normalized)).size <= 1) {",
        "if (new Set(rawItemTokens(normalized).filter((t) => t.length >= 3)).size <= 1) {", "mv",
        "fragment gate 5.1: rule (a) counts distinct content tokens after the Task 1.3 stoplist"),
    "normalize_off": (MV, "    const next = s.replace(ITEM_PREFIX_RE, \"\").trim();", "    const next = s;", "mv",
        "fragment gate 5.1: Awaiting the operator to apply migration 063 keeps, normalized to the operator to apply migration 063"),
    "prefix_rejected": (MV, "  const normalized = normalizeItemPrefix(desc);\n",
        "  const normalized = normalizeItemPrefix(desc);\n  if (normalized !== String(desc ?? \"\").trim()) return { normalized, drop: \"one_token\", pronounObject: false };\n",
        "mv", "fragment gate 5.1: a prefix is normalized, never a reason to drop"),
    "pronoun_off": (MV, "    if (ALWAYS_PRONOUN.has(t)) return true;\n", "", "mv",
        "fragment gate 5.1: send her the explainer PDF keeps as a pronoun_object suspect"),
    "stored_normalized": (FG, "      kept.push(row);", "      kept.push({ ...row, description: verdict.normalized });", "mv", T_PLAN_E2E),
    "drop_row_not_written": (FG, "    await recordDecision(db, {\n      layer: \"fragment\",\n      outcome: \"dropped\",",
        "    if (false) await recordDecision(db, {\n      layer: \"fragment\",\n      outcome: \"dropped\",", "mv", T_PLAN_E2E),
    "wrong_reason": (FG, "      reason: verdict.drop,", "      reason: \"one_token\",", "mv", T_PLAN_E2E),
    "suspect_wrong_item": (FG, "      item_id: item.id,", "      item_id: thoughtId,", "mv", T_PLAN_E2E),
    # Wiring, shared copy (open-brain-mcp, external-crm-sync).
    "gate_removed_shared": (CP, GATE_SHARED, "  const rows = guarded\n", "mv", T_PLAN_E2E),
    "gate_removed_shared_probe": (CP, GATE_SHARED, "  const rows = guarded\n", "mcp", "probe D: action_items rows"),
    "suspects_not_recorded_shared": (CP, "  await recordPronounSuspects(\n    db,", "  if (false) await recordPronounSuspects(\n    db,", "mv", T_PLAN_E2E),
    "insert_no_select_shared": (CP, "  const { data: inserted, error } = await db.from(\"action_items\").insert(rows)\n    .select(\"id, description\");",
        "  const { data: inserted, error } = await db.from(\"action_items\").insert(rows);", "mv", T_PLAN_E2E),
    "dedup_before_gate_shared": (CP,
        "  const rows = (await applyFragmentGate(db, thoughtId, guarded))\n    .filter((row) =>\n      !existingNormalized.has(normalizeActionText(row.description))\n    )\n",
        "  const rows = (await applyFragmentGate(db, thoughtId, guarded.filter((row) =>\n      !existingNormalized.has(normalizeActionText(row.description))\n    )))\n",
        "mv", "fragment gate 5.1, shared capture path: runs after the appointment guard and before the open-item dedup"),
    "prompt_rule_missing_shared": (CP, RULE_LINE, "", "fg", T_MIRROR_PROMPT),
    # Wiring, ingest-thought copy.
    "gate_removed_ingest": (IT, GATE_INGEST, "  const rows = guarded\n", "fg", T_MIRROR_BODY),
    "gate_removed_ingest_probe": (IT, GATE_INGEST, "  const rows = guarded\n", "ingest", "probe 10 action_items rows"),
    "suspects_not_recorded_ingest": (IT, "  await recordPronounSuspects(\n    supabase,", "  if (false) await recordPronounSuspects(\n    supabase,", "fg", T_MIRROR_BODY),
    "suspects_not_recorded_ingest_probe": (IT, "  await recordPronounSuspects(\n    supabase,", "  if (false) await recordPronounSuspects(\n    supabase,", "ingest", "probe 10 suspect row"),
    "wrong_client_ingest": (IT, GATE_INGEST, "  const rows = (await applyFragmentGate({ from: () => ({ insert: () => Promise.resolve({ error: null }) }) }, thoughtId, guarded))\n", "ingest", "probe 10 fragment drop rows"),
    # Brain Bank keeps one prompt: ingest-thought imports the shared constant.
    # The mutant gives ingest a private literal again, which is how a copy
    # silently loses a rule.
    "prompt_rule_missing_ingest": (IT, "content: EXTRACT_METADATA_SYSTEM_PROMPT,", "content: \"Extract metadata from the user's captured thought. (a private copy)\",", "fg", T_MIRROR_PROMPT),
    # Codex review 1, F2: a divergent filter string, invisible to a whitespace
    # squash. Caught by the token comparison and, behaviorally, by probe 11.
    "dedup_filter_space_ingest": (IT, DEDUP_FILTER, DEDUP_FILTER_SPACE, "fg", T_MIRROR_BODY),
    "dedup_filter_space_ingest_probe": (IT, DEDUP_FILTER, DEDUP_FILTER_SPACE, "ingest", "probe 11 action_items rows"),
    "dedup_filter_space_shared": (CP, DEDUP_FILTER, DEDUP_FILTER_SPACE, "fg", T_MIRROR_BODY),
    # Codex re-review 1, R2: a line break after return (ASI: the filter returns
    # undefined), bare and inside a block comment. Caught by the token
    # comparison and, behaviorally, by probe 1 (every item filtered out).
    "return_newline_ingest": (IT, RETURN_TAIL, RETURN_NEWLINE, "fg", T_MIRROR_BODY),
    "return_newline_ingest_probe": (IT, RETURN_TAIL, RETURN_NEWLINE, "ingest", "probe 1 action_items rows"),
    "return_comment_newline_ingest": (IT, RETURN_TAIL, RETURN_COMMENT_NEWLINE, "fg", T_MIRROR_BODY),
    # Codex re-review 2, N2: a line break moved across a postfix ++ after a
    # TypeScript non-null `!` and after a non-ASCII identifier, in the ingest
    # copy only (the fixture is in both). Caught by the tree comparison and,
    # behaviorally, by probe 1 (the guard returns before any item is stored).
    "nonnull_postfix_ingest": (fixture_mutant(NONNULL_FIXTURE, "count!\n  ++step;", "count!++\n  step;"), None, None, "fg", T_MIRROR_BODY),
    "nonnull_postfix_ingest_probe": (fixture_mutant(NONNULL_FIXTURE, "count!\n  ++step;", "count!++\n  step;"), None, None, "ingest", "probe 1 action_items rows"),
    "unicode_postfix_ingest": (fixture_mutant(UNICODE_FIXTURE, "\u6570\n  ++\u5024;", "\u6570++\n  \u5024;"), None, None, "fg", T_MIRROR_BODY),
    "unicode_postfix_ingest_probe": (fixture_mutant(UNICODE_FIXTURE, "\u6570\n  ++\u5024;", "\u6570++\n  \u5024;"), None, None, "ingest", "probe 1 action_items rows"),
    # Codex re-review 2's regex boundary (35): regular-expression source.
    "regex_source_ingest": (fixture_mutant(REGEX_FIXTURE, "/^a +$/", "/^a+$/"), None, None, "fg", T_MIRROR_BODY),
    "regex_source_ingest_probe": (fixture_mutant(REGEX_FIXTURE, "/^a +$/", "/^a+$/"), None, None, "ingest", "probe 1 action_items rows"),
    # The comparison itself (scripts/loop-closing/mirror-ast.ts). The first two
    # replace correction 2's codetokens_drops_linebreaks / _every_linebreak:
    # a flat token list with no tree (the 571e84a comparison: every line break
    # erased), and a key that records each node's line (layout-sensitive).
    "ast_tokens_not_tree": (MA, '  visit(root, "root", undefined);\n  return out;\n}',
        '  const sf = root.getSourceFile();\n  return tokenRanges(sf, root).map((t) => sf.text.slice(t.start, t.end));\n}', "fg", T_LINEBREAK),
    "ast_layout_sensitive": (MA, "    out.push(`${role}=${kindName(n.kind)}${payload(n, role, parent, rename)}`);",
        "    out.push(`${role}=${kindName(n.kind)}${payload(n, role, parent, rename)} @${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line}`);", "fg", T_REFORMAT),
    "ast_types_kept": (MA, 'const TYPE_ROLES = new Set(["type", "typeArguments", "typeParameters"]);', "const TYPE_ROLES = new Set<string>([]);", "fg", T_AST_UNIT),
    "ast_literal_values_dropped": (MA, "    p = ` ${JSON.stringify(n.text)}`;\n  } else if (ts.isNoSubstitutionTemplateLiteral(n)", '    p = "";\n  } else if (ts.isNoSubstitutionTemplateLiteral(n)', "fg", T_AST_UNIT),
    "ast_operator_dropped": (MA, "    p = ` ${kindName(n.operator)}`;", '    p = "";', "fg", T_AST_UNIT),
    "ast_declaration_kind_dropped": (MA, '    p = ` ${f === ts.NodeFlags.Let ? "let"', '    p = "" && ` ${f === ts.NodeFlags.Let ? "let"', "fg", T_AST_UNIT),
    "ast_trailing_comma_recorded": (MA, "        out.push(`${r}=[`);", '        out.push(`${r}=[${arr.hasTrailingComma ? "," : ""}`);', "fg", T_AST_UNIT),
    "ast_parse_errors_accepted": (MA, "  if (diags.length > 0) {", "  if (false) {", "fg", T_AST_UNIT),
    "ast_arrow_rule_dropped": (MA, "    if (LINE_TERMINATOR.test(text.slice(arr.pos, arr.getStart(sf)))) {", "    if (false) {", "fg", T_AST_V8),
    # Codex re-review 3, R4-1: the one erasure and parenthesis policy
    # (isWrapper, skipErased, groupingObservable), the runtime gate, and the
    # tree locators that use the policy.
    "ast_all_grouping_kept": (MA, "  return isErasedWrapper(n) || ts.isParenthesizedExpression(n);", "  return isErasedWrapper(n);", "fg", T_MIRROR_BODY),
    "ast_erased_only_grouping_kept": (MA, "      if (grouped && groupingObservable(n, core)) {", "      if (grouped) {", "fg", T_PAREN_TABLE),
    "ast_directive_paren_dropped": (MA, "  if (ts.isExpressionStatement(p) && ts.isStringLiteral(core) && inDirectivePrologue(p)) return true;",
        "  if (false && ts.isExpressionStatement(p) && ts.isStringLiteral(core) && inDirectivePrologue(p)) return true;", "fg", T_PAREN_TABLE),
    "ast_naming_paren_dropped": (MA, "  if (\n    ts.isBinaryExpression(p) && p.left === outer &&", "  if (\n    false && ts.isBinaryExpression(p) && p.left === outer &&", "fg", T_PAREN_ORACLE),
    # Codex re-review 4, R5-1: each exception exactly as wide as its rule.
    # Wider (the 4f1bc65 behavior, a false FAIL) and narrower (a false PASS)
    # in every part of each rule.
    "ast_naming_any_value": (MA, "    isAnonymousFunctionDefinition(skipErased(p.right))\n  ) return true;", "    true\n  ) return true;", "fg", T_PAREN_TABLE),
    "ast_naming_value_unwrapped": (MA, "    isAnonymousFunctionDefinition(skipErased(p.right))\n  ) return true;", "    isAnonymousFunctionDefinition(p.right)\n  ) return true;", "fg", T_PAREN_TABLE),
    "ast_naming_class_missed": (MA, " || ts.isArrowFunction(e) ||\n    (ts.isClassExpression(e) && e.name === undefined);", " || ts.isArrowFunction(e);", "fg", T_PAREN_TABLE),
    "ast_naming_named_counted": (MA, "  return (ts.isFunctionExpression(e) && e.name === undefined) || ts.isArrowFunction(e) ||", "  return ts.isFunctionExpression(e) || ts.isArrowFunction(e) ||", "fg", T_PAREN_TABLE),
    "ast_directive_anywhere": (MA, "ts.isStringLiteral(core) && inDirectivePrologue(p)) return true;", "ts.isStringLiteral(core)) return true;", "fg", T_PAREN_TABLE),
    "ast_prologue_first_only": (MA, "    if (!directiveShaped(s)) return false;", "    return false;", "fg", T_PAREN_TABLE),
    "ast_prologue_grouped_continues": (MA, "  for (; isWrapper(e); e = (e as ts.ParenthesizedExpression).expression) if (ts.isParenthesizedExpression(e)) return false;",
        "  for (; isWrapper(e); e = (e as ts.ParenthesizedExpression).expression);", "fg", T_PAREN_TABLE),
    "ast_prologue_method_missed": (MA, "    ts.isMethodDeclaration(owner) || ts.isConstructorDeclaration(owner)", "    ts.isConstructorDeclaration(owner)", "fg", T_PAREN_TABLE),
    # Codex re-review 5, R6-1: the prologue walk uses the key's own statement
    # erasure (isTypeOnlyStatement). Reverting the skip (the 2d1bd68 behavior);
    # applying it only after the first statement (Codex's 87 shape); a second,
    # partial list (type aliases only); an erased statement that admits
    # everything after it; and an erasure widened to an executable statement or
    # to a grouped string, each of which must still end the prologue. Narrowing
    # the predicate itself is caught on the live body.
    "ast_prologue_erased_terminates": (MA, "    if (isTypeOnlyStatement(s)) continue;\n    if (!directiveShaped(s)) return false;", "    if (!directiveShaped(s)) return false;", "fg", T_PAREN_TABLE),
    "ast_prologue_leading_erased_terminates": (MA, "    if (isTypeOnlyStatement(s)) continue;", "    if (isTypeOnlyStatement(s) && s !== list[0]) continue;", "fg", T_PAREN_TABLE),
    "ast_prologue_interface_terminates": (MA, "    if (isTypeOnlyStatement(s)) continue;", "    if (ts.isTypeAliasDeclaration(s)) continue;", "fg", T_PAREN_TABLE),
    "ast_prologue_erased_admits_rest": (MA, "    if (isTypeOnlyStatement(s)) continue;", "    if (isTypeOnlyStatement(s)) return true;", "fg", T_PAREN_TABLE),
    "ast_prologue_skips_executable": (MA, "    if (isTypeOnlyStatement(s)) continue;", "    if (isTypeOnlyStatement(s) || ts.isVariableStatement(s)) continue;", "fg", T_PAREN_TABLE),
    "ast_prologue_skips_grouped_string": (MA, "    if (isTypeOnlyStatement(s)) continue;",
        "    if (isTypeOnlyStatement(s) || (ts.isExpressionStatement(s) && ts.isStringLiteral(skipErased(s.expression)))) continue;", "fg", T_PAREN_TABLE),
    "ast_type_alias_statement_kept": (MA, "  if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;", "  if (ts.isInterfaceDeclaration(n)) return true;", "fg", T_TYPE_ERASURE),
    "ast_optional_chain_flag_dropped": (MA, '  if (n.flags & ts.NodeFlags.OptionalChain) p += " ?chain";', '  if (false) p += " ?chain";', "fg", T_PAREN_TABLE),
    "ast_erased_expression_kept": (MA, "  return ERASED_EXPRESSIONS.has(n.kind) ||", "  return false ||", "fg", T_TYPE_ERASURE),
    "runtime_gate_dropped": (MA, "  return loaded.ok ? null : loaded.error;", "  return null;", "fg", T_PAREN_ORACLE),
    "locator_return_true_unwrapped": (FGT_PATH, "skipErased(r.expression).kind === ts.SyntaxKind.TrueKeyword", "r.expression.kind === ts.SyntaxKind.TrueKeyword", "fg", T_TYPE_ERASURE),
    "locator_callee_unwrapped": (FGT_PATH, "    const callee = skipErased(c.expression);\n    return ts.isIdentifier(callee)", "    const callee = c.expression;\n    return ts.isIdentifier(callee)", "fg", T_TYPE_ERASURE),
    "locator_open_filter_unwrapped": (FGT_PATH, "    const [k, v] = c.arguments.map((a) => skipErased(a));", "    const [k, v] = c.arguments.map((a) => a);", "fg", T_TYPE_ERASURE),
    "locator_select_by_offset": (FGT_PATH, "    selectedAfterDedup: dedup < insert && selectsInsert,", "    selectedAfterDedup: dedup < insert && select === insert,", "fg", T_TYPE_ERASURE),
    # The digest.
    "digest_section_unwired": (BD, "recheckSection, fragmentSection, dedupSection].filter(Boolean)", "recheckSection, dedupSection].filter(Boolean)", "dg", T_DIGEST),
    # ---------------------------------------------------------------------
    # Task 5.2: dedup at insert.
    # The plan's mutation: semanticOverlap returns a suppressing value.
    "semantic_suppressing_value": (DD, SEMANTIC_RETURN, '  return overlapContainment(a, b) >= SEMANTIC_OVERLAP_THRESHOLD ? ("same" as "maybe") : "no";', "dd", T_DD_AL),
    # The round-2 design restored: a `maybe` against a recent open item
    # suppresses the insert (shared copy, then ingest copy).
    "semantic_suppress_path_shared": (SUPPRESS_EDITS(CP, "db"), None, None, "dd", T_DD_AL_E2E),
    "semantic_suppress_path_ingest": (SUPPRESS_EDITS(IT, "supabase"), None, None, "fg", T_MIRROR_BODY),
    "semantic_suppress_path_ingest_probe": (SUPPRESS_EDITS(IT, "supabase"), None, None, "ingest", "probe 13 action_items rows"),
    # Batch-local exact dedup.
    "batch_dedup_off_shared": (CP, BATCH_FILTER, "    );\n", "dd", T_DD_EXACT),
    "batch_dedup_off_shared_probe": (CP, BATCH_FILTER, "    );\n", "mcp", "probe F: action_items rows"),
    "batch_dedup_off_ingest": (IT, BATCH_FILTER, "    );\n", "fg", T_MIRROR_BODY),
    "batch_dedup_off_ingest_probe": (IT, BATCH_FILTER, "    );\n", "ingest", "probe 13 action_items rows"),
    "batch_set_not_updated": (DD, "      seen.add(key);\n      return true;", "      return true;", "dd", T_DD_EXACT),
    "exact_row_not_written": (DD, "    await recordDecision(db, {\n      layer: \"dedup\",", "    if (false) await recordDecision(db, {\n      layer: \"dedup\",", "dd", T_DD_EXACT),
    "exact_row_not_written_mcp_probe": (DD, "    await recordDecision(db, {\n      layer: \"dedup\",", "    if (false) await recordDecision(db, {\n      layer: \"dedup\",", "mcp", "probe F: exact_batch row"),
    "exact_row_not_written_ingest_probe": (DD, "    await recordDecision(db, {\n      layer: \"dedup\",", "    if (false) await recordDecision(db, {\n      layer: \"dedup\",", "ingest", "probe 13 exact_batch row"),
    "exact_row_wrong_survivor": (DD, "      related_item_id: survivor,\n    });", "      related_item_id: thoughtId,\n    });", "dd", T_DD_EXACT),
    "batch_before_gate_shared": (CP,
        "  const rows = (await applyFragmentGate(db, thoughtId, guarded))\n    .filter((row) =>\n      !existingNormalized.has(normalizeActionText(row.description))\n    )\n    .filter((row) => batch.keep(row.description));",
        "  const rows = (await applyFragmentGate(db, thoughtId, guarded.filter((row) => batch.keep(row.description))))\n    .filter((row) =>\n      !existingNormalized.has(normalizeActionText(row.description))\n    );",
        "dd", T_DD_GATE_FIRST),
    "batch_rows_not_recorded_ingest": (IT, "  await recordBatchDuplicates(\n    supabase,", "  if (false) await recordBatchDuplicates(\n    supabase,", "fg", T_MIRROR_BODY),
    # Semantic proposals.
    "semantic_not_proposed_shared": (CP, "  await proposeSemanticDuplicates(\n    db,", "  if (false) await proposeSemanticDuplicates(\n    db,", "dd", T_DD_CASEY),
    "semantic_not_proposed_shared_probe": (CP, "  await proposeSemanticDuplicates(\n    db,", "  if (false) await proposeSemanticDuplicates(\n    db,", "mcp", "probe F: semantic proposal"),
    "semantic_not_proposed_ingest": (IT, "  await proposeSemanticDuplicates(\n    supabase,", "  if (false) await proposeSemanticDuplicates(\n    supabase,", "fg", T_MIRROR_BODY),
    "semantic_not_proposed_ingest_probe": (IT, "  await proposeSemanticDuplicates(\n    supabase,", "  if (false) await proposeSemanticDuplicates(\n    supabase,", "ingest", "probe 13 semantic proposal"),
    "candidates_after_insert_shared": ([(CP, CANDIDATES_READ_SHARED, ""), (CP, "  // Pronoun-object suspects are inserted, then proposed for review (Task 5.1).\n  await recordPronounSuspects(\n    db,",
        "  const recent = await loadSemanticCandidates(db);\n  // Pronoun-object suspects are inserted, then proposed for review (Task 5.1).\n  await recordPronounSuspects(\n    db,")], None, None, "fg", T_MIRROR_52),
    "semantic_newest_survivor": (DD, "  return Date.parse(a.created_at) - Date.parse(b.created_at) ||", "  return Date.parse(b.created_at) - Date.parse(a.created_at) ||", "dd", T_DD_CASEY),
    "semantic_threshold_exclusive": (DD, SEMANTIC_RETURN, '  return overlapContainment(a, b) > SEMANTIC_OVERLAP_THRESHOLD ? "maybe" : "no";', "dd", T_DD_THRESHOLD),
    "semantic_min_tokens_off": (DD, "  if (shorter.size < SEMANTIC_MIN_CONTENT_TOKENS) return 0;", "  if (shorter.size < 1) return 0;", "dd", T_DD_MIN),
    "semantic_longer_containment": (DD, "  const [shorter, longer] = sa.size <= sb.size ? [sa, sb] : [sb, sa];", "  const [shorter, longer] = sa.size <= sb.size ? [sb, sa] : [sa, sb];", "dd", T_DD_SHORTER),
    "semantic_project_ignored": (DD, PROJECT_RULE, "      return true;", "dd", T_DD_PROJECT),
    "semantic_null_project_excluded": (DD, PROJECT_RULE, "      return mine !== null && theirs !== null && mine === theirs;", "dd", T_DD_NULL),
    "semantic_same_thought_included": (DD, ".filter((c) => !insertedIds.has(c.id) && c.source_thought_id !== thoughtId)", ".filter((c) => !insertedIds.has(c.id))", "dd", T_DD_SAME_THOUGHT),
    "record_no_retry": (DD, "      { p_rows: rows.map(toInsertPayload) },\n    );", "      { p_rows: rows.map(toInsertPayload) },\n      1,\n    );", "dd", T_DD_RETRY),
    "describe_order_swapped": (DD, "  return `constraints differ: ${side(onlySurvivor)} vs ${side(onlyItem)}`;", "  return `constraints differ: ${side(onlyItem)} vs ${side(onlySurvivor)}`;", "dd", T_DD_LIVE),
    "constraint_env_dropped": (DD, "    if (ENVIRONMENT_WORDS.has(w) || NEGATION_WORDS.has(w)) out.add(w);", "    if (NEGATION_WORDS.has(w)) out.add(w);", "dd", T_DD_LIVE),
    # The digest.
    "dedup_digest_unwired": (BD, "fragmentSection, dedupSection].filter(Boolean)", "fragmentSection].filter(Boolean)", "dgd", T_DGD_JOIN),
    "dedup_digest_wording_dropped": (DDP, "(${describeConstraints(r.description, survivorText)}${status})", "(constraints agree${status})", "dgd", T_DGD_LINES),
    # Codex review 1 of PR 33, R4: Codex's fresh-02 mutant (digits stripped
    # from the normalizer). Correction 3 retargeted all four: the normalizer is
    # one copy in CH, so stripping digits there changes BOTH capture paths, and
    # ingest probe 14 and REST probe H each catch it behaviorally; a capture
    # file that declares its own (digit-stripping) normalizer again, beside an
    # import that no longer names it, is caught by the single-source check.
    "local_normalizer_ingest": ([(IT, IT_IMPORT, IT_IMPORT.replace("  normalizeActionText,\n", "")),
        (IT, "// --- Action Item Tracking ---\n", "// --- Action Item Tracking ---\n\n" + LOCAL_NORMALIZER_NO_DIGITS)], None, None, "fg", T_SINGLE_SOURCE),
    "normalizer_digits_module_ingest_probe": (CH, NORMALIZER, NORMALIZER_NO_DIGITS, "ingest", "probe 14 action_items rows"),
    "local_normalizer_shared": ([(CP, CP_IMPORT, CP_IMPORT.replace(", normalizeActionText", "")),
        (CP, "// --- Action Item Tracking ---\n", "// --- Action Item Tracking ---\n\n" + LOCAL_NORMALIZER_NO_DIGITS)], None, None, "fg", T_SINGLE_SOURCE),
    "normalizer_digits_module_rest_probe": (CH, NORMALIZER, NORMALIZER_NO_DIGITS, "mcp", "probe H: action_items rows"),
    # The other two helpers, retargeted the same way: the ingest file declares
    # its own mechanical test (one prefix), and the shared copy its own log
    # constant (100).
    "local_mechanical_ingest": ([(IT, IT_IMPORT, IT_IMPORT.replace("  isMechanicalCapture,\n", "")),
        (IT, "// --- Action Item Tracking ---\n", "// --- Action Item Tracking ---\n\n" + LOCAL_MECHANICAL)], None, None, "fg", T_SINGLE_SOURCE),
    "local_log_trunc_shared": (CP, CP_IMPORT, 'import { normalizeActionText } from "./capture-helpers.ts";\nconst LOG_TRUNC = 100;\n', "fg", T_SINGLE_SOURCE),
    # An unlisted per-file helper in both bodies, diverging between the files.
    "unlisted_helper_diverges": (UNLISTED_HELPER(True), None, None, "fg", T_MIRROR_HELPERS_INV),
    # open-brain-mcp's wrapper hands the shared copy another mechanical test.
    "mcp_wrapper_other_mechanical": (MCPF, "    content,\n    isMechanicalCapture,\n  );", "    content,\n    () => false,\n  );", "fg", T_MIRROR_HELPERS_INV),
    # Codex re-review 1 of PR 33, F2 (retargeted, see POLICY_HELPER; the two
    # "listed" variants are retired with the list), and Codex re-review 2, F2
    # (NAMESPACE_WRITE).
    "enum_value_diverges": (POLICY_HELPER("enum", "a-y"), None, None, "fg", T_MIRROR_HELPERS_INV),
    "namespace_value_diverges": (POLICY_HELPER("namespace", "a-y"), None, None, "fg", T_MIRROR_HELPERS_INV),
    "namespace_write_diverges": (NAMESPACE_WRITE(), None, None, "fg", T_MIRROR_HELPERS_INV),
    # Correction 3: the module exports its prefix list (a capture file could
    # then import and change it); the module changes its list at top level; a
    # capture file reads the module through a namespace import.
    "module_exports_prefixes": (CH, "const MECHANICAL_CAPTURE_PREFIXES = [", "export const MECHANICAL_CAPTURE_PREFIXES = [", "fg", T_SINGLE_SOURCE),
    "module_top_level_write": (CH, "export function isMechanicalCapture(", 'MECHANICAL_CAPTURE_PREFIXES.push("[Reviewer]");\n\nexport function isMechanicalCapture(', "fg", T_SINGLE_SOURCE),
    "ingest_namespace_import": (IT, IT_IMPORT, IT_IMPORT + 'import * as CaptureHelpers from "../_shared/capture-helpers.ts";\n', "fg", T_SINGLE_SOURCE),
}


# Changes the AGENTS.md mirror rule ALLOWS (comment wording, local layout) in
# one copy, plus a type annotation (types are erased at runtime). Each runs as
# an extra positive control on its own tree: the check must still exit 0, or
# the suite would fail a permitted change (a false FAIL) and the sweep is
# NEVER-RAN (exit 2).
# name: (edits, check). edits: a list of (file, old, new), or DENO_FMT.
DENO_FMT = "deno fmt"
ALLOWED = {
    # Codex re-review 1, R3.
    "allowed_comment_wording_ingest": ([(IT, "  // Fetch existing open items to dedup against\n",
        "  // Read existing open items to dedup against\n")], "fg"),
    "allowed_comment_quotes_code_ingest": ([(IT, "  // Fetch existing open items to dedup against\n",
        "  // Fetch existing open items to dedup against; applyFragmentGate( and\n  // recordPronounSuspects( run once each, return\n  // true.\n")], "fg"),
    "allowed_filter_layout_ingest": ([(IT, DEDUP_FILTER, '    .select( "description" )\n    .eq(\n      "status",\n      "open"\n    );')], "fg"),
    "allowed_blank_lines_ingest": ([(IT, "  if (rows.length === 0) return;\n", "\n\n  if (rows.length === 0) return;\n\n\n")], "fg"),
    "allowed_comment_wording_shared": ([(CP, "  // Fetch existing open items to dedup against\n",
        "  // Read the open items to dedup against\n")], "fg"),
    # Codex re-review 1, R1: a type change in the shared copy. Correction 2
    # made it a setup failure (NEVER-RAN); types are not part of the compared
    # tree now, so it must simply pass.
    "allowed_shared_param_any": ([(CP, "  db: ActionItemDb,\n", "  db: any,\n")], "fg"),
    # Codex re-review 2, N3: a comment holding a line break before an empty
    # return's semicolon; a space before `return true`'s semicolon; a comment
    # and spaces inside the filter's member call.
    "allowed_empty_return_comment_newline": ([(IT, "  if (rows.length === 0) return;", "  if (rows.length === 0) return /* explanation\n  */;")], "fg"),
    "allowed_return_space": ([(IT, RETURN_TAIL, RETURN_TAIL.replace("true;", "true ;"))], "fg"),
    "allowed_filter_member_comment": ([(IT, DEDUP_FILTER, DEDUP_FILTER.replace(".eq(", ". /* lookup */ eq ("))], "fg"),
    # Codex re-review 2 (29): an actual `deno fmt` of the ingest file (it
    # rewraps .insert(rows) and adds a trailing comma).
    "allowed_deno_fmt_ingest": (DENO_FMT, "fg"),
    # Codex re-review 2 (33, 34): a property named `return` rewrapped, and the
    # spacing inside a template expression that holds a regex with a `}`.
    "allowed_property_name_wrap": (fixture_mutant(PROPERTY_FIXTURE, "return: true", "return\n  : true"), "fg"),
    "allowed_template_expression_space": (fixture_mutant(TEMPLATE_FIXTURE, '/}/.test("}")', '/}/.test( "}" )'), "fg"),
    # Codex re-review 3, R4-1 (52, 53): a type assertion whose parentheses only
    # group it, and a type assertion on `return true`, in the ingest copy; and
    # a non-null assertion in parentheses in the shared copy.
    "allowed_type_cast_items_ingest": ([(IT, ITEMS_GUARD, "  if ((items as typeof items).length === 0) return;")], "fg"),
    "allowed_return_true_as_boolean_ingest": ([(IT, RETURN_TAIL, RETURN_TAIL.replace("true;", "true as boolean;"))], "fg"),
    "allowed_nonnull_items_shared": ([(CP, ITEMS_GUARD, "  if ((items!).length === 0) return;")], "fg"),
    # Codex re-review 4, R5-1: a grouped assignment target (70), the same
    # target typed with a definite-assignment marker on its declaration (79),
    # both `items.length` receivers non-null in parentheses (78), all in the
    # ingest copy; and a string statement outside a directive prologue, bare in
    # the shared copy and grouped in the ingest copy.
    "allowed_assignment_grouping_ingest": ([(IT, ASSIGN_ITEMS, "    (items) = extractOperatorLines(content);")], "fg"),
    "allowed_assignment_typed_definite_ingest": ([(IT, "  let items: unknown[];", "  let items!: unknown[];"),
        (IT, ASSIGN_ITEMS, "    (items as unknown[]) = extractOperatorLines(content);")], "fg"),
    "allowed_nonnull_items_both_ingest": ([(IT, ITEMS_GUARD, "  if ((items!).length === 0) return;"),
        (IT, "with ${items.length} operator-marker lines", "with ${(items!).length} operator-marker lines")], "fg"),
    "allowed_late_string_grouped_ingest": (fixture_mutant(LATE_STRING_FIXTURE, '  "reviewer note";', '  ("reviewer note");'), "fg"),
    # Task 5.2: the new comment block reworded, and the dedup call rewrapped
    # onto one line, in the ingest copy only.
    "allowed_dedup_comment_wording_ingest": ([(IT, "  // Task 5.2: each batch copy names the survivor the insert returned; then a\n",
        "  // Task 5.2, reworded: batch copies name their inserted survivor; then a\n")], "fg"),
    "allowed_dedup_call_one_line_ingest": ([(IT, "  await proposeSemanticDuplicates(\n    supabase,\n    recent,\n    thoughtId,\n    metadata.project,\n    inserted,\n  );",
        "  await proposeSemanticDuplicates(supabase, recent, thoughtId, metadata.project, inserted);")], "fg"),
    # Correction 3 of PR 33: the four helper-parity allowed controls (the
    # ingest normalizer relaid, a comment in the ingest prefix list, a listed
    # enum and namespace relaid) are retired with the copies they edited. The
    # single-source check reads imports and declarations, not layout: the
    # ingest import reordered and relaid with a comment, the shared import
    # relaid over three lines, and the module's normalizer rewrapped with a
    # comment must still pass.
    "allowed_import_relaid_ingest": ([(IT, IT_IMPORT, 'import {\n  // the one copy (correction 3)\n  normalizeActionText,\n  isMechanicalCapture, LOG_TRUNC,\n} from "../_shared/capture-helpers.ts";\n')], "fg"),
    "allowed_import_relaid_shared": ([(CP, CP_IMPORT, 'import {\n  LOG_TRUNC,\n  normalizeActionText,\n} from "./capture-helpers.ts";\n')], "fg"),
    "allowed_module_normalizer_layout": ([(CH, NORMALIZER + "\n    .trim();", "// one line, same code\n  return (s.toLowerCase().replace(/[^a-z0-9\\s]/g, \"\").replace(/\\s+/g, \" \").trim() as string);")], "fg"),
    # Codex re-review 5, R6-1: an erased declaration added in the ingest copy
    # only, before an already-grouped string (87: a type alias; 88: an
    # interface), between an ordinary directive and a grouped string, and
    # before an ordinary directive.
    "allowed_erased_type_before_grouped_ingest": (fixture_mutant(PROLOGUE_GROUPED_FIXTURE, 'function reviewerDirective() { ("reviewer marker");',
        'function reviewerDirective() { type ReviewMarker = number; ("reviewer marker");'), "fg"),
    "allowed_erased_interface_before_grouped_ingest": (fixture_mutant(PROLOGUE_GROUPED_FIXTURE, 'function reviewerDirective() { ("reviewer marker");',
        'function reviewerDirective() { interface ReviewMarker { value: number } ("reviewer marker");'), "fg"),
    "allowed_erased_type_between_directive_and_grouped_ingest": (fixture_mutant(PROLOGUE_BETWEEN_FIXTURE, '"reviewer ordinary"; ("reviewer marker");',
        '"reviewer ordinary"; type ReviewMarker = number; ("reviewer marker");'), "fg"),
    "allowed_erased_type_before_directive_ingest": (fixture_mutant(PROLOGUE_ORDINARY_FIXTURE, 'function reviewerDirective() { "reviewer ordinary";',
        'function reviewerDirective() { type ReviewMarker = number; "reviewer ordinary";'), "fg"),
}

# The test file each deno-test check runs, and the harness each probe check
# runs: the files the claim audit reads.
TEST_FILE = {"mv": "supabase/functions/_shared/metadata-validation.test.ts",
             "fg": "supabase/functions/_shared/fragment-gate.test.ts",
             "dg": "supabase/functions/brain-digest/fragment-proposals.test.ts",
             "dd": "supabase/functions/_shared/dedup.test.ts",
             "dgd": "supabase/functions/brain-digest/dedup-proposals.test.ts"}
HARNESS_FILE = {"ingest": "scripts/loop-closing/ingest-probe-harness.ts",
                "mcp": "scripts/loop-closing/closeout-capture-probe-harness.ts"}

# The ONE claim each mutant is certified against: the id of a claim() call
# (deno tests) or a claimVerdict() call (probe harnesses). Codex re-review 1,
# R1, and re-review 2, N1.
CLAIMS = {
    "rule_b_deleted": "rule-b-dangling",
    "rule_a_off_by_one": "rule-a-one-token",
    "rule_a_no_stoplist": "rule-a-stoplist",
    "normalize_off": "prefix-normalized",
    "prefix_rejected": "prefix-never-drops",
    "pronoun_off": "pronoun-suspect",
    "stored_normalized": "e2e-stored",
    "drop_row_not_written": "e2e-drops",
    "wrong_reason": "e2e-drops",
    "suspect_wrong_item": "e2e-suspect",
    "gate_removed_shared": "e2e-stored",
    "gate_removed_shared_probe": "gate-rows",
    "suspects_not_recorded_shared": "e2e-suspect",
    "insert_no_select_shared": "e2e-suspect",
    "dedup_before_gate_shared": "gate-before-dedup",
    "prompt_rule_missing_shared": "prompt-rule-once",
    "gate_removed_ingest": "mirror-body",
    "gate_removed_ingest_probe": "probe-10-rows",
    "suspects_not_recorded_ingest": "mirror-body",
    "suspects_not_recorded_ingest_probe": "probe-10-suspect",
    "wrong_client_ingest": "probe-10-drops",
    "prompt_rule_missing_ingest": "prompt-single-source",
    "dedup_filter_space_ingest": "mirror-body",
    "dedup_filter_space_ingest_probe": "probe-11-rows",
    "dedup_filter_space_shared": "mirror-body",
    "return_newline_ingest": "mirror-body",
    "return_newline_ingest_probe": "probe-1-rows",
    "return_comment_newline_ingest": "mirror-body",
    "nonnull_postfix_ingest": "mirror-body",
    "nonnull_postfix_ingest_probe": "probe-1-rows",
    "unicode_postfix_ingest": "mirror-body",
    "unicode_postfix_ingest_probe": "probe-1-rows",
    "regex_source_ingest": "mirror-body",
    "regex_source_ingest_probe": "probe-1-rows",
    "ast_tokens_not_tree": "linebreak-after-return",
    "ast_layout_sensitive": "allowed-reformatting",
    "ast_types_kept": "ast-same",
    "ast_literal_values_dropped": "ast-differ",
    "ast_operator_dropped": "ast-differ",
    "ast_declaration_kind_dropped": "ast-differ",
    "ast_trailing_comma_recorded": "ast-same",
    "ast_parse_errors_accepted": "ast-refuses-unparseable",
    "ast_arrow_rule_dropped": "ast-agrees-with-v8",
    "ast_all_grouping_kept": "mirror-body",
    "ast_erased_only_grouping_kept": "paren-same",
    "ast_directive_paren_dropped": "paren-differ",
    "ast_naming_paren_dropped": "paren-agrees-with-runtime",
    "ast_naming_any_value": "paren-same",
    "ast_naming_value_unwrapped": "paren-differ",
    "ast_naming_class_missed": "paren-differ",
    "ast_naming_named_counted": "paren-same",
    "ast_directive_anywhere": "paren-same",
    "ast_prologue_first_only": "paren-differ",
    "ast_prologue_grouped_continues": "paren-same",
    "ast_prologue_method_missed": "paren-differ",
    "ast_prologue_erased_terminates": "paren-differ",
    "ast_prologue_leading_erased_terminates": "paren-same",
    "ast_prologue_interface_terminates": "paren-differ",
    "ast_prologue_erased_admits_rest": "paren-same",
    "ast_prologue_skips_executable": "paren-same",
    "ast_prologue_skips_grouped_string": "paren-same",
    "ast_type_alias_statement_kept": "allowed-type-erasure",
    "ast_optional_chain_flag_dropped": "paren-differ",
    "ast_erased_expression_kept": "allowed-type-erasure",
    "runtime_gate_dropped": "paren-agrees-with-runtime",
    "locator_return_true_unwrapped": "locators-through-types",
    "locator_callee_unwrapped": "locators-through-types",
    "locator_open_filter_unwrapped": "locators-through-types",
    "locator_select_by_offset": "locators-through-types",
    "digest_section_unwired": "digest-section-joined",
    "semantic_suppressing_value": "sam-riley-maybe",
    "semantic_suppress_path_shared": "sam-riley-both-insert",
    "semantic_suppress_path_ingest": "mirror-body",
    "semantic_suppress_path_ingest_probe": "probe-13-rows",
    "batch_dedup_off_shared": "exact-batch-e2e",
    "batch_dedup_off_shared_probe": "dedup-rows",
    "batch_dedup_off_ingest": "mirror-body",
    "batch_dedup_off_ingest_probe": "probe-13-rows",
    "exact_row_not_written_mcp_probe": "dedup-exact-batch",
    "exact_row_not_written_ingest_probe": "probe-13-exact-batch",
    "batch_set_not_updated": "exact-batch-e2e",
    "exact_row_not_written": "exact-batch-e2e",
    "exact_row_wrong_survivor": "exact-batch-e2e",
    "batch_before_gate_shared": "gate-before-batch",
    "batch_rows_not_recorded_ingest": "mirror-body",
    "semantic_not_proposed_shared": "casey-proposals",
    "semantic_not_proposed_shared_probe": "dedup-semantic",
    "semantic_not_proposed_ingest": "mirror-body",
    "semantic_not_proposed_ingest_probe": "probe-13-semantic",
    "candidates_after_insert_shared": "dedup-order",
    "semantic_newest_survivor": "casey-proposals",
    "semantic_threshold_exclusive": "threshold-inclusive",
    "semantic_min_tokens_off": "min-two-tokens",
    "semantic_longer_containment": "shorter-containment",
    "semantic_project_ignored": "project-scope",
    "semantic_null_project_excluded": "null-project-proposes",
    "semantic_same_thought_included": "same-thought-excluded",
    "record_no_retry": "deadlock-retry",
    "describe_order_swapped": "live-demo-wording",
    "constraint_env_dropped": "live-demo-wording",
    "dedup_digest_unwired": "dedup-digest-section-joined",
    "dedup_digest_wording_dropped": "dedup-digest-lines",
    "local_normalizer_ingest": "single-source-helpers",
    "normalizer_digits_module_ingest_probe": "probe-14-rows",
    "local_normalizer_shared": "single-source-helpers",
    "normalizer_digits_module_rest_probe": "numbered-rows",
    "local_mechanical_ingest": "single-source-helpers",
    "local_log_trunc_shared": "single-source-helpers",
    "unlisted_helper_diverges": "mirror-helper-inventory",
    "mcp_wrapper_other_mechanical": "mirror-helper-inventory",
    "enum_value_diverges": "mirror-helper-inventory",
    "namespace_value_diverges": "mirror-helper-inventory",
    "namespace_write_diverges": "mirror-helper-inventory",
    "module_exports_prefixes": "single-source-helpers",
    "module_top_level_write": "single-source-helpers",
    "ingest_namespace_import": "single-source-helpers",
}


def claim_tag(claim: str) -> str:
    return f"[claim:{claim}"


def copy_tree() -> str:
    d = tempfile.mkdtemp(prefix="obfg-ts.")
    dst = os.path.join(d, "repo")
    shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns(".git", "node_modules"))
    return dst


def remove_tree(tree: str) -> None:
    # A negative control may leave a file mode 000; restore write so rmtree works.
    for dirpath, _dirs, files in os.walk(tree):
        for f in files:
            try:
                os.chmod(os.path.join(dirpath, f), 0o644)
            except OSError:
                pass
    shutil.rmtree(os.path.dirname(tree), ignore_errors=True)


# The claim log is appended to a run's output after this marker, by this
# process, after the check has exited. The marker is random per sweep, so the
# code under test cannot print a convincing copy; the LAST occurrence is used.
CLAIM_LOG_MARK = f"=== OBFG CLAIM LOG {secrets.token_hex(12)} ==="
# A sentinel argument: run without --allow-write for the claim log (a negative
# control). Stripped before the command runs.
NO_CLAIM_WRITE = "--obfg-no-claim-write"


def run_args(args, cwd: str):
    """Run a check with a fresh claim log; returns (exit code, output + claim log)."""
    logdir = tempfile.mkdtemp(prefix="obfg-claims.")
    log = os.path.join(logdir, "claims.jsonl")
    args = list(args)
    writable = NO_CLAIM_WRITE not in args
    args = [a for a in args if a != NO_CLAIM_WRITE]
    if writable and len(args) >= 2 and args[0] == "deno" and args[1] in ("test", "run"):
        args = args[:2] + [f"--allow-write={log}"] + args[2:]
    env = dict(os.environ, NO_COLOR="1", OBFG_CLAIM_LOG=log)
    try:
        p = subprocess.run(args, cwd=cwd, env=env, capture_output=True, text=True, timeout=TIMEOUT)
        code, out = p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired:
        code, out = 124, "timeout"
    try:
        records = open(log, encoding="utf-8").read()
    except OSError:
        records = ""
    shutil.rmtree(logdir, ignore_errors=True)
    return code, f"{out}\n{CLAIM_LOG_MARK}\n{records}"


def run(check: str, cwd: str):
    return run_args(CHECKS[check], cwd)


def split_log(out: str):
    """(the check's own output, its claim records, or None when unreadable)."""
    k = out.rfind(CLAIM_LOG_MARK)
    if k < 0:
        return out, None
    body, raw = out[:k], out[k + len(CLAIM_LOG_MARK):]
    records = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except ValueError:
            return body, None
        if not isinstance(r, dict):
            return body, None
        records.append(r)
    return body, records


# Text that means the code under test never reached a behavioral assertion: a
# permission refusal (Deno 2 says NotCapable; older Deno PermissionDenied), a
# file that is not there, a module that did not load, an exception nothing
# caught, or the fragment-gate test's own setup marker (a prerequisite that
# does not hold throws "setup:", never an AssertionError).
INFRA_SIGNALS = (
    "NotCapable",
    "PermissionDenied",
    "Requires read access",
    "Requires net access",
    "Requires env access",
    "Requires write access",
    "NotFound",
    "No such file or directory",
    "Module not found",
    "error: Uncaught",
    "Error: setup:",
)

ERRORS_HEADER = re.compile(r"^ ERRORS $", re.M)
FAILURES_HEADER = re.compile(r"^ FAILURES $", re.M)
TEST_HEADER = re.compile(r"^(.+) => \./\S+:\d+:\d+$", re.M)
TAG = re.compile(r"\[claim:(\S+) ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]")


def test_error_block(out: str, name: str):
    """The text Deno printed under ERRORS for the test called `name`, or None."""
    m = ERRORS_HEADER.search(out)
    if m is None:
        return None
    section = out[m.end():]
    f = FAILURES_HEADER.search(section)
    if f is not None:
        section = section[:f.start()]
    headers = list(TEST_HEADER.finditer(section))
    for i, h in enumerate(headers):
        if h.group(1) == name:
            end = headers[i + 1].start() if i + 1 < len(headers) else len(section)
            return section[h.end():end]
    return None


def claim_record_ok(records, claim: str, uuid: str):
    """None when the log shows `claim` entered and then failed with `uuid`
    (adjacent records), else the reason it does not."""
    if records is None:
        return "no readable claim log"
    fails = [i for i, r in enumerate(records) if r.get("event") == "fail" and r.get("id") == claim and r.get("uuid") == uuid]
    if len(fails) != 1:
        return f"the claim log has {len(fails)} fail record(s) for {claim} with uuid {uuid}, not 1"
    i = fails[0]
    if i == 0 or records[i - 1] != {"event": "enter", "id": claim}:
        return f"the fail record for {claim} is not immediately preceded by its enter record"
    return None


def classify(check: str, expected: str, code: int, out: str, claim=None):
    """('CAUGHT' | 'SURVIVED' | 'NEVER-RAN', reason).

    `claim` is the mutant's CLAIMS id; without one no assertion can be
    certified and a failure is NEVER-RAN."""
    if code == 0:
        return "SURVIVED", "the check exited 0"
    if code != 1:
        return "NEVER-RAN", f"exit {code}, not 1"
    if claim is None:
        return "NEVER-RAN", "no claim configured, so no assertion can be certified"
    body, records = split_log(out)
    if check in TEST_FILE:
        if re.search(r"^" + re.escape(expected) + r" \.\.\. FAILED", body, re.M) is None:
            return "NEVER-RAN", f"the named test '{expected}' is not among the FAILED lines"
        block = test_error_block(body, expected)
        if block is None:
            return "NEVER-RAN", f"no ERRORS block for '{expected}'"
        first = next((l for l in block.splitlines() if l.strip()), "")
        if not first.startswith("error: AssertionError"):
            return "NEVER-RAN", f"the named test failed without a completed assertion: {first[:160]}"
        hit = next((sig for sig in INFRA_SIGNALS if sig in block), None)
        if hit is not None:
            return "NEVER-RAN", f"the named test's error carries the infrastructure signal '{hit}'"
        line = first
    else:
        marker = {"ingest": "INGEST PROBE FAILED: ", "mcp": "CLOSEOUT CAPTURE PROBE FAILED: "}[check]
        if PASSED_LINE[check] in body:
            return "NEVER-RAN", "the PASSED line is present with a nonzero exit"
        failed = [l for l in body.splitlines() if l.startswith(marker)]
        if len(failed) != 1 or not failed[0].startswith(marker + expected):
            return "NEVER-RAN", f"the harness did not fail on the named check '{expected}' (exactly one FAILED line)"
        hit = next((sig for sig in INFRA_SIGNALS if sig in body), None)
        if hit is not None:
            return "NEVER-RAN", f"the output carries the infrastructure signal '{hit}'"
        line = failed[0]
    tags = TAG.findall(line)
    if len(tags) != 1 or tags[0][0] != claim:
        return "NEVER-RAN", f"the failure does not carry exactly one tag of the claim {claim_tag(claim)} <uuid>]: {line[:160]}"
    why = claim_record_ok(records, claim, tags[0][1])
    if why is not None:
        return "NEVER-RAN", f"the failure carries the claim's tag but {why}"
    return "CAUGHT", f"{expected} {claim_tag(claim)} {tags[0][1]}] entered and failed"


def claim_config():
    files = sorted(set(TEST_FILE.values()) | set(HARNESS_FILE.values()))
    claims = []
    for name, (_rel, _old, _new, check, expected) in MUTANTS.items():
        claim = CLAIMS.get(name)
        if claim is None:
            claims.append({"file": TEST_FILE.get(check) or HARNESS_FILE[check], "id": f"<none configured for {name}>"})
        elif check in TEST_FILE:
            claims.append({"file": TEST_FILE[check], "id": claim, "test": expected})
        else:
            claims.append({"file": HARNESS_FILE[check], "id": claim})
    uniq = []
    for c in claims:
        if c not in uniq:
            uniq.append(c)
    return {"files": files, "claims": uniq}


def claim_audit(tree: str) -> bool:
    """Every mutant's claim names exactly one claim call site, and nothing else
    in the test and harness files can produce a claim record or tag (read with
    the TypeScript parser by claim-audit.ts)."""
    d = tempfile.mkdtemp(prefix="obfg-audit.")
    try:
        cfg = os.path.join(d, "claims.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump(claim_config(), f)
        code, out = run_args(["deno", "run", "--no-lock", "--allow-read", "--allow-env", "scripts/loop-closing/claim-audit.ts", os.path.abspath(tree), cfg], tree)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    body, _records = split_log(out)
    for line in body.strip().splitlines():
        print(line)
    good = code == 0 and "NOT OK" not in body and "CLAIM AUDIT" in body
    if not good:
        print(f"CLAIM AUDIT: exit {code}")
    return good


# Audit controls (Codex re-review 3, R4-1): the audit reads erased TypeScript
# syntax with the same policy as the comparison. A claim called through a type
# assertion with a parenthesized literal id is still one direct call site; a
# Deno file write behind a type assertion is still a file write.
# Codex re-review 5, R6-1 audit: an entry point named only inside a statement
# the key erases (an interface's heritage) or an `implements` clause never runs,
# so it is not a reference (inTypePosition uses isTypeOnlyStatement); a class's
# `extends` does run, so naming an entry point there is still refused.
# name: (replacement, should pass, the refusal text when it should not).
AUDIT_CONTROLS = {
    "audit_erased_callee_accepted": (
        "  (claim as typeof claim)((\"mirror-body\" as const), a, b, \"the two bodies' syntax trees differ\");\n", True, None),
    "audit_erased_deno_writer_refused": (
        "  (Deno as any).writeTextFileSync(\"/dev/null\", \"\");\n" + "  claim(\"mirror-body\", a, b, \"the two bodies' syntax trees differ\");\n", False,
        "calls Deno.writeTextFileSync"),
    "audit_erased_statement_reference_accepted": (
        "  interface ClaimShape extends claim {}\n  class ClaimProbe implements claim {}\n" + "  claim(\"mirror-body\", a, b, \"the two bodies' syntax trees differ\");\n", True, None),
    "audit_runtime_heritage_refused": (
        "  class ClaimProbe extends claim {}\n" + "  claim(\"mirror-body\", a, b, \"the two bodies' syntax trees differ\");\n", False,
        "uses claim other than as a callee"),
}


def audit_controls() -> bool:
    ok = True
    for name, (replacement, should_pass, refusal) in AUDIT_CONTROLS.items():
        tree = copy_tree()
        try:
            replace_once(FGT, MIRROR_CLAIM, replacement)(tree)
            d = tempfile.mkdtemp(prefix="obfg-audit.")
            try:
                cfg = os.path.join(d, "claims.json")
                with open(cfg, "w", encoding="utf-8") as f:
                    json.dump(claim_config(), f)
                code, out = run_args(["deno", "run", "--no-lock", "--allow-read", "--allow-env", "scripts/loop-closing/claim-audit.ts", os.path.abspath(tree), cfg], tree)
            finally:
                shutil.rmtree(d, ignore_errors=True)
            body, _records = split_log(out)
            passed = code == 0 and "NOT OK" not in body and "CLAIM AUDIT" in body
            refused = code == 1 and "NOT OK" in body and refusal is not None and refusal in body
            good = passed if should_pass else refused
            print(f"AUDIT CONTROL {name}: exit {code} {'ok' if good else 'NOT OK'}")
            ok = ok and good
        finally:
            remove_tree(tree)
    return ok


def apply_edits(tree: str, edits):
    """Apply each (file, old, new) in order; None on success, else the reason."""
    for rel, old, new in edits:
        path = os.path.join(tree, rel)
        src = open(path, encoding="utf-8").read()
        if src.count(old) != 1:
            return f"the replacement matched {src.count(old)} times in {rel}, not once"
        open(path, "w", encoding="utf-8").write(src.replace(old, new))
    return None


def mutant_edits(name: str):
    rel, old, new, _check, _expected = MUTANTS[name]
    return rel if isinstance(rel, list) else [(rel, old, new)]


def apply_mutant(tree: str, name: str):
    """Apply mutant `name` in `tree`; None on success, else the reason it could not be applied."""
    return apply_edits(tree, mutant_edits(name))


def without(flag: str):
    return lambda args: [a for a in args if a != flag]


def no_claim_write(args):
    return list(args) + [NO_CLAIM_WRITE]


def delete(rel: str):
    return lambda tree: os.remove(os.path.join(tree, rel))


def unreadable(rel: str):
    return lambda tree: os.chmod(os.path.join(tree, rel), 0)


def replace_once(rel: str, old: str, new: str):
    def go(tree: str):
        path = os.path.join(tree, rel)
        src = open(path, encoding="utf-8").read()
        if src.count(old) != 1:
            raise RuntimeError(f"negative-control fault matched {src.count(old)} times in {rel}")
        open(path, "w", encoding="utf-8").write(src.replace(old, new))
    return go


IH = "scripts/loop-closing/ingest-probe-harness.ts"
FGT = "supabase/functions/_shared/fragment-gate.test.ts"
MVT = "supabase/functions/_shared/metadata-validation.test.ts"
MIRROR_CLAIM = '  claim("mirror-body", a, b, "the two bodies\' syntax trees differ");\n'

# name: (mutant, args transform or None, tree fault or None, what it stops).
# Each mutant is one the sweep CATCHES when nothing else is wrong; the fault
# stops the claimed assertion from executing (or from being the failure), so
# the verdict must be NEVER-RAN.
NEGATIVE_CONTROLS = {
    "nc_fg_without_allow_read": ("gate_removed_ingest", without("--allow-read"), None,
        "the mirror test cannot read either source file (Codex review 1, F1)"),
    "nc_fg_source_missing": ("gate_removed_ingest", None, delete(IT),
        "the ingest source the mirror test reads is not there"),
    "nc_fg_source_unreadable": ("gate_removed_ingest", None, unreadable(IT),
        "the ingest source the mirror test reads is mode 000"),
    "nc_fg_locator_misses": ("gate_removed_ingest", None,
        replace_once(IT, "async function extractAndStoreActionItems(", "async function extractAndStoreActionItemsRenamed("),
        "the parser finds no ingest function of that name, so the comparison never runs"),
    "nc_dg_without_allow_read": ("digest_section_unwired", without("--allow-read"), None,
        "the digest wiring test cannot read brain-digest/index.ts"),
    "nc_mv_module_missing": ("rule_b_deleted", None, delete(FG),
        "metadata-validation.test.ts cannot load (fragment-gate.ts deleted)"),
    # Task 5.2: the dedup test cannot load its module; the digest wiring test
    # cannot read the digest source; a dedup probe's HTTP check fails first.
    "nc_dd_module_missing": ("semantic_suppressing_value", None, delete(DD),
        "dedup.test.ts cannot load (dedup.ts deleted)"),
    "nc_dgd_without_allow_read": ("dedup_digest_unwired", without("--allow-read"), None,
        "the dedup digest wiring test cannot read brain-digest/index.ts"),
    "nc_ingest_probe13_other_assertion": ("batch_dedup_off_ingest_probe", None,
        replace_once(IH, '=== 200, "probe 13 HTTP");', '=== 299, "probe 13 HTTP");'),
        "probe 13's HTTP assertion fails first, so its exact_batch claim never runs"),
    "nc_ingest_without_allow_net": ("gate_removed_ingest_probe", without("--allow-net"), None,
        "the ingest handler cannot start its server, so no probe runs"),
    "nc_ingest_other_assertion": ("gate_removed_ingest_probe", None,
        replace_once(IH, '=== 200, "probe 10 HTTP");', '=== 299, "probe 10 HTTP");'),
        "probe 10's HTTP assertion fails first, so its action_items claim never runs"),
    # An untagged AssertionError raised inside the named test before the
    # claimed comparison.
    "nc_fg_untagged_prerequisite": ("gate_removed_ingest", None,
        replace_once(FGT, "function sharedKey(fn: ts.FunctionDeclaration): string[] {\n",
            "function sharedKey(fn: ts.FunctionDeclaration): string[] {\n  assertEquals(fn.parameters.length, -1, \"negative control: an untagged prerequisite assertion\");\n"),
        "an untagged assertion in the shared-key helper fails before the mirror claim runs"),
    "nc_mv_untagged_earlier_assertion": ("stored_normalized", None,
        replace_once(MVT, 'await extractAndStoreActionItems(db, FRAG_THOUGHT, TASK_META(PLAN_ITEMS), "a note with eight items", isMechanicalForTest);\n',
            'await extractAndStoreActionItems(db, FRAG_THOUGHT, TASK_META(PLAN_ITEMS), "a note with eight items", isMechanicalForTest);\n  assertEquals(inserted.length, -1, "negative control: an untagged assertion");\n'),
        "an untagged assertion fails before the e2e-stored claim runs"),
    # Another claim of the same test fails first: the shared prompt also loses
    # the rule, so prompt-rule-once fails before prompt-single-source.
    "nc_fg_other_claim_first": ("prompt_rule_missing_ingest", None,
        replace_once(CP, RULE_LINE, ""),
        "the test's prompt-rule-once claim fails first, so the claimed prompt-single-source never runs"),
    # Codex re-review 2, N1 (claim-sweep.py mode `helper`), on this head: one
    # message variable carrying the claim's tag reaches a helper assertion and
    # the claim; the helper fails first.
    "nc_fg_helper_shared_message": ("gate_removed_ingest", None,
        replace_once(FGT, MIRROR_CLAIM,
            "  const message = \"[claim:mirror-body] the two bodies' syntax trees differ\";\n"
            "  const checkFixture = (actual: string[], expected: string[], msg: string) => {\n"
            "    assertEquals(actual.length, expected.length, msg);\n"
            "  };\n"
            "  checkFixture(a, b, message);\n" + MIRROR_CLAIM),
        "a helper assertion sharing the claim's tagged message fails before the claim is entered (Codex re-review 2, N1)"),
    # Codex re-review 2 (claim-sweep.py mode `fake`): a plain Error named
    # AssertionError with the tagged message, thrown while the claim's
    # arguments are evaluated.
    "nc_fg_fake_assertion_error": ("gate_removed_ingest", None,
        replace_once(FGT, MIRROR_CLAIM,
            "  const message = \"[claim:mirror-body] the two bodies' syntax trees differ\";\n"
            "  const compareInput = () => {\n"
            "    if (a.length !== b.length) {\n"
            "      const error = new Error(message); error.name = \"AssertionError\"; throw error;\n"
            "    }\n"
            "    return a;\n"
            "  };\n"
            "  claim(\"mirror-body\", compareInput(), b, message);\n"),
        "a fake AssertionError thrown while the claim's arguments are evaluated (Codex re-review 2, 26-fake)"),
    # A forged tag WITH a well-formed uuid, thrown before the claim: only the
    # claim log (no fail record with that uuid) tells it apart.
    "nc_fg_forged_uuid_tag": ("gate_removed_ingest", None,
        replace_once(FGT, MIRROR_CLAIM,
            "  if (a.length !== b.length) {\n"
            "    const forged = new Error([\"[claim:mirror-body\", \"00000000-0000-4000-8000-000000000000]\", \"forged\"].join(\" \"));\n"
            "    forged.name = \"AssertionError\";\n"
            "    throw forged;\n"
            "  }\n" + MIRROR_CLAIM),
        "a forged tag with a well-formed uuid, thrown before the claim is entered"),
    # Codex re-review 2 (28-probe), on this head: a direct fail() whose message
    # starts with the probe's label, before the claimed probe check runs.
    "nc_ingest_direct_fail_label": ("gate_removed_ingest_probe", None,
        replace_once(IH, 'const items10 = inserts("action_items");\n',
            'const items10 = inserts("action_items");\nfail(["probe 10", "action_items rows fixture unavailable"].join(" "));\n'),
        "a direct fail() carrying the probe's label, before its claim runs (Codex re-review 2, 28-probe)"),
    # The claim cannot write its record: the claimed assertion's failure is
    # never certifiable.
    # Codex re-review 1 of PR 33, F2: the ingest enum also declared a second
    # time (declaration merging), a reached binding the inventory refuses as a
    # setup error, so its claim never runs.
    "nc_fg_enum_merged_refused": ("enum_value_diverges", None,
        replace_once(IT, POLICY_DECL("enum", "a-y"), POLICY_DECL("enum", "a-y") + 'enum NormalizationPolicy { Extra = "reviewer" }\n'),
        "the ingest enum is declared twice, which the inventory refuses as a setup error before its claim runs"),
    "nc_fg_claim_log_unwritable": ("gate_removed_ingest", no_claim_write, None,
        "the check runs without write access to the claim log, so the claim cannot record its entry"),
}


def claims_for(check: str):
    return sorted({CLAIMS[n] for n, m in MUTANTS.items() if m[3] == check and n in CLAIMS})


def control(cwd: str) -> bool:
    ok = True
    for name in CHECKS:
        code, out = run(name, cwd)
        body, records = split_log(out)
        good = code == 0 and (name not in PASSED_LINE or PASSED_LINE[name] in body)
        # Every claim configured for this check ran and held: none is dead code.
        dead = []
        for c in claims_for(name):
            mine = [r for r in (records or []) if r.get("id") == c]
            events = {r.get("event") for r in mine}
            if records is None or "enter" not in events or "pass" not in events or "fail" in events:
                dead.append(c)
        if dead:
            good = False
        last = body.strip().splitlines()[-1][:160] if body.strip() else ""
        print(f"CONTROL {name}: exit {code}, {len(claims_for(name))} claim(s) entered and passed {'ok' if good else 'NOT OK: ' + (('claims not entered and passed: ' + ', '.join(dead)) if dead else last)}")
        ok = ok and good
    return ok


def allowed_controls() -> bool:
    ok = True
    for name, (edits, check) in ALLOWED.items():
        tree = copy_tree()
        try:
            if edits == DENO_FMT:
                code, out = run_args(["deno", "fmt", IT], tree)
                before = open(os.path.join(ROOT, IT), encoding="utf-8").read()
                after = open(os.path.join(tree, IT), encoding="utf-8").read()
                if code != 0 or before == after:
                    print(f"ALLOWED {name}: NOT OK: deno fmt exit {code}, changed the file: {before != after}")
                    ok = False
                    continue
            else:
                reason = apply_edits(tree, edits)
                if reason is not None:
                    print(f"ALLOWED {name}: NOT OK: {reason}")
                    ok = False
                    continue
            code, out = run(check, tree)
            good = code == 0
            print(f"ALLOWED {name} ({check}): exit {code} {'ok' if good else 'NOT OK: a permitted change fails the suite'}")
            ok = ok and good
        finally:
            remove_tree(tree)
    return ok


def negative_controls() -> bool:
    ok = True
    for nc, (mutant, transform, fault, what) in NEGATIVE_CONTROLS.items():
        _rel, _old, _new, check, expected = MUTANTS[mutant]
        tree = copy_tree()
        try:
            reason = apply_mutant(tree, mutant)
            if reason is not None:
                print(f"NEGATIVE CONTROL {nc}: could not apply {mutant}: {reason}")
                ok = False
                continue
            if fault is not None:
                fault(tree)
            args = transform(CHECKS[check]) if transform else CHECKS[check]
            code, out = run_args(args, tree)
            verdict, why = classify(check, expected, code, out, CLAIMS.get(mutant))
            good = verdict == "NEVER-RAN"
            print(f"NEGATIVE CONTROL {nc} ({mutant}, {check}): {verdict} {'ok' if good else 'NOT OK'}: {what}; {why}")
            ok = ok and good
        finally:
            remove_tree(tree)
    return ok


def main() -> int:
    names = sys.argv[1:] or list(MUTANTS)
    for n in names:
        if n not in MUTANTS:
            print(f"NEVER-RAN: unknown mutant {n}")
            return 2
    base = copy_tree()
    try:
        if not control(base):
            print("NEVER-RAN: a check does not pass on the unmutated tree, or a claim is never entered, so no mutant can be judged")
            return 2
        if not claim_audit(base):
            print("NEVER-RAN: a claim is not bound to exactly one call site, or a claim record or tag can be produced elsewhere, so no mutant can be certified")
            return 2
        if not audit_controls():
            print("NEVER-RAN: the claim audit does not read erased TypeScript syntax as the comparison does")
            return 2
    finally:
        remove_tree(base)
    if not allowed_controls():
        print("NEVER-RAN: a change the mirror rule allows fails a check (a false FAIL), so no mutant can be judged")
        return 2
    if not negative_controls():
        print("NEVER-RAN: a negative control did not end NEVER-RAN, so the classifier cannot be trusted")
        return 2
    caught = survived = never = 0
    for n in names:
        _rel, _old, _new, check, expected = MUTANTS[n]
        tree = copy_tree()
        try:
            reason = apply_mutant(tree, n)
            if reason is not None:
                print(f"NEVER-RAN {n}: {reason}")
                never += 1
                continue
            code, out = run(check, tree)
            verdict, why = classify(check, expected, code, out, CLAIMS.get(n))
            if verdict == "CAUGHT":
                print(f"CAUGHT    {n} ({check}): {why}")
                caught += 1
            elif verdict == "SURVIVED":
                print(f"SURVIVED  {n} ({check})")
                survived += 1
            else:
                print(f"NEVER-RAN {n} ({check}, exit {code}): {why}")
                never += 1
        finally:
            remove_tree(tree)
    print(f"SWEEP: {len(names)} mutants, {caught} caught, {survived} survived, {never} never ran")
    if never:
        return 2
    if survived:
        return 1
    print(f"ALL {len(names)} MUTANTS CAUGHT")
    return 0


if __name__ == "__main__":
    sys.exit(main())
