import { browser, type Browser } from 'wxt/browser';
import {
  getSessions,
  syncTaskGroupSnapshot,
  type TaskGroupTabSnapshot,
} from './storage';
import type { SavedGroup, SavedGroupColor } from './types';

const TASK_GROUP_BINDINGS_KEY = 'task-group-bindings';
const removedBrowserGroupIds = new Set<number>();
const closingWindowIds = new Set<number>();

export interface TaskGroupBinding {
  sessionId: string;
  savedGroupId: string;
  browserGroupId: number;
  windowId: number;
  savedTabIdByBrowserTabId: Record<string, string>;
  ignoredBrowserTabIds: number[];
}

export interface PreparedTaskGroupsForSave {
  excludedTabIds: Set<number>;
  bindingKeys: string[];
}

type StoredBindings = Record<string, TaskGroupBinding>;

function bindingKey(sessionId: string, savedGroupId: string): string {
  return `${sessionId}:${savedGroupId}`;
}

function isBinding(value: unknown): value is TaskGroupBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.sessionId === 'string' &&
    typeof binding.savedGroupId === 'string' &&
    typeof binding.browserGroupId === 'number' &&
    typeof binding.windowId === 'number' &&
    typeof binding.savedTabIdByBrowserTabId === 'object' &&
    binding.savedTabIdByBrowserTabId !== null &&
    Array.isArray(binding.ignoredBrowserTabIds)
  );
}

async function getBindings(): Promise<StoredBindings> {
  const stored = await browser.storage.session.get(TASK_GROUP_BINDINGS_KEY);
  const value = stored[TASK_GROUP_BINDINGS_KEY];
  if (typeof value !== 'object' || value === null) return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, binding]) =>
      isBinding(binding),
    ),
  ) as StoredBindings;
}

async function setBindings(bindings: StoredBindings): Promise<void> {
  await browser.storage.session.set({ [TASK_GROUP_BINDINGS_KEY]: bindings });
}

function getBrowserGroupTitle(group: SavedGroup): string {
  return group.title.trim() || `${group.tabs.length} 个标签页`;
}

function toSnapshot(tab: Browser.tabs.Tab, savedTabId?: string): TaskGroupTabSnapshot | null {
  if (tab.id == null) return null;
  const url = tab.pendingUrl || tab.url;
  if (!url) return null;
  return {
    browserTabId: tab.id,
    savedTabId,
    url,
    title: tab.title?.trim() || url,
    favIconUrl: tab.favIconUrl,
  };
}

function reverseTabMap(
  openedTabIdBySavedTabId: Record<string, number>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(openedTabIdBySavedTabId).map(([savedTabId, browserTabId]) => [
      String(browserTabId),
      savedTabId,
    ]),
  );
}

export async function bindOpenedTaskGroup(
  sessionId: string,
  savedGroupId: string,
  browserGroupId: number,
  windowId: number,
  openedTabIdBySavedTabId: Record<string, number>,
): Promise<void> {
  const bindings = await getBindings();
  bindings[bindingKey(sessionId, savedGroupId)] = {
    sessionId,
    savedGroupId,
    browserGroupId,
    windowId,
    savedTabIdByBrowserTabId: reverseTabMap(openedTabIdBySavedTabId),
    ignoredBrowserTabIds: [],
  };
  await setBindings(bindings);
}

export async function clearTaskGroupBinding(
  sessionId: string,
  savedGroupId: string,
): Promise<void> {
  const bindings = await getBindings();
  const key = bindingKey(sessionId, savedGroupId);
  if (!(key in bindings)) return;
  delete bindings[key];
  await setBindings(bindings);
}

export async function clearTaskGroupBindingsForWindow(windowId: number): Promise<void> {
  const bindings = await getBindings();
  let changed = false;
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.windowId !== windowId) continue;
    try {
      const group = await browser.tabGroups.get(binding.browserGroupId);
      if (group.windowId !== windowId) {
        binding.windowId = group.windowId;
        changed = true;
        continue;
      }
    } catch {
      // The whole group vanished with the window, so only its binding is cleared.
    }
    delete bindings[key];
    changed = true;
  }
  if (changed) await setBindings(bindings);
  closingWindowIds.delete(windowId);
}

export function markTaskGroupWindowClosing(windowId: number): void {
  closingWindowIds.add(windowId);
}

export function markTaskGroupRemoved(browserGroupId: number): void {
  removedBrowserGroupIds.add(browserGroupId);
}

export function markTaskGroupCreated(browserGroupId: number): void {
  removedBrowserGroupIds.delete(browserGroupId);
}

export async function ignoreTaskTab(
  sessionId: string,
  savedTabId: string,
): Promise<void> {
  const bindings = await getBindings();
  let changed = false;
  for (const binding of Object.values(bindings)) {
    if (binding.sessionId !== sessionId) continue;
    for (const [browserTabId, mappedSavedTabId] of Object.entries(
      binding.savedTabIdByBrowserTabId,
    )) {
      if (mappedSavedTabId !== savedTabId) continue;
      delete binding.savedTabIdByBrowserTabId[browserTabId];
      const id = Number(browserTabId);
      if (!binding.ignoredBrowserTabIds.includes(id)) binding.ignoredBrowserTabIds.push(id);
      changed = true;
    }
  }
  if (changed) await setBindings(bindings);
}

export async function ignoreMissingTaskGroupTabs(
  sessionId: string,
  savedGroupId: string,
  savedTabIds: string[],
): Promise<void> {
  const bindings = await getBindings();
  const binding = bindings[bindingKey(sessionId, savedGroupId)];
  if (!binding) return;

  const existingIds = new Set(savedTabIds);
  let changed = false;
  for (const [browserTabId, savedTabId] of Object.entries(
    binding.savedTabIdByBrowserTabId,
  )) {
    if (existingIds.has(savedTabId)) continue;
    delete binding.savedTabIdByBrowserTabId[browserTabId];
    const id = Number(browserTabId);
    if (!binding.ignoredBrowserTabIds.includes(id)) binding.ignoredBrowserTabIds.push(id);
    changed = true;
  }
  if (changed) await setBindings(bindings);
}

export async function focusTaskGroupBinding(
  sessionId: string,
  savedGroupId: string,
): Promise<boolean> {
  const bindings = await getBindings();
  const key = bindingKey(sessionId, savedGroupId);
  const binding = bindings[key];
  if (!binding) return false;

  try {
    const group = await browser.tabGroups.get(binding.browserGroupId);
    const tabs = await browser.tabs.query({ groupId: binding.browserGroupId });
    const firstTab = tabs.find((tab) => tab.id != null);
    if (firstTab?.id == null) throw new Error('任务标签组没有可聚焦的标签页');
    await browser.windows.update(group.windowId, { focused: true });
    await browser.tabs.update(firstTab.id, { active: true });
    return true;
  } catch {
    delete bindings[key];
    await setBindings(bindings);
    return false;
  }
}

export async function reconcileTaskGroup(browserGroupId: number): Promise<void> {
  const bindings = await getBindings();
  const matchedEntries = Object.entries(bindings).filter(
    ([, binding]) => binding.browserGroupId === browserGroupId,
  );
  if (matchedEntries.length === 0) return;

  if (removedBrowserGroupIds.has(browserGroupId)) {
    for (const [key] of matchedEntries) delete bindings[key];
    await setBindings(bindings);
    return;
  }

  let chromeGroup: Browser.tabGroups.TabGroup;
  try {
    chromeGroup = await browser.tabGroups.get(browserGroupId);
  } catch {
    for (const [key] of matchedEntries) delete bindings[key];
    await setBindings(bindings);
    return;
  }

  const browserTabs = (await browser.tabs.query({ groupId: browserGroupId })).sort(
    (a, b) => a.index - b.index,
  );
  let bindingsChanged = false;

  for (const [key, binding] of matchedEntries) {
    if (
      removedBrowserGroupIds.has(browserGroupId) ||
      closingWindowIds.has(chromeGroup.windowId)
    ) {
      delete bindings[key];
      bindingsChanged = true;
      continue;
    }
    const ignoredTabIds = new Set(binding.ignoredBrowserTabIds);
    const snapshots = browserTabs.flatMap((tab) => {
      if (tab.id == null || ignoredTabIds.has(tab.id)) return [];
      const snapshot = toSnapshot(tab, binding.savedTabIdByBrowserTabId[String(tab.id)]);
      return snapshot ? [snapshot] : [];
    });
    const previousIds = Object.entries(binding.savedTabIdByBrowserTabId)
      .filter(([browserTabId]) => !ignoredTabIds.has(Number(browserTabId)))
      .map(([, savedTabId]) => savedTabId);
    const result = await syncTaskGroupSnapshot(
      binding.sessionId,
      binding.savedGroupId,
      snapshots,
      previousIds,
      { title: chromeGroup.title ?? '', color: chromeGroup.color as SavedGroupColor },
      () =>
        !removedBrowserGroupIds.has(browserGroupId) &&
        !closingWindowIds.has(chromeGroup.windowId),
    );

    if (!result.active) {
      delete bindings[key];
      bindingsChanged = true;
      continue;
    }
    binding.windowId = chromeGroup.windowId;
    binding.savedTabIdByBrowserTabId = result.savedTabIdByBrowserTabId;
    bindingsChanged = true;
  }

  if (bindingsChanged) await setBindings(bindings);
}

export async function reconcileTaskTab(browserTabId: number): Promise<void> {
  const bindings = await getBindings();
  const groupIds = new Set(
    Object.values(bindings)
      .filter(
        (binding) =>
          binding.savedTabIdByBrowserTabId[String(browserTabId)] !== undefined ||
          binding.ignoredBrowserTabIds.includes(browserTabId),
      )
      .map((binding) => binding.browserGroupId),
  );
  await Promise.all([...groupIds].map(reconcileTaskGroup));
}

/**
 * Chrome gives a group a new ID when the whole group moves between windows.
 * Its tab IDs stay stable, so a binding can be migrated only when every mapped
 * live tab appears in exactly one newly-created group.
 */
export async function adoptMovedTaskGroup(browserGroupId: number): Promise<boolean> {
  let chromeGroup: Browser.tabGroups.TabGroup;
  try {
    chromeGroup = await browser.tabGroups.get(browserGroupId);
  } catch {
    return false;
  }

  const browserTabIds = new Set(
    (await browser.tabs.query({ groupId: browserGroupId })).flatMap((tab) =>
      tab.id == null ? [] : [tab.id],
    ),
  );
  const bindings = await getBindings();
  const candidates = Object.entries(bindings).filter(([, binding]) => {
    if (
      binding.browserGroupId === browserGroupId ||
      binding.windowId === chromeGroup.windowId ||
      !removedBrowserGroupIds.has(binding.browserGroupId)
    ) {
      return false;
    }
    const mappedTabIds = Object.keys(binding.savedTabIdByBrowserTabId).map(Number);
    return (
      mappedTabIds.length > 0 &&
      mappedTabIds.every((tabId) => browserTabIds.has(tabId))
    );
  });
  if (candidates.length !== 1) return false;

  const [, binding] = candidates[0];
  binding.browserGroupId = browserGroupId;
  binding.windowId = chromeGroup.windowId;
  await setBindings(bindings);
  return true;
}

/**
 * Snapshot live task groups before Bok closes a window. Their existing Bok
 * records remain the source of truth, so these tabs must not become a second
 * ordinary saved session. Bindings are removed only after Chrome closes them.
 */
export async function prepareTaskGroupsForSave(
  windowId: number,
): Promise<PreparedTaskGroupsForSave> {
  await restoreTaskGroupBindings();

  const initialBindings = await getBindings();
  for (const binding of Object.values(initialBindings)) {
    if (binding.windowId === windowId) {
      await reconcileTaskGroup(binding.browserGroupId);
    }
  }

  const bindings = await getBindings();
  const excludedTabIds = new Set<number>();
  const bindingKeys: string[] = [];
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.windowId !== windowId) continue;
    try {
      const group = await browser.tabGroups.get(binding.browserGroupId);
      const tabs = await browser.tabs.query({ groupId: group.id });
      for (const tab of tabs) {
        if (tab.id != null) excludedTabIds.add(tab.id);
      }
      bindingKeys.push(key);
    } catch {
      // A missing whole group must not change Bok and needs no save exclusion.
    }
  }
  return { excludedTabIds, bindingKeys };
}

export async function finishTaskGroupsSave(
  bindingKeys: string[],
  closedTabIds: Set<number>,
): Promise<void> {
  if (bindingKeys.length === 0) return;
  const bindings = await getBindings();
  let changed = false;
  for (const key of bindingKeys) {
    const binding = bindings[key];
    if (!binding) continue;
    try {
      const group = await browser.tabGroups.get(binding.browserGroupId);
      binding.windowId = group.windowId;
      for (const browserTabId of Object.keys(binding.savedTabIdByBrowserTabId)) {
        if (closedTabIds.has(Number(browserTabId))) {
          delete binding.savedTabIdByBrowserTabId[browserTabId];
        }
      }
      changed = true;
    } catch {
      delete bindings[key];
      changed = true;
    }
  }
  if (changed) await setBindings(bindings);
}

export async function restoreTaskGroupBindings(): Promise<void> {
  const bindings = await getBindings();
  const sessions = await getSessions();
  const browserGroups = await browser.tabGroups.query({});
  const browserGroupById = new Map(browserGroups.map((group) => [group.id, group]));
  const candidates = await Promise.all(
    browserGroups.map(async (browserGroup) => ({
      browserGroup,
      tabs: (await browser.tabs.query({ groupId: browserGroup.id })).sort(
        (a, b) => a.index - b.index,
      ),
    })),
  );
  const activeTaskGroupKeys = new Set(
    sessions.flatMap((session) =>
      session.groups.flatMap((group) =>
        group.taskStatus === null ? [] : [bindingKey(session.id, group.id)],
      ),
    ),
  );
  const claimedBrowserGroupIds = new Set<number>();
  let changed = false;
  for (const [key, binding] of Object.entries(bindings)) {
    if (!activeTaskGroupKeys.has(key)) {
      delete bindings[key];
      changed = true;
      continue;
    }

    let browserGroup = browserGroupById.get(binding.browserGroupId);
    if (!browserGroup) {
      const mappedTabIds = Object.keys(binding.savedTabIdByBrowserTabId).map(Number);
      const movedCandidates = candidates.filter(({ browserGroup: candidate, tabs }) =>
        candidate.windowId !== binding.windowId &&
        !claimedBrowserGroupIds.has(candidate.id) &&
        mappedTabIds.length > 0 &&
        mappedTabIds.every((tabId) => tabs.some((tab) => tab.id === tabId)),
      );
      if (movedCandidates.length === 1) {
        browserGroup = movedCandidates[0].browserGroup;
        binding.browserGroupId = browserGroup.id;
        binding.windowId = browserGroup.windowId;
        changed = true;
      }
    }

    if (!browserGroup || claimedBrowserGroupIds.has(browserGroup.id)) {
      delete bindings[key];
      changed = true;
      continue;
    }
    claimedBrowserGroupIds.add(browserGroup.id);
    if (binding.windowId !== browserGroup.windowId) {
      binding.windowId = browserGroup.windowId;
      changed = true;
    }
  }
  const existing = new Set(Object.keys(bindings));

  const matches = sessions.flatMap((session) =>
    session.groups.flatMap((savedGroup) => {
      const key = bindingKey(session.id, savedGroup.id);
      if (savedGroup.taskStatus === null || existing.has(key)) return [];
      const matchingGroups = candidates.filter(({ browserGroup, tabs }) =>
        !claimedBrowserGroupIds.has(browserGroup.id) &&
        browserGroup.title === getBrowserGroupTitle(savedGroup) &&
        tabs.length === savedGroup.tabs.length &&
        tabs.every(
          (tab, index) => (tab.pendingUrl || tab.url) === savedGroup.tabs[index]?.url,
        ),
      );
      return matchingGroups.length === 1
        ? [{ key, sessionId: session.id, savedGroup, candidate: matchingGroups[0] }]
        : [];
    }),
  );

  const matchCountByBrowserGroupId = new Map<number, number>();
  for (const match of matches) {
    const id = match.candidate.browserGroup.id;
    matchCountByBrowserGroupId.set(id, (matchCountByBrowserGroupId.get(id) ?? 0) + 1);
  }

  for (const match of matches) {
    const { browserGroup, tabs } = match.candidate;
    if (matchCountByBrowserGroupId.get(browserGroup.id) !== 1) continue;
    const savedTabIdByBrowserTabId: Record<string, string> = {};
    for (const [index, tab] of tabs.entries()) {
      if (tab.id == null) continue;
      savedTabIdByBrowserTabId[String(tab.id)] = match.savedGroup.tabs[index].id;
    }
    bindings[match.key] = {
      sessionId: match.sessionId,
      savedGroupId: match.savedGroup.id,
      browserGroupId: browserGroup.id,
      windowId: browserGroup.windowId,
      savedTabIdByBrowserTabId,
      ignoredBrowserTabIds: [],
    };
    changed = true;
  }
  if (changed) await setBindings(bindings);
}
