# clickup-context-mcp

**See your whole ClickUp task in Claude — description, comments, and screenshots — from one prompt.**

The official ClickUp integration can't show an AI the screenshots attached to a task: the ClickUp API returns image *URLs*, never image *bytes*, and the official MCP server passes those URLs straight through. So when you say "look at this task," your assistant sees text and a link it can't open — not the screenshot you actually care about.

This MCP server fixes that. Give it any task reference and it returns everything about the task in a single call, with screenshots downloaded and handed to Claude as real, viewable images.

It also covers what paid ClickUp MCP wrappers charge for — Chat, Docs, time tracking, task CRUD, schedule/Gantt, and workspace administration — on a free personal API token.

### Why not the official MCP server?

ClickUp's own MCP server (`mcp.clickup.com`) is free on every plan, but it's rate-limited to **50 calls per 24 hours** on Free and **300** on Unlimited and above. That's the ceiling paid wrappers exist to sell around. A personal API token against the public REST API gets **100 requests per minute** on Free Forever — roughly 2,880× the daily headroom, for nothing. This server uses the token.

The tradeoff: a personal token carries *your* permissions and doesn't expire on its own, where the official server's OAuth is per-user and revocable. For a single-user setup that's the right trade; for a shared team deployment, it isn't.

## What it does

32 tools — 15 reads and 17 that write to ClickUp. Every write can be switched off with `CLICKUP_MODE=read`.

### Task context, with real screenshots

- **`get_task_context`** — resolve a task, then return its description, comments, and screenshots as images.
- **`resolve_task`** — turn a reference into a task id (or candidates) without fetching everything.
- **`set_current_task`** / **`get_current_task`** — remember "the task I'm on" so you stop re-pasting links.

### Task CRUD

- **`create_task`** — name, description, status, priority, dates, estimate, tags, assignees, or a `parent` to make it a subtask.
- **`update_task`** — the same fields on an existing task, plus `archived`. Only the fields you pass are touched.
- **`delete_task`** — permanent. Requires `confirm: true`, and refuses to run through `ref: "current"`.
- **`set_status`** — move a task to another status.
- **`add_comment`** — post a comment.
- **`bulk_update_tasks`** — the same change across every task matching a filter. **Dry run by default**: without `confirm` it returns the exact list it would touch and changes nothing.
- **`task_templates`** — list templates, or apply one to create a task with its subtasks and checklists intact.

Human-shaped arguments, because the API's are not: dates take ISO (`2026-03-01`) or unix ms, estimates take `2h30m` / `90m` / `1.5h`, and priority takes `urgent|high|normal|low` rather than ClickUp's inverted 1–4. Assignees are the one thing that stays raw — numeric user ids, from `list_members`.

Status names are exact API keys that often carry stray spaces and periods (`moved to prod qa .`), so anything taking a status matches what you type against the list's real ones: `prod qa` finds it. Anything unknown or ambiguous — `qa`, when both a local and a prod QA status exist — changes nothing and prints the valid options.

### Finding tasks (including bugs)

- **`query_tasks`** — filter by list, space, folder, tag, status, assignee, custom field, or date range.

ClickUp has no "bug" type, so this server doesn't invent one. Bugs are whatever *your* workspace calls them, and you pass that convention in:

| Your convention | Call it with |
|---|---|
| A `bug` tag | `tags: ["bug"]` |
| A dedicated Bugs list | `list_ids: ["901234"]` |
| A `Type = Bug` custom field | `custom_fields: '[{"field_id":"…","operator":"=","value":"Bug"}]'` |

### Task detail

- **`manage_checklist`** — checklists and items, including ticking them off. `get_task_context` prints the ids.
- **`manage_custom_fields`** — list a List's fields with their types and options, then set or clear one.
- **`upload_attachment`** — attach a file from a local path, a URL, or base64.

Custom field values are typed, and the types are unforgiving: a `drop_down` wants the option's uuid, not its label; `labels` wants an array of option ids; `users` wants `{add, rem}`. `manage_custom_fields` takes the label and resolves it, and **refuses rather than guessing** when it can't — a wrong custom field value is invisible until someone reads the report built on it. The endpoint is also `PUT`, not the `POST` everything else in that shape uses.

Attachments upload as multipart with the field name `attachment`, and deliberately without a `Content-Type` header so fetch can generate the boundary — setting it by hand returns a bare 400.

### Views

- **`get_views`** — list the views on a List/Folder/Space/Workspace, or read the tasks one currently shows.

A View is where a team's real filter lives. Reading one answers "what's on the board" in a way a reconstructed `query_tasks` filter can't.

### Schedule / Gantt

- **`get_schedule`** — the Gantt view as data: dates, estimates, owners, statuses, and dependencies for a scope, plus the **critical path**.

- **`manage_dependencies`** — create or remove the edges that schedule walks, plus plain task links.

Gantt isn't an API concept in ClickUp — it's a rendering of task dates plus dependency edges. This tool fetches both and computes the longest dependency chain by duration, which is what actually sets the end date. Duration prefers `time_estimate`, falling back to the `start_date`→`due_date` span. Circular dependencies are reported rather than hung on.

A dependency reads from whichever end you call it: `depends_on` and `dependency_of` describe the same edge in opposite directions, so `manage_dependencies` names the direction (`waits_for` / `blocks`) instead of exposing ClickUp's pair — swapping them inverts a schedule silently.

### Docs

- **`search_docs`** — find Docs by name, optionally scoped to a Space/Folder/List.
- **`read_doc`** — a Doc's pages as markdown, sub-pages nested. `outline: true` for titles and ids only.
- **`write_doc`** — create a Doc, add a page, or edit one.

ClickUp's Docs endpoint filters by parent and archived state but has **no free-text parameter**, so name matching happens client-side here — the same way task fuzzy search works. Page edits default to `append`: an agent write should not be able to silently erase a page a human wrote, so `replace` has to be asked for.

### Time tracking

- **`get_time_entries`** — what's logged in a range, by task/list/space/folder or assignee, with the total.
- **`track_time`** — log a finished block (`duration: "2h30m"`), or `start`/`stop` a timer.

ClickUp reports a **running** timer as a *negative* duration, so summing durations naively subtracts the in-flight entry. Running timers are flagged and excluded from the total instead.

### Workspace administration

- **`manage_hierarchy`** — list, create, rename, or delete Spaces, Folders, and Lists. This is where the `list_id`s for everything else come from: start at `kind: "space"`, `action: "list"`.
- **`list_members`** — everyone in the workspace with their numeric user id and role. Those ids are what `assignees` expects everywhere.
- **`manage_goal`** — workspace Goals (OKRs) with progress and owners.
- **`manage_webhook`** — webhooks with their delivery health.
- **`list_workspaces`** / **`set_workspace`** — a personal token spans every workspace you belong to, so `CLICKUP_TEAM_ID` is optional: leave it unset and the server resolves it at startup, then switch at any time.

Every `delete` here requires `confirm: true`, because deleting a Space, Folder, or List deletes its contents too.

### Chat

- **`list_chat_channels`** — channels visible to your token, with ids.
- **`read_chat`** — messages in a channel, oldest first, optionally expanding threaded replies.
- **`send_chat_message`** — post to a channel, or reply in a thread.

> ClickUp documents the Chat API as **experimental and subject to change at any time**. It's isolated in `src/chat.ts` with defensive response unwrapping, so an upstream change breaks chat alone and leaves everything else working.

### Read-only mode

`CLICKUP_MODE=read` never registers the 17 tools that mutate ClickUp. The model can't call what it can't see, which is a stronger guarantee than refusing at call time. `set_current_task` and `set_workspace` survive — they change local session state, not ClickUp.

### Verify against your own workspace

Endpoint shapes for Chat and Docs (both v3) and for task dependencies aren't fully specified in ClickUp's docs. Check what your token actually reaches:

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
git clone https://github.com/Tsahi-Elkayam/clickup-context-mcp
cd clickup-context-mcp
npm install && npm run build
```

Add the plugin directory to Claude Code, then set two env vars:

- `CLICKUP_API_TOKEN` — a personal token from **ClickUp → Settings → Apps**.
- `CLICKUP_TEAM_ID` — optional. Your workspace id, the number in `app.clickup.com/{TEAM_ID}/...`; unset, the server resolves it from the token and `set_workspace` switches.

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
| `CLICKUP_TEAM_ID` | auto | Workspace id. Unset resolves from the token's own workspaces |
| `CLICKUP_MODE` | `write` | `read` hides every tool that mutates ClickUp |
| `CLICKUP_MAX_IMAGES` | `8` | Max screenshots returned per task |
| `CLICKUP_MAX_RESPONSE_MB` | `4` | Total response size ceiling |
| `CLICKUP_SEARCH_PAGE_LIMIT` | `5` | Pages of team tasks scanned for fuzzy search |
| `CLICKUP_MAX_SCHEDULE_TASKS` | `100` | Tasks hydrated with dependencies per `get_schedule` call |

## How screenshots work

Image attachments and inline image links are downloaded from ClickUp's CDN, their real type is detected from magic bytes (PNG/JPEG/GIF/WebP), and they're base64-encoded into MCP `image` content blocks. A size + count budget keeps a screenshot-heavy task from blowing up the response; anything skipped is listed in a footer with the reason (over budget, private-attachment-link auth, or download failure).

> Whether the image reaches the model also depends on your MCP client honoring `image` content blocks. Claude Code and Claude Desktop do; some clients drop them.

## Limitations

- **Bulk edits are capped** at 100 tasks per call (25 by default) and report what they left out rather than implying full coverage.
- **Docs search is name-only.** ClickUp has no full-text Docs endpoint, so a Doc whose title doesn't contain your words won't be found however well its body matches.
- **Tags are creation-only**, which is ClickUp's own limit — `PUT /task` ignores them, so `update_task` doesn't pretend to accept them.
- **No comment editing, reactions, or deletes**; `add_comment` appends and that's all.
- **Custom field *definitions* can't be created** — only their values set. That endpoint doesn't exist on the public API.
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
npm run handshake  # boot over stdio and assert the tool surface (no network)
npm run probe      # hit your real workspace and print response shapes
```

CI runs typecheck, tests, and the handshake on Node 18/20/22.

> **Verify before you trust the writes.** Most tools here were built to ClickUp's
> API reference rather than to observed responses. `npm run probe` checks the
> shapes the thinner corners depend on — Docs v3, time entries, custom field
> options, views — against your own workspace.

## Credits

Image-passthrough approach inspired by [hauptsacheNet/clickup-mcp](https://github.com/hauptsacheNet/clickup-mcp) (MIT), which first demonstrated returning ClickUp images as MCP image content.

## License

MIT — see [LICENSE](./LICENSE).
