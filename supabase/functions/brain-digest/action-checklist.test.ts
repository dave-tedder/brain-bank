import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderOpenActionChecklist } from "./action-checklist.ts";

Deno.test("renderOpenActionChecklist: renders exact row descriptions and ids", () => {
  const md = renderOpenActionChecklist([
    {
      id: "action-1",
      description: "Confirm Jane Doe appointment time",
      created_at: "2026-06-18T12:00:00Z",
    },
    {
      id: "action-2",
      description: "Send Sam Smith the bookkeeping export",
      created_at: "2026-06-18T12:01:00Z",
    },
  ]);

  assertEquals(
    md,
    [
      "## Open Action Items",
      "",
      "- [ ] Confirm Jane Doe appointment time (action-1)",
      "- [ ] Send Sam Smith the bookkeeping export (action-2)",
    ].join("\n"),
  );
});

Deno.test("renderOpenActionChecklist: adds cap wording when more rows are open", () => {
  const md = renderOpenActionChecklist(
    [
      {
        id: "action-1",
        description: "Confirm Jane Doe appointment time",
        created_at: "2026-06-18T12:00:00Z",
      },
    ],
    3,
  );

  assert(md.includes("Showing 1 of 3 open action items"));
  assert(md.includes("2 more remain open"));
});

Deno.test("renderOpenActionChecklist: cannot invent event context without a row", () => {
  const md = renderOpenActionChecklist([
    {
      id: "action-1",
      description: "Send Sam Smith the bookkeeping export",
      created_at: "2026-06-18T12:01:00Z",
    },
  ]);

  assertEquals(md.includes("July 5"), false);
  assertEquals(md.includes("launch"), false);
});

Deno.test("renderOpenActionChecklist: no rows renders no checklist", () => {
  assertEquals(renderOpenActionChecklist([], 0), "");
});
