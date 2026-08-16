import {
  collectGroupedTitles,
  getSavedGroupTitle,
  reserveNumericGroupTitle,
} from './group-names.ts';
import type { SavedGroup, SavedSession } from './model.ts';
import {
  createItemsSession,
  getSessionGroups,
  getStandaloneGroupId,
} from './session-items.ts';

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
    const values = [session.id];
    for (const item of session.items) {
      if (item.type === 'tab') {
        values.push(item.tab.id, `tab:${item.tab.id}`);
        continue;
      }
      values.push(item.group.id, ...item.group.tabs.map((tab) => tab.id));
    }
    for (const id of values) {
      if (ids.has(id)) throw new Error(`${source}包含重复 ID：${id}`);
      ids.add(id);
    }
  }
  return ids;
}

const IMPORTED_SESSION_ID_SUFFIX = ':bok-imported-session';
const IMPORTED_GROUP_ID_SUFFIX = ':bok-imported-group';
const IMPORTED_DIRECT_TAB_ID_SUFFIX = ':bok-imported-tab';

function reserveImportedId(
  id: string,
  usedIds: Set<string>,
  reservedSourceIds: Set<string>,
): string {
  if (!usedIds.has(id)) {
    usedIds.add(id);
    return id;
  }
  let nextId = crypto.randomUUID();
  while (usedIds.has(nextId) || reservedSourceIds.has(nextId)) {
    nextId = crypto.randomUUID();
  }
  usedIds.add(nextId);
  return nextId;
}

function getDeterministicCandidate(
  sourceId: string,
  suffix: string,
  index: number,
): string {
  return `${sourceId}${suffix}${index === 0 ? '' : `-${index}`}`;
}

function getDeterministicCandidateIndex(
  candidate: string,
  sourceId: string,
  suffix: string,
): number | null {
  const base = `${sourceId}${suffix}`;
  if (candidate === base) return 0;
  if (!candidate.startsWith(`${base}-`)) return null;
  const value = candidate.slice(base.length + 1);
  return /^[1-9]\d*$/.test(value) ? Number(value) : null;
}

function findDeterministicCandidateId(
  ids: Iterable<string>,
  sourceId: string,
  suffix: string,
  reservedSourceIds: Set<string>,
  reserveStandaloneProxy = false,
): string | undefined {
  let selected: string | undefined;
  let selectedIndex = Number.POSITIVE_INFINITY;
  for (const id of ids) {
    const index = getDeterministicCandidateIndex(id, sourceId, suffix);
    if (
      index === null ||
      index >= selectedIndex ||
      reservedSourceIds.has(id) ||
      (reserveStandaloneProxy && reservedSourceIds.has(getStandaloneGroupId(id)))
    ) {
      continue;
    }
    selected = id;
    selectedIndex = index;
  }
  return selected;
}

function reserveDeterministicImportedId(
  sourceId: string,
  suffix: string,
  usedIds: Set<string>,
  reservedSourceIds: Set<string>,
): string {
  if (!usedIds.has(sourceId)) {
    usedIds.add(sourceId);
    return sourceId;
  }
  let index = 0;
  let candidate = getDeterministicCandidate(sourceId, suffix, index);
  while (usedIds.has(candidate) || reservedSourceIds.has(candidate)) {
    index += 1;
    candidate = getDeterministicCandidate(sourceId, suffix, index);
  }
  usedIds.add(candidate);
  return candidate;
}

function reserveImportedDirectTabId(
  sourceId: string,
  usedIds: Set<string>,
  reservedSourceIds: Set<string>,
  existingTargetItems: SavedSession['items'],
): string | null {
  const remappedId = findDeterministicCandidateId(
    existingTargetItems.flatMap((item) => item.type === 'tab' ? [item.tab.id] : []),
    sourceId,
    IMPORTED_DIRECT_TAB_ID_SUFFIX,
    reservedSourceIds,
    true,
  );
  if (remappedId !== undefined) return null;
  if (!usedIds.has(sourceId) && !usedIds.has(getStandaloneGroupId(sourceId))) {
    usedIds.add(sourceId);
    usedIds.add(getStandaloneGroupId(sourceId));
    return sourceId;
  }
  let index = 0;
  let candidate = getDeterministicCandidate(
    sourceId,
    IMPORTED_DIRECT_TAB_ID_SUFFIX,
    index,
  );
  while (
    usedIds.has(candidate) ||
    usedIds.has(getStandaloneGroupId(candidate)) ||
    reservedSourceIds.has(candidate) ||
    reservedSourceIds.has(getStandaloneGroupId(candidate))
  ) {
    index += 1;
    candidate = getDeterministicCandidate(
      sourceId,
      IMPORTED_DIRECT_TAB_ID_SUFFIX,
      index,
    );
  }
  usedIds.add(candidate);
  usedIds.add(getStandaloneGroupId(candidate));
  return candidate;
}

/** Merge imports by saved identity without changing existing records or titles. */
export function mergeImportedSessions(
  existing: SavedSession[],
  imported: SavedSession[],
): SessionsMergeResult {
  const usedIds = collectIds(existing, '当前 Bok 数据');
  const reservedSourceIds = collectIds(imported, '导入文件');
  const groupById = new Map(
    existing.flatMap((session) =>
      getSessionGroups(session).map((group) => [group.id, group] as const),
    ),
  );
  const existingDirectTabIds = new Set(
    existing.flatMap((session) =>
      session.items.flatMap((item) => item.type === 'tab' ? [item.tab.id] : []),
    ),
  );
  const sessions = existing.map((session) => ({ ...session, items: [...session.items] }));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const addedGroups: Array<{
    sessionCreatedAt: number;
    sessionIndex: number;
    group: SavedGroup;
    groupIndex: number;
  }> = [];
  let importedSessions = 0;
  let importedGroups = 0;
  let importedTabs = 0;
  let skippedDuplicateGroups = 0;

  imported.forEach((sourceSession, sessionIndex) => {
    let targetSession = sessionById.get(sourceSession.id);
    if (!targetSession) {
      const remappedId = findDeterministicCandidateId(
        sessionById.keys(),
        sourceSession.id,
        IMPORTED_SESSION_ID_SUFFIX,
        reservedSourceIds,
      );
      if (remappedId !== undefined) targetSession = sessionById.get(remappedId);
    }
    const existingTargetItems = targetSession ? [...targetSession.items] : [];
    const getTargetSession = (): SavedSession => {
      if (targetSession) return targetSession;
      const sessionId = reserveDeterministicImportedId(
        sourceSession.id,
        IMPORTED_SESSION_ID_SUFFIX,
        usedIds,
        reservedSourceIds,
      );
      targetSession = createItemsSession(
        sessionId,
        sourceSession.createdAt,
        [],
        sourceSession,
      );
      sessions.push(targetSession);
      sessionById.set(sessionId, targetSession);
      sessionById.set(sourceSession.id, targetSession);
      return targetSession;
    };

    if (sourceSession.items.length === 0 && !targetSession) {
      getTargetSession();
      importedSessions += 1;
      return;
    }

    let addedItems = 0;
    sourceSession.items.forEach((item, groupIndex) => {
      if (item.type === 'tab') {
        if (existingDirectTabIds.has(item.tab.id)) return;
        const id = reserveImportedDirectTabId(
          item.tab.id,
          usedIds,
          reservedSourceIds,
          existingTargetItems,
        );
        if (id === null) return;
        const tab = {
          ...item.tab,
          id,
        };
        getTargetSession().items.push({ type: 'tab', tab });
        existingDirectTabIds.add(item.tab.id);
        addedItems += 1;
        importedTabs += 1;
        return;
      }
      const sourceGroup = item.group;
      const remappedGroupId = findDeterministicCandidateId(
        groupById.keys(),
        sourceGroup.id,
        IMPORTED_GROUP_ID_SUFFIX,
        reservedSourceIds,
      );
      if (groupById.has(sourceGroup.id) || remappedGroupId !== undefined) {
        skippedDuplicateGroups += 1;
        return;
      }
      const groupId = reserveDeterministicImportedId(
        sourceGroup.id,
        IMPORTED_GROUP_ID_SUFFIX,
        usedIds,
        reservedSourceIds,
      );
      const tabs = sourceGroup.tabs.map((tab) => ({
        ...tab,
        id: reserveImportedId(tab.id, usedIds, reservedSourceIds),
      }));
      const group = { ...sourceGroup, id: groupId, tabs };
      getTargetSession().items.push({ type: 'group', group });
      groupById.set(groupId, group);
      addedItems += 1;
      importedGroups += 1;
      importedTabs += tabs.length;
      addedGroups.push({
        sessionCreatedAt: sourceSession.createdAt,
        sessionIndex,
        group,
        groupIndex,
      });
    });
    if (addedItems > 0) importedSessions += 1;
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
