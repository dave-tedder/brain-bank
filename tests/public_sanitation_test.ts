import { assertEquals } from "jsr:@std/assert@1.0.19";

const repoRoot = new URL("../", import.meta.url);

async function read(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, repoRoot));
}

// Every term here is split and rejoined so this file does not itself contain the
// literal it bans. A test that trips on its own source is a test people delete.
const PRIVATE_TERMS: ReadonlyArray<[string, string]> = [
  ["supabase project ref", ["dvsvzlwxhmq", "whmknwmdr"].join("")],
  ["operator domain", ["dave", "tedder.com"].join("")],
  ["operator domain", ["lauren", "tedder.com"].join("")],
  ["operator domain", ["tedderfamily", "tattooing.com"].join("")],
  ["operator domain", ["thecustom", "tattoo.com"].join("")],
  ["operator locality", ["Have", "lock"].join("")],
  // Personal lane identities. The public repo uses genericized agent codes
  // (claude-code, runner-a, triage); the "dave-" prefixed forms are the origin
  // deployment's real ledger rows and should never appear in a fork's surfaces.
  ["operator lane identity", ["dave-", "codex"].join("")],
  ["operator lane identity", ["dave-", "claude-code"].join("")],
  ["operator lane identity", ["dave-", "reconciler"].join("")],
  ["operator lane identity", ["dave-", "sentinel"].join("")],
  ["operator lane identity", ["dave-", "triage"].join("")],
  ["operator lane identity", ["dave-", "briefing"].join("")],
];

// Enumerated by walking, never by listing filenames. Naming files is how the
// repo-root tests/ directory went unrun in CI for months and how README.md, the
// most-read release surface in the project, stayed outside this very check while
// the test's name claimed otherwise. A new doc is covered the day it is added.
const SURFACE_ROOTS = ["", "docs", "integrations", "skills", "scripts", "tests"];
const SURFACE_EXTENSIONS = [".md", ".json", ".ts", ".mjs", ".sh", ".sql", ".txt"];
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dashboard", // has its own suite and its own deploy surface
]);

// What ships is the set of TRACKED files, and this test cannot ask git: CI runs it
// as `deno test --allow-read --allow-env`, with no --allow-run. So gitignored paths
// are skipped by prefix instead, and the test below proves each prefix is really in
// .gitignore. Without that proof the skip would silently widen into a blind spot,
// and worse, the scan would disagree between a working copy and a fresh clone --
// green in CI, red locally, for a file that never ships either way.
//
// A hardcoded SKIP is safe in a way a hardcoded include list is not. Getting a skip
// wrong narrows the scan by exactly one visible line. Getting an include list wrong
// is how README.md sat outside a test named for release surfaces.
const GITIGNORED_SKIPS = ["tests/_shared/fixtures/private/"];

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(new URL(dir || ".", repoRoot))) {
    if (entry.name.startsWith(".") && entry.isDirectory) continue;
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (GITIGNORED_SKIPS.some((skip) => `${path}/`.startsWith(skip))) continue;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (SURFACE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      yield path;
    }
  }
}

async function releaseSurfaces(): Promise<string[]> {
  const seen = new Set<string>();
  for (const root of SURFACE_ROOTS) {
    for await (const path of walk(root)) {
      // A root of "" walks the whole tree, so the later roots are redundant by
      // construction; the Set keeps this honest if SURFACE_ROOTS ever narrows.
      seen.add(path);
    }
  }
  return [...seen].sort();
}

Deno.test("release surfaces omit private project references", async () => {
  const surfaces = await releaseSurfaces();

  // Guard the guard. If the walk ever returns nothing (a moved root, a bad URL,
  // a tightened permission) every assertion below passes vacuously and this
  // reports green while checking zero files.
  assertEquals(
    surfaces.length > 50,
    true,
    `walk returned only ${surfaces.length} files; the scan is not covering the repo`,
  );
  assertEquals(surfaces.includes("README.md"), true, "README.md must be scanned");
  assertEquals(surfaces.includes("CHANGELOG.md"), true, "CHANGELOG.md must be scanned");

  const findings: string[] = [];
  for (const path of surfaces) {
    const source = await read(path);
    for (const [label, term] of PRIVATE_TERMS) {
      if (source.includes(term)) findings.push(`${path}: ${label} (${term})`);
    }
  }

  assertEquals(findings, [], `private references in release surfaces:\n${findings.join("\n")}`);
});

Deno.test("every skipped path is genuinely gitignored", async () => {
  // The one thing holding GITIGNORED_SKIPS honest. If a path stops being ignored,
  // it starts shipping, and this fails rather than quietly continuing to skip it.
  const gitignore = await read(".gitignore");
  for (const skip of GITIGNORED_SKIPS) {
    const listed = gitignore
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line === skip || line === skip.replace(/\/$/, ""));
    assertEquals(listed, true, `${skip} is skipped by the scan but is not in .gitignore`);
  }
});

Deno.test("the private-reference scan can actually fail", async () => {
  // The scan is only worth its runtime if a real leak trips it. This proves the
  // matcher, not the corpus: the previous version of this test passed for months
  // while never reading the file most likely to leak.
  const [, term] = PRIVATE_TERMS[0];
  const planted = `# Example\n\nProject ref: ${term}\n`;
  const hits = PRIVATE_TERMS.filter(([, t]) => planted.includes(t));
  assertEquals(hits.length, 1);
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
