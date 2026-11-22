// Tests for the shared entrypoint guard and the script that uses it.
// Run: node --test scripts/open-engine/entrypoint-guard.test.mjs
//
// Part 1 calls isDirectInvocation() directly against real files, directories and
// symlinks in a temp dir. Part 2 never imports the script into this process:
// every launch and every import happens in a child process, so a guard that is
// always true fails a named assertion here instead of running a CLI inside the
// test runner (the same reason closeout-controller-entrypoint.test.mjs exists).
//
// Every temp path contains a space, so the "Mobile Documents" case is covered on
// any machine, not only in a checkout whose path happens to have one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isDirectInvocation } from "./entrypoint-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function withTempDir(fn) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "oe entry guard "));
  try {
    return fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runBounded(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  assert.equal(r.error, undefined, `spawn failed or timed out: ${r.error?.message}`);
  return r;
}

// ---------------------------------------------------------------------------
// Part 1: the helper
// ---------------------------------------------------------------------------

test("guard: true by real path, through a symlinked directory and through a symlinked file", () => {
  withTempDir((base) => {
    const realDir = join(base, "real dir");
    mkdirSync(realDir);
    const script = join(realDir, "script.mjs");
    writeFileSync(script, "");
    const url = pathToFileURL(script).href;
    symlinkSync(realDir, join(base, "linked dir"));
    symlinkSync(script, join(base, "linked script.mjs"));

    assert.equal(isDirectInvocation(url, ["node", script]), true, "real path");
    assert.equal(isDirectInvocation(url, ["node", join(base, "linked dir", "script.mjs")]), true, "symlinked directory");
    assert.equal(isDirectInvocation(url, ["node", join(base, "linked script.mjs")]), true, "symlinked file");
  });
});

test("guard: false when the entry is absent, missing, runs through a file, or names another file", () => {
  withTempDir((base) => {
    const script = join(base, "script.mjs");
    const other = join(base, "other.mjs");
    writeFileSync(script, "");
    writeFileSync(other, "");
    const url = pathToFileURL(script).href;

    assert.equal(isDirectInvocation(url, ["node"]), false, "no argv[1]");
    assert.equal(isDirectInvocation(url, ["node", ""]), false, "empty argv[1]");
    assert.equal(isDirectInvocation(url, ["node", join(base, "missing.mjs")]), false, "ENOENT");
    assert.equal(isDirectInvocation(url, ["node", join(script, "child.mjs")]), false, "ENOTDIR");
    assert.equal(isDirectInvocation(url, ["node", other]), false, "a different file");
  });
});

test("guard: any other resolution error is rethrown, not read as an import", () => {
  withTempDir((base) => {
    const script = join(base, "script.mjs");
    writeFileSync(script, "");
    const loop = join(base, "loop link");
    symlinkSync(loop, loop);
    assert.throws(
      () => isDirectInvocation(pathToFileURL(script).href, ["node", loop]),
      (err) => err?.code === "ELOOP",
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2: the guarded script, driven from child processes
// ---------------------------------------------------------------------------

const SCRIPTS = [
  {
    name: "reconcile-probe.mjs",
    // No --task-id is a deterministic, offline usage line on stdout, exit 0.
    env: () => ({}),
    expect: (r) => {
      assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr.slice(0, 300)}`);
      assert.match(r.stdout, /"error":"usage: reconcile-run\.sh --task-id <uuid>"/);
    },
  },
];

for (const s of SCRIPTS) {
  test(`${s.name}: runs by real path and through a symlinked directory`, () => {
    withTempDir((base) => {
      const linked = join(base, "linked oe");
      symlinkSync(HERE, linked);
      for (const [label, path] of [["real path", join(HERE, s.name)], ["symlinked dir", join(linked, s.name)]]) {
        const r = runBounded(process.execPath, [path], s.env(base));
        assert.ok(r.stdout.length + r.stderr.length > 0, `${label}: no output at all, the CLI never ran`);
        s.expect(r);
      }
    });
  });

  test(`${s.name}: a fresh process that imports it stays quiet`, () => {
    withTempDir((base) => {
      const load = `await import(${JSON.stringify(pathToFileURL(join(HERE, s.name)).href)});`;
      const importer = join(base, "importer.mjs");
      writeFileSync(importer, `${load}\n`);
      const cases = [
        ["no argv[1] (node -e)", ["--input-type=module", "-e", load]],
        ["argv[1] names no file (ENOENT)", ["--input-type=module", "-e", load, join(base, "missing.mjs")]],
        ["argv[1] runs through a regular file (ENOTDIR)", ["--input-type=module", "-e", load, join(importer, "child.mjs")]],
        ["argv[1] is the importing script", [importer]],
      ];
      for (const [label, args] of cases) {
        const r = runBounded(process.execPath, args, s.env(base));
        assert.equal(r.status, 0, `${label}: the import exited ${r.status}: ${r.stderr.slice(0, 300)}`);
        assert.equal(r.stdout, "", `${label}: the CLI ran on import (${r.stdout.length} bytes)`);
        assert.equal(r.stderr, "", `${label}: the import wrote to stderr: ${r.stderr.slice(0, 300)}`);
      }
    });
  });
}

test("reconcile-run.sh through a symlinked directory reaches the probe, not the empty-output fallback", () => {
  withTempDir((base) => {
    const linked = join(base, "linked oe");
    symlinkSync(HERE, linked);
    // Dummy credentials keep the wrapper off ~/.claude.json; without --task-id the
    // probe exits on its usage line before any network call.
    const r = runBounded("bash", [join(linked, "reconcile-run.sh")], {
      OPEN_BRAIN_MCP_URL: "http://127.0.0.1:9/never-called",
      OPEN_BRAIN_MCP_KEY: "dummy",
    });
    assert.doesNotMatch(r.stdout, /probe runner produced no output/, "the probe never ran");
    assert.match(r.stdout, /"error":"usage: reconcile-run\.sh --task-id <uuid>"/);
  });
});
