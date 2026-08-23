import type { ReadingListItem } from './model.ts';
import { getReadingListItems, writeReadingList } from './persistence.ts';

export { getReadingListItems } from './persistence.ts';
export { getReadingListItems as getReadingList } from './persistence.ts';

export interface SaveReadingListItemInput {
  url: string;
  title: string;
}

export interface AddReadingListItemResult {
  item: ReadingListItem;
  status: 'added' | 'duplicate';
  /** Compatibility for the background operation result. */
  added: boolean;
}

export async function addReadingListItem(
  input: SaveReadingListItemInput,
): Promise<AddReadingListItemResult> {
  if (!input.url) throw new Error('收藏链接无效');
  const items = await getReadingListItems();
  const existing = items.find((item) => item.url === input.url);
  if (existing) return { item: existing, status: 'duplicate', added: false };

  const now = Date.now();
  const item: ReadingListItem = {
    id: crypto.randomUUID(),
    url: input.url,
    title: input.title.trim() || input.url,
    note: '',
    createdAt: now,
    updatedAt: now,
  };
  await writeReadingList([item, ...items]);
  return { item, status: 'added', added: true };
}

export async function updateReadingListNote(
  itemId: string,
  note: string,
): Promise<ReadingListItem> {
  const items = await getReadingListItems();
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('找不到要编辑的收藏');
  if (item.note === note) return item;

  const updated = { ...item, note, updatedAt: Date.now() };
  await writeReadingList(items.map((candidate) =>
    candidate.id === itemId ? updated : candidate,
  ));
  return updated;
}

export async function deleteReadingListItem(itemId: string): Promise<void> {
  const items = await getReadingListItems();
  if (!items.some((item) => item.id === itemId)) {
    throw new Error('找不到要删除的收藏');
  }
  await writeReadingList(items.filter((item) => item.id !== itemId));
}

export const saveReadingListItem = addReadingListItem;
export const removeReadingListItem = deleteReadingListItem;

export async function getRandomReadingListItem(): Promise<ReadingListItem | null> {
  const items = await getReadingListItems();
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)] ?? null;
}
