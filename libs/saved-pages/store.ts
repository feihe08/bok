import {
  archiveEligibleGroupsInMemory,
  type AutoArchiveResult,
} from './auto-archive.ts';
import {
  collectGroupedTitles,
  ensureUniqueGroupedTitlesInMemory,
  getDefaultGroupTitle,
  getSavedGroupTitle,
  normalizeGroupTitle,
  reserveTimestampedGroupTitle,
  type GroupedTitleChange,
} from './group-names.ts';
import type {
  SavedGroup,
  SavedGroupColor,
  SavedGroupTaskStatus,
  SavedPagesAutoArchivePeriod,
  SavedSession,
  SavedSessionItem,
  SavedTab,
} from './model.ts';
import { getSessions, writeSessions } from './persistence.ts';
import { getSessionGroups, getStandaloneGroupId } from './session-items.ts';
import {
  getSavedPagesAutoArchivePeriod,
  setSavedPagesAutoArchivePeriod,
} from './settings.ts';

export interface ConvertGroupResult {
  groupTitle: string;
  renamed: boolean;
}

export interface SavedGroupTarget {
  sessionId: string;
  groupId: string;
  title: string;
}

function requireSession(
  sessions: SavedSession[],
  sessionId: string,
): SavedSession {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error('找不到要操作的保存记录');
  return session;
}

function requireSessionItems(session: SavedSession) {
  return session.items;
}

function getRealGroups(session: SavedSession): SavedGroup[] {
  return getSessionGroups(session);
}

function requireGroup(session: SavedSession, groupId: string): SavedGroup {
  const group = getRealGroups(session).find((candidate) => candidate.id === groupId);
  if (!group) throw new Error('找不到要操作的分组');
  return group;
}

function requireAddressedTab(
  session: SavedSession,
  groupId: string,
  tabId: string,
): SavedTab {
  if (groupId === getStandaloneGroupId(tabId)) {
    const item = requireSessionItems(session).find(
      (candidate) => candidate.type === 'tab' && candidate.tab.id === tabId,
    );
    if (item?.type === 'tab') return item.tab;
    throw new Error('找不到要操作的标签页');
  }
  return requireTab(requireGroup(session, groupId), tabId);
}

function requireTab(group: SavedGroup, tabId: string): SavedTab {
  const tab = group.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error('找不到要操作的标签页');
  return tab;
}

export async function addSession(session: SavedSession): Promise<void> {
  const sessions = await getSessions();
  await writeSessions([session, ...sessions]);
}

export async function getUnarchivedSavedGroupTargets(): Promise<SavedGroupTarget[]> {
  const sessions = await getSessions();
  return sessions.flatMap((session) =>
    session.archivedAt === null
      ? getRealGroups(session).flatMap((group) =>
          group.archivedAt === null
            ? [{ sessionId: session.id, groupId: group.id, title: group.title }]
            : [],
        )
      : [],
  );
}

export async function appendTabsToGroup(
  sessionId: string,
  groupId: string,
  tabs: SavedTab[],
): Promise<void> {
  const sessions = await getSessions();
  const session = requireSession(sessions, sessionId);
  if (session.archivedAt !== null) {
    throw new Error('目标保存记录已归档，请先恢复');
  }
  const group = requireGroup(session, groupId);
  if (group.archivedAt !== null) {
    throw new Error('目标分组已归档，请先恢复');
  }
  if (tabs.length === 0) return;
  group.tabs.push(...tabs);
  await writeSessions(sessions);
}

export async function getSavedGroup(
  sessionId: string,
  groupId: string,
): Promise<SavedGroup> {
  const sessions = await getSessions();
  return requireGroup(requireSession(sessions, sessionId), groupId);
}

export async function getSavedSession(sessionId: string): Promise<SavedSession> {
  return requireSession(await getSessions(), sessionId);
}

export async function ensureUniqueGroupedTitles(): Promise<GroupedTitleChange[]> {
  const sessions = await getSessions();
  const changes = ensureUniqueGroupedTitlesInMemory(sessions);
  if (changes.length > 0) await writeSessions(sessions);
  return changes;
}

export async function removeSession(sessionId: string): Promise<void> {
  const sessions = await getSessions();
  const targetSession = requireSession(sessions, sessionId);
  if (targetSession.locked) {
    throw new Error('保存记录已锁定，无法删除');
  }
  if (getRealGroups(targetSession).some((group) => group.locked)) {
    throw new Error('保存记录中包含已锁定的分组，无法删除');
  }
  await writeSessions(sessions.filter((session) => session.id !== sessionId));
}

export async function renameSession(
  sessionId: string,
  title: string,
): Promise<void> {
  const sessions = await getSessions();
  requireSession(sessions, sessionId).title = title.trim();
  await writeSessions(sessions);
}

export async function setSessionPinned(
  sessionId: string,
  pinned: boolean,
): Promise<void> {
  const sessions = await getSessions();
  const session = requireSession(sessions, sessionId);
  if (pinned && session.archivedAt !== null) {
    throw new Error('已归档的保存记录不能固定，请先恢复');
  }
  session.pinned = pinned;
  await writeSessions(sessions);
}

export async function setSessionArchived(
  sessionId: string,
  archived: boolean,
): Promise<void> {
  const sessions = await getSessions();
  const session = requireSession(sessions, sessionId);
  if (archived) {
    session.pinned = false;
    session.archivedAt ??= Date.now();
  } else {
    session.archivedAt = null;
    session.restoredAt = Date.now();
  }
  await writeSessions(sessions);
}

export async function setSessionTaskStatus(
  sessionId: string,
  taskStatus: SavedGroupTaskStatus | null,
): Promise<void> {
  const sessions = await getSessions();
  const session = requireSession(sessions, sessionId);
  if (session.taskStatus === taskStatus) return;
  session.taskStatus = taskStatus;
  session.taskCompletedAt = taskStatus === 'done' ? Date.now() : null;
  await writeSessions(sessions);
}

export async function setSessionLocked(
  sessionId: string,
  locked: boolean,
): Promise<void> {
  const sessions = await getSessions();
  requireSession(sessions, sessionId).locked = locked;
  await writeSessions(sessions);
}

/** Drop one tab, cleaning up any group or session left empty. */
export async function removeTab(sessionId: string, tabId: string): Promise<void> {
  const sessions = await getSessions();
  const targetSession = requireSession(sessions, sessionId);
  const items = requireSessionItems(targetSession);
  const targetItem = items.find((item) =>
    item.type === 'tab'
      ? item.tab.id === tabId
      : item.group.tabs.some((tab) => tab.id === tabId),
  );
  if (!targetItem) throw new Error('找不到要删除的标签页');
  if (targetSession.locked) {
    throw new Error('保存记录已锁定，无法删除其中的标签页');
  }
  if (targetItem.type === 'group' && targetItem.group.locked) {
    throw new Error('分组已锁定，无法删除其中的标签页');
  }
  targetSession.items = items.flatMap<SavedSessionItem>((item) => {
    if (item.type === 'tab') return item.tab.id === tabId ? [] : [item];
    if (item !== targetItem) return [item];
    const tabs = item.group.tabs.filter((tab) => tab.id !== tabId);
    return tabs.length > 0
      ? [{ type: 'group' as const, group: { ...item.group, tabs } }]
      : [];
  });
  await writeSessions(
    targetSession.items.length > 0
      ? sessions
      : sessions.filter((session) => session.id !== sessionId),
  );
}

export async function renameTab(
  sessionId: string,
  groupId: string,
  tabId: string,
  title: string,
): Promise<void> {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw new Error('标签页标题不能为空');

  const sessions = await getSessions();
  const tab = requireAddressedTab(
    requireSession(sessions, sessionId),
    groupId,
    tabId,
  );
  tab.title = normalizedTitle;
  tab.updatedAt = Date.now();
  await writeSessions(sessions);
}

/** Drop one group, dropping the session too if it becomes empty. */
export async function removeGroup(sessionId: string, groupId: string): Promise<void> {
  const sessions = await getSessions();
  const targetSession = requireSession(sessions, sessionId);
  if (targetSession.locked) {
    throw new Error('保存记录已锁定，无法删除其中的分组');
  }
  const targetGroup = requireGroup(targetSession, groupId);
  if (targetGroup.locked) {
    throw new Error('分组已锁定，无法删除');
  }
  targetSession.items = requireSessionItems(targetSession).filter(
    (item) => item.type !== 'group' || item.group.id !== groupId,
  );
  await writeSessions(
    targetSession.items.length > 0
      ? sessions
      : sessions.filter((session) => session.id !== sessionId),
  );
}

export async function renameGroup(
  sessionId: string,
  groupId: string,
  title: string,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  const normalizedTitle =
    normalizeGroupTitle(title) || getDefaultGroupTitle(group.tabs.length);
  const groupedTitles = collectGroupedTitles(sessions, group.id);
  if (groupedTitles.has(normalizedTitle)) {
    throw new Error(`标签组名称“${normalizedTitle}”已存在，请使用其他名称`);
  }
  group.title = normalizedTitle;
  await writeSessions(sessions);
}

export async function convertGroupToBrowserGroup(
  sessionId: string,
  groupId: string,
  _now = Date.now(),
): Promise<ConvertGroupResult> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  const requestedTitle = getSavedGroupTitle(group);
  return { groupTitle: requestedTitle, renamed: false };
}

export async function setGroupArchived(
  sessionId: string,
  groupId: string,
  archived: boolean,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  if (archived) {
    group.pinned = false;
    group.archivedAt ??= Date.now();
  } else {
    group.archivedAt = null;
    group.restoredAt = Date.now();
  }
  await writeSessions(sessions);
}

export async function setGroupLocked(
  sessionId: string,
  groupId: string,
  locked: boolean,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  group.locked = locked;
  await writeSessions(sessions);
}

export async function setGroupPinned(
  sessionId: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  if (pinned && group.archivedAt !== null) {
    throw new Error('已归档的分组不能固定，请先恢复');
  }
  group.pinned = pinned;
  await writeSessions(sessions);
}

export async function archiveEligibleGroups(
  now = Date.now(),
): Promise<AutoArchiveResult> {
  const period = await getSavedPagesAutoArchivePeriod();
  if (period === 'never') return { archivedSessions: 0, archivedGroups: 0 };
  const sessions = await getSessions();
  const result = archiveEligibleGroupsInMemory(sessions, now, period);

  if (result.archivedSessions + result.archivedGroups > 0) {
    await writeSessions(sessions);
  }
  return result;
}

export async function setAutoArchivePeriod(
  period: SavedPagesAutoArchivePeriod,
): Promise<void> {
  const previousPeriod = await getSavedPagesAutoArchivePeriod();
  await setSavedPagesAutoArchivePeriod(period);
  try {
    await archiveEligibleGroups();
  } catch (error) {
    await setSavedPagesAutoArchivePeriod(previousPeriod);
    throw error;
  }
}

export async function setGroupTaskStatus(
  sessionId: string,
  groupId: string,
  taskStatus: SavedGroupTaskStatus | null,
): Promise<ConvertGroupResult | null> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  const now = Date.now();

  if (group.taskStatus === null) {
    if (taskStatus === null) return null;
    group.taskStatus = 'doing';
    group.taskCompletedAt = null;
  } else {
    if (group.taskStatus === taskStatus) return null;
    group.taskStatus = taskStatus;
    group.taskCompletedAt = taskStatus === 'done' ? now : null;
  }
  await writeSessions(sessions);
  return null;
}

export async function setTabTaskStatus(
  sessionId: string,
  groupId: string,
  tabId: string,
  taskStatus: SavedGroupTaskStatus | null,
): Promise<void> {
  const sessions = await getSessions();
  const tab = requireAddressedTab(
    requireSession(sessions, sessionId),
    groupId,
    tabId,
  );
  const now = Date.now();

  if (tab.taskStatus === null) {
    if (taskStatus === null) return;
    tab.taskStatus = 'doing';
    tab.taskCompletedAt = null;
  } else {
    if (tab.taskStatus === taskStatus) return;
    tab.taskStatus = taskStatus;
    tab.taskCompletedAt = taskStatus === 'done' ? now : null;
  }
  await writeSessions(sessions);
}

export interface TaskGroupTabSnapshot {
  browserTabId: number;
  savedTabId?: string;
  url: string;
  title: string;
  favIconUrl?: string;
}

export async function syncTaskGroupSnapshot(
  sessionId: string,
  groupId: string,
  tabs: TaskGroupTabSnapshot[],
  previouslyMappedSavedTabIds: string[],
  metadata?: { title?: string; color?: SavedGroupColor },
  canCommit: () => boolean = () => true,
): Promise<{
  active: boolean;
  savedTabIdByBrowserTabId: Record<string, string>;
  groupTitle?: string;
}> {
  const sessions = await getSessions();
  if (!canCommit()) {
    return { active: false, savedTabIdByBrowserTabId: {} };
  }
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const group = session ? getRealGroups(session).find((candidate) => candidate.id === groupId) : undefined;
  if (!group) {
    return { active: false, savedTabIdByBrowserTabId: {} };
  }

  const now = Date.now();
  const existingById = new Map(group.tabs.map((tab) => [tab.id, tab]));
  const previousIds = new Set(previouslyMappedSavedTabIds);
  const currentIds = new Set<string>();
  const snapshotTabs: SavedTab[] = [];
  const savedTabIdByBrowserTabId: Record<string, string> = {};

  for (const snapshot of tabs) {
    const existing =
      snapshot.savedTabId && !currentIds.has(snapshot.savedTabId)
        ? existingById.get(snapshot.savedTabId)
        : undefined;
    const nextTitle = snapshot.title.trim() || snapshot.url;
    const savedTab = existing
      ? existing.url === snapshot.url &&
        existing.title === nextTitle &&
        existing.favIconUrl === snapshot.favIconUrl
        ? existing
        : {
            ...existing,
            url: snapshot.url,
            title: nextTitle,
            favIconUrl: snapshot.favIconUrl,
            updatedAt: now,
          }
      : {
          id: crypto.randomUUID(),
          url: snapshot.url,
          title: nextTitle,
          favIconUrl: snapshot.favIconUrl,
          createdAt: now,
          updatedAt: now,
          tags: [],
          directory: null,
          taskStatus: null,
          taskCompletedAt: null,
          archivedAt: null,
        };
    currentIds.add(savedTab.id);
    snapshotTabs.push(savedTab);
    savedTabIdByBrowserTabId[String(snapshot.browserTabId)] = savedTab.id;
  }

  const removedIds = new Set(
    [...previousIds].filter((savedTabId) => !currentIds.has(savedTabId)),
  );
  const preservedTabs = group.tabs.filter(
    (tab) => !currentIds.has(tab.id) && !removedIds.has(tab.id),
  );

  group.tabs = [...snapshotTabs, ...preservedTabs];
  group.grouped = true;
  if (metadata?.title !== undefined) {
    const requestedTitle =
      normalizeGroupTitle(metadata.title) || getDefaultGroupTitle(group.tabs.length);
    group.title = reserveTimestampedGroupTitle(
      requestedTitle,
      collectGroupedTitles(sessions, group.id),
      now,
    );
  }
  if (metadata?.color !== undefined) group.color = metadata.color;
  await writeSessions(sessions);

  return {
    active: true,
    savedTabIdByBrowserTabId,
    groupTitle: getSavedGroupTitle(group),
  };
}

export async function deduplicateGroup(
  sessionId: string,
  groupId: string,
): Promise<number> {
  const sessions = await getSessions();
  const session = requireSession(sessions, sessionId);
  if (session.locked) {
    throw new Error('保存记录已锁定，无法移除其中的重复项');
  }
  const group = requireGroup(session, groupId);
  if (group.locked) throw new Error('分组已锁定，无法移除重复项');

  const seen = new Set<string>();
  const uniqueTabs: SavedTab[] = [];
  for (const tab of group.tabs) {
    let key = tab.url;
    try {
      key = new URL(tab.url).href;
    } catch {
      // Preserve unparsable URLs exactly as stored.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTabs.push(tab);
  }

  const removedTabs = group.tabs.length - uniqueTabs.length;
  if (removedTabs > 0) {
    group.tabs = uniqueTabs;
    await writeSessions(sessions);
  }
  return removedTabs;
}
