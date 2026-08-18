/**
 * Thin wrappers around the `git` CLI using Bun's shell. Interpolated values are
 * automatically escaped by Bun's `$`, so untrusted strings (URLs, branches,
 * commit messages) are passed as single arguments rather than re-parsed.
 */

import { $ } from "bun";

/**
 * Embed `token` into an HTTPS clone URL as `x-access-token:<token>@host` so a
 * private repository on any GitHub host clones without a global credential
 * helper. Non-HTTPS or unparseable URLs are returned unchanged.
 */
function authenticate(url: string, token: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") {
      parsed.username = "x-access-token";
      parsed.password = token;
      return parsed.toString();
    }
  } catch {
    // scp-like remotes (git@host:owner/repo) are not URLs; leave them as-is.
  }
  return url;
}

/** Replace any occurrence of `token` in `text` so it never reaches a log. */
function scrub(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("***") : text;
}

/**
 * Clone `url` at `branch` into `dir`. When `token` is given it is used to
 * authenticate the clone. Output is suppressed and any failure message is
 * scrubbed of the token before being thrown, so the credential never leaks.
 */
export async function clone(url: string, branch: string, dir: string, token?: string): Promise<void> {
  const cloneUrl = token ? authenticate(url, token) : url;
  const result = await $`git clone ${cloneUrl} -b ${branch} ${dir}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    throw new Error(`git clone failed for ${url} (${branch}): ${(token ? scrub(stderr, token) : stderr).trim()}`);
  }
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

/**
 * Return every commit subject (`%s`) in the repo at `dir`. A repository with no
 * commits yet (an unborn branch) yields an empty list rather than an error.
 */
export async function subjects(dir: string): Promise<string[]> {
  const result = await $`git -C ${dir} --no-pager log --format=%s`.nothrow().quiet();
  if (result.exitCode !== 0) return [];
  return result.stdout.toString().split("\n").filter((line) => line.length > 0);
}

/** Pull the latest history into the repo at `dir`, ignoring failures. */
export async function pull(dir: string): Promise<void> {
  await $`git -C ${dir} pull`.nothrow().quiet();
}

/**
 * Create an empty commit in the repo at `dir` with the given author `date` and
 * `message`. `date` is any string git accepts via `--date` — a UNIX timestamp
 * (`%at`) for repository commits, or an ISO datetime for account contributions.
 */
export async function commitEmpty(dir: string, date: string, message: string): Promise<void> {
  await $`git -C ${dir} commit --date=${date} -m ${message} --allow-empty`.nothrow().quiet();
}
