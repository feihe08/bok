/**
 * Progress of an item explicitly marked as a task by the user.
 * `todo` is not started, `doing` is in progress, and `done` is completed.
 */
export type TaskStatus = 'todo' | 'doing' | 'done';

/**
 * A globally unique, immutable UUID v4.
 * It is generated once when an entity is created and is never reused.
 */
export type Id = string;

/** One browser tab stored by Bok. */
export interface Tab {
  /** Stable identity of this tab. */
  id: Id;
  /** Complete URL opened by the tab. */
  url: string;
  /** User-visible title; initially taken from the browser tab. */
  title: string;
  /** Unix timestamp in milliseconds when this tab was created in Bok. */
  createdAt: number;
  /** Current task progress; null means this tab is not marked as a task. */
  taskStatus: TaskStatus | null;
  /** Unix timestamp in milliseconds when the current task entered Done; null otherwise. */
  taskCompletedAt: number | null;
}

/** One ordered collection of tabs managed together by Bok. */
export interface TabGroup {
  /** Stable identity of this tab group. */
  id: Id;
  /** User-visible group title; an empty string means no explicit title. */
  title: string;
  /** Unix timestamp in milliseconds when this tab group was created in Bok. */
  createdAt: number;
  /**
   * Whether this collection represents a native Chrome tab group.
   * False means Bok grouped tabs that were ungrouped in Chrome.
   */
  isBrowserGroup: boolean;
  /** Whether destructive operations such as deletion and deduplication are blocked. */
  locked: boolean;
  /** Whether this group stays at the top and is excluded from automatic archiving. */
  pinned: boolean;
  /** Current task progress; null means this group is not marked as a task. */
  taskStatus: TaskStatus | null;
  /** Unix timestamp in milliseconds when the current task entered Done; null otherwise. */
  taskCompletedAt: number | null;
  /** Unix archive timestamp in milliseconds; null means this group is current. */
  archivedAt: number | null;
  /** Tabs in their saved display and restore order. */
  tabs: Tab[];
}
