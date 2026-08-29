import {
  getBookmarkOrganizationAiSettings,
  isBookmarkOrganizationAiTestCommand,
  type BookmarkOrganizationAiTestResponse,
} from './organization-ai-settings';
import { testBookmarkOrganizerResponsesConnection } from './organizer-responses';

interface BookmarkOrganizationAiMessageDependencies {
  getSettings: typeof getBookmarkOrganizationAiSettings;
  testConnection: typeof testBookmarkOrganizerResponsesConnection;
}

export function handleBookmarkOrganizationAiMessage(
  message: unknown,
  sendResponse: (response: BookmarkOrganizationAiTestResponse) => void,
  overrides: Partial<BookmarkOrganizationAiMessageDependencies> = {},
): boolean {
  if (!isBookmarkOrganizationAiTestCommand(message)) return false;
  const dependencies: BookmarkOrganizationAiMessageDependencies = {
    getSettings: getBookmarkOrganizationAiSettings,
    testConnection: testBookmarkOrganizerResponsesConnection,
    ...overrides,
  };

  void (async () => {
    const settings = await dependencies.getSettings();
    if (!settings) throw new Error('请先保存书签整理 AI 配置');
    await dependencies.testConnection(settings);
  })().then(
    () => sendResponse({ ok: true, result: null }),
    (error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return true;
}
