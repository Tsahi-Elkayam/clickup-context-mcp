export type Mode = "read" | "write";

export interface Config {
  apiToken: string;
  /** Empty until resolved — see resolveTeamId() in index.ts. */
  teamId: string;
  /** "read" hides every mutating tool at registration time. */
  mode: Mode;
  maxImages: number;
  maxResponseMb: number;
  searchPageLimit: number;
  maxScheduleTasks: number;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): Config {
  const apiToken = process.env.CLICKUP_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "CLICKUP_API_TOKEN is required. Create a personal token at ClickUp > Settings > Apps."
    );
  }
  // Optional: an unset id is resolved from the token's own workspaces at
  // startup, so a single-workspace user never has to look it up.
  const teamId = process.env.CLICKUP_TEAM_ID ?? "";
  return {
    apiToken,
    teamId,
    // Default stays "write" — the server shipped with writes enabled and
    // flipping the default would silently break existing setups.
    mode: process.env.CLICKUP_MODE?.toLowerCase() === "read" ? "read" : "write",
    maxImages: intFromEnv("CLICKUP_MAX_IMAGES", 8),
    maxResponseMb: intFromEnv("CLICKUP_MAX_RESPONSE_MB", 4),
    // Fuzzy search has no native name endpoint in the ClickUp API, so we page
    // through team tasks and rank client-side. Cap the pages we pull.
    searchPageLimit: intFromEnv("CLICKUP_SEARCH_PAGE_LIMIT", 5),
    // Dependencies are absent from the filtered-tasks response, so a schedule
    // costs one extra call per task. 100 matches the per-minute token limit on
    // Free/Unlimited/Business — raising it spends the next minute's budget too.
    maxScheduleTasks: intFromEnv("CLICKUP_MAX_SCHEDULE_TASKS", 100),
  };
}
