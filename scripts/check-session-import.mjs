import assert from 'node:assert/strict';
import {
  AUTO_ARCHIVE_AGE_MS,
  archiveEligibleGroupsInMemory,
} from '../libs/saved-pages/auto-archive.ts';
import { mergeImportedSessions } from '../libs/saved-pages/session-import.ts';

const tab = (id, taskStatus = null) => ({
  id,
  url: `https://${id}.example`,
  title: id,
  taskStatus,
});
const group = (id, title, createdAt, options = {}) => ({
  id,
  title,
  createdAt,
  grouped: true,
  pinned: options.pinned ?? false,
  archivedAt: options.archivedAt ?? null,
  taskStatus: options.taskStatus ?? null,
  tabs: options.tabs ?? [tab(`${id}-tab`)],
});
const session = (id, createdAt, groups) => ({ id, createdAt, groups });

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
);
assert.equal(archived, 3);
assert.ok(merged.sessions.every((item) => item.groups.every((item) => item.archivedAt)));

const now = AUTO_ARCHIVE_AGE_MS + 1_000;
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
  group('already-archived', 'Archived', 0, { archivedAt: 500 }),
  group('empty-group', 'Empty', 0, { tabs: [] }),
]);

assert.equal(archiveEligibleGroupsInMemory([archiveCandidates], now), 3);
assert.deepEqual(
  archiveCandidates.groups
    .filter((item) => item.archivedAt === now)
    .map((item) => item.id),
  ['older-than-a-week', 'done-group', 'done-tab'],
);
console.log('session import check passed');
