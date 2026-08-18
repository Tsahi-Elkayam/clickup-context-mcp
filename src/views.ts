import type { ClickUpClient } from "./clickup.js";
import type { Task } from "./clickup.js";

/**
 * Views and task templates. A View is the saved filter+grouping a team actually
 * works out of ("My Sprint", "Blocked"), so reading one answers "what does the
 * board show" in a way a raw query_tasks filter can't — the filter lives in
 * ClickUp, not in the arguments.
 */

export interface View {
  id: string;
  name?: string;
  type?: string;
  parent?: { id?: string; type?: number };
}

export type ViewParent = "list" | "folder" | "space" | "team";

export async function listViews(
  client: ClickUpClient,
  parent: ViewParent,
  parentId?: string
): Promise<View[]> {
  const id = parent === "team" ? client.teamId : parentId;
  if (!id) return [];
  const data = await client.get<{ views?: View[]; required_views?: Record<string, View> }>(
    `/${parent}/${encodeURIComponent(id)}/view`
  );
  // ClickUp splits the built-in views ("List", "Board") into `required_views`
  // and the team's saved ones into `views`. Both are real views to a user.
  const required = Object.values(data.required_views ?? {}).filter((v) => v && v.id);
  return [...(data.views ?? []), ...required];
}

export async function viewTasks(
  client: ClickUpClient,
  viewId: string,
  maxPages = 2
): Promise<{ tasks: Task[]; exhausted: boolean }> {
  const out: Task[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await client.get<{ tasks?: Task[]; last_page?: boolean }>(
      `/view/${encodeURIComponent(viewId)}/task`,
      { page: String(page) }
    );
    const tasks = data.tasks ?? [];
    out.push(...tasks);
    if (data.last_page || !tasks.length) return { tasks: out, exhausted: true };
  }
  return { tasks: out, exhausted: false };
}

export function renderViews(views: View[]): string {
  if (!views.length) return "No views found there.";
  const rows = views.map((v) => `| \`${v.id}\` | ${v.name ?? "—"} | ${v.type ?? "—"} |`);
  return `# ${views.length} view(s)\n\n| View ID | Name | Type |\n|---|---|---|\n${rows.join("\n")}`;
}

// -------------------------------------------------------------- templates

export interface TaskTemplate {
  id: string;
  name?: string;
}

export async function listTemplates(client: ClickUpClient): Promise<TaskTemplate[]> {
  const data = await client.get<{ templates?: TaskTemplate[] }>(
    `/team/${client.teamId}/taskTemplate`,
    { page: "0" }
  );
  return data.templates ?? [];
}

export function applyTemplate(
  client: ClickUpClient,
  listId: string,
  templateId: string,
  name: string
): Promise<{ id?: string; url?: string }> {
  return client.request(
    "POST",
    `/list/${encodeURIComponent(listId)}/taskTemplate/${encodeURIComponent(templateId)}`,
    {},
    { name }
  );
}

export function renderTemplates(templates: TaskTemplate[]): string {
  if (!templates.length) return "No task templates in this workspace.";
  return (
    `# ${templates.length} task template(s)\n\n` +
    templates.map((t) => `- \`${t.id}\` — ${t.name ?? "(unnamed)"}`).join("\n")
  );
}
