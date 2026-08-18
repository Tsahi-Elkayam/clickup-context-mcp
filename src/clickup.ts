import type { Config } from "./config.js";

export type ApiVersion = "v2" | "v3";

const API_BASE: Record<ApiVersion, string> = {
  v2: "https://api.clickup.com/api/v2",
  v3: "https://api.clickup.com/api/v3",
};

/** Query values; arrays become repeated `key[]=` params, which is what ClickUp expects. */
export type QueryParams = Record<string, string | string[] | undefined>;

export interface Attachment {
  id: string;
  title: string;
  extension: string;
  mimetype?: string;
  url: string;
  thumbnail_large?: string;
}

/**
 * A rich block inside a comment. Image uploads exist ONLY here — `comment_text`
 * flattens them to the bare filename, and they never appear in `task.attachments`.
 */
export interface CommentBlock {
  type?: string;
  image?: {
    id: string;
    name?: string;
    title?: string;
    /** Bare extension, e.g. "png". */
    type?: string;
    /** Confusingly, the mimetype, e.g. "image/png". */
    extension?: string;
    url?: string;
  };
}

export interface Comment {
  id: string;
  comment_text: string;
  comment?: CommentBlock[];
  user: { username?: string; email?: string };
  date: string;
  resolved?: boolean;
}

export interface User {
  id?: number;
  username?: string;
  email?: string;
}

/**
 * A dependency row as ClickUp returns it on a task. `type` is 0 when this task
 * waits on `depends_on`, 1 when it blocks it.
 */
export interface Dependency {
  task_id: string;
  depends_on: string;
  type?: number;
}

export interface Task {
  id: string;
  custom_id?: string | null;
  name: string;
  description?: string;
  text_content?: string;
  status?: { status: string };
  url?: string;
  list?: { id?: string; name?: string };
  folder?: { id?: string; name?: string };
  space?: { id?: string };
  attachments?: Attachment[];
  // Schedule fields. ClickUp sends unix-millisecond timestamps as strings.
  start_date?: string | null;
  due_date?: string | null;
  time_estimate?: number | string | null;
  date_closed?: string | null;
  assignees?: User[];
  priority?: { priority?: string } | null;
  tags?: { name?: string }[];
  dependencies?: Dependency[];
  linked_tasks?: { task_id?: string; link_id?: string }[];
  checklists?: unknown[];
  parent?: string | null;
}

/** Filters for the team-task query. All optional; omitted filters aren't sent. */
export interface TaskQuery {
  listIds?: string[];
  spaceIds?: string[];
  folderIds?: string[];
  statuses?: string[];
  assignees?: string[];
  tags?: string[];
  /** Raw ClickUp custom_fields JSON, e.g. `[{"field_id":"..","operator":"=","value":"Bug"}]`. */
  customFields?: string;
  dueAfter?: number;
  dueBefore?: number;
  updatedAfter?: number;
  includeClosed?: boolean;
  subtasks?: boolean;
  orderBy?: string;
  reverse?: boolean;
  /** Pages to pull (100 tasks per page). Defaults to config.searchPageLimit. */
  pageLimit?: number;
}

/**
 * Match a human-typed status against a list's exact strings. ClickUp status
 * names carry stray spaces and periods ("moved to prod qa ."), and the API
 * rejects anything that isn't byte-identical, so "prod qa" has to find it.
 * Ambiguity returns null — a write is not the place to guess.
 */
export function resolveStatus(input: string, available: string[]): string | null {
  if (available.includes(input)) return input;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const target = norm(input);
  if (!target) return null;
  const equal = available.filter((s) => norm(s) === target);
  if (equal.length === 1) return equal[0];
  if (equal.length > 1) return null;
  const partial = available.filter((s) => norm(s).includes(target));
  return partial.length === 1 ? partial[0] : null;
}

export class ClickUpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ClickUpError";
  }
}

export class ClickUpClient {
  constructor(private readonly cfg: Config) {}

  get teamId(): string {
    return this.cfg.teamId;
  }

  /**
   * Public so sibling modules (chat) reuse one auth + error path instead of
   * re-implementing fetch. Arrays are appended as repeated `key[]` params.
   */
  async get<T>(path: string, params?: QueryParams, version: ApiVersion = "v2"): Promise<T> {
    return this.request<T>("GET", path, params, undefined, version);
  }

  /**
   * Same token, different workspace. A personal token spans every workspace the
   * user belongs to, so switching is just swapping the id we path with.
   */
  withTeam(teamId: string): ClickUpClient {
    return new ClickUpClient({ ...this.cfg, teamId });
  }

  /**
   * Multipart upload. Deliberately does NOT set Content-Type — fetch has to
   * generate the multipart boundary itself, and setting it by hand produces a
   * request ClickUp rejects with a bare 400.
   */
  async postForm<T>(path: string, form: FormData, version: ApiVersion = "v2"): Promise<T> {
    const res = await fetch(new URL(API_BASE[version] + path), {
      method: "POST",
      headers: { Authorization: this.cfg.apiToken },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ClickUpError(
        `ClickUp API ${res.status} on ${path}: ${body.slice(0, 300)}`,
        res.status
      );
    }
    return (await res.json()) as T;
  }

  /**
   * Public so the docs/time/admin modules reuse one auth + retry + error path
   * instead of each re-implementing fetch.
   */
  async request<T>(
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    params?: QueryParams,
    body?: unknown,
    version: ApiVersion = "v2"
  ): Promise<T> {
    const url = new URL(API_BASE[version] + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(`${k}[]`, item);
      } else {
        url.searchParams.set(k, v);
      }
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { Authorization: this.cfg.apiToken, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      // Rate-limited: honor Retry-After (seconds), twice, then give up loudly.
      if (res.status === 429 && attempt < 2) {
        const after = Number(res.headers.get("retry-after"));
        const waitSec = Number.isFinite(after) && after > 0 ? Math.min(after, 60) : 5 * (attempt + 1);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ClickUpError(
          `ClickUp API ${res.status} on ${path}: ${body.slice(0, 300)}`,
          res.status
        );
      }
      return (await res.json()) as T;
    }
  }

  getTask(taskId: string, useCustomId = false): Promise<Task> {
    const params: QueryParams = { include_subtasks: "false" };
    if (useCustomId) {
      params.custom_task_ids = "true";
      params.team_id = this.cfg.teamId;
    }
    return this.get<Task>(`/task/${encodeURIComponent(taskId)}`, params);
  }

  async getComments(taskId: string, useCustomId = false): Promise<Comment[]> {
    const params: QueryParams = {};
    if (useCustomId) {
      params.custom_task_ids = "true";
      params.team_id = this.cfg.teamId;
    }
    const data = await this.get<{ comments: Comment[] }>(
      `/task/${encodeURIComponent(taskId)}/comment`,
      params
    );
    return data.comments ?? [];
  }

  /** The statuses a list actually accepts, in workspace order. */
  async listStatuses(listId: string): Promise<string[]> {
    const data = await this.get<{ statuses?: { status: string }[] }>(
      `/list/${encodeURIComponent(listId)}`
    );
    return (data.statuses ?? []).map((s) => s.status);
  }

  /**
   * `status` must match the list's status string
   * byte-for-byte — resolveStatus() exists because those strings carry stray
   * spaces and periods that nobody types correctly.
   */
  async setStatus(taskId: string, status: string, useCustomId = false): Promise<Task> {
    const params: QueryParams = {};
    if (useCustomId) {
      params.custom_task_ids = "true";
      params.team_id = this.cfg.teamId;
    }
    return this.request<Task>(
      "PUT",
      `/task/${encodeURIComponent(taskId)}`,
      params,
      { status }
    );
  }

  /**
   * Post a comment. `notifyAll` defaults to false so an automated note doesn't
   * ping every watcher — pass true when a human is meant to see it now.
   */
  async addComment(
    taskId: string,
    commentText: string,
    useCustomId = false,
    notifyAll = false
  ): Promise<{ id?: string }> {
    const params: QueryParams = {};
    if (useCustomId) {
      params.custom_task_ids = "true";
      params.team_id = this.cfg.teamId;
    }
    return this.request<{ id?: string }>(
      "POST",
      `/task/${encodeURIComponent(taskId)}/comment`,
      params,
      { comment_text: commentText, notify_all: notifyAll }
    );
  }

  /**
   * Params for referencing a task by its custom id (ABC-123) instead of the
   * native one. ClickUp needs both flags or it 404s on a perfectly valid id.
   */
  customIdParams(useCustomId: boolean): QueryParams {
    return useCustomId ? { custom_task_ids: "true", team_id: this.cfg.teamId } : {};
  }

  createTask(listId: string, body: Record<string, unknown>): Promise<Task> {
    return this.request<Task>("POST", `/list/${encodeURIComponent(listId)}/task`, {}, body);
  }

  updateTask(
    taskId: string,
    body: Record<string, unknown>,
    useCustomId = false
  ): Promise<Task> {
    return this.request<Task>(
      "PUT",
      `/task/${encodeURIComponent(taskId)}`,
      this.customIdParams(useCustomId),
      body
    );
  }

  deleteTask(taskId: string, useCustomId = false): Promise<unknown> {
    return this.request<unknown>(
      "DELETE",
      `/task/${encodeURIComponent(taskId)}`,
      this.customIdParams(useCustomId)
    );
  }

  /**
   * ClickUp has no name-search endpoint, so page through team tasks and let the
   * caller rank. Returns a flat list capped by searchPageLimit pages.
   */
  async listTeamTasks(): Promise<Task[]> {
    return (await this.queryTasks({ subtasks: true, includeClosed: true })).tasks;
  }

  /**
   * Filtered team-task query. This is the generic finder — "bugs" are whatever a
   * given workspace calls them (a list, a tag, a custom field), so callers pass
   * their own convention instead of the server hardcoding one.
   *
   * `exhausted` is false when the loop stopped at the page cap — more tasks may
   * exist that were never fetched, and callers must say so instead of implying
   * the count is total.
   */
  async queryTasks(q: TaskQuery = {}): Promise<{ tasks: Task[]; exhausted: boolean }> {
    const base: QueryParams = {
      list_ids: q.listIds,
      space_ids: q.spaceIds,
      project_ids: q.folderIds,
      statuses: q.statuses,
      assignees: q.assignees,
      tags: q.tags,
      custom_fields: q.customFields,
      due_date_gt: q.dueAfter !== undefined ? String(q.dueAfter) : undefined,
      due_date_lt: q.dueBefore !== undefined ? String(q.dueBefore) : undefined,
      date_updated_gt: q.updatedAfter !== undefined ? String(q.updatedAfter) : undefined,
      include_closed: q.includeClosed ? "true" : undefined,
      subtasks: q.subtasks ? "true" : undefined,
      order_by: q.orderBy,
      reverse: q.reverse ? "true" : undefined,
    };

    const maxPages = q.pageLimit ?? this.cfg.searchPageLimit;
    const out: Task[] = [];
    let exhausted = false;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.get<{ tasks?: Task[]; last_page?: boolean }>(
        `/team/${this.cfg.teamId}/task`,
        { ...base, page: String(page) }
      );
      const tasks = data.tasks ?? [];
      out.push(...tasks);
      if (data.last_page || tasks.length === 0) {
        exhausted = true;
        break;
      }
    }
    return { tasks: out, exhausted };
  }
}

/**
 * Run `fn` over items with bounded concurrency. Keeps per-task dependency
 * fetches from tripping ClickUp's 100 req/min token limit.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }
  );
  await Promise.all(workers);
  return out;
}
