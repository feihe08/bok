import { browser } from 'wxt/browser';
import { archiveEligibleGroupsInMemory } from './auto-archive.ts';
import { mergeImportedSessions } from './session-import.ts';
import type {
  DirectoryPath,
  SavedGroup,
  SavedGroupColor,
  SavedGroupTaskStatus,
  SavedSession,
  SavedSessionItem,
  SavedSessionState,
  SavedTab,
} from './model.ts';
import { createItemsSession, getStandaloneGroupId } from './session-items.ts';
import { getSavedPagesAutoArchivePeriod } from './settings.ts';
const SESSIONS_KEY = 'sessions';
const SESSIONS_RECOVERY_KEY = 'sessionsRecovery';
const SESSIONS_IMPORT_BACKUP_KEY = 'sessionsImportBackup';
export const SESSIONS_PRE_V3_SNAPSHOT_KEY = 'sessionsPreV3Snapshot';
export const STORAGE_SCHEMA_VERSION = 3;
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
interface StoredSession {
    id: string;
    createdAt: number;
    groups: StoredGroup[];
}
interface StoredV2Session {
    id: string;
    createdAt: number;
    items?: unknown;
    legacyGroups?: unknown;
}
interface StoredV3Session {
    id: string;
    createdAt: number;
    title: string;
    locked: boolean;
    pinned: boolean;
    restoredAt: number | null;
    archivedAt: number | null;
    taskStatus: SavedGroupTaskStatus | null;
    taskCompletedAt: number | null;
    items: unknown;
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
export interface ImportSessionsResult {
    kind: 'saved-pages';
    importedSessions: number;
    importedGroups: number;
    importedTabs: number;
    skippedDuplicateGroups: number;
    renamedGroups: number;
    archivedSessions: number;
    archivedGroups: number;
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
  | 'restoredAt'
  | 'taskStatus'
  | 'taskCompletedAt'
  | 'tabs'
> & {
    archivedAt?: unknown;
    color?: unknown;
    createdAt?: unknown;
    locked?: unknown;
    pinned?: unknown;
    restoredAt?: unknown;
    taskStatus?: unknown;
    taskCompletedAt?: unknown;
    status?: unknown;
    tabs: StoredTab[];
};
type LegacyNormalizedGroup = Omit<SavedGroup, 'grouped'> & { grouped: boolean };
type LegacySessionItem =
  | { type: 'tab'; tab: SavedTab }
  | { type: 'group'; group: LegacyNormalizedGroup };
interface NormalizedSourceSession extends SavedSessionState {
  id: string;
  createdAt: number;
  items: LegacySessionItem[];
}
const SAVED_GROUP_COLORS = new Set<SavedGroupColor>([
  'blue', 'cyan', 'green', 'grey', 'orange', 'pink', 'purple', 'red', 'yellow',
]);
const SAVED_GROUP_TASK_STATUSES = new Set<SavedGroupTaskStatus>([
  'todo', 'doing', 'done',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNullableFiniteNumber = (value: unknown): boolean =>
  value === null || isFiniteNumber(value);
const isTaskStatusValue = (value: unknown): boolean =>
  value === null ||
  (typeof value === 'string' &&
    SAVED_GROUP_TASK_STATUSES.has(value as SavedGroupTaskStatus));
const isDirectoryValue = (value: unknown): boolean =>
  value === null ||
  (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString));

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return [...new Set(
    tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean),
  )];
}

function normalizeDirectory(directory: StoredTab['directory']): DirectoryPath | null {
  const values = typeof directory === 'string'
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

const normalizeNullableTimestamp = (value: unknown): number | null =>
  isFiniteNumber(value) ? value : null;
const normalizeCreatedAt = (value: unknown, fallback: number): number =>
  isFiniteNumber(value) ? value : fallback;
const normalizeGroupColor = (color: unknown): SavedGroupColor | undefined =>
  typeof color === 'string' && SAVED_GROUP_COLORS.has(color as SavedGroupColor)
    ? color as SavedGroupColor
    : undefined;

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

const normalizeTaskCompletedAt = (
  value: unknown,
  status: SavedGroupTaskStatus | null,
): number | null => status === 'done' ? normalizeNullableTimestamp(value) : null;

function normalizeTab(value: StoredTab, fallbackCreatedAt: number): SavedTab {
  const { taskStatus, taskCompletedAt, ...tab } = value;
  const status = normalizeTaskStatus(taskStatus);
  const createdAt = normalizeCreatedAt(tab.createdAt, fallbackCreatedAt);
  return {
    ...tab,
    title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : tab.url,
    favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : undefined,
    createdAt,
    updatedAt: normalizeCreatedAt(tab.updatedAt, createdAt),
    archivedAt: normalizeNullableTimestamp(tab.archivedAt),
    tags: normalizeTags(tab.tags),
    directory: normalizeDirectory(tab.directory),
    taskStatus: status,
    taskCompletedAt: normalizeTaskCompletedAt(taskCompletedAt, status),
  };
}

function normalizeGroup(
  value: StoredGroup,
  fallbackCreatedAt: number,
): LegacyNormalizedGroup {
  const { status, taskStatus, taskCompletedAt, ...group } = value;
  const createdAt = normalizeCreatedAt(group.createdAt, fallbackCreatedAt);
  const task = normalizeTaskStatus(taskStatus, status);
  return {
    ...group,
    title: typeof group.title === 'string' ? group.title : '',
    createdAt,
    archivedAt: normalizeNullableTimestamp(group.archivedAt),
    color: normalizeGroupColor(group.color),
    locked: group.locked === true,
    grouped: group.grouped === true,
    pinned: group.pinned === true,
    restoredAt: normalizeNullableTimestamp(group.restoredAt),
    taskStatus: task,
    taskCompletedAt: normalizeTaskCompletedAt(taskCompletedAt, task),
    tabs: group.tabs.map((tab) => normalizeTab(tab, createdAt)),
  };
}

function sessionState(value: Record<string, unknown>): SavedSessionState {
  const taskStatus = normalizeTaskStatus(value.taskStatus);
  return {
    title: typeof value.title === 'string' ? value.title : '',
    locked: value.locked === true,
    pinned: value.pinned === true,
    restoredAt: normalizeNullableTimestamp(value.restoredAt),
    archivedAt: normalizeNullableTimestamp(value.archivedAt),
    taskStatus,
    taskCompletedAt: normalizeTaskCompletedAt(value.taskCompletedAt, taskStatus),
  };
}

function stateFromOrdinaryGroup(
  group: LegacyNormalizedGroup,
): SavedSessionState {
  return {
    title: group.title,
    locked: group.locked,
    pinned: group.pinned,
    restoredAt: group.restoredAt,
    archivedAt: group.archivedAt,
    taskStatus: group.taskStatus,
    taskCompletedAt: group.taskCompletedAt,
  };
}
class UnsupportedStorageSchemaError extends Error {
}
class InvalidStorageEnvelopeError extends Error {
}
function parseStoredEnvelope(raw: unknown): ParsedStore {
  if (raw === undefined || Array.isArray(raw)) {
    return { sourceSchemaVersion: 0, revision: 0, sessions: raw ?? [] };
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
    (schemaVersion !== 1 &&
      schemaVersion !== 2 &&
      schemaVersion !== STORAGE_SCHEMA_VERSION) ||
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

function validateTab(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) return [`${prefix} 必须是对象`];
  const issues: string[] = [];
  if (!isNonEmptyString(value.id)) issues.push(`${prefix}.id 无效`);
  if (!isNonEmptyString(value.url)) issues.push(`${prefix}.url 无效`);
  if (typeof value.title !== 'string') issues.push(`${prefix}.title 无效`);
  if (!isFiniteNumber(value.createdAt)) issues.push(`${prefix}.createdAt 无效`);
  if (!isFiniteNumber(value.updatedAt)) issues.push(`${prefix}.updatedAt 无效`);
  if (value.favIconUrl !== undefined && typeof value.favIconUrl !== 'string') {
    issues.push(`${prefix}.favIconUrl 无效`);
  }
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string')) {
    issues.push(`${prefix}.tags 无效`);
  }
  if (!isDirectoryValue(value.directory)) issues.push(`${prefix}.directory 无效`);
  if (!isTaskStatusValue(value.taskStatus)) issues.push(`${prefix}.taskStatus 无效`);
  if (!isNullableFiniteNumber(value.taskCompletedAt)) {
    issues.push(`${prefix}.taskCompletedAt 无效`);
  }
  if (!isNullableFiniteNumber(value.archivedAt)) issues.push(`${prefix}.archivedAt 无效`);
  return issues;
}

function validateGroup(
  value: unknown,
  prefix: string,
  requireGrouped: boolean,
): string[] {
  if (!isRecord(value)) return [`${prefix} 必须是对象`];
  const issues: string[] = [];
  if (!isNonEmptyString(value.id)) issues.push(`${prefix}.id 无效`);
  if (typeof value.title !== 'string') issues.push(`${prefix}.title 无效`);
  if (!isFiniteNumber(value.createdAt)) issues.push(`${prefix}.createdAt 无效`);
  if (typeof value.grouped !== 'boolean') issues.push(`${prefix}.grouped 无效`);
  if (requireGrouped && value.grouped !== true) {
    issues.push(`${prefix}.grouped 必须为 true`);
  }
  if (typeof value.locked !== 'boolean') issues.push(`${prefix}.locked 无效`);
  if (typeof value.pinned !== 'boolean') issues.push(`${prefix}.pinned 无效`);
  if (value.restoredAt !== undefined && !isNullableFiniteNumber(value.restoredAt)) {
    issues.push(`${prefix}.restoredAt 无效`);
  }
  if (!isNullableFiniteNumber(value.archivedAt)) issues.push(`${prefix}.archivedAt 无效`);
  if (!isTaskStatusValue(value.taskStatus)) issues.push(`${prefix}.taskStatus 无效`);
  if (!isNullableFiniteNumber(value.taskCompletedAt)) {
    issues.push(`${prefix}.taskCompletedAt 无效`);
  }
  if (value.color !== undefined && normalizeGroupColor(value.color) === undefined) {
    issues.push(`${prefix}.color 无效`);
  }
  if (!Array.isArray(value.tabs)) return [...issues, `${prefix}.tabs 必须是数组`];
  value.tabs.forEach((tab, index) => {
    issues.push(...validateTab(tab, `${prefix}.tabs[${index}]`));
  });
  return issues;
}

function validateLegacySession(value: Record<string, unknown>, prefix: string): string[] {
  if (!Array.isArray(value.groups)) return [`${prefix}.groups 必须是数组`];
  return value.groups.flatMap((group, index) =>
    validateGroup(group, `${prefix}.groups[${index}]`, false),
  );
}

function validateV0Session(value: Record<string, unknown>, prefix: string): string[] {
  if (!Array.isArray(value.groups)) return [`${prefix}.groups 必须是数组`];
  const issues: string[] = [];
  value.groups.forEach((group, groupIndex) => {
    const groupPrefix = `${prefix}.groups[${groupIndex}]`;
    if (!isRecord(group)) {
      issues.push(`${groupPrefix} 必须是对象`);
      return;
    }
    if (!isNonEmptyString(group.id)) issues.push(`${groupPrefix}.id 无效`);
    if (!Array.isArray(group.tabs)) {
      issues.push(`${groupPrefix}.tabs 必须是数组`);
      return;
    }
    group.tabs.forEach((tab, tabIndex) => {
      const tabPrefix = `${groupPrefix}.tabs[${tabIndex}]`;
      if (!isRecord(tab)) {
        issues.push(`${tabPrefix} 必须是对象`);
        return;
      }
      if (!isNonEmptyString(tab.id)) issues.push(`${tabPrefix}.id 无效`);
      if (!isNonEmptyString(tab.url)) issues.push(`${tabPrefix}.url 无效`);
    });
  });
  return issues;
}

function validateV2Session(value: Record<string, unknown>, prefix: string): string[] {
  const hasItems = Array.isArray(value.items);
  const hasLegacyGroups = Array.isArray(value.legacyGroups);
  if (hasItems === hasLegacyGroups) return [`${prefix} 必须包含 items 或 legacyGroups`];
  if (hasLegacyGroups) {
    return validateLegacySession({ ...value, groups: value.legacyGroups }, prefix);
  }
  return (value.items as unknown[]).flatMap((item, index) => {
    const itemPrefix = `${prefix}.items[${index}]`;
    if (!isRecord(item) || (item.type !== 'tab' && item.type !== 'group')) {
      return [`${itemPrefix} 无效`];
    }
    return item.type === 'tab'
      ? validateTab(item.tab, `${itemPrefix}.tab`)
      : validateGroup(item.group, `${itemPrefix}.group`, false);
  });
}

function validateV3Session(value: Record<string, unknown>, prefix: string): string[] {
  const issues: string[] = [];
  if (typeof value.title !== 'string') issues.push(`${prefix}.title 无效`);
  if (typeof value.locked !== 'boolean') issues.push(`${prefix}.locked 无效`);
  if (typeof value.pinned !== 'boolean') issues.push(`${prefix}.pinned 无效`);
  if (!isNullableFiniteNumber(value.restoredAt)) issues.push(`${prefix}.restoredAt 无效`);
  if (!isNullableFiniteNumber(value.archivedAt)) issues.push(`${prefix}.archivedAt 无效`);
  if (!isTaskStatusValue(value.taskStatus)) issues.push(`${prefix}.taskStatus 无效`);
  if (!isNullableFiniteNumber(value.taskCompletedAt)) {
    issues.push(`${prefix}.taskCompletedAt 无效`);
  }
  if ('legacyGroups' in value) {
    issues.push(`${prefix}.legacyGroups 不受 v3 支持`);
  }
  if (!Array.isArray(value.items)) return [...issues, `${prefix}.items 必须是数组`];
  value.items.forEach((item, index) => {
    const itemPrefix = `${prefix}.items[${index}]`;
    if (!isRecord(item) || (item.type !== 'tab' && item.type !== 'group')) {
      issues.push(`${itemPrefix} 无效`);
    } else if (item.type === 'tab') {
      issues.push(...validateTab(item.tab, `${itemPrefix}.tab`));
    } else {
      issues.push(...validateGroup(item.group, `${itemPrefix}.group`, true));
    }
  });
  return issues;
}

function collectIds(value: Record<string, unknown>, schema: number): {
  groupIds: string[];
  tabIds: string[];
} {
  const entries = schema === 2 && Array.isArray(value.legacyGroups)
    ? value.legacyGroups
    : schema < 2
      ? Array.isArray(value.groups)
        ? value.groups
        : []
      : Array.isArray(value.items)
        ? value.items
        : [];
  const groupIds: string[] = [];
  const tabIds: string[] = [];
  for (const entry of entries) {
    const tab = schema >= 2 && isRecord(entry) && entry.type === 'tab'
      ? entry.tab
      : undefined;
    const group = schema >= 2 && isRecord(entry) && entry.type === 'group'
      ? entry.group
      : entry;
    if (isRecord(tab) && isNonEmptyString(tab.id)) {
      groupIds.push(getStandaloneGroupId(tab.id));
      tabIds.push(tab.id);
      continue;
    }
    if (!isRecord(group)) continue;
    if (isNonEmptyString(group.id)) groupIds.push(group.id);
    if (Array.isArray(group.tabs)) {
      for (const savedTab of group.tabs) {
        if (isRecord(savedTab) && isNonEmptyString(savedTab.id)) {
          tabIds.push(savedTab.id);
        }
      }
    }
  }
  return { groupIds, tabIds };
}
function normalizeV1Session(value: StoredSession): NormalizedSourceSession {
  return {
    ...sessionState(value as unknown as Record<string, unknown>),
    id: value.id,
    createdAt: value.createdAt,
    items: value.groups.map((group) => ({
      type: 'group' as const,
      group: normalizeGroup(group, value.createdAt),
    })),
  };
}

function normalizeV2Session(value: StoredV2Session): NormalizedSourceSession {
  const legacyGroups = Array.isArray(value.legacyGroups)
    ? value.legacyGroups as StoredGroup[]
    : null;
  const items = legacyGroups
    ? legacyGroups.map((group) => ({
        type: 'group' as const,
        group: normalizeGroup(group, value.createdAt),
      }))
    : (value.items as Array<Record<string, unknown>>).map((item) => {
        if (item.type === 'group') {
          return {
            type: 'group' as const,
            group: normalizeGroup(item.group as StoredGroup, value.createdAt),
          };
        }
        return {
          type: 'tab' as const,
          tab: normalizeTab(item.tab as StoredTab, value.createdAt),
        };
      });
  return {
    ...sessionState(value as unknown as Record<string, unknown>),
    id: value.id,
    createdAt: value.createdAt,
    items,
  };
}

function normalizeV3Session(value: StoredV3Session): NormalizedSourceSession {
  const items = (value.items as Array<Record<string, unknown>>).map((item) => {
    if (item.type === 'group') {
      return {
        type: 'group' as const,
        group: normalizeGroup(item.group as StoredGroup, value.createdAt),
      };
    }
    return {
      type: 'tab' as const,
      tab: normalizeTab(item.tab as StoredTab, value.createdAt),
    };
  });
  return {
    ...sessionState(value as unknown as Record<string, unknown>),
    id: value.id,
    createdAt: value.createdAt,
    items,
  };
}

function migrateSession(session: NormalizedSourceSession): SavedSession[] {
  const ordinary = session.items.filter(
    (item): item is { type: 'group'; group: LegacyNormalizedGroup } =>
      item.type === 'group' && !item.group.grouped,
  );
  const residual = session.items.flatMap((item) =>
    item.type === 'group' && !item.group.grouped ? [] : [item],
  );
  const savedResidual = residual.map((item) =>
    item.type === 'group'
      ? {
          type: 'group' as const,
          group: { ...item.group, grouped: true as const },
        }
      : item,
  );
  if (ordinary.length === 0) {
    return [createItemsSession(session.id, session.createdAt, savedResidual, session)];
  }
  const extracted = ordinary.map((item, index) =>
    createItemsSession(
      residual.length === 0 && index === 0 ? session.id : item.group.id,
      item.group.createdAt,
      item.group.tabs.map((tab) => ({ type: 'tab' as const, tab })),
      stateFromOrdinaryGroup(item.group),
    ),
  );
  return residual.length === 0
    ? extracted
    : [
        createItemsSession(session.id, session.createdAt, savedResidual, session),
        ...extracted,
      ];
}

function migrateSessions(sessions: NormalizedSourceSession[]): SavedSession[] {
  const migrated = sessions.flatMap(migrateSession);
  const usedIds = new Set<string>();
  for (const session of migrated) {
    usedIds.add(session.id);
    for (const item of session.items) {
      if (item.type === 'tab') {
        usedIds.add(item.tab.id);
      } else {
        usedIds.add(item.group.id);
        item.group.tabs.forEach((tab) => usedIds.add(tab.id));
      }
    }
  }
  for (const session of migrated) {
    session.items = session.items.map((item): SavedSessionItem => {
      if (item.type === 'group') return item;
      const standaloneId = getStandaloneGroupId(item.tab.id);
      if (!usedIds.has(standaloneId)) {
        usedIds.add(standaloneId);
        return item;
      }
      const originalId = item.tab.id;
      let suffix = 0;
      let id = `${originalId}:migrated`;
      while (usedIds.has(id) || usedIds.has(getStandaloneGroupId(id))) {
        suffix += 1;
        id = `${originalId}:migrated-${suffix}`;
      }
      usedIds.add(id);
      usedIds.add(getStandaloneGroupId(id));
      return { type: 'tab', tab: { ...item.tab, id } };
    });
  }
  return migrated;
}

function validateStoredSessions(store: ParsedStore): {
  sessions: NormalizedSourceSession[];
  recoveries: Array<Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>>;
} {
  const sessions: NormalizedSourceSession[] = [];
  const recoveries: Array<Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>> = [];
  const allIds = new Set<string>();

  for (const [index, raw] of store.sessions.entries()) {
    const prefix = `sessions[${index}]`;
    const issues: string[] = [];
    if (!isRecord(raw)) {
      issues.push(`${prefix} 必须是对象`);
    } else {
      if (!isNonEmptyString(raw.id)) issues.push(`${prefix}.id 无效`);
      if (!isFiniteNumber(raw.createdAt)) issues.push(`${prefix}.createdAt 无效`);
      if (store.sourceSchemaVersion === 0) {
        issues.push(...validateV0Session(raw, prefix));
      } else if (store.sourceSchemaVersion === 1) {
        issues.push(...validateLegacySession(raw, prefix));
      } else if (store.sourceSchemaVersion === 2) {
        issues.push(...validateV2Session(raw, prefix));
      } else {
        issues.push(...validateV3Session(raw, prefix));
      }

      const ids = collectIds(raw, store.sourceSchemaVersion);
      const localIds = new Set<string>();
      const idEntries: Array<[unknown, string]> = [
        [raw.id, `${prefix}.id`],
        ...ids.groupIds.map((id): [string, string] => [
          id,
          `${prefix}.group ID`,
        ]),
        ...ids.tabIds.map((id): [string, string] => [
          id,
          `${prefix}.tab ID`,
        ]),
      ];
      for (const [id, label] of idEntries) {
        if (!isNonEmptyString(id)) continue;
        if (localIds.has(id) || allIds.has(id)) {
          issues.push(`${label} 重复`);
        } else {
          localIds.add(id);
        }
      }

      if (issues.length === 0) {
        const normalized = store.sourceSchemaVersion < 2
          ? normalizeV1Session(raw as unknown as StoredSession)
          : store.sourceSchemaVersion === 2
            ? normalizeV2Session(raw as unknown as StoredV2Session)
            : normalizeV3Session(raw as unknown as StoredV3Session);
        sessions.push(normalized);
        localIds.forEach((id) => allIds.add(id));
        continue;
      }
    }
    recoveries.push({
      sourceSchemaVersion: store.sourceSchemaVersion,
      sourceIndex: index,
      issues: [...new Set(issues)],
      raw,
    });
  }
  return { sessions, recoveries };
}
function recoveryFingerprint(
  entry: Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>,
): string {
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
  const existing = Array.isArray(stored[SESSIONS_RECOVERY_KEY])
    ? stored[SESSIONS_RECOVERY_KEY].filter(
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
  raw: unknown;
  store: ParsedStore;
  sessions: SavedSession[];
  recoveryEntryCount: number;
}> {
  const raw = (await browser.storage.local.get(SESSIONS_KEY))[SESSIONS_KEY];
  let store: ParsedStore;
  try {
    store = parseStoredEnvelope(raw);
  } catch (error) {
    if (error instanceof UnsupportedStorageSchemaError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await saveRecoveryEntries([{
      sourceSchemaVersion: -1,
      sourceIndex: null,
      issues: [message],
      raw,
    }]);
    throw new Error(`${message}，已保留原始恢复副本`);
  }
  const validated = validateStoredSessions(store);
  return {
    raw,
    store,
    sessions: migrateSessions(validated.sessions),
    recoveryEntryCount: await saveRecoveryEntries(validated.recoveries),
  };
}

export async function readSessions(): Promise<SessionsReadResult> {
  const stored = await readStoredSessions();
  return {
    sessions: stored.sessions,
    recoveryEntryCount: stored.recoveryEntryCount,
  };
}

export async function getSessions(): Promise<SavedSession[]> {
  return (await readSessions()).sessions;
}

function toStoredSession(session: SavedSession): StoredV3Session {
  return {
    id: session.id,
    createdAt: session.createdAt,
    title: session.title,
    locked: session.locked,
    pinned: session.pinned,
    restoredAt: session.restoredAt,
    archivedAt: session.archivedAt,
    taskStatus: session.taskStatus,
    taskCompletedAt: session.taskCompletedAt,
    items: session.items,
  };
}

function createStoredEnvelope(
  revision: number,
  sessions: SavedSession[],
): StoredEnvelope {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    revision,
    sessions: sessions.map(toStoredSession),
  };
}

async function writeEnvelope(envelope: StoredEnvelope, previous: {
  raw: unknown;
  store: ParsedStore;
}): Promise<void> {
  if (previous.store.sourceSchemaVersion >= STORAGE_SCHEMA_VERSION) {
    await browser.storage.local.set({ [SESSIONS_KEY]: envelope });
    return;
  }
  const snapshot = await browser.storage.local.get(SESSIONS_PRE_V3_SNAPSHOT_KEY);
  await browser.storage.local.set({
    ...(previous.raw !== undefined &&
    snapshot[SESSIONS_PRE_V3_SNAPSHOT_KEY] === undefined
      ? { [SESSIONS_PRE_V3_SNAPSHOT_KEY]: previous.raw }
      : {}),
    [SESSIONS_KEY]: envelope,
  });
}

export async function exportSessionsJson(): Promise<string> {
  const stored = await readStoredSessions();
  return `${JSON.stringify(
    createStoredEnvelope(stored.store.revision, stored.sessions),
    null,
    2,
  )}\n`;
}

export async function importSessionsJson(json: string): Promise<ImportSessionsResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('导入文件不是合法 JSON');
  }
  const importedStore = parseStoredEnvelope(raw);
  if (![1, 2, STORAGE_SCHEMA_VERSION].includes(importedStore.sourceSchemaVersion)) {
    throw new Error(`导入文件必须是 Bok v1、v2 或 v${STORAGE_SCHEMA_VERSION} 数据`);
  }
  const validated = validateStoredSessions(importedStore);
  if (validated.recoveries.length > 0) {
    throw new Error(
      `导入文件校验失败：${validated.recoveries[0]?.issues[0] ?? '数据无效'}`,
    );
  }
  if (validated.sessions.length === 0) throw new Error('导入文件没有保存记录');

  const [current, period] = await Promise.all([
    readStoredSessions(),
    getSavedPagesAutoArchivePeriod(),
  ]);
  const imported = migrateSessions(validated.sessions);
  const merged = mergeImportedSessions(current.sessions, imported);
  const now = Date.now();
  const { archivedSessions, archivedGroups } = archiveEligibleGroupsInMemory(
    merged.sessions,
    now,
    period,
  );
  const envelope = createStoredEnvelope(current.store.revision + 1, merged.sessions);
  const snapshot = current.store.sourceSchemaVersion < STORAGE_SCHEMA_VERSION &&
    current.raw !== undefined
    ? await browser.storage.local.get(SESSIONS_PRE_V3_SNAPSHOT_KEY)
    : {};
  await browser.storage.local.set({
    [SESSIONS_IMPORT_BACKUP_KEY]: { capturedAt: now, value: current.raw ?? null },
    ...(current.raw !== undefined &&
    current.store.sourceSchemaVersion < STORAGE_SCHEMA_VERSION &&
    snapshot[SESSIONS_PRE_V3_SNAPSHOT_KEY] === undefined
      ? { [SESSIONS_PRE_V3_SNAPSHOT_KEY]: current.raw }
      : {}),
    [SESSIONS_KEY]: envelope,
  });
  return {
    kind: 'saved-pages',
    importedSessions: merged.importedSessions,
    importedGroups: merged.importedGroups,
    importedTabs: merged.importedTabs,
    skippedDuplicateGroups: merged.skippedDuplicateGroups,
    renamedGroups: merged.titleChanges.length,
    archivedSessions,
    archivedGroups,
  };
}

export async function writeSessions(sessions: SavedSession[]): Promise<void> {
  const current = await readStoredSessions();
  await writeEnvelope(
    createStoredEnvelope(current.store.revision + 1, sessions),
    current,
  );
}
