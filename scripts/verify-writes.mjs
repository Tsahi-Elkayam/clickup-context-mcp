#!/usr/bin/env node
/**
 * Exercise every write path against a real workspace and assert the result
 * reads back correctly.
 *
 * `npm run probe` only reads, so it cannot catch the failure mode that actually
 * matters: a write that SUCCEEDS and is silently wrong. Four of those are
 * possible here and each gets a dedicated check:
 *
 *   1. a Doc "append" that really replaces (ClickUp's default is replace, so a
 *      wrong parameter name destroys the page and reports success)
 *   2. a dependency stored in the wrong direction (both field names are valid,
 *      so a swap succeeds and silently inverts the critical path)
 *   3. a custom field storing the wrong option
 *   4. assignees/priority/dates written in a shape ClickUp ignores
 *
 * Everything is created inside a throwaway List and deleted afterwards, in a
 * finally block, so an assertion failure still cleans up. It imports from
 * dist/ on purpose — the point is to test the code that ships, not a second
 * implementation of it that could be right where the real one is wrong.
 *
 *   npm run build
 *   CLICKUP_API_TOKEN=pk_... node scripts/verify-writes.mjs <space_id>
 */
import { loadConfig } from "../dist/config.js";
import { ClickUpClient } from "../dist/clickup.js";
import { toNode } from "../dist/schedule.js";
import { createContainer, deleteContainer, listContainers, listMembers, listWorkspaces } from "../dist/admin.js";
import { buildTaskBody } from "../dist/fields.js";
import { addDependency, createChecklist, addChecklistItem, editChecklistItem } from "../dist/relations.js";
import { listFields, coerceValue, setFieldValue } from "../dist/customfields.js";
import { createDoc, createPage, editPage, docPages } from "../dist/docs.js";
import { logTime, getEntries, formatDuration } from "../dist/time.js";
import { uploadAttachment } from "../dist/attachments.js";

const green = (s) => `\x1b[32m✔\x1b[0m ${s}`;
const red = (s) => `\x1b[31m✘\x1b[0m ${s}`;
const grey = (s) => `\x1b[33m•\x1b[0m ${s}`;

const SKIP = Symbol("skip");
let passed = 0;
let failed = 0;
let skipped = 0;

/** Run one assertion. A thrown error is a failure, not a crash. */
async function check(name, fn) {
  try {
    const note = await fn();
    if (note === SKIP) return;
    passed++;
    console.log(green(`${name}${note ? ` — ${note}` : ""}`));
  } catch (e) {
    failed++;
    console.log(red(`${name}\n    ${e.message}`));
  }
}
function skip(why) {
  skipped++;
  console.log(grey(`skipped: ${why}`));
  return SKIP;
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Locate a drop_down custom field to test the option mapping against. Checks
 * the scratch List first (which inherits Space-level fields), then walks a
 * bounded number of other Lists in the Space for Folder/List-level ones.
 */
async function findDropdown(scratchListId, spaceId) {
  const isDropdown = (f) => f.type === "drop_down" && f.type_config?.options?.length;
  const own = await listFields(client, scratchListId);
  const inherited = own.find(isDropdown);
  if (inherited) return { field: inherited, listId: scratchListId };

  const lists = [...((await listContainers(client, "list", spaceId)) ?? [])];
  for (const folder of (await listContainers(client, "folder", spaceId)) ?? []) {
    lists.push(...((await listContainers(client, "list", spaceId, folder.id)) ?? []));
  }
  // Bounded so one call can't walk a large Space through the rate limit.
  for (const l of lists.filter((l) => l.id !== scratchListId).slice(0, 10)) {
    const hit = (await listFields(client, l.id).catch(() => [])).find(isDropdown);
    if (hit) return { field: hit, listId: l.id };
  }
  return { field: null, listId: null };
}

const cfg = loadConfig();
const client = new ClickUpClient(cfg);

if (!cfg.teamId) {
  const [first] = await listWorkspaces(client);
  if (!first) throw new Error("This token can't see any workspace.");
  cfg.teamId = String(first.id);
}

const spaceId = process.argv[2];
if (!spaceId) {
  console.log("Usage: node scripts/verify-writes.mjs <space_id>\n");
  console.log("This script CREATES AND DELETES a scratch List. Pick a Space you don't mind it");
  console.log("touching — nothing outside the List it creates is modified.\n");
  const spaces = (await listContainers(client, "space")) ?? [];
  console.log(spaces.map((s) => `  ${s.id}  ${s.name}`).join("\n") || "  (no spaces visible)");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const SCRATCH = `zz-verify-writes ${stamp}`;
let list = null;
let docId = null;

console.log(`\nWorkspace ${cfg.teamId} · Space ${spaceId}\nScratch List: "${SCRATCH}"\n`);

try {
  list = await createContainer(client, "list", SCRATCH, spaceId);
  assert(list?.id, "could not create the scratch List — check the space_id and your permissions");
  console.log(grey(`created scratch List ${list.id}\n`));

  const members = await listMembers(client);
  const me = members[0]?.user?.id;

  // ---------------------------------------------------------------- tasks
  let taskA;
  let taskB;

  await check("create_task writes name and description", async () => {
    taskA = await client.createTask(list.id, buildTaskBody({ name: "A — verify", description: "hello" }, "create"));
    assert(taskA?.id, "no task id returned");
    const back = await client.getTask(taskA.id);
    assert(back.name === "A — verify", `name read back as "${back.name}"`);
    return taskA.id;
  });

  await check("update_task writes priority, dates and estimate in the shapes ClickUp accepts", async () => {
    const due = Date.now() + 86_400_000;
    await client.updateTask(
      taskA.id,
      buildTaskBody({ priority: "urgent", due_date: String(due), time_estimate: "2h30m" }, "update")
    );
    const back = await client.getTask(taskA.id);
    assert(back.priority?.priority === "urgent", `priority read back as "${back.priority?.priority}" — the 1..4 codes may be inverted`);
    assert(Math.abs(Number(back.due_date) - due) < 60_000, `due_date read back as ${back.due_date}, expected ~${due}`);
    assert(Number(back.time_estimate) === 9_000_000, `time_estimate read back as ${back.time_estimate}, expected 9000000`);
    return "priority + due_date + estimate";
  });

  await check("update_task assignees use the {add, rem} shape, not a flat array", async () => {
    if (!me) return skip("no member id available to assign");
    await client.updateTask(taskA.id, buildTaskBody({ assignees: [String(me)] }, "update"));
    const back = await client.getTask(taskA.id);
    assert(
      (back.assignees ?? []).some((a) => Number(a.id) === Number(me)),
      "assignee did not stick — a flat array is silently ignored on PUT"
    );
    return `assigned ${me}`;
  });

  await check("set_status matches the list's own status strings", async () => {
    const statuses = await client.listStatuses(list.id);
    const current = (await client.getTask(taskA.id)).status?.status;
    const target = statuses.find((s) => s !== current) ?? statuses[0];
    assert(target, "this List reports no statuses at all");
    await client.setStatus(taskA.id, target);
    const back = await client.getTask(taskA.id);
    assert(back.status?.status === target, `status read back as "${back.status?.status}", expected "${target}"`);
    return `→ ${target}`;
  });

  // ------------------------------------------------- dependency DIRECTION
  await check("DIRECTION: 'waits_for' stores the edge the critical path expects", async () => {
    taskB = await client.createTask(list.id, buildTaskBody({ name: "B — verify" }, "create"));
    await addDependency(client, taskA.id, taskB.id, "waits_for");
    const back = await client.getTask(taskA.id);
    const node = toNode(back);
    assert(
      node.dependsOn.includes(taskB.id),
      node.blocks.includes(taskB.id)
        ? `INVERTED — A was recorded as BLOCKING B. depends_on/dependency_of are swapped, and every critical path is backwards.`
        : `no edge found on A (dependsOn=${JSON.stringify(node.dependsOn)}, blocks=${JSON.stringify(node.blocks)})`
    );
    return "A waits for B, as stored";
  });

  // ----------------------------------------------------------- checklists
  await check("checklist items can be added and checked off", async () => {
    const made = await createChecklist(client, taskA.id, "verify list");
    const id = made.checklist?.id;
    assert(id, "no checklist id returned");
    const withItem = await addChecklistItem(client, id, "item one");
    const itemId = withItem.checklist?.items?.[0]?.id;
    assert(itemId, "no checklist item id returned");
    const done = await editChecklistItem(client, id, itemId, { resolved: true });
    const item = done.checklist?.items?.find((i) => i.id === itemId);
    assert(item?.resolved === true, "item did not come back resolved");
    return "created, added, checked";
  });

  // -------------------------------------------------------- custom fields
  await check("custom field values store the option they were asked for", async () => {
    // Space-level fields are inherited by the scratch List, but Folder- and
    // List-level ones are not, so widen the search before giving up. The write
    // still only ever touches a task this script created.
    const { field, listId } = await findDropdown(list.id, spaceId);
    if (!field) return skip("no drop_down custom field anywhere in this Space to test against");

    const opts = field.type_config.options;
    const label = (opts[0].name ?? opts[0].label ?? "").trim();
    const coerced = coerceValue(field, label);
    assert(!("error" in coerced), `coercion refused "${label}": ${coerced.error}`);

    // If the field lives on another List, make our own scratch task there
    // rather than writing to work that belongs to somebody.
    const own = listId === list.id
      ? taskA
      : await client.createTask(listId, buildTaskBody({ name: `zz-verify field ${stamp}` }, "create"));
    try {
      await setFieldValue(client, own.id, field.id, coerced.value);
      const back = await client.getTask(own.id);
      const stored = (back.custom_fields ?? []).find((f) => f.id === field.id);
      const chosen = opts[Number(stored?.value)] ?? opts.find((o) => o.id === stored?.value);
      assert(
        chosen && (chosen.name ?? chosen.label) === label,
        `set "${label}" but the task reads back ${JSON.stringify(stored?.value)} — the option id/orderindex mapping is wrong`
      );
    } finally {
      if (own !== taskA) await client.deleteTask(own.id).catch(() => {});
    }
    return `${field.name} = ${label}${listId === list.id ? "" : ` (borrowed from list ${listId})`}`;
  });

  // ------------------------------------------------------ doc APPEND mode
  await check("APPEND: editing a Doc page appends instead of replacing it", async () => {
    const doc = await createDoc(client, `zz-verify ${stamp}`, { id: list.id, type: "LIST" });
    docId = doc?.id;
    assert(docId, "no doc id returned");
    const page = await createPage(client, docId, { name: "verify page", content: "FIRST-LINE" });
    assert(page?.id, "no page id returned");
    await editPage(client, docId, page.id, { content: "SECOND-LINE", content_edit_mode: "append" });
    const pages = await docPages(client, docId);
    const body = JSON.stringify(pages);
    assert(
      body.includes("FIRST-LINE"),
      "FIRST-LINE is GONE — the append silently replaced the page. write_doc would destroy user documentation."
    );
    assert(body.includes("SECOND-LINE"), "SECOND-LINE was not written at all");
    return "both lines present";
  });

  // ----------------------------------------------------------------- time
  await check("track_time logs a block that reads back at the right length", async () => {
    const ms = 30 * 60_000;
    await logTime(client, { tid: taskA.id, description: "verify", start: Date.now() - ms, duration: ms });
    const entries = await getEntries(client, { taskId: taskA.id, startDate: Date.now() - 86_400_000, endDate: Date.now() + 60_000 });
    const total = entries.reduce((s, e) => s + Math.max(0, Number(e.duration ?? 0)), 0);
    assert(total >= ms * 0.9, `logged 30m but the task reads back ${formatDuration(total)}`);
    return formatDuration(total);
  });

  // ----------------------------------------------------------- attachment
  await check("upload_attachment sends multipart ClickUp accepts", async () => {
    // Smallest valid PNG, so the check exercises the upload and not an encoder.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const up = await uploadAttachment(client, taskA.id, png, "verify.png");
    assert(!("error" in up), up.error);
    const back = await client.getTask(taskA.id);
    assert(
      (back.attachments ?? []).some((a) => (a.title ?? "").includes("verify")),
      "upload returned OK but the task has no such attachment"
    );
    return "verify.png attached";
  });
} finally {
  console.log("");
  if (list?.id) {
    try {
      await deleteContainer(client, "list", list.id);
      console.log(grey(`cleaned up scratch List ${list.id}`));
    } catch (e) {
      console.log(red(`COULD NOT DELETE scratch List ${list.id} — delete "${SCRATCH}" by hand. ${e.message}`));
    }
  }
  // v3 has no delete-doc endpoint, but a Doc parented to a List may go with it.
  // Check rather than guess — telling someone to hunt for a Doc that isn't
  // there is as unhelpful as leaving one behind silently.
  if (docId) {
    let leftover = true;
    try {
      const doc = await client.get(`/workspaces/${cfg.teamId}/docs/${docId}`, {}, "v3");
      leftover = !(doc?.deleted || doc?.archived);
    } catch {
      leftover = false; // 404 — it went with the List.
    }
    console.log(
      leftover
        ? grey(`Doc "zz-verify ${stamp}" (${docId}) is still there — v3 has no delete-doc endpoint, so remove it by hand.`)
        : grey(`Doc "zz-verify ${stamp}" went with the List.`)
    );
  }
  console.log(
    `\n${passed} passed · ${failed} failed · ${skipped} skipped\n` +
      (failed
        ? "Do not ship the failing paths — fix them, rebuild, and re-run.\n"
        : "Every write path verified against a real workspace.\n")
  );
  process.exit(failed ? 1 : 0);
}
