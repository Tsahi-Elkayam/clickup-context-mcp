import { mapLimit, type ClickUpClient, type Task, type TaskQuery } from "./clickup.js";

/**
 * What a Gantt bar actually is, once you strip the drawing: a task with a
 * duration, an owner, a status, and edges to the tasks it waits on.
 */
export interface ScheduleNode {
  id: string;
  name: string;
  status?: string;
  url?: string;
  list?: string;
  start?: number;
  due?: number;
  estimateMs?: number;
  assignees: string[];
  /** Ids this task waits on (edges point backwards in time). */
  dependsOn: string[];
  /** Ids this task blocks, as reported by ClickUp. */
  blocks: string[];
}

export interface CriticalPath {
  /** Chronological: earliest prerequisite first. */
  path: string[];
  totalMs: number;
  /** Dependency loops found while walking. Reported, not thrown. */
  cycles: string[][];
  /** In-scope dependency edges the graph was built from. 0 means the "path" is just the longest task. */
  edges: number;
}

function num(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A bar's length. Prefer an explicit estimate; fall back to the date span so
 * tasks that were scheduled but never estimated still carry weight.
 */
export function durationMs(n: ScheduleNode): number {
  if (n.estimateMs && n.estimateMs > 0) return n.estimateMs;
  if (n.start !== undefined && n.due !== undefined && n.due > n.start) return n.due - n.start;
  return 0;
}

export function toNode(t: Task): ScheduleNode {
  const dependsOn: string[] = [];
  const blocks: string[] = [];
  for (const d of t.dependencies ?? []) {
    // ClickUp reports rows from both sides. The row where task_id is this task
    // and depends_on is the other means this task waits on the other. Rows
    // referencing neither side are dropped — fabricating an edge from a
    // malformed row would put a wrong task on the critical path.
    if (d.depends_on && d.task_id === t.id) dependsOn.push(d.depends_on);
    else if (d.task_id && d.depends_on === t.id) blocks.push(d.task_id);
  }
  return {
    id: t.id,
    name: t.name,
    status: t.status?.status,
    url: t.url,
    list: t.list?.name,
    start: num(t.start_date),
    due: num(t.due_date),
    estimateMs: num(t.time_estimate),
    assignees: (t.assignees ?? []).map((a) => a.username || a.email || String(a.id ?? "?")),
    dependsOn: [...new Set(dependsOn)],
    blocks: [...new Set(blocks)],
  };
}

/**
 * Longest dependency chain by summed duration — the schedule's real bottleneck.
 *
 * Iterative DFS so a deep chain can't blow the stack, with on-stack marking so a
 * dependency loop is recorded and its edge dropped rather than hanging forever.
 * ClickUp will happily let a human create A→B→A.
 */
export function criticalPath(nodes: ScheduleNode[]): CriticalPath {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Build the edge set from BOTH directions ClickUp reports: n.dependsOn and
  // the reverse of n.blocks. One side surviving a failed hydration still
  // contributes the edge. Edges pointing outside the queried scope are
  // ignored; we can't weigh what we didn't fetch.
  const deps = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    let s = deps.get(from);
    if (!s) deps.set(from, (s = new Set()));
    s.add(to);
  };
  for (const n of nodes) {
    for (const d of n.dependsOn) if (byId.has(d)) addEdge(n.id, d);
    for (const b of n.blocks) if (byId.has(b)) addEdge(b, n.id);
  }
  let edges = 0;
  for (const s of deps.values()) edges += s.size;
  const depsOf = (id: string): string[] => [...(deps.get(id) ?? [])];

  const memo = new Map<string, { len: number; next?: string }>();
  const UNSEEN = 0, ON_STACK = 1, DONE = 2;
  const state = new Map<string, number>();
  const cycles: string[][] = [];

  for (const root of byId.keys()) {
    if (state.get(root) === DONE) continue;
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
    state.set(root, ON_STACK);

    while (stack.length) {
      const top = stack[stack.length - 1];
      const deps = depsOf(top.id);

      if (top.i < deps.length) {
        const dep = deps[top.i++];
        const st = state.get(dep) ?? UNSEEN;
        if (st === ON_STACK) {
          const at = stack.findIndex((f) => f.id === dep);
          if (at >= 0) cycles.push(stack.slice(at).map((f) => f.id));
          continue; // drop the back-edge instead of recursing into it
        }
        if (st === UNSEEN) {
          state.set(dep, ON_STACK);
          stack.push({ id: dep, i: 0 });
        }
        continue;
      }

      // Every dependency resolved: this node's chain is its own duration plus
      // the heaviest chain behind it.
      let best = 0;
      let via: string | undefined;
      for (const dep of deps) {
        const m = memo.get(dep);
        if (m && m.len > best) {
          best = m.len;
          via = dep;
        }
      }
      memo.set(top.id, { len: durationMs(byId.get(top.id)!) + best, next: via });
      state.set(top.id, DONE);
      stack.pop();
    }
  }

  let tail: string | undefined;
  let max = 0;
  for (const [id, m] of memo) {
    if (m.len > max) {
      max = m.len;
      tail = id;
    }
  }

  const path: string[] = [];
  const guard = new Set<string>();
  for (let cur = tail; cur && !guard.has(cur); cur = memo.get(cur)?.next) {
    guard.add(cur);
    path.push(cur);
  }
  return { path: path.reverse(), totalMs: max, cycles, edges };
}

/**
 * Fetch a scope's tasks, then hydrate dependencies.
 *
 * The filtered-tasks endpoint omits `dependencies`, so a real graph costs one
 * extra call per task. Bounded concurrency plus a hard cap keeps that inside
 * ClickUp's 100 req/min token budget.
 *
 * ponytail: N+1 fetch, capped at maxTasks. If you need whole-workspace Gantts,
 * cache task->deps between calls rather than raising the cap.
 */
export async function loadSchedule(
  client: ClickUpClient,
  query: TaskQuery,
  maxTasks: number,
  concurrency = 8
): Promise<{ nodes: ScheduleNode[]; truncated: number; depErrors: number }> {
  // Page fetches count against the same rate budget as the per-task fetches,
  // so cap pages at what maxTasks can use instead of the search default.
  const { tasks } = await client.queryTasks({
    ...query,
    pageLimit: query.pageLimit ?? Math.max(1, Math.ceil(maxTasks / 100)),
  });
  const truncated = Math.max(0, tasks.length - maxTasks);
  const scoped = tasks.slice(0, maxTasks);

  let depErrors = 0;
  const hydrated = await mapLimit(scoped, concurrency, async (t) => {
    // A non-empty dependencies array is proof of hydration. An empty or absent
    // one is ambiguous — the list endpoint may omit deps entirely — so fetch
    // rather than silently building a graph with no edges.
    if (t.dependencies && t.dependencies.length > 0) return t;
    try {
      const full = await client.getTask(t.id);
      return { ...t, ...full };
    } catch {
      depErrors++;
      return t; // keep the bar, just without its edges
    }
  });

  return { nodes: hydrated.map(toNode), truncated, depErrors };
}

const DAY = 86_400_000;

export function humanMs(ms: number): string {
  if (ms <= 0) return "0";
  const days = ms / DAY;
  if (days >= 1) return `${Math.round(days * 10) / 10}d`;
  return `${Math.round(ms / 3_600_000 * 10) / 10}h`;
}

function ymd(ms?: number): string {
  return ms === undefined ? "—" : new Date(ms).toISOString().slice(0, 10);
}

export function renderSchedule(
  nodes: ScheduleNode[],
  cp: CriticalPath,
  notes: { truncated: number; depErrors: number }
): string {
  if (!nodes.length) return "No tasks matched that scope.";

  const onPath = new Set(cp.path);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const sorted = [...nodes].sort((a, b) => (a.start ?? a.due ?? Infinity) - (b.start ?? b.due ?? Infinity));

  const out: string[] = [
    `# Schedule — ${nodes.length} task(s), ${cp.edges} dependency edge(s)`,
    "",
  ];
  out.push("| | ID | Task | Start | Due | Est | Status | Owner | Waits on |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const n of sorted) {
    const waits = n.dependsOn.map((d) => byId.get(d)?.name ?? d).join(", ") || "—";
    out.push(
      `| ${onPath.has(n.id) ? "**◆**" : ""} | \`${n.id}\` | ${n.name} | ${ymd(n.start)} | ${ymd(n.due)} | ` +
        `${humanMs(durationMs(n))} | ${n.status ?? "—"} | ${n.assignees.join(", ") || "—"} | ${waits} |`
    );
  }

  out.push("", `## Critical path — ${humanMs(cp.totalMs)}`);
  if (cp.path.length) {
    out.push(
      cp.path
        .map((id, i) => {
          const n = byId.get(id);
          return `${i + 1}. ${n?.name ?? id} — id \`${id}\` (${humanMs(durationMs(n!))}${n?.status ? `, ${n.status}` : ""})`;
        })
        .join("\n")
    );
    if (cp.edges === 0) {
      // Without edges the "path" is just the heaviest task. Say so, or the
      // output is indistinguishable from a real chain.
      out.push("", "_No dependency edges in this scope — this is the longest single task, not a chain._");
    } else {
      out.push("", "◆ marks tasks on this chain — slipping any of them slips the whole scope.");
    }
  } else {
    out.push("_No chain found — tasks carry no estimates or dates to weigh._");
  }

  if (cp.cycles.length) {
    out.push("", "## ⚠ Dependency loops");
    out.push("These form circular dependencies; edges were dropped to compute the path:");
    for (const c of cp.cycles) {
      out.push(`- ${c.map((id) => byId.get(id)?.name ?? id).join(" → ")} → (back to start)`);
    }
  }

  const footer: string[] = [];
  if (notes.truncated) footer.push(`${notes.truncated} more task(s) matched but were not fetched.`);
  if (notes.depErrors) footer.push(`${notes.depErrors} task(s) had dependency fetch errors.`);
  if (footer.length) out.push("", "---", ...footer.map((f) => `- ${f}`));

  return out.join("\n");
}
