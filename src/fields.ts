/**
 * Turning human-shaped tool arguments into the exact JSON ClickUp's task
 * endpoints want. Three traps live here:
 *
 *  1. Dates go over the wire as unix **milliseconds**, but nobody types those.
 *  2. `assignees` is a flat array on create and an {add, rem} object on update.
 *     Sending the create shape to update silently no-ops.
 *  3. `priority` is an integer, and the integers are counter-intuitive: 1 is
 *     Urgent, 4 is Low. Off-by-one here quietly mislabels every task.
 */

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type PriorityName = (typeof PRIORITIES)[number];

const PRIORITY_CODE: Record<PriorityName, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

/** Accepts unix ms, or anything Date can parse ("2026-03-01", an ISO string). */
export function parseDate(input: string | number): number {
  if (typeof input === "number") return input;
  const trimmed = input.trim();
  // A bare digit string is already unix ms — Date.parse would read it as a year.
  if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) throw new Error(`Not a date: "${input}". Use ISO (2026-03-01) or unix ms.`);
  return ms;
}

/**
 * "2h30m" / "1.5h" / "90m" / "45" → milliseconds. A bare number is minutes,
 * because that is what people mean when they type an estimate.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") return input * 60_000;
  const trimmed = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 60_000;
  const matches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([hmd])/g)];
  if (!matches.length) throw new Error(`Not a duration: "${input}". Try "2h30m", "90m", or "1.5h".`);
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 };
  return matches.reduce((ms, [, n, u]) => ms + Number(n) * unit[u as "h" | "m" | "d"], 0);
}

export interface TaskFields {
  name?: string;
  description?: string;
  status?: string;
  priority?: PriorityName;
  due_date?: string;
  start_date?: string;
  time_estimate?: string;
  tags?: string[];
  assignees?: string[];
  remove_assignees?: string[];
  parent?: string;
  archived?: boolean;
}

/**
 * Build the request body. `mode` decides the assignee shape — see trap 2 above.
 * Only keys the caller actually supplied are emitted, so an update never blanks
 * a field it wasn't asked to touch.
 */
export function buildTaskBody(f: TaskFields, mode: "create" | "update"): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (f.name !== undefined) body.name = f.name;
  if (f.description !== undefined) body.description = f.description;
  if (f.status !== undefined) body.status = f.status;
  if (f.priority !== undefined) body.priority = PRIORITY_CODE[f.priority];
  if (f.due_date !== undefined) {
    body.due_date = parseDate(f.due_date);
    body.due_date_time = true;
  }
  if (f.start_date !== undefined) {
    body.start_date = parseDate(f.start_date);
    body.start_date_time = true;
  }
  if (f.time_estimate !== undefined) body.time_estimate = parseDuration(f.time_estimate);
  if (f.parent !== undefined) body.parent = f.parent;
  if (f.archived !== undefined) body.archived = f.archived;
  // Tags are settable only at creation; PUT /task ignores them.
  if (mode === "create" && f.tags !== undefined) body.tags = f.tags;

  const add = f.assignees?.map(Number).filter(Number.isFinite) ?? [];
  const rem = f.remove_assignees?.map(Number).filter(Number.isFinite) ?? [];
  if (mode === "create") {
    if (add.length) body.assignees = add;
  } else if (add.length || rem.length) {
    body.assignees = { add, rem };
  }
  return body;
}
