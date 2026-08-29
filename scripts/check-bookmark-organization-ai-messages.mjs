import assert from 'node:assert/strict';
import { handleBookmarkOrganizationAiMessage } from '../libs/bookmarks/organization-ai-messages.ts';
import { BOOKMARK_ORGANIZATION_AI_TEST_COMMAND } from '../libs/bookmarks/organization-ai-settings.ts';

const settings = {
  schemaVersion: 1,
  endpoint: 'https://api.example.com/v1/responses',
  apiKey: 'key',
  model: 'model',
  preference: '优先保留技术资料。',
};

async function execute(message, overrides) {
  return new Promise((resolve) => {
    const handled = handleBookmarkOrganizationAiMessage(message, resolve, overrides);
    if (!handled) resolve(null);
  });
}

const calls = [];
assert.deepEqual(
  await execute(BOOKMARK_ORGANIZATION_AI_TEST_COMMAND, {
    getSettings: async () => settings,
    testConnection: async (received) => calls.push(received),
  }),
  { ok: true, result: null },
);
assert.deepEqual(calls, [settings]);

assert.deepEqual(
  await execute(BOOKMARK_ORGANIZATION_AI_TEST_COMMAND, {
    getSettings: async () => null,
  }),
  { ok: false, error: '请先保存书签整理 AI 配置' },
);

assert.deepEqual(
  await execute(BOOKMARK_ORGANIZATION_AI_TEST_COMMAND, {
    getSettings: async () => settings,
    testConnection: async () => {
      throw new Error('provider failed');
    },
  }),
  { ok: false, error: 'provider failed' },
);

assert.equal(
  handleBookmarkOrganizationAiMessage(
    { type: 'bok/not-bookmark-organization-ai' },
    () => assert.fail('unknown messages must not receive a response'),
  ),
  false,
);

console.log('bookmark organization AI message checks passed');
