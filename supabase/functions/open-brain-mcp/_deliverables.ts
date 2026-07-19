// Pure helpers for the Phase 2 deliverable artifact verbs (decision D4). New
// file: supabase/functions/open-brain-mcp/_deliverables.ts
//
// Everything here is pure and Deno-testable. The storage calls stay in
// index.ts; these helpers are the server-enforced path scope that makes the
// bucket safe to expose over the shared x-brain-key.

export const DELIVERABLES_BUCKET = "deliverables";
export const DELIVERABLE_MAX_BYTES = 512 * 1024; // matches the bucket's file_size_limit

// <project-slug>/<filename>.<ext> — exactly one folder level, no dotfiles, no
// traversal, extensions limited to the text formats deliverables actually use.
// Mirrors the client-side check in deliverables-bucket-sync.sh.
const DELIVERABLE_PATH_PATTERN =
  /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\.(md|html|txt|json|csv)$/;

export function validateDeliverablePath(path: string): string {
  if (typeof path !== "string") throw new Error("path is required.");
  const cleaned = (path ?? "").trim();
  if (!cleaned) throw new Error("path is required.");
  if (cleaned.length > 200) {
    throw new Error("path must be 200 characters or fewer.");
  }
  if (cleaned.includes("..") || cleaned.startsWith("/")) {
    throw new Error("path must be a relative <project-slug>/<filename> path.");
  }
  if (!DELIVERABLE_PATH_PATTERN.test(cleaned)) {
    throw new Error(
      "path must look like <project-slug>/<filename>.<md|html|txt|json|csv> " +
        "(lowercase slug folder, one level, plain filename).",
    );
  }
  return cleaned;
}

export function validateDeliverableContent(content: string): string {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("content is required.");
  }
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > DELIVERABLE_MAX_BYTES) {
    throw new Error(
      `content is ${bytes} bytes; the deliverable cap is ${DELIVERABLE_MAX_BYTES}.`,
    );
  }
  return content;
}

export function deliverableContentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".csv")) return "text/csv";
  if (path.endsWith(".txt")) return "text/plain";
  return "text/markdown";
}
