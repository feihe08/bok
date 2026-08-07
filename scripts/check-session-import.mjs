import assert from 'node:assert/strict';
import {
  AUTO_ARCHIVE_AGE_MS,
  archiveEligibleGroupsInMemory,
} from '../lib/auto-archive.ts';
import { mergeImportedSessions } from '../lib/session-import.ts';

const tab = (id) => ({
  id,
  url: `https://${id}.example`,
  title: id,
  taskStatus: null,
});
const group = (id, title, createdAt) => ({
  id,
  title,
  createdAt,
  grouped: true,
  pinned: false,
  archivedAt: null,
  taskStatus: null,
  tabs: [tab(`${id}-tab`)],
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
assert.throws(() => mergeImportedSessions(existing, existing), /ID 冲突/);

const archived = archiveEligibleGroupsInMemory(
  merged.sessions,
  AUTO_ARCHIVE_AGE_MS + 20,
);
assert.equal(archived, 3);
assert.ok(merged.sessions.every((item) => item.groups.every((item) => item.archivedAt)));
console.log('session import check passed');
