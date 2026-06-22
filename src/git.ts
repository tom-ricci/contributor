/**
 * Thin wrappers around the `git` CLI using Bun's shell. Interpolated values are
 * automatically escaped by Bun's `$`, so untrusted strings (URLs, branches,
 * commit messages) are passed as single arguments rather than re-parsed.
 */

import { $ } from "bun";

/** Clone `url` at `branch` (shallow history not required) into `dir`. */
export async function clone(url: string, branch: string, dir: string): Promise<void> {
  await $`git clone ${url} -b ${branch} ${dir}`;
}

/**
 * Return the `git log` output for commits authored by `author` in the repo at
 * `dir`, formatted with `format`. Lines are returned in `git log` order
 * (newest first) with blank lines removed.
 */
export async function log(dir: string, author: string, format: string): Promise<string[]> {
  const output = await $`git -C ${dir} --no-pager log --author=${author} --format=${format}`.text();
  return output.split("\n").filter((line) => line.length > 0);
}

/** Return every commit subject (`%s`) in the repo at `dir`. */
export async function subjects(dir: string): Promise<string[]> {
  const output = await $`git -C ${dir} --no-pager log --format=%s`.text();
  return output.split("\n").filter((line) => line.length > 0);
}

/** Pull the latest history into the repo at `dir`, ignoring failures. */
export async function pull(dir: string): Promise<void> {
  await $`git -C ${dir} pull`.nothrow().quiet();
}

/**
 * Create an empty commit in the repo at `dir` with the given author `date`
 * (a UNIX timestamp string from `%at`) and `message`.
 */
export async function commitEmpty(dir: string, date: string, message: string): Promise<void> {
  await $`git -C ${dir} commit --date=${date} -m ${message} --allow-empty`.nothrow().quiet();
}
