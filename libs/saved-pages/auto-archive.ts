import type { SavedGroup, SavedSession } from './model.ts';

export const AUTO_ARCHIVE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function canAutoArchiveGroup(group: SavedGroup, now: number): boolean {
  return (
    group.tabs.length > 0 &&
    group.archivedAt === null &&
    !group.pinned &&
    group.taskStatus !== 'todo' &&
    group.taskStatus !== 'doing' &&
    group.tabs.every(
      (tab) => tab.taskStatus !== 'todo' && tab.taskStatus !== 'doing',
    ) &&
    now - group.createdAt > AUTO_ARCHIVE_AGE_MS
  );
}

export function archiveEligibleGroupsInMemory(
  sessions: SavedSession[],
  now: number,
): number {
  let archivedGroups = 0;
  for (const session of sessions) {
    for (const group of session.groups) {
      if (!canAutoArchiveGroup(group, now)) continue;
      group.archivedAt = now;
      archivedGroups += 1;
    }
  }
  return archivedGroups;
}
