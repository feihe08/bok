import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;
fakeBrowser.runtime.getURL = (path) => `chrome-extension://bok${path}`;

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

async function flushAsyncWork() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForAsyncWork(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await flushAsyncWork();
}

async function waitForStartupWork() {
  await waitForAsyncWork(1_100);
}

let backgroundSetup;
globalThis.defineBackground = (setup) => {
  backgroundSetup = setup;
  return { main: setup };
};

const installed = createEvent();
const startup = createEvent();
const contextMenuClicked = createEvent();
const tabCreated = createEvent();
const tabUpdated = createEvent();
const actionClicked = createEvent();
const menuDefinitions = [];
const badgeUpdates = [];
const titleUpdates = [];
fakeBrowser.runtime.onInstalled = installed;
fakeBrowser.runtime.onStartup = startup;
fakeBrowser.runtime.onMessage = createEvent();
fakeBrowser.storage.onChanged = createEvent();
fakeBrowser.alarms.onAlarm = createEvent();
fakeBrowser.alarms.get = async () => undefined;
fakeBrowser.alarms.create = async () => undefined;
fakeBrowser.alarms.clear = async () => undefined;
fakeBrowser.tabs.onCreated = tabCreated;
fakeBrowser.tabs.onUpdated = tabUpdated;
fakeBrowser.tabs.onActivated = createEvent();
fakeBrowser.tabs.onMoved = createEvent();
fakeBrowser.tabs.onRemoved = createEvent();
fakeBrowser.permissions.contains = async () => false;
fakeBrowser.permissions.onAdded = createEvent();
fakeBrowser.permissions.onRemoved = createEvent();
fakeBrowser.windows.onFocusChanged = createEvent();
fakeBrowser.action.onClicked = actionClicked;
fakeBrowser.action.setBadgeText = async (details) => badgeUpdates.push(details);
fakeBrowser.action.setBadgeBackgroundColor = async () => undefined;
fakeBrowser.action.setTitle = async (details) => titleUpdates.push(details);
fakeBrowser.contextMenus = {
  create: (details) => menuDefinitions.push(details),
  removeAll: async () => {
    menuDefinitions.length = 0;
  },
  update: async () => undefined,
  onClicked: contextMenuClicked,
};
fakeBrowser.tabGroups = {
  query: async () => [],
  update: async () => undefined,
  onUpdated: createEvent(),
  onCreated: createEvent(),
  onMoved: createEvent(),
  onRemoved: createEvent(),
};

const tabsById = new Map();
const createdTabs = [];
const updatedTabs = [];
const updatedWindows = [];
let tabGetCalls = 0;

fakeBrowser.tabs.get = async (tabId) => {
  tabGetCalls += 1;
  return tabsById.get(tabId);
};
fakeBrowser.tabs.query = async (query) => {
  if (query.url) {
    return [...tabsById.values()].filter((tab) => tab.url === query.url);
  }
  return [...tabsById.values()];
};
fakeBrowser.tabs.create = async (details) => {
  const tab = {
    id: 100 + createdTabs.length,
    windowId: details.windowId ?? 10,
    groupId: -1,
    ...details,
  };
  createdTabs.push(tab);
  return tab;
};
fakeBrowser.tabs.update = async (tabId, details) => {
  updatedTabs.push({ tabId, details });
  const tab = tabsById.get(tabId);
  if (tab) Object.assign(tab, details);
  return tab;
};
fakeBrowser.windows.update = async (windowId, details) => {
  updatedWindows.push({ windowId, details });
};
const {
  addReadingListTabSnapshot,
  executeReadingListCommand,
} = await import('../libs/reading-list/operations.ts');
const { getReadingListItems } = await import('../libs/reading-list/store.ts');
const { isReadingListCommand } = await import('../libs/reading-list/messages.ts');
await import('../entrypoints/background.ts');
backgroundSetup();
installed.emit();
await flushAsyncWork();

assert.deepEqual(
  menuDefinitions.find((item) => item.id === 'bok/add-to-reading-list'),
  {
    id: 'bok/add-to-reading-list',
    title: '收藏',
    contexts: ['action'],
    enabled: true,
  },
);
assert.deepEqual(
  menuDefinitions.find((item) => item.id === 'bok/page/add-to-reading-list'),
  {
    id: 'bok/page/add-to-reading-list',
    parentId: 'bok/page',
    title: '收藏',
    contexts: [
      'page',
      'frame',
      'selection',
      'link',
      'editable',
      'image',
      'video',
      'audio',
    ],
    enabled: true,
  },
);
assert.equal(
  menuDefinitions.some((item) => item.title === '打开好文'),
  false,
  'reading list must only be entered from Bok navigation',
);
const clickedTab = {
  id: 11,
  windowId: 10,
  pendingUrl: 'https://pending-at-click.example/article',
  url: 'https://tab-at-click.example/article',
  title: 'Title at click',
};
contextMenuClicked.emit(
  {
    menuItemId: 'bok/page/add-to-reading-list',
    pageUrl: 'https://page-at-click.example/article?exact=1',
    linkUrl: 'https://clicked-link.example/must-not-be-saved',
  },
  clickedTab,
);
clickedTab.pendingUrl = 'https://navigated.example/new-page';
clickedTab.url = 'https://navigated.example/new-page';
clickedTab.title = 'Title after navigation';
tabsById.delete(clickedTab.id);
tabUpdated.emit(
  clickedTab.id,
  { url: 'https://navigated.example/new-page' },
  clickedTab,
);
await flushAsyncWork();

let items = await getReadingListItems();
assert.equal(items.length, 1);
assert.equal(items[0].url, 'https://tab-at-click.example/article');
assert.equal(items[0].title, 'Title at click');
assert.equal(tabGetCalls, 0, 'context-menu collection must not read the tab after enqueueing');
assert.deepEqual(badgeUpdates, [], 'navigation must invalidate delayed feedback');
assert.deepEqual(titleUpdates, [], 'navigation must invalidate delayed feedback');

contextMenuClicked.emit(
  {
    menuItemId: 'bok/page/add-to-reading-list',
    pageUrl: 'https://page-at-click.example/article?exact=1',
  },
  {
    id: 11,
    windowId: 10,
    pendingUrl: 'https://different.example',
    url: 'https://tab-at-click.example/article',
    title: 'Different duplicate title',
  },
);
await flushAsyncWork();

items = await getReadingListItems();
assert.equal(items.length, 1);
assert.equal(items[0].title, 'Title at click');
assert.deepEqual(badgeUpdates.at(-1), { tabId: 11, text: '✓' });
assert.deepEqual(titleUpdates.at(-1), { tabId: 11, title: '已收藏（未重复添加）' });
tabUpdated.emit(
  11,
  { url: 'https://after-feedback.example' },
  { id: 11, windowId: 10, url: 'https://after-feedback.example' },
);
await flushAsyncWork();
assert.deepEqual(badgeUpdates.at(-1), { tabId: 11, text: '' });
assert.deepEqual(titleUpdates.at(-1), { tabId: 11, title: '保存并关闭全部标签' });

contextMenuClicked.emit(
  {
    menuItemId: 'bok/add-to-reading-list',
    pageUrl: 'https://must-not-be-used-for-action-context.example',
  },
  {
    id: 12,
    windowId: 10,
    pendingUrl: 'https://action-tab-at-click.example/pending',
    url: 'https://action-tab-at-click.example/loaded',
    title: 'Action title at click',
  },
);
await flushAsyncWork();
items = await getReadingListItems();
assert.equal(items.length, 2);
assert.equal(items[0].url, 'https://action-tab-at-click.example/loaded');
assert.equal(items[0].title, 'Action title at click');
assert.deepEqual(badgeUpdates.at(-1), { tabId: 12, text: '✓' });
assert.deepEqual(titleUpdates.at(-1), { tabId: 12, title: '已收藏' });

contextMenuClicked.emit(
  { menuItemId: 'bok/add-to-reading-list' },
  {
    id: 13,
    windowId: 10,
    pendingUrl: 'https://pending-only.example/article',
    title: 'Pending navigation title',
  },
);
await flushAsyncWork();
items = await getReadingListItems();
assert.equal(items.length, 2, 'a pending URL must not be collected as the current page');
assert.deepEqual(badgeUpdates.at(-1), { tabId: 13, text: '!' });
assert.deepEqual(titleUpdates.at(-1), {
  tabId: 13,
  title: '收藏失败：只能收藏 http 或 https 网页',
});
tabUpdated.emit(
  13,
  { url: 'https://pending-only.example/article' },
  { id: 13, windowId: 10, url: 'https://pending-only.example/article' },
);
await flushAsyncWork();
await executeReadingListCommand({ type: 'bok/reading-list/delete-item', id: items[0].id });

const backgroundSource = await readFile(
  new URL('../entrypoints/background.ts', import.meta.url),
  'utf8',
);
assert.match(
  backgroundSource,
  /browser\.action\.onClicked\.addListener\(async \(tab\) => \{[\s\S]*?enqueueOperation\(\(\) => saveAndCloseTabs\(tab\.windowId\)\)/,
);

const createdBeforeEmptyStartup = createdTabs.length;
startup.emit();
await waitForStartupWork();
assert.equal(createdTabs.length, createdBeforeEmptyStartup + 1);
assert.deepEqual(createdTabs.at(-1), {
  id: 100 + createdBeforeEmptyStartup,
  windowId: 10,
  groupId: -1,
  url: 'chrome-extension://bok/saved.html',
  active: true,
  pinned: true,
});

const restoredTab = {
  id: 21,
  windowId: 20,
  active: false,
  pinned: false,
};
const createdBeforeRestoredStartup = createdTabs.length;
const updatedBeforeRestoredStartup = updatedTabs.length;
const windowsBeforeRestoredStartup = updatedWindows.length;
startup.emit();
await waitForAsyncWork(600);
tabsById.set(restoredTab.id, restoredTab);
tabCreated.emit(restoredTab);
await waitForAsyncWork(600);
restoredTab.pendingUrl = 'chrome-extension://bok/saved.html';
tabsById.set(22, {
  id: 22,
  windowId: 30,
  url: 'chrome-extension://bok/saved.html',
  active: false,
  pinned: true,
});
tabUpdated.emit(restoredTab.id, { status: 'loading' }, restoredTab);
await waitForAsyncWork(600);
assert.equal(
  createdTabs.length,
  createdBeforeRestoredStartup,
  'each restore event must reset the startup quiet window',
);
assert.equal(updatedTabs.length, updatedBeforeRestoredStartup);
await waitForAsyncWork(500);
assert.equal(createdTabs.length, createdBeforeRestoredStartup);
assert.deepEqual(updatedTabs.slice(updatedBeforeRestoredStartup), [
  { tabId: 21, details: { pinned: true } },
]);
assert.equal(updatedWindows.length, windowsBeforeRestoredStartup);
assert.equal(tabsById.get(21).active, false);
assert.equal(tabsById.get(22).active, false);

tabsById.clear();
const createdBeforeActionClick = createdTabs.length;
actionClicked.emit({ id: 12, windowId: 10 });
await flushAsyncWork();
assert.equal(createdTabs.length, createdBeforeActionClick + 1);
assert.equal(createdTabs.at(-1).url, 'chrome-extension://bok/saved.html');
assert.equal((await getReadingListItems()).length, 1);

await assert.rejects(
  () =>
    addReadingListTabSnapshot({
      url: 'chrome://settings/',
      title: 'Settings',
    }),
  /只能收藏 http 或 https 网页/,
);

const [{ id }] = await getReadingListItems();
assert.equal(isReadingListCommand({ type: 'bok/reading-list/update-note', id, note: 'plain text' }), true);
assert.equal(isReadingListCommand({ type: 'bok/reading-list/update-note', id, note: 1 }), false);
assert.equal(isReadingListCommand({ type: 'bok/reading-list/open-random' }), true);
await executeReadingListCommand({ type: 'bok/reading-list/update-note', id, note: 'plain text' });
assert.equal((await getReadingListItems())[0].note, 'plain text');

assert.deepEqual(
  await executeReadingListCommand({ type: 'bok/reading-list/open-random' }),
  { opened: true },
);
assert.equal(createdTabs.at(-1).url, 'https://tab-at-click.example/article');
await executeReadingListCommand({ type: 'bok/reading-list/delete-item', id });
assert.deepEqual(await getReadingListItems(), []);
assert.deepEqual(
  await executeReadingListCommand({ type: 'bok/reading-list/open-random' }),
  { opened: false },
);

console.log('reading-list background checks passed');
