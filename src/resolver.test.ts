import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRef } from "./resolver.js";
import { inlineImageUrls } from "./images.js";
import type { ClickUpClient } from "./clickup.js";

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
