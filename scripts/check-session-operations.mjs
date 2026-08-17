import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;

const { createItemsSession } = await import('../libs/saved-pages/session-items.ts');
const { isSavedPageCommand } = await import('../libs/saved-pages/messages.ts');
const {
  getSessions,
  writeSessions,
} = await import('../libs/saved-pages/persistence.ts');
const {
  appendTabsToGroup,
  deduplicateGroup,
  getSavedSession,
  getUnarchivedSavedGroupTargets,
  removeGroup,
  removeSession,
  removeTab,
  renameSession,
  setSessionArchived,
  setSessionLocked,
  setSessionPinned,
  setSessionTaskStatus,
} = await import('../libs/saved-pages/store.ts');
const {
  bindOpenedTaskGroups,
  clearTaskGroupBindingsForSession,
  getActiveTaskGroupBindings,
} = await import('../libs/tab-group-sync/sync.ts');
const {
  openSavedSession,
  rollbackOpenedSavedSession,
} = await import('../libs/saved-pages/restore-tabs.ts');
const { saveAndCloseTabToGroup } = await import('../libs/saved-pages/save-tabs.ts');
const { executeSavedPageCommand } = await import('../libs/saved-pages/operations.ts');

const tab = (id, url = `https://${id}.example`) => ({
  id,
  url,
  title: id,
  createdAt: 100,
  updatedAt: 100,
  tags: [],
  directory: null,
  taskStatus: null,
  taskCompletedAt: null,
  archivedAt: null,
});

const group = (id, tabs, options = {}) => ({
  id,
  title: options.title ?? id,
  createdAt: 100,
  color: options.color,
  grouped: true,
  locked: options.locked ?? false,
  pinned: false,
  restoredAt: null,
  archivedAt: null,
  taskStatus: null,
  taskCompletedAt: null,
  tabs,
});

const session = (id, items, state = {}) =>
  createItemsSession(id, 100, items, state);

for (const command of [
  { type: 'bok/open-session', sessionId: 's', destination: 'current-window' },
  { type: 'bok/open-session', sessionId: 's', destination: 'new-window' },
  { type: 'bok/remove-session', sessionId: 's' },
  { type: 'bok/rename-session', sessionId: 's', title: '' },
  { type: 'bok/set-session-pinned', sessionId: 's', pinned: true },
  { type: 'bok/set-session-archived', sessionId: 's', archived: false },
  { type: 'bok/set-session-task-status', sessionId: 's', status: 'doing' },
  { type: 'bok/set-session-locked', sessionId: 's', locked: true },
]) {
  assert.equal(isSavedPageCommand(command), true, command.type);
}
assert.equal(
  isSavedPageCommand({
    type: 'bok/open-session',
    sessionId: 's',
    destination: 'filtered-view',
  }),
  false,
);

await writeSessions([session('state-session', [{ type: 'tab', tab: tab('state-tab') }])]);
await renameSession('state-session', '  Custom name  ');
assert.equal((await getSavedSession('state-session')).title, 'Custom name');
await renameSession('state-session', '   ');
assert.equal((await getSavedSession('state-session')).title, '');

await setSessionPinned('state-session', true);
assert.equal((await getSavedSession('state-session')).pinned, true);
await setSessionArchived('state-session', true);
let storedSession = await getSavedSession('state-session');
assert.equal(storedSession.pinned, false);
assert.equal(typeof storedSession.archivedAt, 'number');
const archivedAt = storedSession.archivedAt;
await setSessionArchived('state-session', true);
assert.equal((await getSavedSession('state-session')).archivedAt, archivedAt);
await assert.rejects(() => setSessionPinned('state-session', true), /先恢复/);
await setSessionArchived('state-session', false);
storedSession = await getSavedSession('state-session');
assert.equal(storedSession.archivedAt, null);
assert.equal(typeof storedSession.restoredAt, 'number');

await setSessionTaskStatus('state-session', 'done');
storedSession = await getSavedSession('state-session');
assert.equal(storedSession.taskStatus, 'done');
assert.equal(typeof storedSession.taskCompletedAt, 'number');
await setSessionTaskStatus('state-session', null);
storedSession = await getSavedSession('state-session');
assert.equal(storedSession.taskStatus, null);
assert.equal(storedSession.taskCompletedAt, null);

await setSessionLocked('state-session', true);
await assert.rejects(() => removeSession('state-session'), /保存记录已锁定/);
await assert.rejects(
  () => removeTab('state-session', 'state-tab'),
  /无法删除其中的标签页/,
);
await setSessionLocked('state-session', false);

await writeSessions([
  session('active-target-session', [
    {
      type: 'group',
      group: group('active-target', [tab('existing-target-tab')], {
        title: 'Active target',
      }),
    },
    {
      type: 'group',
      group: {
        ...group('archived-target', [tab('archived-target-tab')]),
        archivedAt: 200,
      },
    },
  ]),
  session(
    'archived-target-session',
    [
      {
        type: 'group',
        group: group('hidden-target', [tab('hidden-target-tab')]),
      },
    ],
    { archivedAt: 200 },
  ),
]);
assert.deepEqual(await getUnarchivedSavedGroupTargets(), [
  {
    sessionId: 'active-target-session',
    groupId: 'active-target',
    title: 'Active target',
  },
]);
await appendTabsToGroup('active-target-session', 'active-target', [
  tab('appended-target-tab'),
]);
assert.deepEqual(
  (await getSavedSession('active-target-session')).items[0].group.tabs.map(
    (item) => item.id,
  ),
  ['existing-target-tab', 'appended-target-tab'],
);
await assert.rejects(
  () =>
    appendTabsToGroup('active-target-session', 'archived-target', [
      tab('rejected-archived-group-tab'),
    ]),
  /目标分组已归档/,
);
await assert.rejects(
  () =>
    appendTabsToGroup('archived-target-session', 'hidden-target', [
      tab('rejected-archived-session-tab'),
    ]),
  /目标保存记录已归档/,
);
await assert.rejects(
  () => appendTabsToGroup('active-target-session', 'missing-target', []),
  /找不到要操作的分组/,
);

await writeSessions([
  session('locked-group-session', [
    {
      type: 'group',
      group: group('locked-group', [tab('locked-tab')], { locked: true }),
    },
  ]),
]);
await assert.rejects(
  () => removeSession('locked-group-session'),
  /包含已锁定的分组/,
);

await writeSessions([
  session(
    'session-locks-group',
    [{ type: 'group', group: group('unlocked-group', [tab('nested-tab')]) }],
    { locked: true },
  ),
]);
await assert.rejects(
  () => removeTab('session-locks-group', 'nested-tab'),
  /保存记录已锁定/,
);
await assert.rejects(
  () => removeGroup('session-locks-group', 'unlocked-group'),
  /保存记录已锁定/,
);
await assert.rejects(
  () => deduplicateGroup('session-locks-group', 'unlocked-group'),
  /保存记录已锁定/,
);

const binding = (sessionId, savedGroupId, browserGroupId) => ({
  sessionId,
  savedGroupId,
  browserGroupId,
  windowId: 1,
  savedTabIdByBrowserTabId: {},
  ignoredBrowserTabIds: [],
});
await fakeBrowser.storage.session.set({
  'task-group-bindings': {
    'one:group': binding('one', 'group', 11),
    'one:two:group': binding('one:two', 'group', 12),
  },
});
await clearTaskGroupBindingsForSession('one');
assert.deepEqual(
  Object.keys((await fakeBrowser.storage.session.get('task-group-bindings'))['task-group-bindings']),
  ['one:two:group'],
);

await bindOpenedTaskGroups('batch', [
  {
    savedGroupId: 'first',
    browserGroupId: 21,
    windowId: 2,
    openedTabIdBySavedTabId: { savedA: 201 },
  },
  {
    savedGroupId: 'second',
    browserGroupId: 22,
    windowId: 2,
    openedTabIdBySavedTabId: { savedB: 202 },
  },
]);
const batchBindings = (await fakeBrowser.storage.session.get('task-group-bindings'))[
  'task-group-bindings'
];
assert.equal(batchBindings['batch:first'].savedTabIdByBrowserTabId['201'], 'savedA');
assert.equal(batchBindings['batch:second'].savedTabIdByBrowserTabId['202'], 'savedB');

const createdTabs = [];
const groupedTabs = [];
const updatedGroups = [];
const removedTabs = [];
let nextBrowserTabId = 300;
fakeBrowser.tabGroups = {
  get: async (id) => ({ id, windowId: 5, title: '', color: 'grey' }),
  query: async () => [],
  update: async (id, changes) => {
    updatedGroups.push({ id, changes });
    return { id, windowId: 5, ...changes };
  },
};
fakeBrowser.tabs.query = async (query) =>
  query.windowId === 5 ? [{ id: 90, index: 2, windowId: 5 }] : [];
fakeBrowser.tabs.create = async (options) => {
  const created = { id: nextBrowserTabId++, index: options.index, ...options };
  createdTabs.push(created);
  return created;
};
fakeBrowser.tabs.group = async (options) => {
  groupedTabs.push(options);
  return 41;
};
fakeBrowser.tabs.update = async (id, changes) => ({ id, ...changes });
fakeBrowser.tabs.remove = async (ids) => {
  removedTabs.push(...(Array.isArray(ids) ? ids : [ids]));
};

const orderedSession = session('ordered', [
  { type: 'tab', tab: tab('direct-a') },
  {
    type: 'group',
    group: group('browser-group', [tab('group-a'), tab('group-b')], {
      title: 'Blue group',
      color: 'blue',
    }),
  },
  { type: 'tab', tab: tab('direct-b') },
]);
const openedCurrent = await openSavedSession(5, orderedSession, 'current-window');
assert.equal(openedCurrent.openedTabs, 4);
assert.equal(openedCurrent.openedGroups, 1);
assert.deepEqual(createdTabs.map((item) => item.url), [
  'https://direct-a.example',
  'https://group-a.example',
  'https://group-b.example',
  'https://direct-b.example',
]);
assert.deepEqual(createdTabs.map((item) => item.index), [3, 4, 5, 6]);
assert.deepEqual(groupedTabs[0].tabIds, [301, 302]);
assert.deepEqual(updatedGroups[0], {
  id: 41,
  changes: { title: 'Blue group', color: 'blue' },
});

createdTabs.length = 0;
groupedTabs.length = 0;
updatedGroups.length = 0;
nextBrowserTabId = 401;
fakeBrowser.windows.create = async (options) => ({
  id: 8,
  tabs: [{ id: 400, index: 0, windowId: 8, url: options.url }],
});
fakeBrowser.windows.remove = async () => undefined;
const newWindowSession = session('new-window', [
  {
    type: 'group',
    group: group('first-group', [tab('first'), tab('second')], {
      title: 'First group',
      color: 'red',
    }),
  },
  { type: 'tab', tab: tab('third') },
]);
const openedNew = await openSavedSession(undefined, newWindowSession, 'new-window');
assert.equal(openedNew.openedTabs, 3);
assert.equal(createdTabs.length, 2, 'new window first tab must not be duplicated');
assert.deepEqual(groupedTabs[0].tabIds, [400, 401]);
assert.deepEqual(openedNew.openedTaskGroups[0].openedTabIdBySavedTabId, {
  first: 400,
  second: 401,
});

createdTabs.length = 0;
removedTabs.length = 0;
nextBrowserTabId = 500;
fakeBrowser.tabs.query = async (query) =>
  query.windowId === 5 ? createdTabs : [];
fakeBrowser.tabGroups.update = async () => {
  throw new Error('group update failed');
};
await assert.rejects(
  () => openSavedSession(5, newWindowSession, 'current-window'),
  /已回滚本次打开内容/,
);
assert.deepEqual(removedTabs, [500, 501]);

removedTabs.length = 0;
const removedWindows = [];
fakeBrowser.windows.remove = async (windowId) => {
  removedWindows.push(windowId);
};
fakeBrowser.tabs.query = async (query) =>
  query.windowId === 8
    ? [
        { id: 400, windowId: 8 },
        { id: 401, windowId: 8 },
        { id: 402, windowId: 8 },
        { id: 999, windowId: 8 },
      ]
    : [];
assert.equal(
  await rollbackOpenedSavedSession(openedNew),
  true,
  'joining user tabs must not prevent rolling back command tabs',
);
assert.deepEqual(removedTabs, [400, 401, 402]);
assert.deepEqual(removedWindows, [], 'rollback must not close a window with user tabs');

removedTabs.length = 0;
fakeBrowser.tabs.query = async (query) =>
  query.windowId === 8
    ? [
        { id: 400, windowId: 8 },
        { id: 402, windowId: 8 },
        { id: 999, windowId: 8 },
      ]
    : [];
assert.equal(
  await rollbackOpenedSavedSession(openedNew),
  false,
  'a command tab moved out of the target window cannot be safely rolled back',
);
assert.deepEqual(removedTabs, [400, 402]);
assert.equal(removedTabs.includes(401), false);
assert.equal(removedTabs.includes(999), false);
assert.deepEqual(removedWindows, []);

fakeBrowser.tabGroups.get = async (id) => {
  if (id === 999) throw new Error('missing');
  return { id, windowId: 5, title: '', color: 'grey' };
};
const active = await getActiveTaskGroupBindings('batch', ['first', 'second']);
assert.deepEqual([...active], ['first', 'second']);

await writeSessions([
  session('active-multi', [
    { type: 'tab', tab: tab('multi-direct') },
    {
      type: 'group',
      group: group('active-group', [tab('multi-group-tab')]),
    },
  ]),
]);
await bindOpenedTaskGroups('active-multi', [
  {
    savedGroupId: 'active-group',
    browserGroupId: 60,
    windowId: 1,
    openedTabIdBySavedTabId: { 'multi-group-tab': 610 },
  },
]);
fakeBrowser.tabGroups.get = async (id) => {
  if (id === 60) throw new Error('group moved');
  return { id, windowId: 5, title: 'active-group', color: 'grey' };
};
fakeBrowser.tabGroups.query = async () => [
  { id: 61, windowId: 5, title: 'active-group', color: 'grey' },
];
fakeBrowser.tabs.query = async (query) =>
  query.groupId === 61
    ? [
        {
          id: 610,
          index: 0,
          windowId: 5,
          groupId: 61,
          url: 'https://multi-group-tab.example',
        },
      ]
    : [];
let attemptedCreate = false;
fakeBrowser.tabs.create = async () => {
  attemptedCreate = true;
  throw new Error('must not create');
};
await assert.rejects(
  () =>
    executeSavedPageCommand(
      {
        type: 'bok/open-session',
        sessionId: 'active-multi',
        destination: 'current-window',
      },
      { currentWindowId: 5 },
    ),
  /已在浏览器中打开/,
);
assert.equal(attemptedCreate, false);
assert.equal(
  (await fakeBrowser.storage.session.get('task-group-bindings'))[
    'task-group-bindings'
  ]['active-multi:active-group'].browserGroupId,
  61,
);

await writeSessions([
  session('active-single', [
    {
      type: 'group',
      group: group('single-group', [tab('single-tab')]),
    },
  ]),
]);
await bindOpenedTaskGroups('active-single', [
  {
    savedGroupId: 'single-group',
    browserGroupId: 62,
    windowId: 5,
    openedTabIdBySavedTabId: { 'single-tab': 620 },
  },
]);
fakeBrowser.tabGroups.query = async () => [
  { id: 62, windowId: 5, title: 'single-group', color: 'grey' },
];
fakeBrowser.tabs.query = async (query) =>
  query.groupId === 62
    ? [
        {
          id: 620,
          index: 0,
          windowId: 5,
          groupId: 62,
          url: 'https://single-tab.example',
        },
      ]
    : [];
let focusedWindowId;
let activatedTabId;
fakeBrowser.windows.update = async (id) => {
  focusedWindowId = id;
  return { id };
};
fakeBrowser.tabs.update = async (id, changes) => {
  if (changes.active) activatedTabId = id;
  return { id, ...changes };
};
const reused = await executeSavedPageCommand({
  type: 'bok/open-session',
  sessionId: 'active-single',
  destination: 'new-window',
});
assert.equal(reused.reusedSyncedGroup, true);
assert.equal(focusedWindowId, 5);
assert.equal(activatedTabId, 620);
assert.equal(attemptedCreate, false);

await writeSessions([
  session('bound-source-session', [
    {
      type: 'group',
      group: group('bound-source-group', [tab('bound-source-tab')]),
    },
  ]),
  session('bound-target-session', [
    {
      type: 'group',
      group: group('bound-target-group', [tab('bound-target-tab')]),
    },
  ]),
]);
await bindOpenedTaskGroups('bound-source-session', [
  {
    savedGroupId: 'bound-source-group',
    browserGroupId: 80,
    windowId: 5,
    openedTabIdBySavedTabId: { 'bound-source-tab': 700 },
  },
]);
const boundBrowserTab = {
  id: 700,
  index: 0,
  windowId: 5,
  groupId: 80,
  url: 'https://bound-source-tab.example',
  title: 'Bound source tab',
};
fakeBrowser.tabs.get = async () => boundBrowserTab;
fakeBrowser.tabGroups.get = async (id) => ({
  id,
  windowId: 5,
  title: 'bound-source-group',
  color: 'grey',
});
fakeBrowser.tabGroups.query = async () => [
  { id: 80, windowId: 5, title: 'bound-source-group', color: 'grey' },
];
fakeBrowser.tabs.query = async (query) => {
  if (query.groupId === 80) return [boundBrowserTab];
  if (query.windowId === 5) {
    return [boundBrowserTab, { id: 701, index: 1, windowId: 5 }];
  }
  return [];
};
const removedBeforeTargetSave = removedTabs.length;
await saveAndCloseTabToGroup(
  700,
  'bound-target-session',
  'bound-target-group',
);
const boundTarget = await getSavedSession('bound-target-session');
assert.deepEqual(
  boundTarget.items[0].group.tabs.map((item) => item.url),
  ['https://bound-target-tab.example', 'https://bound-source-tab.example'],
);
assert.deepEqual(removedTabs.slice(removedBeforeTargetSave), [700]);

const removedBeforeRejectedTargetSave = removedTabs.length;
await assert.rejects(
  () => saveAndCloseTabToGroup(700, 'bound-target-session', 'missing-group'),
  /找不到要操作的分组/,
);
assert.equal(removedTabs.length, removedBeforeRejectedTargetSave);

await writeSessions([
  session('remove-me', [{ type: 'tab', tab: tab('remove-tab') }]),
]);
await bindOpenedTaskGroups('remove-me', [
  {
    savedGroupId: 'orphan-binding',
    browserGroupId: 71,
    windowId: 5,
    openedTabIdBySavedTabId: {},
  },
]);
const removedTabCountBeforeSessionDelete = removedTabs.length;
const originalSessionSet = fakeBrowser.storage.session.set;
const originalWarn = console.warn;
let deleteWarning;
fakeBrowser.storage.session.set = async () => {
  throw new Error('session storage unavailable');
};
console.warn = (...args) => {
  deleteWarning = args;
};
try {
  await executeSavedPageCommand({ type: 'bok/remove-session', sessionId: 'remove-me' });
} finally {
  fakeBrowser.storage.session.set = originalSessionSet;
  console.warn = originalWarn;
}
assert.equal((await getSessions()).length, 0);
assert.equal(removedTabs.length, removedTabCountBeforeSessionDelete);
assert.equal(deleteWarning?.[0], '[bok] failed to clear deleted session bindings');
const remainingBindings = (await fakeBrowser.storage.session.get('task-group-bindings'))[
  'task-group-bindings'
];
assert.equal(
  Object.values(remainingBindings).some((item) => item.sessionId === 'remove-me'),
  true,
);

console.log('session operations checks passed');
