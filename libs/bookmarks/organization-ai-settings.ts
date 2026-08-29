import { browser } from 'wxt/browser';

export const BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY =
  'bookmarkOrganizerAiSettings';

export interface BookmarkOrganizationAiSettings {
  schemaVersion: 1;
  endpoint: string;
  apiKey: string;
  model: string;
  preference: string;
}

export type BookmarkOrganizationAiTestCommand = {
  type: 'bok/test-bookmark-organization-ai';
};

export type BookmarkOrganizationAiTestResponse =
  | { ok: true; result: null }
  | { ok: false; error: string };

export const BOOKMARK_ORGANIZATION_AI_TEST_COMMAND: BookmarkOrganizationAiTestCommand = {
  type: 'bok/test-bookmark-organization-ai',
};

export function isBookmarkOrganizationAiTestCommand(
  value: unknown,
): value is BookmarkOrganizationAiTestCommand {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    'type' in value &&
    value.type === BOOKMARK_ORGANIZATION_AI_TEST_COMMAND.type;
}

export function normalizeBookmarkOrganizationAiSettings(
  value: unknown,
): BookmarkOrganizationAiSettings | null {
  if (typeof value !== 'object' || value === null) return null;
  const settings = value as Record<string, unknown>;
  if (
    settings.schemaVersion !== 1 ||
    typeof settings.endpoint !== 'string' ||
    typeof settings.apiKey !== 'string' ||
    typeof settings.model !== 'string' ||
    typeof settings.preference !== 'string'
  ) {
    return null;
  }

  try {
    return createBookmarkOrganizationAiSettings({
      endpoint: settings.endpoint,
      apiKey: settings.apiKey,
      model: settings.model,
      preference: settings.preference,
    });
  } catch {
    return null;
  }
}

export function createBookmarkOrganizationAiSettings(value: {
  endpoint: string;
  apiKey: string;
  model: string;
  preference: string;
}): BookmarkOrganizationAiSettings {
  const endpoint = normalizeResponsesEndpoint(value.endpoint);
  const apiKey = value.apiKey.trim();
  const model = value.model.trim();
  const preference = value.preference.trim();
  if (!apiKey) throw new Error('请填写 API Key');
  if (!model) throw new Error('请填写模型名称');
  if (!preference) throw new Error('请填写整理偏好');
  return {
    schemaVersion: 1,
    endpoint,
    apiKey,
    model,
    preference,
  };
}

export function normalizeResponsesEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('请填写完整的 HTTPS Responses API URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Responses API URL 必须使用 HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Responses API URL 不能包含用户名或密码');
  }
  if (url.hash) {
    throw new Error('Responses API URL 不能包含片段');
  }
  if (url.search) {
    throw new Error('Responses API URL 不能包含查询参数');
  }
  return url.toString();
}

export function getResponsesEndpointOriginPermission(endpoint: string): string {
  const url = new URL(normalizeResponsesEndpoint(endpoint));
  return `${url.protocol}//${url.host}/*`;
}

export async function getBookmarkOrganizationAiSettings(): Promise<
  BookmarkOrganizationAiSettings | null
> {
  const stored = await browser.storage.local.get(
    BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY,
  );
  return normalizeBookmarkOrganizationAiSettings(
    stored[BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY],
  );
}

export async function saveBookmarkOrganizationAiSettings(
  next: BookmarkOrganizationAiSettings | null,
  current: BookmarkOrganizationAiSettings | null,
): Promise<void> {
  const currentOrigin = current
    ? getResponsesEndpointOriginPermission(current.endpoint)
    : null;

  if (next === null) {
    if (currentOrigin) {
      const removed = await browser.permissions.remove({ origins: [currentOrigin] });
      if (!removed) throw new Error('无法移除原 Responses API 服务权限');
    }
    await browser.storage.local.remove(BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY);
    return;
  }

  const nextOrigin = getResponsesEndpointOriginPermission(next.endpoint);
  const granted = await browser.permissions.request({
    origins: [nextOrigin],
  });
  if (!granted) throw new Error('未允许 Bok 访问此 Responses API 服务');

  try {
    if (currentOrigin && currentOrigin !== nextOrigin) {
      const removed = await browser.permissions.remove({ origins: [currentOrigin] });
      if (!removed) throw new Error('无法移除原 Responses API 服务权限');
    }
    await browser.storage.local.set({
      [BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY]: next,
    });
  } catch (error) {
    if (currentOrigin !== nextOrigin) {
      await browser.permissions.remove({ origins: [nextOrigin] }).catch(() => undefined);
    }
    throw error;
  }
}
