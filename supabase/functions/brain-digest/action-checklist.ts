export interface DigestActionRow {
  id: string;
  description: string;
  created_at: string;
}

export function renderOpenActionChecklist(
  rows: DigestActionRow[],
  total: number = rows.length,
): string {
  if (rows.length === 0) return "";

  const lines = rows.map((row) => `- [ ] ${row.description} (${row.id})`);
  if (total > rows.length) {
    lines.push(
      `_Showing ${rows.length} of ${total} open action items. ${
        total - rows.length
      } more remain open._`,
    );
  }

  return `## Open Action Items\n\n${lines.join("\n")}`;
}
