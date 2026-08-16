import { browser } from 'wxt/browser';
import type {
  OpenDestination,
  OpenGroupResult,
  OpenMode,
  OpenSessionResult,
} from './messages';
import { getSavedGroupTitle } from './group-names';
import { getSavedGroup } from './store';
import type { SavedGroup, SavedSession, SavedTab } from './model';

/**
 * The public opening result plus the transient Chrome identifiers needed by
 * background task-group synchronization. The extra fields are intentionally
 * not part of the saved-page message contract.
 */
export interface OpenedSavedGroupResult extends OpenGroupResult {
  windowId: number;
  browserGroupId?: number;
  openedTabIdBySavedTabId: Record<string, number>;
}

export interface OpenedSessionGroup {
  savedGroupId: string;
  browserGroupId: number;
  openedTabIdBySavedTabId: Record<string, number>;
}

export interface OpenedSavedSessionResult extends OpenSessionResult {
  windowId: number;
  createdWindow: boolean;
  openedBrowserTabIds: number[];
  openedTaskGroups: OpenedSessionGroup[];
}

interface SessionOpenItem {
  group?: SavedGroup;
  tabs: SavedTab[];
}

export async function openSavedGroup(
  currentWindowId: number | undefined,
  sessionId: string,
  groupId: string,
  mode: OpenMode,
  destination: OpenDestination,
  tabIds: string[],
): Promise<OpenedSavedGroupResult> {
  const group = await getSavedGroup(sessionId, groupId);
  const selectedIds = new Set(tabIds);
  const selectedTabs = group.tabs.filter((tab) => selectedIds.has(tab.id));
  const total = selectedTabs.length;
  let openedTabCount = 0;

  if (tabIds.length === 0) {
    throw new Error('打开失败：没有可打开的标签页，Bok 记录已保留');
  }
  if (selectedIds.size !== total) {
    throw new Error('打开失败：部分标签页已不存在，Bok 记录已保留');
  }
  if (destination === 'current-window' && currentWindowId == null) {
    throw new Error('打开失败：无法确定保存页面所在的浏览器窗口，Bok 记录已保留');
  }

  try {
    const { windowId, openedTabs } =
      destination === 'new-window'
        ? await openInNewWindow(selectedTabs, () => {
            openedTabCount += 1;
          })
        : await openInCurrentWindow(
            currentWindowId as number,
            selectedTabs,
            () => {
              openedTabCount += 1;
            },
          );

    const openedTabIds = openedTabs.map(({ browserTabId }) => browserTabId);
    let browserGroupId: number | undefined;
    if (mode === 'tab-group') {
      browserGroupId = await browser.tabs.group({
        tabIds: openedTabIds as [number, ...number[]],
        createProperties: { windowId },
      });
      await browser.tabGroups.update(browserGroupId, {
        title: getSavedGroupTitle(group),
        color: group.color ?? 'grey',
      });
    }

    await browser.tabs.update(openedTabIds[0], { active: true });

    return {
      openedTabs: openedTabCount,
      mode,
      destination,
      windowId,
      browserGroupId,
      openedTabIdBySavedTabId: Object.fromEntries(
        openedTabs.map(({ savedTabId, browserTabId }) => [savedTabId, browserTabId]),
      ),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `打开失败：已打开 ${openedTabCount}/${total} 个标签页；${reason}，Bok 记录已保留`,
      { cause: error },
    );
  }
}

export async function openSavedSession(
  currentWindowId: number | undefined,
  session: SavedSession,
  destination: OpenDestination,
): Promise<OpenedSavedSessionResult> {
  const items: SessionOpenItem[] = session.items.map((item) =>
    item.type === 'tab'
      ? { tabs: [item.tab] }
      : { group: item.group, tabs: item.group.tabs },
  );
  const firstSavedTab = items.find((item) => item.tabs.length > 0)?.tabs[0];
  const totalTabs = items.reduce((total, item) => total + item.tabs.length, 0);
  if (!firstSavedTab || totalTabs === 0) {
    throw new Error('打开失败：保存记录中没有可打开的标签页，Bok 记录已保留');
  }
  if (destination === 'current-window' && currentWindowId == null) {
    throw new Error('打开失败：无法确定保存页面所在的浏览器窗口，Bok 记录已保留');
  }

  const openedBrowserTabIds: number[] = [];
  const openedTaskGroups: OpenedSessionGroup[] = [];
  let createdWindowId: number | undefined;
  let targetWindowId: number | undefined;
  let nextIndex: number;
  let preopenedFirstTabId: number | undefined;

  try {
    if (destination === 'new-window') {
      const createdWindow = await browser.windows.create({
        url: firstSavedTab.url,
        focused: true,
      });
      if (!createdWindow || createdWindow.id == null) {
        throw new Error('浏览器没有返回新窗口 ID');
      }
      createdWindowId = createdWindow.id;
      targetWindowId = createdWindow.id;
      const firstTab =
        createdWindow.tabs?.find((tab) => tab.id != null) ??
        (await browser.tabs.query({ windowId: createdWindow.id }))[0];
      if (firstTab?.id == null) throw new Error('浏览器没有返回新标签页 ID');
      preopenedFirstTabId = firstTab.id;
      openedBrowserTabIds.push(firstTab.id);
      nextIndex = (firstTab.index ?? 0) + 1;
    } else {
      targetWindowId = currentWindowId as number;
      const currentTabs = await browser.tabs.query({ windowId: targetWindowId });
      nextIndex = currentTabs.reduce(
        (next, tab) => Math.max(next, (tab.index ?? -1) + 1),
        0,
      );
    }

    let usedPreopenedFirstTab = false;
    for (const item of items) {
      const itemBrowserTabIds: number[] = [];
      const openedTabIdBySavedTabId: Record<string, number> = {};
      for (const savedTab of item.tabs) {
        let browserTabId: number;
        if (!usedPreopenedFirstTab && preopenedFirstTabId != null) {
          browserTabId = preopenedFirstTabId;
          usedPreopenedFirstTab = true;
        } else {
          const createdTab = await browser.tabs.create({
            windowId: targetWindowId,
            index: nextIndex,
            url: savedTab.url,
            active: false,
          });
          if (createdTab.id == null) throw new Error('浏览器没有返回新标签页 ID');
          browserTabId = createdTab.id;
          openedBrowserTabIds.push(browserTabId);
          nextIndex += 1;
        }
        itemBrowserTabIds.push(browserTabId);
        openedTabIdBySavedTabId[savedTab.id] = browserTabId;
      }

      if (!item.group || itemBrowserTabIds.length === 0) continue;
      const browserGroupId = await browser.tabs.group({
        tabIds: itemBrowserTabIds as [number, ...number[]],
        createProperties: { windowId: targetWindowId },
      });
      await browser.tabGroups.update(browserGroupId, {
        title: getSavedGroupTitle(item.group),
        color: item.group.color ?? 'grey',
      });
      openedTaskGroups.push({
        savedGroupId: item.group.id,
        browserGroupId,
        openedTabIdBySavedTabId,
      });
    }

    await browser.tabs.update(openedBrowserTabIds[0]!, { active: true });
    return {
      openedTabs: openedBrowserTabIds.length,
      openedGroups: openedTaskGroups.length,
      destination,
      windowId: targetWindowId,
      createdWindow: createdWindowId != null,
      openedBrowserTabIds,
      openedTaskGroups,
    };
  } catch (error) {
    const rolledBack = await rollbackOpenedTabs(
      targetWindowId,
      openedBrowserTabIds,
    );
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `打开失败：${reason}；${
        rolledBack ? '已回滚本次打开内容' : '未能完整回滚本次打开内容'
      }，Bok 记录已保留`,
      { cause: error },
    );
  }
}

export async function rollbackOpenedSavedSession(
  opened: OpenedSavedSessionResult,
): Promise<boolean> {
  return rollbackOpenedTabs(opened.windowId, opened.openedBrowserTabIds);
}

async function rollbackOpenedTabs(
  targetWindowId: number | undefined,
  openedBrowserTabIds: number[],
): Promise<boolean> {
  if (openedBrowserTabIds.length === 0) return true;
  if (targetWindowId == null) return false;

  let currentTabs: Array<{ id?: number }>;
  try {
    currentTabs = await browser.tabs.query({ windowId: targetWindowId });
  } catch {
    return false;
  }

  const openedTabIds = new Set(openedBrowserTabIds);
  const removableTabIds = currentTabs.flatMap((tab) =>
    tab.id != null && openedTabIds.has(tab.id) ? [tab.id] : [],
  );
  if (removableTabIds.length === 0) return false;

  try {
    await browser.tabs.remove(removableTabIds);
  } catch {
    return false;
  }
  return removableTabIds.length === openedBrowserTabIds.length;
}

async function openInCurrentWindow(
  windowId: number,
  tabs: SavedTab[],
  onOpened: () => void,
): Promise<{ windowId: number; openedTabs: OpenedTab[] }> {
  const openedTabs: OpenedTab[] = [];
  for (const savedTab of tabs) {
    const tab = await browser.tabs.create({
      windowId,
      url: savedTab.url,
      active: false,
    });
    onOpened();
    if (tab.id == null) throw new Error('浏览器没有返回新标签页 ID');
    openedTabs.push({ savedTabId: savedTab.id, browserTabId: tab.id });
  }
  return { windowId, openedTabs };
}

async function openInNewWindow(
  tabs: SavedTab[],
  onOpened: () => void,
): Promise<{ windowId: number; openedTabs: OpenedTab[] }> {
  const createdWindow = await browser.windows.create({
    url: tabs[0].url,
    focused: true,
  });
  if (!createdWindow || createdWindow.id == null) {
    throw new Error('浏览器没有返回新窗口 ID');
  }
  onOpened();

  const firstTab =
    createdWindow.tabs?.find((tab) => tab.id != null) ??
    (await browser.tabs.query({ windowId: createdWindow.id }))[0];
  if (firstTab?.id == null) throw new Error('浏览器没有返回新标签页 ID');

  const openedTabs = [{ savedTabId: tabs[0].id, browserTabId: firstTab.id }];
  for (const savedTab of tabs.slice(1)) {
    const tab = await browser.tabs.create({
      windowId: createdWindow.id,
      url: savedTab.url,
      active: false,
    });
    onOpened();
    if (tab.id == null) throw new Error('浏览器没有返回新标签页 ID');
    openedTabs.push({ savedTabId: savedTab.id, browserTabId: tab.id });
  }
  return { windowId: createdWindow.id, openedTabs };
}

interface OpenedTab {
  savedTabId: string;
  browserTabId: number;
}
