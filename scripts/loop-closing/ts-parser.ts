// The one place the TypeScript compiler is imported. Test-only: the mirror
// proof (supabase/functions/_shared/fragment-gate.test.ts, through
// mirror-ast.ts) and the claim audit (claim-audit.ts) parse source with it.
// Nothing deployed imports this file.
//
// Pinned to an exact version: npm never republishes a version, and Deno checks
// the tarball against the registry's sha512 integrity when it downloads it. The
// same version Deno 2.9.3 type-checks with (`deno --version`: typescript 6.0.3).
// The repo also pins the integrity itself:
//
//   deno cache --no-config --lock=scripts/loop-closing/ts-parser.lock.json --frozen scripts/loop-closing/ts-parser.ts
//
// fails if the downloaded package does not match the lock file's hash.
// (--no-config: without it Deno adds the workspace's own dependencies to the
// lock and --frozen refuses the run.) Once cached (that command, or any first
// test run), runs need no network: `deno test --cached-only ...` works offline.
//
// TypeScript reads a few environment variables at load (TSC_WATCHFILE and
// kin), so anything importing this needs --allow-env.
import ts from "npm:typescript@6.0.3";

export { ts };
