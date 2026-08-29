import {
  isSavedPageCommand,
  type SavedPageResponse,
} from '../libs/saved-pages/messages';
import { importBokDataJson, isImportDataCommand } from '../libs/backup/import-data';
import {
  isBookmarkBackupCommand,
  runBookmarkBackup,
} from '../libs/backup/backup';
import {
  cleanupDefaultBookmarkFolderMarkers,
  isDefaultFolderMarker,
  markDefaultBookmarkFolderAsMostRecentlyModified,
} from '../libs/bookmarks/default-folder';
import { BookmarkOrganizer } from '../libs/bookmarks/organizer';
import {
  isBookmarkOrganizerAiCommand,
  isBookmarkOrganizerCommand,
  isBookmarkOrganizerCommandMessage,
  type BookmarkOrganizerResponse,
} from '../libs/bookmarks/organizer-messages';
import { createBookmarkOrganizerOperations } from '../libs/bookmarks/organizer-operations';
import { handleBookmarkOrganizationAiMessage } from '../libs/bookmarks/organization-ai-messages';
import {
  connectCodexBookmarkBridge,
  disconnectCodexBookmarkBridge,
  executeCodexBookmarkRequest,
} from '../libs/bookmarks/codex-bridge';
import type { BookmarkNode } from '../libs/bookmarks/model';
import type {
  BookmarkBackupResponse,
  ImportDataResponse,
} from '../libs/backup/model';
import {
  ensureSavedPageOnBrowserStartup,
  openOrFocusSavedPage,
  saveAndCloseTab,
  saveAndCloseTabToGroup,
  saveAndCloseTabGroup,
  saveAndCloseTabs,
} from '../libs/saved-pages/save-tabs';
import {
  isReadingListCommand,
  type ReadingListResponse,
} from '../libs/reading-list/messages';
import {
  addReadingListTabSnapshot,
  executeReadingListCommand,
  type ReadingListTabSnapshot,
} from '../libs/reading-list/operations';
import { executeSavedPageCommand } from '../libs/saved-pages/operations';
import {
  archiveEligibleGroups,
  ensureUniqueGroupedTitles,
  getUnarchivedSavedGroupTargets,
  type SavedGroupTarget,
} from '../libs/saved-pages/store';
import {
  adoptMovedTaskGroup,
  clearTaskGroupBindingsForWindow,
  markTaskGroupCreated,
  markTaskGroupRemoved,
  markTaskGroupWindowClosing,
  reconcileTaskGroup,
  reconcileTaskTab,
  restoreTaskGroupBindings,
  synchronizeBoundGroupTitles,
} from '../libs/tab-group-sync/sync';

const AUTO_ARCHIVE_ALARM = 'bok-auto-archive';
const AUTO_ARCHIVE_INTERVAL_MINUTES = 60;
const CODEX_BOOKMARK_BRIDGE_ALARM = 'bok-codex-bookmark-bridge';
const CODEX_BOOKMARK_BRIDGE_INTERVAL_MINUTES = 1;
const TASK_GROUP_RECONCILE_DEBOUNCE_MS = 120;
const GROUP_BINDING_RESTORE_DEBOUNCE_MS = 750;
const BOOKMARK_DEFAULT_FOLDER_DEBOUNCE_MS = 250;
const SAVED_PAGE_STARTUP_RESTORE_DELAY_MS = 1_000;
const OPEN_BOK_MENU_ID = 'bok/open';
const ADD_TO_READING_LIST_MENU_ID = 'bok/add-to-reading-list';
const SAVE_ALL_MENU_ID = 'bok/save-all';
const SAVE_TAB_MENU_ID = 'bok/save-tab';
const SAVE_GROUP_MENU_ID = 'bok/save-group';
const SAVE_TAB_TO_GROUP_MENU_ID = 'bok/save-tab-to-group';
const PAGE_CONTEXT_MENU_ID = 'bok/page';
const PAGE_CONTEXTS = [
  'page',
  'frame',
  'selection',
  'link',
  'editable',
  'image',
  'video',
  'audio',
] as const;
const ACTION_DEFAULT_TITLE = '保存并关闭全部标签';
const READING_LIST_FEEDBACK_DURATION_MS = 2_500;

const CONTEXT_MENU_COMMANDS = [
  { id: OPEN_BOK_MENU_ID, title: '打开 Bok' },
  { id: ADD_TO_READING_LIST_MENU_ID, title: '收藏' },
  { id: SAVE_ALL_MENU_ID, title: '保存全部标签' },
  { id: SAVE_TAB_MENU_ID, title: '保存此标签' },
  { id: SAVE_GROUP_MENU_ID, title: '保存此标签组' },
] as const;
const CONTEXT_MENU_COMMAND_IDS = new Set<string>(
  CONTEXT_MENU_COMMANDS.map((item) => item.id),
);

function pageContextMenuId(actionMenuId: string): string {
  return `${PAGE_CONTEXT_MENU_ID}/${actionMenuId.slice('bok/'.length)}`;
}

function normalizeContextMenuId(menuId: string): string {
  const pageMenuPrefix = `${PAGE_CONTEXT_MENU_ID}/`;
  return menuId.startsWith(pageMenuPrefix)
    ? `bok/${menuId.slice(pageMenuPrefix.length)}`
    : menuId;
}

function saveTabToGroupMenuId(target: SavedGroupTarget): string {
  return `${SAVE_TAB_TO_GROUP_MENU_ID}/${target.sessionId}/${target.groupId}`;
}

function parseSaveTabToGroupMenuId(
  menuId: string,
): { sessionId: string; groupId: string } | null {
  const prefix = `${SAVE_TAB_TO_GROUP_MENU_ID}/`;
  if (!menuId.startsWith(prefix)) return null;
  const parts = menuId.slice(prefix.length).split('/');
  return parts.length === 2 && parts[0] && parts[1]
    ? { sessionId: parts[0], groupId: parts[1] }
    : null;
}

interface ContextMenuTabSnapshot {
  readonly id: number | undefined;
  readonly windowId: number | undefined;
  readonly pendingUrl: string | undefined;
  readonly url: string | undefined;
  readonly title: string | undefined;
}

function snapshotContextMenuTab(
  tab?: {
    id?: number;
    windowId?: number;
    pendingUrl?: string;
    url?: string;
    title?: string;
  },
): ContextMenuTabSnapshot {
  return Object.freeze({
    id: tab?.id,
    windowId: tab?.windowId,
    pendingUrl: tab?.pendingUrl,
    url: tab?.url,
    title: tab?.title,
  });
}

function snapshotReadingListTab(
  tab: ContextMenuTabSnapshot,
): ReadingListTabSnapshot {
  return Object.freeze({
    url: tab.url,
    title: tab.title,
  });
}

let operationQueue = Promise.resolve();
let contextMenuQueue = Promise.resolve();
let taskGroupReconcileTimer: ReturnType<typeof setTimeout> | undefined;
let groupBindingRestoreTimer: ReturnType<typeof setTimeout> | undefined;
let bookmarkDefaultFolderTimer: ReturnType<typeof setTimeout> | undefined;
let savedPageStartupRestoreTimer: ReturnType<typeof setTimeout> | undefined;
let savedPageStartupRestoreActive = false;
const readingListFeedbackTimers = new Map<number, ReturnType<typeof setTimeout>>();
const readingListFeedbackTokens = new Map<number, object>();
const pendingTaskGroupAdoptionIds = new Set<number>();
const pendingTaskGroupIds = new Set<number>();
const pendingTaskTabIds = new Set<number>();
const bookmarkOrganizer = new BookmarkOrganizer();
const bookmarkOrganizerOperations = createBookmarkOrganizerOperations({
  organizer: bookmarkOrganizer,
});
let bookmarkOrganizerReady: Promise<void> | null = null;

function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
  const task = operationQueue.then(operation);
  operationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function scheduleSavedPageStartupCheck(): void {
  if (!savedPageStartupRestoreActive) return;
  if (savedPageStartupRestoreTimer !== undefined) {
    clearTimeout(savedPageStartupRestoreTimer);
  }
  savedPageStartupRestoreTimer = setTimeout(() => {
    savedPageStartupRestoreTimer = undefined;
    savedPageStartupRestoreActive = false;
    void enqueueOperation(ensureSavedPageOnBrowserStartup).catch((error) => {
      console.error('[bok] failed to open Bok after browser startup', error);
    });
  }, SAVED_PAGE_STARTUP_RESTORE_DELAY_MS);
}

function cancelReadingListFeedbackTimer(tabId: number): void {
  const timer = readingListFeedbackTimers.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  readingListFeedbackTimers.delete(tabId);
}

function clearReadingListFeedback(tabId: number, token?: object): void {
  if (token && readingListFeedbackTokens.get(tabId) !== token) return;
  const hadVisibleFeedback = readingListFeedbackTimers.has(tabId);
  cancelReadingListFeedbackTimer(tabId);
  readingListFeedbackTokens.delete(tabId);
  if (!hadVisibleFeedback) return;
  void Promise.all([
    browser.action.setBadgeText({ tabId, text: '' }),
    browser.action.setTitle({ tabId, title: ACTION_DEFAULT_TITLE }),
  ]).catch(() => undefined);
}

function beginReadingListFeedback(tabId: number): object {
  clearReadingListFeedback(tabId);
  const token = {};
  readingListFeedbackTokens.set(tabId, token);
  return token;
}

function showReadingListFeedback(
  tabId: number,
  token: object,
  feedback: { badge: string; title: string; color: string },
): void {
  if (readingListFeedbackTokens.get(tabId) !== token) return;
  cancelReadingListFeedbackTimer(tabId);
  void Promise.all([
    browser.action.setBadgeText({ tabId, text: feedback.badge }),
    browser.action.setBadgeBackgroundColor({ tabId, color: feedback.color }),
    browser.action.setTitle({ tabId, title: feedback.title }),
  ]).catch(() => undefined);
  readingListFeedbackTimers.set(
    tabId,
    setTimeout(
      () => clearReadingListFeedback(tabId, token),
      READING_LIST_FEEDBACK_DURATION_MS,
    ),
  );
}

function scheduleBookmarkDefaultFolderReset(): void {
  if (bookmarkDefaultFolderTimer !== undefined) {
    clearTimeout(bookmarkDefaultFolderTimer);
  }
  bookmarkDefaultFolderTimer = setTimeout(() => {
    bookmarkDefaultFolderTimer = undefined;
    void markDefaultBookmarkFolderAsMostRecentlyModified()
      .then((updated) => {
        if (!updated) {
          console.warn('[bok] cannot set the next bookmark folder: configured folder was not found');
        }
      })
      .catch((error) => {
        console.error('[bok] failed to set the next bookmark folder', error);
      });
  }, BOOKMARK_DEFAULT_FOLDER_DEBOUNCE_MS);
}

function handleBookmarkCreated(_id: string, node: BookmarkNode): void {
  if (node.url == null || isDefaultFolderMarker(node)) return;
  scheduleBookmarkDefaultFolderReset();
}

function handleBookmarkMoved(id: string): void {
  void browser.bookmarks
    .get(id)
    .then(([node]) => {
      if (node?.url != null) scheduleBookmarkDefaultFolderReset();
    })
    .catch(() => undefined);
}

export function registerBookmarkDefaultFolderListeners(): boolean {
  const bookmarksApi = browser.bookmarks;
  if (!bookmarksApi?.onCreated || !bookmarksApi.onMoved) return false;
  try {
    bookmarksApi.onCreated.removeListener(handleBookmarkCreated);
    bookmarksApi.onMoved.removeListener(handleBookmarkMoved);
    bookmarksApi.onCreated.addListener(handleBookmarkCreated);
    bookmarksApi.onMoved.addListener(handleBookmarkMoved);
    return true;
  } catch {
    return false;
  }
}

export function unregisterBookmarkDefaultFolderListeners(): void {
  const bookmarksApi = browser.bookmarks;
  if (!bookmarksApi?.onCreated || !bookmarksApi.onMoved) return;
  try {
    bookmarksApi.onCreated.removeListener(handleBookmarkCreated);
    bookmarksApi.onMoved.removeListener(handleBookmarkMoved);
  } catch {
    // Optional Bookmarks API may disappear immediately after permission removal.
  }
}

export async function recoverDefaultBookmarkFolderMarkers(): Promise<boolean> {
  const canReadBookmarks = await browser.permissions.contains({
    permissions: ['bookmarks'],
  });
  if (!canReadBookmarks || !browser.bookmarks) return false;
  const removedMarkers = await cleanupDefaultBookmarkFolderMarkers();
  return removedMarkers === 0
    ? true
    : markDefaultBookmarkFolderAsMostRecentlyModified();
}

function setBookmarkOrganizerReady(operation: () => Promise<void>): Promise<void> {
  const ready = operation();
  bookmarkOrganizerReady = ready;
  void ready.then(
    () => {
      if (bookmarkOrganizerReady === ready) bookmarkOrganizerReady = null;
    },
    () => {
      if (bookmarkOrganizerReady === ready) bookmarkOrganizerReady = null;
    },
  );
  return ready;
}

function enqueueBookmarkOrganizer(operation: () => Promise<unknown>): void {
  const ready = bookmarkOrganizerReady;
  void enqueueOperation(async () => {
    if (ready) await ready;
    return operation();
  }).catch((error) => {
    console.error('[bok] failed to track bookmark organizer change', error);
  });
}

function handleOrganizerBookmarkCreated(id: string): void {
  enqueueBookmarkOrganizer(() => bookmarkOrganizer.trackCreated(id));
}

function handleOrganizerBookmarkChanged(
  id: string,
  changes: { title?: string; url?: string },
): void {
  if (changes.title === undefined && changes.url === undefined) return;
  enqueueBookmarkOrganizer(() => bookmarkOrganizer.trackChanged(id, changes));
}

function handleOrganizerBookmarkMoved(
  id: string,
  move: { parentId: string; oldParentId: string },
): void {
  if (move.parentId === move.oldParentId) return;
  if (bookmarkOrganizerOperations.suppressor.consumeMove(id, move.parentId)) return;
  enqueueBookmarkOrganizer(() => bookmarkOrganizer.trackMoved(id, move));
}

function handleOrganizerBookmarkRemoved(id: string): void {
  if (bookmarkOrganizerOperations.suppressor.consumeRemove(id)) return;
  enqueueBookmarkOrganizer(() => bookmarkOrganizer.trackRemoved(id));
}

export function registerBookmarkOrganizerListeners(): boolean {
  const bookmarksApi = browser.bookmarks;
  if (
    !bookmarksApi?.onCreated ||
    !bookmarksApi.onChanged ||
    !bookmarksApi.onMoved ||
    !bookmarksApi.onRemoved
  ) {
    return false;
  }
  try {
    bookmarksApi.onCreated.removeListener(handleOrganizerBookmarkCreated);
    bookmarksApi.onChanged.removeListener(handleOrganizerBookmarkChanged);
    bookmarksApi.onMoved.removeListener(handleOrganizerBookmarkMoved);
    bookmarksApi.onRemoved.removeListener(handleOrganizerBookmarkRemoved);
    bookmarksApi.onCreated.addListener(handleOrganizerBookmarkCreated);
    bookmarksApi.onChanged.addListener(handleOrganizerBookmarkChanged);
    bookmarksApi.onMoved.addListener(handleOrganizerBookmarkMoved);
    bookmarksApi.onRemoved.addListener(handleOrganizerBookmarkRemoved);
    return true;
  } catch {
    return false;
  }
}

export function unregisterBookmarkOrganizerListeners(): void {
  const bookmarksApi = browser.bookmarks;
  if (!bookmarksApi?.onCreated) return;
  try {
    bookmarksApi.onCreated.removeListener(handleOrganizerBookmarkCreated);
    bookmarksApi.onChanged?.removeListener(handleOrganizerBookmarkChanged);
    bookmarksApi.onMoved?.removeListener(handleOrganizerBookmarkMoved);
    bookmarksApi.onRemoved?.removeListener(handleOrganizerBookmarkRemoved);
  } catch {
    // Optional Bookmarks API may disappear immediately after permission removal.
  }
}

export async function initializeBookmarkOrganizerTracking(): Promise<boolean> {
  const listenersRegistered = registerBookmarkOrganizerListeners();
  let initialized = false;
  await setBookmarkOrganizerReady(async () => {
    const canReadBookmarks = await browser.permissions.contains({
      permissions: ['bookmarks'],
    });
    if (!canReadBookmarks || !browser.bookmarks) {
      unregisterBookmarkOrganizerListeners();
      return;
    }
    if (!listenersRegistered && !registerBookmarkOrganizerListeners()) return;
    await bookmarkOrganizer.initialize();
    initialized = true;
  });
  return initialized;
}

export async function recoverBookmarkOrganizerTracking(): Promise<boolean> {
  if (!registerBookmarkOrganizerListeners()) return false;
  await setBookmarkOrganizerReady(async () => {
    await bookmarkOrganizer.recoverAfterPermissionGap();
  });
  return true;
}

async function ensureAutoArchiveAlarm(): Promise<void> {
  const existing = await browser.alarms.get(AUTO_ARCHIVE_ALARM);
  if (existing) return;
  await browser.alarms.create(AUTO_ARCHIVE_ALARM, {
    periodInMinutes: AUTO_ARCHIVE_INTERVAL_MINUTES,
  });
}

async function syncCodexBookmarkBridge(): Promise<void> {
  const [canReadBookmarks, canUseNativeMessaging] = await Promise.all([
    browser.permissions.contains({ permissions: ['bookmarks'] }),
    browser.permissions.contains({ permissions: ['nativeMessaging'] }),
  ]);
  if (!canReadBookmarks || !canUseNativeMessaging || !browser.bookmarks) {
    disconnectCodexBookmarkBridge();
    await browser.alarms.clear(CODEX_BOOKMARK_BRIDGE_ALARM);
    return;
  }

  connectCodexBookmarkBridge((request) =>
    enqueueOperation(() => executeCodexBookmarkRequest(request)),
  );
  const existing = await browser.alarms.get(CODEX_BOOKMARK_BRIDGE_ALARM);
  if (!existing) {
    await browser.alarms.create(CODEX_BOOKMARK_BRIDGE_ALARM, {
      periodInMinutes: CODEX_BOOKMARK_BRIDGE_INTERVAL_MINUTES,
    });
  }
}

async function runAutoArchive(): Promise<void> {
  const { archivedSessions, archivedGroups } = await archiveEligibleGroups();
  if (archivedSessions + archivedGroups > 0) {
    console.log('[bok] automatically archived saved pages', {
      archivedSessions,
      archivedGroups,
    });
  }
}

async function triggerDailyBookmarkBackup(): Promise<void> {
  try {
    const result = await runBookmarkBackup();
    if (result.status === 'failed') {
      console.warn('[bok] daily bookmark backup will retry on the next open', {
        error: result.state.lastError,
      });
    }
  } catch (error) {
    console.error('[bok] failed to run daily bookmark backup', error);
  }
}

function isBokPageUrl(url: string | undefined): boolean {
  if (!url) return false;
  return new Set([
    browser.runtime.getURL('/saved.html'),
    browser.runtime.getURL('/reading-list.html'),
    browser.runtime.getURL('/bookmark-manager.html'),
    browser.runtime.getURL('/options.html'),
  ]).has(url);
}

async function installContextMenus(): Promise<void> {
  const [[activeTab], groupTargets] = await Promise.all([
    browser.tabs.query({ active: true, lastFocusedWindow: true }),
    getUnarchivedSavedGroupTargets(),
  ]);
  const saveGroupEnabled =
    activeTab?.groupId != null && activeTab.groupId !== -1;
  await browser.contextMenus.removeAll();
  for (const item of CONTEXT_MENU_COMMANDS) {
    browser.contextMenus.create({
      ...item,
      contexts: ['action'],
      enabled: item.id !== SAVE_GROUP_MENU_ID || saveGroupEnabled,
    });
  }
  createSaveTabToGroupMenu(groupTargets);
  browser.contextMenus.create({
    id: PAGE_CONTEXT_MENU_ID,
    title: 'Bok',
    contexts: [...PAGE_CONTEXTS],
  });
  for (const item of CONTEXT_MENU_COMMANDS) {
    browser.contextMenus.create({
      id: pageContextMenuId(item.id),
      parentId: PAGE_CONTEXT_MENU_ID,
      title: item.title,
      contexts: [...PAGE_CONTEXTS],
      enabled: item.id !== SAVE_GROUP_MENU_ID || saveGroupEnabled,
    });
  }
  createSaveTabToGroupMenu(groupTargets, PAGE_CONTEXT_MENU_ID);
}

function createSaveTabToGroupMenu(
  groupTargets: SavedGroupTarget[],
  parentId?: string,
): void {
  const menuId = parentId
    ? pageContextMenuId(SAVE_TAB_TO_GROUP_MENU_ID)
    : SAVE_TAB_TO_GROUP_MENU_ID;
  const contexts: [...typeof PAGE_CONTEXTS] | ['action'] = parentId
    ? [...PAGE_CONTEXTS]
    : ['action'];
  browser.contextMenus.create({
    id: menuId,
    parentId,
    title: '保存此标签到分组',
    contexts,
  });

  if (groupTargets.length === 0) {
    browser.contextMenus.create({
      id: `${menuId}/empty`,
      parentId: menuId,
      title: '没有可用的未归档分组',
      contexts,
      enabled: false,
    });
    return;
  }

  for (const target of groupTargets) {
    const targetMenuId = saveTabToGroupMenuId(target);
    browser.contextMenus.create({
      id: parentId ? pageContextMenuId(targetMenuId) : targetMenuId,
      parentId: menuId,
      title: target.title,
      contexts,
    });
  }
}

function queueContextMenuRefresh(): Promise<void> {
  const task = contextMenuQueue.then(installContextMenus);
  contextMenuQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function refreshSaveGroupMenuState(): Promise<void> {
  const [activeTab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const enabled = activeTab?.groupId != null && activeTab.groupId !== -1;
  await Promise.all([
    browser.contextMenus.update(SAVE_GROUP_MENU_ID, { enabled }),
    browser.contextMenus.update(pageContextMenuId(SAVE_GROUP_MENU_ID), {
      enabled,
    }),
  ]);
}

async function executeContextMenuCommand(
  menuId: string,
  tab: ContextMenuTabSnapshot,
  readingListTabSnapshot?: ReadingListTabSnapshot,
) {
  if (menuId === OPEN_BOK_MENU_ID) {
    await openOrFocusSavedPage(tab?.windowId);
    return undefined;
  }
  if (tab?.id == null) throw new Error('找不到当前标签页');
  if (menuId === ADD_TO_READING_LIST_MENU_ID) {
    if (!readingListTabSnapshot) throw new Error('找不到当前网页');
    return addReadingListTabSnapshot(readingListTabSnapshot);
  }
  const targetGroup = parseSaveTabToGroupMenuId(menuId);
  if (targetGroup) {
    return saveAndCloseTabToGroup(
      tab.id,
      targetGroup.sessionId,
      targetGroup.groupId,
    );
  }
  if (menuId === SAVE_TAB_MENU_ID) return saveAndCloseTab(tab.id);
  if (menuId === SAVE_GROUP_MENU_ID) return saveAndCloseTabGroup(tab.id);
  if (tab.windowId == null) throw new Error('找不到当前窗口');
  return saveAndCloseTabs(tab.windowId);
}

function scheduleTaskGroupReconcile(browserGroupId: number): void {
  pendingTaskGroupIds.add(browserGroupId);
  scheduleTaskReconcile();
}

function scheduleTaskGroupAdoption(browserGroupId: number): void {
  pendingTaskGroupAdoptionIds.add(browserGroupId);
  scheduleTaskReconcile();
}

function scheduleTaskTabReconcile(browserTabId: number): void {
  pendingTaskTabIds.add(browserTabId);
  scheduleTaskReconcile();
}

function scheduleTaskReconcile(): void {
  if (taskGroupReconcileTimer !== undefined) return;
  taskGroupReconcileTimer = setTimeout(() => {
    taskGroupReconcileTimer = undefined;
    const adoptionIds = [...pendingTaskGroupAdoptionIds];
    const groupIds = [...pendingTaskGroupIds];
    const tabIds = [...pendingTaskTabIds];
    pendingTaskGroupAdoptionIds.clear();
    pendingTaskGroupIds.clear();
    pendingTaskTabIds.clear();
    void enqueueOperation(async () => {
      for (const groupId of adoptionIds) await adoptMovedTaskGroup(groupId);
      for (const groupId of groupIds) await reconcileTaskGroup(groupId);
      for (const tabId of tabIds) await reconcileTaskTab(tabId);
    }).catch((error) => {
      console.error('[bok] failed to synchronize task tab group', error);
    });
  }, TASK_GROUP_RECONCILE_DEBOUNCE_MS);
}

function scheduleGroupBindingRestore(): void {
  if (groupBindingRestoreTimer !== undefined) {
    clearTimeout(groupBindingRestoreTimer);
  }
  groupBindingRestoreTimer = setTimeout(() => {
    groupBindingRestoreTimer = undefined;
    void enqueueOperation(restoreTaskGroupBindings).catch((error) => {
      console.error('[bok] failed to restore synced group bindings', error);
    });
  }, GROUP_BINDING_RESTORE_DEBOUNCE_MS);
}

export default defineBackground(() => {
  registerBookmarkDefaultFolderListeners();
  void recoverDefaultBookmarkFolderMarkers().catch((error) => {
    console.error('[bok] failed to recover bookmark default folder markers', error);
  });
  void initializeBookmarkOrganizerTracking().catch((error) => {
    console.error('[bok] failed to initialize bookmark organizer tracking', error);
  });

  browser.runtime.onInstalled.addListener(() => {
    void queueContextMenuRefresh().catch((error) => {
      console.error('[bok] failed to install context menus', error);
    });
  });

  browser.runtime.onStartup.addListener(() => {
    savedPageStartupRestoreActive = true;
    scheduleSavedPageStartupCheck();
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || changes.sessions === undefined) return;
    void queueContextMenuRefresh().catch((error) => {
      console.error('[bok] failed to refresh context menus', error);
    });
  });

  void ensureAutoArchiveAlarm().catch((error) => {
    console.error('[bok] failed to schedule automatic archive', error);
  });
  void syncCodexBookmarkBridge().catch((error) => {
    console.error('[bok] failed to initialize Codex bookmark bridge', error);
  });
  void enqueueOperation(async () => {
    await restoreTaskGroupBindings();
    const renamedGroups = await ensureUniqueGroupedTitles();
    const titleSyncFailures = await synchronizeBoundGroupTitles(renamedGroups);
    for (const failure of titleSyncFailures) {
      console.error('[bok] failed to synchronize stored browser-group title', failure);
    }
    await runAutoArchive();
  }).catch((error) => {
    console.error('[bok] failed to initialize synced groups or run automatic archive', error);
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_ARCHIVE_ALARM) {
      void enqueueOperation(runAutoArchive).catch((error) => {
        console.error('[bok] failed to run scheduled archive', error);
      });
    } else if (alarm.name === CODEX_BOOKMARK_BRIDGE_ALARM) {
      void syncCodexBookmarkBridge().catch((error) => {
        console.error('[bok] failed to reconnect Codex bookmark bridge', error);
      });
    }
  });

  browser.tabs.onCreated.addListener(scheduleSavedPageStartupCheck);

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url !== undefined || changeInfo.status !== undefined) {
      scheduleSavedPageStartupCheck();
    }
    if (changeInfo.url !== undefined) clearReadingListFeedback(tabId);
    if (
      tab.groupId != null &&
      tab.groupId !== -1 &&
      (changeInfo.url !== undefined ||
        changeInfo.title !== undefined ||
        changeInfo.status === 'complete')
    ) {
      scheduleGroupBindingRestore();
      scheduleTaskGroupReconcile(tab.groupId);
    }
    if (changeInfo.groupId === undefined) return;
    void refreshSaveGroupMenuState().catch(() => undefined);
    scheduleTaskTabReconcile(tabId);
    if (changeInfo.groupId !== -1) {
      scheduleTaskGroupReconcile(changeInfo.groupId);
    }
  });

  browser.tabs.onActivated.addListener(() => {
    void refreshSaveGroupMenuState().catch(() => undefined);
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    void browser.tabs
      .get(tabId)
      .then((tab) => {
        if (isBokPageUrl(tab.pendingUrl || tab.url)) {
          return triggerDailyBookmarkBackup();
        }
        return undefined;
      })
      .catch(() => undefined);
  });

  browser.tabs.onMoved.addListener((tabId) => {
    scheduleTaskTabReconcile(tabId);
  });

  browser.permissions.onAdded.addListener((permissions) => {
    if (permissions.permissions?.includes('bookmarks')) {
      registerBookmarkDefaultFolderListeners();
      void recoverDefaultBookmarkFolderMarkers().catch((error) => {
        console.error('[bok] failed to recover bookmark default folder markers', error);
      });
      void recoverBookmarkOrganizerTracking().catch((error) => {
        console.error('[bok] failed to recover bookmark organizer tracking', error);
      });
    }
    if (
      permissions.permissions?.includes('bookmarks') ||
      permissions.permissions?.includes('nativeMessaging')
    ) {
      void syncCodexBookmarkBridge().catch((error) => {
        console.error('[bok] failed to enable Codex bookmark bridge', error);
      });
    }
  });

  browser.permissions.onRemoved.addListener((permissions) => {
    if (permissions.permissions?.includes('bookmarks')) {
      unregisterBookmarkDefaultFolderListeners();
      unregisterBookmarkOrganizerListeners();
      void enqueueOperation(() => bookmarkOrganizer.markPermissionGap()).catch((error) => {
        console.error('[bok] failed to mark bookmark organizer permission gap', error);
      });
    }
    if (
      permissions.permissions?.includes('bookmarks') ||
      permissions.permissions?.includes('nativeMessaging')
    ) {
      void syncCodexBookmarkBridge().catch((error) => {
        console.error('[bok] failed to disable Codex bookmark bridge', error);
      });
    }
  });

  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId < 0) return;
    void refreshSaveGroupMenuState().catch(() => undefined);
  });

  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    clearReadingListFeedback(tabId);
    if (removeInfo.isWindowClosing) {
      markTaskGroupWindowClosing(removeInfo.windowId);
      void enqueueOperation(() => clearTaskGroupBindingsForWindow(removeInfo.windowId)).catch(
        (error) => console.error('[bok] failed to clear closed-window task bindings', error),
      );
      return;
    }
    scheduleTaskTabReconcile(tabId);
  });

  browser.tabGroups.onUpdated.addListener((group) => {
    scheduleGroupBindingRestore();
    scheduleTaskGroupReconcile(group.id);
  });

  browser.tabGroups.onCreated.addListener((group) => {
    markTaskGroupCreated(group.id);
    scheduleTaskGroupAdoption(group.id);
    scheduleGroupBindingRestore();
    scheduleTaskGroupReconcile(group.id);
    void enqueueOperation(async () => {
      if (await adoptMovedTaskGroup(group.id)) {
        await reconcileTaskGroup(group.id);
      }
    }).catch((error) => {
      console.error('[bok] failed to adopt moved task group', error);
    });
  });

  browser.tabGroups.onMoved.addListener((group) => {
    scheduleTaskGroupReconcile(group.id);
  });

  browser.tabGroups.onRemoved.addListener((group) => {
    markTaskGroupRemoved(group.id);
    scheduleTaskGroupReconcile(group.id);
  });

  browser.action.onClicked.addListener(async (tab) => {
    if (tab.windowId == null) return;
    try {
      const result = await enqueueOperation(() => saveAndCloseTabs(tab.windowId));
      console.log('[bok] saved & closed tabs', result);
      await triggerDailyBookmarkBackup();
    } catch (err) {
      console.error('[bok] failed to save tabs', err);
    }
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const rawMenuId = String(info.menuItemId);
    const menuId = normalizeContextMenuId(rawMenuId);
    if (
      !CONTEXT_MENU_COMMAND_IDS.has(menuId) &&
      parseSaveTabToGroupMenuId(menuId) === null
    ) {
      return;
    }

    const tabSnapshot = snapshotContextMenuTab(tab);
    const readingListTabSnapshot =
      menuId === ADD_TO_READING_LIST_MENU_ID
        ? snapshotReadingListTab(tabSnapshot)
        : undefined;
    const readingListFeedbackToken =
      menuId === ADD_TO_READING_LIST_MENU_ID && tabSnapshot.id != null
        ? beginReadingListFeedback(tabSnapshot.id)
        : undefined;

    void enqueueOperation(() =>
      executeContextMenuCommand(menuId, tabSnapshot, readingListTabSnapshot),
    ).then(
      (result) => {
        console.log('[bok] completed context menu command', {
          menuId,
          result,
        });
        if (
          menuId === ADD_TO_READING_LIST_MENU_ID &&
          tabSnapshot.id != null &&
          readingListFeedbackToken
        ) {
          const added = Boolean(
            result &&
              typeof result === 'object' &&
              'added' in result &&
              result.added,
          );
          showReadingListFeedback(tabSnapshot.id, readingListFeedbackToken, {
            badge: '✓',
            title: added ? '已收藏' : '已收藏（未重复添加）',
            color: added ? '#16803c' : '#6b7280',
          });
          return;
        }
        void triggerDailyBookmarkBackup();
      },
      (error) => {
        if (
          menuId === ADD_TO_READING_LIST_MENU_ID &&
          tabSnapshot.id != null &&
          readingListFeedbackToken
        ) {
          const reason = error instanceof Error ? error.message : String(error);
          showReadingListFeedback(tabSnapshot.id, readingListFeedbackToken, {
            badge: '!',
            title: `收藏失败：${reason}`,
            color: '#b42318',
          });
        }
        console.error('[bok] failed context menu command', {
          menuId,
          error,
        });
      },
    );
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (handleBookmarkOrganizationAiMessage(message, sendResponse)) return true;

    if (isBookmarkOrganizerCommand(message)) {
      const execute = async () => {
        const ready = bookmarkOrganizerReady;
        if (ready) await ready;
        return bookmarkOrganizerOperations.execute(message);
      };
      const operation = isBookmarkOrganizerAiCommand(message)
        ? execute()
        : enqueueOperation(execute);
      void operation.then(
        (result) => sendResponse({ ok: true, result } satisfies BookmarkOrganizerResponse),
        (error) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies BookmarkOrganizerResponse),
      );
      return true;
    }
    if (isBookmarkOrganizerCommandMessage(message)) {
      sendResponse({
        ok: false,
        error: '书签整理命令无效',
      } satisfies BookmarkOrganizerResponse);
      return false;
    }

    if (isBookmarkBackupCommand(message)) {
      void runBookmarkBackup(message.force).then(
        (result) => {
          sendResponse({ ok: true, result } satisfies BookmarkBackupResponse);
        },
        (error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies BookmarkBackupResponse);
        },
      );
      return true;
    }

    if (isImportDataCommand(message)) {
      void enqueueOperation(() => importBokDataJson(message.json)).then(
        (result) => {
          sendResponse({ ok: true, result } satisfies ImportDataResponse);
        },
        (error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ImportDataResponse);
        },
      );
      return true;
    }

    if (isReadingListCommand(message)) {
      void enqueueOperation(() => executeReadingListCommand(message)).then(
        (result) => {
          sendResponse({ ok: true, result } satisfies ReadingListResponse);
        },
        (error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ReadingListResponse);
        },
      );
      return true;
    }

    if (!isSavedPageCommand(message)) return undefined;

    void enqueueOperation(() =>
      executeSavedPageCommand(message, {
        currentWindowId: sender.tab?.windowId,
      }),
    ).then(
      (result) => {
        sendResponse({
          ok: true,
          result,
        } satisfies SavedPageResponse);
      },
      (error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies SavedPageResponse);
      },
    );

    // Keep Chrome's message channel open until the queued operation responds.
    return true;
  });
});
