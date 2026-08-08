import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRef } from "./resolver.js";
import { collectImageSources, inlineImageUrls } from "./images.js";
import { resolveStatus } from "./clickup.js";
import type { ClickUpClient, Comment, Task } from "./clickup.js";

// The real strings from the zed-q workspace, stray spaces and periods included.
const STATUSES = [
  "to do",
  "requires specification.",
  "moved to local qa ",
  "moved to development.",
  "moved to prod qa .",
  "complete",
];

test("resolveStatus finds the exact string from a human-typed one", () => {
  assert.equal(resolveStatus("prod qa", STATUSES), "moved to prod qa .");
  assert.equal(resolveStatus("Moved To Prod QA", STATUSES), "moved to prod qa .");
  assert.equal(resolveStatus("moved to prod qa .", STATUSES), "moved to prod qa .");
});

test("resolveStatus refuses to guess when the input is ambiguous or unknown", () => {
  // "qa" matches both local qa and prod qa — guessing would move work backwards.
  assert.equal(resolveStatus("qa", STATUSES), null);
  assert.equal(resolveStatus("shipped", STATUSES), null);
  assert.equal(resolveStatus("", STATUSES), null);
});

// Fuzzy resolution is the only branch that touches the client.
const stubClient = {
  async listTeamTasks() {
    return [
      { id: "aaa111", name: "Fix login bug", list: { name: "Bugs" }, status: { status: "open" } },
      { id: "bbb222", name: "Onboarding flow", list: { name: "Feat" }, status: { status: "open" } },
    ];
  },
} as unknown as ClickUpClient;

test("parses a task URL", async () => {
  const r = await resolveRef(stubClient, "https://app.clickup.com/t/abc123");
  assert.deepEqual(r.resolved, { taskId: "abc123", useCustomId: false });
});

test("detects a custom id", async () => {
  const r = await resolveRef(stubClient, "DEV-456");
  assert.deepEqual(r.resolved, { taskId: "DEV-456", useCustomId: true });
});

test("detects a native id", async () => {
  const r = await resolveRef(stubClient, "abcd1234");
  assert.deepEqual(r.resolved, { taskId: "abcd1234", useCustomId: false });
});

test("fuzzy single match resolves directly", async () => {
  const r = await resolveRef(stubClient, "login bug");
  assert.equal(r.resolved?.taskId, "aaa111");
});

test("fuzzy ambiguous returns candidates", async () => {
  const r = await resolveRef(stubClient, "flow bug");
  assert.ok((r.candidates?.length ?? 0) >= 2);
  assert.equal(r.resolved, undefined);
});

test("inlineImageUrls finds attachment image links in text", () => {
  const text =
    "see ![](https://attachments-public.clickup.com/x/shot.png) and (https://attachments-public.clickup.com/y/two.jpeg)";
  const urls = inlineImageUrls(text);
  assert.equal(urls.length, 2);
  assert.ok(urls.some((u) => u.endsWith("shot.png")));
});

// A screenshot pasted into a comment is invisible in both task.attachments and
// comment_text; only the comment's image block carries it.
test("collectImageSources finds images that exist only in comment blocks", () => {
  const task = { attachments: [] } as unknown as Task;
  const comments: Comment[] = [
    {
      id: "1",
      comment_text: "image.png\nלהוסיף כפתור",
      user: {},
      date: "0",
      comment: [
        { type: "image", image: { id: "abc.png", title: "image.png", type: "png", extension: "image/png", url: "https://t1.p.clickup-attachments.com/t1/abc/image.png" } },
        { type: undefined, image: undefined },
      ],
    },
  ];
  const srcs = collectImageSources(task, comments);
  assert.equal(srcs.length, 1);
  assert.equal(srcs[0].url, "https://t1.p.clickup-attachments.com/t1/abc/image.png");
  // downloadImages() gates on extension/mimetype, so the block's swapped naming
  // must be unswapped or the image is silently dropped.
  assert.equal(srcs[0].extension, "png");
  assert.equal(srcs[0].mimetype, "image/png");
});
