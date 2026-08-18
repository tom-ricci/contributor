# contributor
### Turn your commits into contributions!

Contributor is a little utility to add contributions to your GitHub timeline from two kinds of sources:

- **Repositories** &mdash; aggregate commits you authored in other repositories and recreate them on your graph.
- **Accounts** &mdash; mirror another GitHub account's entire contribution graph over a date range you choose.

## Installation
1. Create a repository out of this template.
2. Edit `manifest.json` to configure your sources (details below).
3. Edit `credentials.sh` and follow the instructions to add the Git identity your generated commits are created with (don't worry, it's only public information, nothing sensitive!).
4. Add a repository secret for any token you reference in `manifest.json` (see [Tokens](#tokens)). Public repositories and public accounts need no token at all.

## Configuring `manifest.json`
`manifest.json` has two optional sections. An empty file (`{ "repositories": [], "accounts": [] }`) is a valid no-op.

```json
{
  "repositories": [
    {
      "id": "work",
      "url": "https://github.com/me/private-work.git",
      "branch": "main",
      "author": "My Name <me@example.com>",
      "token": "WORK_REPO_PAT",
      "dedup": [
        { "url": "https://github.com/me/mirror.git", "branch": "main" }
      ]
    }
  ],
  "accounts": [
    { "id": "mine",   "token": "MY_ACCOUNT_PAT", "from": "2020-01-01", "to": "2026-08-18" },
    { "id": "public", "username": "octocat",     "from": "2015-01-01", "to": "2020-12-31" }
  ]
}
```

### `repositories`
Each entry is a repository whose commits (by its `author`) are recreated on your graph.

| Field | Meaning |
|-------|---------|
| `id` | Stable identifier Contributor uses in its generated commit messages. Change a repo's `url`/`branch` without recommitting past commits by keeping its `id`. |
| `url` | Clone URL of the repository. |
| `branch` | Branch to import commits from. |
| `author` | The commit author to import, matched with `git log --author=`. This must be the exact author string used on the commits (e.g. a name or email). It only *selects* commits &mdash; the identity commits are created with comes from `credentials.sh`. |
| `token` | *(optional)* **Name** of the repository secret holding the token used to clone this repo. Omit for public repositories. |
| `dedup` | *(optional)* Repositories whose commits should be **excluded** &mdash; commits that also appear (by hash, for this author) in any dedup repo are skipped. |

### `accounts`
Each entry mirrors an account's contribution graph over a fixed date range. Set **exactly one** of `token` or `username`:

| Field | Meaning |
|-------|---------|
| `id` | Stable identifier Contributor uses in its generated commit messages. |
| `token` | **Name** of the secret holding a token. Reads that token's *own* account (the account is whoever owns the token &mdash; no username needed) via the authenticated API, so it includes private contributions. |
| `username` | A public account to read **anonymously**, no token required. Reads only that account's *public* contributions. |
| `from` / `to` | Inclusive `YYYY-MM-DD` range to copy. Any range works; Contributor automatically chunks it into the per-request windows GitHub allows. |

> [!NOTE]
> A contribution graph only exposes a **count per day**, not individual events. So for each day with *N* contributions, Contributor creates *N* empty commits dated that day. This reproduces the graph's shape and colors, not the underlying events. (The authenticated `token` count can differ slightly from the anonymous `username` count for the same account, since one includes private contributions and they bucket days by different timezones.)

> [!IMPORTANT]
> **All `id`s must be unique** across `repositories` and `accounts`, since both share the commit-message namespace Contributor uses to avoid double-counting.

## Tokens
Tokens are optional &mdash; only private repositories and authenticated accounts need one. When you do use a token, you reference the **secret** that holds it; the token value never lives in `manifest.json`.

1. For each `token` name you use, add a repository secret with that exact name (Settings &rarr; Secrets and variables &rarr; Actions), containing a PAT.
   - **Repository** tokens need the `repo` scope (to clone private repositories).
   - **Account** tokens need `read:user` (to read the contribution calendar).
2. The workflow passes all secrets to Contributor via `toJSON(secrets)`, so **adding a token never requires editing the workflow** &mdash; just add the secret and reference its name.

## Usage
Go to Actions &rarr; Update Contributions and dispatch the workflow. It runs on dispatch, so trigger it whenever you want to update your contributions.

> [!NOTE]
> Contributor sets author dates to match the source exactly (real author dates for repository commits; noon UTC on the correct day for account contributions), so timing takes care of itself. Dispatch as often or as rarely as you like&mdash;contributions always show up on the correct dates.

## How it Works
Each run, Contributor:

- **For each repository:** clones it, collects the configured author's commits, drops the ones present in its dedup sources, drops commits it already imported, and recreates the rest as empty commits with their original author dates.
- **For each account:** reads the contribution calendar over your date range (authenticated via the API for `token`, or by scraping the public profile for `username`) and, for each day, creates enough empty commits to match that day's count.

Because every generated commit shares the same `C: <id> ...` message format, Contributor detects and skips work it has already imported, so runs are **idempotent** and safe to repeat. Finally it sets your Git credentials from `credentials.sh`, commits everything, and pushes.

> [!NOTE]
> Reconciliation is **append-only**: because account ranges are fixed, a day's count is stable and only ever grows, so Contributor only ever adds the missing commits &mdash; it never rewrites history. If you *shrink* an already-copied count (e.g. by narrowing a range) and want the extra commits removed, that's a manual history rewrite.
