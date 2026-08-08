#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import {
  ClickUpClient,
  mapLimit,
  resolveStatus,
  type Comment,
  type Task,
  type TaskQuery,
} from "./clickup.js";
import { resolveRef } from "./resolver.js";
import { collectImageSources, downloadImages, looksLikeImage } from "./images.js";
import { setCurrentTask, getCurrentTask } from "./state.js";
import { criticalPath, loadSchedule, renderSchedule } from "./schedule.js";
import {
  listChannels,
  readChannel,
  readReplies,
  renderChannels,
  renderMessages,
  type ChatMessage,
} from "./chat.js";

const cfg = loadConfig();
const client = new ClickUpClient(cfg);

// Single source of truth — a hardcoded copy here drifts from package.json and
// reports the wrong version over the MCP handshake. `files: ["dist"]` still
// ships package.json at the tarball root, so ../ resolves from dist/index.js.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({ name: "clickup-context", version });

// Every read tool gets this so clients that gate on readOnlyHint don't throw
// mutation-style confirmation prompts at pure reads. openWorld: it's a SaaS API.
const readOnly = { readOnlyHint: true, openWorldHint: true };
// Local-state tools never leave the machine.
const readOnlyLocal = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  "get_task_context",
  {
    title: "Get ClickUp task context",
    description:
      "Resolve a ClickUp task from a URL, custom id (ABC-123), native id, fuzzy name, " +
      "or 'current', then return its description, comments, and screenshots as viewable images " +
      "— everything about the task in one call.",
    annotations: readOnly,
    inputSchema: {
      ref: z
        .string()
        .describe(
          "Task URL, custom id (ABC-123), native id, a fuzzy name/description, or 'current'."
        ),
    },
  },
  async ({ ref }) => {
    const { resolved, candidates } = await resolveRef(client, ref);
    if (!resolved) {
      const lines = (candidates ?? []).map(
        (c) => `- ${c.name} [${c.status ?? "?"}] in ${c.list ?? "?"} — id ${c.taskId}`
      );
      return {
        content: [
          {
            type: "text" as const,
            text:
              candidates && candidates.length
                ? `Multiple tasks match "${ref}". Ask the user which, then call again with the id:\n${lines.join("\n")}`
                : `No task matched "${ref}".`,
          },
        ],
      };
    }

    const [task, comments] = await Promise.all([
      client.getTask(resolved.taskId, resolved.useCustomId),
      client.getComments(resolved.taskId, resolved.useCustomId).catch(() => [] as Comment[]),
    ]);

    // ClickUp returns comments newest-first. Flip once here so the thread reads
    // as a conversation AND the screenshots come back in the same order.
    comments.reverse();

    const sources = collectImageSources(task, comments);
    // Non-image attachments used to be dropped in silence, so a task whose only
    // content was an attached spec read as an empty task. List them by name and
    // url — they can't be rendered as vision, but they must not be invisible.
    const attachments = sources.filter(looksLikeImage);
    const files = sources.filter((a) => !looksLikeImage(a));

    const text =
      renderTask(task, comments) +
      (files.length
        ? `\n\n## Files\n${files.map((f) => `- ${f.title} — ${f.url}`).join("\n")}`
        : "");
    const reserved = Buffer.byteLength(text, "utf8");
    const { images, skipped } = await downloadImages(
      attachments,
      cfg,
      cfg.apiToken,
      reserved
    );

    const footer = skipped.length ? `\n\n---\nImages not shown:\n- ${skipped.join("\n- ")}` : "";

    return {
      content: [
        { type: "text" as const, text: text + footer },
        ...images.map((img) => ({
          type: "image" as const,
          data: img.data,
          mimeType: img.mimeType,
        })),
      ],
    };
  }
);

server.registerTool(
  "set_status",
  {
    title: "Set a ClickUp task status",
    description:
      "Move a task to another status — e.g. to prod qa when work is finished. This is the only " +
      "tool here that writes to ClickUp. The status is matched against the list's own statuses, " +
      "so 'prod qa' finds 'moved to prod qa .'; an unknown or ambiguous status lists the valid " +
      "ones instead of guessing.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      ref: z.string().describe("Task URL, custom id, native id, fuzzy name, or 'current'."),
      status: z
        .string()
        .describe("Target status. Matched loosely against the statuses the task's list allows."),
    },
  },
  async ({ ref, status }) => {
    const { resolved, candidates } = await resolveRef(client, ref);
    if (!resolved) {
      return text(
        candidates?.length
          ? `"${ref}" is ambiguous — no status was changed. Pick one and retry:\n${candidates
              .map((c) => `- ${c.name} [${c.status ?? "?"}] — id ${c.taskId}`)
              .join("\n")}`
          : `No task matched "${ref}". Nothing was changed.`
      );
    }

    const task = await client.getTask(resolved.taskId, resolved.useCustomId);
    if (!task.list?.id) return text(`Task ${task.id} has no list, so its statuses are unknown.`);

    const available = await client.listStatuses(task.list.id);
    const target = resolveStatus(status, available);
    if (!target) {
      return text(
        `"${status}" is not a status in list "${task.list.name ?? task.list.id}" (or matches more ` +
          `than one). Nothing was changed. Valid statuses:\n${available
            .map((s) => `- ${JSON.stringify(s)}`)
            .join("\n")}`
      );
    }

    const before = task.status?.status ?? "(unknown)";
    if (before === target) return text(`${task.name} is already in "${target}". No change made.`);

    await client.setStatus(resolved.taskId, target, resolved.useCustomId);
    return text(`${task.name}: "${before}" → "${target}"\n${task.url ?? ""}`);
  }
);

server.registerTool(
  "add_comment",
  {
    title: "Comment on a ClickUp task",
    description:
      "Post a comment on a task — e.g. to record what was done, or to ask the reporter a " +
      "question. Writes to ClickUp and is visible to everyone on the task.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      ref: z.string().describe("Task URL, custom id, native id, fuzzy name, or 'current'."),
      comment: z.string().min(1).describe("Comment body. ClickUp renders it as plain text."),
      notify_all: z
        .boolean()
        .optional()
        .describe("Notify every watcher. Default false — avoids pinging a team for a log entry."),
    },
  },
  async ({ ref, comment, notify_all }) => {
    const { resolved, candidates } = await resolveRef(client, ref);
    if (!resolved) {
      return text(
        candidates?.length
          ? `"${ref}" is ambiguous — nothing was posted. Pick one:\n${candidates
              .map((c) => `- ${c.name} — id ${c.taskId}`)
              .join("\n")}`
          : `No task matched "${ref}". Nothing was posted.`
      );
    }
    await client.addComment(resolved.taskId, comment, resolved.useCustomId, notify_all ?? false);
    return text(`Comment posted to ${resolved.taskId}.`);
  }
);

server.registerTool(
  "resolve_task",
  {
    title: "Resolve a ClickUp task reference",
    description:
      "Turn a URL/custom id/native id/fuzzy name into a concrete task id, or a list of " +
      "candidates for disambiguation. Does not fetch full context.",
    annotations: readOnly,
    inputSchema: { ref: z.string().describe("Task URL, id, or fuzzy name.") },
  },
  async ({ ref }) => {
    const { resolved, candidates } = await resolveRef(client, ref);
    return {
      content: [
        {
          type: "text" as const,
          text: resolved
            ? `Resolved to task id ${resolved.taskId} (customId=${resolved.useCustomId}).`
            : `Candidates:\n${(candidates ?? [])
                .map((c) => `- ${c.name} [${c.status ?? "?"}] — id ${c.taskId}`)
                .join("\n")}`,
        },
      ],
    };
  }
);

server.registerTool(
  "set_current_task",
  {
    title: "Set the current ClickUp task",
    description:
      "Remember a task as 'current' so later calls can use ref='current'. Accepts a URL, " +
      "custom id, native id, or unambiguous fuzzy name.",
    // Writes a local state file only — never mutates ClickUp.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { ref: z.string().describe("Task URL, id, or fuzzy name to set as current.") },
  },
  async ({ ref }) => {
    const { resolved, candidates } = await resolveRef(client, ref);
    if (!resolved) {
      return {
        content: [
          {
            type: "text" as const,
            text: `"${ref}" is ambiguous; pick one and retry:\n${(candidates ?? [])
              .map((c) => `- ${c.name} — id ${c.taskId}`)
              .join("\n")}`,
          },
        ],
      };
    }
    const task = await client.getTask(resolved.taskId, resolved.useCustomId).catch(() => null);
    await setCurrentTask({
      taskId: resolved.taskId,
      useCustomId: resolved.useCustomId,
      label: task?.name,
      setAt: new Date().toISOString(),
    });
    return {
      content: [
        { type: "text" as const, text: `Current task set: ${task?.name ?? resolved.taskId}.` },
      ],
    };
  }
);

server.registerTool(
  "get_current_task",
  {
    title: "Get the current ClickUp task",
    description: "Show which task is currently remembered as 'current'.",
    annotations: readOnlyLocal,
    inputSchema: {},
  },
  async () => {
    const cur = await getCurrentTask();
    return {
      content: [
        {
          type: "text" as const,
          text: cur
            ? `Current task: ${cur.label ?? cur.taskId} (id ${cur.taskId}, set ${cur.setAt}).`
            : "No current task set.",
        },
      ],
    };
  }
);

/**
 * Scope filters shared by query_tasks and get_schedule. There is no "bug" concept
 * in ClickUp — every workspace encodes it differently (a list, a tag, a custom
 * field), so the caller supplies the convention.
 */
const scopeShape = {
  list_ids: z.array(z.string()).optional().describe("Restrict to these List ids."),
  space_ids: z.array(z.string()).optional().describe("Restrict to these Space ids."),
  folder_ids: z.array(z.string()).optional().describe("Restrict to these Folder ids."),
  statuses: z
    .array(z.string())
    .optional()
    .describe("Status names to include, e.g. ['open','in progress']."),
  assignees: z.array(z.string()).optional().describe("ClickUp numeric user ids."),
  tags: z.array(z.string()).optional().describe("Tag names, e.g. ['bug'] if bugs are tagged."),
  custom_fields: z
    .string()
    .optional()
    .describe(
      'Raw ClickUp custom_fields JSON for field-based conventions, e.g. ' +
        '\'[{"field_id":"abc","operator":"=","value":"Bug"}]\'.'
    ),
  due_after: z.number().optional().describe("Due date lower bound, unix ms."),
  due_before: z.number().optional().describe("Due date upper bound, unix ms."),
  updated_after: z.number().optional().describe("Only tasks updated after this, unix ms."),
  include_closed: z.boolean().optional().describe("Include closed tasks. Default false."),
  subtasks: z.boolean().optional().describe("Include subtasks. Default false."),
};

type Scope = {
  list_ids?: string[];
  space_ids?: string[];
  folder_ids?: string[];
  statuses?: string[];
  assignees?: string[];
  tags?: string[];
  custom_fields?: string;
  due_after?: number;
  due_before?: number;
  updated_after?: number;
  include_closed?: boolean;
  subtasks?: boolean;
};

function toQuery(s: Scope): TaskQuery {
  return {
    listIds: s.list_ids,
    spaceIds: s.space_ids,
    folderIds: s.folder_ids,
    statuses: s.statuses,
    assignees: s.assignees,
    tags: s.tags,
    customFields: s.custom_fields,
    dueAfter: s.due_after,
    dueBefore: s.due_before,
    updatedAfter: s.updated_after,
    includeClosed: s.include_closed,
    subtasks: s.subtasks,
  };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

server.registerTool(
  "query_tasks",
  {
    title: "Query ClickUp tasks by filter",
    description:
      "Find tasks by list, space, folder, tag, status, assignee, custom field, or date range. " +
      "This is how you find bugs: ClickUp has no bug type, so pass whatever this workspace uses " +
      "— tags:['bug'], a Bugs list_id, or a custom_fields filter. Returns a compact table.",
    annotations: readOnly,
    inputSchema: {
      ...scopeShape,
      limit: z.number().int().min(1).max(200).optional().describe("Max tasks to return, default 50."),
    },
  },
  async ({ limit, ...scope }) => {
    const want = limit ?? 50;
    // Fetch just past `want` so we can honestly distinguish "that's all" from
    // "there's more", without pulling 5 pages to show 50 rows.
    const { tasks, exhausted } = await client.queryTasks({
      ...toQuery(scope),
      pageLimit: Math.max(1, Math.ceil((want + 1) / 100)),
    });
    const shown = tasks.slice(0, want);
    if (!shown.length) {
      return text(exhausted ? "No tasks matched those filters." : "No tasks in the fetched pages — page cap reached, more may exist.");
    }

    const rows = shown.map((t) => {
      const due = t.due_date ? new Date(Number(t.due_date)).toISOString().slice(0, 10) : "—";
      const owners = (t.assignees ?? []).map((a) => a.username || a.email).join(", ") || "—";
      const tags = (t.tags ?? []).map((g) => g.name).filter(Boolean).join(", ") || "—";
      const id = t.custom_id ? `${t.custom_id} (\`${t.id}\`)` : `\`${t.id}\``;
      return `| ${id} | ${t.name} | ${t.status?.status ?? "—"} | ${due} | ${owners} | ${tags} | ${t.list?.name ?? "—"} |`;
    });
    const hidden = tasks.length - shown.length;
    const more = !exhausted
      ? `\n\n_${hidden ? `${hidden}+ more matched` : "More may exist"} — page cap reached, narrow the filters or raise limit._`
      : hidden
        ? `\n\n_${hidden} more matched._`
        : "";
    return text(
      `# ${shown.length} task(s)\n\n| ID | Name | Status | Due | Owner | Tags | List |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}${more}`
    );
  }
);

server.registerTool(
  "get_schedule",
  {
    title: "Get ClickUp schedule and critical path",
    description:
      "The Gantt view as data: every task in a scope with its dates, estimate, owner, status, " +
      "and dependencies, plus the computed critical path — the longest dependency chain, which " +
      "is what actually determines the end date. Flags circular dependencies. Scope it with the " +
      "same filters as query_tasks (a list, space, or tag).",
    annotations: readOnly,
    inputSchema: scopeShape,
  },
  async (scope) => {
    const { nodes, truncated, depErrors } = await loadSchedule(
      client,
      toQuery(scope),
      cfg.maxScheduleTasks
    );
    if (!nodes.length) return text("No tasks matched that scope.");
    return text(renderSchedule(nodes, criticalPath(nodes), { truncated, depErrors }));
  }
);

server.registerTool(
  "list_chat_channels",
  {
    title: "List ClickUp Chat channels",
    description:
      "List Chat channels visible to this token, with their ids for read_chat. " +
      "Note: ClickUp's Chat API is experimental and may change without notice.",
    annotations: readOnly,
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Max channels, default 50."),
    },
  },
  async ({ limit }) => text(renderChannels(await listChannels(client, limit ?? 50)))
);

server.registerTool(
  "read_chat",
  {
    title: "Read a ClickUp Chat channel",
    description:
      "Read messages in a Chat channel, oldest first, optionally expanding threaded replies. " +
      "This is ClickUp Chat (the messaging product), not task comments — use get_task_context " +
      "for the conversation on a task. Get channel ids from list_chat_channels.",
    annotations: readOnly,
    inputSchema: {
      channel_id: z.string().describe("Channel id from list_chat_channels."),
      limit: z.number().int().min(1).max(100).optional().describe("Max messages, default 50."),
      cursor: z.string().optional().describe("Pagination cursor from a previous call."),
      include_replies: z
        .boolean()
        .optional()
        .describe("Fetch threaded replies for messages that have them. Costs one call each."),
    },
  },
  async ({ channel_id, limit, cursor, include_replies }) => {
    const { messages, cursor: next } = await readChannel(client, channel_id, limit ?? 50, cursor);

    let replies: Map<string, ChatMessage[]> | undefined;
    if (include_replies) {
      const threaded = messages.filter((m) => (m.replies_count ?? 0) > 0);
      replies = new Map();
      // A failed fetch must NOT store an empty array — that would render the
      // thread as reply-less and erase the "N replies" evidence entirely.
      const fetched = await mapLimit(threaded, 5, async (m) => {
        try {
          return [m.id, await readReplies(client, m.id)] as const;
        } catch {
          return null;
        }
      });
      for (const entry of fetched) if (entry) replies.set(entry[0], entry[1]);
    }

    return text(renderMessages(messages, { channel: channel_id, cursor: next, replies }));
  }
);

function renderTask(task: Task, comments: Comment[]): string {
  const parts: string[] = [];
  parts.push(`# ${task.name}`);
  const meta = [
    task.custom_id ? `Custom ID: ${task.custom_id}` : null,
    task.status?.status ? `Status: ${task.status.status}` : null,
    task.list?.name ? `List: ${task.list.name}` : null,
    task.url ? `URL: ${task.url}` : null,
  ].filter(Boolean);
  if (meta.length) parts.push(meta.join(" · "));

  const body = task.text_content?.trim() || task.description?.trim();
  parts.push("\n## Description\n" + (body || "_(empty)_"));

  if (comments.length) {
    parts.push("\n## Comments");
    for (const c of comments) {
      const who = c.user?.username || c.user?.email || "unknown";
      const txt = (c.comment_text ?? "").trim();
      const ms = Number(c.date);
      const at = ms ? ` · ${new Date(ms).toISOString().replace("T", " ").slice(0, 16)}` : "";
      parts.push(`**${who}**${at}: ${txt || "_(no text — may be an attachment)_"}`);
    }
  } else {
    parts.push("\n## Comments\n_(none)_");
  }
  return parts.join("\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);
