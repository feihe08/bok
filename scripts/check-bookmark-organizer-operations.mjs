import assert from 'node:assert/strict';
import { isBookmarkOrganizerCommand, isBookmarkOrganizerCommandMessage } from '../libs/bookmarks/organizer-messages.ts';
import { BookmarkOrganizerMutationSuppressor, createBookmarkOrganizerOperations } from '../libs/bookmarks/organizer-operations.ts';

const expected = {
  title: 'Candidate', url: 'https://candidate.example', parentId: 'inbox',
  folderPath: [{ id: '1', title: 'Bookmarks Bar' }, { id: 'inbox', title: 'Inbox' }],
};
const candidate = {
  bookmarkId: 'candidate', firstDetectedAt: 1, updatedAt: 1, revision: 2,
  changeTypes: ['created'], ...expected,
};
const tree = {
  id: '1', title: 'Bookmarks Bar', folderType: 'bookmarks-bar', children: [
    { id: 'inbox', title: 'Inbox', parentId: '1', children: [
      { id: 'candidate', title: 'Candidate', url: 'https://candidate.example', parentId: 'inbox', index: 0 },
    ] },
    { id: 'target', title: 'Target', parentId: '1', children: [] },
    { id: 'duplicate-a', title: 'Duplicate', parentId: '1', children: [] },
    { id: 'duplicate-b', title: 'Duplicate', parentId: '1', children: [] },
    { id: 'managed', title: 'Managed', parentId: '1', folderType: 'managed', children: [] },
  ],
};
function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}
function store(overrides = {}) {
  return {
    schemaVersion: 1, kind: 'bok-bookmark-organizer', revision: 3,
    tracking: { bookmarksBarId: '1', baselineAt: 0, status: 'tracking', gap: null },
    candidates: { candidate: { ...candidate, ...overrides } }, decisions: {},
    round: { id: 'round', startedAt: 1, candidateIds: ['candidate'], deferredBookmarkIds: [] },
  };
}
function command(action, extra = {}) {
  return { type: 'bok/bookmark-organizer/decide', action, roundId: 'round', bookmarkId: 'candidate', expectedRevision: 2, expected, ...extra };
}

assert.equal(isBookmarkOrganizerCommand(command('keep-current')), true);
assert.equal(isBookmarkOrganizerCommand({ ...command('keep-current'), extra: true }), false);
assert.equal(isBookmarkOrganizerCommandMessage({ ...command('keep-current'), extra: true }), true);
assert.equal(isBookmarkOrganizerCommand(command('move', { destinationId: 'target' })), true);
assert.equal(isBookmarkOrganizerCommand({
  type: 'bok/bookmark-organizer/generate-suggestions', roundId: 'round',
}), true);
assert.equal(isBookmarkOrganizerCommand({
  type: 'bok/bookmark-organizer/generate-suggestions', roundId: 'round', extra: true,
}), false);
assert.equal(isBookmarkOrganizerCommand({
  type: 'bok/bookmark-organizer/retry-suggestion', roundId: 'round',
  bookmarkId: 'candidate', expectedRevision: 2, expected,
}), true);

const suppressor = new BookmarkOrganizerMutationSuppressor(1000);
suppressor.expect('candidate', { type: 'move', targetParentId: 'target' });
assert.equal(suppressor.consumeMove('candidate', 'wrong'), false);
assert.equal(suppressor.consumeRemove('candidate'), false);
assert.equal(suppressor.consumeMove('candidate', 'target'), true);
assert.equal(suppressor.consumeMove('candidate', 'target'), false);
suppressor.expect('candidate', { type: 'remove' });
assert.equal(suppressor.consumeRemove('candidate'), true);

async function harness(currentStore = store(), { moveCanUndo = true, deleteCanUndo = true } = {}) {
  const calls = [];
  const organizer = {
    startRound: async () => currentStore,
    deferInRound: async () => (calls.push('defer'), currentStore),
    completeCandidate: async (_id, _revision, decision) => (calls.push(decision), currentStore),
    completeRound: async () => currentStore,
    reconcileMoveUndo: async () => (calls.push('reconcile-move-undo'), currentStore),
    trackMoved: async () => currentStore,
    trackRemoved: async () => currentStore,
  };
  const operations = createBookmarkOrganizerOperations({
    organizer,
    readStore: async () => currentStore,
    readBookmarksBar: async () => structuredClone(tree),
    moveBookmarkNode: async (_node, destination) => {
      calls.push(`move:${destination.parentId}`);
      return moveCanUndo;
    },
    deleteBookmarkNode: async () => {
      calls.push('delete');
      return deleteCanUndo;
    },
  });
  return { operations, calls };
}
{
  const move = await harness(store(), { moveCanUndo: false });
  assert.equal((await move.operations.execute(command('move', { destinationId: 'target' }))).canUndo, false);
  assert.deepEqual(move.calls, ['move:target', 'keep']);
  const remove = await harness(store(), { deleteCanUndo: false });
  assert.equal((await remove.operations.execute(command('remove'))).canUndo, false);
  assert.deepEqual(remove.calls, ['delete', 'remove']);
}
{
  const { operations, calls } = await harness();
  assert.equal((await operations.execute({
    type: 'bok/bookmark-organizer/reconcile-move-undo',
    bookmarkId: 'candidate',
  })).canUndo, false);
  assert.deepEqual(calls, ['reconcile-move-undo']);
}

{
  const { operations } = await harness();
  await assert.rejects(operations.execute({ ...command('keep-current'), expectedRevision: 1 }), /发生变化/);
  await assert.rejects(operations.execute({ ...command('keep-current'), expected: { ...expected, title: 'Old' } }), /发生变化/);
}
{
  const { operations } = await harness();
  assert.equal((await operations.execute(command('keep-current'))).canUndo, false);
  assert.equal((await operations.execute(command('defer'))).canUndo, false);
  assert.equal((await operations.execute(command('move', { destinationId: 'target' }))).canUndo, true);
  await assert.rejects(operations.execute(command('move', { destinationId: 'managed' })), /可修改/);
  await assert.rejects(operations.execute(command('move', { destinationId: 'missing' })), /可修改/);
  assert.equal((await operations.execute(command('remove'))).canUndo, true);
}
{
  const { operations, calls } = await harness();
  assert.equal((await operations.execute(command('move', { destinationId: 'inbox' }))).canUndo, false);
  assert.deepEqual(calls, ['keep']);
}
{
  const unsure = await harness(store({ suggestion: { candidateRevision: 2, retention: 'unsure', directory: null, reason: '', suggestedAt: 2 } }));
  await assert.rejects(unsure.operations.execute(command('accept-suggestion')), /手动决定/);
  const duplicate = await harness(store({ suggestion: { candidateRevision: 2, retention: 'keep', directory: 'Bookmarks Bar / Duplicate', reason: '', suggestedAt: 2 } }));
  await assert.rejects(duplicate.operations.execute(command('accept-suggestion')), /不唯一/);
  const discard = await harness(store({ suggestion: { candidateRevision: 2, retention: 'discard', directory: null, reason: '', suggestedAt: 2 } }));
  assert.equal((await discard.operations.execute(command('accept-suggestion'))).canUndo, true);
  assert.deepEqual(discard.calls, ['delete', 'remove']);
}

const aiSettings = {
  schemaVersion: 1,
  endpoint: 'https://api.example.com/v1/responses',
  apiKey: 'key',
  model: 'model',
  preference: '优先保留技术资料。',
};

function createAiHarness({
  currentStore = store(),
  configured = true,
  changeDuringRequest = false,
  requestFailure = false,
  retryFailure = false,
} = {}) {
  const currentTree = structuredClone(tree);
  const calls = { apply: [], retry: [], requests: [], retryRequests: [] };
  const organizer = {
    applySuggestions: async (suggestions) => {
      calls.apply.push(suggestions);
      return currentStore;
    },
    retrySuggestion: async (bookmarkId, expectedRevision, suggestion) => {
      calls.retry.push({ bookmarkId, expectedRevision, suggestion });
      return currentStore;
    },
  };
  const operations = createBookmarkOrganizerOperations({
    organizer,
    readStore: async () => currentStore,
    readBookmarksBar: async () => structuredClone(currentTree),
    getAiSettings: async () => configured ? aiSettings : null,
    requestAiSuggestions: async (settings, request) => {
      calls.requests.push({ settings, request });
      if (requestFailure) throw new Error('request failed');
      if (changeDuringRequest) findNode(currentTree, 'candidate').title = 'Changed during request';
      return [{
        id: 'candidate-1', retention: 'keep',
        directory: 'Bookmarks Bar / Target', reason: '更适合目标目录。',
      }];
    },
    retryAiSuggestion: async (settings, request) => {
      calls.retryRequests.push({ settings, request });
      if (retryFailure) throw new Error('retry failed');
      return {
        id: 'candidate-1', retention: 'unsure', directory: null,
        reason: '需要你进一步判断。',
      };
    },
  });
  return { operations, calls };
}

{
  const { operations, calls } = createAiHarness();
  const result = await operations.execute({
    type: 'bok/bookmark-organizer/generate-suggestions', roundId: 'round',
  });
  assert.equal(result.canUndo, false);
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.requests[0].settings, aiSettings);
  assert.deepEqual(calls.requests[0].request.candidates, [{
    id: 'candidate-1',
    title: 'Candidate',
    url: 'https://candidate.example',
    currentDirectory: 'Bookmarks Bar / Inbox',
    changeTypes: ['created'],
  }]);
  assert.deepEqual(calls.requests[0].request.existingDirectories, [
    'Bookmarks Bar',
    'Bookmarks Bar / Inbox',
    'Bookmarks Bar / Target',
    'Bookmarks Bar / Duplicate',
  ]);
  assert.equal(calls.requests[0].request.preference, aiSettings.preference);
  assert.deepEqual(calls.apply, [[{
    bookmarkId: 'candidate',
    expectedRevision: 2,
    suggestion: {
      retention: 'keep',
      directory: 'Bookmarks Bar / Target',
      reason: '更适合目标目录。',
    },
  }]]);
}
{
  const retryStore = store({
    suggestion: {
      candidateRevision: 2,
      retention: 'keep',
      directory: 'Bookmarks Bar / Inbox',
      reason: '原建议。',
      suggestedAt: 2,
    },
  });
  const { operations, calls } = createAiHarness({ currentStore: retryStore });
  const result = await operations.execute({
    type: 'bok/bookmark-organizer/retry-suggestion',
    roundId: 'round', bookmarkId: 'candidate', expectedRevision: 2, expected,
  });
  assert.equal(result.canUndo, false);
  assert.deepEqual(calls.retryRequests[0].request.previousSuggestion, {
    retention: 'keep', directory: 'Bookmarks Bar / Inbox', reason: '原建议。',
  });
  assert.deepEqual(calls.retry, [{
    bookmarkId: 'candidate',
    expectedRevision: 2,
    suggestion: {
      retention: 'unsure', directory: null, reason: '需要你进一步判断。',
    },
  }]);
}
{
  const { operations } = createAiHarness({ configured: false });
  await assert.rejects(
    operations.execute({
      type: 'bok/bookmark-organizer/generate-suggestions', roundId: 'round',
    }),
    /请先在设置中配置/,
  );
}
{
  const { operations, calls } = createAiHarness({ changeDuringRequest: true });
  await assert.rejects(
    operations.execute({
      type: 'bok/bookmark-organizer/generate-suggestions', roundId: 'round',
    }),
    /发生变化/,
  );
  assert.deepEqual(calls.apply, []);
}
{
  const { operations, calls } = createAiHarness({ requestFailure: true });
  await assert.rejects(
    operations.execute({
      type: 'bok/bookmark-organizer/generate-suggestions', roundId: 'round',
    }),
    /request failed/,
  );
  assert.deepEqual(calls.apply, []);
}
{
  const retryStore = store({
    suggestion: {
      candidateRevision: 2,
      retention: 'keep',
      directory: 'Bookmarks Bar / Inbox',
      reason: '继续保留的原建议。',
      suggestedAt: 2,
    },
  });
  const { operations, calls } = createAiHarness({
    currentStore: retryStore,
    retryFailure: true,
  });
  await assert.rejects(
    operations.execute({
      type: 'bok/bookmark-organizer/retry-suggestion',
      roundId: 'round', bookmarkId: 'candidate', expectedRevision: 2, expected,
    }),
    /retry failed/,
  );
  assert.deepEqual(calls.retry, []);
  assert.equal(retryStore.candidates.candidate.suggestion.reason, '继续保留的原建议。');
}

console.log('bookmark organizer operation checks passed');
