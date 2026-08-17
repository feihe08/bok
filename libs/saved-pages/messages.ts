import type {
  SavedGroupTaskStatus,
  SavedPagesAutoArchivePeriod,
} from './model.ts';
import { isSavedPagesAutoArchivePeriod } from './model.ts';
import type { ImportSessionsResult } from './persistence.ts';
import type { ConvertGroupResult } from './store.ts';

export type OpenMode = 'tabs' | 'tab-group';
export type OpenDestination = 'current-window' | 'new-window';

export type SavedPageCommand =
  | { type: 'bok/import-sessions'; json: string }
  | {
      type: 'bok/set-auto-archive-period';
      period: SavedPagesAutoArchivePeriod;
    }
  | {
      type: 'bok/open-session';
      sessionId: string;
      destination: OpenDestination;
    }
  | { type: 'bok/remove-session'; sessionId: string }
  | { type: 'bok/rename-session'; sessionId: string; title: string }
  | { type: 'bok/set-session-pinned'; sessionId: string; pinned: boolean }
  | {
      type: 'bok/set-session-archived';
      sessionId: string;
      archived: boolean;
    }
  | {
      type: 'bok/set-session-task-status';
      sessionId: string;
      status: SavedGroupTaskStatus | null;
    }
  | { type: 'bok/set-session-locked'; sessionId: string; locked: boolean }
  | { type: 'bok/remove-tab'; sessionId: string; tabId: string }
  | {
      type: 'bok/move-tab';
      sessionId: string;
      tabId: string;
      targetSessionId: string;
      targetGroupId: string | null;
      targetBeforeTabId?: string | null;
    }
  | {
      type: 'bok/rename-tab';
      sessionId: string;
      groupId: string;
      tabId: string;
      title: string;
    }
  | { type: 'bok/remove-group'; sessionId: string; groupId: string }
  | { type: 'bok/convert-group'; sessionId: string; groupId: string }
  | { type: 'bok/restore-group'; sessionId: string; groupId: string }
  | {
      type: 'bok/rename-group';
      sessionId: string;
      groupId: string;
      title: string;
    }
  | {
      type: 'bok/set-group-archived';
      sessionId: string;
      groupId: string;
      archived: boolean;
    }
  | {
      type: 'bok/set-group-locked';
      sessionId: string;
      groupId: string;
      locked: boolean;
    }
  | {
      type: 'bok/set-group-pinned';
      sessionId: string;
      groupId: string;
      pinned: boolean;
    }
  | {
      type: 'bok/set-group-task-status';
      sessionId: string;
      groupId: string;
      status: SavedGroupTaskStatus | null;
    }
  | {
      type: 'bok/set-tab-task-status';
      sessionId: string;
      groupId: string;
      tabId: string;
      status: SavedGroupTaskStatus | null;
    }
  | {
      type: 'bok/deduplicate-group';
      sessionId: string;
      groupId: string;
    }
  | {
      type: 'bok/open-group';
      sessionId: string;
      groupId: string;
      mode: OpenMode;
      destination: OpenDestination;
      tabIds: string[];
    };

export interface OpenGroupResult {
  openedTabs: number;
  mode: OpenMode;
  destination: OpenDestination;
  /** True when an already-open synced group was focused instead of duplicated. */
  reusedSyncedGroup?: boolean;
  /** Present when opening as a Chrome group converted a normal Bok group first. */
  convertedGroup?: ConvertGroupResult;
}

export interface OpenSessionResult {
  openedTabs: number;
  openedGroups: number;
  destination: OpenDestination;
  /** True when a single-group session focused its existing synced group. */
  reusedSyncedGroup?: boolean;
}

export interface DeduplicateGroupResult {
  removedTabs: number;
}

export type SavedPageCommandResult =
  | OpenGroupResult
  | OpenSessionResult
  | DeduplicateGroupResult
  | ConvertGroupResult
  | ImportSessionsResult
  | null;

export type SavedPageResponse =
  | { ok: true; result: SavedPageCommandResult }
  | { ok: false; error: string };

const GROUP_TASK_STATUSES = new Set<SavedGroupTaskStatus>([
  'todo',
  'doing',
  'done',
]);

export function isSavedPageCommand(value: unknown): value is SavedPageCommand {
  if (typeof value !== 'object' || value === null) return false;

  const command = value as Record<string, unknown>;
  if (command.type === 'bok/import-sessions') {
    return typeof command.json === 'string';
  }
  if (command.type === 'bok/set-auto-archive-period') {
    return isSavedPagesAutoArchivePeriod(command.period);
  }
  if (typeof command.sessionId !== 'string') return false;

  switch (command.type) {
    case 'bok/open-session':
      return (
        command.destination === 'current-window' ||
        command.destination === 'new-window'
      );
    case 'bok/remove-session':
      return true;
    case 'bok/rename-session':
      return typeof command.title === 'string';
    case 'bok/set-session-pinned':
      return typeof command.pinned === 'boolean';
    case 'bok/set-session-archived':
      return typeof command.archived === 'boolean';
    case 'bok/set-session-locked':
      return typeof command.locked === 'boolean';
    case 'bok/set-session-task-status':
      return (
        command.status === null ||
        (typeof command.status === 'string' &&
          GROUP_TASK_STATUSES.has(command.status as SavedGroupTaskStatus))
      );
    case 'bok/remove-tab':
      return typeof command.tabId === 'string';
    case 'bok/move-tab':
      return (
        typeof command.tabId === 'string' &&
        typeof command.targetSessionId === 'string' &&
        (command.targetGroupId === null ||
          typeof command.targetGroupId === 'string') &&
        (command.targetBeforeTabId === undefined ||
          command.targetBeforeTabId === null ||
          typeof command.targetBeforeTabId === 'string')
      );
    case 'bok/rename-tab':
      return (
        hasGroupId(command) &&
        typeof command.tabId === 'string' &&
        typeof command.title === 'string'
      );
    case 'bok/remove-group':
    case 'bok/convert-group':
    case 'bok/restore-group':
    case 'bok/deduplicate-group':
      return hasGroupId(command);
    case 'bok/rename-group':
      return hasGroupId(command) && typeof command.title === 'string';
    case 'bok/set-group-archived':
      return hasGroupId(command) && typeof command.archived === 'boolean';
    case 'bok/set-group-locked':
      return hasGroupId(command) && typeof command.locked === 'boolean';
    case 'bok/set-group-pinned':
      return hasGroupId(command) && typeof command.pinned === 'boolean';
    case 'bok/set-group-task-status':
      return (
        hasGroupId(command) &&
        (command.status === null ||
          (typeof command.status === 'string' &&
            GROUP_TASK_STATUSES.has(command.status as SavedGroupTaskStatus)))
      );
    case 'bok/set-tab-task-status':
      return (
        hasGroupId(command) &&
        typeof command.tabId === 'string' &&
        (command.status === null ||
          (typeof command.status === 'string' &&
            GROUP_TASK_STATUSES.has(command.status as SavedGroupTaskStatus)))
      );
    case 'bok/open-group':
      return (
        hasGroupId(command) &&
        (command.mode === 'tabs' || command.mode === 'tab-group') &&
        (command.destination === 'current-window' ||
          command.destination === 'new-window') &&
        Array.isArray(command.tabIds) &&
        command.tabIds.every((tabId) => typeof tabId === 'string')
      );
    default:
      return false;
  }
}

function hasGroupId(
  command: Record<string, unknown>,
): command is Record<string, unknown> & { groupId: string } {
  return typeof command.groupId === 'string';
}
