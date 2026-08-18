import type { ClickUpClient, QueryParams } from "./clickup.js";

/**
 * The structure hanging off a task: dependencies, task-to-task links, and
 * checklists. get_schedule already *reads* dependencies to compute the critical
 * path; this is the other half — being able to create the edges it walks.
 */

/**
 * ClickUp expresses a dependency from whichever side you call it on:
 * `depends_on` means "this task waits for that one", `dependency_of` means
 * "that one waits for this". Same edge, opposite direction — getting these
 * backwards silently inverts the schedule, so the tool names the direction.
 */
export function addDependency(
  client: ClickUpClient,
  taskId: string,
  other: string,
  direction: "waits_for" | "blocks",
  useCustomId = false
): Promise<unknown> {
  const body =
    direction === "waits_for" ? { depends_on: other } : { dependency_of: other };
  return client.request<unknown>(
    "POST",
    `/task/${encodeURIComponent(taskId)}/dependency`,
    client.customIdParams(useCustomId),
    body
  );
}

export function removeDependency(
  client: ClickUpClient,
  taskId: string,
  other: string,
  direction: "waits_for" | "blocks",
  useCustomId = false
): Promise<unknown> {
  // The delete takes the pair as query params, not a body.
  const params: QueryParams = {
    ...client.customIdParams(useCustomId),
    ...(direction === "waits_for" ? { depends_on: other } : { dependency_of: other }),
  };
  return client.request<unknown>(
    "DELETE",
    `/task/${encodeURIComponent(taskId)}/dependency`,
    params
  );
}

/** A link is an undirected "see also" — no scheduling meaning, unlike a dependency. */
export function linkTasks(
  client: ClickUpClient,
  taskId: string,
  linksTo: string,
  useCustomId = false
): Promise<unknown> {
  return client.request<unknown>(
    "POST",
    `/task/${encodeURIComponent(taskId)}/link/${encodeURIComponent(linksTo)}`,
    client.customIdParams(useCustomId)
  );
}

export function unlinkTasks(
  client: ClickUpClient,
  taskId: string,
  linksTo: string,
  useCustomId = false
): Promise<unknown> {
  return client.request<unknown>(
    "DELETE",
    `/task/${encodeURIComponent(taskId)}/link/${encodeURIComponent(linksTo)}`,
    client.customIdParams(useCustomId)
  );
}

// ------------------------------------------------------------- checklists

export interface ChecklistItem {
  id: string;
  name?: string;
  resolved?: boolean;
  assignee?: { username?: string } | null;
}

export interface Checklist {
  id: string;
  name?: string;
  resolved?: number;
  unresolved?: number;
  items?: ChecklistItem[];
}

export function createChecklist(
  client: ClickUpClient,
  taskId: string,
  name: string,
  useCustomId = false
): Promise<{ checklist?: Checklist }> {
  return client.request(
    "POST",
    `/task/${encodeURIComponent(taskId)}/checklist`,
    client.customIdParams(useCustomId),
    { name }
  );
}

export function renameChecklist(
  client: ClickUpClient,
  checklistId: string,
  name: string
): Promise<{ checklist?: Checklist }> {
  return client.request("PUT", `/checklist/${encodeURIComponent(checklistId)}`, {}, { name });
}

export function deleteChecklist(client: ClickUpClient, checklistId: string): Promise<unknown> {
  return client.request<unknown>("DELETE", `/checklist/${encodeURIComponent(checklistId)}`);
}

export function addChecklistItem(
  client: ClickUpClient,
  checklistId: string,
  name: string,
  assignee?: number
): Promise<{ checklist?: Checklist }> {
  return client.request(
    "POST",
    `/checklist/${encodeURIComponent(checklistId)}/checklist_item`,
    {},
    { name, assignee }
  );
}

export function editChecklistItem(
  client: ClickUpClient,
  checklistId: string,
  itemId: string,
  body: { name?: string; resolved?: boolean; assignee?: number | null }
): Promise<{ checklist?: Checklist }> {
  return client.request(
    "PUT",
    `/checklist/${encodeURIComponent(checklistId)}/checklist_item/${encodeURIComponent(itemId)}`,
    {},
    body
  );
}

export function deleteChecklistItem(
  client: ClickUpClient,
  checklistId: string,
  itemId: string
): Promise<unknown> {
  return client.request<unknown>(
    "DELETE",
    `/checklist/${encodeURIComponent(checklistId)}/checklist_item/${encodeURIComponent(itemId)}`
  );
}

export function renderChecklists(checklists: Checklist[]): string {
  if (!checklists.length) return "No checklists on this task.";
  return checklists
    .map((c) => {
      const items = (c.items ?? []).map(
        (i) =>
          `  - [${i.resolved ? "x" : " "}] ${i.name ?? "(unnamed)"}` +
          `${i.assignee?.username ? ` — @${i.assignee.username}` : ""} \`${i.id}\``
      );
      const head = `**${c.name ?? "(unnamed)"}** \`${c.id}\` — ${c.resolved ?? 0}/${
        (c.resolved ?? 0) + (c.unresolved ?? 0)
      } done`;
      return items.length ? `${head}\n${items.join("\n")}` : head;
    })
    .join("\n\n");
}
