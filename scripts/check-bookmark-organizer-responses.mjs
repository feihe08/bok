import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;

const {
  requestBookmarkOrganizerSuggestions,
  retryBookmarkOrganizerSuggestion,
  testBookmarkOrganizerResponsesConnection,
} = await import('../libs/bookmarks/organizer-responses.ts');

const settings = {
  schemaVersion: 1,
  endpoint: 'https://ai.example.test/custom/responses',
  apiKey: 'secret-key-must-not-leak',
  model: 'test-model',
  preference: '优先保留工作资料，按主题归类。',
};

const candidate = {
  id: 'request-1',
  title: 'Structured outputs guide',
  url: 'https://example.test/guide',
  currentDirectory: '书签栏 / 收件箱',
  changeTypes: ['created', 'title-changed'],
  dateAdded: 1_700_000_000_000,
  dateLastUsed: 1_700_000_100_000,
};

const request = {
  candidates: [candidate],
  existingDirectories: ['书签栏 / 开发', '书签栏 / 待阅读'],
  preference: settings.preference,
};

function completedResponse(output, options = {}) {
  return new Response(
    JSON.stringify({
      status: 'completed',
      error: null,
      incomplete_details: null,
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify(output) }],
        },
      ],
      ...options,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function createDependencies(responseFactory, permission = true) {
  const calls = [];
  const origins = [];
  return {
    calls,
    origins,
    dependencies: {
      fetch: async (input, init) => {
        calls.push({ input, init });
        return responseFactory();
      },
      hasOriginPermission: async (origin) => {
        origins.push(origin);
        return permission;
      },
    },
  };
}

function validSuggestions() {
  return {
    suggestions: [
      {
        id: 'request-1',
        retention: 'keep',
        directory: '书签栏 / 开发',
        reason: '与开发资料相符。',
      },
    ],
  };
}

const connection = createDependencies(() => completedResponse({ ok: true }));
await testBookmarkOrganizerResponsesConnection(settings, connection.dependencies);
assert.deepEqual(connection.origins, ['https://ai.example.test/*']);
assert.equal(connection.calls.length, 1);
assert.equal(connection.calls[0].input, settings.endpoint);
assert.equal(connection.calls[0].init.method, 'POST');
assert.deepEqual(connection.calls[0].init.headers, {
  'Content-Type': 'application/json',
  Authorization: 'Bearer secret-key-must-not-leak',
});
assert.equal(connection.calls[0].init.credentials, 'omit');
assert.equal(connection.calls[0].init.redirect, 'error');
assert.equal(connection.calls[0].init.referrerPolicy, 'no-referrer');
assert.equal(connection.calls[0].init.signal instanceof AbortSignal, true);
const connectionPayload = JSON.parse(connection.calls[0].init.body);
assert.equal(connectionPayload.model, settings.model);
assert.equal(connectionPayload.store, false);
assert.deepEqual(connectionPayload.tools, []);
assert.equal('previous_response_id' in connectionPayload, false);
assert.match(connectionPayload.instructions, /valid JSON/);
assert.match(connectionPayload.instructions, /Do not use Markdown or code fences/);
assert.deepEqual(JSON.parse(connectionPayload.input), {
  purpose: 'connection-test',
});
assert.equal(JSON.stringify(connectionPayload).includes('Structured outputs guide'), false);
assert.deepEqual(connectionPayload.text.format, {
  type: 'json_schema',
  name: 'bookmark_organizer_connection_test',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok'],
    properties: { ok: { type: 'boolean' } },
  },
});

const batch = createDependencies(() => completedResponse(validSuggestions()));
assert.deepEqual(
  await requestBookmarkOrganizerSuggestions(settings, request, batch.dependencies),
  validSuggestions().suggestions,
);
const batchPayload = JSON.parse(batch.calls[0].init.body);
assert.equal('previous_response_id' in batchPayload, false);
assert.match(batchPayload.instructions, /valid JSON/);
assert.match(batchPayload.instructions, /one suggestion per request-scoped id/);
assert.deepEqual(JSON.parse(batchPayload.input), {
  preference: settings.preference,
  existingDirectories: request.existingDirectories,
  candidates: [candidate],
});
assert.deepEqual(batchPayload.text.format, {
  type: 'json_schema',
  name: 'bookmark_organizer_suggestions',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['suggestions'],
    properties: {
      suggestions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'retention', 'directory', 'reason'],
          properties: {
            id: { type: 'string', enum: ['request-1'] },
            retention: { type: 'string', enum: ['keep', 'discard', 'unsure'] },
            directory: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'string',
                  enum: [
                    '书签栏 / 开发',
                    '书签栏 / 待阅读',
                    '书签栏 / 收件箱',
                  ],
                },
              ],
            },
            reason: { type: 'string', minLength: 1, maxLength: 240 },
          },
        },
      },
    },
  },
});

const retry = createDependencies(() =>
  completedResponse({
    suggestions: [
      {
        id: 'request-1',
        retention: 'unsure',
        directory: null,
        reason: '需要进一步判断。',
      },
    ],
  }),
);
assert.deepEqual(
  await retryBookmarkOrganizerSuggestion(
    settings,
    {
      candidate,
      existingDirectories: request.existingDirectories,
      preference: settings.preference,
      previousSuggestion: {
        retention: 'keep',
        directory: '书签栏 / 开发',
        reason: '原先归为开发资料。',
      },
    },
    retry.dependencies,
  ),
  {
    id: 'request-1',
    retention: 'unsure',
    directory: null,
    reason: '需要进一步判断。',
  },
);
const retryPayload = JSON.parse(retry.calls[0].init.body);
assert.match(retryPayload.instructions, /valid JSON/);
assert.match(retryPayload.instructions, /one replacement suggestion/);
assert.deepEqual(JSON.parse(retryPayload.input), {
  preference: settings.preference,
  existingDirectories: request.existingDirectories,
  candidates: [candidate],
  previousSuggestion: {
    retention: 'keep',
    directory: '书签栏 / 开发',
    reason: '原先归为开发资料。',
  },
});

const noPermission = createDependencies(() => completedResponse(validSuggestions()), false);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, noPermission.dependencies),
  /未允许 Bok 访问此 Responses API 服务/,
);
assert.equal(noPermission.calls.length, 0);

const httpFailure = createDependencies(
  () => new Response('provider response must not be exposed', { status: 401 }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, httpFailure.dependencies),
  (error) =>
    error instanceof Error &&
    /HTTP 401/.test(error.message) &&
    !error.message.includes(settings.apiKey) &&
    !error.message.includes('provider response'),
);

const structuredHttpFailure = createDependencies(
  () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'invalid_request_error',
          message: `Unknown parameter: text.format.strict ${settings.apiKey}`,
          ignored: 'must not be exposed',
        },
        ignored: 'must not be exposed',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, structuredHttpFailure.dependencies),
  (error) =>
    error instanceof Error &&
    error.message ===
      'Responses API 请求失败（HTTP 400）：invalid_request_error：Unknown parameter: text.format.strict [API Key 已隐藏]' &&
    !error.message.includes(settings.apiKey) &&
    !error.message.includes('must not be exposed'),
);

const spacedApiKeySettings = { ...settings, apiKey: 'secret   key' };
const spacedApiKeyFailure = createDependencies(
  () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'invalid_request_error',
          message: `Rejected key ${spacedApiKeySettings.apiKey}`,
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(
    spacedApiKeySettings,
    request,
    spacedApiKeyFailure.dependencies,
  ),
  (error) =>
    error instanceof Error &&
    error.message.endsWith('Rejected key [API Key 已隐藏]') &&
    !error.message.includes(spacedApiKeySettings.apiKey) &&
    !error.message.includes('secret key'),
);

const incomplete = createDependencies(() =>
  completedResponse(validSuggestions(), { status: 'incomplete', incomplete_details: { reason: 'length' } }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, incomplete.dependencies),
  /未完成请求/,
);

const payloadError = createDependencies(() =>
  completedResponse(validSuggestions(), { error: { code: 'provider_error' } }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, payloadError.dependencies),
  /错误或不完整结果/,
);

const incompleteMessage = createDependencies(() =>
  completedResponse(validSuggestions(), {
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: [{ type: 'output_text', text: JSON.stringify(validSuggestions()) }],
      },
    ],
  }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, incompleteMessage.dependencies),
  /输出消息未完成或无效/,
);

const wrongMessageRole = createDependencies(() =>
  completedResponse(validSuggestions(), {
    output: [
      {
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(validSuggestions()) }],
      },
    ],
  }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, wrongMessageRole.dependencies),
  /输出消息未完成或无效/,
);

const reasoningBeforeMessage = createDependencies(() =>
  completedResponse(validSuggestions(), {
    output: [
      { type: 'reasoning', id: 'reasoning-1' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(validSuggestions()) }],
      },
    ],
  }),
);
assert.deepEqual(
  await requestBookmarkOrganizerSuggestions(
    settings,
    request,
    reasoningBeforeMessage.dependencies,
  ),
  validSuggestions().suggestions,
);

const duplicateOutputText = createDependencies(
  () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: JSON.stringify(validSuggestions()) },
              { type: 'output_text', text: JSON.stringify(validSuggestions()) },
            ],
          },
        ],
      }),
      { status: 200 },
    ),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, duplicateOutputText.dependencies),
  /恰好返回一个 output_text/,
);

const malformedJson = createDependencies(
  () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: '{not valid json' }],
          },
        ],
      }),
      { status: 200 },
    ),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, malformedJson.dependencies),
  /输出不是有效 JSON/,
);

const fencedJson = createDependencies(
  () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: `\`\`\`json\n${JSON.stringify(validSuggestions())}\n\`\`\``,
              },
            ],
          },
        ],
      }),
      { status: 200 },
    ),
);
assert.deepEqual(
  await requestBookmarkOrganizerSuggestions(settings, request, fencedJson.dependencies),
  validSuggestions().suggestions,
);

const jsonWithProse = createDependencies(
  () =>
    new Response(
      JSON.stringify({
        status: 'completed',
        error: null,
        incomplete_details: null,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: `Here is the result:\n${JSON.stringify(validSuggestions())}`,
              },
            ],
          },
        ],
      }),
      { status: 200 },
    ),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, jsonWithProse.dependencies),
  /输出不是有效 JSON/,
);

const invalidResponseBody = createDependencies(
  () => new Response('not JSON and never a provider error detail', { status: 200 }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, invalidResponseBody.dependencies),
  (error) =>
    error instanceof Error &&
    /返回不是有效 JSON/.test(error.message) &&
    !error.message.includes(settings.apiKey),
);

const fetchFailure = {
  fetch: async () => {
    throw new Error(`network failure with ${settings.apiKey}`);
  },
  hasOriginPermission: async () => true,
};
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, fetchFailure),
  (error) =>
    error instanceof Error &&
    /无法连接 Responses API/.test(error.message) &&
    !error.message.includes(settings.apiKey),
);

const timeoutFailure = {
  fetch: async () => {
    throw new DOMException('request timed out', 'TimeoutError');
  },
  hasOriginPermission: async () => true,
};
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, timeoutFailure),
  /请求超时，请重试/,
);

const originalTimeout = AbortSignal.timeout;
try {
  AbortSignal.timeout = () => AbortSignal.abort(
    new DOMException('request timed out', 'TimeoutError'),
  );
  const bodyTimeoutFailure = {
    fetch: async () => ({
      ok: true,
      json: async () => {
        throw new TypeError('body aborted');
      },
    }),
    hasOriginPermission: async () => true,
  };
  await assert.rejects(
    requestBookmarkOrganizerSuggestions(settings, request, bodyTimeoutFailure),
    /请求超时，请重试/,
  );
} finally {
  AbortSignal.timeout = originalTimeout;
}

const schemaFailure = createDependencies(() =>
  completedResponse({ ...validSuggestions(), ignored: true }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, schemaFailure.dependencies),
  /包含不支持的字段/,
);

const semanticFailure = createDependencies(() =>
  completedResponse({
    suggestions: [
      {
        id: 'request-1',
        retention: 'keep',
        directory: '书签栏 / 不存在',
        reason: '不在目录白名单中。',
      },
    ],
  }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, semanticFailure.dependencies),
  /目录不在允许范围内/,
);

const unknownId = createDependencies(() =>
  completedResponse({
    suggestions: [
      {
        id: 'request-other',
        retention: 'keep',
        directory: '书签栏 / 开发',
        reason: '未知编号。',
      },
    ],
  }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, unknownId.dependencies),
  /未知候选编号/,
);

const duplicateId = createDependencies(() =>
  completedResponse({
    suggestions: [
      ...validSuggestions().suggestions,
      {
        id: 'request-1',
        retention: 'discard',
        directory: null,
        reason: '重复编号。',
      },
    ],
  }),
);
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, duplicateId.dependencies),
  /恰好覆盖每个候选一次/,
);

const coverageFailure = createDependencies(() => completedResponse({ suggestions: [] }));
await assert.rejects(
  requestBookmarkOrganizerSuggestions(settings, request, coverageFailure.dependencies),
  /恰好覆盖每个候选一次/,
);

console.log('bookmark organizer Responses checks passed');
