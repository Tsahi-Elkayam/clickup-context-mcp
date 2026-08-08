# clickup-context-mcp

**See your whole ClickUp task in Claude — description, comments, and screenshots — from one prompt.**

The official ClickUp integration can't show an AI the screenshots attached to a task: the ClickUp API returns image *URLs*, never image *bytes*, and the official MCP server passes those URLs straight through. So when you say "look at this task," your assistant sees text and a link it can't open — not the screenshot you actually care about.

This MCP server fixes that. Give it any task reference and it returns everything about the task in a single call, with screenshots downloaded and handed to Claude as real, viewable images.

It also covers the reads that paid ClickUp MCP wrappers charge for — Chat, schedule/Gantt, and filtered task queries — on a free personal API token.

### Why not the official MCP server?

ClickUp's own MCP server (`mcp.clickup.com`) is free on every plan, but it's rate-limited to **50 calls per 24 hours** on Free and **300** on Unlimited and above. That's the ceiling paid wrappers exist to sell around. A personal API token against the public REST API gets **100 requests per minute** on Free Forever — roughly 2,880× the daily headroom, for nothing. This server uses the token.

The tradeoff: a personal token carries *your* permissions and doesn't expire on its own, where the official server's OAuth is per-user and revocable. For a single-user setup that's the right trade; for a shared team deployment, it isn't.

## What it does

### Task context, with real screenshots

- **`get_task_context`** — resolve a task, then return its description, comments, and screenshots as images.
- **`resolve_task`** — turn a reference into a task id (or candidates) without fetching everything.
- **`set_current_task`** / **`get_current_task`** — remember "the task I'm on" so you stop re-pasting links.
- **`set_status`** — move a task to another status.
- **`add_comment`** — post a comment, to record what was done or ask the reporter a question.

Those two are the only tools that write to ClickUp; everything else is a read.

Status names are exact API keys that often carry stray spaces and periods (`moved to prod qa .`), so `set_status` matches what you type against the list's real statuses: `prod qa` finds it. Anything unknown or ambiguous — `qa`, when both a local and a prod QA status exist — changes nothing and prints the valid options.

### Finding tasks (including bugs)

- **`query_tasks`** — filter by list, space, folder, tag, status, assignee, custom field, or date range.

ClickUp has no "bug" type, so this server doesn't invent one. Bugs are whatever *your* workspace calls them, and you pass that convention in:

| Your convention | Call it with |
|---|---|
| A `bug` tag | `tags: ["bug"]` |
| A dedicated Bugs list | `list_ids: ["901234"]` |
| A `Type = Bug` custom field | `custom_fields: '[{"field_id":"…","operator":"=","value":"Bug"}]'` |

### Schedule / Gantt

- **`get_schedule`** — the Gantt view as data: dates, estimates, owners, statuses, and dependencies for a scope, plus the **critical path**.

Gantt isn't an API concept in ClickUp — it's a rendering of task dates plus dependency edges. This tool fetches both and computes the longest dependency chain by duration, which is what actually sets the end date. Duration prefers `time_estimate`, falling back to the `start_date`→`due_date` span. Circular dependencies are reported rather than hung on.

### Chat

- **`list_chat_channels`** — channels visible to your token, with ids.
- **`read_chat`** — messages in a channel, oldest first, optionally expanding threaded replies.

> ClickUp documents the Chat API as **experimental and subject to change at any time**. It's isolated in `src/chat.ts` with defensive response unwrapping, so an upstream change breaks chat alone and leaves task and schedule reads working.

### Verify against your own workspace

Endpoint shapes for Chat (v3) and task dependencies aren't fully specified in ClickUp's docs. Check what your token actually reaches:

```bash
CLICKUP_API_TOKEN=pk_... CLICKUP_TEAM_ID=9000000 npm run probe
```

It prints response shapes, field names, and your rate-limit headroom — never task contents, never the token.

### Reference any way you think about it

| You give it | Example |
|---|---|
| Task URL | `https://app.clickup.com/t/abc123` |
| Custom id | `ABC-123` |
| Native id | `abc123` |
| Fuzzy name | `the login bug task` (searches + ranks; asks if ambiguous) |
| Current task | `current` |

## Install (Claude Code plugin)

```bash
git clone https://github.com/<you>/clickup-context-mcp
cd clickup-context-mcp
npm install && npm run build
```

Add the plugin directory to Claude Code, then set two env vars:

- `CLICKUP_API_TOKEN` — a personal token from **ClickUp → Settings → Apps**.
- `CLICKUP_TEAM_ID` — your workspace id, the number in `app.clickup.com/{TEAM_ID}/...`.

### Use as a plain MCP server

Any MCP client can run it directly:

```json
{
  "mcpServers": {
    "clickup-context": {
      "command": "node",
      "args": ["/path/to/clickup-context-mcp/dist/index.js"],
      "env": {
        "CLICKUP_API_TOKEN": "pk_...",
        "CLICKUP_TEAM_ID": "9000000"
      }
    }
  }
}
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CLICKUP_API_TOKEN` | — (required) | Personal API token |
| `CLICKUP_TEAM_ID` | — (required) | Workspace id |
| `CLICKUP_MAX_IMAGES` | `8` | Max screenshots returned per task |
| `CLICKUP_MAX_RESPONSE_MB` | `4` | Total response size ceiling |
| `CLICKUP_SEARCH_PAGE_LIMIT` | `5` | Pages of team tasks scanned for fuzzy search |
| `CLICKUP_MAX_SCHEDULE_TASKS` | `100` | Tasks hydrated with dependencies per `get_schedule` call |

## How screenshots work

Image attachments and inline image links are downloaded from ClickUp's CDN, their real type is detected from magic bytes (PNG/JPEG/GIF/WebP), and they're base64-encoded into MCP `image` content blocks. A size + count budget keeps a screenshot-heavy task from blowing up the response; anything skipped is listed in a footer with the reason (over budget, private-attachment-link auth, or download failure).

> Whether the image reaches the model also depends on your MCP client honoring `image` content blocks. Claude Code and Claude Desktop do; some clients drop them.

## Limitations

- **Two writes.** `set_status` and `add_comment` are the only tools that mutate ClickUp; every other tool is a read. Between them they change a status and append a comment — no assignees, no dates, no edits to existing content, no deletes.
- **Chat is experimental upstream.** ClickUp may change or break those endpoints without notice. Run `npm run probe` if chat output looks wrong.
- **Schedule costs one call per task.** The filtered-tasks endpoint omits `dependencies`, so building real edges means fetching each task. Capped at `CLICKUP_MAX_SCHEDULE_TASKS` (default 100, matching the per-minute token limit) — scope `get_schedule` to a list or space rather than a whole workspace.
- **Critical path weighs only what it fetched.** Dependency edges pointing outside the queried scope are ignored, and tasks with neither an estimate nor a date span count as zero-duration.
- Fuzzy search has no native ClickUp endpoint, so it pages through team tasks and ranks client-side; bound by `CLICKUP_SEARCH_PAGE_LIMIT`.
- If a workspace enables **Private Attachment Links**, CDN URLs need auth; the server retries with your token but some setups still block it.

## Development

```bash
npm run build      # compile
npm test           # build + run unit tests
npm run typecheck  # types only
```

## Credits

Image-passthrough approach inspired by [hauptsacheNet/clickup-mcp](https://github.com/hauptsacheNet/clickup-mcp) (MIT), which first demonstrated returning ClickUp images as MCP image content.

## License

MIT — see [LICENSE](./LICENSE).
