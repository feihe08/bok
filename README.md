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

Run `pnpm dev` to open Bok in Chrome for Testing. WXT always uses the persistent
profile at `~/Library/Application Support/bok-test-chrome`, so saved tabs survive
browser restarts and extension reloads.

Bok data remains local to that browser profile in `browser.storage.local`. Do not
remove the extension or delete the profile directory unless you intend to remove
its saved data. Use the dev output consistently while testing; the build output is
a different unpacked extension identity and therefore has separate local storage.
