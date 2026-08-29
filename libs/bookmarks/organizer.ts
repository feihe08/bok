import { readBookmarksBar } from './api';
import { isDefaultFolderMarker } from './default-folder';
import type { BookmarkNode } from './model';
import {
  createBookmarkOrganizerStore,
  nextBookmarkOrganizerStore,
  readBookmarkOrganizerStore,
  writeBookmarkOrganizerStore,
  type BookmarkOrganizerCandidate,
  type BookmarkOrganizerChangeType,
  type BookmarkOrganizerDecision,
  type BookmarkOrganizerFolder,
  type BookmarkOrganizerStore,
  type BookmarkOrganizerSuggestion,
} from './organizer-storage';

interface BookmarkSnapshot {
  bookmarkId: string;
  title: string;
  url: string;
  dateAdded?: number;
  dateLastUsed?: number;
  parentId: string;
  folderPath: BookmarkOrganizerFolder[];
}

interface BookmarkTreeIndex {
  nodes: Map<string, BookmarkNode>;
  bookmarks: Map<string, BookmarkSnapshot>;
}

interface BookmarkOrganizerOptions {
  now?: () => number;
  createRoundId?: () => string;
}

function indexBookmarksBar(bookmarksBar: BookmarkNode): BookmarkTreeIndex {
  const nodes = new Map<string, BookmarkNode>();
  const bookmarks = new Map<string, BookmarkSnapshot>();

  function walk(node: BookmarkNode, folderPath: BookmarkOrganizerFolder[]): void {
    nodes.set(node.id, node);
    if (node.url != null) {
      if (!isDefaultFolderMarker(node) && node.parentId != null) {
        bookmarks.set(node.id, {
          bookmarkId: node.id,
          title: node.title,
          url: node.url,
          ...(typeof node.dateAdded === 'number' ? { dateAdded: node.dateAdded } : {}),
          ...(typeof node.dateLastUsed === 'number'
            ? { dateLastUsed: node.dateLastUsed }
            : {}),
          parentId: node.parentId,
          folderPath,
        });
      }
      return;
    }
    const nextFolderPath = [...folderPath, { id: node.id, title: node.title }];
    for (const child of node.children ?? []) walk(child, nextFolderPath);
  }

  walk(bookmarksBar, []);
  return { nodes, bookmarks };
}

function sameFolderPath(
  left: BookmarkOrganizerFolder[],
  right: BookmarkOrganizerFolder[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (folder, index) =>
        folder.id === right[index]?.id && folder.title === right[index]?.title,
    )
  );
}

function sameSnapshot(
  candidate: BookmarkOrganizerCandidate,
  snapshot: BookmarkSnapshot,
): boolean {
  return (
    candidate.title === snapshot.title &&
    candidate.url === snapshot.url &&
    candidate.dateAdded === snapshot.dateAdded &&
    candidate.dateLastUsed === snapshot.dateLastUsed &&
    candidate.parentId === snapshot.parentId &&
    sameFolderPath(candidate.folderPath, snapshot.folderPath)
  );
}

function withCandidate(
  candidates: Record<string, BookmarkOrganizerCandidate>,
  snapshot: BookmarkSnapshot,
  changeTypes: BookmarkOrganizerChangeType[],
  now: number,
): Record<string, BookmarkOrganizerCandidate> {
  const existing = candidates[snapshot.bookmarkId];
  if (!existing) {
    return {
      ...candidates,
      [snapshot.bookmarkId]: {
        ...snapshot,
        firstDetectedAt: now,
        updatedAt: now,
        revision: 1,
        changeTypes,
      },
    };
  }
  const nextChangeTypes = [
    ...existing.changeTypes,
    ...changeTypes.filter((type) => !existing.changeTypes.includes(type)),
  ];
  if (sameSnapshot(existing, snapshot) && nextChangeTypes.length === existing.changeTypes.length) {
    return candidates;
  }
  return {
    ...candidates,
    [snapshot.bookmarkId]: {
      ...existing,
      ...snapshot,
      updatedAt: now,
      revision: existing.revision + 1,
      changeTypes: nextChangeTypes,
      suggestion: undefined,
    },
  };
}

function withoutRemovedCandidates(
  candidates: Record<string, BookmarkOrganizerCandidate>,
  removedId: string,
): Record<string, BookmarkOrganizerCandidate> {
  let changed = false;
  const next: Record<string, BookmarkOrganizerCandidate> = {};
  for (const [bookmarkId, candidate] of Object.entries(candidates)) {
    if (
      bookmarkId === removedId ||
      candidate.folderPath.some((folder) => folder.id === removedId)
    ) {
      changed = true;
      continue;
    }
    next[bookmarkId] = candidate;
  }
  return changed ? next : candidates;
}

function keepCandidatesInBookmarksBar(
  candidates: Record<string, BookmarkOrganizerCandidate>,
  index: BookmarkTreeIndex,
  now: number,
): Record<string, BookmarkOrganizerCandidate> {
  let changed = false;
  const next: Record<string, BookmarkOrganizerCandidate> = {};
  for (const [bookmarkId, candidate] of Object.entries(candidates)) {
    const snapshot = index.bookmarks.get(bookmarkId);
    if (!snapshot) {
      changed = true;
      continue;
    }
    next[bookmarkId] = sameSnapshot(candidate, snapshot)
      ? candidate
      : {
          ...candidate,
          ...snapshot,
          updatedAt: now,
          revision: candidate.revision + 1,
          suggestion: undefined,
        };
    changed ||= next[bookmarkId] !== candidate;
  }
  return changed ? next : candidates;
}

function pruneRound(
  store: BookmarkOrganizerStore,
  candidates: Record<string, BookmarkOrganizerCandidate>,
): BookmarkOrganizerStore['round'] {
  if (!store.round) return null;
  const candidateIds = store.round.candidateIds.filter((id) => candidates[id] !== undefined);
  const deferredBookmarkIds = store.round.deferredBookmarkIds.filter((id) =>
    candidateIds.includes(id),
  );
  if (
    candidateIds.length === store.round.candidateIds.length &&
    deferredBookmarkIds.length === store.round.deferredBookmarkIds.length
  ) {
    return store.round;
  }
  return { ...store.round, candidateIds, deferredBookmarkIds };
}

export class BookmarkOrganizer {
  private queue = Promise.resolve();

  private readonly now: () => number;

  private readonly createRoundId: () => string;

  constructor(options: BookmarkOrganizerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createRoundId = options.createRoundId ?? (() => crypto.randomUUID());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async readIndex(): Promise<{ bookmarksBar: BookmarkNode; index: BookmarkTreeIndex }> {
    const bookmarksBar = await readBookmarksBar();
    return { bookmarksBar, index: indexBookmarksBar(bookmarksBar) };
  }

  private async update(
    update: (store: BookmarkOrganizerStore) => BookmarkOrganizerStore | null,
  ): Promise<BookmarkOrganizerStore | null> {
    const store = await readBookmarkOrganizerStore();
    if (!store) return null;
    const next = update(store);
    if (!next || next === store) return store;
    await writeBookmarkOrganizerStore(next);
    return next;
  }

  async initialize(): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const { bookmarksBar } = await this.readIndex();
      const store = await readBookmarkOrganizerStore();
      if (!store) {
        const initialized = createBookmarkOrganizerStore(bookmarksBar.id, this.now());
        await writeBookmarkOrganizerStore(initialized);
        return initialized;
      }
      if (store.tracking.status === 'permission-gap') {
        return this.recoverAfterPermissionGapInQueue(bookmarksBar);
      }
      return store;
    });
  }

  async markPermissionGap(): Promise<BookmarkOrganizerStore | null> {
    return this.enqueue(() =>
      this.update((store) => {
        if (store.tracking.status === 'permission-gap') return null;
        return nextBookmarkOrganizerStore(store, {
          tracking: {
            ...store.tracking,
            status: 'permission-gap',
            gap: { startedAt: this.now() },
          },
          candidates: store.candidates,
          decisions: store.decisions,
          round: store.round,
        });
      }),
    );
  }

  private async recoverAfterPermissionGapInQueue(
    bookmarksBar: BookmarkNode,
  ): Promise<BookmarkOrganizerStore> {
    const index = indexBookmarksBar(bookmarksBar);
    const store = await readBookmarkOrganizerStore();
    if (!store) {
      const initialized = createBookmarkOrganizerStore(bookmarksBar.id, this.now());
      await writeBookmarkOrganizerStore(initialized);
      return initialized;
    }
    const candidates = keepCandidatesInBookmarksBar(store.candidates, index, this.now());
    const round = pruneRound(store, candidates);
    const recoveredAt = this.now();
    const next = nextBookmarkOrganizerStore(store, {
      tracking: {
        bookmarksBarId: bookmarksBar.id,
        baselineAt: recoveredAt,
        status: 'tracking',
        gap: store.tracking.gap
          ? { ...store.tracking.gap, recoveredAt }
          : { startedAt: recoveredAt, recoveredAt },
      },
      candidates,
      decisions: store.decisions,
      round,
    });
    await writeBookmarkOrganizerStore(next);
    return next;
  }

  async recoverAfterPermissionGap(): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const { bookmarksBar } = await this.readIndex();
      return this.recoverAfterPermissionGapInQueue(bookmarksBar);
    });
  }

  private async trackNode(
    nodeId: string,
    changeType: BookmarkOrganizerChangeType,
  ): Promise<BookmarkOrganizerStore | null> {
    const { index } = await this.readIndex();
    return this.update((store) => {
      if (store.tracking.status !== 'tracking') return null;
      const node = index.nodes.get(nodeId);
      if (!node) {
        const candidates = withoutRemovedCandidates(store.candidates, nodeId);
        if (candidates === store.candidates) return null;
        return nextBookmarkOrganizerStore(store, {
          tracking: store.tracking,
          candidates,
          decisions: store.decisions,
          round: pruneRound(store, candidates),
        });
      }
      const snapshots = node.url != null
        ? [index.bookmarks.get(node.id)].filter(
            (snapshot): snapshot is BookmarkSnapshot => snapshot !== undefined,
          )
        : [...index.bookmarks.values()].filter((snapshot) =>
            snapshot.folderPath.some((folder) => folder.id === node.id),
          );
      let candidates = store.candidates;
      const now = this.now();
      for (const snapshot of snapshots) {
        candidates = withCandidate(candidates, snapshot, [changeType], now);
      }
      if (candidates === store.candidates) return null;
      return nextBookmarkOrganizerStore(store, {
        tracking: store.tracking,
        candidates,
        decisions: store.decisions,
        round: store.round,
      });
    });
  }

  async trackCreated(nodeId: string): Promise<BookmarkOrganizerStore | null> {
    return this.enqueue(() => this.trackNode(nodeId, 'created'));
  }

  async trackChanged(
    nodeId: string,
    changes: { title?: string; url?: string },
  ): Promise<BookmarkOrganizerStore | null> {
    if (changes.title === undefined && changes.url === undefined) {
      return readBookmarkOrganizerStore();
    }
    return this.enqueue(async () => {
      const { index } = await this.readIndex();
      const node = index.nodes.get(nodeId);
      return this.update((store) => {
        if (store.tracking.status !== 'tracking') return null;
        if (!node) {
          const candidates = withoutRemovedCandidates(store.candidates, nodeId);
          if (candidates === store.candidates) return null;
          return nextBookmarkOrganizerStore(store, {
            tracking: store.tracking,
            candidates,
            decisions: store.decisions,
            round: pruneRound(store, candidates),
          });
        }
        const changeTypes: BookmarkOrganizerChangeType[] =
          node.url == null
            ? ['ancestor-changed']
            : [
                ...(changes.title === undefined ? [] : ['title-changed' as const]),
                ...(changes.url === undefined ? [] : ['url-changed' as const]),
              ];
        const snapshots = node.url != null
          ? [index.bookmarks.get(node.id)].filter(
              (snapshot): snapshot is BookmarkSnapshot => snapshot !== undefined,
            )
          : [...index.bookmarks.values()].filter((snapshot) =>
              snapshot.folderPath.some((folder) => folder.id === node.id),
            );
        let candidates = store.candidates;
        const now = this.now();
        for (const snapshot of snapshots) {
          candidates = withCandidate(candidates, snapshot, changeTypes, now);
        }
        if (candidates === store.candidates) return null;
        return nextBookmarkOrganizerStore(store, {
          tracking: store.tracking,
          candidates,
          decisions: store.decisions,
          round: store.round,
        });
      });
    });
  }

  async trackMoved(
    nodeId: string,
    move: { parentId: string; oldParentId: string },
  ): Promise<BookmarkOrganizerStore | null> {
    if (move.parentId === move.oldParentId) return readBookmarkOrganizerStore();
    return this.enqueue(async () => {
      const { index } = await this.readIndex();
      const node = index.nodes.get(nodeId);
      return this.update((store) => {
        if (store.tracking.status !== 'tracking') return null;
        if (!node) {
          const candidates = withoutRemovedCandidates(store.candidates, nodeId);
          if (candidates === store.candidates) return null;
          return nextBookmarkOrganizerStore(store, {
            tracking: store.tracking,
            candidates,
            decisions: store.decisions,
            round: pruneRound(store, candidates),
          });
        }
        const movedWithinBookmarksBar = index.nodes.has(move.oldParentId);
        const type: BookmarkOrganizerChangeType =
          node.url != null || !movedWithinBookmarksBar ? 'moved' : 'ancestor-changed';
        const snapshots = node.url != null
          ? [index.bookmarks.get(node.id)].filter(
              (snapshot): snapshot is BookmarkSnapshot => snapshot !== undefined,
            )
          : [...index.bookmarks.values()].filter((snapshot) =>
              snapshot.folderPath.some((folder) => folder.id === node.id),
            );
        let candidates = store.candidates;
        const now = this.now();
        for (const snapshot of snapshots) {
          candidates = withCandidate(candidates, snapshot, [type], now);
        }
        if (candidates === store.candidates) return null;
        return nextBookmarkOrganizerStore(store, {
          tracking: store.tracking,
          candidates,
          decisions: store.decisions,
          round: store.round,
        });
      });
    });
  }

  async reconcileMoveUndo(nodeId: string): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const { index } = await this.readIndex();
      const snapshot = index.bookmarks.get(nodeId);
      if (!snapshot) throw new Error('撤销后的书签不在书签栏中');
      const next = await this.update((store) => {
        if (store.tracking.status !== 'tracking') return null;
        const existing = store.candidates[nodeId];
        const decision = store.decisions[nodeId];
        if (
          existing &&
          sameSnapshot(existing, snapshot) &&
          (!decision || decision.candidateRevision !== existing.revision)
        ) {
          return null;
        }
        const now = this.now();
        const candidates = existing
          ? {
              ...store.candidates,
              [nodeId]: {
                ...existing,
                ...snapshot,
                updatedAt: now,
                revision: existing.revision + 1,
                changeTypes: existing.changeTypes.includes('moved')
                  ? existing.changeTypes
                  : [...existing.changeTypes, 'moved' as const],
                suggestion: undefined,
              },
            }
          : withCandidate(store.candidates, snapshot, ['moved'], now);
        return nextBookmarkOrganizerStore(store, {
          tracking: store.tracking,
          candidates,
          decisions: store.decisions,
          round: store.round,
        });
      });
      if (!next) throw new Error('书签整理状态不可用');
      return next;
    });
  }

  async trackRemoved(nodeId: string): Promise<BookmarkOrganizerStore | null> {
    return this.enqueue(() =>
      this.update((store) => {
        const candidates = withoutRemovedCandidates(store.candidates, nodeId);
        if (candidates === store.candidates) return null;
        return nextBookmarkOrganizerStore(store, {
          tracking: store.tracking,
          candidates,
          decisions: store.decisions,
          round: pruneRound(store, candidates),
        });
      }),
    );
  }

  async startRound(): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const [stored, { index }] = await Promise.all([
        readBookmarkOrganizerStore(),
        this.readIndex(),
      ]);
      if (!stored) throw new Error('书签整理尚未建立基线');
      let candidates = stored.candidates;
      const now = this.now();
      for (const snapshot of index.bookmarks.values()) {
        if (
          candidates[snapshot.bookmarkId] === undefined &&
          snapshot.dateAdded != null &&
          snapshot.dateAdded > stored.tracking.baselineAt
        ) {
          candidates = withCandidate(candidates, snapshot, ['created'], now);
        }
      }
      if (stored.round?.candidateIds.length) {
        if (candidates === stored.candidates) return stored;
        const next = nextBookmarkOrganizerStore(stored, {
          tracking: stored.tracking,
          candidates,
          decisions: stored.decisions,
          round: stored.round,
        });
        await writeBookmarkOrganizerStore(next);
        return next;
      }
      const candidateIds = Object.keys(candidates);
      if (candidateIds.length === 0) {
        if (!stored.round) return stored;
        const next = nextBookmarkOrganizerStore(stored, {
          tracking: stored.tracking,
          candidates,
          decisions: stored.decisions,
          round: null,
        });
        await writeBookmarkOrganizerStore(next);
        return next;
      }
      const next = nextBookmarkOrganizerStore(stored, {
        tracking: stored.tracking,
        candidates,
        decisions: stored.decisions,
        round: {
          id: this.createRoundId(),
          startedAt: now,
          candidateIds,
          deferredBookmarkIds: [],
        },
      });
      await writeBookmarkOrganizerStore(next);
      return next;
    });
  }

  async deferInRound(bookmarkId: string): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const store = await readBookmarkOrganizerStore();
      if (!store?.round || !store.round.candidateIds.includes(bookmarkId)) {
        throw new Error('该书签不在当前整理轮次中');
      }
      if (store.round.deferredBookmarkIds.includes(bookmarkId)) return store;
      const next = nextBookmarkOrganizerStore(store, {
        tracking: store.tracking,
        candidates: store.candidates,
        decisions: store.decisions,
        round: {
          ...store.round,
          deferredBookmarkIds: [...store.round.deferredBookmarkIds, bookmarkId],
        },
      });
      await writeBookmarkOrganizerStore(next);
      return next;
    });
  }

  async completeCandidate(
    bookmarkId: string,
    expectedRevision: number,
    decision: BookmarkOrganizerDecision,
  ): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const store = await readBookmarkOrganizerStore();
      const candidate = store?.candidates[bookmarkId];
      if (
        !store ||
        !candidate ||
        !store.round?.candidateIds.includes(bookmarkId) ||
        store.round.deferredBookmarkIds.includes(bookmarkId) ||
        candidate.revision !== expectedRevision
      ) {
        throw new Error('该书签候选已发生变化');
      }
      const next = nextBookmarkOrganizerStore(store, {
        tracking: store.tracking,
        candidates: store.candidates,
        decisions: {
          ...store.decisions,
          [bookmarkId]: {
            candidateRevision: candidate.revision,
            decision,
            decidedAt: this.now(),
          },
        },
        round: store.round,
      });
      await writeBookmarkOrganizerStore(next);
      return next;
    });
  }

  async applySuggestions(
    suggestions: Array<{ bookmarkId: string; expectedRevision: number; suggestion: Omit<BookmarkOrganizerSuggestion, 'candidateRevision' | 'suggestedAt'> }>,
  ): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const store = await readBookmarkOrganizerStore();
      if (!store?.round || suggestions.length === 0) throw new Error('当前整理轮次不可用');
      const ids = new Set(suggestions.map((item) => item.bookmarkId));
      if (ids.size !== suggestions.length) throw new Error('建议候选不能重复');
      const pending = this.unsuggestedRoundCandidates(store);
      if (suggestions.length !== pending.length || suggestions.some((item) => !pending.includes(item.bookmarkId))) {
        throw new Error('候选已发生变化，请重新生成建议');
      }
      const candidates = { ...store.candidates };
      for (const item of suggestions) {
        const candidate = candidates[item.bookmarkId];
        if (!candidate || candidate.revision !== item.expectedRevision) {
          throw new Error('候选已发生变化，请重新生成建议');
        }
        candidates[item.bookmarkId] = { ...candidate, suggestion: { ...item.suggestion, candidateRevision: candidate.revision, suggestedAt: this.now() } };
      }
      const next = nextBookmarkOrganizerStore(store, { tracking: store.tracking, candidates, decisions: store.decisions, round: store.round });
      await writeBookmarkOrganizerStore(next);
      return next;
    });
  }

  async retrySuggestion(
    bookmarkId: string,
    expectedRevision: number,
    suggestion: Omit<BookmarkOrganizerSuggestion, 'candidateRevision' | 'suggestedAt'>,
  ): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const store = await readBookmarkOrganizerStore();
      const candidate = store?.candidates[bookmarkId];
      if (!store?.round || !candidate || candidate.revision !== expectedRevision || !candidate.suggestion || !this.currentRoundCandidates(store).includes(bookmarkId)) {
        throw new Error('候选已发生变化，请重新生成建议');
      }
      const candidates = { ...store.candidates, [bookmarkId]: { ...candidate, suggestion: { ...suggestion, candidateRevision: candidate.revision, suggestedAt: this.now() } } };
      const next = nextBookmarkOrganizerStore(store, { tracking: store.tracking, candidates, decisions: store.decisions, round: store.round });
      await writeBookmarkOrganizerStore(next);
      return next;
    });
  }

  private currentRoundCandidates(store: BookmarkOrganizerStore): string[] {
    if (!store.round) return [];
    return store.round.candidateIds.filter((id) => {
      const candidate = store.candidates[id];
      return !store.round?.deferredBookmarkIds.includes(id) && store.decisions[id]?.candidateRevision !== candidate?.revision;
    });
  }

  private unsuggestedRoundCandidates(store: BookmarkOrganizerStore): string[] {
    return this.currentRoundCandidates(store).filter((id) => {
      const candidate = store.candidates[id];
      return candidate?.suggestion?.candidateRevision !== candidate?.revision;
    });
  }

  async completeRound(): Promise<BookmarkOrganizerStore> {
    return this.enqueue(async () => {
      const store = await readBookmarkOrganizerStore();
      if (!store?.round) throw new Error('当前没有进行中的整理轮次');
      const pending = store.round.candidateIds.filter(
        (id) => {
          if (store.round?.deferredBookmarkIds.includes(id)) return false;
          const candidate = store.candidates[id];
          return store.decisions[id]?.candidateRevision !== candidate?.revision;
        },
      );
      if (pending.length > 0) throw new Error('当前整理轮次仍有待处理书签');
      const handledIds = store.round.candidateIds.filter((id) => {
        const candidate = store.candidates[id];
        return store.decisions[id]?.candidateRevision === candidate?.revision;
      });
      const candidates = { ...store.candidates };
      const decisions = { ...store.decisions };
      for (const id of handledIds) {
        delete candidates[id];
        delete decisions[id];
      }
      const next = nextBookmarkOrganizerStore(store, {
        tracking: {
          ...store.tracking,
          baselineAt: this.now(),
        },
        candidates,
        decisions,
        round: null,
      });
      await writeBookmarkOrganizerStore(next);
      return next;
    });
  }

  async getCurrentRoundCandidateIds(): Promise<string[]> {
    const store = await readBookmarkOrganizerStore();
    if (!store?.round) return [];
    return this.currentRoundCandidates(store);
  }
}
