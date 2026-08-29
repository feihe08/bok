import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;

const ai = await import('../libs/bookmarks/organization-ai-settings.ts');

assert.equal(ai.isBookmarkOrganizationAiTestCommand(
  ai.BOOKMARK_ORGANIZATION_AI_TEST_COMMAND,
), true);
assert.equal(ai.isBookmarkOrganizationAiTestCommand({
  ...ai.BOOKMARK_ORGANIZATION_AI_TEST_COMMAND,
  extra: true,
}), false);

const operations = [];
const grantedOrigins = new Set();
let grantNextRequest = true;
let blockedRemovalOrigin = null;

fakeBrowser.permissions.request = async ({ origins }) => {
  operations.push(['request', ...origins]);
  if (!grantNextRequest) return false;
  origins.forEach((origin) => grantedOrigins.add(origin));
  return true;
};
fakeBrowser.permissions.remove = async ({ origins }) => {
  operations.push(['remove', ...origins]);
  if (origins.includes(blockedRemovalOrigin)) return false;
  origins.forEach((origin) => grantedOrigins.delete(origin));
  return true;
};

const first = ai.createBookmarkOrganizationAiSettings({
  endpoint: 'https://api.example.com/v1/responses',
  apiKey: ' first-key ',
  model: ' example-model ',
  preference: ' 优先保留技术文档。 ',
});
assert.deepEqual(first, {
  schemaVersion: 1,
  endpoint: 'https://api.example.com/v1/responses',
  apiKey: 'first-key',
  model: 'example-model',
  preference: '优先保留技术文档。',
});
assert.equal(
  ai.getResponsesEndpointOriginPermission(first.endpoint),
  'https://api.example.com/*',
);
assert.equal(
  ai.getResponsesEndpointOriginPermission('https://api.example.com:8443/v1/responses'),
  'https://api.example.com:8443/*',
);

for (const [input, message] of [
  ['http://api.example.com/v1/responses', /必须使用 HTTPS/],
  ['https://key:secret@api.example.com/v1/responses', /不能包含用户名或密码/],
  ['https://api.example.com/v1/responses?key=value', /不能包含查询参数/],
  ['https://api.example.com/v1/responses#fragment', /不能包含片段/],
] ) {
  assert.throws(() => ai.normalizeResponsesEndpoint(input), message);
}
assert.throws(
  () => ai.createBookmarkOrganizationAiSettings({ ...first, preference: '  ' }),
  /请填写整理偏好/,
);

await ai.saveBookmarkOrganizationAiSettings(first, null);
assert.deepEqual(operations, [['request', 'https://api.example.com/*']]);
assert.deepEqual(await ai.getBookmarkOrganizationAiSettings(), first);

const second = ai.createBookmarkOrganizationAiSettings({
  endpoint: 'https://ai.example.com:8443/responses',
  apiKey: 'second-key',
  model: 'second-model',
  preference: '保留项目资料。',
});
operations.length = 0;
await ai.saveBookmarkOrganizationAiSettings(second, first);
assert.deepEqual(operations, [
  ['request', 'https://ai.example.com:8443/*'],
  ['remove', 'https://api.example.com/*'],
]);
assert.deepEqual(await ai.getBookmarkOrganizationAiSettings(), second);

operations.length = 0;
grantNextRequest = false;
await assert.rejects(
  () => ai.saveBookmarkOrganizationAiSettings(first, second),
  /未允许 Bok 访问此 Responses API 服务/,
);
assert.deepEqual(operations, [['request', 'https://api.example.com/*']]);
assert.deepEqual(await ai.getBookmarkOrganizationAiSettings(), second);

operations.length = 0;
grantNextRequest = true;
blockedRemovalOrigin = 'https://ai.example.com:8443/*';
await assert.rejects(
  () => ai.saveBookmarkOrganizationAiSettings(first, second),
  /无法移除原 Responses API 服务权限/,
);
assert.deepEqual(operations, [
  ['request', 'https://api.example.com/*'],
  ['remove', 'https://ai.example.com:8443/*'],
  ['remove', 'https://api.example.com/*'],
]);
assert.deepEqual(await ai.getBookmarkOrganizationAiSettings(), second);

operations.length = 0;
await assert.rejects(
  () => ai.saveBookmarkOrganizationAiSettings(null, second),
  /无法移除原 Responses API 服务权限/,
);
assert.deepEqual(operations, [['remove', 'https://ai.example.com:8443/*']]);
assert.deepEqual(await ai.getBookmarkOrganizationAiSettings(), second);

operations.length = 0;
blockedRemovalOrigin = null;
await ai.saveBookmarkOrganizationAiSettings(null, second);
assert.deepEqual(operations, [['remove', 'https://ai.example.com:8443/*']]);
assert.equal(await ai.getBookmarkOrganizationAiSettings(), null);
assert.equal(grantedOrigins.size, 0);

console.log('bookmark organization AI settings checks passed');
