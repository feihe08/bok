import type {
  SavedGroup,
  SavedPagesAutoArchivePeriod,
  SavedSession,
} from './model.ts';

export const AUTO_ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000;

function canAutoArchiveGroup(
  group: SavedGroup,
  now: number,
  periodDays: number,
): boolean {
  const archiveAgeBaseline = Math.max(
    group.createdAt,
    group.restoredAt ?? group.createdAt,
  );
  return (
    group.tabs.length > 0 &&
    group.archivedAt === null &&
    !group.pinned &&
    group.taskStatus !== 'todo' &&
    group.taskStatus !== 'doing' &&
    group.tabs.every(
      (tab) => tab.taskStatus !== 'todo' && tab.taskStatus !== 'doing',
    ) &&
    now - archiveAgeBaseline > periodDays * AUTO_ARCHIVE_DAY_MS
  );
}

export function archiveEligibleGroupsInMemory(
  sessions: SavedSession[],
  now: number,
  period: SavedPagesAutoArchivePeriod,
): number {
  if (period === 'never') return 0;
  let archivedGroups = 0;
  for (const session of sessions) {
    for (const group of session.groups) {
      if (!canAutoArchiveGroup(group, now, period)) continue;
      group.archivedAt = now;
      archivedGroups += 1;
    }
  }
  return archivedGroups;
}
