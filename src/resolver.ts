import type { ClickUpClient, Task } from "./clickup.js";
import { getCurrentTask } from "./state.js";

export interface ResolvedRef {
  taskId: string;
  useCustomId: boolean;
}

export interface Candidate {
  taskId: string;
  name: string;
  list?: string;
  status?: string;
  score: number;
}

// app.clickup.com/t/{id}  or  app.clickup.com/{team}/v/.../t/{id}
const URL_TASK = /clickup\.com\/(?:t|.*\/t)\/([a-z0-9]+)/i;
// Custom ids look like ABC-123 / DEV-4567 (letters, dash, digits).
const CUSTOM_ID = /^[A-Z][A-Z0-9]*-\d+$/;
// Native task ids are short base-36 strings, no dash.
const NATIVE_ID = /^[a-z0-9]{6,12}$/i;

/**
 * Turn whatever the user typed into a concrete task id, or a list of fuzzy
 * candidates when the ref is a name/description.
 */
export async function resolveRef(
  client: ClickUpClient,
  ref: string
): Promise<{ resolved?: ResolvedRef; candidates?: Candidate[] }> {
  const trimmed = ref.trim();

  if (!trimmed || /^(current|this task|the one i'?m on|current task)$/i.test(trimmed)) {
    const cur = await getCurrentTask();
    if (!cur) {
      throw new Error(
        "No current task set. Pass a task URL/id, or call set_current_task first."
      );
    }
    return { resolved: { taskId: cur.taskId, useCustomId: cur.useCustomId } };
  }

  const urlMatch = trimmed.match(URL_TASK);
  if (urlMatch) return { resolved: { taskId: urlMatch[1], useCustomId: false } };

  if (CUSTOM_ID.test(trimmed)) return { resolved: { taskId: trimmed, useCustomId: true } };

  if (NATIVE_ID.test(trimmed)) return { resolved: { taskId: trimmed, useCustomId: false } };

  // Fuzzy: rank team tasks by name similarity to the query.
  const tasks = await client.listTeamTasks();
  const candidates = rankByName(tasks, trimmed)
    .filter((c) => c.score > 0)
    .slice(0, 8);

  if (candidates.length === 1) {
    return { resolved: { taskId: candidates[0].taskId, useCustomId: false } };
  }
  return { candidates };
}

function rankByName(tasks: Task[], query: string): Candidate[] {
  const q = query.toLowerCase();
  const qWords = q.split(/\s+/).filter(Boolean);
  return tasks
    .map((t) => {
      const name = (t.name ?? "").toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.includes(q)) score = 60;
      else {
        const hits = qWords.filter((w) => name.includes(w)).length;
        score = qWords.length ? (hits / qWords.length) * 40 : 0;
      }
      return {
        taskId: t.id,
        name: t.name,
        list: t.list?.name,
        status: t.status?.status,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}
