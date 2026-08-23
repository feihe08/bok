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

## Releases

- Every Bok release must follow the repository's current release workflow and synchronize both the unpacked extension and ZIP package to the iCloud release directory through `scripts/sync-release.mjs`.
- A release is not complete until the local and iCloud artifacts have been synchronized and verified. If iCloud access is blocked by the execution sandbox or permissions, request the required access and retry; do not report the release as complete.
- A local development build or verification build is not a release and does not require iCloud synchronization unless the user explicitly requests a release.

## Parallel Feature Worktrees

- For every code-changing requirement, clarify the requested behavior and scope before implementation, then create a dedicated linked worktree with `pnpm worktree create <slug>`. Explanations and read-only investigation do not require a worktree.
- Keep the primary `main` checkout as the integration checkout. Do not implement features there; use it only for worktree administration, reviewed merges, release work, and explicitly requested repository maintenance.
- Allow at most six registered non-primary worktrees at once. The primary checkout does not count. Every linked worktree counts, including manually created, locked, or prunable entries. Do not bypass or change this limit, or the matching `MAX_LINKED_WORKTREES` script constant, unless the user explicitly asks to change the limit in this file.
- Use `pnpm worktree ...` for worktree creation, listing, merging, and removal. Do not call `git worktree add`, `git worktree remove`, or `git worktree prune` directly after this workflow is available.
- Create `codex/<slug>` from the current local `main`. Preserve uncommitted user work; do not stash, reset, overwrite, or include primary-checkout changes in the feature branch.
- Initialize each worktree with `pnpm install --frozen-lockfile`, then implement and run proportional checks there. Have an independent agent or reviewer inspect the final scope and verification result. If implementation changes afterward, repeat the affected checks and review.
- Merge only the exact independently verified commit with `pnpm worktree merge <slug> --verified-sha <sha>`. Both checkouts must be clean, the verified SHA must still be the feature branch tip, and the merge must be a fast-forward. If `main` moved or histories diverged, update the feature branch deliberately and repeat verification before merging.
- After the merge is verified, run `pnpm worktree close <slug>`. Never remove a dirty or unmerged worktree, never force-remove it, and never force-delete its branch.
- If a worktree directory was deleted outside the manager, inspect the exact cleanup with `pnpm worktree prune`. Run `pnpm worktree prune --apply` only after the user explicitly confirms that preview. Do not call `git worktree prune` directly or prune automatically. Inspect and confirm repair operations separately.
- Across all worktrees, run at most two dependency installs, type checks, builds, test suites, or development browsers at once. Stop watchers and development browsers when they are no longer needed. Do not auto-start background development processes.
- Ordinary worktree verification uses focused checks and `pnpm verify` as appropriate. Do not run `pnpm build` or `pnpm zip` unless the user requested a release because both synchronize release artifacts to iCloud.
- Do not install the bookmark native host or use the live bookmark bridge from a feature worktree. Those commands share user-level Chrome configuration and runtime state and require a single explicit owner.
