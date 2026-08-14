export interface SavedTabIdentity {
  id: string;
  url: string;
}

export interface BrowserTabIdentity {
  id: number;
  url: string;
}

export interface GroupMergePlan {
  overlapCount: number;
  overlapRatio: number;
  savedTabIdByBrowserTabId: Record<string, string>;
  unmatchedSavedTabIds: string[];
}

export interface ScoredRecoveryCandidate<T> {
  savedGroupKey: string;
  browserGroupId: number;
  overlapCount: number;
  overlapRatio: number;
  value: T;
}

export interface TaskGroupBinding {
  sessionId: string;
  savedGroupId: string;
  browserGroupId: number;
  windowId: number;
  savedTabIdByBrowserTabId: Record<string, string>;
  ignoredBrowserTabIds: number[];
  pendingBrowserTitle?: string;
}

export interface PreparedTaskGroupsForSave {
  excludedTabIds: Set<number>;
  bindingKeys: string[];
}
