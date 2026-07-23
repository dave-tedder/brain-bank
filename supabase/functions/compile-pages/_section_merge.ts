// Section-merge helpers for structured-edit synthesis.
//
// The compile-pages function asks the LLM to emit an <edits> XML block instead
// of regenerating the entire page on every compile. This module parses the
// existing page into H2-keyed sections, parses the LLM's edit instructions,
// and reserializes the result. Compile output cost is O(change_size), not
// O(page_size), which is what kept high-traffic pages in the 2026-05-11
// timeout death loop.

export type EditAction = "prepend" | "update" | "append" | "create";

export interface SectionEdit {
  name: string;
  action: EditAction;
  content: string;
}

// Header regex: a line that starts with "## " and a non-empty name, optional
// CR before the LF. Capturing group 1 is the section name. The split() call
// below consumes the entire header line including the newline, so section
// bodies start at the first character after that newline and run up to the
// next header (or EOF).
const SECTION_HEADER_RE = /^## (.+)\r?\n/gm;

const SECTION_TAG_RE =
  /<section\s+name="([^"]+)"\s+action="(prepend|update|append|create)"\s*>([\s\S]*?)<\/section>/g;

const CDATA_WRAPPER_RE = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

// Pre-first-H2 preamble is stored under the empty-string key. Section names
// are otherwise as they appear in the source (case-sensitive, whitespace
// preserved). Insertion order is preserved by Map semantics.
const PREAMBLE_KEY = "";

export function parsePageSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = content.split(SECTION_HEADER_RE);
  sections.set(PREAMBLE_KEY, parts[0] ?? "");
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const body = parts[i + 1] ?? "";
    sections.set(name, body);
  }
  return sections;
}

export function serializePage(sections: Map<string, string>): string {
  let out = sections.get(PREAMBLE_KEY) ?? "";
  for (const [name, body] of sections) {
    if (name === PREAMBLE_KEY) continue;
    // Guarantee separation from the next header. Empty bodies stay empty so
    // the section is just "## Name\n".
    const normalizedBody = body === "" || body.endsWith("\n") ? body : body + "\n";
    out += `## ${name}\n${normalizedBody}`;
  }
  return out;
}

export function parseEditsXml(xml: string): SectionEdit[] {
  const wrapped = xml.match(/<edits>([\s\S]*?)<\/edits>/);
  const inner = wrapped ? wrapped[1] : xml;
  const edits: SectionEdit[] = [];
  for (const match of inner.matchAll(SECTION_TAG_RE)) {
    const name = match[1];
    const action = match[2] as EditAction;
    let content = match[3];
    const cdata = content.match(CDATA_WRAPPER_RE);
    if (cdata) content = cdata[1];
    if (name.length === 0) continue;
    edits.push({ name, action, content });
  }
  return edits;
}

export function applyEdits(existing: string, edits: SectionEdit[]): string {
  const sections = parsePageSections(existing);
  for (const edit of edits) {
    if (edit.name === PREAMBLE_KEY) continue;
    switch (edit.action) {
      case "update": {
        if (!sections.has(edit.name)) {
          console.warn(
            `[applyEdits] Unknown section "${edit.name}" with action=update; treating as create`,
          );
        }
        sections.set(edit.name, edit.content);
        break;
      }
      case "prepend": {
        const prior = sections.get(edit.name) ?? "";
        sections.set(edit.name, edit.content + prior);
        break;
      }
      case "append": {
        const prior = sections.get(edit.name) ?? "";
        sections.set(edit.name, prior + edit.content);
        break;
      }
      case "create": {
        sections.set(edit.name, edit.content);
        break;
      }
    }
  }
  return serializePage(sections);
}
