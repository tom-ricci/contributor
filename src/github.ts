/**
 * Fetching an account's contribution calendar from GitHub's GraphQL API.
 *
 * The calendar exposes only a per-day count (no per-contribution timestamps), and
 * the API rejects any single query spanning more than one year. So a requested
 * range is split into sub-year windows, each fetched separately, and the results
 * are merged by date. The query uses `viewer`, so the account is whichever one
 * owns the token — no username is needed.
 */

const ENDPOINT = "https://api.github.com/graphql";

/** Window size in days, kept comfortably under the API's 1-year span limit. */
const WINDOW_DAYS = 360;
const DAY_MS = 86_400_000;

const CALENDAR_QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/** A single day with at least one contribution. */
export interface ContributionDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Number of contributions GitHub attributed to that day. */
  count: number;
}

interface Window {
  from: string;
  to: string;
}

function utcMillis(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function isoDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/** Split `[from, to]` (inclusive) into consecutive, non-overlapping sub-year windows. */
function windows(from: string, to: string): Window[] {
  const result: Window[] = [];
  const end = utcMillis(to);
  for (let cursor = utcMillis(from); cursor <= end; ) {
    const windowEnd = Math.min(cursor + WINDOW_DAYS * DAY_MS, end);
    result.push({ from: isoDate(cursor), to: isoDate(windowEnd) });
    cursor = windowEnd + DAY_MS;
  }
  return result;
}

interface CalendarResponse {
  data?: {
    viewer?: {
      contributionsCollection?: {
        contributionCalendar?: {
          weeks?: Array<{ contributionDays: Array<{ date: string; contributionCount: number }> }>;
        };
      };
    };
  };
  errors?: Array<{ message: string }>;
}

/** Fetch the day counts for a single window. Never includes the token in errors. */
async function fetchWindow(token: string, window: Window): Promise<Array<{ date: string; contributionCount: number }>> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "contributor",
    },
    body: JSON.stringify({
      query: CALENDAR_QUERY,
      variables: { from: `${window.from}T00:00:00Z`, to: `${window.to}T23:59:59Z` },
    }),
  });

  const range = `${window.from}..${window.to}`;
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed (${response.status} ${response.statusText}) for ${range}.`);
  }

  const payload = (await response.json()) as CalendarResponse;
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL error for ${range}: ${payload.errors.map((e) => e.message).join("; ")}`);
  }

  const weeks = payload.data?.viewer?.contributionsCollection?.contributionCalendar?.weeks;
  if (!weeks) {
    throw new Error(`Unexpected GraphQL response shape for ${range}.`);
  }
  return weeks.flatMap((week) => week.contributionDays);
}

/**
 * Return every day in `[from, to]` (inclusive) that has at least one
 * contribution, merged across windows and sorted oldest first.
 */
export async function fetchContributionDays(token: string, from: string, to: string): Promise<ContributionDay[]> {
  const lo = utcMillis(from);
  const hi = utcMillis(to);
  const byDate = new Map<string, number>();

  for (const window of windows(from, to)) {
    for (const day of await fetchWindow(token, window)) {
      const millis = utcMillis(day.date);
      // Calendars pad to whole weeks, so drop days outside the requested range.
      if (millis < lo || millis > hi) continue;
      if (day.contributionCount > 0) byDate.set(day.date, day.contributionCount);
    }
  }

  return [...byDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Fetch a public account's contribution days anonymously by scraping GitHub's
 * profile contributions fragment. No token is required. Unlike the GraphQL API
 * this only sees *public* contributions, and the endpoint returns a whole
 * calendar year at a time (ignoring the exact `from`), so it is fetched one year
 * per request and clamped to `[from, to]`.
 */
export async function fetchPublicContributionDays(username: string, from: string, to: string): Promise<ContributionDay[]> {
  const lo = utcMillis(from);
  const hi = utcMillis(to);
  const byDate = new Map<string, number>();

  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    for (const day of parseProfileCalendar(await fetchProfileYear(username, year))) {
      const millis = utcMillis(day.date);
      if (millis < lo || millis > hi) continue;
      if (day.count > 0) byDate.set(day.date, day.count);
    }
  }

  return [...byDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchProfileYear(username: string, year: number): Promise<string> {
  const url = `https://github.com/users/${encodeURIComponent(username)}/contributions?from=${year}-01-01&to=${year}-12-31`;
  const response = await fetch(url, { headers: { "User-Agent": "contributor" } });
  if (!response.ok) {
    const hint = response.status === 404 ? ` — is "${username}" a valid public account?` : "";
    throw new Error(`GitHub contributions request failed (${response.status} ${response.statusText}) for ${username} ${year}${hint}.`);
  }
  return response.text();
}

/**
 * Parse a profile contributions HTML fragment into day counts. Each day `<td>`
 * carries `data-date` and an `id`; the exact count lives in a sibling
 * `<tool-tip for="<id>">N contributions on ...</tool-tip>` ("No contributions"
 * means zero). Days are joined on that id.
 */
function parseProfileCalendar(html: string): Array<{ date: string; count: number }> {
  const dateById = new Map<string, string>();
  for (const tag of html.match(/<td\b[^>]*ContributionCalendar-day[^>]*>/g) ?? []) {
    const date = tag.match(/data-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
    const id = tag.match(/\bid="([^"]+)"/)?.[1];
    if (date && id) dateById.set(id, date);
  }

  const days: Array<{ date: string; count: number }> = [];
  const tooltip = /<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g;
  for (let match = tooltip.exec(html); match !== null; match = tooltip.exec(html)) {
    const date = dateById.get(match[1] ?? "");
    if (date === undefined) continue;
    const count = match[2]?.match(/^([\d,]+)\s+contribution/);
    days.push({ date, count: count ? Number(count[1]!.replace(/,/g, "")) : 0 });
  }
  return days;
}
