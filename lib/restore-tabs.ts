import { browser } from 'wxt/browser';
import type {
  OpenDestination,
  OpenGroupResult,
  OpenMode,
} from './messages';
import { getSavedGroupTitle } from './group-names';
import { getSavedGroup } from './storage';
import type { SavedTab } from './types';

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
