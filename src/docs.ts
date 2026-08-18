import type { ClickUpClient } from "./clickup.js";

/**
 * ClickUp Docs live on the v3 API under /workspaces/{id}/docs. The "search"
 * endpoint is a *listing* — it filters by parent and archived state but has no
 * free-text parameter — so name matching happens client-side here, the same way
 * resolver.ts ranks tasks.
 */

export interface Doc {
  id: string;
  name?: string;
  date_updated?: number;
  archived?: boolean;
  parent?: { id?: string; type?: number };
}

export interface Page {
  id: string;
  doc_id?: string;
  parent_page_id?: string;
  name?: string;
  sub_title?: string;
  content?: string;
  pages?: Page[];
}

/** `parent_type` values the v3 API accepts, lowercased for the tool schema. */
export const PARENT_TYPES = ["SPACE", "FOLDER", "LIST", "EVERYTHING", "WORKSPACE"] as const;
export type ParentType = (typeof PARENT_TYPES)[number];

/** Doc `parent.type` is a magic number on create; the names are the API's own. */
const PARENT_TYPE_CODE: Record<ParentType, number> = {
  SPACE: 4,
  FOLDER: 5,
  LIST: 6,
  EVERYTHING: 7,
  WORKSPACE: 12,
};

function docsPath(client: ClickUpClient, suffix = ""): string {
  return `/workspaces/${client.teamId}/docs${suffix}`;
}

/**
 * Page through workspace docs. `maxPages` bounds the walk the same way
 * searchPageLimit bounds task search — an unbounded loop over a big workspace
 * would burn the whole per-minute budget on one call.
 */
export async function listDocs(
  client: ClickUpClient,
  opts: { parentId?: string; parentType?: ParentType; archived?: boolean; maxPages?: number } = {}
): Promise<{ docs: Doc[]; exhausted: boolean }> {
  const out: Doc[] = [];
  let cursor: string | undefined;
  const maxPages = opts.maxPages ?? 3;
  for (let page = 0; page < maxPages; page++) {
    const data = await client.get<{ docs?: Doc[]; results?: Doc[]; next_cursor?: string }>(
      docsPath(client),
      {
        limit: "50",
        cursor,
        parent_id: opts.parentId,
        parent_type: opts.parentType,
        archived: opts.archived === undefined ? undefined : String(opts.archived),
      },
      "v3"
    );
    // The v3 responses are inconsistent about the collection key across
    // endpoints, so accept either rather than returning a silent empty list.
    out.push(...(data.docs ?? data.results ?? []));
    cursor = data.next_cursor || undefined;
    if (!cursor) return { docs: out, exhausted: true };
  }
  return { docs: out, exhausted: false };
}

/** Score a doc name against a query. Same shape as the task ranker. */
export function scoreName(name: string, query: string): number {
  const n = name.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (n === q) return 100;
  if (n.includes(q)) return 60;
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  return (words.filter((w) => n.includes(w)).length / words.length) * 40;
}

export function rankDocs(docs: Doc[], query: string): Doc[] {
  if (!query.trim()) return docs;
  return docs
    .map((d) => ({ d, score: scoreName(d.name ?? "", query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d);
}

/** Flat page tree (id + name + nesting depth) without fetching any content. */
export async function pageListing(client: ClickUpClient, docId: string): Promise<Page[]> {
  return client.get<Page[]>(
    docsPath(client, `/${encodeURIComponent(docId)}/page_listing`),
    { max_page_depth: "-1" },
    "v3"
  );
}

/** Every page of a doc, content included, as markdown. */
export async function docPages(client: ClickUpClient, docId: string): Promise<Page[]> {
  return client.get<Page[]>(
    docsPath(client, `/${encodeURIComponent(docId)}/pages`),
    { content_format: "text/md", max_page_depth: "-1" },
    "v3"
  );
}

export function createDoc(
  client: ClickUpClient,
  name: string,
  parent?: { id: string; type: ParentType }
): Promise<Doc> {
  return client.request<Doc>("POST", docsPath(client), {}, {
    name,
    parent: parent ? { id: parent.id, type: PARENT_TYPE_CODE[parent.type] } : undefined,
    create_page: true,
  }, "v3");
}

export function createPage(
  client: ClickUpClient,
  docId: string,
  body: { name: string; content?: string; sub_title?: string; parent_page_id?: string }
): Promise<Page> {
  return client.request<Page>(
    "POST",
    docsPath(client, `/${encodeURIComponent(docId)}/pages`),
    {},
    body,
    "v3"
  );
}

export function editPage(
  client: ClickUpClient,
  docId: string,
  pageId: string,
  body: {
    name?: string;
    sub_title?: string;
    content?: string;
    /** `replace` overwrites the page. Default `append` here — see write_doc. */
    content_edit_mode?: "replace" | "append" | "prepend";
  }
): Promise<unknown> {
  return client.request<unknown>(
    "PUT",
    docsPath(client, `/${encodeURIComponent(docId)}/pages/${encodeURIComponent(pageId)}`),
    {},
    { ...body, content_format: "text/md" },
    "v3"
  );
}

export function renderDocs(docs: Doc[], exhausted: boolean): string {
  if (!docs.length) return "No Docs matched.";
  const rows = docs.map((d) => {
    const when = d.date_updated
      ? new Date(Number(d.date_updated)).toISOString().slice(0, 10)
      : "—";
    return `| \`${d.id}\` | ${d.name ?? "(untitled)"} | ${when} | ${d.archived ? "archived" : "—"} |`;
  });
  const more = exhausted ? "" : "\n\n_Page cap reached — more Docs may exist._";
  return `# ${docs.length} Doc(s)\n\n| ID | Name | Updated | State |\n|---|---|---|---|\n${rows.join("\n")}${more}`;
}

/** Render pages depth-first so sub-pages stay under their parent. */
export function renderPages(pages: Page[], depth = 0): string {
  return pages
    .map((p) => {
      const heading = `${"#".repeat(Math.min(depth + 2, 6))} ${p.name ?? "(untitled)"} \`${p.id}\``;
      const sub = p.sub_title ? `\n_${p.sub_title}_` : "";
      const body = p.content?.trim() ? `\n\n${p.content.trim()}` : "";
      const kids = p.pages?.length ? `\n\n${renderPages(p.pages, depth + 1)}` : "";
      return `${heading}${sub}${body}${kids}`;
    })
    .join("\n\n");
}
