import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';
import {
  AUTO_ARCHIVE_DAY_MS,
  archiveEligibleGroupsInMemory,
} from '../libs/saved-pages/auto-archive.ts';
import { mergeImportedSessions } from '../libs/saved-pages/session-import.ts';

const tab = (id, taskStatus = null) => ({
  id,
  url: `https://${id}.example`,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  tags: [],
  directory: null,
  taskStatus,
  taskCompletedAt: null,
  archivedAt: null,
});
const group = (id, title, createdAt, options = {}) => ({
  id,
  title,
  createdAt,
  grouped: true,
  locked: false,
  pinned: options.pinned ?? false,
  restoredAt: options.restoredAt ?? null,
  archivedAt: options.archivedAt ?? null,
  taskStatus: options.taskStatus ?? null,
  taskCompletedAt: null,
  tabs: options.tabs ?? [tab(`${id}-tab`)],
});
const session = (id, createdAt, groups) => ({ id, createdAt, groups });
const AUTO_ARCHIVE_AGE_MS = 7 * AUTO_ARCHIVE_DAY_MS;

const existing = [session('existing', 20, [group('existing-group', 'WBS', 20)])];
const imported = [
  session('imported', 10, [
    group('imported-group-1', 'WBS', 10),
    group('imported-group-2', 'Stonefront', 11),
  ]),
];
const merged = mergeImportedSessions(existing, imported);

assert.equal(existing[0].groups[0].title, 'WBS');
assert.equal(imported[0].groups[0].title, 'WBS');
assert.equal(merged.sessions[1].groups[0].title, 'WBS 1');
assert.deepEqual(merged.titleChanges, [{ from: 'WBS', to: 'WBS 1' }]);
assert.equal(merged.importedGroups, 2);
assert.equal(merged.skippedDuplicateGroups, 0);

const duplicateMerge = mergeImportedSessions(existing, existing);
assert.equal(duplicateMerge.sessions.length, 1);
assert.equal(duplicateMerge.importedGroups, 0);
assert.equal(duplicateMerge.skippedDuplicateGroups, 1);

const partialMerge = mergeImportedSessions(existing, [
  session('existing', 30, [
    group('existing-group', 'WBS changed', 30),
    group('new-group', 'New', 31),
  ]),
]);
assert.equal(partialMerge.sessions.length, 1);
assert.equal(partialMerge.sessions[0].groups.length, 2);
assert.equal(partialMerge.importedGroups, 1);
assert.equal(partialMerge.skippedDuplicateGroups, 1);

const archived = archiveEligibleGroupsInMemory(
  merged.sessions,
  AUTO_ARCHIVE_AGE_MS + 21,
  7,
);
assert.equal(archived, 3);
assert.ok(merged.sessions.every((item) => item.groups.every((item) => item.archivedAt)));

const now = AUTO_ARCHIVE_AGE_MS + 1_000;
assert.equal(group('newly-saved', 'Newly saved', now).restoredAt, null);
const archiveCandidates = session('archive-candidates', now, [
  group('older-than-a-week', 'Old', now - AUTO_ARCHIVE_AGE_MS - 1),
  group('exactly-a-week', 'Boundary', now - AUTO_ARCHIVE_AGE_MS),
  group('newer-than-a-week', 'New', now - AUTO_ARCHIVE_AGE_MS + 1),
  group('todo-group', 'Todo group', 0, { taskStatus: 'todo' }),
  group('doing-group', 'Doing group', 0, { taskStatus: 'doing' }),
  group('done-group', 'Done group', 0, { taskStatus: 'done' }),
  group('todo-tab', 'Todo tab', 0, { tabs: [tab('todo-tab-item', 'todo')] }),
  group('doing-tab', 'Doing tab', 0, {
    tabs: [tab('doing-tab-item', 'doing')],
  }),
  group('done-tab', 'Done tab', 0, { tabs: [tab('done-tab-item', 'done')] }),
  group('pinned-group', 'Pinned', 0, { pinned: true }),
  group('recently-restored', 'Restored', 0, { restoredAt: now }),
  group('already-archived', 'Archived', 0, { archivedAt: 500 }),
  group('empty-group', 'Empty', 0, { tabs: [] }),
]);

assert.equal(archiveEligibleGroupsInMemory([archiveCandidates], now, 7), 3);
assert.deepEqual(
  archiveCandidates.groups
    .filter((item) => item.archivedAt === now)
    .map((item) => item.id),
  ['older-than-a-week', 'done-group', 'done-tab'],
);

const restoredCreatedAt = now - AUTO_ARCHIVE_AGE_MS - 1;
const manuallyRestoredGroup = group(
  'manually-restored',
  'Manually restored',
  restoredCreatedAt,
  { restoredAt: now },
);
const equivalentOldGroup = group(
  'equivalent-old-group',
  'Equivalent old group',
  restoredCreatedAt,
);
const restoredGroupState = {
  createdAt: manuallyRestoredGroup.createdAt,
  pinned: manuallyRestoredGroup.pinned,
};
const equivalentGroupState = {
  createdAt: equivalentOldGroup.createdAt,
  pinned: equivalentOldGroup.pinned,
};

assert.equal(
  archiveEligibleGroupsInMemory(
    [session('manual-restore-exemption', now, [manuallyRestoredGroup, equivalentOldGroup])],
    now,
    7,
  ),
  1,
);
assert.equal(manuallyRestoredGroup.archivedAt, null);
assert.equal(manuallyRestoredGroup.restoredAt, now);
assert.equal(equivalentOldGroup.archivedAt, now);
assert.equal(equivalentOldGroup.restoredAt, null);
assert.deepEqual(
  {
    createdAt: manuallyRestoredGroup.createdAt,
    pinned: manuallyRestoredGroup.pinned,
  },
  restoredGroupState,
);
assert.deepEqual(
  {
    createdAt: equivalentOldGroup.createdAt,
    pinned: equivalentOldGroup.pinned,
  },
  equivalentGroupState,
);

const restoreAgeCandidates = session('restore-age-candidates', now, [
  group('restored-exactly-a-week', 'Restore boundary', 0, {
    restoredAt: now - AUTO_ARCHIVE_AGE_MS,
  }),
  group('restored-over-a-week', 'Restored old', 0, {
    restoredAt: now - AUTO_ARCHIVE_AGE_MS - 1,
  }),
]);
assert.equal(archiveEligibleGroupsInMemory([restoreAgeCandidates], now, 7), 1);
assert.deepEqual(
  restoreAgeCandidates.groups
    .filter((item) => item.archivedAt === now)
    .map((item) => item.id),
  ['restored-over-a-week'],
);

for (const period of [1, 3, 7, 30]) {
  const periodNow = period * AUTO_ARCHIVE_DAY_MS + 1_000;
  const periodCandidates = session(`period-${period}`, periodNow, [
    group(`period-${period}-boundary`, 'Boundary', 1_000),
    group(`period-${period}-over`, 'Over', 999),
  ]);
  assert.equal(
    archiveEligibleGroupsInMemory([periodCandidates], periodNow, period),
    1,
  );
  assert.deepEqual(
    periodCandidates.groups
      .filter((item) => item.archivedAt === periodNow)
      .map((item) => item.id),
    [`period-${period}-over`],
  );
}

const neverGroup = group('never-group', 'Never', 0);
assert.equal(
  archiveEligibleGroupsInMemory(
    [session('never-session', now, [neverGroup])],
    now,
    'never',
  ),
  0,
);
assert.equal(neverGroup.archivedAt, null);

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;
const {
  getSavedPagesAutoArchivePeriod,
  normalizeSavedPagesAutoArchivePeriod,
  SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY,
  setSavedPagesAutoArchivePeriod,
} = await import('../libs/saved-pages/settings.ts');
const {
  archiveEligibleGroups,
  getSavedGroup,
  setAutoArchivePeriod,
  setGroupArchived,
} = await import('../libs/saved-pages/store.ts');
const { exportSessionsJson, importSessionsJson } = await import(
  '../libs/saved-pages/persistence.ts'
);
const { isSavedPageCommand } = await import('../libs/saved-pages/messages.ts');

assert.equal(normalizeSavedPagesAutoArchivePeriod(undefined), 7);
assert.equal(normalizeSavedPagesAutoArchivePeriod(2), 7);
assert.equal(normalizeSavedPagesAutoArchivePeriod('7'), 7);
for (const period of [1, 3, 7, 30, 'never']) {
  assert.equal(normalizeSavedPagesAutoArchivePeriod(period), period);
}
assert.equal(await getSavedPagesAutoArchivePeriod(), 7);
await fakeBrowser.storage.local.set({
  [SAVED_PAGES_AUTO_ARCHIVE_PERIOD_KEY]: 2,
});
assert.equal(await getSavedPagesAutoArchivePeriod(), 7);
await assert.rejects(
  () => setSavedPagesAutoArchivePeriod(2),
  /自动归档周期无效/,
);
assert.equal(
  isSavedPageCommand({ type: 'bok/set-auto-archive-period', period: 'never' }),
  true,
);
assert.equal(
  isSavedPageCommand({ type: 'bok/set-auto-archive-period', period: 2 }),
  false,
);
assert.equal(
  isSavedPageCommand({
    type: 'bok/restore-group',
    sessionId: 'session',
    groupId: 'group',
  }),
  true,
);
assert.equal(
  isSavedPageCommand({ type: 'bok/restore-group', sessionId: 'session' }),
  false,
);
await fakeBrowser.storage.local.clear();

const storageNow = Date.now();
const storageCreatedAt = storageNow - AUTO_ARCHIVE_AGE_MS - 1;
const storageSessionId = 'storage-session';
const storageGroupId = 'storage-group';
const legacyStoredGroup = group(storageGroupId, 'Storage group', storageCreatedAt, {
  archivedAt: storageNow - 1,
});
delete legacyStoredGroup.restoredAt;
await fakeBrowser.storage.local.set({
  sessions: {
    schemaVersion: 1,
    revision: 0,
    sessions: [
      session(storageSessionId, storageCreatedAt, [
        legacyStoredGroup,
      ]),
    ],
  },
});

assert.equal(
  (await getSavedGroup(storageSessionId, storageGroupId)).restoredAt,
  null,
);
const restoreStartedAt = Date.now();
await setGroupArchived(storageSessionId, storageGroupId, false);
let stored = await fakeBrowser.storage.local.get('sessions');
let storedGroup = stored.sessions.sessions[0].groups[0];
assert.equal(storedGroup.archivedAt, null);
assert.equal(storedGroup.createdAt, storageCreatedAt);
assert.equal(storedGroup.pinned, false);
assert.ok(storedGroup.restoredAt >= restoreStartedAt);
const restoredAt = storedGroup.restoredAt;

assert.equal(await archiveEligibleGroups(restoredAt), 0);
stored = await fakeBrowser.storage.local.get('sessions');
storedGroup = stored.sessions.sessions[0].groups[0];
assert.equal(storedGroup.archivedAt, null);
assert.equal(storedGroup.createdAt, storageCreatedAt);
assert.equal(storedGroup.pinned, false);
assert.equal(storedGroup.restoredAt, restoredAt);

const exported = await exportSessionsJson();
fakeBrowser.reset();
const importResult = await importSessionsJson(exported);
assert.equal(importResult.archivedGroups, 0);
stored = await fakeBrowser.storage.local.get('sessions');
storedGroup = stored.sessions.sessions[0].groups[0];
assert.equal(storedGroup.archivedAt, null);
assert.equal(storedGroup.createdAt, storageCreatedAt);
assert.equal(storedGroup.pinned, false);
assert.equal(storedGroup.restoredAt, restoredAt);

await setGroupArchived(storageSessionId, storageGroupId, true);
stored = await fakeBrowser.storage.local.get('sessions');
storedGroup = stored.sessions.sessions[0].groups[0];
assert.equal(typeof storedGroup.archivedAt, 'number');
assert.equal(storedGroup.createdAt, storageCreatedAt);
assert.equal(storedGroup.pinned, false);
assert.equal(storedGroup.restoredAt, restoredAt);

const importNow = Date.now();
const periodImportJson = JSON.stringify({
  schemaVersion: 1,
  revision: 0,
  sessions: [
    session('period-import-session', importNow, [
      group(
        'period-import-group',
        'Period import',
        importNow - 2 * AUTO_ARCHIVE_DAY_MS,
      ),
    ]),
  ],
});

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
await fakeBrowser.storage.local.set({ sessions: 'invalid-but-unread' });
assert.equal(await archiveEligibleGroups(), 0);
assert.equal(
  (await fakeBrowser.storage.local.get('sessions')).sessions,
  'invalid-but-unread',
);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
let periodImportResult = await importSessionsJson(periodImportJson);
assert.equal(periodImportResult.archivedGroups, 0);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(stored.sessions.sessions[0].groups[0].archivedAt, null);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod(1);
periodImportResult = await importSessionsJson(periodImportJson);
assert.equal(periodImportResult.archivedGroups, 1);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(typeof stored.sessions.sessions[0].groups[0].archivedAt, 'number');

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod(7);
const immediateArchiveNow = Date.now();
await fakeBrowser.storage.local.set({
  sessions: {
    schemaVersion: 1,
    revision: 0,
    sessions: [
      session('immediate-archive-session', immediateArchiveNow, [
        group(
          'immediate-archive-group',
          'Immediate archive',
          immediateArchiveNow - 2 * AUTO_ARCHIVE_DAY_MS,
        ),
      ]),
    ],
  },
});
await setAutoArchivePeriod(1);
assert.equal(await getSavedPagesAutoArchivePeriod(), 1);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(typeof stored.sessions.sessions[0].groups[0].archivedAt, 'number');

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod(7);
await fakeBrowser.storage.local.set({
  sessions: { schemaVersion: 999, revision: 0, sessions: [] },
});
await assert.rejects(() => setAutoArchivePeriod(1), /Bok 数据来自更新版本/);
assert.equal(await getSavedPagesAutoArchivePeriod(), 7);
console.log('session import check passed');
