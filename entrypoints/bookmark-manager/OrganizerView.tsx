import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  BookmarkOrganizerCandidate,
  BookmarkOrganizerRound,
  BookmarkOrganizerStore,
  BookmarkOrganizerSuggestion,
} from '../../libs/bookmarks/organizer-storage';

export interface OrganizerFolderOption {
  id: string;
  path: string;
}

export interface OrganizerViewProps {
  store: BookmarkOrganizerStore;
  round: BookmarkOrganizerRound | null;
  folders: OrganizerFolderOption[];
  selectedCandidateId: string;
  focusCandidateId?: string | null;
  busy: boolean;
  aiBusyAction: 'generate' | 'retry' | null;
  error: string;
  aiConfigured: boolean;
  onSelectCandidate: (bookmarkId: string) => void;
  onGenerateSuggestions: () => void;
  onCompleteRound: () => void;
  onAcceptSuggestion: (bookmarkId: string) => void;
  onMoveAndKeep: (bookmarkId: string, folderId: string) => void;
  onKeepCurrent: (bookmarkId: string) => void;
  onDiscard: (bookmarkId: string) => void;
  onDefer: (bookmarkId: string) => void;
  onRetrySuggestion: (bookmarkId: string) => void;
}

type CandidateState = 'pending' | 'processed' | 'deferred';

const changeLabels: Record<BookmarkOrganizerCandidate['changeTypes'][number], string> = {
  created: '新建',
  'title-changed': '标题变更',
  'url-changed': '网址变更',
  moved: '移动目录',
  'ancestor-changed': '上级目录变更',
};

const decisionLabels = {
  keep: '已保留',
  remove: '已处理为无需长期保存',
  unsure: '已处理为不确定',
} as const;

const retentionLabels = {
  keep: '建议保留',
  discard: '建议无需长期保存',
  unsure: '需要你决定',
} as const;

function formatDate(value: number | undefined): string {
  if (value == null) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function getCurrentDirectory(candidate: BookmarkOrganizerCandidate): string {
  return candidate.folderPath.map((folder) => folder.title).join(' / ') || '书签栏';
}

function getSuggestion(
  candidate: BookmarkOrganizerCandidate,
): BookmarkOrganizerSuggestion | null {
  return candidate.suggestion?.candidateRevision === candidate.revision
    ? candidate.suggestion
    : null;
}

function getCandidateState(
  candidate: BookmarkOrganizerCandidate,
  store: BookmarkOrganizerStore,
  round: BookmarkOrganizerRound,
): CandidateState {
  if (round.deferredBookmarkIds.includes(candidate.bookmarkId)) return 'deferred';
  return store.decisions[candidate.bookmarkId]?.candidateRevision === candidate.revision
    ? 'processed'
    : 'pending';
}

function getStateLabel(
  state: CandidateState,
  candidate: BookmarkOrganizerCandidate,
  store: BookmarkOrganizerStore,
): string {
  if (state === 'pending') return '待处理';
  if (state === 'deferred') return '稍后决定';
  const decision = store.decisions[candidate.bookmarkId];
  return decision ? decisionLabels[decision.decision] : '已处理';
}

export function OrganizerView({
  store,
  round,
  folders,
  selectedCandidateId,
  focusCandidateId,
  busy,
  aiBusyAction,
  error,
  aiConfigured,
  onSelectCandidate,
  onGenerateSuggestions,
  onCompleteRound,
  onAcceptSuggestion,
  onMoveAndKeep,
  onKeepCurrent,
  onDiscard,
  onDefer,
  onRetrySuggestion,
}: OrganizerViewProps) {
  const candidateButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const roundCandidates = useMemo(
    () =>
      round?.candidateIds
        .map((bookmarkId) => store.candidates[bookmarkId])
        .filter((candidate): candidate is BookmarkOrganizerCandidate => Boolean(candidate)) ?? [],
    [round, store.candidates],
  );
  const selectedCandidate =
    roundCandidates.find((candidate) => candidate.bookmarkId === selectedCandidateId) ??
    roundCandidates[0] ??
    null;
  const [selectedFolderId, setSelectedFolderId] = useState('');
  const selectedCandidateRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focusCandidateId) return;
    const frame = requestAnimationFrame(() => {
      candidateButtonRefs.current.get(focusCandidateId)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusCandidateId, roundCandidates]);

  useEffect(() => {
    if (!selectedCandidate) {
      selectedCandidateRef.current = null;
      setSelectedFolderId('');
      return;
    }
    const fallbackFolderId =
      folders.find((folder) => folder.id === selectedCandidate.parentId)?.id ??
      folders[0]?.id ??
      '';
    if (
      selectedCandidateRef.current !== selectedCandidate.bookmarkId ||
      !folders.some((folder) => folder.id === selectedFolderId)
    ) {
      selectedCandidateRef.current = selectedCandidate.bookmarkId;
      setSelectedFolderId(fallbackFolderId);
    }
  }, [folders, selectedCandidate, selectedFolderId]);

  if (!round) {
    return (
      <section className="organizer-empty-state" aria-labelledby="organizer-empty-heading">
        <h1 id="organizer-empty-heading">书签整理</h1>
        <p>开始一轮整理后，Bok 会按固定范围列出待审核的书签变化。</p>
      </section>
    );
  }

  const processedCount = roundCandidates.filter(
    (candidate) => getCandidateState(candidate, store, round) !== 'pending',
  ).length;
  const pendingCount = roundCandidates.filter(
    (candidate) => getCandidateState(candidate, store, round) === 'pending',
  ).length;
  const unsuggestedCount = roundCandidates.filter(
    (candidate) =>
      getCandidateState(candidate, store, round) === 'pending' &&
      getSuggestion(candidate) === null,
  ).length;
  const canComplete = pendingCount === 0;

  return (
    <section className="organizer-view" aria-labelledby="organizer-heading">
      <p className="sr-only" role="status">
        {aiBusyAction === 'generate'
          ? '正在生成 AI 建议。'
          : aiBusyAction === 'retry'
            ? '正在重新生成 AI 建议。'
            : ''}
      </p>
      <header className="organizer-view__header">
        <div>
          <h1 id="organizer-heading">审核本轮</h1>
          <p role="status">
            已处理 {processedCount} / {roundCandidates.length}
            {round.deferredBookmarkIds.length > 0
              ? ` · ${round.deferredBookmarkIds.length} 项稍后决定`
              : ''}
          </p>
          {store.tracking.gap?.recoveredAt !== undefined && (
            <p className="organizer-view__warning" role="status">
              权限中断期间的变化无法还原，已从重新授权时建立新基线。
            </p>
          )}
        </div>
        <div className="organizer-view__header-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !aiConfigured || unsuggestedCount === 0}
            title={aiConfigured ? undefined : '请先在设置中配置 AI'}
            aria-busy={aiBusyAction === 'generate' ? true : undefined}
            onClick={onGenerateSuggestions}
          >
            {aiBusyAction === 'generate' ? '生成 AI 建议中…' : '生成 AI 建议'}
          </button>
          {canComplete && (
            <button
              id="organizer-complete-round"
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={onCompleteRound}
            >
              完成本轮
            </button>
          )}
        </div>
      </header>

      {roundCandidates.length === 0 ? (
        <section className="organizer-empty-state" aria-labelledby="organizer-empty-heading">
          <h2 id="organizer-empty-heading">本轮没有待审核书签</h2>
          <p>此轮范围内没有可处理的书签变化。</p>
        </section>
      ) : (
        <div className="organizer-workspace">
          <aside className="organizer-queue" aria-label="候选队列">
            <ol className="organizer-queue__list">
              {roundCandidates.map((candidate) => {
                const state = getCandidateState(candidate, store, round);
                const suggestion = getSuggestion(candidate);
                return (
                  <li key={candidate.bookmarkId}>
                    <button
                      id={`organizer-candidate-${candidate.bookmarkId}`}
                      ref={(element) => {
                        if (element) candidateButtonRefs.current.set(candidate.bookmarkId, element);
                        else candidateButtonRefs.current.delete(candidate.bookmarkId);
                      }}
                      type="button"
                      className="organizer-queue__candidate"
                      aria-current={
                        candidate.bookmarkId === selectedCandidate?.bookmarkId ? 'true' : undefined
                      }
                      disabled={busy}
                      onClick={() => onSelectCandidate(candidate.bookmarkId)}
                    >
                      <span className="organizer-queue__title">{candidate.title || '未命名书签'}</span>
                      <span className="organizer-queue__domain">{getDomain(candidate.url)}</span>
                      <span className="organizer-queue__meta">
                        {candidate.changeTypes.map((type) => changeLabels[type]).join(' · ')}
                      </span>
                      <span className="organizer-queue__state">{getStateLabel(state, candidate, store)}</span>
                      <span className="organizer-queue__ai-state">
                        {suggestion ? retentionLabels[suggestion.retention] : 'AI 未生成'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </aside>

          {selectedCandidate && (() => {
            const state = getCandidateState(selectedCandidate, store, round);
            const suggestion = getSuggestion(selectedCandidate);
            const currentDirectory = getCurrentDirectory(selectedCandidate);
            const suggestedDirectory = suggestion?.directory ??
              (suggestion?.retention === 'discard'
                ? '无需移动目录'
                : suggestion?.retention === 'unsure'
                  ? '未确定目录'
                  : '尚无 AI 建议目录');
            const canAcceptSuggestion =
              suggestion !== null && suggestion.retention !== 'unsure' && state === 'pending';
            const manualActionsAvailable = state === 'pending';
            const errorId = 'organizer-current-error';

            return (
              <article className="organizer-detail" aria-labelledby="organizer-detail-heading">
                <header className="organizer-detail__header">
                  <div>
                    <p className="organizer-detail__eyebrow">当前候选</p>
                    <h2 id="organizer-detail-heading">
                      {selectedCandidate.title || '未命名书签'}
                    </h2>
                  </div>
                  <span className="organizer-detail__state">
                    {getStateLabel(state, selectedCandidate, store)}
                  </span>
                </header>

                <div className="organizer-detail__content">
                  <a
                    className="organizer-detail__url"
                    href={selectedCandidate.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {selectedCandidate.url}
                  </a>

                  <dl className="organizer-detail__facts">
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDate(selectedCandidate.dateAdded)}</dd>
                    </div>
                    <div>
                      <dt>最近使用</dt>
                      <dd>{formatDate(selectedCandidate.dateLastUsed)}</dd>
                    </div>
                    <div className="organizer-detail__fact-wide">
                      <dt>变化</dt>
                      <dd>{selectedCandidate.changeTypes.map((type) => changeLabels[type]).join('、')}</dd>
                    </div>
                    <div className="organizer-detail__fact-wide">
                      <dt>目录</dt>
                      <dd>
                        <span>{currentDirectory}</span>
                        <span className="organizer-detail__directory-arrow" aria-hidden="true">→</span>
                        <strong>{suggestedDirectory}</strong>
                      </dd>
                    </div>
                  </dl>

                  <section className="organizer-suggestion" aria-labelledby="organizer-suggestion-heading">
                    <h3 id="organizer-suggestion-heading">AI 建议</h3>
                    {suggestion ? (
                      <>
                        <p className="organizer-suggestion__retention">
                          {retentionLabels[suggestion.retention]}
                        </p>
                        <p>{suggestion.reason}</p>
                        {suggestion.retention === 'unsure' && (
                          <p className="organizer-suggestion__notice">需要你决定，不能直接接受此建议。</p>
                        )}
                      </>
                    ) : (
                      <p>{aiConfigured ? '尚未生成建议。你仍可直接手动决定。' : '尚未配置 AI。你仍可直接手动决定。'}</p>
                    )}
                  </section>

                  {error && (
                    <p id={errorId} className="organizer-detail__error" role="alert">
                      {error}
                    </p>
                  )}

                  <section className="organizer-actions" aria-labelledby="organizer-actions-heading">
                    <h3 id="organizer-actions-heading">处理此书签</h3>
                    <div className="organizer-actions__primary">
                      {canAcceptSuggestion && (
                        <button
                          type="button"
                          className={
                            suggestion.retention === 'discard'
                              ? 'organizer-danger-button'
                              : 'primary-button'
                          }
                          disabled={busy}
                          aria-describedby={error ? errorId : undefined}
                          onClick={() => {
                            if (suggestion.retention === 'discard') {
                              onDiscard(selectedCandidate.bookmarkId);
                              return;
                            }
                            onAcceptSuggestion(selectedCandidate.bookmarkId);
                          }}
                        >
                          {suggestion.retention === 'discard' ? '删除书签' : '接受建议'}
                        </button>
                      )}
                      <label className="organizer-actions__directory">
                        <span>选择现有目录</span>
                        <select
                          value={selectedFolderId}
                          disabled={busy || !manualActionsAvailable || folders.length === 0}
                          onChange={(event) => setSelectedFolderId(event.target.value)}
                        >
                          {folders.length === 0 ? (
                            <option value="">没有可用目录</option>
                          ) : (
                            folders.map((folder) => (
                              <option key={folder.id} value={folder.id}>
                                {folder.path}
                              </option>
                            ))
                          )}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || !manualActionsAvailable || !selectedFolderId}
                        aria-describedby={error ? errorId : undefined}
                        onClick={() => onMoveAndKeep(selectedCandidate.bookmarkId, selectedFolderId)}
                      >
                        移动并保留
                      </button>
                    </div>

                    <div className="organizer-actions__manual">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || !manualActionsAvailable}
                        aria-describedby={error ? errorId : undefined}
                        onClick={() => onKeepCurrent(selectedCandidate.bookmarkId)}
                      >
                        保留在当前目录
                      </button>
                      <button
                        type="button"
                        className="organizer-danger-button"
                        disabled={busy || !manualActionsAvailable}
                        aria-describedby={error ? errorId : undefined}
                        onClick={() => onDiscard(selectedCandidate.bookmarkId)}
                      >
                        删除书签
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || !manualActionsAvailable}
                        aria-describedby={error ? errorId : undefined}
                        onClick={() => onDefer(selectedCandidate.bookmarkId)}
                      >
                        稍后决定
                      </button>
                      {suggestion && (
                        <button
                          type="button"
                          className="organizer-feedback-button"
                          disabled={busy || !aiConfigured || state !== 'pending'}
                          aria-busy={aiBusyAction === 'retry' ? true : undefined}
                          aria-describedby={error ? errorId : undefined}
                          onClick={() => onRetrySuggestion(selectedCandidate.bookmarkId)}
                        >
                          {aiBusyAction === 'retry'
                            ? '正在重新生成建议…'
                            : '建议不准，重试'}
                        </button>
                      )}
                    </div>
                  </section>
                </div>
              </article>
            );
          })()}
        </div>
      )}
    </section>
  );
}
