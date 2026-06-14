// Extract a JSON object from an LLM response that may be fenced or followed
// by prose. Callers still own JSON.parse and must fail closed on malformed data.
//
// Known limitation: unfenced trailing prose containing another closing brace
// is over-captured by lastIndexOf. JSON.parse then throws, so auto-resolve
// returns no matches rather than risking an incorrect resolution.
export function extractJsonObject(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenceMatch ? fenceMatch[1] : raw;
  const braceStart = candidate.indexOf("{");
  const braceEnd = candidate.lastIndexOf("}");

  return braceStart >= 0 && braceEnd > braceStart
    ? candidate.slice(braceStart, braceEnd + 1)
    : candidate.trim();
}
