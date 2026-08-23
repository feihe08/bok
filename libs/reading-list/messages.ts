export type ReadingListCommand =
  | { type: 'bok/reading-list/update-note'; id: string; note: string }
  | { type: 'bok/reading-list/delete-item'; id: string }
  | { type: 'bok/reading-list/open-random' };

export interface OpenRandomReadingListResult {
  opened: boolean;
}

export type ReadingListCommandResult = OpenRandomReadingListResult | null;

export type ReadingListResponse =
  | { ok: true; result: ReadingListCommandResult }
  | { ok: false; error: string };

export function isReadingListCommand(value: unknown): value is ReadingListCommand {
  if (typeof value !== 'object' || value === null) return false;

  const command = value as Record<string, unknown>;
  switch (command.type) {
    case 'bok/reading-list/update-note':
      return typeof command.id === 'string' && typeof command.note === 'string';
    case 'bok/reading-list/delete-item':
      return typeof command.id === 'string';
    case 'bok/reading-list/open-random':
      return true;
    default:
      return false;
  }
}
