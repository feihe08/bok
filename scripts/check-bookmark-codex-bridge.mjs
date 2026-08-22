import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;
fakeBrowser.runtime.id = 'bok-test';
fakeBrowser.runtime.getManifest = () => ({ version: '0.0.0' });

const nodes = new Map([
  ['0', { id: '0', title: '' }],
  ['1', { id: '1', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' }],
  ['25', { id: '25', title: 'Todo', parentId: '1', index: 0 }],
  ['125', { id: '125', title: 'Read Source', parentId: '1', index: 1 }],
  ['126', { id: '126', title: 'Other Source', parentId: '1', index: 2 }],
  [
    '152',
    {
      id: '152',
      title: '从数据库到 AI - 学习让我快乐',
      url: 'https://example.com/article',
      parentId: '125',
      index: 0,
    },
  ],
  [
    '153',
    {
      id: '153',
      title: 'Later sibling',
      url: 'https://example.com/later',
      parentId: '125',
      index: 2,
    },
  ],
  [
    '154',
    {
      id: '154',
      title: 'Other source article',
      url: 'https://example.com/other',
      parentId: '126',
      index: 0,
    },
  ],
]);
const calls = [];
const api = {
  async get(id) {
    const node = nodes.get(id);
    return node ? [{ ...node }] : [];
  },
  async getTree() {
    return [{ ...nodes.get('1') }];
  },
  async update(id, changes) {
    const node = nodes.get(id);
    if (!node) throw new Error('missing');
    Object.assign(node, changes);
    calls.push(['update', id, changes]);
    return { ...node };
  },
  async move(id, destination) {
    const node = nodes.get(id);
    if (!node) throw new Error('missing');
    Object.assign(node, destination);
    calls.push(['move', id, destination]);
    return { ...node };
  },
};

const { executeCodexBookmarkRequest, parseCodexBookmarkRequest } = await import(
  '../libs/bookmarks/codex-bridge.ts'
);

const operations = [
  {
    type: 'rename-folder',
    expected: {
      id: '125',
      kind: 'folder',
      title: 'Read Source',
      url: null,
      parentId: '1',
      index: 1,
    },
    title: 'blog',
  },
  {
    type: 'move-bookmark',
    expected: {
      id: '152',
      kind: 'bookmark',
      title: '从数据库到 AI - 学习让我快乐',
      url: 'https://example.com/article',
      parentId: '125',
      index: 0,
    },
    destination: {
      expected: {
        id: '25',
        kind: 'folder',
        title: 'Todo',
        url: null,
        parentId: '1',
        index: 0,
      },
      index: null,
    },
  },
];

const preview = await executeCodexBookmarkRequest(
  {
    id: 'preview',
    type: 'bok/bookmarks/plan',
    apply: false,
    operations,
  },
  api,
);
assert.equal(preview.applied, false);
assert.equal(preview.operations.length, 2);
assert.deepEqual(calls, []);

const applied = await executeCodexBookmarkRequest(
  {
    id: 'apply',
    type: 'bok/bookmarks/plan',
    apply: true,
    operations,
  },
  api,
);
assert.equal(applied.applied, true);
assert.equal(nodes.get('125').title, 'blog');
assert.equal(nodes.get('152').parentId, '25');

await assert.rejects(
  executeCodexBookmarkRequest(
    {
      id: 'stale',
      type: 'bok/bookmarks/plan',
      apply: false,
      operations: [operations[0]],
    },
    api,
  ),
  /title 已变化/,
);

assert.throws(
  () =>
    parseCodexBookmarkRequest({
      id: 'duplicate',
      type: 'bok/bookmarks/plan',
      apply: false,
      operations: [operations[1], operations[1]],
    }),
  /不能重复操作/,
);

nodes.get('125').title = 'Read Source';
nodes.get('152').parentId = '125';
let moveAttempts = 0;
const failingApi = {
  ...api,
  async move(id, destination) {
    moveAttempts += 1;
    if (moveAttempts === 1) throw new Error('move failed');
    return api.move(id, destination);
  },
};
await assert.rejects(
  executeCodexBookmarkRequest(
    {
      id: 'rollback',
      type: 'bok/bookmarks/plan',
      apply: true,
      operations,
    },
    failingApi,
  ),
  /已回滚此前操作/,
);
assert.equal(nodes.get('125').title, 'Read Source');

await assert.rejects(
  executeCodexBookmarkRequest(
    {
      id: 'root-folder',
      type: 'bok/bookmarks/plan',
      apply: false,
      operations: [
        {
          type: 'rename-folder',
          expected: {
            id: '0',
            kind: 'folder',
            title: '',
            url: null,
            parentId: null,
            index: null,
          },
          title: 'Root',
        },
      ],
    },
    api,
  ),
  /根目录/,
);

calls.length = 0;
await executeCodexBookmarkRequest(
  {
    id: 'multi-source-order',
    type: 'bok/bookmarks/plan',
    apply: true,
    operations: [
      operations[1],
      {
        type: 'move-bookmark',
        expected: {
          id: '154',
          kind: 'bookmark',
          title: 'Other source article',
          url: 'https://example.com/other',
          parentId: '126',
          index: 0,
        },
        destination: operations[1].destination,
      },
      {
        type: 'move-bookmark',
        expected: {
          id: '153',
          kind: 'bookmark',
          title: 'Later sibling',
          url: 'https://example.com/later',
          parentId: '125',
          index: 2,
        },
        destination: operations[1].destination,
      },
    ],
  },
  api,
);
assert.deepEqual(
  calls.filter(([type]) => type === 'move').map(([, id]) => id),
  ['153', '152', '154'],
);

console.log('codex bookmark bridge checks passed');
