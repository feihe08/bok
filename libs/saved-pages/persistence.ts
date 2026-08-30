import { browser } from 'wxt/browser';
import { archiveEligibleGroupsInMemory } from './auto-archive.ts';
import { mergeImportedSessions } from './session-import.ts';
import type {
  DirectoryPath,
  SavedGroup,
  SavedGroupColor,
  SavedGroupTaskStatus,
  SavedSession,
  SavedSessionState,
  SavedTab,
} from './model.ts';
import { getStandaloneGroupId } from './session-items.ts';
import { getSavedPagesAutoArchivePeriod } from './settings.ts';
const SESSIONS_KEY = 'sessions';
const SESSIONS_RECOVERY_KEY = 'sessionsRecovery';
const SESSIONS_IMPORT_BACKUP_KEY = 'sessionsImportBackup';
export const STORAGE_SCHEMA_VERSION = 3;
interface StoredEnvelope {
    schemaVersion: typeof STORAGE_SCHEMA_VERSION;
    revision: number;
    sessions: unknown[];
}
interface ParsedStore {
    revision: number;
    sessions: unknown[];
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
type StoredTab = SavedTab;
type StoredGroup = Omit<
  SavedGroup,
  | 'restoredAt'
  | 'tabs'
> & {
    restoredAt?: number | null;
    tabs: StoredTab[];
};
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
  const values = Array.isArray(directory) ? directory : [];
  const segments = values
    .filter((segment): segment is string => typeof segment === 'string')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const [first, ...rest] = segments;
  return first ? [first, ...rest] : null;
}

const normalizeNullableTimestamp = (value: unknown): number | null =>
  isFiniteNumber(value) ? value : null;
const normalizeGroupColor = (color: unknown): SavedGroupColor | undefined =>
  typeof color === 'string' && SAVED_GROUP_COLORS.has(color as SavedGroupColor)
    ? color as SavedGroupColor
    : undefined;

function normalizeTaskStatus(taskStatus: unknown): SavedGroupTaskStatus | null {
  if (
    typeof taskStatus === 'string' &&
    SAVED_GROUP_TASK_STATUSES.has(taskStatus as SavedGroupTaskStatus)
  ) {
    return taskStatus as SavedGroupTaskStatus;
  }
  return null;
}

const normalizeTaskCompletedAt = (
  value: unknown,
  status: SavedGroupTaskStatus | null,
): number | null => status === 'done' ? normalizeNullableTimestamp(value) : null;

function normalizeTab(value: StoredTab): SavedTab {
  const { taskStatus, taskCompletedAt, ...tab } = value;
  const status = normalizeTaskStatus(taskStatus);
  return {
    ...tab,
    title: typeof tab.title === 'string' && tab.title.trim() ? tab.title : tab.url,
    favIconUrl: typeof tab.favIconUrl === 'string' ? tab.favIconUrl : undefined,
    archivedAt: normalizeNullableTimestamp(tab.archivedAt),
    tags: normalizeTags(tab.tags),
    directory: normalizeDirectory(tab.directory),
    taskStatus: status,
    taskCompletedAt: normalizeTaskCompletedAt(taskCompletedAt, status),
  };
}

function normalizeGroup(value: StoredGroup): SavedGroup {
  const task = normalizeTaskStatus(value.taskStatus);
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : '',
    createdAt: value.createdAt,
    archivedAt: normalizeNullableTimestamp(value.archivedAt),
    color: normalizeGroupColor(value.color),
    locked: value.locked === true,
    grouped: true,
    pinned: value.pinned === true,
    restoredAt: normalizeNullableTimestamp(value.restoredAt),
    taskStatus: task,
    taskCompletedAt: normalizeTaskCompletedAt(value.taskCompletedAt, task),
    tabs: value.tabs.map(normalizeTab),
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

class UnsupportedStorageSchemaError extends Error {
}
class InvalidStorageEnvelopeError extends Error {
}
function parseStoredEnvelope(raw: unknown): ParsedStore {
  if (raw === undefined) {
    return { revision: 0, sessions: [] };
  }
  if (Array.isArray(raw)) {
    throw new UnsupportedStorageSchemaError(
      `Bok 数据版本为 v0，当前版本只支持 v${STORAGE_SCHEMA_VERSION}。为避免覆盖数据，已停止读写。`,
    );
  }
  if (!isRecord(raw)) {
    throw new InvalidStorageEnvelopeError('保存数据的顶层结构无效');
  }
  const schemaVersion = raw.schemaVersion;
  if (
    typeof schemaVersion === 'number' &&
    Number.isInteger(schemaVersion) &&
    schemaVersion !== STORAGE_SCHEMA_VERSION
  ) {
    throw new UnsupportedStorageSchemaError(
      `Bok 数据版本为 v${schemaVersion}，当前版本只支持 v${STORAGE_SCHEMA_VERSION}。为避免覆盖数据，已停止读写。`,
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
): string[] {
  if (!isRecord(value)) return [`${prefix} 必须是对象`];
  const issues: string[] = [];
  if (!isNonEmptyString(value.id)) issues.push(`${prefix}.id 无效`);
  if (typeof value.title !== 'string') issues.push(`${prefix}.title 无效`);
  if (!isFiniteNumber(value.createdAt)) issues.push(`${prefix}.createdAt 无效`);
  if (value.grouped !== true) {
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
      issues.push(...validateGroup(item.group, `${itemPrefix}.group`));
    }
  });
  return issues;
}

function collectIds(value: Record<string, unknown>): {
  groupIds: string[];
  tabIds: string[];
} {
  const entries = Array.isArray(value.items) ? value.items : [];
  const groupIds: string[] = [];
  const tabIds: string[] = [];
  for (const entry of entries) {
    const tab = isRecord(entry) && entry.type === 'tab'
      ? entry.tab
      : undefined;
    const group = isRecord(entry) && entry.type === 'group'
      ? entry.group
      : undefined;
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
function normalizeV3Session(value: StoredV3Session): SavedSession {
  const items = (value.items as Array<Record<string, unknown>>).map((item) => {
    if (item.type === 'group') {
      return {
        type: 'group' as const,
        group: normalizeGroup(item.group as StoredGroup),
      };
    }
    return {
      type: 'tab' as const,
      tab: normalizeTab(item.tab as StoredTab),
    };
  });
  return {
    ...sessionState(value as unknown as Record<string, unknown>),
    id: value.id,
    createdAt: value.createdAt,
    items,
  };
}

function validateStoredSessions(store: ParsedStore): {
  sessions: SavedSession[];
  recoveries: Array<Omit<RecoveryEntry, 'capturedAt' | 'fingerprint'>>;
} {
  const sessions: SavedSession[] = [];
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
      issues.push(...validateV3Session(raw, prefix));

      const ids = collectIds(raw);
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
        sessions.push(normalizeV3Session(raw as unknown as StoredV3Session));
        localIds.forEach((id) => allIds.add(id));
        continue;
      }
    }
    recoveries.push({
      sourceSchemaVersion: STORAGE_SCHEMA_VERSION,
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
    sessions: validated.sessions,
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

async function writeEnvelope(envelope: StoredEnvelope): Promise<void> {
  await browser.storage.local.set({ [SESSIONS_KEY]: envelope });
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
  const merged = mergeImportedSessions(current.sessions, validated.sessions);
  const now = Date.now();
  const { archivedSessions, archivedGroups } = archiveEligibleGroupsInMemory(
    merged.sessions,
    now,
    period,
  );
  const envelope = createStoredEnvelope(current.store.revision + 1, merged.sessions);
  await browser.storage.local.set({
    [SESSIONS_IMPORT_BACKUP_KEY]: { capturedAt: now, value: current.raw ?? null },
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
  );
}
