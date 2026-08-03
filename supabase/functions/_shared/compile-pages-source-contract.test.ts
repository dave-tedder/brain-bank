import { assert } from "jsr:@std/assert@1.0.19";

const compilePagesSource = await Deno.readTextFile(
  new URL("../compile-pages/index.ts", import.meta.url),
);

Deno.test("scheduled compile runs avoid five simultaneous slow synthesis calls", () => {
  assert(compilePagesSource.includes("COMPILE_CONCURRENCY = 3"));
  assert(!compilePagesSource.includes("COMPILE_CONCURRENCY = 5"));
});
