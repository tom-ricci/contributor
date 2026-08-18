/**
 * Parsing for `sources.txt`.
 *
 * Each non-empty line describes one source repository whose commits should be
 * imported, with an optional list of deduplication sources after a pipe (`|`):
 *
 *   <Repo Link> <Branch> <Repo ID>
 *   <Repo Link> <Branch> <Repo ID> | <Repo 2 Link> <Branch 2>, <Repo 3 Link> <Branch 3>
 *
 * Commits that appear (by hash, for the configured author) in any dedup source
 * are skipped when importing the primary source.
 */

/** A repository/branch pair used to deduplicate commits out of a source. */
export interface DedupSource {
  url: string;
  branch: string;
}

/** A single source line: a repo to import plus optional dedup sources. */
export interface Source {
  /** Clone URL of the repository to import commits from. */
  url: string;
  /** Branch to import commits from. */
  branch: string;
  /** Stable identifier Contributor uses in generated commit messages. */
  id: string;
  /** Repositories whose commits should be excluded from this source. */
  dedup: DedupSource[];
}

/** Collapse runs of whitespace and trim, mirroring the shell's `xargs` usage. */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Parse the right-hand side of a source line into dedup sources. */
function parseDedup(section: string): DedupSource[] {
  return section
    .split(",")
    .map(normalize)
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [url, branch] = entry.split(" ");
      // A dedup entry needs both a URL and a branch to be usable.
      if (!url || !branch) return null;
      return { url, branch } satisfies DedupSource;
    })
    .filter((entry): entry is DedupSource => entry !== null);
}

/**
 * Parse the contents of `sources.txt` into structured {@link Source} entries.
 *
 * Blank lines, `#` comments, and the placeholder template line (whose tokens
 * are wrapped in angle brackets, e.g. `<Repo Link>`) are ignored so an
 * unconfigured template repository is a no-op rather than an error.
 */
export function parseSources(contents: string): Source[] {
  const sources: Source[] = [];

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const [primarySection, dedupSection = ""] = line.split("|");
    const [url, branch, id] = normalize(primarySection ?? "").split(" ");

    // Skip the placeholder template line and any incomplete entries.
    if (!url || !branch || !id) continue;
    if (url.startsWith("<")) continue;

    sources.push({ url, branch, id, dedup: parseDedup(dedupSection) });
  }

  return sources;
}
