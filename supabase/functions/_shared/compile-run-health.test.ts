import {
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CompilePagesRun,
  getCompileRunHealthWarning,
} from "./compile-run-health.ts";

const now = Date.parse("2026-06-13T10:00:00Z");

function run(
  overrides: Partial<CompilePagesRun> = {},
): CompilePagesRun {
  return {
    created_at: "2026-06-13T09:46:00Z",
    mode: "compile",
    index_mode: "auto",
    batch: 10,
    compiled: 8,
    errors: 0,
    status: "complete",
    error_message: null,
    ...overrides,
  };
}

Deno.test("healthy full compile adds no digest warning", () => {
  assertEquals(getCompileRunHealthWarning([run()], now), null);
});

Deno.test("newer maintenance run does not mask a degraded full compile", () => {
  const warning = getCompileRunHealthWarning([
    run({
      created_at: "2026-06-13T09:55:00Z",
      batch: 1,
      index_mode: "skip",
    }),
    run({ errors: 2, compiled: 6 }),
  ], now);

  assertMatch(warning || "", /degraded.*2 page/i);
});

Deno.test("errored full compile reports failure", () => {
  const warning = getCompileRunHealthWarning([
    run({ status: "errored", error_message: "upstream unavailable" }),
  ], now);

  assertMatch(warning || "", /failed.*upstream unavailable/i);
});

Deno.test("missing and stale full compiles report clearly", () => {
  assertMatch(getCompileRunHealthWarning([], now) || "", /no recent full compile run/i);
  assertMatch(
    getCompileRunHealthWarning([
      run({ created_at: "2026-06-12T07:00:00Z" }),
    ], now) || "",
    /stale.*27 hours/i,
  );
});
