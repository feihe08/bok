import type {
  SavedGroup,
  SavedSession,
  SavedSessionItem,
  SavedSessionState,
  SavedTab,
} from './model.ts';

const STANDALONE_GROUP_PREFIX = 'tab:';

export const DEFAULT_SAVED_SESSION_STATE: SavedSessionState = {
  title: '',
  locked: false,
  pinned: false,
  restoredAt: null,
  archivedAt: null,
  taskStatus: null,
  taskCompletedAt: null,
};

export function getStandaloneGroupId(tabId: string): string {
  return `${STANDALONE_GROUP_PREFIX}${tabId}`;
}

export function getSessionGroups(session: SavedSession): SavedGroup[] {
  return session.items.flatMap((item) =>
    item.type === 'group' ? [item.group] : [],
  );
}

export function createItemsSession(
  id: string,
  createdAt: number,
  items: SavedSessionItem[],
  state: Partial<SavedSessionState> = {},
): SavedSession {
  const {
    title = DEFAULT_SAVED_SESSION_STATE.title,
    locked = DEFAULT_SAVED_SESSION_STATE.locked,
    pinned = DEFAULT_SAVED_SESSION_STATE.pinned,
    restoredAt = DEFAULT_SAVED_SESSION_STATE.restoredAt,
    archivedAt = DEFAULT_SAVED_SESSION_STATE.archivedAt,
    taskStatus = DEFAULT_SAVED_SESSION_STATE.taskStatus,
    taskCompletedAt = DEFAULT_SAVED_SESSION_STATE.taskCompletedAt,
  } = state;
  return {
    id,
    createdAt,
    title,
    locked,
    pinned,
    restoredAt,
    archivedAt,
    taskStatus,
    taskCompletedAt,
    items,
  };
}
