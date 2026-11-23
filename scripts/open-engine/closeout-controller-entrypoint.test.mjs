// External driver for the closeout controller's entrypoint guard.
//
// This file deliberately never imports closeout-controller.mjs into its own process.
// closeout-controller.test.mjs imports the controller at load time, so a guard that is
// always true runs the CLI inside that test runner and fails the whole file before any
// assertion is reached: a crash, not a named catch. Here every import happens in a
// child process, so the same defect fails the named assertion below.
//
// Run with the main suite:
//   node --test scripts/open-engine/closeout-controller.test.mjs scripts/open-engine/closeout-controller-entrypoint.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTROLLER_PATH = join(dirname(fileURLToPath(import.meta.url)), "closeout-controller.mjs");

function runNodeBounded(args) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.error, undefined, `spawn failed or timed out: ${r.error?.message}`);
  return r;
}

test("entrypoint driver: a fresh process that imports the controller stays quiet", () => {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe-entry-driver-"));
  try {
    const load = `await import(${JSON.stringify(pathToFileURL(CONTROLLER_PATH).href)});`;
    const importer = join(base, "importer.mjs");
    writeFileSync(importer, `${load}\n`);
    const cases = [
      ["no argv[1] (node -e)", ["--input-type=module", "-e", load]],
      ["argv[1] names no file (ENOENT)", ["--input-type=module", "-e", load, join(base, "missing.mjs"), "--help"]],
      ["argv[1] runs through a regular file (ENOTDIR)", ["--input-type=module", "-e", load, join(importer, "child.mjs"), "--help"]],
      ["argv[1] is the importing script", [importer, "--help"]],
    ];
    for (const [label, args] of cases) {
      const r = runNodeBounded(args);
      assert.equal(r.status, 0, `${label}: the import exited ${r.status}: ${r.stderr.slice(0, 300)}`);
      assert.equal(r.stdout, "", `${label}: the CLI ran on import (${r.stdout.length} bytes)`);
      assert.equal(r.stderr, "", `${label}: the import wrote to stderr: ${r.stderr.slice(0, 300)}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
