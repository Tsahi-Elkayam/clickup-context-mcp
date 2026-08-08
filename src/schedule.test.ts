import { test } from "node:test";
import assert from "node:assert/strict";
import { criticalPath, durationMs, toNode, type ScheduleNode } from "./schedule.js";
import type { Task } from "./clickup.js";

const DAY = 86_400_000;

function node(id: string, days: number, dependsOn: string[] = []): ScheduleNode {
  return { id, name: id, assignees: [], dependsOn, blocks: [], estimateMs: days * DAY };
}

test("critical path picks the longest chain, not the longest hop", () => {
  // a(1) -> b(1) -> d(1)  = 3d
  // a(1) -> c(5) -> d(1)  = 7d  <- critical
  const cp = criticalPath([
    node("a", 1),
    node("b", 1, ["a"]),
    node("c", 5, ["a"]),
    node("d", 1, ["b", "c"]),
  ]);
  assert.deepEqual(cp.path, ["a", "c", "d"]);
  assert.equal(cp.totalMs, 7 * DAY);
  assert.deepEqual(cp.cycles, []);
});

test("a blocks-only edge still contributes to the path", () => {
  // b's own hydration failed (no dependsOn), but a knows it blocks b.
  const a = { ...node("a", 5), blocks: ["b"] };
  const cp = criticalPath([a, node("b", 2)]);
  assert.deepEqual(cp.path, ["a", "b"]);
  assert.equal(cp.totalMs, 7 * DAY);
  assert.equal(cp.edges, 1);
});

test("both-sided edges are not double counted", () => {
  const a = { ...node("a", 1), blocks: ["b"] };
  const cp = criticalPath([a, node("b", 1, ["a"])]);
  assert.equal(cp.edges, 1);
  assert.equal(cp.totalMs, 2 * DAY);
});

test("zero edges is reported as zero edges", () => {
  const cp = criticalPath([node("a", 1), node("b", 3)]);
  assert.equal(cp.edges, 0);
  assert.deepEqual(cp.path, ["b"]); // heaviest single task, and render says so
});

test("a dependency loop is reported, not hung on", () => {
  const cp = criticalPath([node("x", 1, ["z"]), node("y", 1, ["x"]), node("z", 1, ["y"])]);
  assert.equal(cp.cycles.length, 1);
  assert.ok(cp.totalMs > 0); // still produced a usable answer
});

test("edges outside the fetched scope are ignored", () => {
  const cp = criticalPath([node("a", 2, ["not-fetched"])]);
  assert.deepEqual(cp.path, ["a"]);
  assert.equal(cp.totalMs, 2 * DAY);
});

test("duration falls back to the date span when no estimate exists", () => {
  const span: ScheduleNode = {
    id: "s",
    name: "s",
    assignees: [],
    dependsOn: [],
    blocks: [],
    start: 0,
    due: 3 * DAY,
  };
  assert.equal(durationMs(span), 3 * DAY);
  // Estimate wins when both are present.
  assert.equal(durationMs({ ...span, estimateMs: DAY }), DAY);
  // Neither: weightless, but must not be NaN.
  assert.equal(durationMs({ ...span, start: undefined, due: undefined }), 0);
});

test("toNode splits ClickUp's two-sided dependency rows", () => {
  const t: Task = {
    id: "me",
    name: "me",
    start_date: "1000",
    due_date: null,
    time_estimate: "7200000",
    assignees: [{ id: 1, username: "dev" }],
    dependencies: [
      { task_id: "me", depends_on: "upstream" },
      { task_id: "downstream", depends_on: "me" },
      { task_id: "other", depends_on: "unrelated" }, // malformed row: dropped, not fabricated
    ],
  };
  const n = toNode(t);
  assert.deepEqual(n.dependsOn, ["upstream"]);
  assert.deepEqual(n.blocks, ["downstream"]);
  assert.equal(n.start, 1000);
  assert.equal(n.due, undefined); // null date must not become 0
  assert.equal(n.estimateMs, 7_200_000);
  assert.deepEqual(n.assignees, ["dev"]);
});
