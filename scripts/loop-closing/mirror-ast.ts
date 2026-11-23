// The mirror proof's comparison (AGENTS.md mirror rule), on a real parser.
// Used by supabase/functions/_shared/fragment-gate.test.ts. Test-only.
//
// Why a parser (Codex review 1 F2, re-review 1 R2/R3, re-review 2 N2/N3). The
// comparison was a hand-written tokenizer plus a hand-written rule for which
// line breaks matter (ASI). Each round found another grammar edge it got wrong:
// whitespace inside a literal, a line break after `return`, after a postfix
// non-null `!`, after a non-ASCII identifier, a comment holding a line break
// before an empty return's `;`. The TypeScript parser already implements the
// whole grammar, ASI included. So two bodies are compared as SYNTAX TREES:
//
//   - Layout and comments are not in the tree, so blank lines, wrapping,
//     indentation, comment wording and comment placement compare equal.
//   - A line break that changes the parse changes the tree (`return\n true` is
//     a return with no value plus an expression statement; `count!\n++step` is
//     two statements, `count!++\nstep` is a postfix increment), so it compares
//     different, with no list of restricted words to keep current. Two
//     line-break rules TypeScript enforces in its checker, not its parser,
//     are refused in parseTs (an arrow's `=>` on a new line, TS1200; `throw`
//     followed by a line break, TS1142): the parser builds a tree for them that
//     the runtime would reject. fragment-gate.test.ts checks the comparison
//     against V8 at every token gap of a corpus; that is how TS1200 was found.
//   - Literal values are compared exactly (string and numeric values, regular
//     expression source and flags, template text cooked AND raw), so
//     `"op en"` is not `"open"`; a string's quote style is not (`'a'` and `"a"`
//     are one value, and deno fmt rewrites quotes).
//   - Code that does not parse is refused: a setup error, never a verdict.
//   - Code the RUNTIME refuses is refused too (runtimeRejects): the TypeScript
//     parser builds a tree for some code that its checker, not its parser,
//     rejects, and so does Deno. parseTs refuses two such line-break rules
//     itself; the mirror tests also load every function they compare through
//     Deno's own module loader (its TypeScript transpiler, then V8), which is
//     the path the deployed code takes, and refuse what it refuses. The
//     wrapping check in fragment-gate.test.ts found three that parentheses
//     reach: `([a, b]) = [b, a]` and `a ?? b || c` (both runtimes refuse
//     them), and `[(a = f)] = []` (V8 refuses it; Deno's transpiler drops the
//     parentheses and accepts it).
//
// What the tree comparison IGNORES, and why each is safe:
//   - TypeScript types. Deno strips them before running the code, so they
//     cannot change behavior: annotations (`: T`), type arguments and
//     parameters (`<T>`), `as T`, `satisfies T`, non-null `x!`, `<T>x`,
//     optional/definite markers on declarations, interface and type-alias
//     declarations, `implements` clauses, bodiless overload signatures. A type
//     change in one copy (Codex re-review 1's `db: any`) is therefore an
//     allowed difference, not a setup failure. Enums, namespaces, parameter
//     properties and decorators DO run, and are compared. The erased
//     EXPRESSION wrappers (`as`, `satisfies`, `!`, `<T>x`, `f<T>`) and the
//     grouping parentheses are one policy, defined once below (isWrapper,
//     skipErased, groupingObservable): astKey uses it, and so must every tree
//     locator in the tests and claim-audit.ts, so that an erased type the key
//     accepts can never make a locator miss its site (R4-1, `return true as
//     boolean`).
//   - Grouping parentheses, with two exceptions (Codex re-review 3, R4-1). In
//     TypeScript's tree a ParenthesizedExpression holds nothing but its own
//     presence: everything grouping decides is already in the tree's SHAPE
//     (precedence and associativity: `(a + b) * c` is a different tree from
//     `a + b * c`; `new (f())` from `new f()`; `(0, o.f)()` from `o.f()`) or in
//     a node FLAG the key records (an optional chain ends at a parenthesis, so
//     the `.b` of `(o?.a).b` carries no OptionalChain flag and the `.b` of
//     `o?.a.b` does). So `(items as typeof items).length` keys as
//     `items.length`, and `((x))`, `(x)` and `x` key alike. The two exceptions
//     are the places the language itself inspects the parenthesis, so they are
//     kept in the key (groupingObservable), each only where its rule applies
//     (Codex re-review 4, R5-1): a parenthesized string statement inside a
//     directive prologue is not a directive and ends the prologue
//     (`("use strict");`; elsewhere `("x");` and `"x";` are the same
//     statement; a statement the key erases, such as a type alias, neither
//     ends the prologue nor counts in it, Codex re-review 5, R6-1), and a parenthesized identifier assigned an anonymous
//     function, arrow or class does not name it (`(a) = function () {}`
//     leaves `a.name` empty; `=`, `&&=`, `||=`, `??=`; `(items) = f()` is
//     the same as `items = f()`). Deno's TypeScript
//     transpiler happens to drop both of those parentheses, so for these .ts
//     bodies keeping them can only fail conservatively; for plain JavaScript
//     (V8) they are exact. fragment-gate.test.ts checks this against V8 and
//     against Deno's own transpiler by wrapping every node of a corpus.
//   - A trailing comma in a list (`f(a,)`, `{ a, }`, `[a,]`): no runtime
//     effect; deno fmt adds them when it wraps. An array HOLE is an
//     OmittedExpression node and is compared.
//
// Name differences between the two copies are applied to the tree, on
// identifier nodes, never on text: see `astKey`'s `rename`.
import { ts } from "./ts-parser.ts";

export { ts };

// Kind names, preferring a real name over a range marker (FirstStatement is
// VariableStatement's alias).
const KIND_NAME = new Map<number, string>();
for (const [name, value] of Object.entries(ts.SyntaxKind)) {
  if (typeof value !== "number") continue;
  const marker = /^(First|Last)/.test(name);
  if (!KIND_NAME.has(value) || (!marker && /^(First|Last)/.test(KIND_NAME.get(value)!))) KIND_NAME.set(value, name);
}
export const kindName = (k: number) => KIND_NAME.get(k) ?? `Kind${k}`;

// Parse TypeScript source. A parse error is a setup failure (plain Error tagged
// "setup:"), so a mutant that does not even parse is never mistaken for a
// verdict of the comparison.
export function parseTs(text: string, label = "source"): ts.SourceFile {
  const sf = ts.createSourceFile(`${label.replace(/[^A-Za-z0-9_.-]/g, "_")}.ts`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = (sf as unknown as { parseDiagnostics: ts.DiagnosticWithLocation[] }).parseDiagnostics;
  if (diags.length > 0) {
    const d = diags[0];
    throw new Error(`setup: ${label} does not parse: ${ts.flattenDiagnosticMessageText(d.messageText, " ")} at ${d.start}`);
  }
  // The one "[no LineTerminator here]" rule TypeScript enforces in its checker
  // rather than its parser (TS1200): ArrowParameters [no LineTerminator here]
  // =>. The parser builds the same arrow function either way, but the runtime
  // rejects the file, so it is refused here like any other parse error.
  for (const arrow of findAll(sf, ts.isArrowFunction)) {
    const arr = arrow.equalsGreaterThanToken;
    if (LINE_TERMINATOR.test(text.slice(arr.pos, arr.getStart(sf)))) {
      throw new Error(`setup: ${label} does not parse: line terminator before => at ${arr.getStart(sf)}`);
    }
  }
  // Error recovery without a parse diagnostic: `throw\nerr` becomes a throw of
  // an EMPTY identifier (TypeScript reports TS1142 from its checker). Any empty
  // identifier is such a repair; the runtime rejects the file.
  const empty = findAll(sf, (n) => ts.isIdentifier(n) && n.text === "");
  if (empty.length > 0) throw new Error(`setup: ${label} does not parse: missing expression at ${empty[0].getStart(sf)}`);
  return sf;
}

// Load `moduleText` as a module through Deno's own loader, as a .ts file is
// loaded. The data: URL needs no permission and no network.
const toBase64 = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));
export async function loadTs(moduleText: string): Promise<{ ok: true; module: Record<string, unknown> } | { ok: false; error: string }> {
  try {
    return { ok: true, module: await import(`data:application/typescript;base64,${toBase64(moduleText)}`) };
  } catch (e) {
    // Without the location: it names the data: URL, whose columns differ.
    return { ok: false, error: `${(e as Error).name}: ${String((e as Error).message).split("\n")[0].replace(/ at data:\S*/g, "")}` };
  }
}
// null when the runtime loads `moduleText`, else why it refuses it. Use it on
// declarations only (a function's text): loading evaluates the module's top
// level.
export async function runtimeRejects(moduleText: string): Promise<string | null> {
  const loaded = await loadTs(moduleText);
  return loaded.ok ? null : loaded.error;
}

// Every node, depth first, that `pred` accepts.
export function findAll<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[];
export function findAll(root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[];
export function findAll(root: ts.Node, pred: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node) => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(root);
  return out;
}

// The one top-level function declaration of that name, with a body.
export function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = sf.statements.filter((s): s is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(s) && s.name?.text === name && s.body !== undefined
  );
  if (found.length !== 1) throw new Error(`setup: ${found.length} top-level function(s) named ${name} with a body, expected 1`);
  return found[0];
}

const ERASED_EXPRESSIONS = new Set([
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);
// THE type-erasure policy for expressions, used by astKey and by every tree
// locator (fragment-gate.test.ts, claim-audit.ts). A wrapper is a node Deno's
// transpiler removes, leaving its `expression` to run: an erased type wrapper,
// or a parenthesis.
export function isErasedWrapper(n: ts.Node): boolean {
  return ERASED_EXPRESSIONS.has(n.kind) ||
    (ts.isExpressionWithTypeArguments(n) && n.parent !== undefined && !ts.isHeritageClause(n.parent)); // f<T>
}
export function isWrapper(n: ts.Node): boolean {
  return isErasedWrapper(n) || ts.isParenthesizedExpression(n);
}
// Down: the expression that runs, through every wrapper. `((items as T))` is
// `items`; `return true as boolean` returns `true`.
export function skipErased<T extends ts.Node>(n: T): ts.Node {
  let e: ts.Node = n;
  while (isWrapper(e)) e = (e as unknown as ts.ParenthesizedExpression).expression;
  return e;
}
// THE type-erasure policy for statements: a statement Deno's transpiler
// removes whole (an interface, a type alias, a bodiless overload signature,
// anything declared with `declare`). astKey leaves it out of the key, and
// everything that walks a statement list or looks for an enclosing erased
// construct uses this same predicate: inDirectivePrologue skips it rather than
// stopping at it (Codex re-review 5, R6-1: `type ReviewMarker = number;`
// before an already-grouped string changed whether its grouping was kept),
// and inTypePosition treats what is inside it as erased.
export function isTypeOnlyStatement(n: ts.Node): boolean {
  if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;
  if (ts.isFunctionDeclaration(n) && n.body === undefined) return true; // overload signature
  const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}
// Whether `n` sits inside something erased, so never a runtime reference: a
// type (`typeof claim` in `x as typeof claim`, an annotation, a type
// argument), a statement the key erases (isTypeOnlyStatement: `interface I
// extends claim {}`), or an `implements` clause, which the key also drops.
export function inTypePosition(n: ts.Node): boolean {
  for (let p = n.parent; p !== undefined; p = p.parent) {
    if (p.kind >= ts.SyntaxKind.FirstTypeNode && p.kind <= ts.SyntaxKind.LastTypeNode) return true;
    if (isTypeOnlyStatement(p)) return true;
    if (ts.isHeritageClause(p) && p.token === ts.SyntaxKind.ImplementsKeyword) return true;
  }
  return false;
}
// Up: the outermost wrapper around `n` (n itself when nothing wraps it).
export function outermostWrapper(n: ts.Node): ts.Node {
  let e = n;
  while (e.parent !== undefined && isWrapper(e.parent) && (e.parent as ts.ParenthesizedExpression).expression === e) e = e.parent;
  return e;
}
// The assignments whose target, when it is a bare identifier, names an
// anonymous function assigned to it (ECMAScript IsIdentifierRef; a
// parenthesized identifier is not one).
const NAMING_ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
// ECMAScript IsAnonymousFunctionDefinition, on the expression that runs (the
// caller passes it through skipErased): a function, generator or async
// function expression, an arrow function, or a class expression, without a
// name of its own. The specification looks through grouping parentheses here
// (IsFunctionDefinition and NamedEvaluation of a ParenthesizedExpression are
// those of the expression inside), so `a = (function () {})` names it "a";
// and Deno's transpiler removes an erased wrapper before V8 sees it, so
// `a = (function () {}) as F` names it "a" too (both measured).
function isAnonymousFunctionDefinition(e: ts.Node): boolean {
  return (ts.isFunctionExpression(e) && e.name === undefined) || ts.isArrowFunction(e) ||
    (ts.isClassExpression(e) && e.name === undefined);
}
// Whether the statement list holding `st` has a directive prologue: a function
// body, a script or module, or a namespace body (TypeScript emits it as a
// function body). A class static block, any other block, a case clause: no.
function prologueStatements(st: ts.Statement): ts.NodeArray<ts.Statement> | undefined {
  const list = st.parent;
  if (ts.isSourceFile(list) || ts.isModuleBlock(list)) return list.statements;
  if (!ts.isBlock(list)) return undefined;
  const owner = list.parent;
  const isFunctionBody = (ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) || ts.isArrowFunction(owner) ||
    ts.isMethodDeclaration(owner) || ts.isConstructorDeclaration(owner) || ts.isGetAccessorDeclaration(owner) ||
    ts.isSetAccessorDeclaration(owner)) && owner.body === list;
  return isFunctionBody ? list.statements : undefined;
}
// A statement that is a directive once types are erased: a string literal, not
// grouped, as a whole expression statement (`"x";`, `"x" as string;`).
function directiveShaped(s: ts.Statement): boolean {
  if (!ts.isExpressionStatement(s)) return false;
  let e: ts.Node = s.expression;
  for (; isWrapper(e); e = (e as ts.ParenthesizedExpression).expression) if (ts.isParenthesizedExpression(e)) return false;
  return ts.isStringLiteral(e);
}
// Whether `st` stands where a directive would: every statement before it in a
// statement list that has a directive prologue is itself directive-shaped
// (the prologue is the longest such run at the start; ECMAScript 11.2.1),
// once the statements the key erases are gone. Deno's transpiler removes an
// interface or type alias before V8 sees the body, so a string after one is
// still a directive (measured: `function f(a = 1) { type T = number;
// "use strict"; return a; }` is refused by Deno's loader, the early error for
// a directive in a function with a non-simple parameter list). So an erased
// statement is skipped, never a terminator, by the key's own predicate
// (isTypeOnlyStatement; Codex re-review 5, R6-1). Every other statement,
// including an empty statement and a grouped string, ends the prologue.
function inDirectivePrologue(st: ts.Statement): boolean {
  const list = prologueStatements(st);
  if (list === undefined) return false;
  for (const s of list) {
    if (s === st) return true;
    if (isTypeOnlyStatement(s)) continue;
    if (!directiveShaped(s)) return false;
  }
  return false;
}
// Whether `st` is a directive once types are erased: a bare string statement
// standing in a directive prologue. Wrapping one in parentheses is not a
// permitted edit (it stops being a directive), so a test that wraps
// expression statements excludes these, by the same prologue walk.
export function isDirective(st: ts.Statement): boolean {
  return directiveShaped(st) && inDirectivePrologue(st);
}
// Whether the parentheses in the wrapper chain `outer` (its outermost node)
// around `core` are observable at run time beyond the tree's shape and flags.
// Only two places in the language look at a parenthesis itself, and each
// exception is exactly as wide as its rule (Codex re-review 4, R5-1: the first
// version kept every parenthesized identifier target and every parenthesized
// string statement, a false FAIL on `(items) = extractOperatorLines(content)`):
export function groupingObservable(outer: ts.Node, core: ts.Node): boolean {
  const p = outer.parent;
  if (p === undefined) return false;
  // A directive: `("use strict");` is an expression statement, `"use strict";`
  // a directive, but only inside a directive prologue. There a grouped string
  // also ENDS the prologue (`("x"); "use strict";` is sloppy code). Anywhere
  // else a string statement is never a directive, grouped or not.
  if (ts.isExpressionStatement(p) && ts.isStringLiteral(core) && inDirectivePrologue(p)) return true;
  // NamedEvaluation: `(a) = function () {}` leaves the function unnamed,
  // `a = function () {}` names it "a" (also `&&=`, `||=`, `??=`, and a
  // destructuring default, `[(a) = function () {}] = []`, which TypeScript's
  // tree holds as the same BinaryExpression). Only when the value assigned is
  // an anonymous function definition: `(items) = extractOperatorLines(content)`
  // runs exactly as `items = extractOperatorLines(content)`. An object
  // shorthand default (`{ a = function () {} } = {}`) also names, but its
  // target cannot be parenthesized (a parse error), so there is nothing to keep.
  if (
    ts.isBinaryExpression(p) && p.left === outer && NAMING_ASSIGNMENTS.has(p.operatorToken.kind) && ts.isIdentifier(core) &&
    isAnonymousFunctionDefinition(skipErased(p.right))
  ) return true;
  return false;
}

const TYPE_ROLES = new Set(["type", "typeArguments", "typeParameters"]);
// Optional `?` / definite `!` markers on these are type-only.
const MARKER_PARENTS = new Set([
  ts.SyntaxKind.Parameter, ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.MethodSignature, ts.SyntaxKind.VariableDeclaration,
]);
// Identifiers in these roles are property keys or labels, not references to a
// binding, so a rename never applies to them.
const KEY_ROLES: Array<[number, string]> = [
  [ts.SyntaxKind.PropertyAccessExpression, "name"],
  [ts.SyntaxKind.PropertyAssignment, "name"],
  [ts.SyntaxKind.ShorthandPropertyAssignment, "name"],
  [ts.SyntaxKind.MethodDeclaration, "name"],
  [ts.SyntaxKind.PropertyDeclaration, "name"],
  [ts.SyntaxKind.GetAccessor, "name"],
  [ts.SyntaxKind.SetAccessor, "name"],
  [ts.SyntaxKind.EnumMember, "name"],
  [ts.SyntaxKind.BindingElement, "propertyName"],
  [ts.SyntaxKind.ImportSpecifier, "propertyName"],
  [ts.SyntaxKind.ExportSpecifier, "propertyName"],
  [ts.SyntaxKind.LabeledStatement, "label"],
  [ts.SyntaxKind.BreakStatement, "label"],
  [ts.SyntaxKind.ContinueStatement, "label"],
];

// The role (property name in its parent) of each child, so that optional slots
// cannot alias: `for (;x;)` and `for (x;;)` have the same children in the same
// order, in different roles.
function roleOf(parent: ts.Node, child: ts.Node | ts.NodeArray<ts.Node>): string {
  for (const key of Object.keys(parent)) {
    if (key === "parent" || key === "original") continue;
    if ((parent as unknown as Record<string, unknown>)[key] === child) return key;
  }
  throw new Error(`setup: no role for a child of ${kindName(parent.kind)}`);
}

export type KeyOptions = {
  // Identifier renames (from -> to), applied to references and bindings, never
  // to property keys or labels. The caller checks the map is a bijection
  // between the two bodies (no `to` name already in the renamed body, no `from`
  // name in the other), so a rename cannot merge two different names.
  rename?: ReadonlyMap<string, string>;
  // Children left out of the key (the documented signature differences).
  skip?: (node: ts.Node) => boolean;
};

// The syntax tree as a flat list of strings, one opening entry per node
// (`role=Kind payload`), its children, then ")". Equal lists mean equal trees,
// up to the ignored differences listed at the top of this file.
export function astKey(root: ts.Node, opts: KeyOptions = {}): string[] {
  const out: string[] = [];
  const rename = opts.rename ?? new Map<string, string>();
  const visit = (n: ts.Node, role: string, parent: ts.Node | undefined) => {
    if (opts.skip?.(n)) return;
    if (isWrapper(n)) {
      // A chain of erased type wrappers and parentheses, entered at its
      // outermost node: key the expression that runs, and one parenthesis only
      // where the language can observe it.
      const core = skipErased(n);
      let grouped = false;
      for (let w: ts.Node = n; w !== core; w = (w as ts.ParenthesizedExpression).expression) {
        if (ts.isParenthesizedExpression(w)) grouped = true;
      }
      if (grouped && groupingObservable(n, core)) {
        out.push(`${role}=ParenthesizedExpression`);
        visit(core, "expression", n);
        out.push(")");
        return;
      }
      visit(core, role, parent);
      return;
    }
    out.push(`${role}=${kindName(n.kind)}${payload(n, role, parent, rename)}`);
    ts.forEachChild(
      n,
      (c) => {
        const r = roleOf(n, c);
        if (TYPE_ROLES.has(r)) return;
        if ((r === "questionToken" || r === "exclamationToken") && MARKER_PARENTS.has(n.kind)) return;
        if (ts.isParameter(c) && ts.isIdentifier(c.name) && c.name.text === "this") return; // `this: T`
        if (ts.isHeritageClause(c) && c.token === ts.SyntaxKind.ImplementsKeyword) return;
        if (isTypeOnlyStatement(c)) return;
        visit(c, r, n);
      },
      (arr) => {
        const r = roleOf(n, arr);
        if (TYPE_ROLES.has(r)) return;
        out.push(`${r}=[`); // a trailing comma (arr.hasTrailingComma) is not recorded
        for (const c of arr) {
          if (isTypeOnlyStatement(c)) continue;
          if (ts.isParameter(c) && ts.isIdentifier(c.name) && c.name.text === "this") continue;
          if (ts.isHeritageClause(c) && c.token === ts.SyntaxKind.ImplementsKeyword) continue;
          visit(c, "item", n);
        }
        out.push("]");
      },
    );
    out.push(")");
  };
  visit(root, "root", undefined);
  return out;
}

function payload(n: ts.Node, role: string, parent: ts.Node | undefined, rename: ReadonlyMap<string, string>): string {
  let p = "";
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) {
    const isKey = parent !== undefined && KEY_ROLES.some(([k, r]) => parent.kind === k && role === r);
    // A shorthand binding `{ error }` is both a key and a binding: not renamed.
    const shorthandBinding = parent !== undefined && ts.isBindingElement(parent) && parent.propertyName === undefined &&
      ts.isObjectBindingPattern(parent.parent);
    const text = n.text;
    p = ` ${JSON.stringify(isKey || shorthandBinding ? text : rename.get(text) ?? text)}`;
  } else if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isBigIntLiteral(n) || ts.isRegularExpressionLiteral(n) || ts.isJsxText(n)) {
    p = ` ${JSON.stringify(n.text)}`;
  } else if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
    // Cooked and raw: a tagged template (String.raw) can read the raw text.
    p = ` ${JSON.stringify(n.text)} raw ${JSON.stringify(n.rawText ?? null)}`;
  } else if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
    p = ` ${kindName(n.operator)}`;
  } else if (ts.isMetaProperty(n)) {
    p = ` ${kindName(n.keywordToken)}`;
  } else if (ts.isHeritageClause(n)) {
    p = ` ${kindName(n.token)}`;
  } else if (ts.isVariableDeclarationList(n)) {
    const f = n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using);
    p = ` ${f === ts.NodeFlags.Let ? "let" : f === ts.NodeFlags.Const ? "const" : f === ts.NodeFlags.Using ? "using" : f === ts.NodeFlags.AwaitUsing ? "await using" : "var"}`;
  }
  if (n.flags & ts.NodeFlags.OptionalChain) p += " ?chain";
  return p;
}

// Every identifier name in a tree, for the rename bijection check.
export function identifierNames(root: ts.Node): Set<string> {
  return new Set(findAll(root, ts.isIdentifier).map((i) => i.text));
}

// The source's tokens (leaves of the tree with a width), in order. The gaps
// between consecutive tokens are pure layout: whitespace and comments.
export function tokenRanges(sf: ts.SourceFile, root: ts.Node = sf): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const walk = (n: ts.Node) => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const kids = n.getChildren(sf);
    if (kids.length === 0) {
      const start = n.getStart(sf);
      if (n.end > start) out.push({ start, end: n.end });
      return;
    }
    kids.forEach(walk);
  };
  walk(root);
  return out;
}

export type Gap = { text: string; index: number; prev: string; next: string; prevEnd: number };

// Rewrite only the layout between tokens: `f` gets each gap (whitespace and
// comments between two tokens) and returns its replacement. The edited text is
// re-parsed (it must parse) and its tokens must be the original tokens, in
// order, byte for byte: only layout changed. Whether the PARSE changed (a line
// break where ASI depends on it) is exactly what astKey then decides.
export function editLayout(text: string, f: (gap: Gap) => string, label = "layout edit"): string {
  const sf = parseTs(text, label);
  const toks = tokenRanges(sf);
  let out = text.slice(0, toks[0]?.start ?? text.length);
  toks.forEach((t, k) => {
    out += text.slice(t.start, t.end);
    const next = toks[k + 1];
    if (next === undefined) out += text.slice(t.end);
    else out += f({ text: text.slice(t.end, next.start), index: k, prev: text.slice(t.start, t.end), next: text.slice(next.start, next.end), prevEnd: t.end });
  });
  const after = parseTs(out, `${label} (edited)`);
  const a = toks.map((t) => text.slice(t.start, t.end));
  const b = tokenRanges(after).map((t) => out.slice(t.start, t.end));
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`setup: ${label} changed a token, not only layout`);
  return out;
}

// The comments in a gap, as [start, end) ranges within it. A gap holds only
// whitespace and comments, so the trivia scanner reads it without context.
export function commentRanges(gap: string): Array<{ start: number; end: number; multiLine: boolean }> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, gap);
  const out: Array<{ start: number; end: number; multiLine: boolean }> = [];
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    if (k === ts.SyntaxKind.SingleLineCommentTrivia || k === ts.SyntaxKind.MultiLineCommentTrivia) {
      out.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), multiLine: k === ts.SyntaxKind.MultiLineCommentTrivia });
    } else if (k !== ts.SyntaxKind.WhitespaceTrivia && k !== ts.SyntaxKind.NewLineTrivia) {
      throw new Error(`setup: a layout gap holds a ${kindName(k)}`);
    }
  }
  return out;
}

export const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

// Where an expression first occurs in a tree, and how often, by tree shape: a
// needle such as `applyFragmentGate(db, thoughtId, guarded)` matches whatever
// the layout and comments around it.
export function treeFind(root: ts.Node, needle: string): { at: number; count: number; nodes: ts.Node[] } {
  const nsf = parseTs(needle, "needle");
  setupOne(nsf.statements.length === 1 && ts.isExpressionStatement(nsf.statements[0]), "the needle is one expression");
  const expr = (nsf.statements[0] as ts.ExpressionStatement).expression;
  const want = JSON.stringify(astKey(expr));
  // Only nodes of the needle's own kind: an erased `as`/`!` wrapper or a
  // grouping parenthesis keys like the expression inside it and is not a
  // second occurrence.
  const nodes = findAll(root, (n) => n.kind === expr.kind && JSON.stringify(astKey(n)) === want);
  return { at: nodes.length ? nodes[0].getStart() : -1, count: nodes.length, nodes };
}

function setupOne(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`setup: ${msg}`);
}
