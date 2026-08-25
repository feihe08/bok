import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from 'react';
import { browser } from 'wxt/browser';
import type {
  SavedPageCommand,
  SavedPageResponse,
} from '../../libs/saved-pages/messages';
import type {
  SavedGroup,
  SavedSession,
  SavedTab,
  TaskStatus,
} from '../../libs/saved-pages/model';
import { readSessions } from '../../libs/saved-pages/persistence';
import { AppHeader } from '../shared/AppHeader';
import { useBokTheme } from '../shared/useBokTheme';

type TaskFilter = 'all' | TaskStatus;
type OpenGroupOptions = {
  mode: 'tabs' | 'tab-group';
  destination: 'current-window' | 'new-window';
};
type ArchiveView = 'current' | 'archived';
type ManagedGroup = SavedGroup & { sessionId: string };
type ManagedSessionItem =
  | { type: 'tab'; tab: SavedTab; sessionId: string; groupId: string }
  | { type: 'group'; group: ManagedGroup };
type ManagedSession = {
  id: string;
  createdAt: number;
  title: string;
  locked: boolean;
  pinned: boolean;
  restoredAt: number | null;
  archivedAt: number | null;
  taskStatus: TaskStatus | null;
  taskCompletedAt: number | null;
  totalTabCount: number;
  items: ManagedSessionItem[];
};
type ActionNotice = {
  type: 'success' | 'error';
  message: string;
  persistent?: boolean;
};
type TabMoveTarget = {
  indicatorKey: string;
  sessionId: string;
  groupId: string | null;
  targetBeforeTabId: string | null;
  label: string;
  indicator:
    | { type: 'row'; tabId: string; edge: 'before' | 'after' }
    | { type: 'container'; kind: 'session' | 'group'; id: string };
};
type DraggedTab = {
  tab: SavedTab;
  sourceSessionId: string;
  sourceGroupId: string | null;
};
type TaskCounts = Record<TaskStatus, { sessions: number; groups: number; tabs: number }>;

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

function getManagedSessions(sessions: SavedSession[]): ManagedSession[] {
  return [...sessions]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((session) => {
      const items = session.items.flatMap<ManagedSessionItem>((item) => {
        if (item.type === 'tab') {
          return [{
            type: 'tab',
            tab: item.tab,
            sessionId: session.id,
            groupId: `tab:${item.tab.id}`,
          }];
        }
        return item.group.tabs.length > 0
          ? [{
              type: 'group',
              group: { ...item.group, sessionId: session.id },
            }]
          : [];
      });
      return {
        id: session.id,
        createdAt: session.createdAt,
        title: session.title,
        locked: session.locked,
        pinned: session.pinned,
        restoredAt: session.restoredAt,
        archivedAt: session.archivedAt,
        taskStatus: session.taskStatus,
        taskCompletedAt: session.taskCompletedAt,
        totalTabCount: items.reduce(
          (total, item) => total + (item.type === 'tab' ? 1 : item.group.tabs.length),
          0,
        ),
        items,
      };
    })
    .filter((session) => session.items.length > 0);
}

function getSessionsForView(
  sessions: ManagedSession[],
  archiveView: ArchiveView,
): ManagedSession[] {
  return sessions.flatMap((session) => {
    if (session.archivedAt !== null) {
      return archiveView === 'archived' ? [session] : [];
    }

    const items = session.items.filter((item) => {
      const archivedAt = item.type === 'tab'
        ? item.tab.archivedAt
        : item.group.archivedAt;
      return archiveView === 'archived' ? archivedAt !== null : archivedAt === null;
    });
    return items.length > 0 ? [{ ...session, items }] : [];
  });
}

function getSingleBrowserGroup(session: ManagedSession): ManagedGroup | null {
  if (session.items.length !== 1) return null;
  const [item] = session.items;
  return item.type === 'group' ? item.group : null;
}

function getMergedBrowserGroup(session: ManagedSession): ManagedGroup | null {
  if (
    session.title.trim() ||
    session.locked ||
    session.pinned ||
    session.archivedAt !== null ||
    session.taskStatus !== null
  ) {
    return null;
  }
  return getSingleBrowserGroup(session);
}

function hasLockedGroup(session: ManagedSession): boolean {
  return session.items.some(
    (item) => item.type === 'group' && item.group.locked,
  );
}

function getSessionTitle(session: ManagedSession): string {
  return session.title.trim() || `${session.totalTabCount} 个标签`;
}

function getSessionNavigationTitle(session: ManagedSession): string {
  const singleGroup = getMergedBrowserGroup(session);
  return singleGroup ? getGroupTitle(singleGroup) : getSessionTitle(session);
}

function getGroupTitle(group: SavedGroup): string {
  return group.title.trim() || `${group.tabs.length} 个标签页`;
}

function formatGroupCreatedAt(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const datePart = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(
    '-',
  );
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}`;

  return `${datePart} ${timePart}`;
}

function getContentTitle(archiveView: ArchiveView, taskFilter: TaskFilter): string {
  const taskLabel = TASK_FILTERS.find((filter) => filter.value === taskFilter)?.label;
  if (archiveView === 'archived') {
    return taskFilter === 'all' ? '归档' : `归档 · ${taskLabel}`;
  }
  return taskFilter === 'all' ? '全部标签' : `${taskLabel} 任务`;
}

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

function Favicon({ tab }: { tab: SavedTab }) {
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

function matchesTaskFilter(group: SavedGroup, filter: TaskFilter): boolean {
  if (filter === 'all') return true;
  return group.taskStatus === filter || group.tabs.some((tab) => tab.taskStatus === filter);
}

function filterSessions(
  sessions: ManagedSession[],
  searchTerms: string[],
  taskFilter: TaskFilter,
): ManagedSession[] {
  return sessions.flatMap((session) => {
    const sessionSearchText = normalizeSearchText(getSessionTitle(session));
    const sessionMatchesSearch =
      searchTerms.length > 0 &&
      searchTerms.every((term) => sessionSearchText.includes(term));
    const sessionMatchesTask =
      taskFilter !== 'all' && session.taskStatus === taskFilter;
    const items = session.items.flatMap<ManagedSessionItem>((item) => {
      if (item.type === 'tab') {
        if (
          taskFilter !== 'all' &&
          !sessionMatchesTask &&
          item.tab.taskStatus !== taskFilter
        ) return [];
        if (searchTerms.length === 0 || sessionMatchesSearch) return [item];
        const searchText = normalizeSearchText(`${item.tab.title}\n${item.tab.url}`);
        return searchTerms.every((term) => searchText.includes(term)) ? [item] : [];
      }

      const group = item.group;
      if (!sessionMatchesTask && !matchesTaskFilter(group, taskFilter)) return [];

      const groupTitle = normalizeSearchText(getGroupTitle(group));
      const groupMatches =
        sessionMatchesSearch ||
        searchTerms.every((term) => groupTitle.includes(term));
      const tabs = group.tabs.filter((tab) => {
        if (
          taskFilter !== 'all' &&
          !sessionMatchesTask &&
          group.taskStatus !== taskFilter
        ) {
          if (tab.taskStatus !== taskFilter) return false;
        }
        if (searchTerms.length === 0 || groupMatches) return true;

        const searchText = normalizeSearchText(`${tab.title}\n${tab.url}`);
        return searchTerms.every((term) => searchText.includes(term));
      });

      return tabs.length > 0
        ? [{ type: 'group', group: { ...group, tabs } }]
        : [];
    });

    return items.length > 0 ? [{ ...session, items }] : [];
  });
}

function countVisibleSessionTabs(session: ManagedSession): number {
  return session.items.reduce(
    (total, item) => total + (item.type === 'tab' ? 1 : item.group.tabs.length),
    0,
  );
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
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [searchValue, setSearchValue] = useState('');
  const [archiveView, setArchiveView] = useState<ArchiveView>('current');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [activeSessionId, setActiveSessionId] = useState('');
  const [openMenuGroupId, setOpenMenuGroupId] = useState('');
  const [openMenuSessionId, setOpenMenuSessionId] = useState('');
  const [openingGroupId, setOpeningGroupId] = useState('');
  const [openingSessionId, setOpeningSessionId] = useState('');
  const [changingGroupId, setChangingGroupId] = useState('');
  const [changingSessionId, setChangingSessionId] = useState('');
  const [changingTabId, setChangingTabId] = useState('');
  const [movingTabId, setMovingTabId] = useState('');
  const [draggedTab, setDraggedTab] = useState<DraggedTab | null>(null);
  const [dropTarget, setDropTarget] = useState<TabMoveTarget | null>(null);
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null);
  const [editingGroupId, setEditingGroupId] = useState('');
  const [groupTitleDraft, setGroupTitleDraft] = useState('');
  const [editingSessionId, setEditingSessionId] = useState('');
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const groupTitleButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const sessionTitleButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabTaskButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabTaskStatusRefs = useRef(new Map<string, HTMLSelectElement>());
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const sessionMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const menuItemRefs = useRef(new Map<string, Array<HTMLButtonElement | undefined>>());
  const sessionMenuItemRefs = useRef(
    new Map<string, Array<HTMLButtonElement | undefined>>(),
  );
  const savingGroupTitleIds = useRef(new Set<string>());
  const cancellingGroupTitleIds = useRef(new Set<string>());
  const savingSessionTitleIds = useRef(new Set<string>());
  const cancellingSessionTitleIds = useRef(new Set<string>());
  const openingCommandRef = useRef(false);
  const { theme: activeTheme, toggleTheme } = useBokTheme({
    forceBackupOnWrite: true,
  });
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<Set<string>>(
    () => new Set(),
  );
  const deferredSearchValue = useDeferredValue(searchValue);
  const searchTerms = useMemo(
    () =>
      normalizeSearchText(deferredSearchValue)
        .trim()
        .split(/\s+/)
        .filter(Boolean),
    [deferredSearchValue],
  );
  const filtersActive = searchTerms.length > 0 || taskFilter !== 'all';
  const groups = useMemo(
    () => sessions.flatMap((session) =>
      session.items.flatMap((item) => item.type === 'group' ? [item.group] : []),
    ),
    [sessions],
  );
  const viewSessions = useMemo(
    () => getSessionsForView(sessions, archiveView),
    [sessions, archiveView],
  );
  const visibleSessions = useMemo(
    () => filterSessions(viewSessions, searchTerms, taskFilter),
    [viewSessions, searchTerms, taskFilter],
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const totalTabCount = useMemo(
    () => viewSessions.reduce(
      (total, session) => total + countVisibleSessionTabs(session),
      0,
    ),
    [viewSessions],
  );
  const visibleTabCount = useMemo(
    () => visibleSessions.reduce(
      (total, session) => total + countVisibleSessionTabs(session),
      0,
    ),
    [visibleSessions],
  );
  const taskCounts = useMemo<TaskCounts>(() => {
    const counts: TaskCounts = {
      todo: { sessions: 0, groups: 0, tabs: 0 },
      doing: { sessions: 0, groups: 0, tabs: 0 },
      done: { sessions: 0, groups: 0, tabs: 0 },
    };
    for (const session of viewSessions) {
      if (session.taskStatus) counts[session.taskStatus].sessions += 1;
      for (const item of session.items) {
        if (item.type === 'tab') {
          if (item.tab.taskStatus) counts[item.tab.taskStatus].tabs += 1;
          continue;
        }
        if (item.group.taskStatus) counts[item.group.taskStatus].groups += 1;
        for (const tab of item.group.tabs) {
          if (tab.taskStatus) counts[tab.taskStatus].tabs += 1;
        }
      }
    }
    return counts;
  }, [viewSessions]);
  const archiveCounts = useMemo(() => {
    const counts: Record<ArchiveView, number> = { current: 0, archived: 0 };
    for (const session of sessions) {
      if (session.archivedAt !== null) {
        counts.archived += session.totalTabCount;
        continue;
      }
      for (const item of session.items) {
        const archivedAt = item.type === 'tab'
          ? item.tab.archivedAt
          : item.group.archivedAt;
        const target = archivedAt === null ? 'current' : 'archived';
        counts[target] += item.type === 'tab' ? 1 : item.group.tabs.length;
      }
    }
    return counts;
  }, [sessions]);

  useEffect(() => {
    void browser.runtime
      .sendMessage({ type: 'bok/bookmark-backup' })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { sessions, recoveryEntryCount } = await readSessions();
        if (cancelled) return;
        setSessions(getManagedSessions(sessions));
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
    setActiveSessionId((current) =>
      visibleSessions.some((session) => session.id === current)
        ? current
        : (visibleSessions[0]?.id ?? ''),
    );
  }, [visibleSessions]);

  useEffect(() => {
    if (!actionNotice || actionNotice.type === 'error' || actionNotice.persistent) return;
    const timeoutId = window.setTimeout(() => setActionNotice(null), 5500);
    return () => window.clearTimeout(timeoutId);
  }, [actionNotice]);

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
    if (!openMenuSessionId) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest('.session-more')?.getAttribute('data-session-id') ===
        openMenuSessionId
      ) {
        return;
      }
      setOpenMenuSessionId('');
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeSessionMenu(true);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenuSessionId]);

  useEffect(() => {
    let frameId = 0;

    function updateActiveSession() {
      if (frameId) return;

      frameId = requestAnimationFrame(() => {
        frameId = 0;
        const topbarHeight = Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--topbar-height'),
        );
        const activationTop = (Number.isFinite(topbarHeight) ? topbarHeight : 64) + 20;
        let nextSessionId = visibleSessions[0]?.id ?? '';

        for (const session of visibleSessions) {
          const element = document.getElementById(`session-${session.id}`);
          if (!element || element.getBoundingClientRect().top > activationTop) break;
          nextSessionId = session.id;
        }

        setActiveSessionId((current) =>
          current === nextSessionId ? current : nextSessionId,
        );
      });
    }

    updateActiveSession();
    window.addEventListener('scroll', updateActiveSession, { passive: true });
    window.addEventListener('resize', updateActiveSession);
    return () => {
      window.removeEventListener('scroll', updateActiveSession);
      window.removeEventListener('resize', updateActiveSession);
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [visibleSessions]);

  function goToSession(sessionId: string) {
    setActiveSessionId(sessionId);
    setCollapsedSessionIds((current) => {
      if (!current.has(sessionId)) return current;
      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });
    requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.getElementById(`session-${sessionId}`)?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    });
  }

  function toggleSession(sessionId: string) {
    setCollapsedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
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
    setOpenMenuSessionId('');
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

  function focusSessionTitleButton(sessionId: string) {
    requestAnimationFrame(() => sessionTitleButtonRefs.current.get(sessionId)?.focus());
  }

  function focusSessionMenuTrigger(sessionId: string) {
    window.setTimeout(() => {
      const trigger = sessionMenuTriggerRefs.current.get(sessionId);
      if (trigger?.isConnected && !trigger.disabled) {
        trigger.focus();
        return;
      }
      document.getElementById('saved-groups')?.focus();
    }, 120);
  }

  function setSessionMenuItemRef(
    sessionId: string,
    index: number,
    element: HTMLButtonElement | null,
  ) {
    const items = sessionMenuItemRefs.current.get(sessionId) ?? [];
    if (element) {
      element.tabIndex = -1;
      items[index] = element;
    } else {
      delete items[index];
    }
    sessionMenuItemRefs.current.set(sessionId, items);
  }

  function closeSessionMenu(restoreFocus = false) {
    const sessionId = openMenuSessionId;
    setOpenMenuSessionId('');
    if (restoreFocus && sessionId) focusSessionMenuTrigger(sessionId);
  }

  function openSessionMenu(
    sessionId: string,
    position: 'first' | 'last' = 'first',
  ) {
    setOpenMenuGroupId('');
    setOpenMenuSessionId(sessionId);
    requestAnimationFrame(() => {
      const items = (sessionMenuItemRefs.current.get(sessionId) ?? []).filter(
        (item): item is HTMLButtonElement => Boolean(item && !item.disabled),
      );
      focusMenuItem(items, position === 'first' ? items[0] : items.at(-1));
    });
  }

  function handleSessionMenuTriggerKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    sessionId: string,
  ) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openSessionMenu(sessionId, 'first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openSessionMenu(sessionId, 'last');
    } else if (event.key === 'Escape' && openMenuSessionId === sessionId) {
      event.preventDefault();
      closeSessionMenu(true);
    }
  }

  function handleSessionMenuKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    sessionId: string,
  ) {
    if (event.key === 'Tab') {
      event.preventDefault();
      const trigger = sessionMenuTriggerRefs.current.get(sessionId);
      const nextButton = trigger?.parentElement?.nextElementSibling;
      setOpenMenuSessionId('');
      requestAnimationFrame(() => {
        if (event.shiftKey) trigger?.focus();
        else if (nextButton instanceof HTMLButtonElement) nextButton.focus();
      });
      return;
    }

    const items = (sessionMenuItemRefs.current.get(sessionId) ?? []).filter(
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
      closeSessionMenu(true);
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

  async function deleteTab(
    groupId: string,
    tabId: string,
    deleteButton: HTMLButtonElement,
  ) {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    const tab = group.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const tabList = deleteButton.closest('.tab-list');
    const deleteButtons = tabList
      ? Array.from(
          tabList.querySelectorAll<HTMLButtonElement>('.tab-action--delete:not(:disabled)'),
        )
      : [];
    const deleteButtonIndex = deleteButtons.indexOf(deleteButton);
    const nextFocusTarget = deleteButtonIndex >= 0
      ? deleteButtons[deleteButtonIndex + 1] ?? deleteButtons[deleteButtonIndex - 1]
      : undefined;

    try {
      await runCommand({
        type: 'bok/remove-tab',
        sessionId: group.sessionId,
        tabId,
      });
      setActionNotice({ type: 'success', message: `已删除“${tab.title}”` });
      if (nextFocusTarget?.isConnected && !nextFocusTarget.disabled) {
        nextFocusTarget.focus({ preventScroll: true });
      } else {
        document.getElementById('saved-groups')?.focus({ preventScroll: true });
      }
    } catch (error) {
      showCommandError('删除标签', error);
    }
  }

  async function deleteDirectTab(item: Extract<ManagedSessionItem, { type: 'tab' }>) {
    const session = sessions.find((candidate) => candidate.id === item.sessionId);
    if (session?.locked) {
      setActionNotice({ type: 'error', message: '保存记录已锁定，无法删除标签。' });
      return;
    }
    try {
      await runCommand({
        type: 'bok/remove-tab',
        sessionId: item.sessionId,
        tabId: item.tab.id,
      });
      setActionNotice({ type: 'success', message: `已删除“${item.tab.title}”` });
      requestAnimationFrame(() => document.getElementById('saved-groups')?.focus());
    } catch (error) {
      showCommandError('删除标签', error);
    }
  }

  async function deduplicateGroup(groupId: string) {
    closeGroupMenu(true);
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    if (group.locked) {
      setActionNotice({ type: 'error', message: '分组已锁定，无法去重。' });
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
        message: group.pinned ? '已取消固定' : '已固定，将跳过自动归档',
      });
    } catch (error) {
      showCommandError('更新固定状态', error);
    } finally {
      setChangingGroupId('');
      focusMenuTrigger(group.id);
    }
  }

  async function toggleArchived(group: ManagedGroup) {
    if (changingGroupId) return;
    const archiving = group.archivedAt === null;
    closeGroupMenu();
    setChangingGroupId(group.id);

    try {
      await runCommand(
        archiving
          ? {
              type: 'bok/set-group-archived',
              sessionId: group.sessionId,
              groupId: group.id,
              archived: true,
            }
          : {
              type: 'bok/restore-group',
              sessionId: group.sessionId,
              groupId: group.id,
            },
      );
      setActionNotice({
        type: 'success',
        message: archiving
          ? group.pinned
            ? '已取消固定并归档'
            : '已归档'
          : '已恢复到当前视图',
      });
    } catch (error) {
      showCommandError(archiving ? '归档分组' : '恢复分组', error);
    } finally {
      setChangingGroupId('');
      focusMenuTrigger(group.id);
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
      setActionNotice({ type: 'success', message: '分组名称已更新' });
    } catch (error) {
      showCommandError('重命名分组', error);
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
        message: group.locked ? '分组已解锁' : '分组已锁定，删除和去重已禁用',
      });
    } catch (error) {
      showCommandError(group.locked ? '解锁分组' : '锁定分组', error);
    } finally {
      setChangingGroupId('');
      focusMenuTrigger(group.id);
    }
  }

  async function setGroupTaskStatus(
    group: ManagedGroup,
    status: TaskStatus | null,
  ) {
    if (changingGroupId) return;
    closeGroupMenu(true);
    setChangingGroupId(group.id);

    try {
      const result = await runCommand({
        type: 'bok/set-group-task-status',
        sessionId: group.sessionId,
        groupId: group.id,
        status,
      });
      const label = status === null ? '已取消任务标记' : `已标记为 ${status === 'todo' ? 'Todo' : status === 'doing' ? 'Doing' : 'Done'}`;
      const convertedGroup = result && 'groupTitle' in result ? result : undefined;
      setActionNotice({
        type: 'success',
        message: convertedGroup
          ? convertedGroup.renamed
            ? `${label}；名称重复，已重命名为“${convertedGroup.groupTitle}”并转换为标签组`
            : `${label}，并已转换为标签组`
          : label,
      });
    } catch (error) {
      showCommandError('更新任务状态', error);
    } finally {
      setChangingGroupId('');
      focusMenuTrigger(group.id);
    }
  }

  async function setTabTaskStatus(
    sessionId: string,
    groupId: string,
    tab: SavedTab,
    status: TaskStatus | null,
  ) {
    if (changingTabId) return;
    setChangingTabId(tab.id);
    let changed = false;

    try {
      await runCommand({
        type: 'bok/set-tab-task-status',
        sessionId,
        groupId,
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
    const storedGroup = groups.find((candidate) => candidate.id === group.id) ?? group;
    if (storedGroup.locked) {
      setActionNotice({ type: 'error', message: '分组已锁定，无法删除。' });
      focusMenuTrigger(group.id);
      return;
    }
    const title = getGroupTitle(storedGroup);
    if (
      !window.confirm(
        `从 Bok 保存记录中永久删除整个分组“${title}”及其中 ${storedGroup.tabs.length} 个标签？此操作无法恢复。`,
      )
    ) {
      focusMenuTrigger(group.id);
      return;
    }

    try {
      await runCommand({
        type: 'bok/remove-group',
        sessionId: storedGroup.sessionId,
        groupId: storedGroup.id,
      });
      setActionNotice({ type: 'success', message: `已删除分组“${title}”` });
      requestAnimationFrame(() => document.getElementById('saved-groups')?.focus());
    } catch (error) {
      showCommandError('删除分组', error);
      focusMenuTrigger(group.id);
    }
  }

  async function openSession(
    session: ManagedSession,
    destination: 'current-window' | 'new-window',
    restoreMenuFocus = false,
  ) {
    if (openingCommandRef.current || openingSessionId || openingGroupId) return;
    openingCommandRef.current = true;
    closeGroupMenu();
    closeSessionMenu();
    setOpeningSessionId(session.id);

    try {
      const result = await runCommand({
        type: 'bok/open-session',
        sessionId: session.id,
        destination,
      });
      const openedTabs = result && 'openedTabs' in result
        ? result.openedTabs
        : session.totalTabCount;
      const openedGroups = result && 'openedGroups' in result
        ? result.openedGroups
        : 0;
      const reusedSyncedGroup = Boolean(
        result && 'reusedSyncedGroup' in result && result.reusedSyncedGroup,
      );
      setActionNotice({
        type: 'success',
        message: reusedSyncedGroup
          ? '已切换到打开中的同步标签组，未创建重复标签。'
          : `已打开 ${openedTabs} 个标签${openedGroups > 0 ? `、${openedGroups} 个标签组` : ''}，保存记录仍保留。`,
        persistent: true,
      });
    } catch (error) {
      showCommandError('打开保存记录', error);
    } finally {
      openingCommandRef.current = false;
      setOpeningSessionId('');
      if (restoreMenuFocus) focusSessionMenuTrigger(session.id);
    }
  }

  function startEditingSession(session: ManagedSession) {
    closeSessionMenu();
    cancellingSessionTitleIds.current.delete(session.id);
    setEditingSessionId(session.id);
    setSessionTitleDraft(getSessionTitle(session));
  }

  async function saveSessionTitle(session: ManagedSession) {
    if (cancellingSessionTitleIds.current.delete(session.id)) return;
    if (savingSessionTitleIds.current.has(session.id)) return;
    savingSessionTitleIds.current.add(session.id);
    const title = sessionTitleDraft.trim();
    setEditingSessionId('');
    setSessionTitleDraft('');
    focusSessionTitleButton(session.id);

    if (title === getSessionTitle(session)) {
      savingSessionTitleIds.current.delete(session.id);
      return;
    }

    try {
      await runCommand({ type: 'bok/rename-session', sessionId: session.id, title });
      setActionNotice({ type: 'success', message: '保存记录名称已更新' });
    } catch (error) {
      showCommandError('重命名保存记录', error);
    } finally {
      savingSessionTitleIds.current.delete(session.id);
    }
  }

  function cancelSessionTitleEdit(sessionId: string) {
    cancellingSessionTitleIds.current.add(sessionId);
    setEditingSessionId('');
    setSessionTitleDraft('');
    focusSessionTitleButton(sessionId);
  }

  async function toggleSessionPinned(session: ManagedSession) {
    if (changingSessionId || session.archivedAt !== null) return;
    closeSessionMenu();
    setChangingSessionId(session.id);
    try {
      await runCommand({
        type: 'bok/set-session-pinned',
        sessionId: session.id,
        pinned: !session.pinned,
      });
      setActionNotice({
        type: 'success',
        message: session.pinned ? '已取消固定' : '已固定，将跳过自动归档',
      });
    } catch (error) {
      showCommandError('更新固定状态', error);
    } finally {
      setChangingSessionId('');
      focusSessionMenuTrigger(session.id);
    }
  }

  async function toggleSessionArchived(session: ManagedSession) {
    if (changingSessionId) return;
    const archiving = session.archivedAt === null;
    closeSessionMenu();
    setChangingSessionId(session.id);
    try {
      await runCommand({
        type: 'bok/set-session-archived',
        sessionId: session.id,
        archived: archiving,
      });
      setActionNotice({
        type: 'success',
        message: archiving
          ? session.pinned ? '已取消固定并归档' : '已归档'
          : '已恢复到当前视图',
      });
    } catch (error) {
      showCommandError(archiving ? '归档保存记录' : '恢复保存记录', error);
    } finally {
      setChangingSessionId('');
      focusSessionMenuTrigger(session.id);
    }
  }

  async function toggleSessionLocked(session: ManagedSession) {
    if (changingSessionId) return;
    closeSessionMenu();
    setChangingSessionId(session.id);
    try {
      await runCommand({
        type: 'bok/set-session-locked',
        sessionId: session.id,
        locked: !session.locked,
      });
      setActionNotice({
        type: 'success',
        message: session.locked
          ? '保存记录已解锁'
          : '保存记录已锁定，删除记录和独立标签已禁用',
      });
    } catch (error) {
      showCommandError(session.locked ? '解锁保存记录' : '锁定保存记录', error);
    } finally {
      setChangingSessionId('');
      focusSessionMenuTrigger(session.id);
    }
  }

  async function setSessionTaskStatus(
    session: ManagedSession,
    status: TaskStatus | null,
  ) {
    if (changingSessionId) return;
    closeSessionMenu();
    setChangingSessionId(session.id);
    try {
      await runCommand({
        type: 'bok/set-session-task-status',
        sessionId: session.id,
        status,
      });
      setActionNotice({
        type: 'success',
        message: status === null
          ? '已取消任务标记'
          : `已标记为 ${TASK_STATUS_LABELS[status]}`,
      });
    } catch (error) {
      showCommandError('更新任务状态', error);
    } finally {
      setChangingSessionId('');
      focusSessionMenuTrigger(session.id);
    }
  }

  async function deleteSession(session: ManagedSession) {
    closeSessionMenu();
    if (session.locked) {
      setActionNotice({ type: 'error', message: '保存记录已锁定，无法删除。' });
      focusSessionMenuTrigger(session.id);
      return;
    }
    if (hasLockedGroup(session)) {
      setActionNotice({
        type: 'error',
        message: '保存记录中有已锁定标签组，请先解锁后再删除。',
      });
      focusSessionMenuTrigger(session.id);
      return;
    }
    const title = getSessionTitle(session);
    if (
      !window.confirm(
        `永久删除保存记录“${title}”及其中 ${session.totalTabCount} 个标签？此操作无法恢复。`,
      )
    ) {
      focusSessionMenuTrigger(session.id);
      return;
    }

    setChangingSessionId(session.id);
    try {
      await runCommand({ type: 'bok/remove-session', sessionId: session.id });
      setActionNotice({ type: 'success', message: `已删除保存记录“${title}”` });
      requestAnimationFrame(() => document.getElementById('saved-groups')?.focus());
    } catch (error) {
      showCommandError('删除保存记录', error);
      focusSessionMenuTrigger(session.id);
    } finally {
      setChangingSessionId('');
    }
  }

  async function openGroup(
    group: ManagedGroup,
    options: OpenGroupOptions,
    restoreMenuFocus = false,
  ) {
    if (openingCommandRef.current || openingGroupId || openingSessionId) return;
    openingCommandRef.current = true;

    closeSessionMenu();
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
      const reusedSyncedGroup = Boolean(
        result && 'reusedSyncedGroup' in result && result.reusedSyncedGroup,
      );
      const convertedGroup =
        result && 'convertedGroup' in result ? result.convertedGroup : undefined;
      const conversionMessage = convertedGroup
        ? convertedGroup.renamed
          ? `名称重复，已重命名为“${convertedGroup.groupTitle}”并转换为标签组`
          : '已转换为标签组'
        : '';
      setActionNotice({
        type: 'success',
        message: convertedGroup
          ? reusedSyncedGroup
            ? `${conversionMessage}；已切换到打开中的同步标签组，未创建重复标签。`
            : `${conversionMessage}，并打开 ${openedTabs} 个标签；保存记录仍保留。`
          : reusedSyncedGroup
            ? '已切换到打开中的同步标签组，未创建重复标签。'
            : `已打开 ${openedTabs} 个标签，保存记录仍保留。`,
        persistent: true,
      });
    } catch (error) {
      showCommandError('打开分组', error);
    } finally {
      openingCommandRef.current = false;
      setOpeningGroupId('');
      if (restoreMenuFocus) focusMenuTrigger(group.id);
    }
  }

  function getContainerTabs(sessionId: string, groupId: string | null): SavedTab[] {
    const session = sessionsById.get(sessionId);
    if (!session) return [];
    if (groupId === null) {
      return session.items.flatMap((item) => item.type === 'tab' ? [item.tab] : []);
    }
    const group = session.items.find(
      (item): item is Extract<ManagedSessionItem, { type: 'group' }> =>
        item.type === 'group' && item.group.id === groupId,
    );
    return group?.group.tabs ?? [];
  }

  function isNoOpMove(
    source: DraggedTab,
    targetSessionId: string,
    targetGroupId: string | null,
    targetBeforeTabId: string | null,
  ): boolean {
    if (
      source.sourceSessionId !== targetSessionId ||
      source.sourceGroupId !== targetGroupId
    ) {
      return false;
    }

    const tabs = getContainerTabs(targetSessionId, targetGroupId);
    const sourceIndex = tabs.findIndex((tab) => tab.id === source.tab.id);
    if (sourceIndex < 0) return false;
    const remainingTabs = tabs.filter((tab) => tab.id !== source.tab.id);
    const targetIndex = targetBeforeTabId === null
      ? remainingTabs.length
      : remainingTabs.findIndex((tab) => tab.id === targetBeforeTabId);
    return targetIndex === sourceIndex;
  }

  function getTargetLabel(sessionId: string, groupId: string | null): string {
    const session = sessionsById.get(sessionId);
    if (!session) return '保存记录';
    if (groupId === null) return `保存记录“${getSessionTitle(session)}”`;
    const group = session.items.find(
      (item): item is Extract<ManagedSessionItem, { type: 'group' }> =>
        item.type === 'group' && item.group.id === groupId,
    );
    return group ? `标签组“${getGroupTitle(group.group)}”` : '标签组';
  }

  function createMoveTarget(
    source: DraggedTab,
    targetSessionId: string,
    targetGroupId: string | null,
    targetBeforeTabId: string | null,
    indicator: TabMoveTarget['indicator'],
  ): TabMoveTarget | null {
    const targetSession = sessionsById.get(targetSessionId);
    if (!targetSession || targetSession.archivedAt !== null) return null;
    if (targetGroupId !== null) {
      const targetGroup = targetSession.items.find(
        (item): item is Extract<ManagedSessionItem, { type: 'group' }> =>
          item.type === 'group' && item.group.id === targetGroupId,
      );
      if (!targetGroup || targetGroup.group.archivedAt !== null) return null;
    }
    if (isNoOpMove(source, targetSessionId, targetGroupId, targetBeforeTabId)) {
      return null;
    }

    const key = JSON.stringify([targetSessionId, targetGroupId, targetBeforeTabId]);
    const indicatorKey = indicator.type === 'row'
      ? `${key}:${indicator.tabId}:${indicator.edge}`
      : `${key}:${indicator.kind}:${indicator.id}`;
    return {
      indicatorKey,
      sessionId: targetSessionId,
      groupId: targetGroupId,
      targetBeforeTabId,
      label: getTargetLabel(targetSessionId, targetGroupId),
      indicator,
    };
  }

  function getAppendMoveTarget(
    source: DraggedTab,
    targetSessionId: string,
    targetGroupId: string | null,
    kind: 'session' | 'group',
    id: string,
  ): TabMoveTarget | null {
    return createMoveTarget(
      source,
      targetSessionId,
      targetGroupId,
      null,
      { type: 'container', kind, id },
    );
  }

  function getRowMoveTarget(
    event: ReactDragEvent<HTMLElement>,
    targetTab: SavedTab,
    targetSessionId: string,
    targetGroupId: string | null,
  ): TabMoveTarget | null {
    if (!draggedTab || draggedTab.tab.id === targetTab.id) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
    const destinationTabs = getContainerTabs(targetSessionId, targetGroupId).filter(
      (tab) => tab.id !== draggedTab.tab.id,
    );
    const hoveredIndex = destinationTabs.findIndex((tab) => tab.id === targetTab.id);
    if (hoveredIndex < 0) return null;
    const targetBeforeTabId = edge === 'before'
      ? targetTab.id
      : destinationTabs[hoveredIndex + 1]?.id ?? null;
    return createMoveTarget(
      draggedTab,
      targetSessionId,
      targetGroupId,
      targetBeforeTabId,
      { type: 'row', tabId: targetTab.id, edge },
    );
  }

  async function moveSavedTab(source: DraggedTab, target: TabMoveTarget) {
    if (
      movingTabId ||
      isNoOpMove(
        source,
        target.sessionId,
        target.groupId,
        target.targetBeforeTabId,
      )
    ) {
      return;
    }

    setMovingTabId(source.tab.id);
    setDraggedTab(null);
    setDropTarget(null);
    try {
      await runCommand({
        type: 'bok/move-tab',
        sessionId: source.sourceSessionId,
        tabId: source.tab.id,
        targetSessionId: target.sessionId,
        targetGroupId: target.groupId,
        targetBeforeTabId: target.targetBeforeTabId,
      });
      setActionNotice({
        type: 'success',
        message: `已将“${source.tab.title}”移到${target.label}`,
      });
    } catch (error) {
      showCommandError('移动标签', error);
    } finally {
      setMovingTabId('');
    }
  }

  function startTabDrag(
    event: ReactDragEvent<HTMLElement>,
    source: DraggedTab,
  ) {
    if (movingTabId) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', source.tab.id);
    const preview = document.createElement('div');
    preview.className = 'tab-drag-preview';
    preview.setAttribute('aria-hidden', 'true');

    const favicon = document.createElement('span');
    favicon.className = 'tab-drag-preview__favicon';
    favicon.textContent = getFaviconFallback(source.tab.url);

    const copy = document.createElement('span');
    copy.className = 'tab-drag-preview__copy';
    const title = document.createElement('strong');
    title.textContent = source.tab.title;
    const url = document.createElement('span');
    url.textContent = getDisplayUrl(source.tab.url);
    copy.append(title, url);
    preview.append(favicon, copy);
    document.body.append(preview);
    event.dataTransfer.setDragImage(preview, 22, preview.offsetHeight / 2);
    window.setTimeout(() => preview.remove(), 0);

    setDraggedTab(source);
    setDropTarget(null);
  }

  function finishTabDrag() {
    setDraggedTab(null);
    setDropTarget(null);
  }

  function allowTabDrop(
    event: ReactDragEvent<HTMLElement>,
    target: TabMoveTarget,
  ) {
    if (!draggedTab || movingTabId) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget((current) =>
      current?.indicatorKey === target.indicatorKey ? current : target,
    );
  }

  function leaveTabDropTarget(
    event: ReactDragEvent<HTMLElement>,
    targetIndicatorKey: string,
  ) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setDropTarget((current) =>
      current?.indicatorKey === targetIndicatorKey ? null : current,
    );
  }

  function dropTab(
    event: ReactDragEvent<HTMLElement>,
    target: TabMoveTarget,
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (!draggedTab) return;
    void moveSavedTab(draggedTab, target);
  }

  function renderTabRow(
    tab: SavedTab,
    location: {
      sessionId: string;
      groupId: string;
      sourceGroupId: string | null;
      locked: boolean;
      canMove: boolean;
      lockOwner?: '组' | '保存记录';
      directItem?: Extract<ManagedSessionItem, { type: 'tab' }>;
    },
  ) {
    const Row = location.directItem ? 'div' : 'li';
    const lockOwner = location.lockOwner ?? '组';
    const canMove = location.canMove && movingTabId !== tab.id;
    const source = {
      tab,
      sourceSessionId: location.sessionId,
      sourceGroupId: location.sourceGroupId,
    };
    const rowDropIndicator =
      dropTarget?.indicator.type === 'row' && dropTarget.indicator.tabId === tab.id
        ? dropTarget.indicator.edge
        : undefined;
    return (
      <Row
        key={tab.id}
        className={`tab-row${tab.taskStatus ? ' tab-row--task' : ''}${
          draggedTab?.tab.id === tab.id ? ' tab-row--dragging' : ''
        }`}
        data-tab-id={tab.id}
        data-drop-position={rowDropIndicator}
        data-task-status={tab.taskStatus ?? undefined}
        aria-busy={movingTabId === tab.id || undefined}
        onDragEnter={(event) => {
          const target = getRowMoveTarget(
            event,
            tab,
            location.sessionId,
            location.sourceGroupId,
          );
          if (target) allowTabDrop(event, target);
        }}
        onDragOver={(event) => {
          const target = getRowMoveTarget(
            event,
            tab,
            location.sessionId,
            location.sourceGroupId,
          );
          if (target) allowTabDrop(event, target);
          else if (
            dropTarget?.indicator.type === 'row' &&
            dropTarget.indicator.tabId === tab.id
          ) {
            setDropTarget(null);
          }
        }}
        onDragLeave={(event) => {
          if (
            dropTarget?.indicator.type === 'row' &&
            dropTarget.indicator.tabId === tab.id
          ) {
            leaveTabDropTarget(event, dropTarget.indicatorKey);
          }
        }}
        onDrop={(event) => {
          const target = getRowMoveTarget(
            event,
            tab,
            location.sessionId,
            location.sourceGroupId,
          );
          if (target) dropTab(event, target);
        }}
      >
        <a
          className="tab-row__link"
          href={tab.url}
          target="_blank"
          rel="noreferrer"
          draggable={canMove}
          aria-label={`在新标签页打开链接：${tab.title}`}
          onDragStart={(event) => startTabDrag(event, source)}
          onDragEnd={finishTabDrag}
          onClick={(event) => openChromeUrl(event, tab.url)}
        />
        <Favicon tab={tab} />
        <span className="tab-actions">
          <button
            type="button"
            className="tab-action tab-action--delete"
            aria-label={
              location.locked
                ? `${lockOwner}已锁定，先解锁后才能删除：${tab.title}`
                : `删除：${tab.title}`
            }
            disabled={location.locked}
            title={location.locked ? `${lockOwner}已锁定，先解锁后才能删除标签` : '删除'}
            onClick={(event) =>
              location.directItem
                ? void deleteDirectTab(location.directItem)
                : void deleteTab(location.groupId, tab.id, event.currentTarget)
            }
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4.5 6h11M8 3.5h4M6.5 6l.6 10h5.8l.6-10M8.5 9v4M11.5 9v4" />
            </svg>
          </button>
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
              onClick={() =>
                void setTabTaskStatus(
                  location.sessionId,
                  location.groupId,
                  tab,
                  'doing',
                )
              }
            >
              <TaskIcon status="doing" />
            </button>
          )}
        </span>
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
                    location.sessionId,
                    location.groupId,
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
      </Row>
    );
  }

  function renderSessionHeader(
    session: ManagedSession,
    collapsed: boolean,
    createdAt: string,
  ) {
    const title = getSessionTitle(session);
    const changing = changingSessionId === session.id;
    const opening = openingSessionId === session.id;
    const archived = session.archivedAt !== null;
    const lockedGroup = hasLockedGroup(session);
    const deleteBlocked = session.locked || lockedGroup;
    const deleteBlockedMessage = session.locked
      ? '保存记录已锁定，无法删除'
      : '保存记录中有已锁定标签组，请先解锁后再删除';
    const appendTarget = draggedTab
      ? getAppendMoveTarget(draggedTab, session.id, null, 'session', session.id)
      : null;
    const dropActive = Boolean(
      dropTarget?.indicator.type === 'container' &&
      dropTarget.indicator.kind === 'session' &&
      dropTarget.indicator.id === session.id,
    );

    return (
      <header
        className="saved-session__header"
        data-drop-active={dropActive || undefined}
        onDragEnter={(event) => {
          if (appendTarget) allowTabDrop(event, appendTarget);
        }}
        onDragOver={(event) => {
          if (appendTarget) allowTabDrop(event, appendTarget);
        }}
        onDragLeave={(event) => {
          if (appendTarget) leaveTabDropTarget(event, appendTarget.indicatorKey);
        }}
        onDrop={(event) => {
          if (appendTarget) dropTab(event, appendTarget);
        }}
      >
        <div className="saved-session__summary">
          <h2 id={`session-title-${session.id}`}>
            {editingSessionId === session.id ? (
              <input
                className="session-title__input"
                value={sessionTitleDraft}
                aria-label={`编辑 ${title} 的名称`}
                autoFocus
                onChange={(event) => setSessionTitleDraft(event.target.value)}
                onBlur={() => void saveSessionTitle(session)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveSessionTitle(session);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelSessionTitleEdit(session.id);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="session-title__button"
                aria-describedby={`session-title-hint-${session.id}`}
                title="点击编辑名称"
                ref={(element) => {
                  if (element) sessionTitleButtonRefs.current.set(session.id, element);
                  else sessionTitleButtonRefs.current.delete(session.id);
                }}
                onClick={() => startEditingSession(session)}
              >
                {title}
              </button>
            )}
          </h2>
          {editingSessionId !== session.id && (
            <span id={`session-title-hint-${session.id}`} className="sr-only">
              点击重命名保存记录
            </span>
          )}
          <div className="saved-session__meta">
            <time dateTime={new Date(session.createdAt).toISOString()}>{createdAt}</time>
            {session.title.trim() && <span>{session.totalTabCount} 个标签</span>}
            {session.pinned && <span>已固定</span>}
            {archived && <span>已归档</span>}
            {session.locked && <span>已锁定</span>}
            {session.taskStatus && <TaskBadge status={session.taskStatus} />}
          </div>
        </div>

        <div className="saved-session__actions">
          <button
            type="button"
            className="group-open-button session-open-button"
            disabled={Boolean(openingSessionId) || Boolean(openingGroupId) || changing}
            onClick={() => void openSession(session, 'current-window')}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5 4.5h10v11H5zM8 8h4M10 6v4" />
            </svg>
            <span>{opening ? '打开中…' : '打开全部'}</span>
          </button>

          <div className="group-more session-more" data-session-id={session.id}>
            <button
              type="button"
              className="group-more__trigger"
              aria-label={`更多操作：${title}`}
              aria-haspopup="menu"
              aria-expanded={openMenuSessionId === session.id}
              disabled={Boolean(openingSessionId) || Boolean(openingGroupId) || changing}
              ref={(element) => {
                if (element) sessionMenuTriggerRefs.current.set(session.id, element);
                else sessionMenuTriggerRefs.current.delete(session.id);
              }}
              onClick={() => {
                if (openMenuSessionId === session.id) closeSessionMenu();
                else openSessionMenu(session.id);
              }}
              onKeyDown={(event) => handleSessionMenuTriggerKeyDown(event, session.id)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="5" cy="10" r="1" />
                <circle cx="10" cy="10" r="1" />
                <circle cx="15" cy="10" r="1" />
              </svg>
            </button>

            {openMenuSessionId === session.id && (
              <div
                className="group-menu session-menu"
                role="menu"
                aria-label={`${title} 的更多操作`}
                onKeyDown={(event) => handleSessionMenuKeyDown(event, session.id)}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={Boolean(openingGroupId)}
                  ref={(element) => setSessionMenuItemRef(session.id, 0, element)}
                  onClick={() => void openSession(session, 'new-window', true)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <rect x="3.5" y="5" width="5" height="10" rx="1" />
                    <rect x="11.5" y="5" width="5" height="10" rx="1" />
                  </svg>
                  在新窗口打开
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={archived}
                  title={archived ? '归档中的保存记录不能固定' : undefined}
                  ref={(element) => setSessionMenuItemRef(session.id, 1, element)}
                  onClick={() => void toggleSessionPinned(session)}
                >
                  <PinIcon />
                  {session.pinned ? '取消固定' : '固定保存记录'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  ref={(element) => setSessionMenuItemRef(session.id, 2, element)}
                  onClick={() => void toggleSessionArchived(session)}
                >
                  <ArchiveIcon restore={archived} />
                  {archived ? '恢复到当前视图' : '归档保存记录'}
                </button>
                <div className="group-menu__separator" role="separator" />
                {(['todo', 'doing', 'done'] as const).map((status, index) => (
                  <button
                    key={status}
                    type="button"
                    role="menuitemradio"
                    aria-checked={session.taskStatus === status}
                    ref={(element) => setSessionMenuItemRef(session.id, 3 + index, element)}
                    onClick={() => void setSessionTaskStatus(session, status)}
                  >
                    <TaskIcon status={status} />
                    标记为 {TASK_STATUS_LABELS[status]}
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  disabled={session.taskStatus === null}
                  ref={(element) => setSessionMenuItemRef(session.id, 6, element)}
                  onClick={() => void setSessionTaskStatus(session, null)}
                >
                  <TaskOffIcon />
                  取消任务标记
                </button>
                <div className="group-menu__separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  ref={(element) => setSessionMenuItemRef(session.id, 7, element)}
                  onClick={() => void toggleSessionLocked(session)}
                >
                  <LockIcon open={session.locked} />
                  {session.locked ? '解锁保存记录' : '锁定保存记录'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="group-menu__danger"
                  disabled={deleteBlocked}
                  title={deleteBlocked ? deleteBlockedMessage : undefined}
                  ref={(element) => setSessionMenuItemRef(session.id, 8, element)}
                  onClick={() => void deleteSession(session)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M4.5 6h11M8 3.5h4M6.5 6l.6 10h5.8l.6-10M8.5 9v4M11.5 9v4" />
                  </svg>
                  {deleteBlocked ? '删除（有锁定内容，先解锁）' : '删除保存记录'}
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className="collapse-button session-collapse-button"
            aria-expanded={!collapsed}
            aria-controls={`session-items-${session.id}`}
            disabled={filtersActive}
            title={filtersActive ? '筛选期间保持展开' : undefined}
            onClick={() => toggleSession(session.id)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6.5 8 3.5 3.5L13.5 8" />
            </svg>
            <span className="sr-only">{collapsed ? '展开' : '收起'} {title}</span>
          </button>
        </div>
      </header>
    );
  }

  return (
    <div className="bok-page">
      <a className="skip-link" href="#saved-groups">
        跳到标签列表
      </a>

      <AppHeader
        activeSection="saved"
        search={{
          label: '搜索标签',
          placeholder: '搜索标题或 URL',
          value: searchValue,
          onChange: (event) => setSearchValue(event.target.value),
        }}
        theme={activeTheme}
        onToggleTheme={toggleTheme}
      />

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
                            aria-label={`Doing 中：${doingCount.sessions} 个保存记录，${doingCount.groups} 个分组，${doingCount.tabs} 个标签`}
                          >
                            {doingCount.sessions} 记录 · {doingCount.groups} 组 · {doingCount.tabs} 标签
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="sidebar__section sidebar__section--sessions">
              <h2>保存记录</h2>
              {visibleSessions.length > 0 && (
                <label className="group-select">
                  <span className="sr-only">跳转到保存记录</span>
                  <select
                    value={activeSessionId}
                    onChange={(event) => goToSession(event.target.value)}
                  >
                    {visibleSessions.map((session, index) => {
                      const fullSession = sessionsById.get(session.id) ?? session;
                      return (
                        <option key={session.id} value={session.id}>
                          {index + 1}. {getSessionNavigationTitle(fullSession)}
                        </option>
                      );
                    })}
                  </select>
                </label>
              )}
              <ol className="group-nav session-nav">
                {visibleSessions.map((session, index) => {
                  const fullSession = sessionsById.get(session.id) ?? session;
                  return (
                    <li key={session.id}>
                      <button
                        type="button"
                        aria-current={activeSessionId === session.id ? 'location' : undefined}
                        title={`${getSessionNavigationTitle(fullSession)}，共 ${fullSession.totalTabCount} 个标签，保存于 ${formatGroupCreatedAt(fullSession.createdAt)}`}
                        onClick={() => goToSession(session.id)}
                      >
                        <span className="group-nav__index">{index + 1}</span>
                        <span className="group-nav__title">
                          {getSessionNavigationTitle(fullSession)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          </nav>
        </aside>

        <main id="saved-groups" className="content" tabIndex={-1}>
          <header className="content__header">
            <div>
              <h1>{getContentTitle(archiveView, taskFilter)}</h1>
            </div>
            <span>{visibleSessions.length} 个记录 · {visibleTabCount} 个标签</span>
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
          ) : sessions.length === 0 ? (
            <section className="empty-state">
              <h2>还没有保存记录</h2>
              <p>点击 Bok 插件图标保存并关闭当前窗口的全部标签后，它们会显示在这里。</p>
            </section>
          ) : viewSessions.length === 0 ? (
            <section className="empty-state">
              <h2>{archiveView === 'archived' ? '还没有归档记录' : '当前视图为空'}</h2>
              <p>
                {archiveView === 'archived'
                  ? '归档内容会保留在原保存记录中，可以在这里打开或恢复。'
                  : '所有内容都已归档，可以切换到归档视图查看。'}
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
          ) : visibleSessions.length === 0 ? (
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
            <div className="session-list">
              {visibleSessions.map((session) => {
                const fullSession = sessionsById.get(session.id) ?? session;
                const mergedBrowserGroup = getMergedBrowserGroup(fullSession);
                const mergedGroupId = mergedBrowserGroup?.id ?? '';
                const sessionCollapsed =
                  !filtersActive && collapsedSessionIds.has(session.id);
                const sessionCreatedAt = formatGroupCreatedAt(fullSession.createdAt);

                return (
                  <section
                    key={session.id}
                    id={`session-${session.id}`}
                    className={`saved-session${
                      mergedGroupId ? ' saved-session--merged' : ''
                    }${
                      fullSession.taskStatus ? ' saved-session--task' : ''
                    }${
                      fullSession.archivedAt !== null ? ' saved-session--archived' : ''
                    }`}
                    data-collapsed={sessionCollapsed || undefined}
                    data-task-status={fullSession.taskStatus ?? undefined}
                    aria-labelledby={
                      mergedGroupId
                        ? `group-title-${mergedGroupId}`
                        : `session-title-${session.id}`
                    }
                  >
                    {!mergedGroupId &&
                      renderSessionHeader(fullSession, sessionCollapsed, sessionCreatedAt)}
                    {(Boolean(mergedGroupId) || !sessionCollapsed) && (
                      <div
                        id={mergedGroupId ? undefined : `session-items-${session.id}`}
                        className={`saved-session__items${
                          mergedGroupId ? ' saved-session__items--merged' : ''
                        }`}
                      >
              {session.items.map((item) => {
                if (item.type === 'tab') {
                  return (
                    <div
                      key={`tab:${item.tab.id}`}
                      className={`session-item session-direct-tab${
                        fullSession.archivedAt !== null || item.tab.archivedAt !== null
                          ? ' session-direct-tab--archived'
                          : ''
                      }`}
                    >
                      {renderTabRow(item.tab, {
                        sessionId: item.sessionId,
                        groupId: item.groupId,
                        sourceGroupId: null,
                        locked: fullSession.locked,
                        canMove:
                          archiveView === 'current' &&
                          fullSession.archivedAt === null &&
                          item.tab.archivedAt === null &&
                          !fullSession.locked,
                        lockOwner: '保存记录',
                        directItem: item,
                      })}
                    </div>
                  );
                }
                const group = item.group;
                const originalGroup = fullSession.items.find(
                  (candidate): candidate is Extract<ManagedSessionItem, { type: 'group' }> =>
                    candidate.type === 'group' && candidate.group.id === group.id,
                )?.group;
                const isMergedGroup = group.id === mergedGroupId;
                const collapsed = isMergedGroup
                  ? sessionCollapsed
                  : !filtersActive && collapsedGroupIds.has(group.id);
                const GroupHeading = isMergedGroup ? 'h2' : 'h3';
                const title = getGroupTitle(group);
                const isTaskGroup = group.taskStatus !== null;
                const pinMenuIndex = 2;
                const archiveMenuIndex = 3;
                const taskMenuStartIndex = 4;
                const taskOffMenuIndex = 7;
                const deduplicateMenuIndex = 8;
                const lockMenuIndex = 9;
                const deleteMenuIndex = 10;
                const defaultOpenOptions: OpenGroupOptions = {
                  mode: 'tab-group',
                  destination: 'current-window',
                };
                const defaultOpenTitle = '以浏览器标签组形式打开全部标签';
                const groupChanging = changingGroupId === group.id;
                const groupAppendTarget = draggedTab
                  ? getAppendMoveTarget(
                      draggedTab,
                      group.sessionId,
                      group.id,
                      'group',
                      group.id,
                    )
                  : null;
                const sessionAppendTarget = isMergedGroup && draggedTab
                  ? getAppendMoveTarget(
                      draggedTab,
                      fullSession.id,
                      null,
                      'session',
                      fullSession.id,
                    )
                  : null;
                const groupDropActive = Boolean(
                  dropTarget?.indicator.type === 'container' &&
                  dropTarget.indicator.kind === 'group' &&
                  dropTarget.indicator.id === group.id,
                );
                const sessionDirectDropActive = Boolean(
                  isMergedGroup &&
                  dropTarget?.indicator.type === 'container' &&
                  dropTarget.indicator.kind === 'session' &&
                  dropTarget.indicator.id === fullSession.id,
                );
                const displayedCreatedAt = isMergedGroup
                  ? fullSession.createdAt
                  : group.createdAt;
                const displayedTabCount = originalGroup?.tabs.length ?? group.tabs.length;
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
                    className={`session-item tab-group${
                      isMergedGroup ? ' tab-group--merged' : ''
                    } tab-group--browser${
                      isTaskGroup ? ' tab-group--task' : ''
                    }${
                      fullSession.archivedAt !== null || group.archivedAt !== null
                        ? ' tab-group--archived'
                        : ''
                    }`}
                    data-task-status={group.taskStatus ?? undefined}
                    data-group-color={group.color ?? 'grey'}
                    aria-labelledby={`group-title-${group.id}`}
                  >
                    <header
                      className="tab-group__header"
                      data-drop-active={groupDropActive || undefined}
                      onDragEnter={(event) => {
                        if (groupAppendTarget) allowTabDrop(event, groupAppendTarget);
                      }}
                      onDragOver={(event) => {
                        if (groupAppendTarget) allowTabDrop(event, groupAppendTarget);
                      }}
                      onDragLeave={(event) => {
                        if (groupAppendTarget) {
                          leaveTabDropTarget(event, groupAppendTarget.indicatorKey);
                        }
                      }}
                      onDrop={(event) => {
                        if (groupAppendTarget) dropTab(event, groupAppendTarget);
                      }}
                    >
                      <span
                        className="tab-group__kind"
                        role="img"
                        aria-label="浏览器标签组"
                        title="浏览器标签组"
                      >
                        <BrowserGroupIcon />
                      </span>
                      <div className="tab-group__title">
                        <GroupHeading id={`group-title-${group.id}`}>
                          {editingGroupId === group.id ? (
                            <input
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
                          )}
                        </GroupHeading>
                        {editingGroupId !== group.id && (
                          <span id={`group-title-hint-${group.id}`} className="sr-only">
                            点击重命名分组
                          </span>
                        )}
                        <time
                          className="group-created-at"
                          dateTime={new Date(displayedCreatedAt).toISOString()}
                          title={`创建于 ${formatGroupCreatedAt(displayedCreatedAt)}`}
                        >
                          {formatGroupCreatedAt(displayedCreatedAt)}
                        </time>
                        {group.title.trim() && <span>{displayedTabCount} 个标签</span>}
                        {group.locked && <span>已锁定</span>}
                        {group.taskStatus && <TaskBadge status={group.taskStatus} />}
                      </div>

                      {sessionAppendTarget && (
                        <span
                          className="session-direct-drop-target"
                          data-drop-active={sessionDirectDropActive || undefined}
                          onDragEnter={(event) => allowTabDrop(event, sessionAppendTarget)}
                          onDragOver={(event) => allowTabDrop(event, sessionAppendTarget)}
                          onDragLeave={(event) =>
                            leaveTabDropTarget(event, sessionAppendTarget.indicatorKey)
                          }
                          onDrop={(event) => dropTab(event, sessionAppendTarget)}
                        >
                          移到保存记录
                        </span>
                      )}

                      <div className="tab-group__actions">
                        <button
                          type="button"
                          className="group-open-button"
                          disabled={
                            Boolean(openingGroupId) ||
                            Boolean(openingSessionId) ||
                            groupChanging
                          }
                          title={defaultOpenTitle}
                          onClick={() => void openGroup(group, defaultOpenOptions)}
                        >
                          <BrowserGroupIcon />
                          <span>{openingGroupId === group.id ? '打开中…' : '打开全部'}</span>
                        </button>

                        <div className="group-more" data-group-id={group.id}>
                          <button
                            type="button"
                            className="group-more__trigger"
                            aria-label={`更多操作：${title}`}
                            aria-haspopup="menu"
                            aria-expanded={openMenuGroupId === group.id}
                            disabled={
                              Boolean(openingGroupId) ||
                              Boolean(openingSessionId) ||
                              groupChanging
                            }
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
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) => setMenuItemRef(group.id, 0, element)}
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
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) => setMenuItemRef(group.id, 1, element)}
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
                              {group.archivedAt === null && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  ref={(element) =>
                                    setMenuItemRef(group.id, pinMenuIndex, element)
                                  }
                                  onClick={() => void togglePinned(group)}
                                >
                                  <PinIcon />
                                  {group.pinned ? '取消固定' : '固定分组'}
                                </button>
                              )}
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) =>
                                  setMenuItemRef(group.id, archiveMenuIndex, element)
                                }
                                onClick={() => void toggleArchived(group)}
                              >
                                <ArchiveIcon restore={group.archivedAt !== null} />
                                {archiveActionLabel}
                              </button>
                              <div className="group-menu__separator" role="separator" />
                              {group.taskStatus === null ? (
                                <button
                                  type="button"
                                  role="menuitem"
                                  ref={(element) =>
                                    setMenuItemRef(group.id, taskMenuStartIndex, element)
                                  }
                                  onClick={() => void setGroupTaskStatus(group, 'doing')}
                                >
                                  <TaskIcon status="doing" />
                                  标记为 Doing
                                </button>
                              ) : (
                                <>
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
                                      setMenuItemRef(group.id, taskOffMenuIndex, element)
                                    }
                                    onClick={() => void setGroupTaskStatus(group, null)}
                                  >
                                    <TaskOffIcon />
                                    取消任务标记
                                  </button>
                                </>
                              )}
                              <div className="group-menu__separator" role="separator" />
                              <button
                                type="button"
                                role="menuitem"
                                ref={(element) =>
                                  setMenuItemRef(group.id, deduplicateMenuIndex, element)
                                }
                                disabled={group.locked}
                                title={group.locked ? '分组已锁定，无法去重' : '按完整 URL 去重'}
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
                                {group.locked ? '解锁分组' : '锁定分组'}
                              </button>
                              <div className="group-menu__separator" role="separator" />
                              <button
                                type="button"
                                role="menuitem"
                                className="group-menu__danger"
                                ref={(element) =>
                                  setMenuItemRef(group.id, deleteMenuIndex, element)
                                }
                                disabled={group.locked}
                                title={group.locked ? '分组已锁定，无法删除' : undefined}
                                onClick={() => void deleteGroup(group)}
                              >
                                <svg viewBox="0 0 20 20" aria-hidden="true">
                                  <path d="M4.5 6h11M8 3.5h4M6.5 6l.6 10h5.8l.6-10M8.5 9v4M11.5 9v4" />
                                </svg>
                                {group.locked ? '删除分组（已锁定）' : '删除分组'}
                              </button>
                            </div>
                          )}
                        </div>

                        <button
                          type="button"
                          className="collapse-button"
                          aria-expanded={!collapsed}
                          aria-controls={`group-tabs-${group.id}`}
                          disabled={filtersActive}
                          title={filtersActive ? '筛选期间保持展开' : undefined}
                          onClick={() =>
                            isMergedGroup
                              ? toggleSession(session.id)
                              : toggleGroup(group.id)
                          }
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
                        {group.tabs.map((tab) =>
                          renderTabRow(tab, {
                            sessionId: group.sessionId,
                            groupId: group.id,
                            sourceGroupId: group.id,
                            locked: group.locked,
                            canMove:
                              archiveView === 'current' &&
                              fullSession.archivedAt === null &&
                              group.archivedAt === null &&
                              !fullSession.locked &&
                              !group.locked,
                          }),
                        )}
                      </ol>
                    )}
                  </section>
                );
              })}
                      </div>
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
