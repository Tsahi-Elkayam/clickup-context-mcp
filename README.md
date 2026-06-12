# clickup-context-mcp

**See your whole ClickUp task in Claude — description, comments, and screenshots — from one prompt.**

The official ClickUp integration can't show an AI the screenshots attached to a task: the ClickUp API returns image *URLs*, never image *bytes*, and the official MCP server passes those URLs straight through. So when you say "look at this task," your assistant sees text and a link it can't open — not the screenshot you actually care about.

This MCP server fixes that. Give it any task reference and it returns everything about the task in a single call, with screenshots downloaded and handed to Claude as real, viewable images.

## What it does

One tool does the work:

- **`get_task_context`** — resolve a task, then return its description, comments, and screenshots as images.

Supporting tools:

- **`resolve_task`** — turn a reference into a task id (or candidates) without fetching everything.
- **`set_current_task`** / **`get_current_task`** — remember "the task I'm on" so you stop re-pasting links.

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

## How screenshots work

Image attachments and inline image links are downloaded from ClickUp's CDN, their real type is detected from magic bytes (PNG/JPEG/GIF/WebP), and they're base64-encoded into MCP `image` content blocks. A size + count budget keeps a screenshot-heavy task from blowing up the response; anything skipped is listed in a footer with the reason (over budget, private-attachment-link auth, or download failure).

> Whether the image reaches the model also depends on your MCP client honoring `image` content blocks. Claude Code and Claude Desktop do; some clients drop them.

## Limitations

- **Task comments only** — the conversation *on* the task. ClickUp Chat channels (separate messaging) aren't covered yet.
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
