import type { BookmarkOrganizerFolder } from './organizer-storage';

export interface BookmarkOrganizerExpectedCandidate {
  title: string;
  url: string;
  parentId: string;
  folderPath: BookmarkOrganizerFolder[];
}

interface CandidateCommandBase {
  roundId: string;
  bookmarkId: string;
  expectedRevision: number;
  expected: BookmarkOrganizerExpectedCandidate;
}

export type BookmarkOrganizerCommand =
  | { type: 'bok/bookmark-organizer/start-round' }
  | { type: 'bok/bookmark-organizer/resume-round' }
  | { type: 'bok/bookmark-organizer/reconcile-move-undo'; bookmarkId: string }
  | { type: 'bok/bookmark-organizer/generate-suggestions'; roundId: string }
  | ({ type: 'bok/bookmark-organizer/retry-suggestion' } & CandidateCommandBase)
  | ({ type: 'bok/bookmark-organizer/decide'; action: 'keep-current' | 'remove' | 'defer' | 'accept-suggestion' } & CandidateCommandBase)
  | ({ type: 'bok/bookmark-organizer/decide'; action: 'move'; destinationId: string } & CandidateCommandBase)
  | { type: 'bok/bookmark-organizer/finish-round'; roundId: string };

export type BookmarkOrganizerResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFolderPath(value: unknown): value is BookmarkOrganizerFolder[] {
  return Array.isArray(value) && value.every((folder) =>
    isRecord(folder) && hasExactKeys(folder, ['id', 'title']) &&
    isNonEmptyString(folder.id) && typeof folder.title === 'string');
}

function isExpected(value: unknown): value is BookmarkOrganizerExpectedCandidate {
  return isRecord(value) &&
    hasExactKeys(value, ['title', 'url', 'parentId', 'folderPath']) &&
    typeof value.title === 'string' && isNonEmptyString(value.url) &&
    isNonEmptyString(value.parentId) && isFolderPath(value.folderPath);
}

export function isBookmarkOrganizerCommand(value: unknown): value is BookmarkOrganizerCommand {
  if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
  if (value.type === 'bok/bookmark-organizer/start-round' || value.type === 'bok/bookmark-organizer/resume-round') {
    return hasExactKeys(value, ['type']);
  }
  if (value.type === 'bok/bookmark-organizer/reconcile-move-undo') {
    return hasExactKeys(value, ['type', 'bookmarkId']) && isNonEmptyString(value.bookmarkId);
  }
  if (value.type === 'bok/bookmark-organizer/finish-round' ||
    value.type === 'bok/bookmark-organizer/generate-suggestions') {
    return hasExactKeys(value, ['type', 'roundId']) && isNonEmptyString(value.roundId);
  }
  if ((value.type !== 'bok/bookmark-organizer/decide' &&
    value.type !== 'bok/bookmark-organizer/retry-suggestion') ||
    !isNonEmptyString(value.roundId) || !isNonEmptyString(value.bookmarkId) ||
    !Number.isInteger(value.expectedRevision) || (value.expectedRevision as number) < 1 ||
    !isExpected(value.expected)) return false;
  const candidateKeys = ['type', 'roundId', 'bookmarkId', 'expectedRevision', 'expected'];
  if (value.type === 'bok/bookmark-organizer/retry-suggestion') {
    return hasExactKeys(value, candidateKeys);
  }
  const common = [...candidateKeys, 'action'];
  if (value.action === 'move') {
    return hasExactKeys(value, [...common, 'destinationId']) && isNonEmptyString(value.destinationId);
  }
  return (value.action === 'keep-current' || value.action === 'remove' ||
    value.action === 'defer' || value.action === 'accept-suggestion') && hasExactKeys(value, common);
}

export function isBookmarkOrganizerCommandMessage(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string' &&
    value.type.startsWith('bok/bookmark-organizer/');
}

export function isBookmarkOrganizerAiCommand(
  value: BookmarkOrganizerCommand,
): value is Extract<BookmarkOrganizerCommand, {
  type:
    | 'bok/bookmark-organizer/generate-suggestions'
    | 'bok/bookmark-organizer/retry-suggestion';
}> {
  return value.type === 'bok/bookmark-organizer/generate-suggestions' ||
    value.type === 'bok/bookmark-organizer/retry-suggestion';
}
