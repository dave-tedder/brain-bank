import { assert, assertEquals } from "jsr:@std/assert";

const source = await Deno.readTextFile(
  new URL("../supabase/functions/compile-pages/index.ts", import.meta.url),
);

Deno.test("wiki auto-create excludes Gmail captures", () => {
  const autoCreateStart = source.indexOf("async function autoCreatePages");
  const lintStart = source.indexOf("interface LintResult");
  const autoCreateSource = source.slice(autoCreateStart, lintStart);

  assert(autoCreateStart >= 0);
  assert(lintStart > autoCreateStart);
  assertEquals(
    (autoCreateSource.match(/if \(m\.source === "gmail"\) continue;/g) ?? []).length,
    1,
  );
});

Deno.test("curated contradiction-lint scope remains wired", () => {
  assert(source.includes("selectContradictionLintPages"));
  assert(source.includes("curatedProjectSlugs"));
  assert(source.includes("const contradictionPages = selectContradictionLintPages"));
});
