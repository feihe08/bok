import type {
  SavedGroup,
  SavedPagesAutoArchivePeriod,
  SavedSession,
  SavedTab,
} from './model.ts';
import { getSessionGroups } from './session-items.ts';

export const AUTO_ARCHIVE_DAY_MS = 24 * 60 * 60 * 1000;

export interface AutoArchiveResult {
  archivedSessions: number;
  archivedGroups: number;
}

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

function canAutoArchiveSession(
  session: SavedSession,
  tabs: SavedTab[],
  now: number,
  periodDays: number,
): boolean {
  const archiveAgeBaseline = Math.max(
    session.createdAt,
    session.restoredAt ?? session.createdAt,
  );
  return (
    tabs.length > 0 &&
    session.archivedAt === null &&
    !session.pinned &&
    session.taskStatus !== 'todo' &&
    session.taskStatus !== 'doing' &&
    tabs.every(
      (tab) => tab.taskStatus !== 'todo' && tab.taskStatus !== 'doing',
    ) &&
    now - archiveAgeBaseline > periodDays * AUTO_ARCHIVE_DAY_MS
  );
}

export function archiveEligibleGroupsInMemory(
  sessions: SavedSession[],
  now: number,
  period: SavedPagesAutoArchivePeriod,
): AutoArchiveResult {
  if (period === 'never') return { archivedSessions: 0, archivedGroups: 0 };
  let archivedSessions = 0;
  let archivedGroups = 0;
  for (const session of sessions) {
    const directTabs =
      session.items.every((item) => item.type === 'tab')
        ? session.items.map((item) => item.tab)
        : [];
    if (canAutoArchiveSession(session, directTabs, now, period)) {
      session.archivedAt = now;
      archivedSessions += 1;
    }
    for (const group of getSessionGroups(session)) {
      if (!canAutoArchiveGroup(group, now, period)) continue;
      group.archivedAt = now;
      archivedGroups += 1;
    }
  }
  return { archivedSessions, archivedGroups };
}
