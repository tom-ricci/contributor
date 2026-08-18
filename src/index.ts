/**
 * Contributor — turn your commits into contributions.
 *
 * For each source in `sources.txt`, this collects every commit by the author in
 * `author.txt`, drops commits that appear in the source's dedup repositories,
 * drops commits Contributor has already imported, and recreates the rest as
 * empty commits in the Contributor repository with their original author dates.
 *
 * Because every generated commit shares the same `C: <id> <hash> <timestamp>`
 * message format, previously imported commits can be detected and skipped, so
 * the workflow is safe to run as often as you like.
 *
 * Auth and the final `git push` are handled by the workflow, not this script.
 */

import { $ } from "bun";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { clone, commitEmpty, log, pull, subjects } from "./git.ts";
import { parseSources, type Source } from "./sources.ts";

/** Path to the checked-out Contributor repository. */
const CONTRIBUTOR_DIR = process.env.CONTRIBUTOR_DIR ?? join(process.cwd(), "contributor");
/** Workspace root where source repositories are cloned as siblings. */
const WORKSPACE = dirname(CONTRIBUTOR_DIR);

/** Read a file's contents, returning `null` if it does not exist. */
async function readMaybe(path: string): Promise<string | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
}

/** Collect the commit hashes authored by `author` across a source's dedup repos. */
async function collectDedupHashes(source: Source, author: string): Promise<Set<string>> {
  const hashes = new Set<string>();

  for (const [index, dedup] of source.dedup.entries()) {
    const dir = join(WORKSPACE, `dedup-${source.id}-${index}`);
    try {
      await clone(dedup.url, dedup.branch, dir);
      for (const hash of await log(dir, author, "%H")) hashes.add(hash);
    } catch (error) {
      console.warn(`Skipping dedup source ${dedup.url} (${dedup.branch}): ${error}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  return hashes;
}

/** Import all commits from a single source into the Contributor repository. */
async function processSource(source: Source, author: string): Promise<void> {
  const sourceDir = join(WORKSPACE, source.id);

  // Clone the source and collect this author's commits as importable lines.
  await clone(source.url, source.branch, sourceDir);
  let commits = await log(sourceDir, author, `C: ${source.id} %H %at`);

  // Sync Contributor and gather the messages of commits already imported.
  await pull(CONTRIBUTOR_DIR);
  const existing = (await subjects(CONTRIBUTOR_DIR)).filter((subject) => subject.length > 0);

  // Drop commits that also appear in any of the configured dedup sources.
  const dedupHashes = await collectDedupHashes(source, author);
  if (dedupHashes.size > 0) {
    commits = commits.filter((line) => {
      const hash = line.split(" ")[2];
      return hash === undefined || !dedupHashes.has(hash);
    });
  }

  // Drop commits Contributor has already imported (identical generated message).
  commits = commits.filter((line) => !existing.includes(line));

  // Apply the user's Git identity, then recreate each remaining commit.
  await $`bash ${join(CONTRIBUTOR_DIR, "credentials.sh")}`;
  for (const line of commits) {
    const timestamp = line.split(" ")[3];
    if (timestamp === undefined) continue;
    await commitEmpty(CONTRIBUTOR_DIR, timestamp, line);
  }

  await rm(sourceDir, { recursive: true, force: true });
  console.log(
    `Committed ${commits.length} commit(s) by ${author} from ${source.branch} in ${source.url} ` +
      `to Contributor with the message C: ${source.id} <Hash> <Timestamp>`,
  );
}

async function main(): Promise<void> {
  if (!existsSync(CONTRIBUTOR_DIR)) {
    throw new Error(`Contributor directory not found: ${CONTRIBUTOR_DIR}`);
  }

  const authorRaw = await readMaybe(join(CONTRIBUTOR_DIR, "author.txt"));
  const author = authorRaw?.split("\n")[0]?.trim() ?? "";
  if (author.length === 0) {
    throw new Error("author.txt is empty — add the commit author to import.");
  }

  const sourcesRaw = await readMaybe(join(CONTRIBUTOR_DIR, "sources.txt"));
  const sources = parseSources(sourcesRaw ?? "");
  if (sources.length === 0) {
    console.log("No sources configured in sources.txt — nothing to do.");
    return;
  }

  for (const source of sources) {
    await processSource(source, author);
  }
}

await main();
