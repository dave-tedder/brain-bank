// The claim audit for scripts/loop-closing/fragment-gate-ts-mutants.py (Codex
// re-review 2, N1). Run by the sweep on the unmutated tree, after the positive
// controls and before any mutant is judged:
//
//   deno run --no-lock --allow-read --allow-env scripts/loop-closing/claim-audit.ts <tree> <claims.json>
//
// <claims.json>: {"files": [<every test or harness file a claim lives in>],
//                 "claims": [{"file", "id", "test"?}]}   (paths relative to <tree>)
//
// It reads the files with the TypeScript parser (never by string search) and
// checks that a claim can only be produced by the claim it names:
//   - `claim` and `claimVerdict` are imported from scripts/loop-closing/claim.ts
//     and appear ONLY as the callee of a call: never aliased, passed, wrapped or
//     shadowed;
//   - every such call passes its id as a string literal;
//   - each configured id has exactly one call site in its file, and a deno-test
//     claim's call site is inside the Deno.test named for it;
//   - no literal in these files contains "[claim:" (the tag is built only in
//     claim.ts) or names the claim log variable, and no code in them writes or
//     opens a file through Deno or node:fs (only claim.ts writes claim records).
// Erased TypeScript syntax and grouping parentheses are looked through with
// mirror-ast.ts's one erasure policy (skipErased, outermostWrapper), the same
// one the mirror comparison uses (Codex re-review 3, R4-1): `(claim as typeof
// claim)("id", ...)` is a call of claim with the literal id "id" (the `typeof
// claim` is a type, erased, never a reference), and
// `(Deno as any).writeTextFileSync` is a Deno file write.
// Prints one line per check; exit 0 when every check holds, 1 otherwise.
import { findAll, inTypePosition, outermostWrapper, parseTs, skipErased, ts } from "./mirror-ast.ts";

type Claim = { file: string; id: string; test?: string };
const [tree, configPath] = Deno.args;
const config = JSON.parse(Deno.readTextFileSync(configPath)) as { files: string[]; claims: Claim[] };
const CLAIM_MODULE = new URL("scripts/loop-closing/claim.ts", `file://${tree.endsWith("/") ? tree : tree + "/"}`).pathname;
const ENTRY = new Set(["claim", "claimVerdict"]);
const FILE_WRITERS = /^(write|open|create|truncate|rename|remove|copyFile|link|symlink|makeTemp|mkdir|chmod|chown|utime)/;

let ok = true;
const report = (good: boolean, line: string) => {
  console.log(`CLAIM AUDIT ${line} ${good ? "ok" : "NOT OK"}`);
  ok = ok && good;
};

const sites = new Map<string, ts.CallExpression[]>(); // file \0 id -> call sites
for (const rel of config.files) {
  const path = `${tree}/${rel}`;
  const sf = parseTs(Deno.readTextFileSync(path), rel);
  const problems: string[] = [];
  const where = (n: ts.Node) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  // Imports of the entry points come from claim.ts; nothing comes from node:fs.
  for (const imp of sf.statements.filter(ts.isImportDeclaration)) {
    const spec = (imp.moduleSpecifier as ts.StringLiteral).text;
    if (spec === "node:fs" || spec === "fs" || spec === "node:fs/promises") problems.push(`${where(imp)} imports ${spec}`);
    const named = imp.importClause?.namedBindings;
    const names = named && ts.isNamedImports(named) ? named.elements.map((e) => (e.propertyName ?? e.name).text) : [];
    if (names.some((n) => ENTRY.has(n))) {
      const resolved = new URL(spec, `file://${path}`).pathname;
      if (resolved !== CLAIM_MODULE) problems.push(`${where(imp)} imports a claim entry point from ${spec}, not claim.ts`);
      for (const e of (named as ts.NamedImports).elements) {
        if (e.propertyName !== undefined && ENTRY.has(e.propertyName.text)) problems.push(`${where(e)} renames ${e.propertyName.text} on import`);
      }
    }
  }

  // Every reference to an entry point is the callee of a call with a literal id.
  for (const id of findAll(sf, ts.isIdentifier).filter((i) => ENTRY.has(i.text))) {
    if (ts.isImportSpecifier(id.parent) && id.parent.name === id) continue;
    if (inTypePosition(id)) continue; // `typeof claim` in a type: erased, never runs
    const callee = outermostWrapper(id);
    const p = callee.parent;
    if (ts.isCallExpression(p) && p.expression === callee) {
      const arg = p.arguments[0] === undefined ? undefined : skipErased(p.arguments[0]);
      if (arg === undefined || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        problems.push(`${where(p)} calls ${id.text} without a literal id`);
        continue;
      }
      const key = `${rel}\0${arg.text}`;
      sites.set(key, [...(sites.get(key) ?? []), p]);
      continue;
    }
    problems.push(`${where(id)} uses ${id.text} other than as a callee (alias, argument, wrapper or shadow)`);
  }

  // Tags are built only in claim.ts; the log is written only by claim.ts.
  for (const lit of findAll(sf, (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))) {
    const text = (lit as ts.LiteralLikeNode).text;
    if (text.includes("[claim:")) problems.push(`${where(lit)} has a literal containing "[claim:"`);
    if (text.includes("OBFG_CLAIM")) problems.push(`${where(lit)} names the claim log variable`);
  }
  for (const pa of findAll(sf, ts.isPropertyAccessExpression)) {
    const target = skipErased(pa.expression);
    if (ts.isIdentifier(target) && target.text === "Deno" && FILE_WRITERS.test(pa.name.text)) {
      problems.push(`${where(pa)} calls Deno.${pa.name.text}`);
    }
  }
  report(problems.length === 0, `file ${rel}: ${problems.length ? problems.join("; ") : "entry points only called, ids literal, no tag or log writer outside claim.ts"}`);
}

for (const c of config.claims) {
  const calls = sites.get(`${c.file}\0${c.id}`) ?? [];
  let inTest = true;
  if (c.test !== undefined && calls.length === 1) {
    let n: ts.Node | undefined = calls[0].parent;
    inTest = false;
    for (; n !== undefined; n = n.parent) {
      if (!ts.isCallExpression(n)) continue;
      const callee = skipErased(n.expression);
      const name = n.arguments[0] === undefined ? undefined : skipErased(n.arguments[0]);
      if (
        ts.isPropertyAccessExpression(callee) && ts.isIdentifier(skipErased(callee.expression)) &&
        (skipErased(callee.expression) as ts.Identifier).text === "Deno" && callee.name.text === "test" && name !== undefined &&
        ts.isStringLiteral(name)
      ) {
        inTest = name.text === c.test;
        break;
      }
    }
  }
  report(calls.length === 1 && inTest, `claim ${c.id} in ${c.file}: ${calls.length} call site(s)${c.test !== undefined ? `, inside Deno.test "${c.test}": ${inTest}` : ""}`);
}
Deno.exit(ok ? 0 : 1);
