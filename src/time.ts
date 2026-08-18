import type { ClickUpClient, QueryParams } from "./clickup.js";

/**
 * Time tracking (v2). One quirk drives the whole module: ClickUp signals a
 * *running* timer with a NEGATIVE duration, so any naive sum of durations
 * silently subtracts the in-flight entry. formatDuration/totalMs treat negative
 * as "running" instead of as time.
 */

export interface TimeEntry {
  id: string;
  task?: { id?: string; name?: string; status?: { status?: string } };
  wid?: string;
  user?: { id?: number; username?: string; email?: string };
  billable?: boolean;
  /** Unix ms as a string. */
  start?: string;
  end?: string | null;
  /** Milliseconds. Negative means this timer is still running. */
  duration?: string | number;
  description?: string;
  task_location?: { list_name?: string; folder_name?: string; space_name?: string };
}

export function isRunning(e: TimeEntry): boolean {
  return Number(e.duration ?? 0) < 0;
}

/** ms → "2h 15m". Sub-minute entries read as "<1m" rather than "0m". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.round((abs % 3_600_000) / 60_000);
  if (!h && !m) return "<1m";
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** Sum only completed entries — a running timer's negative duration is a flag. */
export function totalMs(entries: TimeEntry[]): number {
  return entries.reduce((sum, e) => sum + Math.max(0, Number(e.duration ?? 0)), 0);
}

export async function getEntries(
  client: ClickUpClient,
  opts: {
    startDate?: number;
    endDate?: number;
    assignees?: string[];
    taskId?: string;
    listId?: string;
    spaceId?: string;
    folderId?: string;
  }
): Promise<TimeEntry[]> {
  const params: QueryParams = {
    start_date: opts.startDate !== undefined ? String(opts.startDate) : undefined,
    end_date: opts.endDate !== undefined ? String(opts.endDate) : undefined,
    // Multiple assignees go as one comma-joined value, NOT repeated params.
    assignee: opts.assignees?.length ? opts.assignees.join(",") : undefined,
    task_id: opts.taskId,
    list_id: opts.listId,
    space_id: opts.spaceId,
    folder_id: opts.folderId,
    include_location_names: "true",
  };
  const data = await client.get<{ data?: TimeEntry[] }>(
    `/team/${client.teamId}/time_entries`,
    params
  );
  return data.data ?? [];
}

export async function runningEntry(client: ClickUpClient): Promise<TimeEntry | null> {
  const data = await client.get<{ data?: TimeEntry | null }>(
    `/team/${client.teamId}/time_entries/current`
  );
  // ClickUp returns `data: null` when no timer is running.
  return data.data && data.data.id ? data.data : null;
}

export function logTime(
  client: ClickUpClient,
  body: { tid?: string; description?: string; start: number; duration: number; billable?: boolean },
  useCustomId = false
): Promise<{ data?: TimeEntry }> {
  return client.request<{ data?: TimeEntry }>(
    "POST",
    `/team/${client.teamId}/time_entries`,
    client.customIdParams(useCustomId),
    body
  );
}

export function startTimer(
  client: ClickUpClient,
  body: { tid?: string; description?: string; billable?: boolean },
  useCustomId = false
): Promise<{ data?: TimeEntry }> {
  return client.request<{ data?: TimeEntry }>(
    "POST",
    `/team/${client.teamId}/time_entries/start`,
    client.customIdParams(useCustomId),
    body
  );
}

export function stopTimer(client: ClickUpClient): Promise<{ data?: TimeEntry }> {
  return client.request<{ data?: TimeEntry }>(
    "POST",
    `/team/${client.teamId}/time_entries/stop`,
    {},
    {}
  );
}

export function renderEntries(entries: TimeEntry[]): string {
  if (!entries.length) return "No time entries in that range.";
  const rows = entries
    .slice()
    .sort((a, b) => Number(a.start ?? 0) - Number(b.start ?? 0))
    .map((e) => {
      const when = e.start ? new Date(Number(e.start)).toISOString().slice(0, 16).replace("T", " ") : "—";
      const dur = isRunning(e) ? "**running**" : formatDuration(Number(e.duration ?? 0));
      const who = e.user?.username || e.user?.email || "—";
      const task = e.task?.name ? `${e.task.name} (\`${e.task.id}\`)` : "—";
      const note = (e.description || "").replace(/\|/g, "\\|").slice(0, 60) || "—";
      return `| ${when} | ${dur} | ${who} | ${task} | ${note} |`;
    });
  const running = entries.filter(isRunning).length;
  const footer =
    `\n\n**Total logged: ${formatDuration(totalMs(entries))}**` +
    (running ? ` · ${running} timer(s) still running (excluded from the total).` : "");
  return `# ${entries.length} time entr(ies)\n\n| Start | Duration | User | Task | Note |\n|---|---|---|---|---|\n${rows.join("\n")}${footer}`;
}
