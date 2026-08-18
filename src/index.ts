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
  replyToMessage,
  sendMessage,
  type ChatMessage,
} from "./chat.js";
import {
  createDoc,
  createPage,
  docPages,
  editPage,
  listDocs,
  pageListing,
  rankDocs,
  renderDocs,
  renderPages,
  PARENT_TYPES,
} from "./docs.js";
import {
  formatDuration,
  getEntries,
  logTime,
  renderEntries,
  runningEntry,
  startTimer,
  stopTimer,
} from "./time.js";
import {
  createContainer,
  createGoal,
  createWebhook,
  deleteContainer,
  deleteGoal,
  deleteWebhook,
  listContainers,
  listGoals,
  listMembers,
  listWebhooks,
  parentHint,
  renameContainer,
  renderContainers,
  renderGoals,
  renderMembers,
  renderWebhooks,
  listWorkspaces,
  renderWorkspaces,
  updateGoal,
  updateWebhook,
  type Kind,
} from "./admin.js";
import { buildTaskBody, parseDate, parseDuration, PRIORITIES, type TaskFields } from "./fields.js";
import {
  addChecklistItem,
  addDependency,
  createChecklist,
  deleteChecklist,
  deleteChecklistItem,
  editChecklistItem,
  linkTasks,
  removeDependency,
  renameChecklist,
  renderChecklists,
  unlinkTasks,
  type Checklist,
} from "./relations.js";
import { clearFieldValue, coerceValue, listFields, renderFields, setFieldValue } from "./customfields.js";
import { loadSource, uploadAttachment } from "./attachments.js";
import {
  applyTemplate,
  listTemplates,
  listViews,
  renderTemplates,
  renderViews,
  viewTasks,
} from "./views.js";

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
// Mutating tools. `destructive` is reserved for the three that remove data —
// clients surface that hint differently, so a rename must not claim it.
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const destructive = { ...writes, destructiveHint: true };

/**
 * Register a tool that mutates ClickUp. Under CLICKUP_MODE=read it is never
 * registered at all — the model cannot call what it cannot see, which is a
 * stronger guarantee than refusing at call time.
 */
// Cast keeps registerTool's generic inference at each call site; the return
// value is never used, so handing back undefined in read mode is harmless.
const registerWrite = ((name: string, config: never, cb: never) =>
  cfg.mode === "read" ? undefined : server.registerTool(name, config, cb)) as
  typeof server.registerTool;

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

registerWrite(
  "set_status",
  {
    title: "Set a ClickUp task status",
    description:
      "Move a task to another status — e.g. to prod qa when work is finished. " +
      "The status is matched against the list's own statuses, " +
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

registerWrite(
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

// ─────────────────────────────────────────────────────────── task write tools

/** Resolve a ref or hand back the "pick one" text — every write starts here. */
async function needTask(
  ref: string,
  action: string
): Promise<{ taskId: string; useCustomId: boolean } | { error: string }> {
  const { resolved, candidates } = await resolveRef(client, ref);
  if (resolved) return resolved;
  return {
    error: candidates?.length
      ? `"${ref}" is ambiguous — ${action} did nothing. Pick one and retry:\n${candidates
          .map((c) => `- ${c.name} [${c.status ?? "?"}] — id ${c.taskId}`)
          .join("\n")}`
      : `No task matched "${ref}". ${action} did nothing.`,
  };
}

/** Statuses are exact API strings; reuse the loose matcher rather than guessing. */
async function pickStatus(listId: string, wanted: string): Promise<{ status: string } | { error: string }> {
  const available = await client.listStatuses(listId);
  const target = resolveStatus(wanted, available);
  if (target) return { status: target };
  return {
    error:
      `"${wanted}" is not a status in that list (or matches more than one). Nothing was changed. ` +
      `Valid statuses:\n${available.map((s) => `- ${JSON.stringify(s)}`).join("\n")}`,
  };
}

const taskFieldShape = {
  name: z.string().optional().describe("Task title."),
  description: z.string().optional().describe("Task description. Plain text."),
  status: z.string().optional().describe("Status name, matched loosely against the list's own."),
  priority: z.enum(PRIORITIES).optional().describe("urgent | high | normal | low."),
  due_date: z.string().optional().describe("Due date: ISO ('2026-03-01T17:00') or unix ms."),
  start_date: z.string().optional().describe("Start date: ISO or unix ms."),
  time_estimate: z.string().optional().describe("Estimate: '2h30m', '90m', '1.5h', or bare minutes."),
  assignees: z.array(z.string()).optional().describe("Numeric ClickUp user ids to assign (see list_members)."),
};

registerWrite(
  "create_task",
  {
    title: "Create a ClickUp task",
    description:
      "Create a task in a List. Use manage_hierarchy to find the list_id and list_members for " +
      "assignee ids. Set parent to make it a subtask of an existing task.",
    annotations: writes,
    inputSchema: {
      list_id: z.string().describe("List id the task belongs in."),
      ...taskFieldShape,
      name: z.string().describe("Task title."),
      tags: z.array(z.string()).optional().describe("Tag names. Only settable at creation."),
      parent: z.string().optional().describe("Native task id to nest under, making this a subtask."),
    },
  },
  async ({ list_id, ...fields }) => {
    if (fields.status) {
      const picked = await pickStatus(list_id, fields.status);
      if ("error" in picked) return text(picked.error);
      fields.status = picked.status;
    }
    const task = await client.createTask(list_id, buildTaskBody(fields as TaskFields, "create"));
    return text(`Created "${task.name}" — id \`${task.id}\`\n${task.url ?? ""}`);
  }
);

registerWrite(
  "update_task",
  {
    title: "Update a ClickUp task",
    description:
      "Change fields on an existing task: name, description, status, priority, dates, estimate, " +
      "assignees, parent, archived. Only the fields you pass are touched — omitted fields keep " +
      "their values. Assignees are added; use remove_assignees to unassign.",
    annotations: { ...writes, idempotentHint: true },
    inputSchema: {
      ref: z.string().describe("Task URL, custom id, native id, fuzzy name, or 'current'."),
      ...taskFieldShape,
      remove_assignees: z.array(z.string()).optional().describe("Numeric user ids to unassign."),
      parent: z.string().optional().describe("Move under a different parent task."),
      archived: z.boolean().optional().describe("Archive (true) or restore (false) the task."),
    },
  },
  async ({ ref, ...fields }) => {
    const found = await needTask(ref, "The update");
    if ("error" in found) return text(found.error);

    if (fields.status) {
      const task = await client.getTask(found.taskId, found.useCustomId);
      if (!task.list?.id) return text(`Task ${task.id} has no list, so its statuses are unknown.`);
      const picked = await pickStatus(task.list.id, fields.status);
      if ("error" in picked) return text(picked.error);
      fields.status = picked.status;
    }

    const body = buildTaskBody(fields as TaskFields, "update");
    if (!Object.keys(body).length) return text("No fields given — nothing was changed.");

    const updated = await client.updateTask(found.taskId, body, found.useCustomId);
    return text(
      `Updated "${updated.name ?? found.taskId}": ${Object.keys(body).join(", ")}\n${updated.url ?? ""}`
    );
  }
);

registerWrite(
  "delete_task",
  {
    title: "Delete a ClickUp task",
    description:
      "Permanently delete a task. ClickUp does not undo this. Requires confirm=true, and you " +
      "should ask the user before calling it. To hide a task instead, use update_task with " +
      "archived=true.",
    annotations: destructive,
    inputSchema: {
      ref: z.string().describe("Task URL, custom id, native id, or fuzzy name. 'current' is refused."),
      confirm: z.boolean().describe("Must be true. Guards against an accidental delete."),
    },
  },
  async ({ ref, confirm }) => {
    if (!confirm) return text("Not deleted — call again with confirm=true once the user has agreed.");
    // 'current' is a stored pointer, not something the user just looked at. A
    // delete has to name its target explicitly.
    if (/^(current|this task)$/i.test(ref.trim())) {
      return text("Refusing to delete via 'current'. Pass the task's id or URL explicitly.");
    }
    const found = await needTask(ref, "The delete");
    if ("error" in found) return text(found.error);
    const task = await client.getTask(found.taskId, found.useCustomId).catch(() => null);
    await client.deleteTask(found.taskId, found.useCustomId);
    return text(`Deleted "${task?.name ?? found.taskId}" (id ${found.taskId}). This cannot be undone.`);
  }
);

// ────────────────────────────────────────────────────────────────────── docs

server.registerTool(
  "search_docs",
  {
    title: "Search ClickUp Docs",
    description:
      "Find Docs by name. ClickUp's Docs endpoint has no text search, so this lists the " +
      "workspace's Docs and ranks them by name here — narrow with parent_id/parent_type when a " +
      "workspace has many. Returns doc ids for read_doc.",
    annotations: readOnly,
    inputSchema: {
      query: z.string().optional().describe("Name to match. Omit to list everything in scope."),
      parent_id: z.string().optional().describe("Space/Folder/List id to look inside."),
      parent_type: z.enum(PARENT_TYPES).optional().describe("What parent_id refers to."),
      archived: z.boolean().optional().describe("Include archived Docs. Default false."),
    },
  },
  async ({ query, parent_id, parent_type, archived }) => {
    const { docs, exhausted } = await listDocs(client, {
      parentId: parent_id,
      parentType: parent_type,
      archived,
    });
    return text(renderDocs(rankDocs(docs, query ?? ""), exhausted));
  }
);

server.registerTool(
  "read_doc",
  {
    title: "Read a ClickUp Doc",
    description:
      "Read a Doc's pages as markdown, sub-pages included. Get the doc_id from search_docs. " +
      "Use outline=true on a large Doc to see page names and ids without pulling every page's body.",
    annotations: readOnly,
    inputSchema: {
      doc_id: z.string().describe("Doc id from search_docs."),
      outline: z.boolean().optional().describe("Page titles and ids only, no content."),
    },
  },
  async ({ doc_id, outline }) => {
    const pages = outline ? await pageListing(client, doc_id) : await docPages(client, doc_id);
    if (!pages?.length) return text(`Doc ${doc_id} has no readable pages.`);
    return text(`# Doc ${doc_id}\n\n${renderPages(pages)}`);
  }
);

registerWrite(
  "write_doc",
  {
    title: "Write to a ClickUp Doc",
    description:
      "Create a Doc, add a page to one, or edit an existing page. Editing defaults to appending " +
      "so an agent write cannot silently wipe a page someone else wrote — pass mode='replace' " +
      "deliberately, and only when the user asked for a rewrite.",
    annotations: writes,
    inputSchema: {
      action: z.enum(["create_doc", "create_page", "edit_page"]).describe("What to write."),
      name: z.string().optional().describe("Doc or page name. Required for create_doc/create_page."),
      content: z.string().optional().describe("Page body, markdown."),
      doc_id: z.string().optional().describe("Target Doc. Required for create_page and edit_page."),
      page_id: z.string().optional().describe("Target page. Required for edit_page."),
      parent_id: z.string().optional().describe("For create_doc: the Space/Folder/List to file it under."),
      parent_type: z.enum(PARENT_TYPES).optional().describe("For create_doc: what parent_id refers to."),
      mode: z
        .enum(["append", "prepend", "replace"])
        .optional()
        .describe("edit_page only. Default append. 'replace' overwrites the whole page."),
    },
  },
  async ({ action, name, content, doc_id, page_id, parent_id, parent_type, mode }) => {
    if (action === "create_doc") {
      if (!name) return text("create_doc needs a name.");
      if (parent_id && !parent_type) return text("parent_id needs parent_type (SPACE/FOLDER/LIST/...).");
      const doc = await createDoc(
        client,
        name,
        parent_id && parent_type ? { id: parent_id, type: parent_type } : undefined
      );
      return text(`Created Doc "${doc.name ?? name}" — id \`${doc.id}\`.`);
    }
    if (action === "create_page") {
      if (!doc_id || !name) return text("create_page needs doc_id and name.");
      const page = await createPage(client, doc_id, { name, content });
      return text(`Added page "${page.name ?? name}" — id \`${page.id}\` in Doc ${doc_id}.`);
    }
    if (!doc_id || !page_id) return text("edit_page needs doc_id and page_id.");
    const edit = mode ?? "append";
    await editPage(client, doc_id, page_id, { name, content, content_edit_mode: edit });
    return text(`Page ${page_id} updated (${edit}).`);
  }
);

// ───────────────────────────────────────────────────────────── time tracking

server.registerTool(
  "get_time_entries",
  {
    title: "Get ClickUp time entries",
    description:
      "Time logged in a range, with the total. Defaults to your own last 30 days; pass assignees " +
      "for other people (admin only). A running timer shows as 'running' and is left out of the " +
      "total, because ClickUp reports it as a negative duration.",
    annotations: readOnly,
    inputSchema: {
      start_date: z.number().optional().describe("Range start, unix ms."),
      end_date: z.number().optional().describe("Range end, unix ms."),
      assignees: z.array(z.string()).optional().describe("Numeric user ids. Admin-only for others."),
      ref: z.string().optional().describe("Limit to one task (URL, id, fuzzy name, or 'current')."),
      list_id: z.string().optional().describe("Limit to a List."),
      space_id: z.string().optional().describe("Limit to a Space."),
      folder_id: z.string().optional().describe("Limit to a Folder."),
      include_running: z.boolean().optional().describe("Also report the timer running right now."),
    },
  },
  async ({ ref, include_running, ...opts }) => {
    let taskId: string | undefined;
    if (ref) {
      const found = await needTask(ref, "The lookup");
      if ("error" in found) return text(found.error);
      taskId = found.taskId;
    }
    const entries = await getEntries(client, {
      startDate: opts.start_date,
      endDate: opts.end_date,
      assignees: opts.assignees,
      taskId,
      listId: opts.list_id,
      spaceId: opts.space_id,
      folderId: opts.folder_id,
    });
    let extra = "";
    if (include_running) {
      const running = await runningEntry(client).catch(() => null);
      extra = running
        ? `\n\n**Running now:** ${running.task?.name ?? "(no task)"} since ` +
          `${new Date(Number(running.start ?? 0)).toISOString().slice(0, 16).replace("T", " ")}` +
          ` (${formatDuration(Date.now() - Number(running.start ?? Date.now()))} so far).`
        : "\n\n_No timer running._";
    }
    return text(renderEntries(entries) + extra);
  }
);

registerWrite(
  "track_time",
  {
    title: "Track time on a ClickUp task",
    description:
      "Log time after the fact ('log'), or run a timer ('start' / 'stop'). Logging needs a " +
      "duration like '2h30m'; it defaults to ending now, so a 2h log covers the last two hours " +
      "unless you pass start.",
    annotations: writes,
    inputSchema: {
      action: z.enum(["log", "start", "stop"]).describe("log a finished block, or start/stop a timer."),
      ref: z.string().optional().describe("Task to track against. Required for log, optional for start."),
      duration: z.string().optional().describe("For log: '2h30m', '90m', '1.5h', or bare minutes."),
      start: z.string().optional().describe("For log: when the block began. ISO or unix ms."),
      description: z.string().optional().describe("Note on the entry."),
      billable: z.boolean().optional().describe("Mark the entry billable."),
    },
  },
  async ({ action, ref, duration, start, description, billable }) => {
    if (action === "stop") {
      const stopped = await stopTimer(client);
      const ms = Number(stopped.data?.duration ?? 0);
      return text(ms > 0 ? `Timer stopped — ${formatDuration(ms)} logged.` : "Timer stopped.");
    }

    let found: { taskId: string; useCustomId: boolean } | undefined;
    if (ref) {
      const r = await needTask(ref, `The ${action}`);
      if ("error" in r) return text(r.error);
      found = r;
    }

    if (action === "start") {
      await startTimer(client, { tid: found?.taskId, description, billable }, found?.useCustomId ?? false);
      return text(`Timer started${found ? ` on ${found.taskId}` : ""}.`);
    }

    if (!found) return text("log needs a task ref.");
    if (!duration) return text("log needs a duration, e.g. '2h30m'.");
    const ms = parseDuration(duration);
    // ClickUp wants the block's start; default to "the duration ending now",
    // which is what someone logging work they just finished means.
    const startMs = start ? parseDate(start) : Date.now() - ms;
    await logTime(
      client,
      { tid: found.taskId, description, start: startMs, duration: ms, billable },
      found.useCustomId
    );
    return text(`Logged ${formatDuration(ms)} on ${found.taskId}.`);
  }
);

// ──────────────────────────────────────────────── hierarchy, members, admin

registerWrite(
  "manage_hierarchy",
  {
    title: "Browse or change Spaces, Folders and Lists",
    description:
      "List / create / rename / delete the workspace containers. Start with action='list', " +
      "kind='space' to discover ids, then drill down with space_id or folder_id. This is where " +
      "list_ids for create_task and query_tasks come from. Deleting takes everything inside with it.",
    annotations: writes,
    inputSchema: {
      kind: z.enum(["space", "folder", "list"]).describe("Which container type."),
      action: z.enum(["list", "create", "rename", "delete"]).describe("What to do. Default-safe: list."),
      id: z.string().optional().describe("Target container id. Required for rename and delete."),
      name: z.string().optional().describe("New name. Required for create and rename."),
      space_id: z.string().optional().describe("Parent Space for folders, or a folderless List."),
      folder_id: z.string().optional().describe("Parent Folder for a List."),
      confirm: z.boolean().optional().describe("Required true for delete — it removes the contents too."),
    },
  },
  async ({ kind, action, id, name, space_id, folder_id, confirm }) => {
    const k = kind as Kind;
    if (action === "list") {
      const items = await listContainers(client, k, space_id, folder_id);
      if (!items) return text(`Listing ${k}s needs a parent — ${parentHint(k)}`);
      return text(renderContainers(k, items));
    }
    if (action === "create") {
      if (!name) return text("create needs a name.");
      const made = await createContainer(client, k, name, space_id, folder_id);
      if (!made) return text(`Creating a ${k} needs a parent — ${parentHint(k)}`);
      return text(`Created ${k} "${made.name ?? name}" — id \`${made.id}\`.`);
    }
    if (!id) return text(`${action} needs the ${k}'s id.`);
    if (action === "rename") {
      if (!name) return text("rename needs a name.");
      const renamed = await renameContainer(client, k, id, name);
      return text(`Renamed ${k} ${id} to "${renamed.name ?? name}".`);
    }
    if (!confirm) {
      return text(
        `Not deleted. Deleting a ${k} also deletes everything inside it. Call again with ` +
          `confirm=true once the user has agreed.`
      );
    }
    await deleteContainer(client, k, id);
    return text(`Deleted ${k} ${id} and its contents. This cannot be undone.`);
  }
);

server.registerTool(
  "list_members",
  {
    title: "List ClickUp workspace members",
    description:
      "Everyone in the workspace with their numeric user id and role. Those ids are what " +
      "assignees expects on create_task, update_task, query_tasks, and get_time_entries.",
    annotations: readOnly,
    inputSchema: {},
  },
  async () => text(renderMembers(await listMembers(client)))
);

registerWrite(
  "manage_goal",
  {
    title: "Manage ClickUp Goals",
    description:
      "List, create, update, or delete workspace Goals (OKRs) with their progress and owners.",
    annotations: writes,
    inputSchema: {
      action: z.enum(["list", "create", "update", "delete"]).describe("What to do."),
      goal_id: z.string().optional().describe("Target Goal. Required for update and delete."),
      name: z.string().optional().describe("Goal name. Required for create."),
      description: z.string().optional().describe("Goal description."),
      due_date: z.string().optional().describe("ISO date or unix ms."),
      owners: z.array(z.string()).optional().describe("Numeric user ids to own the Goal."),
      remove_owners: z.array(z.string()).optional().describe("update only: user ids to drop."),
      confirm: z.boolean().optional().describe("Required true for delete."),
    },
  },
  async ({ action, goal_id, name, description, due_date, owners, remove_owners, confirm }) => {
    const ids = (v?: string[]) => v?.map(Number).filter(Number.isFinite);
    if (action === "list") return text(renderGoals(await listGoals(client)));
    if (action === "create") {
      if (!name) return text("create needs a name.");
      const made = await createGoal(client, {
        name,
        description,
        due_date: due_date ? parseDate(due_date) : undefined,
        owners: ids(owners),
      });
      return text(`Created Goal "${name}" — id \`${made.goal?.id ?? "?"}\`.`);
    }
    if (!goal_id) return text(`${action} needs a goal_id.`);
    if (action === "update") {
      await updateGoal(client, goal_id, {
        name,
        description,
        due_date: due_date ? parseDate(due_date) : undefined,
        add_owners: ids(owners),
        rem_owners: ids(remove_owners),
      });
      return text(`Goal ${goal_id} updated.`);
    }
    if (!confirm) return text("Not deleted — call again with confirm=true once the user has agreed.");
    await deleteGoal(client, goal_id);
    return text(`Deleted Goal ${goal_id}.`);
  }
);

registerWrite(
  "manage_webhook",
  {
    title: "Manage ClickUp webhooks",
    description:
      "List, create, update, or delete workspace webhooks, with their delivery health. Events are " +
      "ClickUp's own names, e.g. taskCreated, taskStatusUpdated, taskCommentPosted — or ['*'] for all.",
    annotations: writes,
    inputSchema: {
      action: z.enum(["list", "create", "update", "delete"]).describe("What to do."),
      webhook_id: z.string().optional().describe("Target webhook. Required for update and delete."),
      endpoint: z.string().optional().describe("HTTPS URL to POST events to. Required for create."),
      events: z.array(z.string()).optional().describe("Event names, or ['*'] for everything."),
      space_id: z.string().optional().describe("Scope the webhook to a Space."),
      folder_id: z.string().optional().describe("Scope the webhook to a Folder."),
      list_id: z.string().optional().describe("Scope the webhook to a List."),
      status: z.string().optional().describe("update only: 'active' or 'suspended'."),
      confirm: z.boolean().optional().describe("Required true for delete."),
    },
  },
  async ({ action, webhook_id, endpoint, events, space_id, folder_id, list_id, status, confirm }) => {
    if (action === "list") return text(renderWebhooks(await listWebhooks(client)));
    if (action === "create") {
      if (!endpoint || !events?.length) return text("create needs an endpoint and at least one event.");
      const made = await createWebhook(client, { endpoint, events, space_id, folder_id, list_id });
      return text(`Webhook created — id \`${made.id ?? made.webhook?.id ?? "?"}\` → ${endpoint}.`);
    }
    if (!webhook_id) return text(`${action} needs a webhook_id.`);
    if (action === "update") {
      await updateWebhook(client, webhook_id, { endpoint, events, status });
      return text(`Webhook ${webhook_id} updated.`);
    }
    if (!confirm) return text("Not deleted — call again with confirm=true once the user has agreed.");
    await deleteWebhook(client, webhook_id);
    return text(`Deleted webhook ${webhook_id}.`);
  }
);


// ──────────────────────────────────────────────── dependencies and links

registerWrite(
  "manage_dependencies",
  {
    title: "Link or sequence ClickUp tasks",
    description:
      "Create or remove the edges get_schedule walks. A *dependency* is scheduling: " +
      "direction='waits_for' means this task can't start until the other finishes, " +
      "direction='blocks' is the reverse. A *link* is just a cross-reference with no " +
      "scheduling meaning. Adding a dependency changes the critical path — re-run get_schedule " +
      "afterwards if the user cares about dates.",
    annotations: writes,
    inputSchema: {
      action: z.enum(["add", "remove", "link", "unlink"]).describe("add/remove a dependency, or link/unlink a reference."),
      ref: z.string().describe("The task being changed. URL, id, fuzzy name, or 'current'."),
      other: z.string().describe("The task on the other end. URL, id, or fuzzy name."),
      direction: z
        .enum(["waits_for", "blocks"])
        .optional()
        .describe("For add/remove. waits_for = ref waits on other. Default waits_for."),
    },
  },
  async ({ action, ref, other, direction }) => {
    const a = await needTask(ref, `The ${action}`);
    if ("error" in a) return text(a.error);
    const b = await needTask(other, `The ${action}`);
    if ("error" in b) return text(b.error);
    if (a.taskId === b.taskId) return text("A task can't depend on itself. Nothing was changed.");

    const dir = direction ?? "waits_for";
    if (action === "add") {
      await addDependency(client, a.taskId, b.taskId, dir, a.useCustomId);
      return text(
        dir === "waits_for"
          ? `${a.taskId} now waits for ${b.taskId}.`
          : `${a.taskId} now blocks ${b.taskId}.`
      );
    }
    if (action === "remove") {
      await removeDependency(client, a.taskId, b.taskId, dir, a.useCustomId);
      return text(`Dependency between ${a.taskId} and ${b.taskId} removed.`);
    }
    if (action === "link") {
      await linkTasks(client, a.taskId, b.taskId, a.useCustomId);
      return text(`${a.taskId} linked to ${b.taskId}.`);
    }
    await unlinkTasks(client, a.taskId, b.taskId, a.useCustomId);
    return text(`Link between ${a.taskId} and ${b.taskId} removed.`);
  }
);

// ─────────────────────────────────────────────────────────────── checklists

registerWrite(
  "manage_checklist",
  {
    title: "Manage a task's checklists",
    description:
      "Create checklists on a task and tick their items off. Checklist and item ids come back " +
      "from get_task_context. Use action='check' / 'uncheck' to resolve an item.",
    annotations: writes,
    inputSchema: {
      action: z
        .enum(["create", "rename", "delete", "add_item", "edit_item", "check", "uncheck", "delete_item"])
        .describe("What to do."),
      ref: z.string().optional().describe("Task, for action='create'. URL, id, fuzzy name, or 'current'."),
      checklist_id: z.string().optional().describe("Target checklist. Required for everything but create."),
      item_id: z.string().optional().describe("Target item. Required for edit_item/check/uncheck/delete_item."),
      name: z.string().optional().describe("Checklist or item text."),
      assignee: z.string().optional().describe("Numeric user id to assign an item to."),
      confirm: z.boolean().optional().describe("Required true for delete (removes every item too)."),
    },
  },
  async ({ action, ref, checklist_id, item_id, name, assignee, confirm }) => {
    const who = assignee ? Number(assignee) : undefined;
    if (action === "create") {
      if (!ref || !name) return text("create needs a task ref and a name.");
      const found = await needTask(ref, "The checklist");
      if ("error" in found) return text(found.error);
      const made = await createChecklist(client, found.taskId, name, found.useCustomId);
      return text(`Checklist "${name}" created — id \`${made.checklist?.id ?? "?"}\`.`);
    }
    if (!checklist_id) return text(`${action} needs a checklist_id (get_task_context shows them).`);

    if (action === "rename") {
      if (!name) return text("rename needs a name.");
      await renameChecklist(client, checklist_id, name);
      return text(`Checklist ${checklist_id} renamed to "${name}".`);
    }
    if (action === "delete") {
      if (!confirm) return text("Not deleted — a checklist takes its items with it. Retry with confirm=true.");
      await deleteChecklist(client, checklist_id);
      return text(`Checklist ${checklist_id} deleted.`);
    }
    if (action === "add_item") {
      if (!name) return text("add_item needs a name.");
      await addChecklistItem(client, checklist_id, name, who);
      return text(`Added "${name}" to checklist ${checklist_id}.`);
    }
    if (!item_id) return text(`${action} needs an item_id.`);
    if (action === "delete_item") {
      await deleteChecklistItem(client, checklist_id, item_id);
      return text(`Item ${item_id} deleted.`);
    }
    const resolved = action === "check" ? true : action === "uncheck" ? false : undefined;
    await editChecklistItem(client, checklist_id, item_id, { name, resolved, assignee: who });
    return text(
      action === "check"
        ? `Item ${item_id} checked off.`
        : action === "uncheck"
          ? `Item ${item_id} unchecked.`
          : `Item ${item_id} updated.`
    );
  }
);

// ────────────────────────────────────────────────────────────── custom fields

registerWrite(
  "manage_custom_fields",
  {
    title: "Read and set ClickUp custom fields",
    description:
      "action='list' shows a List's custom fields with their ids, types, and dropdown options — " +
      "call it first, because values are typed per field. Then 'set' writes one by name or id " +
      "(a dropdown takes the option's label and it is matched for you), and 'clear' empties it. " +
      "This is also where the field_id for query_tasks' custom_fields filter comes from.",
    annotations: writes,
    inputSchema: {
      action: z.enum(["list", "set", "clear"]).describe("What to do."),
      list_id: z.string().optional().describe("For list: the List whose fields you want."),
      ref: z.string().optional().describe("For set/clear: the task. URL, id, fuzzy name, or 'current'."),
      field: z.string().optional().describe("For set/clear: the field's name or id."),
      value: z.string().optional().describe("For set: the value. A dropdown takes the option label."),
    },
  },
  async ({ action, list_id, ref, field, value }) => {
    if (action === "list") {
      if (!list_id) return text("list needs a list_id (manage_hierarchy finds one).");
      return text(renderFields(await listFields(client, list_id)));
    }
    if (!ref || !field) return text(`${action} needs a task ref and a field name or id.`);

    const found = await needTask(ref, `The ${action}`);
    if ("error" in found) return text(found.error);
    const task = await client.getTask(found.taskId, found.useCustomId);
    if (!task.list?.id) return text(`Task ${task.id} has no list, so its fields are unknown.`);

    const fields = await listFields(client, task.list.id);
    const target =
      fields.find((f) => f.id === field) ??
      fields.find((f) => (f.name ?? "").toLowerCase() === field.toLowerCase());
    if (!target) {
      return text(
        `No custom field called "${field}" on that List. Available:\n` +
          fields.map((f) => `- ${f.name} (${f.type}) \`${f.id}\``).join("\n")
      );
    }

    if (action === "clear") {
      await clearFieldValue(client, found.taskId, target.id, found.useCustomId);
      return text(`Cleared "${target.name}" on ${found.taskId}.`);
    }
    if (value === undefined) return text("set needs a value.");
    const coerced = coerceValue(target, value);
    if ("error" in coerced) return text(`${coerced.error}\nNothing was changed.`);
    await setFieldValue(client, found.taskId, target.id, coerced.value, found.useCustomId);
    return text(`Set "${target.name}" to ${JSON.stringify(coerced.value)} on ${found.taskId}.`);
  }
);

// ───────────────────────────────────────────────────────────────── uploads

registerWrite(
  "upload_attachment",
  {
    title: "Attach a file to a ClickUp task",
    description:
      "Upload a file to a task from a local path, a URL, or base64 data. This is the return " +
      "trip for screenshots: get_task_context reads images out, this puts one back — e.g. " +
      "attaching a screenshot of the fix to the bug it closes.",
    annotations: writes,
    inputSchema: {
      ref: z.string().describe("Task to attach to. URL, id, fuzzy name, or 'current'."),
      file_path: z.string().optional().describe("Absolute path to a local file."),
      url: z.string().optional().describe("URL to download and attach (ClickUp takes bytes, not links)."),
      base64: z.string().optional().describe("Base64 file data. A data: URI is fine. Needs filename."),
      filename: z.string().optional().describe("Name to show in ClickUp. Required with base64."),
    },
  },
  async ({ ref, file_path, url, base64, filename }) => {
    const found = await needTask(ref, "The upload");
    if ("error" in found) return text(found.error);
    const src = await loadSource({ file_path, url, base64, filename });
    if ("error" in src) return text(`${src.error} Nothing was uploaded.`);
    const up = await uploadAttachment(client, found.taskId, src.bytes, src.filename, found.useCustomId);
    if ("error" in up) return text(`${up.error} Nothing was uploaded.`);
    const kb = Math.max(1, Math.round(src.bytes.length / 1024));
    return text(`Attached "${src.filename}" (${kb} KB) to ${found.taskId}.\n${up.result.url ?? ""}`);
  }
);

// ─────────────────────────────────────────────────────── views and templates

server.registerTool(
  "get_views",
  {
    title: "Read ClickUp views",
    description:
      "A View is the saved filter and grouping a team actually works out of — 'My Sprint', " +
      "'Blocked', 'This week'. action='list' shows the views on a List/Folder/Space/Workspace; " +
      "action='tasks' returns what a view currently shows, which is the honest answer to " +
      "\\\"what's on the board\\\" when the filter lives in ClickUp rather than in your arguments.",
    annotations: readOnly,
    inputSchema: {
      action: z.enum(["list", "tasks"]).describe("List the views, or read one view's tasks."),
      parent: z
        .enum(["list", "folder", "space", "team"])
        .optional()
        .describe("For list: where the views live. 'team' means workspace-level. Default team."),
      parent_id: z.string().optional().describe("For list: the List/Folder/Space id. Not needed for team."),
      view_id: z.string().optional().describe("For tasks: the view to read."),
    },
  },
  async ({ action, parent, parent_id, view_id }) => {
    if (action === "list") {
      const p = parent ?? "team";
      if (p !== "team" && !parent_id) return text(`Listing ${p} views needs parent_id.`);
      return text(renderViews(await listViews(client, p, parent_id)));
    }
    if (!view_id) return text("tasks needs a view_id (get it from action='list').");
    const { tasks, exhausted } = await viewTasks(client, view_id);
    if (!tasks.length) return text("That view is currently empty.");
    const rows = tasks.map((t) => {
      const due = t.due_date ? new Date(Number(t.due_date)).toISOString().slice(0, 10) : "—";
      const owners = (t.assignees ?? []).map((a) => a.username || a.email).join(", ") || "—";
      return `| \`${t.id}\` | ${t.name} | ${t.status?.status ?? "—"} | ${due} | ${owners} |`;
    });
    const more = exhausted ? "" : "\n\n_Page cap reached — the view holds more._";
    return text(
      `# View ${view_id} — ${tasks.length} task(s)\n\n| ID | Name | Status | Due | Owner |\n|---|---|---|---|---|\n${rows.join("\n")}${more}`
    );
  }
);

registerWrite(
  "task_templates",
  {
    title: "List or apply ClickUp task templates",
    description:
      "action='list' shows the workspace's task templates; action='apply' creates a task in a " +
      "List from one, which brings the template's subtasks and checklists with it — the thing " +
      "create_task can't do.",
    annotations: writes,
    inputSchema: {
      action: z.enum(["list", "apply"]).describe("What to do."),
      template_id: z.string().optional().describe("For apply: the template."),
      list_id: z.string().optional().describe("For apply: the List to create in."),
      name: z.string().optional().describe("For apply: the new task's name."),
    },
  },
  async ({ action, template_id, list_id, name }) => {
    if (action === "list") return text(renderTemplates(await listTemplates(client)));
    if (!template_id || !list_id || !name) return text("apply needs template_id, list_id, and name.");
    const made = await applyTemplate(client, list_id, template_id, name);
    return text(`Created "${name}" from template ${template_id} — id \`${made.id ?? "?"}\`.\n${made.url ?? ""}`);
  }
);

// ────────────────────────────────────────────────────────────── bulk edits

registerWrite(
  "bulk_update_tasks",
  {
    title: "Update many ClickUp tasks at once",
    description:
      "Apply the same change to every task matching a filter — close a sprint's tasks, reassign " +
      "a leaver's work, push a set of due dates. Run it with confirm omitted first: that returns " +
      "the exact list it WOULD change without touching anything. Show the user that list, then " +
      "call again with confirm=true.",
    annotations: writes,
    inputSchema: {
      ...scopeShape,
      set_status: z.string().optional().describe("New status for all matches."),
      priority: z.enum(PRIORITIES).optional().describe("New priority for all matches."),
      due_date: z.string().optional().describe("New due date, ISO or unix ms."),
      add_assignees: z.array(z.string()).optional().describe("Numeric user ids to add to all matches."),
      remove_assignees: z.array(z.string()).optional().describe("Numeric user ids to remove from all matches."),
      archived: z.boolean().optional().describe("Archive or restore all matches."),
      limit: z.number().int().min(1).max(100).optional().describe("Cap on tasks changed. Default 25, max 100."),
      confirm: z.boolean().optional().describe("Omit for a dry run. true actually writes."),
    },
  },
  async ({ set_status, priority, due_date, add_assignees, remove_assignees, archived, limit, confirm, ...scope }) => {
    const fields: TaskFields = {
      status: set_status,
      priority,
      due_date,
      assignees: add_assignees,
      remove_assignees,
      archived,
    };
    const body = buildTaskBody(fields, "update");
    if (!Object.keys(body).length) return text("No changes given — nothing to apply.");

    const cap = limit ?? 25;
    const { tasks, exhausted } = await client.queryTasks({
      ...toQuery(scope),
      pageLimit: Math.max(1, Math.ceil((cap + 1) / 100)),
    });
    const targets = tasks.slice(0, cap);
    if (!targets.length) return text("No tasks matched those filters. Nothing was changed.");

    const overflow =
      tasks.length > cap || !exhausted
        ? `\n\n⚠️ More tasks match than the cap of ${cap} — only the ${targets.length} listed are affected. ` +
          `Narrow the filters or raise limit to cover the rest.`
        : "";
    const list = targets
      .map((t) => `- ${t.name} [${t.status?.status ?? "?"}] — \`${t.id}\``)
      .join("\n");

    if (!confirm) {
      return text(
        `**Dry run — nothing changed.** ${targets.length} task(s) would be updated ` +
          `(${Object.keys(body).join(", ")}):\n${list}${overflow}\n\n` +
          `Show this to the user, then call again with confirm=true.`
      );
    }

    // A per-task status has to be re-matched against that task's own list —
    // two lists can spell the "same" status differently.
    const statusCache = new Map<string, string | null>();
    const results = await mapLimit(targets, 5, async (t) => {
      try {
        const per = { ...body };
        if (set_status) {
          const listId = t.list?.id ?? "";
          if (!statusCache.has(listId)) {
            const available = listId ? await client.listStatuses(listId) : [];
            statusCache.set(listId, resolveStatus(set_status, available));
          }
          const resolvedStatus = statusCache.get(listId);
          if (!resolvedStatus) return { t, error: `"${set_status}" is not a status in ${t.list?.name ?? "its list"}` };
          per.status = resolvedStatus;
        }
        await client.updateTask(t.id, per);
        return { t };
      } catch (e) {
        return { t, error: (e as Error).message.slice(0, 120) };
      }
    });

    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    return text(
      `Updated ${ok.length}/${targets.length} task(s): ${Object.keys(body).join(", ")}\n` +
        ok.map((r) => `- ${r.t.name}`).join("\n") +
        (failed.length
          ? `\n\n**${failed.length} failed — unchanged:**\n${failed
              .map((r) => `- ${r.t.name}: ${r.error}`)
              .join("\n")}`
          : "") +
        overflow
    );
  }
);

// ─────────────────────────────────────────────────────────────── chat write

registerWrite(
  "send_chat_message",
  {
    title: "Post to a ClickUp Chat channel",
    description:
      "Send a message to a Chat channel, or reply in a thread by passing reply_to. This posts " +
      "to a channel real people are reading — show the user what you're about to send first. " +
      "ClickUp's Chat API is experimental and may change without notice.",
    annotations: writes,
    inputSchema: {
      channel_id: z.string().optional().describe("Channel to post in, from list_chat_channels."),
      reply_to: z.string().optional().describe("Message id to reply to instead of posting to the channel."),
      content: z.string().min(1).describe("Message body, markdown."),
    },
  },
  async ({ channel_id, reply_to, content }) => {
    if (!channel_id && !reply_to) return text("Give a channel_id to post, or reply_to to answer a thread.");
    const msg = reply_to
      ? await replyToMessage(client, reply_to, content)
      : await sendMessage(client, channel_id!, content);
    return text(
      reply_to
        ? `Replied in thread ${reply_to} (message \`${msg.id ?? "?"}\`).`
        : `Posted to channel ${channel_id} (message \`${msg.id ?? "?"}\`).`
    );
  }
);

// ───────────────────────────────────────────────────────────── workspaces

server.registerTool(
  "list_workspaces",
  {
    title: "List ClickUp workspaces",
    description:
      "Every workspace this token can reach, marking the active one. A personal token is not " +
      "scoped to a single workspace — use set_workspace to switch.",
    annotations: readOnly,
    inputSchema: {},
  },
  async () => text(renderWorkspaces(await listWorkspaces(client), cfg.teamId))
);

server.registerTool(
  "set_workspace",
  {
    title: "Switch the active ClickUp workspace",
    description:
      "Point every other tool at a different workspace for the rest of this session. Accepts an " +
      "id or a workspace name. Nothing in ClickUp changes — this only redirects subsequent calls.",
    // Changes in-process state only; never mutates ClickUp.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      workspace: z.string().describe("Workspace id, or its name (matched loosely)."),
    },
  },
  async ({ workspace }) => {
    const all = await listWorkspaces(client);
    const q = workspace.trim().toLowerCase();
    const hit =
      all.find((w) => String(w.id) === workspace.trim()) ??
      all.find((w) => (w.name ?? "").toLowerCase() === q) ??
      all.find((w) => (w.name ?? "").toLowerCase().includes(q));
    if (!hit?.id) {
      return text(
        `No workspace matched "${workspace}". Visible workspaces:\n` +
          all.map((w) => `- ${w.name} — \`${w.id}\``).join("\n")
      );
    }
    // The client reads teamId off this same config object on every call.
    cfg.teamId = String(hit.id);
    return text(`Active workspace is now "${hit.name}" (${hit.id}).`);
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

  // Checklists carry the ids manage_checklist needs; without them, ticking an
  // item off would cost a second round trip to find the id.
  const checklists = (task.checklists ?? []) as Checklist[];
  if (checklists.length) parts.push("\n## Checklists\n" + renderChecklists(checklists));

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

// CLICKUP_TEAM_ID is optional. Resolve it from the token's own workspaces so a
// single-workspace user never has to dig the number out of a URL. stderr, not
// stdout — stdout is the MCP protocol channel.
if (!cfg.teamId) {
  const workspaces = await listWorkspaces(client).catch((e: Error) => {
    throw new Error(
      `CLICKUP_TEAM_ID is unset and the workspace lookup failed (${e.message}). ` +
        `Set CLICKUP_TEAM_ID to the number in your ClickUp URL: app.clickup.com/{TEAM_ID}/...`
    );
  });
  if (!workspaces.length) throw new Error("This token can't see any ClickUp workspace.");
  cfg.teamId = String(workspaces[0].id);
  if (workspaces.length > 1) {
    console.error(
      `[clickup-context] CLICKUP_TEAM_ID unset — using "${workspaces[0].name}" (${cfg.teamId}). ` +
        `${workspaces.length} workspaces visible; set CLICKUP_TEAM_ID or call set_workspace.`
    );
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
