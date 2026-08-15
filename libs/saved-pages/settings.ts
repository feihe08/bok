import { browser } from 'wxt/browser';
import {
  isSavedPagesAutoArchivePeriod,
  type SavedPagesAutoArchivePeriod,
} from './model.ts';

export const SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY =
  'savedPagesAutoArchivePeriod';
export const DEFAULT_SAVED_PAGES_AUTO_ARCHIVE_PERIOD = 7;

export function normalizeSavedPagesAutoArchivePeriod(
  value: unknown,
): SavedPagesAutoArchivePeriod {
  return isSavedPagesAutoArchivePeriod(value)
    ? value
    : DEFAULT_SAVED_PAGES_AUTO_ARCHIVE_PERIOD;
}

export async function getSavedPagesAutoArchivePeriod(): Promise<
  SavedPagesAutoArchivePeriod
> {
  const stored = await browser.storage.local.get(
    SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY,
  );
  return normalizeSavedPagesAutoArchivePeriod(
    stored[SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY],
  );
}

export async function setSavedPagesAutoArchivePeriod(
  period: SavedPagesAutoArchivePeriod,
): Promise<void> {
  if (!isSavedPagesAutoArchivePeriod(period)) {
    throw new Error('自动归档周期无效');
  }
  await browser.storage.local.set({
    [SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY]: period,
  });
}
