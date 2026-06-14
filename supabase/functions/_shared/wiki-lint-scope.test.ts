import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  selectContradictionLintPages,
} from "./wiki-lint-scope.ts";

const pages = [
  { slug: "client/jane-doe", page_type: "client" },
  { slug: "project/open-brain", page_type: "project" },
  { slug: "project/uncurated-topic-project", page_type: "project" },
  { slug: "topic/marketing", page_type: "topic" },
  { slug: "index/wiki", page_type: "index" },
];

Deno.test("contradiction lint keeps clients and curated projects only", () => {
  const selected = selectContradictionLintPages(
    pages,
    new Set(["open-brain"]),
  );

  assertEquals(
    selected.map((page) => page.slug),
    ["client/jane-doe", "project/open-brain"],
  );
});
