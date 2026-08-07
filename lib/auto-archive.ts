import type { SavedGroup, SavedSession } from './types.ts';

export const AUTO_ARCHIVE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function canAutoArchiveGroup(group: SavedGroup, now: number): boolean {
  return (
    group.tabs.length > 0 &&
    group.archivedAt === null &&
    !group.pinned &&
    group.taskStatus === null &&
    group.tabs.every((tab) => tab.taskStatus === null) &&
    now - group.createdAt >= AUTO_ARCHIVE_AGE_MS
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
