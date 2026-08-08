import type { Config } from "./config.js";
import type { Attachment, Comment, Task } from "./clickup.js";

export interface ImageBlock {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface ImageResult {
  images: ImageBlock[];
  skipped: string[]; // human-readable notes for images we could not include
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

// Detect real type from magic bytes; ClickUp extensions/mimetypes are unreliable.
function sniffMime(buf: Uint8Array): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  )
    return "image/webp";
  return null;
}

export function looksLikeImage(a: Attachment): boolean {
  const ext = (a.extension ?? "").toLowerCase();
  if (IMAGE_EXT.has(ext)) return true;
  return (a.mimetype ?? "").startsWith("image/");
}

/**
 * Download image attachments, sniff their real type, base64-encode, and apply a
 * total-size + count budget so a task with many screenshots can't blow up the
 * response. Newest images are kept first.
 */
export async function downloadImages(
  attachments: Attachment[],
  cfg: Config,
  apiToken: string,
  reservedBytes: number
): Promise<ImageResult> {
  const imageAtts = attachments.filter(looksLikeImage).slice(0, cfg.maxImages);
  const skipped: string[] = [];
  const images: ImageBlock[] = [];

  const totalDropped = attachments.filter(looksLikeImage).length - imageAtts.length;
  if (totalDropped > 0) {
    skipped.push(`${totalDropped} more image(s) over the MAX_IMAGES=${cfg.maxImages} limit`);
  }

  let budget = cfg.maxResponseMb * 1024 * 1024 - reservedBytes;

  for (const a of imageAtts) {
    try {
      const buf = await fetchBinary(a.url, apiToken);
      const mime = sniffMime(buf) ?? (a.mimetype?.startsWith("image/") ? a.mimetype : null);
      if (!mime) {
        skipped.push(`${a.title}: not a recognized image format`);
        continue;
      }
      // base64 is ~4/3 the binary size.
      const encodedSize = Math.ceil(buf.length / 3) * 4;
      if (encodedSize > budget) {
        skipped.push(`${a.title}: skipped to stay under MAX_RESPONSE_MB (${cfg.maxResponseMb}MB)`);
        continue;
      }
      budget -= encodedSize;
      images.push({ type: "image", data: Buffer.from(buf).toString("base64"), mimeType: mime });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      skipped.push(`${a.title}: download failed (${msg}). URL: ${a.url}`);
    }
  }

  return { images, skipped };
}

async function fetchBinary(url: string, apiToken: string): Promise<Uint8Array> {
  // Public CDN URLs need no auth; private-attachment-link workspaces do. Try
  // anonymous first, then retry with the token.
  let res = await fetch(url);
  if (res.status === 401 || res.status === 403) {
    res = await fetch(url, { headers: { Authorization: apiToken } });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// Pull attachment-style image URLs embedded inline in description/comment text.
const INLINE_URL = /https:\/\/[^\s)"']*attachments[^\s)"']+\.(png|jpe?g|gif|webp)/gi;

export function inlineImageUrls(text: string | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(INLINE_URL)) found.add(m[0]);
  return [...found];
}

/**
 * Every place an image can hide on a task, de-duped by url: real attachments,
 * comment image blocks, and image urls written inline in text. Comment blocks
 * matter most — a screenshot pasted into a comment appears in NEITHER
 * `task.attachments` NOR `comment_text` (which keeps only the filename).
 */
export function collectImageSources(task: Task, comments: Comment[]): Attachment[] {
  const byUrl = new Map<string, Attachment>();
  for (const a of task.attachments ?? []) byUrl.set(a.url, a);

  for (const c of comments) {
    for (const b of c.comment ?? []) {
      const img = b.type === "image" ? b.image : undefined;
      if (!img?.url || byUrl.has(img.url)) continue;
      byUrl.set(img.url, {
        id: img.id,
        title: img.title ?? img.name ?? "image",
        extension: img.type ?? "", // block `type` is the bare ext ("png")...
        mimetype: img.extension, // ...and block `extension` is the mimetype.
        url: img.url,
      });
    }
  }

  const texts = [task.description, task.text_content, ...comments.map((c) => c.comment_text)];
  for (const t of texts) {
    for (const url of inlineImageUrls(t)) {
      if (byUrl.has(url)) continue;
      const ext = url.split(".").pop()?.toLowerCase() ?? "";
      byUrl.set(url, { id: url, title: url.split("/").pop() ?? "inline", extension: ext, url });
    }
  }
  return [...byUrl.values()];
}
