# Old School PRs

A Claude Code mod that brings back the old view of a session's pull requests:
a pane beside the chat with every PR and branch the current session opened or
pushed, and what each one needs right now.

The Code tab of the Claude desktop app lists a session's PRs at the bottom of
its session rail, with no state. You cannot tell at a glance which PR has a
conflict, which one has failing checks, and which one is ready to merge. This
mod shows exactly that.

## What it shows

One line per PR that still needs something: a label, the number (a link to
GitHub) and the title.

| Label | When |
| --- | --- |
| conflict | GitHub cannot merge the branch without a conflict |
| checks failed | checks on the latest commit failed |
| changes requested | a reviewer asked for changes |
| behind main | the branch is behind, and the repository requires it up to date |
| review required | the repository requires an approval that is missing |
| checks running | checks have not finished yet |
| ready to merge | no conflict, checks passed |
| draft | the PR is marked as a draft |

A branch the session pushed without a PR shows as "no PR, N commits not in
main".

Below, one line each for what is done: `merged #12 #13 …`, `closed …`, and
`no PR, all in main …` for branches that are safe to delete. When the
session's PRs span several repositories, numbers carry the repository name:
`api#42`.

The line under the prompt names only what waits for you, for example
`#42 ready to merge`. When nothing waits, there is no line.

At the bottom of the pane, "Refresh", and "All my open PRs": every open PR
authored by you across your repositories, and branches without an open PR.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install old-school-prs --marketplace rbaranov/old-school-prs
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it load
in every session).

From a shell:

```bash
claude plugin install old-school-prs --marketplace rbaranov/old-school-prs
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `rbaranov/old-school-prs`, then Add
plugin.

### Requirements

- Claude Code with function hooks (2.1.308 or later).
- The GitHub CLI, `gh`, signed in (`gh auth login`). The mod reads PRs as that
  account. It looks for `gh` on `PATH`, then in `/opt/homebrew/bin` and
  `/usr/local/bin`.

## Use

- The pane opens by itself in a session that has PRs or pushed branches, and
  when the session opens its first PR.
- `/prs` opens it in any session, also after it was closed with ×.
- Ask the agent to show the session's PRs: it can call the
  `mcp__old-school-prs__show` tool, which opens the pane and answers with the
  list as text.
- In a session that was already running when you installed or updated the
  mod, run `/reload-plugins`.

## How it finds the session's PRs

- From the session's transcript: `gh pr create` (the PR number in its output)
  and `git push ... origin <branch>` (the repository from the output, or from
  the folder the command ran in). Only commands the shell runs count: a
  heredoc body or a script that mentions `git push` in its text does not.
  Subagents' commands count while the session runs.
- The branch of the session's working folder, unless it is main or master.
- What it found is kept in the plugin store under the session id, so
  compaction does not lose it.

A PR created outside `gh pr create` (say, with the button on github.com) is
not seen until the session pushes its branch.

## How it works

- PR state comes from one `gh api graphql` query for all of the session's PRs.
- It refreshes at session start, after every `gh pr …`, `git push` and
  `git merge` the session runs, every 2 minutes, and on "Refresh". The
  all-open-PRs list refreshes every 5 minutes, only while it is expanded.
- `hooks/register.tsx` holds the hooks and the pane; `hooks/scan.ts` parses
  commands and picks labels, with no calls to the engine, so it is tested on
  its own.

## Checking it

1. Open a session that created PRs (or run `/reload-plugins` in one) → the
   "Session PRs" pane on the right lists them; if one waits, the line under
   the prompt reads `old-school-prs #<number> <label>`.
2. Compare the labels with GitHub: for an open PR,
   `gh pr view <number> --json mergeable,statusCheckRollup` → the conflict and
   checks match.
3. Merge a PR from the session (`gh pr merge`) → after the command it moves to
   the `merged` line, and the line under the prompt goes away.
4. Press "All my open PRs" → the list appears below; its count matches
   `gh search prs --author @me --state open`.
5. Open a session without PRs and type `/prs` → "No PRs in this session", and
   no line under the prompt.

## Developing

```bash
claude plugin validate .
claude plugin test .
```

To run your working copy instead of the installed one, add the folder as a
marketplace (`claude plugin marketplace add <folder>`) and install from it:
the plugin is then read from the folder, and `/reload-plugins` picks up
edits.
