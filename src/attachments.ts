import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ClickUpClient } from "./clickup.js";

/**
 * Uploading files to a task — the return trip for the screenshots this server
 * already reads out. v2's multipart endpoint is used rather than the newer v3
 * one because it is the long-standing path every ClickUp client exercises.
 */

/** Refuse anything that would just fail slowly at the API. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export interface UploadedAttachment {
  id?: string;
  title?: string;
  url?: string;
  size?: number;
}

/**
 * Resolve one of the three ways a caller can name a file into bytes.
 * `url` is fetched here rather than handed to ClickUp because ClickUp's upload
 * endpoint takes bytes only — there is no "attach from URL" on the API.
 */
export async function loadSource(src: {
  file_path?: string;
  url?: string;
  base64?: string;
  filename?: string;
}): Promise<{ bytes: Uint8Array; filename: string } | { error: string }> {
  try {
    if (src.file_path) {
      const bytes = await readFile(src.file_path);
      return { bytes, filename: src.filename || basename(src.file_path) };
    }
    if (src.base64) {
      if (!src.filename) return { error: "base64 uploads need a filename (ClickUp names the file by it)." };
      // Tolerate a data: URI — models produce them constantly.
      const raw = src.base64.replace(/^data:[^;]+;base64,/, "");
      return { bytes: Buffer.from(raw, "base64"), filename: src.filename };
    }
    if (src.url) {
      const res = await fetch(src.url);
      if (!res.ok) return { error: `Could not fetch ${src.url}: HTTP ${res.status}.` };
      const buf = Buffer.from(await res.arrayBuffer());
      const fromUrl = decodeURIComponent(new URL(src.url).pathname.split("/").pop() || "");
      return { bytes: buf, filename: src.filename || fromUrl || "attachment" };
    }
    return { error: "Give one of file_path, url, or base64." };
  } catch (e) {
    return { error: `Could not read the file: ${(e as Error).message}` };
  }
}

export async function uploadAttachment(
  client: ClickUpClient,
  taskId: string,
  bytes: Uint8Array,
  filename: string,
  useCustomId = false
): Promise<{ result: UploadedAttachment } | { error: string }> {
  if (!bytes.length) return { error: "That file is empty — nothing was uploaded." };
  if (bytes.length > MAX_UPLOAD_BYTES) {
    return {
      error: `That file is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      } MB cap.`,
    };
  }
  const form = new FormData();
  // The field name is `attachment`, and the filename argument is what ClickUp
  // displays — a Blob without one uploads as "blob".
  form.append("attachment", new Blob([new Uint8Array(bytes)]), filename);
  const params = useCustomId ? `?custom_task_ids=true&team_id=${client.teamId}` : "";
  const result = await client.postForm<UploadedAttachment>(
    `/task/${encodeURIComponent(taskId)}/attachment${params}`,
    form
  );
  return { result };
}
