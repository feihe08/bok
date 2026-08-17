import { browser, type Browser } from 'wxt/browser';
import {
  collectGroupedTitles,
  getDefaultGroupTitle,
  normalizeGroupTitle,
  reserveNumericGroupTitle,
} from './group-names';
import { getSessions } from './persistence';
import { addSession, appendTabsToGroup } from './store';
import { createItemsSession } from './session-items';
import {
  finishTaskGroupsSave,
  getBoundSavedGroupForTab,
  prepareTaskGroupsForSave,
} from '../tab-group-sync/sync';
import type { SavedGroup, SavedSessionItem, SavedTab } from './model';

type Tab = Browser.tabs.Tab;
type CapturableTab = Tab & { id: number; url: string };

/** Chrome's sentinel for "tab does not belong to a group". */
const TAB_GROUP_ID_NONE = -1;

export interface SaveResult {
  savedTabs: number;
  savedGroups: number;
  skipped: number;
}

interface SaveSelectionOptions {
  openSavedPage: boolean;
  scope: 'selection' | 'tab-groups' | 'window';
  targetGroup?: { sessionId: string; groupId: string };
}

/**
 * Capture every tab in a window into storage, then close them — the OneTab
 * flow. Reuse an existing Bok tab across windows; otherwise open Bok in the
 * source window so it survives having all of its tabs removed.
 */
export async function saveAndCloseTabs(windowId: number): Promise<SaveResult> {
  const allTabs = await browser.tabs.query({ windowId });
  return saveAndCloseSelection(windowId, allTabs, {
    openSavedPage: true,
    scope: 'window',
  });
}

/** Save and close one tab without touching the other tabs in its window. */
export async function saveAndCloseTab(tabId: number): Promise<SaveResult> {
  const tab = await browser.tabs.get(tabId);
  return saveAndCloseSelection(tab.windowId, [tab], {
    openSavedPage: false,
    scope: 'selection',
  });
}

/** Save and close one tab, appending it to an existing unarchived Bok group. */
export async function saveAndCloseTabToGroup(
  tabId: number,
  sessionId: string,
  groupId: string,
): Promise<SaveResult> {
  const tab = await browser.tabs.get(tabId);
  return saveAndCloseSelection(tab.windowId, [tab], {
    openSavedPage: false,
    scope: 'selection',
    targetGroup: { sessionId, groupId },
  });
}

/** Save and close the Chrome tab group that currently contains this tab. */
export async function saveAndCloseTabGroup(tabId: number): Promise<SaveResult> {
  const tab = await browser.tabs.get(tabId);
  if (tab.groupId == null || tab.groupId === TAB_GROUP_ID_NONE) {
    throw new Error('当前标签页不在标签组中');
  }

  const tabs = await browser.tabs.query({ groupId: tab.groupId });
  return saveAndCloseSelection(tab.windowId, tabs, {
    openSavedPage: false,
    scope: 'tab-groups',
  });
}

/** Open Bok once, or focus the existing Bok tab when it is already open. */
export async function openOrFocusSavedPage(
  preferredWindowId?: number,
): Promise<void> {
  const savedPageUrl = browser.runtime.getURL('/saved.html');
  const existing = await browser.tabs.query({ url: savedPageUrl });
  const reusable =
    existing.find((tab) => tab.windowId === preferredWindowId && tab.id != null) ??
    existing.find((tab) => tab.id != null);

  if (reusable?.id != null) {
    await browser.windows.update(reusable.windowId, { focused: true });
    await browser.tabs.update(reusable.id, { active: true, pinned: true });
    return;
  }

  const created = await browser.tabs.create({
    ...(preferredWindowId == null ? {} : { windowId: preferredWindowId }),
    url: savedPageUrl,
    active: true,
    pinned: true,
  });
  if (created.id != null && created.groupId !== TAB_GROUP_ID_NONE) {
    await browser.tabs.ungroup(created.id);
  }
}

async function saveAndCloseSelection(
  windowId: number,
  selectedTabs: Tab[],
  options: SaveSelectionOptions,
): Promise<SaveResult> {
  const savedPageUrl = browser.runtime.getURL('/saved.html');
  const internalPageUrls = new Set([
    savedPageUrl,
    browser.runtime.getURL('/bookmark-manager.html'),
    browser.runtime.getURL('/options.html'),
  ]);
  const allCapturable = selectedTabs
    .map((tab) => toCapturableTab(tab, internalPageUrls))
    .filter((tab): tab is CapturableTab => tab != null);
  const preparedTaskGroups = await prepareTaskGroupsForSave(windowId);
  let capturable = allCapturable.filter(
    (tab) => !preparedTaskGroups.excludedTabIds.has(tab.id),
  );
  if (options.targetGroup) {
    const bindings = await Promise.all(
      allCapturable.map((tab) => getBoundSavedGroupForTab(tab.id)),
    );
    capturable = allCapturable.filter((_, index) => {
      const binding = bindings[index];
      return (
        binding === null ||
        binding.sessionId !== options.targetGroup?.sessionId ||
        binding.groupId !== options.targetGroup.groupId
      );
    });
  }
  const selectedTabIds = await expandSelectedTabIdsAfterRecovery(
    windowId,
    selectedTabs,
    options.scope,
  );
  const tabsToClose = new Set([
    ...allCapturable.map((tab) => tab.id),
    ...[...preparedTaskGroups.excludedTabIds].filter((tabId) =>
      selectedTabIds.has(tabId),
    ),
  ]);

  if (tabsToClose.size === 0) {
    if (options.openSavedPage) {
      await openOrFocusSavedPage(windowId);
    }
    return { savedTabs: 0, savedGroups: 0, skipped: selectedTabs.length };
  }

  let groups: SavedGroup[] = [];
  const createdAt = Date.now();
  if (options.targetGroup) {
    await appendTabsToGroup(
      options.targetGroup.sessionId,
      options.targetGroup.groupId,
      capturable.map((tab) => toSavedTab(tab, createdAt)),
    );
  } else if (capturable.length > 0) {
    const groupedTitles = collectGroupedTitles(await getSessions());
    const items = await buildItems(
      capturable,
      windowId,
      createdAt,
      groupedTitles,
    );
    groups = items.flatMap((item) => (item.type === 'group' ? [item.group] : []));
    const session = createItemsSession(crypto.randomUUID(), createdAt, items);
    await addSession(session);
  }

  if (options.openSavedPage) {
    await openOrFocusSavedPage(windowId);
  } else if (await wouldCloseWindow(windowId, tabsToClose)) {
    // Keep the window alive when the selected tabs are the only tabs left.
    await openSavedPageForSave(windowId, savedPageUrl, tabsToClose);
  }
  await browser.tabs.remove([...tabsToClose]);
  await finishTaskGroupsSave(preparedTaskGroups.bindingKeys, tabsToClose);

  return {
    savedTabs: capturable.length,
    savedGroups: groups.length,
    skipped: selectedTabs.length - capturable.length,
  };
}

async function expandSelectedTabIdsAfterRecovery(
  windowId: number,
  initiallySelectedTabs: Tab[],
  scope: SaveSelectionOptions['scope'],
): Promise<Set<number>> {
  const initialIds = new Set(
    initiallySelectedTabs.flatMap((tab) => (tab.id == null ? [] : [tab.id])),
  );
  if (scope === 'selection') return initialIds;

  const currentTabs = await browser.tabs.query({ windowId });
  if (scope === 'window') {
    return new Set(
      currentTabs.flatMap((tab) => (tab.id == null ? [] : [tab.id])),
    );
  }

  const selectedGroupIds = new Set(
    initiallySelectedTabs.flatMap((tab) =>
      tab.groupId == null || tab.groupId === TAB_GROUP_ID_NONE ? [] : [tab.groupId],
    ),
  );
  return new Set(
    currentTabs.flatMap((tab) =>
      tab.id != null && tab.groupId != null && selectedGroupIds.has(tab.groupId)
        ? [tab.id]
        : [],
    ),
  );
}

function toCapturableTab(
  tab: Tab,
  internalPageUrls: ReadonlySet<string>,
): CapturableTab | null {
  const url = tab.pendingUrl || tab.url;
  if (tab.id == null || !url || internalPageUrls.has(url)) return null;
  return { ...tab, id: tab.id, url };
}

/** Preserve Chrome tab-strip order, grouping only contiguous Chrome-group tabs. */
async function buildItems(
  tabs: CapturableTab[],
  windowId: number,
  createdAt: number,
  groupedTitles: Set<string>,
): Promise<SavedSessionItem[]> {
  const chromeGroups = await browser.tabGroups.query({ windowId });
  return buildSavedSessionItems(tabs, chromeGroups, createdAt, groupedTitles);
}

/** Map the current tab strip to ordered v3 session items. */
export function buildSavedSessionItems(
  tabs: CapturableTab[],
  chromeGroups: Browser.tabGroups.TabGroup[],
  createdAt: number,
  groupedTitles: Set<string>,
): SavedSessionItem[] {
  const metaById = new Map(chromeGroups.map((g) => [g.id, g]));
  const orderedTabs = [...tabs].sort((left, right) =>
    (left.index ?? 0) - (right.index ?? 0),
  );

  const items: SavedSessionItem[] = [];
  for (let index = 0; index < orderedTabs.length; ) {
    const tab = orderedTabs[index]!;
    const groupId = tab.groupId ?? TAB_GROUP_ID_NONE;
    if (groupId === TAB_GROUP_ID_NONE) {
      items.push({ type: 'tab', tab: toSavedTab(tab, createdAt) });
      index += 1;
      continue;
    }
    const groupTabs: CapturableTab[] = [];
    while (
      index < orderedTabs.length &&
      (orderedTabs[index]!.groupId ?? TAB_GROUP_ID_NONE) === groupId
    ) {
      groupTabs.push(orderedTabs[index]!);
      index += 1;
    }
    const meta = metaById.get(groupId);
    const requestedTitle =
      normalizeGroupTitle(meta?.title ?? '') || getDefaultGroupTitle(groupTabs.length);
    items.push({
      type: 'group',
      group: {
        id: crypto.randomUUID(),
        title: reserveNumericGroupTitle(requestedTitle, groupedTitles),
        createdAt,
        color: meta?.color,
        grouped: true,
        locked: false,
        pinned: false,
        restoredAt: null,
        archivedAt: null,
        taskStatus: null,
        taskCompletedAt: null,
        tabs: groupTabs.map((item) => toSavedTab(item, createdAt)),
      },
    });
  }
  return items;
}

function toSavedTab(tab: CapturableTab, now: number): SavedTab {
  return {
    id: crypto.randomUUID(),
    url: tab.url,
    title: tab.title?.trim() || tab.url,
    favIconUrl: tab.favIconUrl,
    createdAt: now,
    updatedAt: now,
    tags: [],
    directory: null,
    taskStatus: null,
    taskCompletedAt: null,
    archivedAt: null,
  };
}

async function wouldCloseWindow(
  windowId: number,
  tabsToClose: Set<number>,
): Promise<boolean> {
  const tabs = await browser.tabs.query({ windowId });
  return !tabs.some((tab) => tab.id != null && !tabsToClose.has(tab.id));
}

async function openSavedPageForSave(
  windowId: number,
  url: string,
  tabsToClose: Set<number>,
): Promise<void> {
  const existing = await browser.tabs.query({ windowId, url });
  const reusable = existing.find(
    (tab) => tab.id != null && !tabsToClose.has(tab.id),
  );

  if (reusable?.id != null) {
    await browser.tabs.update(reusable.id, { active: true, pinned: true });
    await browser.tabs.reload(reusable.id);
    return;
  }
  const created = await browser.tabs.create({
    windowId,
    url,
    active: true,
    pinned: true,
  });
  if (created.id != null && created.groupId !== TAB_GROUP_ID_NONE) {
    await browser.tabs.ungroup(created.id);
  }
}
