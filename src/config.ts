/**
 * Parsing and validation for `manifest.json`.
 *
 * The manifest has two sections. Both are optional; an empty file is a no-op so
 * an unconfigured template repository does nothing rather than erroring.
 *
 *   {
 *     "repositories": [
 *       { "id": "work", "url": "...", "branch": "main", "author": "Me <me@x.com>",
 *         "token": "WORK_PAT", "dedup": [ { "url": "...", "branch": "main" } ] }
 *     ],
 *     "accounts": [
 *       { "id": "alt", "token": "ALT_PAT", "from": "2020-01-01", "to": "2026-08-18" }
 *     ]
 *   }
 *
 * `token` is the *name* of a repository secret (env var), never the token value.
 * `author` is the per-repository `git log --author=` filter used to find your
 * commits; the identity commits are *created* with comes from `credentials.sh`.
 * Every `id` must be unique across both sections because repositories and
 * accounts share the `C: <id> ...` commit-message namespace used for dedup.
 */

/** A repository/branch pair used to deduplicate commits out of a repository. */
export interface DedupSource {
  url: string;
  branch: string;
}

/** A source repository whose commits are imported as contributions. */
export interface Repository {
  /** Stable identifier used in generated commit messages. */
  id: string;
  /** Clone URL of the repository to import commits from. */
  url: string;
  /** Branch to import commits from. */
  branch: string;
  /** `git log --author=` filter identifying whose commits to import from this repo. */
  author: string;
  /** Name of the secret holding the clone token; omit for public repositories. */
  token?: string;
  /** Repositories whose commits should be excluded from this source. */
  dedup: DedupSource[];
}

/**
 * A GitHub account whose contribution graph is mirrored over a date range.
 *
 * Exactly one of `token`/`username` is set:
 *   • `token`    — authenticate as that token's owner (the GraphQL API, private
 *                  contributions included) and mirror its own graph.
 *   • `username` — read a public account's graph anonymously (no token needed).
 */
export interface Account {
  /** Stable identifier used in generated commit messages. */
  id: string;
  /** Name of the secret holding this account's token (authenticated mode). */
  token?: string;
  /** Public username to read anonymously (unauthenticated mode). */
  username?: string;
  /** Inclusive start date, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive end date, `YYYY-MM-DD`. */
  to: string;
}

/** The parsed contents of `manifest.json`. */
export interface Config {
  repositories: Repository[];
  accounts: Account[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Milliseconds since the epoch for a `YYYY-MM-DD` date at UTC midnight. */
function utcMillis(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** Narrow `value` to a plain object or throw a contextual error. */
function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** Require a non-empty string field, returning it trimmed. */
function requireString(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

/** An optional string field: `undefined`/`null`/absent yields `undefined`. */
function optionalString(value: unknown, field: string, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: "${field}" must be a non-empty string when present.`);
  }
  return value.trim();
}

/** Require a `YYYY-MM-DD` calendar date field. */
function requireDate(value: unknown, field: string, context: string): string {
  const raw = requireString(value, field, context);
  if (!DATE_PATTERN.test(raw) || Number.isNaN(utcMillis(raw))) {
    throw new Error(`${context}: "${field}" must be a valid YYYY-MM-DD date (got "${raw}").`);
  }
  return raw;
}

/** Map an optional array field through a parser, defaulting to `[]`. */
function parseArray<T>(
  value: unknown,
  field: string,
  context: string,
  parse: (entry: unknown, index: number) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context}: "${field}" must be an array.`);
  return value.map(parse);
}

function parseDedup(value: unknown, context: string): DedupSource[] {
  return parseArray(value, "dedup", context, (entry, index) => {
    const scope = `${context} dedup[${index}]`;
    const record = asRecord(entry, scope);
    return {
      url: requireString(record.url, "url", scope),
      branch: requireString(record.branch, "branch", scope),
    } satisfies DedupSource;
  });
}

function parseRepository(entry: unknown, index: number): Repository {
  const context = `repositories[${index}]`;
  const record = asRecord(entry, context);
  return {
    id: requireString(record.id, "id", context),
    url: requireString(record.url, "url", context),
    branch: requireString(record.branch, "branch", context),
    author: requireString(record.author, "author", context),
    token: optionalString(record.token, "token", context),
    dedup: parseDedup(record.dedup, context),
  } satisfies Repository;
}

function parseAccount(entry: unknown, index: number): Account {
  const context = `accounts[${index}]`;
  const record = asRecord(entry, context);
  const from = requireDate(record.from, "from", context);
  const to = requireDate(record.to, "to", context);
  if (utcMillis(from) >= utcMillis(to)) {
    throw new Error(`${context}: "from" (${from}) must be before "to" (${to}).`);
  }

  const token = optionalString(record.token, "token", context);
  const username = optionalString(record.username, "username", context);
  if (!token && !username) {
    throw new Error(`${context}: needs a "token" (reads that token's own account) or a "username" (reads a public account).`);
  }
  if (token && username) {
    throw new Error(`${context}: set only one of "token" or "username" — a token reads its own account, a username reads a public one.`);
  }

  return {
    id: requireString(record.id, "id", context),
    token,
    username,
    from,
    to,
  } satisfies Account;
}

/** Parse and validate the contents of `manifest.json`. */
export function parseConfig(contents: string): Config {
  let data: unknown;
  try {
    data = JSON.parse(contents);
  } catch (error) {
    throw new Error(`manifest.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }

  const root = asRecord(data, "manifest.json");
  const repositories = parseArray(root.repositories, "repositories", "manifest.json", parseRepository);
  const accounts = parseArray(root.accounts, "accounts", "manifest.json", parseAccount);

  // Ids namespace the generated commit messages, so they must be globally unique.
  const seen = new Set<string>();
  for (const { id, kind } of [
    ...repositories.map((repo) => ({ id: repo.id, kind: "repository" })),
    ...accounts.map((account) => ({ id: account.id, kind: "account" })),
  ]) {
    if (seen.has(id)) {
      throw new Error(`Duplicate id "${id}" (${kind}) — ids must be unique across repositories and accounts.`);
    }
    seen.add(id);
  }

  return { repositories, accounts };
}
