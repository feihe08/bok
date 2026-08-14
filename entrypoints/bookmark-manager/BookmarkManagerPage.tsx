import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { browser } from 'wxt/browser';
import {
  moveBookmarkNode,
  readBookmarksBar,
  restoreLastBookmarkOperation,
} from '../../libs/bookmarks/api';
import {
  archiveBookmarkFolder,
  inspectLegacyBookmarkArchive,
  migrateLegacyBookmarkArchive,
  reconcileBookmarkArchiveStore,
  restoreArchivedBookmarkFolder,
  type LegacyArchiveMigrationInfo,
} from '../../libs/bookmarks/archive';
import { emptyBookmarkArchiveStore } from '../../libs/bookmarks/archive-storage';
import type {
  BookmarkArchiveRecord,
  BookmarkArchiveStore,
  BookmarkNode,
} from '../../libs/bookmarks/model';
import { ActionMenu, type ActionMenuEntry } from '../shared/ActionMenu';
import { ArchiveView } from './ArchiveView';

type Theme = 'light' | 'dark';
type Notice = {
  type: 'success' | 'error';
  message: string;
  canUndo?: boolean;
};
type MoveDialogState = {
  nodeId: string;
  targetId: string;
};
type RestoreDialogState = { archiveId: string; targetId: string };
type BookmarkView = 'current' | 'archived';

interface FolderEntry {
  node: BookmarkNode;
  path: string;
}

interface BookmarkIndex {
  nodeById: Map<string, BookmarkNode>;
  pathById: Map<string, string>;
  searchTextById: Map<string, string>;
  folders: FolderEntry[];
}

type BookmarkEventsApi = typeof browser.bookmarks & {
  onChildrenReordered?: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
  onImportBegan?: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
  onImportEnded?: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
};

const THEME_STORAGE_KEY = 'bok-theme';
const BOOKMARK_DRAG_TYPE = 'application/x-bok-bookmark-node';
const FORMAT_CHARACTERS = /\p{Cf}/gu;

function getStoredTheme(): Theme | null {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === 'light' || value === 'dark' ? value : null;
}

function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

const storedTheme = getStoredTheme();
if (storedTheme) document.documentElement.dataset.theme = storedTheme;

function cleanTitle(value: string): string {
  return value.normalize('NFKC').replace(FORMAT_CHARACTERS, '').trim();
}

function getNodeTitle(node: BookmarkNode): string {
  return cleanTitle(node.title) || (node.url == null ? '未命名文件夹' : node.url);
}

function getArchivedFolderTitle(record: BookmarkArchiveRecord): string {
  return cleanTitle(record.root.title) || '未命名文件夹';
}

function normalizeSearchText(value: string): string {
  return cleanTitle(value).toLowerCase();
}

function getDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = url.pathname === '/' ? '' : url.pathname;
    return `${hostname}${pathname}` || value;
  } catch {
    return value;
  }
}

function getHostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function getFaviconUrl(pageUrl: string): string | null {
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const favicon = new URL(
      '/_favicon/',
      browser.runtime.getURL('/bookmark-manager.html'),
    );
    favicon.searchParams.set('pageUrl', pageUrl);
    favicon.searchParams.set('size', '32');
    return favicon.toString();
  } catch {
    return null;
  }
}

function getFaviconFallback(value: string): string {
  return getHostname(value).charAt(0).toUpperCase() || '•';
}

function formatLastUsed(timestamp: number | undefined): string {
  if (timestamp == null) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function buildBookmarkIndex(root: BookmarkNode): BookmarkIndex {
  const nodeById = new Map<string, BookmarkNode>();
  const pathById = new Map<string, string>();
  const searchTextById = new Map<string, string>();
  const folders: FolderEntry[] = [];

  function walk(node: BookmarkNode, parentPath: string): void {
    const title = getNodeTitle(node);
    const path = parentPath ? `${parentPath} / ${title}` : title;
    nodeById.set(node.id, node);
    pathById.set(node.id, path);
    searchTextById.set(
      node.id,
      normalizeSearchText([path, node.url ?? '', getHostname(node.url ?? '')].join('\n')),
    );

    if (node.url != null) {
      return;
    }

    folders.push({ node, path });
    for (const child of node.children ?? []) {
      walk(child, path);
    }
  }

  walk(root, '');
  return {
    nodeById,
    pathById,
    searchTextById,
    folders,
  };
}

function filterBookmarkTree(
  root: BookmarkNode,
  index: BookmarkIndex,
  query: string,
): BookmarkNode | null {
  const terms = query.split(/\s+/).filter(Boolean);

  function filterNode(node: BookmarkNode): BookmarkNode | null {
    const searchText = index.searchTextById.get(node.id) ?? '';
    const matches = terms.every((term) => searchText.includes(term));
    if (node.url != null) return matches ? node : null;

    const children = (node.children ?? [])
      .map(filterNode)
      .filter((child): child is BookmarkNode => child !== null);
    if (!matches && children.length === 0) return null;
    return { ...node, children };
  }

  return filterNode(root);
}

function omitNode(root: BookmarkNode, nodeId?: string): BookmarkNode {
  if (!nodeId || root.children == null) return root;
  return {
    ...root,
    children: root.children
      .filter((child) => child.id !== nodeId)
      .map((child) => omitNode(child, nodeId)),
  };
}

function getFolderCounts(node: BookmarkNode): {
  folders: number;
  bookmarks: number;
} {
  let folders = 0;
  let bookmarks = 0;
  for (const child of node.children ?? []) {
    if (child.url == null) {
      folders += 1;
      const nested = getFolderCounts(child);
      folders += nested.folders;
      bookmarks += nested.bookmarks;
    } else {
      bookmarks += 1;
    }
  }
  return { folders, bookmarks };
}

function collectFolderIds(node: BookmarkNode, result = new Set<string>()): Set<string> {
  if (node.url != null) return result;
  result.add(node.id);
  for (const child of node.children ?? []) {
    collectFolderIds(child, result);
  }
  return result;
}

function findFolderByPath(root: BookmarkNode, path: string[]): BookmarkNode | null {
  let current = root;
  for (const title of path) {
    const next = (current.children ?? []).find(
      (child) => child.url == null && child.title === title,
    );
    if (!next) return null;
    current = next;
  }
  return current;
}

function isNodeManaged(node: BookmarkNode, index: BookmarkIndex): boolean {
  let current: BookmarkNode | undefined = node;
  while (current) {
    if (current.unmodifiable) return true;
    current = current.parentId ? index.nodeById.get(current.parentId) : undefined;
  }
  return false;
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.8 5.5h5l1.5 1.8h7.9v7.2H2.8z" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6 3.5h8v13l-4-2.5-4 2.5z" />
    </svg>
  );
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return dark ? (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="3.25" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
    </svg>
  ) : (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M16.5 12.2A6.6 6.6 0 0 1 7.8 3.5a6.6 6.6 0 1 0 8.7 8.7Z" />
    </svg>
  );
}

function Favicon({ node }: { node: BookmarkNode }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = node.url ? getFaviconUrl(node.url) : null;
  if (!faviconUrl || failed) {
    return (
      <span className="bookmark-favicon bookmark-favicon--fallback" aria-hidden="true">
        {getFaviconFallback(node.url ?? '')}
      </span>
    );
  }
  return (
    <img
      className="bookmark-favicon"
      src={faviconUrl}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function Modal({
  title,
  className = '',
  onClose,
  children,
}: {
  title: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useMemo(() => `dialog-${crypto.randomUUID()}`, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    const focusFrame = requestAnimationFrame(() => {
      dialog
        ?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
        ?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      dialog?.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`bookmark-dialog ${className}`.trim()}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bookmark-dialog__surface">
        <header className="bookmark-dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

function LoadingState() {
  return (
    <div className="bookmark-skeleton" aria-label="正在读取书签" role="status">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className="bookmark-skeleton__row">
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}

export default function BookmarkManagerPage() {
  const [permission, setPermission] = useState<boolean | null>(null);
  const [root, setRoot] = useState<BookmarkNode | null>(null);
  const [archiveStore, setArchiveStore] = useState<BookmarkArchiveStore>(
    emptyBookmarkArchiveStore,
  );
  const [legacyMigration, setLegacyMigration] =
    useState<LegacyArchiveMigrationInfo | null>(null);
  const [bookmarkView, setBookmarkView] = useState<BookmarkView>('current');
  const [selectedId, setSelectedId] = useState('');
  const [searchValue, setSearchValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);
  const [restoreDialog, setRestoreDialog] = useState<RestoreDialogState | null>(null);
  const [moveError, setMoveError] = useState('');
  const [archiveDialogId, setArchiveDialogId] = useState('');
  const [draggedNodeId, setDraggedNodeId] = useState('');
  const [dropTargetId, setDropTargetId] = useState('');
  const [theme, setTheme] = useState<Theme | null>(storedTheme);
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const requestIdRef = useRef(0);
  const actionTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const columnsRef = useRef<HTMLDivElement>(null);
  const activeTheme = theme ?? systemTheme;
  const deferredSearchValue = useDeferredValue(searchValue);
  const query = normalizeSearchText(deferredSearchValue);
  const currentRoot = useMemo(
    () => (root ? omitNode(root, legacyMigration?.archiveRootId) : null),
    [legacyMigration?.archiveRootId, root],
  );
  const index = useMemo(
    () => (currentRoot ? buildBookmarkIndex(currentRoot) : null),
    [currentRoot],
  );
  const selectedFolder =
    (index?.nodeById.get(selectedId)?.url == null
      ? index?.nodeById.get(selectedId)
      : null) ?? currentRoot;
  const folderPath = useMemo(() => {
    if (!index || !selectedFolder) return [];
    const path: BookmarkNode[] = [];
    let current: BookmarkNode | undefined = selectedFolder;
    while (current) {
      path.unshift(current);
      if (current.id === currentRoot?.id) break;
      current = current.parentId ? index.nodeById.get(current.parentId) : undefined;
    }
    return path;
  }, [currentRoot?.id, index, selectedFolder]);

  const filteredSearchRoot = useMemo(
    () => (currentRoot && index && query ? filterBookmarkTree(currentRoot, index, query) : null),
    [currentRoot, index, query],
  );

  const loadBookmarks = useCallback(async (showLoading = false) => {
    const requestId = ++requestIdRef.current;
    if (showLoading) setLoading(true);
    try {
      const nextRoot = await readBookmarksBar();
      const [nextArchiveStore, nextLegacyMigration] = await Promise.all([
        reconcileBookmarkArchiveStore(),
        inspectLegacyBookmarkArchive(nextRoot),
      ]);
      if (requestId !== requestIdRef.current) return;
      setRoot(nextRoot);
      setArchiveStore(nextArchiveStore);
      setLegacyMigration(nextLegacyMigration);
      setLoadError('');
      setSelectedId((current) => current || nextRoot.id);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      console.error('[bok] failed to read bookmarks bar', error);
      setLoadError(
        error instanceof Error ? error.message : '无法读取 Chrome 书签栏',
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void browser.runtime
      .sendMessage({ type: 'bok/bookmark-backup' })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void browser.permissions
      .contains({ permissions: ['bookmarks'] })
      .then((granted) => {
        if (cancelled) return;
        setPermission(granted);
        if (granted) void loadBookmarks(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadBookmarks]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    function onPermissionsRemoved(removed: { permissions?: string[] }) {
      if (removed.permissions?.includes('bookmarks')) setPermission(false);
    }
    function onPermissionsAdded(added: { permissions?: string[] }) {
      if (added.permissions?.includes('bookmarks')) {
        setPermission(true);
        void loadBookmarks(true);
      }
    }
    browser.permissions.onRemoved.addListener(onPermissionsRemoved);
    browser.permissions.onAdded.addListener(onPermissionsAdded);
    return () => {
      browser.permissions.onRemoved.removeListener(onPermissionsRemoved);
      browser.permissions.onAdded.removeListener(onPermissionsAdded);
    };
  }, [loadBookmarks]);

  useEffect(() => {
    if (!permission) return;
    const bookmarksApi = browser.bookmarks as BookmarkEventsApi;
    let reloadTimer = 0;
    let importing = false;
    const scheduleReload = () => {
      if (importing) return;
      window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => void loadBookmarks(), 140);
    };
    const beginImport = () => {
      importing = true;
    };
    const endImport = () => {
      importing = false;
      scheduleReload();
    };

    bookmarksApi.onCreated.addListener(scheduleReload);
    bookmarksApi.onRemoved.addListener(scheduleReload);
    bookmarksApi.onChanged.addListener(scheduleReload);
    bookmarksApi.onMoved.addListener(scheduleReload);
    bookmarksApi.onChildrenReordered?.addListener(scheduleReload);
    bookmarksApi.onImportBegan?.addListener(beginImport);
    bookmarksApi.onImportEnded?.addListener(endImport);
    return () => {
      window.clearTimeout(reloadTimer);
      bookmarksApi.onCreated.removeListener(scheduleReload);
      bookmarksApi.onRemoved.removeListener(scheduleReload);
      bookmarksApi.onChanged.removeListener(scheduleReload);
      bookmarksApi.onMoved.removeListener(scheduleReload);
      bookmarksApi.onChildrenReordered?.removeListener(scheduleReload);
      bookmarksApi.onImportBegan?.removeListener(beginImport);
      bookmarksApi.onImportEnded?.removeListener(endImport);
    };
  }, [loadBookmarks, permission]);

  useEffect(() => {
    if (bookmarkView !== 'current' || query || folderPath.length === 0) return;
    const frame = requestAnimationFrame(() => {
      const columns = columnsRef.current;
      if (!columns) return;
      columns.scrollTo({
        left: columns.scrollWidth,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [bookmarkView, folderPath.length, query, selectedId]);

  async function requestPermission() {
    try {
      const granted = await browser.permissions.request({ permissions: ['bookmarks'] });
      setPermission(granted);
      if (granted) await loadBookmarks(true);
    } catch (error) {
      console.error('[bok] failed to request bookmarks permission', error);
      setNotice({ type: 'error', message: '无法请求书签权限，请重试。' });
    }
  }

  function toggleTheme() {
    const nextTheme = activeTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setTheme(nextTheme);
  }

  function selectFolder(id: string, focusContent = true) {
    setSelectedId(id);
    setSearchValue('');
    if (focusContent) {
      requestAnimationFrame(() => document.getElementById('bookmark-content')?.focus());
    }
  }

  function switchBookmarkView(nextView: BookmarkView) {
    setBookmarkView(nextView);
    setSelectedId(nextView === 'current' ? currentRoot?.id ?? '' : '');
    setSearchValue('');
    requestAnimationFrame(() => document.getElementById('bookmark-content')?.focus());
  }

  function canDropIntoFolder(node: BookmarkNode, folder: BookmarkNode): boolean {
    if (!index || folder.url != null || !node.parentId) return false;
    if (node.parentId === folder.id) return false;
    if (isNodeManaged(node, index) || isNodeManaged(folder, index)) return false;
    if (node.url == null && collectFolderIds(node).has(folder.id)) return false;
    return true;
  }

  function getDraggedNode(event: DragEvent<HTMLElement>): BookmarkNode | undefined {
    if (!index) return undefined;
    const nodeId =
      draggedNodeId || event.dataTransfer.getData(BOOKMARK_DRAG_TYPE);
    return index.nodeById.get(nodeId);
  }

  function startDragging(event: DragEvent<HTMLElement>, node: BookmarkNode) {
    if (!index || busyId || isNodeManaged(node, index)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(BOOKMARK_DRAG_TYPE, node.id);
    event.dataTransfer.setData('text/plain', node.id);
    setDraggedNodeId(node.id);
  }

  function clearDragging() {
    setDraggedNodeId('');
    setDropTargetId('');
  }

  function dragOverFolder(event: DragEvent<HTMLElement>, folder: BookmarkNode) {
    const node = getDraggedNode(event);
    if (!node || !canDropIntoFolder(node, folder)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTargetId(folder.id);
  }

  function leaveDropTarget(event: DragEvent<HTMLElement>, folderId: string) {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setDropTargetId((current) => (current === folderId ? '' : current));
  }

  function dropIntoFolder(event: DragEvent<HTMLElement>, folder: BookmarkNode) {
    const node = getDraggedNode(event);
    event.preventDefault();
    event.stopPropagation();
    clearDragging();
    if (!node || !canDropIntoFolder(node, folder)) return;
    setMoveError('');
    setMoveDialog({ nodeId: node.id, targetId: folder.id });
  }

  function restoreActionFocus(nodeId: string) {
    window.setTimeout(() => actionTriggerRefs.current.get(nodeId)?.focus(), 80);
  }

  function closeMoveDialog() {
    setMoveDialog(null);
    setMoveError('');
    requestAnimationFrame(() => document.getElementById('bookmark-content')?.focus());
  }

  function closeArchiveDialog() {
    const nodeId = archiveDialogId;
    setArchiveDialogId('');
    if (nodeId) restoreActionFocus(nodeId);
  }

  async function performMove(node: BookmarkNode, destination: {
    parentId: string;
    index?: number;
  }, message: string) {
    if (busyId) return;
    setBusyId(node.id);
    try {
      await moveBookmarkNode(node, destination);
      setNotice({ type: 'success', message, canUndo: true });
      setMoveDialog(null);
      setMoveError('');
      await loadBookmarks();
      requestAnimationFrame(() => document.getElementById('bookmark-content')?.focus());
    } catch (error) {
      console.error('[bok] failed to move bookmark node', error);
      const detail = error instanceof Error ? error.message : '未知错误';
      if (moveDialog?.nodeId === node.id) setMoveError(detail);
      else setNotice({ type: 'error', message: `移动失败：${detail}` });
      await loadBookmarks();
    } finally {
      setBusyId('');
    }
  }

  async function performArchive(node: BookmarkNode) {
    if (busyId || !root) return;
    setBusyId(node.id);
    try {
      const result = await archiveBookmarkFolder(node, root);
      setNotice({
        type: result.backupWarning ? 'error' : 'success',
        message: result.backupWarning
          ? `已归档“${getNodeTitle(node)}”，但备份文件未更新：${result.backupWarning}`
          : `已归档“${getNodeTitle(node)}”。`,
      });
      setArchiveDialogId('');
      await loadBookmarks();
      requestAnimationFrame(() => document.getElementById('bookmark-content')?.focus());
    } catch (error) {
      console.error('[bok] failed to archive bookmark folder', error);
      const detail = error instanceof Error ? error.message : '未知错误';
      setNotice({ type: 'error', message: `归档失败：${detail}` });
      await loadBookmarks();
    } finally {
      setBusyId('');
    }
  }

  function requestRestore(record: BookmarkArchiveRecord) {
    const originalParent = index?.nodeById.get(record.source.parentId);
    const pathParent = currentRoot
      ? findFolderByPath(currentRoot, record.source.parentPath)
      : null;
    setRestoreDialog({
      archiveId: record.id,
      targetId:
        originalParent && originalParent.url == null
          ? originalParent.id
          : pathParent?.id ?? currentRoot?.id ?? '',
    });
  }

  async function performRestore(record: BookmarkArchiveRecord, targetId: string) {
    if (busyId || !targetId) return;
    setBusyId(record.id);
    try {
      await restoreArchivedBookmarkFolder(record.id, targetId);
      setRestoreDialog(null);
      setNotice({
        type: 'success',
        message: `已恢复“${getArchivedFolderTitle(record)}”。`,
      });
      await loadBookmarks();
      requestAnimationFrame(() => document.getElementById('bookmark-content')?.focus());
    } catch (error) {
      console.error('[bok] failed to restore archived bookmark folder', error);
      const detail = error instanceof Error ? error.message : '未知错误';
      setNotice({ type: 'error', message: `恢复失败：${detail}` });
      await loadBookmarks();
    } finally {
      setBusyId('');
    }
  }

  async function performLegacyMigration() {
    if (busyId || !legacyMigration) return;
    if (
      !window.confirm(
        `将 ${legacyMigration.folderCount} 个旧归档文件夹迁移到 Bok 本地归档库，并在备份验证后从 Chrome 删除。继续？`,
      )
    ) {
      return;
    }
    setBusyId('legacy-migration');
    try {
      const result = await migrateLegacyBookmarkArchive();
      setNotice({
        type: 'success',
        message: `已迁移 ${result.migratedFolders} 个旧归档文件夹${result.remainingBookmarks > 0 ? `；${result.remainingBookmarks} 个直属书签仍保留在 Chrome` : ''}。`,
      });
      await loadBookmarks();
    } catch (error) {
      console.error('[bok] failed to migrate legacy bookmark archive', error);
      setNotice({
        type: 'error',
        message: `迁移失败：${error instanceof Error ? error.message : '未知错误'}`,
      });
      await loadBookmarks();
    } finally {
      setBusyId('');
    }
  }

  async function undoLastOperation() {
    if (busyId) return;
    setBusyId('undo');
    try {
      const restored = await restoreLastBookmarkOperation();
      if (!restored) throw new Error('没有可以撤销的操作');
      await loadBookmarks();
      setNotice({
        type: 'success',
        message: restored.type === 'move' ? '已撤销移动。' : '已恢复删除的书签内容。',
      });
    } catch (error) {
      console.error('[bok] failed to restore bookmark deletion', error);
      const detail = error instanceof Error ? error.message : '未知错误';
      setNotice({ type: 'error', message: `无法撤销：${detail}` });
    } finally {
      setBusyId('');
    }
  }

  function getArchiveEntry(node: BookmarkNode): ActionMenuEntry[] {
    if (!index || node.url != null || !node.parentId) return [];
    const managed = isNodeManaged(node, index);
    return [
      {
        type: 'action',
        id: 'archive',
        label: '冻结并归档…',
        disabled: managed || Boolean(busyId),
        onSelect: () => setArchiveDialogId(node.id),
      },
    ];
  }

  function renderArchiveMenu(node: BookmarkNode) {
    return (
      <ActionMenu
        ref={(element) => {
          if (element) actionTriggerRefs.current.set(node.id, element);
          else actionTriggerRefs.current.delete(node.id);
        }}
        label={`归档文件夹：${getNodeTitle(node)}`}
        disabled={Boolean(busyId)}
        pending={busyId === node.id}
        entries={getArchiveEntry(node)}
      />
    );
  }

  function renderNodeRow(node: BookmarkNode) {
    const draggable = Boolean(index && !busyId && !isNodeManaged(node, index));
    if (node.url == null) {
      return (
        <div
          className={`bookmark-row bookmark-row--folder${draggedNodeId === node.id ? ' is-dragging' : ''}${dropTargetId === node.id ? ' is-drop-target' : ''}`}
          draggable={draggable}
          onDragStart={(event) => startDragging(event, node)}
          onDragEnd={clearDragging}
          onDragOver={(event) => dragOverFolder(event, node)}
          onDragLeave={(event) => leaveDropTarget(event, node.id)}
          onDrop={(event) => dropIntoFolder(event, node)}
        >
          <button
            type="button"
            className="bookmark-row__folder-link"
            onClick={() => selectFolder(node.id)}
          >
            <span className="bookmark-row__leading bookmark-row__folder-icon">
              <FolderIcon />
            </span>
            <span className="bookmark-row__body">
              <span className="bookmark-row__title">{getNodeTitle(node)}</span>
            </span>
          </button>
          <span className="bookmark-row__actions">{renderArchiveMenu(node)}</span>
        </div>
      );
    }

    return (
      <div
        className={`bookmark-row${draggedNodeId === node.id ? ' is-dragging' : ''}`}
        draggable={draggable}
        onDragStart={(event) => startDragging(event, node)}
        onDragEnd={clearDragging}
      >
        <a
          className="bookmark-row__bookmark-link"
          href={node.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`在新标签页打开：${getNodeTitle(node)}`}
        >
          <span className="bookmark-row__leading">
            <Favicon node={node} />
          </span>
          <span className="bookmark-row__body">
            <span className="bookmark-row__title">{getNodeTitle(node)}</span>
            <span className="bookmark-row__meta">{getDisplayUrl(node.url)}</span>
          </span>
        </a>
        <span className="bookmark-row__last-used">
          <small>最后访问</small>
          {formatLastUsed(node.dateLastUsed)}
        </span>
      </div>
    );
  }

  function renderSearchBranch(node: BookmarkNode): ReactNode {
    return (
      <li key={node.id} className="bookmark-search-tree__item">
        {renderNodeRow(node)}
        {node.url == null && Boolean(node.children?.length) && (
          <ol className="bookmark-search-tree__children">
            {node.children?.map(renderSearchBranch)}
          </ol>
        )}
      </li>
    );
  }

  function renderColumnNode(node: BookmarkNode, selected: boolean) {
    const draggable = Boolean(index && !busyId && !isNodeManaged(node, index));
    if (node.url == null) {
      return (
        <li
          key={node.id}
          className={`bookmark-column-row bookmark-column-row--folder${selected ? ' is-selected' : ''}${draggedNodeId === node.id ? ' is-dragging' : ''}${dropTargetId === node.id ? ' is-drop-target' : ''}`}
          draggable={draggable}
          onDragStart={(event) => startDragging(event, node)}
          onDragEnd={clearDragging}
          onDragOver={(event) => dragOverFolder(event, node)}
          onDragLeave={(event) => leaveDropTarget(event, node.id)}
          onDrop={(event) => dropIntoFolder(event, node)}
        >
          <button
            type="button"
            className="bookmark-column-row__main"
            aria-current={selected ? 'location' : undefined}
            title={index?.pathById.get(node.id)}
            onClick={() => selectFolder(node.id, false)}
          >
            <span className="bookmark-column-row__icon bookmark-column-row__icon--folder">
              <FolderIcon />
            </span>
            <span className="bookmark-column-row__body">
              <span className="bookmark-column-row__title">{getNodeTitle(node)}</span>
            </span>
            <svg className="bookmark-column-row__chevron" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m7.5 5.5 5 4.5-5 4.5" />
            </svg>
          </button>
          <span className="bookmark-column-row__actions">{renderArchiveMenu(node)}</span>
        </li>
      );
    }

    return (
      <li
        key={node.id}
        className={`bookmark-column-row${draggedNodeId === node.id ? ' is-dragging' : ''}`}
        draggable={draggable}
        onDragStart={(event) => startDragging(event, node)}
        onDragEnd={clearDragging}
      >
        <a
          className="bookmark-column-row__main"
          href={node.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`在新标签页打开：${getNodeTitle(node)}`}
          title={node.url}
        >
          <span className="bookmark-column-row__icon">
            <Favicon node={node} />
          </span>
          <span className="bookmark-column-row__body">
            <span className="bookmark-column-row__title">{getNodeTitle(node)}</span>
            <span className="bookmark-column-row__meta">
              {getDisplayUrl(node.url)} · 最后访问 {formatLastUsed(node.dateLastUsed)}
            </span>
          </span>
        </a>
      </li>
    );
  }

  if (permission === null) {
    return (
      <div className="bookmark-page bookmark-page--centered">
        <LoadingState />
      </div>
    );
  }

  if (!permission) {
    return (
      <div className="bookmark-page bookmark-page--centered">
        <main className="permission-state">
          <img src="/bok.svg" alt="" />
          <h1>允许 Bok 管理 Chrome 书签栏</h1>
          <p>
            Bok 只读取书签栏。只有在你确认拖动或归档文件夹时才会修改内容，更改可能通过
            Chrome 同步到其他设备。
          </p>
          <button type="button" onClick={() => void requestPermission()}>
            允许访问书签
          </button>
          <a href="/saved.html">返回标签页</a>
        </main>
        {notice && <div className="bookmark-notice bookmark-notice--error">{notice.message}</div>}
      </div>
    );
  }

  const archiveDialogNode = index?.nodeById.get(archiveDialogId);
  const moveNode = moveDialog ? index?.nodeById.get(moveDialog.nodeId) : undefined;
  const moveTarget = moveDialog ? index?.nodeById.get(moveDialog.targetId) : undefined;
  const restoreRecord = restoreDialog
    ? archiveStore.archives.find((record) => record.id === restoreDialog.archiveId)
    : undefined;
  const moveCounts = moveNode && moveNode.url == null ? getFolderCounts(moveNode) : null;
  const archiveDialogCounts =
    archiveDialogNode && archiveDialogNode.url == null
      ? getFolderCounts(archiveDialogNode)
      : null;

  return (
    <div className="bookmark-page">
      <a className="skip-link" href="#bookmark-content">
        跳到书签列表
      </a>

      <header className="topbar">
        <div className="topbar__inner">
          <a className="brand" href="/saved.html" aria-label="Bok 标签页">
            <img src="/bok.svg" alt="" />
            <span>Bok</span>
          </a>
          <label className="search-field">
            <span className="sr-only">
              {bookmarkView === 'archived' ? '搜索归档' : '搜索书签'}
            </span>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m12.5 12.5 4 4" />
            </svg>
            <input
              type="search"
              value={searchValue}
              placeholder={
                bookmarkView === 'archived'
                  ? '搜索归档文件夹、标题或网址'
                  : '搜索文件夹、书签名称或网址'
              }
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setSearchValue(event.target.value)}
            />
          </label>
          <div className="topbar__actions">
            <a className="topbar__link" href="/saved.html">
              标签页
            </a>
            <a className="topbar__link" href="/options.html">
              设置
            </a>
            <button
              type="button"
              className="theme-toggle"
              aria-label={activeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              aria-pressed={activeTheme === 'dark'}
              title={activeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
              onClick={toggleTheme}
            >
              <ThemeIcon dark={activeTheme === 'dark'} />
            </button>
          </div>
        </div>
      </header>

      <div className="bookmark-workspace">
        <main
          id="bookmark-content"
          className={`bookmark-content bookmark-content--${bookmarkView}${query ? ' is-searching' : ''}`}
          tabIndex={-1}
        >
          {root && (
            <div className="bookmark-view-toolbar" aria-label="书签工具">
              {bookmarkView === 'archived' && (
                <button
                  type="button"
                  className="bookmark-toolbar-button bookmark-toolbar-button--back"
                  onClick={() => switchBookmarkView('current')}
                >
                  返回书签
                </button>
              )}
              {bookmarkView === 'current' &&
                selectedFolder &&
                currentRoot &&
                selectedFolder.id !== currentRoot.id && (
                  <button
                    type="button"
                    className="bookmark-toolbar-button bookmark-toolbar-button--back"
                    onClick={() =>
                      selectFolder(selectedFolder.parentId ?? currentRoot.id, false)
                    }
                  >
                    返回
                  </button>
                )}
              {bookmarkView === 'current' && (
                <div className="bookmark-view-toolbar__actions">
                <button
                  type="button"
                    className="bookmark-toolbar-button"
                  onClick={() => switchBookmarkView('archived')}
                >
                    归档库
                </button>
                  <button
                    type="button"
                    className="bookmark-toolbar-button"
                    title="整理功能尚未开放"
                    disabled
                  >
                    整理
                  </button>
                </div>
              )}
            </div>
          )}
          {loading && !root ? (
            <LoadingState />
          ) : loadError && !root ? (
            <section className="bookmark-empty-state">
              <h1>无法读取书签栏</h1>
              <p>{loadError}</p>
              <button type="button" onClick={() => void loadBookmarks(true)}>
                重试
              </button>
            </section>
          ) : root && bookmarkView === 'archived' ? (
            <ArchiveView
              archives={archiveStore.archives}
              query={query}
              busyId={busyId}
              legacyMigration={legacyMigration}
              onRestore={(archiveId) => {
                const record = archiveStore.archives.find((item) => item.id === archiveId);
                if (record) requestRestore(record);
              }}
              onMigrateLegacy={() => void performLegacyMigration()}
            />
          ) : currentRoot && index && selectedFolder ? (
            <>
              <h1 className="sr-only">{query ? '书签搜索结果' : '书签'}</h1>

              {query ? (
                filteredSearchRoot && Boolean(filteredSearchRoot.children?.length) ? (
                  <ol className="bookmark-search-tree" aria-label="书签搜索结果">
                    {filteredSearchRoot.children?.map(renderSearchBranch)}
                  </ol>
                ) : (
                  <section className="bookmark-empty-state">
                    <h2>没有找到“{deferredSearchValue.trim()}”</h2>
                    <p>试试文件夹、书签名称或网址。</p>
                  </section>
                )
              ) : (
                <div
                  ref={columnsRef}
                  className="bookmark-columns"
                  aria-label="书签分栏"
                >
                  {folderPath.map((folder, columnIndex) => {
                    const children = folder.children ?? [];
                    const selectedChildId = folderPath[columnIndex + 1]?.id;
                    return (
                      <section
                        key={folder.id}
                        className={`bookmark-column${dropTargetId === folder.id ? ' is-drop-target' : ''}`}
                        aria-label={getNodeTitle(folder)}
                        onDragOver={(event) => dragOverFolder(event, folder)}
                        onDragLeave={(event) => leaveDropTarget(event, folder.id)}
                        onDrop={(event) => dropIntoFolder(event, folder)}
                      >
                        {children.length > 0 ? (
                          <ol className="bookmark-column__list">
                            {children.map((node) =>
                              renderColumnNode(node, node.id === selectedChildId),
                            )}
                          </ol>
                        ) : (
                          <div className="bookmark-column__empty">
                            <FolderIcon />
                            <p>这个文件夹是空的</p>
                          </div>
                        )}
                      </section>
                    );
                  })}
                </div>
              )}
            </>
          ) : null}
        </main>
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {notice?.type === 'success' ? notice.message : ''}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {notice?.type === 'error' ? notice.message : ''}
      </div>
      {notice && (
        <div className={`bookmark-notice bookmark-notice--${notice.type}`}>
          <span>{notice.message}</span>
          {notice.canUndo && (
            <button
              type="button"
              disabled={busyId === 'undo'}
              onClick={() => void undoLastOperation()}
            >
              {busyId === 'undo' ? '恢复中…' : '撤销'}
            </button>
          )}
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      )}

      {moveDialog && moveNode && index && (
        <Modal
          title={`确认移动“${getNodeTitle(moveNode)}”？`}
          onClose={closeMoveDialog}
        >
          <div className="bookmark-dialog__body">
            <p>
              当前：{moveNode.parentId ? index.pathById.get(moveNode.parentId) : '未知目录'}
            </p>
            {moveTarget && (
              <p>
                移动到：{index.pathById.get(moveTarget.id)}
              </p>
            )}
            {moveCounts && (
              <p className="bookmark-dialog__hint">
                将同时移动 {moveCounts.folders} 个子文件夹和 {moveCounts.bookmarks} 个书签。
              </p>
            )}
            {moveError && <p className="bookmark-dialog__error">{moveError}</p>}
          </div>
          <footer className="bookmark-dialog__footer">
            <button
              type="button"
              className="secondary-button"
              autoFocus
              data-dialog-initial-focus
              onClick={closeMoveDialog}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!moveDialog.targetId || busyId === moveNode.id}
              onClick={() => {
                const target = index.nodeById.get(moveDialog.targetId);
                if (!target) return;
                void performMove(
                  moveNode,
                  { parentId: target.id },
                  `已将“${getNodeTitle(moveNode)}”移动到“${getNodeTitle(target)}”。`,
                );
              }}
            >
              {busyId === moveNode.id ? '移动中…' : '移动'}
            </button>
          </footer>
        </Modal>
      )}

      {archiveDialogNode && archiveDialogCounts && index && (
        <Modal
          title={`冻结并归档“${getNodeTitle(archiveDialogNode)}”？`}
          onClose={closeArchiveDialog}
        >
          <div className="bookmark-dialog__body">
            <p>
              Bok 会把这个文件夹保存成只读快照，然后从 Chrome 书签栏移除原文件夹。
              以后可以在归档库中浏览其中的页面，或把整个文件夹恢复到 Chrome。
            </p>
            <p className="bookmark-dialog__hint">
              {archiveDialogCounts.folders} 个子文件夹 · {archiveDialogCounts.bookmarks} 个书签 ·{' '}
              位置：{index.pathById.get(archiveDialogNode.id)}
            </p>
          </div>
          <footer className="bookmark-dialog__footer">
            <button
              type="button"
              className="secondary-button"
              autoFocus
              data-dialog-initial-focus
              onClick={closeArchiveDialog}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busyId === archiveDialogNode.id}
              onClick={() => void performArchive(archiveDialogNode)}
            >
              {busyId === archiveDialogNode.id ? '归档中…' : '冻结并归档'}
            </button>
          </footer>
        </Modal>
      )}

      {restoreDialog && restoreRecord && index && (
        <Modal
          title={`恢复“${getArchivedFolderTitle(restoreRecord)}”`}
          onClose={() => setRestoreDialog(null)}
        >
          <div className="bookmark-dialog__body">
            <p>
              将重新创建 {restoreRecord.counts.folders} 个子文件夹和{' '}
              {restoreRecord.counts.bookmarks} 个书签。Chrome 会生成新的节点 ID 和创建时间。
            </p>
            <p className="bookmark-dialog__hint">
              原位置：{['书签栏', ...restoreRecord.source.parentPath].join(' / ')}
            </p>
            <label className="bookmark-dialog__field">
              <span>恢复到</span>
              <select
                autoFocus
                data-dialog-initial-focus
                value={restoreDialog.targetId}
                disabled={busyId === restoreRecord.id}
                onChange={(event) =>
                  setRestoreDialog({ ...restoreDialog, targetId: event.target.value })
                }
              >
                {index.folders.map((folder) => (
                  <option
                    key={folder.node.id}
                    value={folder.node.id}
                    disabled={isNodeManaged(folder.node, index)}
                  >
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <footer className="bookmark-dialog__footer">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setRestoreDialog(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!restoreDialog.targetId || busyId === restoreRecord.id}
              onClick={() =>
                void performRestore(restoreRecord, restoreDialog.targetId)
              }
            >
              {busyId === restoreRecord.id ? '恢复中…' : '恢复'}
            </button>
          </footer>
        </Modal>
      )}

    </div>
  );
}
