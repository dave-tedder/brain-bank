function parseTokens(raw, valid) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => valid.includes(token));
}

function parseOffset(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function normalizeTasksIndexParams(params, statusTokens, agentTokens) {
  return {
    selectedStatuses: parseTokens(params.status, statusTokens),
    selectedAgents: parseTokens(params.agent, agentTokens),
    risk: params.risk === "low" || params.risk === "high" ? params.risk : params.risk === "medium" ? "medium" : "all",
    sort: params.sort === "oldest" ? "oldest" : "updated",
    offset: parseOffset(params.offset),
  };
}

export function buildTasksUrl({
  statuses = [],
  agents = [],
  risk = "all",
  sort = "updated",
  offset = 0,
}) {
  const parts = [];

  if (statuses.length > 0) parts.push(`status=${statuses.join(",")}`);
  if (agents.length > 0) parts.push(`agent=${agents.join(",")}`);
  if (risk !== "all") parts.push(`risk=${risk}`);
  if (sort === "oldest") parts.push("sort=oldest");
  if (offset && offset > 0) parts.push(`offset=${offset}`);

  return `/tasks${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
}
