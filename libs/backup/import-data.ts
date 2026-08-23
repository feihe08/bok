import { importBookmarkArchiveJson } from '../bookmarks/archive-storage';
import { importReadingListJson } from '../reading-list/persistence';
import { importSessionsJson } from '../saved-pages/persistence';
import type { ImportDataCommand, ImportDataResult } from './model';

export async function importBokDataJson(
  json: string,
): Promise<ImportDataResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('导入文件不是合法 JSON');
  }
  if (raw && typeof raw === 'object') {
    const kind = (raw as Record<string, unknown>).kind;
    if (kind === 'bok-reading-list') return importReadingListJson(json);
    if (kind === 'bok-bookmark-archive') return importBookmarkArchiveJson(json);
    if (kind === 'bok-bookmarks-backup') {
      throw new Error('当前不支持导入 Chrome 书签备份');
    }
  }
  return importSessionsJson(json);
}

export function isImportDataCommand(value: unknown): value is ImportDataCommand {
  if (typeof value !== 'object' || value === null) return false;

  const command = value as Record<string, unknown>;
  return command.type === 'bok/import-data' && typeof command.json === 'string';
}
