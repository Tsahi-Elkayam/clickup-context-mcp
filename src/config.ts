export interface Config {
  apiToken: string;
  teamId: string;
  maxImages: number;
  maxResponseMb: number;
  searchPageLimit: number;
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
  const teamId = process.env.CLICKUP_TEAM_ID;
  if (!teamId) {
    throw new Error(
      "CLICKUP_TEAM_ID is required. It is the workspace id in your ClickUp URL: app.clickup.com/{TEAM_ID}/..."
    );
  }
  return {
    apiToken,
    teamId,
    maxImages: intFromEnv("CLICKUP_MAX_IMAGES", 8),
    maxResponseMb: intFromEnv("CLICKUP_MAX_RESPONSE_MB", 4),
    // Fuzzy search has no native name endpoint in the ClickUp API, so we page
    // through team tasks and rank client-side. Cap the pages we pull.
    searchPageLimit: intFromEnv("CLICKUP_SEARCH_PAGE_LIMIT", 5),
  };
}
