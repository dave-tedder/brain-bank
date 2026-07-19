import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  DELIVERABLE_MAX_BYTES,
  deliverableContentType,
  validateDeliverableContent,
  validateDeliverablePath,
} from "./_deliverables.ts";

Deno.test("deliverable path: valid slug/filename shapes pass", () => {
  assertEquals(
    validateDeliverablePath("some-project/abcd1234-claim-kit.md"),
    "some-project/abcd1234-claim-kit.md",
  );
  assertEquals(
    validateDeliverablePath("another-project/post-4-INSTALL-READY.html"),
    "another-project/post-4-INSTALL-READY.html",
  );
});

Deno.test("deliverable path: traversal, absolute, deep, and odd shapes throw", () => {
  assertThrows(() => validateDeliverablePath("../secrets.md"), Error);
  assertThrows(() => validateDeliverablePath("/etc/passwd"), Error);
  assertThrows(() => validateDeliverablePath("a/b/c.md"), Error); // one level only
  assertThrows(() => validateDeliverablePath("slug/.hidden.md"), Error);
  assertThrows(() => validateDeliverablePath("slug/script.sh"), Error); // ext allowlist
  assertThrows(() => validateDeliverablePath("Slug/file.md"), Error); // slug lowercase
  assertThrows(() => validateDeliverablePath(""), Error);
  assertThrows(() => validateDeliverablePath(123 as unknown as string), Error);
});

Deno.test("deliverable content: cap enforced, small content passes", () => {
  assertEquals(validateDeliverableContent("hello"), "hello");
  assertThrows(
    () => validateDeliverableContent("x".repeat(DELIVERABLE_MAX_BYTES + 1)),
    Error,
    "cap",
  );
});

Deno.test("deliverable content type maps by extension", () => {
  assertEquals(deliverableContentType("s/f.md"), "text/markdown");
  assertEquals(deliverableContentType("s/f.html"), "text/html");
  assertEquals(deliverableContentType("s/f.csv"), "text/csv");
});
