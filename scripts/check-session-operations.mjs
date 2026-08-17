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
  moveTab,
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
  reconcileTaskGroup,
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
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 'tab',
    targetSessionId: 'target',
    targetGroupId: null,
  },
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 'tab',
    targetSessionId: 'target',
    targetGroupId: 'group',
    targetBeforeTabId: 'before-tab',
  },
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 'tab',
    targetSessionId: 'target',
    targetGroupId: null,
    targetBeforeTabId: null,
  },
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
for (const command of [
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 'tab',
    targetSessionId: 'target',
  },
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 'tab',
    targetSessionId: 1,
    targetGroupId: null,
  },
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 1,
    targetSessionId: 'target',
    targetGroupId: null,
  },
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 'tab',
    targetSessionId: 'target',
    targetGroupId: 1,
  },
  {
    type: 'bok/move-tab',
    sessionId: 's',
    tabId: 'tab',
    targetSessionId: 'target',
    targetGroupId: null,
    targetBeforeTabId: 1,
  },
]) {
  assert.equal(isSavedPageCommand(command), false, JSON.stringify(command));
}

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

const metadataTab = {
  ...tab('metadata-tab', 'https://metadata.example/path'),
  title: 'Metadata tab',
  favIconUrl: 'https://metadata.example/favicon.ico',
  createdAt: 11,
  updatedAt: 22,
  tags: ['work', 'important'],
  directory: ['Projects'],
  taskStatus: 'done',
  taskCompletedAt: 33,
  archivedAt: null,
};

await writeSessions([
  session('move-direct-source', [{ type: 'tab', tab: metadataTab }]),
  session(
    'move-direct-target',
    [
      { type: 'tab', tab: tab('direct-target-existing') },
      {
        type: 'group',
        group: group('direct-target-group', [tab('direct-target-group-tab')]),
      },
    ],
    { locked: true },
  ),
]);
let moveResult = await moveTab(
  'move-direct-source',
  'metadata-tab',
  'move-direct-target',
  null,
);
assert.deepEqual(moveResult, {
  moved: true,
  containerChanged: true,
  sourceSessionId: 'move-direct-source',
  sourceGroupId: null,
  removedSourceGroup: false,
});
let movedSessions = await getSessions();
assert.deepEqual(movedSessions.map((item) => item.id), ['move-direct-target']);
assert.deepEqual(
  movedSessions[0].items.map((item) => item.type === 'tab' ? item.tab.id : item.group.id),
  ['direct-target-existing', 'metadata-tab', 'direct-target-group'],
  'direct append inserts after the last direct tab, before later groups',
);
assert.deepEqual(movedSessions[0].items[1].tab, metadataTab);

await writeSessions([
  session('move-group-same-direct', [
    {
      type: 'group',
      group: group('same-direct-source-group', [
        tab('same-direct-moved'),
        tab('same-direct-stays'),
      ]),
    },
    { type: 'tab', tab: tab('same-direct-existing') },
  ]),
]);
moveResult = await moveTab(
  'move-group-same-direct',
  'same-direct-moved',
  'move-group-same-direct',
  null,
);
assert.equal(moveResult.removedSourceGroup, false);
storedSession = await getSavedSession('move-group-same-direct');
assert.deepEqual(
  storedSession.items.map((item) =>
    item.type === 'tab'
      ? `tab:${item.tab.id}`
      : `group:${item.group.tabs.map((item) => item.id).join(',')}`,
  ),
  [
    'group:same-direct-stays',
    'tab:same-direct-existing',
    'tab:same-direct-moved',
  ],
);

await writeSessions([
  session('move-group-other-source', [
    {
      type: 'group',
      group: group('move-group-other-group', [tab('move-group-other-tab')]),
    },
  ]),
  session('move-group-other-target', [
    { type: 'tab', tab: tab('move-group-other-existing') },
  ]),
]);
moveResult = await moveTab(
  'move-group-other-source',
  'move-group-other-tab',
  'move-group-other-target',
  null,
);
assert.equal(moveResult.removedSourceGroup, true);
movedSessions = await getSessions();
assert.deepEqual(movedSessions.map((item) => item.id), ['move-group-other-target']);
assert.deepEqual(
  movedSessions[0].items.map((item) => item.tab.id),
  ['move-group-other-existing', 'move-group-other-tab'],
);

await writeSessions([
  session('move-direct-group-source', [
    { type: 'tab', tab: metadataTab },
    { type: 'tab', tab: tab('move-direct-group-stays') },
  ]),
  session(
    'move-direct-group-target',
    [
      {
        type: 'group',
        group: group(
          'move-direct-target-group',
          [tab('move-direct-group-existing')],
          { locked: true },
        ),
      },
    ],
    { locked: true },
  ),
]);
await moveTab(
  'move-direct-group-source',
  'metadata-tab',
  'move-direct-group-target',
  'move-direct-target-group',
);
storedSession = await getSavedSession('move-direct-group-target');
assert.deepEqual(
  storedSession.items[0].group.tabs.map((item) => item.id),
  ['move-direct-group-existing', 'metadata-tab'],
);
assert.deepEqual(storedSession.items[0].group.tabs[1], metadataTab);

await writeSessions([
  session('move-group-to-group', [
    {
      type: 'group',
      group: group('move-group-source', [tab('move-group-tab')]),
    },
    {
      type: 'group',
      group: group('move-group-target', [tab('move-group-existing')]),
    },
  ]),
]);
moveResult = await moveTab(
  'move-group-to-group',
  'move-group-tab',
  'move-group-to-group',
  'move-group-target',
);
assert.equal(moveResult.removedSourceGroup, true);
storedSession = await getSavedSession('move-group-to-group');
assert.deepEqual(storedSession.items.map((item) => item.group.id), ['move-group-target']);
assert.deepEqual(
  storedSession.items[0].group.tabs.map((item) => item.id),
  ['move-group-existing', 'move-group-tab'],
);

await writeSessions([
  session('reorder-direct', [
    { type: 'tab', tab: tab('reorder-direct-first') },
    {
      type: 'group',
      group: group('reorder-direct-middle-group', [tab('reorder-direct-group-tab')]),
    },
    { type: 'tab', tab: tab('reorder-direct-second') },
    { type: 'tab', tab: tab('reorder-direct-third') },
  ]),
]);
moveResult = await moveTab(
  'reorder-direct',
  'reorder-direct-third',
  'reorder-direct',
  null,
  'reorder-direct-first',
);
assert.equal(moveResult.moved, true);
assert.equal(moveResult.containerChanged, false);
storedSession = await getSavedSession('reorder-direct');
assert.deepEqual(
  storedSession.items.flatMap((item) => item.type === 'tab' ? [item.tab.id] : []),
  ['reorder-direct-third', 'reorder-direct-first', 'reorder-direct-second'],
  'direct tabs in one session can be reordered around grouped items',
);

await writeSessions([
  session('reorder-group', [
    {
      type: 'group',
      group: group('reorder-group-target', [
        tab('reorder-group-first'),
        tab('reorder-group-second'),
        tab('reorder-group-third'),
      ]),
    },
  ]),
]);
moveResult = await moveTab(
  'reorder-group',
  'reorder-group-third',
  'reorder-group',
  'reorder-group-target',
  'reorder-group-first',
);
assert.equal(moveResult.moved, true);
assert.equal(moveResult.containerChanged, false);
assert.deepEqual(
  (await getSavedSession('reorder-group')).items[0].group.tabs.map((item) => item.id),
  ['reorder-group-third', 'reorder-group-first', 'reorder-group-second'],
  'tabs in one group can be reordered',
);

await writeSessions([
  session('move-before-source-session', [
    { type: 'tab', tab: tab('move-before-cross-session') },
  ]),
  session('move-before-target-session', [
    { type: 'tab', tab: tab('move-before-target-first') },
    {
      type: 'group',
      group: group('move-before-target-group', [tab('move-before-target-group-tab')]),
    },
    { type: 'tab', tab: tab('move-before-target-second') },
  ]),
]);
moveResult = await moveTab(
  'move-before-source-session',
  'move-before-cross-session',
  'move-before-target-session',
  null,
  'move-before-target-second',
);
assert.equal(moveResult.containerChanged, true);
assert.deepEqual(
  (await getSavedSession('move-before-target-session')).items.flatMap((item) =>
    item.type === 'tab' ? [item.tab.id] : [],
  ),
  [
    'move-before-target-first',
    'move-before-cross-session',
    'move-before-target-second',
  ],
  'a cross-session move inserts before the requested direct tab',
);

await writeSessions([
  session('move-before-groups', [
    {
      type: 'group',
      group: group('move-before-source-group', [
        tab('move-before-cross-group'),
        tab('move-before-source-stays'),
      ]),
    },
    {
      type: 'group',
      group: group('move-before-target-group', [
        tab('move-before-group-first'),
        tab('move-before-group-second'),
      ]),
    },
  ]),
]);
moveResult = await moveTab(
  'move-before-groups',
  'move-before-cross-group',
  'move-before-groups',
  'move-before-target-group',
  'move-before-group-second',
);
assert.equal(moveResult.containerChanged, true);
assert.deepEqual(
  (await getSavedSession('move-before-groups')).items[1].group.tabs.map(
    (item) => item.id,
  ),
  [
    'move-before-group-first',
    'move-before-cross-group',
    'move-before-group-second',
  ],
  'a cross-group move inserts before the requested group tab',
);

await writeSessions([
  session('move-no-op', [
    { type: 'tab', tab: tab('move-no-op-direct') },
    {
      type: 'group',
      group: group('move-no-op-group', [
        tab('move-no-op-group-tab'),
        tab('move-no-op-group-after'),
      ]),
    },
  ]),
]);
const noOpBefore = await fakeBrowser.storage.local.get('sessions');
moveResult = await moveTab(
  'move-no-op',
  'move-no-op-direct',
  'move-no-op',
  null,
);
assert.equal(moveResult.moved, false);
moveResult = await moveTab(
  'move-no-op',
  'move-no-op-group-tab',
  'move-no-op',
  'move-no-op-group',
  'move-no-op-group-after',
);
assert.equal(moveResult.moved, false);
moveResult = await moveTab(
  'move-no-op',
  'move-no-op-group-after',
  'move-no-op',
  'move-no-op-group',
);
assert.equal(moveResult.moved, false);
moveResult = await moveTab(
  'move-no-op',
  'move-no-op-direct',
  'move-no-op',
  null,
  'move-no-op-direct',
);
assert.equal(moveResult.moved, false);
assert.deepEqual(await fakeBrowser.storage.local.get('sessions'), noOpBefore);

async function assertMoveRejected(sourceSessions, command, error) {
  await writeSessions(sourceSessions);
  const before = await getSessions();
  await assert.rejects(() => moveTab(
    command.sessionId,
    command.tabId,
    command.targetSessionId,
    command.targetGroupId,
    command.targetBeforeTabId ?? null,
  ), error);
  assert.deepEqual(await getSessions(), before, `partial move: ${error}`);
}

const activeMoveSessions = () => [
  session('rejected-source', [
    { type: 'tab', tab: tab('rejected-direct') },
    {
      type: 'group',
      group: group('rejected-source-group', [tab('rejected-group-tab')]),
    },
  ]),
  session('rejected-target', [
    {
      type: 'group',
      group: group('rejected-target-group', [tab('rejected-target-tab')]),
    },
  ]),
];

await assertMoveRejected(activeMoveSessions(), {
  sessionId: 'missing-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /找不到要操作的保存记录/);
await assertMoveRejected(activeMoveSessions(), {
  sessionId: 'rejected-source',
  tabId: 'missing-tab',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /找不到要移动的标签页/);
await assertMoveRejected(activeMoveSessions(), {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'missing-target',
  targetGroupId: null,
}, /找不到要操作的保存记录/);
await assertMoveRejected(activeMoveSessions(), {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: 'missing-group',
}, /找不到要操作的分组/);
await assertMoveRejected(activeMoveSessions(), {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: 'rejected-target-group',
  targetBeforeTabId: 'missing-before-tab',
}, /找不到目标位置的标签页/);
await assertMoveRejected([
  session('rejected-source', [{ type: 'tab', tab: tab('rejected-direct') }], {
    archivedAt: 200,
  }),
  activeMoveSessions()[1],
], {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /来源保存记录已归档/);
await assertMoveRejected([
  activeMoveSessions()[0],
  session('rejected-target', [
    { type: 'tab', tab: tab('rejected-target-tab') },
  ], { archivedAt: 200 }),
], {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /目标保存记录已归档/);
await assertMoveRejected([
  session('rejected-source', [
    {
      type: 'group',
      group: { ...group('rejected-source-group', [tab('rejected-group-tab')]), archivedAt: 200 },
    },
  ]),
  activeMoveSessions()[1],
], {
  sessionId: 'rejected-source',
  tabId: 'rejected-group-tab',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /来源分组已归档/);
await assertMoveRejected([
  activeMoveSessions()[0],
  session('rejected-target', [
    {
      type: 'group',
      group: { ...group('rejected-target-group', [tab('rejected-target-tab')]), archivedAt: 200 },
    },
  ]),
], {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: 'rejected-target-group',
}, /目标分组已归档/);
await assertMoveRejected([
  session('rejected-source', [
    {
      type: 'tab',
      tab: { ...tab('rejected-direct'), archivedAt: 200 },
    },
  ]),
  activeMoveSessions()[1],
], {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /来源标签页已归档/);
await assertMoveRejected([
  session('rejected-source', [{ type: 'tab', tab: tab('rejected-direct') }], {
    locked: true,
  }),
  activeMoveSessions()[1],
], {
  sessionId: 'rejected-source',
  tabId: 'rejected-direct',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /来源保存记录已锁定/);
await assertMoveRejected([
  session('rejected-source', [
    {
      type: 'group',
      group: group('rejected-source-group', [tab('rejected-group-tab')], { locked: true }),
    },
  ]),
  activeMoveSessions()[1],
], {
  sessionId: 'rejected-source',
  tabId: 'rejected-group-tab',
  targetSessionId: 'rejected-target',
  targetGroupId: null,
}, /来源分组已锁定/);

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
  session('reorder-bound-session', [
    {
      type: 'group',
      group: group('reorder-bound-group', [
        tab('reorder-bound-first'),
        tab('reorder-bound-second'),
      ]),
    },
  ]),
]);
await bindOpenedTaskGroups('reorder-bound-session', [
  {
    savedGroupId: 'reorder-bound-group',
    browserGroupId: 90,
    windowId: 5,
    openedTabIdBySavedTabId: {
      'reorder-bound-first': 700,
      'reorder-bound-second': 701,
    },
  },
]);
const reorderBindingBefore = structuredClone(
  (await fakeBrowser.storage.session.get('task-group-bindings'))[
    'task-group-bindings'
  ]['reorder-bound-session:reorder-bound-group'],
);
const originalReorderSessionSet = fakeBrowser.storage.session.set;
fakeBrowser.storage.session.set = async () => {
  throw new Error('same-group reorder must not write sync bindings');
};
try {
  await executeSavedPageCommand({
    type: 'bok/move-tab',
    sessionId: 'reorder-bound-session',
    tabId: 'reorder-bound-second',
    targetSessionId: 'reorder-bound-session',
    targetGroupId: 'reorder-bound-group',
    targetBeforeTabId: 'reorder-bound-first',
  });
} finally {
  fakeBrowser.storage.session.set = originalReorderSessionSet;
}
assert.deepEqual(
  (await getSavedSession('reorder-bound-session')).items[0].group.tabs.map(
    (item) => item.id,
  ),
  ['reorder-bound-second', 'reorder-bound-first'],
);
assert.deepEqual(
  (await fakeBrowser.storage.session.get('task-group-bindings'))[
    'task-group-bindings'
  ]['reorder-bound-session:reorder-bound-group'],
  reorderBindingBefore,
  'same-group reordering must not detach or ignore the live group binding',
);

await writeSessions([
  session('move-bound-source', [
    {
      type: 'group',
      group: group('move-bound-source-group', [
        tab('move-bound-tab'),
        tab('move-bound-stays'),
      ]),
    },
  ]),
  session('move-bound-target', [
    {
      type: 'group',
      group: group('move-bound-target-group', [tab('move-bound-target-tab')]),
    },
  ]),
]);
await bindOpenedTaskGroups('move-bound-source', [
  {
    savedGroupId: 'move-bound-source-group',
    browserGroupId: 91,
    windowId: 5,
    openedTabIdBySavedTabId: {
      'move-bound-tab': 710,
      'move-bound-stays': 711,
    },
  },
]);
await bindOpenedTaskGroups('move-bound-target', [
  {
    savedGroupId: 'move-bound-target-group',
    browserGroupId: 92,
    windowId: 5,
    openedTabIdBySavedTabId: { 'move-bound-target-tab': 720 },
  },
]);
fakeBrowser.tabGroups.get = async (id) => ({
  id,
  windowId: 5,
  title: id === 91 ? 'move-bound-source-group' : 'move-bound-target-group',
  color: 'grey',
});
fakeBrowser.tabs.query = async (query) => {
  if (query.groupId === 91) {
    return [
      {
        id: 710,
        index: 0,
        windowId: 5,
        groupId: 91,
        url: 'https://move-bound-tab.example',
        title: 'move-bound-tab',
      },
      {
        id: 711,
        index: 1,
        windowId: 5,
        groupId: 91,
        url: 'https://move-bound-stays.example',
        title: 'move-bound-stays',
      },
    ];
  }
  return [];
};
await executeSavedPageCommand({
  type: 'bok/move-tab',
  sessionId: 'move-bound-source',
  tabId: 'move-bound-tab',
  targetSessionId: 'move-bound-target',
  targetGroupId: 'move-bound-target-group',
});
let moveBindings = (await fakeBrowser.storage.session.get('task-group-bindings'))[
  'task-group-bindings'
];
assert.deepEqual(
  moveBindings['move-bound-source:move-bound-source-group'].savedTabIdByBrowserTabId,
  { 711: 'move-bound-stays' },
);
assert.deepEqual(
  moveBindings['move-bound-source:move-bound-source-group'].ignoredBrowserTabIds,
  [710],
);
assert.deepEqual(
  moveBindings['move-bound-target:move-bound-target-group'].savedTabIdByBrowserTabId,
  { 720: 'move-bound-target-tab' },
  'moving a saved tab must not inject it into the target live group binding',
);
await reconcileTaskGroup(91);
assert.deepEqual(
  (await getSavedSession('move-bound-source')).items[0].group.tabs.map(
    (item) => item.id,
  ),
  ['move-bound-stays'],
  'the source live group must not write an ignored moved tab back',
);
assert.deepEqual(
  (await getSavedSession('move-bound-target')).items[0].group.tabs.map(
    (item) => item.id,
  ),
  ['move-bound-target-tab', 'move-bound-tab'],
);

await writeSessions([
  session('move-empty-bound-source', [
    {
      type: 'group',
      group: group('move-empty-bound-group', [tab('move-empty-bound-tab')]),
    },
  ]),
  session('move-empty-bound-target', [
    { type: 'tab', tab: tab('move-empty-bound-target-tab') },
  ]),
]);
await bindOpenedTaskGroups('move-empty-bound-source', [
  {
    savedGroupId: 'move-empty-bound-group',
    browserGroupId: 93,
    windowId: 5,
    openedTabIdBySavedTabId: { 'move-empty-bound-tab': 730 },
  },
]);
await executeSavedPageCommand({
  type: 'bok/move-tab',
  sessionId: 'move-empty-bound-source',
  tabId: 'move-empty-bound-tab',
  targetSessionId: 'move-empty-bound-target',
  targetGroupId: null,
});
moveBindings = (await fakeBrowser.storage.session.get('task-group-bindings'))[
  'task-group-bindings'
];
assert.equal(
  moveBindings['move-empty-bound-source:move-empty-bound-group'],
  undefined,
  'an emptied source group binding must be cleared',
);
assert.equal(
  (await getSessions()).some((item) => item.id === 'move-empty-bound-source'),
  false,
  'an emptied cross-session source must be removed',
);

await writeSessions([
  session('move-sync-failure-source', [
    {
      type: 'group',
      group: group('move-sync-failure-group', [
        tab('move-sync-failure-tab'),
        tab('move-sync-failure-stays'),
      ]),
    },
  ]),
  session('move-sync-failure-target', [
    { type: 'tab', tab: tab('move-sync-failure-target-tab') },
  ]),
]);
await bindOpenedTaskGroups('move-sync-failure-source', [
  {
    savedGroupId: 'move-sync-failure-group',
    browserGroupId: 94,
    windowId: 5,
    openedTabIdBySavedTabId: {
      'move-sync-failure-tab': 740,
      'move-sync-failure-stays': 741,
    },
  },
]);
const moveSyncFailureBindings = structuredClone(
  (await fakeBrowser.storage.session.get('task-group-bindings'))[
    'task-group-bindings'
  ],
);
const originalMoveSessionSet = fakeBrowser.storage.session.set;
fakeBrowser.storage.session.set = async () => {
  throw new Error('session storage unavailable');
};
try {
  await assert.rejects(
    () => executeSavedPageCommand({
      type: 'bok/move-tab',
      sessionId: 'move-sync-failure-source',
      tabId: 'move-sync-failure-tab',
      targetSessionId: 'move-sync-failure-target',
      targetGroupId: null,
    }),
    /session storage unavailable/,
  );
} finally {
  fakeBrowser.storage.session.set = originalMoveSessionSet;
}
assert.deepEqual(
  (await getSavedSession('move-sync-failure-source')).items[0].group.tabs.map(
    (item) => item.id,
  ),
  ['move-sync-failure-tab', 'move-sync-failure-stays'],
  'a failed source binding update must roll the saved tab back into its source group',
);
assert.deepEqual(
  (await getSavedSession('move-sync-failure-target')).items.map((item) =>
    item.type === 'tab' ? item.tab.id : item.group.id,
  ),
  ['move-sync-failure-target-tab'],
  'a failed source binding update must remove the saved tab from its target',
);
assert.deepEqual(
  (await fakeBrowser.storage.session.get('task-group-bindings'))[
    'task-group-bindings'
  ],
  moveSyncFailureBindings,
  'a rejected session storage write must leave the original binding intact',
);

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
