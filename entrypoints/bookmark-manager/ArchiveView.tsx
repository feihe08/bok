import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type {
  ArchivedFolder,
  ArchivedNode,
  BookmarkArchiveRecord,
} from '../../libs/bookmarks/model';
import type { LegacyArchiveMigrationInfo } from '../../libs/bookmarks/archive';

const FORMAT_CHARACTERS = /\p{Cf}/gu;

function displayTitle(title: string, fallback: string): string {
  return title.normalize('NFKC').replace(FORMAT_CHARACTERS, '').trim() || fallback;
}

function faviconUrl(pageUrl: string): string | null {
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const favicon = new URL('/_favicon/', browser.runtime.getURL('/bookmark-manager.html'));
    favicon.searchParams.set('pageUrl', pageUrl);
    favicon.searchParams.set('size', '32');
    return favicon.toString();
  } catch {
    return null;
  }
}

function ArchivedFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const source = faviconUrl(url);
  if (!source || failed) {
    let fallback = '•';
    try {
      fallback = new URL(url).hostname.replace(/^www\./, '').charAt(0).toUpperCase() || '•';
    } catch {
      // Keep the neutral fallback for non-standard URLs.
    }
    return <span className="bookmark-favicon bookmark-favicon--fallback">{fallback}</span>;
  }
  return (
    <img
      className="bookmark-favicon"
      src={source}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function formatArchivedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function archiveMatches(record: BookmarkArchiveRecord, query: string): boolean {
  if (!query) return true;
  function matches(node: ArchivedNode, path: string[]): boolean {
    const nextPath = [
      ...path,
      displayTitle(node.title, node.kind === 'folder' ? '未命名文件夹' : node.url),
    ];
    if (nextPath.join(' / ').toLocaleLowerCase().includes(query)) return true;
    if (node.kind === 'bookmark' && node.url.toLocaleLowerCase().includes(query)) return true;
    return node.kind === 'folder' && node.children.some((child) => matches(child, nextPath));
  }
  return matches(record.root, []);
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2.5 5.5h5l1.5 2h8.5v7.5H2.5z" />
    </svg>
  );
}

function getArchiveColumns(root: ArchivedFolder, selectedPath: number[]) {
  const columns: Array<{ folder: ArchivedFolder; path: number[] }> = [
    { folder: root, path: [] },
  ];
  let folder = root;
  for (let depth = 0; depth < selectedPath.length; depth += 1) {
    const childIndex = selectedPath[depth];
    const child = folder.children[childIndex];
    if (!child || child.kind !== 'folder') break;
    const path = selectedPath.slice(0, depth + 1);
    columns.push({ folder: child, path });
    folder = child;
  }
  return columns;
}

export function ArchiveView({
  archives,
  query,
  busyId,
  legacyMigration,
  onRestore,
  onMigrateLegacy,
}: {
  archives: BookmarkArchiveRecord[];
  query: string;
  busyId: string;
  legacyMigration: LegacyArchiveMigrationInfo | null;
  onRestore: (archiveId: string) => void;
  onMigrateLegacy: () => void;
}) {
  const [selectedArchiveId, setSelectedArchiveId] = useState('');
  const [selectedFolderPath, setSelectedFolderPath] = useState<number[]>([]);
  const visibleArchives = archives
    .filter((record) => record.status !== 'pending-removal')
    .filter((record) => archiveMatches(record, query));
  const selectedArchive =
    visibleArchives.find((record) => record.id === selectedArchiveId) ??
    visibleArchives[0] ??
    null;
  const selectedArchiveKey = selectedArchive?.id ?? '';
  const columns = selectedArchive
    ? getArchiveColumns(selectedArchive.root, selectedFolderPath)
    : [];

  useEffect(() => {
    setSelectedFolderPath([]);
  }, [selectedArchiveKey]);

  function selectArchive(archiveId: string) {
    setSelectedArchiveId(archiveId);
    setSelectedFolderPath([]);
  }

  return (
    <div className="archive-view">
      <h1 className="sr-only">归档库</h1>

      {legacyMigration && (
        <section className="archive-migration" aria-labelledby="archive-migration-heading">
          <div>
            <h2 id="archive-migration-heading">发现旧版归档</h2>
            <p>
              Chrome 的“Bok 归档”中有 {legacyMigration.folderCount} 个文件夹。
              迁移会先写入并校验归档备份，再从 Chrome 移除这些文件夹。
            </p>
            {legacyMigration.bookmarkCount > 0 && (
              <p>其中另有 {legacyMigration.bookmarkCount} 个直属书签，会保留在 Chrome 中。</p>
            )}
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busyId) || legacyMigration.folderCount === 0}
            onClick={onMigrateLegacy}
          >
            {busyId === 'legacy-migration' ? '迁移中…' : '迁移旧归档'}
          </button>
        </section>
      )}

      {visibleArchives.length === 0 ? (
        <section className="bookmark-empty-state">
          <h2>{query ? '没有匹配的归档' : '还没有归档文件夹'}</h2>
          <p>
            {query
              ? '试试文件夹名称、书签标题或完整网址。'
              : '从书签文件夹的更多操作中选择“归档”，之后可以随时在这里浏览和恢复。'}
          </p>
        </section>
      ) : (
        <div className="archive-browser">
          <nav className="archive-roots" aria-label="归档根文件夹">
            <ol className="archive-roots__list">
              {visibleArchives.map((record) => {
                const selected = record.id === selectedArchive?.id;
                const title = displayTitle(record.root.title, '未命名文件夹');
                return (
                  <li
                    key={record.id}
                    className={`archive-root-row${selected ? ' is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      aria-current={selected ? 'location' : undefined}
                      title={title}
                      onClick={() => selectArchive(record.id)}
                    >
                      <span className="archive-root-row__icon">
                        <FolderIcon />
                      </span>
                      <span>{title}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          {selectedArchive && (
            <section className="archive-detail" aria-label={displayTitle(selectedArchive.root.title, '未命名文件夹')}>
              <header className="archive-detail__toolbar">
                <button
                  type="button"
                  className="archive-detail__back"
                  disabled={selectedFolderPath.length === 0}
                  onClick={() => setSelectedFolderPath((path) => path.slice(0, -1))}
                >
                  上一级
                </button>
                <div className="archive-detail__meta">
                  <span>归档于 {formatArchivedAt(selectedArchive.archivedAt)}</span>
                  <span
                    className="archive-detail__source"
                    title={['书签栏', ...selectedArchive.source.parentPath].join(' / ')}
                  >
                    原位置：{['书签栏', ...selectedArchive.source.parentPath].join(' / ')}
                  </span>
                </div>
                <button
                  type="button"
                  className="archive-detail__restore"
                  disabled={Boolean(busyId) || selectedArchive.status !== 'archived'}
                  onClick={() => onRestore(selectedArchive.id)}
                >
                  {busyId === selectedArchive.id
                    ? '恢复中…'
                    : selectedArchive.status === 'restore-conflict'
                      ? '需要检查'
                      : selectedArchive.status === 'pending-restore'
                        ? '正在完成恢复'
                        : '恢复到 Chrome'}
                </button>
              </header>

              <div className="bookmark-columns archive-columns" aria-label="归档分栏">
                {columns.map(({ folder, path }, columnIndex) => (
                  <div
                    key={`${selectedArchive.id}:${path.join('.') || 'root'}`}
                    className="bookmark-column archive-column"
                    aria-label={displayTitle(folder.title, '未命名文件夹')}
                  >
                    {folder.children.length > 0 ? (
                      <ol className="bookmark-column__list">
                        {folder.children.map((node, childIndex) => {
                          const itemKey = `${selectedArchive.id}:${[...path, childIndex].join('.')}`;
                          if (node.kind === 'folder') {
                            const selected = selectedFolderPath[columnIndex] === childIndex;
                            return (
                              <li
                                key={itemKey}
                                className={`bookmark-column-row bookmark-column-row--folder${selected ? ' is-selected' : ''}`}
                              >
                                <button
                                  type="button"
                                  className="bookmark-column-row__main"
                                  aria-current={selected ? 'location' : undefined}
                                  title={displayTitle(node.title, '未命名文件夹')}
                                  onClick={() => setSelectedFolderPath([...path, childIndex])}
                                >
                                  <span className="bookmark-column-row__icon bookmark-column-row__icon--folder">
                                    <FolderIcon />
                                  </span>
                                  <span className="bookmark-column-row__body">
                                    <span className="bookmark-column-row__title">
                                      {displayTitle(node.title, '未命名文件夹')}
                                    </span>
                                  </span>
                                  <svg className="bookmark-column-row__chevron" viewBox="0 0 20 20" aria-hidden="true">
                                    <path d="m7.5 5.5 5 4.5-5 4.5" />
                                  </svg>
                                </button>
                              </li>
                            );
                          }
                          const title = displayTitle(node.title, node.url);
                          return (
                            <li key={itemKey} className="bookmark-column-row">
                              <a
                                className="bookmark-column-row__main"
                                href={node.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`在新标签页打开：${title}`}
                                title={node.url}
                              >
                                <span className="bookmark-column-row__icon">
                                  <ArchivedFavicon url={node.url} />
                                </span>
                                <span className="bookmark-column-row__body">
                                  <span className="bookmark-column-row__title">{title}</span>
                                  <span className="bookmark-column-row__meta archive-bookmark-row__url">
                                    {node.url}
                                  </span>
                                </span>
                              </a>
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      <div className="bookmark-column__empty">
                        <FolderIcon />
                        <p>这个文件夹是空的</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
