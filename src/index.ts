#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { ClickUpClient, type Attachment, type Comment, type Task } from "./clickup.js";
import { resolveRef } from "./resolver.js";
import { downloadImages, inlineImageUrls } from "./images.js";
import { setCurrentTask, getCurrentTask } from "./state.js";

const cfg = loadConfig();
const client = new ClickUpClient(cfg);

const server = new McpServer({ name: "clickup-context", version: "0.1.0" });

server.registerTool(
  "get_task_context",
  {
    title: "Get ClickUp task context",
    description:
      "Resolve a ClickUp task from a URL, custom id (ABC-123), native id, fuzzy name, " +
      "or 'current', then return its description, comments, and screenshots as viewable images " +
      "— everything about the task in one call.",
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

    const text = renderTask(task, comments);
    const attachments = collectImageSources(task, comments);
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
  "resolve_task",
  {
    title: "Resolve a ClickUp task reference",
    description:
      "Turn a URL/custom id/native id/fuzzy name into a concrete task id, or a list of " +
      "candidates for disambiguation. Does not fetch full context.",
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
      parts.push(`**${who}:** ${txt || "_(no text — may be an attachment)_"}`);
    }
  } else {
    parts.push("\n## Comments\n_(none)_");
  }
  return parts.join("\n");
}

// Combine real attachments with inline image URLs found in text, de-duped by url.
function collectImageSources(task: Task, comments: Comment[]): Attachment[] {
  const byUrl = new Map<string, Attachment>();
  for (const a of task.attachments ?? []) byUrl.set(a.url, a);

  const texts = [task.description, task.text_content, ...comments.map((c) => c.comment_text)];
  for (const t of texts) {
    for (const url of inlineImageUrls(t)) {
      if (byUrl.has(url)) continue;
      const ext = url.split(".").pop()?.toLowerCase() ?? "";
      byUrl.set(url, { id: url, title: url.split("/").pop() ?? "inline", extension: ext, url });
    }
  }
  return [...byUrl.values()];
}

const transport = new StdioServerTransport();
await server.connect(transport);
