import type {
  SavedPageCommand,
  SavedPageCommandResult,
} from './messages';
import {
  openSavedGroup,
  openSavedSession,
  rollbackOpenedSavedSession,
} from './restore-tabs';
import {
  setAutoArchivePeriod,
  convertGroupToBrowserGroup,
  deduplicateGroup,
  getSavedGroup,
  getSavedSession,
  removeGroup,
  removeSession,
  removeTab,
  renameGroup,
  renameSession,
  renameTab,
  setGroupArchived,
  setGroupLocked,
  setGroupPinned,
  setGroupTaskStatus,
  setSessionArchived,
  setSessionLocked,
  setSessionPinned,
  setSessionTaskStatus,
  setTabTaskStatus,
} from './store';
import { importSessionsJson } from './persistence';
import {
  bindOpenedTaskGroup,
  bindOpenedTaskGroups,
  clearTaskGroupBinding,
  clearTaskGroupBindingsForSession,
  focusTaskGroupBinding,
  getActiveTaskGroupBindings,
  ignoreMissingTaskGroupTabs,
  ignoreTaskTab,
  restoreTaskGroupBindings,
  updateBoundGroupTitle,
} from '../tab-group-sync/sync';

export interface SavedPageOperationContext {
  currentWindowId?: number;
}

export async function executeSavedPageCommand(
  command: SavedPageCommand,
  context: SavedPageOperationContext = {},
): Promise<SavedPageCommandResult> {
  switch (command.type) {
    case 'bok/import-sessions':
      return importSessionsJson(command.json);
    case 'bok/set-auto-archive-period': {
      await setAutoArchivePeriod(command.period);
      return null;
    }
    case 'bok/open-session': {
      let session = await getSavedSession(command.sessionId);
      let sourceItems = session.items;
      const groupedGroupIds = sourceItems.flatMap((item) =>
        item.type === 'group' ? [item.group.id] : [],
      );
      if (sourceItems.length > 1 && groupedGroupIds.length > 0) {
        await restoreTaskGroupBindings();
        session = await getSavedSession(command.sessionId);
        sourceItems = session.items;
        const activeBindings = await getActiveTaskGroupBindings(
          session.id,
          sourceItems.flatMap((item) =>
            item.type === 'group' ? [item.group.id] : [],
          ),
        );
        if (activeBindings.size > 0) {
          throw new Error(
            '打开失败：保存记录中的标签组已在浏览器中打开，请先关闭该标签组',
          );
        }
      } else if (
        sourceItems.length === 1 &&
        sourceItems[0]?.type === 'group'
      ) {
        await restoreTaskGroupBindings();
        session = await getSavedSession(command.sessionId);
        sourceItems = session.items;
        const singleGroup =
          sourceItems.length === 1 && sourceItems[0]?.type === 'group'
            ? sourceItems[0].group
            : undefined;
        if (singleGroup && await focusTaskGroupBinding(session.id, singleGroup.id)) {
          return {
            openedTabs: singleGroup.tabs.length,
            openedGroups: 1,
            destination: command.destination,
            reusedSyncedGroup: true,
          };
        }
      }

      const opened = await openSavedSession(
        context.currentWindowId,
        session,
        command.destination,
      );
      try {
        await bindOpenedTaskGroups(
          session.id,
          opened.openedTaskGroups.map((group) => ({
            ...group,
            windowId: opened.windowId,
          })),
        );
      } catch (error) {
        await clearTaskGroupBindingsForSession(session.id).catch(() => undefined);
        const rolledBack = await rollbackOpenedSavedSession(opened);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `打开失败：无法建立标签组同步：${reason}；${
            rolledBack ? '已回滚本次打开内容' : '未能完整回滚本次打开内容'
          }，Bok 记录已保留`,
          { cause: error },
        );
      }
      return {
        openedTabs: opened.openedTabs,
        openedGroups: opened.openedGroups,
        destination: opened.destination,
      };
    }
    case 'bok/remove-session': {
      await removeSession(command.sessionId);
      try {
        await clearTaskGroupBindingsForSession(command.sessionId);
      } catch (error) {
        console.warn('[bok] failed to clear deleted session bindings', {
          sessionId: command.sessionId,
          error,
        });
      }
      return null;
    }
    case 'bok/rename-session':
      await renameSession(command.sessionId, command.title);
      return null;
    case 'bok/set-session-pinned':
      await setSessionPinned(command.sessionId, command.pinned);
      return null;
    case 'bok/set-session-archived':
      await setSessionArchived(command.sessionId, command.archived);
      return null;
    case 'bok/set-session-task-status':
      await setSessionTaskStatus(command.sessionId, command.status);
      return null;
    case 'bok/set-session-locked':
      await setSessionLocked(command.sessionId, command.locked);
      return null;
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
    case 'bok/convert-group':
      return convertGroupToBrowserGroup(command.sessionId, command.groupId);
    case 'bok/rename-group': {
      const previousGroup = await getSavedGroup(command.sessionId, command.groupId);
      await renameGroup(command.sessionId, command.groupId, command.title);
      const group = await getSavedGroup(command.sessionId, command.groupId);
      try {
        await updateBoundGroupTitle(
          command.sessionId,
          command.groupId,
          group.title,
        );
      } catch (error) {
        await renameGroup(
          command.sessionId,
          command.groupId,
          previousGroup.title,
        );
        throw error;
      }
      return null;
    }
    case 'bok/restore-group':
      await setGroupArchived(command.sessionId, command.groupId, false);
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
      return setGroupTaskStatus(
        command.sessionId,
        command.groupId,
        command.status,
      );
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
      let group = await getSavedGroup(command.sessionId, command.groupId);
      await restoreTaskGroupBindings();
      group = await getSavedGroup(command.sessionId, command.groupId);
      if (await focusTaskGroupBinding(command.sessionId, command.groupId)) {
        return {
          openedTabs: group.tabs.length,
          mode: 'tab-group',
          destination: command.destination,
          reusedSyncedGroup: true,
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
        throw new Error('打开同步标签组失败：浏览器没有返回标签组 ID，Bok 记录已保留');
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
  }
}
