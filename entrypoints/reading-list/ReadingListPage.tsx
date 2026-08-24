import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { ReadingListCommand, ReadingListResponse } from '../../libs/reading-list/messages';
import type { ReadingListItem } from '../../libs/reading-list/model';
import { READING_LIST_KEY, readReadingList } from '../../libs/reading-list/persistence';
import { AppHeader } from '../shared/AppHeader';
import { useBokTheme } from '../shared/useBokTheme';

type Notice = { type: 'success' | 'error'; message: string };
type PendingFocus = { targetId: string; fallbackId: string };

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function getDisplayUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function getFaviconFallback(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '').charAt(0).toUpperCase() || '•';
  } catch {
    return '•';
  }
}

function getFaviconUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const faviconUrl = new URL('/_favicon/', browser.runtime.getURL('/reading-list.html'));
    faviconUrl.searchParams.set('pageUrl', pageUrl);
    faviconUrl.searchParams.set('size', '32');
    return faviconUrl.toString();
  } catch {
    return null;
  }
}

function formatSavedDate(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const source = getFaviconUrl(url);

  if (!source || failed) {
    return <span className="reading-item__favicon" aria-hidden="true">{getFaviconFallback(url)}</span>;
  }

  return (
    <span className="reading-item__favicon" aria-hidden="true">
      <img src={source} alt="" width="20" height="20" loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

export default function ReadingListPage() {
  const [items, setItems] = useState<ReadingListItem[]>([]);
  const [searchValue, setSearchValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [editingId, setEditingId] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [savingId, setSavingId] = useState('');
  const [deleteCandidateId, setDeleteCandidateId] = useState('');
  const [deletingId, setDeletingId] = useState('');
  const [randomOpening, setRandomOpening] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const { theme: activeTheme, toggleTheme } = useBokTheme();
  const searchRef = useRef<HTMLInputElement>(null);
  const focusRevisionRef = useRef(0);

  const searchTerms = useMemo(
    () => normalizeSearchText(searchValue).split(/\s+/).filter(Boolean),
    [searchValue],
  );
  const visibleItems = useMemo(() => {
    if (searchTerms.length === 0) return items;
    return items.filter((item) => {
      const haystack = normalizeSearchText(`${item.title}\n${item.url}\n${item.note}`);
      return searchTerms.every((term) => haystack.includes(term));
    });
  }, [items, searchTerms]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await readReadingList();
        if (cancelled) return;
        setItems(result.items);
        setLoadError('');
      } catch (error) {
        if (cancelled) return;
        console.error('[bok] failed to load reading list', error);
        setLoadError(
          error instanceof Error && error.message
            ? error.message
            : '无法读取好文列表，请稍后重试。',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    const handleStorageChange: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName === 'local' && changes[READING_LIST_KEY]) void load();
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handleFocusIn = () => {
      focusRevisionRef.current += 1;
    };
    document.addEventListener('focusin', handleFocusIn);
    return () => document.removeEventListener('focusin', handleFocusIn);
  }, []);

  useEffect(() => {
    if (!editingId) return;
    requestAnimationFrame(() => document.getElementById(`reading-note-${editingId}`)?.focus());
  }, [editingId]);

  useEffect(() => {
    if (!deleteCandidateId) return;
    requestAnimationFrame(() =>
      document.getElementById(`reading-delete-confirm-${deleteCandidateId}`)?.focus(),
    );
  }, [deleteCandidateId]);

  useEffect(() => {
    if (!notice || notice.type === 'error') return;
    const timeoutId = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => {
    if (!pendingFocus || savingId || deletingId) return;
    const frameId = requestAnimationFrame(() => {
      const target = document.getElementById(pendingFocus.targetId)
        ?? document.getElementById(pendingFocus.fallbackId);
      target?.focus();
      setPendingFocus(null);
    });
    return () => cancelAnimationFrame(frameId);
  }, [deletingId, items, pendingFocus, savingId]);

  async function runCommand(command: ReadingListCommand) {
    const response = await browser.runtime.sendMessage(command) as ReadingListResponse;
    if (!response?.ok) throw new Error(response?.error || '操作失败，请稍后重试。');
    return response.result;
  }

  function showCommandError(action: string, error: unknown) {
    console.error(`[bok] failed to ${action} reading list item`, error);
    setNotice({
      type: 'error',
      message: error instanceof Error && error.message ? error.message : `${action}失败，请稍后重试。`,
    });
  }

  function focusItemAction(itemId: string, action: 'note' | 'delete') {
    requestAnimationFrame(() =>
      document.getElementById(`reading-item-${action}-${itemId}`)?.focus(),
    );
  }

  function retryLoad() {
    setLoadError('');
    setLoading(true);
    setRetryCount((count) => count + 1);
  }

  function startEditing(item: ReadingListItem) {
    if (savingId || deletingId) return;
    setDeleteCandidateId('');
    setEditingId(item.id);
    setNoteDraft(item.note);
  }

  function cancelEditing(itemId: string) {
    setEditingId('');
    setNoteDraft('');
    focusItemAction(itemId, 'note');
  }

  async function saveNote(item: ReadingListItem) {
    if (savingId) return;
    if (noteDraft === item.note) {
      cancelEditing(item.id);
      return;
    }

    const submittedNote = noteDraft;
    const focusRevision = focusRevisionRef.current;
    setSavingId(item.id);
    try {
      await runCommand({ type: 'bok/reading-list/update-note', id: item.id, note: submittedNote });
      const shouldRestoreFocus = focusRevisionRef.current === focusRevision;
      setItems((current) => current.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, note: submittedNote, updatedAt: Date.now() }
          : candidate,
      ));
      setEditingId('');
      setNoteDraft('');
      if (shouldRestoreFocus) {
        setPendingFocus({
          targetId: `reading-item-note-${item.id}`,
          fallbackId: 'reading-list-content',
        });
      }
      setNotice({ type: 'success', message: '备注已保存。' });
    } catch (error) {
      showCommandError('保存备注', error);
    } finally {
      setSavingId('');
    }
  }

  function startDeleting(item: ReadingListItem) {
    if (savingId || deletingId) return;
    setEditingId('');
    setNoteDraft('');
    setDeleteCandidateId(item.id);
  }

  function cancelDeleting(itemId: string) {
    setDeleteCandidateId('');
    focusItemAction(itemId, 'delete');
  }

  async function deleteItem(item: ReadingListItem) {
    if (deletingId) return;
    const focusRevision = focusRevisionRef.current;
    setDeletingId(item.id);
    const itemIndex = visibleItems.findIndex((candidate) => candidate.id === item.id);
    const nextFocusItemId =
      visibleItems[itemIndex + 1]?.id ?? visibleItems[itemIndex - 1]?.id ?? '';
    try {
      await runCommand({ type: 'bok/reading-list/delete-item', id: item.id });
      const shouldRestoreFocus = focusRevisionRef.current === focusRevision;
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      setDeleteCandidateId('');
      setNotice({ type: 'success', message: `已删除“${item.title || getDisplayUrl(item.url)}”。` });
      if (shouldRestoreFocus) {
        setPendingFocus({
          targetId: nextFocusItemId
            ? `reading-item-title-${nextFocusItemId}`
            : 'reading-list-content',
          fallbackId: 'reading-list-content',
        });
      }
    } catch (error) {
      showCommandError('删除好文', error);
    } finally {
      setDeletingId('');
    }
  }

  async function openRandom() {
    if (randomOpening || items.length === 0) return;
    setRandomOpening(true);
    try {
      const result = await runCommand({ type: 'bok/reading-list/open-random' });
      setNotice(
        result?.opened
          ? { type: 'success', message: '已在新标签页打开一篇好文。' }
          : { type: 'error', message: '还没有可随机打开的好文。' },
      );
    } catch (error) {
      showCommandError('随机打开好文', error);
    } finally {
      setRandomOpening(false);
    }
  }

  return (
    <div className="reading-list-page">
      <a className="reading-skip-link" href="#reading-list-content">跳到好文列表</a>

      <AppHeader
        activeSection="reading-list"
        search={{
          label: '搜索好文',
          placeholder: '搜索标题、URL 或备注',
          value: searchValue,
          inputRef: searchRef,
          ariaKeyShortcuts: 'Control+K Meta+K',
          onChange: (event) => setSearchValue(event.target.value),
        }}
        theme={activeTheme}
        onToggleTheme={toggleTheme}
      />

      <main id="reading-list-content" className="reading-content" tabIndex={-1}>
        <header className="reading-content__header">
          <h1 className="reading-sr-only">好文</h1>
          <span className="reading-sr-only" aria-live="polite">
            {searchTerms.length > 0 ? `${visibleItems.length} / ${items.length} 篇文章` : `${items.length} 篇文章`}
          </span>
          <button
            type="button"
            className="reading-random-button"
            disabled={items.length === 0 || randomOpening}
            onClick={() => void openRandom()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3.25 5.5h2.1c1.42 0 2.73.78 3.42 2.02l.76 1.38c.69 1.24 2 2.02 3.42 2.02h3.15" />
              <path d="m14.5 8.4 1.95 2.52-1.95 2.52" />
              <path d="M3.25 14.5h2.1c1.42 0 2.73-.78 3.42-2.02l.76-1.38c.69-1.24 2-2.02 3.42-2.02h3.15" />
              <path d="m14.5 3.56 1.95 2.52-1.95 2.52" />
            </svg>
            {randomOpening ? '打开中…' : '随机读一篇'}
          </button>
        </header>

        {loadError ? (
          <section className="reading-empty-state reading-empty-state--error" role="alert">
            <h2>读取失败</h2>
            <p>{loadError}</p>
            <button type="button" className="reading-empty-action" onClick={retryLoad}>
              重新读取
            </button>
          </section>
        ) : loading ? (
          <section className="reading-empty-state" role="status">
            <h2>正在读取好文</h2>
            <p>正在加载你保存的长期好文。</p>
          </section>
        ) : items.length === 0 ? (
          <section className="reading-empty-state">
            <h2>还没有好文</h2>
            <p>在网页上打开菜单，选择「收藏」，以后想读时再回来挑一篇。</p>
          </section>
        ) : visibleItems.length === 0 ? (
          <section className="reading-empty-state">
            <h2>没有匹配的好文</h2>
            <p>试试标题、URL 或你写下的备注。</p>
            <button type="button" className="reading-empty-action" onClick={() => setSearchValue('')}>清除搜索</button>
          </section>
        ) : (
          <ol className="reading-list" aria-label="好文列表">
            {visibleItems.map((item) => {
              const isEditing = editingId === item.id;
              const isConfirmingDelete = deleteCandidateId === item.id;
              const isSaving = savingId === item.id;
              const isDeleting = deletingId === item.id;
              const displayTitle = item.title.trim() || getDisplayUrl(item.url);
              const titleId = `reading-item-title-${item.id}`;
              const domainId = `reading-item-domain-${item.id}`;
              const dateId = `reading-item-date-${item.id}`;
              const noteId = `reading-item-note-${item.id}`;
              const noteLabelId = `reading-item-note-label-${item.id}`;
              const deleteHeadingId = `reading-item-delete-heading-${item.id}`;
              const deleteDescriptionId = `reading-item-delete-description-${item.id}`;
              return (
                <li key={item.id} className="reading-list__item">
                  <article
                    className="reading-item"
                    aria-labelledby={titleId}
                    aria-describedby={`${domainId} ${dateId} ${noteId}`}
                  >
                    <Favicon url={item.url} />
                    <div className="reading-item__main">
                      <a
                        id={titleId}
                        className="reading-item__title"
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {displayTitle}
                      </a>
                      <span
                        id={domainId}
                        className="reading-item__domain"
                        dir="ltr"
                        title={item.url}
                      >
                        {item.url}
                      </span>
                    </div>
                    <time
                      id={dateId}
                      className="reading-item__date"
                      dateTime={new Date(item.createdAt).toISOString()}
                      aria-label={`收藏于 ${formatSavedDate(item.createdAt)}`}
                    >
                      {formatSavedDate(item.createdAt)}
                    </time>
                    <div className="reading-item__actions" role="group" aria-label={`“${displayTitle}”的操作`}>
                      <button
                        id={`reading-item-delete-${item.id}`}
                        type="button"
                        className="reading-item__action reading-item__action--delete"
                        disabled={Boolean(savingId || deletingId)}
                        aria-label={`删除“${displayTitle}”`}
                        onClick={() => startDeleting(item)}
                      >
                        删除
                      </button>
                    </div>

                    {isEditing ? (
                      <div
                        id={noteId}
                        className="reading-item__editor"
                      >
                        <label id={noteLabelId} htmlFor={`reading-note-${item.id}`}>给未来的自己留一句备注</label>
                        <textarea
                          id={`reading-note-${item.id}`}
                          value={noteDraft}
                          rows={3}
                          aria-labelledby={`${titleId} ${noteLabelId}`}
                          aria-keyshortcuts="Enter Escape"
                          aria-busy={isSaving}
                          readOnly={isSaving}
                          onChange={(event) => setNoteDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing) return;
                            if (event.key === 'Escape' && !isSaving) {
                              event.preventDefault();
                              cancelEditing(item.id);
                              return;
                            }
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              void saveNote(item);
                            }
                          }}
                        />
                        <div className="reading-item__editor-actions">
                          <button
                            type="button"
                            className="reading-inline-button"
                            aria-disabled={isSaving}
                            onClick={() => void saveNote(item)}
                          >
                            {isSaving ? '保存中…' : '保存'}
                          </button>
                          <button
                            type="button"
                            className="reading-inline-button reading-inline-button--secondary"
                            disabled={isSaving}
                            onClick={() => cancelEditing(item.id)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        id={noteId}
                        type="button"
                        className={`reading-item__note${item.note ? '' : ' reading-item__note--empty'}`}
                        disabled={Boolean(savingId || deletingId)}
                        aria-label={`编辑“${displayTitle}”的备注：${item.note || '尚未添加备注'}`}
                        onClick={() => startEditing(item)}
                      >
                        <span className="reading-item__note-text">
                          {item.note || '尚未添加备注'}
                        </span>
                      </button>
                    )}

                    {isConfirmingDelete && (
                      <section
                        id={`reading-item-delete-confirmation-${item.id}`}
                        className="reading-item__delete-confirmation"
                        aria-labelledby={deleteHeadingId}
                        aria-describedby={deleteDescriptionId}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape' || isDeleting) return;
                          event.preventDefault();
                          cancelDeleting(item.id);
                        }}
                      >
                        <strong id={deleteHeadingId}>确认删除“{displayTitle}”？</strong>
                        <p id={deleteDescriptionId}>删除后无法恢复，备注也会一并移除。</p>
                        <div className="reading-item__delete-actions">
                          <button
                            id={`reading-delete-confirm-${item.id}`}
                            type="button"
                            className="reading-inline-button reading-inline-button--danger"
                            aria-label={`确认删除“${displayTitle}”`}
                            aria-disabled={isDeleting}
                            onClick={() => void deleteItem(item)}
                          >
                            {isDeleting ? '删除中…' : '删除'}
                          </button>
                          <button
                            type="button"
                            className="reading-inline-button reading-inline-button--secondary"
                            aria-label={`取消删除“${displayTitle}”`}
                            disabled={isDeleting}
                            onClick={() => cancelDeleting(item.id)}
                          >
                            取消
                          </button>
                        </div>
                      </section>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </main>

      <div className={`reading-live-region${notice?.type === 'error' ? ' reading-live-region--error' : ''}`} role="status" aria-live="polite" aria-atomic="true" hidden={!notice}>
        <span>{notice?.message}</span>
        {notice && <button type="button" onClick={() => setNotice(null)}>关闭</button>}
      </div>
    </div>
  );
}
