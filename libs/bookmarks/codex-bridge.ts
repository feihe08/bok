import { browser } from 'wxt/browser';
import type { BookmarkNode } from './model';

export const CODEX_BOOKMARK_NATIVE_HOST = 'com.hefei.bok.bookmarks';

interface ExpectedBookmarkNode {
  id: string;
  kind: 'folder' | 'bookmark';
  title: string;
  url: string | null;
  parentId: string | null;
  index: number | null;
}

interface RenameFolderOperation {
  type: 'rename-folder';
  expected: ExpectedBookmarkNode;
  title: string;
}

interface MoveBookmarkOperation {
  type: 'move-bookmark';
  expected: ExpectedBookmarkNode;
  destination: {
    expected: ExpectedBookmarkNode;
    index: null;
  };
}

export type CodexBookmarkOperation =
  | RenameFolderOperation
  | MoveBookmarkOperation;

export type CodexBookmarkRequest =
  | { id: string; type: 'bok/bookmarks/ping' }
  | { id: string; type: 'bok/bookmarks/read-tree' }
  | {
      id: string;
      type: 'bok/bookmarks/plan';
      apply: boolean;
      operations: CodexBookmarkOperation[];
    };

export type CodexBookmarkResponse =
  | { id: string | null; ok: true; result: unknown }
  | { id: string | null; ok: false; error: string; details?: unknown };

interface BookmarksApi {
  get(id: string): Promise<BookmarkNode[]>;
  getTree(): Promise<BookmarkNode[]>;
  move(
    id: string,
    destination: { parentId?: string; index?: number },
  ): Promise<BookmarkNode>;
  update(
    id: string,
    changes: { title?: string; url?: string },
  ): Promise<BookmarkNode>;
}

interface OperationPreview {
  type: CodexBookmarkOperation['type'];
  id: string;
  title: string;
  from: { title: string; parentId?: string; index?: number };
  to: { title: string; parentId?: string; index?: number };
}

export class CodexBookmarkExecutionError extends Error {
  constructor(
    message: string,
    readonly details: {
      status: 'conflict-before-write' | 'rolled-back' | 'partial-rollback';
      rollbackErrors?: string[];
    },
  ) {
    super(message);
    this.name = 'CodexBookmarkExecutionError';
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.trim().length === 0)
  ) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireString(value, label);
}

function requireNullableIndex(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负整数或 null`);
  }
  return value as number;
}

function parseExpectedNode(value: unknown, label: string): ExpectedBookmarkNode {
  const expected = requireRecord(value, label);
  if (expected.kind !== 'folder' && expected.kind !== 'bookmark') {
    throw new Error(`${label}.kind 必须是 folder 或 bookmark`);
  }
  return {
    id: requireString(expected.id, `${label}.id`),
    kind: expected.kind,
    title: requireString(expected.title, `${label}.title`, { allowEmpty: true }),
    url: requireNullableString(expected.url, `${label}.url`),
    parentId: requireNullableString(expected.parentId, `${label}.parentId`),
    index: requireNullableIndex(expected.index, `${label}.index`),
  };
}

function parseOperation(value: unknown, index: number): CodexBookmarkOperation {
  const operation = requireRecord(value, `operations[${index}]`);
  const type = requireString(operation.type, `operations[${index}].type`);
  const expected = parseExpectedNode(
    operation.expected,
    `operations[${index}].expected`,
  );

  if (type === 'rename-folder') {
    return {
      type,
      expected,
      title: requireString(operation.title, `operations[${index}].title`),
    };
  }

  if (type === 'move-bookmark') {
    const destination = requireRecord(
      operation.destination,
      `operations[${index}].destination`,
    );
    if (destination.index !== null) {
      throw new Error(`operations[${index}].destination.index 当前只支持 null`);
    }
    return {
      type,
      expected,
      destination: {
        expected: parseExpectedNode(
          destination.expected,
          `operations[${index}].destination.expected`,
        ),
        index: null,
      },
    };
  }

  throw new Error(`不支持的书签操作：${type}`);
}

export function parseCodexBookmarkRequest(value: unknown): CodexBookmarkRequest {
  const request = requireRecord(value, '请求');
  const id = requireString(request.id, 'id');
  const type = requireString(request.type, 'type');

  if (type === 'bok/bookmarks/ping' || type === 'bok/bookmarks/read-tree') {
    return { id, type };
  }

  if (type !== 'bok/bookmarks/plan') {
    throw new Error(`不支持的请求：${type}`);
  }
  if (typeof request.apply !== 'boolean') {
    throw new Error('apply 必须明确为 true 或 false');
  }
  if (!Array.isArray(request.operations) || request.operations.length === 0) {
    throw new Error('operations 至少需要一个操作');
  }
  if (request.operations.length > 100) {
    throw new Error('单次最多执行 100 个书签操作');
  }

  const operations = request.operations.map(parseOperation);
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.expected.id)) {
      throw new Error(`同一计划不能重复操作节点 ${operation.expected.id}`);
    }
    ids.add(operation.expected.id);
  }
  return { id, type, apply: request.apply, operations };
}

async function getNode(api: BookmarksApi, id: string): Promise<BookmarkNode> {
  const [node] = await api.get(id);
  if (!node) throw new Error(`找不到书签节点 ${id}`);
  return node;
}

function nodeKind(node: BookmarkNode): ExpectedBookmarkNode['kind'] {
  return node.url == null ? 'folder' : 'bookmark';
}

function nodeUnmodifiable(node: BookmarkNode): string | undefined {
  return (node as BookmarkNode & { unmodifiable?: string }).unmodifiable;
}

function assertExpectedNode(
  node: BookmarkNode,
  expected: ExpectedBookmarkNode,
  label: string,
): void {
  const actual = {
    id: node.id,
    kind: nodeKind(node),
    title: node.title,
    url: node.url ?? null,
    parentId: node.parentId ?? null,
    index: node.index ?? null,
  } satisfies ExpectedBookmarkNode;
  for (const key of Object.keys(actual) as Array<keyof ExpectedBookmarkNode>) {
    if (actual[key] !== expected[key]) {
      throw new Error(
        `${label} ${expected.id} 的 ${key} 已变化：预期 ${JSON.stringify(expected[key])}，当前为 ${JSON.stringify(actual[key])}`,
      );
    }
  }
}

function assertMutableNormalFolder(node: BookmarkNode, label: string): void {
  if (node.url != null) throw new Error(`${label} ${node.id} 不是文件夹`);
  if (node.parentId == null) throw new Error(`${label} ${node.id} 是根目录`);
  if (node.folderType != null || nodeUnmodifiable(node) != null) {
    throw new Error(`${label} ${node.id} 是 Chrome 特殊或不可修改目录`);
  }
}

async function validateOperations(
  api: BookmarksApi,
  operations: CodexBookmarkOperation[],
): Promise<Array<{ operation: CodexBookmarkOperation; node: BookmarkNode }>> {
  const validated = [];
  for (const operation of operations) {
    const node = await getNode(api, operation.expected.id);
    assertExpectedNode(node, operation.expected, '节点');

    if (operation.type === 'rename-folder') {
      assertMutableNormalFolder(node, '节点');
    } else {
      if (node.url == null) throw new Error(`节点 ${node.id} 不是书签`);
      if (operation.expected.kind !== 'bookmark' || operation.expected.url == null) {
        throw new Error(`节点 ${node.id} 的预期类型必须是 bookmark`);
      }
      const destination = await getNode(api, operation.destination.expected.id);
      assertExpectedNode(destination, operation.destination.expected, '目标目录');
      assertMutableNormalFolder(destination, '目标目录');
      if (operation.destination.expected.kind !== 'folder') {
        throw new Error(`目标节点 ${destination.id} 的预期类型必须是 folder`);
      }
      if (node.parentId === destination.id) throw new Error(`书签 ${node.id} 已在目标目录中`);
    }
    validated.push({ operation, node });
  }
  return validated;
}

function previewOperation(
  operation: CodexBookmarkOperation,
  node: BookmarkNode,
): OperationPreview {
  if (operation.type === 'rename-folder') {
    return {
      type: operation.type,
      id: operation.expected.id,
      title: node.title,
      from: { title: node.title, parentId: node.parentId, index: node.index },
      to: { title: operation.title, parentId: node.parentId, index: node.index },
    };
  }
  return {
    type: operation.type,
    id: operation.expected.id,
    title: node.title,
    from: { title: node.title, parentId: node.parentId, index: node.index },
    to: {
      title: node.title,
      parentId: operation.destination.expected.id,
    },
  };
}

function executionOrder(
  validated: Array<{ operation: CodexBookmarkOperation; node: BookmarkNode }>,
) {
  const renames = validated.filter(
    (item): item is { operation: RenameFolderOperation; node: BookmarkNode } =>
      item.operation.type === 'rename-folder',
  );
  const moves = validated
    .filter(
      (item): item is { operation: MoveBookmarkOperation; node: BookmarkNode } =>
        item.operation.type === 'move-bookmark',
    )
    .sort((left, right) => {
      const parentOrder = (left.operation.expected.parentId ?? '').localeCompare(
        right.operation.expected.parentId ?? '',
      );
      if (parentOrder !== 0) return parentOrder;
      return (right.operation.expected.index ?? -1) - (left.operation.expected.index ?? -1);
    });
  return [...renames, ...moves];
}

export async function executeCodexBookmarkRequest(
  value: unknown,
  api: BookmarksApi = browser.bookmarks as BookmarksApi,
): Promise<unknown> {
  const request = parseCodexBookmarkRequest(value);
  if (request.type === 'bok/bookmarks/ping') {
    return {
      extensionId: browser.runtime.id,
      version: browser.runtime.getManifest().version,
    };
  }
  if (request.type === 'bok/bookmarks/read-tree') {
    return { roots: await api.getTree() };
  }

  let validated;
  try {
    validated = await validateOperations(api, request.operations);
  } catch (error) {
    throw new CodexBookmarkExecutionError(
      error instanceof Error ? error.message : String(error),
      { status: 'conflict-before-write' },
    );
  }
  const preview = validated.map(({ operation, node }) =>
    previewOperation(operation, node),
  );
  if (!request.apply) return { applied: false, operations: preview };

  const rollbacks: Array<() => Promise<void>> = [];
  try {
    for (const { operation, node } of executionOrder(validated)) {
      const current = await getNode(api, operation.expected.id);
      assertExpectedNode(current, operation.expected, '节点');
      if (operation.type === 'rename-folder') {
        assertMutableNormalFolder(current, '节点');
        const updated = await api.update(node.id, { title: operation.title });
        rollbacks.push(async () => {
          const rollbackCurrent = await getNode(api, node.id);
          assertExpectedNode(
            rollbackCurrent,
            { ...operation.expected, title: updated.title },
            '回滚节点',
          );
          await api.update(node.id, { title: node.title });
        });
      } else {
        const destination = await getNode(api, operation.destination.expected.id);
        assertExpectedNode(destination, operation.destination.expected, '目标目录');
        assertMutableNormalFolder(destination, '目标目录');
        const moved = await api.move(node.id, {
          parentId: destination.id,
        });
        rollbacks.push(async () => {
          const rollbackCurrent = await getNode(api, node.id);
          assertExpectedNode(
            rollbackCurrent,
            {
              ...operation.expected,
              parentId: moved.parentId ?? null,
              index: moved.index ?? null,
            },
            '回滚节点',
          );
          await api.move(node.id, {
            parentId: operation.expected.parentId ?? undefined,
            ...(operation.expected.index == null
              ? {}
              : { index: operation.expected.index }),
          });
        });
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const rollback of rollbacks.reverse()) {
      try {
        await rollback();
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        );
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexBookmarkExecutionError(
      rollbackErrors.length === 0 ? `${message}；已回滚此前操作` : message,
      rollbackErrors.length === 0
        ? { status: 'rolled-back' }
        : { status: 'partial-rollback', rollbackErrors },
    );
  }

  return { applied: true, operations: preview };
}

type NativePort = ReturnType<typeof browser.runtime.connectNative>;
type ExecuteRequest = (request: unknown) => Promise<unknown>;

let nativePort: NativePort | null = null;

export function disconnectCodexBookmarkBridge(): void {
  nativePort?.disconnect();
  nativePort = null;
}

export function connectCodexBookmarkBridge(execute: ExecuteRequest): boolean {
  if (nativePort) return true;

  try {
    const port = browser.runtime.connectNative(CODEX_BOOKMARK_NATIVE_HOST);
    nativePort = port;
    const postResponse = (response: CodexBookmarkResponse) => {
      try {
        port.postMessage(response);
      } catch (error) {
        console.warn('[bok] failed to respond through Codex bookmark bridge', error);
      }
    };
    port.onMessage.addListener((request: unknown) => {
      const requestId =
        typeof request === 'object' &&
        request !== null &&
        'id' in request &&
        typeof request.id === 'string'
          ? request.id
          : null;
      void execute(request).then(
        (result) => {
          postResponse({ id: requestId, ok: true, result });
        },
        (error) => {
          postResponse({
            id: requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof CodexBookmarkExecutionError
              ? { details: error.details }
              : {}),
          });
        },
      );
    });
    port.onDisconnect.addListener(() => {
      if (nativePort === port) nativePort = null;
    });
    return true;
  } catch (error) {
    console.warn('[bok] failed to connect Codex bookmark bridge', error);
    nativePort = null;
    return false;
  }
}
