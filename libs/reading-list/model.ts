/** One long-term article collected by the user. */
export interface ReadingListItem {
  /** Globally unique, immutable UUID. */
  id: string;
  /** The exact URL collected from the browser tab. */
  url: string;
  /** Title captured when the item was collected. */
  title: string;
  /** Plain text note. Empty strings and line breaks are preserved. */
  note: string;
  createdAt: number;
  /** Changes only when the note changes. */
  updatedAt: number;
}

export interface ReadingListStore {
  schemaVersion: 1;
  kind: 'bok-reading-list';
  revision: number;
  items: ReadingListItem[];
}

export interface ImportReadingListResult {
  kind: 'reading-list';
  importedItems: number;
  skippedDuplicateUrls: number;
  regeneratedIds: number;
}
