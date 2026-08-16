/**
 * Progress of an item explicitly marked as a task by the user.
 * `todo` is not started, `doing` is in progress, and `done` is completed.
 */
export type TaskStatus = 'todo' | 'doing' | 'done';

/** Automatic archive period in days; `never` disables automatic archive. */
export type SavedPagesAutoArchivePeriod = 1 | 3 | 7 | 30 | 'never';

export function isSavedPagesAutoArchivePeriod(
  value: unknown,
): value is SavedPagesAutoArchivePeriod {
  return (
    value === 1 ||
    value === 3 ||
    value === 7 ||
    value === 30 ||
    value === 'never'
  );
}

/** A globally unique, immutable UUID v4. */
export type Id = string;

/**
 * One directory below Chrome's bookmarks bar.
 *
 * Each item is one folder name, so ["Dev", "Tools"] maps to Dev/Tools without
 * making "/" inside a folder name ambiguous.
 */
export type DirectoryPath = [string, ...string[]];

/** One saved tab. */
export interface SavedTab {
  id: Id;
  /** 链接 */
  url: string;
  /** 标题 */
  title: string;
  favIconUrl?: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 标签：可以多个，由用户指定 */
  tags: string[];
  /** 唯一目录；null 表示用户尚未指定目录。 */
  directory: DirectoryPath | null;
  /** 用户主动将标签页标记为任务后的状态；null 表示普通标签页。 */
  taskStatus: TaskStatus | null;
  /** 当前任务进入 Done 状态的时间；非 Done 任务为 null。 */
  taskCompletedAt: number | null;
  /** Legacy-compatible tab-level archive state. */
  archivedAt: number | null;
}

export type SavedGroupColor =
  | 'blue'
  | 'cyan'
  | 'green'
  | 'grey'
  | 'orange'
  | 'pink'
  | 'purple'
  | 'red'
  | 'yellow';

export type SavedGroupTaskStatus = TaskStatus;

/** One ordered Chrome tab group saved by Bok. */
export interface SavedGroup {
  id: Id;
  /** 浏览器标签组名称；必须使用唯一的非空名称。 */
  title: string;
  /** 分组进入 Bok 的时间。 */
  createdAt: number;
  /** Chrome tab group color, kept so the page can render it like the browser does */
  color?: SavedGroupColor;
  /** Every v3 Group is a real Chrome tab group. */
  grouped: true;
  /** 锁定后仍可打开，但不能从 Bok 删除 */
  locked: boolean;
  /** 固定后跳过自动归档；session 内仍保留原始顺序。 */
  pinned: boolean;
  /** 最近一次手动从归档恢复的时间；从未恢复时为 null。 */
  restoredAt: number | null;
  /** 归档时间；null 表示当前未归档。 */
  archivedAt: number | null;
  /** 用户主动将标签组标记为任务后维护的状态；null 表示未标记为任务。 */
  taskStatus: SavedGroupTaskStatus | null;
  /** 当前任务进入 Done 状态的时间；非 Done 任务为 null。 */
  taskCompletedAt: number | null;
  tabs: SavedTab[];
}

export type SavedSessionItem =
  | { type: 'tab'; tab: SavedTab }
  | { type: 'group'; group: SavedGroup };

export interface SavedSessionState {
  /** Session title; new saves use an empty title and show a generated fallback. */
  title: string;
  locked: boolean;
  pinned: boolean;
  restoredAt: number | null;
  archivedAt: number | null;
  taskStatus: TaskStatus | null;
  taskCompletedAt: number | null;
}

export interface SavedSession extends SavedSessionState {
  id: Id;
  createdAt: number;
  items: SavedSessionItem[];
}
