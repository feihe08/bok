import {
  collectGroupedTitles,
  getSavedGroupTitle,
  reserveNumericGroupTitle,
} from './group-names.ts';
import type { SavedSession } from './types.ts';

export interface ImportedTitleChange {
  from: string;
  to: string;
}

export interface SessionsMergeResult {
  sessions: SavedSession[];
  titleChanges: ImportedTitleChange[];
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

/** Merge imports without changing existing records or existing grouped titles. */
export function mergeImportedSessions(
  existing: SavedSession[],
  imported: SavedSession[],
): SessionsMergeResult {
  const existingIds = collectIds(existing, '当前 Bok 数据');
  const importedIds = collectIds(imported, '导入文件');
  for (const id of importedIds) {
    if (existingIds.has(id)) {
      throw new Error('导入文件已经导入过，或与当前 Bok 数据存在 ID 冲突');
    }
  }

  const importedCopies = imported.map((session) => ({
    ...session,
    groups: session.groups.map((group) => ({ ...group })),
  }));
  const grouped = importedCopies
    .flatMap((session, sessionIndex) =>
      session.groups.map((group, groupIndex) => ({
        session,
        sessionIndex,
        group,
        groupIndex,
      })),
    )
    .filter(({ group }) => group.grouped)
    .sort(
      (left, right) =>
        left.group.createdAt - right.group.createdAt ||
        left.session.createdAt - right.session.createdAt ||
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
    sessions: [...existing, ...importedCopies],
    titleChanges,
  };
}
