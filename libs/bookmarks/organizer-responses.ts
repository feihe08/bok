import { browser } from 'wxt/browser';
import {
  getResponsesEndpointOriginPermission,
  type BookmarkOrganizationAiSettings,
} from './organization-ai-settings';

export type BookmarkOrganizerSuggestionRetention = 'keep' | 'discard' | 'unsure';

export interface BookmarkOrganizerSuggestion {
  id: string;
  retention: BookmarkOrganizerSuggestionRetention;
  directory: string | null;
  reason: string;
}

export interface BookmarkOrganizerSuggestionCandidate {
  /** Request-scoped identifier. Never pass a Chrome bookmark ID here. */
  id: string;
  title: string;
  url: string;
  currentDirectory: string;
  changeTypes: string[];
  dateAdded?: number;
  dateLastUsed?: number;
}

export interface BookmarkOrganizerSuggestionRequest {
  candidates: BookmarkOrganizerSuggestionCandidate[];
  existingDirectories: string[];
  preference: string;
}

export interface BookmarkOrganizerRetrySuggestionRequest {
  candidate: BookmarkOrganizerSuggestionCandidate;
  existingDirectories: string[];
  preference: string;
  previousSuggestion: Omit<BookmarkOrganizerSuggestion, 'id'>;
}

export interface BookmarkOrganizerResponsesDependencies {
  fetch: typeof fetch;
  hasOriginPermission(origin: string): Promise<boolean>;
}

const MAX_REASON_LENGTH = 240;
const MAX_PROVIDER_ERROR_DETAIL_LENGTH = 320;
const RESPONSE_TIMEOUT_MS = 60_000;
const RETENTION_VALUES = ['keep', 'discard', 'unsure'] as const;
const RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
};

function defaultDependencies(): BookmarkOrganizerResponsesDependencies {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    hasOriginPermission: async (origin) =>
      browser.permissions.contains({ origins: [origin] }),
  };
}

function isTimeoutError(signal: AbortSignal, error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true;
  return signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === 'TimeoutError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeProviderErrorDetail(value: unknown, apiKey: string): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const redacted = apiKey
    ? String(value).replaceAll(apiKey, '[API Key 已隐藏]')
    : String(value);
  const detail = redacted
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!detail) return null;
  return detail.slice(0, MAX_PROVIDER_ERROR_DETAIL_LENGTH);
}

async function createResponsesHttpError(
  response: Response,
  apiKey: string,
): Promise<Error> {
  const summary = `Responses API 请求失败（HTTP ${response.status}）`;
  try {
    const payload = (await response.json()) as unknown;
    if (!isRecord(payload) || !isRecord(payload.error)) return new Error(summary);
    const code = sanitizeProviderErrorDetail(payload.error.code, apiKey);
    const message = sanitizeProviderErrorDetail(payload.error.message, apiKey);
    const detail = [code, message].filter(Boolean).join('：');
    return new Error(detail ? `${summary}：${detail}` : summary);
  } catch {
    return new Error(summary);
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new Error(`${label} 包含不支持的字段`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label).trim();
  if (!text) throw new Error(`${label} 不能为空`);
  return text;
}

function normalizeDirectories(value: readonly string[]): string[] {
  const result: string[] = [];
  for (const directory of value) {
    const normalized = requireNonEmptyString(directory, '目录');
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizeCandidate(
  candidate: BookmarkOrganizerSuggestionCandidate,
): BookmarkOrganizerSuggestionCandidate {
  if (!isRecord(candidate)) throw new Error('候选书签无效');
  requireExactKeys(
    candidate,
    [
      'id',
      'title',
      'url',
      'currentDirectory',
      'changeTypes',
      'dateAdded',
      'dateLastUsed',
    ].filter((key) => key in candidate),
    '候选书签',
  );
  const id = requireNonEmptyString(candidate.id, '候选编号');
  const title = requireString(candidate.title, '书签标题');
  const url = requireNonEmptyString(candidate.url, '书签网址');
  const currentDirectory = requireNonEmptyString(
    candidate.currentDirectory,
    '当前目录',
  );
  if (
    !Array.isArray(candidate.changeTypes) ||
    candidate.changeTypes.length === 0 ||
    !candidate.changeTypes.every((type) => typeof type === 'string' && type.trim())
  ) {
    throw new Error('变化类型无效');
  }
  const changeTypes = [...new Set(candidate.changeTypes.map((type) => type.trim()))];
  const dateAdded = candidate.dateAdded;
  const dateLastUsed = candidate.dateLastUsed;
  if (dateAdded !== undefined && (!Number.isSafeInteger(dateAdded) || dateAdded < 0)) {
    throw new Error('创建时间无效');
  }
  if (
    dateLastUsed !== undefined &&
    (!Number.isSafeInteger(dateLastUsed) || dateLastUsed < 0)
  ) {
    throw new Error('最近使用时间无效');
  }
  return {
    id,
    title,
    url,
    currentDirectory,
    changeTypes,
    ...(dateAdded === undefined ? {} : { dateAdded }),
    ...(dateLastUsed === undefined ? {} : { dateLastUsed }),
  };
}

function normalizeRequest(
  request: BookmarkOrganizerSuggestionRequest,
): BookmarkOrganizerSuggestionRequest {
  if (!isRecord(request)) throw new Error('建议请求无效');
  requireExactKeys(request, ['candidates', 'existingDirectories', 'preference'], '建议请求');
  if (!Array.isArray(request.candidates) || request.candidates.length === 0) {
    throw new Error('至少需要一个候选书签');
  }
  const candidates = request.candidates.map(normalizeCandidate);
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('候选编号不能重复');
  }
  return {
    candidates,
    existingDirectories: normalizeDirectories(request.existingDirectories),
    preference: requireNonEmptyString(request.preference, '整理偏好'),
  };
}

function normalizePreviousSuggestion(
  suggestion: Omit<BookmarkOrganizerSuggestion, 'id'>,
): Omit<BookmarkOrganizerSuggestion, 'id'> {
  if (!isRecord(suggestion)) throw new Error('上一条建议无效');
  requireExactKeys(suggestion, ['retention', 'directory', 'reason'], '上一条建议');
  if (!RETENTION_VALUES.includes(suggestion.retention as BookmarkOrganizerSuggestionRetention)) {
    throw new Error('上一条建议的保留结论无效');
  }
  if (suggestion.directory !== null && typeof suggestion.directory !== 'string') {
    throw new Error('上一条建议的目录无效');
  }
  return {
    retention: suggestion.retention as BookmarkOrganizerSuggestionRetention,
    directory: suggestion.directory,
    reason: requireNonEmptyString(suggestion.reason, '上一条建议的理由'),
  };
}

function buildSuggestionSchema(
  directories: readonly string[],
  requestIds: readonly string[],
) {
  return {
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
            id: { type: 'string', enum: requestIds },
            retention: { type: 'string', enum: [...RETENTION_VALUES] },
            directory: {
              anyOf: [
                { type: 'null' },
                { type: 'string', enum: directories },
              ],
            },
            reason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LENGTH },
          },
        },
      },
    },
  };
}

const CONNECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
  },
};

function createRequestBody(
  settings: BookmarkOrganizationAiSettings,
  instructions: string,
  input: string,
  schemaName: string,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    model: settings.model,
    instructions,
    input,
    store: false,
    tools: [],
    text: {
      format: {
        type: 'json_schema',
        name: schemaName,
        schema,
      },
    },
  };
}

async function requestResponse(
  settings: BookmarkOrganizationAiSettings,
  body: Record<string, unknown>,
  dependencies: BookmarkOrganizerResponsesDependencies,
): Promise<unknown> {
  const origin = getResponsesEndpointOriginPermission(settings.endpoint);
  if (!(await dependencies.hasOriginPermission(origin))) {
    throw new Error('未允许 Bok 访问此 Responses API 服务');
  }

  const signal = AbortSignal.timeout(RESPONSE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await dependencies.fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        ...RESPONSE_HEADERS,
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    });
  } catch (error) {
    if (isTimeoutError(signal, error)) {
      throw new Error('Responses API 请求超时，请重试');
    }
    throw new Error('无法连接 Responses API');
  }

  if (!response.ok) {
    throw await createResponsesHttpError(response, settings.apiKey);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isTimeoutError(signal, error)) {
      throw new Error('Responses API 请求超时，请重试');
    }
    throw new Error('Responses API 返回不是有效 JSON');
  }
  return extractOutputText(payload);
}

function extractOutputText(payload: unknown): string {
  if (!isRecord(payload)) throw new Error('Responses API 返回无效');
  if (payload.status !== 'completed') {
    throw new Error('Responses API 未完成请求');
  }
  if (payload.error !== null || payload.incomplete_details !== null) {
    throw new Error('Responses API 返回了错误或不完整结果');
  }
  if (!Array.isArray(payload.output)) throw new Error('Responses API 未返回输出');

  const outputText: string[] = [];
  for (const output of payload.output) {
    if (!isRecord(output)) throw new Error('Responses API 输出项目无效');
    if (output.type === 'reasoning') continue;
    if (
      output.type !== 'message' ||
      output.status !== 'completed' ||
      output.role !== 'assistant' ||
      !Array.isArray(output.content)
    ) {
      throw new Error('Responses API 输出消息未完成或无效');
    }
    for (const content of output.content) {
      if (!isRecord(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
        throw new Error('Responses API 输出文本无效');
      }
      outputText.push(content.text);
    }
  }
  if (outputText.length !== 1) {
    throw new Error('Responses API 必须恰好返回一个 output_text');
  }
  return outputText[0];
}

function parseStructuredJson(value: string): unknown {
  const trimmed = value.replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(trimmed);
    if (!fenced) throw new Error('Responses API 输出不是有效 JSON');
    try {
      return JSON.parse(fenced[1]!.trim()) as unknown;
    } catch {
      throw new Error('Responses API 输出不是有效 JSON');
    }
  }
}

function parseSuggestions(
  outputText: string,
  request: BookmarkOrganizerSuggestionRequest,
): BookmarkOrganizerSuggestion[] {
  const parsed = parseStructuredJson(outputText);
  if (!isRecord(parsed)) throw new Error('建议输出顶层必须是对象');
  requireExactKeys(parsed, ['suggestions'], '建议输出');
  if (!Array.isArray(parsed.suggestions)) throw new Error('建议输出 suggestions 无效');

  const candidatesById = new Map(
    request.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const suggestions = parsed.suggestions.map((value, index) => {
    if (!isRecord(value)) throw new Error(`建议输出 suggestions[${index}] 无效`);
    requireExactKeys(
      value,
      ['id', 'retention', 'directory', 'reason'],
      `建议输出 suggestions[${index}]`,
    );
    const id = requireNonEmptyString(value.id, `建议输出 suggestions[${index}].id`);
    const retention = value.retention;
    if (!RETENTION_VALUES.includes(retention as BookmarkOrganizerSuggestionRetention)) {
      throw new Error(`建议输出 suggestions[${index}].retention 无效`);
    }
    const directory = value.directory;
    if (directory !== null && typeof directory !== 'string') {
      throw new Error(`建议输出 suggestions[${index}].directory 无效`);
    }
    const reason = requireNonEmptyString(value.reason, `建议输出 suggestions[${index}].reason`);
    if (reason.length > MAX_REASON_LENGTH) {
      throw new Error(`建议输出 suggestions[${index}].reason 过长`);
    }
    const candidate = candidatesById.get(id);
    if (!candidate) throw new Error('建议输出包含未知候选编号');
    const allowedDirectories = new Set([
      candidate.currentDirectory,
      ...request.existingDirectories,
    ]);
    if (directory !== null && !allowedDirectories.has(directory)) {
      throw new Error('建议输出目录不在允许范围内');
    }
    if (retention === 'keep' && directory === null) {
      throw new Error('保留建议必须给出当前目录或现有目录');
    }
    return {
      id,
      retention: retention as BookmarkOrganizerSuggestionRetention,
      directory,
      reason,
    };
  });

  if (
    suggestions.length !== request.candidates.length ||
    new Set(suggestions.map((suggestion) => suggestion.id)).size !== suggestions.length ||
    suggestions.some((suggestion) => !candidatesById.has(suggestion.id))
  ) {
    throw new Error('建议输出必须恰好覆盖每个候选一次');
  }
  return suggestions;
}

function getSchemaDirectories(request: BookmarkOrganizerSuggestionRequest): string[] {
  return normalizeDirectories([
    ...request.existingDirectories,
    ...request.candidates.map((candidate) => candidate.currentDirectory),
  ]);
}

export async function testBookmarkOrganizerResponsesConnection(
  settings: BookmarkOrganizationAiSettings,
  dependencies = defaultDependencies(),
): Promise<void> {
  const output = await requestResponse(
    settings,
    createRequestBody(
      settings,
      'Return only valid JSON matching the provided JSON Schema. Do not use Markdown or code fences.',
      JSON.stringify({ purpose: 'connection-test' }),
      'bookmark_organizer_connection_test',
      CONNECTION_SCHEMA,
    ),
    dependencies,
  );
  const parsed = parseStructuredJson(output as string);
  if (!isRecord(parsed)) throw new Error('连接测试输出顶层必须是对象');
  requireExactKeys(parsed, ['ok'], '连接测试输出');
  if (typeof parsed.ok !== 'boolean' || !parsed.ok) {
    throw new Error('Responses API 连接测试未确认成功');
  }
}

export async function requestBookmarkOrganizerSuggestions(
  settings: BookmarkOrganizationAiSettings,
  request: BookmarkOrganizerSuggestionRequest,
  dependencies = defaultDependencies(),
): Promise<BookmarkOrganizerSuggestion[]> {
  const normalizedRequest = normalizeRequest(request);
  const output = await requestResponse(
    settings,
    createRequestBody(
      settings,
      'Classify each candidate. Return only valid JSON matching the provided JSON Schema, with one suggestion per request-scoped id. Do not use Markdown or code fences. Use only the provided directories. Do not infer or request other bookmark data.',
      JSON.stringify({
        preference: normalizedRequest.preference,
        existingDirectories: normalizedRequest.existingDirectories,
        candidates: normalizedRequest.candidates,
      }),
      'bookmark_organizer_suggestions',
      buildSuggestionSchema(
        getSchemaDirectories(normalizedRequest),
        normalizedRequest.candidates.map((candidate) => candidate.id),
      ),
    ),
    dependencies,
  );
  return parseSuggestions(output as string, normalizedRequest);
}

export async function retryBookmarkOrganizerSuggestion(
  settings: BookmarkOrganizationAiSettings,
  request: BookmarkOrganizerRetrySuggestionRequest,
  dependencies = defaultDependencies(),
): Promise<BookmarkOrganizerSuggestion> {
  if (!isRecord(request)) throw new Error('重试建议请求无效');
  requireExactKeys(
    request,
    ['candidate', 'existingDirectories', 'preference', 'previousSuggestion'],
    '重试建议请求',
  );
  const normalizedRequest = normalizeRequest({
    candidates: [request.candidate],
    existingDirectories: request.existingDirectories,
    preference: request.preference,
  });
  const previousSuggestion = normalizePreviousSuggestion(request.previousSuggestion);
  const output = await requestResponse(
    settings,
    createRequestBody(
      settings,
      'Reconsider this one candidate because its previous suggestion was inaccurate. Return only valid JSON matching the provided JSON Schema, with one replacement suggestion. Do not use Markdown or code fences. Use only the provided directories.',
      JSON.stringify({
        preference: normalizedRequest.preference,
        existingDirectories: normalizedRequest.existingDirectories,
        candidates: normalizedRequest.candidates,
        previousSuggestion,
      }),
      'bookmark_organizer_retry_suggestion',
      buildSuggestionSchema(
        getSchemaDirectories(normalizedRequest),
        normalizedRequest.candidates.map((candidate) => candidate.id),
      ),
    ),
    dependencies,
  );
  return parseSuggestions(output as string, normalizedRequest)[0]!;
}
