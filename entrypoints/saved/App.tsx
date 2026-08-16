import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react';
import { browser } from 'wxt/browser';
import type {
  DeduplicateGroupResult,
  OpenDestination,
  OpenGroupResult,
  OpenMode,
  SavedPageCommand,
  SavedPageResponse,
} from '../../libs/saved-pages/messages';
import { getSessions } from '../../libs/saved-pages/persistence';
import type {
  SavedGroup,
  SavedGroupTaskStatus,
  SavedSession,
  SavedTab,
} from '../../libs/saved-pages/model';
import { ActionMenu, type ActionMenuEntry } from '../shared/ActionMenu';
import { InlineEditor } from './InlineEditor';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

type ActionNotice = { type: 'success' | 'error'; message: string };
type CommandOutcome<T> = { ok: true; result: T } | { ok: false };

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '时间未知' : dateFormatter.format(date);
}

function formatDateTime(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function formatDisplayUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return url;

    const host = parsedUrl.host.replace(/^www\./i, '');
    const pathname = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname;
    return `${host}${pathname}`;
  } catch {
    return url;
  }
}

function getGroupTitle(group: SavedGroup): string {
  return group.title.trim() || '未命名标签组';
}

function getSessionGroups(session: SavedSession): SavedGroup[] {
  return session.items.flatMap((item) => item.type === 'group' ? [item.group] : []);
}

function getSessionTabCount(session: SavedSession): number {
  return session.items.reduce(
    (total, item) => total + (item.type === 'tab' ? 1 : item.group.tabs.length),
    0,
  );
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function getSearchKey(sessionId: string, groupId: string, tabId: string): string {
  return `${sessionId}\n${groupId}\n${tabId}`;
}

function getGroupKey(sessionId: string, groupId: string): string {
  return `${sessionId}\n${groupId}`;
}

function getActionKey(
  action: string,
  sessionId: string,
  groupId: string,
  tabId?: string,
): string {
  return [action, sessionId, groupId, tabId].filter(Boolean).join(':');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '操作失败，请稍后重试。';
}

function focusOnNextFrame(target: HTMLElement | null) {
  requestAnimationFrame(() => {
    if (target?.isConnected) target.focus();
  });
}

function getGroupRemovalFocusTarget(source: HTMLElement): HTMLElement | null {
  const group = source.closest('.group');
  if (!group) return null;

  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled)',
    ),
  ].filter(
    (candidate) =>
      !group.contains(candidate) &&
      !candidate.closest('.action-menu'),
  );
  const next = candidates.find(
    (candidate) =>
      Boolean(group.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
  if (next) return next;

  return (
    candidates.findLast((candidate) =>
      Boolean(group.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_PRECEDING),
    ) ?? null
  );
}

function getTabRemovalFocusTarget(source: HTMLElement): HTMLElement | null {
  const row = source.closest('li');
  const nextTab = row?.nextElementSibling?.querySelector<HTMLElement>(
    'a[href], button:not(:disabled)',
  );
  if (nextTab) return nextTab;

  const previousTab = row?.previousElementSibling?.querySelector<HTMLElement>(
    'a[href], button:not(:disabled)',
  );
  return previousTab ?? getGroupRemovalFocusTarget(source);
}

function openSavedTab(event: MouseEvent<HTMLAnchorElement>, url: string) {
  if (!url.startsWith('chrome:')) return;
  event.preventDefault();
  void browser.tabs.create({ url }).catch((error) => {
    console.error('[bok] failed to open saved tab', error);
  });
}

function getVisibleSessions(sessions: SavedSession[]): SavedSession[] {
  return sessions.flatMap((session) => {
    const items = session.items.filter(
      (item) => item.type === 'tab' || item.group.tabs.length > 0,
    );
    return items.length > 0 ? [{ ...session, items }] : [];
  });
}

function getFaviconFallback(url: string): string {
  return `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
}

interface SearchFieldProps {
  value: string;
  onChange: (value: string) => void;
}

function SearchField({ value, onChange }: SearchFieldProps) {
  return (
    <div className="search" role="search">
      <label className="sr-only" htmlFor="saved-search">
        搜索当前视图
      </label>
      <svg className="search__icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="m12.5 12.5 4 4" />
      </svg>
      <input
        id="saved-search"
        type="search"
        value={value}
        placeholder="搜索标题、URL 或标签"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

interface GroupActionMenuProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  group: SavedGroup;
  disabled: boolean;
  pending: boolean;
  onOpen: (mode: OpenMode, destination: OpenDestination) => void;
  onRename: () => void;
  onToggleLocked: () => void;
  onToggleTask: () => void;
  onDeduplicate: () => void;
  onRemove: () => void;
}

function GroupActionMenu({
  triggerRef,
  group,
  disabled,
  pending,
  onOpen,
  onRename,
  onToggleLocked,
  onToggleTask,
  onDeduplicate,
  onRemove,
}: GroupActionMenuProps) {
  const entries: ActionMenuEntry[] = [
    {
      type: 'action',
      id: 'current-tab-group',
      label: '当前窗口，以标签组打开',
      onSelect: () => onOpen('tab-group', 'current-window'),
    },
    {
      type: 'action',
      id: 'new-tabs',
      label: '新窗口，以普通标签打开',
      onSelect: () => onOpen('tabs', 'new-window'),
    },
    {
      type: 'action',
      id: 'new-tab-group',
      label: '新窗口，以标签组打开',
      onSelect: () => onOpen('tab-group', 'new-window'),
    },
    { type: 'separator', id: 'open-actions' },
    {
      type: 'action',
      id: 'rename',
      label: '重命名',
      onSelect: onRename,
    },
    {
      type: 'action',
      id: 'lock',
      label: group.locked ? '解除锁定' : '锁定',
      onSelect: onToggleLocked,
    },
    {
      type: 'action',
      id: 'deduplicate',
      label: '移除组内重复项',
      disabled: group.locked,
      onSelect: onDeduplicate,
    },
    {
      type: 'action',
      id: 'task',
      label: group.taskStatus === null ? '标记为任务' : '取消任务',
      onSelect: onToggleTask,
    },
    { type: 'separator', id: 'danger-actions' },
    {
      type: 'action',
      id: 'remove',
      label: '删除整个分组',
      tone: 'danger',
      disabled: group.locked,
      onSelect: onRemove,
    },
  ];

  return (
    <ActionMenu
      ref={triggerRef}
      label={`“${getGroupTitle(group)}”的更多操作`}
      entries={entries}
      disabled={disabled}
      pending={pending}
    />
  );
}

interface TabActionMenuProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  tab: SavedTab;
  disabled: boolean;
  pending: boolean;
  locked: boolean;
  onRename: () => void;
  onRemove: () => void;
}

function TabActionMenu({
  triggerRef,
  tab,
  disabled,
  pending,
  locked,
  onRename,
  onRemove,
}: TabActionMenuProps) {
  const entries: ActionMenuEntry[] = [
    {
      type: 'action',
      id: 'rename',
      label: '重命名',
      onSelect: onRename,
    },
    { type: 'separator', id: 'danger-actions' },
    {
      type: 'action',
      id: 'remove',
      label: '删除',
      tone: 'danger',
      disabled: locked,
      onSelect: onRemove,
    },
  ];

  return (
    <ActionMenu
      ref={triggerRef}
      label={`“${tab.title || tab.url}”的更多操作`}
      entries={entries}
      disabled={disabled}
      pending={pending}
    />
  );
}

interface TabRowProps {
  sessionId: string;
  group: SavedGroup;
  tab: SavedTab;
  pendingAction: string | null;
  onRename: (
    sessionId: string,
    group: SavedGroup,
    tab: SavedTab,
    title: string,
  ) => Promise<boolean>;
  onRemove: (sessionId: string, group: SavedGroup, tab: SavedTab) => Promise<boolean>;
}

function TabRow({
  sessionId,
  group,
  tab,
  pendingAction,
  onRename,
  onRemove,
}: TabRowProps) {
  const [editing, setEditing] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const targetId = tab.id;
  const tabPending =
    pendingAction !== null &&
    pendingAction.includes(`:${sessionId}:${group.id}:${targetId}`);

  async function rename(title: string) {
    const succeeded = await onRename(sessionId, group, tab, title);
    if (succeeded) {
      setEditing(false);
      focusOnNextFrame(menuTriggerRef.current);
    }
    return succeeded;
  }

  async function remove() {
    const source = menuTriggerRef.current;
    if (!source) return;
    const successFocusTarget = getTabRemovalFocusTarget(source);
    const succeeded = await onRemove(sessionId, group, tab);
    focusOnNextFrame(succeeded ? successFocusTarget : source);
  }

  return (
    <li data-bok-kind="tab" aria-busy={tabPending}>
      {editing ? (
        <div className="tab__editor">
          <InlineEditor
            label={`重命名 ${tab.title || tab.url}`}
            value={tab.title}
            fallbackValue={tab.url}
            pending={tabPending}
            onSave={rename}
            onCancel={() => {
              setEditing(false);
              focusOnNextFrame(menuTriggerRef.current);
            }}
          />
        </div>
      ) : (
        <a
          href={tab.url}
          target="_blank"
          rel="noreferrer"
          title={tab.title && tab.title !== tab.url ? `${tab.title}\n${tab.url}` : tab.url}
          onClick={(event) => openSavedTab(event, tab.url)}
        >
          <img
            className="tab__favicon"
            src={tab.favIconUrl || getFaviconFallback(tab.url)}
            alt=""
            width="16"
            height="16"
            loading="lazy"
            onError={(event) => {
              const fallback = getFaviconFallback(tab.url);
              if (event.currentTarget.src !== new URL(fallback, location.href).href) {
                event.currentTarget.src = fallback;
                return;
              }
              event.currentTarget.style.visibility = 'hidden';
            }}
          />
          <span className="tab__content">
            <span className="tab__title">{tab.title || tab.url}</span>
            <span className="tab__url">{formatDisplayUrl(tab.url)}</span>
          </span>
        </a>
      )}
      <TabActionMenu
        triggerRef={menuTriggerRef}
        tab={tab}
        disabled={pendingAction !== null || editing}
        pending={tabPending}
        locked={group.locked}
        onRename={() => setEditing(true)}
        onRemove={() => void remove()}
      />
    </li>
  );
}

interface GroupSectionProps {
  group: SavedGroup;
  operationGroup: SavedGroup;
  sessionId: string;
  pendingAction: string | null;
  onOpen: (
    sessionId: string,
    group: SavedGroup,
    mode: OpenMode,
    destination: OpenDestination,
  ) => Promise<CommandOutcome<OpenGroupResult>>;
  onRename: (sessionId: string, group: SavedGroup, title: string) => Promise<boolean>;
  onSetLocked: (
    sessionId: string,
    group: SavedGroup,
    locked: boolean,
  ) => Promise<boolean>;
  onSetTaskStatus: (
    sessionId: string,
    group: SavedGroup,
    status: SavedGroupTaskStatus | null,
  ) => Promise<boolean>;
  onDeduplicate: (sessionId: string, group: SavedGroup) => Promise<boolean>;
  onRemove: (sessionId: string, group: SavedGroup) => Promise<boolean>;
  onRenameTab: TabRowProps['onRename'];
  onRemoveTab: TabRowProps['onRemove'];
}

function GroupSection({
  group,
  operationGroup,
  sessionId,
  pendingAction,
  onOpen,
  onRename,
  onSetLocked,
  onSetTaskStatus,
  onDeduplicate,
  onRemove,
  onRenameTab,
  onRemoveTab,
}: GroupSectionProps) {
  const [editing, setEditing] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const groupPending =
    pendingAction !== null && pendingAction.includes(`:${sessionId}:${group.id}`);

  async function open(mode: OpenMode, destination: OpenDestination, source: HTMLElement | null) {
    if (!source) return;
    await onOpen(sessionId, operationGroup, mode, destination);
    focusOnNextFrame(source);
  }

  async function rename(title: string) {
    const succeeded = await onRename(sessionId, group, title);
    if (succeeded) {
      setEditing(false);
      focusOnNextFrame(menuTriggerRef.current);
    }
    return succeeded;
  }

  async function runStableAction(action: () => Promise<boolean>) {
    const source = menuTriggerRef.current;
    const succeeded = await action();
    focusOnNextFrame(source);
    return succeeded;
  }

  async function runRemovingAction(action: () => Promise<boolean>) {
    const source = menuTriggerRef.current;
    if (!source) return;
    const successFocusTarget = getGroupRemovalFocusTarget(source);
    const succeeded = await action();
    focusOnNextFrame(succeeded ? successFocusTarget : source);
  }

  return (
    <section
      className="group"
      data-bok-kind="group"
      aria-label={editing ? `正在编辑“${getGroupTitle(group)}”` : undefined}
      aria-labelledby={editing ? undefined : `group-${sessionId}-${group.id}`}
      aria-busy={groupPending}
    >
      <header className="group__header">
        <div className="group__identity">
          <span
            className="group__color"
            data-color={group.color || 'grey'}
            aria-hidden="true"
          />
          {editing ? (
            <InlineEditor
              label={`重命名 ${getGroupTitle(group)}`}
              value={group.title}
              fallbackValue="未命名标签组"
              pending={groupPending}
              onSave={rename}
              onCancel={() => {
                setEditing(false);
                focusOnNextFrame(menuTriggerRef.current);
              }}
            />
          ) : (
            <h3 id={`group-${sessionId}-${group.id}`}>{getGroupTitle(group)}</h3>
          )}
          <span className="group__count">{group.tabs.length} 个</span>
          {group.locked && (
            <span className="group__locked" title="解除锁定后才能删除或移除重复项">
              已锁定
            </span>
          )}
        </div>

        <div className="group__actions">
          {group.taskStatus !== null && (
            <>
              <label className="sr-only" htmlFor={`status-${sessionId}-${group.id}`}>
                “{getGroupTitle(group)}”的任务状态
              </label>
              <select
                id={`status-${sessionId}-${group.id}`}
                className="group__task"
                value={group.taskStatus}
                disabled={pendingAction !== null}
                onChange={(event) => {
                  const source = event.currentTarget;
                  void onSetTaskStatus(
                    sessionId,
                    operationGroup,
                    event.target.value as SavedGroupTaskStatus,
                  ).then(() => focusOnNextFrame(source));
                }}
              >
                <option value="todo">Todo</option>
                <option value="doing">Doing</option>
                <option value="done">Done</option>
              </select>
            </>
          )}
          <button
            ref={openButtonRef}
            type="button"
            className="text-button"
            disabled={pendingAction !== null}
            onClick={() => void open('tabs', 'current-window', openButtonRef.current)}
          >
            {pendingAction ===
            getActionKey('open-tabs-current-window', sessionId, group.id)
              ? '打开中'
              : '打开'}
          </button>
          <GroupActionMenu
            triggerRef={menuTriggerRef}
            group={group}
            disabled={pendingAction !== null || editing}
            pending={groupPending}
            onOpen={(mode, destination) =>
              void open(mode, destination, menuTriggerRef.current)
            }
            onRename={() => setEditing(true)}
            onToggleLocked={() =>
              void runStableAction(() =>
                onSetLocked(sessionId, group, !group.locked),
              )
            }
            onDeduplicate={() =>
              void runStableAction(() => onDeduplicate(sessionId, operationGroup))
            }
            onToggleTask={() =>
              void runStableAction(() =>
                onSetTaskStatus(
                  sessionId,
                  operationGroup,
                  group.taskStatus === null ? 'todo' : null,
                ),
              )
            }
            onRemove={() =>
              void runRemovingAction(() => onRemove(sessionId, operationGroup))
            }
          />
        </div>
      </header>

      <ul className="tabs">
        {group.tabs.map((tab) => (
          <TabRow
            key={tab.id}
            sessionId={sessionId}
            group={group}
            tab={tab}
            pendingAction={pendingAction}
            onRename={onRenameTab}
            onRemove={onRemoveTab}
          />
        ))}
      </ul>
    </section>
  );
}

interface SessionSectionProps
  extends Omit<GroupSectionProps, 'group' | 'operationGroup' | 'sessionId'> {
  session: SavedSession;
  operationGroups: ReadonlyMap<string, SavedGroup>;
}

function SessionSection({
  session,
  operationGroups,
  ...groupProps
}: SessionSectionProps) {
  const groups = getSessionGroups(session);
  const tabCount = getSessionTabCount(session);

  return (
    <section className="session" aria-labelledby={`session-${session.id}`}>
      <header className="session__header">
        <h2 id={`session-${session.id}`}>
          <time dateTime={formatDateTime(session.createdAt)}>
            {formatDate(session.createdAt)}
          </time>
        </h2>
        <p>
          {tabCount} 个标签
          {groups.length > 0 ? ` · ${groups.length} 个标签组` : ''}
        </p>
      </header>

      <div className="groups">
        {groups.map((group) => (
          <GroupSection
            key={group.id}
            {...groupProps}
            group={group}
            operationGroup={
              operationGroups.get(getGroupKey(session.id, group.id)) ?? group
            }
            sessionId={session.id}
          />
        ))}
      </div>
    </section>
  );
}

function LoadingState() {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr-only">正在读取保存记录</span>
      <div className="loading__line loading__line--short" />
      <div className="loading__line" />
      <div className="loading__line" />
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState<SavedSession[] | null>(null);
  const [searchValue, setSearchValue] = useState('');
  const deferredSearchValue = useDeferredValue(searchValue);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingActionRef = useRef<string | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);

  const visibleSessions = useMemo(
    () => (sessions === null ? null : getVisibleSessions(sessions)),
    [sessions],
  );
  const searchTerms = useMemo(
    () => normalizeSearchText(deferredSearchValue).trim().split(/\s+/).filter(Boolean),
    [deferredSearchValue],
  );
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();

    for (const session of visibleSessions ?? []) {
      for (const group of getSessionGroups(session)) {
        for (const tab of group.tabs) {
          index.set(
            getSearchKey(session.id, group.id, tab.id),
            normalizeSearchText([tab.title, tab.url, ...tab.tags].join('\n')),
          );
        }
      }
    }

    return index;
  }, [visibleSessions]);
  const operationGroups = useMemo(() => {
    const index = new Map<string, SavedGroup>();
    for (const session of visibleSessions ?? []) {
      for (const group of getSessionGroups(session)) {
        index.set(getGroupKey(session.id, group.id), group);
      }
    }
    return index;
  }, [visibleSessions]);
  const filteredSessions = useMemo(() => {
    if (visibleSessions === null || searchTerms.length === 0) return visibleSessions;

    const matches: SavedSession[] = [];
    for (const session of visibleSessions) {
      const items = session.items.flatMap<SavedSession['items'][number]>((item) => {
        if (item.type === 'tab') return [];
        const tabs = item.group.tabs.filter((tab) => {
          const searchText = searchIndex.get(
            getSearchKey(session.id, item.group.id, tab.id),
          );
          return (
            searchText !== undefined &&
            searchTerms.every((term) => searchText.includes(term))
          );
        });
        return tabs.length > 0
          ? [{ type: 'group', group: { ...item.group, tabs } }]
          : [];
      });
      if (items.length > 0) matches.push({ ...session, items });
    }
    return matches;
  }, [visibleSessions, searchIndex, searchTerms]);
  const totalTabCount = useMemo(
    () =>
      visibleSessions?.reduce(
        (sessionTotal, session) =>
          sessionTotal + getSessionTabCount(session),
        0,
      ),
    [visibleSessions],
  );
  const filteredTabCount = useMemo(
    () =>
      filteredSessions?.reduce(
        (sessionTotal, session) =>
          sessionTotal + getSessionTabCount(session),
        0,
      ),
    [filteredSessions],
  );
  const isSearching = searchTerms.length > 0;

  useEffect(() => {
    let cancelled = false;

    async function load(showLoading = false) {
      if (showLoading) {
        setSessions(null);
        setError(null);
      }

      try {
        const storedSessions = await getSessions();
        if (cancelled) return;
        setSessions([...storedSessions].sort((a, b) => b.createdAt - a.createdAt));
        setError(null);
      } catch (loadError) {
        if (cancelled) return;
        console.error('[bok] failed to load saved sessions', loadError);
        setSessions(null);
        setError('无法读取保存记录，请稍后重试。');
      }
    }

    const handleStorageChange: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, areaName) => {
      if (areaName === 'local' && changes.sessions) void load();
    };

    void load(true);
    browser.storage.onChanged.addListener(handleStorageChange);

    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [retryCount]);

  async function runCommand<T>(
    actionKey: string,
    command: SavedPageCommand,
    getSuccessMessage: (result: T) => string,
  ): Promise<CommandOutcome<T>> {
    if (pendingActionRef.current !== null) return { ok: false };

    pendingActionRef.current = actionKey;
    setPendingAction(actionKey);
    setActionNotice(null);

    try {
      const response = (await browser.runtime.sendMessage(command)) as SavedPageResponse;
      if (!response?.ok) throw new Error(response?.error || '后台没有返回操作结果');
      const result = response.result as T;
      setActionNotice({ type: 'success', message: getSuccessMessage(result) });
      return { ok: true, result };
    } catch (commandError) {
      console.error('[bok] saved page command failed', commandError);
      setActionNotice({ type: 'error', message: getErrorMessage(commandError) });
      return { ok: false };
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }

  async function handleOpen(
    sessionId: string,
    group: SavedGroup,
    mode: OpenMode,
    destination: OpenDestination,
  ) {
    return runCommand<OpenGroupResult>(
      getActionKey(`open-${mode}-${destination}`, sessionId, group.id),
      {
        type: 'bok/open-group',
        sessionId,
        groupId: group.id,
        mode,
        destination,
        tabIds: group.tabs.map((tab) => tab.id),
      },
      (result) => {
        const destinationLabel =
          result.destination === 'new-window' ? '新窗口' : '当前窗口';
        return `已在${destinationLabel}打开 ${result.openedTabs} 个标签，保存记录已保留。`;
      },
    );
  }

  async function handleRenameGroup(
    sessionId: string,
    group: SavedGroup,
    title: string,
  ) {
    const outcome = await runCommand<null>(
      getActionKey('rename-group', sessionId, group.id),
      { type: 'bok/rename-group', sessionId, groupId: group.id, title },
      () => `已重命名为“${title}”。`,
    );
    return outcome.ok;
  }

  async function handleSetGroupLocked(
    sessionId: string,
    group: SavedGroup,
    locked: boolean,
  ) {
    const outcome = await runCommand<null>(
      getActionKey('lock-group', sessionId, group.id),
      { type: 'bok/set-group-locked', sessionId, groupId: group.id, locked },
      () => `${locked ? '已锁定' : '已解除锁定'}“${getGroupTitle(group)}”。`,
    );
    return outcome.ok;
  }

  async function handleSetGroupTaskStatus(
    sessionId: string,
    group: SavedGroup,
    status: SavedGroupTaskStatus | null,
  ) {
    const labels: Record<SavedGroupTaskStatus, string> = {
      todo: 'Todo',
      doing: 'Doing',
      done: 'Done',
    };
    const outcome = await runCommand<null>(
      getActionKey('task-status-group', sessionId, group.id),
      { type: 'bok/set-group-task-status', sessionId, groupId: group.id, status },
      () =>
        status === null
          ? `已取消“${getGroupTitle(group)}”的任务标记。`
          : `“${getGroupTitle(group)}”已设为 ${labels[status]}。`,
    );
    return outcome.ok;
  }

  async function handleDeduplicateGroup(sessionId: string, group: SavedGroup) {
    if (
      !window.confirm(
        `确定移除“${getGroupTitle(group)}”内 URL 相同的重复标签吗？此操作无法撤销。`,
      )
    ) {
      return false;
    }
    const outcome = await runCommand<DeduplicateGroupResult>(
      getActionKey('deduplicate-group', sessionId, group.id),
      { type: 'bok/deduplicate-group', sessionId, groupId: group.id },
      (result) =>
        result.removedTabs === 0
          ? `“${getGroupTitle(group)}”内没有重复项。`
          : `已从“${getGroupTitle(group)}”移除 ${result.removedTabs} 个重复项。`,
    );
    return outcome.ok;
  }

  async function handleRemoveGroup(sessionId: string, group: SavedGroup) {
    if (
      !window.confirm(
        `确定永久删除“${getGroupTitle(group)}”及其中所有 ${group.tabs.length} 个标签吗？`,
      )
    ) {
      return false;
    }
    const outcome = await runCommand<null>(
      getActionKey('remove-group', sessionId, group.id),
      { type: 'bok/remove-group', sessionId, groupId: group.id },
      () => `已删除“${getGroupTitle(group)}”。`,
    );
    return outcome.ok;
  }

  async function handleRenameTab(
    sessionId: string,
    group: SavedGroup,
    tab: SavedTab,
    title: string,
  ) {
    const outcome = await runCommand<null>(
      getActionKey('rename-tab', sessionId, group.id, tab.id),
      {
        type: 'bok/rename-tab',
        sessionId,
        groupId: group.id,
        tabId: tab.id,
        title,
      },
      () => `已重命名为“${title}”。`,
    );
    return outcome.ok;
  }

  async function handleRemoveTab(
    sessionId: string,
    group: SavedGroup,
    tab: SavedTab,
  ) {
    if (group.locked) return false;
    if (!window.confirm(`确定永久删除“${tab.title || tab.url}”吗？`)) return false;

    const outcome = await runCommand<null>(
      getActionKey('remove-tab', sessionId, group.id, tab.id),
      { type: 'bok/remove-tab', sessionId, tabId: tab.id },
      () => `已删除“${tab.title || tab.url}”。`,
    );
    return outcome.ok;
  }

  return (
    <div className="page">
      <header className="page__header">
        <div className="brand" aria-label="Bok">
          <img src="/bok.svg" alt="" />
        </div>
        <h1>保存记录</h1>
        {totalTabCount !== undefined && (
          <p aria-live="polite">
            {isSearching
              ? `${filteredTabCount ?? 0} / ${totalTabCount} 个标签`
              : `${totalTabCount} 个标签`}
          </p>
        )}
      </header>

      {actionNotice && (
        <div
          className="action-notice"
          data-type={actionNotice.type}
          role={actionNotice.type === 'error' ? 'alert' : 'status'}
        >
          {actionNotice.message}
        </div>
      )}

      {visibleSessions !== null && visibleSessions.length > 0 && (
        <SearchField value={searchValue} onChange={setSearchValue} />
      )}

      <main>
        {error ? (
          <section className="state" role="alert">
            <h2>读取失败</h2>
            <p>{error}</p>
            <button type="button" onClick={() => setRetryCount((count) => count + 1)}>
              重新读取
            </button>
          </section>
        ) : sessions === null ? (
          <LoadingState />
        ) : sessions.length === 0 ? (
          <section className="state">
            <h2>还没有保存记录</h2>
            <p>在浏览器中点击 Bok 插件图标，当前窗口的标签组和独立标签会显示在这里。</p>
          </section>
        ) : visibleSessions?.length === 0 ? (
          <section className="state">
            <h2>没有可显示的保存记录</h2>
            <p>保存新的标签后，它们会显示在这里。</p>
          </section>
        ) : filteredSessions?.length === 0 ? (
          <section className="state">
            <h2>没有匹配的保存记录</h2>
            <p>试试更短的关键词，或检查标题、URL 和标签。</p>
          </section>
        ) : (
          <div className="session-list">
            {filteredSessions?.map((session) => (
              <SessionSection
                key={session.id}
                session={session}
                operationGroups={operationGroups}
                pendingAction={pendingAction}
                onOpen={handleOpen}
                onRename={handleRenameGroup}
                onSetLocked={handleSetGroupLocked}
                onSetTaskStatus={handleSetGroupTaskStatus}
                onDeduplicate={handleDeduplicateGroup}
                onRemove={handleRemoveGroup}
                onRenameTab={handleRenameTab}
                onRemoveTab={handleRemoveTab}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
