// Capture helpers both capture paths use: the action-item text normalizer, the
// mechanical-capture test and the log truncation length.
//
// Single source since loop-closing Task 5.2. Until then ingest-thought/index.ts, open-brain-mcp/index.ts and
// _shared/capture-pipeline.ts each carried its own byte-identical copy, kept
// equal by the mirror rule in AGENTS.md and by a test that compared the copies.
// The comparison kept missing new ways for two copies to differ at run time, so
// the copies were removed: every capture file imports these, and
// supabase/functions/_shared/fragment-gate.test.ts fails if one of them
// declares its own again.
//
// Close to a leaf module on purpose: its one import is the profile loader, for
// the operator's own bridge prefixes, so importing it adds nothing else to a
// function's module graph. The prefix list is module-private: what a capture
// file can import is two functions and a number, none of which it can change.

import { loadProfile } from "./profile.ts";

// Action-item text as the exact dedups compare it.
export function normalizeActionText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ")
    .trim();
}

// Content starting with any of these prefixes is a mechanical/informational capture
// (calendar sync, notion sync, email thread, weekly review, trend analysis, Meta DM
// failure report). These captures describe STATE or EVENTS, not completion of action
// items, so auto-resolve is unsafe — they carry topic/person metadata that scope-
// matches real action items but aren't evidence of anything being done. Completion
// signals from these sources must come through a manual `done:` command or a
// dedicated session-log thought, not this path. Adding a pattern here means
// "this source never resolves action items."
// Structural prefixes are universal (every operator has these sync sources).
// Operator-specific bridge prefixes come from profile.json (see
// `profile.example.json` at the repo root, copied to
// `supabase/functions/_shared/profile.json` during setup).
const MECHANICAL_CAPTURE_PREFIXES = [
  "[Calendar Sync]",
  "[Notion Sync]",
  "[Meta DM Scan]",
  "[Weekly Review]",
  "Email thread:",
  "Meta DM Scan failed",
  ...loadProfile().mechanical_capture_prefixes,
  // Closeout-controller bookkeeping records (apply batch, operator-resolution
  // sweep, run summary). Mirror of CLOSEOUT_CAPTURE_PREFIX in
  // scripts/open-engine/closeout-controller.mjs. Stored, never extracted,
  // never a completion signal, operator-marker lines included (one such
  // capture once auto-resolved the open design item its own card said was the
  // operator's).
  "[Open Engine Closeout]",
];

export function isMechanicalCapture(content: string): boolean {
  const head = content.trimStart();
  return MECHANICAL_CAPTURE_PREFIXES.some((p) => head.startsWith(p));
}

// Truncation length for capture-path log lines.
export const LOG_TRUNC = 200;
