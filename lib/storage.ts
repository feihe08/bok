import { browser } from 'wxt/browser';
import type {
  DirectoryPath,
  SavedGroup,
  SavedGroupColor,
  SavedGroupTaskStatus,
  SavedSession,
  SavedTab,
} from './types';

const SESSIONS_KEY = 'sessions';
const SESSIONS_RECOVERY_KEY = 'sessionsRecovery';

export const STORAGE_SCHEMA_VERSION = 1;

interface StoredEnvelope {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  revision: number;
  sessions: unknown[];
}

interface ParsedStore {
  sourceSchemaVersion: number;
  revision: number;
  sessions: unknown[];
}

interface RecoveryEntry {
  fingerprint: string;
  capturedAt: number;
  sourceSchemaVersion: number;
  sourceIndex: number | null;
  issues: string[];
  raw: unknown;
}

export interface SessionsReadResult {
  sessions: SavedSession[];
  recoveryEntryCount: number;
}

type StoredTab = Omit<
  SavedTab,
  | 'archivedAt'
  | 'createdAt'
  | 'directory'
  | 'tags'
  | 'taskStatus'
  | 'taskCompletedAt'
> & {
  /** Legacy records used a "/"-separated string and omitted this field. */
  directory?: string | DirectoryPath | null;
  tags?: unknown;
  archivedAt?: unknown;
  createdAt?: unknown;
  taskStatus?: unknown;
  taskCompletedAt?: unknown;
};

type StoredGroup = Omit<
  SavedGroup,
  | 'archivedAt'
  | 'color'
  | 'createdAt'
  | 'locked'
  | 'pinned'
  | 'taskStatus'
  | 'taskCompletedAt'
  | 'tabs'
> & {
  archivedAt?: unknown;
  color?: unknown;
  createdAt?: unknown;
  locked?: unknown;
  pinned?: unknown;
  taskStatus?: unknown;
  taskCompletedAt?: unknown;
  /** Legacy field used before task state became opt-in. */
  status?: unknown;
  tabs: StoredTab[];
};

type StoredSession = Omit<SavedSession, 'groups'> & {
  groups: StoredGroup[];
};

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];

  return [
    ...new Set(
      tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeDirectory(directory: StoredTab['directory']): DirectoryPath | null {
  const values =
    typeof directory === 'string'
      ? directory.split('/')
      : Array.isArray(directory)
        ? directory
        : [];
  const segments = values
    .filter((segment): segment is string => typeof segment === 'string')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const [first, ...rest] = segments;

  return first ? [first, ...rest] : null;
}

const SAVED_GROUP_COLORS = new Set<SavedGroupColor>([
  'blue',
  'cyan',
  'green',
  'grey',
  'orange',
  'pink',
  'purple',
  'red',
  'yellow',
]);

function normalizeGroupColor(color: unknown): SavedGroupColor | undefined {
  return typeof color === 'string' && SAVED_GROUP_COLORS.has(color as SavedGroupColor)
    ? (color as SavedGroupColor)
    : undefined;
}

function normalizeArchivedAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeCreatedAt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const SAVED_GROUP_TASK_STATUSES = new Set<SavedGroupTaskStatus>([
  'todo',
  'doing',
  'done',
]);

function normalizeTaskStatus(
  taskStatus: unknown,
  legacyStatus?: unknown,
): SavedGroupTaskStatus | null {
  if (
    typeof taskStatus === 'string' &&
    SAVED_GROUP_TASK_STATUSES.has(taskStatus as SavedGroupTaskStatus)
  ) {
    return taskStatus as SavedGroupTaskStatus;
  }

  if (legacyStatus === 'in-progress') return 'doing';
  if (legacyStatus === 'completed') return 'done';
  return null;
}

function normalizeTaskCompletedAt(
  taskCompletedAt: unknown,
  taskStatus: SavedGroupTaskStatus | null,
): number | null {
  return taskStatus === 'done' ? normalizeArchivedAt(taskCompletedAt) : null;
}

function normalizeSession(session: StoredSession): SavedSession {
  return {
    ...session,
    groups: session.groups.map(({ status, taskStatus, taskCompletedAt, ...group }) => {
      const createdAt = normalizeCreatedAt(group.createdAt, session.createdAt);
      const normalizedTaskStatus = normalizeTaskStatus(taskStatus, status);
      return {
        ...group,
        title: typeof group.title === 'string' ? group.title : '',
        createdAt,
        archivedAt: normalizeArchivedAt(group.archivedAt),
        color: normalizeGroupColor(group.color),
        locked: group.locked === true,
        grouped: group.grouped === true || normalizedTaskStatus !== null,
        pinned: group.pinned === true,
        taskStatus: normalizedTaskStatus,
        taskCompletedAt: normalizeTaskCompletedAt(
          taskCompletedAt,
          normalizedTaskStatus,
        ),
        tabs: group.tabs.map(({ taskStatus, taskCompletedAt, ...tab }) => {
          const normalizedTabTaskStatus = normalizeTaskStatus(taskStatus);
          const tabCreatedAt = normalizeCreatedAt(tab.createdAt, createdAt);
          return {
            ...tab,
            title:
              typeof tab.title === 'string' && tab.title.trim()
                ? tab.title
                : tab.url,
            favIconUrl:
              typeof tab.favIconUrl === 'string' ? tab.favIconUrl : undefined,
            createdAt: tabCreatedAt,
            updatedAt: normalizeCreatedAt(tab.updatedAt, tabCreatedAt),
            archivedAt: normalizeArchivedAt(tab.archivedAt),
            tags: normalizeTags(tab.tags),
            directory: normalizeDirectory(tab.directory),
            taskStatus: normalizedTabTaskStatus,
            taskCompletedAt: normalizeTaskCompletedAt(
              taskCompletedAt,
              normalizedTabTaskStatus,
            ),
          };
        }),
      };
    }),
  };
}

class UnsupportedStorageSchemaError extends Error {}

class InvalidStorageEnvelopeError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isTaskStatusValue(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      SAVED_GROUP_TASK_STATUSES.has(value as SavedGroupTaskStatus))
  );
}

function isDirectoryValue(value: unknown): boolean {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every((segment) => isNonEmptyString(segment)))
  );
}

function parseStoredEnvelope(raw: unknown): ParsedStore {
  if (raw === undefined) {
    return { sourceSchemaVersion: 0, revision: 0, sessions: [] };
  }
  if (Array.isArray(raw)) {
    return { sourceSchemaVersion: 0, revision: 0, sessions: raw };
  }
  if (!isRecord(raw)) {
    throw new InvalidStorageEnvelopeError('保存数据的顶层结构无效');
  }

  const schemaVersion = raw.schemaVersion;
  if (
    typeof schemaVersion === 'number' &&
    Number.isInteger(schemaVersion) &&
    schemaVersion > STORAGE_SCHEMA_VERSION
  ) {
    throw new UnsupportedStorageSchemaError(
      `Bok 数据来自更新版本（v${schemaVersion}），当前版本只支持 v${STORAGE_SCHEMA_VERSION}。为避免覆盖数据，已停止读写。`,
    );
  }
  if (
    schemaVersion !== STORAGE_SCHEMA_VERSION ||
    !Number.isInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !Array.isArray(raw.sessions)
  ) {
    throw new InvalidStorageEnvelopeError('保存数据的版本或顶层结构无效');
  }

  return {
    sourceSchemaVersion: schemaVersion,
    revision: raw.revision as number,
    sessions: raw.sessions,
  };
}

function validateV1Session(value: Record<string, unknown>, prefix: string): string[] {
  const issues: string[] = [];
  if (!isFiniteNumber(value.createdAt)) issues.push(`${prefix}.createdAt 无效`);

  const groups = value.groups;
  if (!Array.isArray(groups)) return [...issues, `${prefix}.groups 必须是数组`];

  for (const [groupIndex, groupValue] of groups.entries()) {
    const groupPrefix = `${prefix}.groups[${groupIndex}]`;
    if (!isRecord(groupValue)) {
      issues.push(`${groupPrefix} 必须是对象`);
      continue;
    }
    if (!isNonEmptyString(groupValue.id)) issues.push(`${groupPrefix}.id 无效`);
    if (typeof groupValue.title !== 'string') issues.push(`${groupPrefix}.title 无效`);
    if (!isFiniteNumber(groupValue.createdAt)) issues.push(`${groupPrefix}.createdAt 无效`);
    if (typeof groupValue.grouped !== 'boolean') issues.push(`${groupPrefix}.grouped 无效`);
    if (typeof groupValue.locked !== 'boolean') issues.push(`${groupPrefix}.locked 无效`);
    if (typeof groupValue.pinned !== 'boolean') issues.push(`${groupPrefix}.pinned 无效`);
    if (!isNullableFiniteNumber(groupValue.archivedAt)) {
      issues.push(`${groupPrefix}.archivedAt 无效`);
    }
    if (!isTaskStatusValue(groupValue.taskStatus)) {
      issues.push(`${groupPrefix}.taskStatus 无效`);
    }
    if (!isNullableFiniteNumber(groupValue.taskCompletedAt)) {
      issues.push(`${groupPrefix}.taskCompletedAt 无效`);
    }
    if (
      groupValue.color !== undefined &&
      normalizeGroupColor(groupValue.color) === undefined
    ) {
      issues.push(`${groupPrefix}.color 无效`);
    }

    const tabs = groupValue.tabs;
    if (!Array.isArray(tabs)) {
      issues.push(`${groupPrefix}.tabs 必须是数组`);
      continue;
    }
    for (const [tabIndex, tabValue] of tabs.entries()) {
      const tabPrefix = `${groupPrefix}.tabs[${tabIndex}]`;
      if (!isRecord(tabValue)) {
        issues.push(`${tabPrefix} 必须是对象`);
        continue;
      }
      if (!isNonEmptyString(tabValue.id)) issues.push(`${tabPrefix}.id 无效`);
      if (!isNonEmptyString(tabValue.url)) issues.push(`${tabPrefix}.url 无效`);
      if (typeof tabValue.title !== 'string') issues.push(`${tabPrefix}.title 无效`);
      if (!isFiniteNumber(tabValue.createdAt)) issues.push(`${tabPrefix}.createdAt 无效`);
      if (!isFiniteNumber(tabValue.updatedAt)) issues.push(`${tabPrefix}.updatedAt 无效`);
      if (
        tabValue.favIconUrl !== undefined &&
        typeof tabValue.favIconUrl !== 'string'
      ) {
        issues.push(`${tabPrefix}.favIconUrl 无效`);
      }
      if (
        !Array.isArray(tabValue.tags) ||
        !tabValue.tags.every((tag) => typeof tag === 'string')
      ) {
        issues.push(`${tabPrefix}.tags 无效`);
      }
      if (!isDirectoryValue(tabValue.directory)) {
        issues.push(`${tabPrefix}.directory 无效`);
      }
      if (!isTaskStatusValue(tabValue.taskStatus)) {
        issues.push(`${tabPrefix}.taskStatus 无效`);
      }
      if (!isNullableFiniteNumber(tabValue.taskCompletedAt)) {
        issues.push(`${tabPrefix}.taskCompletedAt 无效`);
      }
      if (!isNullableFiniteNumber(tabValue.archivedAt)) {
        issues.push(`${tabPrefix}.archivedAt 无效`);
      }
    }
  }
  return issues;
}

function validateStoredSessions(store: ParsedStore): {
  sessions: StoredSession[];
  recoveries: Array<Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>>;
} {
  const sessions: StoredSession[] = [];
  const recoveries: Array<Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>> = [];
  const sessionIds = new Set<string>();
  const groupIds = new Set<string>();
  const tabIds = new Set<string>();

  for (const [sessionIndex, value] of store.sessions.entries()) {
    const prefix = `sessions[${sessionIndex}]`;
    const issues: string[] = [];
    const localGroupIds = new Set<string>();
    const localTabIds = new Set<string>();

    if (!isRecord(value)) {
      issues.push(`${prefix} 必须是对象`);
    } else {
      if (!isNonEmptyString(value.id)) issues.push(`${prefix}.id 无效`);
      if (!isFiniteNumber(value.createdAt)) issues.push(`${prefix}.createdAt 无效`);
      if (!Array.isArray(value.groups)) {
        issues.push(`${prefix}.groups 必须是数组`);
      } else {
        for (const [groupIndex, groupValue] of value.groups.entries()) {
          const groupPrefix = `${prefix}.groups[${groupIndex}]`;
          if (!isRecord(groupValue)) {
            issues.push(`${groupPrefix} 必须是对象`);
            continue;
          }
          if (!isNonEmptyString(groupValue.id)) {
            issues.push(`${groupPrefix}.id 无效`);
          } else if (
            localGroupIds.has(groupValue.id) ||
            groupIds.has(groupValue.id)
          ) {
            issues.push(`${groupPrefix}.id 重复`);
          } else {
            localGroupIds.add(groupValue.id);
          }
          if (!Array.isArray(groupValue.tabs)) {
            issues.push(`${groupPrefix}.tabs 必须是数组`);
            continue;
          }
          for (const [tabIndex, tabValue] of groupValue.tabs.entries()) {
            const tabPrefix = `${groupPrefix}.tabs[${tabIndex}]`;
            if (!isRecord(tabValue)) {
              issues.push(`${tabPrefix} 必须是对象`);
              continue;
            }
            if (!isNonEmptyString(tabValue.id)) {
              issues.push(`${tabPrefix}.id 无效`);
            } else if (localTabIds.has(tabValue.id) || tabIds.has(tabValue.id)) {
              issues.push(`${tabPrefix}.id 重复`);
            } else {
              localTabIds.add(tabValue.id);
            }
            if (!isNonEmptyString(tabValue.url)) issues.push(`${tabPrefix}.url 无效`);
          }
        }
      }

      if (store.sourceSchemaVersion === STORAGE_SCHEMA_VERSION) {
        issues.push(...validateV1Session(value, prefix));
      }
      if (isNonEmptyString(value.id) && sessionIds.has(value.id)) {
        issues.push(`${prefix}.id 重复`);
      }
    }

    if (issues.length > 0 || !isRecord(value)) {
      recoveries.push({
        sourceSchemaVersion: store.sourceSchemaVersion,
        sourceIndex: sessionIndex,
        issues: [...new Set(issues)],
        raw: value,
      });
      continue;
    }

    const session = value as unknown as StoredSession;
    sessions.push(session);
    sessionIds.add(session.id);
    for (const groupId of localGroupIds) groupIds.add(groupId);
    for (const tabId of localTabIds) tabIds.add(tabId);
  }

  return { sessions, recoveries };
}

function recoveryFingerprint(entry: Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>): string {
  const serialized = JSON.stringify({
    sourceSchemaVersion: entry.sourceSchemaVersion,
    sourceIndex: entry.sourceIndex,
    raw: entry.raw,
  });
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${serialized.length}:${(hash >>> 0).toString(16)}`;
}

async function saveRecoveryEntries(
  entries: Array<Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>>,
): Promise<number> {
  const stored = await browser.storage.local.get(SESSIONS_RECOVERY_KEY);
  const existingValue = stored[SESSIONS_RECOVERY_KEY];
  const existing = Array.isArray(existingValue)
    ? existingValue.filter(
        (entry): entry is RecoveryEntry =>
          isRecord(entry) && typeof entry.fingerprint === 'string',
      )
    : [];
  const fingerprints = new Set(existing.map((entry) => entry.fingerprint));
  const capturedAt = Date.now();
  const additions = entries.flatMap((entry) => {
    const fingerprint = recoveryFingerprint(entry);
    if (fingerprints.has(fingerprint)) return [];
    fingerprints.add(fingerprint);
    return [{ ...entry, fingerprint, capturedAt }];
  });
  if (additions.length > 0) {
    await browser.storage.local.set({
      [SESSIONS_RECOVERY_KEY]: [...existing, ...additions],
    });
  }
  return existing.length + additions.length;
}

async function readStoredSessions(): Promise<{
  store: ParsedStore;
  sessions: StoredSession[];
  recoveryEntryCount: number;
}> {
  const stored = await browser.storage.local.get(SESSIONS_KEY);
  const raw = stored[SESSIONS_KEY];
  let store: ParsedStore;
  try {
    store = parseStoredEnvelope(raw);
  } catch (error) {
    if (error instanceof UnsupportedStorageSchemaError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await saveRecoveryEntries([
      {
        sourceSchemaVersion: -1,
        sourceIndex: null,
        issues: [message],
        raw,
      },
    ]);
    throw new Error(`${message}，已保留原始恢复副本`);
  }

  const validated = validateStoredSessions(store);
  const recoveryEntryCount = await saveRecoveryEntries(validated.recoveries);
  return {
    store,
    sessions: validated.sessions,
    recoveryEntryCount,
  };
}

/** Sessions, newest first, with damaged sessions isolated into recovery storage. */
export async function readSessions(): Promise<SessionsReadResult> {
  const stored = await readStoredSessions();
  return {
    sessions: stored.sessions.map(normalizeSession),
    recoveryEntryCount: stored.recoveryEntryCount,
  };
}

export async function getSessions(): Promise<SavedSession[]> {
  return (await readSessions()).sessions;
}

async function setSessions(sessions: SavedSession[]): Promise<void> {
  const current = await readStoredSessions();
  const envelope: StoredEnvelope = {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    revision: current.store.revision + 1,
    sessions,
  };
  await browser.storage.local.set({ [SESSIONS_KEY]: envelope });
}

function requireSession(
  sessions: SavedSession[],
  sessionId: string,
): SavedSession {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error('找不到要操作的保存记录');
  return session;
}

function requireGroup(session: SavedSession, groupId: string): SavedGroup {
  const group = session.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error('找不到要操作的标签组');
  return group;
}

function requireTab(group: SavedGroup, tabId: string): SavedTab {
  const tab = group.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error('找不到要操作的标签页');
  return tab;
}

export async function addSession(session: SavedSession): Promise<void> {
  const sessions = await getSessions();
  await setSessions([session, ...sessions]);
}

export async function getSavedGroup(
  sessionId: string,
  groupId: string,
): Promise<SavedGroup> {
  const sessions = await getSessions();
  return requireGroup(requireSession(sessions, sessionId), groupId);
}

export async function removeSession(sessionId: string): Promise<void> {
  const sessions = await getSessions();
  const targetSession = sessions.find((session) => session.id === sessionId);
  if (!targetSession) throw new Error('找不到要删除的保存记录');
  if (targetSession.groups.some((group) => group.locked)) {
    throw new Error('保存记录中包含已锁定的标签组，无法删除');
  }
  await setSessions(sessions.filter((s) => s.id !== sessionId));
}

/** Drop one tab, cleaning up any group or session left empty. */
export async function removeTab(sessionId: string, tabId: string): Promise<void> {
  const sessions = await getSessions();
  const targetSession = requireSession(sessions, sessionId);

  const targetGroup = targetSession.groups.find((group) =>
    group.tabs.some((tab) => tab.id === tabId),
  );
  if (!targetGroup) throw new Error('找不到要删除的标签页');
  if (targetGroup.locked) {
    throw new Error('标签组已锁定，无法删除其中的标签页');
  }
  const next: SavedSession[] = [];

  for (const session of sessions) {
    if (session.id !== sessionId) {
      next.push(session);
      continue;
    }
    const groups = session.groups
      .map((g) => ({ ...g, tabs: g.tabs.filter((t) => t.id !== tabId) }))
      .filter((g) => g.tabs.length > 0);
    if (groups.length > 0) next.push({ ...session, groups });
  }

  await setSessions(next);
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
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  const tab = requireTab(group, tabId);
  tab.title = normalizedTitle;
  tab.updatedAt = Date.now();
  await setSessions(sessions);
}

/** Drop one group, dropping the session too if it becomes empty. */
export async function removeGroup(sessionId: string, groupId: string): Promise<void> {
  const sessions = await getSessions();
  const targetSession = requireSession(sessions, sessionId);
  const targetGroup = requireGroup(targetSession, groupId);
  if (targetGroup.locked) {
    throw new Error('标签组已锁定，无法删除');
  }
  const next: SavedSession[] = [];

  for (const session of sessions) {
    if (session.id !== sessionId) {
      next.push(session);
      continue;
    }
    const groups = session.groups.filter((g) => g.id !== groupId);
    if (groups.length > 0) next.push({ ...session, groups });
  }

  await setSessions(next);
}

export async function renameGroup(
  sessionId: string,
  groupId: string,
  title: string,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  group.title = title.trim();
  await setSessions(sessions);
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
  }
  await setSessions(sessions);
}

export async function setGroupLocked(
  sessionId: string,
  groupId: string,
  locked: boolean,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  group.locked = locked;
  await setSessions(sessions);
}

export async function setGroupPinned(
  sessionId: string,
  groupId: string,
  pinned: boolean,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  if (pinned && group.archivedAt !== null) {
    throw new Error('已归档的标签组不能固定，请先恢复');
  }
  group.pinned = pinned;
  await setSessions(sessions);
}

const AUTO_ARCHIVE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

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

export async function archiveEligibleGroups(now = Date.now()): Promise<number> {
  const sessions = await getSessions();
  let archivedGroups = 0;

  for (const session of sessions) {
    for (const group of session.groups) {
      if (!canAutoArchiveGroup(group, now)) continue;
      group.archivedAt = now;
      archivedGroups += 1;
    }
  }

  if (archivedGroups > 0) await setSessions(sessions);
  return archivedGroups;
}

export async function setGroupTaskStatus(
  sessionId: string,
  groupId: string,
  taskStatus: SavedGroupTaskStatus | null,
): Promise<void> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  const now = Date.now();

  if (group.taskStatus === null) {
    if (taskStatus === null) return;
    group.taskStatus = 'doing';
    group.taskCompletedAt = null;
    group.grouped = true;
  } else {
    if (group.taskStatus === taskStatus) return;
    group.taskStatus = taskStatus;
    group.taskCompletedAt = taskStatus === 'done' ? now : null;
  }
  await setSessions(sessions);
}

export async function setTabTaskStatus(
  sessionId: string,
  groupId: string,
  tabId: string,
  taskStatus: SavedGroupTaskStatus | null,
): Promise<void> {
  const sessions = await getSessions();
  const tab = requireTab(requireGroup(requireSession(sessions, sessionId), groupId), tabId);
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
  await setSessions(sessions);
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
): Promise<{ active: boolean; savedTabIdByBrowserTabId: Record<string, string> }> {
  const sessions = await getSessions();
  if (!canCommit()) {
    return { active: false, savedTabIdByBrowserTabId: {} };
  }
  const session = sessions.find((candidate) => candidate.id === sessionId);
  const group = session?.groups.find((candidate) => candidate.id === groupId);
  if (!group || group.taskStatus === null) {
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
  if (metadata?.title !== undefined) group.title = metadata.title;
  if (metadata?.color !== undefined) group.color = metadata.color;
  await setSessions(sessions);

  return { active: true, savedTabIdByBrowserTabId };
}

export async function deduplicateGroup(
  sessionId: string,
  groupId: string,
): Promise<number> {
  const sessions = await getSessions();
  const group = requireGroup(requireSession(sessions, sessionId), groupId);
  if (group.locked) throw new Error('标签组已锁定，无法移除重复项');

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
    await setSessions(sessions);
  }
  return removedTabs;
}
