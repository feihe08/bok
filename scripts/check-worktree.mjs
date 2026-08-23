import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const managerPath = fileURLToPath(new URL('./worktree.mjs', import.meta.url));
const stateFile = '.bok-worktree-state.json';

function run(command, args, cwd, expectedStatus = 0) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, BOK_WORKTREE_LOCK_HELD: '' },
  });
  assert.equal(
    result.status,
    expectedStatus,
    result.stderr || result.stdout || `${command} failed`,
  );
  return result;
}

function runManager(args, cwd, expectedStatus = 0) {
  return run(process.execPath, [managerPath, ...args], cwd, expectedStatus);
}

function runManagerAsync(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [managerPath, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, BOK_WORKTREE_LOCK_HELD: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function gitOutput(args, cwd) {
  return run('git', args, cwd).stdout.trim();
}

function linkedCount(repositoryRoot) {
  return (
    run('git', ['worktree', 'list', '--porcelain'], repositoryRoot)
      .stdout.match(/^worktree /gm)?.length ?? 0
  ) - 1;
}

function branchExists(repositoryRoot, slug) {
  return (
    spawnSync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/codex/${slug}`],
      { cwd: repositoryRoot },
    ).status === 0
  );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readState(worktreeRoot) {
  return JSON.parse(await readFile(join(worktreeRoot, stateFile), 'utf8'));
}

async function writeState(worktreeRoot, state) {
  await writeFile(
    join(worktreeRoot, stateFile),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'bok-worktree-check-'));
const repositoryRoot = join(temporaryRoot, 'repo');
const managedRoot = join(temporaryRoot, 'repo-worktrees');

try {
  await mkdir(repositoryRoot);
  run('git', ['init', '-b', 'main'], repositoryRoot);
  run('git', ['config', 'user.name', 'Bok Worktree Check'], repositoryRoot);
  run('git', ['config', 'user.email', 'worktree-check@example.invalid'], repositoryRoot);
  await writeFile(join(repositoryRoot, 'base.txt'), 'base\n');
  await writeFile(
    join(repositoryRoot, '.gitignore'),
    '.bok-worktree-state.json\n.bok-worktree-state.json.tmp-*\n.cache-sentinel\n',
  );
  run('git', ['add', 'base.txt', '.gitignore'], repositoryRoot);
  run('git', ['commit', '-m', 'test: initialize repository'], repositoryRoot);

  await writeFile(join(repositoryRoot, 'base.txt'), 'uncommitted\n');
  await writeFile(join(repositoryRoot, 'local.txt'), 'preserve me\n');

  const slugs = Array.from({ length: 11 }, (_, index) => `parallel-${index + 1}`);
  const results = await Promise.all(
    slugs.map((slug) => runManagerAsync(['create', slug], repositoryRoot)),
  );
  const successfulSlugs = slugs.filter((_, index) => results[index].status === 0);
  const failures = results.filter((result) => result.status !== 0);
  assert.equal(successfulSlugs.length, 10);
  assert.equal(failures.length, 1);
  assert.match(failures[0].stderr, /10\/10 slots are occupied/);
  assert.match(failures[0].stderr, /no safe retained slot/);
  assert.equal(linkedCount(repositoryRoot), 10);

  const listResult = runManager(['list'], repositoryRoot);
  assert.match(listResult.stdout, /Linked worktrees: 10\/10/);
  for (const slug of successfulSlugs) {
    const worktreeRoot = join(managedRoot, slug);
    assert.equal(await readFile(join(worktreeRoot, 'base.txt'), 'utf8'), 'base\n');
    await assert.rejects(readFile(join(worktreeRoot, 'local.txt'), 'utf8'));
    assert.equal((await readState(worktreeRoot)).state, 'active');
  }
  for (const slug of successfulSlugs) runManager(['close', slug], repositoryRoot);
  assert.equal(await readFile(join(repositoryRoot, 'base.txt'), 'utf8'), 'uncommitted\n');
  assert.equal(await readFile(join(repositoryRoot, 'local.txt'), 'utf8'), 'preserve me\n');
  await writeFile(join(repositoryRoot, 'base.txt'), 'base\n');
  await unlink(join(repositoryRoot, 'local.txt'));

  runManager(['create', 'prune-check'], repositoryRoot);
  const prunableRoot = await realpath(
    join(managedRoot, 'prune-check'),
  );
  await rm(prunableRoot, { recursive: true, force: true });
  const doctorResult = runManager(['doctor'], repositoryRoot, 1);
  assert.match(doctorResult.stderr, /Prunable entry still occupies a slot/);
  const prunePreview = runManager(['prune'], repositoryRoot);
  assert.match(prunePreview.stdout, /Preview only/);
  assert.ok(prunePreview.stdout.includes(prunableRoot));
  const afterPreview = run(
    'git',
    ['worktree', 'list', '--porcelain'],
    repositoryRoot,
  ).stdout;
  assert.ok(
    afterPreview.includes(`worktree ${prunableRoot}\n`),
    afterPreview,
  );
  runManager(['prune', '--apply'], repositoryRoot);
  assert.ok(
    !run('git', ['worktree', 'list', '--porcelain'], repositoryRoot)
      .stdout.includes(`worktree ${prunableRoot}\n`),
  );
  run('git', ['branch', '-d', 'codex/prune-check'], repositoryRoot);

  runManager(['create', 'merge-check'], repositoryRoot);
  const featureRoot = join(managedRoot, 'merge-check');
  const featureIdentity = await realpath(featureRoot);
  await writeFile(join(featureRoot, '.cache-sentinel'), 'keep\n');
  await writeFile(join(featureRoot, 'feature.txt'), 'verified\n');
  run('git', ['add', 'feature.txt'], featureRoot);
  run('git', ['commit', '-m', 'test: add verified change'], featureRoot);
  const verifiedSha = gitOutput(['rev-parse', 'HEAD'], featureRoot);
  const stateBeforeRejectedMerge = await readState(featureRoot);

  const rejected = runManager(
    ['merge', 'merge-check', '--verified-sha', '0000000000000000000000000000000000000000'],
    repositoryRoot,
    1,
  );
  assert.match(rejected.stderr, /does not match the current feature tip/);
  assert.deepEqual(await readState(featureRoot), stateBeforeRejectedMerge);

  runManager(
    ['merge', 'merge-check', '--verified-sha', verifiedSha],
    repositoryRoot,
  );
  assert.equal((await readState(featureRoot)).state, 'retained');
  assert.equal(await realpath(featureRoot), featureIdentity);
  assert.equal(
    await readFile(join(featureRoot, '.cache-sentinel'), 'utf8'),
    'keep\n',
  );
  assert.equal(gitOutput(['rev-parse', 'HEAD'], featureRoot), verifiedSha);
  assert.equal(gitOutput(['rev-parse', 'main'], repositoryRoot), verifiedSha);

  runManager(['create', 'advance-main'], repositoryRoot);
  const advanceRoot = join(managedRoot, 'advance-main');
  await writeFile(join(advanceRoot, 'advance.txt'), 'advance\n');
  run('git', ['add', 'advance.txt'], advanceRoot);
  run('git', ['commit', '-m', 'test: advance main'], advanceRoot);
  const advanceSha = gitOutput(['rev-parse', 'HEAD'], advanceRoot);
  runManager(
    ['merge', 'advance-main', '--verified-sha', advanceSha],
    repositoryRoot,
  );

  runManager(['reuse', 'merge-check'], featureRoot);
  assert.equal((await readState(featureRoot)).state, 'active');
  assert.equal(gitOutput(['rev-parse', 'HEAD'], featureRoot), advanceSha);
  assert.equal(await realpath(featureRoot), featureIdentity);
  assert.equal(
    await readFile(join(featureRoot, '.cache-sentinel'), 'utf8'),
    'keep\n',
  );

  await writeFile(join(featureRoot, 'second-feature.txt'), 'second\n');
  run('git', ['add', 'second-feature.txt'], featureRoot);
  run('git', ['commit', '-m', 'test: reuse worktree'], featureRoot);
  const reusedSha = gitOutput(['rev-parse', 'HEAD'], featureRoot);
  runManager(
    ['merge', 'merge-check', '--verified-sha', reusedSha],
    repositoryRoot,
  );
  assert.equal((await readState(featureRoot)).state, 'retained');
  assert.equal(await realpath(featureRoot), featureIdentity);
  runManager(['close', 'advance-main'], repositoryRoot);
  runManager(['close', 'merge-check'], repositoryRoot);

  runManager(['create', 'evict-old'], repositoryRoot);
  runManager(['create', 'evict-new'], repositoryRoot);
  const evictionBaseSha = gitOutput(['rev-parse', 'main'], repositoryRoot);
  runManager(
    ['merge', 'evict-old', '--verified-sha', evictionBaseSha],
    repositoryRoot,
  );
  runManager(
    ['merge', 'evict-new', '--verified-sha', evictionBaseSha],
    repositoryRoot,
  );
  const evictOldRoot = join(managedRoot, 'evict-old');
  const evictNewRoot = join(managedRoot, 'evict-new');
  await writeState(evictOldRoot, {
    version: 1,
    slug: 'evict-old',
    state: 'retained',
    createdAt: '2000-01-01T00:00:00.000Z',
    lastActivityAt: '2000-01-01T00:00:00.000Z',
  });
  await writeState(evictNewRoot, {
    version: 1,
    slug: 'evict-new',
    state: 'retained',
    createdAt: '2000-01-01T00:00:00.000Z',
    lastActivityAt: '2001-01-01T00:00:00.000Z',
  });
  runManager(['touch'], evictOldRoot);
  assert.equal((await readState(evictOldRoot)).state, 'retained');

  const fillSlugs = Array.from(
    { length: 8 },
    (_, index) => `fill-${index + 1}`,
  );
  for (const slug of fillSlugs) runManager(['create', slug], repositoryRoot);
  assert.equal(linkedCount(repositoryRoot), 10);
  const replacement = runManager(['create', 'replacement'], repositoryRoot);
  assert.match(
    replacement.stdout,
    /Removed least-recently-active retained worktree/,
  );
  assert.equal(linkedCount(repositoryRoot), 10);
  assert.equal(await exists(evictNewRoot), false);
  assert.equal(branchExists(repositoryRoot, 'evict-new'), false);
  assert.equal(await exists(evictOldRoot), true);
  assert.equal(
    (await readState(join(managedRoot, 'replacement'))).state,
    'active',
  );

  await writeFile(join(evictOldRoot, 'dirty.txt'), 'preserve\n');

  const lockedSlug = 'fill-1';
  runManager(
    ['merge', lockedSlug, '--verified-sha', evictionBaseSha],
    repositoryRoot,
  );
  run('git', ['worktree', 'lock', join(managedRoot, lockedSlug)], repositoryRoot);

  const staleSlug = 'fill-2';
  runManager(
    ['merge', staleSlug, '--verified-sha', evictionBaseSha],
    repositoryRoot,
  );
  const staleRoot = await realpath(join(managedRoot, staleSlug));
  await rm(staleRoot, { recursive: true, force: true });

  const unmergedSlug = 'fill-3';
  runManager(
    ['merge', unmergedSlug, '--verified-sha', evictionBaseSha],
    repositoryRoot,
  );
  const unmergedRoot = join(managedRoot, unmergedSlug);
  await writeFile(join(unmergedRoot, 'unmerged.txt'), 'unmerged\n');
  run('git', ['add', 'unmerged.txt'], unmergedRoot);
  run('git', ['commit', '-m', 'test: protect unmerged worktree'], unmergedRoot);

  const blocked = runManager(['create', 'blocked-new'], repositoryRoot, 1);
  assert.match(blocked.stderr, /no safe retained slot/);
  assert.equal(linkedCount(repositoryRoot), 10);
  assert.equal(branchExists(repositoryRoot, 'blocked-new'), false);
  assert.equal(
    await readFile(join(evictOldRoot, 'dirty.txt'), 'utf8'),
    'preserve\n',
  );
  assert.ok(
    run('git', ['worktree', 'list', '--porcelain'], repositoryRoot)
      .stdout.includes(`worktree ${staleRoot}\n`),
  );

  await unlink(join(evictOldRoot, 'dirty.txt'));
  run(
    'git',
    ['worktree', 'unlock', join(managedRoot, lockedSlug)],
    repositoryRoot,
  );
  runManager(['prune'], repositoryRoot);
  runManager(['prune', '--apply'], repositoryRoot);
  run('git', ['branch', '-d', `codex/${staleSlug}`], repositoryRoot);

  run('git', ['merge', '--ff-only', `codex/${unmergedSlug}`], repositoryRoot);
  const remainingSlugs = [
    'evict-old',
    ...fillSlugs.filter((slug) => slug !== staleSlug),
    'replacement',
  ];
  for (const slug of remainingSlugs) runManager(['close', slug], repositoryRoot);
  assert.equal(linkedCount(repositoryRoot), 0);
  runManager(['doctor'], repositoryRoot);

  const manualRoot = join(managedRoot, 'manual');
  run(
    'git',
    ['worktree', 'add', '-b', 'codex/manual', manualRoot, 'main'],
    repositoryRoot,
  );
  runManager(['create', 'current-safe'], repositoryRoot);
  const currentSafeRoot = join(managedRoot, 'current-safe');
  const currentMainSha = gitOutput(['rev-parse', 'main'], repositoryRoot);
  runManager(
    ['merge', 'current-safe', '--verified-sha', currentMainSha],
    repositoryRoot,
  );
  const guardSlugs = Array.from(
    { length: 8 },
    (_, index) => `guard-${index + 1}`,
  );
  for (const slug of guardSlugs) runManager(['create', slug], repositoryRoot);
  assert.equal(linkedCount(repositoryRoot), 10);
  assert.match(runManager(['list'], repositoryRoot).stdout, /manual.*unmanaged/);
  runManager(['doctor'], repositoryRoot);

  const manualTouch = runManager(['touch', 'manual'], repositoryRoot, 1);
  assert.match(manualTouch.stderr, /missing \.bok-worktree-state\.json/);
  assert.equal(await exists(join(manualRoot, stateFile)), false);
  const currentBlocked = runManager(
    ['create', 'current-blocked'],
    currentSafeRoot,
    1,
  );
  assert.match(currentBlocked.stderr, /no safe retained slot/);
  assert.equal(branchExists(repositoryRoot, 'current-blocked'), false);
  assert.equal(await exists(currentSafeRoot), true);
  assert.equal((await readState(currentSafeRoot)).state, 'retained');

  for (const slug of guardSlugs) runManager(['close', slug], repositoryRoot);
  runManager(['close', 'current-safe'], repositoryRoot);
  runManager(['close', 'manual'], repositoryRoot);
  assert.equal(linkedCount(repositoryRoot), 0);
  runManager(['doctor'], repositoryRoot);

  console.log('worktree management checks passed');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
