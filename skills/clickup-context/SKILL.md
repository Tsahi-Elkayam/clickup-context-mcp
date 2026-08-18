---
name: clickup-context
description: Use for anything in ClickUp — a task referenced by URL, custom id (ABC-123), native id, fuzzy name, or "the task I'm on"; finding tasks or bugs; what's on someone's plate or on the board; schedules, deadlines, dependencies, what's blocking a release or the critical path; making one task wait on another; reading or posting in Chat; reading or writing Docs; logging or reviewing time; creating, updating, assigning, bulk-editing, or moving tasks; checklists, custom fields, attaching a file or screenshot; Spaces, Folders, Lists, views, templates, members, Goals, webhooks, or switching workspace. Also use when the user pastes a clickup.com link or says "look at this ClickUp task", "move it to prod QA", or "comment on the ticket".
---

# ClickUp

The `clickup-context` MCP server. It reaches ClickUp with a personal API token (100 req/min), so it does not share the official integration's 50-calls-per-day ceiling. The thing the official integration can't do: **screenshots come back as images you can actually see**, not URLs you can't open.

## Reading a task

Call **`get_task_context`** with whatever the user gave you as `ref`:

- A URL → paste it verbatim (`https://app.clickup.com/t/abc123`)
- A custom id → `ABC-123` · a native id → `abc123`
- A description → `the login bug task` (searches and ranks; returns candidates if ambiguous)
- The active one → `current`

You get the description, every comment, and each screenshot as a viewable image. **Read the images — don't just acknowledge them.** If one is missing, the footer says why (size budget, private-attachment auth, download failure); relay that instead of pretending you saw it.

`resolve_task` does the lookup alone when you only need an id.

## Staying on one task

`set_current_task` once, then `ref: "current"` everywhere. `get_current_task` reports what's remembered.

## Finding things

- **`query_tasks`** — filter by list, space, folder, tag, status, assignee, custom field, or date range.
- **`manage_hierarchy`** with `action: "list"` — walk Spaces → Folders → Lists to discover the ids the filters need. Start at `kind: "space"`.
- **`get_views`** — a View is the saved filter a team actually works out of ("My Sprint", "Blocked"). `action: "tasks"` answers "what's on the board" when the filter lives in ClickUp, not in your arguments.
- **`list_members`** — numeric user ids, which is what every `assignees` argument expects. Usernames will not work.
- **`list_workspaces`** / **`set_workspace`** — a personal token spans every workspace the user belongs to. If something isn't found, check you're in the right one.

ClickUp has no bug type. Bugs are whatever this workspace calls them — pass the convention: `tags: ["bug"]`, a Bugs `list_ids`, or a `custom_fields` filter. Ask the user which if you don't know.

## Task detail

- **`manage_checklist`** — checklists and their items; `check`/`uncheck` to tick one off. The ids come from `get_task_context`, which prints them.
- **`manage_custom_fields`** — `action: "list"` first, always: values are typed per field and the listing shows each field's type and dropdown options. Then `set` takes the option's *label* and matches it for you. A value that doesn't resolve changes nothing and tells you the valid ones.
- **`upload_attachment`** — put a file back: a local path, a URL, or base64. This is the return trip for screenshots — e.g. attaching proof of a fix to the bug it closes.
- **`task_templates`** — `apply` creates a task from a template, which brings its subtasks and checklists along. `create_task` can't do that.

## Schedule

**`get_schedule`** returns the Gantt data for a scope plus the computed **critical path** — the longest dependency chain, which is what actually sets the end date. Use it for "what's blocking the release", "are we on track", "what slips if this slips". Scope it to a list or space; a whole workspace is capped and will truncate.

**`manage_dependencies`** creates the edges it walks. `direction: "waits_for"` means this task can't start until the other finishes; `"blocks"` is the reverse — getting it backwards inverts the schedule silently, so state which way round you're setting it. `link`/`unlink` make a plain cross-reference with no scheduling meaning. Adding a dependency changes the critical path; re-run `get_schedule` if dates matter.

## Docs

**`search_docs`** → **`read_doc`**. Docs search is name-based only (ClickUp has no full-text endpoint), so a wrong guess returns nothing rather than something similar — try a shorter name fragment before concluding the Doc doesn't exist. `outline: true` lists page titles and ids without pulling every body.

## Time

**`get_time_entries`** for what's logged (a running timer shows as `running` and is excluded from the total). **`track_time`** to `log` a finished block (`duration: "2h30m"`), or `start`/`stop` a timer.

## Chat

**`list_chat_channels`** → **`read_chat`** → **`send_chat_message`** (pass `reply_to` to answer in a thread). This is ClickUp Chat, the messaging product — the conversation *on a task* comes from `get_task_context` instead. Show the user any message before you post it. ClickUp documents these endpoints as experimental; if the output looks wrong, say so rather than inventing content.

## Writing

These tools change a shared workspace that other people are looking at:

| Tool | Effect |
|---|---|
| `set_status` | moves a task's status |
| `add_comment` | posts a visible comment |
| `create_task` / `update_task` | creates or edits a task |
| `write_doc` | creates a Doc/page, or edits a page |
| `track_time` | logs time or runs a timer |
| `manage_hierarchy` / `manage_goal` / `manage_webhook` | creates, renames, deletes |
| `manage_dependencies` | changes what blocks what |
| `manage_checklist` / `manage_custom_fields` | edits task detail |
| `upload_attachment` | adds a file everyone can see |
| `task_templates` (apply) | creates a task |
| `send_chat_message` | posts to a channel people are reading |
| `bulk_update_tasks` | changes many tasks at once |
| `delete_task` | permanent, no undo |

Rules:

- **Say what you're about to write before you write it**, and don't invent content the user didn't ask for — a comment or status change is visible to their whole team.
- **Deletes need `confirm: true`, and you must ask the user first.** That applies to `delete_task` and to `delete` on `manage_hierarchy`/`manage_goal`/`manage_webhook`. Deleting a Space, Folder, or List takes everything inside it. Prefer `update_task` with `archived: true` when the user means "get it out of the way".
- **`bulk_update_tasks` is a dry run unless you pass `confirm: true`.** Always run it once without confirm, show the user the exact list it would change, and only then confirm. It caps at 25 tasks by default and says so when more match — never report a capped run as if it covered everything.
- `write_doc` edits **append** by default. Only pass `mode: "replace"` when the user explicitly asked to rewrite the page — replace destroys whatever was there.
- Statuses are matched loosely against the list's real strings, so `prod qa` finds `moved to prod qa .`. An unknown or ambiguous status **changes nothing** and lists the valid options — relay those and ask, don't retry with a guess.
- If the write tools aren't in your tool list, the server is running `CLICKUP_MODE=read`. Say that; don't look for a workaround.

## Disambiguation

When a call returns multiple candidates, show them as a short list (name, status, list) and ask which. Then call again with the chosen id — never guess, and never guess on a write.
