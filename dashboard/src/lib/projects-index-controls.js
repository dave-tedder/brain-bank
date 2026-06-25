const CLOSED_STATUS_TOKENS = new Set(["done", "archive"]);

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

function hasClosedStatus(statuses) {
  return statuses.some((status) => CLOSED_STATUS_TOKENS.has(status));
}

export function normalizeProjectsIndexParams(
  params,
  typeTokens,
  statusTokens
) {
  const selectedTypes = parseTokens(params.type, typeTokens);
  const selectedStatuses = parseTokens(params.status, statusTokens);

  return {
    selectedTypes,
    selectedStatuses,
    view: params.view === "log" ? "log" : "grid",
    sort: params.sort === "name" ? "name" : "updated",
    offset: parseOffset(params.offset),
    includeArchived:
      params.include === "archived" || hasClosedStatus(selectedStatuses),
  };
}

export function buildProjectsUrl({
  types = [],
  statuses = [],
  view = "grid",
  sort = "updated",
  offset = 0,
  includeArchived = false,
}) {
  const shouldIncludeArchived = includeArchived || hasClosedStatus(statuses);
  const parts = [];

  if (types.length > 0) parts.push(`type=${types.join(",")}`);
  if (statuses.length > 0) parts.push(`status=${statuses.join(",")}`);
  if (view === "log") parts.push("view=log");
  if (sort === "name") parts.push("sort=name");
  if (shouldIncludeArchived) parts.push("include=archived");
  if (offset && offset > 0) parts.push(`offset=${offset}`);

  return `/projects${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
}
