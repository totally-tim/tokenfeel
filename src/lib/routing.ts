export type PageId = "landing" | "playground" | "race" | "configs" | "method" | "contribute";

export const pageIds: PageId[] = ["landing", "playground", "race", "configs", "method", "contribute"];

export interface HashRoute {
  page: PageId;
  params: URLSearchParams;
}

export function parseHashRoute(hash: string): HashRoute {
  const [rawPage = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const page = pageIds.includes(rawPage as PageId) ? (rawPage as PageId) : "landing";
  return {
    page,
    params: new URLSearchParams(query)
  };
}

export function pageFromHashValue(hash: string): PageId {
  return parseHashRoute(hash).page;
}

export function buildPageHash(page: PageId, params = new URLSearchParams()): string {
  const query = params.toString();
  if (page === "landing") return "#";
  return query ? `#${page}?${query}` : `#${page}`;
}
