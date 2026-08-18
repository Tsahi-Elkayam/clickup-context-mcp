import type { ClickUpClient } from "./clickup.js";

/**
 * Workspace administration: the Space/Folder/List hierarchy, members, Goals,
 * and webhooks. All v2. Grouped in one module because each is a handful of
 * endpoints that share the same "list / create / rename / delete" shape.
 */

export type Kind = "space" | "folder" | "list";

export interface Container {
  id: string;
  name?: string;
  archived?: boolean;
  task_count?: number | string;
  folder?: { id?: string; name?: string };
  space?: { id?: string; name?: string };
}

/**
 * Where a container lives. Spaces hang off the workspace; Folders off a Space;
 * Lists off either a Folder or — "folderless" — a Space directly. Returning
 * null rather than throwing lets callers phrase the error in tool terms.
 */
function parentPath(client: ClickUpClient, kind: Kind, spaceId?: string, folderId?: string): string | null {
  if (kind === "space") return `/team/${client.teamId}/space`;
  if (kind === "folder") return spaceId ? `/space/${encodeURIComponent(spaceId)}/folder` : null;
  if (folderId) return `/folder/${encodeURIComponent(folderId)}/list`;
  return spaceId ? `/space/${encodeURIComponent(spaceId)}/list` : null;
}

export function parentHint(kind: Kind): string {
  if (kind === "folder") return "space_id is required for folders.";
  return "list needs folder_id, or space_id for a folderless List.";
}

export async function listContainers(
  client: ClickUpClient,
  kind: Kind,
  spaceId?: string,
  folderId?: string
): Promise<Container[] | null> {
  const path = parentPath(client, kind, spaceId, folderId);
  if (!path) return null;
  const data = await client.get<{ spaces?: Container[]; folders?: Container[]; lists?: Container[] }>(
    path,
    { archived: "false" }
  );
  return data.spaces ?? data.folders ?? data.lists ?? [];
}

export async function createContainer(
  client: ClickUpClient,
  kind: Kind,
  name: string,
  spaceId?: string,
  folderId?: string
): Promise<Container | null> {
  const path = parentPath(client, kind, spaceId, folderId);
  if (!path) return null;
  // A Space with multiple_assignees off rejects multi-assignee tasks later;
  // ClickUp's own default is on, so match it rather than inventing a stricter one.
  const body = kind === "space" ? { name, multiple_assignees: true } : { name };
  return client.request<Container>("POST", path, {}, body);
}

export function renameContainer(
  client: ClickUpClient,
  kind: Kind,
  id: string,
  name: string
): Promise<Container> {
  return client.request<Container>("PUT", `/${kind}/${encodeURIComponent(id)}`, {}, { name });
}

export function deleteContainer(client: ClickUpClient, kind: Kind, id: string): Promise<unknown> {
  return client.request<unknown>("DELETE", `/${kind}/${encodeURIComponent(id)}`);
}

export function renderContainers(kind: Kind, items: Container[]): string {
  if (!items.length) return `No ${kind}s found there.`;
  const rows = items.map(
    (c) =>
      `| \`${c.id}\` | ${c.name ?? "—"} | ${c.task_count ?? "—"} | ${c.folder?.name ?? c.space?.name ?? "—"} |`
  );
  return `# ${items.length} ${kind}(s)\n\n| ID | Name | Tasks | Parent |\n|---|---|---|---|\n${rows.join("\n")}`;
}

// ---------------------------------------------------------------- members

export interface Member {
  user?: { id?: number; username?: string; email?: string; role?: number };
  invited_by?: unknown;
}

const ROLES: Record<number, string> = { 1: "owner", 2: "admin", 3: "member", 4: "guest" };

/**
 * Members come from the authorized-teams endpoint — there is no
 * /team/{id}/member on v2 — so pick our workspace out of the list.
 */
export async function listMembers(client: ClickUpClient): Promise<Member[]> {
  const data = await client.get<{ teams?: { id?: string; members?: Member[] }[] }>("/team");
  const team = (data.teams ?? []).find((t) => String(t.id) === String(client.teamId));
  return team?.members ?? [];
}

export function renderMembers(members: Member[]): string {
  if (!members.length) return "No members visible to this token.";
  const rows = members.map((m) => {
    const u = m.user ?? {};
    return `| ${u.id ?? "—"} | ${u.username ?? "—"} | ${u.email ?? "—"} | ${ROLES[u.role ?? 0] ?? u.role ?? "—"} |`;
  });
  return (
    `# ${members.length} member(s)\n\n` +
    `| User ID | Username | Email | Role |\n|---|---|---|---|\n${rows.join("\n")}\n\n` +
    `_User IDs are what \`assignees\` filters and task assignment expect._`
  );
}

export interface Workspace {
  id?: string;
  name?: string;
  members?: Member[];
}

/** Every workspace this token can reach. The token is not scoped to one. */
export async function listWorkspaces(client: ClickUpClient): Promise<Workspace[]> {
  const data = await client.get<{ teams?: Workspace[] }>("/team");
  return data.teams ?? [];
}

export function renderWorkspaces(workspaces: Workspace[], current: string): string {
  if (!workspaces.length) return "This token can't see any workspaces.";
  const rows = workspaces.map(
    (w) =>
      `| \`${w.id}\` | ${w.name ?? "—"} | ${w.members?.length ?? "—"} | ${
        String(w.id) === String(current) ? "**current**" : "—"
      } |`
  );
  return (
    `# ${workspaces.length} workspace(s)\n\n| ID | Name | Members | |\n|---|---|---|---|\n${rows.join("\n")}` +
    `\n\n_Pass \`workspace_id\` to any workspace-scoped tool to work in another one._`
  );
}

// ------------------------------------------------------------------ goals

export interface Goal {
  id: string;
  name?: string;
  due_date?: string;
  description?: string;
  percent_completed?: number;
  owners?: { username?: string }[];
}

export async function listGoals(client: ClickUpClient): Promise<Goal[]> {
  const data = await client.get<{ goals?: Goal[] }>(`/team/${client.teamId}/goal`);
  return data.goals ?? [];
}

export function createGoal(
  client: ClickUpClient,
  body: { name: string; due_date?: number; description?: string; owners?: number[] }
): Promise<{ goal?: Goal }> {
  return client.request<{ goal?: Goal }>("POST", `/team/${client.teamId}/goal`, {}, {
    ...body,
    multiple_owners: (body.owners?.length ?? 0) > 1,
  });
}

export function updateGoal(
  client: ClickUpClient,
  goalId: string,
  body: { name?: string; due_date?: number; description?: string; add_owners?: number[]; rem_owners?: number[] }
): Promise<{ goal?: Goal }> {
  return client.request<{ goal?: Goal }>("PUT", `/goal/${encodeURIComponent(goalId)}`, {}, body);
}

export function deleteGoal(client: ClickUpClient, goalId: string): Promise<unknown> {
  return client.request<unknown>("DELETE", `/goal/${encodeURIComponent(goalId)}`);
}

export function renderGoals(goals: Goal[]): string {
  if (!goals.length) return "No Goals in this workspace.";
  const rows = goals.map((g) => {
    const due = g.due_date ? new Date(Number(g.due_date)).toISOString().slice(0, 10) : "—";
    const owners = (g.owners ?? []).map((o) => o.username).filter(Boolean).join(", ") || "—";
    return `| \`${g.id}\` | ${g.name ?? "—"} | ${Math.round(g.percent_completed ?? 0)}% | ${due} | ${owners} |`;
  });
  return `# ${goals.length} Goal(s)\n\n| ID | Name | Progress | Due | Owners |\n|---|---|---|---|---|\n${rows.join("\n")}`;
}

// --------------------------------------------------------------- webhooks

export interface Webhook {
  id: string;
  endpoint?: string;
  events?: string[] | string;
  status?: string;
  health?: { status?: string; fail_count?: number };
}

export async function listWebhooks(client: ClickUpClient): Promise<Webhook[]> {
  const data = await client.get<{ webhooks?: Webhook[] }>(`/team/${client.teamId}/webhook`);
  return data.webhooks ?? [];
}

export function createWebhook(
  client: ClickUpClient,
  body: { endpoint: string; events: string[]; space_id?: string; folder_id?: string; list_id?: string; task_id?: string }
): Promise<{ id?: string; webhook?: Webhook }> {
  return client.request("POST", `/team/${client.teamId}/webhook`, {}, body);
}

export function updateWebhook(
  client: ClickUpClient,
  webhookId: string,
  body: { endpoint?: string; events?: string[]; status?: string }
): Promise<{ webhook?: Webhook }> {
  return client.request("PUT", `/webhook/${encodeURIComponent(webhookId)}`, {}, body);
}

export function deleteWebhook(client: ClickUpClient, webhookId: string): Promise<unknown> {
  return client.request<unknown>("DELETE", `/webhook/${encodeURIComponent(webhookId)}`);
}

export function renderWebhooks(hooks: Webhook[]): string {
  if (!hooks.length) return "No webhooks registered for this workspace.";
  const rows = hooks.map((w) => {
    const events = Array.isArray(w.events) ? w.events.join(", ") : (w.events ?? "—");
    const health = w.health?.status
      ? `${w.health.status}${w.health.fail_count ? ` (${w.health.fail_count} fails)` : ""}`
      : "—";
    return `| \`${w.id}\` | ${w.endpoint ?? "—"} | ${events} | ${w.status ?? "—"} | ${health} |`;
  });
  return `# ${hooks.length} webhook(s)\n\n| ID | Endpoint | Events | Status | Health |\n|---|---|---|---|---|\n${rows.join("\n")}`;
}
