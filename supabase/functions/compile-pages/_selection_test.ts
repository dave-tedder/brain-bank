import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import { selectPagesToCompile } from "./_selection.ts";

// Minimal shape the selector needs. Real callers pass full page rows; the
// selector only reads page_type and preserves the caller's (oldest-first) order.
function page(slug: string, page_type: string) {
  return { slug, page_type };
}

// Build N oldest-first topic pages t0..t(n-1) followed by client pages.
function pages(topics: number, clients: number) {
  const out: Array<{ slug: string; page_type: string }> = [];
  for (let i = 0; i < topics; i++) out.push(page(`topic/t${i}`, "topic"));
  for (let i = 0; i < clients; i++) out.push(page(`client/c${i}`, "client"));
  return out;
}

Deno.test("selectPagesToCompile: reserves high-value slots so topics can't starve clients", () => {
  // 20 topics ahead of 6 clients in the oldest-first queue. Without a reserve,
  // batch=10 would be all topics. With reserve=5, half go to clients.
  const selected = selectPagesToCompile(pages(20, 6), 10, 5);
  const clients = selected.filter((p) => p.page_type === "client");
  const topics = selected.filter((p) => p.page_type === "topic");
  assertEquals(selected.length, 10);
  assertEquals(clients.length, 5);
  assertEquals(topics.length, 5);
});

Deno.test("selectPagesToCompile: backlog lane is oldest-first (input order preserved)", () => {
  const selected = selectPagesToCompile(pages(20, 6), 10, 5);
  const topics = selected.filter((p) => p.page_type === "topic").map((p) => p.slug);
  assertEquals(topics, ["topic/t0", "topic/t1", "topic/t2", "topic/t3", "topic/t4"]);
});

Deno.test("selectPagesToCompile: high-value lane is oldest-first (input order preserved)", () => {
  const selected = selectPagesToCompile(pages(20, 6), 10, 5);
  const clients = selected.filter((p) => p.page_type === "client").map((p) => p.slug);
  assertEquals(clients, ["client/c0", "client/c1", "client/c2", "client/c3", "client/c4"]);
});

Deno.test("selectPagesToCompile: unused high-value slots spill to backlog", () => {
  // Only 2 clients but reserve=5: the 3 unused reserved slots go to topics.
  const selected = selectPagesToCompile(pages(20, 2), 10, 5);
  assertEquals(selected.filter((p) => p.page_type === "client").length, 2);
  assertEquals(selected.filter((p) => p.page_type === "topic").length, 8);
  assertEquals(selected.length, 10);
});

Deno.test("selectPagesToCompile: unused backlog slots spill to extra high-value", () => {
  // Only 3 topics but 10 clients: after 5 reserved clients + 3 topics, the
  // remaining 2 slots pull more clients rather than leaving the batch short.
  const selected = selectPagesToCompile(pages(3, 10), 10, 5);
  assertEquals(selected.filter((p) => p.page_type === "topic").length, 3);
  assertEquals(selected.filter((p) => p.page_type === "client").length, 7);
  assertEquals(selected.length, 10);
});

Deno.test("selectPagesToCompile: project pages count as high-value alongside clients", () => {
  const input = [
    page("topic/t0", "topic"),
    page("topic/t1", "topic"),
    page("project/p0", "project"),
    page("client/c0", "client"),
  ];
  const selected = selectPagesToCompile(input, 2, 1);
  // reserve=1 high-value → project/p0 (oldest high-value), then 1 topic.
  assertEquals(selected.map((p) => p.slug).sort(), ["project/p0", "topic/t0"]);
});

Deno.test("selectPagesToCompile: fewer candidates than batch returns all", () => {
  const selected = selectPagesToCompile(pages(2, 2), 10, 5);
  assertEquals(selected.length, 4);
});

Deno.test("selectPagesToCompile: batch of 0 returns nothing", () => {
  assertEquals(selectPagesToCompile(pages(5, 5), 0, 5), []);
});

Deno.test("selectPagesToCompile: reserve of 0 is pure oldest-first", () => {
  const selected = selectPagesToCompile(pages(20, 6), 10, 0);
  // No reservation → the first 10 by input order, all topics.
  assertEquals(selected.map((p) => p.slug), [
    "topic/t0", "topic/t1", "topic/t2", "topic/t3", "topic/t4",
    "topic/t5", "topic/t6", "topic/t7", "topic/t8", "topic/t9",
  ]);
});

Deno.test("selectPagesToCompile: reserve larger than batch is clamped", () => {
  // reserve=20 but batch=4: at most 4 high-value, no crash, batch respected.
  const selected = selectPagesToCompile(pages(10, 10), 4, 20);
  assertEquals(selected.length, 4);
  assertEquals(selected.filter((p) => p.page_type === "client").length, 4);
});
