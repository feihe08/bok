# WXT + React

This template should help get you started developing with React in WXT.

## Source architecture

Chrome and page entrypoints live in `entrypoints/`. Reusable product code is
organized by feature in `libs/`:

- `saved-pages/` owns saved sessions, tabs, groups, and their archive rules.
- `tab-group-sync/` owns synchronization with live Chrome tab groups.
- `bookmarks/` owns Chrome bookmark access and bookmark archives.
- `backup/` owns the combined backup/import workflow.

Every feature defines its core data in `model.ts`. Other files are named after
the concrete behavior they implement and import each other directly; there are
no barrel modules or generic repository layers. Moving the source does not
change browser storage keys, schemas, or exported JSON formats.

## Test Chrome

Run `pnpm dev` to open Bok in Chrome for Testing. The primary checkout uses the
persistent profile at `~/Library/Application Support/bok-test-chrome`, so saved
tabs survive browser restarts and extension reloads. Linked feature worktrees use
isolated temporary profiles instead, preventing parallel development sessions
from sharing browser state; their browser data is discarded when the process exits.

Bok data remains local to that browser profile in `browser.storage.local`. Do not
remove the extension or delete the profile directory unless you intend to remove
its saved data. Development and release builds use the same stable extension ID.
Their data remains separate because `pnpm dev` uses a dedicated Chrome for Testing
profile; do not load both builds into the same browser profile at the same time.

## Parallel feature worktrees

Use `pnpm worktree create <slug>` after the requirement is clear. The command
creates `codex/<slug>` in the sibling `bok-worktrees/` directory and enforces a
maximum of six linked worktrees; the primary checkout is not counted. Initialize
the new worktree with `pnpm install --frozen-lockfile` and use `pnpm verify` for
the baseline compile and non-release build.

After independent review and verification, bind the merge to the checked commit
with `pnpm worktree merge <slug> --verified-sha <sha>`. Then remove the merged
worktree and its branch with `pnpm worktree close <slug>`. Use
`pnpm worktree list` and `pnpm worktree doctor` for status. Ordinary verification
must not use `pnpm build` or `pnpm zip`, because those commands perform a release.
If a worktree directory was deleted manually, preview stale metadata cleanup with
`pnpm worktree prune`; `--apply` requires explicit confirmation of that preview.

## Release builds

Run `pnpm build` for a Chrome release. The command type-checks the project, builds
and zips the extension, validates the stable Chrome Web Store ID, and writes the
versioned artifacts to `.output`:

- `bok-<version>-chrome/`
- `bok-chrome-<version>.zip`

After validation, the same two artifacts are synchronized to
`~/Library/Mobile Documents/com~apple~CloudDocs/Bok-development/releases`.
Building the same version replaces that version in iCloud. Both `.output` and
iCloud keep the highest three Chrome release versions and remove only older
artifacts that match Bok's current or legacy release naming patterns. The iCloud
`archive` directory and unrelated files are not changed.

`pnpm zip` uses the same release workflow. Load the versioned iCloud directory in
the regular Chrome profile; `.output` is for local build and verification work.
