import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;

const persistence = await import('../libs/reading-list/persistence.ts');
const store = await import('../libs/reading-list/store.ts');

assert.deepEqual(await persistence.getReadingListItems(), []);

const first = await store.addReadingListItem({
  url: 'https://example.com/article?source=one#intro',
  title: '  First article  ',
});
assert.equal(first.status, 'added');
assert.equal(first.added, true);
assert.equal(first.item.title, 'First article');
assert.equal(first.item.note, '');

const duplicate = await store.addReadingListItem({
  url: 'https://example.com/article?source=one#intro',
  title: 'Changed title',
});
assert.equal(duplicate.status, 'duplicate');
assert.equal(duplicate.added, false);
assert.deepEqual(duplicate.item, first.item);

const differentFullUrl = await store.addReadingListItem({
  url: 'https://example.com/article?source=one#conclusion',
  title: '',
});
assert.equal(differentFullUrl.status, 'added');
assert.equal(differentFullUrl.item.title, differentFullUrl.item.url);

const exactRawUrl = 'https://Example.COM/%7Earticle?encoded=%2F#Section';
const exactRaw = await store.addReadingListItem({
  url: exactRawUrl,
  title: 'Exact raw URL',
});
assert.equal(exactRaw.item.url, exactRawUrl);

const multilineNote = '第一行\n\n  保留前导空格\n最后一行  ';
const updated = await store.updateReadingListNote(first.item.id, multilineNote);
assert.equal(updated.note, multilineNote);
assert.ok(updated.updatedAt >= updated.createdAt);
assert.equal(
  (await store.getReadingListItems()).find((item) => item.id === first.item.id)?.note,
  multilineNote,
);

const exported = JSON.parse(await persistence.exportReadingListJson());
assert.equal(exported.schemaVersion, 1);
assert.equal(exported.kind, 'bok-reading-list');
assert.equal(exported.items.length, 3);

const originalStore = (await fakeBrowser.storage.local.get(persistence.READING_LIST_KEY))[
  persistence.READING_LIST_KEY
];
const importResult = await persistence.importReadingListJson(JSON.stringify({
  schemaVersion: 1,
  kind: 'bok-reading-list',
  revision: 7,
  items: [
    {
      ...updated,
      note: 'must not replace existing note',
    },
    {
      id: differentFullUrl.item.id,
      url: 'https://example.com/id-collision',
      title: 'ID collision',
      note: 'new item',
      createdAt: 10,
      updatedAt: 10,
    },
    {
      id: 'second-source-id',
      url: 'https://example.com/imported',
      title: 'Imported',
      note: '',
      createdAt: 11,
      updatedAt: 11,
    },
    {
      id: 'later-duplicate-url',
      url: 'https://example.com/imported',
      title: 'Later duplicate URL',
      note: 'ignored',
      createdAt: 12,
      updatedAt: 12,
    },
  ],
}));
assert.deepEqual(importResult, {
  kind: 'reading-list',
  importedItems: 2,
  skippedDuplicateUrls: 2,
  regeneratedIds: 1,
});
const importedItems = await store.getReadingListItems();
assert.equal(importedItems.find((item) => item.url === updated.url)?.note, multilineNote);
assert.notEqual(
  importedItems.find((item) => item.url === 'https://example.com/id-collision')?.id,
  differentFullUrl.item.id,
);
assert.deepEqual(
  (await fakeBrowser.storage.local.get(persistence.READING_LIST_IMPORT_BACKUP_KEY))[
    persistence.READING_LIST_IMPORT_BACKUP_KEY
  ].value,
  originalStore,
);

const stateBeforeInvalidImports = await fakeBrowser.storage.local.get([
  persistence.READING_LIST_KEY,
  persistence.READING_LIST_IMPORT_BACKUP_KEY,
]);
const validImportedItem = {
  id: 'invalid-import-item',
  url: 'https://example.com/invalid-import',
  title: 'Invalid import',
  note: '',
  createdAt: 100,
  updatedAt: 100,
};
for (const [label, item, error] of [
  ['non-http URL', { ...validImportedItem, url: 'ftp://example.com/article' }, /url 无效/],
  ['invalid URL', { ...validImportedItem, url: 'https://example .com' }, /url 无效/],
  ['leading whitespace URL', { ...validImportedItem, url: ' https://example.com/article' }, /url 无效/],
  ['negative timestamp', { ...validImportedItem, createdAt: -1 }, /createdAt 无效/],
  ['fractional timestamp', { ...validImportedItem, createdAt: 1.5 }, /createdAt 无效/],
  [
    'out-of-range timestamp',
    { ...validImportedItem, createdAt: 8_640_000_000_000_001 },
    /createdAt 无效/,
  ],
  ['invalid updated timestamp', { ...validImportedItem, updatedAt: -1 }, /updatedAt 无效/],
  [
    'updated before created',
    { ...validImportedItem, createdAt: 101, updatedAt: 100 },
    /updatedAt 不能早于 createdAt/,
  ],
]) {
  await assert.rejects(
    () => persistence.importReadingListJson(JSON.stringify({
      schemaVersion: 1,
      kind: 'bok-reading-list',
      revision: 1,
      items: [item],
    })),
    error,
    label,
  );
  assert.deepEqual(
    await fakeBrowser.storage.local.get([
      persistence.READING_LIST_KEY,
      persistence.READING_LIST_IMPORT_BACKUP_KEY,
    ]),
    stateBeforeInvalidImports,
    `${label} must not write data or an import snapshot`,
  );
}

const invalidStoredList = {
  schemaVersion: 1,
  kind: 'bok-reading-list',
  revision: 0,
  items: [{ ...validImportedItem, url: 'file:///private/article' }],
};
await fakeBrowser.storage.local.set({
  [persistence.READING_LIST_KEY]: invalidStoredList,
});
await assert.rejects(() => persistence.getReadingListItems(), /url 无效/);
await assert.rejects(() => persistence.writeReadingList([]), /url 无效/);
assert.deepEqual(
  (await fakeBrowser.storage.local.get(persistence.READING_LIST_KEY))[persistence.READING_LIST_KEY],
  invalidStoredList,
);

await fakeBrowser.storage.local.set({ [persistence.READING_LIST_KEY]: originalStore });
await store.deleteReadingListItem(first.item.id);
assert.equal(
  (await store.getReadingListItems()).some((item) => item.id === first.item.id),
  false,
);
await assert.rejects(() => store.deleteReadingListItem(first.item.id), /找不到要删除/);

fakeBrowser.reset();
await fakeBrowser.storage.local.set({
  [persistence.READING_LIST_KEY]: {
    schemaVersion: 2,
    kind: 'bok-reading-list',
    revision: 0,
    items: [],
  },
});
await assert.rejects(() => persistence.getReadingListItems(), /来自更新版本/);
await assert.rejects(() => persistence.writeReadingList([]), /来自更新版本/);

console.log('reading list check passed');
