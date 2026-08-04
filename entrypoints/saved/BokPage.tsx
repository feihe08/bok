import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react';
import { browser } from 'wxt/browser';
import type { SavedPageCommand, SavedPageResponse } from '../../lib/messages';
import type { Tab, TabGroup, TaskStatus } from '../../lib/model';
import { readSessions } from '../../lib/storage';
import type { SavedSession } from '../../lib/types';

type TaskFilter = 'all' | TaskStatus;
type OpenGroupOptions = {
  mode: 'tabs' | 'tab-group';
  destination: 'current-window' | 'new-window';
};
type Theme = 'light' | 'dark';
type ArchiveView = 'current' | 'archived';
type ManagedGroup = TabGroup & { sessionId: string };
type ActionNotice = {
  type: 'success' | 'error';
  message: string;
  persistent?: boolean;
};
type TaskCounts = Record<TaskStatus, { groups: number; tabs: number }>;

const THEME_STORAGE_KEY = 'bok-theme';

const TASK_FILTERS: Array<{ value: TaskFilter; label: string }> = [
  { value: 'all', label: '全部标签' },
  { value: 'todo', label: 'Todo' },
  { value: 'doing', label: 'Doing' },
  { value: 'done', label: 'Done' },
];

const ARCHIVE_VIEWS: Array<{ value: ArchiveView; label: string }> = [
  { value: 'current', label: '当前' },
  { value: 'archived', label: '归档' },
];

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  doing: 'Doing',
  done: 'Done',
};

function getManagedGroups(sessions: SavedSession[]): ManagedGroup[] {
  return [...sessions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((session) =>
      session.groups
        .filter((group) => group.tabs.length > 0)
        .map((group) => ({
          id: group.id,
          sessionId: session.id,
          title: group.title,
          createdAt: group.createdAt,
          isBrowserGroup: group.grouped,
          locked: group.locked,
          pinned: group.pinned,
          taskStatus: group.taskStatus,
          taskCompletedAt: group.taskCompletedAt,
          archivedAt: group.archivedAt,
          tabs: group.tabs.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            createdAt: tab.createdAt,
            taskStatus: tab.taskStatus,
            taskCompletedAt: tab.taskCompletedAt,
          })),
        })),
    );
}

function getGroupsForView(
  groups: ManagedGroup[],
  archiveView: ArchiveView,
): ManagedGroup[] {
  const visible = groups.filter((group) =>
    archiveView === 'archived' ? group.archivedAt !== null : group.archivedAt === null,
  );

  return visible.sort((a, b) => {
    if (archiveView === 'archived') {
      return (b.archivedAt ?? 0) - (a.archivedAt ?? 0);
    }
    return Number(b.pinned) - Number(a.pinned);
  });
}

function getGroupTitle(group: TabGroup): string {
  return group.title.trim() || `${group.tabs.length} 个标签页`;
}

function getContentTitle(archiveView: ArchiveView, taskFilter: TaskFilter): string {
  const taskLabel = TASK_FILTERS.find((filter) => filter.value === taskFilter)?.label;
  if (archiveView === 'archived') {
    return taskFilter === 'all' ? '归档' : `归档 · ${taskLabel}`;
  }
  return taskFilter === 'all' ? '全部标签' : `${taskLabel} 任务`;
}

function getStoredTheme(): Theme | null {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : null;
}

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const storedTheme = getStoredTheme();
if (storedTheme) document.documentElement.dataset.theme = storedTheme;

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function getDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'chrome:') return url.href.replace(/\/$/, '');

    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname === '/' ? '' : url.pathname;
    return `${hostname}${pathname}`;
  } catch {
    return value;
  }
}

function getFaviconUrl(pageUrl: string): string | null {
  try {
    const parsedUrl = new URL(pageUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;

    const faviconUrl = new URL('/_favicon/', browser.runtime.getURL('/saved.html'));
    faviconUrl.searchParams.set('pageUrl', pageUrl);
    faviconUrl.searchParams.set('size', '32');
    return faviconUrl.toString();
  } catch {
    return null;
  }
}

function getFaviconFallback(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol === 'chrome:') return 'C';
    return parsedUrl.hostname.replace(/^www\./, '').charAt(0).toUpperCase() || '•';
  } catch {
    return '•';
  }
}

function Favicon({ tab }: { tab: Tab }) {
  const [failed, setFailed] = useState(false);
  const source = getFaviconUrl(tab.url);

  if (!source || failed) {
    return (
      <span className="tab-favicon tab-favicon--fallback" aria-hidden="true">
        {getFaviconFallback(tab.url)}
      </span>
    );
  }

  return (
    <img
      className="tab-favicon"
      src={source}
      alt=""
      width="16"
      height="16"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function matchesTaskFilter(group: TabGroup, filter: TaskFilter): boolean {
  if (filter === 'all') return true;
  return group.taskStatus === filter || group.tabs.some((tab) => tab.taskStatus === filter);
}

function filterGroups(
  groups: ManagedGroup[],
  searchTerms: string[],
  taskFilter: TaskFilter,
): ManagedGroup[] {
  return groups.flatMap((group) => {
    if (!matchesTaskFilter(group, taskFilter)) return [];

    const groupTitle = normalizeSearchText(getGroupTitle(group));
    const groupMatches = searchTerms.every((term) => groupTitle.includes(term));
    const tabs = group.tabs.filter((tab) => {
      if (taskFilter !== 'all' && group.taskStatus !== taskFilter) {
        if (tab.taskStatus !== taskFilter) return false;
      }
      if (searchTerms.length === 0 || groupMatches) return true;

      const searchText = normalizeSearchText(`${tab.title}\n${tab.url}`);
      return searchTerms.every((term) => searchText.includes(term));
    });

    return tabs.length > 0 ? [{ ...group, tabs }] : [];
  });
}

function openChromeUrl(event: MouseEvent<HTMLAnchorElement>, url: string) {
  if (!url.startsWith('chrome://')) return;

  event.preventDefault();
  void browser.tabs.create({ url });
}

function TaskIcon({ status }: { status: TaskStatus }) {
  return (
    <svg className="task-icon" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6" />
      {status === 'doing' && <path d="M10 4v12" />}
      {status === 'done' && <path d="m7.2 10.2 1.8 1.8 3.8-4.2" />}
    </svg>
  );
}

function TaskBadge({ status }: { status: TaskStatus }) {
  return (
    <span className="task-badge" data-task-status={status}>
      <TaskIcon status={status} />
      <span>{TASK_STATUS_LABELS[status]}</span>
    </span>
  );
}

function BrowserGroupIcon() {
  return (
    <svg className="browser-group-icon" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="3" y="6.5" width="14" height="9.5" rx="1.5" />
      <path d="M3 9.5h14M5.5 6.5V4.5h3v2M10 6.5V4.5h3v2" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7 3.5 6 1-.8 3.2 2.3 2.3-4 1.2-1.8 5.3-.9-5.8-3.3-2 3.3-1.2L7 3.5Z" />
    </svg>
  );
}

function ArchiveIcon({ restore = false }: { restore?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 6.5h12v9H4zM3.5 3.5h13v3h-13zM8 10h4" />
      {restore && <path d="m7 13-2-2 2-2M5 11h4" />}
    </svg>
  );
}

function LockIcon({ open = false }: { open?: boolean }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="5" y="8.5" width="10" height="8" rx="1.5" />
      {open ? <path d="M8 8.5V6.8a3 3 0 0 1 5.4-1.8" /> : <path d="M7.5 8.5V6.8a2.5 2.5 0 0 1 5 0v1.7" />}
    </svg>
  );
}

function TaskOffIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="6" />
      <path d="m5.8 5.8 8.4 8.4" />
    </svg>
  );
}

function CurrentViewIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.5h13v10h-13zM3.5 11h3l1.5 2h4l1.5-2h3" />
    </svg>
  );
}

export default function BokPage() {
  const [groups, setGroups] = useState<ManagedGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [searchValue, setSearchValue] = useState('');
  const [archiveView, setArchiveView] = useState<ArchiveView>('current');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [activeGroupId, setActiveGroupId] = useState('');
  const [openMenuGroupId, setOpenMenuGroupId] = useState('');
  const [openingGroupId, setOpeningGroupId] = useState('');
  const [changingGroupId, setChangingGroupId] = useState('');
  const [changingTabId, setChangingTabId] = useState('');
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [editingGroupId, setEditingGroupId] = useState('');
  const [groupTitleDraft, setGroupTitleDraft] = useState('');
  const groupTitleButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabTaskButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabTaskStatusRefs = useRef(new Map<string, HTMLSelectElement>());
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const groupTaskButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const groupDeleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuItemRefs = useRef(new Map<string, Array<HTMLButtonElement | undefined>>());
  const savingGroupTitleIds = useRef(new Set<string>());
  const cancellingGroupTitleIds = useRef(new Set<string>());
  const [theme, setTheme] = useState<Theme | null>(storedTheme);
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const activeTheme = theme ?? systemTheme;
  const deferredSearchValue = useDeferredValue(searchValue);
  const searchTerms = useMemo(
    () =>
      normalizeSearchText(deferredSearchValue)
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    [deferredSearchValue],
  );
  const viewGroups = useMemo(
    () => getGroupsForView(groups, archiveView),
    [groups, archiveView],
  );
  const visibleGroups = useMemo(
    () => filterGroups(viewGroups, searchTerms, taskFilter),
    [viewGroups, searchTerms, taskFilter],
  );
  const totalTabCount = useMemo(
    () => viewGroups.reduce((total, group) => total + group.tabs.length, 0),
    [viewGroups],
  );
  const visibleTabCount = useMemo(
    () => visibleGroups.reduce((total, group) => total + group.tabs.length, 0),
    [visibleGroups],
  );
  const taskCounts = useMemo<TaskCounts>(() => {
    const counts: TaskCounts = {
      todo: { groups: 0, tabs: 0 },
      doing: { groups: 0, tabs: 0 },
      done: { groups: 0, tabs: 0 },
    };
    for (const group of viewGroups) {
      if (group.taskStatus) counts[group.taskStatus].groups += 1;
      for (const tab of group.tabs) {
        if (tab.taskStatus) counts[tab.taskStatus].tabs += 1;
      }
    }
    return counts;
  }, [viewGroups]);
  const archiveCounts = useMemo(() => {
    const counts: Record<ArchiveView, number> = { current: 0, archived: 0 };
    for (const group of groups) {
      const target = group.archivedAt === null ? 'current' : 'archived';
      counts[target] += group.tabs.length;
    }
    return counts;
  }, [groups]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { sessions, recoveryEntryCount } = await readSessions();
        if (cancelled) return;
        setGroups(getManagedGroups(sessions));
        setLoadError('');
        if (recoveryEntryCount > 0) {
          setActionNotice({
            type: 'error',
            message: `存在 ${recoveryEntryCount} 份异常数据恢复副本。损坏记录已被跳过，其他记录可继续使用。`,
            persistent: true,
          });
        }
      } catch (error) {
        if (cancelled) return;
        console.error('[bok] failed to load saved sessions', error);
        setLoadError(
          error instanceof Error && error.message
            ? error.message
            : '无法读取保存记录，请稍后重试。',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    const handleStorageChange: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, areaName) => {
      if (areaName === 'local' && changes.sessions) void load();
    };

    setLoading(true);
    void load();
    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, [retryCount]);

  useEffect(() => {
    setActiveGroupId((current) =>
      visibleGroups.some((group) => group.id === current)
        ? current
        : (visibleGroups[0]?.id ?? ''),
    );
  }, [visibleGroups]);

  useEffect(() => {
    if (!actionNotice || actionNotice.type === 'error' || actionNotice.persistent) return;
    const timeoutId = window.setTimeout(() => setActionNotice(null), 5500);
    return () => window.clearTimeout(timeoutId);
  }, [actionNotice]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    function handleThemeChange(event: MediaQueryListEvent) {
      setSystemTheme(event.matches ? 'dark' : 'light');
    }

    mediaQuery.addEventListener('change', handleThemeChange);
    return () => mediaQuery.removeEventListener('change', handleThemeChange);
  }, []);

  useEffect(() => {
    if (!openMenuGroupId) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.group-more')?.getAttribute('data-group-id') === openMenuGroupId) {
        return;
      }
      setOpenMenuGroupId('');
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeGroupMenu(true);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuGroupId]);

  useEffect(() => {
    let frameId = 0;

    function updateActiveGroup() {
      if (frameId) return;

      frameId = requestAnimationFrame(() => {
        frameId = 0;
        const topbarHeight = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--topbar-height'),
        );
        const activationTop = (Number.isFinite(topbarHeight) ? topbarHeight : 64) + 20;
        let nextGroupId = visibleGroups[0]?.id ?? '';

        for (const group of visibleGroups) {
          const element = document.getElementById(`group-${group.id}`);
          if (!element || element.getBoundingClientRect().top > activationTop) break;
          nextGroupId = group.id;
        }

        setActiveGroupId((current) =>
          current === nextGroupId ? current : nextGroupId,
        );
      });
    }

    updateActiveGroup();
    window.addEventListener('scroll', updateActiveGroup, { passive: true });
    window.addEventListener('resize', updateActiveGroup);
    return () => {
      window.removeEventListener('scroll', updateActiveGroup);
      window.removeEventListener('resize', updateActiveGroup);
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [visibleGroups]);

  function goToGroup(groupId: string) {
    setActiveGroupId(groupId);
    setCollapsedGroupIds((current) => {
      if (!current.has(groupId)) return current;
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });

    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.getElementById(`group-${groupId}`)?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    });
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function showCommandError(action: string, error: unknown) {
    console.error(`[bok] failed to ${action}`, error);
    const reason = error instanceof Error && error.message ? error.message : '未知错误';
    const detail = reason.replace(/[。.!！]+$/, '');
    setActionNotice({ type: 'error', message: `${action}失败：${detail}。请重试。` });
  }

  function focusGroupTitleButton(groupId: string) {
    requestAnimationFrame(() => groupTitleButtonRefs.current.get(groupId)?.focus());
  }

  function focusTabTaskButton(tabId: string) {
    window.setTimeout(() => tabTaskButtonRefs.current.get(tabId)?.focus(), 120);
  }

  function focusTabTaskStatus(tabId: string) {
    window.setTimeout(() => tabTaskStatusRefs.current.get(tabId)?.focus(), 120);
  }

  function focusMenuTrigger(groupId: string) {
    window.setTimeout(() => {
      const trigger = menuTriggerRefs.current.get(groupId);
      if (trigger?.isConnected && !trigger.disabled) {
        trigger.focus();
        return;
      }
      document.getElementById('saved-groups')?.focus();
    }, 120);
  }

  function focusGroupDeleteButton(groupId: string) {
    window.setTimeout(() => {
      const button = groupDeleteButtonRefs.current.get(groupId);
      if (button?.isConnected && !button.disabled) {
        button.focus();
        return;
      }
      document.getElementById('saved-groups')?.focus();
    }, 120);
  }

  function focusGroupTaskButton(groupId: string) {
    window.setTimeout(() => {
      const button = groupTaskButtonRefs.current.get(groupId);
      if (button?.isConnected && !button.disabled) {
        button.focus();
        return;
      }
      document.getElementById('saved-groups')?.focus();
    }, 120);
  }

  function setMenuItemRef(
    groupId: string,
    index: number,
    element: HTMLButtonElement | null,
  ) {
    const items = menuItemRefs.current.get(groupId) ?? [];
    if (element) {
      element.tabIndex = -1;
      items[index] = element;
    }
    else delete items[index];
    menuItemRefs.current.set(groupId, items);
  }

  function focusMenuItem(items: HTMLButtonElement[], target: HTMLButtonElement | undefined) {
    for (const item of items) item.tabIndex = -1;
    if (!target) return;
    target.tabIndex = 0;
    target.focus();
  }

  function closeGroupMenu(restoreFocus = false) {
    const groupId = openMenuGroupId;
    setOpenMenuGroupId('');
    if (restoreFocus && groupId) focusMenuTrigger(groupId);
  }

  function openGroupMenu(groupId: string, position: 'first' | 'last' = 'first') {
    setOpenMenuGroupId(groupId);
    requestAnimationFrame(() => {
      const items = (menuItemRefs.current.get(groupId) ?? []).filter(
        (item): item is HTMLButtonElement => Boolean(item && !item.disabled),
      );
      const target = position === 'first' ? items[0] : items.at(-1);
      focusMenuItem(items, target);
    });
  }

  function handleMenuTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    groupId: string,
  ) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openGroupMenu(groupId, 'first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openGroupMenu(groupId, 'last');
    } else if (event.key === 'Escape' && openMenuGroupId === groupId) {
      event.preventDefault();
      closeGroupMenu(true);
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, groupId: string) {
    if (event.key === 'Tab') {
      event.preventDefault();
      const trigger = menuTriggerRefs.current.get(groupId);
      const nextButton = trigger?.parentElement?.nextElementSibling;
      setOpenMenuGroupId('');
      requestAnimationFrame(() => {
        if (event.shiftKey) trigger?.focus();
        else if (nextButton instanceof HTMLButtonElement) nextButton.focus();
      });
      return;
    }

    const items = (menuItemRefs.current.get(groupId) ?? []).filter(
      (item): item is HTMLButtonElement => Boolean(item && !item.disabled),
    );
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let targetIndex: number | null = null;
    if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1 + items.length) % items.length;
    if (event.key === 'ArrowUp') targetIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') targetIndex = 0;
    if (event.key === 'End') targetIndex = items.length - 1;

    if (targetIndex !== null) {
      event.preventDefault();
      focusMenuItem(items, items[targetIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeGroupMenu(true);
    }
  }

  async function runCommand(command: SavedPageCommand) {
    const response = (await browser.runtime.sendMessage(command)) as SavedPageResponse;
    if (!response) {
      throw new Error('扩展后台未响应，请重新加载 Bok 扩展后刷新页面');
    }
    if (!response.ok) throw new Error(response.error || '后台没有返回操作结果');
    return response.result;
  }

  async function deleteTab(groupId: string, tabId: string) {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    const tab = group.tabs.find((candidate) => candidate.id === tabId);
    if (
      !tab ||
      !window.confirm(
        `从 Bok 保存记录中永久删除“${tab.title}”？此操作无法恢复，但不会关闭浏览器中的标签页。`,
      )
    ) {
      return;
    }

    try {
      await runCommand({
        type: 'bok/remove-tab',
        sessionId: group.sessionId,
        tabId,
      });
      setActionNotice({ type: 'success', message: `已删除“${tab.title}”` });
      focusMenuTrigger(group.id);
    } catch (error) {
      showCommandError('删除标签', error);
    }
  }

  async function deduplicateGroup(groupId: string) {
    closeGroupMenu(true);
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    if (group.locked) {
      setActionNotice({ type: 'error', message: '标签组已锁定，无法去重。' });
      return;
    }
    if (
      !window.confirm(
        `按完整 URL 移除“${getGroupTitle(group)}”中的重复标签，只保留每个 URL 的第一条？此操作无法恢复。`,
      )
    ) {
      return;
    }

    try {
      const result = await runCommand({
        type: 'bok/deduplicate-group',
        sessionId: group.sessionId,
        groupId,
      });
      const removedTabs = result && 'removedTabs' in result ? result.removedTabs : 0;
      setActionNotice({
        type: 'success',
        message: removedTabs > 0 ? `已按完整 URL 去重，删除 ${removedTabs} 个重复标签` : '没有重复 URL',
      });
    } catch (error) {
      showCommandError('按完整 URL 去重', error);
    } finally {
      focusMenuTrigger(group.id);
    }
  }

  async function togglePinned(group: ManagedGroup) {
    if (changingGroupId || group.archivedAt !== null) return;
    closeGroupMenu();
    setChangingGroupId(group.id);

    try {
      await runCommand({
        type: 'bok/set-group-pinned',
        sessionId: group.sessionId,
        groupId: group.id,
        pinned: !group.pinned,
      });
      setActionNotice({
        type: 'success',
        message: group.pinned ? '已取消固定' : '已固定到顶部',
      });
    } catch (error) {
      showCommandError('更新固定状态', error);
    } finally {
      setChangingGroupId('');
    }
  }

  async function toggleArchived(group: ManagedGroup) {
    if (changingGroupId) return;
    const archiving = group.archivedAt === null;
    closeGroupMenu();
    setChangingGroupId(group.id);

    try {
      await runCommand({
        type: 'bok/set-group-archived',
        sessionId: group.sessionId,
        groupId: group.id,
        archived: archiving,
      });
      setActionNotice({
        type: 'success',
        message: archiving
          ? group.pinned
            ? '已取消固定并归档'
            : '已归档'
          : '已恢复到当前视图',
      });
    } catch (error) {
      showCommandError(archiving ? '归档标签组' : '恢复标签组', error);
    } finally {
      setChangingGroupId('');
    }
  }

  function startEditingGroup(group: ManagedGroup) {
    closeGroupMenu();
    cancellingGroupTitleIds.current.delete(group.id);
    setEditingGroupId(group.id);
    setGroupTitleDraft(getGroupTitle(group));
  }

  async function saveGroupTitle(group: ManagedGroup) {
    if (cancellingGroupTitleIds.current.delete(group.id)) return;
    if (savingGroupTitleIds.current.has(group.id)) return;
    savingGroupTitleIds.current.add(group.id);
    const title = groupTitleDraft.trim();
    setEditingGroupId('');
    setGroupTitleDraft('');
    focusGroupTitleButton(group.id);

    if (title === getGroupTitle(group)) {
      savingGroupTitleIds.current.delete(group.id);
      return;
    }

    try {
      await runCommand({
        type: 'bok/rename-group',
        sessionId: group.sessionId,
        groupId: group.id,
        title,
      });
      setActionNotice({ type: 'success', message: '标签组名称已更新' });
    } catch (error) {
      showCommandError('重命名标签组', error);
    } finally {
      savingGroupTitleIds.current.delete(group.id);
    }
  }

  function cancelGroupTitleEdit(groupId: string) {
    cancellingGroupTitleIds.current.add(groupId);
    setEditingGroupId('');
    setGroupTitleDraft('');
    focusGroupTitleButton(groupId);
  }

  async function toggleLocked(group: ManagedGroup) {
    if (changingGroupId) return;
    closeGroupMenu(true);
    setChangingGroupId(group.id);

    try {
      await runCommand({
        type: 'bok/set-group-locked',
        sessionId: group.sessionId,
        groupId: group.id,
        locked: !group.locked,
      });
      setActionNotice({
        type: 'success',
        message: group.locked ? '标签组已解锁' : '标签组已锁定，删除和去重已禁用',
      });
    } catch (error) {
      showCommandError(group.locked ? '解锁标签组' : '锁定标签组', error);
    } finally {
      setChangingGroupId('');
      focusMenuTrigger(group.id);
    }
  }

  async function setGroupTaskStatus(
    group: ManagedGroup,
    status: TaskStatus | null,
    source: 'menu' | 'header' = 'menu',
  ) {
    if (changingGroupId) return;
    closeGroupMenu(true);
    setChangingGroupId(group.id);

    try {
      await runCommand({
        type: 'bok/set-group-task-status',
        sessionId: group.sessionId,
        groupId: group.id,
        status,
      });
      const label = status === null ? '已取消任务标记' : `已标记为 ${status === 'todo' ? 'Todo' : status === 'doing' ? 'Doing' : 'Done'}`;
      setActionNotice({ type: 'success', message: label });
    } catch (error) {
      showCommandError('更新任务状态', error);
    } finally {
      setChangingGroupId('');
      if (source === 'header') focusGroupTaskButton(group.id);
      else focusMenuTrigger(group.id);
    }
  }

  async function setTabTaskStatus(
    group: ManagedGroup,
    tab: Tab,
    status: TaskStatus | null,
  ) {
    if (changingTabId) return;
    setChangingTabId(tab.id);
    let changed = false;

    try {
      await runCommand({
        type: 'bok/set-tab-task-status',
        sessionId: group.sessionId,
        groupId: group.id,
        tabId: tab.id,
        status,
      });
      changed = true;
      setActionNotice({
        type: 'success',
        message:
          status === null
            ? '已取消任务标记'
            : `已标记为 ${TASK_STATUS_LABELS[status]}`,
      });
    } catch (error) {
      showCommandError('更新任务状态', error);
    } finally {
      setChangingTabId('');
      if (changed) {
        if (status === null) focusTabTaskButton(tab.id);
        else focusTabTaskStatus(tab.id);
      } else if (tab.taskStatus === null) {
        focusTabTaskButton(tab.id);
      } else {
        focusTabTaskStatus(tab.id);
      }
    }
  }

  async function deleteGroup(group: ManagedGroup) {
    closeGroupMenu();
    if (group.locked) {
      setActionNotice({ type: 'error', message: '标签组已锁定，无法删除。' });
      focusGroupDeleteButton(group.id);
      return;
    }
    const title = getGroupTitle(group);
    if (
      !window.confirm(
        `从 Bok 保存记录中永久删除整个标签组“${title}”及其中 ${group.tabs.length} 个标签？此操作无法恢复。`,
      )
    ) {
      focusGroupDeleteButton(group.id);
      return;
    }

    try {
      await runCommand({
        type: 'bok/remove-group',
        sessionId: group.sessionId,
        groupId: group.id,
      });
      setActionNotice({ type: 'success', message: `已删除标签组“${title}”` });
      requestAnimationFrame(() => document.getElementById('saved-groups')?.focus());
    } catch (error) {
      showCommandError('删除标签组', error);
      focusGroupDeleteButton(group.id);
    }
  }

  function toggleTheme() {
    const nextTheme = activeTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setTheme(nextTheme);
  }

  async function openGroup(
    group: ManagedGroup,
    options: OpenGroupOptions,
    restoreMenuFocus = false,
  ) {
    if (openingGroupId) return;

    closeGroupMenu(restoreMenuFocus);
    setOpeningGroupId(group.id);

    try {
      const storedGroup = groups.find((candidate) => candidate.id === group.id) ?? group;
      const result = await runCommand({
        type: 'bok/open-group',
        sessionId: storedGroup.sessionId,
        groupId: storedGroup.id,
        mode: options.mode,
        destination: options.destination,
        tabIds: storedGroup.tabs.map((tab) => tab.id),
      });
      const openedTabs = result && 'openedTabs' in result
        ? result.openedTabs
        : storedGroup.tabs.length;
      const reusedTaskGroup = Boolean(
        result && 'reusedTaskGroup' in result && result.reusedTaskGroup,
      );
      setActionNotice({
        type: 'success',
        message: reusedTaskGroup
          ? '已切换到打开中的任务标签组，未创建重复标签。'
          : `已打开 ${openedTabs} 个标签，保存记录仍保留。`,
        persistent: true,
      });
    } catch (error) {
      showCommandError('打开标签组', error);
    } finally {
      setOpeningGroupId('');
      if (restoreMenuFocus) focusMenuTrigger(group.id);
    }
  }

  return (
    <div className="bok-page">
      <a className="skip-link" href="#saved-groups">
        跳到标签列表
      </a>

      <header className="topbar">
        <div className="topbar__inner">
          <a className="brand" href="#saved-groups" aria-label="Bok 首页">
            <img src="/bok.svg" alt="" />
            <span>Bok</span>
          </a>

          <label className="search-field">
            <span className="sr-only">搜索标签</span>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m12.5 12.5 4 4" />
            </svg>
            <input
              type="search"
              value={searchValue}
              placeholder="搜索标题或 URL"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSearchValue(event.target.value)}
            />
          </label>

          <div className="topbar__actions">
            <p className="topbar__summary" aria-live="polite">
              {visibleTabCount === totalTabCount
                ? `${totalTabCount} 个标签`
                : `${visibleTabCount} / ${totalTabCount} 个标签`}
            </p>
            <button
              type="button"
              className="theme-toggle"
              aria-label={activeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              aria-pressed={activeTheme === 'dark'}
              title={activeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              onClick={toggleTheme}
            >
              {activeTheme === 'dark' ? (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="10" cy="10" r="3.25" />
                  <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M16.5 12.2A6.6 6.6 0 0 1 7.8 3.5a6.6 6.6 0 1 0 8.7 8.7Z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar" aria-label="标签导航">
          <nav>
            <div className="sidebar__section">
              <h2>视图</h2>
              <ul className="filter-list">
                {ARCHIVE_VIEWS.map((view) => (
                  <li key={view.value}>
                    <button
                      type="button"
                      aria-pressed={archiveView === view.value}
                      onClick={() => setArchiveView(view.value)}
                    >
                      <span className="filter-list__label">
                        <span className="filter-list__icon">
                          {view.value === 'current' ? (
                            <CurrentViewIcon />
                          ) : (
                            <ArchiveIcon />
                          )}
                        </span>
                        {view.label}
                      </span>
                      <span className="sidebar__count">{archiveCounts[view.value]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="sidebar__section">
              <h2>任务</h2>
              <ul className="filter-list">
                {TASK_FILTERS.map((filter) => {
                  const doingCount = taskCounts.doing;
                  return (
                    <li key={filter.value}>
                      <button
                        type="button"
                        aria-pressed={taskFilter === filter.value}
                        onClick={() => setTaskFilter(filter.value)}
                      >
                        <span className="filter-list__label">
                          {filter.value === 'all' ? (
                            <span aria-hidden="true">⌘</span>
                          ) : (
                            <TaskIcon status={filter.value} />
                          )}
                          {filter.label}
                        </span>
                        {filter.value === 'all' ? (
                          <span className="sidebar__count">{totalTabCount}</span>
                        ) : filter.value === 'doing' ? (
                          <span
                            className="sidebar__count sidebar__count--task"
                            aria-label={`Doing 中：${doingCount.groups} 个标签组，${doingCount.tabs} 个标签`}
                          >
                            {doingCount.groups} 组 · {doingCount.tabs} 标签
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="sidebar__section sidebar__section--groups">
              <h2>标签组</h2>
              {visibleGroups.length > 0 && (
                <label className="group-select">
                  <span className="sr-only">跳转到标签组</span>
                  <select
                    value={activeGroupId}
                    onChange={(event) => goToGroup(event.target.value)}
                  >
                    {visibleGroups.map((group, index) => (
                      <option key={group.id} value={group.id}>
                        {index + 1}. {getGroupTitle(group)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <ol className="group-nav">
                {visibleGroups.map((group, index) => (
                  <li key={group.id}>
                    <button
                      type="button"
                      aria-current={activeGroupId === group.id ? 'location' : undefined}
                      title={getGroupTitle(group)}
                      onClick={() => goToGroup(group.id)}
                    >
                      <span className="group-nav__index">{index + 1}</span>
                      {group.pinned && (
                        <span className="group-nav__pin" aria-label="已固定">
                          <PinIcon />
                        </span>
                      )}
                      {(group.isBrowserGroup || group.taskStatus !== null) && <BrowserGroupIcon />}
                      <span className="group-nav__title">{getGroupTitle(group)}</span>
                      <span className="sidebar__count">{group.tabs.length}</span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          </nav>
        </aside>

        <main id="saved-groups" className="content" tabIndex={-1}>
          <header className="content__header">
            <div>
              <h1>{getContentTitle(archiveView, taskFilter)}</h1>
            </div>
            <span>{visibleGroups.length} 个标签组</span>
          </header>

          {loadError ? (
            <section className="empty-state" role="alert">
              <h2>读取失败</h2>
              <p>{loadError}</p>
              <button type="button" onClick={() => setRetryCount((count) => count + 1)}>
                重新读取
              </button>
            </section>
          ) : loading ? (
            <section className="empty-state" role="status">
              <h2>正在读取保存记录</h2>
            </section>
          ) : groups.length === 0 ? (
            <section className="empty-state">
              <h2>还没有保存记录</h2>
              <p>点击 Bok 插件图标保存并关闭当前窗口的全部标签后，它们会显示在这里。</p>
            </section>
          ) : viewGroups.length === 0 ? (
            <section className="empty-state">
              <h2>{archiveView === 'archived' ? '还没有归档记录' : '当前视图为空'}</h2>
              <p>
                {archiveView === 'archived'
                  ? '归档标签组后，可以在这里打开或恢复。'
                  : '所有标签组都已归档，可以切换到归档视图查看。'}
              </p>
              <button
                type="button"
                onClick={() =>
                  setArchiveView(archiveView === 'archived' ? 'current' : 'archived')
                }
              >
                {archiveView === 'archived' ? '返回当前视图' : '查看归档'}
              </button>
            </section>
          ) : visibleGroups.length === 0 ? (
            <section className="empty-state">
              <h2>没有匹配的标签</h2>
              <p>调整搜索关键词、任务状态或切换视图。</p>
              <button
                type="button"
                onClick={() => {
                  setSearchValue('');
                  setTaskFilter('all');
                }}
              >
                清除筛选
              </button>
            </section>
          ) : (
            <div className="group-list">
              {visibleGroups.map((group) => {
                const collapsed = collapsedGroupIds.has(group.id);
                const title = getGroupTitle(group);
                const isTaskGroup = group.taskStatus !== null;
                const isBrowserGroup = group.isBrowserGroup || isTaskGroup;
                const openMenuItemCount = isTaskGroup ? 2 : 4;
                const deduplicateMenuIndex = openMenuItemCount;
                const lockMenuIndex = deduplicateMenuIndex + 1;
                const taskMenuStartIndex = lockMenuIndex + 1;
                const defaultOpenOptions: OpenGroupOptions = {
                  mode: isBrowserGroup ? 'tab-group' : 'tabs',
                  destination: 'current-window',
                };
                const defaultOpenTitle = isBrowserGroup
                  ? '以浏览器标签组形式打开全部标签'
                  : '在此窗口打开全部标签';
                const groupChanging = changingGroupId === group.id;
                const archiveActionLabel =
                  group.archivedAt !== null
                    ? '恢复到当前视图'
                    : group.pinned
                      ? '取消固定并归档'
                      : '归档';

                return (
                  <section
                    key={group.id}
                    id={`group-${group.id}`}
                    className={`tab-group${isTaskGroup ? ' tab-group--task' : ''}`}
                    data-task-status={group.taskStatus ?? undefined}
                    aria-labelledby={`group-title-${group.id}`}
                  >
                    <header className="tab-group__header">
                      {isBrowserGroup && (
                        <span
                          className="tab-group__kind"
                          role="img"
                          aria-label="浏览器标签组"
                          title="浏览器标签组"
                        >
                          <BrowserGroupIcon />
                        </span>
                      )}
                      <div className="tab-group__title">
                        {editingGroupId === group.id ? (
                          <input
                            id={`group-title-${group.id}`}
                            className="group-title__input"
                            value={groupTitleDraft}
                            aria-label={`编辑 ${title} 的名称`}
                            autoFocus
                            onChange={(event) => setGroupTitleDraft(event.target.value)}
                            onBlur={() => void saveGroupTitle(group)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void saveGroupTitle(group);
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelGroupTitleEdit(group.id);
                              }
                            }}
                          />
                        ) : (
                          <h2 id={`group-title-${group.id}`}>
                            <button
                              type="button"
                              className="group-title__button"
                              aria-describedby={`group-title-hint-${group.id}`}
                              title="点击编辑名称"
                              ref={(element) => {
                                if (element) groupTitleButtonRefs.current.set(group.id, element);
                                else groupTitleButtonRefs.current.delete(group.id);
                              }}
                              onClick={() => startEditingGroup(group)}
                            >
                              {title}
                            </button>
                          </h2>
                        )}
                        {editingGroupId !== group.id && (
                          <span id={`group-title-hint-${group.id}`} className="sr-only">
                            点击重命名标签组
                          </span>
                        )}
                        {group.title.trim() && <span>{group.tabs.length} 个标签</span>}
                        {group.locked && <span>已锁定</span>}
                        {group.taskStatus && <TaskBadge status={group.taskStatus} />}
                      </div>

                      <div className="tab-group__actions">
                        {group.archivedAt === null && (
                          <button
                            type="button"
                            className={`group-state-button${group.pinned ? ' group-state-button--active' : ''}`}
                            aria-label={group.pinned ? `取消固定：${title}` : `固定到顶部：${title}`}
                            aria-pressed={group.pinned}
                            title={group.pinned ? '取消固定' : '固定到顶部'}
                            disabled={Boolean(changingGroupId)}
                            onClick={() => void togglePinned(group)}
                          >
                            <PinIcon />
                          </button>
                        )}

                        <button
                          type="button"
                          className="group-open-button"
                          disabled={Boolean(openingGroupId) || groupChanging}
                          title={defaultOpenTitle}
                          onClick={() => void openGroup(group, defaultOpenOptions)}
                        >
                          {isBrowserGroup ? (
                            <BrowserGroupIcon />
                          ) : (
                            <svg viewBox="0 0 20 20" aria-hidden="true">
                              <path d="M5 4.5h10v11H5zM8 8h4M10 6v4" />
                            </svg>
                          )}
                          <span>{openingGroupId === group.id ? '打开中…' : '打开全部'}</span>
                        </button>

                        <button
                          type="button"
                          className="group-state-button"
                          aria-label={`${archiveActionLabel}：${title}`}
                          title={archiveActionLabel}
                          disabled={Boolean(changingGroupId)}
                          onClick={() => void toggleArchived(group)}
                        >
                          <ArchiveIcon restore={group.archivedAt !== null} />
                        </button>

                        <button
                          type="button"
                          className={`group-state-button group-task-button${isTaskGroup ? ' group-task-button--active' : ''}`}
                          data-task-status={group.taskStatus ?? 'doing'}
                          aria-label={
                            isTaskGroup
                              ? `取消任务标记：${title}`
                              : `标记为任务：${title}`
                          }
                          aria-pressed={isTaskGroup}
                          title={
                            isTaskGroup
                              ? `取消任务标记（当前 ${TASK_STATUS_LABELS[group.taskStatus!]}）`
                              : '标记为任务（Doing）'
                          }
                          disabled={Boolean(openingGroupId) || groupChanging}
                          ref={(element) => {
                            if (element) groupTaskButtonRefs.current.set(group.id, element);
                            else groupTaskButtonRefs.current.delete(group.id);
                          }}
                          onClick={() =>
                            void setGroupTaskStatus(
                              group,
                              isTaskGroup ? null : 'doing',
                              'header',
                            )
                          }
                        >
                          <TaskIcon status={group.taskStatus ?? 'doing'} />
                        </button>

                        <button
                          type="button"
                          className="group-state-button group-delete-button"
                          aria-label={
                            group.locked
                              ? `标签组已锁定，无法删除：${title}`
                              : `删除标签组：${title}`
                          }
                          title={group.locked ? '标签组已锁定，无法删除' : '删除标签组'}
                          disabled={Boolean(openingGroupId) || groupChanging || group.locked}
                          ref={(element) => {
                            if (element) groupDeleteButtonRefs.current.set(group.id, element);
                            else groupDeleteButtonRefs.current.delete(group.id);
                          }}
                          onClick={() => void deleteGroup(group)}
                        >
                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <path d="M4.5 6h11M8 3.5h4M6.5 6l.6 10h5.8l.6-10M8.5 9v4M11.5 9v4" />
                          </svg>
                        </button>

                        <div className="group-more" data-group-id={group.id}>
                          <button
                            type="button"
                            className="group-more__trigger"
                            aria-label={`更多操作：${title}`}
                            aria-haspopup="menu"
                            aria-expanded={openMenuGroupId === group.id}
                            disabled={Boolean(openingGroupId) || groupChanging}
                            ref={(element) => {
                              if (element) menuTriggerRefs.current.set(group.id, element);
                              else menuTriggerRefs.current.delete(group.id);
                            }}
                            onClick={() => {
                              if (openMenuGroupId === group.id) closeGroupMenu();
                              else openGroupMenu(group.id);
                            }}
                            onKeyDown={(event) => handleMenuTriggerKeyDown(event, group.id)}
                          >
                            <svg viewBox="0 0 20 20" aria-hidden="true">
                              <circle cx="5" cy="10" r="1" />
                              <circle cx="10" cy="10" r="1" />
                              <circle cx="15" cy="10" r="1" />
                            </svg>
                          </button>

                          {openMenuGroupId === group.id && (
                            <div
                              className="group-menu"
                              role="menu"
                              aria-label={`${title} 的更多操作`}
                              onKeyDown={(event) => handleMenuKeyDown(event, group.id)}
                            >
                              {!isTaskGroup && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  ref={(element) => setMenuItemRef(group.id, 0, element)}
                                  onClick={() =>
                                    void openGroup(
                                      group,
                                      {
                                        mode: 'tabs',
                                        destination: 'current-window',
                                      },
                                      true,
                                    )
                                  }
                                >
                                  <svg viewBox="0 0 20 20" aria-hidden="true">
                                    <rect x="3.5" y="4" width="13" height="12" rx="1.5" />
                                    <path d="M3.5 7h13" />
                                  </svg>
                                  在此窗口打开
                                </button>
                              )}
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) =>
                                  setMenuItemRef(group.id, isTaskGroup ? 0 : 1, element)
                                }
                                onClick={() =>
                                  void openGroup(
                                    group,
                                    {
                                      mode: 'tab-group',
                                      destination: 'current-window',
                                    },
                                    true,
                                  )
                                }
                              >
                                <svg viewBox="0 0 20 20" aria-hidden="true">
                                  <path d="M4 4.5h12v11H4zM7 8h6" />
                                </svg>
                                在此窗口以标签组打开
                              </button>
                              {!isTaskGroup && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  ref={(element) => setMenuItemRef(group.id, 2, element)}
                                  onClick={() =>
                                    void openGroup(
                                      group,
                                      {
                                        mode: 'tabs',
                                        destination: 'new-window',
                                      },
                                      true,
                                    )
                                  }
                                >
                                  <svg viewBox="0 0 20 20" aria-hidden="true">
                                    <rect x="3.5" y="5" width="5" height="10" rx="1" />
                                    <rect x="11.5" y="5" width="5" height="10" rx="1" />
                                  </svg>
                                  在新窗口打开
                                </button>
                              )}
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) =>
                                  setMenuItemRef(group.id, isTaskGroup ? 1 : 3, element)
                                }
                                onClick={() =>
                                  void openGroup(
                                    group,
                                    {
                                      mode: 'tab-group',
                                      destination: 'new-window',
                                    },
                                    true,
                                  )
                                }
                              >
                                <svg viewBox="0 0 20 20" aria-hidden="true">
                                  <rect x="3.5" y="5" width="5" height="10" rx="1" />
                                  <path d="M11.5 7.5h5v8h-5zM13.5 5.5h3v3M16.5 5.5l-4 4" />
                                </svg>
                                在新窗口以标签组打开
                              </button>
                              <div className="group-menu__separator" role="separator" />
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) =>
                                  setMenuItemRef(group.id, deduplicateMenuIndex, element)
                                }
                                disabled={group.locked}
                                title={group.locked ? '标签组已锁定，无法去重' : '按完整 URL 去重'}
                                onClick={() => void deduplicateGroup(group.id)}
                              >
                                <svg viewBox="0 0 20 20" aria-hidden="true">
                                  <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
                                  <path d="M7.5 12.5v2A2 2 0 0 0 9.5 16.5h5a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-2" />
                                </svg>
                                {group.locked ? '去重（已锁定，先解锁）' : '按完整 URL 去重'}
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) => setMenuItemRef(group.id, lockMenuIndex, element)}
                                onClick={() => void toggleLocked(group)}
                              >
                                <LockIcon open={group.locked} />
                                {group.locked ? '解锁标签组' : '锁定标签组'}
                              </button>
                              {group.taskStatus !== null && (
                                <>
                                  <div className="group-menu__separator" role="separator" />
                                  {(['todo', 'doing', 'done'] as const).map((status, index) => (
                                    <button
                                      key={status}
                                      type="button"
                                      role="menuitemradio"
                                      aria-checked={group.taskStatus === status}
                                      ref={(element) =>
                                        setMenuItemRef(group.id, taskMenuStartIndex + index, element)
                                      }
                                      onClick={() => void setGroupTaskStatus(group, status)}
                                    >
                                      <TaskIcon status={status} />
                                      标记为 {TASK_STATUS_LABELS[status]}
                                    </button>
                                  ))}
                                  <button
                                    type="button"
                                    role="menuitem"
                                    ref={(element) =>
                                      setMenuItemRef(group.id, taskMenuStartIndex + 3, element)
                                    }
                                    onClick={() => void setGroupTaskStatus(group, null)}
                                  >
                                    <TaskOffIcon />
                                    取消任务标记
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          className="collapse-button"
                          aria-expanded={!collapsed}
                          aria-controls={`group-tabs-${group.id}`}
                          onClick={() => toggleGroup(group.id)}
                        >
                          <svg viewBox="0 0 20 20" aria-hidden="true">
                            <path d="m6.5 8 3.5 3.5L13.5 8" />
                          </svg>
                          <span className="sr-only">{collapsed ? '展开' : '收起'} {title}</span>
                        </button>
                      </div>
                    </header>

                    {!collapsed && (
                      <ol id={`group-tabs-${group.id}`} className="tab-list">
                        {group.tabs.map((tab) => (
                          <li
                            key={tab.id}
                            className={`tab-row${tab.taskStatus ? ' tab-row--task' : ''}`}
                            data-task-status={tab.taskStatus ?? undefined}
                          >
                              <a
                                className="tab-row__link"
                                href={tab.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`在新标签页打开链接：${tab.title}`}
                                onClick={(event) => openChromeUrl(event, tab.url)}
                              />
                              <Favicon tab={tab} />
                              <span className="tab-title">
                                <span className="tab-title__text">{tab.title}</span>
                                {tab.taskStatus && (
                                  <label className="tab-task-status">
                                    <span className="sr-only">任务状态</span>
                                    <TaskIcon status={tab.taskStatus} />
                                    <select
                                      value={tab.taskStatus}
                                      disabled={changingTabId === tab.id}
                                      aria-label={`任务状态：${tab.title}`}
                                      ref={(element) => {
                                        if (element) tabTaskStatusRefs.current.set(tab.id, element);
                                        else tabTaskStatusRefs.current.delete(tab.id);
                                      }}
                                      onChange={(event) =>
                                        void setTabTaskStatus(
                                          group,
                                          tab,
                                          (event.target.value || null) as TaskStatus | null,
                                        )
                                      }
                                    >
                                      <option value="todo">Todo</option>
                                      <option value="doing">Doing</option>
                                      <option value="done">Done</option>
                                      <option value="">取消任务</option>
                                    </select>
                                  </label>
                                )}
                              </span>
                              <span className="tab-url">{getDisplayUrl(tab.url)}</span>
                              <span className="tab-actions">
                                {tab.taskStatus === null && (
                                  <button
                                    type="button"
                                    className="tab-action tab-action--task"
                                    aria-label={`标记为任务：${tab.title}`}
                                    title="标记为任务（Doing）"
                                    disabled={changingTabId === tab.id}
                                    ref={(element) => {
                                      if (element) tabTaskButtonRefs.current.set(tab.id, element);
                                      else tabTaskButtonRefs.current.delete(tab.id);
                                    }}
                                    onClick={() => void setTabTaskStatus(group, tab, 'doing')}
                                  >
                                    <TaskIcon status="doing" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="tab-action tab-action--delete"
                                  aria-label={
                                    group.locked
                                      ? `组已锁定，先解锁后才能删除：${tab.title}`
                                      : `删除：${tab.title}`
                                  }
                                  disabled={group.locked}
                                  title={group.locked ? '组已锁定，先解锁后才能删除标签' : '删除'}
                                  onClick={() => void deleteTab(group.id, tab.id)}
                                >
                                  <svg viewBox="0 0 20 20" aria-hidden="true">
                                    <path d="M4.5 6h11M8 3.5h4M6.5 6l.6 10h5.8l.6-10M8.5 9v4M11.5 9v4" />
                                  </svg>
                                </button>
                              </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </main>
      </div>

      <div className="sr-only" role="status" aria-atomic="true">
        {actionNotice?.type === 'success' ? actionNotice.message : ''}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {actionNotice?.type === 'error' ? actionNotice.message : ''}
      </div>
      {actionNotice && (
        <div className={`action-notice action-notice--${actionNotice.type}`}>
          <span>{actionNotice.message}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setActionNotice(null)}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
