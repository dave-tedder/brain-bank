import { assertEquals } from "jsr:@std/assert";

const repoRoot = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, repoRoot));
}

Deno.test("release surfaces omit private project references", async () => {
  const privateRef = ["dvsvzlwxhmq", "whmknwmdr"].join("");
  const paths = [
    "CHANGELOG.md",
    "tests/auto_resolve_prompt_contract_test.ts",
  ];

  for (const path of paths) {
    assertEquals((await read(path)).includes(privateRef), false, path);
  }
});

Deno.test("public API examples stay domain-neutral", async () => {
  const paths = [
    "integrations/chatgpt-gpt/openapi.json",
    "supabase/functions/open-brain-mcp/index.ts",
  ];

  for (const path of paths) {
    assertEquals(/irezumi/i.test(await read(path)), false, path);
  }
});

Deno.test("MCP instructions use Brain Bank branding", async () => {
  const source = await read("supabase/functions/open-brain-mcp/index.ts");
  assertEquals(source.includes("Open Brain"), false);
  assertEquals(source.includes("# Brain Bank"), true);
});
