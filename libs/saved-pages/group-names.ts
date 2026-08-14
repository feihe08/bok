import type { SavedGroup, SavedSession } from './model';

export interface GroupedTitleChange {
  sessionId: string;
  groupId: string;
  groupTitle: string;
}

export function normalizeGroupTitle(title: string): string {
  return title.trim();
}

export function getDefaultGroupTitle(tabCount: number): string {
  return `${tabCount} 个标签页`;
}

export function getSavedGroupTitle(group: SavedGroup): string {
  return normalizeGroupTitle(group.title) || getDefaultGroupTitle(group.tabs.length);
}

export function collectGroupedTitles(
  sessions: SavedSession[],
  excludeGroupId?: string,
): Set<string> {
  return new Set(
    sessions.flatMap((session) =>
      session.groups.flatMap((group) =>
        group.grouped && group.id !== excludeGroupId
          ? [getSavedGroupTitle(group)]
          : [],
      ),
    ),
  );
}

/**
 * Normalize historical tag-group names and resolve duplicates oldest-first.
 * Ordinary groups are deliberately ignored and may continue sharing names.
 */
export function ensureUniqueGroupedTitlesInMemory(
  sessions: SavedSession[],
): GroupedTitleChange[] {
  const grouped = sessions
    .flatMap((session, sessionIndex) =>
      session.groups.map((group, groupIndex) => ({
        session,
        sessionIndex,
        group,
        groupIndex,
      })),
    )
    .filter(({ group }) => group.grouped)
    .sort(
      (left, right) =>
        left.group.createdAt - right.group.createdAt ||
        left.session.createdAt - right.session.createdAt ||
        right.sessionIndex - left.sessionIndex ||
        left.groupIndex - right.groupIndex,
    );
  const reservedTitles = new Set(
    grouped.map(({ group }) => getSavedGroupTitle(group)),
  );
  const claimedOriginalTitles = new Set<string>();
  const changes: GroupedTitleChange[] = [];

  for (const { session, group } of grouped) {
    const originalTitle = getSavedGroupTitle(group);
    const groupTitle = claimedOriginalTitles.has(originalTitle)
      ? reserveNumericGroupTitle(originalTitle, reservedTitles)
      : originalTitle;
    claimedOriginalTitles.add(originalTitle);
    if (group.title === groupTitle) continue;
    group.title = groupTitle;
    changes.push({
      sessionId: session.id,
      groupId: group.id,
      groupTitle,
    });
  }

  return changes;
}

export function reserveNumericGroupTitle(
  requestedTitle: string,
  reservedTitles: Set<string>,
): string {
  const baseTitle = normalizeGroupTitle(requestedTitle);
  if (!reservedTitles.has(baseTitle)) {
    reservedTitles.add(baseTitle);
    return baseTitle;
  }

  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${baseTitle} ${suffix}`;
    if (reservedTitles.has(candidate)) continue;
    reservedTitles.add(candidate);
    return candidate;
  }
}

export function formatGroupTitleTimestamp(now: number): string {
  const date = new Date(now);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes}`;
}

export function reserveTimestampedGroupTitle(
  requestedTitle: string,
  reservedTitles: Set<string>,
  now = Date.now(),
): string {
  const baseTitle = normalizeGroupTitle(requestedTitle);
  if (!reservedTitles.has(baseTitle)) {
    reservedTitles.add(baseTitle);
    return baseTitle;
  }

  const timestampedTitle = `${baseTitle} ${formatGroupTitleTimestamp(now)}`;
  return reserveNumericGroupTitle(timestampedTitle, reservedTitles);
}
