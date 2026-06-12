import type { Config } from "./config.js";

const API_BASE = "https://api.clickup.com/api/v2";

export interface Attachment {
  id: string;
  title: string;
  extension: string;
  mimetype?: string;
  url: string;
  thumbnail_large?: string;
}

export interface Comment {
  id: string;
  comment_text: string;
  user: { username?: string; email?: string };
  date: string;
  resolved?: boolean;
}

export interface Task {
  id: string;
  custom_id?: string | null;
  name: string;
  description?: string;
  text_content?: string;
  status?: { status: string };
  url?: string;
  list?: { name?: string };
  attachments?: Attachment[];
}

export class ClickUpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ClickUpError";
  }
}

export class ClickUpClient {
  constructor(private readonly cfg: Config) {}

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: this.cfg.apiToken, "Content-Type": "application/json" },
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

  getTask(taskId: string, useCustomId = false): Promise<Task> {
    const params: Record<string, string> = { include_subtasks: "false" };
    if (useCustomId) {
      params.custom_task_ids = "true";
      params.team_id = this.cfg.teamId;
    }
    return this.get<Task>(`/task/${encodeURIComponent(taskId)}`, params);
  }

  async getComments(taskId: string, useCustomId = false): Promise<Comment[]> {
    const params: Record<string, string> = {};
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

  /**
   * ClickUp has no name-search endpoint, so page through team tasks and let the
   * caller rank. Returns a flat list capped by searchPageLimit pages.
   */
  async listTeamTasks(): Promise<Task[]> {
    const out: Task[] = [];
    for (let page = 0; page < this.cfg.searchPageLimit; page++) {
      const data = await this.get<{ tasks: Task[]; last_page?: boolean }>(
        `/team/${this.cfg.teamId}/task`,
        { page: String(page), subtasks: "true", include_closed: "true" }
      );
      const tasks = data.tasks ?? [];
      out.push(...tasks);
      if (data.last_page || tasks.length === 0) break;
    }
    return out;
  }
}
