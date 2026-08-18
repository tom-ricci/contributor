/**
 * Contributor — turn your commits into contributions.
 *
 * Reads `manifest.json`, which has two sections:
 *
 *   • repositories — for each, collects every commit by that repo's configured
 *     `author`, drops commits that appear in the repo's dedup repositories,
 *     drops commits already imported, and recreates the rest as empty commits
 *     with their original author dates.
 *   • accounts — for each, mirrors the account's contribution graph over a fixed
 *     date range: for every day with N contributions it creates N empty commits
 *     dated that day.
 *
 * Every generated commit shares a `C: <id> ...` message, so previously imported
 * work is detected and skipped and the workflow is safe to run repeatedly.
 *
 * Each entry names the secret that holds its token; the workflow passes all
 * secrets as `SECRETS` (`toJSON(secrets)`) and tokens are looked up by name.
 * The final `git push` is handled by the workflow, not this script.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { clone, commitEmpty, log, pull, subjects } from "./git.ts";
import { parseConfig, type Account, type Repository } from "./config.ts";
import { fetchContributionDays, fetchPublicContributionDays } from "./github.ts";

/** Path to the checked-out Contributor repository. */
const CONTRIBUTOR_DIR = process.env.CONTRIBUTOR_DIR ?? join(process.cwd(), "contributor");
/** Workspace root where source repositories are cloned as siblings. */
const WORKSPACE = dirname(CONTRIBUTOR_DIR);

/** Read a file's contents, returning `null` if it does not exist. */
async function readMaybe(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

/** Parse the `SECRETS` env (`toJSON(secrets)`) into a name→value map. */
function resolveSecrets(): Record<string, string> {
  const raw = process.env.SECRETS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("SECRETS env var is not valid JSON — expected `toJSON(secrets)` from the workflow.");
  }
}

/** Look up the token named by an entry, or fail with a helpful message. */
function requireToken(secrets: Record<string, string>, name: string, context: string): string {
  const token = secrets[name];
  if (!token) {
    throw new Error(`Token secret "${name}" for ${context} is not set — add it as a repository secret.`);
  }
  return token;
}

/** Collect the commit hashes authored by `author` across a repo's dedup repos. */
async function collectDedupHashes(repo: Repository, author: string, token: string | undefined): Promise<Set<string>> {
  const hashes = new Set<string>();

  for (const [index, dedup] of repo.dedup.entries()) {
    const dir = join(WORKSPACE, `dedup-${repo.id}-${index}`);
    try {
      await clone(dedup.url, dedup.branch, dir, token);
      for (const hash of await log(dir, author, "%H")) hashes.add(hash);
    } catch (error) {
      console.warn(`Skipping dedup source ${dedup.url} (${dedup.branch}): ${error}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return hashes;
}

/** Import all commits from a single repository into the Contributor repository. */
async function processRepository(repo: Repository, token: string | undefined): Promise<void> {
  const sourceDir = join(WORKSPACE, repo.id);

  // Clone the repo and collect this author's commits as importable lines.
  await clone(repo.url, repo.branch, sourceDir, token);
  let commits = await log(sourceDir, repo.author, `C: ${repo.id} %H %at`);

  // Sync Contributor and gather the messages of commits already imported.
  await pull(CONTRIBUTOR_DIR);
  const existing = new Set((await subjects(CONTRIBUTOR_DIR)).filter((subject) => subject.length > 0));

  // Drop commits that also appear in any of the configured dedup sources.
  const dedupHashes = await collectDedupHashes(repo, repo.author, token);
  if (dedupHashes.size > 0) {
    commits = commits.filter((line) => {
      const hash = line.split(" ")[2];
      return hash === undefined || !dedupHashes.has(hash);
    });
  }

  // Drop commits Contributor has already imported (identical generated message).
  commits = commits.filter((line) => !existing.has(line));

  // Apply the user's Git identity, then recreate each remaining commit.
  await $`bash ${join(CONTRIBUTOR_DIR, "credentials.sh")}`;
  for (const line of commits) {
    const timestamp = line.split(" ")[3];
    if (timestamp === undefined) continue;
    await commitEmpty(CONTRIBUTOR_DIR, timestamp, line);
  }

  await rm(sourceDir, { recursive: true, force: true });
  console.log(
    `Committed ${commits.length} commit(s) by ${repo.author} from ${repo.branch} in ${repo.url} ` +
      `to Contributor with the message C: ${repo.id} <Hash> <Timestamp>`,
  );
}

/** Mirror an account's contribution graph into the Contributor repository. */
async function processAccount(account: Account, secrets: Record<string, string>): Promise<void> {
  // Fetch the per-day counts: authenticated via GraphQL when a token is named,
  // otherwise anonymously by scraping the public profile of `username`.
  const days = account.token
    ? await fetchContributionDays(requireToken(secrets, account.token, `account "${account.id}"`), account.from, account.to)
    : await fetchPublicContributionDays(account.username as string, account.from, account.to);

  // Sync Contributor and gather the messages of contributions already imported.
  await pull(CONTRIBUTOR_DIR);
  const existing = new Set((await subjects(CONTRIBUTOR_DIR)).filter((subject) => subject.length > 0));

  // Expand each day into one line per contribution, keyed by day + 1-based index,
  // then drop any Contributor has already imported (identical generated message).
  const pending: Array<{ date: string; message: string }> = [];
  for (const day of days) {
    for (let index = 1; index <= day.count; index++) {
      const message = `C: ${account.id} ${day.date} ${index}`;
      if (!existing.has(message)) pending.push({ date: day.date, message });
    }
  }

  // Apply the user's Git identity, then create each empty commit at noon UTC so
  // it lands on the intended calendar day regardless of runner/viewer timezone.
  await $`bash ${join(CONTRIBUTOR_DIR, "credentials.sh")}`;
  for (const { date, message } of pending) {
    await commitEmpty(CONTRIBUTOR_DIR, `${date}T12:00:00Z`, message);
  }

  console.log(
    `Committed ${pending.length} contribution(s) for account ${account.id} ` +
      `between ${account.from} and ${account.to} with the message C: ${account.id} <Date> <Index>`,
  );
}

async function main(): Promise<void> {
  if (!existsSync(CONTRIBUTOR_DIR)) {
    throw new Error(`Contributor directory not found: ${CONTRIBUTOR_DIR}`);
  }

  const configRaw = await readMaybe(join(CONTRIBUTOR_DIR, "manifest.json"));
  if (configRaw === null) {
    console.log("No manifest.json found — nothing to do.");
    return;
  }
  const config = parseConfig(configRaw);
  if (config.repositories.length === 0 && config.accounts.length === 0) {
    console.log("No repositories or accounts configured in manifest.json — nothing to do.");
    return;
  }

  const secrets = resolveSecrets();

  for (const repo of config.repositories) {
    // Public repositories clone without a token.
    const token = repo.token ? requireToken(secrets, repo.token, `repository "${repo.id}"`) : undefined;
    await processRepository(repo, token);
  }

  for (const account of config.accounts) {
    await processAccount(account, secrets);
  }
}

await main();
