import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { fakeBrowser } from 'wxt/testing';

class MemoryFile {
  constructor(contents = '') {
    this.contents = contents;
    this.corruptNextWrite = false;
  }

  async getFile() {
    const contents = this.contents;
    return {
      text: async () =>
        typeof contents === 'string'
          ? contents
          : new TextDecoder().decode(contents),
      arrayBuffer: async () => {
        const bytes =
          typeof contents === 'string'
            ? new TextEncoder().encode(contents)
            : contents;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  async createWritable() {
    let pending = null;
    return {
      write: async (contents) => {
        if (typeof contents === 'string') {
          pending = contents;
          return;
        }
        if (contents instanceof ArrayBuffer) {
          pending = new Uint8Array(contents.slice(0));
          return;
        }
        pending = new Uint8Array(
          contents.buffer.slice(
            contents.byteOffset,
            contents.byteOffset + contents.byteLength,
          ),
        );
      },
      close: async () => {
        if (pending == null) return;
        this.contents = this.corruptNextWrite
          ? typeof pending === 'string'
            ? `${pending}corrupted`
            : new Uint8Array([...pending, 0])
          : pending;
        this.corruptNextWrite = false;
      },
      abort: async () => undefined,
    };
  }
}

class MemoryDirectory {
  constructor(name) {
    this.name = name;
    this.kind = 'directory';
    this.directories = new Map();
    this.files = new Map();
    this.permission = 'granted';
  }

  async queryPermission() {
    return this.permission;
  }

  async requestPermission() {
    return this.permission;
  }

  async getDirectoryHandle(name, options = {}) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options.create) throw new DOMException('Missing directory', 'NotFoundError');
    const directory = new MemoryDirectory(name);
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name, options = {}) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options.create) throw new DOMException('Missing file', 'NotFoundError');
    const file = new MemoryFile();
    this.files.set(name, file);
    return file;
  }

  async *entries() {
    for (const [name, directory] of this.directories) yield [name, directory];
    for (const [name, file] of this.files) yield [name, { kind: 'file', ...file }];
  }

  async removeEntry(name) {
    this.files.delete(name);
    this.directories.delete(name);
  }
}

function installIndexedDbMock() {
  const stores = new Map();

  function complete(transaction) {
    setTimeout(() => transaction.oncomplete?.(), 0);
  }

  globalThis.indexedDB = {
    open: () => {
      const request = { result: null, error: null };
      const database = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore: (name) => {
          if (!stores.has(name)) stores.set(name, new Map());
        },
        transaction: (name) => {
          const transaction = { oncomplete: null, onerror: null, onabort: null };
          const store = stores.get(name);
          transaction.objectStore = () => ({
            get: (key) => {
              const getRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
              setTimeout(() => {
                getRequest.result = store.get(key);
                getRequest.onsuccess?.();
              }, 0);
              complete(transaction);
              return getRequest;
            },
            put: (value, key) => {
              store.set(key, value);
              complete(transaction);
            },
          });
          return transaction;
        },
        close: () => undefined,
      };
      request.result = database;
      setTimeout(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

function directoryAt(root, path) {
  return path.split('/').reduce((directory, name) => {
    const child = directory.directories.get(name);
    assert.ok(child, `missing directory ${path}`);
    return child;
  }, root);
}

function fileAt(root, path) {
  const parts = path.split('/');
  const fileName = parts.pop();
  const directory = parts.length === 0 ? root : directoryAt(root, parts.join('/'));
  const file = directory.files.get(fileName);
  assert.ok(file, `missing file ${path}`);
  return file;
}

async function readText(root, path) {
  return (await fileAt(root, path).getFile()).text();
}

async function readBytes(root, path) {
  return Array.from(
    new Uint8Array(await (await fileAt(root, path).getFile()).arrayBuffer()),
  );
}

async function snapshotDirectory(directory) {
  const snapshot = {};
  for (const [name, child] of directory.directories) {
    snapshot[`directory:${name}`] = await snapshotDirectory(child);
  }
  for (const [name, file] of directory.files) {
    snapshot[`file:${name}`] = Array.from(
      new Uint8Array(await (await file.getFile()).arrayBuffer()),
    );
  }
  return snapshot;
}

async function readZip(root, path) {
  const bytes = new Uint8Array(await (await fileAt(root, path).getFile()).arrayBuffer());
  return JSZip.loadAsync(bytes);
}

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;
installIndexedDbMock();

const root = new MemoryDirectory('backup-root');
const legacySavedPages = '{"schemaVersion":1,"revision":1,"sessions":[]}\n';
root.files.set('bok-saved-pages.json', new MemoryFile(legacySavedPages));
globalThis.window = {
  showDirectoryPicker: async () => root,
};

fakeBrowser.permissions.contains = async () => true;
fakeBrowser.bookmarks.getChildren = async () => [
  { id: '1', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' },
];
fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [
      { id: '2', title: 'Folder', children: [{ id: '3', title: 'Bok', url: 'https://bok.example' }] },
    ],
  },
];

const settings = await import('../libs/saved-pages/settings.ts');
const aiSettings = await import('../libs/bookmarks/organization-ai-settings.ts');
const backup = await import('../libs/backup/backup.ts');

await fakeBrowser.storage.local.set({
  [settings.SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY]: 3,
  [settings.THEME_PREFERENCE_KEY]: 'dark',
  [aiSettings.BOOKMARK_ORGANIZATION_AI_SETTINGS_KEY]: {
    schemaVersion: 1,
    endpoint: 'https://api.example.com/v1/responses',
    apiKey: 'backup-key',
    model: 'backup-model',
    preference: '保留技术文档。',
  },
  sessions: { schemaVersion: 1, revision: 4, sessions: [] },
});

await backup.chooseBookmarkBackupDirectory();
assert.equal(await backup.getBackupDeviceName(), 'personal');

const first = await backup.runBookmarkBackup(true);
assert.equal(first.status, 'success');
assert.equal(first.state.lastSavedPagesBackupFileName, 'devices/personal/bok-saved-pages.json');
assert.equal(first.state.lastReadingListBackupFileName, 'shared/bok-reading-list.json');
assert.equal(first.state.lastSettingsBackupFileName, 'devices/personal/bok-settings.json');
assert.equal(first.state.lastBackupFileName, 'shared/bok-bookmarks.json');
assert.equal(first.state.lastArchiveBackupFileName, 'shared/bok-bookmark-archive.json');
assert.equal(await readText(root, 'bok-saved-pages.json'), legacySavedPages);

const firstClaim = JSON.parse(await readText(root, 'devices/personal/device.json'));
assert.equal(firstClaim.deviceName, 'personal');
assert.equal(typeof firstClaim.claimId, 'string');
assert.equal(
  (await fakeBrowser.storage.local.get(backup.BACKUP_DEVICE_CLAIM_ID_KEY))[
    backup.BACKUP_DEVICE_CLAIM_ID_KEY
  ],
  firstClaim.claimId,
);
assert.equal(JSON.parse(await readText(root, 'devices/personal/bok-saved-pages.json')).schemaVersion, 3);
const readingListBackup = JSON.parse(
  await readText(root, 'shared/bok-reading-list.json'),
);
assert.deepEqual(readingListBackup, {
  schemaVersion: 1,
  kind: 'bok-reading-list',
  revision: 0,
  items: [],
});
const settingsBackup = JSON.parse(await readText(root, 'devices/personal/bok-settings.json'));
assert.equal(settingsBackup.schemaVersion, 2);
assert.deepEqual(settingsBackup.settings, {
  savedPagesAutoArchivePeriod: 3,
  theme: 'dark',
  bookmarkOrganizationAi: {
    schemaVersion: 1,
    endpoint: 'https://api.example.com/v1/responses',
    apiKey: 'backup-key',
    model: 'backup-model',
    preference: '保留技术文档。',
  },
});
assert.deepEqual(Object.keys(settingsBackup.settings).sort(), [
  'bookmarkOrganizationAi',
  'savedPagesAutoArchivePeriod',
  'theme',
]);
assert.equal(JSON.stringify(settingsBackup).includes('claimId'), false);
assert.equal(JSON.stringify(settingsBackup).includes('deviceName'), false);
assert.equal(JSON.stringify(settingsBackup).includes('bookmarkBackupState'), false);
assert.equal(root.files.has('bok-bookmarks.json'), false);
assert.equal(root.files.has('bok-bookmark-archive.json'), false);
assert.equal(root.files.has('bok-reading-list.json'), false);
assert.equal(directoryAt(root, 'devices/personal').files.has('bok-bookmarks.json'), false);
assert.equal(directoryAt(root, 'devices/personal').files.has('bok-reading-list.json'), false);
assert.equal(directoryAt(root, 'shared').files.has('bok-saved-pages.json'), false);

const deviceWeekly = first.state.lastWeeklyBackupFileName;
const sharedWeekly = first.state.lastSharedWeeklyBackupFileName;
assert.ok(deviceWeekly?.startsWith('devices/personal/history/'));
assert.ok(sharedWeekly?.startsWith('shared/history/'));
assert.deepEqual(
  Object.keys((await readZip(root, deviceWeekly)).files).sort(),
  ['bok-saved-pages.json', 'bok-settings.json'],
);
assert.deepEqual(
  Object.keys((await readZip(root, sharedWeekly)).files).sort(),
  ['bok-bookmark-archive.json', 'bok-bookmarks.json', 'bok-reading-list.json'],
);
const firstDeviceWeeklyBytes = await readBytes(root, deviceWeekly);
let firstSharedWeeklyBytes = await readBytes(root, sharedWeekly);

const claimBeforeReuse = await readText(root, 'devices/personal/device.json');
await backup.saveBackupDeviceName(' Personal ');
assert.equal(await readText(root, 'devices/personal/device.json'), claimBeforeReuse);
assert.equal((await backup.runBookmarkBackup(true)).status, 'success');

const ordinaryBackup = backup.runBookmarkBackup(false);
const queuedForcedBackup = backup.runBookmarkBackup(true);
assert.notEqual(queuedForcedBackup, ordinaryBackup);
assert.equal((await ordinaryBackup).status, 'already-backed-up');
assert.equal((await queuedForcedBackup).status, 'success');

const stateBeforeSharedPathCorrection = await backup.getBookmarkBackupState();
await fakeBrowser.storage.local.set({
  [backup.BOOKMARK_BACKUP_STATE_KEY]: {
    ...stateBeforeSharedPathCorrection,
    lastReadingListBackupFileName: 'devices/personal/bok-reading-list.json',
  },
});
const correctedSharedPathBackup = await backup.runBookmarkBackup(false);
assert.equal(correctedSharedPathBackup.status, 'success');
assert.equal(
  correctedSharedPathBackup.state.lastReadingListBackupFileName,
  'shared/bok-reading-list.json',
);
assert.deepEqual(
  await readBytes(root, correctedSharedPathBackup.state.lastWeeklyBackupFileName),
  firstDeviceWeeklyBytes,
);
assert.deepEqual(
  Object.keys((await readZip(
    root,
    correctedSharedPathBackup.state.lastSharedWeeklyBackupFileName,
  )).files).sort(),
  ['bok-bookmark-archive.json', 'bok-bookmarks.json', 'bok-reading-list.json'],
);
firstSharedWeeklyBytes = await readBytes(
  root,
  correctedSharedPathBackup.state.lastSharedWeeklyBackupFileName,
);

for (const invalidName of ['', 'personal/work', 'A'.repeat(33)]) {
  await assert.rejects(() => backup.saveBackupDeviceName(invalidName), /机器名称只能包含/);
}
assert.equal(await backup.getBackupDeviceName(), 'personal');
assert.equal(directoryAt(root, 'devices/personal').directories.has('work'), false);

const personalSavedBeforeConflict = await readText(root, 'devices/personal/bok-saved-pages.json');
await fakeBrowser.storage.local.set({
  [backup.BACKUP_DEVICE_NAME_KEY]: 'personal',
  [backup.BACKUP_DEVICE_CLAIM_ID_KEY]: 'other-machine-claim',
});
await assert.rejects(
  () => backup.saveBackupDeviceName('personal'),
  (error) => error instanceof backup.BackupDeviceNameConflictError,
);
assert.equal(await readText(root, 'devices/personal/device.json'), claimBeforeReuse);
assert.equal(await readText(root, 'devices/personal/bok-saved-pages.json'), personalSavedBeforeConflict);
const rootBeforeConflictBackup = await snapshotDirectory(root);
const conflictBackup = await backup.runBookmarkBackup(true);
assert.equal(conflictBackup.status, 'failed');
assert.match(conflictBackup.state.lastError ?? '', /已被其他电脑使用/);
assert.deepEqual(await snapshotDirectory(root), rootBeforeConflictBackup);

await backup.takeOverBackupDeviceName('personal');
const takeoverClaim = JSON.parse(await readText(root, 'devices/personal/device.json'));
assert.notEqual(takeoverClaim.claimId, firstClaim.claimId);
assert.equal(
  (await fakeBrowser.storage.local.get(backup.BACKUP_DEVICE_CLAIM_ID_KEY))[backup.BACKUP_DEVICE_CLAIM_ID_KEY],
  takeoverClaim.claimId,
);
const takeoverBackup = await backup.runBookmarkBackup(true);
assert.equal(takeoverBackup.status, 'success');
assert.notEqual(takeoverBackup.state.lastWeeklyBackupFileName, deviceWeekly);
assert.notEqual(takeoverBackup.state.lastSharedWeeklyBackupFileName, sharedWeekly);
assert.deepEqual(await readBytes(root, deviceWeekly), firstDeviceWeeklyBytes);
assert.deepEqual(await readBytes(root, sharedWeekly), firstSharedWeeklyBytes);

const rootAfterTakeoverBackup = await snapshotDirectory(root);
await fakeBrowser.storage.local.set({
  [backup.BACKUP_DEVICE_NAME_KEY]: 'personal',
  [backup.BACKUP_DEVICE_CLAIM_ID_KEY]: firstClaim.claimId,
});
const oldDeviceBackup = await backup.runBookmarkBackup(false);
assert.equal(oldDeviceBackup.status, 'failed');
assert.match(oldDeviceBackup.state.lastError ?? '', /已被其他电脑使用/);
assert.deepEqual(await snapshotDirectory(root), rootAfterTakeoverBackup);
await fakeBrowser.storage.local.set({
  [backup.BACKUP_DEVICE_NAME_KEY]: 'personal',
  [backup.BACKUP_DEVICE_CLAIM_ID_KEY]: takeoverClaim.claimId,
});

const personalSavedBeforeRename = await readText(root, 'devices/personal/bok-saved-pages.json');
const personalStateBeforeRename = await backup.getBookmarkBackupState();
const personalDeviceWeeklyPath = personalStateBeforeRename.lastWeeklyBackupFileName;
const personalSharedWeeklyPath = personalStateBeforeRename.lastSharedWeeklyBackupFileName;
const personalDeviceWeeklyBeforeRename = await readBytes(
  root,
  personalDeviceWeeklyPath,
);
const personalSharedWeeklyBeforeRename = await readBytes(
  root,
  personalSharedWeeklyPath,
);
await backup.saveBackupDeviceName('work');
assert.equal((await backup.runBookmarkBackup(true)).status, 'success');
assert.equal(await backup.getBackupDeviceName(), 'work');
assert.ok(fileAt(root, 'devices/work/device.json'));
assert.ok(fileAt(root, 'devices/work/bok-saved-pages.json'));
assert.equal(await readText(root, 'devices/personal/bok-saved-pages.json'), personalSavedBeforeRename);
const currentState = await backup.getBookmarkBackupState();
assert.equal(currentState.lastReadingListBackupFileName, 'shared/bok-reading-list.json');
const workClaim = JSON.parse(await readText(root, 'devices/work/device.json'));
assert.equal(workClaim.deviceName, 'work');
assert.notEqual(workClaim.claimId, takeoverClaim.claimId);
assert.equal(
  (await fakeBrowser.storage.local.get(backup.BACKUP_DEVICE_CLAIM_ID_KEY))[
    backup.BACKUP_DEVICE_CLAIM_ID_KEY
  ],
  workClaim.claimId,
);
assert.ok(currentState.lastWeeklyBackupFileName?.startsWith('devices/work/history/'));
assert.ok(currentState.lastSharedWeeklyBackupFileName?.startsWith('shared/history/'));
assert.equal(directoryAt(root, 'devices/personal').files.has('bok-reading-list.json'), false);
assert.equal(directoryAt(root, 'devices/work').files.has('bok-reading-list.json'), false);
assert.equal(
  JSON.parse(await readText(root, 'shared/bok-reading-list.json')).kind,
  'bok-reading-list',
);
assert.deepEqual(
  Object.keys((await readZip(root, currentState.lastWeeklyBackupFileName)).files).sort(),
  ['bok-saved-pages.json', 'bok-settings.json'],
);
assert.deepEqual(
  Object.keys((await readZip(root, currentState.lastSharedWeeklyBackupFileName)).files).sort(),
  ['bok-bookmark-archive.json', 'bok-bookmarks.json', 'bok-reading-list.json'],
);
assert.deepEqual(
  await readBytes(root, personalDeviceWeeklyPath),
  personalDeviceWeeklyBeforeRename,
);
assert.deepEqual(
  await readBytes(root, personalSharedWeeklyPath),
  personalSharedWeeklyBeforeRename,
);

fileAt(root, 'devices/work/bok-saved-pages.json').corruptNextWrite = true;
const failed = await backup.runBookmarkBackup(true);
assert.equal(failed.status, 'failed');
assert.match(failed.state.lastError ?? '', /写入后校验失败/);
assert.equal(failed.state.lastSuccessfulBackupDay, currentState.lastSuccessfulBackupDay);
assert.equal(failed.state.lastSuccessfulBackupAt, currentState.lastSuccessfulBackupAt);

await fakeBrowser.storage.local.set({
  [backup.BOOKMARK_BACKUP_STATE_KEY]: {
    ...currentState,
    lastSuccessfulWeeklyBackupWeek: null,
  },
});
fileAt(root, currentState.lastWeeklyBackupFileName).corruptNextWrite = true;
const binaryFailed = await backup.runBookmarkBackup(true);
assert.equal(binaryFailed.status, 'failed');
assert.match(binaryFailed.state.lastError ?? '', /写入后校验失败/);
assert.equal(binaryFailed.state.lastSuccessfulBackupAt, currentState.lastSuccessfulBackupAt);

const devices = directoryAt(root, 'devices');
const broken = await devices.getDirectoryHandle('broken', { create: true });
broken.files.set('device.json', new MemoryFile('{broken json'));
await assert.rejects(
  () => backup.saveBackupDeviceName('broken'),
  (error) => error instanceof backup.BackupDeviceNameConflictError,
);
await backup.takeOverBackupDeviceName('broken');
assert.equal(
  JSON.parse(await readText(root, 'devices/broken/device.json')).deviceName,
  'broken',
);

await devices.getDirectoryHandle('dup', { create: true });
await devices.getDirectoryHandle('DUP', { create: true });
await assert.rejects(
  () => backup.saveBackupDeviceName('dup'),
  /存在多个.*大小写等价的目录/,
);

root.permission = 'denied';
const offlineNameState = await backup.saveBackupDeviceName('offline');
assert.equal(offlineNameState.deviceName, 'offline');
assert.equal(await backup.getBackupDeviceName(), 'offline');
root.permission = 'granted';

console.log('bookmark backup check passed');
