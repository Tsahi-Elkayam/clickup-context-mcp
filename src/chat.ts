import type { ClickUpClient, QueryParams } from "./clickup.js";

/**
 * ClickUp Chat lives on the v3 API and ClickUp documents it as "experimental and
 * subject to change at any time". It is deliberately isolated in this module and
 * response shapes are unwrapped defensively, so an upstream change degrades chat
 * alone instead of taking task and schedule reads down with it.
 */

export interface ChatChannel {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  visibility?: string;
  parent?: { id?: string; type?: number };
}

export interface ChatMessage {
  id: string;
  type?: string;
  /** ClickUp has shipped this as both `content` and `text` across revisions. */
  content?: string;
  text?: string;
  date?: string | number;
  user?: { id?: number; username?: string; email?: string };
  user_id?: number;
  replies_count?: number;
  resolved?: boolean;
}

/** v3 list responses wrap in `{data: [...]}`; older shapes returned bare arrays. */
function unwrap<T>(res: unknown): { items: T[]; cursor?: string } {
  if (Array.isArray(res)) return { items: res as T[] };
  const o = (res ?? {}) as Record<string, unknown>;
  const items = (o.data ?? o.channels ?? o.messages ?? o.replies ?? []) as T[];
  const cursor = (o.next_cursor ?? o.cursor) as string | undefined;
  return { items: Array.isArray(items) ? items : [], cursor };
}

function base(client: ClickUpClient): string {
  return `/workspaces/${client.teamId}/chat`;
}

export async function listChannels(
  client: ClickUpClient,
  limit = 50
): Promise<ChatChannel[]> {
  const res = await client.get<unknown>(
    `${base(client)}/channels`,
    { limit: String(limit) },
    "v3"
  );
  return unwrap<ChatChannel>(res).items;
}

export async function readChannel(
  client: ClickUpClient,
  channelId: string,
  limit = 50,
  cursor?: string
): Promise<{ messages: ChatMessage[]; cursor?: string }> {
  const params: QueryParams = {
    limit: String(Math.min(Math.max(limit, 1), 100)), // API rejects outside 1..100
    content_format: "text/md",
    cursor,
  };
  const res = await client.get<unknown>(
    `${base(client)}/channels/${encodeURIComponent(channelId)}/messages`,
    params,
    "v3"
  );
  const { items, cursor: next } = unwrap<ChatMessage>(res);
  return { messages: items, cursor: next };
}

export async function readReplies(
  client: ClickUpClient,
  messageId: string,
  limit = 50
): Promise<ChatMessage[]> {
  const res = await client.get<unknown>(
    `${base(client)}/messages/${encodeURIComponent(messageId)}/replies`,
    { limit: String(Math.min(Math.max(limit, 1), 100)), content_format: "text/md" },
    "v3"
  );
  return unwrap<ChatMessage>(res).items;
}

/**
 * Post to a channel. `type: "message"` is required by the API — omitting it is
 * a 400, and "post" is the other (titled, announcement-style) kind.
 */
export async function sendMessage(
  client: ClickUpClient,
  channelId: string,
  content: string
): Promise<ChatMessage> {
  const res = await client.request<unknown>(
    "POST",
    `${base(client)}/channels/${encodeURIComponent(channelId)}/messages`,
    {},
    { type: "message", content, content_format: "text/md" },
    "v3"
  );
  return ((res as { data?: ChatMessage })?.data ?? res) as ChatMessage;
}

export async function replyToMessage(
  client: ClickUpClient,
  messageId: string,
  content: string
): Promise<ChatMessage> {
  const res = await client.request<unknown>(
    "POST",
    `${base(client)}/messages/${encodeURIComponent(messageId)}/replies`,
    {},
    { type: "message", content, content_format: "text/md" },
    "v3"
  );
  return ((res as { data?: ChatMessage })?.data ?? res) as ChatMessage;
}

function who(m: ChatMessage): string {
  return m.user?.username || m.user?.email || (m.user_id ? `user ${m.user_id}` : "unknown");
}

function when(m: ChatMessage): string {
  const n = typeof m.date === "string" ? Number(m.date) : m.date;
  if (!n || !Number.isFinite(n)) return "";
  return new Date(n).toISOString().replace("T", " ").slice(0, 16);
}

function body(m: ChatMessage): string {
  return (m.content ?? m.text ?? "").trim() || "_(no text)_";
}

export function renderChannels(channels: ChatChannel[]): string {
  if (!channels.length) return "No chat channels visible to this token.";
  const lines = channels.map((c) => {
    const meta = [c.type, c.visibility].filter(Boolean).join("/");
    return `- **${c.name ?? "(unnamed)"}** — id \`${c.id}\`${meta ? ` (${meta})` : ""}${
      c.description ? `\n    ${c.description.trim().slice(0, 200)}` : ""
    }`;
  });
  return `# Chat channels (${channels.length})\n${lines.join("\n")}`;
}

export function renderMessages(
  messages: ChatMessage[],
  opts: { channel?: string; cursor?: string; replies?: Map<string, ChatMessage[]> } = {}
): string {
  if (!messages.length) return "No messages in that channel.";
  const out: string[] = [`# ${opts.channel ?? "Channel"} — ${messages.length} message(s)`, ""];
  // ClickUp returns newest-first; read oldest-first so the thread makes sense.
  for (const m of [...messages].reverse()) {
    const ts = when(m);
    out.push(`**${who(m)}**${ts ? ` · ${ts}` : ""}: ${body(m)}`);
    const total = m.replies_count ?? 0;
    const rs = opts.replies?.get(m.id);
    if (rs) {
      for (const r of rs) out.push(`  ↳ **${who(r)}**: ${body(r)}`);
      // The replies endpoint caps a page at 100; never render a truncated
      // thread as if it were complete.
      if (total > rs.length) {
        out.push(`  ↳ _+${total - rs.length} more repl${total - rs.length === 1 ? "y" : "ies"} not fetched — message id \`${m.id}\`_`);
      }
    } else if (total) {
      out.push(`  ↳ _${total} repl${total === 1 ? "y" : "ies"} — message id \`${m.id}\`_`);
    }
  }
  if (opts.cursor) out.push("", `---`, `More history available — pass cursor \`${opts.cursor}\`.`);
  return out.join("\n");
}
