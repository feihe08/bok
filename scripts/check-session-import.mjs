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

const firstStoredGroup = (stored) => {
  for (const session of stored.sessions.sessions) {
    if (session.legacyGroups?.[0]) return session.legacyGroups[0];
    const item = session.items?.find((candidate) => candidate.type === 'group');
    if (item) return item.group;
  }
  return undefined;
};
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
const session = (id, createdAt, groups) => ({
  id,
  createdAt,
  title: '',
  locked: false,
  pinned: false,
  restoredAt: null,
  archivedAt: null,
  taskStatus: null,
  taskCompletedAt: null,
  items: groups.map((group) => ({ type: 'group', group })),
  groups,
});
const directSession = (id, createdAt, tabs) => ({
  id,
  createdAt,
  title: '',
  locked: false,
  pinned: false,
  restoredAt: null,
  archivedAt: null,
  taskStatus: null,
  taskCompletedAt: null,
  items: tabs.map((savedTab) => ({ type: 'tab', tab: savedTab })),
});
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
assert.equal(
  merged.sessions[1].items.find((item) => item.type === 'group').group.title,
  'WBS 1',
);
assert.deepEqual(merged.titleChanges, [{ from: 'WBS', to: 'WBS 1' }]);
assert.equal(merged.importedGroups, 2);
assert.equal(merged.skippedDuplicateGroups, 0);

const duplicateMerge = mergeImportedSessions(existing, existing);
assert.equal(duplicateMerge.sessions.length, 1);
assert.equal(duplicateMerge.importedSessions, 0);
assert.equal(duplicateMerge.importedGroups, 0);
assert.equal(duplicateMerge.skippedDuplicateGroups, 1);

const duplicateGroupNewSession = mergeImportedSessions(existing, [
  session('different-session', 30, [group('existing-group', 'Duplicate', 30)]),
]);
assert.equal(duplicateGroupNewSession.sessions.length, 1);
assert.equal(duplicateGroupNewSession.importedSessions, 0);
assert.equal(duplicateGroupNewSession.importedGroups, 0);
assert.equal(duplicateGroupNewSession.importedTabs, 0);
assert.equal(duplicateGroupNewSession.skippedDuplicateGroups, 1);

const existingDirectSession = directSession('same-direct-session', 1, [
  tab('same-direct-tab'),
]);
const duplicateDirectMerge = mergeImportedSessions(
  [existingDirectSession],
  [directSession('same-direct-session', 1, [tab('same-direct-tab')])],
);
assert.equal(duplicateDirectMerge.sessions.length, 1);
assert.equal(duplicateDirectMerge.sessions[0].items.length, 1);
assert.equal(duplicateDirectMerge.sessions[0].items[0].tab.id, 'same-direct-tab');
assert.equal(duplicateDirectMerge.importedSessions, 0);
assert.equal(duplicateDirectMerge.importedTabs, 0);

const directIdConflict = mergeImportedSessions(
  [
    directSession('existing-direct', 1, [tab('direct-conflict')]),
    directSession('existing-command', 1, [tab('group-command-conflict')]),
  ],
  [
    directSession('imported-direct', 2, [tab('direct-conflict')]),
    session('imported-group', 3, [
      group('tab:group-command-conflict', 'Group with direct command ID', 3, {
        tabs: [tab('shared-group-tab')],
      }),
    ]),
  ],
);
assert.equal(
  directIdConflict.sessions.some((candidate) => candidate.id === 'imported-direct'),
  false,
);
const importedGroup = directIdConflict.sessions
  .find((candidate) => candidate.id === 'imported-group')
  .items.find((item) => item.type === 'group').group;
assert.notEqual(importedGroup.id, 'tab:group-command-conflict');
assert.equal(new Set([
  'direct-conflict',
  'tab:group-command-conflict',
  importedGroup.id,
]).size, 3);
assert.equal(directIdConflict.importedSessions, 1);
assert.equal(directIdConflict.importedGroups, 1);
assert.equal(directIdConflict.importedTabs, 1);

const directProxyConflict = mergeImportedSessions(
  [session('existing-group-session', 1, [
    group('tab:direct-proxy-conflict', 'Existing real group', 1),
  ])],
  [directSession('imported-proxy-direct', 2, [tab('direct-proxy-conflict')])],
);
const importedProxyDirect = directProxyConflict.sessions
  .find((candidate) => candidate.id === 'imported-proxy-direct')
  .items[0].tab;
assert.equal(importedProxyDirect.id, 'direct-proxy-conflict:bok-imported-tab');
assert.equal(
  `tab:${importedProxyDirect.id}`,
  'tab:direct-proxy-conflict:bok-imported-tab',
);
importedProxyDirect.title = 'Locally edited title';
importedProxyDirect.tags = ['local'];
importedProxyDirect.taskStatus = 'doing';
const repeatedProxyDirect = mergeImportedSessions(
  directProxyConflict.sessions,
  [directSession('imported-proxy-direct', 2, [tab('direct-proxy-conflict')])],
);
assert.equal(repeatedProxyDirect.sessions.length, directProxyConflict.sessions.length);
assert.equal(repeatedProxyDirect.importedSessions, 0);
assert.equal(repeatedProxyDirect.importedTabs, 0);
assert.equal(
  repeatedProxyDirect.sessions
    .find((candidate) => candidate.id === 'imported-proxy-direct')
    .items[0].tab.id,
  importedProxyDirect.id,
);
assert.equal(importedProxyDirect.title, 'Locally edited title');
assert.deepEqual(importedProxyDirect.tags, ['local']);
assert.equal(importedProxyDirect.taskStatus, 'doing');

const sameContentTemplate = tab('same-content-template');
const sameContentTabA = { ...sameContentTemplate, id: 'same-content-a' };
const sameContentTabB = { ...sameContentTemplate, id: 'same-content-b' };
const sameContentConflictSource = directSession('same-content-target', 2, [
  sameContentTabB,
]);
const sameContentConflict = mergeImportedSessions(
  [
    directSession('same-content-target', 1, [sameContentTabA]),
    session('same-content-conflict-holder', 1, [
      group('tab:same-content-b', 'Unrelated ID conflict', 1),
      group(
        'same-content-b:bok-imported-tab',
        'Unrelated candidate conflict',
        1,
      ),
    ]),
  ],
  [sameContentConflictSource],
);
const sameContentTarget = sameContentConflict.sessions.find(
  (candidate) => candidate.id === 'same-content-target',
);
assert.deepEqual(
  sameContentTarget.items.map((item) => item.type === 'tab' ? item.tab.id : item.group.id),
  ['same-content-a', 'same-content-b:bok-imported-tab-1'],
);
assert.equal(sameContentConflict.importedSessions, 1);
assert.equal(sameContentConflict.importedTabs, 1);
const repeatedSameContentConflict = mergeImportedSessions(
  sameContentConflict.sessions,
  [sameContentConflictSource],
);
assert.deepEqual(
  repeatedSameContentConflict.sessions
    .find((candidate) => candidate.id === 'same-content-target')
    .items.map((item) => item.type === 'tab' ? item.tab.id : item.group.id),
  ['same-content-a', 'same-content-b:bok-imported-tab-1'],
);
assert.equal(repeatedSameContentConflict.importedSessions, 0);
assert.equal(repeatedSameContentConflict.importedTabs, 0);

const batchDirectSourceId = 'batch-direct-source';
const batchDirectCandidateId = `${batchDirectSourceId}:bok-imported-tab`;
const batchDirectSources = [
  directSession('batch-direct-session', 2, [
    tab(batchDirectSourceId),
    tab(batchDirectCandidateId),
  ]),
];
const batchDirectMerge = mergeImportedSessions(
  [session('batch-direct-conflict', 1, [
    group(`tab:${batchDirectSourceId}`, 'Source proxy conflict', 1),
  ])],
  batchDirectSources,
);
const batchDirectTarget = batchDirectMerge.sessions.find(
  (item) => item.id === 'batch-direct-session',
);
assert.deepEqual(
  batchDirectTarget.items.map((item) => item.type === 'tab' ? item.tab.id : item.group.id),
  [`${batchDirectCandidateId}-1`, batchDirectCandidateId],
);
batchDirectTarget.items[0].tab.title = 'Local batch direct tab';
const repeatedBatchDirect = mergeImportedSessions(
  batchDirectMerge.sessions,
  batchDirectSources,
);
assert.equal(repeatedBatchDirect.importedSessions, 0);
assert.equal(repeatedBatchDirect.importedTabs, 0);
assert.equal(
  repeatedBatchDirect.sessions
    .find((item) => item.id === 'batch-direct-session')
    .items[0].tab.title,
  'Local batch direct tab',
);

const proxyReservedSourceId = 'tab:proxy-reserved-source';
const proxyReservedCandidateId =
  `${proxyReservedSourceId}:bok-imported-tab`;
const proxyRawTabId = 'proxy-reserved-source:bok-imported-tab';
const proxyReservedSources = [
  directSession('proxy-reserved-session', 2, [
    tab(proxyReservedSourceId),
    tab(proxyRawTabId),
  ]),
];
const proxyReservedMerge = mergeImportedSessions(
  [session('proxy-reserved-conflict', 1, [
    group(`tab:${proxyReservedSourceId}`, 'Source proxy conflict', 1),
  ])],
  proxyReservedSources,
);
const proxyReservedTarget = proxyReservedMerge.sessions.find(
  (item) => item.id === 'proxy-reserved-session',
);
assert.deepEqual(
  proxyReservedTarget.items.map((item) => item.type === 'tab' ? item.tab.id : item.group.id),
  [`${proxyReservedCandidateId}-1`, proxyRawTabId],
);
assert.equal(`tab:${proxyRawTabId}`, proxyReservedCandidateId);
proxyReservedTarget.items[0].tab.title = 'Local proxy-reserved tab';
const repeatedProxyReserved = mergeImportedSessions(
  proxyReservedMerge.sessions,
  proxyReservedSources,
);
assert.equal(repeatedProxyReserved.importedSessions, 0);
assert.equal(repeatedProxyReserved.importedTabs, 0);
assert.equal(
  repeatedProxyReserved.sessions
    .find((item) => item.id === 'proxy-reserved-session')
    .items[0].tab.title,
  'Local proxy-reserved tab',
);

const deterministicGroupSource = session('deterministic-group-session', 2, [
  group('deterministic-group', 'Deterministic group', 2),
]);
const deterministicGroupMerge = mergeImportedSessions(
  [
    directSession('group-id-conflict', 1, [tab('deterministic-group')]),
    directSession('group-candidate-conflict', 1, [
      tab('deterministic-group:bok-imported-group'),
    ]),
  ],
  [deterministicGroupSource],
);
const deterministicImportedGroup = deterministicGroupMerge.sessions
  .find((candidate) => candidate.id === 'deterministic-group-session')
  .items.find((item) => item.type === 'group').group;
assert.equal(
  deterministicImportedGroup.id,
  'deterministic-group:bok-imported-group-1',
);
deterministicImportedGroup.title = 'Locally edited group';
deterministicImportedGroup.taskStatus = 'doing';
const repeatedDeterministicGroup = mergeImportedSessions(
  deterministicGroupMerge.sessions,
  [deterministicGroupSource],
);
assert.equal(repeatedDeterministicGroup.importedSessions, 0);
assert.equal(repeatedDeterministicGroup.importedGroups, 0);
assert.equal(repeatedDeterministicGroup.skippedDuplicateGroups, 1);
const preservedDeterministicGroup = repeatedDeterministicGroup.sessions
  .find((candidate) => candidate.id === 'deterministic-group-session')
  .items.find((item) => item.type === 'group').group;
assert.equal(preservedDeterministicGroup.id, deterministicImportedGroup.id);
assert.equal(preservedDeterministicGroup.title, 'Locally edited group');
assert.equal(preservedDeterministicGroup.taskStatus, 'doing');

const batchGroupSourceId = 'batch-group-source';
const batchGroupCandidateId = `${batchGroupSourceId}:bok-imported-group`;
const batchGroupSources = [
  session('batch-group-session', 2, [
    group(batchGroupSourceId, 'Batch group source', 2),
    group(batchGroupCandidateId, 'Batch raw candidate', 3),
  ]),
];
const batchGroupMerge = mergeImportedSessions(
  [directSession('batch-group-conflict', 1, [tab(batchGroupSourceId)])],
  batchGroupSources,
);
const batchRemappedGroupId = `${batchGroupCandidateId}-1`;
const batchGroups = batchGroupMerge.sessions.flatMap((item) =>
  item.items.flatMap((entry) => entry.type === 'group' ? [entry.group] : []),
);
assert.ok(batchGroups.some((item) => item.id === batchRemappedGroupId));
assert.ok(batchGroups.some((item) => item.id === batchGroupCandidateId));
assert.equal(batchGroupMerge.importedGroups, 2);
batchGroups.find((item) => item.id === batchRemappedGroupId).title =
  'Local batch group';
const repeatedBatchGroups = mergeImportedSessions(
  batchGroupMerge.sessions,
  batchGroupSources,
);
assert.equal(repeatedBatchGroups.importedGroups, 0);
assert.equal(repeatedBatchGroups.skippedDuplicateGroups, 2);
assert.equal(
  repeatedBatchGroups.sessions
    .flatMap((item) => item.items)
    .find(
      (entry) => entry.type === 'group' && entry.group.id === batchRemappedGroupId,
    ).group.title,
  'Local batch group',
);

const mixedGroupSourceId = 'mixed-group-source';
const mixedGroupCandidateId = `${mixedGroupSourceId}:bok-imported-group`;
const mixedGroupSources = [
  session('mixed-group-session', 2, [
    group(mixedGroupSourceId, 'Mixed group source', 2),
  ]),
  directSession(mixedGroupCandidateId, 3, []),
];
const mixedGroupMerge = mergeImportedSessions(
  [directSession('mixed-group-conflict', 1, [tab(mixedGroupSourceId)])],
  mixedGroupSources,
);
const mixedRemappedGroupId = `${mixedGroupCandidateId}-1`;
assert.ok(
  mixedGroupMerge.sessions.some((item) => item.id === mixedGroupCandidateId),
);
assert.ok(
  mixedGroupMerge.sessions.some((item) =>
    item.items.some(
      (entry) =>
        entry.type === 'group' &&
        entry.group.id === mixedRemappedGroupId,
    ),
  ),
);
mixedGroupMerge.sessions
  .flatMap((item) => item.items)
  .find(
    (entry) => entry.type === 'group' && entry.group.id === mixedRemappedGroupId,
  ).group.title = 'Local mixed group';
const repeatedMixedGroups = mergeImportedSessions(
  mixedGroupMerge.sessions,
  mixedGroupSources,
);
assert.equal(repeatedMixedGroups.importedSessions, 0);
assert.equal(repeatedMixedGroups.importedGroups, 0);
assert.equal(
  repeatedMixedGroups.sessions
    .flatMap((item) => item.items)
    .find(
      (entry) => entry.type === 'group' && entry.group.id === mixedRemappedGroupId,
    ).group.title,
  'Local mixed group',
);

const sessionIdConflictSource = directSession('session-id-conflict', 2, [
  tab('new-direct-tab'),
]);
const sessionIdConflict = mergeImportedSessions(
  [session('existing-session', 1, [group('session-id-conflict', 'Existing', 1)])],
  [sessionIdConflictSource],
);
const importedSession = sessionIdConflict.sessions.find((candidate) =>
  candidate.items.some(
    (item) => item.type === 'tab' && item.tab.id === 'new-direct-tab',
  ),
);
assert.equal(
  importedSession.id,
  'session-id-conflict:bok-imported-session',
);
assert.equal(
  new Set(sessionIdConflict.sessions.map((candidate) => candidate.id)).size,
  2,
);
importedSession.title = 'Locally edited session';
importedSession.pinned = true;
const repeatedSessionIdConflict = mergeImportedSessions(
  sessionIdConflict.sessions,
  [sessionIdConflictSource],
);
assert.equal(repeatedSessionIdConflict.sessions.length, 2);
assert.equal(repeatedSessionIdConflict.importedSessions, 0);
const preservedImportedSession = repeatedSessionIdConflict.sessions.find(
  (candidate) => candidate.id === importedSession.id,
);
assert.equal(preservedImportedSession.title, 'Locally edited session');
assert.equal(preservedImportedSession.pinned, true);

const batchSessionSourceId = 'batch-session-source';
const batchSessionCandidateId =
  `${batchSessionSourceId}:bok-imported-session`;
const batchSessionSources = [
  directSession(batchSessionSourceId, 2, []),
  directSession(batchSessionCandidateId, 3, []),
];
const batchSessionMerge = mergeImportedSessions(
  [session('batch-session-conflict-holder', 1, [
    group(batchSessionSourceId, 'Source conflict', 1),
  ])],
  batchSessionSources,
);
const batchRemappedSessionId = `${batchSessionCandidateId}-1`;
assert.ok(batchSessionMerge.sessions.some((item) => item.id === batchRemappedSessionId));
assert.ok(batchSessionMerge.sessions.some((item) => item.id === batchSessionCandidateId));
assert.equal(batchSessionMerge.importedSessions, 2);
batchSessionMerge.sessions.find((item) => item.id === batchRemappedSessionId).title =
  'Local batch session';
const repeatedBatchSessions = mergeImportedSessions(
  batchSessionMerge.sessions,
  batchSessionSources,
);
assert.equal(repeatedBatchSessions.importedSessions, 0);
assert.equal(
  repeatedBatchSessions.sessions.find((item) => item.id === batchRemappedSessionId).title,
  'Local batch session',
);
assert.equal(
  repeatedBatchSessions.sessions.filter((item) =>
    item.id === batchRemappedSessionId || item.id === batchSessionCandidateId,
  ).length,
  2,
);

const mixedSessionSourceId = 'mixed-session-source';
const mixedSessionCandidateId =
  `${mixedSessionSourceId}:bok-imported-session`;
const mixedSessionSources = [
  directSession(mixedSessionSourceId, 2, []),
  session('mixed-session-batch-holder', 3, [
    group(mixedSessionCandidateId, 'Raw group candidate', 3),
  ]),
];
const mixedSessionMerge = mergeImportedSessions(
  [session('mixed-session-conflict-holder', 1, [
    group(mixedSessionSourceId, 'Source conflict', 1),
  ])],
  mixedSessionSources,
);
const mixedRemappedSessionId = `${mixedSessionCandidateId}-1`;
assert.ok(mixedSessionMerge.sessions.some((item) => item.id === mixedRemappedSessionId));
assert.ok(
  mixedSessionMerge.sessions.some((item) =>
    item.items.some(
      (entry) => entry.type === 'group' && entry.group.id === mixedSessionCandidateId,
    ),
  ),
);
mixedSessionMerge.sessions.find((item) => item.id === mixedRemappedSessionId).title =
  'Local mixed session';
const repeatedMixedSessions = mergeImportedSessions(
  mixedSessionMerge.sessions,
  mixedSessionSources,
);
assert.equal(repeatedMixedSessions.importedSessions, 0);
assert.equal(repeatedMixedSessions.importedGroups, 0);
assert.equal(
  repeatedMixedSessions.sessions.find((item) => item.id === mixedRemappedSessionId).title,
  'Local mixed session',
);

const partialMerge = mergeImportedSessions(existing, [
  session('existing', 30, [
    group('existing-group', 'WBS changed', 30),
    group('new-group', 'New', 31),
  ]),
]);
assert.equal(partialMerge.sessions.length, 1);
assert.equal(
  partialMerge.sessions[0].items.filter((item) => item.type === 'group').length,
  2,
);
assert.equal(partialMerge.importedGroups, 1);
assert.equal(partialMerge.skippedDuplicateGroups, 1);

const archived = archiveEligibleGroupsInMemory(
  merged.sessions,
  AUTO_ARCHIVE_AGE_MS + 21,
  7,
);
assert.deepEqual(archived, { archivedSessions: 0, archivedGroups: 3 });
assert.ok(
  merged.sessions.every((session) =>
    session.items
      .filter((item) => item.type === 'group')
      .every((item) => item.group.archivedAt),
  ),
);

const now = AUTO_ARCHIVE_AGE_MS + 1_000;
assert.equal(group('newly-saved', 'Newly saved', now).restoredAt, null);
const directOnlyArchiveSession = directSession('direct-only-archive', 0, [
  tab('direct-only-archive-tab'),
]);
const realGroupArchive = group('real-group-archive', 'Real group', 0);
assert.deepEqual(
  archiveEligibleGroupsInMemory(
    [directOnlyArchiveSession, session('real-group-archive-session', now, [realGroupArchive])],
    now,
    7,
  ),
  { archivedSessions: 1, archivedGroups: 1 },
);
assert.equal(directOnlyArchiveSession.archivedAt, now);
assert.equal(realGroupArchive.archivedAt, now);

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

assert.deepEqual(
  archiveEligibleGroupsInMemory([archiveCandidates], now, 7),
  { archivedSessions: 0, archivedGroups: 3 },
);
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

assert.deepEqual(
  archiveEligibleGroupsInMemory(
    [session('manual-restore-exemption', now, [manuallyRestoredGroup, equivalentOldGroup])],
    now,
    7,
  ),
  { archivedSessions: 0, archivedGroups: 1 },
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
assert.deepEqual(
  archiveEligibleGroupsInMemory([restoreAgeCandidates], now, 7),
  { archivedSessions: 0, archivedGroups: 1 },
);
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
  assert.deepEqual(
    archiveEligibleGroupsInMemory([periodCandidates], periodNow, period),
    { archivedSessions: 0, archivedGroups: 1 },
  );
  assert.deepEqual(
    periodCandidates.groups
      .filter((item) => item.archivedAt === periodNow)
      .map((item) => item.id),
    [`period-${period}-over`],
  );
}

const neverGroup = group('never-group', 'Never', 0);
assert.deepEqual(
  archiveEligibleGroupsInMemory(
    [session('never-session', now, [neverGroup])],
    now,
    'never',
  ),
  { archivedSessions: 0, archivedGroups: 0 },
);
assert.equal(neverGroup.archivedAt, null);

const prefixedRealGroup = group('tab:real-group', 'Prefixed real group', 0);
assert.deepEqual(
  archiveEligibleGroupsInMemory(
    [session('prefixed-real-session', now, [prefixedRealGroup])],
    now,
    7,
  ),
  { archivedSessions: 0, archivedGroups: 1 },
);
assert.equal(prefixedRealGroup.archivedAt, now);

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
  removeTab,
  setAutoArchivePeriod,
  setGroupArchived,
  setTabTaskStatus,
} = await import('../libs/saved-pages/store.ts');
const {
  exportSessionsJson,
  getSessions,
  importSessionsJson,
  readSessions,
  SESSIONS_PRE_V3_SNAPSHOT_KEY,
  writeSessions,
} = await import(
  '../libs/saved-pages/persistence.ts'
);
const { isSavedPageCommand } = await import('../libs/saved-pages/messages.ts');
const { buildSavedSessionItems } = await import('../libs/saved-pages/save-tabs.ts');

const capturedItems = buildSavedSessionItems(
  [
    { id: 4, index: 3, url: 'https://four.example', title: 'four', groupId: -1 },
    { id: 2, index: 1, url: 'https://two.example', title: 'two', groupId: 7 },
    { id: 5, index: 4, url: 'https://five.example', title: 'five', groupId: 7 },
    { id: 1, index: 0, url: 'https://one.example', title: 'one', groupId: -1 },
    { id: 3, index: 2, url: 'https://three.example', title: 'three', groupId: 7 },
  ],
  [{ id: 7, title: 'Browser group', color: 'blue' }],
  100,
  new Set(),
);
assert.deepEqual(
  capturedItems.map((item) =>
    item.type === 'tab'
      ? `tab:${item.tab.url}`
      : `group:${item.group.tabs.map((tab) => tab.url).join(',')}`,
  ),
  [
    'tab:https://one.example',
    'group:https://two.example,https://three.example',
    'tab:https://four.example',
    'group:https://five.example',
  ],
);

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
await writeSessions([]);
assert.equal(
  SESSIONS_PRE_V3_SNAPSHOT_KEY in (await fakeBrowser.storage.local.get(null)),
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
let storedGroup = firstStoredGroup(stored);
assert.equal(storedGroup.archivedAt, null);
assert.equal(storedGroup.createdAt, storageCreatedAt);
assert.equal(storedGroup.pinned, false);
assert.ok(storedGroup.restoredAt >= restoreStartedAt);
const restoredAt = storedGroup.restoredAt;

assert.deepEqual(
  await archiveEligibleGroups(restoredAt),
  { archivedSessions: 0, archivedGroups: 0 },
);
stored = await fakeBrowser.storage.local.get('sessions');
storedGroup = firstStoredGroup(stored);
assert.equal(storedGroup.archivedAt, null);
assert.equal(storedGroup.createdAt, storageCreatedAt);
assert.equal(storedGroup.pinned, false);
assert.equal(storedGroup.restoredAt, restoredAt);

const exported = await exportSessionsJson();
fakeBrowser.reset();
const importResult = await importSessionsJson(exported);
assert.equal(importResult.archivedSessions, 0);
assert.equal(importResult.archivedGroups, 0);
stored = await fakeBrowser.storage.local.get('sessions');
storedGroup = firstStoredGroup(stored);
assert.equal(storedGroup.archivedAt, null);
assert.equal(storedGroup.createdAt, storageCreatedAt);
assert.equal(storedGroup.pinned, false);
assert.equal(storedGroup.restoredAt, restoredAt);

await setGroupArchived(storageSessionId, storageGroupId, true);
stored = await fakeBrowser.storage.local.get('sessions');
storedGroup = firstStoredGroup(stored);
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
const directPeriodImportJson = JSON.stringify({
  schemaVersion: 2,
  revision: 0,
  sessions: [
    directSession(
      'direct-period-import-session',
      importNow - 2 * AUTO_ARCHIVE_DAY_MS,
      [tab('direct-period-import-tab')],
    ),
  ],
});

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
await fakeBrowser.storage.local.set({ sessions: 'invalid-but-unread' });
assert.deepEqual(
  await archiveEligibleGroups(),
  { archivedSessions: 0, archivedGroups: 0 },
);
assert.equal(
  (await fakeBrowser.storage.local.get('sessions')).sessions,
  'invalid-but-unread',
);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
let periodImportResult = await importSessionsJson(periodImportJson);
assert.equal(periodImportResult.archivedSessions, 0);
assert.equal(periodImportResult.archivedGroups, 0);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(firstStoredGroup(stored).archivedAt, null);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod(1);
const directPeriodImportResult = await importSessionsJson(directPeriodImportJson);
assert.equal(directPeriodImportResult.archivedSessions, 1);
assert.equal(directPeriodImportResult.archivedGroups, 0);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(typeof stored.sessions.sessions[0].archivedAt, 'number');

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod(1);
periodImportResult = await importSessionsJson(periodImportJson);
assert.equal(periodImportResult.archivedSessions, 0);
assert.equal(periodImportResult.archivedGroups, 1);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(typeof firstStoredGroup(stored).archivedAt, 'number');

const emptyOrdinaryState = {
  grouped: false,
  locked: true,
  pinned: true,
  restoredAt: 7,
  archivedAt: 8,
  taskStatus: 'done',
  taskCompletedAt: 9,
  tabs: [],
};

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
await writeSessions([
  session('v1-empty-conflict-holder', 1, [
    group('v1-empty-session', 'Source ID conflict', 1),
    group(
      'v1-empty-session:bok-imported-session',
      'Candidate ID conflict',
      1,
    ),
  ]),
]);
const v1EmptyImportResult = await importSessionsJson(JSON.stringify({
  schemaVersion: 1,
  revision: 0,
  sessions: [
    session('v1-empty-session', 1, [
      {
        ...group('v1-empty-ordinary', 'V1 empty ordinary', 2),
        ...emptyOrdinaryState,
      },
    ]),
  ],
}));
assert.equal(v1EmptyImportResult.importedSessions, 1);
assert.equal(v1EmptyImportResult.importedGroups, 0);
assert.equal(v1EmptyImportResult.importedTabs, 0);
let emptyImportedSession = (await getSessions()).find(
  (candidate) => candidate.id === 'v1-empty-session:bok-imported-session-1',
);
assert.deepEqual(emptyImportedSession.items, []);
assert.deepEqual(
  {
    title: emptyImportedSession.title,
    locked: emptyImportedSession.locked,
    pinned: emptyImportedSession.pinned,
    restoredAt: emptyImportedSession.restoredAt,
    archivedAt: emptyImportedSession.archivedAt,
    taskStatus: emptyImportedSession.taskStatus,
    taskCompletedAt: emptyImportedSession.taskCompletedAt,
  },
  {
    title: 'V1 empty ordinary',
    locked: true,
    pinned: true,
    restoredAt: 7,
    archivedAt: 8,
    taskStatus: 'done',
    taskCompletedAt: 9,
  },
);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
await writeSessions([
  session('v2-empty-conflict-holder', 1, [
    group('v2-empty-conflict-group', 'Nested tab ID conflict', 1, {
      tabs: [tab('v2-empty-session')],
    }),
  ]),
]);
const v2EmptyImportResult = await importSessionsJson(JSON.stringify({
  schemaVersion: 2,
  revision: 0,
  sessions: [{
    id: 'v2-empty-session',
    createdAt: 1,
    items: [{
      type: 'group',
      group: {
        ...group('v2-empty-ordinary', 'V2 empty ordinary', 2),
        ...emptyOrdinaryState,
      },
    }],
  }],
}));
assert.equal(v2EmptyImportResult.importedSessions, 1);
assert.equal(v2EmptyImportResult.importedGroups, 0);
assert.equal(v2EmptyImportResult.importedTabs, 0);
emptyImportedSession = (await getSessions()).find(
  (candidate) => candidate.id === 'v2-empty-session:bok-imported-session',
);
assert.deepEqual(emptyImportedSession.items, []);
assert.equal(emptyImportedSession.title, 'V2 empty ordinary');
assert.equal(emptyImportedSession.locked, true);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
await writeSessions([
  directSession('v3-empty-conflict-holder', 1, [tab('v3-existing-direct')]),
]);
const v3EmptySession = {
  ...directSession('tab:v3-existing-direct', 3, []),
  title: 'V3 empty',
  locked: true,
  pinned: true,
  restoredAt: 10,
  archivedAt: 11,
  taskStatus: 'done',
  taskCompletedAt: 12,
};
const v3EmptyJson = JSON.stringify({
  schemaVersion: 3,
  revision: 0,
  sessions: [v3EmptySession],
});
const v3EmptyImportResult = await importSessionsJson(v3EmptyJson);
assert.equal(v3EmptyImportResult.importedSessions, 1);
assert.equal(v3EmptyImportResult.importedGroups, 0);
assert.equal(v3EmptyImportResult.importedTabs, 0);
const v3EmptyRemappedId =
  'tab:v3-existing-direct:bok-imported-session';
let v3StoredSessions = await getSessions();
emptyImportedSession = v3StoredSessions.find(
  (candidate) => candidate.id === v3EmptyRemappedId,
);
assert.deepEqual(emptyImportedSession, {
  ...v3EmptySession,
  id: v3EmptyRemappedId,
});
emptyImportedSession.title = 'Locally edited empty session';
emptyImportedSession.locked = false;
emptyImportedSession.taskStatus = 'doing';
emptyImportedSession.taskCompletedAt = null;
await writeSessions(v3StoredSessions);
const repeatedV3EmptyImport = await importSessionsJson(v3EmptyJson);
assert.equal(repeatedV3EmptyImport.importedSessions, 0);
v3StoredSessions = await getSessions();
assert.equal(v3StoredSessions.length, 2);
emptyImportedSession = v3StoredSessions.find(
  (candidate) => candidate.id === v3EmptyRemappedId,
);
assert.equal(emptyImportedSession.title, 'Locally edited empty session');
assert.equal(emptyImportedSession.locked, false);
assert.equal(emptyImportedSession.taskStatus, 'doing');

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
assert.equal(typeof firstStoredGroup(stored).archivedAt, 'number');

fakeBrowser.reset();
const v0RawSessions = [
  {
    id: 'minimal-v0-session',
    createdAt: 50,
    groups: [
      {
        id: 'minimal-v0-group',
        tabs: [{ id: 'minimal-v0-tab', url: 'https://minimal-v0.example' }],
      },
    ],
  },
];
await fakeBrowser.storage.local.set({ sessions: v0RawSessions });
const minimalV0 = await getSessions();
assert.equal(minimalV0.length, 1);
assert.equal(minimalV0[0].id, 'minimal-v0-session');
assert.equal(minimalV0[0].title, '');
assert.equal(minimalV0[0].locked, false);
assert.equal(minimalV0[0].items[0].type, 'tab');
assert.deepEqual(minimalV0[0].items[0].tab, {
  id: 'minimal-v0-tab',
  url: 'https://minimal-v0.example',
  title: 'https://minimal-v0.example',
  favIconUrl: undefined,
  createdAt: 50,
  updatedAt: 50,
  archivedAt: null,
  tags: [],
  directory: null,
  taskStatus: null,
  taskCompletedAt: null,
});

fakeBrowser.reset();
const v1Envelope = {
  schemaVersion: 1,
  revision: 4,
  sessions: [session('legacy-v1', 1, [group('legacy-group', 'Legacy', 1)])],
};
await fakeBrowser.storage.local.set({ sessions: v1Envelope });
const legacySessions = await getSessions();
assert.ok(Array.isArray(legacySessions[0].items));
await writeSessions(legacySessions);
stored = await fakeBrowser.storage.local.get(['sessions', SESSIONS_PRE_V3_SNAPSHOT_KEY]);
assert.deepEqual(stored[SESSIONS_PRE_V3_SNAPSHOT_KEY], v1Envelope);
assert.equal(stored.sessions.schemaVersion, 3);
assert.ok(Array.isArray(stored.sessions.sessions[0].items));
assert.equal('groups' in stored.sessions.sessions[0], false);
await fakeBrowser.storage.local.set({ [SESSIONS_PRE_V3_SNAPSHOT_KEY]: { preserved: true } });
await writeSessions(await getSessions());
assert.deepEqual(
  (await fakeBrowser.storage.local.get(SESSIONS_PRE_V3_SNAPSHOT_KEY))[SESSIONS_PRE_V3_SNAPSHOT_KEY],
  { preserved: true },
);

fakeBrowser.reset();
await fakeBrowser.storage.local.set({
  sessions: {
    schemaVersion: 2,
    revision: 1,
    sessions: [
      {
        id: 'ordered-v2',
        createdAt: 10,
        items: [
          { type: 'tab', tab: tab('first-direct') },
          { type: 'group', group: group('middle-group', 'Middle', 2) },
          { type: 'tab', tab: tab('last-direct') },
        ],
      },
    ],
  },
});
const orderedSessions = await getSessions();
assert.deepEqual(
  orderedSessions[0].items.map((item) =>
    item.type === 'tab' ? `tab:${item.tab.id}` : item.group.id,
  ),
  ['tab:first-direct', 'middle-group', 'tab:last-direct'],
);
assert.deepEqual(
  await archiveEligibleGroups(AUTO_ARCHIVE_AGE_MS + 100),
  { archivedSessions: 0, archivedGroups: 1 },
);
await writeSessions(await getSessions());
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(stored.sessions.schemaVersion, 3);
assert.equal('groups' in stored.sessions.sessions[0], false);
assert.deepEqual(
  stored.sessions.sessions[0].items.map((item) => item.type),
  ['tab', 'group', 'tab'],
);
assert.equal(stored.sessions.sessions[0].items[0].tab.id, 'first-direct');
assert.equal(stored.sessions.sessions[0].items[2].tab.id, 'last-direct');
const orderedV3Json = JSON.stringify(stored.sessions);

fakeBrowser.reset();
await fakeBrowser.storage.local.set({
  sessions: {
    schemaVersion: 2,
    revision: 1,
    sessions: [
      {
        id: 'direct-operations',
        createdAt: 10,
        items: [
          { type: 'tab', tab: tab('direct-task') },
          { type: 'group', group: group('direct-operations-group', 'Group', 2) },
          { type: 'tab', tab: tab('direct-remove') },
        ],
      },
    ],
  },
});
await setTabTaskStatus(
  'direct-operations',
  'tab:direct-task',
  'direct-task',
  'doing',
);
stored = await fakeBrowser.storage.local.get('sessions');
assert.deepEqual(
  stored.sessions.sessions[0].items.map((item) => item.type),
  ['tab', 'group', 'tab'],
);
assert.equal(stored.sessions.sessions[0].items[0].tab.taskStatus, 'doing');
await removeTab('direct-operations', 'direct-remove');
stored = await fakeBrowser.storage.local.get('sessions');
assert.deepEqual(
  stored.sessions.sessions[0].items.map((item) => item.type),
  ['tab', 'group'],
);
assert.equal(stored.sessions.sessions[0].items[0].tab.id, 'direct-task');

fakeBrowser.reset();
const proxyIdCollisionEnvelope = {
  schemaVersion: 2,
  revision: 1,
  sessions: [
    {
      id: 'proxy-id-collision',
      createdAt: 10,
      items: [
        { type: 'tab', tab: tab('same-id') },
        { type: 'group', group: group('tab:same-id', 'Collision', 2) },
      ],
    },
  ],
};
await fakeBrowser.storage.local.set({ sessions: proxyIdCollisionEnvelope });
const collisionRead = await readSessions();
assert.equal(collisionRead.sessions.length, 0);
assert.equal(collisionRead.recoveryEntryCount, 1);
assert.deepEqual(
  (await fakeBrowser.storage.local.get('sessions')).sessions,
  proxyIdCollisionEnvelope,
);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
const directOnlyImportJson = JSON.stringify({
    schemaVersion: 2,
    revision: 0,
    sessions: [
      {
        id: 'direct-only-v2',
        createdAt: 10,
        items: [{ type: 'tab', tab: tab('direct-import') }],
      },
    ],
  });
const directImportResult = await importSessionsJson(directOnlyImportJson);
assert.equal(directImportResult.importedSessions, 1);
assert.equal(directImportResult.importedGroups, 0);
assert.equal(directImportResult.importedTabs, 1);
const directStoredId = (await getSessions())[0].items[0].tab.id;
const repeatedDirectImport = await importSessionsJson(directOnlyImportJson);
assert.equal(repeatedDirectImport.importedSessions, 0);
assert.equal(repeatedDirectImport.importedGroups, 0);
assert.equal(repeatedDirectImport.importedTabs, 0);
assert.equal((await getSessions())[0].items.length, 1);
assert.equal((await getSessions())[0].items[0].tab.id, directStoredId);
await importSessionsJson(orderedV3Json);
stored = await fakeBrowser.storage.local.get('sessions');
assert.deepEqual(
  stored.sessions.sessions.find((item) => item.id === 'ordered-v2').items.map((item) => item.type),
  ['tab', 'group', 'tab'],
);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
await fakeBrowser.storage.local.set({
  sessions: {
    schemaVersion: 1,
    revision: 0,
    sessions: [session('same-session', 1, [group('legacy-same', 'Legacy', 1)])],
  },
});
await importSessionsJson(
  JSON.stringify({
    schemaVersion: 2,
    revision: 0,
    sessions: [
      {
        id: 'same-session',
        createdAt: 2,
        items: [{ type: 'tab', tab: tab('direct-after-conflict') }],
      },
    ],
  }),
);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(stored.sessions.sessions.length, 1);
assert.deepEqual(stored.sessions.sessions[0].items.map((item) => item.type), [
  'group',
  'tab',
]);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod('never');
await fakeBrowser.storage.local.set({
  sessions: {
    schemaVersion: 2,
    revision: 0,
    sessions: [
      {
        id: 'same-session-reverse',
        createdAt: 2,
        items: [{ type: 'tab', tab: tab('direct-before-conflict') }],
      },
    ],
  },
});
await importSessionsJson(
  JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    sessions: [
      session('same-session-reverse', 1, [group('legacy-after-conflict', 'Legacy', 1)]),
    ],
  }),
);
stored = await fakeBrowser.storage.local.get('sessions');
assert.equal(stored.sessions.sessions.length, 1);
assert.deepEqual(stored.sessions.sessions[0].items.map((item) => item.type), [
  'tab',
  'group',
]);

fakeBrowser.reset();
const ordinaryFirst = {
  ...group('ordinary-first', 'Ordinary first', 11, {
    pinned: true,
    taskStatus: 'doing',
  }),
  grouped: false,
  locked: true,
  archivedAt: 9,
  restoredAt: 10,
};
const ordinaryLast = {
  ...group('ordinary-last', 'Ordinary last', 12),
  grouped: false,
};
const mixedLegacyEnvelope = {
  schemaVersion: 1,
  revision: 3,
  sessions: [
    session('mixed-legacy-session', 20, [
      ordinaryFirst,
      group('real-legacy-group', 'Real', 20),
      ordinaryLast,
    ]),
  ],
};
await fakeBrowser.storage.local.set({ sessions: mixedLegacyEnvelope });
const migratedLegacy = await getSessions();
assert.equal(migratedLegacy.length, 3);
assert.equal(migratedLegacy[0].id, 'mixed-legacy-session');
assert.deepEqual(migratedLegacy[0].items.map((item) => item.type), ['group']);
assert.equal(migratedLegacy[1].id, 'ordinary-first');
assert.equal(migratedLegacy[1].title, 'Ordinary first');
assert.equal(migratedLegacy[1].locked, true);
assert.equal(migratedLegacy[1].pinned, true);
assert.equal(migratedLegacy[1].archivedAt, 9);
assert.equal(migratedLegacy[1].restoredAt, 10);
assert.equal(migratedLegacy[1].taskStatus, 'doing');
assert.deepEqual(migratedLegacy[1].items.map((item) => item.type), ['tab']);
assert.equal(migratedLegacy[2].id, 'ordinary-last');
await writeSessions(migratedLegacy);
stored = await fakeBrowser.storage.local.get(['sessions', SESSIONS_PRE_V3_SNAPSHOT_KEY]);
assert.deepEqual(stored[SESSIONS_PRE_V3_SNAPSHOT_KEY], mixedLegacyEnvelope);
assert.equal(stored.sessions.schemaVersion, 3);
assert.ok(
  stored.sessions.sessions.every(
    (savedSession) =>
      !('legacyGroups' in savedSession) &&
      savedSession.items.every(
        (item) => item.type !== 'group' || item.group.grouped === true,
      ),
  ),
);

fakeBrowser.reset();
const ordinaryProxyCollisionEnvelope = {
  schemaVersion: 1,
  revision: 0,
  sessions: [
    session('ordinary-proxy-parent', 1, [
      {
        ...group('ordinary-proxy-group', 'Ordinary', 1, {
          tabs: [tab('proxy-source-tab')],
        }),
        grouped: false,
      },
      group('tab:proxy-source-tab', 'Real group collision', 2),
    ]),
  ],
};
await fakeBrowser.storage.local.set({ sessions: ordinaryProxyCollisionEnvelope });
const migratedProxyCollision = await readSessions();
assert.equal(migratedProxyCollision.sessions.length, 2);
assert.equal(migratedProxyCollision.recoveryEntryCount, 0);
const migratedDirectSession = migratedProxyCollision.sessions.find((candidate) =>
  candidate.items.some((item) => item.type === 'tab'),
);
assert.equal(migratedDirectSession.items[0].tab.id, 'proxy-source-tab:migrated');
await writeSessions(migratedProxyCollision.sessions);
const rereadProxyCollision = await readSessions();
assert.equal(rereadProxyCollision.sessions.length, 2);
assert.equal(rereadProxyCollision.recoveryEntryCount, 0);
assert.equal(
  rereadProxyCollision.sessions
    .find((candidate) => candidate.items.some((item) => item.type === 'tab'))
    .items[0].tab.id,
  'proxy-source-tab:migrated',
);

fakeBrowser.reset();
await assert.rejects(
  () => importSessionsJson(JSON.stringify({
    schemaVersion: 3,
    revision: 0,
    sessions: [{
      ...directSession('invalid-v3-legacy-groups', 1, [tab('invalid-v3-tab')]),
      legacyGroups: null,
    }],
  })),
  /legacyGroups 不受 v3 支持/,
);

fakeBrowser.reset();
const legacySessionIdCollision = {
  schemaVersion: 1,
  revision: 0,
  sessions: [
    session('legacy-parent', 1, [
      { ...group('another-session', 'Ordinary', 1), grouped: false },
    ]),
    session('another-session', 2, [group('real-group', 'Real', 2)]),
  ],
};
await fakeBrowser.storage.local.set({ sessions: legacySessionIdCollision });
const collisionMigration = await readSessions();
assert.equal(collisionMigration.sessions.length, 1);
assert.equal(collisionMigration.recoveryEntryCount, 1);
assert.deepEqual(
  (await fakeBrowser.storage.local.get('sessions')).sessions,
  legacySessionIdCollision,
);

fakeBrowser.reset();
await setSavedPagesAutoArchivePeriod(7);
await fakeBrowser.storage.local.set({
  sessions: { schemaVersion: 999, revision: 0, sessions: [] },
});
await assert.rejects(() => setAutoArchivePeriod(1), /Bok 数据来自更新版本/);
assert.equal(await getSavedPagesAutoArchivePeriod(), 7);
console.log('session import check passed');
