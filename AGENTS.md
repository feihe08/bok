# Project Instructions

## Supported Platform

- Bok supports desktop Google Chrome only, as a Chrome extension.
- Mobile browsers, phones, tablets, touch-first layouts, and mobile viewport adaptation are outside the product scope.
- Do not propose, design, implement, review, test, or document mobile-specific behavior unless the user explicitly changes the supported-platform scope.
- Do not infer a mobile requirement from narrow window sizes; only address narrow desktop-window behavior when the user explicitly requests it.

## Data Model Changes

- Before modifying a data model, explicitly describe the proposed changes and their data compatibility or migration impact to the user.
- Data model changes include changes to any `model.ts`, persisted schema, model field, stored domain type or interface, serialization format, or migration.
- Do not edit files until the user explicitly confirms the proposed data model changes.
- After implementation, explicitly report the data model changes that were actually made.

## Feature Development Workflow

- Develop each new feature in a dedicated Git worktree on a `codex/`-prefixed branch created from `main`. Do not modify the primary `main` worktree while developing the feature.
- Before creating the worktree, inspect the repository status and existing worktrees. Preserve unrelated or uncommitted user changes.
- Complete the implementation, proportional verification, and code review in the feature worktree, then commit only the approved feature scope.
- Before merging, re-check the primary `main` worktree. If its uncommitted changes or concurrent branch movement make the merge unsafe, stop and ask the user instead of stashing, overwriting, rebasing, or discarding their work.
- Merge the completed feature branch into `main` without force. Only after the merge and relevant verification succeed, remove the feature worktree. Never remove a worktree containing uncommitted or unmerged work.

## Releases

- Every Bok release must follow the repository's current release workflow and synchronize both the unpacked extension and ZIP package to the iCloud release directory through `scripts/sync-release.mjs`.
- A release is not complete until the local and iCloud artifacts have been synchronized and verified. If iCloud access is blocked by the execution sandbox or permissions, request the required access and retry; do not report the release as complete.
- A local development build or verification build is not a release and does not require iCloud synchronization unless the user explicitly requests a release.
