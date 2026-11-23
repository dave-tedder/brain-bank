// Runtime-bound assertion claims for scripts/loop-closing/fragment-gate-ts-mutants.py
// (Codex re-review 2, N1).
//
// The mutant sweep certifies a catch only for ONE assertion: the one a mutant is
// claimed against. Correction 2 identified that assertion by a "[claim:<id>]"
// string in its message, written once in the source. A string is not an
// assertion: one message variable can reach a helper's assertion and the
// claimed one, and the helper's failure carried the tag (Codex's `helper`
// fault). So the claim is now bound at RUNTIME:
//
//   - `claim(id, actual, expected, note)` (deno tests) and
//     `claimVerdict(id, check)` (probe harnesses) are the only code that
//     produces a claim record or a claim tag. The audit (claim-audit.ts)
//     checks every call site passes its id as a string literal, each id has
//     exactly one call site, a deno-test claim sits inside the named
//     Deno.test, and no test or harness file writes files, names the log
//     variable or contains "[claim:" in a literal.
//   - On entry, before its own comparison, a claim appends {"event":"enter"} to
//     the log the sweep names in OBFG_CLAIM_LOG. If ITS comparison fails it
//     appends {"event":"fail", "uuid"} with a fresh random uuid and puts
//     "[claim:<id> <uuid>]" on the first line of the failure it raises.
//   - The sweep counts CAUGHT only when the named test's (or probe's) failure
//     carries that tag AND the log holds the claim's "enter" immediately
//     followed by its "fail" with the same uuid. A helper, a fake error, a
//     prerequisite or a direct fail() never enters the claim, so it cannot
//     produce the record, and cannot know the uuid.
//
// Without OBFG_CLAIM_LOG (an ordinary test run) nothing is written. With it, a
// write that fails (no --allow-write for the log) throws, so the run cannot be
// certified: NEVER-RAN, never a silent pass.
import { AssertionError, assertEquals, equal } from "jsr:@std/assert@1.0.19";

const LOG_VAR = "OBFG_CLAIM_LOG";

function logPath(): string | undefined {
  // An ordinary run may not grant env access at all; that is not an error.
  if (Deno.permissions.querySync({ name: "env", variable: LOG_VAR }).state !== "granted") return undefined;
  return Deno.env.get(LOG_VAR) || undefined;
}

function record(entry: Record<string, string>): void {
  const path = logPath();
  if (path !== undefined) Deno.writeTextFileSync(path, JSON.stringify(entry) + "\n", { append: true });
}

function conclude(id: string, ok: boolean): string | null {
  if (ok) {
    record({ event: "pass", id });
    return null;
  }
  const uuid = crypto.randomUUID();
  record({ event: "fail", id, uuid });
  return `[claim:${id} ${uuid}]`;
}

// For the probe harnesses, whose failures are a FAILED line, not an exception.
// Records the entry, THEN evaluates the claimed check; returns null when it
// holds, else the tag the caller puts on its FAILED line. A check that throws
// leaves an "enter" with no verdict: not certifiable.
export function claimVerdict(id: string, check: () => boolean): string | null {
  record({ event: "enter", id });
  return conclude(id, check() === true);
}

// assertEquals with a runtime-bound claim: records the entry, then compares.
// The failure is an AssertionError whose FIRST line carries the tag; the diff
// follows on later lines.
export function claim(id: string, actual: unknown, expected: unknown, note = ""): void {
  record({ event: "enter", id });
  const tag = conclude(id, equal(actual, expected));
  if (tag === null) return;
  let diff = "";
  try {
    assertEquals(actual, expected);
  } catch (e) {
    diff = e instanceof Error ? e.message : String(e);
  }
  throw new AssertionError(`${tag} ${note.replace(/\s+/g, " ")}\n${diff}`);
}
