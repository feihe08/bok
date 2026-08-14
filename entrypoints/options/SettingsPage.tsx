import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { browser } from 'wxt/browser';
import {
  BOOKMARK_BACKUP_STATE_KEY,
  chooseBookmarkBackupDirectory,
  getBookmarkBackupDirectoryPermission,
  getBookmarkBackupState,
  requestBookmarkBackupDirectoryPermission,
} from '../../libs/backup/backup';
import type {
  BookmarkBackupResponse,
  BookmarkBackupState,
  ImportDataResponse,
} from '../../libs/backup/model';

type Theme = 'light' | 'dark';
type DirectoryPermission = 'granted' | 'denied' | 'prompt' | 'missing';
type Notice = { type: 'success' | 'error'; message: string };
type SettingsSection = 'backup' | 'import';

const THEME_STORAGE_KEY = 'bok-theme';

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

export default function SettingsPage() {
  const [state, setState] = useState<BookmarkBackupState | null>(null);
  const [directoryPermission, setDirectoryPermission] =
    useState<DirectoryPermission>('missing');
  const [bookmarksPermission, setBookmarksPermission] = useState(false);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme | null>(storedTheme);
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    window.location.hash === '#import-settings' ? 'import' : 'backup',
  );
  const activeTheme = theme ?? systemTheme;

  const refresh = useCallback(async () => {
    const [nextState, nextDirectoryPermission, canReadBookmarks] =
      await Promise.all([
        getBookmarkBackupState(),
        getBookmarkBackupDirectoryPermission(),
        browser.permissions.contains({ permissions: ['bookmarks'] }),
      ]);
    setState(nextState);
    setDirectoryPermission(nextDirectoryPermission);
    setBookmarksPermission(canReadBookmarks);
  }, []);

  useEffect(() => {
    void refresh();
    void browser.runtime
      .sendMessage({ type: 'bok/bookmark-backup' })
      .then(refresh)
      .catch(() => undefined);

    function onStorageChanged(
      changes: Record<string, { newValue?: unknown }>,
      areaName: string,
    ) {
      if (areaName === 'local' && changes[BOOKMARK_BACKUP_STATE_KEY]) {
        void refresh();
      }
    }
    browser.storage.onChanged.addListener(onStorageChanged);
    return () => browser.storage.onChanged.removeListener(onStorageChanged);
  }, [refresh]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setSystemTheme(event.matches ? 'dark' : 'light');
    };
    mediaQuery.addEventListener('change', onChange);
    return () => mediaQuery.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    function onHashChange() {
      setActiveSection(
        window.location.hash === '#import-settings' ? 'import' : 'backup',
      );
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function toggleTheme() {
    const nextTheme = activeTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    setTheme(nextTheme);
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
    setNotice({ type: 'success', message: '三份最新备份已更新；每周历史包已按规则处理。' });
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
      } else {
        setNotice({
          type: 'success',
          message: `已导入 ${result.importedSessions} 个会话、${result.importedGroups} 个分组和 ${result.importedTabs} 个标签；跳过 ${result.skippedDuplicateGroups} 个重复分组；按超过一周规则归档 ${result.archivedGroups} 个分组${result.renamedGroups > 0 ? `；${result.renamedGroups} 个标签组因重名已追加数字后缀` : ''}。`,
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
            aria-pressed={activeTheme === 'dark'}
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
            <p>管理 Chrome 书签栏和 Bok 已保存网页的本地备份。</p>
          </header>

          <section
            id="backup-settings"
            className="settings-section"
            aria-labelledby="backup-heading"
          >
            <div className="settings-section__heading">
              <h2 id="backup-heading">本地备份</h2>
              <p>备份文件保存在你选择的文件夹，不会上传到 Bok 的服务器。</p>
            </div>

          {!bookmarksPermission && (
            <div className="settings-permission">
              <div>
                <strong>允许读取 Chrome 书签栏</strong>
                <p>只用于生成书签栏备份文件。</p>
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
                  <strong>{formatBackupTime(state?.lastWeeklyBackupAt ?? null)}</strong>
                  {state?.lastWeeklyBackupFileName && (
                    <small>历史包：{state.lastWeeklyBackupFileName}</small>
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
                    Chrome 书签、已保存网页和书签归档分别写入三个固定文件，每天覆盖。
                    每周第一次成功备份时，三个文件还会打包为 ZIP，最多保留最近 10 份。
                    只有写入和校验全部成功才算完成；失败后当天继续尝试。归档和恢复时
                    还会立即更新归档文件。
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
              <p>导入 Bok 保存网页或书签归档 JSON。</p>
            </div>
            <div className="settings-import">
              <div>
                <strong>导入保存网页或归档库</strong>
                <p>保存网页按分组去重合并；归档记录始终作为新内容追加。</p>
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
      {notice && (
        <div className={`settings-notice settings-notice--${notice.type}`}>
          <span>{notice.message}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
