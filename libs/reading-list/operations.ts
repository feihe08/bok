import { browser } from 'wxt/browser';
import type { ReadingListCommand, ReadingListCommandResult } from './messages';
import {
  addReadingListItem,
  deleteReadingListItem,
  getRandomReadingListItem,
  updateReadingListNote,
} from './store';

export interface AddReadingListTabSnapshotResult {
  added: boolean;
}

export interface ReadingListTabSnapshot {
  readonly url: string | undefined;
  readonly title: string | undefined;
}

export async function addReadingListTabSnapshot(
  snapshot: ReadingListTabSnapshot,
): Promise<AddReadingListTabSnapshotResult> {
  const { url, title } = snapshot;
  if (!url || !isWebUrl(url)) {
    throw new Error('只能收藏 http 或 https 网页');
  }

  const result = await addReadingListItem({
    url,
    title: title?.trim() || url,
  });
  return { added: result.added };
}

export async function executeReadingListCommand(
  command: ReadingListCommand,
): Promise<ReadingListCommandResult> {
  switch (command.type) {
    case 'bok/reading-list/update-note':
      await updateReadingListNote(command.id, command.note);
      return null;
    case 'bok/reading-list/delete-item':
      await deleteReadingListItem(command.id);
      return null;
    case 'bok/reading-list/open-random': {
      const item = await getRandomReadingListItem();
      if (!item) return { opened: false };
      await browser.tabs.create({ url: item.url, active: true });
      return { opened: true };
    }
  }
}

function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
