import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface CurrentTask {
  taskId: string;
  useCustomId: boolean;
  label?: string;
  setAt: string;
}

function stateFile(): string {
  const base = process.env.CLICKUP_STATE_DIR || join(homedir(), ".clickup-context");
  return join(base, "current-task.json");
}

export async function setCurrentTask(t: CurrentTask): Promise<void> {
  const file = stateFile();
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(t, null, 2), "utf8");
  } catch {
    // Home dir may be read-only in some sandboxes; fall back to tmp.
    const fallback = join(tmpdir(), "clickup-context-current-task.json");
    await writeFile(fallback, JSON.stringify(t, null, 2), "utf8");
  }
}

export async function getCurrentTask(): Promise<CurrentTask | null> {
  for (const file of [
    stateFile(),
    join(tmpdir(), "clickup-context-current-task.json"),
  ]) {
    try {
      const raw = await readFile(file, "utf8");
      return JSON.parse(raw) as CurrentTask;
    } catch {
      // try next location
    }
  }
  return null;
}
