import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  STILL_OWED_MARKERS,
  stillOwedAdjacencyVeto,
} from "./still-owed-veto.ts";
const idStem = (token: string) => token;

const productionStem = (token: string): string => {
  let value = token;
  if (value.length >= 4 && value.endsWith("s")) value = value.slice(0, -1);
  if (value.length >= 5 && value.endsWith("ing")) value = value.slice(0, -3);
  if (value.length >= 4 && value.endsWith("ed")) value = value.slice(0, -2);
  if (value.length >= 5 && value.endsWith("tion")) value = value.slice(0, -4) + "t";
  if (value.length >= 5 && value.endsWith("e")) value = value.slice(0, -1);
  return value;
};

Deno.test("vetoes queued work adjacent to its candidate subject", () => {
  const result = stillOwedAdjacencyVeto(
    "The prompt hardening shipped. The dashboard refresh is queued for the next release.",
    "dashboard refresh",
    idStem,
  );
  assertEquals(result.vetoed, true);
  assertEquals(result.marker, "queued");
});

Deno.test("vetoes remaining and pending work", () => {
  assertEquals(
    stillOwedAdjacencyVeto(
      "The RPC shipped. Remaining: email sender blocklist cleanup.",
      "email sender blocklist cleanup",
      idStem,
    ).vetoed,
    true,
  );
  assertEquals(
    stillOwedAdjacencyVeto(
      "The release notes shipped, but the export migration is still pending.",
      "export migration",
      idStem,
    ).vetoed,
    true,
  );
});

Deno.test("does not veto completed target when marker belongs to another subject", () => {
  const result = stillOwedAdjacencyVeto(
    "Shipped the database policy cleanup and deployed it to production successfully. " +
      "Separately, the unrelated digest filter is queued for later.",
    "database policy cleanup",
    idStem,
  );
  assertEquals(result.vetoed, false);
});

Deno.test("window includes distance six and excludes distance seven", () => {
  assertEquals(
    stillOwedAdjacencyVeto("queued one two three four five dashboard", "dashboard refactor", idStem).vetoed,
    true,
  );
  assertEquals(
    stillOwedAdjacencyVeto("queued one two three four five six dashboard", "dashboard refactor", idStem).vetoed,
    false,
  );
});

Deno.test("production stem aligns marker and subject inflections", () => {
  const result = stillOwedAdjacencyVeto(
    "Port artifacts queuing with the dashboards refresh work.",
    "dashboard refresh",
    productionStem,
  );
  assertEquals(result.vetoed, true);
});

Deno.test("all-stoplisted candidate has no subject and is not vetoed", () => {
  assertEquals(
    stillOwedAdjacencyVeto("queued the todo task item for later", "TODO task item", idStem).vetoed,
    false,
  );
});

Deno.test("precision marker set excludes ambiguous completion words", () => {
  assertEquals(STILL_OWED_MARKERS.includes("cleared"), false);
  assertEquals(STILL_OWED_MARKERS.includes("staged"), false);
  assertEquals(STILL_OWED_MARKERS.includes("slated"), false);
  assertEquals(
    stillOwedAdjacencyVeto(
      "Cleared the database policy backlog and shipped it.",
      "database policy backlog",
      idStem,
    ).vetoed,
    false,
  );
});

Deno.test("documents accepted remains versus remaining stem collision", () => {
  assertEquals(
    stillOwedAdjacencyVeto(
      "The dashboard design remains the best version; I finished it today.",
      "dashboard design",
      productionStem,
    ).vetoed,
    true,
  );
});

Deno.test("subject before marker is covered by the backward window", () => {
  const result = stillOwedAdjacencyVeto(
    "The dashboard refactor is still pending review.",
    "dashboard refactor",
    idStem,
  );
  assertEquals(result.vetoed, true);
  assertEquals(result.marker, "pending");
});
