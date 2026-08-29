import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;
fakeBrowser.runtime.getURL = (path) => `chrome-extension://bok${path}`;

let bookmarksBar = {
  id: '1',
  title: 'Bookmarks Bar',
  folderType: 'bookmarks-bar',
  children: [
    {
      id: 'inbox',
      title: 'Inbox',
      parentId: '1',
      children: [],
    },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function removeNode(node, id) {
  if (!node.children) return false;
  const index = node.children.findIndex((child) => child.id === id);
  if (index >= 0) {
    node.children.splice(index, 1);
    return true;
  }
  return node.children.some((child) => removeNode(child, id));
}

fakeBrowser.bookmarks.getChildren = async (id) =>
  id === '0' ? [clone(bookmarksBar)] : clone(findNode(bookmarksBar, id)?.children ?? []);
fakeBrowser.bookmarks.getSubTree = async (id) => {
  const node = findNode(bookmarksBar, id);
  return node ? [clone(node)] : [];
};

const {
  BookmarkOrganizer,
} = await import('../libs/bookmarks/organizer.ts');
const {
  BOOKMARK_ORGANIZER_STATE_KEY,
  readBookmarkOrganizerStore,
} = await import('../libs/bookmarks/organizer-storage.ts');

let now = 1_000;
const organizer = new BookmarkOrganizer({
  now: () => now,
  createRoundId: () => 'round-1',
});

const baseline = await organizer.initialize();
assert.equal(baseline.tracking.status, 'tracking');
assert.deepEqual(baseline.candidates, {});
assert.equal((await organizer.startRound()).round, null);

bookmarksBar.children[0].children.push({
  id: 'baseline-date',
  title: 'Not newer than baseline',
  url: 'https://baseline-date.example',
  parentId: 'inbox',
  dateAdded: 1_000,
});
bookmarksBar.children[0].children.push({
  id: 'missed-created-event',
  title: 'Recovered from dateAdded',
  url: 'https://missed-created-event.example',
  parentId: 'inbox',
  dateAdded: 1_001,
});
let store = await organizer.startRound();
assert.deepEqual(store.round.candidateIds, ['missed-created-event']);
assert.deepEqual(store.candidates['missed-created-event'].changeTypes, ['created']);
assert.equal(store.candidates['baseline-date'], undefined);
removeNode(bookmarksBar, 'missed-created-event');
await organizer.trackRemoved('missed-created-event');
assert.equal((await organizer.startRound()).round, null);

await fakeBrowser.storage.local.set({
  [BOOKMARK_ORGANIZER_STATE_KEY]: {
    ...baseline,
    round: {
      id: 'legacy-empty-round',
      startedAt: now,
      candidateIds: [],
      deferredBookmarkIds: [],
    },
  },
});

bookmarksBar.children[0].children.push({
  id: 'bookmark-1',
  title: 'Initial title',
  url: 'https://initial.example',
  parentId: 'inbox',
  dateAdded: 1_001,
  dateLastUsed: 20,
});
now += 1;
await organizer.trackCreated('bookmark-1');
store = await readBookmarkOrganizerStore();
assert.deepEqual(store.candidates['bookmark-1'], {
  bookmarkId: 'bookmark-1',
  firstDetectedAt: 1_001,
  updatedAt: 1_001,
  revision: 1,
  changeTypes: ['created'],
  title: 'Initial title',
  url: 'https://initial.example',
  dateAdded: 1_001,
  dateLastUsed: 20,
  parentId: 'inbox',
  folderPath: [
    { id: '1', title: 'Bookmarks Bar' },
    { id: 'inbox', title: 'Inbox' },
  ],
});
store = await organizer.startRound();
assert.deepEqual(store.round.candidateIds, ['bookmark-1']);

bookmarksBar.children[0].children.push({
  id: 'missed-during-round',
  title: 'Recovered after round cutoff',
  url: 'https://missed-during-round.example',
  parentId: 'inbox',
  dateAdded: 1_002,
});
store = await organizer.startRound();
assert.ok(store.candidates['missed-during-round']);
assert.deepEqual(store.round.candidateIds, ['bookmark-1']);
removeNode(bookmarksBar, 'missed-during-round');
await organizer.trackRemoved('missed-during-round');

await organizer.completeCandidate('bookmark-1', 1, 'keep');
findNode(bookmarksBar, 'bookmark-1').dateLastUsed = 21;
store = await organizer.startRound();
assert.equal(store.candidates['bookmark-1'].revision, 1);
assert.equal(store.decisions['bookmark-1'].candidateRevision, 1);
assert.deepEqual(store.round.candidateIds, ['bookmark-1']);
await fakeBrowser.storage.local.set({
  [BOOKMARK_ORGANIZER_STATE_KEY]: { ...store, decisions: {}, round: null },
});

const bookmarkOne = findNode(bookmarksBar, 'bookmark-1');
bookmarkOne.title = 'Updated title';
bookmarkOne.url = 'https://updated.example';
now += 1;
await organizer.trackChanged('bookmark-1', {
  title: bookmarkOne.title,
  url: bookmarkOne.url,
});
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['bookmark-1'].firstDetectedAt, 1_001);
assert.equal(store.candidates['bookmark-1'].updatedAt, 1_002);
assert.equal(store.candidates['bookmark-1'].revision, 2);
assert.deepEqual(store.candidates['bookmark-1'].changeTypes, [
  'created',
  'title-changed',
  'url-changed',
]);

await organizer.trackMoved('bookmark-1', { parentId: 'inbox', oldParentId: 'inbox' });
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['bookmark-1'].revision, 2);

bookmarksBar.children.push({
  id: 'project',
  title: 'Project',
  parentId: '1',
  children: [
    {
      id: 'bookmark-2',
      title: 'Nested',
      url: 'https://nested.example',
      parentId: 'project',
    },
  ],
});
now += 1;
await organizer.trackCreated('project');
store = await readBookmarkOrganizerStore();
assert.deepEqual(store.candidates['bookmark-2'].changeTypes, ['created']);

findNode(bookmarksBar, 'project').title = 'Renamed project';
now += 1;
await organizer.trackChanged('project', { title: 'Renamed project' });
store = await readBookmarkOrganizerStore();
assert.deepEqual(store.candidates['bookmark-2'].changeTypes, [
  'created',
  'ancestor-changed',
]);
assert.equal(
  store.candidates['bookmark-2'].folderPath.at(-1).title,
  'Renamed project',
);

const projectIndex = bookmarksBar.children.findIndex((node) => node.id === 'project');
const [project] = bookmarksBar.children.splice(projectIndex, 1);
project.parentId = 'inbox';
bookmarksBar.children[0].children.push(project);
now += 1;
await organizer.trackMoved('project', { parentId: 'inbox', oldParentId: '1' });
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['bookmark-2'].revision, 3);
assert.deepEqual(store.candidates['bookmark-2'].folderPath.map((folder) => folder.id), [
  '1',
  'inbox',
  'project',
]);

removeNode(bookmarksBar, 'bookmark-1');
now += 1;
await organizer.trackMoved('bookmark-1', { parentId: 'other-bookmarks', oldParentId: 'inbox' });
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['bookmark-1'], undefined);

bookmarksBar.children[0].children.push({
  id: 'marker',
  title: 'Bok Inbox marker',
  url: 'chrome-extension://bok/bookmark-manager.html#bok-inbox-default-folder-marker',
  parentId: 'inbox',
});
now += 1;
await organizer.trackCreated('marker');
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates.marker, undefined);

bookmarksBar.children[0].children.push({
  id: 'removed-folder',
  title: 'Removed folder',
  parentId: 'inbox',
  children: [
    {
      id: 'removed-bookmark',
      title: 'Removed bookmark',
      url: 'https://removed.example',
      parentId: 'removed-folder',
    },
  ],
});
now += 1;
await organizer.trackCreated('removed-folder');
assert.ok((await readBookmarkOrganizerStore()).candidates['removed-bookmark']);
removeNode(bookmarksBar, 'removed-folder');
now += 1;
await organizer.trackRemoved('removed-folder');
assert.equal((await readBookmarkOrganizerStore()).candidates['removed-bookmark'], undefined);

now += 1;
await organizer.markPermissionGap();
assert.equal((await readBookmarkOrganizerStore()).tracking.status, 'permission-gap');
findNode(bookmarksBar, 'bookmark-2').title = 'Changed during gap';
now += 1;
await organizer.recoverAfterPermissionGap();
store = await readBookmarkOrganizerStore();
assert.equal(store.tracking.status, 'tracking');
assert.equal(store.tracking.gap?.recoveredAt, now);
assert.ok((store.tracking.gap?.startedAt ?? now) < now);
assert.equal(store.candidates['bookmark-2'].title, 'Changed during gap');
assert.equal(store.candidates['bookmark-2'].revision, 4);

now += 1;
await organizer.startRound();
assert.deepEqual(await organizer.getCurrentRoundCandidateIds(), ['bookmark-2']);
bookmarksBar.children[0].children.push({
  id: 'bookmark-3',
  title: 'After cutoff',
  url: 'https://after.example',
  parentId: 'inbox',
});
now += 1;
await organizer.trackCreated('bookmark-3');
assert.deepEqual(await organizer.getCurrentRoundCandidateIds(), ['bookmark-2']);
await organizer.deferInRound('bookmark-2');
await organizer.completeRound();
store = await readBookmarkOrganizerStore();
assert.equal(store.round, null);
assert.ok(store.candidates['bookmark-2']);
assert.ok(store.candidates['bookmark-3']);

now += 1;
await organizer.startRound();
store = await readBookmarkOrganizerStore();
const bookmarkTwoRevision = store.candidates['bookmark-2'].revision;
await organizer.applySuggestions([
  {
    bookmarkId: 'bookmark-2',
    expectedRevision: bookmarkTwoRevision,
    suggestion: { retention: 'keep', directory: 'Bookmarks Bar / Inbox / Renamed project', reason: 'cached' },
  },
  {
    bookmarkId: 'bookmark-3',
    expectedRevision: store.candidates['bookmark-3'].revision,
    suggestion: { retention: 'unsure', directory: null, reason: 'first pass' },
  },
]);
store = await readBookmarkOrganizerStore();
const cachedSuggestion = store.candidates['bookmark-2'].suggestion;
delete store.candidates['bookmark-3'].suggestion;
await fakeBrowser.storage.local.set({ bookmarkOrganizerState: store });
await organizer.applySuggestions([
  {
    bookmarkId: 'bookmark-3',
    expectedRevision: store.candidates['bookmark-3'].revision,
    suggestion: { retention: 'keep', directory: 'Bookmarks Bar / Inbox', reason: 'only missing cache' },
  },
]);
store = await readBookmarkOrganizerStore();
assert.deepEqual(store.candidates['bookmark-2'].suggestion, cachedSuggestion);
assert.equal(store.candidates['bookmark-3'].suggestion.reason, 'only missing cache');
await organizer.completeCandidate('bookmark-2', bookmarkTwoRevision, 'keep');
assert.deepEqual(await organizer.getCurrentRoundCandidateIds(), ['bookmark-3']);
findNode(bookmarksBar, 'bookmark-2').title = 'Changed after decision';
now += 1;
await organizer.trackChanged('bookmark-2', { title: 'Changed after decision' });
assert.deepEqual(await organizer.getCurrentRoundCandidateIds(), [
  'bookmark-2',
  'bookmark-3',
]);
await assert.rejects(
  organizer.completeCandidate('bookmark-2', bookmarkTwoRevision, 'keep'),
  /已发生变化/,
);
store = await readBookmarkOrganizerStore();
await organizer.completeCandidate(
  'bookmark-2',
  store.candidates['bookmark-2'].revision,
  'keep',
);
await organizer.completeCandidate(
  'bookmark-3',
  store.candidates['bookmark-3'].revision,
  'unsure',
);
await organizer.completeRound();
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['bookmark-2'], undefined);
assert.equal(store.decisions['bookmark-2'], undefined);
assert.equal(store.decisions['bookmark-3'], undefined);
assert.equal(store.tracking.baselineAt, now);

bookmarksBar.children[0].children.push({
  id: 'undo-move',
  title: 'Moved into the bar',
  url: 'https://undo-move.example',
  parentId: 'inbox',
});
now += 1;
await organizer.trackMoved('undo-move', {
  parentId: 'inbox',
  oldParentId: 'other-bookmarks',
});
store = await organizer.startRound();
const undoMoveRevision = store.candidates['undo-move'].revision;
assert.deepEqual(store.candidates['undo-move'].changeTypes, ['moved']);
await organizer.completeCandidate('undo-move', undoMoveRevision, 'keep');
assert.deepEqual(await organizer.getCurrentRoundCandidateIds(), []);
now += 1;
await organizer.reconcileMoveUndo('undo-move');
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['undo-move'].revision, undoMoveRevision + 1);
assert.deepEqual(await organizer.getCurrentRoundCandidateIds(), ['undo-move']);
await organizer.reconcileMoveUndo('undo-move');
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['undo-move'].revision, undoMoveRevision + 1);

await organizer.completeCandidate('undo-move', undoMoveRevision + 1, 'keep');
await organizer.completeRound();
bookmarksBar.children[0].children.push({
  id: 'undo-created',
  title: 'Created before organizer move',
  url: 'https://undo-created.example',
  parentId: 'inbox',
});
now += 1;
await organizer.trackCreated('undo-created');
store = await organizer.startRound();
const undoCreatedRevision = store.candidates['undo-created'].revision;
await organizer.completeCandidate('undo-created', undoCreatedRevision, 'keep');
now += 1;
await organizer.trackMoved('undo-created', {
  parentId: 'inbox',
  oldParentId: 'target',
});
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['undo-created'].revision, undoCreatedRevision + 1);
await organizer.reconcileMoveUndo('undo-created');
store = await readBookmarkOrganizerStore();
assert.equal(store.candidates['undo-created'].revision, undoCreatedRevision + 1);
assert.deepEqual(await organizer.getCurrentRoundCandidateIds(), ['undo-created']);

await fakeBrowser.storage.local.set({
  [BOOKMARK_ORGANIZER_STATE_KEY]: { schemaVersion: 2 },
});
await assert.rejects(readBookmarkOrganizerStore(), /版本或顶层结构无效/);

console.log('bookmark organizer checks passed');
