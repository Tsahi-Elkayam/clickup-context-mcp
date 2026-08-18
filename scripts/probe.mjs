#!/usr/bin/env node
/**
 * Verify what a personal API token can actually reach in YOUR workspace.
 *
 * ClickUp's docs don't state whether Chat (v3, "experimental") accepts personal
 * tokens, nor whether `dependencies` ships on the task response. This asks.
 *
 *   CLICKUP_API_TOKEN=pk_... CLICKUP_TEAM_ID=9000000 node scripts/probe.mjs
 *
 * Prints shapes and counts only — never task contents, never the token.
 */
const token = process.env.CLICKUP_API_TOKEN;
const team = process.env.CLICKUP_TEAM_ID;
if (!token || !team) {
  console.error("Set CLICKUP_API_TOKEN and CLICKUP_TEAM_ID first.");
  process.exit(1);
}

const ok = (s) => `\x1b[32m✔\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✘\x1b[0m ${s}`;
const meh = (s) => `\x1b[33m•\x1b[0m ${s}`;

async function call(label, url) {
  try {
    const res = await fetch(url, { headers: { Authorization: token } });
    const body = await res.text();
    if (!res.ok) {
      console.log(bad(`${label} — HTTP ${res.status}: ${body.slice(0, 160)}`));
      return null;
    }
    console.log(ok(`${label} — HTTP 200`));
    try {
      return JSON.parse(body);
    } catch {
      console.log(meh(`  (response was not JSON)`));
      return null;
    }
  } catch (e) {
    console.log(bad(`${label} — ${e.message}`));
    return null;
  }
}

const V2 = "https://api.clickup.com/api/v2";
const V3 = "https://api.clickup.com/api/v3";

console.log("\n── Rate limit headroom ──");
const probe = await fetch(`${V2}/team`, { headers: { Authorization: token } });
console.log(
  `  limit=${probe.headers.get("x-ratelimit-limit") ?? "?"}/min  ` +
    `remaining=${probe.headers.get("x-ratelimit-remaining") ?? "?"}`
);

console.log("\n── Tasks (v2, stable) ──");
const filtered = await call(
  "filtered team tasks",
  `${V2}/team/${team}/task?page=0&subtasks=true&include_closed=true`
);
const sample = filtered?.tasks?.[0];
if (sample) {
  console.log(meh(`  ${filtered.tasks.length} task(s) on page 0; sampling task ${sample.id}`));
  console.log(
    meh(
      `  list response has dependencies? ${
        sample.dependencies === undefined ? "NO — per-task fetch needed (expected)" : "yes"
      }`
    )
  );

  const full = await call("single task", `${V2}/task/${sample.id}`);
  if (full) {
    const deps = full.dependencies;
    console.log(
      deps === undefined
        ? bad("  no `dependencies` field on the task response — critical path can't build edges")
        : ok(`  \`dependencies\`: ${deps.length} row(s)` +
            (deps[0] ? ` e.g. ${JSON.stringify(deps[0])}` : " (none on this task)"))
    );
    for (const f of ["start_date", "due_date", "time_estimate", "assignees", "linked_tasks"]) {
      console.log(
        full[f] === undefined ? meh(`  ${f}: absent`) : ok(`  ${f}: present`)
      );
    }
  }
} else {
  console.log(meh("  no tasks returned — check CLICKUP_TEAM_ID"));
}

console.log("\n── Chat (v3, experimental) ──");
const chan = await call("chat channels", `${V3}/workspaces/${team}/chat/channels?limit=5`);
if (chan) {
  const items = Array.isArray(chan) ? chan : (chan.data ?? chan.channels ?? []);
  console.log(meh(`  wrapper keys: ${Array.isArray(chan) ? "(bare array)" : Object.keys(chan).join(", ")}`));
  console.log(meh(`  ${items.length} channel(s)`));
  const first = items[0];
  if (first) {
    console.log(meh(`  channel keys: ${Object.keys(first).join(", ")}`));
    const msgs = await call(
      "channel messages",
      `${V3}/workspaces/${team}/chat/channels/${first.id}/messages?limit=5&content_format=text%2Fmd`
    );
    if (msgs) {
      const list = Array.isArray(msgs) ? msgs : (msgs.data ?? msgs.messages ?? []);
      console.log(meh(`  wrapper keys: ${Array.isArray(msgs) ? "(bare array)" : Object.keys(msgs).join(", ")}`));
      console.log(meh(`  ${list.length} message(s)`));
      if (list[0]) {
        console.log(meh(`  message keys: ${Object.keys(list[0]).join(", ")}`));
        const textField = ["content", "text", "comment_text"].find((k) => list[0][k] !== undefined);
        console.log(
          textField
            ? ok(`  message body field is \`${textField}\``)
            : bad("  no recognizable text field — chat.ts body() needs updating")
        );
      }
    }
  }
}

console.log("\n── Docs (v3) ──");
const docs = await call("docs", `${V3}/workspaces/${team}/docs?limit=5`);
if (docs) {
  const items = Array.isArray(docs) ? docs : (docs.docs ?? docs.results ?? []);
  console.log(meh(`  wrapper keys: ${Array.isArray(docs) ? "(bare array)" : Object.keys(docs).join(", ")}`));
  console.log(
    items.length
      ? ok(`  ${items.length} doc(s); doc keys: ${Object.keys(items[0]).join(", ")}`)
      : meh("  no docs returned — this workspace may simply have none")
  );
  if (items[0]) {
    const pages = await call(
      "doc pages",
      `${V3}/workspaces/${team}/docs/${items[0].id}/pages?content_format=text%2Fmd`
    );
    const list = Array.isArray(pages) ? pages : (pages?.pages ?? []);
    if (list?.length) {
      console.log(meh(`  page keys: ${Object.keys(list[0]).join(", ")}`));
      console.log(
        list[0].content !== undefined
          ? ok("  pages carry `content` — read_doc will show bodies")
          : bad("  no `content` field — read_doc will render titles only")
      );
    }
  }
}

console.log("\n── Time tracking (v2) ──");
const entries = await call("time entries", `${V2}/team/${team}/time_entries`);
if (entries) {
  const list = entries.data ?? [];
  console.log(meh(`  ${list.length} entr(ies) in the default 30-day window`));
  if (list[0]) {
    console.log(meh(`  entry keys: ${Object.keys(list[0]).join(", ")}`));
    const running = list.filter((e) => Number(e.duration ?? 0) < 0).length;
    console.log(meh(`  ${running} running timer(s) (negative duration)`));
  }
}

console.log("\n── Custom fields + views (v2) ──");
if (sample?.list?.id) {
  const fields = await call("list custom fields", `${V2}/list/${sample.list.id}/field`);
  const fl = fields?.fields ?? [];
  console.log(meh(`  ${fl.length} field(s) on list ${sample.list.id}`));
  if (fl[0]) {
    console.log(meh(`  field keys: ${Object.keys(fl[0]).join(", ")}`));
    const opts = fl.find((f) => f.type_config?.options?.length);
    console.log(
      opts
        ? ok(`  "${opts.name}" (${opts.type}) has ${opts.type_config.options.length} option(s) — label matching will work`)
        : meh("  no option-bearing field found to check label matching against")
    );
  }
  const views = await call("list views", `${V2}/list/${sample.list.id}/view`);
  if (views) {
    const saved = views.views ?? [];
    const required = Object.values(views.required_views ?? {}).filter((v) => v && v.id);
    console.log(meh(`  ${saved.length} saved + ${required.length} built-in view(s)`));
  }
} else {
  console.log(meh("  no sample task with a list — skipped"));
}

console.log("\nIf Chat returned 401/403, personal tokens are locked out and chat needs OAuth.\n");
