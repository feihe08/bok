import { deleteBookmarkNode, moveBookmarkNode, readBookmarksBar } from './api';
import type { BookmarkNode } from './model';
import type { BookmarkOrganizerCommand, BookmarkOrganizerExpectedCandidate } from './organizer-messages';
import { getBookmarkOrganizationAiSettings } from './organization-ai-settings';
import { BookmarkOrganizer } from './organizer';
import {
  requestBookmarkOrganizerSuggestions,
  retryBookmarkOrganizerSuggestion,
  type BookmarkOrganizerSuggestionCandidate,
} from './organizer-responses';
import { readBookmarkOrganizerStore, type BookmarkOrganizerCandidate, type BookmarkOrganizerFolder, type BookmarkOrganizerStore } from './organizer-storage';

type Mutation = { type: 'move'; targetParentId: string } | { type: 'remove' };

export class BookmarkOrganizerMutationSuppressor {
  private pending = new Map<string, { mutation: Mutation; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly timeoutMs = 5_000) {}

  expect(bookmarkId: string, mutation: Mutation): () => void {
    this.cancel(bookmarkId);
    const timer = setTimeout(() => this.pending.delete(bookmarkId), this.timeoutMs);
    this.pending.set(bookmarkId, { mutation, timer });
    return () => this.cancel(bookmarkId);
  }

  consumeMove(bookmarkId: string, parentId: string): boolean {
    const item = this.pending.get(bookmarkId);
    if (item?.mutation.type !== 'move' || item.mutation.targetParentId !== parentId) return false;
    this.cancel(bookmarkId);
    return true;
  }

  consumeRemove(bookmarkId: string): boolean {
    const item = this.pending.get(bookmarkId);
    if (item?.mutation.type !== 'remove') return false;
    this.cancel(bookmarkId);
    return true;
  }

  cancel(bookmarkId: string): void {
    const item = this.pending.get(bookmarkId);
    if (item) clearTimeout(item.timer);
    this.pending.delete(bookmarkId);
  }
}

interface OrganizerOperationsDependencies {
  organizer: BookmarkOrganizer;
  suppressor: BookmarkOrganizerMutationSuppressor;
  readBookmarksBar: typeof readBookmarksBar;
  readStore: typeof readBookmarkOrganizerStore;
  moveBookmarkNode: typeof moveBookmarkNode;
  deleteBookmarkNode: typeof deleteBookmarkNode;
  getAiSettings: typeof getBookmarkOrganizationAiSettings;
  requestAiSuggestions: typeof requestBookmarkOrganizerSuggestions;
  retryAiSuggestion: typeof retryBookmarkOrganizerSuggestion;
}

function indexTree(root: BookmarkNode): Map<string, BookmarkNode> {
  const result = new Map<string, BookmarkNode>();
  const walk = (node: BookmarkNode) => {
    result.set(node.id, node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return result;
}

function folderPathFor(node: BookmarkNode, index: Map<string, BookmarkNode>): BookmarkOrganizerFolder[] {
  const result: BookmarkOrganizerFolder[] = [];
  let current = node.parentId ? index.get(node.parentId) : undefined;
  while (current) {
    result.unshift({ id: current.id, title: current.title });
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  return result;
}

function samePath(left: BookmarkOrganizerFolder[], right: BookmarkOrganizerFolder[]): boolean {
  return left.length === right.length && left.every((folder, i) =>
    folder.id === right[i]?.id && folder.title === right[i]?.title);
}

function assertSnapshot(candidate: BookmarkOrganizerCandidate, node: BookmarkNode, path: BookmarkOrganizerFolder[], expected: BookmarkOrganizerExpectedCandidate): void {
  if (candidate.title !== expected.title || candidate.url !== expected.url ||
    candidate.parentId !== expected.parentId || !samePath(candidate.folderPath, expected.folderPath) ||
    node.title !== expected.title || node.url !== expected.url || node.parentId !== expected.parentId ||
    !samePath(path, expected.folderPath)) throw new Error('该书签候选已发生变化，请刷新后重试');
}

function isManaged(node: BookmarkNode, index: Map<string, BookmarkNode>): boolean {
  let current: BookmarkNode | undefined = node;
  while (current) {
    if (current.folderType === 'managed' || current.unmodifiable != null) return true;
    current = current.parentId ? index.get(current.parentId) : undefined;
  }
  return false;
}

function directoryName(path: BookmarkOrganizerFolder[]): string {
  return path.map((folder) => folder.title).join(' / ') || '书签栏';
}

function folderDirectory(node: BookmarkNode, index: Map<string, BookmarkNode>): string {
  return directoryName([...folderPathFor(node, index), { id: node.id, title: node.title }]);
}

function assertLiveCandidate(
  candidate: BookmarkOrganizerCandidate,
  index: Map<string, BookmarkNode>,
): void {
  const node = index.get(candidate.bookmarkId);
  if (!node || node.url == null) throw new Error('该书签已不存在或类型已变化');
  assertSnapshot(candidate, node, folderPathFor(node, index), {
    title: candidate.title,
    url: candidate.url,
    parentId: candidate.parentId,
    folderPath: candidate.folderPath,
  });
}

function suggestionCandidate(
  candidate: BookmarkOrganizerCandidate,
  id: string,
): BookmarkOrganizerSuggestionCandidate {
  return {
    id,
    title: candidate.title,
    url: candidate.url,
    currentDirectory: directoryName(candidate.folderPath),
    changeTypes: candidate.changeTypes,
    ...(candidate.dateAdded === undefined ? {} : { dateAdded: candidate.dateAdded }),
    ...(candidate.dateLastUsed === undefined ? {} : { dateLastUsed: candidate.dateLastUsed }),
  };
}

function existingDirectories(
  root: BookmarkNode,
  index: Map<string, BookmarkNode>,
): string[] {
  return [...new Set(
    [...index.values()]
      .filter((node) => node.url == null && !isManaged(node, index))
      .filter((node) =>
        node.id === root.id ||
        folderPathFor(node, index).some((folder) => folder.id === root.id))
      .map((node) => folderDirectory(node, index)),
  )];
}

export function createBookmarkOrganizerOperations(overrides: Partial<OrganizerOperationsDependencies> = {}) {
  const dependencies: OrganizerOperationsDependencies = {
    organizer: new BookmarkOrganizer(), suppressor: new BookmarkOrganizerMutationSuppressor(),
    readBookmarksBar, readStore: readBookmarkOrganizerStore, moveBookmarkNode, deleteBookmarkNode,
    getAiSettings: getBookmarkOrganizationAiSettings,
    requestAiSuggestions: requestBookmarkOrganizerSuggestions,
    retryAiSuggestion: retryBookmarkOrganizerSuggestion,
    ...overrides,
  };

  async function current(command: Extract<BookmarkOrganizerCommand, { type: 'bok/bookmark-organizer/decide' }>) {
    const [store, bar] = await Promise.all([dependencies.readStore(), dependencies.readBookmarksBar()]);
    if (!store?.round || store.round.id !== command.roundId || !store.round.candidateIds.includes(command.bookmarkId)) throw new Error('整理轮次已发生变化');
    const candidate = store.candidates[command.bookmarkId];
    if (!candidate || candidate.revision !== command.expectedRevision || store.round.deferredBookmarkIds.includes(command.bookmarkId) ||
      store.decisions[command.bookmarkId]?.candidateRevision === candidate.revision) throw new Error('该书签候选已发生变化，请刷新后重试');
    const index = indexTree(bar);
    const node = index.get(command.bookmarkId);
    if (!node || node.url == null) throw new Error('该书签已不存在或类型已变化');
    assertSnapshot(candidate, node, folderPathFor(node, index), command.expected);
    return { store, bar, index, candidate, node };
  }

  async function decide(command: Extract<BookmarkOrganizerCommand, { type: 'bok/bookmark-organizer/decide' }>) {
    const state = await current(command);
    let action = command.action;
    let destinationId = 'destinationId' in command ? command.destinationId : undefined;
    if (action === 'accept-suggestion') {
      const suggestion = state.candidate.suggestion;
      if (!suggestion || suggestion.candidateRevision !== state.candidate.revision) throw new Error('当前候选没有可接受的本地建议');
      if (suggestion.retention === 'unsure') throw new Error('不确定建议必须由你手动决定');
      if (suggestion.retention === 'discard') action = 'remove';
      else {
        const currentDirectory = directoryName(state.candidate.folderPath);
        if (suggestion.directory === currentDirectory) action = 'keep-current';
        else {
          const matches = [...state.index.values()].filter((node) =>
            node.url == null && !isManaged(node, state.index) &&
            folderDirectory(node, state.index) === suggestion.directory);
          if (matches.length !== 1) throw new Error(matches.length === 0 ? '建议目录已不存在，请手动选择' : '建议目录名称不唯一，请手动选择');
          action = 'move'; destinationId = matches[0]!.id;
        }
      }
    }
    if (action === 'defer') {
      const next = await dependencies.organizer.deferInRound(command.bookmarkId);
      return { store: next, canUndo: false };
    }
    if (action === 'keep-current') {
      const next = await dependencies.organizer.completeCandidate(command.bookmarkId, command.expectedRevision, 'keep');
      return { store: next, canUndo: false };
    }
    if (action === 'move') {
      const destination = destinationId ? state.index.get(destinationId) : undefined;
      if (!destination || destination.url != null || isManaged(destination, state.index)) throw new Error('目标必须是书签栏内现有且可修改的目录');
      if (destination.id !== state.bar.id && !folderPathFor(destination, state.index).some((folder) => folder.id === state.bar.id)) throw new Error('目标目录不在当前书签栏');
      if (destination.id === state.node.parentId) {
        const next = await dependencies.organizer.completeCandidate(command.bookmarkId, command.expectedRevision, 'keep');
        return { store: next, canUndo: false };
      }
      const cancel = dependencies.suppressor.expect(command.bookmarkId, { type: 'move', targetParentId: destination.id });
      let canUndo: boolean;
      try { canUndo = await dependencies.moveBookmarkNode(state.node, { parentId: destination.id }); } catch (error) { cancel(); throw error; }
      try {
        const next = await dependencies.organizer.completeCandidate(command.bookmarkId, command.expectedRevision, 'keep');
        return { store: next, canUndo };
      } catch (error) {
        await dependencies.organizer.trackMoved(command.bookmarkId, { parentId: destination.id, oldParentId: state.node.parentId! }).catch(() => undefined);
        throw error;
      }
    }
    const cancel = dependencies.suppressor.expect(command.bookmarkId, { type: 'remove' });
    let canUndo: boolean;
    try { canUndo = await dependencies.deleteBookmarkNode(state.node); } catch (error) { cancel(); throw error; }
    try {
      const next = await dependencies.organizer.completeCandidate(command.bookmarkId, command.expectedRevision, 'remove');
      return { store: next, canUndo };
    } catch (error) {
      await dependencies.organizer.trackRemoved(command.bookmarkId).catch(() => undefined);
      throw error;
    }
  }

  async function generateSuggestions(
    command: Extract<BookmarkOrganizerCommand, { type: 'bok/bookmark-organizer/generate-suggestions' }>,
  ) {
    const [settings, store, bar] = await Promise.all([
      dependencies.getAiSettings(),
      dependencies.readStore(),
      dependencies.readBookmarksBar(),
    ]);
    if (!settings) throw new Error('请先在设置中配置书签整理 AI');
    if (!store?.round || store.round.id !== command.roundId) {
      throw new Error('整理轮次已发生变化');
    }

    const candidates = store.round.candidateIds
      .map((bookmarkId) => store.candidates[bookmarkId])
      .filter((candidate): candidate is BookmarkOrganizerCandidate =>
        Boolean(candidate) &&
        !store.round?.deferredBookmarkIds.includes(candidate.bookmarkId) &&
        store.decisions[candidate.bookmarkId]?.candidateRevision !== candidate.revision &&
        candidate.suggestion?.candidateRevision !== candidate.revision);
    if (candidates.length === 0) throw new Error('当前没有需要生成 AI 建议的书签');

    const index = indexTree(bar);
    candidates.forEach((candidate) => assertLiveCandidate(candidate, index));
    const requestCandidates = candidates.map((candidate, index) =>
      suggestionCandidate(candidate, `candidate-${index + 1}`));
    const suggestions = await dependencies.requestAiSuggestions(settings, {
      candidates: requestCandidates,
      existingDirectories: existingDirectories(bar, index),
      preference: settings.preference,
    });

    const latestIndex = indexTree(await dependencies.readBookmarksBar());
    candidates.forEach((candidate) => assertLiveCandidate(candidate, latestIndex));
    const candidateByRequestId = new Map(
      requestCandidates.map((requestCandidate, index) => [
        requestCandidate.id,
        candidates[index]!,
      ]),
    );
    const next = await dependencies.organizer.applySuggestions(
      suggestions.map((suggestion) => {
        const candidate = candidateByRequestId.get(suggestion.id);
        if (!candidate) throw new Error('AI 建议包含未知候选');
        return {
          bookmarkId: candidate.bookmarkId,
          expectedRevision: candidate.revision,
          suggestion: {
            retention: suggestion.retention,
            directory: suggestion.directory,
            reason: suggestion.reason,
          },
        };
      }),
    );
    return { store: next, canUndo: false };
  }

  async function retrySuggestion(
    command: Extract<BookmarkOrganizerCommand, { type: 'bok/bookmark-organizer/retry-suggestion' }>,
  ) {
    const [settings, store, bar] = await Promise.all([
      dependencies.getAiSettings(),
      dependencies.readStore(),
      dependencies.readBookmarksBar(),
    ]);
    if (!settings) throw new Error('请先在设置中配置书签整理 AI');
    if (!store?.round || store.round.id !== command.roundId ||
      !store.round.candidateIds.includes(command.bookmarkId) ||
      store.round.deferredBookmarkIds.includes(command.bookmarkId)) {
      throw new Error('整理轮次已发生变化');
    }
    const candidate = store.candidates[command.bookmarkId];
    if (!candidate || candidate.revision !== command.expectedRevision ||
      store.decisions[command.bookmarkId]?.candidateRevision === candidate.revision) {
      throw new Error('该书签候选已发生变化，请刷新后重试');
    }
    const previousSuggestion = candidate.suggestion;
    if (!previousSuggestion || previousSuggestion.candidateRevision !== candidate.revision) {
      throw new Error('当前候选没有可重试的 AI 建议');
    }
    const index = indexTree(bar);
    const node = index.get(command.bookmarkId);
    if (!node || node.url == null) throw new Error('该书签已不存在或类型已变化');
    assertSnapshot(candidate, node, folderPathFor(node, index), command.expected);

    const requestCandidate = suggestionCandidate(candidate, 'candidate-1');
    const suggestion = await dependencies.retryAiSuggestion(settings, {
      candidate: requestCandidate,
      existingDirectories: existingDirectories(bar, index),
      preference: settings.preference,
      previousSuggestion: {
        retention: previousSuggestion.retention,
        directory: previousSuggestion.directory,
        reason: previousSuggestion.reason,
      },
    });

    assertLiveCandidate(candidate, indexTree(await dependencies.readBookmarksBar()));
    const next = await dependencies.organizer.retrySuggestion(
      command.bookmarkId,
      command.expectedRevision,
      {
        retention: suggestion.retention,
        directory: suggestion.directory,
        reason: suggestion.reason,
      },
    );
    return { store: next, canUndo: false };
  }

  return {
    suppressor: dependencies.suppressor,
    async execute(command: BookmarkOrganizerCommand): Promise<unknown> {
      if (command.type === 'bok/bookmark-organizer/start-round') return dependencies.organizer.startRound();
      if (command.type === 'bok/bookmark-organizer/resume-round') {
        const store = await dependencies.readStore();
        if (!store?.round) throw new Error('当前没有进行中的整理轮次');
        return store;
      }
      if (command.type === 'bok/bookmark-organizer/reconcile-move-undo') {
        const store = await dependencies.organizer.reconcileMoveUndo(command.bookmarkId);
        return { store, canUndo: false };
      }
      if (command.type === 'bok/bookmark-organizer/finish-round') {
        const store = await dependencies.readStore();
        if (!store?.round || store.round.id !== command.roundId) throw new Error('整理轮次已发生变化');
        return dependencies.organizer.completeRound();
      }
      if (command.type === 'bok/bookmark-organizer/generate-suggestions') {
        return generateSuggestions(command);
      }
      if (command.type === 'bok/bookmark-organizer/retry-suggestion') {
        return retrySuggestion(command);
      }
      return decide(command);
    },
  };
}
