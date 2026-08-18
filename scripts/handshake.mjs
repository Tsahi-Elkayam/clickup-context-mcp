#!/usr/bin/env node
/**
 * Boot the server over stdio with a fake token and assert the tool surface.
 * No network: listing tools never calls ClickUp. Catches a registration that
 * compiles but throws, and a write leaking into read mode.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";

async function tools(mode) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      CLICKUP_API_TOKEN: "pk_ci_fake",
      // Pinned so startup never reaches out to resolve a workspace.
      CLICKUP_TEAM_ID: "1",
      CLICKUP_MODE: mode,
    },
  });
  const client = new Client({ name: "ci-handshake", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const write = await tools("write");
const read = await tools("read");
const names = new Set(read.map((t) => t.name));

assert.ok(write.length > read.length, "read mode must expose fewer tools than write mode");
for (const banned of ["create_task", "delete_task", "bulk_update_tasks", "send_chat_message"]) {
  assert.ok(!names.has(banned), `${banned} must not be registered in read mode`);
}
for (const required of ["get_task_context", "get_schedule", "query_tasks"]) {
  assert.ok(names.has(required), `${required} must survive read mode`);
}
console.log(`✔ handshake ok — ${write.length} tools in write mode, ${read.length} in read mode`);
