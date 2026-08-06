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

const SAME_GROUP_OVERLAP_THRESHOLD = 0.5;

/**
 * Match duplicate URLs occurrence-by-occurrence so overlap and merge behavior
 * stay correct even when either group intentionally contains duplicates.
 */
export function createGroupMergePlan(
  savedTabs: SavedTabIdentity[],
  browserTabs: BrowserTabIdentity[],
): GroupMergePlan {
  const availableSavedTabsByUrl = new Map<string, SavedTabIdentity[]>();
  for (const savedTab of savedTabs) {
    const available = availableSavedTabsByUrl.get(savedTab.url) ?? [];
    available.push(savedTab);
    availableSavedTabsByUrl.set(savedTab.url, available);
  }

  const matchedSavedTabIds = new Set<string>();
  const savedTabIdByBrowserTabId: Record<string, string> = {};
  for (const browserTab of browserTabs) {
    const available = availableSavedTabsByUrl.get(browserTab.url);
    const matched = available?.shift();
    if (!matched) continue;
    matchedSavedTabIds.add(matched.id);
    savedTabIdByBrowserTabId[String(browserTab.id)] = matched.id;
  }

  const denominator = Math.max(savedTabs.length, browserTabs.length);
  const overlapCount = matchedSavedTabIds.size;
  return {
    overlapCount,
    overlapRatio: denominator === 0 ? 0 : overlapCount / denominator,
    savedTabIdByBrowserTabId,
    unmatchedSavedTabIds: savedTabs
      .filter((savedTab) => !matchedSavedTabIds.has(savedTab.id))
      .map((savedTab) => savedTab.id),
  };
}

export function hasSufficientTabOverlap(
  plan: Pick<GroupMergePlan, 'overlapRatio'>,
): boolean {
  return plan.overlapRatio > SAME_GROUP_OVERLAP_THRESHOLD;
}

function compareRecoveryCandidateScore<T>(
  left: ScoredRecoveryCandidate<T>,
  right: ScoredRecoveryCandidate<T>,
): number {
  return (
    right.overlapRatio - left.overlapRatio ||
    right.overlapCount - left.overlapCount
  );
}

function getUniqueBestCandidate<T>(
  candidates: ScoredRecoveryCandidate<T>[],
): ScoredRecoveryCandidate<T> | undefined {
  const sorted = [...candidates].sort(compareRecoveryCandidateScore);
  const best = sorted[0];
  const second = sorted[1];
  if (!best) return undefined;
  if (!second || compareRecoveryCandidateScore(best, second) !== 0) return best;
  return undefined;
}

/**
 * A recovery is safe only when the same edge is the unique strongest match
 * from both the Bok-group side and the Chrome-group side.
 */
export function selectUnambiguousRecoveryCandidates<T>(
  candidates: ScoredRecoveryCandidate<T>[],
): ScoredRecoveryCandidate<T>[] {
  const bySavedGroup = new Map<string, ScoredRecoveryCandidate<T>[]>();
  const byBrowserGroup = new Map<number, ScoredRecoveryCandidate<T>[]>();

  for (const candidate of candidates) {
    const savedCandidates = bySavedGroup.get(candidate.savedGroupKey) ?? [];
    savedCandidates.push(candidate);
    bySavedGroup.set(candidate.savedGroupKey, savedCandidates);

    const browserCandidates = byBrowserGroup.get(candidate.browserGroupId) ?? [];
    browserCandidates.push(candidate);
    byBrowserGroup.set(candidate.browserGroupId, browserCandidates);
  }

  const bestBySavedGroup = new Map(
    [...bySavedGroup].flatMap(([key, groupCandidates]) => {
      const best = getUniqueBestCandidate(groupCandidates);
      return best ? [[key, best] as const] : [];
    }),
  );
  const bestByBrowserGroup = new Map(
    [...byBrowserGroup].flatMap(([id, groupCandidates]) => {
      const best = getUniqueBestCandidate(groupCandidates);
      return best ? [[id, best] as const] : [];
    }),
  );

  return candidates.filter(
    (candidate) =>
      bestBySavedGroup.get(candidate.savedGroupKey) === candidate &&
      bestByBrowserGroup.get(candidate.browserGroupId) === candidate,
  );
}
