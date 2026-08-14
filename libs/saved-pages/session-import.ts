import {
  collectGroupedTitles,
  getSavedGroupTitle,
  reserveNumericGroupTitle,
} from './group-names.ts';
import type { SavedSession } from './model.ts';

export interface ImportedTitleChange {
  from: string;
  to: string;
}

export interface SessionsMergeResult {
  sessions: SavedSession[];
  titleChanges: ImportedTitleChange[];
  importedSessions: number;
  importedGroups: number;
  importedTabs: number;
  skippedDuplicateGroups: number;
}

function collectIds(sessions: SavedSession[], source: string): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    const values = [
      session.id,
      ...session.groups.flatMap((group) => [
        group.id,
        ...group.tabs.map((tab) => tab.id),
      ]),
    ];
    for (const id of values) {
      if (ids.has(id)) throw new Error(`${source}包含重复 ID：${id}`);
      ids.add(id);
    }
  }
  return ids;
}

function reserveImportedId(id: string, usedIds: Set<string>): string {
  if (!usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }
  let nextId = crypto.randomUUID();
  while (usedIds.has(nextId)) nextId = crypto.randomUUID();
  usedIds.add(nextId);
  return nextId;
}

/** Merge imports by group identity without changing existing records or titles. */
export function mergeImportedSessions(
  existing: SavedSession[],
  imported: SavedSession[],
): SessionsMergeResult {
  const usedIds = collectIds(existing, '当前 Bok 数据');
  collectIds(imported, '导入文件');
  const existingGroupIds = new Set(
    existing.flatMap((session) => session.groups.map((group) => group.id)),
  );
  const sessions = existing.map((session) => ({
    ...session,
    groups: [...session.groups],
  }));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const addedGroups: Array<{
    sessionCreatedAt: number;
    sessionIndex: number;
    group: SavedSession['groups'][number];
    groupIndex: number;
  }> = [];
  let importedSessions = 0;
  let importedGroups = 0;
  let importedTabs = 0;
  let skippedDuplicateGroups = 0;

  imported.forEach((sourceSession, sessionIndex) => {
    const sourceGroups = sourceSession.groups.filter((group) => {
      if (!existingGroupIds.has(group.id)) return true;
      skippedDuplicateGroups += 1;
      return false;
    });
    if (sourceGroups.length === 0) return;

    let targetSession = sessionById.get(sourceSession.id);
    if (!targetSession) {
      const sessionId = reserveImportedId(sourceSession.id, usedIds);
      targetSession = { ...sourceSession, id: sessionId, groups: [] };
      sessions.push(targetSession);
      sessionById.set(sessionId, targetSession);
    }

    importedSessions += 1;
    sourceGroups.forEach((sourceGroup, groupIndex) => {
      const groupId = reserveImportedId(sourceGroup.id, usedIds);
      const tabs = sourceGroup.tabs.map((tab) => ({
        ...tab,
        id: reserveImportedId(tab.id, usedIds),
      }));
      const group = { ...sourceGroup, id: groupId, tabs };
      targetSession.groups.push(group);
      existingGroupIds.add(sourceGroup.id);
      importedGroups += 1;
      importedTabs += tabs.length;
      addedGroups.push({
        sessionCreatedAt: sourceSession.createdAt,
        sessionIndex,
        group,
        groupIndex,
      });
    });
  });

  const grouped = addedGroups
    .filter(({ group }) => group.grouped)
    .sort(
      (left, right) =>
        left.group.createdAt - right.group.createdAt ||
        left.sessionCreatedAt - right.sessionCreatedAt ||
        right.sessionIndex - left.sessionIndex ||
        left.groupIndex - right.groupIndex,
    );
  const reservedTitles = collectGroupedTitles(existing);
  const titleChanges: ImportedTitleChange[] = [];

  for (const { group } of grouped) {
    const original = getSavedGroupTitle(group);
    const title = reserveNumericGroupTitle(original, reservedTitles);
    if (group.title === title) continue;
    group.title = title;
    titleChanges.push({ from: original, to: title });
  }

  return {
    sessions,
    titleChanges,
    importedSessions,
    importedGroups,
    importedTabs,
    skippedDuplicateGroups,
  };
}
