import type {
  SavedPageCommand,
  SavedPageCommandResult,
} from './messages';
import { openSavedGroup } from './restore-tabs';
import {
  deduplicateGroup,
  getSavedGroup,
  removeGroup,
  removeTab,
  renameGroup,
  renameTab,
  setGroupArchived,
  setGroupLocked,
  setGroupPinned,
  setGroupTaskStatus,
  setTabTaskStatus,
} from './storage';
import {
  bindOpenedTaskGroup,
  clearTaskGroupBinding,
  focusTaskGroupBinding,
  ignoreMissingTaskGroupTabs,
  ignoreTaskTab,
} from './task-group-sync';

export interface SavedPageOperationContext {
  currentWindowId?: number;
}

export async function executeSavedPageCommand(
  command: SavedPageCommand,
  context: SavedPageOperationContext = {},
): Promise<SavedPageCommandResult> {
  switch (command.type) {
    case 'bok/remove-tab':
      await removeTab(command.sessionId, command.tabId);
      await ignoreTaskTab(command.sessionId, command.tabId);
      return null;
    case 'bok/rename-tab':
      await renameTab(
        command.sessionId,
        command.groupId,
        command.tabId,
        command.title,
      );
      return null;
    case 'bok/remove-group':
      await removeGroup(command.sessionId, command.groupId);
      await clearTaskGroupBinding(command.sessionId, command.groupId);
      return null;
    case 'bok/rename-group':
      await renameGroup(command.sessionId, command.groupId, command.title);
      return null;
    case 'bok/set-group-archived':
      await setGroupArchived(
        command.sessionId,
        command.groupId,
        command.archived,
      );
      return null;
    case 'bok/set-group-locked':
      await setGroupLocked(command.sessionId, command.groupId, command.locked);
      return null;
    case 'bok/set-group-pinned':
      await setGroupPinned(command.sessionId, command.groupId, command.pinned);
      return null;
    case 'bok/set-group-task-status':
      await setGroupTaskStatus(
        command.sessionId,
        command.groupId,
        command.status,
      );
      if (command.status === null) {
        await clearTaskGroupBinding(command.sessionId, command.groupId);
      }
      return null;
    case 'bok/set-tab-task-status':
      await setTabTaskStatus(
        command.sessionId,
        command.groupId,
        command.tabId,
        command.status,
      );
      return null;
    case 'bok/deduplicate-group':
      {
        const removedTabs = await deduplicateGroup(
          command.sessionId,
          command.groupId,
        );
        const group = await getSavedGroup(command.sessionId, command.groupId);
        await ignoreMissingTaskGroupTabs(
          command.sessionId,
          command.groupId,
          group.tabs.map((tab) => tab.id),
        );
        return { removedTabs };
      }
    case 'bok/open-group': {
      const group = await getSavedGroup(command.sessionId, command.groupId);
      if (group.taskStatus !== null) {
        if (await focusTaskGroupBinding(command.sessionId, command.groupId)) {
          return {
            openedTabs: group.tabs.length,
            mode: 'tab-group',
            destination: command.destination,
            reusedTaskGroup: true,
          };
        }

        const opened = await openSavedGroup(
          context.currentWindowId,
          command.sessionId,
          command.groupId,
          'tab-group',
          command.destination,
          group.tabs.map((tab) => tab.id),
        );
        if (opened.browserGroupId == null) {
          throw new Error('打开任务失败：浏览器没有返回标签组 ID，Bok 记录已保留');
        }
        await bindOpenedTaskGroup(
          command.sessionId,
          command.groupId,
          opened.browserGroupId,
          opened.windowId,
          opened.openedTabIdBySavedTabId,
        );
        return opened;
      }

      return openSavedGroup(
        context.currentWindowId,
        command.sessionId,
        command.groupId,
        command.mode,
        command.destination,
        command.tabIds,
      );
    }
  }
}
