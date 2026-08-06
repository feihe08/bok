import {
  isSavedPageCommand,
  type SavedPageResponse,
} from '../lib/messages';
import {
  openOrFocusSavedPage,
  saveAndCloseTab,
  saveAndCloseTabGroup,
  saveAndCloseTabs,
} from '../lib/save-tabs';
import { executeSavedPageCommand } from '../lib/saved-page-operations';
import {
  archiveEligibleGroups,
  ensureUniqueGroupedTitles,
} from '../lib/storage';
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
} from '../lib/task-group-sync';

const AUTO_ARCHIVE_ALARM = 'bok-auto-archive';
const AUTO_ARCHIVE_INTERVAL_MINUTES = 60;
const TASK_GROUP_RECONCILE_DEBOUNCE_MS = 120;
const GROUP_BINDING_RESTORE_DEBOUNCE_MS = 750;
const OPEN_BOK_MENU_ID = 'bok/open';
const SAVE_ALL_MENU_ID = 'bok/save-all';
const SAVE_TAB_MENU_ID = 'bok/save-tab';
const SAVE_GROUP_MENU_ID = 'bok/save-group';
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

const CONTEXT_MENU_COMMANDS = [
  { id: OPEN_BOK_MENU_ID, title: '打开 Bok' },
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

let operationQueue = Promise.resolve();
let taskGroupReconcileTimer: ReturnType<typeof setTimeout> | undefined;
let groupBindingRestoreTimer: ReturnType<typeof setTimeout> | undefined;
const pendingTaskGroupAdoptionIds = new Set<number>();
const pendingTaskGroupIds = new Set<number>();
const pendingTaskTabIds = new Set<number>();

function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
  const task = operationQueue.then(operation);
  operationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function ensureAutoArchiveAlarm(): Promise<void> {
  const existing = await browser.alarms.get(AUTO_ARCHIVE_ALARM);
  if (existing) return;
  await browser.alarms.create(AUTO_ARCHIVE_ALARM, {
    periodInMinutes: AUTO_ARCHIVE_INTERVAL_MINUTES,
  });
}

async function runAutoArchive(): Promise<void> {
  const archivedGroups = await archiveEligibleGroups();
  if (archivedGroups > 0) {
    console.log('[bok] automatically archived groups', { archivedGroups });
  }
}

async function installContextMenus(): Promise<void> {
  const [activeTab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
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
  tab?: { id?: number; windowId?: number },
) {
  if (menuId === OPEN_BOK_MENU_ID) {
    await openOrFocusSavedPage(tab?.windowId);
    return undefined;
  }
  if (tab?.id == null) throw new Error('找不到当前标签页');
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
  browser.runtime.onInstalled.addListener(() => {
    void installContextMenus().catch((error) => {
      console.error('[bok] failed to install context menus', error);
    });
  });

  void ensureAutoArchiveAlarm().catch((error) => {
    console.error('[bok] failed to schedule automatic archive', error);
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
    if (alarm.name !== AUTO_ARCHIVE_ALARM) return;
    void enqueueOperation(runAutoArchive).catch((error) => {
      console.error('[bok] failed to run scheduled archive', error);
    });
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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

  browser.tabs.onMoved.addListener((tabId) => {
    scheduleTaskTabReconcile(tabId);
  });

  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId < 0) return;
    void refreshSaveGroupMenuState().catch(() => undefined);
  });

  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
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
    } catch (err) {
      console.error('[bok] failed to save tabs', err);
    }
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const menuId = normalizeContextMenuId(String(info.menuItemId));
    if (!CONTEXT_MENU_COMMAND_IDS.has(menuId)) return;

    void enqueueOperation(() => executeContextMenuCommand(menuId, tab)).then(
      (result) => {
        console.log('[bok] completed context menu command', {
          menuId,
          result,
        });
      },
      (error) => {
        console.error('[bok] failed context menu command', {
          menuId,
          error,
        });
      },
    );
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
