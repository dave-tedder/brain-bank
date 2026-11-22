// Shared entrypoint guard for the Open Engine node scripts.
//
// A script calls isDirectInvocation(import.meta.url) to decide whether to run its
// CLI or stay quiet because it was imported (by a test, or by another module).
//
// Compare RESOLVED filesystem paths on both sides. Node resolves symlinks before
// loading the main module, so import.meta.url names the real file while
// process.argv[1] keeps whatever path the caller typed. Comparing a URL built
// from argv[1] (the old guard in reconcile-probe.mjs) was false for any launch
// through a symlink, including macOS /tmp -> /private/tmp and reconcile-run.sh's
// logical `pwd`, and the script exited 0 with no output having run nothing: it
// printed its result by real path and 0 bytes, exit 0, through a symlinked
// directory. Going through fileURLToPath also keeps the paths-with-spaces fix
// (a checkout under, say, an iCloud "Mobile Documents" folder), which a raw
// string compare breaks.
//
// A missing entry (node -e, a REPL) or one naming no file means the module was
// imported, not launched. Any other resolution error (ELOOP, EACCES, EIO) is
// rethrown, so a launch that cannot be checked fails loudly instead of silently
// doing nothing.
//
// The argv array is a parameter (not a bare argv[1] with a default) so a test can
// pass an argv with no script path; with a defaulted argv[1], passing undefined
// silently substitutes the test runner's own path. The explicit `!entry` check is
// behaviorally redundant on Node 25.6.0, where realpathSync(undefined) throws
// ENOENT, and is kept so the import case does not depend on that.
//
// closeout-controller.mjs keeps its own identical copy (PR 21, bba3cfd): the
// supersede recovery harness's cli_does_nothing mutant pins that file's exact
// `if (isDirectInvocation()) {` line, so moving it here would break that mutant.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isDirectInvocation(moduleUrl, argv = process.argv) {
  const entry = argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return false;
    throw err;
  }
}
