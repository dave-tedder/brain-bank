export interface WikiLintPage {
  slug: string;
  page_type: string;
}

export function selectContradictionLintPages<T extends WikiLintPage>(
  pages: T[],
  curatedProjectSlugs: Set<string>,
): T[] {
  return pages.filter((page) => {
    if (page.page_type === "client") return true;
    if (page.page_type !== "project") return false;

    const projectSlug = page.slug.startsWith("project/")
      ? page.slug.slice("project/".length)
      : page.slug;
    return curatedProjectSlugs.has(projectSlug);
  });
}
