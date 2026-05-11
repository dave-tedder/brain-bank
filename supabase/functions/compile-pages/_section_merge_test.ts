import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import {
  applyEdits,
  parseEditsXml,
  parsePageSections,
  type SectionEdit,
  serializePage,
} from "./_section_merge.ts";

Deno.test("parsePageSections: empty input", () => {
  const sections = parsePageSections("");
  assertEquals(sections.size, 1);
  assertEquals(sections.get(""), "");
});

Deno.test("parsePageSections: preamble only, no headers", () => {
  const sections = parsePageSections("just a preamble\nno headers here\n");
  assertEquals(sections.size, 1);
  assertEquals(sections.get(""), "just a preamble\nno headers here\n");
});

Deno.test("parsePageSections: single section, no preamble", () => {
  const sections = parsePageSections("## Status\nactive\n");
  assertEquals(sections.size, 2);
  assertEquals(sections.get(""), "");
  assertEquals(sections.get("Status"), "active\n");
});

Deno.test("parsePageSections: preamble + multiple sections", () => {
  const input = "intro line\n\n## A\nA body\n\n## B\nB body\n";
  const sections = parsePageSections(input);
  assertEquals(sections.size, 3);
  assertEquals(sections.get(""), "intro line\n\n");
  assertEquals(sections.get("A"), "A body\n\n");
  assertEquals(sections.get("B"), "B body\n");
});

Deno.test("parsePageSections: ignores H3 and deeper", () => {
  const input = "## A\n### Subsection\nstill A body\n\n## B\nB body\n";
  const sections = parsePageSections(input);
  assertEquals(sections.size, 3);
  assertEquals(sections.get("A"), "### Subsection\nstill A body\n\n");
  assertEquals(sections.get("B"), "B body\n");
});

Deno.test("parsePageSections: H2 not at start of line is body, not header", () => {
  const input = "## A\nthis line ## not-a-header keeps as body\n";
  const sections = parsePageSections(input);
  assertEquals(sections.size, 2);
  assertEquals(sections.get("A"), "this line ## not-a-header keeps as body\n");
});

Deno.test("serializePage: round-trip of preamble + sections", () => {
  const input = "intro\n\n## A\nA body\n\n## B\nB body\n";
  const out = serializePage(parsePageSections(input));
  assertEquals(out, input);
});

Deno.test("serializePage: round-trip of section without trailing newline at EOF", () => {
  const input = "## A\nA body";
  const out = serializePage(parsePageSections(input));
  // Body is normalized to end with \n so the next section (if any) would parse.
  assertEquals(out, "## A\nA body\n");
});

Deno.test("serializePage: empty body produces bare header", () => {
  const sections = new Map([["", ""], ["Empty", ""]]);
  assertEquals(serializePage(sections), "## Empty\n");
});

Deno.test("parseEditsXml: empty input returns empty array", () => {
  assertEquals(parseEditsXml(""), []);
  assertEquals(parseEditsXml("<edits></edits>"), []);
});

Deno.test("parseEditsXml: single update with CDATA", () => {
  const xml = `<edits>
<section name="Status" action="update"><![CDATA[active and shipped]]></section>
</edits>`;
  const edits = parseEditsXml(xml);
  assertEquals(edits.length, 1);
  assertEquals(edits[0], {
    name: "Status",
    action: "update",
    content: "active and shipped",
  });
});

Deno.test("parseEditsXml: multiple actions in one block", () => {
  const xml = `<edits>
<section name="Status" action="update"><![CDATA[shipped]]></section>
<section name="Sessions" action="append"><![CDATA[
- 2026-05-11 — D1 landed
]]></section>
<section name="Open Questions" action="prepend"><![CDATA[Q1 ]]></section>
<section name="New Section" action="create"><![CDATA[fresh content]]></section>
</edits>`;
  const edits = parseEditsXml(xml);
  assertEquals(edits.length, 4);
  assertEquals(edits[0].action, "update");
  assertEquals(edits[1].action, "append");
  assertEquals(edits[2].action, "prepend");
  assertEquals(edits[3].action, "create");
  assertEquals(edits[1].content, "\n- 2026-05-11 — D1 landed\n");
});

Deno.test("parseEditsXml: works without <edits> wrapper", () => {
  const xml = `<section name="A" action="update"><![CDATA[x]]></section>`;
  const edits = parseEditsXml(xml);
  assertEquals(edits.length, 1);
  assertEquals(edits[0].name, "A");
});

Deno.test("parseEditsXml: section content without CDATA wrapper passes through raw", () => {
  const xml = `<edits><section name="A" action="update">raw content</section></edits>`;
  const edits = parseEditsXml(xml);
  assertEquals(edits.length, 1);
  assertEquals(edits[0].content, "raw content");
});

Deno.test("parseEditsXml: skips section with empty name", () => {
  // Regex requires at least one char in name, so this just won't match.
  const xml = `<edits><section name="" action="update"><![CDATA[x]]></section></edits>`;
  assertEquals(parseEditsXml(xml), []);
});

Deno.test("parseEditsXml: ignores malformed action attribute", () => {
  const xml = `<edits><section name="A" action="bogus"><![CDATA[x]]></section></edits>`;
  assertEquals(parseEditsXml(xml), []);
});

Deno.test("applyEdits: update existing section", () => {
  const existing = "## A\nold A\n\n## B\nold B\n";
  const edits: SectionEdit[] = [{ name: "A", action: "update", content: "new A\n" }];
  assertEquals(applyEdits(existing, edits), "## A\nnew A\n## B\nold B\n");
});

Deno.test("applyEdits: append to existing section", () => {
  const existing = "## Sessions\n- entry 1\n";
  const edits: SectionEdit[] = [
    { name: "Sessions", action: "append", content: "- entry 2\n" },
  ];
  assertEquals(applyEdits(existing, edits), "## Sessions\n- entry 1\n- entry 2\n");
});

Deno.test("applyEdits: prepend to existing section", () => {
  const existing = "## Recent Activity\nolder entry\n";
  const edits: SectionEdit[] = [
    { name: "Recent Activity", action: "prepend", content: "newest entry\n" },
  ];
  assertEquals(applyEdits(existing, edits), "## Recent Activity\nnewest entry\nolder entry\n");
});

Deno.test("applyEdits: create new section at end", () => {
  const existing = "preamble\n\n## A\nA body\n";
  const edits: SectionEdit[] = [
    { name: "B", action: "create", content: "B body\n" },
  ];
  assertEquals(
    applyEdits(existing, edits),
    "preamble\n\n## A\nA body\n## B\nB body\n",
  );
});

Deno.test("applyEdits: update on unknown section behaves like create", () => {
  const existing = "## A\nA body\n";
  const edits: SectionEdit[] = [
    { name: "Z", action: "update", content: "Z body\n" },
  ];
  assertEquals(applyEdits(existing, edits), "## A\nA body\n## Z\nZ body\n");
});

Deno.test("applyEdits: prepend/append on unknown section silently creates", () => {
  const existing = "## A\nA body\n";
  const out = applyEdits(existing, [
    { name: "B", action: "append", content: "B body\n" },
    { name: "C", action: "prepend", content: "C body\n" },
  ]);
  assertEquals(out, "## A\nA body\n## B\nB body\n## C\nC body\n");
});

Deno.test("applyEdits: preserves preamble verbatim", () => {
  const existing = "PAGE TITLE\n\nA paragraph.\n\n## A\nA body\n";
  const edits: SectionEdit[] = [{ name: "A", action: "update", content: "new A\n" }];
  const out = applyEdits(existing, edits);
  assertEquals(out, "PAGE TITLE\n\nA paragraph.\n\n## A\nnew A\n");
});

Deno.test("applyEdits: empty edits array returns input round-tripped", () => {
  const existing = "## A\nA body\n\n## B\nB body\n";
  // Round-trip equals input.
  assertEquals(applyEdits(existing, []), existing);
});

Deno.test("applyEdits: edits applied in order (later wins on same section)", () => {
  const existing = "## A\nv1\n";
  const out = applyEdits(existing, [
    { name: "A", action: "update", content: "v2\n" },
    { name: "A", action: "append", content: "v3\n" },
  ]);
  assertEquals(out, "## A\nv2\nv3\n");
});

Deno.test("applyEdits: ignores edit targeting preamble", () => {
  const existing = "preamble\n\n## A\nA body\n";
  const edits: SectionEdit[] = [
    { name: "", action: "update", content: "hijacked\n" },
  ];
  assertEquals(applyEdits(existing, edits), existing);
});

Deno.test("end-to-end: parse XML, apply to existing page, serialize", () => {
  const existing = `# project/open-brain

A short page summary.

## Status
in progress

## Recent Activity
- 2026-05-10 — Bundle C landed
`;
  const xml = `<edits>
<section name="Status" action="update"><![CDATA[active — D1 landed]]></section>
<section name="Recent Activity" action="prepend"><![CDATA[- 2026-05-11 — D1 ports landed
]]></section>
<section name="Decisions" action="create"><![CDATA[- structured-edit synthesis (2026-05-11)
]]></section>
</edits>`;
  const out = applyEdits(existing, parseEditsXml(xml));
  const expected = `# project/open-brain

A short page summary.

## Status
active — D1 landed
## Recent Activity
- 2026-05-11 — D1 ports landed
- 2026-05-10 — Bundle C landed
## Decisions
- structured-edit synthesis (2026-05-11)
`;
  assertEquals(out, expected);
});
