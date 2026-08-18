import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskBody, parseDate, parseDuration } from "./fields.js";
import { formatDuration, isRunning, totalMs, type TimeEntry } from "./time.js";
import { rankDocs } from "./docs.js";
import { coerceValue } from "./customfields.js";
import { loadSource } from "./attachments.js";

test("parseDuration reads human estimates as milliseconds", () => {
  assert.equal(parseDuration("2h"), 7_200_000);
  assert.equal(parseDuration("2h30m"), 9_000_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration("90m"), 5_400_000);
  // A bare number is minutes — that is what people mean by "45".
  assert.equal(parseDuration("45"), 2_700_000);
  assert.equal(parseDuration(45), 2_700_000);
  assert.throws(() => parseDuration("soon"), /Not a duration/);
});

test("parseDate keeps unix ms whole instead of reading it as a year", () => {
  assert.equal(parseDate(1772323200000), 1772323200000);
  assert.equal(parseDate("1772323200000"), 1772323200000);
  assert.equal(parseDate("2026-03-01T00:00:00.000Z"), Date.parse("2026-03-01T00:00:00.000Z"));
  assert.throws(() => parseDate("next tuesday"), /Not a date/);
});

test("assignees take the array shape on create and the add/rem shape on update", () => {
  assert.deepEqual(buildTaskBody({ assignees: ["7", "9"] }, "create").assignees, [7, 9]);
  assert.deepEqual(buildTaskBody({ assignees: ["7"], remove_assignees: ["9"] }, "update").assignees, {
    add: [7],
    rem: [9],
  });
});

test("priority maps to ClickUp's inverted codes", () => {
  assert.equal(buildTaskBody({ priority: "urgent" }, "update").priority, 1);
  assert.equal(buildTaskBody({ priority: "low" }, "update").priority, 4);
});

test("an update body carries only the fields that were passed", () => {
  const body = buildTaskBody({ name: "x" }, "update");
  assert.deepEqual(Object.keys(body), ["name"]);
  // Tags are creation-only; silently including them on update would imply a
  // write that ClickUp ignores.
  assert.equal(buildTaskBody({ tags: ["bug"] }, "update").tags, undefined);
  assert.deepEqual(buildTaskBody({ tags: ["bug"] }, "create").tags, ["bug"]);
});

test("a running timer is a flag, not negative time", () => {
  const entries = [
    { id: "1", duration: "3600000" },
    { id: "2", duration: "-120000" },
  ] as TimeEntry[];
  assert.equal(isRunning(entries[1]), true);
  assert.equal(totalMs(entries), 3_600_000);
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(9_000_000), "2h 30m");
  assert.equal(formatDuration(5_000), "<1m");
});

test("doc ranking prefers exact then substring then word hits", () => {
  const docs = [
    { id: "a", name: "Deploy runbook" },
    { id: "b", name: "Runbook" },
    { id: "c", name: "Onboarding" },
  ];
  assert.deepEqual(rankDocs(docs, "runbook").map((d) => d.id), ["b", "a"]);
  // No query means no filtering — the caller asked for a plain listing.
  assert.equal(rankDocs(docs, "").length, 3);
});

test("dropdown values are matched to option ids, not passed through as labels", () => {
  const field = {
    id: "f1",
    name: "Type",
    type: "drop_down",
    type_config: { options: [{ id: "u-1", name: "Bug" }, { id: "u-2", name: "Feature" }] },
  };
  assert.deepEqual(coerceValue(field, "Bug"), { value: "u-1" });
  assert.deepEqual(coerceValue(field, "bug"), { value: "u-1" });
  const bad = coerceValue(field, "Epic");
  assert.ok("error" in bad && /not an option/.test(bad.error), "unknown option must error, not guess");
});

test("typed custom fields coerce, and a bad value refuses instead of writing", () => {
  assert.deepEqual(coerceValue({ id: "n", type: "number" }, "42"), { value: 42 });
  assert.ok("error" in coerceValue({ id: "n", type: "number" }, "lots"));
  assert.deepEqual(coerceValue({ id: "c", type: "checkbox" }, "yes"), { value: true });
  assert.deepEqual(coerceValue({ id: "c", type: "checkbox" }, "no"), { value: false });
  assert.deepEqual(coerceValue({ id: "u", type: "users" }, "7, 9"), { value: { add: [7, 9], rem: [] } });
  // Unknown types pass the string through rather than dropping the write.
  assert.deepEqual(coerceValue({ id: "t", type: "short_text" }, "hi"), { value: "hi" });
});

test("labels need every value to resolve — a partial match writes nothing", () => {
  const field = {
    id: "l",
    type: "labels",
    type_config: { options: [{ id: "a", label: "red" }, { id: "b", label: "blue" }] },
  };
  assert.deepEqual(coerceValue(field, "red,blue"), { value: ["a", "b"] });
  assert.ok("error" in coerceValue(field, "red,green"));
});

test("base64 uploads without a filename are refused, and data: URIs are tolerated", async () => {
  const png = "data:image/png;base64,aGVsbG8=";
  assert.ok("error" in (await loadSource({ base64: png })));
  const ok = await loadSource({ base64: png, filename: "shot.png" });
  assert.ok(!("error" in ok) && Buffer.from(ok.bytes).toString() === "hello");
});
