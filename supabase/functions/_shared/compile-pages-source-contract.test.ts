import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const compilePagesSource = await Deno.readTextFile(
  new URL("../compile-pages/index.ts", import.meta.url),
);

Deno.test("scheduled compile runs avoid five simultaneous slow synthesis calls", () => {
  assert(compilePagesSource.includes("COMPILE_CONCURRENCY = 3"));
  assert(!compilePagesSource.includes("COMPILE_CONCURRENCY = 5"));
});
