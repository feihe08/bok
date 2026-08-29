import { browser } from 'wxt/browser';

export const BOOKMARK_ORGANIZER_STATE_KEY = 'bookmarkOrganizerState';
export const BOOKMARK_ORGANIZER_SCHEMA_VERSION = 1;

export type BookmarkOrganizerChangeType =
  | 'created'
  | 'title-changed'
  | 'url-changed'
  | 'moved'
  | 'ancestor-changed';

export type BookmarkOrganizerDecision = 'keep' | 'remove' | 'unsure';
export type BookmarkOrganizerSuggestionRetention = 'keep' | 'discard' | 'unsure';

export interface BookmarkOrganizerSuggestion {
  candidateRevision: number;
  retention: BookmarkOrganizerSuggestionRetention;
  directory: string | null;
  reason: string;
  suggestedAt: number;
}

export interface BookmarkOrganizerFolder {
  id: string;
  title: string;
}

export interface BookmarkOrganizerCandidate {
  bookmarkId: string;
  firstDetectedAt: number;
  updatedAt: number;
  revision: number;
  changeTypes: BookmarkOrganizerChangeType[];
  title: string;
  url: string;
  dateAdded?: number;
  dateLastUsed?: number;
  suggestion?: BookmarkOrganizerSuggestion;
  parentId: string;
  folderPath: BookmarkOrganizerFolder[];
}

export interface BookmarkOrganizerRecordedDecision {
  candidateRevision: number;
  decision: BookmarkOrganizerDecision;
  decidedAt: number;
}

export interface BookmarkOrganizerRound {
  id: string;
  /** Candidates are snapshotted at this time; later arrivals wait for the next round. */
  startedAt: number;
  candidateIds: string[];
  deferredBookmarkIds: string[];
}

export interface BookmarkOrganizerGap {
  startedAt: number;
  recoveredAt?: number;
}

export interface BookmarkOrganizerTracking {
  bookmarksBarId: string;
  baselineAt: number;
  status: 'tracking' | 'permission-gap';
  gap: BookmarkOrganizerGap | null;
}

export interface BookmarkOrganizerStore {
  schemaVersion: typeof BOOKMARK_ORGANIZER_SCHEMA_VERSION;
  kind: 'bok-bookmark-organizer';
  revision: number;
  tracking: BookmarkOrganizerTracking;
  candidates: Record<string, BookmarkOrganizerCandidate>;
  decisions: Record<string, BookmarkOrganizerRecordedDecision>;
  round: BookmarkOrganizerRound | null;
}

class InvalidBookmarkOrganizerStoreError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseFolder(value: unknown, prefix: string): BookmarkOrganizerFolder {
  if (!isRecord(value) || !isNonEmptyString(value.id) || typeof value.title !== 'string') {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 无效`);
  }
  return { id: value.id, title: value.title };
}

function parseChangeTypes(value: unknown, prefix: string): BookmarkOrganizerChangeType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 无效`);
  }
  const allowed = new Set<BookmarkOrganizerChangeType>([
    'created',
    'title-changed',
    'url-changed',
    'moved',
    'ancestor-changed',
  ]);
  const types = value.map((item) => {
    if (typeof item !== 'string' || !allowed.has(item as BookmarkOrganizerChangeType)) {
      throw new InvalidBookmarkOrganizerStoreError(`${prefix} 无效`);
    }
    return item as BookmarkOrganizerChangeType;
  });
  if (new Set(types).size !== types.length) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 不能重复`);
  }
  return types;
}

function parseCandidate(value: unknown, prefix: string): BookmarkOrganizerCandidate {
  if (!isRecord(value)) throw new InvalidBookmarkOrganizerStoreError(`${prefix} 必须是对象`);
  if (
    !isNonEmptyString(value.bookmarkId) ||
    !isTimestamp(value.firstDetectedAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.firstDetectedAt ||
    !isRevision(value.revision) ||
    value.revision < 1 ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    !isNonEmptyString(value.parentId) ||
    !Array.isArray(value.folderPath)
  ) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 无效`);
  }
  if (value.dateAdded !== undefined && !isTimestamp(value.dateAdded)) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix}.dateAdded 无效`);
  }
  if (value.dateLastUsed !== undefined && !isTimestamp(value.dateLastUsed)) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix}.dateLastUsed 无效`);
  }
  const suggestion = value.suggestion === undefined ? undefined : parseSuggestion(value.suggestion, `${prefix}.suggestion`);
  return {
    bookmarkId: value.bookmarkId,
    firstDetectedAt: value.firstDetectedAt,
    updatedAt: value.updatedAt,
    revision: value.revision,
    changeTypes: parseChangeTypes(value.changeTypes, `${prefix}.changeTypes`),
    title: value.title,
    url: value.url,
    ...(typeof value.dateAdded === 'number' ? { dateAdded: value.dateAdded } : {}),
    ...(typeof value.dateLastUsed === 'number'
      ? { dateLastUsed: value.dateLastUsed }
      : {}),
    ...(suggestion ? { suggestion } : {}),
    parentId: value.parentId,
    folderPath: value.folderPath.map((folder, index) =>
      parseFolder(folder, `${prefix}.folderPath[${index}]`),
    ),
  };
}

function parseSuggestion(value: unknown, prefix: string): BookmarkOrganizerSuggestion {
  if (!isRecord(value) || !isRevision(value.candidateRevision) || value.candidateRevision < 1 ||
    (value.retention !== 'keep' && value.retention !== 'discard' && value.retention !== 'unsure') ||
    (value.directory !== null && typeof value.directory !== 'string') ||
    typeof value.reason !== 'string' || !isTimestamp(value.suggestedAt)) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 无效`);
  }
  return { candidateRevision: value.candidateRevision, retention: value.retention, directory: value.directory, reason: value.reason, suggestedAt: value.suggestedAt };
}

function parseDecision(
  value: unknown,
  prefix: string,
): BookmarkOrganizerRecordedDecision {
  if (
    !isRecord(value) ||
    !isRevision(value.candidateRevision) ||
    value.candidateRevision < 1 ||
    (value.decision !== 'keep' && value.decision !== 'remove' && value.decision !== 'unsure') ||
    !isTimestamp(value.decidedAt)
  ) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 无效`);
  }
  return {
    candidateRevision: value.candidateRevision,
    decision: value.decision,
    decidedAt: value.decidedAt,
  };
}

function parseGap(value: unknown): BookmarkOrganizerGap | null {
  if (value === null) return null;
  if (!isRecord(value) || !isTimestamp(value.startedAt)) {
    throw new InvalidBookmarkOrganizerStoreError('tracking.gap 无效');
  }
  if (value.recoveredAt !== undefined && !isTimestamp(value.recoveredAt)) {
    throw new InvalidBookmarkOrganizerStoreError('tracking.gap.recoveredAt 无效');
  }
  if (
    typeof value.recoveredAt === 'number' &&
    value.recoveredAt < value.startedAt
  ) {
    throw new InvalidBookmarkOrganizerStoreError('tracking.gap.recoveredAt 无效');
  }
  return {
    startedAt: value.startedAt,
    ...(typeof value.recoveredAt === 'number'
      ? { recoveredAt: value.recoveredAt }
      : {}),
  };
}

function parseTracking(value: unknown): BookmarkOrganizerTracking {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.bookmarksBarId) ||
    !isTimestamp(value.baselineAt) ||
    (value.status !== 'tracking' && value.status !== 'permission-gap')
  ) {
    throw new InvalidBookmarkOrganizerStoreError('tracking 无效');
  }
  const gap = parseGap(value.gap);
  if (value.status === 'permission-gap' && (!gap || gap.recoveredAt !== undefined)) {
    throw new InvalidBookmarkOrganizerStoreError('tracking.gap 无效');
  }
  return {
    bookmarksBarId: value.bookmarksBarId,
    baselineAt: value.baselineAt,
    status: value.status,
    gap,
  };
}

function parseStringArray(value: unknown, prefix: string): string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 无效`);
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) {
    throw new InvalidBookmarkOrganizerStoreError(`${prefix} 不能重复`);
  }
  return ids;
}

function parseRound(value: unknown): BookmarkOrganizerRound | null {
  if (value === null) return null;
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isTimestamp(value.startedAt)) {
    throw new InvalidBookmarkOrganizerStoreError('round 无效');
  }
  const candidateIds = parseStringArray(value.candidateIds, 'round.candidateIds');
  const deferredBookmarkIds = parseStringArray(
    value.deferredBookmarkIds,
    'round.deferredBookmarkIds',
  );
  if (!deferredBookmarkIds.every((id) => candidateIds.includes(id))) {
    throw new InvalidBookmarkOrganizerStoreError('round.deferredBookmarkIds 无效');
  }
  return { id: value.id, startedAt: value.startedAt, candidateIds, deferredBookmarkIds };
}

export function parseBookmarkOrganizerStore(value: unknown): BookmarkOrganizerStore | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new InvalidBookmarkOrganizerStoreError('书签整理状态无效');
  if (
    value.schemaVersion !== BOOKMARK_ORGANIZER_SCHEMA_VERSION ||
    value.kind !== 'bok-bookmark-organizer' ||
    !isRevision(value.revision) ||
    !isRecord(value.candidates) ||
    !isRecord(value.decisions)
  ) {
    throw new InvalidBookmarkOrganizerStoreError('书签整理状态的版本或顶层结构无效');
  }
  const candidates: Record<string, BookmarkOrganizerCandidate> = {};
  for (const [id, candidate] of Object.entries(value.candidates)) {
    if (!isNonEmptyString(id)) {
      throw new InvalidBookmarkOrganizerStoreError('candidates key 无效');
    }
    const parsed = parseCandidate(candidate, `candidates.${id}`);
    if (parsed.bookmarkId !== id) {
      throw new InvalidBookmarkOrganizerStoreError(`candidates.${id}.bookmarkId 无效`);
    }
    candidates[id] = parsed;
  }
  const decisions: Record<string, BookmarkOrganizerRecordedDecision> = {};
  for (const [id, decision] of Object.entries(value.decisions)) {
    if (!isNonEmptyString(id)) {
      throw new InvalidBookmarkOrganizerStoreError('decisions key 无效');
    }
    decisions[id] = parseDecision(decision, `decisions.${id}`);
  }
  const round = parseRound(value.round);
  if (round && !round.candidateIds.every((id) => candidates[id] !== undefined)) {
    throw new InvalidBookmarkOrganizerStoreError('round.candidateIds 无效');
  }
  return {
    schemaVersion: BOOKMARK_ORGANIZER_SCHEMA_VERSION,
    kind: 'bok-bookmark-organizer',
    revision: value.revision,
    tracking: parseTracking(value.tracking),
    candidates,
    decisions,
    round,
  };
}

export function createBookmarkOrganizerStore(
  bookmarksBarId: string,
  baselineAt: number,
): BookmarkOrganizerStore {
  return {
    schemaVersion: BOOKMARK_ORGANIZER_SCHEMA_VERSION,
    kind: 'bok-bookmark-organizer',
    revision: 0,
    tracking: {
      bookmarksBarId,
      baselineAt,
      status: 'tracking',
      gap: null,
    },
    candidates: {},
    decisions: {},
    round: null,
  };
}

export async function readBookmarkOrganizerStore(): Promise<BookmarkOrganizerStore | null> {
  const stored = await browser.storage.local.get(BOOKMARK_ORGANIZER_STATE_KEY);
  return parseBookmarkOrganizerStore(stored[BOOKMARK_ORGANIZER_STATE_KEY]);
}

export async function writeBookmarkOrganizerStore(
  store: BookmarkOrganizerStore,
): Promise<void> {
  const checked = parseBookmarkOrganizerStore(store);
  if (!checked) throw new InvalidBookmarkOrganizerStoreError('书签整理状态无效');
  await browser.storage.local.set({ [BOOKMARK_ORGANIZER_STATE_KEY]: checked });
}

export function nextBookmarkOrganizerStore(
  store: BookmarkOrganizerStore,
  changes: Omit<BookmarkOrganizerStore, 'schemaVersion' | 'kind' | 'revision'>,
): BookmarkOrganizerStore {
  return {
    schemaVersion: BOOKMARK_ORGANIZER_SCHEMA_VERSION,
    kind: 'bok-bookmark-organizer',
    revision: store.revision + 1,
    ...changes,
  };
}
