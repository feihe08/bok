import { browser, type Browser } from 'wxt/browser';
import {
  createGroupMergePlan,
  hasSufficientTabOverlap,
  selectUnambiguousRecoveryCandidates,
} from './recovery';
import type {
  PreparedTaskGroupsForSave,
  ScoredRecoveryCandidate,
  TaskGroupBinding,
} from './model';
import {
  getSavedGroupTitle,
  type GroupedTitleChange,
} from '../saved-pages/group-names';
import {
  getSavedGroup,
  syncTaskGroupSnapshot,
  type TaskGroupTabSnapshot,
} from '../saved-pages/store';
import { getSessions } from '../saved-pages/persistence';
import type { SavedGroup, SavedGroupColor } from '../saved-pages/model';

const TASK_GROUP_BINDINGS_KEY = 'task-group-bindings';
const removedBrowserGroupIds = new Set<number>();
const closingWindowIds = new Set<number>();

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
    Array.isArray(binding.ignoredBrowserTabIds) &&
    (binding.pendingBrowserTitle === undefined ||
      typeof binding.pendingBrowserTitle === 'string')
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
  return getSavedGroupTitle(group);
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

function getRecoveryMergePlan(
  savedGroup: SavedGroup,
  browserTabs: Browser.tabs.Tab[],
) {
  const browserTabIdentities = browserTabs.flatMap((tab) => {
    const snapshot = toSnapshot(tab);
    return snapshot
      ? [{ id: snapshot.browserTabId, url: snapshot.url }]
      : [];
  });
  return createGroupMergePlan(savedGroup.tabs, browserTabIdentities);
}

function hasMatchingRecoveryTitle(
  savedGroup: SavedGroup,
  browserGroup: Browser.tabGroups.TabGroup,
): boolean {
  const browserTitle = (browserGroup.title ?? '').trim();
  return (
    browserTitle === savedGroup.title.trim() ||
    browserTitle === getBrowserGroupTitle(savedGroup).trim()
  );
}

async function mergeAndBindRecoveredGroup(
  sessionId: string,
  savedGroupId: string,
  browserGroupId: number,
): Promise<TaskGroupBinding | null> {
  const savedGroup = await getSavedGroup(sessionId, savedGroupId);

  const browserGroup = await browser.tabGroups.get(browserGroupId);
  const browserTabs = (await browser.tabs.query({ groupId: browserGroupId })).sort(
    (a, b) => a.index - b.index,
  );
  if (!hasMatchingRecoveryTitle(savedGroup, browserGroup)) return null;

  const mergePlan = getRecoveryMergePlan(savedGroup, browserTabs);
  if (!hasSufficientTabOverlap(mergePlan)) return null;

  const savedTabsById = new Map(savedGroup.tabs.map((tab) => [tab.id, tab]));
  const preferredSavedTabIdByBrowserTabId = {
    ...mergePlan.savedTabIdByBrowserTabId,
  };
  const createdBrowserTabIds: number[] = [];

  try {
    for (const savedTabId of mergePlan.unmatchedSavedTabIds) {
      const savedTab = savedTabsById.get(savedTabId);
      if (!savedTab) continue;
      const createdTab = await browser.tabs.create({
        windowId: browserGroup.windowId,
        url: savedTab.url,
        active: false,
      });
      if (createdTab.id == null) {
        throw new Error('浏览器没有返回合并标签页 ID');
      }
      createdBrowserTabIds.push(createdTab.id);
      preferredSavedTabIdByBrowserTabId[String(createdTab.id)] = savedTab.id;
    }

    if (createdBrowserTabIds.length > 0) {
      await browser.tabs.group({
        groupId: browserGroupId,
        tabIds: createdBrowserTabIds as [number, ...number[]],
      });
    }

    const currentBrowserGroup = await browser.tabGroups.get(browserGroupId);
    const mergedBrowserTabs = (
      await browser.tabs.query({ groupId: browserGroupId })
    ).sort((a, b) => a.index - b.index);
    const snapshots = mergedBrowserTabs.flatMap((tab) => {
      if (tab.id == null) return [];
      const savedTabId = preferredSavedTabIdByBrowserTabId[String(tab.id)];
      const savedTab = savedTabId ? savedTabsById.get(savedTabId) : undefined;
      const snapshot = toSnapshot(
        tab,
        savedTabId,
      );
      if (!snapshot) return [];
      return [
        savedTab
          ? {
              ...snapshot,
              title: tab.title?.trim() ? snapshot.title : savedTab.title,
              favIconUrl: snapshot.favIconUrl ?? savedTab.favIconUrl,
            }
          : snapshot,
      ];
    });
    const result = await syncTaskGroupSnapshot(
      sessionId,
      savedGroupId,
      snapshots,
      savedGroup.tabs.map((tab) => tab.id),
      {
        color: currentBrowserGroup.color as SavedGroupColor,
      },
    );
    if (!result.active) {
      if (createdBrowserTabIds.length > 0) {
        await browser.tabs.remove(createdBrowserTabIds).catch(() => undefined);
      }
      return null;
    }
    if (
      result.groupTitle !== undefined &&
      result.groupTitle !== (currentBrowserGroup.title ?? '')
    ) {
      await browser.tabGroups.update(browserGroupId, {
        title: result.groupTitle,
      });
    }

    return {
      sessionId,
      savedGroupId,
      browserGroupId,
      windowId: currentBrowserGroup.windowId,
      savedTabIdByBrowserTabId: result.savedTabIdByBrowserTabId,
      ignoredBrowserTabIds: [],
    };
  } catch (error) {
    if (createdBrowserTabIds.length > 0) {
      await browser.tabs.remove(createdBrowserTabIds).catch(() => undefined);
    }
    throw error;
  }
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

export interface OpenedTaskGroupBinding {
  savedGroupId: string;
  browserGroupId: number;
  windowId: number;
  openedTabIdBySavedTabId: Record<string, number>;
}

export async function bindOpenedTaskGroups(
  sessionId: string,
  openedGroups: OpenedTaskGroupBinding[],
): Promise<void> {
  if (openedGroups.length === 0) return;
  const bindings = await getBindings();
  for (const opened of openedGroups) {
    bindings[bindingKey(sessionId, opened.savedGroupId)] = {
      sessionId,
      savedGroupId: opened.savedGroupId,
      browserGroupId: opened.browserGroupId,
      windowId: opened.windowId,
      savedTabIdByBrowserTabId: reverseTabMap(
        opened.openedTabIdBySavedTabId,
      ),
      ignoredBrowserTabIds: [],
    };
  }
  await setBindings(bindings);
}

export async function bindOpenedTaskGroup(
  sessionId: string,
  savedGroupId: string,
  browserGroupId: number,
  windowId: number,
  openedTabIdBySavedTabId: Record<string, number>,
): Promise<void> {
  await bindOpenedTaskGroups(sessionId, [
    {
      savedGroupId,
      browserGroupId,
      windowId,
      openedTabIdBySavedTabId,
    },
  ]);
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

export async function clearTaskGroupBindingsForSession(
  sessionId: string,
): Promise<void> {
  const bindings = await getBindings();
  let changed = false;
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.sessionId !== sessionId) continue;
    delete bindings[key];
    changed = true;
  }
  if (changed) await setBindings(bindings);
}

export async function getActiveTaskGroupBindings(
  sessionId: string,
  savedGroupIds: string[],
): Promise<Set<string>> {
  const bindings = await getBindings();
  const active = new Set<string>();
  for (const savedGroupId of savedGroupIds) {
    const key = bindingKey(sessionId, savedGroupId);
    const binding = bindings[key];
    if (!binding) continue;
    try {
      await browser.tabGroups.get(binding.browserGroupId);
      active.add(savedGroupId);
    } catch {
      // Read-only preflight: stale bindings are cleaned by the normal restore path.
    }
  }
  return active;
}

export async function getBoundSavedGroupForTab(
  browserTabId: number,
): Promise<{ sessionId: string; groupId: string } | null> {
  const matches = Object.values(await getBindings()).filter(
    (binding) =>
      binding.savedTabIdByBrowserTabId[String(browserTabId)] !== undefined,
  );
  return matches.length === 1
    ? {
        sessionId: matches[0].sessionId,
        groupId: matches[0].savedGroupId,
      }
    : null;
}

export async function updateBoundGroupTitle(
  sessionId: string,
  savedGroupId: string,
  title: string,
  options: { keepPendingOnFailure?: boolean } = {},
): Promise<void> {
  const bindings = await getBindings();
  const key = bindingKey(sessionId, savedGroupId);
  const binding = bindings[key];
  if (!binding) return;

  const previousPendingBrowserTitle = binding.pendingBrowserTitle;
  binding.pendingBrowserTitle = title;
  await setBindings(bindings);

  try {
    await browser.tabGroups.update(binding.browserGroupId, { title });
    delete binding.pendingBrowserTitle;
    await setBindings(bindings);
    return;
  } catch (initialError) {
    let failure: unknown = initialError;
    try {
      const mappedTabIds = Object.keys(binding.savedTabIdByBrowserTabId).map(Number);
      const matchingGroups = await Promise.all(
        (await browser.tabGroups.query({})).map(async (group) => ({
          group,
          tabIds: new Set(
            (await browser.tabs.query({ groupId: group.id })).flatMap((tab) =>
              tab.id == null ? [] : [tab.id],
            ),
          ),
        })),
      );
      const candidates = matchingGroups.filter(
        ({ tabIds }) =>
          mappedTabIds.length > 0 &&
          mappedTabIds.every((browserTabId) => tabIds.has(browserTabId)),
      );
      if (candidates.length !== 1) throw initialError;

      const resolvedGroup = candidates[0].group;
      await browser.tabGroups.update(resolvedGroup.id, { title });
      binding.browserGroupId = resolvedGroup.id;
      binding.windowId = resolvedGroup.windowId;
      delete binding.pendingBrowserTitle;
      await setBindings(bindings);
      return;
    } catch (retryError) {
      failure = retryError;
    }

    if (!options.keepPendingOnFailure) {
      if (previousPendingBrowserTitle === undefined) {
        delete binding.pendingBrowserTitle;
      } else {
        binding.pendingBrowserTitle = previousPendingBrowserTitle;
      }
      await setBindings(bindings);
    }
    const detail = failure instanceof Error ? `：${failure.message}` : '';
    throw new Error(`无法同步 Chrome 标签组名称${detail}`);
  }
}

export async function synchronizeBoundGroupTitles(
  renamedGroups: GroupedTitleChange[] = [],
): Promise<
  Array<{
    sessionId: string;
    savedGroupId: string;
    error: unknown;
  }>
> {
  const bindings = await getBindings();
  const renamedTitleByBindingKey = new Map(
    renamedGroups.map((group) => [
      bindingKey(group.sessionId, group.groupId),
      group.groupTitle,
    ]),
  );
  const failures: Array<{
    sessionId: string;
    savedGroupId: string;
    error: unknown;
  }> = [];

  for (const [key, binding] of Object.entries(bindings)) {
    const title =
      renamedTitleByBindingKey.get(key) ?? binding.pendingBrowserTitle;
    if (title === undefined) continue;
    try {
      await updateBoundGroupTitle(
        binding.sessionId,
        binding.savedGroupId,
        title,
        { keepPendingOnFailure: true },
      );
    } catch (error) {
      failures.push({
        sessionId: binding.sessionId,
        savedGroupId: binding.savedGroupId,
        error,
      });
    }
  }

  return failures;
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
    if (firstTab?.id == null) throw new Error('同步标签组没有可聚焦的标签页');
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
    const browserTitle = chromeGroup.title ?? '';
    const synchronizedTitle = binding.pendingBrowserTitle ?? browserTitle;
    const result = await syncTaskGroupSnapshot(
      binding.sessionId,
      binding.savedGroupId,
      snapshots,
      previousIds,
      {
        title: synchronizedTitle,
        color: chromeGroup.color as SavedGroupColor,
      },
      () =>
        !removedBrowserGroupIds.has(browserGroupId) &&
        !closingWindowIds.has(chromeGroup.windowId),
    );

    if (!result.active) {
      delete bindings[key];
      bindingsChanged = true;
      continue;
    }
    if (
      result.groupTitle !== undefined &&
      result.groupTitle !== browserTitle
    ) {
      try {
        await browser.tabGroups.update(browserGroupId, {
          title: result.groupTitle,
        });
        delete binding.pendingBrowserTitle;
      } catch {
        binding.pendingBrowserTitle = result.groupTitle;
      }
    } else if (binding.pendingBrowserTitle === browserTitle) {
      delete binding.pendingBrowserTitle;
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
 * Snapshot live synced groups before Bok closes a window. Their existing Bok
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
  const activeSyncedGroupKeys = new Set(
    sessions.flatMap((session) =>
      session.items.flatMap((item) =>
        item.type === 'group'
          ? [bindingKey(session.id, item.group.id)]
          : [],
      ),
    ),
  );
  const claimedBrowserGroupIds = new Set<number>();
  let changed = false;
  for (const [key, binding] of Object.entries(bindings)) {
    if (!activeSyncedGroupKeys.has(key)) {
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

  const recoveryCandidates: Array<
    ScoredRecoveryCandidate<{
      key: string;
      sessionId: string;
      savedGroupId: string;
    }>
  > = [];
  for (const session of sessions) {
    for (const item of session.items) {
      if (item.type !== 'group') continue;
      const savedGroup = item.group;
      const key = bindingKey(session.id, savedGroup.id);
      if (existing.has(key)) continue;

      for (const candidate of candidates) {
        const { browserGroup, tabs } = candidate;
        if (
          claimedBrowserGroupIds.has(browserGroup.id) ||
          !hasMatchingRecoveryTitle(savedGroup, browserGroup)
        ) {
          continue;
        }
        const mergePlan = getRecoveryMergePlan(savedGroup, tabs);
        if (!hasSufficientTabOverlap(mergePlan)) continue;
        recoveryCandidates.push({
          savedGroupKey: key,
          browserGroupId: browserGroup.id,
          overlapCount: mergePlan.overlapCount,
          overlapRatio: mergePlan.overlapRatio,
          value: {
            key,
            sessionId: session.id,
            savedGroupId: savedGroup.id,
          },
        });
      }
    }
  }

  const selectedRecoveries = selectUnambiguousRecoveryCandidates(
    recoveryCandidates,
  );
  for (const recovery of selectedRecoveries) {
    try {
      const binding = await mergeAndBindRecoveredGroup(
        recovery.value.sessionId,
        recovery.value.savedGroupId,
        recovery.browserGroupId,
      );
      if (!binding) continue;
      bindings[recovery.value.key] = binding;
      claimedBrowserGroupIds.add(recovery.browserGroupId);
      changed = true;
    } catch (error) {
      console.error('[bok] failed to merge recovered synced group', {
        savedGroupId: recovery.value.savedGroupId,
        browserGroupId: recovery.browserGroupId,
        error,
      });
    }
  }
  if (changed) await setBindings(bindings);
}
