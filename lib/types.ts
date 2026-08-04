/**
 * One directory below Chrome's bookmarks bar.
 *
 * Each item is one folder name, so ["Dev", "Tools"] maps to Dev/Tools without
 * making "/" inside a folder name ambiguous.
 */
export type DirectoryPath = [string, ...string[]];

/**
 * One saved tab. Fields mirror the "书签源信息" spec in requirement.md so a
 * SavedTab can later be promoted into a Chrome bookmark or archived to iCloud.
 */
export interface SavedTab {
  id: string;
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
  /** Legacy compatibility only; group.archivedAt is the archive source of truth. */
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

/**
 * A Chrome tab group captured as a unit. Per requirement.md one project maps to
 * one tab group, so this is the natural unit to sync into a bookmark folder.
 */
export interface SavedGroup {
  id: string;
  /** 标签组名称；未分组的标签用空字符串 */
  title: string;
  /** 标签组进入 Bok 的时间。 */
  createdAt: number;
  /** Chrome tab group color, kept so the page can render it like the browser does */
  color?: SavedGroupColor;
  /** false 表示这些标签本来就没有分组 */
  grouped: boolean;
  /** 锁定后仍可打开，但不能从 Bok 删除 */
  locked: boolean;
  /** 固定后置顶显示，并跳过自动归档。 */
  pinned: boolean;
  /** 归档时间；null 表示当前未归档。 */
  archivedAt: number | null;
  /** 用户主动将分组标记为任务后维护的状态；null 表示普通分组。 */
  taskStatus: SavedGroupTaskStatus | null;
  /** 当前任务进入 Done 状态的时间；非 Done 任务为 null。 */
  taskCompletedAt: number | null;
  tabs: SavedTab[];
}

/** One click of the extension icon produces one session. */
export interface SavedSession {
  id: string;
  createdAt: number;
  groups: SavedGroup[];
}
import type { TaskStatus } from './model';
