import { browser, type Browser } from 'wxt/browser';
import { addSession } from './storage';
import {
  finishTaskGroupsSave,
  prepareTaskGroupsForSave,
} from './task-group-sync';
import type { SavedGroup, SavedSession, SavedTab } from './types';

type Tab = Browser.tabs.Tab;
type CapturableTab = Tab & { id: number; url: string };

/** Chrome's sentinel for "tab does not belong to a group". */
const TAB_GROUP_ID_NONE = -1;
const UNGROUPED = '';

export interface SaveResult {
  savedTabs: number;
  savedGroups: number;
  skipped: number;
}

interface SaveSelectionOptions {
  openSavedPage: boolean;
}

/**
 * Capture every tab in a window into storage, then close them — the OneTab
 * flow. The saved-tabs page is opened first so the window survives having all
 * of its tabs removed.
 */
export async function saveAndCloseTabs(windowId: number): Promise<SaveResult> {
  const allTabs = await browser.tabs.query({ windowId });
  return saveAndCloseSelection(windowId, allTabs, { openSavedPage: true });
}

/** Save and close one tab without touching the other tabs in its window. */
export async function saveAndCloseTab(tabId: number): Promise<SaveResult> {
  const tab = await browser.tabs.get(tabId);
  return saveAndCloseSelection(tab.windowId, [tab], { openSavedPage: false });
}

/** Save and close the Chrome tab group that currently contains this tab. */
export async function saveAndCloseTabGroup(tabId: number): Promise<SaveResult> {
  const tab = await browser.tabs.get(tabId);
  if (tab.groupId == null || tab.groupId === TAB_GROUP_ID_NONE) {
    throw new Error('当前标签页不在标签组中');
  }

  const tabs = await browser.tabs.query({ groupId: tab.groupId });
  return saveAndCloseSelection(tab.windowId, tabs, { openSavedPage: false });
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
    await browser.tabs.update(reusable.id, { active: true });
    return;
  }

  const created = await browser.tabs.create({
    ...(preferredWindowId == null ? {} : { windowId: preferredWindowId }),
    url: savedPageUrl,
    active: true,
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
  const allCapturable = selectedTabs
    .map((tab) => toCapturableTab(tab, savedPageUrl))
    .filter((tab): tab is CapturableTab => tab != null);
  const preparedTaskGroups = await prepareTaskGroupsForSave(windowId);
  const capturable = allCapturable.filter(
    (tab) => !preparedTaskGroups.excludedTabIds.has(tab.id),
  );
  const selectedTabIds = new Set(
    selectedTabs.flatMap((tab) => (tab.id == null ? [] : [tab.id])),
  );
  const tabsToClose = new Set([
    ...allCapturable.map((tab) => tab.id),
    ...[...preparedTaskGroups.excludedTabIds].filter((tabId) =>
      selectedTabIds.has(tabId),
    ),
  ]);

  if (tabsToClose.size === 0) {
    if (options.openSavedPage) {
      await openSavedPageForSave(windowId, savedPageUrl, tabsToClose);
    }
    return { savedTabs: 0, savedGroups: 0, skipped: selectedTabs.length };
  }

  let groups: SavedGroup[] = [];
  if (capturable.length > 0) {
    const createdAt = Date.now();
    groups = await buildGroups(capturable, windowId, createdAt);
    const session: SavedSession = {
      id: crypto.randomUUID(),
      createdAt,
      groups,
    };
    await addSession(session);
  }

  if (
    options.openSavedPage ||
    (await wouldCloseWindow(windowId, tabsToClose))
  ) {
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

function toCapturableTab(tab: Tab, savedPageUrl: string): CapturableTab | null {
  const url = tab.pendingUrl || tab.url;
  if (tab.id == null || !url || url === savedPageUrl) return null;
  return { ...tab, id: tab.id, url };
}

/** Partition tabs by their Chrome tab group, preserving tab order. */
async function buildGroups(
  tabs: CapturableTab[],
  windowId: number,
  createdAt: number,
): Promise<SavedGroup[]> {
  const chromeGroups = await browser.tabGroups.query({ windowId });
  const metaById = new Map(chromeGroups.map((g) => [g.id, g]));

  // Keyed by groupId so ungrouped tabs collapse into a single bucket.
  const buckets = new Map<number, CapturableTab[]>();
  for (const tab of tabs) {
    const key = tab.groupId ?? TAB_GROUP_ID_NONE;
    const bucket = buckets.get(key) ?? [];
    bucket.push(tab);
    buckets.set(key, bucket);
  }

  const groups: SavedGroup[] = [];
  for (const [groupId, groupTabs] of buckets) {
    const meta = metaById.get(groupId);
    groups.push({
      id: crypto.randomUUID(),
      title: meta?.title ?? UNGROUPED,
      createdAt,
      color: meta?.color,
      grouped: groupId !== TAB_GROUP_ID_NONE,
      locked: false,
      pinned: false,
      archivedAt: null,
      taskStatus: null,
      taskCompletedAt: null,
      tabs: groupTabs.map((tab) => toSavedTab(tab, createdAt)),
    });
  }

  // Real groups first; the ungrouped bucket sinks to the bottom.
  return groups.sort((a, b) => Number(b.grouped) - Number(a.grouped));
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
    await browser.tabs.update(reusable.id, { active: true });
    await browser.tabs.reload(reusable.id);
    return;
  }
  const created = await browser.tabs.create({ windowId, url, active: true });
  if (created.id != null && created.groupId !== TAB_GROUP_ID_NONE) {
    await browser.tabs.ungroup(created.id);
  }
}
