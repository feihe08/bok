import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { browser } from 'wxt/browser';
import {
  BOOKMARK_BACKUP_STATE_KEY,
  chooseBookmarkBackupDirectory,
  getBackupDeviceName,
  getBookmarkBackupDirectoryPermission,
  getBookmarkBackupState,
  requestBookmarkBackupDirectoryPermission,
  saveBackupDeviceName,
  takeOverBackupDeviceName,
} from '../../libs/backup/backup';
import type {
  BookmarkBackupResponse,
  BookmarkBackupState,
  ImportDataResponse,
} from '../../libs/backup/model';
import {
  isSavedPagesAutoArchivePeriod,
  type SavedPagesAutoArchivePeriod,
} from '../../libs/saved-pages/model';
import type { SavedPageResponse } from '../../libs/saved-pages/messages';
import {
  getSavedPagesAutoArchivePeriod,
  SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY,
} from '../../libs/saved-pages/settings';
import {
  getDefaultBookmarkFolderSettings,
  markDefaultBookmarkFolderAsMostRecentlyModified,
  setDefaultBookmarkFolderId,
  type DefaultBookmarkFolderSettings,
} from '../../libs/bookmarks/default-folder';
import {
  BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY,
  BOOKMARK_ORGANIZATION_AI_TEST_COMMAND,
  createBookmarkOrganizationAiSettings,
  getBookmarkOrganizationAiSettings,
  saveBookmarkOrganizationAiSettings,
  type BookmarkOrganizationAiSettings,
  type BookmarkOrganizationAiTestResponse,
} from '../../libs/bookmarks/organization-ai-settings';
import { useBokTheme } from '../shared/useBokTheme';

type DirectoryPermission = 'granted' | 'denied' | 'prompt' | 'missing';
type Notice = { type: 'success' | 'error'; message: string };
type SettingsSection =
  | 'machine'
  | 'bookmarks'
  | 'bookmark-ai'
  | 'saved-pages'
  | 'backup'
  | 'import';

const BACKUP_DEVICE_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const NOTICE_EXIT_DURATION_MS = 120;

function getSettingsSection(): SettingsSection {
  if (window.location.hash === '#import-settings') return 'import';
  if (window.location.hash === '#backup-settings') return 'backup';
  if (window.location.hash === '#saved-pages-settings') return 'saved-pages';
  if (window.location.hash === '#bookmark-ai-settings') return 'bookmark-ai';
  if (window.location.hash === '#bookmark-settings') return 'bookmarks';
  return 'machine';
}

const EMPTY_BOOKMARK_FOLDER_SETTINGS: DefaultBookmarkFolderSettings = {
  configuredFolderId: null,
  selectedFolderId: null,
  missingConfiguredFolder: false,
  options: [],
};

function formatBackupTime(timestamp: number | null): string {
  if (timestamp == null) return '尚未成功备份';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function ThemeIcon({ dark }: { dark: boolean }) {
  return (
    <span className="theme-icon" aria-hidden="true">
      <svg
        className={`theme-icon__glyph${dark ? ' is-visible' : ''}`}
        viewBox="0 0 20 20"
      >
        <circle cx="10" cy="10" r="3.25" />
        <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
      </svg>
      <svg
        className={`theme-icon__glyph${dark ? '' : ' is-visible'}`}
        viewBox="0 0 20 20"
      >
        <path d="M16.5 12.2A6.6 6.6 0 0 1 7.8 3.5a6.6 6.6 0 1 0 8.7 8.7Z" />
      </svg>
    </span>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.8 5.5h5l1.5 1.8h7.9v7.2H2.8z" />
    </svg>
  );
}

function permissionLabel(permission: DirectoryPermission): string {
  if (permission === 'granted') return '可以写入';
  if (permission === 'missing') return '尚未选择';
  return '需要重新授权';
}

function isBackupDeviceNameConflict(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'backup-device-name-conflict'
  ) {
    return true;
  }
  return error instanceof Error && /已被.*使用|冲突|占用/.test(error.message);
}

function triggerForceBackup(): void {
  void browser.runtime
    .sendMessage({ type: 'bok/bookmark-backup', force: true })
    .catch(() => undefined);
}

export default function SettingsPage() {
  const [state, setState] = useState<BookmarkBackupState | null>(null);
  const [directoryPermission, setDirectoryPermission] =
    useState<DirectoryPermission>('missing');
  const [bookmarksPermission, setBookmarksPermission] = useState(false);
  const [codexBookmarkBridgePermission, setCodexBookmarkBridgePermission] =
    useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [renderedNotice, setRenderedNotice] = useState<Notice | null>(null);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const deviceNameInputRef = useRef<HTMLInputElement>(null);
  const deviceNameEditButtonRef = useRef<HTMLButtonElement>(null);
  const { theme: activeTheme, toggleTheme } = useBokTheme({
    forceBackupOnWrite: true,
  });
  const [autoArchivePeriod, setAutoArchivePeriod] =
    useState<SavedPagesAutoArchivePeriod>(7);
  const [bookmarkFolderSettings, setBookmarkFolderSettings] =
    useState<DefaultBookmarkFolderSettings>(EMPTY_BOOKMARK_FOLDER_SETTINGS);
  const [bookmarkOrganizationAiSettings, setBookmarkOrganizationAiSettings] =
    useState<BookmarkOrganizationAiSettings | null>(null);
  const [bookmarkOrganizationAiSettingsLoaded, setBookmarkOrganizationAiSettingsLoaded] =
    useState(false);
  const [aiEndpoint, setAiEndpoint] = useState('');
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiPreference, setAiPreference] = useState('');
  const [aiSettingsError, setAiSettingsError] = useState('');
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(getSettingsSection);
  const [backupDeviceName, setBackupDeviceName] = useState('personal');
  const [savedBackupDeviceName, setSavedBackupDeviceName] =
    useState('personal');
  const [isEditingBackupDeviceName, setIsEditingBackupDeviceName] =
    useState(false);
  const [backupDeviceNameError, setBackupDeviceNameError] = useState('');
  const [canTakeOverBackupDeviceName, setCanTakeOverBackupDeviceName] =
    useState(false);
  const refresh = useCallback(async () => {
    const [
      nextState,
      nextDirectoryPermission,
      canReadBookmarks,
      canUseCodexBookmarkBridge,
      nextAutoArchivePeriod,
      nextBookmarkOrganizationAiSettings,
    ] =
      await Promise.all([
        getBookmarkBackupState(),
        getBookmarkBackupDirectoryPermission(),
        browser.permissions.contains({ permissions: ['bookmarks'] }),
        browser.permissions.contains({ permissions: ['nativeMessaging'] }),
        getSavedPagesAutoArchivePeriod(),
        getBookmarkOrganizationAiSettings(),
      ]);
    const nextBookmarkFolderSettings = canReadBookmarks
      ? await getDefaultBookmarkFolderSettings()
      : EMPTY_BOOKMARK_FOLDER_SETTINGS;
    setState(nextState);
    setDirectoryPermission(nextDirectoryPermission);
    setBookmarksPermission(canReadBookmarks);
    setCodexBookmarkBridgePermission(
      canReadBookmarks && canUseCodexBookmarkBridge,
    );
    setAutoArchivePeriod(nextAutoArchivePeriod);
    setBookmarkFolderSettings(nextBookmarkFolderSettings);
    setBookmarkOrganizationAiSettings(nextBookmarkOrganizationAiSettings);
    setBookmarkOrganizationAiSettingsLoaded(true);
    setAiEndpoint(nextBookmarkOrganizationAiSettings?.endpoint ?? '');
    setAiApiKey(nextBookmarkOrganizationAiSettings?.apiKey ?? '');
    setAiModel(nextBookmarkOrganizationAiSettings?.model ?? '');
    setAiPreference(nextBookmarkOrganizationAiSettings?.preference ?? '');
  }, []);

  useEffect(() => {
    void refresh();
    void getBackupDeviceName()
      .then((deviceName) => {
        setBackupDeviceName(deviceName);
        setSavedBackupDeviceName(deviceName);
      })
      .catch(() => {
        setIsEditingBackupDeviceName(true);
        setBackupDeviceNameError('无法读取机器名称，请重新加载后重试。');
      });
    void browser.runtime
      .sendMessage({ type: 'bok/bookmark-backup' })
      .then(refresh)
      .catch(() => undefined);

    function onStorageChanged(
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) {
      if (
        areaName === 'local' &&
        (changes[BOOKMARK_BACKUP_STATE_KEY] ||
          changes[SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY] ||
          changes[BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY])
      ) {
        void refresh();
      }
    }
    browser.storage.onChanged.addListener(onStorageChanged);
    return () => browser.storage.onChanged.removeListener(onStorageChanged);
  }, [refresh]);

  useEffect(() => {
    function onHashChange() {
      setActiveSection(getSettingsSection());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!notice) return;
    setRenderedNotice(notice);
    const frameId = requestAnimationFrame(() => setNoticeVisible(true));
    return () => cancelAnimationFrame(frameId);
  }, [notice]);

  useEffect(() => {
    if (notice || !renderedNotice) return;
    setNoticeVisible(false);
    const timeoutId = window.setTimeout(
      () => setRenderedNotice(null),
      NOTICE_EXIT_DURATION_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [notice, renderedNotice]);

  async function changeAutoArchivePeriod(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.currentTarget.value;
    const nextPeriod: unknown = value === 'never' ? value : Number(value);
    if (!isSavedPagesAutoArchivePeriod(nextPeriod) || busy) return;

    const previousPeriod = autoArchivePeriod;
    setAutoArchivePeriod(nextPeriod);
    setBusy('auto-archive');
    setNotice(null);
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'bok/set-auto-archive-period',
        period: nextPeriod,
      })) as SavedPageResponse;
      if (!response?.ok) {
        throw new Error(response?.error || '后台没有返回保存结果');
      }
      setNotice({ type: 'success', message: '自动归档设置已保存。' });
      triggerForceBackup();
    } catch (error) {
      setAutoArchivePeriod(previousPeriod);
      setNotice({
        type: 'error',
        message: `自动归档设置保存失败：${error instanceof Error ? error.message : '请重试'}`,
      });
    } finally {
      setBusy('');
    }
  }

  async function changeDefaultBookmarkFolder(
    event: ChangeEvent<HTMLSelectElement>,
  ) {
    const folderId = event.currentTarget.value;
    if (!folderId || busy) return;

    setBusy('bookmark-folder');
    setNotice(null);
    try {
      await setDefaultBookmarkFolderId(folderId);
      if (!(await markDefaultBookmarkFolderAsMostRecentlyModified())) {
        throw new Error('目录已保存，但现在无法找到，请重新选择');
      }
      await refresh();
      setNotice({ type: 'success', message: '默认书签目录已保存。' });
    } catch (error) {
      await refresh();
      setNotice({
        type: 'error',
        message: `默认书签目录保存失败：${error instanceof Error ? error.message : '请重试'}`,
      });
    } finally {
      setBusy('');
    }
  }

  async function saveBookmarkOrganizationAi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !bookmarkOrganizationAiSettingsLoaded) return;

    setBusy('bookmark-ai');
    setNotice(null);
    setAiSettingsError('');
    try {
      const next = createBookmarkOrganizationAiSettings({
        endpoint: aiEndpoint,
        apiKey: aiApiKey,
        model: aiModel,
        preference: aiPreference,
      });
      await saveBookmarkOrganizationAiSettings(next, bookmarkOrganizationAiSettings);
      setBookmarkOrganizationAiSettings(next);
      setAiEndpoint(next.endpoint);
      setAiApiKey(next.apiKey);
      setAiModel(next.model);
      setAiPreference(next.preference);
      setNotice({ type: 'success', message: '书签整理 AI 配置已保存。' });
      triggerForceBackup();
    } catch (error) {
      setAiSettingsError(
        error instanceof Error ? error.message : '无法保存书签整理 AI 配置',
      );
    } finally {
      setBusy('');
    }
  }

  async function clearBookmarkOrganizationAi() {
    if (busy || !bookmarkOrganizationAiSettingsLoaded) return;

    setBusy('bookmark-ai');
    setNotice(null);
    setAiSettingsError('');
    try {
      await saveBookmarkOrganizationAiSettings(null, bookmarkOrganizationAiSettings);
      setBookmarkOrganizationAiSettings(null);
      setAiEndpoint('');
      setAiApiKey('');
      setAiModel('');
      setAiPreference('');
      setNotice({ type: 'success', message: '书签整理 AI 配置已清除。' });
      triggerForceBackup();
    } catch (error) {
      setAiSettingsError(
        error instanceof Error ? error.message : '无法清除书签整理 AI 配置',
      );
    } finally {
      setBusy('');
    }
  }

  async function testBookmarkOrganizationAiConnection() {
    if (busy || !bookmarkOrganizationAiSettings) return;

    setBusy('bookmark-ai-test');
    setNotice(null);
    setAiSettingsError('');
    try {
      const response = (await browser.runtime.sendMessage(
        BOOKMARK_ORGANIZATION_AI_TEST_COMMAND,
      )) as BookmarkOrganizationAiTestResponse | undefined;
      if (!response) throw new Error('扩展后台未响应，请重新加载 Bok 后重试');
      if (!response.ok) throw new Error(response.error || '连接测试失败');
      setNotice({
        type: 'success',
        message: 'Responses API 连接测试成功。',
      });
    } catch (error) {
      setAiSettingsError(
        `连接测试失败：${error instanceof Error ? error.message : '请检查配置后重试'}`,
      );
    } finally {
      setBusy('');
    }
  }

  function focusBackupDeviceNameInput(): void {
    requestAnimationFrame(() => deviceNameInputRef.current?.focus());
  }

  function finishEditingBackupDeviceName(deviceName: string): void {
    setBackupDeviceName(deviceName);
    setSavedBackupDeviceName(deviceName);
    setIsEditingBackupDeviceName(false);
    requestAnimationFrame(() => deviceNameEditButtonRef.current?.focus());
  }

  function startEditingBackupDeviceName(): void {
    setBackupDeviceName(savedBackupDeviceName);
    setBackupDeviceNameError('');
    setCanTakeOverBackupDeviceName(false);
    setIsEditingBackupDeviceName(true);
    requestAnimationFrame(() => {
      deviceNameInputRef.current?.focus();
      deviceNameInputRef.current?.select();
    });
  }

  function cancelEditingBackupDeviceName(): void {
    setBackupDeviceName(savedBackupDeviceName);
    setBackupDeviceNameError('');
    setCanTakeOverBackupDeviceName(false);
    setIsEditingBackupDeviceName(false);
    requestAnimationFrame(() => deviceNameEditButtonRef.current?.focus());
  }

  async function ensureBackupDirectoryReady(): Promise<boolean> {
    if (!state?.directoryName) {
      setBackupDeviceNameError('请先选择备份文件夹，再重新绑定机器名称。');
      focusBackupDeviceNameInput();
      return false;
    }

    const permission = await requestBookmarkBackupDirectoryPermission();
    if (permission !== 'granted') {
      setBackupDeviceNameError('请先重新授权备份文件夹，再重新绑定机器名称。');
      focusBackupDeviceNameInput();
      return false;
    }
    return true;
  }

  async function saveDeviceName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const normalizedName = backupDeviceName.trim().toLowerCase();
    setBackupDeviceName(normalizedName);
    setBackupDeviceNameError('');
    setCanTakeOverBackupDeviceName(false);
    setNotice(null);

    if (!BACKUP_DEVICE_NAME_PATTERN.test(normalizedName)) {
      setBackupDeviceNameError('使用 1–32 个小写字母、数字、- 或 _。');
      focusBackupDeviceNameInput();
      return;
    }

    setBusy('device-name');
    try {
      const nextState = await saveBackupDeviceName(normalizedName);
      setState(nextState);
      finishEditingBackupDeviceName(nextState.deviceName);
      setNotice({ type: 'success', message: '机器名称已保存。' });
      if (directoryPermission === 'granted' && bookmarksPermission) {
        triggerForceBackup();
      }
    } catch (error) {
      if (isBackupDeviceNameConflict(error)) {
        setCanTakeOverBackupDeviceName(true);
        setBackupDeviceNameError(
          '这个名称已被其他电脑使用。请更换名称，或重新绑定此名称。',
        );
      } else {
        setBackupDeviceNameError(
          error instanceof Error ? error.message : '无法保存机器名称，请重试。',
        );
      }
      focusBackupDeviceNameInput();
    } finally {
      setBusy('');
    }
  }

  async function takeOverDeviceName() {
    if (busy || !canTakeOverBackupDeviceName) return;
    if (
      !window.confirm(
        `重新绑定“${backupDeviceName}”后，旧安装将不能再使用此名称。继续？`,
      )
    ) {
      focusBackupDeviceNameInput();
      return;
    }

    setBusy('device-name');
    setNotice(null);
    try {
      if (!(await ensureBackupDirectoryReady())) return;
      const nextState = await takeOverBackupDeviceName(backupDeviceName);
      setState(nextState);
      setBackupDeviceNameError('');
      setCanTakeOverBackupDeviceName(false);
      finishEditingBackupDeviceName(nextState.deviceName);
      setNotice({ type: 'success', message: '机器名称已重新绑定。' });
      if (bookmarksPermission) triggerForceBackup();
    } catch (error) {
      setBackupDeviceNameError(
        error instanceof Error ? error.message : '无法重新绑定机器名称，请重试。',
      );
      focusBackupDeviceNameInput();
    } finally {
      setBusy('');
    }
  }

  async function executeBackupNow() {
    const permission = await requestBookmarkBackupDirectoryPermission();
    if (permission !== 'granted') {
      throw new Error('请允许 Bok 写入备份文件夹');
    }
    const response = (await browser.runtime.sendMessage({
      type: 'bok/bookmark-backup',
      force: true,
    })) as BookmarkBackupResponse;
    if (!response?.ok) throw new Error(response?.error || '后台没有返回备份结果');
    if (response.result.status === 'failed') {
      throw new Error(response.result.state.lastError || '备份失败');
    }
    setNotice({
      type: 'success',
      message: '五份最新备份已更新；本机和共享每周历史包已按规则处理。',
    });
    await refresh();
  }

  async function runBackupNow() {
    if (busy) return;
    setBusy('backup');
    setNotice(null);
    try {
      await executeBackupNow();
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '备份失败，请重试',
      });
      await refresh();
    } finally {
      setBusy('');
    }
  }

  async function chooseDirectory() {
    if (busy) return;
    setBusy('directory');
    setNotice(null);
    try {
      await chooseBookmarkBackupDirectory();
      await refresh();
      if (bookmarksPermission) await executeBackupNow();
      else {
        setNotice({
          type: 'success',
          message: '已选择备份文件夹。允许书签访问后可同时备份 Chrome 书签栏。',
        });
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setNotice({
          type: 'error',
          message: error instanceof Error ? error.message : '无法选择备份文件夹',
        });
      }
    } finally {
      setBusy('');
    }
  }

  async function grantBookmarksPermission() {
    if (busy) return;
    setBusy('bookmarks');
    setNotice(null);
    try {
      const granted = await browser.permissions.request({ permissions: ['bookmarks'] });
      setBookmarksPermission(granted);
      if (!granted) throw new Error('未允许读取书签，自动备份不会执行');
      setNotice({ type: 'success', message: '已允许 Bok 读取书签栏。' });
      if (directoryPermission === 'granted') await executeBackupNow();
    } catch (error) {
      setNotice({
        type: 'error',
        message: error instanceof Error ? error.message : '无法请求书签权限',
      });
    } finally {
      setBusy('');
      await refresh();
    }
  }

  async function grantCodexBookmarkBridgePermission() {
    if (busy) return;
    setBusy('codex-bookmarks');
    setNotice(null);
    try {
      const granted = await browser.permissions.request({
        permissions: ['bookmarks', 'nativeMessaging'],
      });
      if (!granted) throw new Error('未允许本机桥接，Codex 不能操作 Chrome 书签');
      setNotice({
        type: 'success',
        message: '已允许 Codex 通过本机 Bok 桥接访问书签。',
      });
    } catch (error) {
      setNotice({
        type: 'error',
        message:
          error instanceof Error ? error.message : '无法启用 Codex 书签访问',
      });
    } finally {
      setBusy('');
      await refresh();
    }
  }

  async function revokeCodexBookmarkBridgePermission() {
    if (busy) return;
    setBusy('codex-bookmarks');
    setNotice(null);
    try {
      const removed = await browser.permissions.remove({
        permissions: ['nativeMessaging'],
      });
      if (!removed) throw new Error('无法关闭本机桥接，请重新加载 Bok 后重试');
      setNotice({ type: 'success', message: '已关闭 Codex 书签访问。' });
    } catch (error) {
      setNotice({
        type: 'error',
        message:
          error instanceof Error ? error.message : '无法关闭 Codex 书签访问',
      });
    } finally {
      setBusy('');
      await refresh();
    }
  }

  async function importData(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || busy) return;
    if (
      !window.confirm(
        `将“${file.name}”导入 Bok。当前记录会保留，并在写入前创建本地恢复副本。继续？`,
      )
    ) {
      return;
    }

    setBusy('import');
    setNotice(null);
    try {
      const response = (await browser.runtime.sendMessage({
        type: 'bok/import-data',
        json: await file.text(),
      })) as ImportDataResponse;
      if (!response) throw new Error('扩展后台未响应，请重新加载 Bok 后重试');
      if (!response.ok) throw new Error(response.error || '后台没有返回导入结果');
      const result = response.result;
      if (!result || !('kind' in result)) {
        throw new Error('后台没有返回导入结果');
      }
      if (result.kind === 'bookmark-archive') {
        setNotice({
          type: 'success',
          message: `已新增 ${result.importedArchives} 个归档，共 ${result.importedBookmarks} 个书签。`,
        });
      } else if (result.kind === 'reading-list') {
        setNotice({
          type: 'success',
          message: `已导入 ${result.importedItems} 篇收藏；跳过 ${result.skippedDuplicateUrls} 个重复 URL${result.regeneratedIds > 0 ? `；${result.regeneratedIds} 条记录因 ID 冲突已生成新 ID` : ''}。`,
        });
      } else {
        setNotice({
          type: 'success',
          message: `已导入 ${result.importedSessions} 个会话、${result.importedGroups} 个标签组和 ${result.importedTabs} 个标签；跳过 ${result.skippedDuplicateGroups} 个重复标签组；按自动归档设置归档 ${result.archivedSessions} 个会话和 ${result.archivedGroups} 个标签组${result.renamedGroups > 0 ? `；${result.renamedGroups} 个标签组因重名已追加数字后缀` : ''}。`,
        });
      }
    } catch (error) {
      setNotice({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : '无法导入，请选择 Bok JSON 文件后重试',
      });
    } finally {
      setBusy('');
    }
  }

  const hasUnsavedBookmarkOrganizationAiChanges =
    bookmarkOrganizationAiSettings === null
      ? Boolean(aiEndpoint || aiApiKey || aiModel || aiPreference)
      : aiEndpoint !== bookmarkOrganizationAiSettings.endpoint ||
        aiApiKey !== bookmarkOrganizationAiSettings.apiKey ||
        aiModel !== bookmarkOrganizationAiSettings.model ||
        aiPreference !== bookmarkOrganizationAiSettings.preference;

  return (
    <div className="settings-page">
      <a className="skip-link" href="#settings-content">
        跳到设置
      </a>
      <header className="settings-topbar">
        <div className="settings-topbar__inner">
          <a
            className="brand"
            href="/saved.html"
            aria-label="返回已保存网页"
            title="返回已保存网页"
          >
            <img src="/bok.svg" alt="" />
          </a>
          <button
            type="button"
            className="theme-toggle"
            aria-label={activeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            title={activeTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            onClick={toggleTheme}
          >
            <ThemeIcon dark={activeTheme === 'dark'} />
          </button>
        </div>
      </header>

      <div className="settings-layout">
        <aside className="settings-sidebar">
          <nav aria-label="设置分类">
            <a
              href="#machine-settings"
              aria-current={activeSection === 'machine' ? 'location' : undefined}
            >
              机器
            </a>
            <a
              href="#bookmark-settings"
              aria-current={activeSection === 'bookmarks' ? 'location' : undefined}
            >
              书签
            </a>
            <a
              href="#bookmark-ai-settings"
              aria-current={activeSection === 'bookmark-ai' ? 'location' : undefined}
            >
              书签整理 AI
            </a>
            <a
              href="#saved-pages-settings"
              aria-current={activeSection === 'saved-pages' ? 'location' : undefined}
            >
              已保存网页
            </a>
            <a
              href="#backup-settings"
              aria-current={activeSection === 'backup' ? 'location' : undefined}
            >
              备份
            </a>
            <a
              href="#import-settings"
              aria-current={activeSection === 'import' ? 'location' : undefined}
            >
              导入
            </a>
          </nav>
        </aside>

        <main id="settings-content" className="settings-content" tabIndex={-1}>
          <header className="settings-header">
            <h1>设置</h1>
            <p>管理机器名称、书签、Bok 已保存网页和本地备份。</p>
          </header>

          <section
            id="machine-settings"
            className="settings-section"
            aria-labelledby="machine-heading"
          >
            <div className="settings-section__heading">
              <h2 id="machine-heading">机器</h2>
              <p>标识当前电脑。这个设置不会随备份迁移。</p>
            </div>
            <dl className="settings-list">
              <div className="settings-row settings-row--device-name">
                <dt>
                  {isEditingBackupDeviceName ? (
                    <label htmlFor="backup-device-name">机器名称</label>
                  ) : (
                    '机器名称'
                  )}
                </dt>
                <dd>
                  {isEditingBackupDeviceName ? (
                    <form
                      className="settings-device-name-form"
                      noValidate
                      onSubmit={(event) => void saveDeviceName(event)}
                    >
                      <div className="settings-device-name-controls">
                        <input
                          ref={deviceNameInputRef}
                          id="backup-device-name"
                          name="backupDeviceName"
                          className="settings-input"
                          type="text"
                          value={backupDeviceName}
                          maxLength={32}
                          pattern="[a-z0-9_-]{1,32}"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={Boolean(busy)}
                          aria-invalid={backupDeviceNameError ? true : undefined}
                          aria-describedby={`backup-device-name-help${backupDeviceNameError ? ' backup-device-name-error' : ''}`}
                          onChange={(event) => {
                            setBackupDeviceName(event.currentTarget.value.toLowerCase());
                            setBackupDeviceNameError('');
                            setCanTakeOverBackupDeviceName(false);
                          }}
                        />
                        <button
                          type="submit"
                          className="secondary-button"
                          disabled={Boolean(busy)}
                        >
                          {busy === 'device-name' ? '保存中…' : '保存'}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={Boolean(busy)}
                          onClick={cancelEditingBackupDeviceName}
                        >
                          取消
                        </button>
                        {canTakeOverBackupDeviceName && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={Boolean(busy)}
                            onClick={() => void takeOverDeviceName()}
                          >
                            重新绑定此名称
                          </button>
                        )}
                      </div>
                      <p id="backup-device-name-help">
                        使用 1–32 个小写字母、数字、- 或 _。备份目录可访问时会检查重名。
                      </p>
                      {backupDeviceNameError && (
                        <p id="backup-device-name-error" className="settings-field-error">
                          {backupDeviceNameError}
                        </p>
                      )}
                    </form>
                  ) : (
                    <button
                      ref={deviceNameEditButtonRef}
                      type="button"
                      className="settings-device-name-value"
                      disabled={Boolean(busy)}
                      aria-label={`修改机器名称，当前名称为 ${savedBackupDeviceName}`}
                      onClick={startEditingBackupDeviceName}
                    >
                      <strong>{savedBackupDeviceName}</strong>
                      <small>修改</small>
                    </button>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section
            id="bookmark-settings"
            className="settings-section"
            aria-labelledby="bookmark-heading"
          >
            <div className="settings-section__heading">
              <h2 id="bookmark-heading">书签</h2>
              <p>设置 Chrome 原生书签保存入口下次默认选择的目录。</p>
            </div>

            {!bookmarksPermission && (
              <div className="settings-permission">
                <div>
                  <strong>允许访问 Chrome 书签栏</strong>
                  <p>用于选择默认保存目录和生成书签栏备份文件。</p>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={Boolean(busy)}
                  onClick={() => void grantBookmarksPermission()}
                >
                  {busy === 'bookmarks' ? '请求中…' : '允许访问'}
                </button>
              </div>
            )}

            <dl className="settings-list">
              <div className="settings-row">
                <dt>
                  <label htmlFor="default-bookmark-folder">默认保存目录</label>
                </dt>
                <dd>
                  <div className="settings-select-control">
                    <select
                      id="default-bookmark-folder"
                      className="settings-select"
                      value={
                        bookmarkFolderSettings.missingConfiguredFolder
                          ? bookmarkFolderSettings.configuredFolderId ?? ''
                          : bookmarkFolderSettings.selectedFolderId ?? ''
                      }
                      disabled={
                        Boolean(busy) ||
                        !bookmarksPermission ||
                        bookmarkFolderSettings.options.length === 0
                      }
                      aria-invalid={
                        bookmarkFolderSettings.missingConfiguredFolder || undefined
                      }
                      aria-describedby="default-bookmark-folder-help"
                      onChange={(event) => void changeDefaultBookmarkFolder(event)}
                    >
                      {!bookmarksPermission && <option value="">需要书签权限</option>}
                      {bookmarksPermission &&
                        bookmarkFolderSettings.missingConfiguredFolder && (
                          <option
                            value={bookmarkFolderSettings.configuredFolderId ?? ''}
                            disabled
                          >
                            原目录不再可选
                          </option>
                        )}
                      {bookmarksPermission &&
                        !bookmarkFolderSettings.missingConfiguredFolder &&
                        bookmarkFolderSettings.selectedFolderId == null && (
                          <option value="" disabled>
                            未找到 Inbox，请选择
                          </option>
                        )}
                      {bookmarkFolderSettings.options.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.label}
                        </option>
                      ))}
                    </select>
                    <p id="default-bookmark-folder-help">
                      {!bookmarksPermission
                        ? '允许书签访问后，可选择书签栏中的一级文件夹。'
                        : bookmarkFolderSettings.missingConfiguredFolder
                          ? '原目录已删除、移出书签栏或不在一级目录，请重新选择。'
                          : bookmarkFolderSettings.configuredFolderId == null
                            ? '当前沿用 Inbox；选择后只在当前 Chrome 资料中生效。'
                            : '只在当前 Chrome 资料中生效，不随设置备份迁移。'}
                    </p>
                  </div>
                </dd>
              </div>
              <div className="settings-row">
                <dt>Codex 书签访问</dt>
                <dd>
                  <div className="settings-select-control">
                    <p>
                      {codexBookmarkBridgePermission
                        ? '已允许本机 Codex 读取书签，并在核对当前标题和目录后重命名文件夹或移动书签。'
                        : '允许后，本机 Codex 可通过 Bok 读取书签，并执行经过预览的文件夹重命名或书签移动。'}
                    </p>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void (codexBookmarkBridgePermission
                          ? revokeCodexBookmarkBridgePermission()
                          : grantCodexBookmarkBridgePermission())
                      }
                    >
                      {busy === 'codex-bookmarks'
                        ? '处理中…'
                        : codexBookmarkBridgePermission
                          ? '关闭 Codex 访问'
                          : '允许 Codex 访问'}
                    </button>
                  </div>
                </dd>
              </div>
            </dl>
          </section>

          <section
            id="bookmark-ai-settings"
            className="settings-section"
            aria-labelledby="bookmark-ai-heading"
          >
            <div className="settings-section__heading">
              <h2 id="bookmark-ai-heading">书签整理 AI</h2>
              <p>只支持标准 OpenAI Responses API；Bok 会按你填写的完整 URL 发起请求。</p>
            </div>
            <form
              className="settings-ai-form"
              noValidate
              onSubmit={(event) => void saveBookmarkOrganizationAi(event)}
            >
              <dl className="settings-list">
                <div className="settings-row">
                  <dt>
                    <label htmlFor="bookmark-ai-endpoint">Responses API URL</label>
                  </dt>
                  <dd>
                    <div className="settings-select-control">
                      <input
                        id="bookmark-ai-endpoint"
                        className="settings-input settings-input--wide"
                        type="url"
                        inputMode="url"
                        autoComplete="url"
                        spellCheck={false}
                        value={aiEndpoint}
                        disabled={Boolean(busy) || !bookmarkOrganizationAiSettingsLoaded}
                        aria-invalid={aiSettingsError ? true : undefined}
                        aria-describedby="bookmark-ai-endpoint-help"
                        onChange={(event) => {
                          setAiEndpoint(event.currentTarget.value);
                          setAiSettingsError('');
                        }}
                      />
                      <p id="bookmark-ai-endpoint-help">
                        填写完整 HTTPS URL，例如服务提供的 `/responses` 地址；Bok 不会追加路径。
                      </p>
                    </div>
                  </dd>
                </div>
                <div className="settings-row">
                  <dt>
                    <label htmlFor="bookmark-ai-key">API Key</label>
                  </dt>
                  <dd>
                    <div className="settings-select-control">
                      <input
                        id="bookmark-ai-key"
                        className="settings-input settings-input--wide"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={aiApiKey}
                        disabled={Boolean(busy) || !bookmarkOrganizationAiSettingsLoaded}
                        aria-invalid={aiSettingsError ? true : undefined}
                        aria-describedby="bookmark-ai-key-help"
                        onChange={(event) => {
                          setAiApiKey(event.currentTarget.value);
                          setAiSettingsError('');
                        }}
                      />
                      <p id="bookmark-ai-key-help">
                        以未加密明文保存在当前 Chrome 资料，并进入本机设置备份和每周设备 ZIP。
                      </p>
                    </div>
                  </dd>
                </div>
                <div className="settings-row">
                  <dt>
                    <label htmlFor="bookmark-ai-model">模型</label>
                  </dt>
                  <dd>
                    <div className="settings-select-control">
                      <input
                        id="bookmark-ai-model"
                        className="settings-input settings-input--wide"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={aiModel}
                        disabled={Boolean(busy) || !bookmarkOrganizationAiSettingsLoaded}
                        aria-invalid={aiSettingsError ? true : undefined}
                        onChange={(event) => {
                          setAiModel(event.currentTarget.value);
                          setAiSettingsError('');
                        }}
                      />
                    </div>
                  </dd>
                </div>
                <div className="settings-row">
                  <dt>
                    <label htmlFor="bookmark-ai-preference">整理偏好</label>
                  </dt>
                  <dd>
                    <div className="settings-select-control">
                      <textarea
                        id="bookmark-ai-preference"
                        className="settings-textarea"
                        value={aiPreference}
                        disabled={Boolean(busy) || !bookmarkOrganizationAiSettingsLoaded}
                        aria-invalid={aiSettingsError ? true : undefined}
                        aria-describedby="bookmark-ai-preference-help"
                        onChange={(event) => {
                          setAiPreference(event.currentTarget.value);
                          setAiSettingsError('');
                        }}
                      />
                      <p id="bookmark-ai-preference-help">
                        必填。仅用于表达你希望 AI 采用的整理取向；不保存整理基线、变化队列或缓存建议。
                      </p>
                    </div>
                  </dd>
                </div>
              </dl>
              {aiSettingsError && (
                <p className="settings-field-error" role="alert">
                  {aiSettingsError}
                </p>
              )}
              <div className="settings-ai-actions">
                <button
                  type="submit"
                  className="secondary-button"
                  disabled={Boolean(busy) || !bookmarkOrganizationAiSettingsLoaded}
                >
                  {busy === 'bookmark-ai' ? '保存中…' : '保存配置'}
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    Boolean(busy) ||
                    !bookmarkOrganizationAiSettings ||
                    hasUnsavedBookmarkOrganizationAiChanges
                  }
                  onClick={() => void testBookmarkOrganizationAiConnection()}
                >
                  {busy === 'bookmark-ai-test' ? '测试中…' : '测试连接'}
                </button>
                {bookmarkOrganizationAiSettings && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={Boolean(busy)}
                    onClick={() => void clearBookmarkOrganizationAi()}
                  >
                    清除配置
                  </button>
                )}
              </div>
              <p className="settings-ai-test-note">
                测试连接只使用已保存配置，并会向你填写的 Responses API URL 发送一次请求。
              </p>
            </form>
          </section>

          <section
            id="saved-pages-settings"
            className="settings-section"
            aria-labelledby="saved-pages-heading"
          >
            <div className="settings-section__heading">
              <h2 id="saved-pages-heading">已保存网页</h2>
              <p>设置 Bok 如何整理已保存的分组。</p>
            </div>
            <dl className="settings-list">
              <div className="settings-row">
                <dt>
                  <label htmlFor="auto-archive-period">自动归档</label>
                </dt>
                <dd>
                  <div className="settings-select-control">
                    <select
                      id="auto-archive-period"
                      className="settings-select"
                      value={String(autoArchivePeriod)}
                      disabled={Boolean(busy)}
                      aria-describedby="auto-archive-period-help"
                      onChange={(event) => void changeAutoArchivePeriod(event)}
                    >
                      <option value="1">当天（1 天）</option>
                      <option value="3">3 天</option>
                      <option value="7">7 天</option>
                      <option value="30">1 个月（30 天）</option>
                      <option value="never">永不</option>
                    </select>
                    <p id="auto-archive-period-help">
                      从保存或最近恢复的时间开始计算，只影响后续自动归档；Todo、Doing
                      和固定组仍会跳过。
                    </p>
                  </div>
                </dd>
              </div>
            </dl>
          </section>

          <section
            id="backup-settings"
            className="settings-section"
            aria-labelledby="backup-heading"
          >
            <div className="settings-section__heading">
              <h2 id="backup-heading">本地备份</h2>
              <p>备份文件保存在你选择的文件夹，不会上传到 Bok 的服务器。</p>
            </div>

            <dl className="settings-list">
            <div className="settings-row">
              <dt>备份文件夹</dt>
              <dd>
                <div className="folder-value">
                  <span className="folder-value__icon"><FolderIcon /></span>
                  <span>
                    <strong>{state?.directoryName ?? '尚未选择'}</strong>
                    <small>
                      {state?.directoryName
                        ? `权限：${permissionLabel(directoryPermission)}`
                        : '可以选择本机或 iCloud Drive 中的文件夹'}
                    </small>
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={Boolean(busy)}
                  onClick={() => void chooseDirectory()}
                >
                  {busy === 'directory'
                    ? '选择中…'
                    : state?.directoryName
                      ? '更换文件夹'
                      : '选择文件夹'}
                </button>
              </dd>
            </div>

            <div className="settings-row">
              <dt>最近一次备份</dt>
              <dd>
                <div className="backup-time">
                  <strong>{formatBackupTime(state?.lastSuccessfulBackupAt ?? null)}</strong>
                  {state?.lastBackupFileName && (
                    <small>Chrome 书签：{state.lastBackupFileName}</small>
                  )}
                  {state?.lastSavedPagesBackupFileName && (
                    <small>已保存网页：{state.lastSavedPagesBackupFileName}</small>
                  )}
                  {state?.lastReadingListBackupFileName && (
                    <small>好文收藏：{state.lastReadingListBackupFileName}</small>
                  )}
                  {state?.lastSettingsBackupFileName && (
                    <small>本机设置：{state.lastSettingsBackupFileName}</small>
                  )}
                  {state?.lastArchiveBackupFileName && (
                    <small>书签归档：{state.lastArchiveBackupFileName}</small>
                  )}
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    Boolean(busy) ||
                    !bookmarksPermission ||
                    !state?.directoryName
                  }
                  onClick={() => void runBackupNow()}
                >
                  {busy === 'backup' ? '备份中…' : '立即备份'}
                </button>
              </dd>
            </div>

            <div className="settings-row">
              <dt>最近每周备份</dt>
              <dd>
                <div className="backup-time">
                  <strong>
                    本机：{formatBackupTime(state?.lastWeeklyBackupAt ?? null)}
                  </strong>
                  {state?.lastWeeklyBackupFileName && (
                    <small>本机包：{state.lastWeeklyBackupFileName}</small>
                  )}
                  <strong className="backup-time__shared">
                    共享：{formatBackupTime(state?.lastSharedWeeklyBackupAt ?? null)}
                  </strong>
                  {state?.lastSharedWeeklyBackupFileName && (
                    <small>共享包：{state.lastSharedWeeklyBackupFileName}</small>
                  )}
                </div>
              </dd>
            </div>

            <div className="settings-row settings-row--rule">
              <dt>备份规则</dt>
              <dd>
                <div>
                  <strong>每日最新备份，每周保留历史</strong>
                  <p>
                    本机的已保存网页和设置、共享的好文收藏、Chrome 书签和书签归档分别写入五份
                    最新备份，每天覆盖。每周第一次成功备份时，本机和共享数据分别打包为
                    ZIP，每台电脑每类最多保留最近 10 份。只有五份文件全部写入并校验成功才算完成；
                    失败后当天继续尝试。归档和恢复时还会立即更新共享归档文件。
                  </p>
                </div>
              </dd>
            </div>
          </dl>

          {state?.directoryName &&
            ((bookmarksPermission && state.lastError) ||
              directoryPermission === 'prompt' ||
              directoryPermission === 'denied') && (
            <div className="settings-error" role="alert">
              <div>
                <strong>自动备份尚未完成</strong>
                <p>{state?.lastError || '备份文件夹需要重新授权。'}</p>
              </div>
              {state?.directoryName && directoryPermission !== 'granted' && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={Boolean(busy)}
                  onClick={() => void runBackupNow()}
                >
                  重新授权并备份
                </button>
              )}
            </div>
          )}
          </section>

          <section
            id="import-settings"
            className="settings-section"
            aria-labelledby="import-heading"
          >
            <div className="settings-section__heading">
              <h2 id="import-heading">导入数据</h2>
              <p>导入 Bok 保存网页、好文收藏或书签归档 JSON。</p>
            </div>
            <div className="settings-import">
              <div>
                <strong>导入保存网页、好文收藏或归档库</strong>
                <p>保存网页按分组去重合并；好文收藏按完整 URL 去重；归档记录始终作为新内容追加。</p>
              </div>
              <input
                ref={importInputRef}
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importData(event)}
              />
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(busy)}
                onClick={() => importInputRef.current?.click()}
              >
                {busy === 'import' ? '导入中…' : '选择文件并导入'}
              </button>
            </div>
          </section>

          <p className="settings-footnote">
            Chrome 只向 Bok 提供文件夹名称，不会显示完整路径。若选择 iCloud Drive，文件同步由
            macOS 和 iCloud 负责。
          </p>
        </main>
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {notice?.type === 'success' ? notice.message : ''}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {notice?.type === 'error' ? notice.message : ''}
      </div>
      {renderedNotice && (
        <div
          className={`settings-notice settings-notice--${renderedNotice.type}${noticeVisible ? ' is-visible' : ''}`}
          aria-hidden={!noticeVisible}
        >
          <span>{renderedNotice.message}</span>
          <button
            type="button"
            aria-label="关闭提示"
            tabIndex={noticeVisible ? 0 : -1}
            onClick={() => setNotice(null)}
          >
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
