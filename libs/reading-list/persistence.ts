import { browser } from 'wxt/browser';
import type {
  ImportReadingListResult,
  ReadingListItem,
  ReadingListStore,
} from './model.ts';

export const READING_LIST_KEY = 'readingList';
export const READING_LIST_IMPORT_BACKUP_KEY = 'readingListImportBackup';
export const READING_LIST_SCHEMA_VERSION = 1;

interface ParsedReadingListStore {
  sourceSchemaVersion: 0 | typeof READING_LIST_SCHEMA_VERSION;
  revision: number;
  items: ReadingListItem[];
}

export interface ReadingListReadResult {
  items: ReadingListItem[];
}

class UnsupportedReadingListSchemaError extends Error {}
class InvalidReadingListStoreError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

const isValidTimestamp = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAX_DATE_TIMESTAMP;

function isHttpUrl(value: string): boolean {
  if (value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateItem(value: unknown, prefix: string): ReadingListItem {
  if (!isRecord(value)) throw new InvalidReadingListStoreError(`${prefix} 必须是对象`);
  if (typeof value.id !== 'string' || !value.id) {
    throw new InvalidReadingListStoreError(`${prefix}.id 无效`);
  }
  if (typeof value.url !== 'string' || !isHttpUrl(value.url)) {
    throw new InvalidReadingListStoreError(`${prefix}.url 无效`);
  }
  if (typeof value.title !== 'string') {
    throw new InvalidReadingListStoreError(`${prefix}.title 无效`);
  }
  if (typeof value.note !== 'string') {
    throw new InvalidReadingListStoreError(`${prefix}.note 无效`);
  }
  if (!isValidTimestamp(value.createdAt)) {
    throw new InvalidReadingListStoreError(`${prefix}.createdAt 无效`);
  }
  if (!isValidTimestamp(value.updatedAt)) {
    throw new InvalidReadingListStoreError(`${prefix}.updatedAt 无效`);
  }
  if (value.updatedAt < value.createdAt) {
    throw new InvalidReadingListStoreError(`${prefix}.updatedAt 不能早于 createdAt`);
  }
  return {
    id: value.id,
    url: value.url,
    title: value.title,
    note: value.note,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseStore(
  raw: unknown,
  options: { allowDuplicateUrls?: boolean } = {},
): ParsedReadingListStore {
  if (raw === undefined) return { sourceSchemaVersion: 0, revision: 0, items: [] };
  if (!isRecord(raw)) {
    throw new InvalidReadingListStoreError('收藏列表的顶层结构无效');
  }
  if (
    typeof raw.schemaVersion === 'number' &&
    Number.isInteger(raw.schemaVersion) &&
    raw.schemaVersion > READING_LIST_SCHEMA_VERSION
  ) {
    throw new UnsupportedReadingListSchemaError(
      `收藏列表数据来自更新版本（v${raw.schemaVersion}），当前版本只支持 v${READING_LIST_SCHEMA_VERSION}。为避免覆盖数据，已停止读写。`,
    );
  }
  if (
    raw.schemaVersion !== READING_LIST_SCHEMA_VERSION ||
    raw.kind !== 'bok-reading-list' ||
    !Number.isInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !Array.isArray(raw.items)
  ) {
    throw new InvalidReadingListStoreError('收藏列表的版本或顶层结构无效');
  }

  const ids = new Set<string>();
  const urls = new Set<string>();
  const items = raw.items.map((item, index) => {
    const parsed = validateItem(item, `items[${index}]`);
    if (ids.has(parsed.id)) {
      throw new InvalidReadingListStoreError(`items[${index}].id 重复`);
    }
    if (!options.allowDuplicateUrls && urls.has(parsed.url)) {
      throw new InvalidReadingListStoreError(`items[${index}].url 重复`);
    }
    ids.add(parsed.id);
    urls.add(parsed.url);
    return parsed;
  });
  return {
    sourceSchemaVersion: READING_LIST_SCHEMA_VERSION,
    revision: raw.revision as number,
    items,
  };
}

function createStore(revision: number, items: ReadingListItem[]): ReadingListStore {
  return {
    schemaVersion: READING_LIST_SCHEMA_VERSION,
    kind: 'bok-reading-list',
    revision,
    items,
  };
}

async function readStoredReadingList(): Promise<{
  raw: unknown;
  store: ParsedReadingListStore;
}> {
  const raw = (await browser.storage.local.get(READING_LIST_KEY))[READING_LIST_KEY];
  return { raw, store: parseStore(raw) };
}

export async function readReadingList(): Promise<ReadingListReadResult> {
  const { store } = await readStoredReadingList();
  return { items: store.items };
}

export async function getReadingListItems(): Promise<ReadingListItem[]> {
  return (await readReadingList()).items;
}

export async function writeReadingList(items: ReadingListItem[]): Promise<void> {
  const current = await readStoredReadingList();
  const checked = parseStore(createStore(current.store.revision + 1, items));
  await browser.storage.local.set({
    [READING_LIST_KEY]: createStore(checked.revision, checked.items),
  });
}

export async function exportReadingListJson(): Promise<string> {
  const { store } = await readStoredReadingList();
  return `${JSON.stringify(createStore(store.revision, store.items), null, 2)}\n`;
}

function nextAvailableId(usedIds: Set<string>): string {
  let id = crypto.randomUUID();
  while (usedIds.has(id)) id = crypto.randomUUID();
  return id;
}

export async function importReadingListJson(json: string): Promise<ImportReadingListResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('导入文件不是合法 JSON');
  }

  const imported = parseStore(raw, { allowDuplicateUrls: true });
  if (imported.sourceSchemaVersion !== READING_LIST_SCHEMA_VERSION) {
    throw new Error('导入文件必须是 Bok 阅读列表 v1 数据');
  }
  const current = await readStoredReadingList();
  const items = [...current.store.items];
  const urls = new Set(items.map((item) => item.url));
  const ids = new Set(items.map((item) => item.id));
  let importedItems = 0;
  let skippedDuplicateUrls = 0;
  let regeneratedIds = 0;

  for (const item of imported.items) {
    if (urls.has(item.url)) {
      skippedDuplicateUrls += 1;
      continue;
    }
    const id = ids.has(item.id) ? nextAvailableId(ids) : item.id;
    if (id !== item.id) regeneratedIds += 1;
    items.push({ ...item, id });
    ids.add(id);
    urls.add(item.url);
    importedItems += 1;
  }

  if (importedItems > 0) {
    await browser.storage.local.set({
      [READING_LIST_IMPORT_BACKUP_KEY]: {
        capturedAt: Date.now(),
        value: current.raw ?? null,
      },
      [READING_LIST_KEY]: createStore(current.store.revision + 1, items),
    });
  }
  return { kind: 'reading-list', importedItems, skippedDuplicateUrls, regeneratedIds };
}
