---
name: clickup-context
description: Use whenever the user references a ClickUp task — by URL, custom id (e.g. ABC-123), native id, a fuzzy name/description, or "the task I'm on". Pulls the task's description, comments, and screenshots so you can actually see and reason about it. Also use when the user says "look at this ClickUp task", "what's on this task", or pastes a clickup.com/t/ link.
---

# ClickUp task context

The `clickup-context` MCP server makes a ClickUp task fully visible to you in one call — including **screenshots**, which the official ClickUp integration cannot show you (it returns URLs, not images).

## When the user points at a task

Call **`get_task_context`** with whatever they gave you as `ref`:

- A URL → paste it verbatim (`https://app.clickup.com/t/abc123`)
- A custom id → `ABC-123`
- A native id → `abc123`
- A description → `the login bug task` (the server searches and ranks; if ambiguous it returns candidates — show them and ask which)
- Nothing explicit but they mean the active one → `current`

The result contains the description, every comment, and each screenshot rendered as an image you can see. Read the images — don't just acknowledge them.

## Staying on one task

When the user is working a task across several messages, call **`set_current_task`** once with its ref. After that, `get_task_context` with `ref: "current"` (or just re-reading context) works without re-pasting the link. `get_current_task` reports what's remembered.

## Disambiguation

If `get_task_context` or `resolve_task` returns multiple candidates, present them as a short list (name, status, list) and ask the user to pick. Then call again with the chosen id — do not guess.

## Notes

- "Comments" here means the conversation **on the task**. ClickUp Chat channels (separate messaging) are not covered yet.
- If a screenshot is missing from the output, the footer explains why (size budget, private-attachment-link auth, or download failure) — relay that instead of pretending you saw it.
